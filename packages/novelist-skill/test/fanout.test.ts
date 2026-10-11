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
import { resolveSubagentProvider, runReviewFanout } from '../src/host/llm.ts'

/**
 * The competitor fan-out: one child agent per book.
 *
 * The SOP asks for twenty to fifty same-shelf titles dismantled, and each is
 * independent of every other, so a sequence of one-shot calls buys nothing but
 * latency. These specs pin the three promises the batch makes: it really does run
 * the books concurrently where the host can, it degrades to the sequential path
 * rather than failing where it cannot, and a dead child costs its own book rather
 * than the batch.
 */
let root: string
let ctx: Context
let tools: Map<string, ToolDefinition>
/** Every request the fake model was asked to answer directly, in order. */
let llmCalls: { system: string; user: string }[]
/** What the fake model replies with, in order; the last entry repeats. */
let replies: string[]
/** Every child the fake subagent runtime was asked to start. */
let spawns: { provider: string; label: string; text: string }[]
/** Titles whose child should fail, to exercise a partial batch. */
let failChildFor: string[]
/** Provider names the fake registry reports. */
let providers: string[]

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

/** The fake model, for the sequential path and for routing. */
const fakeModel = {
  name: 'fake-llm',
  apply(target: Context) {
    target.provide('llm', {
      stream: (options: { system?: string; messages: { content: { text: string }[] }[] }) => {
        llmCalls.push({ system: options.system ?? '', user: options.messages[0]?.content[0]?.text ?? '' })
        const text = replies.length > 1 ? (replies.shift() ?? '') : (replies[0] ?? '')
        return (async function* () {
          yield { type: 'block-start' as const, index: 0, blockType: 'text' as const }
          yield { type: 'text-delta' as const, index: 0, text }
          yield { type: 'block-end' as const, index: 0, block: { type: 'text' as const, text } }
          yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
        })()
      },
    })
    target.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    })
  },
}

/**
 * The fake subagent runtime.
 *
 * `list()` is what the plugin reads to discover providers, and `start` returns the
 * one-shot run shape the real seam publishes, so the plugin's own code path is
 * exercised rather than a stand-in for it.
 */
const fakeSubagents = {
  name: 'fake-subagents',
  apply(target: Context) {
    target.provide('subagents', {
      list: () => [...providers],
      start: async (provider: string, request: { label?: string; prompt: { text: string }[] }) => {
        const text = request.prompt[0]?.text ?? ''
        spawns.push({ provider, label: request.label ?? '', text })
        const doomed = failChildFor.some((title) => text.includes(title))
        return {
          id: `child-${String(spawns.length)}`,
          localAgent: undefined,
          result: Promise.resolve(
            doomed
              ? { output: [], stopReason: 'error' as const, diagnostic: 'the child crashed' }
              : {
                  output: [{ type: 'text' as const, text: dismantleJson(titleIn(text)) }],
                  stopReason: 'completed' as const,
                },
          ),
          dispose: async () => undefined,
        }
      },
    })
  },
}

/** A dismantle reply shaped the way the competitor rubric asks for it. */
function dismantleJson(title: string): string {
  return JSON.stringify({
    summary: `${title}：冷开局，爽点密。`,
    findings: [],
    dismantle: {
      tags: ['玄幻'],
      blurb: `${title} 的简介`,
      openingEvent: '开局被逐',
      goldenFinger: '断剑认主',
      protagonistDesire: '上山',
      antagonistMotive: '压住旧案',
      shuangFrequency: '每 3 章',
      emotionCurve: '压抑转爽',
      paywallPoint: '第 10 章',
      chapterHooks: '章末留悬念',
      commentKeywords: ['爽'],
      takeaway: '冷开局可用',
      title,
    },
  })
}

/**
 * The book a child was asked to read, taken from its prompt.
 *
 * A real child learns the title from the request, not from its display label, so
 * the fake does the same — otherwise the label could drift from the book and the
 * spec would not notice.
 */
function titleIn(prompt: string): string {
  return /竞品书名：(.+)/u.exec(prompt)?.[1]?.trim() ?? '（未命名竞品）'
}

/** One tool call, as the agent loop would dispatch it, with an agent attached. */
async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const definition = tools.get(name)
  if (definition === undefined) throw new Error(`tool ${name} is not registered`)
  const exec = { signal: new AbortController().signal, agent: { session: { header: { cwd: root, id: 'session-1' } } } }
  return (await definition.execute(args, exec as never)) as Record<string, unknown>
}

async function seeded(): Promise<void> {
  await call('novel_init', { title: '青云记' })
}

/** The project as the store reads it back. */
async function readState(): Promise<NovelState> {
  const store = new NovelStore(ctx, { workspaceRoot: root, clock: () => '2026-01-01T00:00:00.000Z' })
  const state = await store.read()
  if (state === undefined) throw new Error('the project is missing')
  return state
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ai-novelist-fanout-'))
  tools = new Map()
  llmCalls = []
  replies = [dismantleJson('默认')]
  spawns = []
  failChildFor = []
  providers = ['spawn']
  ctx = new Context()
  ctx.plugin(LocalFileSystem, { cwd: root, diffBasisMaxBytes: 64 * 1024 })
  ctx.plugin(recorder)
  ctx.plugin(fakeModel)
  ctx.plugin(fakeSubagents)
  await new Promise((resolve) => setTimeout(resolve, 0))
  apply(ctx, Config({ workspaceRoot: root }) as never)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('choosing a provider', () => {
  it('prefers the general-purpose spawn provider, and falls back to whatever is registered', () => {
    expect(resolveSubagentProvider(ctx)).toBe('spawn')
    providers = ['acp', 'spawn']
    expect(resolveSubagentProvider(ctx)).toBe('spawn')
    providers = ['acp']
    expect(resolveSubagentProvider(ctx)).toBe('acp')
    providers = []
    expect(resolveSubagentProvider(ctx)).toBeUndefined()
  })

  it('returns undefined where no subagents service is mounted at all', () => {
    const bare = new Context()
    expect(resolveSubagentProvider(bare)).toBeUndefined()
  })
})

describe('running the seam directly', () => {
  it('runs one child per request, in order, and reports a failed child without throwing', async () => {
    failChildFor = ['第二本']
    const requests = ['第一本', '第二本', '第三本'].map((title) => ({ system: 's', user: title, maxTokens: 100 }))
    const outcomes = await runReviewFanout(ctx, 'spawn', { session: 'parent' }, requests, { timeoutMs: 5000 })
    expect(outcomes).toHaveLength(3)
    expect(outcomes.map((outcome) => outcome.index)).toEqual([0, 1, 2])
    expect(outcomes[0]?.error).toBe('')
    expect(outcomes[1]?.text).toBe('')
    expect(outcomes[1]?.error).toMatch(/stopped: error/u)
    expect(outcomes[2]?.error).toBe('')
    expect(spawns).toHaveLength(3)
  })
})

describe('the batch through the tool', () => {
  it('dismantles every target with its own child and records each one separately', async () => {
    await seeded()
    const result = await call('novel_review', {
      operation: 'competitor',
      targets: [
        { title: '同榜甲', text: '甲的开篇' },
        { title: '同榜乙', text: '乙的开篇' },
        { title: '同榜丙', text: '丙的开篇' },
      ],
      save: true,
    })

    expect(result['ok']).toBe(true)
    expect(spawns).toHaveLength(3)
    // One child per book, and the direct model was never called for them.
    expect(llmCalls).toHaveLength(0)
    expect(spawns.map((spawn) => spawn.provider)).toEqual(['spawn', 'spawn', 'spawn'])

    const state = await readState()
    expect(state.competitors.map((entry) => entry.title).sort()).toEqual(['同榜丙', '同榜乙', '同榜甲'])
    // Provenance stays per book: one ledger record and one transcript each.
    expect(state.reviews).toHaveLength(3)
    expect(state.reviews.map((review) => review.target).sort()).toEqual(['同榜丙', '同榜乙', '同榜甲'])
    for (const review of state.reviews) {
      expect(review.model).toBe('deepseek-chat')
      // `artifact` is already absolute, as `writeDerived` returns it.
      expect(await readFile(review.artifact, 'utf8')).toContain(review.target)
    }
  })

  it('keeps what survived when a child dies, and says which book it lost', async () => {
    await seeded()
    failChildFor = ['同榜乙']
    const result = await call('novel_review', {
      operation: 'competitor',
      targets: [
        { title: '同榜甲', text: '甲的开篇' },
        { title: '同榜乙', text: '乙的开篇' },
      ],
      save: true,
    })

    expect(result['ok']).toBe(false)
    const warnings = (result['warnings'] as string[]).join(' ')
    expect(warnings).toMatch(/同榜乙/u)
    const state = await readState()
    expect(state.competitors.map((entry) => entry.title)).toEqual(['同榜甲'])
    expect(state.reviews).toHaveLength(1)
  })

  it('falls back to the sequential path where the host has no subagent provider', async () => {
    await seeded()
    providers = []
    replies = [dismantleJson('同榜甲'), dismantleJson('同榜乙')]
    const result = await call('novel_review', {
      operation: 'competitor',
      targets: [
        { title: '同榜甲', text: '甲的开篇' },
        { title: '同榜乙', text: '乙的开篇' },
      ],
      save: true,
    })

    expect(result['ok']).toBe(true)
    expect(spawns).toHaveLength(0)
    // The direct model did the work instead, once per book.
    expect(llmCalls).toHaveLength(2)
    expect((result['body'] as string[]).join('\n')).toMatch(/没有 subagents 服务/u)
    const state = await readState()
    expect(state.competitors).toHaveLength(2)
  })

  it('does not fan out for a single target, and rejects a batch with no usable text', async () => {
    await seeded()
    await call('novel_review', {
      operation: 'competitor',
      targets: [{ title: '同榜甲', text: '甲的开篇' }],
      save: true,
    })
    expect(spawns).toHaveLength(0)
    expect(llmCalls).toHaveLength(1)

    await expect(
      call('novel_review', { operation: 'competitor', targets: [{ title: '空的', text: '   ' }] }),
    ).rejects.toThrow(/没有非空原文/u)
  })
})
