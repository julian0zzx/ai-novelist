import { describe, expect, it } from 'vitest'
import {
  DRAFT_TARGET_RATIO,
  LENGTH_BENCHMARKS,
  LENGTH_TOLERANCE,
  OUTLINE_SPINE_PARTS,
  OUTLINE_STYLE_FIELDS,
  OUTLINE_STYLE_PARTS,
  VOLUME_SPINE_PARTS,
  WRITING_PLAN_QUESTIONS,
  chapterContractLength,
  chapterOutlineTarget,
  chaptersPerVolume,
  countWords,
  derivedTotalChapters,
  describeWritingPlan,
  draftTargetWords,
  emptyNovel,
  emptyOutline,
  emptyWriting,
  layerLengthCheck,
  layerWordTarget,
  lengthCheck,
  lengthStageFor,
  lengthToleranceLabel,
  lengthWindow,
  narrativeReport,
  normalizeWritingPlan,
  castDebt,
  castGaps,
  outlinePayoffGaps,
  outlineRatioLabel,
  outlineSpineGaps,
  outlineSpineValues,
  outlineStyleGaps,
  outlineStyleValues,
  styleParamName,
  rhythmExpectation,
  volumeLengthNote,
  volumeSpineGaps,
  volumeSpineValues,
  volumeWordTarget,
  writingPlanConflicts,
  writingPlanGaps,
} from '../src/core/index.ts'
import type { Chapter, ChapterStatus, OutlineStyleField, VolumePlan } from '../src/core/types.ts'
import { STYLE_BLOCK } from './style-fixture.ts'

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
      '总字数 1200000 · 单章 3000 字 · 12 卷 · 共约 400 章 · 初稿按 3750 字/章（125%）',
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
 * finished target comes out short. The 125% draft gate exists to absorb that,
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
    timeAnchor: '',
    place: '',
    conflict: '',
    emotionalPayoff: '',
    infoGap: '',
    beats: [],
    hook: '',
    keyBeat: '',
    price: '',
    targetWords,
    waived: {},
    delivered: [],
  })

  it('derives the first draft from the finished target, at 125%', () => {
    expect(DRAFT_TARGET_RATIO).toBe(1.25)
    expect(draftTargetWords(3000)).toBe(3750)
    expect(draftTargetWords(2500)).toBe(3125)
    // Rounded, because half a character is not a length anyone can write to.
    expect(draftTargetWords(2333)).toBe(2916)
    // No target, no draft line: an unanswered question stays unanswered.
    expect(draftTargetWords(0)).toBe(0)
  })

  it('gates planned and drafting chapters on the draft, revised and final on the finished target', () => {
    expect(lengthStageFor('planned')).toBe('draft')
    expect(lengthStageFor('drafting')).toBe('draft')
    expect(lengthStageFor('revised')).toBe('final')
    expect(lengthStageFor('final')).toBe('final')
  })

  it('passes a 4200-character first draft it would fail as a finished chapter', () => {
    const draft = chapter('drafting', 3000, 4200)
    const check = lengthCheck(draft)
    expect(check?.stage).toBe('draft')
    expect(check?.target).toBe(3750)
    expect(check?.within).toBe(true)
    expect(check?.note).toContain('125%')
    // The same prose misses the finished window: that gap is the room 去 AI 化
    // and hand-cutting are supposed to consume.
    expect(lengthCheck(draft, { stage: 'final' })?.within).toBe(false)
  })

  it('calls a draft written to the finished target short, in the gate’s own words', () => {
    const check = lengthCheck(chapter('drafting', 3000, 3000))
    expect(check?.within).toBe(false)
    expect(check?.note).toMatch(/低于初稿目标 3750 字/)
    expect(check?.note).toMatch(/初稿要按 125% 写/)
    // The summary line keeps the verdict and drops the reasoning.
    expect(check?.short).toBe('初稿 3000 字不足初稿目标 3750 字（成稿的 125%）')
  })

  it('judges a trimmed chapter on the finished target and stops asking for 125%', () => {
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
    // The draft gate is the same window around the draft target, so its edges
    // move with the ratio instead of sitting at the finished target's.
    expect(lengthWindow(3750)).toEqual({ low: 3563, high: 4313 })
    expect(lengthCheck(chapter('drafting', 3000, 3563))?.within).toBe(true)
    expect(lengthCheck(chapter('drafting', 3000, 3562))?.within).toBe(false)
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

/**
 * The planning layers' own length budgets.
 *
 * A chapter's length was checkable from the start; an *outline's* was not, so a
 * two-line 全书大纲 and a twenty-thousand-character one passed the same checks.
 * The SOP budgets each layer as a fraction of the prose it governs — 1/100,
 * 1/50, 1/5 — which is the only form of the number that scales from a 30 万字
 * short serial to a 300 万字 paid epic. These specs pin the arithmetic and, more
 * importantly, that a missing length answer produces no target rather than a
 * made-up one.
 */
describe('the planning layers\' length budgets', () => {
  it('derives each layer\'s default from the length it governs', () => {
    // 100 万字全书 → 1 万字全书大纲.
    expect(layerWordTarget(1_000_000, 'full')).toBe(10_000)
    // 20 万字一卷 → 4000 字分卷大纲.
    expect(layerWordTarget(200_000, 'volume')).toBe(4000)
    // 3000 字一章 → 600 字章节大纲.
    expect(layerWordTarget(3000, 'chapter')).toBe(600)
    expect(chapterOutlineTarget(3000)).toBe(600)
  })

  it('labels the ratio it applied, so the number is auditable', () => {
    expect(outlineRatioLabel('full')).toBe('1/100')
    expect(outlineRatioLabel('volume')).toBe('1/50')
    expect(outlineRatioLabel('chapter')).toBe('1/5')
    expect(layerLengthCheck('full', 0, 1_000_000)?.ratio).toBe('1/100')
  })

  it('lets an explicit target override the ratio', () => {
    expect(layerWordTarget(1_000_000, 'full', 2000)).toBe(2000)
    const check = layerLengthCheck('full', 2000, 1_000_000, 2000)
    expect(check?.target).toBe(2000)
    expect(check?.enough).toBe(true)
    expect(check?.ratio).toBe('显式目标')
  })

  it('stays silent when the length it would measure against was never asked', () => {
    // No 总字数 answer means no ratio to apply — inventing a denominator is how
    // the tool would start asserting numbers the author never gave.
    expect(layerWordTarget(0, 'full')).toBe(0)
    expect(layerLengthCheck('full', 12_000, 0)).toBeUndefined()
    expect(volumeWordTarget(emptyWriting())).toBe(0)
  })

  it('reports a layer below its target as short, and never as a pass', () => {
    const short = layerLengthCheck('full', 300, 1_000_000)
    expect(short?.enough).toBe(false)
    expect(short?.note).toMatch(/低于目标 10000 字/)
    expect(short?.note).toMatch(/1\/100/)

    const enough = layerLengthCheck('full', 10_000, 1_000_000)
    expect(enough?.enough).toBe(true)
    expect(enough?.note).toMatch(/已达到目标 10000 字/)
  })

  it('measures a chapter contract by its own text, not by its beats or waivers', () => {
    const chapter: Chapter = {
      id: 'chapter-1',
      number: 1,
      title: '',
      synopsis: '',
      status: 'planned',
      body: '',
      wordCount: 0,
      updatedAt: '2026-01-01T00:00:00.000Z',
      volume: 0,
      plotTask: '剧情任务十四个字',
      timeAnchor: '',
      place: '',
      conflict: '冲突八个字',
      emotionalPayoff: '',
      infoGap: '',
      beats: ['shuang', 'sweet', 'burn'],
      hook: '',
      keyBeat: '关键转折',
      price: '代价',
      targetWords: 3000,
      waived: { emotionalPayoff: '作者显式放弃' },
      delivered: [],
    }
    // '剧情任务十四个字' is 8 characters; '冲突八个字' is 5; '关键转折' is 4; '代价' is 2.
    // Beats and the waiver reason are not prose the author wrote into the contract.
    expect(chapterContractLength(chapter)).toBe(19)
  })

  it('derives the volume budget from chapters-per-volume and chapter length', () => {
    const writing = { ...emptyWriting(), totalChapters: 400, chapterWords: 3000, volumes: 10 }
    // 40 章 × 3000 字 = 12 万字一卷 → 2400 字分卷大纲.
    expect(volumeWordTarget(writing)).toBe(120_000)
    expect(layerWordTarget(volumeWordTarget(writing), 'volume')).toBe(2400)
  })
})

/**
 * Narrative completeness: what a planning layer owes the *story*, checked before
 * its beats and before its word count.
 *
 * The failure these pin is specific: a 20k-character 全书大纲 whose every
 * structural category was filled and whose word count exceeded its 1/100 target,
 * with no place in it that told the story. Length cannot detect that, so the
 * spine is a separate check that runs first.
 */
describe('the narrative spine', () => {
  /** A volume answering every element, over the empty shape's field list. */
  const fullVolume = (overrides: Partial<VolumePlan> = {}): VolumePlan => ({
    number: 1,
    title: '第一卷',
    detail: '卷内节奏',
    goal: '入门',
    conflict: '试炼',
    climax: '登顶',
    endHook: '钟响',
    synopsis: '少年入门，卷末登顶。',
    protagonistArc: '从散修变成门内弟子',
    antagonistArc: '对手第一次露头',
    factionShift: '门内两派成形',
    mainConflict: '入门试炼',
    costs: '失去了自由身',
    gains: '得了一个身份',
    chapters: [1, 30],
    ...overrides,
  })

  it('asks the whole-book outline for eight named elements before anything else', () => {
    const gaps = outlineSpineGaps(emptyOutline())
    // The order is the reading order the report prints: story first, then whose
    // arc moves, then what the story cost.
    expect(gaps.map((gap) => gap.key)).toEqual([
      'synopsis',
      'protagonistArc',
      'supportArcs',
      'antagonistArc',
      'factionShift',
      'conflictArcs',
      'costs',
      'gains',
    ])
    // Each gap says what the element has to answer, so the model is not left to
    // guess what "对抗副本" meant.
    expect(gaps[0]?.requirement).toMatch(/整本书从开头到结局讲一遍/)
    expect(gaps[0]?.fill).toContain('operation="outline"')
  })

  it('stops reporting an element once it is written, and reports the rest', () => {
    const outline = {
      ...emptyOutline(),
      synopsis: '一个社畜在夜里替人吃噩梦。',
      protagonistArc: '从怕接电话到敢按那个号码',
    }
    const gaps = outlineSpineGaps(outline)
    expect(gaps.map((gap) => gap.key)).not.toContain('synopsis')
    expect(gaps.map((gap) => gap.key)).not.toContain('protagonistArc')
    expect(gaps).toHaveLength(6)
  })

  it('asks a volume for seven elements, one stage at a time', () => {
    const gaps = volumeSpineGaps(fullVolume({ synopsis: '', gains: '' }))
    expect(gaps.map((gap) => gap.key)).toEqual(['synopsis', 'gains'])
    // The whole-book-only fields have no volume twin: a volume advances the
    // companions inside the protagonist's line rather than re-listing them.
    expect(VOLUME_SPINE_PARTS.map((part) => part.field)).not.toContain('supportArcs')
    expect(VOLUME_SPINE_PARTS.map((part) => part.field)).not.toContain('conflictArcs')
    // And a volume that answered everything reports nothing.
    expect(volumeSpineGaps(fullVolume())).toEqual([])
  })

  it('reports the payoff schedule only after there is a story to hang it on', () => {
    const bare = emptyOutline()
    expect(outlinePayoffGaps(bare)).toEqual([
      '情绪节拍表为空（每 3 章小爽点、每 10 章大爽点、每卷卷末爆点）：novel_plan operation="beat"',
      '分卷大纲还没写：阶段性高潮与卷末爆点没有落点（novel_plan operation="volume"）',
    ])
    // Beats alone are not enough: a book with a rhythm table but no volumes has
    // nowhere for its 爆点 to land.
    const withBeats = { ...bare, beats: [{ chapter: 3, kind: 'shuang' as const, note: '' }] }
    expect(outlinePayoffGaps(withBeats)).toHaveLength(1)
    expect(outlinePayoffGaps(withBeats)[0]).toMatch(/还没有写|没有落点/)
    // A volume with neither a climax nor an end hook is not a landing point
    // either: the 爆点 has to be written, not merely have a volume around it.
    const unrated = { ...withBeats, volumes: [fullVolume({ climax: '', endHook: '' })] }
    expect(outlinePayoffGaps(unrated)[0]).toMatch(/卷末钩子/)
    // A rated volume satisfies it.
    const rated = { ...withBeats, volumes: [fullVolume()] }
    expect(outlinePayoffGaps(rated)).toEqual([])
  })

  it('prints every element, answered or not, so the shape is visible at a glance', () => {
    const outline = { ...emptyOutline(), synopsis: '一个社畜在夜里替人吃噩梦，最后把神位拆开还给所有人。' }
    const lines = narrativeReport(OUTLINE_SPINE_PARTS, outlineSpineValues(outline))
    expect(lines).toHaveLength(8)
    expect(lines[0]).toContain('✅')
    expect(lines[0]).toContain('一个社畜在夜里替人吃噩梦')
    expect(lines[1]).toContain('⬜')
    expect(lines[1]).toContain('主角成长线')
    expect(lines[1]).toContain('未写')
    // A long answer is truncated for the dashboard rather than flooding it.
    const long = narrativeReport(VOLUME_SPINE_PARTS, volumeSpineValues(fullVolume({ gains: '甲'.repeat(200) })))
    expect(long.at(-1)).toMatch(/…$/)
  })
})

describe('the 写作风格 block', () => {
  it('asks the outline for seven named elements, and names the parameter that fills each', () => {
    const gaps = outlineStyleGaps(emptyOutline())
    expect(gaps.map((gap) => gap.key)).toEqual([...OUTLINE_STYLE_FIELDS])
    expect(OUTLINE_STYLE_PARTS).toHaveLength(7)
    // Every gap points at the parameter a caller actually sends, so the message
    // and the schema cannot drift apart.
    for (const gap of gaps) expect(gap.fill).toContain(styleParamName(gap.key as OutlineStyleField))
    expect(gaps[0]?.fill).toContain('styleTone=')
    expect(gaps[6]?.fill).toContain('styleTaboos=')
  })

  it('stops reporting an element once it is written', () => {
    const outline = { ...emptyOutline(), style: { ...STYLE_BLOCK, diction: '' } }
    expect(outlineStyleGaps(outline).map((gap) => gap.key)).toEqual(['diction'])
    expect(outlineStyleValues(outline).tone).toBe(STYLE_BLOCK.tone)
    expect(outlineStyleGaps({ ...emptyOutline(), style: STYLE_BLOCK })).toEqual([])
  })

  it('prints the style with the same report shape as the narrative spine', () => {
    const lines = narrativeReport(OUTLINE_STYLE_PARTS, outlineStyleValues({ ...emptyOutline(), style: STYLE_BLOCK }))
    expect(lines).toHaveLength(7)
    expect(lines[0]).toContain('文风基调')
    expect(lines[0]).toContain('✅')
    const bare = narrativeReport(OUTLINE_STYLE_PARTS, outlineStyleValues(emptyOutline()))
    expect(bare[0]).toContain('⬜')
    expect(bare[0]).toContain('未写')
  })
})

describe('the cast checklist', () => {
  /** A project with one character, over the empty shape. */
  const withCharacter = (patch: Record<string, string>): ReturnType<typeof emptyNovel> => ({
    ...emptyNovel(),
    characters: {
      'lin-yue': {
        id: 'lin-yue',
        name: '林越',
        role: 'protagonist',
        scope: '',
        volume: 0,
        firstAppearance: '',
        exit: '',
        description: '',
        personality: '',
        voice: '',
        goal: '',
        fear: '',
        obsession: '',
        weakness: '',
        camp: '',
        relations: '',
        growthArc: '',
        notes: '',
        ...patch,
      },
    },
  })

  it('holds every character to a role, a goal, a personality and a voice', () => {
    const gaps = castGaps(withCharacter({}))
    expect(gaps[0]?.missing).toEqual(['goal', 'personality', 'voice', 'fear', 'obsession', 'weakness', 'growthArc'])
    // A character with no role at all is unidentified rather than merely thin.
    expect(castGaps(withCharacter({ role: '' }))[0]?.missing).toContain('role')

    // A 配角 with a role, a goal and a voice is complete: the protagonist's
    // additional spine (恐惧/执念/软肋/成长线) is not demanded of them.
    const support = castGaps(
      withCharacter({ role: 'gatekeeper', goal: '拦住上山的人', personality: '死板', voice: '一句话不问第二遍' }),
    )
    expect(support).toEqual([])
  })

  it('names a character whose only trait is a goal — the "不够丰满" case', () => {
    const gaps = castGaps(withCharacter({ role: 'rival', goal: '压住林越' }))
    expect(gaps[0]?.missing).toEqual(['personality', 'voice'])
    expect(gaps[0]?.name).toBe('林越')
    expect(gaps[0]?.scope).toBe('volume')
  })

  it('holds a 路人 to a name, one line, and the chapter they were seen in', () => {
    // Nothing but "who he is" and "where he was seen": complete, not thin.
    const walked = castGaps(
      withCharacter({ scope: 'cameo', description: '挑担的老汉，在山门口问路。', firstAppearance: '第12章' }),
    )
    expect(walked).toEqual([])
    // A cameo owes neither a personality nor a voice — the point of the tier.
    expect(castGaps(withCharacter({ scope: 'cameo', description: '挑担的老汉。', firstAppearance: '第12章' }))).toEqual([])
  })

  it('reports an incomplete 路人 but never counts it as debt', () => {
    const state = withCharacter({ scope: 'cameo' })
    const gaps = castGaps(state)
    expect(gaps[0]?.scope).toBe('cameo')
    expect(gaps[0]?.missing).toEqual(['description', 'firstAppearance'])
    // The register is incomplete; the cast layer is not unfinished.
    expect(castDebt(state)).toEqual([])
  })

  it('falls back to the role when no scope is declared, so an older cast is unchanged', () => {
    // A protagonist-shaped role: the full spine, exactly as before tiers existed.
    expect(castGaps(withCharacter({}))[0]?.scope).toBe('main')
    // Anything else: 配角, which is what the check demanded before tiers existed.
    expect(castGaps(withCharacter({ role: 'gatekeeper' }))[0]?.scope).toBe('volume')
    // An explicit tier beats the role both ways.
    expect(castGaps(withCharacter({ role: 'protagonist', scope: 'cameo' }))[0]?.scope).toBe('cameo')
    // An unrecognized tier is not guessed at: it falls back the same way.
    expect(castGaps(withCharacter({ scope: 'minor' }))[0]?.scope).toBe('main')
    expect(castGaps(withCharacter({ role: 'gatekeeper', scope: 'minor' }))[0]?.scope).toBe('volume')
  })

  it('counts only the tiers that owe a spine as cast debt', () => {
    const state: ReturnType<typeof emptyNovel> = {
      ...emptyNovel(),
      characters: {
        lead: { ...Object.values(withCharacter({}).characters)[0]!, id: 'lead', name: '林越', role: 'protagonist', scope: 'main' },
        support: {
          ...Object.values(withCharacter({}).characters)[0]!,
          id: 'support',
          name: '守门弟子',
          role: 'gatekeeper',
          scope: 'volume',
          goal: '拦人',
          personality: '死板',
          voice: '不问第二遍',
        },
        cameo: {
          ...Object.values(withCharacter({}).characters)[0]!,
          id: 'cameo',
          name: '挑担老汉',
          role: '',
          scope: 'cameo',
          description: '在山门口问路。',
          firstAppearance: '第12章',
        },
      },
    }
    // The lead is thin (no fear/obsession/weakness/growthArc); the cameo is fine.
    expect(castDebt(state).map((gap) => gap.id)).toEqual(['lead'])
    expect(castGaps(state).map((gap) => gap.id)).toEqual(['lead'])
  })
})
