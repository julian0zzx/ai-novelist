import { describe, expect, it, vi } from 'vitest'
import { emptyNovel, upsertChapter } from '../src/core/novel.ts'
import type { NovelState } from '../src/core/types.ts'
import { MAX_SAVE_CHARS, SAVE_COMMAND, chapterSaveLine, parseSaveInput } from '../src/core/save.ts'
import type { ChapterSavePayload } from '../src/core/save.ts'
import { saveChapterBody } from '../src/client/save.ts'
import { registerSaveCommand, saveChapterEdit } from '../src/host/commands.ts'
import type { NovelStore } from '../src/host/store.ts'

/**
 * Specs for the board's save channel.
 *
 * Three layers, each specified without the one above it: the shared parse (no
 * host, no browser), the host merge against a fake store (no filesystem), and
 * the client's Remote call against a fake Remote (no React). The real store's
 * write path is already covered by `store.test.ts`; what is new here is the
 * wire shape and the stale-editor refusal.
 */

const at = (): string => '2026-01-02T03:04:05.000Z'

/** A project holding one chapter, as the board would have read it. */
function project(body = '旧稿正文', status: 'planned' | 'drafting' | 'revised' | 'final' = 'drafting'): NovelState {
  const base = upsertChapter(
    emptyNovel(),
    { id: 'ch-001', number: 1, title: '开篇', body, status },
    at,
  )
  return base
}

/** The slice of `NovelStore` a save uses, recording what it was asked to do. */
function fakeStore(state: NovelState): {
  readonly store: NovelStore
  readonly archives: string[]
  readonly state: () => NovelState
} {
  let current = state
  const archives: string[] = []
  const store = {
    async update(mutate: (state: NovelState) => NovelState | Promise<NovelState>) {
      current = await mutate(current)
      return current
    },
    async archiveChapterVersion(chapter: { readonly id: string }, stamp: string) {
      archives.push(`${chapter.id}@${stamp}`)
      return '.novel/versions/ch-001.md'
    },
  } as unknown as NovelStore
  return { store, archives, state: () => current }
}

function payload(overrides: Partial<ChapterSavePayload> = {}): ChapterSavePayload {
  return { kind: 'chapter', id: 'ch-001', text: '新写的正文', base: '旧稿正文', ...overrides }
}

describe('parseSaveInput', () => {
  it('accepts the board payload and keeps the body verbatim', () => {
    const body = '第一段\n\n第二段，带「引号」。'
    const parsed = parseSaveInput(JSON.stringify(payload({ text: body })))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.payload.text).toBe(body)
    expect(parsed.payload.id).toBe('ch-001')
    expect(parsed.payload.base).toBe('旧稿正文')
  })

  it('rejects empty, non-JSON, and wrong-kind input with a message the board can show', () => {
    for (const raw of ['', '   ', '{', 'null', '[]', '{"kind":"chapter"}', '{"kind":"file","path":"x"}']) {
      const parsed = parseSaveInput(raw)
      expect(parsed.ok).toBe(false)
      if (parsed.ok) continue
      expect(parsed.message.length).toBeGreaterThan(0)
    }
  })

  it('rejects a payload without base, id, or text', () => {
    for (const record of [
      { kind: 'chapter', text: 'x', base: 'y' },
      { kind: 'chapter', id: 'ch-001', text: 'x' },
      { kind: 'chapter', id: 'ch-001', base: 'y' },
    ]) {
      expect(parseSaveInput(JSON.stringify(record)).ok).toBe(false)
    }
  })

  it('refuses a body larger than one save carries', () => {
    const parsed = parseSaveInput(JSON.stringify(payload({ text: 'x'.repeat(MAX_SAVE_CHARS + 1) })))
    expect(parsed.ok).toBe(false)
  })
})

describe('chapterSaveLine', () => {
  it('is one slash-command line the host parse accepts back', () => {
    const line = chapterSaveLine(payload())
    expect(line.startsWith(`/${SAVE_COMMAND} `)).toBe(true)
    const parsed = parseSaveInput(line.slice(SAVE_COMMAND.length + 2))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.payload).toEqual(payload())
  })
})

describe('saveChapterEdit', () => {
  it('writes the new body, archives the replaced prose, and keeps the status', async () => {
    const fake = fakeStore(project('旧稿正文', 'drafting'))
    const outcome = await saveChapterEdit(fake.store, payload(), at)
    expect(fake.state().chapters['ch-001']?.body).toBe('新写的正文')
    expect(fake.state().chapters['ch-001']?.status).toBe('drafting')
    expect(fake.archives.length).toBe(1)
    expect(outcome.archived).toBe('.novel/versions/ch-001.md')
    expect(outcome.number).toBe(1)
    expect(outcome.wordCount).toBeGreaterThan(0)
  })

  it('promotes a planned chapter to drafting when the first body arrives, without archiving', async () => {
    const fake = fakeStore(project('', 'planned'))
    const outcome = await saveChapterEdit(fake.store, payload({ base: '' }), at)
    expect(fake.state().chapters['ch-001']?.status).toBe('drafting')
    expect(fake.archives.length).toBe(0)
    expect(outcome.archived).toBeUndefined()
  })

  it('refuses a stale editor instead of overwriting prose written meanwhile', async () => {
    const fake = fakeStore(project('agent 刚写的新稿', 'drafting'))
    await expect(saveChapterEdit(fake.store, payload({ base: '旧稿正文' }), at)).rejects.toThrow(/被改过/u)
    expect(fake.archives.length).toBe(0)
    expect(fake.state().chapters['ch-001']?.body).toBe('agent 刚写的新稿')
  })

  it('does not archive when the body is unchanged', async () => {
    const fake = fakeStore(project('同一段', 'drafting'))
    await saveChapterEdit(fake.store, payload({ text: '同一段', base: '同一段' }), at)
    expect(fake.archives.length).toBe(0)
  })

  it('refuses an unknown chapter', async () => {
    const fake = fakeStore(project())
    await expect(saveChapterEdit(fake.store, payload({ id: 'ch-999' }), at)).rejects.toThrow(/找不到章节/u)
  })
})

describe('registerSaveCommand', () => {
  /** A fake plugin context exposing one command registry, recording definitions. */
  function fakeContext(registered: { name: string; recordInput?: boolean; handler: (invocation: never) => Promise<unknown> }[]) {
    return {
      reflect: {
        get: (name: string) =>
          name === 'commands'
            ? {
                register: (definition: { name: string; recordInput?: boolean; handler: (invocation: never) => Promise<unknown> }) => {
                  registered.push(definition)
                  return () => undefined
                },
              }
            : undefined,
      },
      effect: (callback: () => () => void) => callback(),
      // No confining backend: `policyForSession` resolves to undefined, which is
      // the same policy the store would pick up outside a sandbox.
      fs: {},
      get: () => undefined,
    }
  }

  it('does nothing where the profile has no command service', () => {
    const registered: unknown[] = []
    registerSaveCommand({ reflect: { get: () => undefined }, effect: () => undefined } as never, {} as never, {} as never)
    expect(registered).toHaveLength(0)
  })

  it('registers novel-save, records no input, and applies the handler through the store', async () => {
    const registered: { name: string; recordInput?: boolean; handler: (invocation: never) => Promise<{ kind: string; text?: string }> }[] = []
    const fake = fakeStore(project('旧稿正文', 'drafting'))
    const refresh = vi.fn(async () => undefined)
    const projects = { storeForSession: () => fake.store }
    const views = { viewForSession: () => ({ refresh }) }
    registerSaveCommand(fakeContext(registered) as never, projects as never, views as never)
    expect(registered).toHaveLength(1)
    const definition = registered[0]
    expect(definition?.name).toBe(SAVE_COMMAND)
    expect(definition?.recordInput).toBe(false)
    const result = await definition!.handler({
      agent: { session: { header: { cwd: '/tmp/novel' } } },
      rawInput: JSON.stringify(payload()),
    } as never)
    expect(result.kind).toBe('success')
    expect(result.text).toContain('第 1 章已保存')
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('answers a malformed save with an error result rather than throwing', async () => {
    const registered: { name: string; handler: (invocation: never) => Promise<{ kind: string; text?: string }> }[] = []
    registerSaveCommand(fakeContext(registered) as never, {} as never, {} as never)
    const result = await registered[0]!.handler({ agent: {}, rawInput: 'not json' } as never)
    expect(result.kind).toBe('error')
    expect(result.text).toContain('JSON')
  })
})

describe('saveChapterBody', () => {
  /** A Remote shaped the way the client assembly provides it. */
  function remoteWith(execute: (...args: never[]) => unknown) {
    return { commands: { execute } } as never
  }

  it('sends one command line and reports success text', async () => {
    const execute = vi.fn(async () => ({
      ok: true as const,
      value: { result: { kind: 'success' as const, text: '第 1 章已保存：4 字' } },
    }))
    const outcome = await saveChapterBody(remoteWith(execute as never), 'session-1' as never, payload())
    expect(outcome).toEqual({ ok: true, text: '第 1 章已保存：4 字' })
    const [sessionId, line] = execute.mock.calls[0] as unknown as [string, string]
    expect(sessionId).toBe('session-1')
    expect(line.startsWith(`/${SAVE_COMMAND} `)).toBe(true)
  })

  it('maps a handler error result to the message the modal shows', async () => {
    const execute = vi.fn(async () => ({
      ok: true as const,
      value: { result: { kind: 'error' as const, text: '这一章在编辑器打开之后被改过' } },
    }))
    const outcome = await saveChapterBody(remoteWith(execute as never), 'session-1' as never, payload())
    expect(outcome).toEqual({ ok: false, message: '这一章在编辑器打开之后被改过' })
  })

  it('surfaces a transport failure with its code', async () => {
    const execute = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'gateway/not-found', message: 'no such session' },
    }))
    const outcome = await saveChapterBody(remoteWith(execute as never), 'session-1' as never, payload())
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.message).toContain('gateway/not-found')
  })

  it('explains an unregistered command as a host that needs a restart', async () => {
    const execute = vi.fn(async () => ({ ok: true as const, value: undefined }))
    const outcome = await saveChapterBody(remoteWith(execute as never), 'session-1' as never, payload())
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.message).toContain('重启')
  })

  it('explains a Remote without a commands namespace instead of throwing', async () => {
    const outcome = await saveChapterBody({} as never, 'session-1' as never, payload())
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.message).toContain('命令通道')
  })
})
