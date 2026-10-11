/**
 * The one place this plugin calls a model.
 *
 * Everything else in the composer is arithmetic over a JSON document; the
 * review tool is the deliberate exception (see `core/review.ts`). This module is
 * the seam where that exception is contained: route resolution, one streamed
 * call, text assembly, and a typed failure. Nothing above it touches `ctx.llm`,
 * so the judgement layer has exactly one dependency to fake in a spec.
 *
 * Route resolution follows the deployment's intent rather than inventing one:
 * an explicitly configured `reviewProvider`/`reviewModel` wins, and otherwise
 * the call rides whatever model the user has selected for the session
 * (`agentDefaultModel`), so switching models in the GUI switches the reviewer
 * too. If neither exists the tool reports that plainly instead of guessing.
 *
 * Two request controls are decided here rather than left to the adapter, because
 * leaving them to the adapter is what broke this tool:
 *
 * - **Reasoning effort.** A route that declares reasoning materializes its own
 *   default when the caller omits an effort — `deepseek-official` defaults to
 *   `high` — and thinking tokens are billed against the same `maxTokens` budget
 *   as the answer. A rubric-scoring call given `maxTokens: 4096` could therefore
 *   spend the entire budget thinking and emit *no text block at all*. Reviews
 *   ask for `off` by default (`reviewReasoningEffort`), but only after asking the
 *   adapter what the exact route offers: an effort sent to a route that declares
 *   none is rejected outright (`UNSUPPORTED_REASONING_EFFORT`).
 * - **Output budget.** `reviewMaxTokens` is the deployment's budget for one
 *   review call; the builders in `core/review.ts` carry only a fallback for a
 *   caller that supplies none.
 *
 * @module @ai-novelist/novelist-skill/host/llm
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  BlockAssembler,
  createUserMessage,
  ReasoningEffortId,
  type ContentBlock,
  type LlmResolvedModelInfo,
  type LlmRuntime,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { ReviewRequest } from '../core/review.ts'

/**
 * The producer tag this plugin's review call carries.
 *
 * dsh 0.2.0-rc.2 replaced the single catch-all `'plugin'` source with a
 * merge-extensible map whose entries each producer declares in its own module,
 * so a message says *which* producer it came from rather than that it came from
 * "a plugin". Declaring the kind here keeps that attribution honest and makes it
 * impossible for another package to claim the same one.
 *
 * The call is hand-built and never enters the session log, so the declaration
 * carries no `form`: an undeclared form is the documented default for content
 * that is not a context contribution.
 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'ai-novelist-review': {
      kind: 'ai-novelist-review'
    }
  }
}

/** Raised when a review cannot be produced, with the reason in the message. */
export class NovelReviewError extends Error {
  override readonly name = 'NovelReviewError'
}

/** Where a call's model came from, which the tool reports and records. */
export const ROUTE_SOURCES = ['config', 'default', 'call'] as const

/** One entry of {@link ROUTE_SOURCES}. */
export type RouteSource = (typeof ROUTE_SOURCES)[number]

/**
 * Reasoning efforts a review may ask for, plus the empty string.
 *
 * The values are the adapter-owned effort ids DSH routes use today. `''` is not
 * an effort: it means "send none and let the adapter apply its own default",
 * which is the only honest choice for a route whose capabilities are unknown.
 */
export const REVIEW_REASONING_EFFORTS = ['off', 'low', 'high', 'max', ''] as const

/** One entry of {@link REVIEW_REASONING_EFFORTS}. */
export type ReviewReasoningEffort = (typeof REVIEW_REASONING_EFFORTS)[number]

/**
 * The effort a review asks for when the deployment names none.
 *
 * `off`, because scoring prose against a rubric is not a reasoning task and the
 * reasoning channel competes with the answer for the same output budget. A
 * review that has to think first can still be asked for one explicitly.
 */
export const DEFAULT_REVIEW_REASONING_EFFORT: ReviewReasoningEffort = 'off'

/** The provider and model one review runs on. */
export interface LlmRoute {
  /** Registered provider route, for example `deepseek`. */
  readonly provider: string
  /** Model id, for example `deepseek-chat`. */
  readonly model: string
  /** Where the pair came from: the plugin config, the session default, or the call. */
  readonly source: RouteSource
}

/** The default-model service, described structurally to avoid a second dependency. */
interface DefaultModelService {
  currentSelection(): { readonly provider: string; readonly model: string }
}

/**
 * The deployment's review settings, as `apply` parsed them.
 *
 * Only the fields this module needs: keeping the seam's input narrow is what
 * lets a spec drive it without mounting the whole plugin.
 */
export interface ReviewSettings {
  /** Explicit provider; empty means "follow the session default". */
  readonly provider: string
  /** Explicit model; empty means "follow the session default". */
  readonly model: string
  /** Per-call ceiling in milliseconds. */
  readonly timeoutMs: number
  /**
   * Output budget in tokens for one review call.
   *
   * `0` means "use the request's own fallback" (`REVIEW_MAX_TOKENS`), which is
   * what a programmatic caller embedding `runReview` directly gets.
   */
  readonly maxTokens: number
  /**
   * Reasoning effort a review asks for; `''` leaves the adapter's default.
   *
   * Sent only when the exact route declares that effort (see {@link runReview}).
   */
  readonly reasoningEffort: ReviewReasoningEffort
}

/**
 * Resolve the route one review runs on.
 *
 * Precedence: the call's own override (the author may ask for a stronger model
 * for one review), then the plugin's configuration, then the model the session
 * already uses. The last one is what makes the feature usable with no
 * configuration at all.
 *
 * @param ctx - the context to read services from.
 * @param settings - the deployment's review settings.
 * @param override - a provider/model pair requested for this one call.
 * @returns the route, or `undefined` when nothing is configured or selected.
 * @throws {NovelReviewError} when the override names only one half of the pair,
 *   which used to be dropped in silence and left the author staring at a
 *   different model than the one they asked for.
 */
export function resolveRoute(
  ctx: Context,
  settings: ReviewSettings,
  override: { readonly provider?: string | undefined; readonly model?: string | undefined } = {},
): LlmRoute | undefined {
  // An empty string counts as absent, exactly as it does for the configured
  // pair: a model that fills a schema field with "" has not named a route.
  const provider = override.provider === undefined || override.provider === '' ? undefined : override.provider
  const model = override.model === undefined || override.model === '' ? undefined : override.model
  if ((provider === undefined) !== (model === undefined)) {
    throw new NovelReviewError(
      'a per-call model override needs both provider and model:'
        + ` got provider=${provider ?? '(none)'}, model=${model ?? '(none)'}`,
    )
  }
  if (provider !== undefined && model !== undefined) {
    return { provider, model, source: 'call' }
  }
  if (settings.provider !== '' && settings.model !== '') {
    return { provider: settings.provider, model: settings.model, source: 'config' }
  }
  // Read without the inject requirement: a profile without the default-model
  // service is a legitimate deployment, not a broken one.
  const service = ctx.reflect.get('agentDefaultModel') as DefaultModelService | undefined
  const selection = service?.currentSelection()
  if (selection === undefined || selection.provider === '' || selection.model === '') return undefined
  return { provider: selection.provider, model: selection.model, source: 'default' }
}

/** What one completed call produced. */
export interface ReviewResult {
  /** The assembled text. */
  readonly text: string
  /** The provider's finish kind, recorded so a clipped answer is not read as a complete one. */
  readonly finish: string
  /** Whether the model stopped because it ran out of output budget. */
  readonly truncated: boolean
  /**
   * Reasoning characters the model emitted and this module discarded.
   *
   * Non-zero means part of the reply was spent in the reasoning channel. That is
   * normal for a thinking model, but it is also the first place to look when an
   * answer looks thin, so the count is returned instead of being dropped in
   * silence.
   */
  readonly reasoningChars: number
  /** The reasoning effort the call actually asked for; `undefined` when none was sent. */
  readonly reasoningEffort: string | undefined
  /** Provider token accounting, when the stream reported it. */
  readonly usage: TokenUsage | undefined
}

/**
 * Run one review call and return the model's text.
 *
 * Streaming is used even for a one-shot because that is the only call shape
 * `ctx.llm` offers; assembly is the harness's own `BlockAssembler`, so the
 * chunks are interpreted exactly as the agent loop interprets them.
 *
 * The request controls are deliberate. The output budget is the caller's
 * (`options.maxTokens`), because a route's own default is enormous and the
 * builder's fallback is small. The reasoning effort is asked of the exact route
 * first and sent only if that route declares it: sending an effort a route does
 * not offer fails the call outright, and sending none lets a thinking model
 * spend the whole budget before writing a word.
 *
 * @param ctx - the context carrying `llm`.
 * @param route - the resolved provider and model.
 * @param request - the framed request.
 * @param options - timeout, output budget, reasoning effort, cancellation.
 * @returns the assembled text and how the call finished.
 * @throws {NovelReviewError} when the call fails, times out, or returns no text.
 */
export async function runReview(
  ctx: Context,
  route: LlmRoute,
  request: ReviewRequest,
  options: {
    readonly signal?: AbortSignal | undefined
    readonly timeoutMs: number
    readonly maxTokens?: number | undefined
    readonly reasoningEffort?: ReviewReasoningEffort | undefined
  },
): Promise<ReviewResult> {
  const llm: LlmRuntime | undefined = ctx.reflect.get('llm') as LlmRuntime | undefined
  if (llm === undefined) {
    throw new NovelReviewError('no llm service is mounted in this profile; novel_review needs one')
  }
  const timeout = AbortSignal.timeout(options.timeoutMs)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
  const maxTokens = options.maxTokens === undefined || options.maxTokens <= 0 ? request.maxTokens : options.maxTokens
  const assembler = new BlockAssembler()
  let effort: string | undefined
  try {
    // Fail before touching the model when the call is already dead. The
    // capability lookup below is a real await, and an adapter that only reacts
    // to a signal *event* would never see one that fired before it subscribed:
    // the call would hang until the timeout instead of reporting the
    // cancellation that had already happened.
    const stopped = abortReason(timeout, options.signal, options.timeoutMs, route)
    if (stopped !== undefined) throw stopped
    const info = await modelCapability(llm, route, signal)
    const cancelled = abortReason(timeout, options.signal, options.timeoutMs, route)
    if (cancelled !== undefined) throw cancelled
    effort = chooseReasoningEffort(info, options.reasoningEffort ?? '')
    for await (const chunk of llm.stream({
      provider: route.provider,
      model: route.model,
      ...(effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) }),
      system: request.system,
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: request.user }],
          source: { kind: 'ai-novelist-review' },
        }),
      ],
      maxTokens,
      signal,
    })) {
      assembler.push(chunk)
    }
  } catch (error) {
    const reason = abortReason(timeout, options.signal, options.timeoutMs, route)?.message
      ?? `review call failed on ${route.provider}/${route.model}:`
        + ` ${error instanceof Error ? error.message : String(error)}`
    throw new NovelReviewError(reason, { cause: error })
  }
  const finish = assembler.finish
  if (finish.kind === 'aborted') {
    throw new NovelReviewError(
      `review call aborted by the provider on ${route.provider}/${route.model}: ${finish.failure.message}`,
    )
  }
  if (finish.kind === 'error') {
    throw new NovelReviewError(
      `review call failed at the provider on ${route.provider}/${route.model}: ${finish.failure.message}`,
    )
  }
  if (finish.kind === 'tool-calls') {
    throw new NovelReviewError(
      `review call tried to call a tool on ${route.provider}/${route.model}; no tools were offered`,
    )
  }
  const blocks = assembler.blocks()
  const text = textOf(blocks)
  const reasoningChars = reasoningLength(blocks)
  if (text.trim() === '') {
    throw new NovelReviewError(
      emptyReplyReason({ route, finish: finish.kind, maxTokens, reasoningChars, usage: assembler.usage }),
    )
  }
  return {
    text,
    finish: finish.kind,
    truncated: finish.kind === 'max-tokens',
    reasoningChars,
    reasoningEffort: effort,
    usage: assembler.usage,
  }
}

/** Everything the assembled blocks carried in their text channel. */
function textOf(blocks: readonly ContentBlock[]): string {
  return blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
}

/** How many characters the model spent in its reasoning channel, which is dropped. */
function reasoningLength(blocks: readonly ContentBlock[]): number {
  return blocks
    .flatMap((block) => (block.type === 'reasoning' ? [block.text] : []))
    .join('')
    .length
}

/**
 * Why a call is over before it produced anything, or `undefined` while it lives.
 *
 * Both terminal conditions are read from the same place whether they are noticed
 * before dispatch or thrown out of the stream, so a cancellation cannot be
 * reported as a timeout (or the reverse) depending on when it landed.
 *
 * @param timeout - the per-call timeout signal.
 * @param signal - the caller's own cancellation signal, when it has one.
 * @param timeoutMs - the configured ceiling, named in the message.
 * @param route - the route that was being called.
 * @returns the failure to raise, or `undefined` when the call may proceed.
 */
function abortReason(
  timeout: AbortSignal,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  route: LlmRoute,
): NovelReviewError | undefined {
  if (timeout.aborted) {
    return new NovelReviewError(
      `review timed out after ${String(timeoutMs)} ms on ${route.provider}/${route.model}`
        + '（可用 reviewTimeoutMs 调整，或改用更快的模型）',
    )
  }
  if (signal?.aborted === true) {
    return new NovelReviewError('review cancelled: the tool call was aborted')
  }
  return undefined
}

/**
 * Read one route's declared capabilities, tolerating a runtime that has none.
 *
 * A fake runtime in a spec, and any minimal embedding, may expose `stream` and
 * nothing else; the call still works without a capability answer, it just has to
 * leave the reasoning effort to the adapter's own default. A failed lookup is
 * treated the same way rather than failing the review: the point of the lookup
 * is to avoid sending an unsupported effort, so "unknown" must mean "send none".
 *
 * @param llm - the mounted runtime.
 * @param route - the exact route being called.
 * @param signal - cancellation for an adapter-owned lookup.
 * @returns the resolved model info, or `undefined` when it cannot be had.
 */
async function modelCapability(
  llm: LlmRuntime,
  route: LlmRoute,
  signal: AbortSignal,
): Promise<LlmResolvedModelInfo | undefined> {
  const lookup = (llm as { resolveModelInfo?: unknown }).resolveModelInfo
  if (typeof lookup !== 'function') return undefined
  try {
    return await (lookup as (provider: string, model: string, signal?: AbortSignal) => Promise<LlmResolvedModelInfo>)
      .call(llm, route.provider, route.model, signal)
  } catch {
    return undefined
  }
}

/**
 * Decide which reasoning effort this call may ask for.
 *
 * The deployment's choice wins when the route offers it. Otherwise the lowest
 * thing the route does offer is used, preferring `off`: a review that cannot
 * turn reasoning off should still spend as little of its budget on it as the
 * route allows. When the route declares no reasoning at all, or the deployment
 * asked for `''`, nothing is sent — an effort the route does not declare is
 * rejected by the runtime before the request reaches the provider.
 *
 * @param info - the route's capabilities, when they could be read.
 * @param wanted - the deployment's choice; `''` means "send none".
 * @returns the effort to send, or `undefined` to leave the adapter's default.
 */
function chooseReasoningEffort(
  info: LlmResolvedModelInfo | undefined,
  wanted: ReviewReasoningEffort,
): string | undefined {
  if (wanted === '') return undefined
  const reasoning = info?.reasoning
  if (reasoning === undefined) return undefined
  const offered = reasoning.efforts.map((effort) => String(effort.id))
  if (offered.includes(wanted)) return wanted
  if (offered.includes('off')) return 'off'
  return offered[0]
}

/**
 * Explain a reply that carried no usable text.
 *
 * "No text" has several causes with different fixes, and reporting them as one
 * is what sent the first investigation after the wrong thing: a budget consumed
 * before a single word was written reads identically to a model that answered
 * entirely in its reasoning channel and to a genuinely empty stop. The finish
 * kind, the reasoning volume and the token accounting are what tell them apart,
 * so all three are named here.
 *
 * @param input - the completed call's terminal facts.
 * @returns a diagnosis an author can act on.
 */
function emptyReplyReason(input: {
  readonly route: LlmRoute
  readonly finish: string
  readonly maxTokens: number
  readonly reasoningChars: number
  readonly usage: TokenUsage | undefined
}): string {
  const where = `${input.route.provider}/${input.route.model}`
  const spent = input.usage === undefined
    ? ''
    : `；本次输出 ${String(input.usage.outputTokens)} tokens`
      + (input.usage.reasoningTokens === undefined ? '' : `，其中推理 ${String(input.usage.reasoningTokens)} tokens`)
  if (input.finish === 'max-tokens') {
    return `review call exhausted its ${String(input.maxTokens)}-token output budget on ${where}`
      + ` before writing any text${spent}`
      + '（推理与被截断的正文共用这一预算：调大 reviewMaxTokens，并确认 reviewReasoningEffort 为 off）'
  }
  if (input.reasoningChars > 0) {
    return `review call answered only in its reasoning channel on ${where}`
      + `（${String(input.reasoningChars)} 字推理内容没有正文${spent}`
      + '；把 reviewReasoningEffort 设为 off，或用 reviewModel 指到一个非推理模型）'
  }
  return `review call returned no text on ${where}`
    + `（finish=${input.finish}，没有推理内容${spent}）`
}

/**
 * The subagent providers this deployment can actually fan work out to.
 *
 * `ctx.subagents` is a *registry*, not a runner: a provider registers under a
 * name and `start` selects one. The names are the providers' business, so they
 * are read rather than assumed, and `spawn` is preferred when present because it
 * is the general-purpose in-process one.
 *
 * @param ctx - the context to read the service from.
 * @returns the chosen provider name, or `undefined` when nothing can run a child.
 */
export function resolveSubagentProvider(ctx: Context): string | undefined {
  const runtime = ctx.reflect.get('subagents') as { list?: () => string[] } | undefined
  const names = runtime?.list?.() ?? []
  if (names.length === 0) return undefined
  return names.includes('spawn') ? 'spawn' : names[0]
}

/** One child's contribution to a fan-out, successful or not. */
export interface FanoutOutcome {
  /** Index into the requests the fan-out was given. */
  readonly index: number
  /** The child's assembled text, empty when it failed. */
  readonly text: string
  /** Why it failed, empty on success. */
  readonly error: string
}

/**
 * Run several review requests at once, one per child agent.
 *
 * Dismantling twenty to fifty competitors is the SOP's most parallel step and its
 * slowest: each book is independent of every other, so a sequence of one-shot
 * calls spends the sum of their latencies to produce twenty answers that never
 * needed to be ordered. This delegates them to child agents instead.
 *
 * The children inherit the calling agent's model. That is deliberate and matches
 * {@link resolveRoute}'s own lowest-precedence source: a `novel_review` with no
 * configured route already follows the session's model, so a fan-out does the
 * same rather than inventing a second opinion nobody asked for. Pinning the model
 * requires `agentOptions`, which the seam types per provider; leaving it out keeps
 * this working on every provider rather than only the ones that accept overrides.
 *
 * A child that fails is reported, not thrown: the caller merges what came back and
 * decides whether enough survived to be worth writing.
 *
 * @param ctx - the context carrying `subagents`.
 * @param provider - the provider name, from {@link resolveSubagentProvider}.
 * @param parent - the calling agent, which the provider derives lineage from.
 * @param requests - one request per child, in caller order.
 * @param options - per-child timeout and output budget, plus caller cancellation.
 * @returns one outcome per request, in the order given.
 */
export async function runReviewFanout(
  ctx: Context,
  provider: string,
  parent: unknown,
  requests: readonly ReviewRequest[],
  options: {
    readonly signal?: AbortSignal | undefined
    readonly timeoutMs: number
    readonly maxTokens?: number | undefined
    /**
     * Display labels, one per request.
     *
     * A child is listed by its label, so naming each one after the book it is
     * reading is what makes a twenty-child fan-out legible in the session's
     * subagent list. Omitted leaves the seam's positional default.
     */
    readonly labels?: readonly string[] | undefined
  },
): Promise<FanoutOutcome[]> {
  const runtime = ctx.reflect.get('subagents') as
    | {
        start: (
          name: string,
          request: {
            readonly label?: string
            readonly prompt: readonly { readonly type: 'text'; readonly text: string }[]
            readonly parent: unknown
            readonly signal: AbortSignal
          },
        ) => Promise<{ readonly result: Promise<{ readonly output: readonly { readonly type: string; readonly text?: string }[]; readonly stopReason: string }>; dispose: () => Promise<void> }>
      }
    | undefined
  if (runtime === undefined) throw new NovelReviewError('no subagents service is mounted in this profile')

  const runs = await Promise.all(
    requests.map(async (request, index) => {
      const timeout = AbortSignal.timeout(options.timeoutMs)
      const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
      try {
        const run = await runtime.start(provider, {
          label: options.labels?.[index] ?? `review ${String(index + 1)}`,
          prompt: [{ type: 'text', text: `${request.system}\n\n${request.user}` }],
          parent,
          signal,
        })
        try {
          const result = await run.result
          if (result.stopReason !== 'completed') {
            return { index, text: '', error: `child stopped: ${result.stopReason}` }
          }
          const text = result.output
            .filter((block) => block.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text ?? '')
            .join('')
          return text.trim() === ''
            ? { index, text: '', error: 'child returned no text' }
            : { index, text, error: '' }
        } finally {
          await run.dispose()
        }
      } catch (error) {
        return { index, text: '', error: error instanceof Error ? error.message : String(error) }
      }
    }),
  )
  return runs.sort((left, right) => left.index - right.index)
}
