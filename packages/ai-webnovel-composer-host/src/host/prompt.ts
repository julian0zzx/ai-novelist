/**
 * The composer's runtime-context contribution.
 *
 * A model that has to discover the workspace by calling a tool every session
 * wastes a turn and often skips it. DSH re-renders dynamic context before every
 * model step, so this section tells the model what the workspace *is* and what
 * the novel currently holds, and which SOP stage the data supports — the
 * orientation `novel_status` would otherwise have to be called for.
 *
 * The prompt registry resolves context text **synchronously**, so the project
 * numbers come from a small cache that is primed at boot and refreshed in the
 * background whenever a step reads a stale entry. A step therefore never blocks
 * on the filesystem, and never sees an error: a failed refresh keeps the last
 * known good numbers and records the reason for the next render.
 *
 * @module @ai-webnovel/composer-host/host/prompt
 */

import type { Context } from '@deepseek-ai/cordis'
import { assessReading, assessStage, progressOf, stageLabel } from '../core/index.ts'
import { describeVerdict, type WorkspaceVerdict } from '../core/workspace.ts'
import type { NovelStore } from './store.ts'

/** Stable section name; the sidebar's own domain context cannot collide with it. */
export const WORKSPACE_CONTEXT_NAME = 'composer:workspace'

/** Placement: after the sandbox and approval facts, before the delegation facts. */
const WORKSPACE_CONTEXT_OFFSET = 8

/** How long a cached project summary is trusted before a background refresh. */
const SNAPSHOT_TTL_MS = 1500

/** The project standing the prompt renders without touching the filesystem. */
export interface NovelSnapshot {
  /** Novel title, empty when unrecorded. */
  readonly title: string
  /** One-paragraph premise, empty when unrecorded. */
  readonly premise: string
  /** The SOP phase the project's data supports, and what the next one needs. */
  readonly stage: string
  /** The phase's label in the SOP's own vocabulary. */
  readonly stageLabel: string
  /** What the next phase still requires. */
  readonly blockers: readonly string[]
  /** Number of planned chapters. */
  readonly chapters: number
  /** Total prose length. */
  readonly words: number
  /** Chapters with no prose yet. */
  readonly unwritten: number
  /** Chapters whose contract answers every field. */
  readonly contracted: number
  /** Unpublished prose held in stock. */
  readonly stock: number
  /** Characters in the bible. */
  readonly characters: number
  /** World facts recorded. */
  readonly worldFacts: number
  /** Promises not yet paid off, and how many are past their due chapter. */
  readonly openLinks: number
  readonly overdueLinks: number
  /** The latest metric reading's verdict, one line per failing metric. */
  readonly metricNotes: readonly string[]
  /** Reading position of the last planned chapter. */
  readonly lastNumber: number
  /** Title of the last planned chapter. */
  readonly lastTitle: string
  /** Lifecycle stage of the last planned chapter. */
  readonly lastStatus: string
  /** Why the last refresh failed, when it did. */
  readonly error?: string
}

/** What the prompt section reads; filled by {@link createSnapshotCache}. */
export interface SnapshotCache {
  /** The freshest summary available right now, or `undefined` before the first successful load. */
  current(): NovelSnapshot | undefined
  /** Force a refresh and await it. */
  refresh(): Promise<void>
}

/**
 * Build a cache over the project document.
 *
 * @param store - the novel state service.
 * @param now - clock seam, so tests can age the cache deliberately.
 * @returns the cache the prompt section reads.
 */
export function createSnapshotCache(store: NovelStore, now: () => number = Date.now): SnapshotCache {
  let cached: NovelSnapshot | undefined
  let loadedAt = 0
  let inFlight: Promise<void> | undefined

  const load = async (): Promise<void> => {
    try {
      const state = await store.read()
      loadedAt = now()
      if (state === undefined) {
        cached = undefined
        return
      }
      const chapters = Object.values(state.chapters).sort((a, b) => a.number - b.number)
      const last = chapters.at(-1)
      const assessment = assessStage(state)
      const progress = progressOf(state)
      const latest = state.readings.at(-1)
      cached = {
        title: state.meta.title,
        premise: state.meta.premise,
        stage: assessment.stage,
        stageLabel: stageLabel(assessment.stage),
        blockers: assessment.blockers,
        chapters: chapters.length,
        words: progress.totalWords,
        unwritten: progress.emptyChapters.length,
        contracted: progress.contractedChapters,
        stock: progress.stockChapters,
        characters: Object.keys(state.characters).length,
        worldFacts: Object.keys(state.world).length,
        openLinks: progress.openLinks.length,
        overdueLinks: progress.overdueLinks.length,
        metricNotes:
          latest === undefined
            ? []
            : assessReading(latest, state.baselines)
                .filter((entry) => entry.passed === false)
                .map((entry) => entry.note),
        lastNumber: last?.number ?? 0,
        lastTitle: last?.title ?? '',
        lastStatus: last?.status ?? 'planned',
      }
    } catch (error) {
      // Keep the last good numbers; report the fault instead of the stale value
      // silently looking current.
      loadedAt = now()
      cached = {
        ...(cached ?? {
          title: '',
          premise: '',
          stage: 'planning',
          stageLabel: '阶段一 策划',
          blockers: [],
          chapters: 0,
          words: 0,
          unwritten: 0,
          contracted: 0,
          stock: 0,
          characters: 0,
          worldFacts: 0,
          openLinks: 0,
          overdueLinks: 0,
          metricNotes: [],
          lastNumber: 0,
          lastTitle: '',
          lastStatus: 'planned',
        }),
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  const cache: SnapshotCache = {
    current() {
      if (cached === undefined) {
        // First read: kick off the load for the next step rather than returning
        // nothing forever if the caller forgot to prime.
        void cache.refresh()
        return undefined
      }
      if (now() - loadedAt > SNAPSHOT_TTL_MS) void cache.refresh()
      return cached
    },
    refresh(): Promise<void> {
      inFlight ??= load().finally(() => {
        inFlight = undefined
      })
      return inFlight
    },
  }
  return cache
}

/** What the composer expects the model to do in each kind of workspace. */
const CONDUCT: Record<WorkspaceVerdict['kind'], string> = {
  novel:
    'This is a novel workspace. Follow the SOP pipeline rather than jumping to prose: the stage above is derived from '
    + 'the recorded data, and the blockers are what the next phase still needs. Plan with novel_plan, record cast, '
    + 'world and promises with novel_bible, validate with novel_verify before committing to a full outline, write with '
    + 'novel_write (reporting which contract fields the draft delivered), and drive iteration with novel_metrics. '
    + 'A soft gate never blocks you, but when a result carries warnings the SOP and your position disagree — say so '
    + 'to the user instead of silently proceeding.',
  fresh:
    'This workspace is where a novel is being started. Call novel_init once, with the title, premise and platform, and '
    + 'the same-genre medians you can find — without those medians the SOP thresholds cannot run. Then follow the '
    + 'pipeline: novel_plan for the pitch and the competitor study, novel_bible for the cast, and only then prose.',
  plain:
    'This workspace is not a novel project, so the composer tools are idle. Do not create a novel project here '
    + 'unless the user asks you to start one in this directory.',
}

/**
 * Render the current orientation for the model. Pure and synchronous.
 *
 * @param store - the novel state service, for the document path.
 * @param verdict - the boot classification, if it has landed yet.
 * @param snapshot - the cached project numbers, if any.
 * @returns the context text, or `''` while classification is still pending.
 */
export function renderWorkspaceContext(
  store: NovelStore,
  verdict: WorkspaceVerdict | undefined,
  snapshot: NovelSnapshot | undefined,
): string {
  if (verdict === undefined) return ''
  const lines = [`Composer workspace: ${verdict.kind}. ${describeVerdict(verdict)}`]
  if (verdict.kind !== 'plain') {
    lines.push(`The novel project lives at ${store.documentPath.replace(/\\/gu, '/')}.`)
  }
  if (verdict.kind === 'novel') {
    if (snapshot === undefined) {
      lines.push('The project document is present but empty; call novel_init to record the premise.')
    } else {
      lines.push(
        `Novel: "${snapshot.title || '(untitled)'}" — ${snapshot.premise || '(no premise recorded)'}`,
        `SOP stage: ${snapshot.stageLabel}.`,
        `Progress: ${String(snapshot.chapters)} chapters, ${String(snapshot.words)} characters `
          + `(${String(snapshot.unwritten)} not yet written, ${String(snapshot.contracted)} with a complete contract, `
          + `${String(snapshot.stock)} in stock); ${String(snapshot.characters)} cast and `
          + `${String(snapshot.worldFacts)} world facts recorded.`,
        `Promises outstanding: ${String(snapshot.openLinks)} (${String(snapshot.overdueLinks)} past their due chapter).`,
        snapshot.chapters === 0
          ? 'No chapters are planned yet; start with novel_plan operation="chapter".'
          : `Latest chapter: #${String(snapshot.lastNumber)} "${snapshot.lastTitle}" (${snapshot.lastStatus}).`,
      )
    }
    if (snapshot !== undefined && snapshot.blockers.length > 0) {
      lines.push(`What the SOP wants before the next phase: ${snapshot.blockers.join('；')}`)
    }
    if (snapshot !== undefined && snapshot.metricNotes.length > 0) {
      lines.push(`Metrics below their threshold: ${snapshot.metricNotes.join('；')}`)
    }
    if (snapshot?.error !== undefined) lines.push(`The project document could not be read: ${snapshot.error}`)
  }
  lines.push(CONDUCT[verdict.kind])
  return lines.join('\n')
}

/**
 * Register the workspace context on the composed system prompt.
 *
 * @param ctx - plugin context carrying the prompt registry.
 * @param store - the novel state service.
 * @param verdict - reads the boot classification, which lands asynchronously.
 * @param cache - the project-number cache.
 */
export function registerWorkspacePrompt(
  ctx: Context,
  store: NovelStore,
  verdict: () => WorkspaceVerdict | undefined,
  cache: SnapshotCache,
): void {
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.systemPrompt.context({
      name: WORKSPACE_CONTEXT_NAME,
      order: promptCtx.systemPrompt.getContextOrder('SANDBOX_POLICY') + WORKSPACE_CONTEXT_OFFSET,
      text: () => renderWorkspaceContext(store, verdict(), cache.current()),
    })
  })
}
