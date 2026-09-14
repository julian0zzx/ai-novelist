/**
 * The Remote face both composer surfaces read through.
 *
 * Slot props carry the framework's own shares — session identity, store
 * bindings, hooks — and never a business service, so a surface that needs
 * `ctx.remote.workspaceFiles` has to keep it from the one moment it is handed
 * the root context: `apply`. That kept reference lives here, in exactly one
 * place, because the failure mode of two independent captures is not symmetric:
 * the surface that forgets does not fail to compile, it fails at read time with
 * "no Remote face" — for one surface while the other works.
 *
 * The capture is process-wide rather than per-session on purpose. The Remote is
 * a property of the client assembly, not of a session; every session-addressed
 * read still names its session, which is what keeps the two surfaces from
 * disagreeing about which workspace they are reading.
 *
 * @module @ai-webnovel/composer-host/client/remote
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Side-effect type import: `ctx.remote` is a declaration-merged member of the
// client Context, so it exists here only if the assembly providing it is named.
import type {} from '@deepseek-ai/dsh-api-remotes/client'

/** The Remote face, as the composer's client half uses it. */
export type ClientRemote = ClientContext['remote']

/**
 * What a surface shows when {@link clientRemote} came back empty.
 *
 * It names a wiring bug rather than a project state, which is the point: no
 * workspace can produce it, so seeing it means activation never happened.
 */
export const NO_REMOTE_MESSAGE = 'the composer client half has no Remote face'

/** The face captured at activation; absent before `apply` and after unload. */
let captured: ClientRemote | undefined

/**
 * Capture the Remote face for the plugin's lifetime.
 *
 * @param ctx - the client root context `apply` was handed.
 */
export function captureRemote(ctx: ClientContext): void {
  captured = ctx.remote
}

/** Forget the captured face, so a disposed plugin leaves no reference behind. */
export function releaseRemote(): void {
  captured = undefined
}

/**
 * The Remote face captured at activation.
 *
 * @returns the face, or undefined when called outside the plugin's lifetime —
 * which is a bug in the caller, not a state to render past.
 */
export function clientRemote(): ClientRemote | undefined {
  return captured
}
