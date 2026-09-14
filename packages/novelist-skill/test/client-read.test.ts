import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { emptyNovel, upsertChapter } from '../src/core/index.ts'
import { NovelStore } from '../src/host/store.ts'
import { boardOf } from '../src/client/board.ts'
import { readProject } from '../src/client/project.ts'
import type { SessionId } from '../src/client/project.ts'
import type { ClientRemote } from '../src/client/remote.ts'

/**
 * Client-reader specs: what the Kanban view actually gets for a workspace.
 *
 * The view is specified from both ends — `test/client-remote.test.ts` pins the
 * Remote face it reads through, `test/board.test.ts` pins the projection it
 * renders — and this is the middle that was silently assumed: the reader that
 * turns `.novel/novel.json` plus the Markdown it indexes into the state the
 * board projects. It is driven against a project the **store** wrote, so a
 * format change on the writing side fails here rather than in a browser.
 */

let root: string
let ctx: Context
let store: NovelStore
let clock: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ai-novelist-client-'))
  clock = '2024-05-01T00:00:00.000Z'
  ctx = new Context()
  ctx.plugin(LocalFileSystem, { cwd: root, diffBasisMaxBytes: 64 * 1024 })
  store = new NovelStore(ctx, { workspaceRoot: root, clock: () => clock })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/**
 * The shell's Remote, as the reader calls it, backed by the real filesystem.
 *
 * Only the calls the reader makes exist. `read` answers a whole file in one page
 * (`eof: true`), which is what the real one does for a document under the page
 * size, and it reports a missing file with the generated Remote's own
 * `workspace-file/not-found` code — the code the reader treats as absence.
 *
 * @param workspaceRoot - directory relative paths resolve against.
 * @returns the fake face.
 */
function remoteOver(workspaceRoot: string): ClientRemote {
  return {
    workspaceFiles: {
      read: async (_sessionId: string, path: string) => {
        const target = isAbsolute(path) ? path : join(workspaceRoot, path)
        try {
          return { ok: true as const, value: { text: await readFile(target, 'utf8'), eof: true } }
        } catch {
          return { ok: false as const, error: { code: 'workspace-file/not-found', message: target } }
        }
      },
      // Reaching for a second page would mean the fixture outgrew one, which
      // would make this spec read a partial JSON document and fail confusingly.
      readAll: () => Promise.reject(new Error('unexpected second page')),
    },
  } as unknown as ClientRemote
}

/** The session identity a read is addressed by; the fake ignores it. */
const SESSION = 'session-client-read' as SessionId

describe('readProject', () => {
  it('turns a store-written project into the board the Kanban view shows', async () => {
    await store.create(emptyNovel({ title: '青云记', premise: '少年上山' }, () => clock))
    await store.update((current) =>
      upsertChapter(current, { id: 'ch-1', number: 1, title: '山门', body: '少年拾级而上。' }, () => clock),
    )

    const read = await readProject(remoteOver(root), SESSION, new AbortController().signal, root)

    expect(read.status).toBe('ready')
    if (read.status !== 'ready') return
    expect(read.state.meta.title).toBe('青云记')
    expect(Object.values(read.state.chapters)).toHaveLength(1)
    // The card the view renders is the one the store wrote, in its own column.
    const cards = boardOf(read.state).columns.flatMap((column) => column.cards)
    expect(cards.map((card) => card.title)).toEqual(['山门'])
    expect(cards[0]?.wordCount).toBe(6)
  })

  it('answers "no project" where the workspace holds no document', async () => {
    // Which is the one state the view renders as nothing, so no tab appears.
    const read = await readProject(remoteOver(root), SESSION, new AbortController().signal, root)
    expect(read).toEqual({ status: 'none' })
  })
})
