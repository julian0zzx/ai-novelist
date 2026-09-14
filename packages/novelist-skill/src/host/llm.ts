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
 * @module @ai-novelist/novelist-skill/host/llm
 */

import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage, type LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { ReviewRequest } from '../core/review.ts'

/** Raised when a review cannot be produced, with the reason in the message. */
export class NovelReviewError extends Error {
  override readonly name = 'NovelReviewError'
}

/** Where a call's model came from, which the tool reports and records. */
export const ROUTE_SOURCES = ['config', 'default', 'call'] as const

/** One entry of {@link ROUTE_SOURCES}. */
export type RouteSource = (typeof ROUTE_SOURCES)[number]

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
 */
export function resolveRoute(
  ctx: Context,
  settings: ReviewSettings,
  override: { readonly provider?: string | undefined; readonly model?: string | undefined } = {},
): LlmRoute | undefined {
  if (override.provider !== undefined && override.model !== undefined) {
    return { provider: override.provider, model: override.model, source: 'call' }
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
}

/**
 * Run one review call and return the model's text.
 *
 * Streaming is used even for a one-shot because that is the only call shape
 * `ctx.llm` offers; assembly is the harness's own `BlockAssembler`, so the
 * chunks are interpreted exactly as the agent loop interprets them.
 *
 * @param ctx - the context carrying `llm`.
 * @param route - the resolved provider and model.
 * @param request - the framed request.
 * @param options - timeout and the tool's cancellation signal.
 * @returns the assembled text and how the call finished.
 * @throws {NovelReviewError} when the call fails, times out, or returns no text.
 */
export async function runReview(
  ctx: Context,
  route: LlmRoute,
  request: ReviewRequest,
  options: { readonly signal?: AbortSignal | undefined; readonly timeoutMs: number },
): Promise<ReviewResult> {
  const llm: LlmRuntime | undefined = ctx.reflect.get('llm') as LlmRuntime | undefined
  if (llm === undefined) {
    throw new NovelReviewError('no llm service is mounted in this profile; novel_review needs one')
  }
  const timeout = AbortSignal.timeout(options.timeoutMs)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
  const assembler = new BlockAssembler()
  try {
    for await (const chunk of llm.stream({
      provider: route.provider,
      model: route.model,
      system: request.system,
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: request.user }],
          source: { kind: 'plugin', plugin: 'ai-novelist' },
        }),
      ],
      maxTokens: request.maxTokens,
      signal,
    })) {
      assembler.push(chunk)
    }
  } catch (error) {
    const reason = timeout.aborted
      ? `review timed out after ${String(options.timeoutMs)} ms on ${route.provider}/${route.model}`
        + '（可用 reviewTimeoutMs 调整，或改用更快的模型）'
      : options.signal?.aborted === true
        ? 'review cancelled: the tool call was aborted'
        : `review call failed on ${route.provider}/${route.model}:`
          + ` ${error instanceof Error ? error.message : String(error)}`
    throw new NovelReviewError(reason, { cause: error })
  }
  const finish = assembler.finish
  if (finish.kind === 'aborted') {
    throw new NovelReviewError(
      `review call aborted by the provider on ${route.provider}/${route.model}: ${finish.failure.message}`,
    )
  }
  if (finish.kind === 'tool-calls') {
    throw new NovelReviewError(
      `review call tried to call a tool on ${route.provider}/${route.model}; no tools were offered`,
    )
  }
  const text = assembler
    .blocks()
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('')
  if (text.trim() === '') {
    throw new NovelReviewError(
      `review call returned no text on ${route.provider}/${route.model}`
        + '（模型可能只返回了推理内容）',
    )
  }
  return { text, finish: finish.kind, truncated: finish.kind === 'max-tokens' }
}
