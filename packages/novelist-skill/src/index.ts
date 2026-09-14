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
 * @module @ai-novelist/novelist-skill
 */

import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { adoptableVerdict, hasNovelSignals, type WorkspaceKind, type WorkspaceVerdict } from './core/workspace.ts'
import type { ReviewSettings } from './host/llm.ts'
import { registerWorkspacePrompt } from './host/prompt.ts'
import { createProjectResolver } from './host/resolver.ts'
import { registerReviewTool, registerTools } from './host/tools.ts'
import { createWorkspaceViews, onSessionCreated, type WorkspacePolicy } from './host/views.ts'
import { NOVEL_RELATIVE_PATH } from './host/store.ts'

/** Stable Cordis plugin name. */
export const name = 'ai-novelist'

/** Services required before the tools can read or write project state. */
export const inject = ['fs', 'tools']

/**
 * Deployment workspace modes, in ascending order of how much they write.
 *
 * - `signal` (default) also initializes a directory that carries unmistakable
 *   novel material — a `创意整理.md`, a cast file next to a premise file, a few
 *   chapters — even though nothing there is a project document yet. This is the
 *   common first contact with the composer, and the write is only the empty
 *   scaffold: the title comes from the folder name and every story decision stays
 *   unmade, so the tools, the prompt section and the board exist from the first
 *   message instead of waiting for someone to remember `novel_init`.
 * - `auto` keeps the older, quieter rule: only a marked novel directory, or an
 *   empty one the deployment opted into, is claimed.
 * - `novel` forces the deployment's own directory to be treated as a project.
 * - `off` never writes anything.
 */
export const WORKSPACE_MODES = ['signal', 'auto', 'novel', 'off'] as const

/** One entry of {@link WORKSPACE_MODES}. */
export type WorkspaceMode = (typeof WORKSPACE_MODES)[number]

/**
 * Deployment configuration.
 *
 * Every field has a working default: a profile that inserts the row with no
 * `config` at all gets a composer rooted at the agent's working directory that
 * initializes a novel directory it recognizes, and stays quiet everywhere else.
 */
export const Config = z.object({
  /** Directory the project lives in. Defaults to the process working directory. */
  workspaceRoot: z.string().default(''),
  /**
   * How eagerly an unmarked novel directory is initialized; see
   * {@link WORKSPACE_MODES}. `signal` (default) also claims a directory whose
   * novel material is unmistakable, `auto` only a marked or opted-in one,
   * `novel` forces the deployment's own root, and `off` never writes.
   */
  workspaceMode: z.union([...WORKSPACE_MODES]).default('signal'),
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
  const deploymentRoot = projects.defaultRoot

  // Both decisions belong to the *deployment*, so they stay here rather than in
  // the views: `workspaceMode` is a statement about the one directory the
  // operator mounted the composer on (a session elsewhere is judged on its own
  // evidence, never forced), while `off` vetoes adoption wherever a session
  // turns up. `adoptEmptyWorkspace` is the same opt-in it always was — an empty
  // directory is only claimed when the deployment said so.
  //
  // The one thing `signal` adds is adoption on *unmarked* novel material, which
  // is why `auto` has to exclude that case explicitly: the classifier calls such
  // a directory a novel one, so leaving it in would quietly make `auto` mean
  // `signal`. Marked projects and existing drafts are adopted by every mode but
  // `off`, exactly as before.
  const policy: WorkspacePolicy = {
    normalize: (root, detected) => (root === deploymentRoot ? modeVerdict(config.workspaceMode, detected) : detected),
    mayAdopt: (verdict) =>
      config.workspaceMode !== 'off' &&
      (adoptableVerdict(verdict, { adoptEmptyWorkspace: config.adoptEmptyWorkspace }) ||
        (config.workspaceMode === 'signal' && hasNovelSignals(verdict))) &&
      !(config.workspaceMode === 'auto' && hasNovelSignals(verdict)),
  }
  const views = createWorkspaceViews(ctx, projects, policy, {
    log: (message, detail) => {
      ctx.logger?.info?.(
        'ai-novelist: %s%s — project %s',
        message,
        detail.created ? ', project created' : '',
        `${detail.root}/${NOVEL_RELATIVE_PATH}`,
      )
    },
  })

  // The deployment's own directory is classified at mount, so the first model
  // step of the first session already carries it; `classify` contains its own
  // failures, because a workspace that cannot be probed must not take down the
  // mount. `ctx.effect` owns the call so an unload leaves nothing running.
  ctx.effect(() => {
    void views.viewFor(deploymentRoot).classify()
    return () => undefined
  })

  // A *session's* workspace is classified when that session appears. Its `cwd`
  // is the directory the composer must describe and write to, and session
  // creation is the earliest moment the harness announces it — the classification
  // then races the first prompt assembly, which is why the render stays silent
  // for the step or two it can lose (see `host/views.ts`). The listener is
  // `global`: a session's scope is not this plugin's, so a scoped listener would
  // never hear about it.
  onSessionCreated(ctx, (session) => {
    void views.viewForSession(session).classify()
  })

  registerTools(ctx, projects, views)
  registerWorkspacePrompt(ctx, views)

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
 * `off` vetoes both kinds the composer would otherwise act on, leaving only the
 * inert `plain` verdict. `signal` and `auto` change nothing here — what they
 * change is {@link WorkspacePolicy.mayAdopt}, because "what is this directory"
 * and "may I write into it" are separate questions.
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
export { createWorkspaceViews, onSessionCreated } from './host/views.ts'
export type { SessionRef, WorkspacePolicy, WorkspaceView, WorkspaceViews } from './host/views.ts'
export * from './core/index.ts'
