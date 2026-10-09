import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { NovelReviewError, resolveRoute, runReview, type ReviewSettings } from '../src/host/llm.ts'

/**
 * The model seam: which route a review runs on, and what happens when the call
 * misbehaves.
 *
 * This is the only module in the composer that talks to a model, so it is the
 * only place where "the model did something unexpected" has to be turned into
 * something the author can act on: a timeout names the setting to change, a
 * missing service names the service, and a truncated answer is reported as
 * truncated rather than read as complete.
 */
const settings = (provider = '', model = ''): ReviewSettings =>
  ({ provider, model, timeoutMs: 50, maxTokens: 0, reasoningEffort: '' })

/** Chunks as the harness's own assembler expects them. */
function reply(text: string, finish: 'stop' | 'max-tokens' | 'tool-calls' = 'stop'): unknown[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: finish } },
  ]
}

/** A reply that thought first, and optionally said something afterwards. */
function thinkingReply(thinking: string, text: string, finish: 'stop' | 'max-tokens' = 'stop'): unknown[] {
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: thinking },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: thinking } },
    ...(text === ''
      ? []
      : [
          { type: 'block-start', index: 1, blockType: 'text' },
          { type: 'text-delta', index: 1, text },
          { type: 'block-end', index: 1, block: { type: 'text', text } },
        ]),
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 128, reasoningTokens: 120 } },
    { type: 'finish', reason: { kind: finish } },
  ]
}

/** Model metadata a reasoning-capable route returns, as the runtime detaches it. */
const capable = (provider: string, model: string, efforts: string[]): Record<string, unknown> => ({
  provider,
  id: model,
  name: model,
  inputModalities: ['text'],
  reasoning: { efforts: efforts.map((id) => ({ id, name: id })), defaultEffort: efforts.includes('high') ? 'high' : undefined },
})

/** Every request the fake runtime was handed, in order. */
let sent: Record<string, unknown>[] = []

/**
 * A context with a fake `llm` service, and optionally a default selection or a
 * capability answer.
 *
 * The capability answer is optional because a minimal runtime — and the fake in
 * `review-tool.test.ts` — exposes `stream` and nothing else, which the seam has
 * to survive.
 */
async function contextWith(
  stream: (options: { signal?: AbortSignal }) => AsyncIterable<unknown>,
  selection?: { provider: string; model: string },
  capability?: (provider: string, model: string) => unknown,
): Promise<Context> {
  const ctx = new Context()
  ctx.plugin({
    name: 'fake-llm',
    apply(target: Context) {
      target.provide('llm', {
        stream: (options: Record<string, unknown>) => {
          sent.push(options)
          return stream(options as { signal?: AbortSignal })
        },
        ...(capability === undefined
          ? {}
          : { resolveModelInfo: (provider: string, model: string) => Promise.resolve(capability(provider, model)) }),
      })
    },
  })
  if (selection !== undefined) {
    ctx.plugin({
      name: 'fake-default-model',
      apply(target: Context) {
        target.provide('agentDefaultModel', { currentSelection: () => selection })
      },
    })
  }
  await new Promise((resolve) => setTimeout(resolve, 20))
  return ctx
}

/** An async iterable that yields everything it was given. */
async function* from(chunks: unknown[]): AsyncIterable<unknown> {
  for (const chunk of chunks) yield chunk
}

const request = { system: 'rubric', user: 'chapter', maxTokens: 128 }
let live: Context[] = []

afterEach(() => {
  live = []
  sent = []
})

describe('resolveRoute', () => {
  it('prefers a model named by the call itself', async () => {
    const ctx = await contextWith(() => from([]), { provider: 'deepseek', model: 'deepseek-chat' })
    live.push(ctx)
    expect(resolveRoute(ctx, settings('cfg', 'cfg-model'), { provider: 'p', model: 'm' })).toEqual({
      provider: 'p',
      model: 'm',
      source: 'call',
    })
  })

  it('prefers the configured pair over the session default', async () => {
    const ctx = await contextWith(() => from([]), { provider: 'deepseek', model: 'deepseek-chat' })
    live.push(ctx)
    expect(resolveRoute(ctx, settings('cfg', 'cfg-model'))).toEqual({
      provider: 'cfg',
      model: 'cfg-model',
      source: 'config',
    })
  })

  it('follows the session default when nothing is configured', async () => {
    const ctx = await contextWith(() => from([]), { provider: 'deepseek', model: 'deepseek-reasoner' })
    live.push(ctx)
    expect(resolveRoute(ctx, settings())).toEqual({
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      source: 'default',
    })
  })

  it('needs both halves of the configured pair', async () => {
    const ctx = await contextWith(() => from([]), { provider: 'deepseek', model: 'deepseek-chat' })
    live.push(ctx)
    expect(resolveRoute(ctx, settings('cfg', ''))?.source).toBe('default')
  })

  it('returns nothing when neither a config nor a default exists', async () => {
    const ctx = await contextWith(() => from([]))
    live.push(ctx)
    expect(resolveRoute(ctx, settings())).toBeUndefined()
  })

  it('treats an empty default selection as no default', async () => {
    const ctx = await contextWith(() => from([]), { provider: '', model: '' })
    live.push(ctx)
    expect(resolveRoute(ctx, settings())).toBeUndefined()
  })

  it('refuses half a per-call override instead of dropping it in silence', async () => {
    const ctx = await contextWith(() => from([]), { provider: 'deepseek', model: 'deepseek-chat' })
    live.push(ctx)
    // Only a model: the old behaviour quietly reviewed on the session's model.
    expect(() => resolveRoute(ctx, settings(), { model: 'deepseek-reasoner' })).toThrow(/provider and model/)
    expect(() => resolveRoute(ctx, settings(), { provider: 'deepseek' })).toThrow(/provider and model/)
    // An empty string is "not named", so these are half a pair too — not a
    // route whose provider happens to be spelled "".
    expect(() => resolveRoute(ctx, settings(), { provider: '', model: 'deepseek-reasoner' })).toThrow(/provider and model/)
    expect(() => resolveRoute(ctx, settings(), { provider: 'deepseek', model: '' })).toThrow(/provider and model/)
    // Both empty is no override at all.
    expect(resolveRoute(ctx, settings(), { provider: '', model: '' })?.source).toBe('default')
  })
})

describe('runReview', () => {
  const route = { provider: 'deepseek', model: 'deepseek-chat', source: 'default' } as const

  it('assembles the reply from the stream', async () => {
    const ctx = await contextWith(() => from(reply('{"summary":"可以","findings":[]}')))
    live.push(ctx)
    const result = await runReview(ctx, route, request, { timeoutMs: 1000 })
    expect(result.text).toBe('{"summary":"可以","findings":[]}')
    expect(result.finish).toBe('stop')
    expect(result.truncated).toBe(false)
  })

  it('flags an answer cut off by the output budget', async () => {
    const ctx = await contextWith(() => from(reply('{"summary":"半截', 'max-tokens')))
    live.push(ctx)
    const result = await runReview(ctx, route, request, { timeoutMs: 1000 })
    expect(result.truncated).toBe(true)
    expect(result.finish).toBe('max-tokens')
  })

  it('refuses to run without a model service at all', async () => {
    const ctx = new Context()
    live.push(ctx)
    await expect(runReview(ctx, route, request, { timeoutMs: 1000 })).rejects.toThrow(/no llm service/)
  })

  it('reports a provider-side abort with its failure message', async () => {
    const ctx = await contextWith(() =>
      from([{ type: 'finish', reason: { kind: 'aborted', failure: { message: 'rate limited' } } }]),
    )
    live.push(ctx)
    await expect(runReview(ctx, route, request, { timeoutMs: 1000 })).rejects.toThrow(/rate limited/)
  })

  it('reports a tool call as a failure, since no tools were offered', async () => {
    const ctx = await contextWith(() => from(reply('', 'tool-calls')))
    live.push(ctx)
    await expect(runReview(ctx, route, request, { timeoutMs: 1000 })).rejects.toThrow(/tried to call a tool/)
  })

  it('reports an empty answer rather than recording nothing', async () => {
    const ctx = await contextWith(() => from(reply('   ')))
    live.push(ctx)
    await expect(runReview(ctx, route, request, { timeoutMs: 1000 })).rejects.toThrow(/returned no text/)
  })

  it('reports a budget spent before any text as truncation, not as an empty stop', async () => {
    const ctx = await contextWith(() => from(thinkingReply('想', '', 'max-tokens')))
    live.push(ctx)
    const error = await runReview(ctx, route, request, { timeoutMs: 1000, maxTokens: 128 }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(NovelReviewError)
    // The whole point: the old message said "returned no text" and hid the cause.
    expect((error as Error).message).toMatch(/exhausted its 128-token output budget/)
    expect((error as Error).message).toContain('reviewMaxTokens')
    expect((error as Error).message).toContain('推理 120 tokens')
  })

  it('names the reasoning channel when that is where the answer went', async () => {
    const ctx = await contextWith(() => from(thinkingReply('一段很长的推理', '')))
    live.push(ctx)
    await expect(runReview(ctx, route, request, { timeoutMs: 1000 })).rejects.toThrow(/only in its reasoning channel/)
  })

  it('reports a provider error finish with its failure message', async () => {
    const ctx = await contextWith(() =>
      from([{ type: 'finish', reason: { kind: 'error', failure: { message: 'provider exploded' } } }]),
    )
    live.push(ctx)
    await expect(runReview(ctx, route, request, { timeoutMs: 1000 })).rejects.toThrow(/provider exploded/)
  })

  it('counts the reasoning it discards instead of dropping it in silence', async () => {
    const ctx = await contextWith(() => from(thinkingReply('想了 4 个字', '{"summary":"ok","findings":[]}')))
    live.push(ctx)
    const result = await runReview(ctx, route, request, { timeoutMs: 1000 })
    expect(result.text).toBe('{"summary":"ok","findings":[]}')
    expect(result.reasoningChars).toBe('想了 4 个字'.length)
  })

  it('asks a reasoning-capable route for the configured effort', async () => {
    const ctx = await contextWith(
      () => from(reply('{"summary":"ok","findings":[]}')),
      undefined,
      (provider, model) => capable(provider, model, ['off', 'high']),
    )
    live.push(ctx)
    await runReview(ctx, route, request, { timeoutMs: 1000, reasoningEffort: 'off' })
    expect(sent[0]?.reasoningEffort).toBe('off')
  })

  it('sends no effort to a route that declares no reasoning', async () => {
    const ctx = await contextWith(
      () => from(reply('{"summary":"ok","findings":[]}')),
      undefined,
      (provider, model) => ({ provider, id: model, name: model, inputModalities: ['text'] }),
    )
    live.push(ctx)
    // Sending one here is rejected outright by the runtime (UNSUPPORTED_REASONING_EFFORT).
    await runReview(ctx, route, request, { timeoutMs: 1000, reasoningEffort: 'off' })
    expect('reasoningEffort' in (sent[0] ?? {})).toBe(false)
  })

  it('sends no effort when the deployment leaves the choice to the adapter', async () => {
    const ctx = await contextWith(
      () => from(reply('{"summary":"ok","findings":[]}')),
      undefined,
      (provider, model) => capable(provider, model, ['off', 'high']),
    )
    live.push(ctx)
    const result = await runReview(ctx, route, request, { timeoutMs: 1000, reasoningEffort: '' })
    expect('reasoningEffort' in (sent[0] ?? {})).toBe(false)
    expect(result.reasoningEffort).toBeUndefined()
  })

  it('falls back to the lowest effort the route does offer', async () => {
    const ctx = await contextWith(
      () => from(reply('{"summary":"ok","findings":[]}')),
      undefined,
      (provider, model) => capable(provider, model, ['off', 'low']),
    )
    live.push(ctx)
    await runReview(ctx, route, request, { timeoutMs: 1000, reasoningEffort: 'max' })
    expect(sent[0]?.reasoningEffort).toBe('off')
  })

  it('uses the caller budget when one is given, and the request fallback when not', async () => {
    const ctx = await contextWith(() => from(reply('{"summary":"ok","findings":[]}')))
    live.push(ctx)
    await runReview(ctx, route, request, { timeoutMs: 1000, maxTokens: 512 })
    await runReview(ctx, route, request, { timeoutMs: 1000, maxTokens: 0 })
    expect(sent[0]?.maxTokens).toBe(512)
    expect(sent[1]?.maxTokens).toBe(request.maxTokens)
  })

  it('wraps a transport failure with the route that failed', async () => {
    const ctx = await contextWith(() => ({
      [Symbol.asyncIterator](): AsyncIterator<unknown> {
        return { next: () => Promise.reject(new Error('connection reset')) }
      },
    }))
    live.push(ctx)
    await expect(runReview(ctx, route, request, { timeoutMs: 1000 })).rejects.toThrow(
      /failed on deepseek\/deepseek-chat: connection reset/,
    )
  })

  it('gives up on time and names the setting that controls it', async () => {
    const ctx = await contextWith((options) => ({
      [Symbol.asyncIterator](): AsyncIterator<unknown> {
        return {
          next: (): Promise<IteratorResult<unknown>> =>
            new Promise((_resolve, reject) => {
              options.signal?.addEventListener('abort', () => reject(new Error('aborted')))
            }),
        }
      },
    }))
    live.push(ctx)
    const error = await runReview(ctx, route, request, { timeoutMs: 20 }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(NovelReviewError)
    expect((error as Error).message).toMatch(/timed out after 20 ms/)
    expect((error as Error).message).toContain('reviewTimeoutMs')
  })

  it('reports a cancelled call as cancelled, not as a timeout', async () => {
    const controller = new AbortController()
    const ctx = await contextWith((options) => ({
      [Symbol.asyncIterator](): AsyncIterator<unknown> {
        return {
          next: (): Promise<IteratorResult<unknown>> =>
            new Promise((_resolve, reject) => {
              options.signal?.addEventListener('abort', () => reject(new Error('aborted')))
            }),
        }
      },
    }))
    live.push(ctx)
    const pending = runReview(ctx, route, request, { timeoutMs: 5000, signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toThrow(/cancelled/)
  })
})
