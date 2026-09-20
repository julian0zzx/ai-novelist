/**
 * Pure planning checks: what a plan still owes before it can carry prose.
 *
 * The SOP's planning phase is a list of fields, and its failure mode is a field
 * nobody noticed was empty until chapter forty. These functions answer "what is
 * missing?" for the outline, the world, the pitch, and a chapter's contract —
 * which is what `novel_plan`'s soft gate reports and what `novel_write` reports
 * back after a draft.
 *
 * @module @ai-novelist/novelist-skill/core/plan
 */

import {
  CONTRACT_FIELDS,
  type Chapter,
  type ChapterStatus,
  type ContractField,
  type NovelState,
  type Outline,
  type Premise,
  type WritingPlan,
} from './types.ts'

/** One required field that is still empty, with where to fill it. */
export interface MissingField {
  /** Stable key, for grouping and for the tool's output. */
  readonly key: string
  /** What the SOP requires, in one line. */
  readonly requirement: string
  /** The operation that fills it. */
  readonly fill: string
}

/**
 * Fields the minimal viable outline must answer (SOP step 7).
 *
 * The SOP lists ten items; four of them live in other records (the pitch, the
 * cast, the volumes) and are checked by their own functions, so this covers the
 * outline record's own share.
 */
export function missingOutlineFields(outline: Outline): MissingField[] {
  const missing: MissingField[] = []
  const need = (ok: boolean, key: string, requirement: string): void => {
    if (!ok) missing.push({ key, requirement, fill: 'novel_plan operation="outline"' })
  }
  need(outline.logline.trim() !== '', 'logline', '一句话故事')
  need(outline.minimal.trim() !== '', 'minimal', '最小可行大纲（一屏可读完的摘要）')
  need(outline.acts.length > 0, 'acts', '三幕/分卷粗线条走向')
  return missing
}

/**
 * Fields the pitch must answer (SOP step 3).
 *
 * @param pitch - the pitch record.
 * @returns the empty fields.
 */
export function missingPitchFields(pitch: Premise): MissingField[] {
  const missing: MissingField[] = []
  const need = (ok: boolean, key: string, requirement: string): void => {
    if (!ok) missing.push({ key, requirement, fill: 'novel_plan operation="pitch"' })
  }
  need(pitch.memorablePoint.trim() !== '', 'memorablePoint', '唯一记忆点：主角+世界+执念+能力+对抗+情绪')
  need(pitch.coreEmotion.trim() !== '', 'coreEmotion', '给读者的核心情绪')
  need(pitch.shuangPoints.length > 0, 'shuangPoints', '爽点清单')
  need(pitch.differentiators.length > 0, 'differentiators', '与同榜书的差异点')
  need(pitch.kernel.trim() !== '', 'kernel', '精神内核')
  return missing
}

/** A world fact that names no price or limit. */
export interface WorldGap {
  /** The entry id. */
  readonly id: string
  /** The entry name. */
  readonly name: string
  /** Which part is missing: `cost`, `limits`, or `detail`. */
  readonly missing: readonly string[]
}

/**
 * World facts that state an ability without its price or its limit.
 *
 * The SOP is explicit that a power system is defined by what it costs and what
 * it forbids; an entry that only describes what it can do is the seed of a
 * system that cannot generate conflict.
 *
 * @param state - the project.
 * @returns the gaps, in insertion order.
 */
export function worldGaps(state: NovelState): WorldGap[] {
  const gaps: WorldGap[] = []
  for (const entry of Object.values(state.world)) {
    const missing: string[] = []
    if (entry.detail.trim() === '') missing.push('detail')
    if (entry.cost.trim() === '') missing.push('cost')
    if (entry.limits.trim() === '') missing.push('limits')
    if (missing.length > 0) gaps.push({ id: entry.id, name: entry.name, missing })
  }
  return gaps
}

/** A cast member with an incomplete spine. */
export interface CastGap {
  /** The character id. */
  readonly id: string
  /** The character name. */
  readonly name: string
  /** Which parts are missing. */
  readonly missing: readonly string[]
}

/**
 * Cast members missing the traits the SOP requires of a protagonist.
 *
 * Only the protagonist is held to the full spine (欲望/恐惧/执念/软肋 + 成长线);
 * supporting cast are checked for a `goal` only, because demanding a full arc
 * from every walk-on role produces filler, not depth.
 *
 * @param state - the project.
 * @returns the gaps.
 */
export function castGaps(state: NovelState): CastGap[] {
  const gaps: CastGap[] = []
  for (const character of Object.values(state.characters)) {
    const isLead = /protagonist|主角|lead/iu.test(character.role)
    const missing: string[] = []
    if (character.goal.trim() === '') missing.push('goal')
    if (isLead) {
      if (character.fear.trim() === '') missing.push('fear')
      if (character.obsession.trim() === '') missing.push('obsession')
      if (character.weakness.trim() === '') missing.push('weakness')
      if (character.growthArc.trim() === '') missing.push('growthArc')
    }
    if (missing.length > 0) gaps.push({ id: character.id, name: character.name, missing })
  }
  return gaps
}

/** A chapter whose contract is not yet answerable. */
export interface ContractGap {
  /** The chapter id. */
  readonly id: string
  /** The chapter number. */
  readonly number: number
  /** Fields neither answered nor waived. */
  readonly missing: readonly ContractField[]
}

/**
 * Chapters whose contract is incomplete.
 *
 * @param state - the project.
 * @param options - `only` restricts the check to a chapter range.
 * @returns the gaps, in reading order.
 */
export function contractGaps(
  state: NovelState,
  options: { readonly only?: readonly string[] } = {},
): ContractGap[] {
  const wanted = options.only === undefined ? undefined : new Set(options.only)
  const gaps: ContractGap[] = []
  for (const chapter of Object.values(state.chapters).sort((a, b) => a.number - b.number)) {
    if (wanted !== undefined && !wanted.has(chapter.id)) continue
    const missing = missingContract(chapter)
    if (missing.length > 0) gaps.push({ id: chapter.id, number: chapter.number, missing })
  }
  return gaps
}

/**
 * Contract fields a chapter has neither answered nor waived.
 *
 * @param chapter - the chapter to inspect.
 * @returns the unanswered fields, in the SOP's canonical order.
 */
export function missingContract(chapter: Chapter): ContractField[] {
  return CONTRACT_FIELDS.filter((field) => {
    if (chapter.waived[field] !== undefined) return false
    if (field === 'beats') return chapter.beats.length === 0
    const value = chapter[field]
    return typeof value === 'string' ? value.trim() === '' : value === undefined
  })
}

/**
 * The contract's fields as label/value pairs, for a tool to render.
 *
 * @param chapter - the chapter.
 * @returns one entry per contract field, with its text or an empty marker.
 */
export function contractRows(chapter: Chapter): { readonly field: ContractField; readonly text: string }[] {
  return CONTRACT_FIELDS.map((field) => {
    if (field === 'beats') return { field, text: chapter.beats.join('、') }
    const value = chapter[field]
    return { field, text: typeof value === 'string' ? value : '' }
  })
}

// ── the writing plan's four length questions ─────────────────────────────────

/** Which `novel_init` answer a length question is stored in. */
export type PlanAnswerKey = 'targetWords' | 'chapterWords' | 'volumes'

/** One length question the composer must put to the author, not to the story. */
export interface PlanQuestion {
  /** The `novel_init` parameter the answer lands in. */
  readonly key: PlanAnswerKey
  /** The question, phrased for the user. */
  readonly question: string
  /** What the answer decides downstream. */
  readonly decides: string
}

/**
 * The length questions asked at initialization (SOP step 6, extended).
 *
 * Four things are being settled — 总字数, 单章字数, 是否分卷, 分几卷 — through
 * three answers: an explicit `volumes: 0` is the "不分卷" decision, and `-1`
 * (the stored default) is what "not asked yet" looks like. Nothing here is
 * inferable from the premise, so the only honest source is the author.
 */
export const WRITING_PLAN_QUESTIONS: readonly PlanQuestion[] = [
  {
    key: 'targetWords',
    question: '这本书计划写多少字（总字数）？',
    decides: '篇幅量级、上架与完本预期',
  },
  {
    key: 'chapterWords',
    question: '单章目标多少字？',
    decides: '每章细纲的目标字数、初稿 150% 与成稿 -5%/+15% 的长度核对',
  },
  {
    key: 'volumes',
    question: '要分卷吗？分几卷？（确定不分卷就答 0）',
    decides: '分卷大纲的卷数、每卷章数与卷末高潮位置',
  },
]

/** One common length tier, offered to the author as a choice. */
export interface LengthBenchmark {
  /** What this tier is called. */
  readonly name: string
  /** Typical total length. */
  readonly targetWords: string
  /** Typical chapter length. */
  readonly chapterWords: string
  /** Typical volume shape. */
  readonly volumes: string
  /** What the tier is for. */
  readonly note: string
}

/**
 * Common 网文 length tiers, as *choices to offer*, never as facts to assert.
 *
 * The composer cannot know a platform's current house style, so these are
 * printed as a menu beside the question ("which of these is closest?") and the
 * answer recorded is always the author's, not the table's.
 */
export const LENGTH_BENCHMARKS: readonly LengthBenchmark[] = [
  {
    name: '短篇 / 免费短打',
    targetWords: '20–40 万字',
    chapterWords: '2000 字左右',
    volumes: '不分卷，或 3–5 卷',
    note: '节奏快，开篇即冲突，靠完读与留存',
  },
  {
    name: '中篇 / 常规连载',
    targetWords: '80–150 万字',
    chapterWords: '2500–3000 字',
    volumes: '6–12 卷（每卷约 40–60 章）',
    note: '免费平台最常见体量，追读压力适中',
  },
  {
    name: '长篇 / 付费大长篇',
    targetWords: '200–400 万字',
    chapterWords: '3000–4000 字',
    volumes: '15–30 卷（每卷约 50–80 章）',
    note: '付费平台上架与追订模型',
  },
]

/**
 * Length questions the writing plan still has no answer to.
 *
 * This is the checklist `novel_init` reports when the four numbers have not
 * been settled with the author, and what the runtime context repeats every step
 * until they are — an unanswered number is a plan nobody can check.
 *
 * @param writing - the writing plan.
 * @returns one entry per unanswered question.
 */
export function writingPlanGaps(writing: WritingPlan): MissingField[] {
  const gaps: MissingField[] = []
  if (writing.targetWords <= 0) {
    gaps.push({ key: 'targetWords', requirement: '总字数未确认（先问用户）', fill: 'novel_init targetWords' })
  }
  if (writing.chapterWords <= 0) {
    gaps.push({ key: 'chapterWords', requirement: '单章目标字数未确认（先问用户）', fill: 'novel_init chapterWords' })
  }
  if (writing.volumes < 0) {
    gaps.push({ key: 'volumes', requirement: '是否分卷/分几卷未确认（先问用户）', fill: 'novel_init volumes（0 = 不分卷）' })
  }
  return gaps
}

/**
 * The length plan in one line, naming what has not been asked yet.
 *
 * `volumes: 0` is the author's 不分卷 answer and `-1` is "not asked", so the two
 * render differently — a plan nobody has settled must not read like one that has.
 * The per-chapter draft target rides along, because the 150% rule is only
 * followed if the number is visible at the moment a chapter is written.
 *
 * @param writing - the writing plan.
 * @returns the line the tools, the prompt and the board show.
 */
export function describeWritingPlan(writing: WritingPlan): string {
  const parts = [
    writing.targetWords > 0 ? `总字数 ${String(writing.targetWords)}` : '总字数未问',
    writing.chapterWords > 0 ? `单章 ${String(writing.chapterWords)} 字` : '单章字数未问',
    writing.volumes > 0 ? `${String(writing.volumes)} 卷` : writing.volumes === 0 ? '不分卷' : '是否分卷未问',
  ]
  if (writing.totalChapters > 0) parts.push(`共约 ${String(writing.totalChapters)} 章`)
  if (writing.chapterWords > 0) {
    parts.push(`初稿按 ${String(draftTargetWords(writing.chapterWords))} 字/章（150%）`)
  }
  return parts.join(' · ')
}

/**
 * The total chapter count the length numbers imply.
 *
 * @param targetWords - planned total length, 0 when unknown.
 * @param chapterWords - planned chapter length, 0 when unknown.
 * @returns the implied chapter count, or 0 when either number is unknown.
 */
export function derivedTotalChapters(targetWords: number, chapterWords: number): number {
  if (targetWords <= 0 || chapterWords <= 0) return 0
  return Math.max(1, Math.round(targetWords / chapterWords))
}

/**
 * Chapters per volume implied by the plan.
 *
 * @param totalChapters - planned total chapters, 0 when unknown.
 * @param volumes - planned volumes; 0 means one volume, negative means undecided.
 * @returns chapters per volume, or 0 when the shape is not yet known.
 */
export function chaptersPerVolume(totalChapters: number, volumes: number): number {
  if (totalChapters <= 0) return 0
  if (volumes === 0) return totalChapters
  if (volumes < 0) return 0
  return Math.max(1, Math.round(totalChapters / volumes))
}

/**
 * Fill in the numbers the plan implies but the author did not state.
 *
 * Only ever *derives forward*: total chapters from total length and chapter
 * length, then volumes from an explicit chapters-per-volume answer. It never
 * overrides an answer the author gave, because a derived number quietly
 * replacing a stated one is how a plan stops describing the book.
 *
 * @param writing - the writing plan after the author's answers.
 * @param options - `chaptersPerVolume` when the author answered in that shape.
 * @returns the plan with the derivable gaps filled.
 */
export function normalizeWritingPlan(
  writing: WritingPlan,
  options: { readonly chaptersPerVolume?: number } = {},
): WritingPlan {
  let next = writing
  if (next.totalChapters <= 0) {
    const derived = derivedTotalChapters(next.targetWords, next.chapterWords)
    if (derived > 0) next = { ...next, totalChapters: derived }
  }
  const perVolume = options.chaptersPerVolume ?? 0
  if (next.volumes < 0 && perVolume > 0 && next.totalChapters > 0) {
    next = { ...next, volumes: Math.max(1, Math.ceil(next.totalChapters / perVolume)) }
  }
  return next
}

/**
 * Where the length numbers contradict each other.
 *
 * A plan whose parts disagree is not worth checking chapters against, so this
 * reports the disagreement instead of picking a winner.
 *
 * @param writing - the writing plan.
 * @param tolerance - allowed fractional deviation, default 15%.
 * @returns one note per contradiction, empty when the numbers agree.
 */
export function writingPlanConflicts(writing: WritingPlan, tolerance = 0.15): string[] {
  const notes: string[] = []
  if (writing.targetWords > 0 && writing.totalChapters > 0 && writing.chapterWords > 0) {
    const implied = writing.totalChapters * writing.chapterWords
    const off = Math.abs(writing.targetWords - implied) / writing.targetWords
    if (off > tolerance) {
      notes.push(
        `总字数 ${String(writing.targetWords)} 与「总章数 ${String(writing.totalChapters)} × 单章 ${String(writing.chapterWords)} 字」= ${String(implied)} 相差 ${String(Math.round(off * 100))}%（允许 ±${String(Math.round(tolerance * 100))}%）：三者要大致自洽`,
      )
    }
  }
  if (writing.volumes > 0 && writing.totalChapters > 0 && writing.volumes > writing.totalChapters) {
    notes.push(`卷数 ${String(writing.volumes)} 多于总章数 ${String(writing.totalChapters)}：每卷至少要有一章`)
  }
  return notes
}

/**
 * How one volume's chapter span compares with the planned volume length.
 *
 * @param length - the volume's chapter count.
 * @param writing - the writing plan.
 * @param tolerance - allowed fractional deviation, default 15%.
 * @returns a note when the span is off, `undefined` when there is nothing to compare.
 */
export function volumeLengthNote(length: number, writing: WritingPlan, tolerance = 0.15): string | undefined {
  const expected = chaptersPerVolume(writing.totalChapters, writing.volumes)
  if (expected <= 0 || length <= 0) return undefined
  const off = Math.abs(length - expected) / expected
  if (off <= tolerance) return undefined
  return (
    `本卷 ${String(length)} 章，与计划每卷约 ${String(expected)} 章相差 ${String(Math.round(off * 100))}%`
    + `（允许 ±${String(Math.round(tolerance * 100))}%）：卷长要么按计划收，要么回 novel_init 改卷数`
  )
}

// ── the two length gates: 初稿 150%, 成稿 100% ────────────────────────────────

/**
 * How much longer the first draft runs than the finished chapter.
 *
 * 去 AI 化 and manual trimming reliably delete a large share of a draft — a
 * web-novel edit is mostly cutting. A first draft written straight to the
 * finished target therefore arrives at publication short, so the SOP writes
 * every first draft to 150% of the chapter target and trims it back into the
 * finished window afterwards. This is a SOP constant, not an implementation
 * knob: changing it changes what "写完一章" means.
 */
export const DRAFT_TARGET_RATIO = 1.5

/** Which of a chapter's two length gates a draft is measured against. */
export type LengthStage = 'draft' | 'final'

/**
 * How far a chapter may miss its target, on each side.
 *
 * The window is deliberately **asymmetric**: coming in under the target is the
 * failure, and over is only padding to trim. A chapter 15% short of the length
 * the reader was promised is not the same book as one 15% long, so the shortfall
 * is held to 5% while the overrun keeps the 15% the plan itself allows.
 */
export interface LengthTolerance {
  /** Allowed shortfall as a fraction of the target. */
  readonly under: number
  /** Allowed overrun as a fraction of the target. */
  readonly over: number
}

/**
 * The tolerance every length gate applies: −5% / +15%.
 *
 * Both gates use it — a first draft that lands under 150% misses the point of
 * writing long, and a finished chapter that lands under the target has already
 * lost the length the reader paid for.
 */
export const LENGTH_TOLERANCE: LengthTolerance = { under: 0.05, over: 0.15 }

/**
 * The length a first draft is written to, from the finished-chapter target.
 *
 * @param targetWords - the chapter's finished target, 0 when unset.
 * @param ratio - draft-to-final ratio, default {@link DRAFT_TARGET_RATIO}.
 * @returns the draft target, or 0 when no target is set.
 */
export function draftTargetWords(targetWords: number, ratio = DRAFT_TARGET_RATIO): number {
  if (targetWords <= 0) return 0
  return Math.round(targetWords * ratio)
}

/**
 * Which length gate a chapter at this lifecycle stage is measured against.
 *
 * A `planned` or `drafting` chapter is still a first draft and is held to the
 * 150% target; `revised` and `final` have already been through 去 AI 化, so the
 * trimming has happened and they are held to the finished target. Measuring a
 * trimmed chapter against 150% would reward padding, and measuring a first
 * draft against 100% would demand the trim before there is anything to trim.
 *
 * @param status - the chapter's lifecycle stage.
 * @returns `draft` or `final`.
 */
export function lengthStageFor(status: ChapterStatus): LengthStage {
  return status === 'planned' || status === 'drafting' ? 'draft' : 'final'
}

/** The allowed range around a length target. */
export interface LengthWindow {
  /** Inclusive lower bound. */
  readonly low: number
  /** Inclusive upper bound. */
  readonly high: number
}

/**
 * The allowed range around a length target, -5% / +15% by default.
 *
 * The bounds are rounded to whole characters: a length is a character count, so
 * the window a verdict prints as `2850–3450` has to be the window it enforces,
 * not a float that rounds to it on screen.
 *
 * @param target - the target length in characters.
 * @param tolerance - override either side, or pass a bare number to set both
 *   (which is only for a strict comparison, not for the SOP's window).
 * @returns the range the length must fall inside.
 */
export function lengthWindow(target: number, tolerance: number | Partial<LengthTolerance> = {}): LengthWindow {
  const under = typeof tolerance === 'number' ? tolerance : (tolerance.under ?? LENGTH_TOLERANCE.under)
  const over = typeof tolerance === 'number' ? tolerance : (tolerance.over ?? LENGTH_TOLERANCE.over)
  return { low: Math.round(target * (1 - under)), high: Math.round(target * (1 + over)) }
}

/**
 * The tolerance in the notation the verdicts print.
 *
 * A symmetric tolerance prints as `±15%`; the SOP's asymmetric default prints as
 * `-5%/+15%` instead, because the two sides are not the same rule and printing
 * them as one would hide which side is tight.
 *
 * @param tolerance - a bare number (both sides) or a partial window.
 * @returns the label the notes carry.
 */
export function lengthToleranceLabel(tolerance: number | Partial<LengthTolerance> = {}): string {
  const under = typeof tolerance === 'number' ? tolerance : (tolerance.under ?? LENGTH_TOLERANCE.under)
  const over = typeof tolerance === 'number' ? tolerance : (tolerance.over ?? LENGTH_TOLERANCE.over)
  const asPercent = (value: number): string => `${String(Math.round(value * 100))}%`
  return under === over ? `±${asPercent(under)}` : `-${asPercent(under)}/+${asPercent(over)}`
}

/** How a chapter's length compares with the gate that applies to it. */
export interface LengthCheck {
  /** Which gate was applied. */
  readonly stage: LengthStage
  /** The target compared against: the 150% draft target, or the finished one. */
  readonly target: number
  /** The chapter's current length. */
  readonly actual: number
  /** The allowed range around {@link target}. */
  readonly window: LengthWindow
  /** Whether the length is inside the window. */
  readonly within: boolean
  /** One-line verdict naming the gate it was measured against. */
  readonly note: string
  /** The same verdict without the reasoning, for a summary line. */
  readonly short: string
}

/** How {@link lengthCheck} picks its gate and tolerance. */
export interface LengthCheckOptions {
  /** Force a gate; defaults to the one the chapter's status implies. */
  readonly stage?: LengthStage
  /** Override the window; a bare number sets both sides. */
  readonly tolerance?: number | Partial<LengthTolerance>
}

/**
 * Whether a chapter's length met the gate that applies to it, within tolerance.
 *
 * Two gates exist because there are two moments: the first draft is written long
 * (150%) so that 去 AI 化 and hand-cutting cannot leave the finished chapter
 * short, and the finished chapter must land back inside the target the user gave
 * — never more than 5% under it, up to 15% over. This reports the comparison
 * without enforcing it, because a chapter that runs long for a reason is a
 * legitimate authorial choice. A chapter with no prose has nothing to compare
 * yet, so it reports nothing.
 *
 * @param chapter - the chapter.
 * @param options - a bare tolerance, or the gate and tolerance to apply.
 * @returns the comparison, or `undefined` when no target is set or nothing is written.
 */
export function lengthCheck(chapter: Chapter, options: number | LengthCheckOptions = {}): LengthCheck | undefined {
  if (chapter.targetWords <= 0 || chapter.body.trim() === '') return undefined
  const stage = typeof options === 'number' ? undefined : options.stage
  const tolerance = typeof options === 'number' ? options : (options.tolerance ?? {})
  const gate = stage ?? lengthStageFor(chapter.status)
  const target = gate === 'draft' ? draftTargetWords(chapter.targetWords) : chapter.targetWords
  const window = lengthWindow(target, tolerance)
  const actual = chapter.wordCount
  const within = actual >= window.low && actual <= window.high
  const percent = lengthToleranceLabel(tolerance)
  const range = `${String(Math.round(window.low))}–${String(Math.round(window.high))}`
  const note = gate === 'draft'
    ? within
      ? `初稿 ${String(actual)} 字在初稿目标 ${String(target)} 字内`
        + `（成稿目标 ${String(chapter.targetWords)} 的 150%，允许 ${range}）`
      : actual < window.low
        ? `初稿 ${String(actual)} 字低于初稿目标 ${String(target)} 字`
          + `（成稿目标 ${String(chapter.targetWords)} 的 150%，允许 ${range}）：`
          + '去 AI 化与手改会成段删减，初稿要按 150% 写才留得住成稿长度'
        : `初稿 ${String(actual)} 字超过初稿目标 ${String(target)} 字`
          + `（成稿目标 ${String(chapter.targetWords)} 的 150%，允许 ${range}）：`
          + '去 AI 化阶段压缩回成稿区间'
    : within
      ? `成稿 ${String(actual)} 字在目标 ${String(chapter.targetWords)} 字的 ${percent} 内（允许 ${range}）`
      : actual < window.low
        ? `成稿 ${String(actual)} 字偏离目标 ${String(chapter.targetWords)} 字（允许 ${range}）：`
          + `低于目标 ${percent} 的下限就要补写，成稿不能比目标少太多`
        : `成稿 ${String(actual)} 字偏离目标 ${String(chapter.targetWords)} 字（允许 ${range}）：`
          + `超过上限（目标 ${percent}）就在去 AI 化阶段压回`
  const short = gate === 'draft'
    ? within
      ? `初稿 ${String(actual)} 字达到初稿目标 ${String(target)} 字（成稿的 150%）`
      : `初稿 ${String(actual)} 字${actual < window.low ? '不足' : '超过'}初稿目标 ${String(target)} 字（成稿的 150%）`
    : within
      ? `成稿 ${String(actual)} 字在目标 ${String(chapter.targetWords)} 字 ${percent} 内`
      : `成稿 ${String(actual)} 字${actual < window.low ? '低于' : '高于'}目标 ${String(chapter.targetWords)} 字（${percent}）`
  return { stage: gate, target, actual, window, within, note, short }
}

/**
 * Suggested beats for a chapter position, from the SOP's rhythm rule.
 *
 * The SOP asks for a small climax every three chapters, a medium one every ten,
 * and a volume climax; this turns that into a suggestion the plan tool prints
 * when a beat is not yet placed, without writing the beat for the author.
 *
 * @param chapter - the 1-based chapter number.
 * @param volumeLength - chapters per volume, or 0 when unknown.
 * @returns what the rhythm rule expects, or `undefined` for a routine chapter.
 */
export function rhythmExpectation(chapter: number, volumeLength: number): string | undefined {
  if (volumeLength > 0 && chapter % volumeLength === 0) return '卷末大高潮 + 卷末钩子'
  if (chapter % 10 === 0) return '中高潮'
  if (chapter % 3 === 0) return '小高潮'
  return undefined
}

/**
 * Opening-package readiness: what the SOP's phase two still needs.
 *
 * @param state - the project.
 * @returns the unmet preconditions, each naming where to fill it.
 */
export function openingPackageGaps(state: NovelState): MissingField[] {
  const gaps: MissingField[] = []
  const chapterPlans = Object.values(state.chapters).filter((chapter) => chapter.body.trim() === '')
  if (state.outline.logline.trim() === '' && state.outline.minimal.trim() === '') {
    gaps.push({ key: 'minimal-outline', requirement: '最小可行大纲', fill: 'novel_plan operation="outline"' })
  }
  if (chapterPlans.length === 0) {
    gaps.push({ key: 'chapter-plans', requirement: '前 N 章细纲', fill: 'novel_plan operation="chapter"' })
  }
  const pending = state.outline.opening.filter((check) => !check.done)
  if (pending.length > 0) {
    gaps.push({
      key: 'opening-checklist',
      requirement: `开篇工程清单还有 ${String(pending.length)} 项未确认：${pending.map((check) => check.key).join(', ')}`,
      fill: 'novel_plan operation="opening"',
    })
  }
  const naming = state.naming.filter((candidate) => candidate.title !== '' || candidate.blurb !== '')
  if (naming.length < 3) {
    gaps.push({
      key: 'naming-candidates',
      requirement: `书名/简介/标签备选 ≥3 组（当前 ${String(naming.length)} 组）`,
      fill: 'novel_plan operation="naming"',
    })
  }
  return gaps
}
