/**
 * The AI Web Novel Composer — host half.
 *
 * Cordis plugin that gives an agent the vocabulary of novel composition:
 * premise, chapter plan, story bible, prose, and export. It provides one
 * service (`novelState`) and registers the SOP tools — eight that compute, plus the
 * model-backed reviewer wherever a model route exists.
 *
 * At boot it also decides **what the workspace is**. That decision is the
 * difference between a composer that sits inert until someone happens to call
 * `novel_init`, and one that is already usable the moment a novel directory is
 * opened: a workspace that already looks like a novel is adopted (so the agent
 * can see it exists), and the verdict is injected into the system prompt every
 * step, together with the SOP stage the recorded data supports.
 *
 * The browser half ships from this same package (`exports["./client"]`,
 * discovered through the `dsh.client` declaration in `package.json`), so one
 * package is one product surface on both faces.
 *
 * @module @ai-webnovel/composer-host
 */

import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { emptyNovel } from './core/novel.ts'
import type { WorkspaceKind, WorkspaceVerdict } from './core/workspace.ts'
import type { ReviewSettings } from './host/llm.ts'
import { createSnapshotCache, registerWorkspacePrompt } from './host/prompt.ts'
import { createProjectResolver } from './host/resolver.ts'
import { registerReviewTool, registerTools } from './host/tools.ts'
import { NovelStore, NOVEL_RELATIVE_PATH } from './host/store.ts'

/** Stable Cordis plugin name. */
export const name = 'ai-webnovel-composer'

/** Services required before the tools can read or write project state. */
export const inject = ['fs', 'tools']

/** How the composer should treat the directory it is mounted in. */
export const WORKSPACE_MODES = ['auto', 'novel', 'off'] as const

/** One entry of {@link WORKSPACE_MODES}. */
export type WorkspaceMode = (typeof WORKSPACE_MODES)[number]

/**
 * Deployment configuration.
 *
 * Every field has a working default: a profile that inserts the row with no
 * `config` at all gets a composer rooted at the agent's working directory that
 * adopts novel and empty workspaces and stays quiet everywhere else.
 */
export const Config = z.object({
  /** Directory the project lives in. Defaults to the process working directory. */
  workspaceRoot: z.string().default(''),
  /**
   * `auto` (default) adopts a novel or empty workspace and leaves unrelated
   * directories alone; `novel` forces adoption wherever the plugin is mounted
   * with a pinned `workspaceRoot`; `off` never writes anything at boot.
   */
  workspaceMode: z.union([...WORKSPACE_MODES]).default('auto'),
  /**
   * Whether boot may create the project document in an *empty* directory. Off by
   * default: a workspace is just a directory the user chose, and writing files
   * into it before they ask is a surprise. A directory that already looks like a
   * novel (or that carries the document) is adopted either way.
   */
  adoptEmptyWorkspace: z.boolean().default(false),
  /**
   * Provider the review tool calls, with {@link Config.reviewModel}.
   *
   * Empty (the default) means "follow the model this session is using", which is
   * what makes `novel_review` work with no configuration. Set both to pin
   * reviews to a specific model — a cheaper one for routine passes, or a
   * stronger one for an opening that has to land.
   */
  reviewProvider: z.string().default(''),
  /** Model the review tool calls; see {@link Config.reviewProvider}. */
  reviewModel: z.string().default(''),
  /** How long one review call may take before it is abandoned. */
  reviewTimeoutMs: z.number().step(1).min(1000).default(120000),
})

/** Parsed {@link Config}, derived through Schemastery's global type namespace. */
export type ComposerConfig = Schemastery.TypeT<typeof Config>

/** What the composer decided about this workspace, for logging and the prompt. */
export interface WorkspaceActivation {
  /** The classification. */
  readonly verdict: WorkspaceVerdict
  /** Whether boot wrote the project document. */
  readonly created: boolean
  /** The root the decision was made about. */
  readonly workspaceRoot: string
}

/**
 * Mount the composer: classify the workspace, provide the state service, register
 * the tools, and publish the verdict to the system prompt.
 *
 * The service is constructed first so a tool that runs immediately after
 * registration still sees `ctx.novelState`; Cordis disposal of the owning fiber
 * unregisters everything.
 *
 * @param ctx - plugin context carrying `fs` and `tools`.
 * @param config - the deployment's configuration.
 */
export function apply(ctx: Context, config: ComposerConfig): void {
  // The project root belongs to the *session*, not to this process: one service
  // can host sessions for many directories, so tools resolve their store from
  // the calling agent's own `cwd`. The configured root is only the fallback for
  // a session that records none.
  const projects = createProjectResolver(ctx, {
    provide: true,
    ...(config.workspaceRoot === '' ? {} : { configuredRoot: config.workspaceRoot }),
  })
  const workspaceRoot = projects.defaultRoot
  const store = projects.storeFor(workspaceRoot)
  const cache = createSnapshotCache(store)
  const state: { verdict: WorkspaceVerdict | undefined; created: boolean } = {
    verdict: undefined,
    created: false,
  }

  // Classification and adoption must finish before the first model step, and the
  // prompt section reads the result — so the async work is owned by the plugin's
  // effect and the section renders nothing until it lands. `ctx.effect` takes a
  // synchronous body returning a disposer, so the promise is started here and
  // contained: a workspace that cannot be probed must not take down the mount.
  ctx.effect(() => {
    const activation = (async (): Promise<void> => {
      const verdict = modeVerdict(config.workspaceMode, await store.probeWorkspace())
      let created = false
      // Adoption is opt-in for an empty directory (`adoptEmptyWorkspace`):
      // creating files in a directory the user only just pointed the harness at
      // is a surprise, and a workspace is a directory, not necessarily a novel.
      const adoptable = verdict.kind === 'novel' || (verdict.kind === 'fresh' && config.adoptEmptyWorkspace)
      if (adoptable) {
        const outcome = await store.adopt(
          emptyNovel(
            { title: workspaceRoot.split(/[/\\]/u).filter(Boolean).at(-1) ?? '', premise: '' },
            () => new Date().toISOString(),
          ),
        )
        created = outcome === 'created'
      }
      state.verdict = verdict
      state.created = created
      // Prime the prompt cache now, so the very first model step already carries
      // the project numbers rather than "still loading".
      await cache.refresh()
      ctx.logger?.info?.(
        'ai-webnovel-composer: workspace %s (%s)%s — project %s',
        verdict.kind,
        verdict.reason,
        created ? ', project created' : '',
        `${workspaceRoot}/${NOVEL_RELATIVE_PATH}`,
      )
    })()
    void activation.catch((error: unknown) => {
      ctx.logger?.warn?.(
        'ai-webnovel-composer: workspace classification failed, composer stays idle: %s',
        error instanceof Error ? error.message : String(error),
      )
    })
    return () => undefined
  })

  registerTools(ctx, projects, () => state.verdict, cache)
  registerWorkspacePrompt(ctx, store, () => state.verdict, cache)

  // The eight tools compute; `novel_review` asks a model. It is mounted only
  // where an `llm` service exists, so a profile without one keeps a fully usable
  // composer instead of a tool that can only fail.
  //
  // The injection is a *trigger*, not the mounting context: a service context
  // exposes the injected dependency and nothing else, so the tool is registered
  // against this plugin's own ctx — the one that carries `tools`. Mounting is
  // guarded because an injection callback may run again when services change.
  const review: ReviewSettings = {
    provider: config.reviewProvider,
    model: config.reviewModel,
    timeoutMs: config.reviewTimeoutMs,
  }
  let reviewMounted = false
  const mountReview = (): void => {
    if (reviewMounted) return
    reviewMounted = true
    registerReviewTool(ctx, projects, review)
  }
  if (ctx.reflect.get('llm') !== undefined) mountReview()
  else ctx.inject(['llm'], mountReview)
}

/**
 * Apply the deployment's mode to a detected verdict.
 *
 * `novel` is for a profile row pinned to one project directory: the operator has
 * already said what the directory is, so detection only supplies the evidence.
 *
 * @param mode - the configured mode.
 * @param detected - what the filesystem said.
 * @returns the verdict the composer acts on.
 */
function modeVerdict(mode: WorkspaceMode, detected: WorkspaceVerdict): WorkspaceVerdict {
  if (mode === 'novel' && detected.kind !== 'novel') {
    return { ...detected, kind: 'novel', reason: 'project-document' }
  }
  if (mode === 'off' && (detected.kind === 'novel' || detected.kind === 'fresh')) {
    return { ...detected, kind: 'plain' as WorkspaceKind }
  }
  return detected
}

export { NovelStore, NOVEL_RELATIVE_PATH, NOVEL_SERVICE_NAME } from './host/store.ts'
export { createProjectResolver } from './host/resolver.ts'
export type { ProjectResolver, ProjectsView, WorkspaceRef } from './host/resolver.ts'
export { DEFAULT_MANUSCRIPT_PATH, DEFAULT_REVIEW_PATH, DEFAULT_TEMPLATE_PATH, registerReviewTool, registerTools } from './host/tools.ts'
export { NovelReviewError, resolveRoute, runReview } from './host/llm.ts'
export type { LlmRoute, ReviewResult, ReviewSettings } from './host/llm.ts'
export { registerWorkspacePrompt } from './host/prompt.ts'
export * from './core/index.ts'
