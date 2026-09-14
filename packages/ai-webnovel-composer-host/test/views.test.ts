import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { emptyNovel, upsertChapter } from '../src/core/index.ts'
import { createProjectResolver } from '../src/host/resolver.ts'
import { NovelStore, NOVEL_RELATIVE_PATH } from '../src/host/store.ts'
import { createWorkspaceViews, type WorkspacePolicy, type WorkspaceViews } from '../src/host/views.ts'

/**
 * Workspace-view specs against the real local filesystem backend.
 *
 * A view is the composer's answer to "what is this directory, and what does the
 * project in it hold", and its whole reason to exist is that the answer must be
 * per *workspace* rather than per process — so these specs drive the registry
 * with several roots at once, the way one long-running server sees them. The
 * deployment's own mode policy belongs to `test/entry.test.ts`; here the policy
 * is stated by each spec.
 */
let root: string
let ctx: Context
let clock: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ai-webnovel-views-'))
  clock = '2024-05-01T00:00:00.000Z'
  ctx = new Context()
  ctx.plugin(LocalFileSystem, { cwd: root, diffBasisMaxBytes: 64 * 1024 })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Absolute path of one root's project document. */
const documentOf = (workspaceRoot: string): string => join(workspaceRoot, NOVEL_RELATIVE_PATH)

/** Whether a path can be read, for assertions about a file that must not exist. */
async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path, 'utf8')
    return true
  } catch {
    return false
  }
}

/** A store over one root, for arranging a project the view did not create. */
const storeAt = (workspaceRoot: string): NovelStore => new NovelStore(ctx, { workspaceRoot, clock: () => clock })

/** A registry over the real resolver, with the policy a spec wants. */
function viewsWith(policy: Partial<WorkspacePolicy> = {}, now: () => number = Date.now): WorkspaceViews {
  return createWorkspaceViews(
    ctx,
    createProjectResolver(ctx, { workspaceRoot: root }),
    {
      normalize: (_root, detected) => detected,
      mayAdopt: (verdict) => verdict.kind === 'novel',
      ...policy,
    },
    { clock: () => clock, now },
  )
}

/** A directory with the three chapter-shaped files that mark an existing draft. */
async function draftDir(name: string): Promise<string> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  for (const file of ['001-山门.md', '002-入道.md', '003-出宗.md']) {
    await writeFile(join(dir, file), '# 章\n', 'utf8')
  }
  return dir
}

/** A half-initialized project: the marker directory exists, the document does not. */
async function markedDir(name: string): Promise<string> {
  const dir = join(root, name)
  await mkdir(join(dir, '.novel'), { recursive: true })
  return dir
}

describe('createWorkspaceViews', () => {
  it('classifies a root on demand and adopts what the evidence claims', async () => {
    const novel = await draftDir('qingyun')
    const views = viewsWith()

    const view = views.viewFor(novel)
    await view.classify()

    expect(view.verdict()).toMatchObject({ kind: 'novel', reason: 'draft-files' })
    expect(view.created()).toBe(true)
    expect(view.documentPath).toBe(documentOf(novel))
    // The folder name is the provisional title; the model records the real one.
    const state = JSON.parse(await readFile(documentOf(novel), 'utf8')) as { meta: { title: string } }
    expect(state.meta.title).toBe('qingyun')
  })

  it('leaves an empty root to novel_init unless the policy claims it', async () => {
    const fresh = join(root, 'blank')
    await mkdir(fresh, { recursive: true })
    const views = viewsWith()

    const view = views.viewFor(fresh)
    await view.classify()

    expect(view.verdict()).toMatchObject({ kind: 'fresh', reason: 'empty-directory' })
    expect(view.created()).toBe(false)
    expect(await exists(documentOf(fresh))).toBe(false)
    // No document, so there are no numbers to report either.
    expect(view.snapshot()).toBeUndefined()
  })

  it('adopts an empty root when the policy opts in', async () => {
    const fresh = join(root, 'blank')
    await mkdir(fresh, { recursive: true })
    const views = viewsWith({ mayAdopt: () => true })

    const view = views.viewFor(fresh)
    await view.classify()

    expect(view.created()).toBe(true)
    expect(await exists(documentOf(fresh))).toBe(true)
  })

  it('writes nothing when the policy refuses, however novel the evidence is', async () => {
    const novel = await markedDir('qingyun')
    const views = viewsWith({ mayAdopt: () => false })

    const view = views.viewFor(novel)
    await view.classify()

    expect(view.verdict()).toMatchObject({ kind: 'novel', reason: 'novel-directory' })
    expect(view.created()).toBe(false)
    expect(await exists(documentOf(novel))).toBe(false)
  })

  it('shares one classification and one adoption between concurrent callers', async () => {
    const novel = await markedDir('qingyun')
    const views = viewsWith()
    const view = views.viewFor(novel)

    // Three sessions in one directory at once: the work runs once, and every
    // caller sees the same answer.
    await Promise.all([view.classify(), view.classify(), view.classify()])

    expect(views.viewFor(novel)).toBe(view)
    expect(view.created()).toBe(true)
    const state = JSON.parse(await readFile(documentOf(novel), 'utf8')) as { meta: { title: string } }
    expect(state.meta.title).toBe('qingyun')
  })

  it('reports the numbers of a project it did not adopt', async () => {
    const novel = join(root, 'qingyun')
    await mkdir(novel, { recursive: true })
    await storeAt(novel).adopt(
      upsertChapter(
        emptyNovel({ title: '青云记', premise: '少年上山' }, () => clock),
        { id: 'chapter-1', number: 1, title: '山门', body: '山门很高。', status: 'drafting' },
        () => clock,
      ),
    )
    const views = viewsWith({ mayAdopt: () => false })

    const view = views.viewFor(novel)
    await view.classify()

    expect(view.created()).toBe(false)
    expect(view.snapshot()).toMatchObject({ title: '青云记', chapters: 1, lastTitle: '山门' })
  })

  it('routes each session to its own root, and an agentless caller to the deployment', async () => {
    const novel = await markedDir('qingyun')
    const views = viewsWith()

    const session = views.viewForSession({ header: { cwd: novel } })
    expect(session.root).toBe(novel)
    expect(session.documentPath).toBe(documentOf(novel))

    const deployment = views.viewForSession(undefined)
    expect(deployment.root).toBe(root)
    // A session that records no cwd is the deployment's own workspace.
    expect(views.viewForSession({ header: {} })).toBe(deployment)
  })

  it('refreshes the numbers of the session workspace after a write', async () => {
    const novel = await markedDir('qingyun')
    const views = viewsWith({ mayAdopt: () => false })
    const view = views.viewFor(novel)
    await view.classify()
    expect(view.snapshot()).toBeUndefined()

    // A tool writes through the store; the view's refresh is what puts the new
    // state in front of the model on the next step.
    await storeAt(novel).adopt(emptyNovel({ title: '青云记', premise: '少年上山' }, () => clock))
    await view.refresh()

    expect(view.snapshot()).toMatchObject({ title: '青云记', chapters: 0 })
  })

  it('stops calling an empty workspace fresh once novel_init has written the project', async () => {
    // The flow the composer exists for: the section tells the model to call
    // `novel_init` in a `fresh` directory, the call creates the document, and the
    // very next step must describe a novel — not keep asking for initialization
    // while quoting the title it just recorded.
    const fresh = join(root, 'blank')
    await mkdir(fresh, { recursive: true })
    const views = viewsWith()
    const view = views.viewFor(fresh)
    await view.classify()
    expect(view.verdict()).toMatchObject({ kind: 'fresh' })

    await storeAt(fresh).adopt(emptyNovel({ title: '青云记', premise: '少年上山' }, () => clock))
    await view.refresh()
    expect(view.verdict()).toMatchObject({ kind: 'novel', reason: 'project-document' })
    expect(view.snapshot()).toMatchObject({ title: '青云记' })
    // The refresh is a read: it never adopts on its own authority.
    expect(view.created()).toBe(false)
  })

  it('serves the last good numbers while the cache is stale', async () => {
    const novel = await markedDir('qingyun')
    await storeAt(novel).adopt(emptyNovel({ title: 'First' }, () => clock))
    let now = 1_000_000
    const views = viewsWith({ mayAdopt: () => false }, () => now)

    const view = views.viewFor(novel)
    await view.classify()
    expect(view.snapshot()?.title).toBe('First')

    // Age the cache past its TTL: the render still answers, and starts a refresh.
    now += 60_000
    expect(view.snapshot()?.title).toBe('First')
  })

  it('reports a broken document by name instead of failing the render', async () => {
    const novel = await markedDir('qingyun')
    const views = viewsWith({ mayAdopt: () => false })
    const view = views.viewFor(novel)
    await view.classify()

    // The document appears out from under the view, already broken.
    await writeFile(documentOf(novel), 'broken\n', 'utf8')
    await view.refresh()

    expect(view.created()).toBe(false)
    expect(view.snapshot()?.error).toMatch(/not valid JSON/)
  })

  it('keeps a failing classification contained, so a session cannot be taken down by it', async () => {
    // No filesystem service at all: the probe cannot even start.
    const bare = new Context()
    const views = createWorkspaceViews(
      bare,
      createProjectResolver(bare, { workspaceRoot: root }),
      { normalize: (_root, detected) => detected, mayAdopt: () => true },
    )

    const view = views.viewFor(root)
    await expect(view.classify()).resolves.toBeUndefined()

    // The view stays silent rather than reporting a verdict it never made.
    expect(view.verdict()).toBeUndefined()
    expect(view.created()).toBe(false)
    expect(view.snapshot()).toBeUndefined()
  })
})
