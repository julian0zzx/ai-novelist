import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { Config, apply } from '../src/index.ts'
import { NovelStore } from '../src/host/store.ts'
import { emptyNovel, upsertChapter, type NovelState } from '../src/core/index.ts'

/**
 * `novel_review`, driven end to end against a fake model.
 *
 * This is the spec that keeps the one non-deterministic feature honest. The
 * model is the only thing that cannot be pinned, so it is the only thing faked:
 * every other layer — routing, prompt framing, parsing, recording, the derived
 * transcript — runs for real, against a real filesystem and a real store.
 *
 * The properties asserted here are the promises the tool makes: the seven
 * deterministic tools never need a model, a review never edits prose, a
 * judgement records the model and rubric that produced it, and nothing a model
 * wrote enters the ledger unless the author asked for it.
 */
let root: string
let ctx: Context
let tools: Map<string, ToolDefinition>
/** Every request the fake model was asked to answer, in order. */
let calls: { provider: string; model: string; system: string; user: string }[]
/** What the fake model replies with, in order; the last entry repeats. */
let replies: string[]
/** Finish reason the fake stream ends with. */
let finish: 'stop' | 'max-tokens' | 'tool-calls'

/** Minimal stand-in for the `tools` service: records what a plugin registers. */
const recorder = {
  name: 'tools-recorder',
  apply(target: Context) {
    const definitions = new Map<string, ToolDefinition>()
    tools = definitions
    target.provide('tools', {
      register: (definition: ToolDefinition) => {
        definitions.set(definition.name, definition)
        return () => definitions.delete(definition.name)
      },
    })
  },
}

/**
 * The fake model: a `llm` service and the default-model selection beside it.
 *
 * `stream` yields the chunk vocabulary `BlockAssembler` expects, so the seam
 * under test is the real one.
 */
const fakeModel = {
  name: 'fake-llm',
  apply(target: Context) {
    target.provide('llm', {
      stream: (options: { provider: string; model: string; system?: string }) => {
        const messages = (options as unknown as { messages: { content: { text: string }[] }[] }).messages
        calls.push({
          provider: options.provider,
          model: options.model,
          system: options.system ?? '',
          user: messages[0]?.content[0]?.text ?? '',
        })
        const text = replies.length > 1 ? (replies.shift() ?? '') : (replies[0] ?? '')
        return (async function* () {
          yield { type: 'block-start' as const, index: 0, blockType: 'text' as const }
          yield { type: 'text-delta' as const, index: 0, text }
          yield { type: 'block-end' as const, index: 0, block: { type: 'text' as const, text } }
          yield { type: 'finish' as const, reason: { kind: finish } }
        })()
      },
    })
    target.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    })
  },
}

/** One tool call, as the agent loop would dispatch it. */
async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const definition = tools.get(name)
  if (definition === undefined) throw new Error(`tool ${name} is not registered`)
  return (await definition.execute(args, { signal: new AbortController().signal } as never)) as Record<string, unknown>
}

/** The rendered text of one tool call, for asserting what the model is told. */
async function callText(name: string, args: Record<string, unknown>): Promise<string> {
  const definition = tools.get(name)
  if (definition === undefined) throw new Error(`tool ${name} is not registered`)
  const value = (await definition.execute(args, { signal: new AbortController().signal } as never)) as Record<
    string,
    unknown
  >
  return definition.output
    .render(args, value as never)
    .map((block) => ('text' in block ? block.text : ''))
    .join('\n')
}

/**
 * The store the mounted plugin uses, for inspecting what landed on disk.
 *
 * Built over the same workspace root and filesystem as the plugin's own, which is
 * the point: the assertion below then reads the project exactly as a second
 * session would, from the files rather than from any in-memory copy.
 */
function store(): NovelStore {
  return new NovelStore(ctx, { workspaceRoot: root, clock: () => '2026-01-01T00:00:00.000Z' })
}

/** The stored project, re-read from the files. */
async function stored(): Promise<NovelState> {
  const state = await store().read()
  if (state === undefined) throw new Error('no project in the workspace')
  return state
}

/**
 * A project with the author's settings sign-off and one written chapter.
 *
 * Seeded through the store's own write path rather than through the tools: these
 * specs are about `novel_review`, so the checkpoints `novel_write` enforces are
 * satisfied here instead of being exercised again.
 */
async function seed(chapterBody = '山门很高，云雾不散。他握紧断剑，没有回答守门弟子的问题。'): Promise<void> {
  const at = (): string => '2026-01-01T00:00:00.000Z'
  const base = emptyNovel({ title: '青云记', premise: '少年持断剑上山' }, at)
  const signed: NovelState = {
    ...base,
    discussions: [
      {
        id: 'discuss-settings-1',
        kind: 'settings',
        at: at(),
        proposal: '第一版设定：沉默少年持断剑上山，冷开局。',
        feedback: '主角再冷一点，别一上来就热血。',
        topics: ['立意'],
      },
      {
        id: 'discuss-settings-2',
        kind: 'settings',
        at: at(),
        proposal: '按你的意见改成沉默寡言，删掉复仇宣言。',
        feedback: '可以，就按这版来。',
        topics: ['人设'],
      },
    ],
    confirmations: [
      {
        id: 'confirm-settings-1',
        kind: 'settings',
        at: at(),
        summary: '沉默少年持断剑上山，冷开局，不喊口号。',
        note: '可以，就按这版来。',
        rounds: 2,
      },
    ],
  }
  const state = upsertChapter(
    signed,
    { id: 'chapter-1', number: 1, title: '山门', plotTask: '林越抵达山门', hook: '钟响', body: chapterBody },
    at,
  )
  await store().create(state)
}

const FINDINGS = JSON.stringify({
  summary: '这一章动作清楚，但有三处在替读者总结情绪。',
  findings: [
    {
      dimension: '总结式抒情',
      quote: '他心中五味杂陈',
      why: '把情绪讲出来，没有让读者自己感到',
      fix: '换成他手上的动作或眼前的物件',
      severity: 'high',
    },
    {
      dimension: '整齐句式',
      quote: '山门很高，云雾不散',
      why: '两句等长对仗，像文案不像叙述',
      fix: '拆成不等长的两句',
      severity: 'low',
    },
  ],
})

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ai-novelist-review-'))
  calls = []
  replies = [FINDINGS]
  finish = 'stop'
  ctx = new Context()
  ctx.plugin(LocalFileSystem, { cwd: root, diffBasisMaxBytes: 64 * 1024 })
  ctx.plugin(recorder)
  await until(() => ctx.get('tools') !== undefined)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Wait for a condition to hold, up to a short deadline. */
async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('novel_review registration', () => {
  it('is absent without a model, so the eight deterministic tools never need one', async () => {
    apply(ctx, Config({ workspaceRoot: root }) as never)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect([...tools.keys()].sort()).toEqual([
      'novel_assess',
      'novel_bible',
      'novel_confirm',
      'novel_init',
      'novel_plan',
      'novel_repo',
      'novel_status',
      'novel_write',
    ])
  })

  it('appears as the ninth tool once a model route exists', async () => {
    ctx.plugin(fakeModel)
    apply(ctx, Config({ workspaceRoot: root }) as never)
    await until(() => tools.has('novel_review'))
    expect(tools.size).toBe(9)
  })
})

describe('novel_review routing', () => {
  beforeEach(async () => {
    ctx.plugin(fakeModel)
    apply(ctx, Config({ workspaceRoot: root }) as never)
    await until(() => tools.has('novel_review'))
    await seed()
  })

  it('follows the session default model when nothing is configured', async () => {
    const result = await call('novel_review', { operation: 'ai-flavor', chapterId: 'chapter-1' })
    expect(calls[0]?.provider).toBe('deepseek')
    expect(calls[0]?.model).toBe('deepseek-chat')
    expect(String(result['detail'])).toContain('deepseek/deepseek-chat')
    expect((await stored()).reviews[0]?.provider).toBe('deepseek')
  })

  it('lets one call name its own model', async () => {
    await call('novel_review', {
      operation: 'ai-flavor',
      chapterId: 'chapter-1',
      provider: 'deepseek',
      model: 'deepseek-reasoner',
    })
    expect(calls[0]?.model).toBe('deepseek-reasoner')
  })

  it('refuses to guess when nothing names a model', async () => {
    const bare = new Context()
    bare.plugin(LocalFileSystem, { cwd: root, diffBasisMaxBytes: 64 * 1024 })
    const definitions = new Map<string, ToolDefinition>()
    bare.plugin({
      name: 'tools-recorder',
      apply(target: Context) {
        target.provide('tools', {
          register: (definition: ToolDefinition) => {
            definitions.set(definition.name, definition)
            return () => definitions.delete(definition.name)
          },
        })
      },
    })
    // A model service, but no configured route and no default selection.
    bare.plugin({
      name: 'llm-only',
      apply(target: Context) {
        target.provide('llm', { stream: () => (async function* () {})() })
      },
    })
    await until(() => bare.get('tools') !== undefined)
    apply(bare, Config({ workspaceRoot: root }) as never)
    await until(() => definitions.has('novel_review'))
    const definition = definitions.get('novel_review')
    await expect(
      definition?.execute({ operation: 'ai-flavor', chapterId: 'chapter-1' }, {
        signal: new AbortController().signal,
      } as never),
    ).rejects.toThrow(/no model route/)
  })
})

describe('novel_review operations', () => {
  beforeEach(async () => {
    ctx.plugin(fakeModel)
    apply(ctx, Config({ workspaceRoot: root }) as never)
    await until(() => tools.has('novel_review'))
    await seed()
  })

  it('diagnoses a chapter, records the judgement, and leaves the prose alone', async () => {
    const text = await callText('novel_review', { operation: 'ai-flavor', chapterId: 'chapter-1' })
    expect(text).toContain('总结式抒情')
    expect(text).toContain('他心中五味杂陈')
    expect(text).toContain('prompt review-rubric-2')

    const state = await stored()
    expect(state.reviews).toHaveLength(1)
    expect(state.reviews[0]).toMatchObject({
      id: 'review-1',
      kind: 'ai-flavor',
      target: 'chapter-1',
      model: 'deepseek-chat',
      promptVersion: 'review-rubric-2',
    })
    // Highest severity first, whatever order the model used.
    expect(state.reviews[0]?.findings.map((finding) => finding.severity)).toEqual(['high', 'low'])
    expect(state.chapters['chapter-1']?.body).toContain('山门很高')
    expect(state.chapters['chapter-1']?.body).not.toContain('五味杂陈')
  })

  it('keeps the model transcript beside the project', async () => {
    await call('novel_review', { operation: 'ai-flavor', chapterId: 'chapter-1' })
    const transcript = await readFile(join(root, '.novel/reviews/review-1-ai-flavor.md'), 'utf8')
    expect(transcript).toContain('review-rubric-2')
    expect(transcript).toContain('deepseek/deepseek-chat')
    expect(transcript).toContain('模型原始回复')
    expect(transcript).toContain('五味杂陈')
    expect((await stored()).reviews[0]?.artifact).toBe('.novel/reviews/review-1-ai-flavor.md')
  })

  it('sends the rubric and the chapter, and asks for a rewrite only when asked', async () => {
    await call('novel_review', { operation: 'ai-flavor', chapterId: 'chapter-1' })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.system).toContain('像 AI 写的')
    expect(calls[0]?.system).toContain('翻译腔')
    expect(calls[0]?.user).toContain('山门很高')

    replies = [FINDINGS, '山门很高。云雾压着石阶。他握紧断剑。']
    await call('novel_review', { operation: 'ai-flavor', chapterId: 'chapter-1', rewrite: true })
    expect(calls).toHaveLength(3)
    const rewrite = await readFile(join(root, '.novel/reviews/review-2-rewrite.md'), 'utf8')
    expect(rewrite).toContain('云雾压着石阶')
    // A proposal, never the chapter itself.
    expect((await stored()).chapters['chapter-1']?.body).not.toContain('云雾压着石阶')
  })

  it('judges the chapter against the book’s own style, and hands over what was counted', async () => {
    // The two additions that make the diagnosis specific to *this* book: the
    // 写作风格 it is supposed to be written in (including the 负面清单), and the
    // contrast frames the mechanical pass already counted, which the model is
    // asked to judge rather than to re-count.
    const body = '他不是没听见，是不想听见。这不是钱的事，是命的事。'
    // The chapter body is set through the store's own write path, because
    // `beforeEach` has already seeded the project.
    const at = (): string => '2026-01-01T00:00:00.000Z'
    await store().update((current) =>
      upsertChapter(current, { id: 'chapter-1', body }, at),
    )
    await call('novel_review', { operation: 'ai-flavor', chapterId: 'chapter-1' })
    expect(calls[0]?.user).toContain('本书《写作风格》')
    expect(calls[0]?.user).toContain('负面清单')
    expect(calls[0]?.system).toContain('违反本书自己写下的')
    expect(calls[0]?.user).toContain('机械统计已发现')
    expect(calls[0]?.user).toContain('对举句式共 2 处')
  })

  it('honours a dimension filter', async () => {
    await call('novel_review', { operation: 'ai-flavor', chapterId: 'chapter-1', focus: ['翻译腔'] })
    expect(calls[0]?.system).toContain('翻译腔')
    expect(calls[0]?.system).not.toContain('解释型对话')
  })

  it('reviews the opening without touching the plan', async () => {
    const text = await callText('novel_review', { operation: 'opening' })
    expect(text).toContain('opening 诊断')
    expect(calls[0]?.user).toContain('开篇正文')
    expect(calls[0]?.user).toContain('山门很高')
    expect((await stored()).outline.opening.every((check) => !check.done)).toBe(true)
  })

  it('returns a competitor dismantle without saving it by default', async () => {
    replies = [
      JSON.stringify({
        summary: '开篇三章一个爽点，钩子具体。',
        findings: [],
        dismantle: {
          tags: ['玄幻', '复仇'],
          blurb: '断剑少年',
          openingEvent: '被逐出师门',
          goldenFinger: '断剑认主',
          protagonistDesire: '重上山门',
          antagonistMotive: '守住位置',
          shuangFrequency: '每2章',
          emotionCurve: '压抑转爆发',
          paywallPoint: '第12章',
          chapterHooks: '悬念+反转',
          commentKeywords: ['断剑'],
          takeaway: '开篇即冲突',
        },
      }),
    ]
    const text = await callText('novel_review', { operation: 'competitor', title: '断剑', text: '第一章……' })
    expect(text).toContain('尚未入库')
    expect((await stored()).competitors).toHaveLength(0)

    await call('novel_review', { operation: 'competitor', title: '断剑', text: '第一章……', save: true })
    const state = await stored()
    expect(state.competitors).toHaveLength(1)
    expect(state.competitors[0]).toMatchObject({ id: '断剑', title: '断剑', goldenFinger: '断剑认主' })
  })

  it('refuses a competitor call without material', async () => {
    await expect(call('novel_review', { operation: 'competitor' })).rejects.toThrow(/needs the competitor material/)
  })

  it('distils lessons, and only archives them into an existing retrospective', async () => {
    replies = [
      JSON.stringify({
        summary: '数据不足，但两次钩子调整后追读回升。',
        findings: [],
        lessons: [
          { kind: 'reuse', statement: '章末留具体动作的钩子', evidence: 'iteration-1 后追读回升', area: 'hook' },
          { kind: 'avoid', statement: '开篇一次交代三条设定线', evidence: '第3章读完偏低', area: 'opening' },
        ],
      }),
    ]
    const text = await callText('novel_review', { operation: 'retro', save: true })
    expect(text).toContain('还没有复盘记录')
    expect((await stored()).retro).toBeUndefined()

    await call('novel_repo', { operation: 'retro' })
    const saved = await callText('novel_review', { operation: 'retro', save: true })
    expect(saved).toContain('已归档经验 2 条')
    const state = await stored()
    expect(state.retro?.lessons.map((lesson) => lesson.kind)).toEqual(['reuse', 'avoid'])
  })
})

describe('novel_review failure handling', () => {
  beforeEach(async () => {
    ctx.plugin(fakeModel)
    apply(ctx, Config({ workspaceRoot: root }) as never)
    await until(() => tools.has('novel_review'))
    await seed()
  })

  it('records the call even when the model ignores the JSON contract', async () => {
    replies = ['这一章读起来还行，就是有点平。']
    const result = await call('novel_review', { operation: 'ai-flavor', chapterId: 'chapter-1' })
    expect((result['warnings'] as string[]).join(' ')).toMatch(/没有按 JSON 约定回复/)
    const state = await stored()
    expect(state.reviews[0]?.findings).toEqual([])
    expect(state.reviews[0]?.summary).toContain('这一章读起来还行')
    expect(await readFile(join(root, '.novel/reviews/review-1-ai-flavor.md'), 'utf8')).toContain('结构化解析：失败')
  })

  it('warns when the model ran out of output budget', async () => {
    finish = 'max-tokens'
    const result = await call('novel_review', { operation: 'ai-flavor', chapterId: 'chapter-1' })
    expect((result['warnings'] as string[]).join(' ')).toMatch(/截断/)
  })

  it('refuses a chapter that has no prose yet', async () => {
    // A second chapter that is planned but still unwritten. Reaching it through a
    // write that empties chapter 1 would trip the prose gate instead — rightly, a
    // write that deletes prose is not how a chapter comes to have none — and this
    // spec is about what novel_review does with such a chapter.
    await call('novel_plan', { operation: 'chapter', id: 'chapter-2', title: '梦醒', number: 2, plotTask: '醒来' })
    await expect(call('novel_review', { operation: 'ai-flavor', chapterId: 'chapter-2' })).rejects.toThrow(
      /还没有正文/,
    )
  })
})
