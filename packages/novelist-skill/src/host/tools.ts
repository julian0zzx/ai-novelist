/**
 * Model-facing tools: the nine surfaces of the SOP.
 *
 * One tool per capability, each owning one phase or one kind of state, so the
 * model's vocabulary matches the workflow instead of the storage layout:
 *
 * | tool | SOP phase | what it owns |
 * |---|---|---|
 * | `novel_init` | 一 策划 | project, platform, calibration medians, writing parameters |
 * | `novel_confirm` | 一/五 | the author checkpoints: the settings layers settled in order (立意 → 世界观 → 人物设定 → 全书大纲（含写作风格）→ 分卷大纲), then the 文风复核 after the golden three chapters |
 * | `novel_plan` | 一/二/三/四 | pitch, competitors, world, outline (写作风格 included), volumes, beats, chapters, naming, the launch decision |
 * | `novel_bible` | 一/四/六 | cast, world facts, reader promises, and their review |
 * | `novel_write` | 五 连载 | prose plus the contract-delivery report |
 * | `novel_assess` | 五 按需 | the on-demand investment evaluation: readings in, verdict out |
 * | `novel_status` | 全流程 | the SOP dashboard, entirely derived |
 * | `novel_repo` | 六 复盘 | retrospective, IP assets, templates, manuscript export |
 *
 * The data assessment is deliberately *not* a phase. `novel_assess` is started by
 * the author when they want to know whether the book is still worth continuing —
 * normally once the platform has numbers to transcribe — and nothing in the
 * pipeline waits for it. The stage machine advances on planned and written work
 * alone, which is what lets a project move while the numbers are unavailable.
 *
 * Every tool answers with the same envelope — `ok`, `operation`, `detail`, the
 * derived stage, the next phase's blockers, soft-gate `warnings`, and a progress
 * line — so the model learns where the project stands and what the SOP expects
 * next whichever tool it happened to call.
 *
 * The soft gate is deliberate: `novel_plan` and friends never refuse a call
 * because the SOP would rather you were elsewhere. They do it, then tell you.
 * The one exception is `novel_write`, which refuses to write prose while the
 * author has not signed the settings off: running from an inspiration straight
 * to chapters is the failure this surface exists to make impossible.
 *
 * @module @ai-novelist/novelist-skill/host/tools
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { ScheduleService } from '@deepseek-ai/dsh-schedule'
import {
  BEAT_KINDS,
  CHAPTER_STATUSES,
  CONFIRMATION_KINDS,
  CONFIRMATION_MIN_ROUNDS,
  COMPETITOR_TARGET,
  CONTRACT_FIELDS,
  GOLDEN_CHAPTERS,
  LENGTH_BENCHMARKS,
  LINK_STATUSES,
  METRIC_KEYS,
  NAMING_MIN_CANDIDATES,
  OUTLINE_SPINE_PARTS,
  OUTLINE_STYLE_FIELDS,
  OUTLINE_STYLE_PARTS,
  PLATFORM_AUDIENCES,
  PLATFORM_MODES,
  REVIEW_KINDS,
  REVIEW_PROMPT_VERSION,
  SETTINGS_LAYERS,
  SPINE_LABELS,
  STYLE_GATE_CHAPTER,
  styleParamName,
  TOOL_SURFACE,
  VOLUME_SPINE_PARTS,
  WRITING_PLAN_QUESTIONS,
  NovelInputError,
  addConfirmation,
  addDiscussionRound,
  addEvaluation,
  addIteration,
  addLaunchDecision,
  addReading,
  addReview,
  analyzeDelivery,
  assessReading,
  assessStage,
  blockersToFinal,
  buildAiFlavorRequest,
  buildCompetitorRequest,
  buildOpeningRequest,
  buildRetroRequest,
  buildRetrospective,
  buildRewriteRequest,
  buildTemplate,
  calibrationAge,
  castDebt,
  castGaps,
  chapterContractLength,
  characterScope,
  chapterOutlineTarget,
  chaptersPerVolume,
  complianceChecklist,
  confirmationStanding,
  contractGaps,
  contractRows,
  countIneffectiveIterations,
  describeWritingPlan,
  draftRatioLabel,
  draftTargetWords,
  emptyNovel,
  evaluationAction,
  evaluationActionLabel,
  evaluationHint,
  iterationRules,
  judgeIteration,
  layerLengthCheck,
  latestConfirmation,
  lessonPrompts,
  lengthCheck,
  lengthWindow,
  missingContract,
  narrativeReport,
  nextStep,
  normalizeId,
  normalizeWritingPlan,
  openingPackageGaps,
  outlinePayoffGaps,
  outlineSpineGaps,
  outlineSpineValues,
  outlineStyleGaps,
  outlineStyleValues,
  parseReviewOutput,
  progressOf,
  proseGate,
  removeChapter,
  removeLink,
  renderManuscript,
  renderReview,
  resolveChapterId,
  rhythmExpectation,
  setOpeningCheck,
  skeletonGate,
  stageLabel,
  styleGateReached,
  styleObservations,
  styleTabooPhrases,
  tallyAssessments,
  updateBaselines,
  updateMeta,
  updateOutline,
  updatePitch,
  updatePlatform,
  updateWriting,
  upsertBeat,
  upsertChapter,
  upsertCharacter,
  upsertLink,
  upsertVolume,
  upsertWorld,
  unknownScope,
  CHARACTER_SCOPES,
  SCOPE_LABELS,
  verdictFromAssessments,
  volumeLengthNote,
  volumeSpineGaps,
  volumeSpineValues,
  volumeWordTarget,
  worldGaps,
  writingPlanConflicts,
  writingPlanGaps,
  type Clock,
  type Chapter,
  type CharacterScope,
  type ConfirmationKind,
  type DiscussionRound,
  type Evaluation,
  type IterationOutcome,
  type LaunchVerdict,
  type Lesson,
  type MetricBaselines,
  type MetricKey,
  type MetricPeriod,
  type NovelState,
  type ReviewFinding,
  type ReviewKind,
  type ReviewRecord,
  type SettingsLayer,
  type SettingsLayerKey,
  type VerdictLevel,
} from '../core/index.ts'
import { CUT_LOSS_MULTIPLIER, DEFAULT_MULTIPLIERS, INEFFECTIVE_ITERATIONS_FOR_CUT } from '../core/metrics.ts'
import {
  NovelReviewError,
  resolveRoute,
  resolveSubagentProvider,
  runReview,
  runReviewFanout,
  type LlmRoute,
  type ReviewSettings,
} from './llm.ts'
import { syncEvaluationReminder, type ReminderCadence } from './reminder.ts'
import type { ProjectResolver } from './resolver.ts'
import { policyForSession, withSandboxPolicy } from './sandbox.ts'
import { NOVEL_RELATIVE_PATH } from './store.ts'
import type { SessionRef, WorkspaceViews } from './views.ts'

/** Default export destination for the rendered manuscript. */
export const DEFAULT_MANUSCRIPT_PATH = '.novel/manuscript.md'

/** Default directory for exported structural templates. */
export const DEFAULT_TEMPLATE_PATH = '.novel/templates'

/** Default directory for review transcripts and rewritten drafts. */
export const DEFAULT_REVIEW_PATH = '.novel/reviews'

/**
 * Whether writing one settings layer is out of order, and who is still open.
 *
 * The settings are settled a layer at a time, so a world fact written before the
 * premise is confirmed — or a volume outline written before the cast — is a
 * disagreement with the SOP rather than a forbidden act. It is reported as a
 * warning, not a refusal: `novel_plan` is a *soft* gate everywhere, and the one
 * hard gate is `novel_write`. `novel_confirm` is where skipping ahead is actually
 * refused, because that is the point at which an unconfirmed layer would be
 * recorded as settled.
 *
 * @param state - the project as it stood before this write.
 * @param key - the layer being written.
 * @returns the warning, or `undefined` when the layer is the one in turn.
 */
function outOfOrderWarning(state: NovelState, key: SettingsLayerKey): string | undefined {
  const standing = confirmationStanding(state)
  const layer = standing.layers.find((entry) => entry.key === key)
  if (layer === undefined || layer.ready) return undefined
  const blocking = standing.layers.find((entry) => entry.key === layer.blockedBy)
  return (
    `设定要按顺序确定：「${blocking?.label ?? String(layer.blockedBy ?? '')}」这一层还没与用户确认，`
    + `现在就写「${layer.label}」是跳步。先 novel_confirm operation="discuss" kind="${blocking?.kind ?? 'settings'}" `
    + '把上一层谈完并由用户确认，再回到这一层。'
  )
}

/**
 * Refuse work the SOP explicitly postpones until after the launch decision.
 *
 * The sibling of {@link outOfOrderWarning}, and deliberately not a warning.
 * `outOfOrderWarning` covers the settings layers, where writing a layer early is
 * a disagreement the SOP tolerates; this covers the one boundary the SOP states as
 * a rule — *"go 才解锁阶段四：完整大纲、分卷、伏笔、上架卡点"* — where doing the work
 * early is the investment stage three exists to withhold.
 *
 * @param tool - the tool being refused, for the message.
 * @param state - the project as it stood before this write.
 * @param what - the work being attempted, named for the message.
 * @throws {NovelInputError} when no `go` decision authorises the work.
 */
function assertSkeletonAuthorised(tool: string, state: NovelState, what: string): void {
  const gate = skeletonGate(state, what)
  if (gate.allowed) return
  throw new NovelInputError(
    `${tool} refused: ${gate.reasons.join('；')}。`
    + `下一步：${gate.next.join('，然后 ')}。`,
  )
}

/**
 * The content files a project keeps, as the lines a tool body shows.
 *
 * Naming every path is the point: since the split, the author is expected to
 * open these files in their own editor, and a research file they cannot find is
 * a research file they cannot use.
 *
 * @param state - the project.
 * @returns one line per content location, empty when the state has no index yet.
 */
function contentFileLines(state: NovelState): string[] {
  const index = state.index
  if (index === undefined) return []
  const volumes = Object.values(index.volumes).sort((a, b) => a.number - b.number)
  const volumeLine = volumes.length === 0
    ? `- 分卷大纲：${index.volumeDir}/（一卷一个文件，尚无文件）`
    : `- 分卷大纲：${index.volumeDir}/（一卷一个文件，现有 ${String(volumes.length)} 个：`
      + `${volumes.map((ref) => ref.file).join('、')}）`
  const plans = Object.values(index.chapterPlans).sort((a, b) => a.volume - b.volume)
  const planLine = plans.length === 0
    ? `- 章节大纲：${index.chapterPlanFile}（开篇工程清单与索引）+ ${index.chapterPlanDir}/（一卷一个文件，尚无文件）`
    : `- 章节大纲：${index.chapterPlanFile}（开篇工程清单与索引）+ ${index.chapterPlanDir}/（一卷一个文件，现有 `
      + `${String(plans.length)} 个：${plans.map((ref) => ref.file).join('、')}）`
  return [
    `- 全书大纲：${index.outlineFile}`,
    `- 世界观设定：${index.worldFile}`,
    `- 人物设定：${index.castFile}`,
    volumeLine,
    planLine,
    `- 竞品拆解：${index.competitorFile}`,
  ]
}

/**
 * The volume a character's first appearance falls in, when the character itself
 * does not say.
 *
 * Derived rather than stored twice: the chapter plan already owns which volume a
 * chapter belongs to, so a walk-on registered as "第37章" does not also have to
 * be filed under a volume — and cannot disagree with the plan about it.
 *
 * @param state - the project.
 * @param firstAppearance - the chapter id or number as the author wrote it.
 * @returns the volume number, or 0 when it cannot be told.
 */
function volumeOfFirstAppearance(state: NovelState, firstAppearance: string): number {
  const text = firstAppearance.trim()
  if (text === '') return 0
  const named = Object.values(state.chapters).find((chapter) => chapter.id === text)
  if (named !== undefined) return named.volume
  const number = Number.parseInt(/\d+/u.exec(text)?.[0] ?? '', 10)
  if (!Number.isFinite(number)) return 0
  const chapter = Object.values(state.chapters).find((entry) => entry.number === number)
  return chapter?.volume ?? 0
}

/** The store type one execution resolves. */
type SessionStore = ReturnType<ProjectResolver['storeForSession']>

/**
 * The settings layer one `novel_confirm` kind addresses.
 *
 * `settings` is the SOP's umbrella name for the pre-prose checkpoint and means
 * the same thing as the `premise` layer — one checkpoint, two spellings, so a
 * call written against the older documentation keeps working. `style` addresses
 * no settings layer at all and returns `undefined`.
 *
 * @param kind - the confirmation kind from the call.
 * @returns the layer, or `undefined` for the voice checkpoint.
 */
function settingsLayerFor(kind: ConfirmationKind): SettingsLayer | undefined {
  if (kind === 'style') return undefined
  const wanted: SettingsLayerKey = kind === 'settings' ? 'premise' : kind
  return SETTINGS_LAYERS.find((layer) => layer.key === wanted)
}

/**
 * The layer one call is about, with the status default following the sequence.
 *
 * A bare `operation="status"` is the question "where are we, and what is next?",
 * so once the premise is closed it reports the layer in turn instead of repeating
 * the one already done. An explicit kind, and every mutating operation, keeps the
 * literal mapping — a round or a sign-off must land where the caller aimed it.
 *
 * @param requested - the kind from the call.
 * @param state - the project as it stands.
 * @param operation - the confirmation operation.
 * @returns the layer, or `undefined` for the voice checkpoint.
 */
function layerForKind(
  requested: ConfirmationKind,
  state: NovelState,
  operation: string,
): SettingsLayer | undefined {
  if (requested === 'style') return undefined
  if (requested === 'settings' && operation === 'status') {
    const standing = confirmationStanding(state)
    const premise = standing.layers.find((layer) => layer.key === 'premise')
    if (premise?.confirmed === true) {
      return SETTINGS_LAYERS.find((layer) => layer.key === standing.nextLayer?.key)
    }
    return SETTINGS_LAYERS.find((layer) => layer.key === 'premise')
  }
  return settingsLayerFor(requested)
}

/**
 * What one settings layer is supposed to settle, in the words the model needs.
 *
 * Printed by `novel_confirm operation="status"` so a round starts from what the
 * layer owes rather than from whatever the model remembers about it — the SOP's
 * own list for that layer, and nothing about the layers after it.
 *
 * @param key - the layer's key.
 * @returns the brief, as body lines.
 */
function layerBrief(key: SettingsLayerKey): string {
  switch (key) {
    case 'premise':
      return '书名、一句话立意与唯一记忆点、核心情绪、爽点清单、差异点、精神内核、篇幅四问（总字数/单章字数/分卷）、书名简介标签备选。'
        + '这里只定一句「读起来大概是什么味道」；详细的写作风格（基调、人称与视角、句式与节奏、遣词用句、对话与描写、情绪落点、负面清单）'
        + '留到「全书大纲」那一层，与故事一起交给用户。'
    case 'world':
      return '只定影响冲突的规则：力量体系、代价、限制、阶层、核心矛盾、势力关系。每条规则都要能说出它花什么、禁什么——没有代价的规则生不出冲突。'
    case 'cast':
      return '主角的欲望/恐惧/执念/软肋/成长线，主要配角阵营，反派动机，人物关系与冲突体系，金手指的规则、限制与成长曲线。'
        + '每位出场人物都要有 role（身份/阵营）、goal（要什么）、personality（性格底色与压力下的反应）、voice（说话方式：句长、口头禅、称呼、情绪怎么外化）——'
        + '只有名字和目标的人物在对话里等于没有人物；主角另需 fear/obsession/weakness/growthArc。'
        + '用 novel_bible kind="review" 可以点名谁还不够丰满。'
    case 'outline':
      return '先讲完整故事：故事梗概（从开头到结局）、主角成长线、伙伴成长线、反派成长线、阵营演变、对抗副本（每一场怎么打、奇遇在哪）、失去了什么、获得了什么。'
        + '再定写作风格七要素：文风基调、人称与视角、句式与节奏、遣词用句、对话与描写、情绪与爽点落点、负面清单——这一版是第 1 章起笔的依据，'
        + '正文只能按它写（没写全时 novel_write 会拒绝写正文）。'
        + '再讲爽点与爆点：每 3 章小爽点、每 10 章大爽点、每卷卷末爆点，落到章位上。最后才是体量：全书大纲 ≈ 总字数 ÷ 100。'
        + '四样按这个顺序报，故事没讲完就先不核字数。'
    case 'volume':
      return '先讲完整这一卷的故事：本卷梗概、主角成长、反派成长、阵营演变、核心对抗、代价与失去、收获与获得。'
        + '再讲这一卷的爽点与卷末爆点：独立目标、独立矛盾、阶段性高潮、卷末钩子、卷内节奏，以及它覆盖的章数区间。最后才是体量：分卷大纲 ≈ 本卷字数 ÷ 50。'
    default:
      return ''
  }
}

/**
 * The Chinese names of the cast fields `castGaps` reports.
 *
 * The gap check speaks in field keys because that is what it tests; the author
 * reads 性格 and 说话方式. One map keeps the two from drifting.
 */
const CAST_FIELD_LABELS: Readonly<Record<string, string>> = {
  role: '身份/阵营',
  goal: '欲望',
  personality: '性格',
  voice: '说话方式',
  fear: '恐惧',
  obsession: '执念',
  weakness: '软肋',
  growthArc: '成长线',
  description: '他是谁',
  firstAppearance: '首次出场章',
}

/**
 * Register one composer tool with the calling session's sandbox policy in scope.
 *
 * The composer writes through `ctx.fs` itself rather than through the
 * model-facing file tools, so it has to carry the same per-call sandbox policy
 * those tools do. Without it a confining backend fences every mutation against
 * the *deployment's* root instead of the session workspace — every write denied
 * while reads keep working, which is exactly the failure this wrapper exists to
 * make impossible. Wrapping the registration rather than each handler keeps that
 * guarantee in one place, so a tool added later cannot forget it.
 *
 * @param ctx - the plugin context carrying `fs` and `tools`.
 * @param tool - the definition to register.
 */
function registerScoped(ctx: Context, tool: ToolDefinition): void {
  const execute = tool.execute
  ctx.tools.register({
    ...tool,
    execute: (args, exec) =>
      withSandboxPolicy(policyForSession(ctx, exec.agent?.session), () => execute(args, exec)),
  })
}

/** The envelope fields every tool contributes. */
interface Envelope {
  readonly stage: string
  readonly blockers: string[]
  /**
   * The one step the state machine asks for, derived from the same source as
   * `stage` and `blockers`.
   *
   * `blockers` is the full ordered debt; this is the head of it, or the shut hard
   * gate when one is shut. It exists because a list is not a decision: whichever
   * tool the model called, the result now ends with the same single imperative.
   */
  readonly next: { readonly action: string; readonly blocked: boolean }
  readonly warnings?: string[]
  /**
   * Present only when the project suggests running an investment evaluation.
   *
   * It rides in the envelope rather than in `warnings` on purpose: a warning says
   * the SOP disagrees with where you are, and this never does — the data check is
   * optional by design, and reporting it as a warning would rebuild the gate this
   * design removes.
   */
  readonly evaluationDue?: string
  readonly progress: {
    readonly chapters: number
    readonly words: number
    readonly written: number
    readonly contracted: number
    readonly stock: number
    readonly openLinks: number
    readonly overdueLinks: number
  }
}

/** JSON schema properties of the envelope, reused by every tool. */
const ENVELOPE_PROPERTIES = {
  ok: { type: 'boolean', required: true, description: 'Whether the call changed anything.' },
  operation: { type: 'string', required: true, description: 'Which operation ran.' },
  detail: { type: 'string', required: true, description: 'What happened, in one line.' },
  stage: { type: 'string', required: true, description: 'The SOP phase this project is in.' },
  blockers: {
    type: 'array',
    required: true,
    items: { type: 'string' },
    description: 'What the SOP still needs before the next phase.',
  },
  next: {
    type: 'object',
    required: true,
    additionalProperties: false,
    description:
      'The one step to take now: the shut hard gate if there is one, otherwise the first blocker. `blocked` is true '
      + 'only for a hard gate, where nothing else substitutes and novel_write refuses prose until it is cleared.',
    properties: {
      action: { type: 'string', required: true, description: 'The call to make now, in the SOP\'s own terms.' },
      blocked: { type: 'boolean', required: true, description: 'Whether a hard gate is what demands it.' },
    },
  },
  warnings: {
    type: 'array',
    items: { type: 'string' },
    description: 'Soft-gate notes: the call succeeded, but the SOP disagrees with the position.',
  },
  body: { type: 'array', items: { type: 'string' }, description: 'Tool-specific detail lines.' },
  evaluationDue: {
    type: 'string',
    description:
      'Present only when the project suggests running an investment evaluation now, with the reason. Advisory: the '
      + 'data check is on demand and never blocks anything.',
  },
  progress: {
    type: 'object',
    required: true,
    additionalProperties: false,
    properties: {
      chapters: { type: 'integer', required: true },
      words: { type: 'integer', required: true },
      written: { type: 'integer', required: true },
      contracted: { type: 'integer', required: true },
      stock: { type: 'integer', required: true },
      openLinks: { type: 'integer', required: true },
      overdueLinks: { type: 'integer', required: true },
    },
  },
} as const

/** JSON schema for the envelope, reused by every tool. */
const ENVELOPE_SCHEMA = { type: 'object', additionalProperties: true, properties: ENVELOPE_PROPERTIES } as const

/**
 * Build the envelope's derived share.
 *
 * @param state - the project after the call.
 * @param warnings - soft-gate notes accumulated by the call.
 * @returns the envelope fields every tool shares.
 */
function envelope(state: NovelState, warnings: readonly string[] = []): Envelope {
  const assessment = assessStage(state)
  const progress = progressOf(state)
  const hint = evaluationHint(state)
  return {
    stage: `${assessment.stage}（${stageLabel(assessment.stage)}）`,
    blockers: [...assessment.blockers],
    next: { ...nextStep(state) },
    ...(warnings.length > 0 ? { warnings: [...warnings] } : {}),
    // Only when it is due: an always-present line would train the model to
    // ignore it, and the point of the hint is that it is rare and actionable.
    ...(hint.due ? { evaluationDue: hint.reason } : {}),
    progress: {
      chapters: progress.chapters,
      words: progress.totalWords,
      written: progress.chapters - progress.emptyChapters.length,
      contracted: progress.contractedChapters,
      stock: progress.stockChapters,
      openLinks: progress.openLinks.length,
      overdueLinks: progress.overdueLinks.length,
    },
  }
}

/**
 * The threshold verdict in Chinese, for tool output.
 *
 * @param verdict - the verdict the comparisons produced.
 * @returns 通过 / 部分通过 / 不通过.
 */
function verdictLabelOf(verdict: VerdictLevel): string {
  if (verdict === 'pass') return '通过'
  if (verdict === 'partial') return '部分通过'
  return '不通过'
}

/**
 * Append the SOP's 去 AI 化 statistics to a tool body.
 *
 * The SOP puts 去 AI 化 immediately after every chapter draft, so every
 * operation that hands prose back reports the same countable symptoms rather
 * than waiting to be asked. The header states what the numbers are — statistics,
 * not a verdict — because the rewrite itself is the author's work: nothing here
 * edits the prose, and a revised draft goes back through `novel_write`
 * `operation="write"`.
 *
 * The book's own 写作风格 travels with the statistics, both as the standard the
 * count is made against (the 负面清单 is searched phrase by phrase) and as a
 * reminder printed under them: a chapter handed back with four numbers and no
 * mention of the voice it was supposed to be written in is a chapter whose voice
 * nobody is holding it to.
 *
 * @param body - the accumulator the calling tool is building.
 * @param prose - the chapter text to scan.
 * @param taboos - the outline's 负面清单 text.
 */
function pushStyleHints(body: string[], prose: string, taboos: string): void {
  const observations = styleObservations(prose, styleTabooPhrases(taboos))
  if (observations.length === 0) return
  body.push('', '## 去 AI 化提示（机械统计，不是评价）')
  for (const observation of observations) body.push(`- ${observation}`)
}

/**
 * Append the chapter's two length gates to a tool body.
 *
 * A chapter is written long and published on target: the first draft runs to
 * 125% of the finished target because 去 AI 化 and hand-editing delete a large
 * share of it, and the finished chapter then has to land back inside the target
 * the user gave — never more than 5% under it, up to 15% over. Printing both
 * windows every time prose is handed back is
 * what keeps the draft-target rule from existing only in the documentation — the writer
 * sees the number it is drafting against, and the stage decides which of the two
 * gates binds.
 *
 * @param body - the accumulator the calling tool is building.
 * @param chapter - the chapter whose gates to render.
 */
function pushLengthReport(body: string[], chapter: Chapter): void {
  if (chapter.targetWords <= 0) return
  const draft = draftTargetWords(chapter.targetWords)
  const finalWindow = lengthWindow(chapter.targetWords)
  const draftWindow = lengthWindow(draft)
  const round = (value: number): string => String(Math.round(value))
  body.push('', `## 字数（初稿 ${draftRatioLabel()}，成稿不许低于目标 5%、可高 15%）`)
  body.push(
    `- 成稿目标 ${String(chapter.targetWords)} 字：允许 ${round(finalWindow.low)}–${round(finalWindow.high)} 字`
    + '（下限只差 5%：读者买的是这个长度；上限 +15% 留改稿余量）',
  )
  body.push(
    `- 初稿目标 ${String(draft)} 字（成稿目标 × ${draftRatioLabel()}）：允许 ${round(draftWindow.low)}–${round(draftWindow.high)} 字`
    + '；去 AI 化与手改会成段删减，初稿按这个写才留得住成稿长度',
  )
  const gate = lengthCheck(chapter)
  if (gate !== undefined) body.push(`- 本章按${gate.stage === 'draft' ? '初稿' : '成稿'}口径：${gate.note}`)
}

/**
 * Render the envelope plus tool-specific lines as the text the model reads.
 *
 * @param value - the returned envelope.
 * @param body - tool-specific lines.
 * @returns the content blocks.
 */
function renderEnvelope(
  value: Record<string, unknown>,
  body: readonly string[],
): { type: 'text'; text: string }[] {
  const lines: string[] = [String(value['detail'] ?? '')]
  const lines2 = Array.isArray(value['body']) ? (value['body'] as string[]) : body
  if (lines2.length > 0) lines.push('', ...lines2)
  const warnings = value['warnings']
  if (Array.isArray(warnings) && warnings.length > 0) {
    lines.push('', '## 软拦（SOP 提醒，未阻止本次调用）')
    lines.push(...warnings.map((warning) => `- ${String(warning)}`))
  }
  lines.push('', `阶段：${String(value['stage'] ?? '')}`)
  const blockers = value['blockers']
  if (Array.isArray(blockers) && blockers.length > 0) {
    lines.push('下一阶段的缺口：')
    lines.push(...blockers.map((blocker) => `- ${String(blocker)}`))
  }
  // The head of that debt, or the shut hard gate — reported last so it is the
  // line the model reads immediately before deciding what to call next.
  const next = value['next'] as { action?: unknown; blocked?: unknown } | undefined
  if (next !== undefined && next.action !== undefined && String(next.action) !== '') {
    lines.push('', next.blocked === true ? `## 下一步（硬门禁，未关不能继续）\n${String(next.action)}` : `## 下一步\n${String(next.action)}`)
  }
  const progress = value['progress'] as Record<string, number> | undefined
  if (progress !== undefined) {
    lines.push(
      '',
      `进度：${String(progress['chapters'])} 章 / ${String(progress['words'])} 字 · 已写 ${String(progress['written'])}`
        + ` · 细纲完整 ${String(progress['contracted'])} · 库存 ${String(progress['stock'])}`
        + ` · 未回收承诺 ${String(progress['openLinks'])}（逾期 ${String(progress['overdueLinks'])}）`,
    )
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

/** Shared `render` binding for the envelope tools. */
const renderTool = (args: unknown, value: unknown): { type: 'text'; text: string }[] =>
  renderEnvelope(value as Record<string, unknown>, [])

/** Shared body-collecting helper used by every tool body. */
interface Body {
  readonly lines: string[]
}

/**
 * The deployment settings the tool bodies read.
 *
 * Narrower than the plugin's `Config`: this is only what a tool needs to know,
 * so a test can exercise the tools without constructing a whole deployment.
 */
export interface ComposerSettings {
  /** How often the host reminds the author to run the on-demand evaluation. */
  readonly evaluationReminder: ReminderCadence
  /** IANA zone the reminder's wall-clock time is anchored in. */
  readonly reminderTimeZone: string
}

/**
 * Register every composer tool on `ctx.tools`.
 *
 * @param ctx - plugin context carrying the tool registry.
 * @param projects - resolves the novel store per calling session.
 * @param views - the per-root views whose numbers the prompt renders; a write
 *   refreshes the view of the *calling session's* workspace, never another one's.
 * @param settings - the deployment's reminder cadence and zone.
 */
export function registerTools(
  ctx: Context,
  projects: ProjectResolver,
  views: WorkspaceViews,
  settings: ComposerSettings,
): void {
  /** The store for one execution's session. */
  const storeFor = (session: SessionRef | undefined): SessionStore => projects.storeForSession(session)
  /** Re-read the writing session's project into the prompt after a successful write. */
  const resync = async (session: SessionRef | undefined): Promise<void> => {
    await views.viewForSession(session).refresh()
  }
  const now: Clock = () => new Date().toISOString()

  /**
   * Keep the host's evaluation reminder in step with the project.
   *
   * Called at the four points where the answer can change — a chapter is written,
   * a reading is recorded, an evaluation leaves an appointment, a retrospective
   * closes the book — rather than on a timer, because the project is what decides
   * whether a reminder is warranted at all.
   *
   * @param state - the project after the write.
   * @param exec - the executing tool's context, for the session to deliver to.
   * @param body - the body to append the outcome to.
   * @param warnings - the soft-gate notes to append a failure to.
   */
  const syncReminder = async (
    state: NovelState,
    exec: { readonly agent?: { readonly session?: SessionRef } | undefined; readonly signal?: AbortSignal },
    body: string[],
    warnings: string[],
  ): Promise<void> => {
    const schedule = ctx.reflect.get('schedule') as ScheduleService | undefined
    const outcome = await syncEvaluationReminder(
      schedule,
      exec.agent?.session?.header.id,
      state,
      settings.evaluationReminder,
      settings.reminderTimeZone,
      exec.signal,
    )
    // A routine "nothing changed" is not news; only a real change or a failure is.
    if (outcome.action === 'failed') warnings.push(outcome.note)
    else if (outcome.action !== 'kept' && outcome.action !== 'skipped') body.push('', outcome.note)
  }

  // ── novel_init ──────────────────────────────────────────────────────────────

  registerScoped(ctx,
    defineTool({
      name: 'novel_init',
      description: TOOL_SURFACE.novel_init.summary,
      parameters: {
        title: { type: 'string', description: 'Novel title.' },
        premise: { type: 'string', description: 'One-paragraph premise; kept if already set.' },
        platform: { type: 'string', description: 'Platform name, for example qidian / fanqie / jinjiang.' },
        mode: { type: 'string', enum: [...PLATFORM_MODES], description: 'paid | free | unknown.' },
        audience: { type: 'string', enum: [...PLATFORM_AUDIENCES], description: 'male | female | general.' },
        genres: { type: 'array', items: { type: 'string' }, description: 'Genre tags as the platform spells them.' },
        readers: { type: 'string', description: 'One line on the target reader.' },
        monetization: { type: 'string', description: 'How the novel is expected to earn.' },
        language: { type: 'string', description: 'Prose language, for example zh-CN.' },
        pov: { type: 'string', description: 'Point of view, for example third-limited.' },
        targetWords: {
          type: 'integer',
          description: 'Planned total length in characters. Ask the user; never guess. An unanswered question stays 0.',
        },
        chapterWords: {
          type: 'integer',
          description:
            'Target length of one chapter in characters — the length the reader gets, not the length to draft. Ask the '
            + 'user; chapters planned without their own target inherit this. The first draft is written to 125% of it '
            + '(去 AI 化与手改会大幅删减); a finished chapter must land within -5%/+15% of that target — never '
            + 'more than 5% under it — and novel_write checks a draft against 125% and a finished chapter against that window.',
        },
        totalChapters: {
          type: 'integer',
          description: 'Planned total chapters. Optional: derived from targetWords ÷ chapterWords when omitted.',
        },
        volumes: {
          type: 'integer',
          description:
            'Planned volumes. Ask "分卷吗？分几卷？": 0 is the explicit answer 不分卷（单卷到底）, and omitting it '
            + 'means the question is still unanswered (-1).',
        },
        chaptersPerVolume: {
          type: 'integer',
          description: 'Chapters per volume, when the user answered in that shape instead of a volume count.',
        },
        updateRhythm: { type: 'string', description: 'Update rhythm, for example daily-2.' },
        chapterPlanWindow: { type: 'integer', description: 'Chapters of detailed outline kept ahead of the prose.' },
        openingGateChapters: {
          type: 'array',
          items: { type: 'integer' },
          description: 'Chapter positions the opening metrics are read at, for example [3, 10].',
        },
        stockTargetChapters: { type: 'integer', description: 'Chapters of unpublished prose to hold in stock.' },
        chapterPlanCeiling: { type: 'integer', description: 'How far the rolling outline may run ahead at most.' },
        baselines: {
          type: 'object',
          additionalProperties: true,
          description:
            'Same-genre medians over the last 30 days, keyed by metric: clickRate, readThrough3, followRead10, '
            + 'followRead24h, retention7d, favoriteRate, firstSubscription, averageSubscription, collectToSubscribe, '
            + 'followSubscription, subscription24h, completionRate, retention, adUnlock, averageReadPerChapter, chapterScore.',
        },
        multipliers: {
          type: 'object',
          additionalProperties: true,
          description: 'Optional per-metric override of the default threshold multiplier.',
        },
        baselineSource: { type: 'string', description: 'Where the medians came from: leaderboard, editor, cohort.' },
        naming: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description:
            'Candidate title/blurb/tag sets to record at once, each {title, blurb, tags?, rationale?, active?}. '
            + 'The SOP asks for 3–5 of them before validation; more can be added later with novel_plan operation="naming".',
        },
      },
      output: { schema: ENVELOPE_SCHEMA, render: renderTool },
      execute: async (args, exec) => {
        const store = storeFor(exec.agent?.session)
        const existing = await store.read()
        const warnings: string[] = []
        if (existing === undefined) {
          await store.adopt(
            emptyNovel(
              {
                title: args.title ?? '',
                premise: args.premise ?? '',
                ...(args.genres !== undefined && { genres: args.genres }),
                ...(args.pov !== undefined && { pov: args.pov }),
                ...(args.language !== undefined && { language: args.language }),
              },
              now,
            ),
          )
        } else if (args.premise !== undefined && existing.meta.premise.trim() !== '') {
          warnings.push('premise 已存在，本次未覆盖；改用 novel_plan operation="pitch" 修订立意')
        }

        const next = await store.update((current) => {
          let state = updateMeta(
            current,
            {
              ...(args.title !== undefined && { title: args.title }),
              ...(args.premise !== undefined && current.meta.premise.trim() === '' && { premise: args.premise }),
              ...(args.genres !== undefined && { genres: args.genres }),
              ...(args.pov !== undefined && { pov: args.pov }),
              ...(args.language !== undefined && { language: args.language }),
            },
            now,
          )
          state = updatePlatform(
            state,
            {
              ...(args.platform !== undefined && { name: args.platform }),
              ...(args.mode !== undefined && { mode: args.mode }),
              ...(args.audience !== undefined && { audience: args.audience }),
              ...(args.genres !== undefined && { genres: args.genres }),
              ...(args.readers !== undefined && { readers: args.readers }),
              ...(args.monetization !== undefined && { monetization: args.monetization }),
            },
            now,
          )
          state = updateWriting(
            state,
            {
              ...(args.targetWords !== undefined && { targetWords: args.targetWords }),
              ...(args.chapterWords !== undefined && { chapterWords: args.chapterWords }),
              ...(args.totalChapters !== undefined && { totalChapters: args.totalChapters }),
              ...(args.volumes !== undefined && { volumes: args.volumes }),
              ...(args.updateRhythm !== undefined && { updateRhythm: args.updateRhythm }),
              ...(args.chapterPlanWindow !== undefined && { chapterPlanWindow: args.chapterPlanWindow }),
              ...(args.openingGateChapters !== undefined && { openingGateChapters: args.openingGateChapters }),
              ...(args.stockTargetChapters !== undefined && { stockTargetChapters: args.stockTargetChapters }),
              ...(args.chapterPlanCeiling !== undefined && { chapterPlanCeiling: args.chapterPlanCeiling }),
            },
            now,
          )
          // Derive only forward, and only what the answers imply: total chapters
          // from total length ÷ chapter length, volumes from a chapters-per-volume
          // answer. A stated answer is never overwritten.
          const plan = normalizeWritingPlan(state.writing, {
            ...(args.chaptersPerVolume !== undefined && { chaptersPerVolume: args.chaptersPerVolume }),
          })
          if (plan !== state.writing) state = { ...state, writing: plan, updatedAt: now() }
          if (args.naming !== undefined && args.naming.length > 0) {
            const incoming = args.naming.map((entry, index) => {
              const title = typeof entry['title'] === 'string' ? entry['title'] : ''
              const blurb = typeof entry['blurb'] === 'string' ? entry['blurb'] : ''
              return {
                id: normalizeId(typeof entry['id'] === 'string' ? entry['id'] : '') || normalizeId(title) || `candidate-${String(index + 1)}`,
                title,
                blurb,
                tags: Array.isArray(entry['tags']) ? entry['tags'].filter((tag): tag is string => typeof tag === 'string') : [],
                rationale: typeof entry['rationale'] === 'string' ? entry['rationale'] : '',
                active: entry['active'] === true,
              }
            })
            const activeIncoming = incoming.some((candidate) => candidate.active)
            state = {
              ...state,
              naming: [
                ...state.naming
                  .filter((existing) => !incoming.some((candidate) => candidate.id === existing.id))
                  .map((existing) => (activeIncoming ? { ...existing, active: false } : existing)),
                ...incoming,
              ],
              updatedAt: now(),
            }
          }
          if (args.baselines !== undefined || args.multipliers !== undefined || args.baselineSource !== undefined) {
            const medians: Partial<Record<MetricKey, number>> = { ...state.baselines.medians }
            for (const [key, value] of Object.entries(args.baselines ?? {})) {
              if (typeof value !== 'number' || !Number.isFinite(value)) continue
              if (!(METRIC_KEYS as readonly string[]).includes(key)) {
                warnings.push(`未知指标 "${key}" 已忽略；可用：${METRIC_KEYS.join(', ')}`)
                continue
              }
              Object.assign(medians, { [key]: value })
            }
            const multipliers: Partial<Record<MetricKey, number>> = { ...state.baselines.multipliers }
            for (const [key, value] of Object.entries(args.multipliers ?? {})) {
              if (typeof value === 'number' && Number.isFinite(value)) Object.assign(multipliers, { [key]: value })
            }
            state = updateBaselines(
              state,
              { medians, multipliers, calibratedAt: now(), ...(args.baselineSource !== undefined && { source: args.baselineSource }) },
              now,
            )
          }
          return state
        })

        if (next.naming.length > 0 && next.naming.length < 3) {
          warnings.push(`书名/简介/标签备选 ${String(next.naming.length)}/${String(NAMING_MIN_CANDIDATES)}：SOP 要求至少 ${String(NAMING_MIN_CANDIDATES)} 组，验证阶段要逐个测`)
        }
        // The length numbers are the author's, so an unanswered one is reported as
        // a question to put to them, not as a value to assume.
        const planGaps = writingPlanGaps(next.writing)
        if (planGaps.length > 0) {
          warnings.push(
            `篇幅四问还有 ${String(planGaps.length)} 项没问用户：${planGaps.map((gap) => gap.requirement).join('、')}`
            + `（novel_init 补录，别自己定）`,
          )
        }
        warnings.push(...writingPlanConflicts(next.writing))

        const body = [
          `项目文档：${NOVEL_RELATIVE_PATH}`,
          `平台：${next.platform.name || '—'}（${next.platform.mode}/${next.platform.audience}）`,
          `篇幅：${describeWritingPlan(next.writing)}`,
        ]
        if (planGaps.length > 0) {
          body.push('', '## 初始化必问（把这几条问用户，答案回填 novel_init）')
          for (const question of WRITING_PLAN_QUESTIONS) {
            if (!planGaps.some((gap) => gap.key === question.key)) continue
            body.push(`- ${question.question}（决定：${question.decides}）`)
          }
          body.push('', '## 常见口径（当选项给用户选，不要替他定）')
          for (const tier of LENGTH_BENCHMARKS) {
            body.push(`- ${tier.name}：${tier.targetWords} · 单章 ${tier.chapterWords} · ${tier.volumes}（${tier.note}）`)
          }
        }

        await resync(exec.agent?.session)
        return {
          ok: true,
          operation: 'init',
          detail: `项目已就绪：「${next.meta.title || '(untitled)'}」，已校准 ${String(Object.keys(next.baselines.medians).length)} 项指标中位，候选物料 ${String(next.naming.length)} 组。`,
          ...envelope(next, warnings),
          body,
        }
      },
    }),
  )

  // ── novel_confirm ───────────────────────────────────────────────────────────

  registerScoped(ctx,
    defineTool({
      name: 'novel_confirm',
      description: TOOL_SURFACE.novel_confirm.summary,
      parameters: {
        operation: {
          type: 'string',
          enum: ['status', 'discuss', 'confirm'],
          description: 'status (default) | discuss (record one round with the user) | confirm (record the user\'s sign-off).',
        },
        kind: {
          type: 'string',
          enum: [...CONFIRMATION_KINDS],
          description:
            'Which layer is being settled. settings/premise = 立意与核心设定 (the pre-prose checkpoint) · world = 世界观设定 · '
            + 'cast = 人物设定 · outline = 全书大纲（含写作风格七要素）· volume = 分卷大纲 · '
            + `style = 文风复核（黄金三章即成稿之后，问用户表达方式与遣词用句要不要调整）.`,
        },
        proposal: {
          type: 'string',
          description: 'discuss: what this round puts in front of the user — one layer\'s draft, or what changed since last round.',
        },
        feedback: {
          type: 'string',
          description: 'discuss: what the user answered, in their own words. Required — a round with no feedback is refused.',
        },
        topics: {
          type: 'array',
          items: { type: 'string' },
          description: 'discuss: which settings this round settled (书名/立意/人设/世界观/篇幅/文风 …).',
        },
        summary: {
          type: 'string',
          description: 'confirm: the version the user approved, written down — later chapters are held to it.',
        },
        note: {
          type: 'string',
          description: 'confirm: the user\'s own words giving the sign-off. Required — the author closes the checkpoint.',
        },
      },
      output: { schema: ENVELOPE_SCHEMA, render: renderTool },
      execute: async (args, exec) => {
        const store = storeFor(exec.agent?.session)
        const current = await store.read()
        if (current === undefined) {
          throw new NovelInputError(`no novel project at ${store.documentPath}; call novel_init first`)
        }
        const requested = (args.kind ?? 'settings') as ConfirmationKind
        const operation = args.operation ?? 'status'
        const warnings: string[] = []
        const body: string[] = []

        /**
         * The settings layer a `kind` addresses, or `undefined` for `style`.
         *
         * `operation="status"` with no explicit kind describes **the layer in
         * turn** rather than the premise the umbrella name points at: the status
         * call is how a model or an author asks "what now?", and answering
         * "premise" forever once the premise is closed would hide the layer that
         * actually is next. Every other operation keeps the literal kind, because
         * a write must land where the caller aimed it.
         */
        const layer = layerForKind(requested, current, operation)

        /**
         * The kind a round or a sign-off is recorded under.
         *
         * The caller's own wording is kept rather than normalized: `settings` and
         * `premise` are the same checkpoint addressed two ways, and a project that
         * was talked through under `settings` must not be asked to repeat those
         * rounds because the documentation now calls the layer `premise`. The
         * round *count* is what has to be shared, and it is — the premise layer
         * counts both spellings.
         */
        const recordKind: ConfirmationKind = layer === undefined ? 'style' : requested

        /** Refuse out-of-order layers: the order IS the feature. */
        const assertInOrder = (state: NovelState): void => {
          if (layer === undefined) return
          const standing = confirmationStanding(state)
          const entry = standing.layers.find((item) => item.key === layer.key)
          if (entry === undefined || entry.ready) return
          const blocking = standing.layers.find((item) => item.key === entry.blockedBy)
          throw new NovelInputError(
            `设定要按顺序确定：先关掉「${blocking?.label ?? String(entry.blockedBy ?? '')}」这一层`
            + `（novel_confirm operation="discuss" kind="${blocking?.kind ?? 'settings'}" 记录用户的意见，`
            + `再由用户 operation="confirm"），之后才轮到「${layer.label}」。`
            + '一次性把世界观、人设、大纲全部塞给用户，正是这套顺序要避免的事。',
          )
        }

        /** The checkpoint ledger, as both the author and the model need to see it. */
        const describeStanding = (state: NovelState): void => {
          const standing = confirmationStanding(state)
          if (layer === undefined) {
            const confirmed = standing.style
            body.push(`## 文风复核（style，黄金三章之后）`)
            // The style now lives in the 全书大纲 layer, so the review can only
            // happen once that block exists; the prose gate reports both of these
            // as blockers between here and chapter 1.
            const gate = proseGate(state, 1)
            for (const reason of gate.reasons) body.push(`- ⛔ ${reason}`)
            if (!standing.preProseConfirmed) {
              body.push(
                `- 立意这一层还没关：正文要等「${standing.nextLayer?.label ?? '立意与核心设定'}」关掉之后才写`,
                `  下一步：novel_confirm operation="discuss" kind="${standing.nextLayer?.kind ?? 'settings'}"（写好用户的原话）`,
              )
            }
            const styleGaps = outlineStyleGaps(state.outline)
            body.push(
              '',
              `## 全书大纲里的《写作风格》（novel_plan operation="outline"）`,
              ...narrativeReport(OUTLINE_STYLE_PARTS, outlineStyleValues(state.outline)),
            )
            if (styleGaps.length > 0) {
              body.push(
                '',
                `还缺 ${String(styleGaps.length)} 项，` +
                  `${styleGaps.map((gap) => SPINE_LABELS[gap.key]).join('、')}——`
                  + '这七项补齐之前 novel_write 不会写正文，第 1 章的语感就是模型自己挑的。',
              )
            }
            body.push(
              '',
              `- 已复核：${confirmed === undefined ? '否' : `是（${confirmed.at}）`}`,
              `- 本次确认前需记录 ${String(CONFIRMATION_MIN_ROUNDS.style)} 轮讨论，当前 ${String(standing.styleRounds)} 轮`,
            )
            if (confirmed !== undefined) {
              body.push('', `已确认版本：${confirmed.summary || '（未写摘要）'}`)
              if (confirmed.note !== '') body.push(`用户原话：${confirmed.note}`)
            }
            const history = state.discussions.filter((round) => round.kind === 'style')
            if (history.length > 0) {
              body.push('', `## 讨论记录（${String(history.length)} 轮）`)
              history.forEach((round, index) => {
                body.push(
                  `${String(index + 1)}. ${round.at}${round.topics.length > 0 ? `（${round.topics.join('、')}）` : ''}`,
                  `   - 提案：${round.proposal || '（未写）'}`,
                  `   - 用户：${round.feedback}`,
                )
              })
            }
            if (!styleGateReached(state)) {
              body.push(
                '',
                `## 下一步`,
                `文风复核在黄金三章（第 1–${String(GOLDEN_CHAPTERS)} 章）成稿之后进行：先把这三章按全书大纲的《写作风格》写出来，`,
                '再把正文交给用户读，问清语感、表达方式、遣词用句要不要调整——记录一轮讨论后确认。',
              )
            } else if (confirmed === undefined) {
              body.push(
                '',
                '## 下一步（黄金三章已成稿）',
                `1. 把第 1–${String(GOLDEN_CHAPTERS)} 章正文交给用户读，直接问：文风/表达方式/遣词用句要不要调整？`,
                '2. 要调整：先把调整写回全书大纲的《写作风格》'
                + `（novel_plan operation="outline" ${OUTLINE_STYLE_FIELDS.map((field) => `${styleParamName(field)}=…`).join(' ')}），`
                + '再用 novel_write 把受影响的章节改一遍（status="revised"）。',
                '3. 用 novel_confirm operation="discuss" kind="style" 记下用户的原话（不调整也要记，写下「不用改」的理由）。',
                '4. 用户认可后 operation="confirm"：summary 写调整后的文风基准（后续章节按它写），note 写用户原话。',
                `未复核之前 novel_write 会拒绝写第 ${String(STYLE_GATE_CHAPTER + 1)} 章。`,
              )
            }
            return
          }

          body.push(`## 设定分层的确认进度`)
          for (const entry of standing.layers) {
            const mark = entry.confirmed ? '[x]' : entry.ready ? '[ ] ← 现在这一层' : '[ ]'
            body.push(
              `- ${mark} ${entry.label}（kind="${entry.kind}"）：`
              + `${entry.confirmed ? '已确认' : `未确认，${String(entry.rounds)}/${String(entry.roundsRequired)} 轮`}`
              + `${entry.gatesProse ? '（关掉它才能写正文）' : ''}`,
            )
          }
          body.push('')
          body.push(`## ${layer.label}（kind="${layer.kind}"）`)
          const entry = standing.layers.find((item) => item.key === layer.key)
          const confirmed = layer.kind === 'premise' ? standing.settings : latestConfirmation(state, layer.kind)
          body.push(`- 已确认：${entry?.confirmed === true ? `是（${confirmed?.at ?? ''}）` : '否'}`)
          body.push(
            `- 本次确认前需记录 ${String(entry?.roundsRequired ?? 1)} 轮讨论，当前 ${String(entry?.rounds ?? 0)} 轮`,
          )
          if (entry?.blockedBy !== undefined) {
            const blocking = standing.layers.find((item) => item.key === entry.blockedBy)
            body.push(`- 顺序：先关掉「${blocking?.label ?? String(entry.blockedBy)}」（kind="${blocking?.kind ?? ''}"）`)
          }
          if (confirmed !== undefined) {
            body.push('', `已确认版本：${confirmed.summary || '（未写摘要）'}`)
            if (confirmed.note !== '') body.push(`用户原话：${confirmed.note}`)
          }
          const history = state.discussions.filter((round) => round.kind === recordKind)
          if (history.length > 0) {
            body.push('', `## 讨论记录（${String(history.length)} 轮）`)
            history.forEach((round, index) => {
              body.push(
                `${String(index + 1)}. ${round.at}${round.topics.length > 0 ? `（${round.topics.join('、')}）` : ''}`,
                `   - 提案：${round.proposal || '（未写）'}`,
                `   - 用户：${round.feedback}`,
              )
            })
          }
          body.push(
            '',
            '## 这一层要谈什么',
            layerBrief(layer.key),
            '每轮用 operation="discuss" 记下用户的原话；用户认可后再 operation="confirm"（summary = 他认可的版本）。',
          )
          // A cast layer can be "confirmed" while half its entries are names with
          // a goal attached. Naming them here is the whole point of the check:
          // thin characters are only visible when something counts them. Walk-ons
          // are excluded, because a register entry is not a flat character.
          if (layer.key === 'cast') {
            const thin = castDebt(state)
            const cameos = Object.values(state.characters).filter((character) => characterScope(character) === 'cameo')
            if (thin.length > 0) {
              body.push('', `## 人物丰满度（${String(thin.length)} 位还欠要素）`)
              for (const gap of thin) {
                body.push(
                  `- [${SCOPE_LABELS[gap.scope]}] ${gap.name}（${gap.id}）缺 `
                  + `${gap.missing.map((field) => CAST_FIELD_LABELS[field] ?? field).join('、')}`,
                )
              }
              body.push(
                '缺 personality / voice 的人物在对话里等于没有人物：先把性格底色与说话方式写进《人物设定》，'
                + '再谈这一层的确认（novel_bible kind="character"）。',
              )
            }
            if (cameos.length > 0) {
              body.push(
                `- 另有 ${String(cameos.length)} 位路人（scope="cameo"）已登记：`
                + '他们只要「他是谁 + 首次出场章」，不计入这一层的欠账。',
              )
            }
          }
        }

        if (operation === 'status') {
          const status = confirmationStanding(current)
          describeStanding(current)
          const confirmed = layer === undefined
            ? status.styleConfirmed
            : status.layers.find((entry) => entry.key === layer.key)?.confirmed === true
          return {
            ok: false,
            operation: 'status',
            detail: `${layer === undefined ? '文风复核' : layer.label}确认：${confirmed ? '已确认' : '未确认'}`,
            ...envelope(current, warnings),
            body,
          }
        }

        if (operation === 'discuss') {
          const feedback = (args.feedback ?? '').trim()
          if (feedback === '') {
            throw new NovelInputError(
              'operation="discuss" needs `feedback`: the user\'s own answer to this round. '
              + 'A round that records only your own proposal is not a discussion — put the draft to the user first, then '
              + 'record what they said.',
            )
          }
          assertInOrder(current)
          const round: DiscussionRound = {
            id: `discuss-${recordKind}-${String(current.discussions.filter((entry) => entry.kind === recordKind).length + 1)}`,
            kind: recordKind,
            at: now(),
            proposal: (args.proposal ?? '').trim(),
            feedback,
            topics: args.topics ?? [],
          }
          const next = await store.update((state) => addDiscussionRound(state, round, now))
          const standing = confirmationStanding(next)
          const entry = standing.layers.find((item) => item.key === layer?.key)
          const rounds = layer === undefined ? standing.styleRounds : (entry?.rounds ?? 0)
          const need = CONFIRMATION_MIN_ROUNDS[layer?.kind ?? 'style']
          describeStanding(next)
          if (layer === undefined) {
            body.push(
              '',
              'style 这一轮记的是用户读过黄金三章之后对文风/表达方式/遣词用句的原话。'
              + '如果用户要求调整：先把调整写回全书大纲的《写作风格》'
              + `（novel_plan operation="outline" ${OUTLINE_STYLE_FIELDS.map((field) => `${styleParamName(field)}=…`).join(' ')}），`
              + '再用 novel_write 把受影响的章节改一遍（status="revised"），然后才 confirm。'
              + '用户说「不用改」也要把理由写进这轮 feedback——不然这条记录证明不了他读过。',
            )
          }
          if (rounds < need) {
            body.push('', `还差 ${String(need - rounds)} 轮讨论才能确认：把用户的意见消化进这一层，再问一轮。`)
          } else {
            body.push('', '讨论轮次已够：用户明确认可后，用 operation="confirm" 记下确认版本。')
          }
          await resync(exec.agent?.session)
          return {
            ok: true,
            operation: 'discuss',
            detail: `${layer === undefined ? '文风复核' : layer.label}讨论第 ${String(rounds)} 轮已记录`,
            ...envelope(next, warnings),
            body,
          }
        }

        if (operation !== 'confirm') {
          throw new NovelInputError(`unknown confirmation operation ${JSON.stringify(operation)}`)
        }

        const standing = confirmationStanding(current)
        assertInOrder(current)
        const entry = standing.layers.find((item) => item.key === layer?.key)
        const rounds = layer === undefined ? standing.styleRounds : (entry?.rounds ?? 0)
        const need = CONFIRMATION_MIN_ROUNDS[layer?.kind ?? 'style']
        if (rounds < need) {
          throw new NovelInputError(
            `${layer === undefined ? '文风复核' : layer.label}确认还差 ${String(need - rounds)} 轮与用户的讨论：`
            + `先用 novel_confirm operation="discuss" kind="${entry?.kind ?? 'style'}" 记录每一轮（要写用户的原话），`
            + '确认要建立在这些轮次上，而不是直接宣布。',
          )
        }
        if (recordKind === 'style') {
          if (!styleGateReached(current)) {
            throw new NovelInputError(
              `文风复核要等黄金三章（第 1–${String(GOLDEN_CHAPTERS)} 章）成稿：先把这三章按全书大纲的《写作风格》写出来，`
              + '交给用户读过、问清表达方式与遣词用句要不要调整，再确认。',
            )
          }
        }
        if (recordKind === 'outline') {
          // The style block is part of this layer, and `novel_write` refuses prose
          // until all of it is written. Confirming the layer without it would
          // record "the outline is settled" over a book that has no voice.
          const styleGaps = outlineStyleGaps(current.outline)
          if (styleGaps.length > 0) {
            throw new NovelInputError(
              `全书大纲还缺《写作风格》${String(styleGaps.length)} 项：`
              + `${styleGaps.map((gap) => SPINE_LABELS[gap.key]).join('、')}。`
              + '写作风格是这一层的一部分，也是正文的语感基准：'
              + `先用 novel_plan operation="outline" ${OUTLINE_STYLE_FIELDS.map((field) => `${styleParamName(field)}=…`).join(' ')} `
              + '补齐，与用户谈过之后再确认「全书大纲」。',
            )
          }
        }
        const summary = (args.summary ?? '').trim()
        if (summary === '') {
          throw new NovelInputError(
            'operation="confirm" needs `summary`: write down the version the user approved. '
            + 'It is the reference later chapters and edits are held to.',
          )
        }
        const approval = (args.note ?? '').trim()
        if (approval === '') {
          throw new NovelInputError(
            'operation="confirm" needs `note`: the user\'s own words giving the sign-off. '
            + 'A checkpoint is closed by the author speaking, not by the tool deciding it can be closed — '
            + 'never confirm on their behalf.',
          )
        }
        // The sign-off records how many rounds had been held when it was given,
        // which is what makes "rounds since the sign-off" a subtraction. For the
        // premise that is both spellings of its kind, so it must be counted the
        // same way {@link confirmationStanding} counts it.
        const total =
          layer?.key === 'premise' || layer === undefined
            ? current.discussions.filter((item) => item.kind === 'settings' || item.kind === 'premise').length
            : current.discussions.filter((item) => item.kind === recordKind).length
        const confirmation = {
          id: `confirm-${recordKind}-${String(current.confirmations.filter((item) => item.kind === recordKind).length + 1)}`,
          kind: recordKind,
          at: now(),
          summary,
          note: approval,
          rounds: total,
        }
        const next = await store.update((state) => addConfirmation(state, confirmation, now))
        // Confirming a cast that still has thin entries is allowed — the author may
        // have a reason — but it is said out loud, because "有些角色不够丰满" is
        // exactly the finding a silent sign-off would bury. Walk-ons are not part
        // of it: they are a register that keeps growing while the book is written.
        if (recordKind === 'cast') {
          const thin = castDebt(next)
          if (thin.length > 0) {
            warnings.push(
              `人物设定里还有 ${String(thin.length)} 位角色不够丰满：`
              + thin.map((gap) => `${gap.name}（缺 ${gap.missing.map((field) => CAST_FIELD_LABELS[field] ?? field).join('、')}）`).join('；')
              + '——先补 personality 与 voice，再往下写正文，否则人物在对话里会串味。'
              + '（路人 scope="cameo" 不计入：他们只要「他是谁 + 首次出场章」。）',
            )
          }
        }
        describeStanding(next)
        const remaining = confirmationStanding(next).nextLayer
        body.push('', '## 已关闭的关卡')
        body.push(
          layer === undefined
            ? `文风复核已经用户确认：第 ${String(STYLE_GATE_CHAPTER + 1)} 章起按这一版文风基准写（再调就重新讨论并确认）。`
            : layer.kind === 'premise'
              ? '立意已经用户确认：正文可以开写了，但设定还没谈完。'
              : `「${layer.label}」已经用户确认。`,
        )
        if (layer !== undefined) {
          if (remaining === undefined) {
            body.push('', '## 接下来', '设定五层全部确认完毕：可以进入细纲与正文，并按阶段推进。设定再改要重新讨论并确认。')
          } else {
            body.push(
              '',
              '## 接下来',
              `下一层是「${remaining.label}」（kind="${remaining.kind}"）：把这一层写出来交给用户讨论，`
              + `每轮 operation="discuss" 记下他的原话，认可后 operation="confirm"。`,
              '不要一次把后面几层一起抛给用户——顺序本身就是这套流程要守的东西。',
            )
          }
        }
        await resync(exec.agent?.session)
        return {
          ok: true,
          operation: 'confirm',
          detail: `${layer === undefined ? '文风复核' : layer.label}已确认（${String(total)} 轮讨论）`,
          ...envelope(next, warnings),
          body,
        }
      },
    }),
  )

  // ── novel_plan ──────────────────────────────────────────────────────────────

  registerScoped(ctx,
    defineTool({
      name: 'novel_plan',
      description: TOOL_SURFACE.novel_plan.summary,
      parameters: {
        operation: {
          type: 'string',
          required: true,
          enum: ['competitor', 'pitch', 'world', 'outline', 'volume', 'chapter', 'beat', 'opening', 'naming', 'launch'],
          description: 'Which planning step to write.',
        },
        id: { type: 'string', description: 'Slug of the record; derived from title/name when omitted.' },
        title: { type: 'string', description: 'Title of the competitor / volume / chapter / naming candidate.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'competitor/naming: platform tags.' },
        blurb: { type: 'string', description: 'competitor/naming: the blurb, verbatim.' },
        openingEvent: { type: 'string', description: 'competitor: the event chapter one opens on.' },
        goldenFinger: { type: 'string', description: 'competitor: the protagonist\'s edge.' },
        protagonistDesire: { type: 'string', description: 'competitor: what the protagonist wants.' },
        antagonistMotive: { type: 'string', description: 'competitor: why the antagonist opposes them.' },
        shuangFrequency: { type: 'string', description: 'competitor: how often a payoff lands.' },
        emotionCurve: { type: 'string', description: 'competitor: the emotional curve.' },
        paywallPoint: { type: 'string', description: 'competitor: where the paywall or ramp lands.' },
        chapterHooks: { type: 'string', description: 'competitor: chapter-end hook patterns.' },
        commentKeywords: { type: 'array', items: { type: 'string' }, description: 'competitor: high-frequency comment words.' },
        takeaway: { type: 'string', description: 'competitor: what is reusable from it.' },
        memorablePoint: { type: 'string', description: 'pitch: 主角+世界+执念+能力+对抗+情绪，一句话。' },
        coreEmotion: { type: 'string', description: 'pitch: the core emotional payoff.' },
        shuangPoints: { type: 'array', items: { type: 'string' }, description: 'pitch: the payoff list.' },
        differentiators: { type: 'array', items: { type: 'string' }, description: 'pitch: how it differs from the comparables.' },
        kernel: { type: 'string', description: 'pitch: the theme underneath the plot.' },
        name: { type: 'string', description: 'world: display name of the rule or fact.' },
        kind: { type: 'string', description: 'world: place|faction|power-system|item|history|rule.' },
        cost: { type: 'string', description: 'world: what the rule costs.' },
        limits: { type: 'string', description: 'world: what the rule forbids.' },
        detail: {
          type: 'string',
          description:
            "world: the fact itself. volume: the volume's own 分卷剧情大纲 — 卷内节奏、阶段推进、本卷伏笔. It lands in that "
            + "volume's own file (分卷大纲/第N卷.md) under `## 卷内节奏` and targets about 1/50 of that volume's length.",
        },
        logline: { type: 'string', description: 'outline: the one-sentence story.' },
        synopsis: {
          type: 'string',
          description:
            'outline: the whole book told as a story, start to finish — 谁、要什么、遇到什么、最后怎样. Write it as prose from '
            + '开头到结局, not as a list of turning points. It lands in the `## 叙事骨架` block of 全书大纲.md, and it is the '
            + 'first thing checked: beats and the 1/100 length target are only reported once the story reads whole. '
            + 'volume: this volume told the same way (本卷梗概).',
        },
        protagonistArc: {
          type: 'string',
          description:
            'outline: 主角成长线 — the state the protagonist starts in, the state they end in, and the坎 they cross between. '
            + 'volume: the one step this volume takes them across.',
        },
        supportArcs: {
          type: 'string',
          description: 'outline: 伙伴成长线 — how each main companion changes, and at which node.',
        },
        antagonistArc: {
          type: 'string',
          description:
            'outline: 反派成长线 — how the antagonist grows, wavers, and finally loses. volume: what the antagonist and their '
            + 'people do and become inside this volume.',
        },
        factionShift: {
          type: 'string',
          description:
            'outline/volume: 阵营演变 — how the antagonist side expands, splits or defects, and how the protagonist side turns '
            + 'from one person into a camp.',
        },
        conflictArcs: {
          type: 'string',
          description:
            'outline: 对抗副本 — every confrontation as its own story: how it starts, the 奇遇 inside it, how it ends, and what '
            + 'it costs. Write one entry per confrontation rather than summarising the trend.',
        },
        costs: {
          type: 'string',
          description:
            'outline/volume: 失去了什么 — itemised losses on the protagonist side (people,记忆, position, belief), with the chapter '
            + 'or node where each lands.',
        },
        gains: {
          type: 'string',
          description:
            'outline/volume: 获得了什么 — itemised gains on the protagonist side (power, allies, ground, information, sleep), so the '
            + 'cost column has something to be weighed against.',
        },
        mainConflict: {
          type: 'string',
          description: 'volume: 核心对抗 — this volume\'s central confrontation as a story: how it ignites and how it is settled.',
        },
        styleTone: {
          type: 'string',
          description:
            'outline: 文风基调 — one line on what the book *reads like*, with two or three 「像这样写」 sample sentences. Part of '
            + 'the `## 写作风格` block of 全书大纲.md.',
        },
        stylePerspective: {
          type: 'string',
          description:
            'outline: 人称与视角 — 第几人称、镜头贴谁、能不能切视角、镜头远近。Must agree with the `pov` settled at novel_init.',
        },
        styleRhythm: {
          type: 'string',
          description: 'outline: 句式与节奏 — 长短句比例、段落长度、断句与单句成段用在哪。',
        },
        styleDiction: {
          type: 'string',
          description: 'outline: 遣词用句 — 用词层级（书面/口语/方言/网络语）、称呼习惯、比喻与意象密度、禁用的词。',
        },
        styleDialogue: {
          type: 'string',
          description: 'outline: 对话与描写 — 对话占比、内心戏怎么落地、动作与环境描写的密度与顺序。',
        },
        styleEmotion: {
          type: 'string',
          description: 'outline: 情绪与爽点落点 — 情绪落在哪些可观察的细节上、爽点怎么给、每章收尾时读者该有什么感受。',
        },
        styleTaboos: {
          type: 'string',
          description:
            'outline: 负面清单 — 本书明令禁止的写法：AI 味句式、翻译腔、滥用副词与形容词、章末总结、把情绪直接说出来…… '
            + 'These seven style fields are the prose gate: novel_write refuses to write while any of them is empty.',
        },
        keyBeat: {
          type: 'string',
          description:
            'chapter: 关键转折 — whose arc this chapter moves and how (主角/伙伴/反派), or what turn it takes. A transitional '
            + 'chapter answers it in one clause; waive it with waiveReason if the chapter genuinely has none.',
        },
        price: {
          type: 'string',
          description:
            'chapter: 代价与收获 — what this chapter costs or leaves behind in story terms, as opposed to `emotionalPayoff` which '
            + 'is what the reader feels. Waivable like every contract field.',
        },
        fullOutline: {
          type: 'string',
          description:
            'outline: the whole-book detailed outline — 三幕主线、核心剧情走向、全局伏笔、大高潮节点、终极冲突、结局框架、'
            + '全书钩子体系. It lands in the `## 完整大纲` section of 全书大纲.md and targets about 1/100 of the total '
            + 'length (novel_init targetWords).',
        },
        acts: { type: 'array', items: { type: 'string' }, description: 'outline: act structure, one entry per act.' },
        minimal: { type: 'string', description: 'outline: the minimal viable outline summary.' },
        full: { type: 'boolean', description: 'outline: true records the full-outline stage as confirmed.' },
        targetWords: {
          type: 'integer',
          description:
            'outline/volume/chapter: the target length in characters, overriding the SOP default ratio for that layer '
            + '(全书大纲 ≈ 总字数/100, 分卷大纲 ≈ 本卷字数/50, 章节大纲正文 ≈ 单章字数/5). Ignored for chapter: a chapter '
            + 'inherits the per-chapter length settled at initialization (novel_init chapterWords).',
        },
        number: { type: 'integer', description: 'volume/chapter/beat: the 1-based position.' },
        goal: { type: 'string', description: 'volume: what this volume accomplishes on its own.' },
        conflict: { type: 'string', description: 'volume/chapter: the conflict that carries it.' },
        climax: { type: 'string', description: 'volume: the volume\'s own climax.' },
        endHook: { type: 'string', description: 'volume: the hook that closes the volume.' },
        chapters: { type: 'array', items: { type: 'integer' }, description: 'volume: chapter range, inclusive.' },
        plotTask: { type: 'string', description: 'chapter: what this chapter must accomplish.' },
        emotionalPayoff: { type: 'string', description: 'chapter: what the reader gets emotionally.' },
        infoGap: { type: 'string', description: 'chapter: the information gap opened or closed.' },
        beats: { type: 'array', items: { type: 'string', enum: [...BEAT_KINDS] }, description: 'chapter: beats carried.' },
        hook: { type: 'string', description: 'chapter: the chapter-end hook.' },
        volume: { type: 'integer', description: 'chapter: which volume it belongs to.' },
        waive: {
          type: 'array',
          items: { type: 'string', enum: [...CONTRACT_FIELDS] },
          description: 'chapter: contract fields to waive explicitly, with `waiveReason`.',
        },
        waiveReason: { type: 'string', description: 'chapter: why those fields are waived.' },
        remove: { type: 'boolean', description: 'chapter: delete this chapter instead of writing it.' },
        beatKind: { type: 'string', enum: [...BEAT_KINDS], description: 'beat: which kind of beat.' },
        note: { type: 'string', description: 'beat/opening/launch: one line on what happens, or the evidence.' },
        verdict: {
          type: 'string',
          enum: ['go', 'revise', 'abandon'],
          description: 'launch: go (投入完整骨架) | revise (改后再说) | abandon (放弃该概念).',
        },
        fallback: {
          type: 'string',
          description: 'launch: required when the verdict is not `go` — which phase to fall back to.',
        },
        abandonIf: {
          type: 'string',
          description: 'launch: required when the verdict is not `go` — what would make you drop the concept.',
        },
        key: { type: 'string', description: 'opening: the checklist key; omit to list the checklist.' },
        done: { type: 'boolean', description: 'opening: confirm (true) or unconfirm (false).' },
        rationale: { type: 'string', description: 'naming: why this set should work.' },
        active: { type: 'boolean', description: 'naming: whether this is the published set.' },
      },
      output: { schema: ENVELOPE_SCHEMA, render: renderTool },
      execute: async (args, exec) => {
        const store = storeFor(exec.agent?.session)
        const current = await store.read()
        if (current === undefined) {
          throw new NovelInputError(`no novel project at ${store.documentPath}; call novel_init first`)
        }
        const warnings: string[] = []
        const body: string[] = []
        let detail = ''
        let changed = true

        switch (args.operation) {
          case 'competitor': {
            if (args.title === undefined || args.title.trim() === '') {
              throw new NovelInputError('operation="competitor" needs the comparable title')
            }
            const title = args.title
            const id = normalizeId(args.id) || normalizeId(title) || title.trim()
            const next = await store.update((state) => ({
              ...state,
              competitors: [
                ...state.competitors.filter((entry) => entry.id !== id),
                {
                  id,
                  title,
                  tags: args.tags ?? [],
                  blurb: args.blurb ?? '',
                  openingEvent: args.openingEvent ?? '',
                  goldenFinger: args.goldenFinger ?? '',
                  protagonistDesire: args.protagonistDesire ?? '',
                  antagonistMotive: args.antagonistMotive ?? '',
                  shuangFrequency: args.shuangFrequency ?? '',
                  emotionCurve: args.emotionCurve ?? '',
                  paywallPoint: args.paywallPoint ?? '',
                  chapterHooks: args.chapterHooks ?? '',
                  commentKeywords: args.commentKeywords ?? [],
                  takeaway: args.takeaway ?? '',
                },
              ],
              updatedAt: now(),
            }))
            detail = `已拆解竞品「${title}」（第 ${String(next.competitors.length)} 本）`
            if (next.competitors.length < 20) {
              warnings.push(`竞品拆解 ${String(next.competitors.length)}/${String(COMPETITOR_TARGET)}：SOP 要求 ${String(COMPETITOR_TARGET)}–50 本才看得清赛道`)
            }
            break
          }
          case 'pitch': {
            const next = await store.update((state) =>
              updatePitch(
                state,
                {
                  ...(args.memorablePoint !== undefined && { memorablePoint: args.memorablePoint }),
                  ...(args.coreEmotion !== undefined && { coreEmotion: args.coreEmotion }),
                  ...(args.shuangPoints !== undefined && { shuangPoints: args.shuangPoints }),
                  ...(args.differentiators !== undefined && { differentiators: args.differentiators }),
                  ...(args.kernel !== undefined && { kernel: args.kernel }),
                },
                now,
              ),
            )
            detail = `立意已更新：${next.pitch.memorablePoint || '（记忆点仍为空）'}`
            break
          }
          case 'world': {
            const order = outOfOrderWarning(current, 'world')
            if (order !== undefined) warnings.push(order)
            const next = await store.update((state) =>
              upsertWorld(
                state,
                {
                  ...(args.id !== undefined && { id: args.id }),
                  ...(args.name !== undefined && { name: args.name }),
                  ...(args.kind !== undefined && { kind: args.kind }),
                  ...(args.detail !== undefined && { detail: args.detail }),
                  ...(args.cost !== undefined && { cost: args.cost }),
                  ...(args.limits !== undefined && { limits: args.limits }),
                },
                now,
              ),
            )
            const id = normalizeId(args.id) || normalizeId(args.name) || ''
            detail = `世界设定「${next.world[id]?.name ?? id}」已写入`
            const gap = worldGaps(next).find((entry) => entry.id === id)
            if (gap !== undefined) {
              warnings.push(`该设定缺 ${gap.missing.join('、')}：力量体系必须写明代价与限制，否则无法生成冲突`)
            }
            break
          }
          case 'outline': {
            if (args.full === true || args.fullOutline !== undefined) {
              assertSkeletonAuthorised('novel_plan', current, '完整大纲（full=true）')
              const order = outOfOrderWarning(current, 'outline')
              if (order !== undefined) warnings.push(order)
            }
            const next = await store.update((state) =>
              updateOutline(
                state,
                {
                  ...(args.logline !== undefined && { logline: args.logline }),
                  ...(args.synopsis !== undefined && { synopsis: args.synopsis }),
                  ...(args.protagonistArc !== undefined && { protagonistArc: args.protagonistArc }),
                  ...(args.supportArcs !== undefined && { supportArcs: args.supportArcs }),
                  ...(args.antagonistArc !== undefined && { antagonistArc: args.antagonistArc }),
                  ...(args.factionShift !== undefined && { factionShift: args.factionShift }),
                  ...(args.conflictArcs !== undefined && { conflictArcs: args.conflictArcs }),
                  ...(args.costs !== undefined && { costs: args.costs }),
                  ...(args.gains !== undefined && { gains: args.gains }),
                  ...(args.styleTone !== undefined
                    || args.stylePerspective !== undefined
                    || args.styleRhythm !== undefined
                    || args.styleDiction !== undefined
                    || args.styleDialogue !== undefined
                    || args.styleEmotion !== undefined
                    || args.styleTaboos !== undefined
                    ? {
                        style: {
                          ...state.outline.style,
                          ...(args.styleTone !== undefined && { tone: args.styleTone }),
                          ...(args.stylePerspective !== undefined && { perspective: args.stylePerspective }),
                          ...(args.styleRhythm !== undefined && { rhythm: args.styleRhythm }),
                          ...(args.styleDiction !== undefined && { diction: args.styleDiction }),
                          ...(args.styleDialogue !== undefined && { dialogue: args.styleDialogue }),
                          ...(args.styleEmotion !== undefined && { emotion: args.styleEmotion }),
                          ...(args.styleTaboos !== undefined && { taboos: args.styleTaboos }),
                        },
                      }
                    : {}),
                  ...(args.fullOutline !== undefined && { fullOutline: args.fullOutline }),
                  ...(args.acts !== undefined && { acts: args.acts }),
                  ...(args.minimal !== undefined && { minimal: args.minimal }),
                  ...(args.full !== undefined && { fullOutlineDone: args.full }),
                },
                now,
              ),
            )
            detail = args.full === true ? '完整大纲已标记为确认' : '大纲已更新'
            // 1. Narrative completeness first. The spine is what the beats and the
            // length target are supposed to be attached to, so it is reported
            // before either of them: a 20000-character skeleton with no story is
            // the failure this ordering exists to name.
            const spine = outlineSpineGaps(next.outline)
            body.push('## 叙事完整性', ...narrativeReport(OUTLINE_SPINE_PARTS, outlineSpineValues(next.outline)))
            if (spine.length > 0) {
              warnings.push(
                `全书大纲的叙事骨架还缺 ${String(spine.length)} 项：`
                + `${spine.map((gap) => gap.key).join('、')}——先讲完故事，再看爽点与字数`,
              )
            }
            // 2. Then the style the story is told in. It is the prose gate, so it is
            // reported before the payoff schedule: no 爽点 lands if the voice is not
            // decided, and `novel_write` will refuse until these seven are written.
            const styleGaps = outlineStyleGaps(next.outline)
            body.push('## 写作风格', ...narrativeReport(OUTLINE_STYLE_PARTS, outlineStyleValues(next.outline)))
            if (styleGaps.length > 0) {
              warnings.push(
                `全书大纲的《写作风格》还缺 ${String(styleGaps.length)} 项：`
                + `${styleGaps.map((gap) => SPINE_LABELS[gap.key]).join('、')}——`
                + '这七项是正文的语感基准，补齐之前 novel_write 会拒绝写正文',
              )
            }
            // 3. Then the payoff schedule, checked against the story above.
            const payoff = outlinePayoffGaps(next.outline)
            if (payoff.length > 0) warnings.push(`爽点与爆点还没讲清：${payoff.join('、')}`)
            // 4. Length last. The SOP budgets 全书大纲 at ~1/100 of the whole book.
            // Reported, not enforced: a thin outline is a soft disagreement, and
            // the author may have a reason for it.
            const fullLength = layerLengthCheck(
              'full',
              next.outline.fullOutline.trim().length,
              next.writing.targetWords,
              args.targetWords ?? 0,
            )
            if (fullLength !== undefined) {
              body.push('## 全书大纲字数', `- ${fullLength.note}`)
              if (!fullLength.enough) warnings.push(fullLength.note)
            } else if (next.writing.targetWords <= 0) {
              warnings.push('总字数还没问用户：全书大纲的目标字数按总字数的 1/100 推算，先回 novel_init 定总字数')
            }
            break
          }
          case 'volume': {
            if (args.number === undefined || args.number <= 0) {
              throw new NovelInputError('operation="volume" needs a positive `number`')
            }
            const number = args.number
            assertSkeletonAuthorised('novel_plan', current, '分卷大纲')
            const order = outOfOrderWarning(current, 'volume')
            if (order !== undefined) warnings.push(order)
            // A partial update keeps the elements it did not name. Since this
            // layer now carries a seven-element spine, replacing the whole record
            // on every call would mean that editing a volume's title silently
            // deleted its story.
            const previous = current.outline.volumes.find((volume) => volume.number === number)
            const next = await store.update((state) =>
              upsertVolume(
                state,
                {
                  number,
                  title: args.title ?? previous?.title ?? '',
                  detail: args.detail ?? previous?.detail ?? '',
                  goal: args.goal ?? previous?.goal ?? '',
                  conflict: args.conflict ?? previous?.conflict ?? '',
                  climax: args.climax ?? previous?.climax ?? '',
                  endHook: args.endHook ?? previous?.endHook ?? '',
                  synopsis: args.synopsis ?? previous?.synopsis ?? '',
                  protagonistArc: args.protagonistArc ?? previous?.protagonistArc ?? '',
                  antagonistArc: args.antagonistArc ?? previous?.antagonistArc ?? '',
                  factionShift: args.factionShift ?? previous?.factionShift ?? '',
                  mainConflict: args.mainConflict ?? previous?.mainConflict ?? '',
                  costs: args.costs ?? previous?.costs ?? '',
                  gains: args.gains ?? previous?.gains ?? '',
                  chapters: args.chapters ?? previous?.chapters ?? [],
                },
                now,
              ),
            )
            detail = `第 ${String(number)} 卷已写入`
            const written = next.outline.volumes.find((volume) => volume.number === number)
            // 1. Narrative completeness, same order as the whole-book outline.
            if (written !== undefined) {
              const gaps = volumeSpineGaps(written)
              body.push(`## 第 ${String(number)} 卷叙事完整性`, ...narrativeReport(VOLUME_SPINE_PARTS, volumeSpineValues(written)))
              if (gaps.length > 0) {
                warnings.push(
                  `第 ${String(number)} 卷的叙事骨架还缺 ${String(gaps.length)} 项：`
                  + `${gaps.map((gap) => gap.key).join('、')}——先把这一卷讲完整，再核字数`,
                )
              }
              if (written.goal === '' || written.climax === '') {
                warnings.push(`第 ${String(number)} 卷缺独立目标或高潮：SOP 要求每卷有自己的矛盾与高潮`)
              }
            }
            // The volume count was settled with the user at initialization; the
            // outline has to stay answerable to it, and 0 means 不分卷.
            const declared = next.writing.volumes
            const plannedVolumes = next.outline.volumes.length
            if (declared === 0) {
              warnings.push('写作参数登记为「不分卷」，却写入了分卷大纲：要么回 novel_init 定卷数，要么把这一卷并回单卷')
            } else if (declared > 0 && plannedVolumes > declared) {
              warnings.push(`已写入 ${String(plannedVolumes)} 卷，超过初始化与用户确认的 ${String(declared)} 卷：补问用户改卷数，或合并卷`)
            } else if (declared < 0) {
              warnings.push('是否分卷还没问用户：先回 novel_init 定 volumes（0 = 不分卷），再写分卷大纲')
            }
            if (written !== undefined && written.chapters.length >= 2) {
              const span = (written.chapters.at(-1) ?? 0) - (written.chapters[0] ?? 0) + 1
              const note = volumeLengthNote(span, next.writing)
              if (note !== undefined) warnings.push(`第 ${String(number)} 卷：${note}`)
            }
            // 2. Length last. The SOP budgets 分卷大纲 at ~1/50 of the volume it
            // governs, and the measure is the pacing detail rather than the spine:
            // the spine is checked for presence above, not for size.
            if (written !== undefined) {
              const volumeLength = layerLengthCheck(
                'volume',
                written.detail.trim().length,
                volumeWordTarget(next.writing),
                args.targetWords ?? 0,
              )
              if (volumeLength !== undefined) {
                body.push(`## 第 ${String(number)} 卷字数`, `- ${volumeLength.note}`)
                if (!volumeLength.enough) warnings.push(`第 ${String(number)} 卷：${volumeLength.note}`)
              } else {
                warnings.push(
                  `第 ${String(number)} 卷的字数目标算不出来（每卷章数或单章字数未定）：先补齐 novel_init 的篇幅四问`,
                )
              }
            }
            break
          }
          case 'chapter': {
            if (args.remove === true) {
              if (args.id === undefined) throw new NovelInputError('operation="chapter" with remove needs an `id`')
              const id = args.id
              const next = await store.update((state) => removeChapter(state, id, now))
              detail = `已删除章节 ${id}`
              void next
              break
            }
            if (args.id === undefined && args.title === undefined) {
              throw new NovelInputError('operation="chapter" needs an `id` or a `title`')
            }
            const waived: Partial<Record<(typeof CONTRACT_FIELDS)[number], string>> = {}
            for (const field of args.waive ?? []) {
              waived[field as (typeof CONTRACT_FIELDS)[number]] = args.waiveReason ?? '作者显式放弃'
            }
            const chapterId = resolveChapterId({ id: args.id, title: args.title })
            const next = await store.update((state) => {
              // A chapter that states no target inherits the per-chapter length the
              // user settled at initialization, so the length check has
              // something to compare against instead of silently doing nothing.
              const targetWords = args.targetWords ?? state.writing.chapterWords
              return upsertChapter(
                state,
                {
                  id: chapterId,
                  ...(args.title !== undefined && { title: args.title }),
                  ...(args.number !== undefined && { number: args.number }),
                  ...(args.synopsis !== undefined && { synopsis: args.synopsis }),
                  ...(args.plotTask !== undefined && { plotTask: args.plotTask }),
                  ...(args.conflict !== undefined && { conflict: args.conflict }),
                  ...(args.emotionalPayoff !== undefined && { emotionalPayoff: args.emotionalPayoff }),
                  ...(args.infoGap !== undefined && { infoGap: args.infoGap }),
                  ...(args.beats !== undefined && { beats: args.beats as NovelState['chapters'][string]['beats'] }),
                  ...(args.hook !== undefined && { hook: args.hook }),
                  ...(args.keyBeat !== undefined && { keyBeat: args.keyBeat }),
                  ...(args.price !== undefined && { price: args.price }),
                  ...(targetWords > 0 && { targetWords }),
                  ...(args.volume !== undefined && { volume: args.volume }),
                  ...(Object.keys(waived).length > 0 && { waived }),
                },
                now,
              )
            })
            const chapter = next.chapters[chapterId]
            detail = chapter === undefined
              ? '章节已写入'
              : `第 ${String(chapter.number)} 章「${chapter.title || chapterId}」契约已写入`
            // 1. Narrative completeness first: which contract fields are still
            // unanswered, and whether the two that carry this chapter's share of
            // the story were answered or explicitly waived.
            const gaps = contractGaps(next, { only: [chapterId] })
            if (gaps[0] !== undefined) {
              warnings.push(
                `第 ${String(gaps[0].number)} 章契约缺：${gaps[0].missing.join('、')}`
                + '——先把这一章要讲的故事写清，再看字数',
              )
            }
            // 2. Length last. The contract's targetWords is the finished length;
            // the draft this chapter is now written to is 125% of it. Print both
            // at planning time, which is the last moment before prose exists.
            if (chapter !== undefined && chapter.targetWords > 0) {
              const draft = draftTargetWords(chapter.targetWords)
              body.push('## 本章字数')
              body.push(
                `- 成稿目标 ${String(chapter.targetWords)} 字（读者看到的长度，允许 -5%/+15%）`,
                `- 初稿目标 ${String(draft)} 字 = 成稿目标 × ${draftRatioLabel()}：初稿按这个写，去 AI 化与手改删减后才留得住成稿长度`,
              )
            }
            // The SOP budgets the contract text itself at ~1/5 of the chapter.
            if (chapter !== undefined) {
              const contractLength = layerLengthCheck(
                'chapter',
                chapterContractLength(chapter),
                chapter.targetWords,
                args.targetWords ?? 0,
              )
              if (contractLength !== undefined) {
                const suggested = chapterOutlineTarget(chapter.targetWords)
                body.push(
                  '## 本章细纲字数',
                  `- ${contractLength.note}`,
                  `- 建议 ${String(suggested)} 字：剧情任务、关键转折、代价与收获、冲突、情绪回报、信息差、章末钩子写清到这个量级，正文才有可核对的目标`,
                )
                if (!contractLength.enough) warnings.push(contractLength.note)
              }
            }
            if (chapter !== undefined && chapter.targetWords <= 0) {
              warnings.push(
                `第 ${String(chapter.number)} 章没设目标字数，写作参数里也没有单章字数：先问用户单章多少字`
                + `（novel_init chapterWords），否则正文长度无从核对`,
              )
            }
            if (chapter !== undefined && !next.outline.beats.some((beat) => beat.chapter === chapter.number)) {
              const expected = rhythmExpectation(
                chapter.number,
                chaptersPerVolume(next.writing.totalChapters, next.writing.volumes),
              )
              if (expected !== undefined) {
                warnings.push(
                  `第 ${String(chapter.number)} 章按节奏应为「${expected}」，节拍表里还没有：novel_plan operation="beat"`,
                )
              }
            }
            const planned = Object.values(next.chapters).filter((entry) => entry.body.trim() === '').length
            if (planned > next.writing.chapterPlanCeiling) {
              warnings.push(
                `细纲已达 ${String(planned)} 章，超过上限 ${String(next.writing.chapterPlanCeiling)}：SOP 建议滚动推进，不必一次写完`,
              )
            }
            break
          }
          case 'beat': {
            if (args.number === undefined || args.number <= 0) {
              throw new NovelInputError('operation="beat" needs a positive `number` (the chapter)')
            }
            const chapter = args.number
            assertSkeletonAuthorised('novel_plan', current, '情绪节拍表')
            await store.update((state) =>
              upsertBeat(
                state,
                { chapter, kind: (args.beatKind ?? 'shuang') as NovelState['outline']['beats'][number]['kind'], note: args.note ?? '' },
                now,
              ),
            )
            detail = `第 ${String(chapter)} 章节拍已写入（${args.beatKind ?? 'shuang'}）`
            break
          }
          case 'opening': {
            if (args.key === undefined) {
              changed = false
              body.push('## 开篇工程清单')
              for (const check of current.outline.opening) {
                body.push(
                  `- [${check.done ? 'x' : ' '}] ${check.key} — ${check.requirement}${check.note === '' ? '' : `（${check.note}）`}`,
                )
              }
              detail = `开篇工程清单：${String(current.outline.opening.filter((check) => check.done).length)}/${String(current.outline.opening.length)} 项已确认`
              break
            }
            const key = args.key
            await store.update((state) => setOpeningCheck(state, key, args.done ?? true, args.note ?? '', now))
            detail = `开篇清单项 ${key} 已${args.done === false ? '取消确认' : '确认'}`
            break
          }
          case 'naming': {
            const id = normalizeId(args.id) || normalizeId(args.title) || `candidate-${String(current.naming.length + 1)}`
            const candidate = {
              id,
              title: args.title ?? '',
              blurb: args.blurb ?? '',
              tags: args.tags ?? [],
              rationale: args.rationale ?? '',
              active: args.active ?? false,
            }
            const next = await store.update((state) => ({
              ...state,
              naming: [
                ...state.naming
                  .filter((entry) => entry.id !== id)
                  .map((entry) => (candidate.active ? { ...entry, active: false } : entry)),
                candidate,
              ],
              updatedAt: now(),
            }))
            detail = `候选物料「${candidate.title || id}」已记录`
            if (next.naming.length < 3) {
              warnings.push(`书名/简介/标签备选 ${String(next.naming.length)}/${String(NAMING_MIN_CANDIDATES)}：SOP 要求至少 ${String(NAMING_MIN_CANDIDATES)} 组，验证阶段要逐个测`)
            }
            break
          }
          case 'launch': {
            // The stage-three decision. It is a judgement, so the tool does not
            // compute it — it only refuses to let a non-`go` verdict through
            // without a fallback target and an abandon condition, which is the
            // SOP's own anti-formality rule (C7) and the one thing that survives
            // the move away from a data-driven gate.
            const verdict = (args.verdict ?? 'revise') as LaunchVerdict
            if (args.verdict === undefined) {
              throw new NovelInputError('operation="launch" needs `verdict`: go | revise | abandon')
            }
            if (verdict !== 'go' && (args.fallback === undefined || args.fallback.trim() === '')) {
              throw new NovelInputError(
                `上线决策为「${verdict}」，必须给出 fallback（回退到哪个阶段）才能记录——`
                + 'SOP 要求不通过的上线决策写明回退目标，否则决策会变成走过场',
              )
            }
            if (verdict !== 'go' && (args.abandonIf === undefined || args.abandonIf.trim() === '')) {
              throw new NovelInputError(`上线决策为「${verdict}」，必须给出 abandonIf（什么情况下放弃该概念）`)
            }
            const round = current.launchDecisions.length + 1
            const decision = {
              id: `launch-${String(round)}`,
              at: now(),
              verdict,
              fallback: args.fallback ?? '',
              abandonIf: args.abandonIf ?? '',
              note: args.note ?? '',
            }
            await store.update((state) => addLaunchDecision(state, decision, now))
            detail = `上线决策 ${decision.id}：${verdict === 'go' ? '通过，进入完整大纲' : verdict === 'revise' ? '改后再说' : '放弃该概念'}`
            body.push(`## 上线决策 ${decision.id}`)
            if (verdict === 'go') {
              body.push('- 进入阶段四：完整大纲、分卷、节拍表与伏笔表')
            } else {
              body.push('', `回退目标：${decision.fallback}`, `放弃条件：${decision.abandonIf}`)
              if (verdict === 'revise') body.push('', '改完后重新调用 operation="launch" 记录下一次决策。')
            }
            break
          }
          default: {
            throw new NovelInputError(`unknown planning operation ${JSON.stringify(args.operation)}`)
          }
        }

        const final = (await store.read()) ?? current
        await resync(exec.agent?.session)

        // The soft gate: report the SOP's own preconditions for wherever the
        // project now stands, without ever refusing the call.
        const assessment = assessStage(final)
        if (assessment.stage === 'planning') warnings.push(...assessment.blockers)
        if (final.outline.minimal.trim() !== '' || final.outline.logline.trim() !== '') {
          for (const gap of openingPackageGaps(final)) warnings.push(`开篇包未完成：${gap.requirement}`)
        }

        return {
          ok: changed,
          operation: args.operation,
          detail,
          ...envelope(final, warnings),
          ...(body.length > 0 ? { body } : {}),
        }
      },
    }),
  )

  // ── novel_bible ─────────────────────────────────────────────────────────────

  registerScoped(ctx,
    defineTool({
      name: 'novel_bible',
      description: TOOL_SURFACE.novel_bible.summary,
      parameters: {
        kind: {
          type: 'string',
          required: true,
          enum: ['character', 'world', 'link', 'review'],
          description: 'character | world | link | review.',
        },
        id: { type: 'string', description: 'Slug of the entry; derived from name/note when omitted.' },
        name: { type: 'string', description: 'character/world: display name; required when creating.' },
        role: { type: 'string', description: 'character: protagonist | antagonist | foil | …' },
        scope: {
          type: 'string',
          enum: [...CHARACTER_SCOPES],
          description:
            'character: how much of the spine this character owes. main = 主角/反派/核心伙伴（全 spine）；'
            + 'volume = 一张地图/一卷内反复出现或有台词的配角（身份、欲望、性格、说话方式）；'
            + 'cameo = 一次性的路人（只要「他是谁」+ 首次出场章）。'
            + 'Omitted, a protagonist-shaped role is main and everything else volume — the pre-tier behaviour.',
        },
        description: { type: 'string', description: 'character: appearance and habits — how they are recognised on the page; for a cameo, the one line saying who they are.' },
        firstAppearance: { type: 'string', description: 'character: the chapter they were first seen in, e.g. 第37章. A cameo owes this.' },
        exit: { type: 'string', description: 'character: how they left the story, e.g. 第52章 被灭口 — so a dead walk-on does not walk back in.' },
        personality: {
          type: 'string',
          description:
            'character: 性格 — their 底色, their contradictions, and what they do under pressure. Required of main and volume '
            + 'characters: a cast entry with a name and a goal and no personality is a name, not a character. Not required of a cameo.',
        },
        voice: {
          type: 'string',
          description:
            'character: 说话方式 — sentence length, catchphrases, how they address people, how feelings reach the surface. Required '
            + 'of main and volume characters: it is what keeps two people in one dialogue distinguishable with no attributions. '
            + 'Not required of a cameo — but anyone who speaks should be promoted to volume rather than left silent.',
        },
        goal: { type: 'string', description: 'character: what they want.' },
        fear: { type: 'string', description: 'character: what they are afraid of.' },
        obsession: { type: 'string', description: 'character: the obsession that makes them act against interest.' },
        weakness: { type: 'string', description: 'character: the weakness an opponent can press.' },
        camp: { type: 'string', description: 'character: protagonist-camp | rival | neutral | …' },
        growthArc: { type: 'string', description: 'character: the arc across the novel.' },
        notes: { type: 'string', description: 'character: continuity notes. world: the entry kind.' },
        appendNotes: { type: 'boolean', description: 'character: append to existing notes instead of replacing them.' },
        detail: { type: 'string', description: 'world: the fact itself.' },
        cost: { type: 'string', description: 'world: what it costs.' },
        limits: { type: 'string', description: 'world: what it forbids.' },
        worldKind: { type: 'string', description: 'world: place | faction | power-system | item | history | rule.' },
        note: { type: 'string', description: 'link: the promise as planted, in prose terms.' },
        linkKind: { type: 'string', description: 'link: foreshadow | mystery | hook | promise.' },
        plantedAt: { type: 'string', description: 'link: chapter id or number where it is planted.' },
        dueAt: { type: 'string', description: 'link: chapter id or number it must pay off by.' },
        payoff: { type: 'string', description: 'link: how it pays off.' },
        status: { type: 'string', enum: [...LINK_STATUSES], description: 'link: open | paid | abandoned.' },
        volume: { type: 'integer', description: 'character: the volume/map they belong to (0 = unset), which makes 第 N 卷有哪些人 answerable. link: the volume the payoff belongs to.' },
        remove: { type: 'boolean', description: 'link: delete this promise instead of writing it.' },
      },
      output: { schema: ENVELOPE_SCHEMA, render: renderTool },
      execute: async (args, exec) => {
        const store = storeFor(exec.agent?.session)
        const current = await store.read()
        if (current === undefined) {
          throw new NovelInputError(`no novel project at ${store.documentPath}; call novel_init first`)
        }
        const warnings: string[] = []
        const body: string[] = []
        let detail = ''

        if (args.kind === 'review') {
          const world = worldGaps(current)
          const cast = castGaps(current)
          // Cameo gaps are a register that is incomplete, not a character that is
          // flat: they are reported below, separately, and they never count as
          // debt the way a speaking character without a voice does.
          const debt = castDebt(current)
          const registerGaps = cast.filter((gap) => gap.scope === 'cameo')
          const progress = progressOf(current)
          const byScope = (scope: CharacterScope): number =>
            Object.values(current.characters).filter((character) => characterScope(character) === scope).length
          body.push('## 设定复核')
          body.push(`- 世界设定 ${String(Object.keys(current.world).length)} 条，缺代价/限制 ${String(world.length)} 条`)
          for (const gap of world) body.push(`  - ${gap.name}（${gap.id}）缺 ${gap.missing.join('、')}`)
          body.push(
            `- 人物 ${String(Object.keys(current.characters).length)} 位（主要角色 ${String(byScope('main'))}、`
            + `配角 ${String(byScope('volume'))}、路人 ${String(byScope('cameo'))}），不够丰满 ${String(debt.length)} 位`,
          )
          for (const gap of debt) {
            body.push(
              `  - [${SCOPE_LABELS[gap.scope]}] ${gap.name}（${gap.id}）缺 `
              + `${gap.missing.map((field) => CAST_FIELD_LABELS[field] ?? field).join('、')}`,
            )
          }
          if (debt.length > 0) {
            body.push(
              '  - 补法：novel_bible kind="character" id=… personality=… voice=…（性格底色与说话方式是「不够丰满」最常缺的两项）',
            )
          }
          for (const character of Object.values(current.characters)) {
            if (!unknownScope(character)) continue
            body.push(
              `  - ${character.name}（${character.id}）的 scope="${character.scope}" 不是 `
              + `${CHARACTER_SCOPES.join('/')} 之一，已按 ${SCOPE_LABELS[characterScope(character)]} 计；请改成三档之一`,
            )
          }
          if (registerGaps.length > 0) {
            body.push(`- 路人登记缺项 ${String(registerGaps.length)} 位（不算欠账，只影响「第 N 卷有哪些人」查得准不准）`)
            for (const gap of registerGaps) {
              body.push(
                `  - ${gap.name}（${gap.id}）缺 ${gap.missing.map((field) => CAST_FIELD_LABELS[field] ?? field).join('、')}`,
              )
            }
          }
          body.push(
            `- 承诺未回收 ${String(progress.openLinks.length)} 条，逾期 ${String(progress.overdueLinks.length)} 条`,
          )
          for (const id of progress.overdueLinks) {
            const link = current.links[id]
            if (link !== undefined) body.push(`  - 逾期：${link.note}（应回收于 ${link.dueAt || '未定'}）`)
          }
          detail = `复核完成：世界缺口 ${String(world.length)}，人物缺口 ${String(debt.length)}`
            + `${registerGaps.length > 0 ? `（另有 ${String(registerGaps.length)} 位路人登记不全）` : ''}`
            + `，未回收承诺 ${String(progress.openLinks.length)}`
        } else if (args.kind === 'character') {
          const next = await store.update((state) =>
            upsertCharacter(
              state,
              {
                ...(args.id !== undefined && { id: args.id }),
                ...(args.name !== undefined && { name: args.name }),
                ...(args.role !== undefined && { role: args.role }),
                ...(args.scope !== undefined && { scope: args.scope }),
                ...(args.volume !== undefined && { volume: args.volume }),
                ...(args.firstAppearance !== undefined && { firstAppearance: args.firstAppearance }),
                ...(args.exit !== undefined && { exit: args.exit }),
                ...(args.description !== undefined && { description: args.description }),
                ...(args.personality !== undefined && { personality: args.personality }),
                ...(args.voice !== undefined && { voice: args.voice }),
                ...(args.goal !== undefined && { goal: args.goal }),
                ...(args.fear !== undefined && { fear: args.fear }),
                ...(args.obsession !== undefined && { obsession: args.obsession }),
                ...(args.weakness !== undefined && { weakness: args.weakness }),
                ...(args.camp !== undefined && { camp: args.camp }),
                ...(args.growthArc !== undefined && { growthArc: args.growthArc }),
                ...(args.notes !== undefined && { notes: args.notes }),
                ...(args.appendNotes !== undefined && { appendNotes: args.appendNotes }),
              },
              now,
            ),
          )
          const id = normalizeId(args.id) || normalizeId(args.name) || ''
          const written = next.characters[id]
          const scope = written === undefined ? 'volume' : characterScope(written)
          detail = `人物「${written?.name ?? id}」已写入（${SCOPE_LABELS[scope]}，共 ${String(Object.keys(next.characters).length)} 位）`
          const gap = castGaps(next).find((entry) => entry.id === id)
          if (gap !== undefined && scope === 'cameo') {
            warnings.push(
              `这位路人还缺 ${gap.missing.map((field) => CAST_FIELD_LABELS[field] ?? field).join('、')}：`
              + '路人只要一句「他是谁」和首次出场章就算登记完了——但写清他在哪一章出现过，'
              + '下次回到这张地图时才查得到。他若有台词、还会再出现，就把 scope 升成 volume，补上说话方式',
            )
          } else if (gap !== undefined) {
            warnings.push(
              `该人物（${SCOPE_LABELS[scope]}）缺 ${gap.missing.map((field) => CAST_FIELD_LABELS[field] ?? field).join('、')}：`
              + (scope === 'main'
                ? 'SOP 要求主角/反派/核心伙伴写全 spine（身份/阵营、欲望、性格、说话方式，另加恐惧、执念、软肋与成长线）'
                : 'SOP 要求配角有身份/阵营、欲望、性格与说话方式；只有目标的人物在对话里等于没有人物')
              + '——若他只是这一张地图里的一次性路人，把 scope 写成 cameo 就只需「他是谁 + 首次出场章」',
            )
          }
          // The collision that actually bites when a walk-on is minted without
          // checking the register first: two entries carrying one display name.
          // A derived id would have merged them, so this is someone passing an
          // explicit `id` — which is exactly how the second 老王 gets born.
          const name = written?.name.trim() ?? ''
          const clashes = Object.values(next.characters).filter((other) => other.id !== id && other.name.trim() === name)
          if (name !== '' && clashes.length > 0) {
            warnings.push(
              `「${name}」与已有的 ${clashes.map((other) => `${other.name}（${other.id}）`).join('、')} 重名：`
              + '读者分不清两个同名的人，改个名字，或给他一个固定称呼（「西街的老王」）——'
              + '不显式给 id 时同名会合并成同一位，所以这里通常是 id 写重了',
            )
          }
        } else if (args.kind === 'world') {
          const next = await store.update((state) =>
            upsertWorld(
              state,
              {
                ...(args.id !== undefined && { id: args.id }),
                ...(args.name !== undefined && { name: args.name }),
                ...(args.detail !== undefined && { detail: args.detail }),
                ...(args.cost !== undefined && { cost: args.cost }),
                ...(args.limits !== undefined && { limits: args.limits }),
                ...(args.worldKind !== undefined && { kind: args.worldKind }),
              },
              now,
            ),
          )
          const id = normalizeId(args.id) || normalizeId(args.name) || ''
          detail = `世界设定「${next.world[id]?.name ?? id}」已写入（共 ${String(Object.keys(next.world).length)} 条）`
          const gap = worldGaps(next).find((entry) => entry.id === id)
          if (gap !== undefined) warnings.push(`该设定缺 ${gap.missing.join('、')}：只写能力不写代价与限制，无法生成冲突`)
        } else if (args.remove === true) {
          if (args.id === undefined) throw new NovelInputError('kind="link" with remove needs an `id`')
          const id = args.id
          await store.update((state) => removeLink(state, id, now))
          detail = `已删除承诺 ${id}`
        } else {
          // Planting a promise is stage-four work in the SOP's own list ("go 才解锁
          // 完整大纲、分卷、伏笔、上架卡点"). Clearing one is not: retiring an
          // abandoned promise is always allowed, which is why the `remove` branch
          // above stays ungated.
          assertSkeletonAuthorised('novel_bible', current, '伏笔台账（kind="link"）')
          const next = await store.update((state) =>
            upsertLink(
              state,
              {
                ...(args.id !== undefined && { id: args.id }),
                ...(args.note !== undefined && { note: args.note }),
                ...(args.linkKind !== undefined && { kind: args.linkKind }),
                ...(args.plantedAt !== undefined && { plantedAt: args.plantedAt }),
                ...(args.dueAt !== undefined && { dueAt: args.dueAt }),
                ...(args.payoff !== undefined && { payoff: args.payoff }),
                ...(args.status !== undefined && { status: args.status }),
                ...(args.volume !== undefined && { volume: args.volume }),
              },
              now,
            ),
          )
          const id = normalizeId(args.id) || normalizeId(args.note) || ''
          detail = `承诺「${next.links[id]?.note.slice(0, 30) ?? id}」已写入（未回收 ${String(progressOf(next).openLinks.length)} 条）`
          if (args.dueAt === undefined || args.dueAt.trim() === '') {
            warnings.push('未给 dueAt：SOP 要求埋下时就写明回收章节，否则逾期无法判定')
          }
        }

        const final = (await store.read()) ?? current
        await resync(exec.agent?.session)
        const progress = progressOf(final)
        if (progress.overdueLinks.length > 0) {
          warnings.push(`有 ${String(progress.overdueLinks.length)} 条承诺已到回收章仍未回收：${progress.overdueLinks.join('、')}`)
        }
        return {
          ok: true,
          operation: args.kind,
          detail,
          ...envelope(final, warnings),
          ...(body.length > 0 ? { body } : {}),
        }
      },
    }),
  )

  // ── novel_assess ────────────────────────────────────────────────────────────

  registerScoped(ctx,
    defineTool({
      name: 'novel_assess',
      description: TOOL_SURFACE.novel_assess.summary,
      parameters: {
        operation: {
          type: 'string',
          required: true,
          enum: ['record', 'iterate', 'evaluate', 'outcome', 'history', 'rules'],
          description: 'record | iterate | evaluate | outcome | history | rules.',
        },
        period: { type: 'string', enum: ['new-book', 'paid', 'free'], description: 'record: release period.' },
        atChapter: { type: 'integer', description: 'record: chapter position the reading describes.' },
        metrics: {
          type: 'object',
          additionalProperties: true,
          description: 'record: values keyed by metric, for example {"readThrough3": 0.42, "followRead10": 0.18}.',
        },
        source: { type: 'string', description: 'record: where the numbers came from.' },
        note: { type: 'string', description: 'record/iterate/evaluate: free-form observation.' },
        baselines: {
          type: 'object',
          additionalProperties: true,
          description:
            'record/evaluate: same-genre medians to re-calibrate with, keyed by metric. Refresh them here, at the '
            + 'moment you are already reading the platform.',
        },
        baselineSource: { type: 'string', description: 'record/evaluate: where the refreshed medians came from.' },
        trigger: { type: 'string', description: 'iterate: the rule key that fired, or "manual".' },
        action: { type: 'string', description: 'iterate: what you decided to change.' },
        scope: { type: 'string', enum: ['chapter', 'volume', 'whole-book'], description: 'iterate: how far the change reaches.' },
        evidence: { type: 'string', description: 'iterate: the comparison that triggered it.' },
        baselineReadingId: { type: 'string', description: 'iterate: the reading it responds to; defaults to the latest.' },
        iterationId: { type: 'string', description: 'outcome: the adjustment to close; defaults to the most recent.' },
        outcomeReadingId: {
          type: 'string',
          description: 'outcome: the reading that judges it; defaults to the latest recorded.',
        },
        readingId: { type: 'string', description: 'evaluate: the reading to evaluate; defaults to the latest.' },
        channel: { type: 'string', description: 'evaluate: platform | readers | editor | author-group.' },
        sampleSize: { type: 'integer', description: 'evaluate: how many readers or titles the sample covers.' },
        namingId: { type: 'string', description: 'evaluate: which naming candidate was under test, if any.' },
        fallback: { type: 'string', description: 'evaluate: required when not passing — which phase to fall back to.' },
        abandonIf: { type: 'string', description: 'evaluate: required when not passing — what would make you stop.' },
        nextAtChapter: { type: 'integer', description: 'evaluate: the chapter position to evaluate again at.' },
        nextTrigger: { type: 'string', description: 'evaluate: the next appointment in words, e.g. 卷末 / 数据异常时.' },
      },
      output: { schema: ENVELOPE_SCHEMA, render: renderTool },
      execute: async (args, exec) => {
        const store = storeFor(exec.agent?.session)
        const current = await store.read()
        if (current === undefined) {
          throw new NovelInputError(`no novel project at ${store.documentPath}; call novel_init first`)
        }
        const warnings: string[] = []
        const body: string[] = []

        // Re-calibration is offered here rather than only at initialization
        // because the medians are a 30-day figure and the author is on the
        // platform at exactly this moment. Recording them at evaluation time is
        // still "before the comparison", which is all SOP principle 5 requires —
        // and it is the medians just transcribed that `evaluate` must judge
        // against, so the patch is built before any comparison runs.
        const calibrationPatch = (): Partial<MetricBaselines> | undefined => {
          if (args.baselines === undefined) return undefined
          const medians = { ...current.baselines.medians }
          for (const [key, value] of Object.entries(args.baselines)) {
            if (typeof value === 'number' && Number.isFinite(value)) Object.assign(medians, { [key]: value })
            else warnings.push(`中位 "${key}" 不是数字，已忽略`)
          }
          return {
            medians,
            calibratedAt: now(),
            ...(args.baselineSource !== undefined && { source: args.baselineSource }),
          }
        }

        const calibrationWarning = (baselines: MetricBaselines): void => {
          const age = calibrationAge(baselines, new Date())
          if (!age.stale) return
          warnings.push(
            age.days === undefined
              ? '尚未校准同类中位：阈值规则无法执行，这次只能记录不能裁决（本工具传 baselines 即可随手校准）'
              : `中位校准已 ${String(Math.round(age.days))} 天（SOP 要求近 30 天）：建议本次读数一起重新校准`,
          )
        }

        if (args.operation === 'rules') {
          const age = calibrationAge(current.baselines, new Date())
          body.push('## 当前生效的阈值')
          body.push(
            age.days === undefined
              ? '尚未校准同类中位：所有阈值不可用，请在 record/evaluate 时传 baselines，或在 novel_init 里录入'
              : `中位校准于 ${current.baselines.calibratedAt}（${String(Math.round(age.days))} 天前）${age.stale ? ' — 已超过 30 天，建议重新校准' : ''}`,
          )
          for (const metric of METRIC_KEYS) {
            const median = current.baselines.medians[metric]
            const multiplier = current.baselines.multipliers[metric] ?? DEFAULT_MULTIPLIERS[metric] ?? 0.8
            body.push(
              median === undefined
                ? `- ${metric}：未校准`
                : `- ${metric}：中位 ${String(median)} × ${String(multiplier)} = 触发线 ${String(Number((median * multiplier).toFixed(4)))}`,
            )
          }
          return {
            ok: true,
            operation: 'rules',
            detail: `已校准 ${String(Object.keys(current.baselines.medians).length)} 项指标`,
            ...envelope(current, warnings),
            body,
          }
        }

        if (args.operation === 'history') {
          const hint = evaluationHint(current)
          body.push('## 投入评估历史')
          if (current.evaluations.length === 0) {
            body.push('- 还没有做过投入评估（按需启动，不启动也不影响写作进度）')
          }
          for (const entry of current.evaluations) {
            const appointment = [
              entry.nextAtChapter > 0 ? `第 ${String(entry.nextAtChapter)} 章` : '',
              entry.nextTrigger,
            ].filter((part) => part !== '').join('，')
            body.push(
              `- 第 ${String(entry.round)} 次（${entry.at.slice(0, 10)}，${entry.channel || '未注明渠道'}）：`
              + `${verdictLabelOf(entry.verdict)} → ${evaluationActionLabel(evaluationAction(entry.verdict))}`,
            )
            if (entry.fallback !== '') body.push(`  回退目标：${entry.fallback}`)
            if (entry.abandonIf !== '') body.push(`  放弃条件：${entry.abandonIf}`)
            if (appointment !== '') body.push(`  下次评估：${appointment}`)
            if (entry.note !== '') body.push(`  备注：${entry.note}`)
          }
          const open = current.iterations.filter((iteration) => iteration.outcomeReadingId === '')
          body.push(
            '',
            `读数 ${String(current.readings.length)} 条 · 迭代 ${String(current.iterations.length)} 次`
            + `（待回填 ${String(open.length)} 次）`,
            `评估提示：${hint.due ? '建议启动一次' : '暂不需要'} — ${hint.reason}`,
          )
          return {
            ok: true,
            operation: 'history',
            detail: `投入评估 ${String(current.evaluations.length)} 次${hint.due ? `；${hint.reason}` : ''}`,
            ...envelope(current, warnings),
            body,
          }
        }

        if (args.operation === 'iterate') {
          if (args.action === undefined || args.action.trim() === '') {
            throw new NovelInputError('operation="iterate" needs the `action` you decided on')
          }
          const baselineReadingId = args.baselineReadingId ?? current.readings.at(-1)?.id ?? ''
          const id = `iteration-${String(current.iterations.length + 1)}`
          const action = args.action
          const next = await store.update(
            (state) =>
              addIteration(
                state,
                {
                  id,
                  at: now(),
                  trigger: args.trigger ?? 'manual',
                  evidence: args.evidence ?? '',
                  action,
                  scope: (args.scope ?? 'chapter') as 'chapter' | 'volume' | 'whole-book',
                  baselineReadingId,
                  outcomeReadingId: '',
                  outcome: 'unknown',
                  note: args.note ?? '',
                },
                now,
              ),
          )
          body.push(
            `基准读数：${baselineReadingId || '（无）'}`,
            '下一次 operation="evaluate" 会用当时的读数自动回填这次调整的结果。',
          )
          await resync(exec.agent?.session)
          return {
            ok: true,
            operation: 'iterate',
            detail: `迭代 ${id} 已记录：${action}（范围 ${args.scope ?? 'chapter'}）`,
            ...envelope(next, warnings),
            body,
          }
        }

        // The manual override for `evaluate`'s automatic back-fill. `evaluate`
        // closes everything open against the reading being evaluated, which is
        // the right default; this exists for the cases it cannot see — an
        // adjustment that was decided after that reading, or one whose outcome
        // is a reading the author wants to name explicitly.
        if (args.operation === 'outcome') {
          const iterationId = args.iterationId ?? current.iterations.at(-1)?.id
          if (iterationId === undefined) {
            throw new NovelInputError('还没有可结项的调整：先用 operation="iterate" 记录一次改动')
          }
          const target = current.iterations.find((iteration) => iteration.id === iterationId)
          if (target === undefined) throw new NovelInputError(`找不到调整 ${iterationId}`)
          const outcomeReadingId = args.outcomeReadingId ?? current.readings.at(-1)?.id ?? ''
          if (outcomeReadingId === '') {
            throw new NovelInputError('没有可用于结项的读数：先用 operation="record" 抄一次读数')
          }
          if (outcomeReadingId === target.baselineReadingId) {
            throw new NovelInputError(
              `读数 ${outcomeReadingId} 就是这次调整的基准读数，拿它结项等于没比较：换一个更晚的读数`,
            )
          }
          const note = args.note
          const linked = await store.update((state) => ({
            ...state,
            iterations: state.iterations.map((iteration) =>
              iteration.id === iterationId
                ? { ...iteration, outcomeReadingId, outcome: 'pending', ...(note !== undefined && { note }) }
                : iteration,
            ),
            updatedAt: now(),
          }))
          const iteration = linked.iterations.find((entry) => entry.id === iterationId)
          const judged = iteration === undefined ? undefined : judgeIteration(linked, iteration)
          const final =
            judged === undefined
              ? linked
              : await store.update((state) => ({
                  ...state,
                  iterations: state.iterations.map((entry) =>
                    entry.id === iterationId ? { ...entry, outcome: judged.improved ? 'effective' : 'ineffective' } : entry,
                  ),
                  updatedAt: now(),
                }))
          const ineffective = countIneffectiveIterations(final)
          if (ineffective >= INEFFECTIVE_ITERATIONS_FOR_CUT) {
            warnings.push(
              `已累计 ${String(ineffective)} 轮调整无效：SOP 的切书止损条件是「连续 2–3 轮无效且核心指标长期低于中位 `
              + `${String(Math.round(CUT_LOSS_MULTIPLIER * 100))}%」，请核对读数后再决定是否切书`,
            )
          }
          body.push(judged?.note ?? '缺少可比读数，未判定有效性')
          body.push('', '这次是手动结项：下一次 operation="evaluate" 只会自动回填仍未结项的调整。')
          await resync(exec.agent?.session)
          return {
            ok: true,
            operation: 'outcome',
            detail:
              judged === undefined
                ? `调整 ${iterationId} 已关联读数 ${outcomeReadingId}（尚无可比较的基准）`
                : `调整 ${iterationId} 结果：${judged.improved ? '有效' : '无效'} — ${judged.note}`,
            ...envelope(final, warnings),
            body,
          }
        }

        const values: Partial<Record<MetricKey, number>> = {}
        for (const [key, value] of Object.entries(args.metrics ?? {})) {
          if (typeof value === 'number' && Number.isFinite(value)) Object.assign(values, { [key]: value })
          else warnings.push(`指标 "${key}" 不是数字，已忽略`)
        }

        if (args.operation === 'evaluate') {
          const reading =
            args.readingId === undefined
              ? current.readings.at(-1)
              : current.readings.find((entry) => entry.id === args.readingId)
          if (reading === undefined) {
            throw new NovelInputError('没有可评估的读数；先用 operation="record" 把平台数据抄一次')
          }

          const patch = calibrationPatch()
          const baselines: MetricBaselines = patch === undefined ? current.baselines : { ...current.baselines, ...patch }
          const assessments = assessReading(reading, baselines)
          const tally = tallyAssessments(assessments)
          // SOP principle 5, enforced at the one place it can be: a reading whose
          // every metric lacks a median is not evidence, and answering "继续投入"
          // on it would be the tool inventing a verdict out of nothing.
          if (assessments.length > 0 && tally.incomparable === assessments.length) {
            throw new NovelInputError(
              '这次读数的指标都没有可比的同类中位，无法裁决：先用 baselines 校准同榜中位（SOP 原则 5：没有基线的指标不是指标），'
              + '或换用已校准的指标',
            )
          }
          const { verdict, reasons } = verdictFromAssessments(assessments)
          const action = evaluationAction(verdict)

          // The two disciplines that survive from the old phase-three gate. Both
          // are about stopping the check from becoming a formality, and neither
          // needs a number.
          if (verdict !== 'pass' && (args.fallback === undefined || args.fallback.trim() === '')) {
            throw new NovelInputError(
              `评估结论为「${verdictLabelOf(verdict)}」，必须给出 fallback（回退到哪个阶段）才能完成这次评估——`
              + 'SOP 要求不通过的评估写明回退目标，否则评估会变成走过场',
            )
          }
          if (verdict !== 'pass' && (args.abandonIf === undefined || args.abandonIf.trim() === '')) {
            throw new NovelInputError(`评估结论为「${verdictLabelOf(verdict)}」，必须给出 abandonIf（什么情况下切书止损）`)
          }
          const nextAtChapter = args.nextAtChapter ?? 0
          const nextTrigger = args.nextTrigger ?? ''
          if (nextAtChapter <= 0 && nextTrigger.trim() === '') {
            throw new NovelInputError(
              '必须留下下一次评估的约定（nextAtChapter 或 nextTrigger）——'
              + '按需评估唯一会死的方式就是没人再问，约定就是防止它悄悄变成「从不评估」',
            )
          }

          // Persist the calibration before anything else reads the state, so the
          // stored medians and the ones this verdict used cannot disagree.
          const base = patch === undefined ? current : await store.update((state) => updateBaselines(state, patch, now))
          calibrationWarning(baselines)

          // Back-fill every change that is still open, using this reading as its
          // outcome. This is what makes "连续 2–3 轮调整无效 → 切书止损"
          // decidable: an evaluation is the only moment the question is asked,
          // so it is where the previous answer is collected.
          const open = base.iterations.filter(
            (iteration) =>
              iteration.outcomeReadingId === ''
              && iteration.baselineReadingId !== reading.id
              && Date.parse(iteration.at) <= Date.parse(reading.at),
          )
          let linked = base
          if (open.length > 0) {
            linked = await store.update((state) => ({
              ...state,
              iterations: state.iterations.map((iteration) =>
                iteration.outcomeReadingId === ''
                  && iteration.baselineReadingId !== reading.id
                  && Date.parse(iteration.at) <= Date.parse(reading.at)
                  ? { ...iteration, outcomeReadingId: reading.id, outcome: 'pending' }
                  : iteration,
              ),
              updatedAt: now(),
            }))
          }
          const judged: IterationOutcome[] = []
          for (const iteration of linked.iterations) {
            if (iteration.outcomeReadingId !== reading.id) continue
            const outcome = judgeIteration(linked, iteration)
            if (outcome !== undefined) judged.push(outcome)
          }
          if (judged.length > 0) {
            linked = await store.update((state) => ({
              ...state,
              iterations: state.iterations.map((iteration) => {
                const outcome = judged.find((entry) => entry.id === iteration.id)
                return outcome === undefined
                  ? iteration
                  : { ...iteration, outcome: outcome.improved ? 'effective' : 'ineffective' }
              }),
              updatedAt: now(),
            }))
          }

          const round = linked.evaluations.length + 1
          const evaluation: Evaluation = {
            id: `evaluation-${String(round)}`,
            round,
            at: reading.at,
            channel: args.channel ?? '',
            sampleSize: args.sampleSize ?? 0,
            readingId: reading.id,
            namingId: args.namingId ?? '',
            verdict,
            reasons,
            fallback: args.fallback ?? '',
            abandonIf: args.abandonIf ?? '',
            nextAtChapter,
            nextTrigger,
            note: args.note ?? '',
          }
          const final = await store.update((state) => addEvaluation(state, evaluation, now))

          body.push(`## 第 ${String(round)} 次投入评估（${evaluation.channel || '未注明渠道'}）`)
          body.push(`读数 ${reading.id}（${reading.period}，第 ${String(reading.atChapter)} 章）`)
          for (const entry of assessments) body.push(`- ${entry.note}`)
          body.push(
            '',
            `达标 ${String(tally.passed)} · 未达标 ${String(tally.failed)} · 无法比较 ${String(tally.incomparable)}`,
            '',
            '## 裁决',
            `- ${verdictLabelOf(verdict)} → ${evaluationActionLabel(action)}`,
          )
          for (const reason of reasons) body.push(`  ${reason}`)
          if (verdict !== 'pass') {
            body.push('', `回退目标：${evaluation.fallback}`, `放弃条件：${evaluation.abandonIf}`)
          }
          if (judged.length > 0) {
            body.push('', '## 上次调整的结果（本次读数回填）')
            for (const outcome of judged) {
              body.push(`- ${outcome.id}：${outcome.improved ? '有效' : '无效'} — ${outcome.note}`)
            }
          }
          const outcomes = iterationRules(reading, assessments, final)
          if (outcomes.length > 0) {
            body.push('', '## 触发的规则与动作')
            for (const outcome of outcomes) {
              body.push(`- [${outcome.key}] ${outcome.label}`, `  动作：${outcome.action}`, `  范围：${outcome.scope}`)
              for (const evidence of outcome.evidence) body.push(`  依据：${evidence}`)
            }
            body.push('', '决定后用 operation="iterate" 把动作写入台账，下一次评估会自动回填它的结果。')
          }
          body.push(
            '',
            '## 下次评估',
            `- ${[nextAtChapter > 0 ? `第 ${String(nextAtChapter)} 章` : '', nextTrigger].filter((part) => part !== '').join('，')}`,
            '- 看板与运行时上下文会在到时提醒，但它永远不阻断写作。',
          )

          const ineffective = countIneffectiveIterations(final)
          if (ineffective >= INEFFECTIVE_ITERATIONS_FOR_CUT) {
            warnings.push(
              `已累计 ${String(ineffective)} 轮调整无效：SOP 的切书止损条件是「连续 2–3 轮无效且核心指标长期低于中位 `
              + `${String(Math.round(CUT_LOSS_MULTIPLIER * 100))}%」，请核对读数后再决定是否切书`,
            )
          }
          // Evaluating is where an appointment is made or changed, so it is where
          // the durable reminder is armed to the appointment just recorded.
          await syncReminder(final, exec, body, warnings)
          await resync(exec.agent?.session)
          return {
            ok: true,
            operation: 'evaluate',
            detail: `第 ${String(round)} 次投入评估：${verdictLabelOf(verdict)} → ${evaluationActionLabel(action)}`,
            ...envelope(final, warnings),
            body,
          }
        }

        if (Object.keys(values).length === 0) {
          throw new NovelInputError('operation="record" needs at least one numeric metric value in `metrics`')
        }
        const reading = {
          id: `reading-${String(current.readings.length + 1)}`,
          at: now(),
          period: (args.period ?? 'new-book') as MetricPeriod,
          atChapter: args.atChapter ?? 0,
          values,
          source: args.source ?? '',
          note: args.note ?? '',
        }
        const patch = calibrationPatch()
        const next = await store.update((state) =>
          addReading(patch === undefined ? state : updateBaselines(state, patch, now), reading, now),
        )
        calibrationWarning(next.baselines)
        const assessments = assessReading(reading, next.baselines)
        const tally = tallyAssessments(assessments)
        const outcomes = iterationRules(reading, assessments, next)
        const hint = evaluationHint(next)

        body.push(`## 读数 ${reading.id}（${reading.period}，第 ${String(reading.atChapter)} 章）`)
        for (const entry of assessments) body.push(`- ${entry.note}`)
        body.push('', `达标 ${String(tally.passed)} · 未达标 ${String(tally.failed)} · 无法比较 ${String(tally.incomparable)}`)
        if (outcomes.length > 0) {
          body.push('', '## 触发的规则与动作（尚未裁决）')
          for (const outcome of outcomes) {
            body.push(`- [${outcome.key}] ${outcome.label}`, `  动作：${outcome.action}`, `  范围：${outcome.scope}`)
            for (const evidence of outcome.evidence) body.push(`  依据：${evidence}`)
          }
        }
        const open = next.iterations.filter((iteration) => iteration.outcomeReadingId === '')
        if (open.length > 0) {
          body.push('', `待回填的调整：${open.map((iteration) => iteration.id).join('、')}（下一次 evaluate 自动回填）`)
        }
        body.push(
          '',
          '读数只是数据。要一份「还值不值得写下去」的裁决，调用 operation="evaluate" —— 它不会自动发生。',
          `评估提示：${hint.due ? '建议启动一次' : '暂不需要'} — ${hint.reason}`,
        )
        await syncReminder(next, exec, body, warnings)
        await resync(exec.agent?.session)
        return {
          ok: true,
          operation: 'record',
          detail: `读数 ${reading.id} 已记录：达标 ${String(tally.passed)}，未达标 ${String(tally.failed)}（裁决需 operation="evaluate"）`,
          ...envelope(next, warnings),
          body,
        }
      },
    }),
  )

  // ── novel_write ─────────────────────────────────────────────────────────────

  registerScoped(ctx,
    defineTool({
      name: 'novel_write',
      description: TOOL_SURFACE.novel_write.summary,
      parameters: {
        operation: { type: 'string', enum: ['write', 'read', 'check'], description: 'write (default) | read | check.' },
        chapterId: { type: 'string', required: true, description: 'Id, slug, or title of the chapter.' },
        body: { type: 'string', description: 'write: the complete chapter prose.' },
        delivered: {
          type: 'array',
          items: { type: 'string', enum: [...CONTRACT_FIELDS] },
          description: 'write: the contract fields this draft reached.',
        },
        status: { type: 'string', enum: [...CHAPTER_STATUSES], description: 'write: planned | drafting | revised | final.' },
        title: { type: 'string', description: 'write: replace the chapter title.' },
      },
      output: { schema: ENVELOPE_SCHEMA, render: renderTool },
      execute: async (args, exec) => {
        const store = storeFor(exec.agent?.session)
        const current = await store.read()
        if (current === undefined) {
          throw new NovelInputError(`no novel project at ${store.documentPath}; call novel_init first`)
        }
        const chapter = resolveChapter(current, args.chapterId)
        const warnings: string[] = []
        const body: string[] = []
        const operation = args.operation ?? 'write'

        if (operation === 'read') {
          body.push(`## 第 ${String(chapter.number)} 章「${chapter.title || chapter.id}」`)
          for (const row of contractRows(chapter)) body.push(`- ${row.field}：${row.text || '（未写）'}`)
          body.push('', chapter.body.trim() === '' ? '（尚无正文）' : chapter.body)
          return {
            ok: false,
            operation: 'read',
            detail: `第 ${String(chapter.number)} 章：${String(chapter.wordCount)} 字，${chapter.status}`,
            ...envelope(current),
            body,
          }
        }

        if (operation === 'check') {
          const report = analyzeDelivery(chapter)
          body.push(`## 契约兑现（第 ${String(chapter.number)} 章）`)
          for (const field of report.fields) {
            body.push(
              `- ${field.field}：计划=${field.plannedAtAll ? '有' : '无'} 兑现=${field.delivered ? '是' : '否'}`
                + `${field.waived === undefined ? '' : `（已放弃：${field.waived}）`}`,
            )
          }
          body.push('', report.summary)
          pushLengthReport(body, chapter)
          pushStyleHints(body, chapter.body, current.outline.style.taboos)
          return {
            ok: report.missed.length === 0,
            operation: 'check',
            detail: report.summary,
            ...envelope(current, report.missed.length > 0 ? [`未兑现：${report.missed.join('、')}`] : []),
            body,
          }
        }

        if (args.body === undefined) throw new NovelInputError('operation="write" needs the complete chapter text in `body`')
        const text = args.body

        // The one hard gate in the pipeline. Everywhere else the SOP reports a
        // disagreement and lets the call stand; here it refuses, because the
        // failure it prevents is the one no later soft warning can undo — a book
        // whose setup and voice the author was never asked about.
        const gate = proseGate(current, chapter.number)
        if (!gate.allowed) {
          throw new NovelInputError(
            `novel_write refused: ${gate.reasons.join('；')}。`
            + `下一步：${gate.next.join('，然后 ')}。`,
          )
        }

        const next = await store.update(
          (state) =>
            upsertChapter(
              state,
              {
                id: chapter.id,
                body: text,
                ...(args.title !== undefined && { title: args.title }),
                ...(args.status !== undefined && { status: args.status }),
                ...(args.delivered !== undefined && {
                  delivered: args.delivered as NovelState['chapters'][string]['delivered'],
                }),
              },
              now,
            ),
        )
        const written = next.chapters[chapter.id]
        if (written === undefined) throw new NovelInputError(`chapter ${chapter.id} vanished during the write`)
        const report = analyzeDelivery(written)

        body.push(`## 第 ${String(written.number)} 章「${written.title || written.id}」`, report.summary)
        if (report.missed.length > 0) {
          body.push('', '未兑现的计划项（正文没写到，或 delivered 没报）：')
          for (const field of report.missed) {
            body.push(`- ${field}：${report.fields.find((entry) => entry.field === field)?.planned ?? ''}`)
          }
        }
        if (report.unplanned.length > 0) body.push('', `细纲本身没写：${report.unplanned.join('、')}`)
        pushLengthReport(body, written)
        pushStyleHints(body, written.body, next.outline.style.taboos)
        if (args.status === 'final') {
          const blockers = blockersToFinal(written)
          if (blockers.length > 0) {
            body.push('', '## 发布前检查（未阻止标记为 final）')
            for (const blocker of blockers) body.push(`- ${blocker}`)
            warnings.push(`标记 final 但存在未完成项：${blockers.join('；')}`)
          }
          body.push('', '## 合规自查（人工确认，工具不代替阅读）')
          for (const item of complianceChecklist(written)) body.push(`- [ ] ${item.key}：${item.item}`)
        }
        if (report.missed.length > 0) {
          warnings.push(`本次未兑现 ${String(report.missed.length)} 项契约：${report.missed.join('、')}`)
        }
        // Writing a chapter can push a promise past its due chapter; the SOP
        // closes promises at volume end, so the writer learns about it now.
        const overdue = progressOf(next).overdueLinks
        if (overdue.length > 0) {
          warnings.push(
            `有 ${String(overdue.length)} 条 promise 已到回收章仍未回收：${overdue.join('、')}`
            + '（novel_bible kind="link" status="paid" 回收，或调整 dueAt）',
          )
        }

        // A chapter is what makes the investment question live, so the durable
        // reminder is synced here rather than waiting for an evaluation that may
        // never be run.
        await syncReminder(next, exec, body, warnings)
        await resync(exec.agent?.session)
        return {
          ok: true,
          operation: 'write',
          detail: `第 ${String(written.number)} 章已写入：${String(written.wordCount)} 字，${written.status}`,
          ...envelope(next, warnings),
          body,
        }
      },
    }),
  )

  // ── novel_status ────────────────────────────────────────────────────────────

  registerScoped(ctx,
    defineTool({
      name: 'novel_status',
      description: TOOL_SURFACE.novel_status.summary,
      parameters: {
        detail: {
          type: 'string',
          enum: ['dashboard', 'bible', 'plan', 'chapter'],
          description: 'dashboard (default) | bible | plan | chapter.',
        },
        chapterId: { type: 'string', description: 'detail="chapter": the chapter to return.' },
      },
      output: { schema: ENVELOPE_SCHEMA, render: renderTool },
      execute: async (args, exec) => {
        const store = storeFor(exec.agent?.session)
        const state = await store.read()
        const detected = await projects.verdictFor(exec.agent?.session)
        if (state === undefined) {
          throw new NovelInputError(`no novel project at ${store.documentPath}; call novel_init first`)
        }
        const body: string[] = []
        const detail = args.detail ?? 'dashboard'

        if (detail === 'bible') {
          // Tiered, because the answer to "who is in this book" is three
          // different answers, and a flat list buries the protagonist among the
          // walk-ons. Within a tier the cast reads in id order.
          const cast = Object.values(state.characters).sort((a, b) => a.id.localeCompare(b.id, 'zh-Hans-CN'))
          body.push('## 人物')
          for (const scope of CHARACTER_SCOPES) {
            const group = cast.filter((character) => characterScope(character) === scope)
            if (group.length === 0) continue
            body.push(`### ${SCOPE_LABELS[scope]}（${String(group.length)}）`)
            for (const character of group) {
              if (scope === 'cameo') {
                // A walk-on's whole record is: who they are and where they were seen.
                const where = character.volume > 0 ? `第 ${String(character.volume)} 卷` : ''
                const first = character.firstAppearance || '（未记首次出场章）'
                body.push(
                  `- ${character.name}（${character.id}）${[where, first].filter((part) => part !== '').join(' · ')}`
                  + `${character.description === '' ? '' : `：${character.description}`}`
                  + `${character.exit === '' ? '' : `［${character.exit}］`}`,
                )
                continue
              }
              body.push(`- ${character.name}（${character.id}，${character.role || '角色'}）：${character.goal || '（无目标）'}`)
              body.push(`  性格：${character.personality || '（未写——人物不够丰满的常见原因）'}`)
              body.push(`  说话方式：${character.voice || '（未写）'}`)
              if (character.obsession !== '') body.push(`  执念：${character.obsession}`)
              if (character.weakness !== '') body.push(`  软肋：${character.weakness}`)
              if (character.exit !== '') body.push(`  退场：${character.exit}`)
            }
          }
          // The lookup the walk-on register exists for: opening a chapter inside a
          // map you have used before. The volume is taken from the character's own
          // key, or derived from the chapter they first appeared in.
          const byVolume = new Map<number, string[]>()
          for (const character of cast) {
            const volume = character.volume > 0 ? character.volume : volumeOfFirstAppearance(state, character.firstAppearance)
            if (volume <= 0) continue
            byVolume.set(volume, [...(byVolume.get(volume) ?? []), character.name])
          }
          if (byVolume.size > 0) {
            body.push('', '## 按卷/地图查人')
            for (const volume of [...byVolume.keys()].sort((a, b) => a - b)) {
              body.push(`- 第 ${String(volume)} 卷：${(byVolume.get(volume) ?? []).join('、')}`)
            }
          }
          body.push('', '## 世界设定')
          for (const entry of Object.values(state.world)) {
            body.push(`- [${entry.kind}] ${entry.name}（${entry.id}）：${entry.detail}`)
            if (entry.cost !== '') body.push(`  代价：${entry.cost}`)
            if (entry.limits !== '') body.push(`  限制：${entry.limits}`)
          }
          body.push('', '## 承诺（伏笔/悬念）')
          for (const link of Object.values(state.links)) {
            body.push(`- [${link.status}] ${link.id}：${link.note}（埋 ${link.plantedAt || '—'} → 收 ${link.dueAt || '—'}）`)
          }
        } else if (detail === 'plan') {
          const standing = confirmationStanding(state)
          body.push(
            '## 设定分层确认（按顺序）',
            ...standing.layers.map((layer) =>
              `- ${layer.confirmed ? '[x]' : layer.ready ? '[ ] ← 现在这一层' : '[ ]'} ${layer.label}`
              + `（novel_confirm kind="${layer.kind}"）：`
              + (layer.confirmed
                ? '已确认'
                : `未确认，${String(layer.rounds)}/${String(layer.roundsRequired)} 轮`)
              + (layer.gatesProse ? '｜关掉它才能写正文' : ''),
            ),
            `- 文风复核（novel_confirm kind="style"）：${standing.styleConfirmed
              ? `已确认：${standing.style?.summary ?? ''}`
              : `未复核（黄金三章即第 1–${String(GOLDEN_CHAPTERS)} 章成稿后复核）`}`,
            `- 写作风格（全书大纲七要素）：${
              outlineStyleGaps(state.outline).length === 0
                ? '已写全'
                : `缺 ${outlineStyleGaps(state.outline).map((gap) => SPINE_LABELS[gap.key]).join('、')}（novel_plan operation="outline"）——未写全时 novel_write 拒绝写正文`
            }`,
            '',
            '## 内容文件',
            ...contentFileLines(state),
            '',
            '## 篇幅（初始化四问）',
            describeWritingPlan(state.writing),
          )
          for (const gap of writingPlanGaps(state.writing)) {
            body.push(`- 未问用户：${gap.requirement}（${gap.fill}）`)
          }
          body.push(
            '',
            '## 立意',
            state.pitch.memorablePoint || '（未写）',
            `情绪：${state.pitch.coreEmotion || '—'}`,
            `内核：${state.pitch.kernel || '—'}`,
            '',
            '## 大纲',
            `一句话：${state.outline.logline || '—'}`,
            `最小可行：${state.outline.minimal || '—'}`,
            '',
            // Narrative completeness comes before the beats and the volumes: the
            // dashboard should show the story's own debts first, because every
            // other plan layer hangs off them.
            '## 叙事完整性（全书）',
            ...narrativeReport(OUTLINE_SPINE_PARTS, outlineSpineValues(state.outline)),
          )
          const payoffNotes = outlinePayoffGaps(state.outline)
          if (payoffNotes.length > 0) body.push('', '## 爽点与爆点欠账', ...payoffNotes.map((note) => `- ${note}`))
          if (state.outline.acts.length > 0) {
            body.push('', '三幕：', ...state.outline.acts.map((act, index) => `${String(index + 1)}. ${act}`))
          }
          body.push('', '## 分卷')
          for (const volume of state.outline.volumes) {
            const gaps = volumeSpineGaps(volume)
            body.push(
              `- 第 ${String(volume.number)} 卷「${volume.title || '—'}」目标=${volume.goal || '—'} 高潮=${volume.climax || '—'} 卷末钩子=${volume.endHook || '—'}`,
            )
            body.push(
              gaps.length === 0
                ? '  - 叙事骨架：完整（梗概/主角/反派/阵营/对抗/得失）'
                : `  - 叙事骨架缺 ${String(gaps.length)} 项：${gaps.map((gap) => gap.key).join('、')}`,
            )
          }
          body.push('', '## 节拍表')
          for (const beat of state.outline.beats) body.push(`- 第 ${String(beat.chapter)} 章 [${beat.kind}] ${beat.note}`)
          body.push('', '## 开篇工程清单')
          for (const check of state.outline.opening) body.push(`- [${check.done ? 'x' : ' '}] ${check.requirement}`)
          body.push('', '## 候选物料')
          for (const candidate of state.naming) {
            body.push(`- ${candidate.active ? '★' : ' '} ${candidate.title || '（无题）'} — ${candidate.blurb.slice(0, 40)}`)
          }
        } else if (detail === 'chapter') {
          const chapter = resolveChapter(state, args.chapterId)
          body.push(`## 第 ${String(chapter.number)} 章「${chapter.title || chapter.id}」（${chapter.status}）`)
          for (const row of contractRows(chapter)) body.push(`- ${row.field}：${row.text || '（未写）'}`)
          body.push('', analyzeDelivery(chapter).summary)
          pushLengthReport(body, chapter)
          pushStyleHints(body, chapter.body, state.outline.style.taboos)
          body.push('', chapter.body.trim() === '' ? '（尚无正文）' : chapter.body)
        } else {
          const progress = progressOf(state)
          const chapters = Object.values(state.chapters).sort((a, b) => a.number - b.number)
          const standing = confirmationStanding(state)
          body.push(
            '## 设定分层确认（按顺序）',
            ...standing.layers.map((layer) =>
              `- ${layer.confirmed ? '[x]' : layer.ready ? '[ ] ← 现在这一层' : '[ ]'} ${layer.label}：`
              + (layer.confirmed
                ? `已确认（${String(layer.rounds)} 轮，novel_confirm kind="${layer.kind}"）`
                : `未确认（已讨论 ${String(layer.rounds)}/${String(layer.roundsRequired)} 轮，novel_confirm kind="${layer.kind}"）`),
            ),
            `- 去 AI 化诊断：${standing.deAi.done
              ? `已做过（最近一次 ${standing.deAi.at.slice(0, 10)}，审 ${standing.deAi.target}）`
                + (standing.deAi.unreviewed.length === 0
                  ? '，黄金三章逐章覆盖'
                  : `；黄金三章里第 ${standing.deAi.unreviewed.map((number) => String(number)).join('、')} 章还没查过`)
              : standing.deAi.due
                ? '未做过——黄金三章已成稿，先 novel_review operation="ai-flavor" 逐章诊断，未做过前 novel_write 拒绝写第 '
                  + `${String(GOLDEN_CHAPTERS + 1)} 章`
                : `未到期（第 1–${String(GOLDEN_CHAPTERS)} 章成稿后逐章诊断）`}`,
            `- 文风复核：${standing.styleConfirmed
              ? `已确认（${standing.style?.at.slice(0, 10) ?? ''}）`
              : styleGateReached(state)
                ? `待复核（黄金三章已成稿，novel_confirm kind="style"）`
                : `未到期（第 1–${String(GOLDEN_CHAPTERS)} 章成稿后复核）`}`,
            '',
          )
          // The story's own debts, before the chapter stats: if the outline
          // cannot say what happens, no chapter count makes the project ready.
          const spineGaps = outlineSpineGaps(state.outline)
          const styleGaps = outlineStyleGaps(state.outline)
          const thinCast = castDebt(state)
          const cameos = Object.values(state.characters).filter((character) => characterScope(character) === 'cameo')
          const volumeGaps = state.outline.volumes.map((volume) => ({ volume, gaps: volumeSpineGaps(volume) }))
          const volumeDebt = volumeGaps.reduce((total, entry) => total + entry.gaps.length, 0)
          body.push(
            '## 叙事完整性',
            spineGaps.length === 0 && volumeDebt === 0
              ? '- 全书大纲与分卷大纲的叙事骨架都已写全'
              : `- 全书大纲缺 ${String(spineGaps.length)}/8 项`
                + `${spineGaps.length > 0 ? `：${spineGaps.map((gap) => gap.key).join('、')}` : ''}`
                + `；分卷大纲共缺 ${String(volumeDebt)} 项`
                + `（明细：novel_status detail="plan"）`,
            styleGaps.length === 0
              ? '- 写作风格（全书大纲七要素）：已写全'
              : `- 写作风格缺 ${String(styleGaps.length)}/7 项：${styleGaps.map((gap) => SPINE_LABELS[gap.key]).join('、')}`
                + '（novel_plan operation="outline"）——未写全时 novel_write 拒绝写正文',
            (thinCast.length === 0
              ? '- 人物丰满度：主要角色与配角都有性格与说话方式'
              : `- 人物不够丰满 ${String(thinCast.length)} 位：`
                + thinCast.map((gap) => `${gap.name}（缺 ${gap.missing.map((field) => CAST_FIELD_LABELS[field] ?? field).join('、')}）`).join('；')
                + '（novel_bible kind="review"）')
              + (cameos.length > 0 ? `；另有 ${String(cameos.length)} 位路人已登记（不计欠账）` : ''),
            '',
          )
          body.push(
            '## 章节',
            `共 ${String(progress.chapters)} 章 / ${String(progress.totalWords)} 字（已写 ${String(progress.chapters - progress.emptyChapters.length)}，`
              + `库存 ${String(progress.stockChapters)}/${String(state.writing.stockTargetChapters)}）`,
            `细纲完整 ${String(progress.contractedChapters)} 章 · 契约兑现 ${String(progress.deliveredChapters)} 章`,
          )
          if (progress.numberingIssues.length > 0) body.push(`章号异常：${progress.numberingIssues.join('、')}`)
          for (const chapter of chapters.slice(0, 30)) {
            const missing = missingContract(chapter)
            const draft = draftTargetWords(chapter.targetWords)
            body.push(
              `${String(chapter.number).padStart(3, ' ')}. [${chapter.status}] ${chapter.title || chapter.id}`
                + ` ${String(chapter.wordCount)} 字${chapter.targetWords > 0 ? `/${String(chapter.targetWords)}` : ''}`
                + `${draft > 0 ? `（初稿 ${String(draft)}）` : ''}`
                + `${missing.length > 0 ? ` ⚠缺${missing.join('/')}` : ''}`,
            )
          }
          if (chapters.length > 30) body.push(`… 另有 ${String(chapters.length - 30)} 章`)
          body.push('', '## 承诺', `未回收 ${String(progress.openLinks.length)} 条，逾期 ${String(progress.overdueLinks.length)} 条`)
          for (const id of progress.overdueLinks) {
            const link = state.links[id]
            if (link !== undefined) body.push(`- 逾期：${link.note}（应回收于 ${link.dueAt}）`)
          }
          // The data side of the project, reported on its own axis. It is never
          // a phase and never a blocker: `evaluationDue` is advice, and the
          // reading under it is just the last number anyone transcribed.
          const hint = evaluationHint(state)
          body.push('', '## 投入评估（按需，不阻断进度）')
          body.push(`- ${hint.due ? '建议启动一次' : '暂不需要'}：${hint.reason}`)
          const lastEvaluation = state.evaluations.at(-1)
          if (lastEvaluation === undefined) {
            body.push('- 还没有评估过；平台有数据时用 novel_assess 抄录后 evaluate')
          } else {
            const appointment = [
              lastEvaluation.nextAtChapter > 0 ? `第 ${String(lastEvaluation.nextAtChapter)} 章` : '',
              lastEvaluation.nextTrigger,
            ].filter((part) => part !== '').join('，')
            body.push(
              `- 上次评估：第 ${String(lastEvaluation.round)} 次（${lastEvaluation.at.slice(0, 10)}）`
              + ` ${verdictLabelOf(lastEvaluation.verdict)} → ${evaluationActionLabel(evaluationAction(lastEvaluation.verdict))}`,
            )
            if (appointment !== '') body.push(`  下次评估约定：${appointment}`)
          }
          const latest = state.readings.at(-1)
          if (latest === undefined) {
            body.push('- 还没有读数（novel_assess operation="record" 录入）')
          } else {
            body.push(`- 最近读数：${latest.id}（${latest.period}，第 ${String(latest.atChapter)} 章）`)
            for (const entry of assessReading(latest, state.baselines)) body.push(`  ${entry.note}`)
          }
          const openIterations = state.iterations.filter((iteration) => iteration.outcomeReadingId === '')
          if (openIterations.length > 0) {
            body.push('', `## 待回填的调整（${String(openIterations.length)}）`)
            body.push('下一次 novel_assess operation="evaluate" 会用当时的读数自动回填结果。')
            for (const iteration of openIterations) body.push(`- ${iteration.id}：${iteration.action}（${iteration.scope}）`)
          }
          // A launch decision that is not `go` is a standing instruction, so the
          // dashboard repeats its fallback and abandon condition: the SOP
          // checkpoint is precisely "did the decision say where to go back to".
          const lastDecision = state.launchDecisions.at(-1)
          if (lastDecision !== undefined && lastDecision.verdict !== 'go') {
            body.push(
              '',
              `## 未通过的上线决策（${lastDecision.id}）`,
              `- ${lastDecision.verdict === 'abandon' ? '放弃该概念' : '改后再说'}`,
            )
            if (lastDecision.fallback !== '') body.push(`  回退目标：${lastDecision.fallback}`)
            if (lastDecision.abandonIf !== '') body.push(`  放弃条件：${lastDecision.abandonIf}`)
          }
          // Reviews are model judgements, not ledger facts, so the dashboard
          // reports them as a separate line: something to re-read, never
          // something a threshold acts on.
          if (state.reviews.length > 0) {
            const last = state.reviews.at(-1)
            body.push(
              '',
              `## 模型评审（${String(state.reviews.length)} 次）`,
              last === undefined
                ? '—'
                : `最近：${last.kind}（${last.target || '项目'}）@ ${last.model}，${String(last.findings.length)} 条问题 · ${last.id}`,
            )
            if (last !== undefined && last.findings.length > 0) {
              body.push(...last.findings.slice(0, 3).map((finding) => `- [${finding.severity}] ${finding.dimension}：${finding.fix}`))
            }
          }
          body.push('', `工作区判定：${detected?.kind ?? 'unknown'}（${detected?.reason ?? '—'}）`)
          // Where the novel actually lives, because since the split a human is
          // expected to open these files in their own editor. Reported, never
          // prescribed: the files win over anything in memory.
          const index = state.index
          if (index !== undefined) {
            body.push(
              '',
              '## 内容文件（可直接编辑；文件为准）',
              `- 元数据与索引：${NOVEL_RELATIVE_PATH}`,
              ...contentFileLines(state),
            )
            for (const chapter of Object.values(state.chapters).sort((a, b) => a.number - b.number)) {
              const ref = index.chapters[chapter.id]
              if (ref === undefined) continue
              body.push(`- 第 ${String(chapter.number)} 章：${ref.bodyFile} · 细纲 ${ref.outlineFile}`)
            }
          }
        }

        return {
          ok: true,
          operation: detail,
          detail: `${state.meta.title || '(untitled)'} · ${stageLabel(assessStage(state).stage)} · ${String(progressOf(state).totalWords)} 字`,
          ...envelope(state),
          body,
        }
      },
    }),
  )

  // ── novel_repo ──────────────────────────────────────────────────────────────

  registerScoped(ctx,
    defineTool({
      name: 'novel_repo',
      description: TOOL_SURFACE.novel_repo.summary,
      parameters: {
        operation: {
          type: 'string',
          required: true,
          enum: ['export', 'retro', 'asset', 'lesson', 'template'],
          description: 'export | retro | asset | lesson | template.',
        },
        path: { type: 'string', description: 'export/template: destination relative to the workspace root.' },
        includeContract: { type: 'boolean', description: 'export: include each chapter\'s task and hook as a blockquote.' },
        dataSummary: { type: 'string', description: 'retro: override the derived completion summary.' },
        highlights: { type: 'array', items: { type: 'string' }, description: 'retro: what worked.' },
        problems: { type: 'array', items: { type: 'string' }, description: 'retro: what failed.' },
        statement: { type: 'string', description: 'lesson: the lesson in one line.' },
        lessonKind: { type: 'string', enum: ['reuse', 'avoid'], description: 'lesson: reuse | avoid.' },
        area: { type: 'string', description: 'lesson: opening | rhythm | character | …' },
        evidence: { type: 'string', description: 'lesson: the evidence behind it.' },
        assetKind: { type: 'string', description: 'asset: character | setting | scene | quote | relationship | link.' },
        label: { type: 'string', description: 'asset: display label.' },
        content: { type: 'string', description: 'asset: the asset itself.' },
        source: { type: 'string', description: 'asset: which chapter it came from.' },
      },
      output: { schema: ENVELOPE_SCHEMA, render: renderTool },
      execute: async (args, exec) => {
        const store = storeFor(exec.agent?.session)
        const current = await store.read()
        if (current === undefined) {
          throw new NovelInputError(`no novel project at ${store.documentPath}; call novel_init first`)
        }
        const warnings: string[] = []
        const body: string[] = []

        if (args.operation === 'export') {
          const chapters = Object.values(current.chapters)
          if (chapters.length === 0) throw new NovelInputError('还没有章节可导出，先用 novel_plan 与 novel_write')
          const destination = args.path ?? DEFAULT_MANUSCRIPT_PATH
          const path = await store.writeDerived(
            destination,
            renderManuscript(current, { includeContract: args.includeContract ?? false }),
          )
          const words = chapters.reduce((total, chapter) => total + chapter.wordCount, 0)
          body.push(`导出 ${String(chapters.length)} 章 / ${String(words)} 字到 ${path}`)
          return {
            ok: true,
            operation: 'export',
            detail: `成稿已导出：${path}`,
            ...envelope(current, warnings),
            body,
          }
        }

        if (args.operation === 'retro') {
          const retro = buildRetrospective(
            current,
            { dataSummary: args.dataSummary, highlights: args.highlights, problems: args.problems },
            now,
          )
          const next = await store.update((state) => ({ ...state, retro, updatedAt: now() }))
          body.push('## 完本数据', retro.dataSummary)
          if (retro.highlights.length > 0) body.push('', '## 亮点', ...retro.highlights.map((item) => `- ${item}`))
          if (retro.problems.length > 0) body.push('', '## 问题', ...retro.problems.map((item) => `- ${item}`))
          body.push('', `已归档 IP 素材 ${String(retro.assets.length)} 项，导出结构模板「${retro.templates[0]?.name ?? '—'}」`)
          body.push('', '## 待补的复盘问题（工具不替你回答）', ...lessonPrompts().map((prompt) => `- ${prompt}`))
          // Completing the book is what retires the reminder: there is no longer
          // an investment decision left to prompt.
          await syncReminder(next, exec, body, warnings)
          await resync(exec.agent?.session)
          return {
            ok: true,
            operation: 'retro',
            detail: `复盘已写入（素材 ${String(retro.assets.length)} 项，模板 ${String(retro.templates.length)} 个）`,
            ...envelope(next, warnings),
            body,
          }
        }

        if (args.operation === 'lesson') {
          if (args.statement === undefined || args.statement.trim() === '') {
            throw new NovelInputError('operation="lesson" needs the lesson `statement`')
          }
          const statement = args.statement
          const kind = args.lessonKind === 'avoid' ? ('avoid' as const) : ('reuse' as const)
          const next = await store.update((state) => {
            const retro = state.retro ?? buildRetrospective(state, {}, now)
            const lesson = {
              id: normalizeId(statement) || `lesson-${String(retro.lessons.length + 1)}`,
              kind,
              statement,
              evidence: args.evidence ?? '',
              area: args.area ?? '',
            }
            return {
              ...state,
              retro: { ...retro, lessons: [...retro.lessons.filter((entry) => entry.id !== lesson.id), lesson] },
              updatedAt: now(),
            }
          })
          return {
            ok: true,
            operation: 'lesson',
            detail: `已记录${kind === 'avoid' ? '避雷' : '复用'}经验（共 ${String(next.retro?.lessons.length ?? 0)} 条）`,
            ...envelope(next, warnings),
            body,
          }
        }

        if (args.operation === 'asset') {
          if (args.label === undefined || args.label.trim() === '') {
            throw new NovelInputError('operation="asset" needs a `label`')
          }
          const label = args.label
          const next = await store.update((state) => {
            const retro = state.retro ?? buildRetrospective(state, {}, now)
            const asset = {
              id: normalizeId(label) || `asset-${String(retro.assets.length + 1)}`,
              kind: args.assetKind ?? 'scene',
              label,
              content: args.content ?? '',
              source: args.source ?? '',
            }
            return {
              ...state,
              retro: { ...retro, assets: [...retro.assets.filter((entry) => entry.id !== asset.id), asset] },
              updatedAt: now(),
            }
          })
          return {
            ok: true,
            operation: 'asset',
            detail: `已归档素材「${label}」（共 ${String(next.retro?.assets.length ?? 0)} 项）`,
            ...envelope(next, warnings),
            body,
          }
        }

        const template = buildTemplate(current, now)
        const fileName = `${normalizeId(template.name) || 'template'}.json`
        const destination = args.path ?? `${DEFAULT_TEMPLATE_PATH}/${fileName}`
        const path = await store.writeDerived(destination, `${JSON.stringify(template, null, 2)}\n`)
        body.push(
          `模板已导出：${path}`,
          '',
          `结构骨架：三幕 ${String(template.acts.length)} 条，分卷节奏 ${String(template.volumeRhythm.length)} 条，节拍 ${String(template.beatPattern.length)} 条`,
          `钩子模式：${template.hookPatterns.join('、') || '（未识别）'}`,
          '',
          template.note,
        )
        if (current.retro === undefined) {
          warnings.push('尚未写复盘（operation="retro"）：模板已导出，但经验教训未归档')
        }
        return {
          ok: true,
          operation: 'template',
          detail: `结构模板已导出：${path}`,
          ...envelope(current, warnings),
          body,
        }
      },
    }),
  )
}

/**
 * Token accounting as a warning suffix, when the provider reported any.
 *
 * A truncated answer is only actionable if the author can see how the budget was
 * spent: reasoning tokens and answer tokens share one ceiling, and an answer cut
 * off after a long think is a different problem from an answer cut off mid-JSON.
 *
 * @param usage - token accounting from the review call.
 * @returns `，输出 N tokens（推理 M）`, or an empty string without usage.
 */
function tokenSpend(usage: TokenUsage | undefined): string {
  if (usage === undefined) return ''
  const reasoning = usage.reasoningTokens === undefined ? '' : `（推理 ${String(usage.reasoningTokens)}）`
  return `，输出 ${String(usage.outputTokens)} tokens${reasoning}`
}

/**
 * Register `novel_review`: the one tool that asks a model instead of computing.
 *
 * It is registered separately from {@link registerTools} because it depends on a
 * service the rest of the composer does not: without `llm` mounted there is
 * nothing to review *with*, and a tool that can only fail is worse than an
 * absent one. The nine deterministic tools therefore stay unconditional, and
 * this one appears exactly where a model route exists.
 *
 * What it will not do is as much of the contract as what it does: it never
 * writes a chapter, never overwrites published prose, and never lets a model
 * judgement into `iterations`, `evaluations` or `launchDecisions` — the ledger
 * entries that the SOP's thresholds act on. A review is recorded as a review,
 * with the model and the rubric version that produced it.
 *
 * @param ctx - plugin context carrying the tool registry and a model route.
 * @param projects - resolves the novel store per calling session.
 * @param settings - configured review route, timeout, output budget and reasoning effort.
 */
export function registerReviewTool(ctx: Context, projects: ProjectResolver, settings: ReviewSettings): void {
  const storeFor = (session: { readonly header: { readonly cwd?: string } } | undefined): SessionStore =>
    projects.storeForSession(session)
  const now: Clock = () => new Date().toISOString()

  registerScoped(ctx,
    defineTool({
      name: 'novel_review',
      description: TOOL_SURFACE.novel_review.summary,
      parameters: {
        operation: {
          type: 'string',
          required: true,
          enum: [...REVIEW_KINDS],
          description: 'ai-flavor | opening | competitor | retro.',
        },
        chapterId: { type: 'string', description: 'ai-flavor: the chapter to diagnose.' },
        focus: {
          type: 'array',
          items: { type: 'string' },
          description: 'ai-flavor: limit the rubric to these dimensions, for example ["翻译腔", "整齐句式"].',
        },
        rewrite: {
          type: 'boolean',
          description: 'ai-flavor: also produce a rewritten draft (a second model call; the file is a proposal only).',
        },
        title: { type: 'string', description: 'competitor: the competitor\'s title.' },
        text: {
          type: 'string',
          description: 'competitor: the competitor material to dismantle — blurb, opening chapters, or both.',
        },
        targets: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description:
            'competitor: several competitors to dismantle in one call, each an object { title, text }. Every entry '
            + 'becomes its own child agent, run in parallel wherever the profile registers a subagent provider and '
            + 'sequentially where it does not; either way the results are merged and saved together. This is the SOP\'s '
            + '20–50-title study in one call instead of fifty. Overrides `title`/`text`.',
        },
        save: {
          type: 'boolean',
          description:
            'competitor/retro: write the structured result into the project (competitors / retro lessons). Default false, '
            + 'so a model draft never enters the ledger unreviewed.',
        },
        maxChapters: { type: 'integer', description: 'opening: how many chapters to review. Default: the first gate.' },
        provider: { type: 'string', description: 'Override the provider for this one call.' },
        model: { type: 'string', description: 'Override the model for this one call.' },
      },
      output: { schema: ENVELOPE_SCHEMA, render: renderTool },
      execute: async (args, exec) => {
        const store = storeFor(exec.agent?.session)
        const state = await store.read()
        if (state === undefined) {
          throw new NovelInputError(`no novel project at ${store.documentPath}; call novel_init first`)
        }
        const operation = args.operation as ReviewKind
        const route = resolveRoute(ctx, settings, { provider: args.provider, model: args.model })
        if (route === undefined) {
          throw new NovelReviewError(
            'no model route for novel_review: select a model in this session, or set reviewProvider/reviewModel in the '
            + 'plugin config. The other eight tools never need one.',
          )
        }
        const warnings: string[] = []
        const body: string[] = []
        const id = `review-${String(state.reviews.length + 1)}`

        // A batch of competitors is the SOP's most parallel step and its slowest:
        // twenty to fifty independent books, each needing its own reading. Handled
        // here, before the single-request path, so one call can carry the whole
        // study; `title`/`text` keep working exactly as before for one book.
        if (operation === 'competitor' && (args.targets?.length ?? 0) > 0) {
          const batch = await runCompetitorBatch({ args, body, ctx, exec, id, route, settings, state, store, warnings })
          return {
            ok: batch.ok,
            operation: 'competitor',
            detail: batch.detail,
            ...envelope(batch.after, batch.warnings),
            body: batch.body,
          }
        }

        const target =
          operation === 'ai-flavor'
            ? resolveChapter(state, args.chapterId).id
            : operation === 'competitor'
              ? (args.title ?? '').trim()
              : ''
        const request = buildRequest(state, operation, args, store)
        const result = await runReview(ctx, route, request, {
          signal: exec.signal,
          timeoutMs: settings.timeoutMs,
          maxTokens: settings.maxTokens,
          reasoningEffort: settings.reasoningEffort,
        })
        const output = parseReviewOutput(result.text)
        if (!output.parsed) {
          warnings.push('模型没有按 JSON 约定回复：findings 无法入库，请查看记录文件里的完整回复')
        } else if (output.findings.length === 0 && /"(dimension|fix)"\s*:/.test(result.text)) {
          // A parsed-but-empty envelope is the dangerous half of this failure:
          // the reply plainly carried findings, so "0 条问题" would read as a
          // clean pass. Say so rather than letting it through silently.
          warnings.push(
            '解析到的 findings 为 0，但回复里出现了 finding 字段：'
            + '结论可能是空的，请核对记录文件里的完整回复',
          )
        }
        if (result.truncated) {
          warnings.push(
            `模型输出被 maxTokens 截断（${String(result.finish)}${tokenSpend(result.usage)}），结论可能不完整`,
          )
        }
        if (result.reasoningChars > 0) {
          warnings.push(
            `本次回复含 ${String(result.reasoningChars)} 字推理内容，不计入评审结果（reviewReasoningEffort=`
            + `${result.reasoningEffort ?? '（跟随适配器默认）'}）`,
          )
        }
        const artifact = await store.writeDerived(
          `${DEFAULT_REVIEW_PATH}/${id}-${operation}.md`,
          transcript({ id, operation, target, route: `${route.provider}/${route.model}`, output, model: route.model }),
        )

        let rewritten = ''
        if (operation === 'ai-flavor' && args.rewrite === true) {
          const chapter = resolveChapter(state, args.chapterId)
          const second = await runReview(
            ctx,
            route,
            buildRewriteRequest({ state, chapter, findings: output.findings }),
            {
              signal: exec.signal,
              timeoutMs: settings.timeoutMs,
              maxTokens: settings.maxTokens,
              reasoningEffort: settings.reasoningEffort,
            },
          )
          rewritten = await store.writeDerived(
            `${DEFAULT_REVIEW_PATH}/${id}-rewrite.md`,
            `${second.text.trim()}\n`,
          )
        }

        const saved = await persist(state, operation, args, output, store)
        const review: ReviewRecord = {
          id,
          at: now(),
          kind: operation,
          target,
          provider: route.provider,
          model: route.model,
          promptVersion: REVIEW_PROMPT_VERSION,
          summary: output.summary,
          findings: output.findings,
          artifact: `${DEFAULT_REVIEW_PATH}/${id}-${operation}.md`,
        }
        const next = await store.update((current) => addReview(current, review))

        body.push(
          `模型：${route.provider}/${route.model}`
            + `（${route.source === 'call' ? '本次指定' : route.source === 'config' ? '插件配置' : '会话默认'}）`
            + `｜推理：${result.reasoningEffort ?? '跟随适配器默认'}`
            + `｜输出预算：${String(settings.maxTokens > 0 ? settings.maxTokens : request.maxTokens)} tokens`,
        )
        body.push(...renderReview(output, `${operation} 诊断`))
        if (output.lessons !== undefined && output.lessons.length > 0) {
          body.push('', `## 经验（${String(output.lessons.length)} 条）`)
          for (const lesson of output.lessons) {
            body.push(`- [${lesson.kind === 'avoid' ? '避雷' : '复用'}] ${lesson.statement}｜证据：${lesson.evidence}`)
          }
        }
        if (saved !== '') body.push('', saved)
        body.push('', `记录文件：${artifact}`, `评审编号：${id}（prompt ${REVIEW_PROMPT_VERSION}）`)
        if (rewritten !== '') {
          body.push('', '## 改写稿（提案，未写入章节）', `文件：${rewritten}`, '')
          body.push('确认后把正文发给 novel_write 覆盖该章；工具不会自动改稿。')
        }
        if (operation === 'ai-flavor' && args.rewrite !== true) {
          const mechanical = styleObservations(resolveChapter(state, args.chapterId).body)
          if (mechanical.length > 0) {
            body.push('', '机械统计（可复现的对照项）：')
            for (const observation of mechanical) body.push(`- ${observation}`)
          }
        }
        if (operation === 'competitor' && args.save !== true) {
          body.push('', '尚未入库：确认拆解可用后重跑并加 save=true，或用 novel_plan operation="competitor" 手工录入。')
        }
        if (operation === 'retro' && args.save !== true && (output.lessons?.length ?? 0) > 0) {
          body.push('', '尚未归档：确认后用 save=true 写入复盘经验，或用 novel_repo operation="lesson" 逐条录入。')
        }
        return {
          ok: true,
          operation,
          detail: `第 ${String(next.reviews.length)} 次模型评审：${operation}（${route.provider}/${route.model}，`
            + `${String(output.findings.length)} 条问题${rewritten === '' ? '' : '，附改写稿'}）`,
          ...envelope(next, warnings),
          body,
        }
      },
    }),
  )
}

/** The arguments `novel_review` accepts, as the tool declares them. */
type ReviewArgs = Record<string, unknown> & {
  readonly chapterId?: string | undefined
  readonly focus?: readonly string[] | undefined
  readonly title?: string | undefined
  readonly text?: string | undefined
  /**
   * Batch competitor entries, each `{ title, text }`.
   *
   * Typed as `unknown[]` rather than as the shape, because the parameter DSL
   * cannot infer a nested `properties` block and widening the whole argument
   * object to satisfy one parameter is a bad trade. `runCompetitorBatch`
   * normalises and validates the entries.
   */
  readonly targets?: readonly unknown[] | undefined
  readonly maxChapters?: number | undefined
}

/**
 * Build the request for one review operation.
 *
 * @param state - the project.
 * @param operation - which judgement to ask for.
 * @param args - the tool arguments.
 * @param store - the store, for error messages that name the document.
 * @returns the framed request.
 * @throws {NovelInputError} when the operation's own inputs are missing.
 */
function buildRequest(
  state: NovelState,
  operation: ReviewKind,
  args: ReviewArgs,
  store: SessionStore,
): ReturnType<typeof buildAiFlavorRequest> {
  if (operation === 'ai-flavor') {
    const chapter = resolveChapter(state, args.chapterId)
    if (chapter.body.trim() === '') {
      throw new NovelInputError(`第 ${String(chapter.number)} 章还没有正文，无法做去 AI 化诊断`)
    }
    // The mechanical pass runs first and its findings travel into the prompt: the
    // counter is cheap, exact, and cannot be argued with, so the model is told what
    // it already found and asked to judge those plus what a counter cannot see.
    return buildAiFlavorRequest({
      state,
      chapter,
      focus: args.focus,
      counted: styleObservations(chapter.body, styleTabooPhrases(state.outline.style.taboos)),
    })
  }
  if (operation === 'opening') {
    const gates = state.writing.openingGateChapters
    const gate = gates.length > 0 ? Math.max(...gates) : 3
    const count = Math.max(1, Math.min(args.maxChapters ?? Math.min(gate, 3), 10))
    const chapters = Object.values(state.chapters)
      .sort((a, b) => a.number - b.number)
      .filter((chapter) => chapter.body.trim() !== '')
      .slice(0, count)
    if (chapters.length === 0) {
      throw new NovelInputError(`没有可体检的正文（${store.documentPath} 里还没有写出任何一章）`)
    }
    return buildOpeningRequest({ state, chapters, checks: state.outline.opening, gate })
  }
  if (operation === 'competitor') {
    if (args.text === undefined || args.text.trim() === '') {
      throw new NovelInputError('operation="competitor" needs the competitor material in `text`')
    }
    return buildCompetitorRequest({ state, title: args.title ?? '（未命名竞品）', text: args.text })
  }
  return buildRetroRequest({
    state,
    progress: progressOf(state),
    readings: state.readings,
    iterations: state.iterations,
    evaluations: state.evaluations,
    launchDecisions: state.launchDecisions,
    lessons: state.retro?.lessons ?? [],
  })
}

/**
 * Dismantle a batch of competitors, one child agent each where the host can.
 *
 * The SOP asks for twenty to fifty same-shelf titles dismantled before the
 * premise is fixed. Doing that as a sequence of one-shot calls spends the sum of
 * their latencies to produce answers that never needed to be ordered, and does it
 * inside the operator's own turn. This hands each book to its own child and merges
 * what comes back.
 *
 * Three behaviours are deliberate:
 *
 * - **It degrades, it does not fail.** No `subagents` service, a single target, or
 *   no agent on the execution means the same work runs sequentially through
 *   `runReview`. The fan-out is an optimisation, never a new requirement.
 * - **A partial result is a result.** A child that fails is reported by name and
 *   the rest are still written, because eighteen dismantles out of twenty is
 *   eighteen more than starting over would produce.
 * - **Provenance stays per book.** Each target gets its own transcript file and
 *   its own ledger record, so "which model read which book" survives the batch.
 *
 * @param input - the review execution's state, arguments and accumulators.
 * @returns the tool result envelope.
 */
async function runCompetitorBatch(input: {
  readonly args: ReviewArgs
  readonly body: string[]
  readonly ctx: Context
  readonly exec: { readonly agent?: unknown; readonly signal?: AbortSignal }
  readonly id: string
  readonly route: LlmRoute
  readonly settings: ReviewSettings
  readonly state: NovelState
  readonly store: SessionStore
  readonly warnings: string[]
}): Promise<{
  readonly ok: boolean
  readonly detail: string
  readonly warnings: string[]
  readonly body: string[]
  readonly after: NovelState
}> {
  return competitorBatchOutcome(input)
}

/**
 * The batch itself: dismantle every target and record what came back.
 *
 * Split from {@link runCompetitorBatch} only so the caller can build the result
 * envelope itself — the schema-derived result type is not nameable from here.
 *
 * @param input - the review execution's state, arguments and accumulators.
 * @returns the outcome pieces the envelope is built from.
 */
async function competitorBatchOutcome(input: {
  readonly args: ReviewArgs
  readonly body: string[]
  readonly ctx: Context
  readonly exec: { readonly agent?: unknown; readonly signal?: AbortSignal }
  readonly id: string
  readonly route: LlmRoute
  readonly settings: ReviewSettings
  readonly state: NovelState
  readonly store: SessionStore
  readonly warnings: string[]
}): Promise<{
  readonly ok: boolean
  readonly detail: string
  readonly warnings: string[]
  readonly body: string[]
  readonly after: NovelState
}> {
  const { args, body, ctx, exec, route, settings, state, store, warnings } = input
  // The schema types the entries loosely (`additionalProperties`), because the
  // parameter DSL does not infer a nested `properties` block and widening the
  // whole argument object to satisfy one parameter is a bad trade. So the shape
  // is normalised here, once, and a malformed entry is named rather than dropped.
  const targets: { title: string; text: string }[] = []
  for (const entry of args.targets ?? []) {
    const record = entry as { readonly title?: unknown; readonly text?: unknown }
    const text = typeof record.text === 'string' ? record.text : ''
    if (typeof record.title !== 'string' && text === '') continue
    targets.push({ title: typeof record.title === 'string' ? record.title : '', text })
  }
  const usable = targets.filter((target) => target.text.trim() !== '')
  if (usable.length === 0) {
    throw new NovelInputError('operation="competitor" 的 targets 里没有非空原文（每项形如 { title, text }）')
  }
  const requests = usable.map((target) =>
    buildCompetitorRequest({ state, title: target.title.trim() || '（未命名竞品）', text: target.text }),
  )

  const provider = resolveSubagentProvider(ctx)
  const parallel = provider !== undefined && requests.length > 1 && exec.agent !== undefined
  let outcomes: { index: number; text: string; error: string }[]
  if (parallel) {
    outcomes = await runReviewFanout(ctx, provider, exec.agent, requests, {
      signal: exec.signal,
      timeoutMs: settings.timeoutMs,
      maxTokens: settings.maxTokens,
      labels: usable.map((target) => target.title.trim() || '（未命名竞品）'),
    })
  } else {
    outcomes = []
    for (const [index, request] of requests.entries()) {
      try {
        const single = await runReview(ctx, route, request, {
          signal: exec.signal,
          timeoutMs: settings.timeoutMs,
          maxTokens: settings.maxTokens,
          reasoningEffort: settings.reasoningEffort,
        })
        outcomes.push({ index, text: single.text, error: '' })
      } catch (error) {
        outcomes.push({ index, text: '', error: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  body.push(
    '## 批量竞品拆解',
    `方式：${
      parallel
        ? `子代理并行 ${String(requests.length)} 本（provider=${String(provider)}）`
        : provider === undefined
          ? '顺序执行（本 profile 没有 subagents 服务）'
          : '顺序执行（单本，或执行上下文里没有 agent）'
    }`,
    `模型：${route.provider}/${route.model}`,
  )

  let saved = 0
  for (const outcome of outcomes) {
    const target = usable[outcome.index]
    if (target === undefined) continue
    const title = target.title.trim() || '（未命名竞品）'
    if (outcome.error !== '') {
      warnings.push(`「${title}」拆解失败：${outcome.error}`)
      body.push(`- ✗ ${title}：${outcome.error}`)
      continue
    }
    const output = parseReviewOutput(outcome.text)
    if (output.dismantle === undefined) {
      warnings.push(`「${title}」的回复里没有 dismantle 字段，未入库（记录文件里有完整回复）`)
    }
    const recordId = `${input.id}-${String(outcome.index + 1)}`
    const artifact = await store.writeDerived(
      `${DEFAULT_REVIEW_PATH}/${recordId}-competitor.md`,
      transcript({
        id: recordId,
        operation: 'competitor',
        target: title,
        route: `${route.provider}/${route.model}`,
        output,
        model: route.model,
      }),
    )
    const persisted = await persist(
      state,
      'competitor',
      { ...args, save: args.save === true, title, text: target.text },
      output,
      store,
    )
    if (persisted !== '') saved += 1
    const review: ReviewRecord = {
      id: recordId,
      at: new Date().toISOString(),
      kind: 'competitor',
      target: title,
      provider: route.provider,
      model: route.model,
      promptVersion: REVIEW_PROMPT_VERSION,
      summary: output.summary,
      findings: output.findings,
      artifact,
    }
    await store.update((current) => addReview(current, review))
    body.push(`- ✓ ${title}${persisted === '' ? '' : ` — ${persisted}`}`)
    body.push(...renderReview(output, title))
  }

  const failed = outcomes.filter((outcome) => outcome.error !== '').length
  body.push(
    '',
    `合计 ${String(outcomes.length)} 本：成功 ${String(outcomes.length - failed)}，失败 ${String(failed)}，入库 ${String(saved)} 本`,
  )
  if (args.save !== true) {
    body.push('尚未入库：确认拆解可用后重跑并加 save=true，或用 novel_plan operation="competitor" 手工录入。')
  }
  const after = (await store.read()) ?? state
  return {
    ok: failed === 0,
    detail: `批量拆解 ${String(outcomes.length)} 本竞品：成功 ${String(outcomes.length - failed)}，失败 ${String(failed)}`,
    warnings,
    body,
    after,
  }
}

/**
 * Apply a review's structured result to the project, when asked to.
 *
 * Kept separate from recording the review itself: the review always lands in
 * the ledger, while the *content* it produced only lands when the author says
 * so, because a model draft is not yet a fact about the book.
 *
 * @param state - the project as read before the call.
 * @param operation - which judgement was asked for.
 * @param args - the tool arguments.
 * @param output - the parsed reply.
 * @param store - the store to write through.
 * @returns a line describing what was saved, or `''` when nothing was.
 */
async function persist(
  state: NovelState,
  operation: ReviewKind,
  args: ReviewArgs,
  output: ReturnType<typeof parseReviewOutput>,
  store: SessionStore,
): Promise<string> {
  const now = (): string => new Date().toISOString()
  if (operation === 'competitor' && args.save === true && output.dismantle !== undefined) {
    const draft = output.dismantle
    const title = draft.title === '' ? (args.title ?? '').trim() : draft.title
    const id = normalizeId(title) || normalizeId(args.title ?? '') || `competitor-${String(state.competitors.length + 1)}`
    const next = await store.update((current) => ({
      ...current,
      competitors: [...current.competitors.filter((entry) => entry.id !== id), { ...draft, id, title }],
      updatedAt: now(),
    }))
    return `已入库竞品「${title}」（第 ${String(next.competitors.length)} 本）`
  }
  if (operation === 'retro' && args.save === true && (output.lessons?.length ?? 0) > 0) {
    if (state.retro === undefined) {
      return '未归档经验：还没有复盘记录，先执行 novel_repo operation="retro"'
    }
    const lessons: Lesson[] = (output.lessons ?? []).map((lesson, index) => ({
      id: normalizeId(lesson.statement) || `lesson-review-${String(index + 1)}`,
      kind: lesson.kind,
      statement: lesson.statement,
      evidence: lesson.evidence,
      area: lesson.area,
    }))
    const retro = state.retro
    const next = await store.update((current) => ({
      ...current,
      retro: {
        ...(current.retro ?? retro),
        lessons: [
          ...(current.retro ?? retro).lessons.filter((entry) => !lessons.some((added) => added.id === entry.id)),
          ...lessons,
        ],
      },
      updatedAt: now(),
    }))
    return `已归档经验 ${String(lessons.length)} 条（共 ${String(next.retro?.lessons.length ?? 0)} 条）`
  }
  return ''
}

/**
 * Render the transcript kept beside the project.
 *
 * The raw reply is included on purpose: when a summary disagrees with the
 * findings, or parsing failed, the verbatim answer is the only way to tell
 * whether the model misbehaved or the rubric did.
 *
 * @param input - the review's identity and its parsed output.
 * @returns the Markdown document.
 */
function transcript(input: {
  readonly id: string
  readonly operation: ReviewKind
  readonly target: string
  readonly route: string
  readonly model: string
  readonly output: ReturnType<typeof parseReviewOutput>
}): string {
  const lines = [
    `# ${input.id} · ${input.operation}`,
    '',
    `- 时间：${new Date().toISOString()}`,
    `- 模型：${input.route}`,
    `- 提示词版本：${REVIEW_PROMPT_VERSION}`,
    `- 对象：${input.target === '' ? '（项目）' : input.target}`,
    `- 结构化解析：${input.output.parsed ? '成功' : '失败'}`,
    '',
    '## 总评',
    '',
    input.output.summary === '' ? '（无）' : input.output.summary,
    '',
    '## 问题',
    '',
  ]
  if (input.output.findings.length === 0) {
    lines.push('（无）')
  } else {
    for (const finding of input.output.findings) {
      lines.push(
        `### [${finding.severity}] ${finding.dimension}`,
        '',
        finding.quote === '' ? '' : `> ${finding.quote}`,
        '',
        `- 原因：${finding.why}`,
        `- 改法：${finding.fix}`,
        '',
      )
    }
  }
  if (input.output.dismantle !== undefined) {
    lines.push('## 竞品拆解', '', '```json', JSON.stringify(input.output.dismantle, null, 2), '```', '')
  }
  if (input.output.lessons !== undefined) {
    lines.push('## 经验', '', '```json', JSON.stringify(input.output.lessons, null, 2), '```', '')
  }
  lines.push('## 模型原始回复', '', '```', input.output.raw.trim(), '```', '')
  return lines.join('\n')
}

/**
 * Find a chapter by id, normalized id, or title.
 *
 * @param state - the state to search.
 * @param reference - the caller-supplied id, slug, or title.
 * @returns the matching chapter.
 * @throws {NovelInputError} when nothing matches.
 */
function resolveChapter(state: NovelState, reference: string | undefined): NovelState['chapters'][string] {
  const raw = reference?.trim() ?? ''
  const known = Object.keys(state.chapters).join(', ') || '(none)'
  if (raw === '') throw new NovelInputError(`a chapter reference is required; known ids: ${known}`)
  const normalized = normalizeId(raw)
  const found =
    state.chapters[raw]
    ?? state.chapters[normalized]
    ?? Object.values(state.chapters).find((chapter) => chapter.title === raw)
  if (found === undefined) throw new NovelInputError(`no chapter matches ${JSON.stringify(raw)}; known ids: ${known}`)
  return found
}
