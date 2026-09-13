/**
 * Which novel is the current session working on?
 *
 * The composer used to answer that once, at boot, from the process working
 * directory. That is wrong in a harness where a *workspace* is a directory the
 * host registers and a *session* carries its own `cwd`: one long-running
 * service can host sessions for many directories, so the project root belongs to
 * the session, not to the process.
 *
 * This resolver owns that mapping: one cache of {@link NovelStore} instances
 * keyed by workspace root, plus the discovery and creation seams the workspace
 * tools use. A session with no recorded `cwd` falls back to the deployment's
 * configured root, and only then to the process directory.
 *
 * @module @ai-webnovel/composer-host/host/resolver
 */

import { mkdir } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { classifyWorkspace, type WorkspaceVerdict } from '../core/workspace.ts'
import { NovelStore, NOVEL_SERVICE_NAME, type NovelStoreOptions } from './store.ts'
import type { NovelState } from '../core/types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The composer's per-session project access. */
    novelState: ProjectResolver
  }
}

/** One registered workspace, trimmed to what a model-facing tool should see. */
export interface WorkspaceRef {
  /** Durable record id. */
  readonly id: string
  /** Canonical absolute directory path. */
  readonly path: string
  /** Display title (the final path segment by default). */
  readonly title: string
  /** How many header-validated sessions ran in this directory. */
  readonly sessionCount: number
  /** Whether this directory currently holds a composer project document. */
  readonly isNovelProject: boolean
}

/** The composer's view of where it is and what else is available. */
export interface ProjectsView {
  /** The current session's workspace root, as the host resolved it. */
  readonly currentRoot: string
  /** Where that root came from, for diagnostics. */
  readonly source: 'session' | 'configured' | 'process'
  /** Classification of the current root. */
  readonly verdict: WorkspaceVerdict
  /** Every registered workspace the host knows about, with novel markers. */
  readonly projects: readonly WorkspaceRef[]
}

/** How the composer resolves and mutates project locations. */
export interface ProjectResolver {
  /** The root used when neither the session nor the configuration names one. */
  readonly defaultRoot: string
  /**
   * The store for one workspace root.
   * @param root - absolute directory path.
   * @returns the cached store.
   */
  storeFor(root: string): NovelStore
  /**
   * The store for the session behind one tool execution.
   * @param session - the executing agent's session, or `undefined` outside an agent.
   * @returns the store for that session's workspace.
   */
  storeForSession(session: { readonly header: { readonly cwd?: string } } | undefined): NovelStore
  /**
   * The root for one tool execution, with the source it came from.
   * @param session - the executing agent's session, or `undefined`.
   * @returns the resolved root and its provenance.
   */
  rootForSession(session: { readonly header: { readonly cwd?: string } } | undefined): { root: string; source: ProjectsView['source'] }
  /**
   * Every registered workspace, annotated with whether each is a novel project.
   * @returns the projects in the registry's durable order.
   */
  listProjects(): Promise<WorkspaceRef[]>
  /**
   * Classify the current session's workspace.
   * @param session - the executing agent's session, or `undefined`.
   * @returns the verdict for that root.
   */
  verdictFor(session: { readonly header: { readonly cwd?: string } } | undefined): Promise<WorkspaceVerdict>
  /**
   * Register a directory as a DSH workspace when the registry is mounted, and
   * make sure it is a directory at all.
   * @param path - absolute directory path.
   * @returns the workspace reference, and whether the registry was available.
   */
  registerWorkspace(path: string): Promise<{ ref: WorkspaceRef | undefined; registered: boolean }>
  /**
   * Read the project in one store, classifying nothing.
   * @param root - absolute directory path.
   * @returns the stored state, or `undefined`.
   */
  readProject(root: string): Promise<NovelState | undefined>
}

/** Options for {@link createProjectResolver}. */
export interface ResolverOptions extends NovelStoreOptions {
  /** Root configured for this deployment, used when a session names none. */
  readonly configuredRoot?: string
}

/**
 * Minimal shape of the workspace registry this resolver uses.
 *
 * Declared structurally rather than imported so the package keeps working in a
 * composition that does not mount `@deepseek-ai/dsh-workspace`: the service is
 * looked up at call time and its absence only disables the project list.
 */
interface WorkspaceRegistryLike {
  list(): { id: string; path: string; title: string; sessionIds: readonly string[] }[]
  create(path: string, title?: string): Promise<{ id: string; path: string; title: string; sessionIds: readonly string[] }>
}

/**
 * Options that also select the service-registration path.
 */
export interface MountResolverOptions extends ResolverOptions {
  /**
   * Register the resolver as `ctx.novelState`. The plugin sets this; tests that
   * build several resolvers over one context leave it off, because a Cordis
   * service name may be registered only once.
   */
  readonly provide?: boolean
}

/**
 * Build the resolver.
 *
 * @param ctx - plugin context; the workspace registry is used when mounted.
 * @param options - configured root, store seams, and whether to provide the service.
 * @returns the resolver.
 */
export function createProjectResolver(ctx: Context, options: MountResolverOptions = {}): ProjectResolver {
  const defaultRoot = (options.configuredRoot ?? options.workspaceRoot ?? process.cwd()).replace(/[/\\]+$/u, '')
  const stores = new Map<string, NovelStore>()

  const storeFor = (root: string): NovelStore => {
    const key = root.replace(/[/\\]+$/u, '')
    let store = stores.get(key)
    if (store === undefined) {
      store = new NovelStore(ctx, {
        ...options,
        workspaceRoot: key,
      })
      stores.set(key, store)
    }
    return store
  }

  const rootForSession = (
    session: { readonly header: { readonly cwd?: string } } | undefined,
  ): { root: string; source: ProjectsView['source'] } => {
    const cwd = session?.header.cwd
    if (typeof cwd === 'string' && cwd.trim() !== '') return { root: cwd.replace(/[/\\]+$/u, ''), source: 'session' }
    if (options.configuredRoot !== undefined && options.configuredRoot !== '') {
      return { root: defaultRoot, source: 'configured' }
    }
    return { root: defaultRoot, source: 'process' }
  }

  const registry = (): WorkspaceRegistryLike | undefined =>
    (ctx as unknown as { workspaceRegistry?: WorkspaceRegistryLike }).workspaceRegistry

  const describe = async (entry: {
    id: string
    path: string
    title: string
    sessionIds: readonly string[]
  }): Promise<WorkspaceRef> => {
    const verdict = await storeFor(entry.path).probeWorkspace()
    return {
      id: entry.id,
      path: entry.path,
      title: entry.title,
      sessionCount: entry.sessionIds.length,
      isNovelProject: verdict.kind === 'novel',
    }
  }

  const resolver: ProjectResolver = {
    defaultRoot,
    storeFor,
    storeForSession: (session) => storeFor(rootForSession(session).root),
    rootForSession,
    async listProjects() {
      const workspaces = registry()?.list() ?? []
      const described = await Promise.all(workspaces.map((entry) => describe(entry)))
      return described
    },
    verdictFor: (session) => storeFor(rootForSession(session).root).probeWorkspace(),
    async registerWorkspace(path) {
      const target = path.replace(/[/\\]+$/u, '')
      // A workspace must be an existing directory; creating it is the caller's
      // intent when they name a path that does not exist yet.
      await mkdir(target, { recursive: true })
      const workspaces = registry()
      if (workspaces === undefined) return { ref: undefined, registered: false }
      const created = await workspaces.create(target)
      return { ref: await describe(created), registered: true }
    },
    readProject: (root) => storeFor(root).read(),
  }

  if (options.provide === true) provideResolver(ctx, resolver)
  return resolver
}

/**
 * Register a resolver as the `novelState` service of one context.
 *
 * Published through `ctx.reflect.provide` synchronously rather than by mounting
 * another plugin fiber: callers that inspect the composition right after `apply`
 * (or before the loader settles) then see the service, and the disposition rides
 * the owning fiber like any other effect.
 *
 * @param ctx - the context to register in.
 * @param resolver - the resolver to publish.
 */
function provideResolver(ctx: Context, resolver: ProjectResolver): void {
  const reflect = (ctx as unknown as { reflect?: { provide?: (name: string, value: unknown) => () => void } }).reflect
  if (typeof reflect?.provide !== 'function') {
    // A minimal harness without the reflect plugin: the tools still work, the
    // service is simply not published.
    return
  }
  ctx.effect(() => reflect.provide?.(NOVEL_SERVICE_NAME, resolver) ?? (() => undefined))
}

export { classifyWorkspace }
