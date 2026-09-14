import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { emptyNovel, upsertChapter } from '../src/core/novel.ts'
import { createProjectResolver } from '../src/host/resolver.ts'

/**
 * Resolver specs: the session → project mapping that makes one running service
 * able to work on many novels.
 *
 * The bug these exist for: the composer used to root every tool at
 * `process.cwd()`, so a workspace the user created in the UI had no effect —
 * the plugin kept reading whatever directory the server was launched from.
 */
let sandbox: string
let ctx: Context

/** Two novel directories plus one unrelated project directory. */
let novelA: string
let novelB: string
let unrelated: string

const session = (cwd?: string) => ({ header: cwd === undefined ? {} : { cwd } })

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'ai-novelist-resolver-'))
  novelA = join(sandbox, 'novel-a')
  novelB = join(sandbox, 'novel-b')
  unrelated = join(sandbox, 'unrelated')
  for (const dir of [novelA, novelB, unrelated]) await mkdir(dir, { recursive: true })
  await writeFile(join(unrelated, 'package.json'), '{}\n', 'utf8')

  ctx = new Context()
  ctx.plugin(LocalFileSystem, { cwd: sandbox, diffBasisMaxBytes: 64 * 1024 })
})

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true })
})

describe('session-scoped roots', () => {
  it("follows the session's own cwd, not the process directory", () => {
    const resolver = createProjectResolver(ctx, { configuredRoot: novelA })
    expect(resolver.rootForSession(session(novelB))).toEqual({ root: novelB, source: 'session' })
  })

  it('falls back to the configured root when the session records none', () => {
    const resolver = createProjectResolver(ctx, { configuredRoot: novelA })
    expect(resolver.rootForSession(session())).toEqual({ root: novelA, source: 'configured' })
  })

  it('falls back to the process directory with no configuration at all', () => {
    const resolver = createProjectResolver(ctx)
    const resolved = resolver.rootForSession(session())
    expect(resolved.source).toBe('process')
    expect(resolved.root).toBe(process.cwd())
  })

  it('normalizes trailing separators so one directory is one store', () => {
    const resolver = createProjectResolver(ctx, { configuredRoot: novelA })
    expect(resolver.storeFor(`${novelA}/`)).toBe(resolver.storeFor(novelA))
  })

  it('keeps per-session stores independent', async () => {
    const resolver = createProjectResolver(ctx, { configuredRoot: novelA })
    const a = resolver.storeForSession(session(novelA))
    const b = resolver.storeForSession(session(novelB))
    expect(a).not.toBe(b)

    await a.adopt(upsertChapter(emptyNovel({ title: 'A' }), { id: 'one', body: '青云宗' }))
    await expect(b.read()).resolves.toBeUndefined()
    expect((await a.read())?.meta.title).toBe('A')
    // A second session in the same directory shares the cached store.
    expect(resolver.storeForSession(session(novelA))).toBe(a)
  })

  it('classifies each session workspace separately', async () => {
    const resolver = createProjectResolver(ctx, { configuredRoot: novelA })
    await resolver.storeFor(novelA).adopt(emptyNovel({ title: 'A' }))
    await expect(resolver.verdictFor(session(novelA))).resolves.toMatchObject({ kind: 'novel' })
    await expect(resolver.verdictFor(session(novelB))).resolves.toMatchObject({ kind: 'fresh' })
    await expect(resolver.verdictFor(session(unrelated))).resolves.toMatchObject({ kind: 'plain' })
  })
})

describe('project discovery', () => {
  it('reports an empty list when the workspace registry is not mounted', async () => {
    const resolver = createProjectResolver(ctx, { configuredRoot: novelA })
    await expect(resolver.listProjects()).resolves.toEqual([])
  })

  it('annotates registered workspaces with whether they hold a novel', async () => {
    // A stand-in for `ctx.workspaceRegistry`, which the real profile mounts.
    const registry = {
      list: () => [
        { id: 'w1', path: novelA, title: 'novel-a', sessionIds: ['s1', 's2'] },
        { id: 'w2', path: novelB, title: 'novel-b', sessionIds: [] },
        { id: 'w3', path: unrelated, title: 'unrelated', sessionIds: ['s3'] },
      ],
      create: (path: string) => Promise.resolve({ id: 'w9', path, title: 'w9', sessionIds: [] }),
    }
    const resolver = createProjectResolver(ctx, { configuredRoot: novelA })
    ;(ctx as unknown as { workspaceRegistry: unknown }).workspaceRegistry = registry

    await resolver.storeFor(novelA).adopt(emptyNovel({ title: 'A' }))
    const projects = await resolver.listProjects()
    expect(projects).toEqual([
      { id: 'w1', path: novelA, title: 'novel-a', sessionCount: 2, isNovelProject: true },
      { id: 'w2', path: novelB, title: 'novel-b', sessionCount: 0, isNovelProject: false },
      { id: 'w3', path: unrelated, title: 'unrelated', sessionCount: 1, isNovelProject: false },
    ])
  })

  it('creates a missing directory and registers it when asked', async () => {
    const registry = {
      list: () => [],
      create: (path: string) => Promise.resolve({ id: 'w9', path, title: 'fresh-novel', sessionIds: [] }),
    }
    const resolver = createProjectResolver(ctx, { configuredRoot: novelA })
    ;(ctx as unknown as { workspaceRegistry: unknown }).workspaceRegistry = registry

    const target = join(sandbox, 'brand-new')
    const result = await resolver.registerWorkspace(target)
    expect(result.registered).toBe(true)
    expect(result.ref).toMatchObject({ path: target, title: 'fresh-novel', isNovelProject: false })
  })
})
