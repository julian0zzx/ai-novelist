import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { emptyNovel, upsertChapter } from '../src/core/novel.ts'
import type { WorkspaceVerdict } from '../src/core/workspace.ts'
import { WORKSPACE_CONTEXT_NAME, createSnapshotCache, registerWorkspacePrompt } from '../src/host/prompt.ts'
import { NovelStore } from '../src/host/store.ts'

/**
 * Prompt-wiring spec.
 *
 * `test/prompt.test.ts` specifies the text; this one proves the text actually
 * reaches a composed model prompt, by mounting the real
 * `@deepseek-ai/dsh-system-prompt` registry and assembling through it. That is
 * the difference between "the renderer is correct" and "the model sees it".
 */
let root: string
let ctx: Context

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ai-webnovel-wire-'))
  ctx = new Context()
  ctx.plugin(LocalFileSystem, { cwd: root, diffBasisMaxBytes: 64 * 1024 })
  ctx.plugin(SystemPrompt, {})
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Wait for a service to appear on the context. */
async function until<T>(read: () => T | undefined, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('timed out waiting for the service')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('registerWorkspacePrompt', () => {
  it('contributes the workspace orientation to a composed prompt', async () => {
    const store = new NovelStore(ctx, { workspaceRoot: root })
    await store.adopt(
      upsertChapter(
        emptyNovel({ title: '青云记', premise: '少年上山求道' }, () => '2024-01-01T00:00:00.000Z'),
        { id: 'chapter-1', number: 1, title: '山门', body: '山门很高。', status: 'drafting' },
        () => '2024-01-01T00:00:00.000Z',
      ),
    )
    const cache = createSnapshotCache(store)
    await cache.refresh()
    const verdict: WorkspaceVerdict = {
      kind: 'novel',
      reason: 'project-document',
      hasProjectDocument: true,
      evidence: ['.novel/novel.json'],
    }
    registerWorkspacePrompt(ctx, store, () => verdict, cache)

    const prompt = await until(() => ctx.get('systemPrompt'))
    const assembly = await prompt.assemble()

    const contributed = assembly.contexts.find((entry) => entry.name === WORKSPACE_CONTEXT_NAME)
    expect(contributed, 'the composer context should be part of the assembly').toBeDefined()
    expect(contributed?.text).toContain('Composer workspace: novel')
    expect(contributed?.text).toContain('"青云记"')
    expect(contributed?.text).toContain('1 chapters, 4 characters')
    expect(contributed?.text).toContain('Latest chapter: #1 "山门" (drafting)')
  })

  it('stays silent until the classification lands', async () => {
    const store = new NovelStore(ctx, { workspaceRoot: root })
    const cache = createSnapshotCache(store)
    registerWorkspacePrompt(ctx, store, () => undefined, cache)

    const prompt = await until(() => ctx.get('systemPrompt'))
    const assembly = await prompt.assemble()
    const contributed = assembly.contexts.find((entry) => entry.name === WORKSPACE_CONTEXT_NAME)
    // Registered, but rendering empty contributes nothing to the model input.
    expect(contributed?.text ?? '').toBe('')
  })

  it('never lets a broken project document fail the assembly', async () => {
    const store = new NovelStore(ctx, { workspaceRoot: root })
    await store.adopt(emptyNovel({ title: 'X' }))
    const cache = createSnapshotCache(store)
    await cache.refresh()
    await writeFile(join(root, '.novel/novel.json'), 'broken\n', 'utf8')
    await cache.refresh()

    registerWorkspacePrompt(
      ctx,
      store,
      () => ({ kind: 'novel', reason: 'project-document', hasProjectDocument: true, evidence: ['.novel/novel.json'] }),
      cache,
    )
    const prompt = await until(() => ctx.get('systemPrompt'))
    const assembly = await prompt.assemble()
    const contributed = assembly.contexts.find((entry) => entry.name === WORKSPACE_CONTEXT_NAME)
    expect(contributed?.text).toContain('Could not be read'.toLowerCase())
  })
})
