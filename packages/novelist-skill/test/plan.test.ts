import { describe, expect, it } from 'vitest'
import {
  DRAFT_TARGET_RATIO,
  LENGTH_BENCHMARKS,
  LENGTH_TOLERANCE,
  WRITING_PLAN_QUESTIONS,
  chaptersPerVolume,
  countWords,
  derivedTotalChapters,
  describeWritingPlan,
  draftTargetWords,
  emptyWriting,
  lengthCheck,
  lengthStageFor,
  lengthToleranceLabel,
  lengthWindow,
  normalizeWritingPlan,
  rhythmExpectation,
  volumeLengthNote,
  writingPlanConflicts,
  writingPlanGaps,
} from '../src/core/index.ts'
import type { Chapter, ChapterStatus } from '../src/core/types.ts'

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
    expect(describeWritingPlan(answered)).toBe(
      '总字数 1200000 · 单章 3000 字 · 12 卷 · 共约 400 章 · 初稿按 4500 字/章（150%）',
    )
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

/**
 * The two length gates: a first draft is written long, the finished chapter is
 * published on target.
 *
 * Editing a web-novel chapter is mostly cutting, so a draft written to the
 * finished target comes out short. The 150% draft gate exists to absorb that,
 * and the finished gate is what the chapter length the user gave actually means:
 * -5%/+15%, asymmetric because falling under the promised length is the failure
 * while an overrun can still be cut. These specs pin both gates, their edges,
 * and the boundary between them.
 */
describe('the two length gates', () => {
  /** Prose of exactly `characters` CJK characters, which {@link countWords} counts one for one. */
  const body = (characters: number): string => '甲'.repeat(characters)

  /**
   * A chapter carrying only what the length gates read.
   *
   * @param status - the lifecycle stage.
   * @param targetWords - the finished target.
   * @param characters - how much prose it holds.
   * @returns the chapter.
   */
  const chapter = (status: ChapterStatus, targetWords: number, characters: number): Chapter => ({
    id: 'chapter-1',
    number: 1,
    title: '',
    synopsis: '',
    status,
    body: body(characters),
    wordCount: countWords(body(characters)),
    updatedAt: '2026-01-01T00:00:00.000Z',
    volume: 0,
    plotTask: '',
    conflict: '',
    emotionalPayoff: '',
    infoGap: '',
    beats: [],
    hook: '',
    targetWords,
    waived: {},
    delivered: [],
  })

  it('derives the first draft from the finished target, at 150%', () => {
    expect(DRAFT_TARGET_RATIO).toBe(1.5)
    expect(draftTargetWords(3000)).toBe(4500)
    expect(draftTargetWords(2500)).toBe(3750)
    // Rounded, because half a character is not a length anyone can write to.
    expect(draftTargetWords(2333)).toBe(3500)
    // No target, no draft line: an unanswered question stays unanswered.
    expect(draftTargetWords(0)).toBe(0)
  })

  it('gates planned and drafting chapters on the draft, revised and final on the finished target', () => {
    expect(lengthStageFor('planned')).toBe('draft')
    expect(lengthStageFor('drafting')).toBe('draft')
    expect(lengthStageFor('revised')).toBe('final')
    expect(lengthStageFor('final')).toBe('final')
  })

  it('passes a 4400-character first draft it would fail as a finished chapter', () => {
    const draft = chapter('drafting', 3000, 4400)
    const check = lengthCheck(draft)
    expect(check?.stage).toBe('draft')
    expect(check?.target).toBe(4500)
    expect(check?.within).toBe(true)
    expect(check?.note).toContain('150%')
    // The same prose misses the finished window: that gap is the room 去 AI 化
    // and hand-cutting are supposed to consume.
    expect(lengthCheck(draft, { stage: 'final' })?.within).toBe(false)
  })

  it('calls a draft written to the finished target short, in the gate’s own words', () => {
    const check = lengthCheck(chapter('drafting', 3000, 3000))
    expect(check?.within).toBe(false)
    expect(check?.note).toMatch(/低于初稿目标 4500 字/)
    expect(check?.note).toMatch(/初稿要按 150% 写/)
    // The summary line keeps the verdict and drops the reasoning.
    expect(check?.short).toBe('初稿 3000 字不足初稿目标 4500 字（成稿的 150%）')
  })

  it('judges a trimmed chapter on the finished target and stops asking for 150%', () => {
    const trimmed = lengthCheck(chapter('revised', 3000, 3000))
    expect(trimmed?.stage).toBe('final')
    expect(trimmed?.target).toBe(3000)
    expect(trimmed?.within).toBe(true)
    expect(trimmed?.note).toMatch(/成稿/)
    // The same length is still wrong while the chapter claims to be a draft.
    expect(lengthCheck(chapter('drafting', 3000, 3000))?.within).toBe(false)
  })

  it('pins the window edges, which are asymmetric on both gates', () => {
    // -5% / +15%: coming in under the target is the failure, so the shortfall is
    // capped at 5% while the overrun keeps the 15% the plan allows.
    expect(LENGTH_TOLERANCE).toEqual({ under: 0.05, over: 0.15 })
    expect(lengthToleranceLabel()).toBe('-5%/+15%')
    expect(lengthWindow(3000)).toEqual({ low: 2850, high: 3450 })
    expect(lengthWindow(4500).low).toBeCloseTo(4275)
    expect(lengthWindow(4500).high).toBeCloseTo(5175)
    expect(lengthCheck(chapter('drafting', 3000, 4275))?.within).toBe(true)
    expect(lengthCheck(chapter('drafting', 3000, 4274))?.within).toBe(false)
    expect(lengthCheck(chapter('final', 3000, 2850))?.within).toBe(true)
    expect(lengthCheck(chapter('final', 3000, 2849))?.within).toBe(false)
  })

  it('rejects a finished chapter that is 10% under target, which ±15% would have allowed', () => {
    const short = lengthCheck(chapter('final', 3000, 2700))
    expect(short?.within).toBe(false)
    expect(short?.note).toMatch(/成稿不能比目标少太多/)
    // The same 13% overrun is still inside the window: long can be cut.
    expect(lengthCheck(chapter('final', 3000, 3400))?.within).toBe(true)
  })

  it('keeps the bare-tolerance call working, and stays silent with no prose or no target', () => {
    // A bare number sets both sides, so 0 is the strict comparison.
    expect(lengthToleranceLabel(0)).toBe('±0%')
    expect(lengthCheck(chapter('final', 3000, 3000), 0)?.within).toBe(true)
    expect(lengthCheck(chapter('final', 3000, 3100), 0)?.within).toBe(false)
    // Nothing written yet: there is no draft to judge, and blockersToFinal says
    // 尚无正文 separately.
    expect(lengthCheck(chapter('drafting', 3000, 0))).toBeUndefined()
    expect(lengthCheck(chapter('drafting', 0, 3000))).toBeUndefined()
  })
})
