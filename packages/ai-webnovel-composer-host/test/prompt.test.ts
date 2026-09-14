import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { emptyNovel, upsertChapter, upsertCharacter } from '../src/core/novel.ts'
import type { WorkspaceVerdict } from '../src/core/workspace.ts'
import {
  createSnapshotCache,
  renderWorkspaceContext,
  type NovelSnapshot,
  type WorkspaceContextInput,
} from '../src/host/prompt.ts'
import { NovelStore } from '../src/host/store.ts'

/**
 * Prompt-section specs.
 *
 * The section is what makes an opened novel workspace usable without a discovery
 * turn, so these assert both the orientation text and the cache policy that lets
 * a synchronous render report live numbers.
 */
let root: string
let ctx: Context
let store: NovelStore
let clock: number

const verdict = (kind: WorkspaceVerdict['kind'], reason: WorkspaceVerdict['reason'] = 'empty-directory'): WorkspaceVerdict => ({
  kind,
  reason,
  hasProjectDocument: kind === 'novel',
  evidence: ['evidence'],
})

/** A snapshot with only the fields a test cares about overridden. */
const snapshot = (overrides: Partial<NovelSnapshot> = {}): NovelSnapshot => ({
  title: '',
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
  ...overrides,
})

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ai-webnovel-prompt-'))
  ctx = new Context()
  ctx.plugin(LocalFileSystem, { cwd: root, diffBasisMaxBytes: 64 * 1024 })
  clock = 1_000_000
  store = new NovelStore(ctx, { workspaceRoot: root, clock: () => '2024-08-01T00:00:00.000Z' })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('renderWorkspaceContext', () => {
  /**
   * The render input for this test's workspace.
   *
   * The render is a pure function of what the composer already learned, so a
   * spec hands it the facts instead of a filesystem: `kind` absent is the
   * "classification has not landed yet" case.
   */
  const workspace = (
    kind?: WorkspaceVerdict['kind'],
    options: { reason?: WorkspaceVerdict['reason']; snapshot?: NovelSnapshot } = {},
  ): WorkspaceContextInput => ({
    root,
    documentPath: join(root, '.novel', 'novel.json'),
    verdict: kind === undefined ? undefined : verdict(kind, options.reason),
    snapshot: options.snapshot,
  })

  it('renders nothing until classification lands', () => {
    expect(renderWorkspaceContext(workspace())).toBe('')
  })

  it('names the workspace kind and where the project lives', () => {
    const text = renderWorkspaceContext(workspace('novel', { reason: 'project-document' }))
    expect(text).toContain('Composer workspace: novel')
    expect(text).toContain('.novel/novel.json')
    expect(text).toContain('Follow the SOP pipeline')
  })

  it('tells the model to initialize a fresh workspace', () => {
    const text = renderWorkspaceContext(workspace('fresh'))
    expect(text).toContain('Composer workspace: fresh')
    expect(text).toContain('Call novel_init once')
  })

  it('keeps the tools idle in an unrelated workspace', () => {
    const text = renderWorkspaceContext(workspace('plain', { reason: 'unrelated-project' }))
    expect(text).toContain('Composer workspace: plain')
    expect(text).toContain('Do not create a novel project here')
    expect(text).not.toContain('.novel/novel.json')
  })

  it('reports the project standing when a snapshot exists', () => {
    const text = renderWorkspaceContext(
      workspace('novel', {
        reason: 'project-document',
        snapshot: snapshot({
          title: '青云记',
          premise: '少年上山求道',
          chapters: 3,
          words: 12000,
          unwritten: 1,
          characters: 4,
          worldFacts: 2,
          lastNumber: 3,
          lastTitle: '出宗',
          lastStatus: 'drafting',
        }),
      }),
    )
    expect(text).toContain('"青云记"')
    expect(text).toContain('3 chapters, 12000 characters (1 not yet written')
    expect(text).toContain('Latest chapter: #3 "出宗" (drafting)')
  })

  it('asks for a plan when the project has no chapters', () => {
    const text = renderWorkspaceContext(workspace('novel', { reason: 'project-document', snapshot: snapshot() }))
    expect(text).toContain('(untitled)')
    expect(text).toContain('(no premise recorded)')
    expect(text).toContain('start with novel_plan operation="chapter"')
  })

  it('surfaces a read failure instead of showing stale numbers as current', () => {
    const text = renderWorkspaceContext(
      workspace('novel', {
        reason: 'project-document',
        snapshot: snapshot({ title: 'X', premise: 'Y', error: 'store is not valid JSON' }),
      }),
    )
    expect(text).toContain('could not be read: store is not valid JSON')
  })
})

describe('createSnapshotCache', () => {
  it('is empty before the first refresh and reports counts after it', async () => {
    const cache = createSnapshotCache(store, () => clock)
    expect(cache.current()).toBeUndefined()

    await store.adopt(
      upsertCharacter(
        upsertChapter(emptyNovel({ title: '青云记', premise: '少年上山' }), { id: 'a', body: '青云宗', status: 'drafting' }),
        { name: '林越' },
      ),
    )
    await cache.refresh()
    expect(cache.current()).toMatchObject({
      title: '青云记',
      chapters: 1,
      words: 3,
      unwritten: 0,
      characters: 1,
      lastNumber: 1,
      lastStatus: 'drafting',
    })
  })

  it('keeps serving the last good numbers while a refresh is in flight', async () => {
    const cache = createSnapshotCache(store, () => clock)
    await store.adopt(emptyNovel({ title: 'First' }))
    await cache.refresh()
    expect(cache.current()?.title).toBe('First')

    // Age the cache past its TTL: `current()` still answers, and starts a refresh.
    clock += 60_000
    expect(cache.current()?.title).toBe('First')
    await cache.refresh()
    expect(cache.current()?.title).toBe('First')
  })

  it('reports a read failure without discarding the last good numbers', async () => {
    const cache = createSnapshotCache(store, () => clock)
    await store.adopt(emptyNovel({ title: 'Kept' }))
    await cache.refresh()

    // Corrupt the document: the refresh must record the fault and keep serving
    // the previous snapshot rather than blanking the prompt.
    await ctx.fs.writeText(await ctx.fs.resolve(join(root, '.novel/novel.json')), 'not json\n')
    await cache.refresh()
    expect(cache.current()?.title).toBe('Kept')
    expect(cache.current()?.error).toMatch(/not valid JSON/)
  })
})
