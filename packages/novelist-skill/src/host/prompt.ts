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
 * Which workspace the text is about is resolved for **every assembly** from the
 * agent it belongs to, so a session opened in one directory is never described
 * with the facts of the directory the server happened to be launched from. The
 * async half of that answer lives in `host/views.ts`; this module only renders
 * what it finds there.
 *
 * @module @ai-novelist/novelist-skill/host/prompt
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import {
  assessReading,
  assessStage,
  castDebt,
  cheatGaps,
  confirmationStanding,
  describeWritingPlan,
  emptyWriting,
  evaluationHint,
  outlineStyleGaps,
  progressOf,
  phaseForStage,
  sixElementRows,
  spaceTimeDebt,
  SPINE_LABELS,
  stageLabel,
  styleGateReached,
  writingPlanGaps,
} from '../core/index.ts'
import { describeVerdict, type WorkspaceVerdict } from '../core/workspace.ts'
import type { NovelStore } from './store.ts'
import type { SessionRef, WorkspaceView, WorkspaceViews } from './views.ts'

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
  /**
   * The phase reference that teaches the phase the project is in.
   *
   * Empty when the deployment is not a skill bundle (a plain DSH plugin has no
   * `references/` directory beside it). The line is what turns the six generated
   * phase files from something the skill mentions into something the model is
   * pointed at exactly when its stage changes.
   */
  readonly stageReference: string
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
  /**
   * The on-demand evaluation's standing: how many were run, and whether the
   * project now suggests another.
   *
   * Carried in the prompt because it is the one mechanism that keeps an optional
   * check from being forgotten, and because the model must know the check is
   * advisory: it is reported as a suggestion, never as a blocker.
   */
  readonly evaluations: number
  readonly evaluationDue: boolean
  readonly evaluationHint: string
  /** The length plan in one line: 总字数 · 单章字数 · 卷数. */
  readonly planSummary: string
  /** Length questions still unanswered, phrased as what to ask the user. */
  readonly planGaps: readonly string[]
  /**
   * The author checkpoints, as the prompt renders them.
   *
   * Carried here rather than left to the blockers because they are the facts
   * that change what the model may *do* next: without the premise layer signed
   * off `novel_write` refuses, and the step-by-step context is where that has to
   * be visible before the call is made.
   */
  readonly settingsConfirmed: boolean
  /** Whether the layer that gates prose — the premise — is confirmed. */
  readonly preProseConfirmed: boolean
  /** The layer the author should be settling now, or `''` when all are closed. */
  readonly nextSettingsLayer: string
  /** The `novel_confirm` kind of {@link nextSettingsLayer}. */
  readonly nextSettingsKind: string
  /** One line per settings layer, in the SOP's order, as the prompt shows them. */
  readonly settingsLayers: readonly string[]
  readonly styleConfirmed: boolean
  /** Whether the style review is due — the golden three chapters have prose. */
  readonly styleDue: boolean
  /**
   * The 去 AI 化 review's standing, as the prompt renders it.
   *
   * Carried because it is now a *prose gate*: `novel_write` refuses to write past
   * the golden three chapters until one review is on the ledger, so the model has
   * to see it before it makes the call rather than at the refusal. `unreviewed`
   * is the advisory half — the golden chapters nobody has diagnosed yet.
   */
  readonly deAiDone: boolean
  readonly deAiDue: boolean
  readonly deAiUnreviewed: readonly number[]
  /**
   * 写作风格 elements the 全书大纲 has not answered yet.
   *
   * Carried because they are a *prose gate*: `novel_write` refuses while this is
   * non-empty, and the step-by-step context is where that has to be visible
   * before the call is made.
   */
  readonly styleGaps: readonly string[]
  /**
   * Characters with a name and a goal but no 性格 or 说话方式.
   *
   * Advisory, never a gate: it is reported so "有些角色不够丰满" is a number rather
   * than an impression, and so a model carrying a scene does not give four people
   * one voice.
   */
  readonly thinCast: readonly string[]
  /**
   * The traditional 六要素 the outline has not answered, 人物 included.
   *
   * Advisory like `thinCast`: the elements are the ground a chapter is written
   * on, and a model that plans chapters without them is planning scenes with no
   * time, no place and no causal chain.
   */
  readonly storyGaps: readonly string[]
  /** 金手指 fields the outline has not answered. */
  readonly cheatGaps: readonly string[]
  /** Chapters whose contract states no time anchor or place. */
  readonly spaceTimeChapters: readonly number[]
  /** The checkpoints still open, in the SOP's words. */
  readonly confirmationGaps: readonly string[]
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
      const hint = evaluationHint(state)
      const standing = confirmationStanding(state)
      cached = {
        title: state.meta.title,
        premise: state.meta.premise,
        stage: assessment.stage,
        stageLabel: stageLabel(assessment.stage),
        stageReference: phaseForStage(assessment.stage)?.reference ?? '',
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
        evaluations: state.evaluations.length,
        evaluationDue: hint.due,
        evaluationHint: hint.reason,
        planSummary: describeWritingPlan(state.writing),
        planGaps: writingPlanGaps(state.writing).map((gap) => gap.requirement),
        settingsConfirmed: standing.settingsConfirmed,
        preProseConfirmed: standing.preProseConfirmed,
        nextSettingsLayer: standing.nextLayer?.label ?? '',
        nextSettingsKind: standing.nextLayer === undefined
          ? ''
          : standing.nextLayer.key === 'premise'
            ? 'settings'
            : standing.nextLayer.kind,
        settingsLayers: standing.layers.map(
          (layer) =>
            `${layer.confirmed ? 'done' : layer.ready ? 'NOW' : 'waiting'} ${layer.label}`
            + `(kind=${layer.kind}${layer.confirmed ? '' : `, ${String(layer.rounds)}/${String(layer.roundsRequired)} rounds`})`,
        ),
        styleConfirmed: standing.styleConfirmed,
        styleDue: styleGateReached(state),
        deAiDone: standing.deAi.done,
        deAiDue: standing.deAi.due,
        deAiUnreviewed: standing.deAi.unreviewed,
        styleGaps: outlineStyleGaps(state.outline).map((gap) => gap.key),
        thinCast: castDebt(state).map((gap) => `${gap.name}（缺 ${gap.missing.join('、')}）`),
        storyGaps: sixElementRows(state).filter((row) => !row.filled).map((row) => row.label),
        cheatGaps: cheatGaps(state.outline).map((gap) => SPINE_LABELS[gap.key]),
        spaceTimeChapters: spaceTimeDebt(state).map((entry) => entry.number),
        confirmationGaps: standing.blockers,
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
          stageReference: '',
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
          evaluations: 0,
          evaluationDue: false,
          evaluationHint: '',
          planSummary: describeWritingPlan(emptyWriting()),
          planGaps: [],
          settingsConfirmed: false,
          preProseConfirmed: false,
          nextSettingsLayer: '',
          nextSettingsKind: '',
          settingsLayers: [],
          styleConfirmed: false,
          deAiDone: false,
          deAiDue: false,
          deAiUnreviewed: [],
          styleDue: false,
          styleGaps: [],
          thinCast: [],
          storyGaps: [],
          cheatGaps: [],
          spaceTimeChapters: [],
          confirmationGaps: [],
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
    + 'the planned and written work, and the blockers are what the next phase still needs. Plan with novel_plan, record '
    + 'cast, world and promises with novel_bible, write with novel_write (reporting which contract fields the draft '
    + 'delivered). Before a chapter, the writing-craft sheets are one call away: novel_status detail="craft" '
    + 'topic="hooks" (or platforms / payoffs / naming / voice / submission) returns the checklist for the problem at '
    + 'hand — read only the sheet that matches it, and treat it as a checklist, not platform law. '
    + 'TWO CHECKPOINTS BELONG TO THE AUTHOR, and neither may be closed on their behalf. First the settings: an '
    + 'inspiration is a starting point, so put the setup in front of the user, revise it over recorded rounds '
    + '(novel_confirm operation="discuss" kind="settings", each round carrying their own words) and let them confirm it '
    + '(operation="confirm" kind="settings"); novel_write refuses prose until then. The settings are settled one layer at '
    + 'a time — 立意 → 世界观 → 人物设定 → 全书大纲 → 分卷大纲 — and the 全书大纲 layer carries the book\'s 写作风格 '
    + '(基调/人称与视角/句式与节奏/遣词用句/对话与描写/情绪落点/负面清单): write all seven before any prose, because '
    + 'novel_write refuses a chapter while one is missing, and do not write chapter 1 on a voice the author has not seen. '
    + 'Second the voice: once the golden three chapters (第 1–3 章) have prose, hand them to the user, ask whether '
    + '文风/表达方式/遣词用句 need adjusting, record that round and have them confirm it (kind="style") before chapter 4 — '
    + 'if they want changes, write them back into the outline and revise the affected chapters first. '
    + 'A character with a name and a goal but no 性格 or 说话方式 is not a character: novel_bible kind="character" takes '
    + 'personality and voice for everyone, and the runtime context names the ones still thin. '
    + 'Phase three ends in a declared launch decision — novel_plan operation="launch" — not in a number: '
    + 'whether the opening package is worth a full skeleton is a judgement, and no platform data is needed to make it. '
    + 'The data check is novel_assess, and it is ON DEMAND: run it when the user asks whether the book is still worth '
    + 'continuing, which normally means after the book has been live and the platform has numbers to transcribe by hand. '
    + 'It is never a gate — do not treat a missing reading as a reason to stop, and do not push the user to fetch '
    + 'platform numbers they cannot get. When a result carries evaluationDue, that is a suggestion you may pass on, '
    + 'not a blocker. '
    + 'A chapter is written long and published on target: write the first draft to 125% of the chapter target, because '
    + '去 AI 化 and hand-editing delete a large share of it, then trim the finished chapter back to within '
    + '-5%/+15% of the target (a finished chapter may never come in more than 5% short). '
    + 'A soft gate never blocks you, but when a result carries warnings the SOP and your position disagree — say so '
    + 'to the user instead of silently proceeding. If the length plan (总字数 / 单章字数 / 是否分卷) is still '
    + 'unanswered, ask the user before planning chapters: those numbers are theirs to give, not yours to assume.',
  fresh:
    'This workspace is where a novel is being started. Before calling novel_init, ask the user for the length plan — '
    + '总字数, 单章字数, and 是否分卷/分几卷 (offer common tiers as choices; never pick a number for them) — because those '
    + 'answers are what every later length check is measured against. Call novel_init once, with the title, premise, '
    + 'platform, those answers and the same-genre medians you can find — without the medians the SOP thresholds cannot '
    + 'run, and without the length answers no chapter length can be checked. Then follow the pipeline: novel_plan for '
    + 'the pitch and the competitor study, novel_bible for the cast — and settle the setup WITH the user before any '
    + 'prose: the inspiration they gave you is the opening of that conversation, not a finished brief. Record each '
    + 'discussion round (novel_confirm operation="discuss" kind="settings"), have them confirm the setup, and only then '
    + 'write chapter 1 — with the 写作风格 of the 全书大纲 written first (novel_plan operation="outline" styleTone=… …), '
    + 'because novel_write refuses prose while it is missing; after the golden three chapters, ask them to review the '
    + 'voice before chapter 4.',
  plain:
    'This workspace is not a novel project, so the composer tools are idle. Do not create a novel project here '
    + 'unless the user asks you to start one in this directory. When the user does ask — "write a novel here", '
    + '"给我 300 字大纲", "整理这本书的创意", "建立小说项目" — ask them for the length plan first (总字数、单章字数、'
    + '是否分卷/分几卷; offer common tiers as choices, never invent the numbers), then call novel_init with what they '
    + 'told you (title, premise, platform, mode, audience, and the length answers); the project document is what makes '
    + 'the tools, this section and the board real. Then plan with novel_plan — and treat the setup as something to '
    + 'settle with the user over recorded rounds (novel_confirm kind="settings") before the first chapter, not as '
    + 'something to decide for them.',
}

/**
 * One workspace as the render sees it: the directory, its classification, and
 * the numbers behind it.
 *
 * Plain data rather than a live view, so the render is a pure function of what
 * the composer already learned — testable without a filesystem, and incapable of
 * starting work of its own.
 */
export interface WorkspaceContextInput {
  /** The workspace root the text is about. */
  readonly root: string
  /** Absolute path of the project document. */
  readonly documentPath: string
  /** The classification, or `undefined` while it is still being made. */
  readonly verdict: WorkspaceVerdict | undefined
  /** The project numbers, or `undefined` while they are still being read. */
  readonly snapshot: NovelSnapshot | undefined
}

/**
 * The session behind one prompt assembly, when there is one.
 *
 * `@deepseek-ai/dsh-agent` contributes `agent` to {@link AssembleContext} through
 * a module augmentation. Reading it structurally — the same shape the resolver
 * already takes for sessions — keeps this package free of a dependency on the
 * agent loop, and keeps the deployment fallback (`undefined`, an assembly with
 * no session) working in compositions that have no agent at all.
 *
 * @param context - the assembly's context.
 * @returns the session, or `undefined` for an agentless assembly.
 */
function sessionOf(context: AssembleContext): SessionRef | undefined {
  return (context as AssembleContext & { agent?: { session?: SessionRef } }).agent?.session
}

/**
 * The render input for one live view.
 *
 * @param view - the view to project.
 * @returns the plain data {@link renderWorkspaceContext} reads.
 */
export function contextInputOf(view: WorkspaceView): WorkspaceContextInput {
  return {
    root: view.root,
    documentPath: view.documentPath,
    verdict: view.verdict(),
    snapshot: view.snapshot(),
  }
}

/**
 * Render the current orientation for the model. Pure and synchronous.
 *
 * The workspace described is the *session's*, resolved by the caller from the
 * assembly's agent — never the process directory, which is what made the
 * composer tell a session opened in an empty novel folder that it was a software
 * project.
 *
 * @param input - the workspace, its classification, and the cached numbers.
 * @returns the context text, or `''` while classification is still pending.
 */
export function renderWorkspaceContext(input: WorkspaceContextInput): string {
  const { verdict, snapshot } = input
  if (verdict === undefined) return ''
  const lines = [`Composer workspace: ${verdict.kind}. ${describeVerdict(verdict)}`]
  if (verdict.kind !== 'plain') {
    lines.push(`The novel project lives at ${input.documentPath.replace(/\\/gu, '/')}.`)
  }
  if (verdict.kind === 'novel') {
    if (snapshot === undefined) {
      lines.push('The project document is present but empty; call novel_init to record the premise.')
      lines.push(
        'Ask the user for the length plan (总字数 / 单章字数 / 是否分卷) and pass it to novel_init: those numbers decide '
        + 'what every later length check is measured against, and the tool never invents them.',
      )
    } else {
      lines.push(
        `Novel: "${snapshot.title || '(untitled)'}" — ${snapshot.premise || '(no premise recorded)'}`,
        `SOP stage: ${snapshot.stageLabel}.`,
        `Progress: ${String(snapshot.chapters)} chapters, ${String(snapshot.words)} characters `
          + `(${String(snapshot.unwritten)} not yet written, ${String(snapshot.contracted)} with a complete contract, `
          + `${String(snapshot.stock)} in stock); ${String(snapshot.characters)} cast and `
          + `${String(snapshot.worldFacts)} world facts recorded.`,
        `Promises outstanding: ${String(snapshot.openLinks)} (${String(snapshot.overdueLinks)} past their due chapter).`,
        `Writing plan: ${snapshot.planSummary}.`,
        snapshot.chapters === 0
          ? 'No chapters are planned yet; start with novel_plan operation="chapter".'
          : `Latest chapter: #${String(snapshot.lastNumber)} "${snapshot.lastTitle}" (${snapshot.lastStatus}).`,
      )
      // Progressive disclosure, aimed: the workflow is six phases and 600 lines,
      // so the one to read is named by the stage the project is actually in rather
      // than left for the model to pick. Silent where there is no skill bundle.
      if (snapshot.stageReference !== '') {
        lines.push(
          `Read this phase only: ${snapshot.stageReference}`
          + ' (references/common.md holds what every phase shares).',
        )
      }
    }
    if (snapshot !== undefined && snapshot.planGaps.length > 0) {
      lines.push(
        `Length questions still unanswered — ask the user, do not assume: ${snapshot.planGaps.join('；')}`,
      )
    }
    if (snapshot !== undefined) {
      lines.push(
        `Author sign-off: settings ${snapshot.settingsConfirmed ? 'CONFIRMED' : 'NOT confirmed'}`
        + `${snapshot.settingsConfirmed ? '' : ` (prose ${snapshot.preProseConfirmed ? 'open' : 'BLOCKED'})`}; `
        + `style ${snapshot.styleConfirmed ? 'CONFIRMED' : 'not confirmed'}.`,
      )
      if (snapshot.settingsLayers.length > 0) {
        lines.push(`Settings layers, in the order they must be settled: ${snapshot.settingsLayers.join(' → ')}.`)
      }
      if (!snapshot.preProseConfirmed) {
        lines.push(
          'The premise layer is unsigned, and novel_write REFUSES prose until it is: put the premise in front of the '
          + 'user and revise it over at least two recorded rounds — novel_confirm operation="discuss" kind="settings", '
          + 'each round carrying their own answer — then let them confirm it (operation="confirm"). An inspiration is the '
          + 'start of that conversation, not a licence to produce chapters: do not write prose, and do not confirm on '
          + 'their behalf.',
        )
      }
      if (snapshot.nextSettingsLayer !== '') {
        lines.push(
          `The settings are settled ONE LAYER AT A TIME, in order, and the layer in turn is 「${snapshot.nextSettingsLayer}」`
          + ` (novel_confirm kind="${snapshot.nextSettingsKind}"): put that one layer in front of the user, record what `
          + 'they said (operation="discuss"), have them confirm it (operation="confirm"), and only then start the next. '
          + 'Do not hand the user world, cast and outline together — the order is the point, and a later layer is '
          + 'refused while an earlier one is still open.',
        )
      }
      if (snapshot.deAiDue && !snapshot.deAiDone) {
        lines.push(
          'The golden three chapters have prose and no 去 AI 化 diagnosis has ever been recorded on this project: run '
          + 'novel_review operation="ai-flavor" for each of them (原文引用 + 为什么像 AI + 怎么改), fix what it finds, and '
          + 'only then hand the chapters to the author for the voice review. This is SOP step 23 and it is ENFORCED: '
          + 'novel_write refuses to write chapter 4 and beyond until one review is on the ledger, so an AI-flavoured '
          + 'opening cannot quietly become a whole book written in the same voice.',
        )
      } else if (snapshot.deAiDone && snapshot.deAiUnreviewed.length > 0) {
        lines.push(
          `A 去 AI 化 diagnosis is on the ledger, but the golden chapters ${snapshot.deAiUnreviewed.join('、')} have `
          + 'never been diagnosed: run novel_review operation="ai-flavor" for them too — one chapter is a sample, three '
          + 'are the voice of the book.',
        )
      }
      if (!snapshot.styleConfirmed && snapshot.styleDue) {
        lines.push(
          'The golden three chapters have prose and the voice has not been reviewed: hand 第 1–3 章 to the author, ask '
          + 'whether 文风/表达方式/遣词用句 need adjusting, write any adjustment back into the outline and revise the '
          + 'affected chapters, then record the round and have them confirm it (novel_confirm kind="style") before '
          + 'chapter 4.',
        )
      }
      if (snapshot.styleGaps.length > 0) {
        lines.push(
          `The 写作风格 of the 全书大纲 is not written out, and novel_write REFUSES prose until it is: missing `
          + `${snapshot.styleGaps.join('、')}. Write it with novel_plan operation="outline" `
          + '(styleTone=… stylePerspective=… styleRhythm=… styleDiction=… styleDialogue=… styleEmotion=… styleTaboos=…), '
          + 'put it in front of the user with the rest of the outline layer, and settle it before chapter 1 — a voice '
          + 'chosen while writing is a voice the author never got to steer.',
        )
      }
      if (snapshot.thinCast.length > 0) {
        lines.push(
          `Characters that are still thin (a name and a goal, no 性格 or 说话方式): ${snapshot.thinCast.join('；')}. `
          + 'Fill personality and voice with novel_bible kind="character" before they carry a scene — two of them in one '
          + 'dialogue read as one person wearing two names.',
        )
      }
      if (snapshot.storyGaps.length > 0) {
        lines.push(
          `The traditional 六要素 are not answered yet: ${snapshot.storyGaps.join('、')}. `
          + 'Write them with novel_plan operation="outline" (storyTime=… storyPlace=… storyCause=… storyProcess=… '
          + 'storyResult=…); 人物 comes from the cast. A chapter planned without a time, a place and a cause has no '
          + 'ground to stand on.',
        )
      }
      if (snapshot.cheatGaps.length > 0) {
        lines.push(
          `The 金手指 is still missing ${snapshot.cheatGaps.join('、')}: write it with novel_plan operation="cheat" `
          + '(name, owner, rule, cost, limits, growth curve, first reveal). A cheat with no price or ceiling makes every '
          + 'conflict collapse.',
        )
      }
      if (snapshot.spaceTimeChapters.length > 0) {
        lines.push(
          `Chapters with no 时空锚点 (${snapshot.spaceTimeChapters.slice(0, 8).map((number) => `第 ${String(number)} 章`).join('、')}`
          + `${snapshot.spaceTimeChapters.length > 8 ? ' …' : ''}): add \`timeAnchor\` and \`place\` to their contracts `
          + 'with novel_plan operation="chapter" — the 时间/地点 half of the traditional 六要素.',
        )
      }
    }
    if (snapshot !== undefined && snapshot.blockers.length > 0) {
      lines.push(`What the SOP wants before the next phase: ${snapshot.blockers.join('；')}`)
    }
    // The data check, on its own axis. Phrased as a suggestion because that is
    // what it is: the stage above never waits for a reading, and an author who
    // cannot transcribe platform numbers must not be blocked by this line.
    if (snapshot !== undefined && snapshot.evaluationDue) {
      lines.push(
        `Data evaluation (on demand, not a gate): ${snapshot.evaluationHint}. `
        + `${String(snapshot.evaluations)} run so far; offer novel_assess when the user asks whether the book is `
        + 'still worth continuing.',
      )
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
 * The section is registered **globally** and resolves its workspace per
 * assembly, from the agent the assembly is for. Registering it per agent would
 * make the same text a different registration for every session and subagent,
 * while the harness itself reads agent facts the same way (its `cwd`, `provider`
 * and `model` variables are providers over `context.agent`).
 *
 * @param ctx - plugin context carrying the prompt registry.
 * @param views - the per-root views, which own classification and the numbers.
 */
export function registerWorkspacePrompt(ctx: Context, views: WorkspaceViews): void {
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.systemPrompt.context({
      name: WORKSPACE_CONTEXT_NAME,
      order: promptCtx.systemPrompt.getContextOrder('SANDBOX_POLICY') + WORKSPACE_CONTEXT_OFFSET,
      // `viewForSession` also starts the classification when nothing has yet, so
      // a session the lifecycle hook never saw still stops being invisible.
      text: (context) => renderWorkspaceContext(contextInputOf(views.viewForSession(sessionOf(context)))),
    })
  })
}
