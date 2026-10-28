import { describe, expect, it } from 'vitest'
import { hasProofreadingFindings, proofread, proofreadLines, punctuationHits, typoHits } from '../src/core/index.ts'

/**
 * The deterministic half of 校对, pinned rule by rule.
 *
 * The specs below exist to keep the checker from drifting into two failures: a
 * rule that fires on correct prose (which trains the author to ignore it) and a
 * rule that silently disappears (which is the typo shipping).
 */
describe('typoHits', () => {
  it('names the only correct spelling for a wrong form', () => {
    const hits = typoHits('他的帐号时侯到了，自已还没发现。')
    expect(hits.map((hit) => [hit.wrong, hit.right])).toEqual([
      ['帐号', '账号'],
      ['时侯', '时候'],
      ['自已', '自己'],
    ].sort((left, right) => (left[0] ?? '').localeCompare(right[0] ?? '')) as [string, string][])
  })

  it('says nothing about the correct forms', () => {
    expect(typoHits('他的账号到时候了，自己还没发现。')).toEqual([])
  })

  it('quotes the context so the hit can be found', () => {
    const [hit] = typoHits('门开了一条缝，他把帐号写在纸上。')
    expect(hit?.samples[0]).toContain('帐号')
    expect(hit?.count).toBe(1)
  })

  it('counts every occurrence of the same form', () => {
    expect(typoHits('帐号、帐号、帐号')[0]?.count).toBe(3)
  })

  it('does not touch 的 / 地 / 得, which need the sentence', () => {
    // Those three are intentionally out of scope: a guesser here would produce the
    // noise the rest of the checker avoids.
    expect(typoHits('他慢慢地走，走得很快，红色的旗子。')).toEqual([])
  })
})

describe('punctuationHits', () => {
  it('flags the shapes that are never a style choice', () => {
    expect(punctuationHits('他走了...')[0]?.key).toBe('ellipsis')
    expect(punctuationHits('他说。。')[0]?.key).toBe('double-period')
    expect(punctuationHits('好,坏')[0]?.key).toBe('halfwidth-comma')
  })

  it('accepts the correct Chinese forms', () => {
    expect(punctuationHits('他走了……她说，好。')).toEqual([])
  })
})

describe('proofreadLines', () => {
  it('prints nothing for clean prose, and never a "passed" line', () => {
    expect(proofreadLines('他走进山门，天还没亮。')).toEqual([])
  })

  it('reports a count and the rules that fired', () => {
    const lines = proofreadLines('帐号时侯，他说...')
    expect(lines[0]).toContain('校对：疑似错别字 2 处')
    expect(lines[0]).toContain('「帐号」→「账号」×1')
    expect(lines[1]).toContain('标点：')
    expect(lines[1]).toContain('半角省略号')
  })

  it('exposes whether anything fired, for aggregators', () => {
    expect(hasProofreadingFindings(proofread('帐号'))).toBe(true)
    expect(hasProofreadingFindings(proofread('账号'))).toBe(false)
  })
})
