import { describe, expect, it } from 'vitest'
import { apply } from '../src/client/index.tsx'
import { clientRemote } from '../src/client/remote.ts'

/**
 * Activation-wiring specs for the client half.
 *
 * Neither surface can be rendered here: their slot props carry React hooks and
 * the repository ships no DOM renderer. So what is specified is the one fact a
 * surface cannot invent for itself — the Remote face it reads through. Both
 * surfaces resolve it from `./remote.ts` and `apply` is that module's only
 * writer, which is what rules out the state this spec was written for: the
 * sidebar panel reading the project while the Kanban view answers "the composer
 * client half has no Remote face" because it captured nothing.
 */

/** The registrations one `apply` performed, and the way to undo it. */
interface Activation {
  /** The `conversation.view` entries that were registered, in order. */
  readonly views: { readonly id: string | undefined; readonly order: number | undefined }[]
  /** Run every disposer `apply` handed to `ctx.effect`, deepest first. */
  readonly dispose: () => void
}

/**
 * Drive `apply` with the registries it calls, recording what it registered.
 *
 * @param remote - the face the fake root context carries as `ctx.remote`.
 * @returns the recorded registrations and their disposer.
 */
function activate(remote: unknown): Activation {
  const disposers: (() => void)[] = []
  const views: { id: string | undefined; order: number | undefined }[] = []
  const ctx = {
    remote,
    effect: (body: () => (() => void) | undefined) => {
      const dispose = body()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    locale: {
      bind: () => (key: string) => key,
      register: () => () => undefined,
    },
    sidebarRightTabs: { register: () => () => undefined },
    slots: {
      // A declared slot runs the callback immediately, which is how a plugin
      // that applies after the Conversation package still lands in the roster.
      inject: (_name: string, body: () => () => void) => body(),
      register: (options: { id?: string; order?: number }) => {
        if (options.id !== undefined) views.push({ id: options.id, order: options.order })
        return () => undefined
      },
    },
  }
  apply(ctx as never)
  return {
    views,
    dispose: () => {
      for (const dispose of [...disposers].reverse()) dispose()
    },
  }
}

describe('the Remote face both composer surfaces read', () => {
  it('is absent until the plugin activates', () => {
    // Which is the state the Kanban view used to hit on every render, because
    // it looked at a capture of its own that nothing ever filled.
    expect(clientRemote()).toBeUndefined()
  })

  it('is the activated assembly face, including for the Kanban view', () => {
    const remote = { workspaceFiles: { read: () => undefined } }
    const session = activate(remote)

    expect(clientRemote()).toBe(remote)
    // The view that reads it is on the ledger, after Chat (0) and Trajectory (10).
    expect(session.views).toEqual([{ id: 'novel-kanban', order: 20 }])

    session.dispose()
    expect(clientRemote()).toBeUndefined()
  })
})
