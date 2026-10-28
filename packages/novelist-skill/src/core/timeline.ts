/**
 * Story-time arithmetic for the 时间账本: read a chapter's `timeAnchor` and say
 * whether the chapter order and the story order agree.
 *
 * The anchor is free text (`第三日 黄昏`, `三日后`, `十年前`) because a two-hundred
 * chapter book has a fictional calendar, not a Gregorian one. Parsing it is
 * deliberately conservative: a shape this module does not recognise is reported as
 * unparsed and **removed from the chain** rather than guessed at, so an unusual
 * phrasing can never manufacture a false "第 37 章 is before 第 12 章".
 *
 * @module @ai-novelist/novelist-skill/core/timeline
 */

import type { Chapter } from './types.ts'

/** Chinese numeral digits, including the two forms of two. */
const DIGITS: Readonly<Record<string, number>> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
}

/** Chinese numeral units. */
const UNITS: Readonly<Record<string, number>> = { 十: 10, 百: 100, 千: 1000 }

/** The numeral spellings an anchor may use, as a regex fragment. */
const NUMERAL = '[0-9]+|[零〇一二两三四五六七八九十百千]+'

/**
 * Parse a numeral written as digits or as Chinese characters.
 *
 * @param text - the numeral.
 * @returns the value, or undefined when the text is not a numeral.
 */
export function parseNumeral(text: string): number | undefined {
  if (/^[0-9]+$/u.test(text)) return Number(text)
  let total = 0
  let current = 0
  let seen = false
  for (const character of text) {
    const digit = DIGITS[character]
    if (digit !== undefined) {
      current = digit
      seen = true
      continue
    }
    const unit = UNITS[character]
    if (unit === undefined) return undefined
    seen = true
    if (current === 0) current = 1
    total += current * unit
    current = 0
  }
  return seen ? total + current : undefined
}

/** What one anchor says about where the chapter sits in story time. */
export type AnchorReading =
  | { readonly kind: 'absolute'; readonly day: number }
  | { readonly kind: 'relative'; readonly days: number }
  | { readonly kind: 'flashback' }
  | { readonly kind: 'unknown' }

/** The shapes an anchor may take, most specific first. */
const ABSOLUTE = new RegExp(`第\\s*(${NUMERAL})\\s*[日天]`, 'u')
const RELATIVE_AFTER = new RegExp(`(${NUMERAL})\\s*[日天]\\s*(?:之后|以后|后)`, 'u')
const RELATIVE_BEFORE = new RegExp(`(${NUMERAL})\\s*[日天]\\s*(?:之前|以前|前)`, 'u')
const FLASHBACK = new RegExp(`(?:回忆|倒叙|闪回|(?:(?:${NUMERAL})\\s*年前))`, 'u')
const NEXT_DAY = /(?:次日|翌日|第二天|隔日)/u
const SAME_DAY = /(?:同日|当日|当天|同一天)/u
const PREVIOUS_DAY = /(?:前一日|前一天|昨夜|昨晚)/u

/**
 * Read one anchor.
 *
 * The order is not arbitrary: a flashback marker wins over everything else
 * (`十年前 第三日` is still a flashback), an absolute day wins over a relative
 * jump (`第三日，三日后` names both a position and a jump, and the position is the
 * one that can be checked), and anything unrecognised is `unknown`.
 *
 * @param anchor - the chapter's `timeAnchor`.
 * @returns what the anchor says.
 */
export function readAnchor(anchor: string): AnchorReading {
  const text = anchor.trim()
  if (text === '') return { kind: 'unknown' }
  if (FLASHBACK.test(text)) return { kind: 'flashback' }
  const absolute = ABSOLUTE.exec(text)
  if (absolute !== null) {
    const day = parseNumeral(absolute[1] ?? '')
    if (day !== undefined) return { kind: 'absolute', day }
  }
  if (NEXT_DAY.test(text)) return { kind: 'relative', days: 1 }
  if (SAME_DAY.test(text)) return { kind: 'relative', days: 0 }
  if (PREVIOUS_DAY.test(text)) return { kind: 'relative', days: -1 }
  const after = RELATIVE_AFTER.exec(text)
  if (after !== null) {
    const days = parseNumeral(after[1] ?? '')
    if (days !== undefined) return { kind: 'relative', days }
  }
  const before = RELATIVE_BEFORE.exec(text)
  if (before !== null) {
    const days = parseNumeral(before[1] ?? '')
    if (days !== undefined) return { kind: 'relative', days: -days }
  }
  return { kind: 'unknown' }
}

/** One chapter whose story day runs backwards against the chapters before it. */
export interface TimelineRegression {
  /** The chapter that goes back in time. */
  readonly chapter: number
  /** Its title, for the report. */
  readonly title: string
  /** Its anchor. */
  readonly anchor: string
  /** The latest day reached before it. */
  readonly reachedDay: number
  /** The chapter that reached that day. */
  readonly reachedBy: number
}

/** What the 时间账本 can say after reading every anchor. */
export interface TimelineReport {
  /** Chapters with an anchor this module could place in time. */
  readonly parsed: number
  /** Chapters with no anchor at all. */
  readonly missing: readonly number[]
  /** Chapters whose anchor could not be placed. */
  readonly unparsed: readonly number[]
  /** Places where story time runs backwards. */
  readonly regressions: readonly TimelineRegression[]
  /** The last day reached, for the report's summary line. */
  readonly lastDay: number | undefined
}

/**
 * Check every chapter's anchor against the chapter order.
 *
 * Flashbacks are skipped: they are a narrative choice, not a contradiction, and
 * they must not move the cursor backwards for the chapters after them. An
 * unparsed anchor is skipped the same way — the chain stays where it was, so a
 * chapter written `灵潮退去后的第二年` never claims the chapters around it drifted.
 *
 * @param chapters - the chapters, in any order.
 * @returns the report.
 */
export function timelineReport(chapters: readonly Chapter[]): TimelineReport {
  const ordered = [...chapters].sort((left, right) => left.number - right.number)
  const missing: number[] = []
  const unparsed: number[] = []
  const regressions: TimelineRegression[] = []
  let day: number | undefined
  let reachedDay = Number.NEGATIVE_INFINITY
  let reachedBy = 0
  let parsed = 0
  for (const chapter of ordered) {
    const anchor = chapter.timeAnchor.trim()
    if (anchor === '') {
      missing.push(chapter.number)
      continue
    }
    const reading = readAnchor(anchor)
    if (reading.kind === 'flashback') continue
    if (reading.kind === 'unknown') {
      unparsed.push(chapter.number)
      continue
    }
    parsed += 1
    day = reading.kind === 'absolute' ? reading.day : (day ?? 0) + reading.days
    if (day < reachedDay) {
      regressions.push({
        chapter: chapter.number,
        title: chapter.title,
        anchor,
        reachedDay,
        reachedBy,
      })
      continue
    }
    reachedDay = day
    reachedBy = chapter.number
  }
  return { parsed, missing, unparsed, regressions, lastDay: day }
}

/**
 * Render the report as the lines `novel_bible kind="review"` prints.
 *
 * Everything here is a fact about the anchors, never a verdict on the story: a
 * regression may be a deliberate flashback written without a marker, and the
 * report says which chapters to look at rather than that the book is broken.
 *
 * @param report - the report.
 * @param limit - how many regressions to name before summarising the rest.
 * @returns the lines, empty when there is nothing to say.
 */
export function timelineLines(report: TimelineReport, limit = 5): string[] {
  const lines: string[] = []
  if (report.regressions.length > 0) {
    for (const regression of report.regressions.slice(0, limit)) {
      lines.push(
        `  - 第 ${String(regression.chapter)} 章「${regression.anchor}」早于第 ${String(regression.reachedBy)} 章`
        + ` 已到的第 ${String(regression.reachedDay)} 日——是倒叙就标「回忆」，不是就改锚点`,
      )
    }
    if (report.regressions.length > limit) {
      lines.push(`  - 另有 ${String(report.regressions.length - limit)} 处逆序未列出`)
    }
  }
  if (report.missing.length > 0) {
    const named = report.missing.slice(0, 8).map((number) => `第 ${String(number)} 章`).join('、')
    lines.push(
      `  - 缺时间锚点 ${String(report.missing.length)} 章（${named}`
      + `${report.missing.length > 8 ? ' 等' : ''}）：没有锚点就查不出逆序`,
    )
  }
  if (report.unparsed.length > 0) {
    const named = report.unparsed.slice(0, 5).map((number) => `第 ${String(number)} 章`).join('、')
    lines.push(`  - 锚点无法解析 ${String(report.unparsed.length)} 章（${named}）：用「第 N 日」「N 日后」「回忆」这类写法`)
  }
  return lines
}
