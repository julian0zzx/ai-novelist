/**
 * Pure contract-delivery checks: did the prose pay for the plan?
 *
 * The SOP requires prose to answer its chapter outline field by field, and
 * version 3.0 had no way to notice when it did not. These functions produce the
 * report `novel_write` returns: which contract fields the draft reached, which
 * were missed, which the author waived, and whether the length landed.
 *
 * Nothing here judges prose quality — that is the author's job, and the SOP says
 * so. It only compares what was promised with what was written.
 *
 * @module @ai-novelist/novelist-skill/core/write
 */

import { countWords } from './novel.ts'
import { contractRows, lengthCheck, missingContract } from './plan.ts'
import { CONTRACT_FIELDS, type Chapter, type ContractField } from './types.ts'

/** How one contract field fared in a draft. */
export interface FieldDelivery {
  /** Which field. */
  readonly field: ContractField
  /** The planned text, empty when the plan never answered it. */
  readonly planned: string
  /** Whether the plan answered it at all. */
  readonly plannedAtAll: boolean
  /** Whether the author waived it, with the reason. */
  readonly waived: string | undefined
  /** Whether the draft reached it, as reported by the writer. */
  readonly delivered: boolean
}

/** The full report for one draft. */
export interface DeliveryReport {
  /** The chapter's id. */
  readonly id: string
  /** The chapter's number. */
  readonly number: number
  /** Per-field outcomes, in the SOP's order. */
  readonly fields: readonly FieldDelivery[]
  /** Fields the plan never answered and the author never waived. */
  readonly unplanned: readonly ContractField[]
  /** Planned fields the draft did not reach. */
  readonly missed: readonly ContractField[]
  /** Fields reached. */
  readonly reached: readonly ContractField[]
  /** Length comparison, when a target was set. */
  readonly length: ReturnType<typeof lengthCheck>
  /** Length after this write, in characters. */
  readonly wordCount: number
  /** One-line verdict the tool prints first. */
  readonly summary: string
}

/**
 * Build the delivery report for a chapter after a write.
 *
 * @param chapter - the chapter as stored, with `delivered` already merged.
 * @returns the report.
 */
export function analyzeDelivery(chapter: Chapter): DeliveryReport {
  const rows = contractRows(chapter)
  const planned = missingContract(chapter)
  const fields: FieldDelivery[] = rows.map((row) => {
    const waived = chapter.waived[row.field]
    const answered = !planned.includes(row.field)
    return {
      field: row.field,
      planned: row.text,
      plannedAtAll: answered,
      waived,
      delivered: chapter.delivered.includes(row.field),
    }
  })

  const unplanned = fields.filter((entry) => !entry.plannedAtAll && entry.waived === undefined).map((entry) => entry.field)
  const missed = fields
    .filter((entry) => entry.plannedAtAll && !entry.delivered)
    .map((entry) => entry.field)
  const reached = fields.filter((entry) => entry.delivered).map((entry) => entry.field)
  const length = lengthCheck(chapter)

  const parts: string[] = [`已兑现 ${String(reached.length)}/${String(CONTRACT_FIELDS.length)} 项契约`]
  if (missed.length > 0) parts.push(`未兑现：${missed.join('、')}`)
  if (unplanned.length > 0) parts.push(`细纲未写：${unplanned.join('、')}`)
  if (length !== undefined && !length.within) parts.push(length.note)

  return {
    id: chapter.id,
    number: chapter.number,
    fields,
    unplanned,
    missed,
    reached,
    length,
    wordCount: countWords(chapter.body),
    summary: parts.join('；'),
  }
}

/**
 * Whether a chapter is ready to be marked `final`.
 *
 * `final` means published in the SOP's model, and publishing a chapter whose
 * contract is unanswered is the mistake the checklist exists to prevent — so the
 * predicate is available even though the tool only warns.
 *
 * @param chapter - the chapter.
 * @returns the reasons it is not ready, empty when it is.
 */
export function blockersToFinal(chapter: Chapter): string[] {
  const blockers: string[] = []
  if (chapter.body.trim() === '') blockers.push('尚无正文')
  const missing = missingContract(chapter)
  if (missing.length > 0) blockers.push(`细纲契约未完成：${missing.join('、')}`)
  const report = analyzeDelivery(chapter)
  if (report.missed.length > 0) blockers.push(`上次写作未兑现：${report.missed.join('、')}`)
  if (report.length !== undefined && !report.length.within) blockers.push(report.length.note)
  return blockers
}

/**
 * The checklist a chapter should be read against before publishing.
 *
 * Compliance is deliberately **not** automated: a keyword list is not a
 * substitute for reading your own draft, and a scanner that reports "clean"
 * creates false confidence. The tool records the confirmation instead.
 *
 * @param chapter - the chapter.
 * @returns the items the author confirms.
 */
export function complianceChecklist(chapter: Chapter): { readonly key: string; readonly item: string }[] {
  return [
    { key: 'sensitive', item: `第 ${String(chapter.number)} 章：平台敏感词与违规内容自查` },
    { key: 'rating', item: `第 ${String(chapter.number)} 章：尺度符合平台分级` },
    { key: 'logic', item: `第 ${String(chapter.number)} 章：与世界规则、前文设定无冲突` },
    { key: 'paywall', item: `第 ${String(chapter.number)} 章：若在上架卡点附近，钩子强度足够` },
  ]
}

/**
 * A short, mechanical style check for the SOP's 去 AI 化 step.
 *
 * Reports countable symptoms — paragraph length, dialogue density, repeated
 * sentence openings — rather than pretending to judge voice. The author decides
 * what to do with the numbers.
 *
 * @param body - the chapter prose.
 * @returns the observations, or an empty list for an empty body.
 */
export function styleObservations(body: string): string[] {
  if (body.trim() === '') return []
  const paragraphs = body.split(/\n\s*\n/u).filter((part) => part.trim() !== '')
  const sentences = body.split(/[。！？!?…]+/u).filter((part) => part.trim() !== '')
  const observations: string[] = []
  if (paragraphs.length > 0) {
    const long = paragraphs.filter((paragraph) => countWords(paragraph) > 220).length
    if (long > 0) observations.push(`有 ${String(long)} 段超过 220 字，网文阅读节奏偏长，考虑拆分`)
    const average = countWords(body) / paragraphs.length
    if (average > 150) observations.push(`段落平均 ${String(Math.round(average))} 字，短段落化可提升代入感`)
  }
  const dialogue = (body.match(/[“”「」"]/gu)?.length ?? 0) / 2
  if (sentences.length > 0 && dialogue / sentences.length < 0.15) {
    observations.push(`对话句占比约 ${String(Math.round((dialogue / sentences.length) * 100))}%，偏低可考虑增加场景对话`)
  }
  const openings = sentences.map((sentence) => sentence.trim().slice(0, 2)).filter((head) => head.length === 2)
  const counts = new Map<string, number>()
  for (const head of openings) counts.set(head, (counts.get(head) ?? 0) + 1)
  const worst = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
  if (worst !== undefined && worst[1] >= 4 && openings.length > 0) {
    observations.push(`以「${worst[0]}」开头的句子出现 ${String(worst[1])} 次，句式重复感明显`)
  }
  return observations
}
