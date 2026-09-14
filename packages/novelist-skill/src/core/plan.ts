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
  type ContractField,
  type NovelState,
  type Outline,
  type Premise,
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

/**
 * Whether a chapter's target length was met within a tolerance.
 *
 * The SOP's "1–3 万字" style gates are only checkable if a chapter carries a
 * target; this reports the comparison without enforcing it, because a chapter
 * that runs long for a reason is a legitimate authorial choice.
 *
 * @param chapter - the chapter.
 * @param tolerance - allowed fractional deviation, default 15%.
 * @returns the comparison, or `undefined` when no target is set.
 */
export function lengthCheck(
  chapter: Chapter,
  tolerance = 0.15,
): { readonly target: number; readonly actual: number; readonly within: boolean; readonly note: string } | undefined {
  if (chapter.targetWords <= 0) return undefined
  const low = chapter.targetWords * (1 - tolerance)
  const high = chapter.targetWords * (1 + tolerance)
  const within = chapter.wordCount >= low && chapter.wordCount <= high
  return {
    target: chapter.targetWords,
    actual: chapter.wordCount,
    within,
    note: within
      ? `字数 ${String(chapter.wordCount)} 在目标 ${String(chapter.targetWords)} ±${String(Math.round(tolerance * 100))}% 内`
      : `字数 ${String(chapter.wordCount)} 偏离目标 ${String(chapter.targetWords)}（允许 ${String(Math.round(low))}–${String(Math.round(high))}）`,
  }
}

/**
 * Suggested beats for a chapter position, from the SOP's rhythm rule.
 *
 * The SOP asks for a small climax every three chapters, a medium one every ten,
 * and a volume climax; this turns that into a suggestion the plan tool can print
 * when a beat is not yet placed, without writing the beat for the author.
 *
 * @param chapter - the 1-based chapter number.
 * @param volumeLength - chapters per volume, or 0 when unknown.
 * @returns what the rhythm rule expects at this position.
 */
export function rhythmExpectation(chapter: number, volumeLength: number): string {
  if (volumeLength > 0 && chapter % volumeLength === 0) return '卷末大高潮 + 卷末钩子'
  if (chapter % 10 === 0) return '中高潮'
  if (chapter % 3 === 0) return '小高潮'
  return '常规推进（可放信息差或支线）'
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
