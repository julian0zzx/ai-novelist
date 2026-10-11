/**
 * The narrative spine: what a planning layer owes the *story*, before it owes a
 * rhythm table or a word count.
 *
 * One idea, in one module. Each outline layer names its narrative elements as
 * fields, and every check here is a presence check over those fields — no
 * arithmetic, no thresholds, nothing that needs the project's length answers.
 * That is deliberate: "this outline does not say what happens" and "this outline
 * is shorter than its target" are different findings, and the second must not be
 * able to hide the first. The tools therefore report this module's gaps **before**
 * they report anything derived from `OUTLINE_LAYER_RATIOS`.
 *
 * It lives outside `plan.ts` because the stage machine needs it too (`novel.ts`),
 * and `plan.ts` already depends on `novel.ts`; a spine check that pulled the
 * dependency the other way would close a cycle between the two.
 *
 * @module @ai-novelist/novelist-skill/core/spine
 */

import {
  OUTLINE_SPINE_PARTS,
  SPINE_LABELS,
  VOLUME_SPINE_PARTS,
  type Outline,
  type OutlineSpineField,
  type SpineGap,
  type SpinePart,
  type VolumePlan,
  type VolumeSpineField,
} from './types.ts'

/**
 * Narrative-spine elements the whole-book outline has not answered yet.
 *
 * This is the check that runs *before* the beat table and the length target: the
 * spine is the story the beats are supposed to be attached to, and a detailed
 * outline can fill every structural box (acts, turning points, foreshadowing, an
 * ending frame) while never once saying what happens to these people. The book
 * this check was added for is exactly that case — 20k characters of skeleton and
 * no synopsis — so "大纲太薄" and "大纲不是一个故事" are now two different reports.
 *
 * @param outline - the whole-book outline.
 * @returns the unanswered elements, in reading order; empty when the story is whole.
 */
export function outlineSpineGaps(outline: Outline): SpineGap[] {
  return OUTLINE_SPINE_PARTS.filter((part) => outline[part.field].trim() === '').map((part) => ({
    key: part.field,
    requirement: part.requirement,
    fill: `novel_plan operation="outline" ${part.field}=…`,
  }))
}

/**
 * Narrative-spine elements one volume has not answered yet.
 *
 * @param volume - the volume plan.
 * @returns the unanswered elements, in reading order.
 */
export function volumeSpineGaps(volume: VolumePlan): SpineGap[] {
  return VOLUME_SPINE_PARTS.filter((part) => volume[part.field].trim() === '').map((part) => ({
    key: part.field,
    requirement: part.requirement,
    fill: `novel_plan operation="volume" number=${String(volume.number)} ${part.field}=…`,
  }))
}

/**
 * The payoff schedule a whole-book outline still owes.
 *
 * Checked *after* the spine and *before* length: these are the SOP's 爽点/爆点
 * obligations, and they are only meaningful once there is a story to place them
 * on. Two gaps are reported here — a rhythm table with no beats, and a book whose
 * volumes have no climax and end hook to be the 爆点's landing point.
 *
 * @param outline - the whole-book outline.
 * @returns one note per missing piece; empty when the schedule is in place.
 */
export function outlinePayoffGaps(outline: Outline): string[] {
  const notes: string[] = []
  if (outline.beats.length === 0) {
    notes.push('情绪节拍表为空（每 3 章小爽点、每 10 章大爽点、每卷卷末爆点）：novel_plan operation="beat"')
  }
  if (outline.volumes.length === 0) {
    notes.push('分卷大纲还没写：阶段性高潮与卷末爆点没有落点（novel_plan operation="volume"）')
  } else if (!outline.volumes.some((volume) => volume.climax.trim() !== '' && volume.endHook.trim() !== '')) {
    notes.push('没有任何一卷写明阶段性高潮与卷末钩子：爆点还没落到卷上（novel_plan operation="volume"）')
  }
  return notes
}

/**
 * Render one layer's narrative spine as a report block.
 *
 * Every element is printed, answered or not, because the *shape* of a spine is
 * itself the thing being checked: a list of eight headings where two are filled
 * tells the author what is still missing without a second tool call.
 *
 * @param parts - the layer's spine table.
 * @param values - the layer's current values.
 * @returns one bullet per element, in reading order.
 */
export function narrativeReport<Field extends string>(
  parts: readonly SpinePart<Field>[],
  values: Readonly<Record<Field, string>>,
): string[] {
  return parts.map((part) => {
    const text = values[part.field].replace(/\s+/gu, ' ').trim()
    const label: string = SPINE_LABELS[part.field as keyof typeof SPINE_LABELS] ?? part.heading
    if (text === '') return `- ⬜ ${label}：未写（${part.requirement}）`
    const short = text.length > 80 ? `${text.slice(0, 80)}…` : text
    return `- ✅ ${label}：${short}`
  })
}

/**
 * The whole-book spine's current values, keyed for {@link narrativeReport}.
 *
 * Narrowing the record here rather than handing an `Outline` to the reporter
 * keeps the report's contract exact: it takes strings, not a state object that
 * happens to hold some.
 *
 * @param outline - the whole-book outline.
 * @returns one entry per spine field.
 */
export function outlineSpineValues(outline: Outline): Readonly<Record<OutlineSpineField, string>> {
  return {
    synopsis: outline.synopsis,
    protagonistArc: outline.protagonistArc,
    supportArcs: outline.supportArcs,
    antagonistArc: outline.antagonistArc,
    factionShift: outline.factionShift,
    conflictArcs: outline.conflictArcs,
    costs: outline.costs,
    gains: outline.gains,
  }
}

/**
 * One volume's spine values, keyed for {@link narrativeReport}.
 *
 * @param volume - the volume plan.
 * @returns one entry per spine field.
 */
export function volumeSpineValues(volume: VolumePlan): Readonly<Record<VolumeSpineField, string>> {
  return {
    synopsis: volume.synopsis,
    protagonistArc: volume.protagonistArc,
    antagonistArc: volume.antagonistArc,
    factionShift: volume.factionShift,
    mainConflict: volume.mainConflict,
    costs: volume.costs,
    gains: volume.gains,
  }
}
