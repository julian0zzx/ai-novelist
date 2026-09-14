import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type { WorkspaceVerdict } from '../src/core/workspace.ts'
import { WORKSPACE_CONTEXT_NAME, registerWorkspacePrompt } from '../src/host/prompt.ts'
import type { NovelSnapshot } from '../src/host/prompt.ts'
import type { WorkspaceView, WorkspaceViews } from '../src/host/views.ts'

/**
 * Prompt-wiring spec.
 *
 * `test/prompt.test.ts` specifies the text and `test/views.test.ts` specifies the
 * classification behind it; this one proves the text of the *right workspace*
 * actually reaches a composed model prompt, by mounting the real
 * `@deepseek-ai/dsh-system-prompt` registry and assembling through it, with the
 * views stubbed so routing is the only thing under test. That is the difference
 * between "the renderer is correct" and "the model sees it, about its own
 * directory".
 */
let root: string
let ctx: Context

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ai-novelist-wire-'))
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

/** One fixed view, so these specs exercise the wiring rather than the probe. */
function viewOf(viewRoot: string, verdict: WorkspaceVerdict | undefined, snapshot?: NovelSnapshot): WorkspaceView {
  return {
    root: viewRoot,
    documentPath: join(viewRoot, '.novel', 'novel.json'),
    verdict: () => verdict,
    snapshot: () => snapshot,
    created: () => false,
    classify: () => Promise.resolve(),
    refresh: () => Promise.resolve(),
  }
}

/**
 * A registry over fixed views, routed the way the real one is: by the session's
 * recorded `cwd`, with the deployment's view for an assembly that has no session.
 */
function viewsOf(deployment: WorkspaceView, others: readonly WorkspaceView[] = []): WorkspaceViews {
  const route = (root: string): WorkspaceView => others.find((view) => view.root === root) ?? deployment
  return {
    deploymentRoot: deployment.root,
    viewFor: route,
    viewForSession: (session) => route(session?.header.cwd ?? deployment.root),
  }
}

const verdict = (kind: WorkspaceVerdict['kind']): WorkspaceVerdict => ({
  kind,
  reason: kind === 'novel' ? 'project-document' : 'empty-directory',
  hasProjectDocument: kind === 'novel',
  evidence: ['.novel/novel.json'],
})

/** The composer's contribution to one assembly. */
function contributed(assembly: PromptAssembly): string {
  return assembly.contexts.find((entry) => entry.name === WORKSPACE_CONTEXT_NAME)?.text ?? ''
}

describe('registerWorkspacePrompt', () => {
  it('contributes the workspace orientation to a composed prompt', async () => {
    const snapshot: NovelSnapshot = {
      title: '青云记',
      premise: '少年上山求道',
      stage: 'drafting',
      stageLabel: '阶段四 写作',
      blockers: [],
      chapters: 1,
      words: 4,
      unwritten: 0,
      contracted: 0,
      stock: 1,
      characters: 4,
      worldFacts: 0,
      openLinks: 0,
      overdueLinks: 0,
      metricNotes: [],
      lastNumber: 1,
      lastTitle: '山门',
      lastStatus: 'drafting',
    }
    registerWorkspacePrompt(ctx, viewsOf(viewOf(root, verdict('novel'), snapshot)))

    const prompt = await until(() => ctx.get('systemPrompt'))
    const text = contributed(await prompt.assemble())

    expect(text).toContain('Composer workspace: novel')
    expect(text).toContain('"青云记"')
    expect(text).toContain('1 chapters, 4 characters')
    expect(text).toContain('Latest chapter: #1 "山门" (drafting)')
  })

  it('stays silent until the classification lands', async () => {
    registerWorkspacePrompt(ctx, viewsOf(viewOf(root, undefined)))

    const prompt = await until(() => ctx.get('systemPrompt'))
    // Registered, but rendering empty contributes nothing to the model input.
    expect(contributed(await prompt.assemble())).toBe('')
  })

  it('never lets a broken project document fail the assembly', async () => {
    const snapshot: NovelSnapshot = {
      title: 'X',
      premise: '',
      stage: 'planning',
      stageLabel: '阶段一 策划',
      blockers: [],
      chapters: 0,
      words: 0,
      unwritten: 0,
      contracted: 0,
      stock: 0,
      characters: 0,
      worldFacts: 0,
      openLinks: 0,
      overdueLinks: 0,
      metricNotes: [],
      lastNumber: 0,
      lastTitle: '',
      lastStatus: 'planned',
      error: 'store is not valid JSON',
    }
    registerWorkspacePrompt(ctx, viewsOf(viewOf(root, verdict('novel'), snapshot)))

    const prompt = await until(() => ctx.get('systemPrompt'))
    expect(contributed(await prompt.assemble())).toContain('Could not be read'.toLowerCase())
  })

  it('describes the workspace of the agent the assembly is for', async () => {
    // The regression this exists for: the deployment is mounted on a software
    // repository while the session works in a fresh novel directory. The old
    // section described the process directory to every session, so the model was
    // told "this is a software project" and refused to start the novel.
    const sessionRoot = join(root, 'fairy-novel')
    const deployment = viewsOf(viewOf(root, verdict('plain')), [viewOf(sessionRoot, verdict('fresh'))])
    registerWorkspacePrompt(ctx, deployment)

    const prompt = await until(() => ctx.get('systemPrompt'))
    const assembly = await prompt.assemble({
      agent: { session: { header: { cwd: sessionRoot } } },
    } as unknown as Parameters<SystemPrompt['assemble']>[0])
    const text = contributed(assembly)

    expect(text).toContain('Composer workspace: fresh')
    expect(text).toContain('Call novel_init once')
    expect(text).not.toContain('software project')
  })
})
