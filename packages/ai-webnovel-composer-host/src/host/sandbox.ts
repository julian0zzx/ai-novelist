/**
 * The sandbox policy a composer mutation must carry.
 *
 * `ctx.fs` may be the confining backend (`dsh-fs-sandbox`), which fences every
 * mutation against a policy: `read-only` denies it, and `workspace-write` allows
 * it only inside that policy's workspace root. The backend takes the policy from
 * an argument the **caller** supplies, because only the caller knows which
 * session a mutation belongs to — that is why `dsh-tool-fs` resolves one per
 * execution and stamps it onto every `writeText`.
 *
 * This plugin writes on behalf of a session just as those tools do, but it calls
 * `ctx.fs` directly, so it has to carry the same policy. Omitting it is not a
 * harmless default: the backend then falls back to `ctx.sandboxPolicy.resolve()`
 * with **no session**, whose workspace root is the *deployment's*
 * (`config.workspaceRoot ?? process.cwd()`) instead of the session workspace.
 * The moment those two differ — the normal case for one long-running service
 * hosting many workspaces — every write into the session's own directory is
 * denied with `FS_SANDBOX_DENIED`, while reads, which are unfenced, keep
 * working. That asymmetry is the whole symptom: `novel_plan` reports a missing
 * project accurately, and `novel_init` still cannot create one.
 *
 * The policy travels by two routes. Explicitly, as an optional parameter, for
 * callers that already hold one. And inside an {@link AsyncLocalStorage} scope
 * opened once per tool execution, so the store's public mutators can pick one up
 * without every call site threading it by hand. The scope is sampled at the
 * **entry** of a mutator and passed down as a value, never read again deeper:
 * the store serializes writes through one queue that crosses async contexts, so
 * a late read could stamp one call's mutation with another call's mode.
 *
 * @module @ai-webnovel/composer-host/host/sandbox
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

/** A session as the host records it; its `cwd` is the workspace it works in. */
export interface SandboxSessionRef {
  /** Durable session header. */
  readonly header: { readonly cwd?: string }
}

/** The file-effect mode one execution runs under. */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/**
 * The sandbox policy for one call: the mode, plus the root `workspace-write`
 * may write under.
 *
 * Declared structurally rather than imported from `@deepseek-ai/dsh-sandbox`,
 * for the same reason {@link isFsErrorCode} matches error codes structurally:
 * the value crosses a service boundary, so a second copy of that package in one
 * process must still agree on its shape. Naming a two-field object is not worth
 * a hard dependency on the security layer.
 */
export interface CallSandboxPolicy {
  /** The file-effect mode this execution runs under. */
  readonly mode: SandboxMode
  /** Absolute root directory `workspace-write` may write under. */
  readonly workspaceRoot: string
}

/** The subset of `ctx.sandboxPolicy` this plugin calls. */
interface SandboxPolicyService {
  /** The deployment's default mode. */
  readonly defaultMode: SandboxMode
  /**
   * The fully resolved per-call mode and absolute workspace root.
   *
   * @param request - the calling session, when there is one.
   * @returns the policy to stamp onto a mutation.
   */
  resolve(request?: { readonly session?: SandboxSessionRef }): CallSandboxPolicy
}

/** The policy of the tool execution the current async context belongs to. */
const scope = new AsyncLocalStorage<CallSandboxPolicy | undefined>()

/**
 * The policy of the tool execution this code is running inside.
 *
 * @returns the policy, or `undefined` outside a scoped execution and under a
 *   backend that does not confine writes.
 */
export function currentSandboxPolicy(): CallSandboxPolicy | undefined {
  return scope.getStore()
}

/**
 * Run `body` with `policy` visible to every store mutation it reaches.
 *
 * @param policy - the policy for this execution.
 * @param body - the work to run inside the scope.
 * @returns the body's result.
 */
export function withSandboxPolicy<T>(policy: CallSandboxPolicy | undefined, body: () => Promise<T>): Promise<T> {
  return scope.run(policy, body)
}

/**
 * The mounted policy service, or `undefined` when nothing confines `ctx.fs`.
 *
 * `fs.sandboxMode` is the capability fact — it is `undefined` for the bare local
 * backend and defined only when a confining backend is mounted, which is exactly
 * when a policy service exists to be resolved.
 *
 * @param ctx - the plugin context carrying `fs`.
 * @returns the policy service, or `undefined` when writes are unconfined.
 */
function policyService(ctx: Context): SandboxPolicyService | undefined {
  if (ctx.fs.sandboxMode === undefined) return undefined
  return ctx.get('sandboxPolicy') as SandboxPolicyService | undefined
}

/**
 * The standing policy of one session: that session's mode, rooted at its cwd.
 *
 * @param ctx - the plugin context carrying `fs`.
 * @param session - the executing session, or `undefined` outside an agent.
 * @returns the policy to stamp onto this call's mutations.
 */
export function policyForSession(
  ctx: Context,
  session: SandboxSessionRef | undefined,
): CallSandboxPolicy | undefined {
  const service = policyService(ctx)
  if (service === undefined) return undefined
  return service.resolve(session === undefined ? {} : { session })
}

/**
 * The policy for a workspace root with no session behind it.
 *
 * Boot-time classification adopts a project before any tool has run, so there is
 * no session to take a cwd from — but the root being classified is known, and it
 * is the one the adoption writes into.
 *
 * @param ctx - the plugin context carrying `fs`.
 * @param root - the workspace root being classified.
 * @returns the policy to stamp onto that root's mutations.
 */
export function policyForRoot(ctx: Context, root: string): CallSandboxPolicy | undefined {
  const service = policyService(ctx)
  if (service === undefined) return undefined
  return { ...service.resolve(), workspaceRoot: resolve(root) }
}
