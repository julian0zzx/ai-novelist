/**
 * What the composer knows about one workspace, and when it learns it.
 *
 * The composer answers two questions about a directory: *is this a novel
 * project* (and if the evidence says so, make it one), and *what does the
 * project hold right now*. Both answers come from the filesystem and are
 * therefore asynchronous, while the system prompt that needs them is resolved
 * **synchronously** before every model step.
 *
 * The first revision answered both once, at boot, for the process working
 * directory — which is the wrong directory in a harness where a session carries
 * its own `cwd`: an operator launching `dsh web` from a software repository got
 * "this workspace is a software project, not a novel workspace" injected into
 * every session, including sessions opened in an empty novel folder, and the
 * model dutifully refused to start a project there.
 *
 * So the answers live here, keyed by **workspace root** rather than by process:
 * one {@link WorkspaceView} per directory, shared by every session in it, filled
 * by a classification that a lifecycle hook starts as early as possible and the
 * render path can also start if it ever gets there first. A view that has not
 * been classified yet reports `undefined` and the prompt section stays silent,
 * which is the same degradation the boot path always had — the difference is
 * that silence is now scoped to the directory it is actually about.
 *
 * @module @ai-webnovel/composer-host/host/views
 */

import type { Context } from '@deepseek-ai/cordis'
import { emptyNovel, type Clock } from '../core/novel.ts'
import type { WorkspaceVerdict } from '../core/workspace.ts'
import { policyForRoot } from './sandbox.ts'
import { createSnapshotCache, type NovelSnapshot, type SnapshotCache } from './prompt.ts'
import type { ProjectResolver } from './resolver.ts'

/**
 * The session facts a view resolves a workspace from.
 *
 * Matched structurally — the same shape `ProjectResolver` already takes — so the
 * composer keeps working in a composition that mounts neither
 * `@deepseek-ai/dsh-session` nor an agent loop.
 */
export interface SessionRef {
  /** The session's recorded working directory, when it has one. */
  readonly header: { readonly cwd?: string }
}

/**
 * The deployment's policy for a workspace the composer just classified.
 *
 * Kept as an injected seam rather than read here: both decisions are the
 * *deployment's* (its `workspaceMode` and `adoptEmptyWorkspace`), and a view has
 * no business knowing which profile mounted it.
 */
export interface WorkspacePolicy {
  /**
   * Fold the deployment's own mode into a detected verdict.
   * @param root - the workspace the verdict is about.
   * @param detected - what the filesystem said.
   * @returns the verdict the composer acts on.
   */
  readonly normalize: (root: string, detected: WorkspaceVerdict) => WorkspaceVerdict
  /**
   * Whether the composer may create the project document for this verdict.
   * @param verdict - the normalized verdict.
   * @returns true when adoption is allowed.
   */
  readonly mayAdopt: (verdict: WorkspaceVerdict) => boolean
}

/** What one root's view exposes to the prompt, the tools, and the boot log. */
export interface WorkspaceView {
  /** Normalized absolute root every path of this view resolves against. */
  readonly root: string
  /** Absolute path of the project document, whether or not it exists yet. */
  readonly documentPath: string
  /** The classification, or `undefined` until the first probe lands. */
  verdict(): WorkspaceVerdict | undefined
  /** The project numbers, or `undefined` while nothing is known yet. */
  snapshot(): NovelSnapshot | undefined
  /** Whether this view's classification is the call that wrote the document. */
  created(): boolean
  /**
   * Classify the workspace, creating the project when the policy allows it, and
   * prime the snapshot. Runs at most once per view; concurrent and later calls
   * await the same work.
   * @returns fulfillment once the view is filled.
   */
  classify(): Promise<void>
  /**
   * Re-read what the workspace is and what the project holds, for a caller that
   * just wrote to it. Never adopts: that decision belongs to {@link classify}.
   * @returns fulfillment once the view reflects the new state.
   */
  refresh(): Promise<void>
}
/** The per-root view registry the composer's three faces share. */
export interface WorkspaceViews {
  /** The root the deployment owns; the fallback for a session that names none. */
  readonly deploymentRoot: string
  /**
   * The view for one root, starting its classification when nothing has.
   * @param root - absolute directory path.
   * @returns the cached view.
   */
  viewFor(root: string): WorkspaceView
  /**
   * The view for the workspace one session runs in.
   * @param session - the session, or `undefined` outside a session.
   * @returns the view for that session's root, or the deployment's when it names none.
   */
  viewForSession(session: SessionRef | undefined): WorkspaceView
}

/** Optional seams for {@link createWorkspaceViews}. */
export interface WorkspaceViewsOptions {
  /** Timestamp source for a project document adoption creates. */
  readonly clock?: Clock
  /** Clock behind the snapshot cache, so tests can age it deliberately. */
  readonly now?: () => number
  /** Sink for the one line each classification reports. */
  readonly log?: (message: string, detail: { readonly root: string; readonly verdict: WorkspaceVerdict; readonly created: boolean }) => void
}

/**
 * Notice every session the harness creates, whichever branch of the composition
 * it belongs to.
 *
 * Registered `global` on purpose. `dsh-scope` routes events along the scope
 * chain, and a session's scope is not this plugin's, so a scoped listener would
 * only ever hear about sessions started under the plugin's own branch — which is
 * none of them. The event itself is matched structurally, for the same reason
 * {@link SessionRef} is: the composer reads one field of a session and has no
 * business depending on the session package to do it.
 *
 * The harness dispatches this event **without awaiting** its listeners, so the
 * work a listener starts must contain its own failures and must not be assumed
 * to have finished by the time the first model step is assembled.
 *
 * @param ctx - plugin context; the listener is disposed with its fiber.
 * @param listener - called once per created session.
 * @returns the disposer, for a caller that wants to unregister early.
 */
export function onSessionCreated(ctx: Context, listener: (session: SessionRef) => void): () => void {
  const events = ctx as unknown as {
    on(name: 'session/created', listener: (session: SessionRef) => void, options?: { global?: boolean }): () => boolean
  }
  return events.on('session/created', listener, { global: true })
}

/**
 * Build the view registry.
 *
 * @param ctx - plugin context carrying the filesystem service.
 * @param projects - resolves stores per root.
 * @param policy - the deployment's classification and adoption policy.
 * @param options - clock and logging seams.
 * @returns the registry.
 */
export function createWorkspaceViews(
  ctx: Context,
  projects: ProjectResolver,
  policy: WorkspacePolicy,
  options: WorkspaceViewsOptions = {},
): WorkspaceViews {
  const clock: Clock = options.clock ?? (() => new Date().toISOString())
  const views = new Map<string, WorkspaceView>()

  /** The provisional title an adopted directory gets: its own folder name. */
  const titleOf = (root: string): string => root.split(/[/\\]/u).filter(Boolean).at(-1) ?? ''

  const viewFor = (root: string): WorkspaceView => {
    const key = root.replace(/[/\\]+$/u, '')
    const existing = views.get(key)
    if (existing !== undefined) return existing

    const store = projects.storeFor(key)
    const cache: SnapshotCache = createSnapshotCache(store, options.now)
    let verdict: WorkspaceVerdict | undefined
    let created = false
    let classification: Promise<void> | undefined

    /** Probe the directory and record what it is now. */
    const probe = async (): Promise<WorkspaceVerdict> => {
      const normalized = policy.normalize(key, await store.probeWorkspace())
      verdict = normalized
      return normalized
    }

    const classify = async (): Promise<void> => {
      const normalized = await probe()
      if (policy.mayAdopt(normalized)) {
        // Idempotent by construction: an existing document is left exactly as it
        // is, so a second session in one directory can never reset a draft.
        created =
          (await store.adopt(emptyNovel({ title: titleOf(key), premise: '' }, clock), policyForRoot(ctx, key))) ===
          'created'
      }
      await cache.refresh()
      options.log?.(`workspace ${normalized.kind} (${normalized.reason})`, { root: key, verdict: normalized, created })
    }

    const view: WorkspaceView = {
      root: key,
      documentPath: store.documentPath,
      verdict: () => verdict,
      snapshot: () => cache.current(),
      created: () => created,
      classify: () => {
        // A classification that fails must not take down the session that
        // triggered it: the view simply stays silent, and the next caller sees
        // the same `undefined` a workspace without evidence always produced.
        classification ??= classify().catch((error: unknown) => {
          ctx.logger?.warn?.(
            'ai-webnovel-composer: classifying %s failed, composer stays idle there: %s',
            key,
            error instanceof Error ? error.message : String(error),
          )
        })
        return classification
      },
      refresh: async () => {
        // A write can change what the directory *is*, not just what it holds:
        // `novel_init` in an empty workspace is what turns `fresh` into `novel`.
        // Re-probing here is what keeps the section from insisting a project
        // does not exist while quoting its title on the next line. Adoption
        // stays out of it — that decision was made once, by `classify`.
        await probe()
        await cache.refresh()
      },
    }
    views.set(key, view)
    return view
  }

  // The render path must never be the reason a workspace stays unclassified —
  // but it is also the earliest caller in a session that predates the lifecycle
  // hook, so it starts the work rather than only reading it. `viewFor` is
  // synchronous and this promise is deliberately not returned: the first step
  // after a cold start renders silence, exactly as the boot path always did, and
  // every step after it renders the orientation.
  const started = (root: string): WorkspaceView => {
    const view = viewFor(root)
    void view.classify()
    return view
  }

  return {
    deploymentRoot: projects.defaultRoot,
    viewFor: started,
    viewForSession: (session) => started(projects.rootForSession(session).root),
  }
}
