/**
 * The deterministic half of 校对: typo forms that have exactly one correct
 * spelling, and punctuation shapes that are never a style choice.
 *
 * Deliberately **not** a sensitive-word list. A keyword scanner that reports
 * "clean" creates false confidence on exactly the content that gets a book taken
 * down, and platform lists change; the SOP keeps that check human. What is here is
 * the opposite kind of rule: `帐号` is wrong in every context, so reporting it can
 * never be an opinion.
 *
 * `的 / 地 / 得`, `在 / 再` used as words, and 权力 / 权利 are **not** checked:
 * telling them apart needs the sentence, and a checker that guesses would be the
 * AI-flavoured noise the rest of this module exists to avoid.
 *
 * @module @ai-novelist/novelist-skill/core/proofread
 */

/** One wrong spelling with its only correct form. */
export interface TypoRule {
  /** The form that is always wrong. */
  readonly wrong: string
  /** The form to replace it with. */
  readonly right: string
}

/**
 * Typo forms that do not depend on context.
 *
 * Each entry is a compound whose characters are settled: 帐 is the curtain, 账 is
 * the account; 侯 is the noble title, 候 is the waiting. None of these is a
 * variant spelling, which is what makes the report actionable without a second
 * reading.
 */
export const TYPO_RULES: readonly TypoRule[] = [
  { wrong: '帐号', right: '账号' },
  { wrong: '帐本', right: '账本' },
  { wrong: '帐单', right: '账单' },
  { wrong: '帐目', right: '账目' },
  { wrong: '结帐', right: '结账' },
  { wrong: '记帐', right: '记账' },
  { wrong: '对帐', right: '对账' },
  { wrong: '时侯', right: '时候' },
  { wrong: '等侯', right: '等候' },
  { wrong: '气侯', right: '气候' },
  { wrong: '侯车', right: '候车' },
  { wrong: '侯鸟', right: '候鸟' },
  { wrong: '己经', right: '已经' },
  { wrong: '自已', right: '自己' },
  { wrong: '既使', right: '即使' },
  { wrong: '既便', right: '即便' },
  { wrong: '即然', right: '既然' },
  { wrong: '竞然', right: '竟然' },
  { wrong: '必竟', right: '毕竟' },
  { wrong: '冒然', right: '贸然' },
  { wrong: '做为', right: '作为' },
  { wrong: '按装', right: '安装' },
  { wrong: '部份', right: '部分' },
  { wrong: '入场卷', right: '入场券' },
  { wrong: '好象', right: '好像' },
  { wrong: '锻练', right: '锻炼' },
  { wrong: '重迭', right: '重叠' },
  { wrong: '寒喧', right: '寒暄' },
  { wrong: '迫不急待', right: '迫不及待' },
  { wrong: '一股作气', right: '一鼓作气' },
  { wrong: '甘败下风', right: '甘拜下风' },
  { wrong: '无以伦比', right: '无与伦比' },
  { wrong: '寻物启示', right: '寻物启事' },
  { wrong: '再接再励', right: '再接再厉' },
  { wrong: '谈笑风声', right: '谈笑风生' },
  { wrong: '变本加利', right: '变本加厉' },
  { wrong: '走头无路', right: '走投无路' },
  { wrong: '一愁莫展', right: '一筹莫展' },
  { wrong: '声名雀起', right: '声名鹊起' },
  { wrong: '有持无恐', right: '有恃无恐' },
  { wrong: '按步就班', right: '按部就班' },
  { wrong: '不径而走', right: '不胫而走' },
  { wrong: '出奇不意', right: '出其不意' },
  { wrong: '额首称庆', right: '额手称庆' },
  { wrong: '鬼计多端', right: '诡计多端' },
  { wrong: '娇揉造作', right: '矫揉造作' },
  { wrong: '金榜提名', right: '金榜题名' },
  { wrong: '默守成规', right: '墨守成规' },
  { wrong: '弄巧成绌', right: '弄巧成拙' },
  { wrong: '如火如茶', right: '如火如荼' },
  { wrong: '世外桃园', right: '世外桃源' },
  { wrong: '首曲一指', right: '首屈一指' },
  { wrong: '随声附合', right: '随声附和' },
  { wrong: '挺而走险', right: '铤而走险' },
  { wrong: '完壁归赵', right: '完璧归赵' },
  { wrong: '无动于中', right: '无动于衷' },
  { wrong: '心心相映', right: '心心相印' },
  { wrong: '一诺千斤', right: '一诺千金' },
  { wrong: '异曲同功', right: '异曲同工' },
  { wrong: '语重心常', right: '语重心长' },
  { wrong: '中流抵柱', right: '中流砥柱' },
  { wrong: '蛛丝蚂迹', right: '蛛丝马迹' },
  { wrong: '脍灸人口', right: '脍炙人口' },
  { wrong: '沤心沥血', right: '呕心沥血' },
  { wrong: '病入膏盲', right: '病入膏肓' },
  { wrong: '不可明状', right: '不可名状' },
]

/** How much context a sample quotes on either side of a hit. */
const SAMPLE_CONTEXT = 6

/** How many offending samples one report quotes back. */
const SAMPLE_LIMIT = 2

/** One typo that occurs in the text. */
export interface TypoHit {
  /** The wrong form. */
  readonly wrong: string
  /** The form to use instead. */
  readonly right: string
  /** How many times it occurs. */
  readonly count: number
  /** Up to two context snippets, with the hit inside. */
  readonly samples: readonly string[]
}

/** One punctuation anomaly that occurs in the text. */
export interface PunctuationHit {
  /** A stable key, for tests and aggregation. */
  readonly key: string
  /** The label the report prints. */
  readonly label: string
  /** How many times it occurs. */
  readonly count: number
  /** Up to two context snippets. */
  readonly samples: readonly string[]
}

/** What one pass over a text found. */
export interface ProofreadResult {
  /** Typo hits, most frequent first. */
  readonly typos: readonly TypoHit[]
  /** Punctuation hits, in a fixed order. */
  readonly punctuation: readonly PunctuationHit[]
}

/** The punctuation shapes checked, in report order. */
const PUNCTUATION_RULES: readonly { readonly key: string; readonly label: string; readonly pattern: RegExp }[] = [
  { key: 'ellipsis', label: '半角省略号 ...（应为 ……）', pattern: /\.{3,}/gu },
  { key: 'double-period', label: '重复句号 。。', pattern: /。{2,}/gu },
  { key: 'double-comma', label: '重复逗号 ，，', pattern: /，{2,}/gu },
  { key: 'double-dun', label: '重复顿号 、、', pattern: /、{2,}/gu },
  { key: 'halfwidth-comma', label: '中文之间夹半角逗号 ,', pattern: /[\u3400-\u4dbf\u4e00-\u9fff],[\u3400-\u4dbf\u4e00-\u9fff]/gu },
  { key: 'halfwidth-question', label: '中文之间夹半角问号 ?', pattern: /[\u3400-\u4dbf\u4e00-\u9fff]\?[\u3400-\u4dbf\u4e00-\u9fff]/gu },
  { key: 'halfwidth-bang', label: '中文之间夹半角感叹号 !', pattern: /[\u3400-\u4dbf\u4e00-\u9fff]![\u3400-\u4dbf\u4e00-\u9fff]/gu },
]

/**
 * The context around one hit, on a single line.
 *
 * @param text - the prose.
 * @param index - where the hit starts.
 * @param length - how long the hit is.
 * @returns the snippet.
 */
function sample(text: string, index: number, length: number): string {
  const start = Math.max(0, index - SAMPLE_CONTEXT)
  const end = Math.min(text.length, index + length + SAMPLE_CONTEXT)
  return text.slice(start, end).replace(/\s+/gu, ' ').trim()
}

/**
 * Count the context-free typos in a text.
 *
 * @param text - the prose.
 * @returns one hit per rule that fired, most frequent first.
 */
export function typoHits(text: string): TypoHit[] {
  const hits: TypoHit[] = []
  for (const rule of TYPO_RULES) {
    let count = 0
    const samples: string[] = []
    let from = 0
    for (;;) {
      const index = text.indexOf(rule.wrong, from)
      if (index < 0) break
      count += 1
      if (samples.length < SAMPLE_LIMIT) samples.push(sample(text, index, rule.wrong.length))
      from = index + rule.wrong.length
    }
    if (count > 0) hits.push({ wrong: rule.wrong, right: rule.right, count, samples })
  }
  return hits.sort((left, right) => right.count - left.count)
}

/**
 * Count the punctuation anomalies in a text.
 *
 * @param text - the prose.
 * @returns one hit per rule that fired, in report order.
 */
export function punctuationHits(text: string): PunctuationHit[] {
  const hits: PunctuationHit[] = []
  for (const rule of PUNCTUATION_RULES) {
    const matches = [...text.matchAll(new RegExp(rule.pattern.source, rule.pattern.flags))]
    if (matches.length === 0) continue
    hits.push({
      key: rule.key,
      label: rule.label,
      count: matches.length,
      samples: matches.slice(0, SAMPLE_LIMIT).map((match) => sample(text, match.index, match[0].length)),
    })
  }
  return hits
}

/**
 * Run both passes.
 *
 * @param text - the prose.
 * @returns the result.
 */
export function proofread(text: string): ProofreadResult {
  return { typos: typoHits(text), punctuation: punctuationHits(text) }
}

/**
 * Whether a result found anything.
 *
 * @param result - the result.
 * @returns true when either pass fired.
 */
export function hasProofreadingFindings(result: ProofreadResult): boolean {
  return result.typos.length > 0 || result.punctuation.length > 0
}

/**
 * Render one chapter's findings as report lines.
 *
 * The wording keeps the same contract as the 去 AI 化 statistics: a count and the
 * thing counted, never a claim that the prose is clean or dirty. Zero findings
 * prints nothing, so a clean chapter does not grow a "校对通过" line that would
 * be read as a guarantee.
 *
 * @param text - the prose.
 * @param limit - how many rules to name per pass.
 * @returns the lines.
 */
export function proofreadLines(text: string, limit = 4): string[] {
  const result = proofread(text)
  const lines: string[] = []
  if (result.typos.length > 0) {
    const total = result.typos.reduce((sum, hit) => sum + hit.count, 0)
    const named = result.typos
      .slice(0, limit)
      .map((hit) => `「${hit.wrong}」→「${hit.right}」×${String(hit.count)}`)
      .join('；')
    lines.push(
      `校对：疑似错别字 ${String(total)} 处——${named}`
      + `${result.typos.length > limit ? `；另 ${String(result.typos.length - limit)} 类` : ''}`
      + '（确定性规则，可整批替换）',
    )
  }
  if (result.punctuation.length > 0) {
    const total = result.punctuation.reduce((sum, hit) => sum + hit.count, 0)
    lines.push(
      `标点：${String(total)} 处异常——${result.punctuation.map((hit) => `${hit.label}×${String(hit.count)}`).join('；')}`,
    )
  }
  return lines
}
