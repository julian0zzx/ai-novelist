/**
 * Pure contract-delivery checks: did the prose pay for the plan?
 *
 * The SOP requires prose to answer its chapter outline field by field, and
 * version 3.0 had no way to notice when it did not. These functions produce the
 * report `novel_write` returns: which contract fields the draft reached, which
 * were missed, which the author waived, and whether the length landed — against
 * the draft gate a first draft is written to (125%), or the finished gate a chapter is
 * published at (-5%/+15%), depending on the chapter's own stage.
 *
 * Nothing here judges prose quality — that is the author's job, and the SOP says
 * so. It only compares what was promised with what was written.
 *
 * @module @ai-novelist/novelist-skill/core/write
 */

import { countWords } from './novel.ts'
import {
  contractRows,
  lengthCheck,
  lengthStageFor,
  missingContract,
  spaceTimeGaps,
  spaceTimeLabel,
  type LengthCheck,
} from './plan.ts'
import { CONTRACT_FIELDS, type Chapter, type ContractField, type SpaceTimeField } from './types.ts'

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
  /**
   * Time/place anchors the contract never answered.
   *
   * Reported beside the contract fields rather than as part of them: these are
   * the traditional 六要素's 时间 and 地点, and a chapter planned before they
   * existed must not read as "contract incomplete" because of them.
   */
  readonly spaceTimeMissing: readonly SpaceTimeField[]
  /** The gate that binds at the chapter's current lifecycle stage. */
  readonly length: LengthCheck | undefined
  /** The first-draft comparison (125%), whenever a target and prose exist. */
  readonly draftLength: LengthCheck | undefined
  /** The finished-chapter comparison (-5%/+15%), which `final` is judged against. */
  readonly finalLength: LengthCheck | undefined
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
  const spaceTimeMissing = spaceTimeGaps(chapter)
  // Both gates are reported; which one binds is the chapter's own lifecycle
  // stage, so a first draft is held to the draft target and a trimmed chapter to the finished
  // window (-5%/+15%).
  const draftLength = lengthCheck(chapter, { stage: 'draft' })
  const finalLength = lengthCheck(chapter, { stage: 'final' })
  const length = lengthStageFor(chapter.status) === 'draft' ? draftLength : finalLength

  const parts: string[] = [`已兑现 ${String(reached.length)}/${String(CONTRACT_FIELDS.length)} 项契约`]
  if (missed.length > 0) parts.push(`未兑现：${missed.join('、')}`)
  if (unplanned.length > 0) parts.push(`细纲未写：${unplanned.join('、')}`)
  if (spaceTimeMissing.length > 0) parts.push(`缺时空锚点：${spaceTimeLabel(spaceTimeMissing)}`)
  if (length !== undefined && !length.within) parts.push(length.short)

  return {
    id: chapter.id,
    number: chapter.number,
    fields,
    unplanned,
    missed,
    reached,
    spaceTimeMissing,
    length,
    draftLength,
    finalLength,
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
  // Publishing is the finished-chapter gate: never more than 5% under the target
  // the user gave, up to 15% over — not the 125% a first draft is written to.
  if (report.finalLength !== undefined && !report.finalLength.within) blockers.push(report.finalLength.note)
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

/** How far apart the two halves of a contrast frame may sit, in characters. */
const CONTRAST_GAP = 24

/**
 * The contrastive sentence shapes that read as machine-written.
 *
 * 「不是 A，是 B」 and 「是 A，不是 B」 are the most recognisable AI tells in Chinese
 * web-novel prose: the correction frame sounds like an argument being made rather
 * than a scene being shown, and a model reaching for emphasis produces it several
 * times a chapter with the same rhythm every time. They are *countable*, which is
 * the point of listing them here rather than leaving them to a judge: the four
 * statistical checks above cannot see them (they are neither long paragraphs nor
 * repeated openings — the sentence heads differ), so a chapter can be full of the
 * pattern and pass every other rule on this list.
 *
 * Two readings per entry: the label the report uses, and the pattern. The gap
 * between the two halves is capped at {@link CONTRAST_GAP} characters so a "不是"
 * in one sentence and a "是" three sentences later is not counted as one device —
 * the frame only reads as a frame when the two halves sit in one breath. The list
 * is ordered most specific first, and a match consumes its span (see
 * {@link contrastFrames}), because 「不是钱，而是名单」 is one device, not one
 * 「不是……而是……」 plus one 「不是……是……」.
 */
export const CONTRAST_PATTERNS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: '与其说……不如说……', pattern: new RegExp(`与其说[^。！？!?\\n]{0,${String(CONTRAST_GAP)}}?不如说`, 'gu') },
  { label: '不是……而是……', pattern: new RegExp(`不是[^。！？!?\\n]{0,${String(CONTRAST_GAP)}}?而是`, 'gu') },
  { label: '不是……是……', pattern: new RegExp(`不是[^。！？!?\\n]{0,${String(CONTRAST_GAP)}}?[，,][^。！？!?\\n]{0,12}?是`, 'gu') },
  { label: '是……不是……', pattern: new RegExp(`是[^。！？!?\\n]{0,${String(CONTRAST_GAP)}}?[，,][^。！？!?\\n]{0,12}?不是`, 'gu') },
]

/**
 * How many times the contrast frame has to repeat before the report names it.
 *
 * One is a sentence an author may have wanted; two is the same device twice, which
 * is where a chapter starts sounding like it was written by one process rather than
 * by a person. The floor is deliberately this low because this pattern is the
 * symptom the SOP's 去 AI 化 step most often misses — the four statistical checks
 * cannot see it at all.
 */
const CONTRAST_REPEAT_FLOOR = 2

/** How many offending fragments the report quotes back, per report. */
const CONTRAST_QUOTES = 2

/** The window a per-thousand rate is measured over. */
const RATE_WINDOW = 1000

/**
 * The Chinese simile markers — the words a draft reaches for when it wants a
 * sentence to sound literary.
 *
 * 「像」 is guarded with a look-behind because the same character sits inside
 * 图像 / 想象 / 影像 / 录像 / 偶像 / 雕像 / 塑像 — counting those as similes would
 * report a density problem on a chapter that has none. The bare 「似」 is not a
 * marker on its own: 似乎 / 相似 / 类似 are ordinary words, so only the bound forms
 * (似的 / 好似 / 恰似 …) are listed.
 *
 * A simile is not an error. Three in one paragraph, or four in a thousand
 * characters, is the point where comparisons stop carrying an image and start
 * carrying the writer's nervousness — the same threshold the craft sheets use.
 */
const SIMILE_MARKERS = /(?<![图想影录偶雕像塑画])像|宛如|仿佛|如同|好似|犹如|恍若|恰似|似的/gu

/** How many similes in one paragraph read as a pile-up rather than a comparison. */
const SIMILE_PILE_UP = 3

/** 经验值: more than this many similes per thousand characters is clutter. */
const SIMILE_RATE_CEILING = 3

/**
 * The words that carry intensity instead of showing it.
 *
 * 非常 / 极其 / 瞬间 / 顿时 are the adverbs a model reaches for when a sentence
 * needs to feel bigger without doing any work: they raise the volume and leave the
 * picture empty. Counted rather than judged — a chapter may legitimately be loud.
 */
const INTENSIFIERS = /非常|极其|极度|无比|异常|格外|分外|十分|瞬间|顿时|立刻|猛地|猛然|骤然|刹那|一瞬/gu

/** 经验值: more than this many intensifiers per thousand characters. */
const INTENSIFIER_RATE_CEILING = 3

/**
 * The stock phrases that recur across drafts, whatever the book.
 *
 * `styleObservations` also checks the author's own 负面清单; this list is the
 * generic floor underneath it, taken from the same symptoms the craft sheets name
 * — the pupil-contraction and cold-sweat reactions, and the summary sentences that
 * tell the reader what to feel. Repeating one of these twice in a chapter is the
 * moment a personal tic becomes a machine tic, so the floor is two, not three.
 * Ordinary connectives (然而 / 与此同时) are deliberately absent: they occur in
 * human prose at a rate where counting them would only create noise.
 */
export const STOCK_PHRASES: readonly string[] = [
  '瞳孔一缩',
  '瞳孔骤缩',
  '嘴角勾起',
  '嘴角微微上扬',
  '心中一凛',
  '心头一震',
  '倒吸一口凉气',
  '冷汗直流',
  '眼中闪过一抹',
  '眼中闪过一丝',
  '不自觉地',
  '不由自主',
  '命运的齿轮',
  '一切才刚刚开始',
  '他不知道的是',
  '五味杂陈',
  '若有所思',
]

/** How many times one stock phrase has to recur before the report names it. */
const STOCK_REPEAT_FLOOR = 2

/** A paragraph needs this many sentences before "all the same length" means anything. */
const EVEN_PARAGRAPH_FLOOR = 4

/** Longest ÷ shortest below this reads as "every sentence is the same size". */
const EVEN_RATIO = 2

/** How many even paragraphs before the report calls the chapter flat. */
const EVEN_PARAGRAPH_SCAN = 2

/** A sentence this short is the 碎句 that gives a paragraph its rhythm. */
const SHORT_SENTENCE = 8

/** Below this share of short sentences, a chapter reads as one even wall. */
const SHORT_SENTENCE_SHARE = 0.05

/** A chapter needs this many sentences before "no short sentences" is worth saying. */
const SHORT_SENTENCE_FLOOR = 20

/**
 * The contrast frames a body uses, by label, largest count first.
 *
 * A span already claimed by a more specific frame is not counted again, so one
 * 「不是钱，而是名单」 reads as one device rather than two. The consumed ranges also
 * keep a single long frame from being double-counted by the narrower patterns that
 * sit inside it.
 *
 * @param body - the prose.
 * @returns one entry per frame that fired, with its hits.
 */
export function contrastFrames(body: string): { readonly label: string; readonly hits: readonly string[] }[] {
  let claimedUntil = -1
  const found: { readonly label: string; readonly hits: string[] }[] = []
  for (const entry of CONTRAST_PATTERNS) {
    const hits: string[] = []
    const scan = new RegExp(entry.pattern.source, entry.pattern.flags)
    for (const match of body.matchAll(scan)) {
      const start = match.index
      // `matchAll` walks left to right, so a match starting before everything
      // claimed so far is the only overlap there can be.
      if (start < claimedUntil) continue
      claimedUntil = start + match[0].length
      hits.push(match[0].replace(/\s+/gu, ' ').trim())
    }
    if (hits.length > 0) found.push({ label: entry.label, hits })
  }
  return found.sort((left, right) => right.hits.length - left.hits.length)
}

/**
 * A short, mechanical style check for the SOP's 去 AI 化 step.
 *
 * Reports countable symptoms — paragraph length, dialogue density, repeated
 * sentence openings, sentence-length swing, simile pile-up and density, intensifier
 * density, repeated stock phrases, the contrast frame, and the author's own
 * forbidden phrases — rather than pretending to judge voice. The author decides
 * what to do with the numbers. Everything reported here is a *number with a
 * quote*, so a writer can act on it without a second call; nothing here calls prose
 * good or bad.
 *
 * @param body - the chapter prose.
 * @param taboos - the book's 负面清单, split into phrases; entries found in the
 * body are reported by name. Empty when the outline has not written one.
 * @returns the observations, or an empty list for an empty body.
 */
export function styleObservations(body: string, taboos: readonly string[] = []): string[] {
  if (body.trim() === '') return []
  const paragraphs = body.split(/\n\s*\n/u).filter((part) => part.trim() !== '')
  // Chinese terminators, or the ASCII ones an English draft uses. Without the
  // ASCII half an 出海 chapter reads as one enormous sentence, and every sentence
  // statistic below becomes meaningless on exactly the drafts that need them.
  // The look-behind keeps "3.5" and "Mr." out of it where a space is missing.
  const sentences = body.split(/[。！？!?…]+|(?<=[.!?])\s+/u).filter((part) => part.trim() !== '')
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
  // Sentence length is the readability half of a chapter's rhythm: a wall of
  // 60-character sentences reads slowly even when every paragraph is short.
  // Reported as a count and a mean, never as a verdict — a deliberately long
  // sentence is a legitimate choice.
  if (sentences.length > 0) {
    const long = sentences.filter((sentence) => countWords(sentence) > 60).length
    if (long > 0) {
      observations.push(`有 ${String(long)} 句超过 60 字，长句会拖慢阅读节奏，考虑在动作或情绪拐点断句`)
    }
    const averageSentence = countWords(body) / sentences.length
    if (averageSentence > 40) {
      observations.push(`平均句长 ${String(Math.round(averageSentence))} 字，偏书面；网文语感多用 15–30 字的短句推进`)
    }
  }
  // Four more symptoms, in the order a reader feels them: too many comparisons,
  // no sentence ever short, every sentence the same size, the same stock reaction
  // twice. Each is a count with its 经验值 attached, so the author can argue with
  // the number instead of guessing at the impression.
  const characters = countWords(body)
  const similes = [...body.matchAll(SIMILE_MARKERS)].length
  const piled = paragraphs.filter((part) => [...part.matchAll(SIMILE_MARKERS)].length >= SIMILE_PILE_UP).length
  if (piled > 0) {
    observations.push(
      `有 ${String(piled)} 段出现 ${String(SIMILE_PILE_UP)} 处以上比喻词，比喻连用会显得堆砌，一段留一个最准的`,
    )
  }
  // Density on a fragment is not a density: a 100-character snippet with one
  // simile would read as 10 per thousand and mean nothing.
  if (characters >= 300) {
    const simileRate = (similes * RATE_WINDOW) / characters
    if (simileRate > SIMILE_RATE_CEILING) {
      observations.push(
        `比喻 ${String(similes)} 处（约 ${simileRate.toFixed(1)} 处/千字），高于经验值 `
        + `${String(SIMILE_RATE_CEILING)} 处/千字，删掉一半只留最准的那个`,
      )
    }
  }
  const even = paragraphs.filter((part) => {
    const lengths = part.split(/[。！？!?…]+/u).map((sentence) => countWords(sentence)).filter((length) => length > 0)
    if (lengths.length < EVEN_PARAGRAPH_FLOOR) return false
    const shortest = Math.min(...lengths)
    const longest = Math.max(...lengths)
    return shortest > 0 && longest / shortest < EVEN_RATIO
  }).length
  if (even >= EVEN_PARAGRAPH_SCAN) {
    observations.push(
      `有 ${String(even)} 段句长几乎等长（最长不到最短的 ${String(EVEN_RATIO)} 倍），节奏偏平，拆一句短的出来`,
    )
  }
  const short = sentences.filter((sentence) => countWords(sentence) <= SHORT_SENTENCE).length
  if (sentences.length >= SHORT_SENTENCE_FLOOR && short / sentences.length < SHORT_SENTENCE_SHARE) {
    observations.push(
      `全章 ${String(sentences.length)} 句里只有 ${String(short)} 句在 ${String(SHORT_SENTENCE)} 字以内，缺少碎句节奏`,
    )
  }
  if (characters >= 300) {
    const intensifiers = [...body.matchAll(INTENSIFIERS)].length
    const intensifierRate = (intensifiers * RATE_WINDOW) / characters
    if (intensifierRate > INTENSIFIER_RATE_CEILING) {
      observations.push(
        `极端词 ${String(intensifiers)} 处（约 ${intensifierRate.toFixed(1)} 处/千字），高于经验值 `
        + `${String(INTENSIFIER_RATE_CEILING)} 处/千字，删九成，改由动作承担强度`,
      )
    }
  }
  const stock = STOCK_PHRASES
    .map((phrase) => ({ phrase, count: body.split(phrase).length - 1 }))
    .filter((entry) => entry.count >= STOCK_REPEAT_FLOOR)
    .sort((left, right) => right.count - left.count)
  if (stock.length > 0) {
    observations.push(
      `重复套话：${stock.map((entry) => `「${entry.phrase}」${String(entry.count)} 次`).join('、')}`
      + '——同一章里每样最多用一次',
    )
  }
  // The contrast frame and the author's own forbidden phrases are reported after
  // the four thresholds, so the fixed order stays the order the SOP lists.
  const frames = contrastFrames(body)
  const repeated = frames.filter((frame) => frame.hits.length >= CONTRAST_REPEAT_FLOOR)
  if (repeated.length > 0) {
    const total = repeated.reduce((sum, frame) => sum + frame.hits.length, 0)
    const quotes = repeated
      .flatMap((frame) => frame.hits)
      .slice(0, CONTRAST_QUOTES)
      .map((hit) => `「${hit}」`)
      .join('')
    // The header names the device that fired, not a fixed one: a chapter whose only
    // frames are 「不是……而是……」 must not be told it is full of 「不是……是……」.
    const headline = repeated.length === 1
      ? `「${repeated[0]?.label ?? ''}」对举句式共 ${String(total)} 处`
      : `对举句式共 ${String(total)} 处`
        + `（${repeated.map((frame) => `${frame.label} ${String(frame.hits.length)}`).join('，')}）`
    observations.push(
      `${headline}：${quotes}——这是最典型的 AI 味句式，改写成动作、画面或直接陈述`,
    )
  }
  const banned = taboos.map((taboo) => taboo.trim()).filter((taboo) => taboo !== '')
  const used = banned.filter((taboo) => body.includes(taboo))
  if (used.length > 0) {
    observations.push(
      `命中本书《写作风格》负面清单 ${String(used.length)} 条：${used.map((taboo) => `「${taboo}」`).join('、')}`
      + '——负面清单是这本书明令禁止的写法，逐条清掉',
    )
  }
  return observations
}
