import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { emptyNovel, upsertChapter } from '../src/core/novel.ts'
import { NOVEL_RELATIVE_PATH, NovelConflictError, NovelStore, isRegularFile } from '../src/host/store.ts'

/**
 * Store integration specs against the real local filesystem backend.
 *
 * The store's whole value is atomicity and containment, which only exist in
 * contact with a real backend — so these specs mount `@deepseek-ai/dsh-fs-local`
 * into a root context and drive the service exactly as the plugin does.
 */
let root: string
let ctx: Context
let store: NovelStore
let clock: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ai-webnovel-'))
  clock = '2024-05-01T00:00:00.000Z'
  ctx = new Context()
  ctx.plugin(LocalFileSystem, { cwd: root, diffBasisMaxBytes: 64 * 1024 })
  store = new NovelStore(ctx, { workspaceRoot: root, clock: () => clock })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Absolute path of the project document inside the temp workspace. */
const docPath = () => join(root, NOVEL_RELATIVE_PATH)

describe('NovelStore', () => {
  it('reports no project before initialization', async () => {
    await expect(store.read()).resolves.toBeUndefined()
  })

  it('creates the document and reads the same state back', async () => {
    const state = emptyNovel({ title: '青云记', premise: '少年上山' }, () => clock)
    await store.create(state)
    await expect(store.read()).resolves.toEqual(state)
    const onDisk = JSON.parse(await readFile(docPath(), 'utf8')) as { meta: { title: string } }
    expect(onDisk.meta.title).toBe('青云记')
  })

  it('refuses to create over an existing project', async () => {
    await store.create(emptyNovel({ title: 'A' }, () => clock))
    await expect(store.create(emptyNovel({ title: 'B' }, () => clock))).rejects.toThrow(NovelConflictError)
    await expect(store.read()).resolves.toMatchObject({ meta: { title: 'A' } })
  })

  it('applies a mutation and persists the clock stamp', async () => {
    await store.create(emptyNovel({ title: 'A' }, () => clock))
    clock = '2024-05-02T00:00:00.000Z'
    const next = await store.update((current) => upsertChapter(current, { id: 'one', body: '青云宗' }, () => clock))
    expect(next.chapters['one']?.wordCount).toBe(3)
    expect(next.updatedAt).toBe('2024-05-02T00:00:00.000Z')
    const reread = await store.read()
    expect(reread?.chapters['one']?.body).toBe('青云宗')
  })

  it('refuses a mutation when no project exists', async () => {
    await expect(store.update((current) => current)).rejects.toThrow(/no novel project/)
  })

  it('re-reads the current document, so an external edit is not lost', async () => {
    await store.create(emptyNovel({ title: 'A' }, () => clock))
    // A concurrent writer (the model's own edit tool, another session) lands
    // before this mutation starts: the store re-reads, so the edit survives.
    const seen = await store.read()
    const forged = { ...seen!, meta: { ...seen!.meta, premise: 'changed elsewhere' } }
    await writeFile(docPath(), `${JSON.stringify(forged, null, 2)}\n`, 'utf8')
    const next = await store.update((current) => upsertChapter(current, { id: 'one', body: 'x' }, () => clock))
    expect(next.meta.premise).toBe('changed elsewhere')
    expect(next.chapters['one']).toBeDefined()
  })

  it('refuses a write when the document changes during the mutation', async () => {
    await store.create(emptyNovel({ title: 'A' }, () => clock))
    // A writer landing between the store's read and its guarded write is exactly
    // what the version guard exists for; without it this write would clobber
    // whatever arrived first.
    await expect(
      store.update(async (current) => {
        await writeFile(docPath(), `${JSON.stringify({ ...current, meta: { ...current.meta, premise: 'race' } }, null, 2)}\n`, 'utf8')
        return upsertChapter(current, { id: 'one', body: 'x' }, () => clock)
      }),
    ).rejects.toThrow(NovelConflictError)
  })

  it('serializes concurrent mutations instead of losing one', async () => {
    await store.create(emptyNovel({ title: 'A' }, () => clock))
    await Promise.all([
      store.update((current) => upsertChapter(current, { id: 'a', number: 1, body: 'first' }, () => clock)),
      store.update((current) => upsertChapter(current, { id: 'b', number: 2, body: 'second' }, () => clock)),
    ])
    const state = await store.read()
    expect(Object.keys(state?.chapters ?? {}).sort()).toEqual(['a', 'b'])
  })

  it('treats an empty document as uninitialized', async () => {
    await store.create(emptyNovel({ title: 'A' }, () => clock))
    await writeFile(docPath(), '\n', 'utf8')
    await expect(store.read()).resolves.toBeUndefined()
  })

  it('writes derived output beside the project', async () => {
    await store.create(emptyNovel({ title: 'A' }, () => clock))
    const written = await store.writeDerived('.novel/manuscript.md', '# A\n')
    expect(await readFile(written, 'utf8')).toBe('# A\n')
  })

  it('refuses a derived path that would escape the workspace root', async () => {
    await store.create(emptyNovel({ title: 'A' }, () => clock))
    await expect(store.writeDerived('../../escape.md', 'x')).rejects.toThrow(/outside the workspace root/)
    await expect(store.writeDerived('/tmp/escape.md', 'x')).rejects.toThrow(/outside the workspace root/)
    await expect(store.writeDerived('a/../../escape.md', 'x')).rejects.toThrow(/outside the workspace root/)
  })

  it('accepts a nested derived path that stays inside the root', async () => {
    await store.create(emptyNovel({ title: 'A' }, () => clock))
    const written = await store.writeDerived('exports/notes/outline.md', 'ok')
    expect(await readFile(written, 'utf8')).toBe('ok')
  })

  it('keeps the document path inside the workspace root', () => {
    expect(store.documentPath).toBe(join(root, NOVEL_RELATIVE_PATH))
  })
})

describe('isRegularFile', () => {
  it('is false for a missing target and true for a written one', async () => {
    const target = await ctx.fs.resolve(join(root, 'probe.txt'))
    await expect(isRegularFile(ctx.fs, target)).resolves.toBe(false)
    await ctx.fs.writeText(target, 'hi')
    await expect(isRegularFile(ctx.fs, target)).resolves.toBe(true)
  })

  it('is false for a directory', async () => {
    const target = await ctx.fs.resolve(root)
    await expect(isRegularFile(ctx.fs, target)).resolves.toBe(false)
  })
})
