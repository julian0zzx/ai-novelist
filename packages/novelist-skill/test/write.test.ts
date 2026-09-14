import { describe, expect, it } from 'vitest'
import { styleObservations } from '../src/core/index.ts'

/**
 * The 去 AI 化 statistics, pinned threshold by threshold.
 *
 * `novel_write` prints these on every draft, so a boundary that drifts either
 * floods the author with noise or hides the symptom the SOP step exists to
 * catch. Each constant here belongs to the SOP, not to the implementation — the
 * same reason the metric multipliers carry their own spec.
 */

/** One paragraph of exactly `n` Chinese characters (each counts as one word). */
const paragraph = (n: number, head = '山'): string => head.repeat(n)

/**
 * A body of `count` sentences, the first `quoted` of which carry one dialogue
 * pair. Sentence heads are all distinct, so only the dialogue ratio varies.
 *
 * @param count - how many sentences.
 * @param quoted - how many sentences contain a quoted line.
 * @returns the prose.
 */
function sentences(count: number, quoted: number): string {
  const heads = '一二三四五六七八九十百千万亿兆京垓秭穰沟涧正载极'.split('')
  return heads
    .slice(0, count)
    .map((head, index) => `${head}道${index < quoted ? '「甲」' : '山门'}`)
    .join('。')
}

/** `count` sentences that all open with the same two characters. */
const repeated = (count: number): string =>
  Array.from({ length: count }, () => '他看向山门').join('。')

describe('styleObservations', () => {
  it('says nothing about an empty or whitespace-only body', () => {
    expect(styleObservations('')).toEqual([])
    expect(styleObservations('   \n\n  ')).toEqual([])
  })

  it('says nothing about prose that has no symptom to report', () => {
    // 20 sentences, 3 of them dialogue: exactly 15% dialogue, no long paragraph,
    // no repeated opening, average paragraph length far below 150.
    expect(styleObservations(sentences(20, 3))).toEqual([])
  })

  it('counts paragraphs over 220 characters, and not one at exactly 220', () => {
    expect(styleObservations(paragraph(221))).toContain('有 1 段超过 220 字，网文阅读节奏偏长，考虑拆分')
    expect(styleObservations(paragraph(220)).join(' ')).not.toContain('超过 220 字')
  })

  it('reports the average paragraph length only above 150 characters', () => {
    const two = (n: number): string => `${paragraph(n, '甲')}\n\n${paragraph(n, '乙')}`
    expect(styleObservations(two(151))).toContain('段落平均 151 字，短段落化可提升代入感')
    expect(styleObservations(two(150)).join(' ')).not.toContain('段落平均')
  })

  it('reports dialogue density below 15% of sentences', () => {
    expect(styleObservations(sentences(20, 2))).toContain('对话句占比约 10%，偏低可考虑增加场景对话')
    // 3/20 = 15% is the boundary the rule does not fire on, asserted above.
    expect(styleObservations(sentences(20, 3)).join(' ')).not.toContain('对话句占比')
  })

  it('reports a repeated sentence opening from the fourth occurrence', () => {
    expect(styleObservations(repeated(4))).toContain('以「他看」开头的句子出现 4 次，句式重复感明显')
    expect(styleObservations(repeated(3)).join(' ')).not.toContain('句式重复感')
  })

  it('reports every symptom it finds, in a fixed order', () => {
    // Four sentences, each one long enough to make the single paragraph exceed
    // 220 characters, all opening with the same two characters, no dialogue:
    // all four statistics apply at once.
    const sentence = `他看向${paragraph(221)}`
    const body = Array.from({ length: 4 }, () => sentence).join('。')
    expect(styleObservations(body)).toEqual([
      '有 1 段超过 220 字，网文阅读节奏偏长，考虑拆分',
      `段落平均 ${String(sentence.length * 4)} 字，短段落化可提升代入感`,
      '对话句占比约 0%，偏低可考虑增加场景对话',
      '以「他看」开头的句子出现 4 次，句式重复感明显',
    ])
  })
})
