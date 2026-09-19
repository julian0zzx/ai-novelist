import { describe, expect, it } from 'vitest'
import {
  LENGTH_BENCHMARKS,
  WRITING_PLAN_QUESTIONS,
  chaptersPerVolume,
  derivedTotalChapters,
  describeWritingPlan,
  emptyWriting,
  normalizeWritingPlan,
  rhythmExpectation,
  volumeLengthNote,
  writingPlanConflicts,
  writingPlanGaps,
} from '../src/core/index.ts'

/**
 * The length plan: the four questions asked at initialization, what the two
 * derivable answers imply, and where the answers contradict each other.
 *
 * The SOP's whole point in recording these numbers is that a chapter length is
 * checkable only against a stated target, so the interesting cases are the ones
 * where a number is missing, implied, or inconsistent with the others.
 */
describe('the writing plan questions', () => {
  it('asks three questions that settle four things', () => {
    // 是否分卷 and 分几卷 are one answer: `volumes: 0` is the explicit 不分卷.
    expect(WRITING_PLAN_QUESTIONS.map((question) => question.key)).toEqual(['targetWords', 'chapterWords', 'volumes'])
  })

  it('offers the common tiers as choices, with each tier internally consistent', () => {
    expect(LENGTH_BENCHMARKS.length).toBeGreaterThanOrEqual(3)
    for (const tier of LENGTH_BENCHMARKS) {
      expect(tier.targetWords).not.toBe('')
      expect(tier.chapterWords).not.toBe('')
      expect(tier.volumes).not.toBe('')
    }
  })

  it('reports every unanswered question on a fresh plan', () => {
    const gaps = writingPlanGaps(emptyWriting())
    expect(gaps.map((gap) => gap.key)).toEqual(['targetWords', 'chapterWords', 'volumes'])
  })

  it('treats an explicit "不分卷" (volumes 0) as an answer, not a missing one', () => {
    const writing = { ...emptyWriting(), targetWords: 300000, chapterWords: 2000, volumes: 0 }
    expect(writingPlanGaps(writing)).toEqual([])
    expect(describeWritingPlan(writing)).toContain('不分卷')
  })

  it('renders an unanswered plan differently from a settled one', () => {
    expect(describeWritingPlan(emptyWriting())).toBe('总字数未问 · 单章字数未问 · 是否分卷未问')
    const answered = { ...emptyWriting(), targetWords: 1200000, chapterWords: 3000, volumes: 12, totalChapters: 400 }
    expect(describeWritingPlan(answered)).toBe('总字数 1200000 · 单章 3000 字 · 12 卷 · 共约 400 章')
  })
})

describe('deriving what the answers imply', () => {
  it('derives the chapter count from total length ÷ chapter length', () => {
    expect(derivedTotalChapters(1200000, 3000)).toBe(400)
    expect(derivedTotalChapters(1000000, 3000)).toBe(333)
    // Nothing to derive from a missing number: an unanswered question stays open.
    expect(derivedTotalChapters(0, 3000)).toBe(0)
    expect(derivedTotalChapters(1000000, 0)).toBe(0)
  })

  it('derives chapters per volume, with 0 volumes meaning one volume', () => {
    expect(chaptersPerVolume(400, 10)).toBe(40)
    expect(chaptersPerVolume(400, 0)).toBe(400)
    expect(chaptersPerVolume(400, -1)).toBe(0)
    expect(chaptersPerVolume(0, 10)).toBe(0)
  })

  it('fills the chapter count without overriding a stated one', () => {
    const derived = normalizeWritingPlan({ ...emptyWriting(), targetWords: 1200000, chapterWords: 3000 })
    expect(derived.totalChapters).toBe(400)

    const stated = normalizeWritingPlan({ ...emptyWriting(), targetWords: 1200000, chapterWords: 3000, totalChapters: 350 })
    expect(stated.totalChapters).toBe(350)
  })

  it('derives volumes only from an explicit chapters-per-volume answer', () => {
    const base = { ...emptyWriting(), targetWords: 1200000, chapterWords: 3000 }
    expect(normalizeWritingPlan(base).volumes).toBe(-1)
    expect(normalizeWritingPlan(base, { chaptersPerVolume: 40 }).volumes).toBe(10)
    // A stated volume count wins over a derived one.
    expect(normalizeWritingPlan({ ...base, volumes: 12 }, { chaptersPerVolume: 40 }).volumes).toBe(12)
  })
})

describe('contradictions between the length numbers', () => {
  it('stays silent when the three numbers roughly agree', () => {
    expect(writingPlanConflicts({ ...emptyWriting(), targetWords: 1200000, chapterWords: 3000, totalChapters: 400 })).toEqual([])
  })

  it('reports a chapter count that contradicts the lengths', () => {
    const notes = writingPlanConflicts({ ...emptyWriting(), targetWords: 1000000, chapterWords: 3000, totalChapters: 100 })
    expect(notes.join(' ')).toMatch(/相差 70%/)
  })

  it('reports more volumes than chapters', () => {
    const notes = writingPlanConflicts({ ...emptyWriting(), totalChapters: 3, volumes: 5 })
    expect(notes.join(' ')).toMatch(/每卷至少要有一章/)
  })
})

describe('volume length and rhythm', () => {
  it('compares one volume span with the planned volume length', () => {
    const writing = { ...emptyWriting(), targetWords: 400000, chapterWords: 2000, totalChapters: 200, volumes: 5 }
    expect(volumeLengthNote(40, writing)).toBeUndefined()
    expect(volumeLengthNote(10, writing)).toMatch(/每卷约 40 章/)
    // With no plan to compare against, there is nothing to say.
    expect(volumeLengthNote(10, emptyWriting())).toBeUndefined()
  })

  it('expects a climax at the rhythm positions the SOP names, routine elsewhere', () => {
    expect(rhythmExpectation(3, 40)).toBe('小高潮')
    expect(rhythmExpectation(10, 40)).toBe('中高潮')
    expect(rhythmExpectation(40, 40)).toBe('卷末大高潮 + 卷末钩子')
    expect(rhythmExpectation(7, 40)).toBeUndefined()
  })
})
