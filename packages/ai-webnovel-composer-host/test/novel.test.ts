import { describe, expect, it } from 'vitest'
import {
  NOVEL_SCHEMA_VERSION,
  NovelInputError,
  NovelStoreError,
  addReading,
  assessStage,
  countWords,
  emptyNovel,
  missingContractFields,
  migrateV1,
  migrateV2,
  parseNovel,
  progressOf,
  renderManuscript,
  serializeNovel,
  setOpeningCheck,
  slugify,
  stageLabel,
  updateBaselines,
  updatePitch,
  upsertChapter,
  upsertCharacter,
  upsertLink,
  upsertVolume,
  upsertWorld,
} from '../src/core/index.ts'

/** Fixed clock so every timestamp assertion is exact. */
const at = (iso: string) => () => iso

/** A minimal verification record; spreads override just the verdict. */
const emptyVerification = {
  id: 'round-1',
  round: 1,
  at: '2024-01-02T00:00:00.000Z',
  channel: 'readers',
  sampleSize: 10,
  readingId: 'reading-1',
  namingId: '',
  verdict: 'fail' as const,
  reasons: [],
  fallback: '阶段二',
  abandonIf: '核心指标再降',
  note: '',
}

describe('slugify and countWords', () => {
  it('keeps CJK and dashes ASCII', () => {
    expect(slugify('The Fallen Sect!')).toBe('the-fallen-sect')
    expect(slugify('青云宗')).toBe('青云宗')
    expect(slugify('!!!')).toBe('')
  })

  it('counts CJK per ideograph and latin per token, ignoring punctuation', () => {
    expect(countWords('青云宗')).toBe(3)
    expect(countWords('The quick brown fox.')).toBe(4)
    expect(countWords('他 said hello to 青云宗')).toBe(7)
    expect(countWords('   \n\t ')).toBe(0)
  })
})

describe('emptyNovel', () => {
  it('produces a version-2 project at the SOP default operating points', () => {
    const state = emptyNovel({ title: '青云记', premise: '少年上山' }, at('2024-01-01T00:00:00.000Z'))
    expect(state.schemaVersion).toBe(NOVEL_SCHEMA_VERSION)
    expect(state.meta.title).toBe('青云记')
    expect(state.pitch.memorablePoint).toBe('')
    expect(state.competitors).toEqual([])
    expect(state.baselines.medians).toEqual({})
    expect(state.writing).toMatchObject({
      chapterPlanWindow: 15,
      openingGateChapters: [3, 10],
      stockTargetChapters: 10,
      chapterPlanCeiling: 40,
    })
    // The SOP's opening checklist is the default, not something to remember.
    expect(state.outline.opening).toHaveLength(7)
    expect(state.outline.opening.every((check) => !check.done)).toBe(true)
    expect(state.links).toEqual({})
    expect(state.readings).toEqual([])
    expect(state.iterations).toEqual([])
    expect(state.verifications).toEqual([])
    expect(state.retro).toBeUndefined()
  })
})

describe('serialize and parse', () => {
  it('round-trips a v2 project', () => {
    const withCast = upsertCharacter(emptyNovel({ title: '青云记' }, at('2024-01-01T00:00:00.000Z')), {
      name: '林越',
      role: 'protagonist',
      goal: '拜入青云宗',
      fear: '被逐出山门',
      obsession: '证明自己',
      weakness: '怕水',
      growthArc: '外门→内门→执剑',
    })
    const withWorld = upsertWorld(withCast, {
      name: '青云宗',
      kind: 'faction',
      detail: '正道第一宗',
      cost: '每年献祭',
      limits: '不出山门',
    })
    const withLink = upsertLink(withWorld, {
      id: 'sword',
      note: '断剑的来历',
      dueAt: '12',
      payoff: '掌门认剑',
      volume: 1,
    })
    const state = upsertChapter(withLink, {
      id: 'chapter-1',
      number: 1,
      title: '山门',
      plotTask: '林越抵达山门',
      conflict: '守门弟子不许他进',
      emotionalPayoff: '被接纳的期待',
      infoGap: '为何执意上山',
      beats: ['tension', 'shuang'],
      hook: '山门后传来一声钟响。',
      targetWords: 2500,
      body: '山门很高，云雾不散。',
    })
    // The single-document codec is the migration path's foundation: it reads a
    // pre-split document whole. `parseNovel` therefore returns the *metadata*
    // half for a current-version document — the content lives in files now — so
    // this spec asserts the metadata round trip plus the word-count derivation
    // that the migration depends on.
    const restored = parseNovel(serializeNovel(state))
    expect(restored.schemaVersion).toBe(NOVEL_SCHEMA_VERSION)
    expect(restored.meta).toEqual(state.meta)
    expect(restored.links).toEqual(state.links)
    expect(restored.outline.opening).toEqual(state.outline.opening)
    expect(restored.index?.chapters).toEqual({})

    // A version-2 document still round-trips *content* through `migrateV2`,
    // which is what the store calls when it finds one on disk.
    const legacy = JSON.parse(serializeNovel(state)) as Record<string, unknown>
    const migrated = migrateV2({ ...legacy, schemaVersion: 2 })
    expect(migrated.state.chapters['chapter-1']?.wordCount).toBe(8)
    expect(migrated.state.characters).toEqual(state.characters)
    expect(migrated.state.world).toEqual(state.world)
    expect(migrated.state.outline.volumes).toEqual(state.outline.volumes)
    // Migration points the index at the files it is about to write.
    expect(migrated.metadata.index.chapters['chapter-1']?.bodyFile).toBe('章节/第001章-山门.md')
  })

  it('rejects unparsable and foreign payloads', () => {
    expect(() => parseNovel('{oops')).toThrow(NovelStoreError)
    expect(() => parseNovel('[]')).toThrow(NovelStoreError)
    expect(() => parseNovel('{"schemaVersion":99}')).toThrow(/not supported/)
  })

  it('recomputes the word count instead of trusting the file', () => {
    const raw = JSON.stringify({
      schemaVersion: 2,
      meta: {},
      chapters: { a: { number: 1, body: '青云宗', wordCount: 9999, status: 'nope' } },
    })
    const state = parseNovel(raw)
    expect(state.chapters['a']?.wordCount).toBe(3)
    expect(state.chapters['a']?.status).toBe('planned')
  })
})

describe('version-1 migration', () => {
  /** A realistic version-1 document: the shape the previous release wrote. */
  const v1 = {
    schemaVersion: 1,
    meta: { title: '青云记', premise: '少年上山求道。', genres: ['xianxia'], pov: 'third-limited', language: 'zh-CN' },
    characters: { 林越: { name: '林越', role: 'protagonist', goal: '拜入青云宗', notes: '左手有疤' } },
    world: { 青云宗: { kind: 'faction', name: '青云宗', detail: '正道第一宗' } },
    chapters: {
      'chapter-1': { number: 1, title: '山门', synopsis: '林越抵达青云宗', status: 'drafting', body: '山门很高。' },
    },
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-02-01T00:00:00.000Z',
  }

  it('keeps every v1 draft fact and lands in the current version', () => {
    const state = parseNovel(JSON.stringify(v1))
    expect(state.schemaVersion).toBe(NOVEL_SCHEMA_VERSION)
    expect(state.meta.title).toBe('青云记')
    expect(state.characters['林越']?.goal).toBe('拜入青云宗')
    expect(state.world['青云宗']?.detail).toBe('正道第一宗')
    expect(state.chapters['chapter-1']?.body).toBe('山门很高。')
    expect(state.chapters['chapter-1']?.status).toBe('drafting')
  })

  it('does not silently empty the only plan a v1 chapter had', () => {
    // v1 kept the whole plan in `synopsis`; v2 splits it into contract fields.
    // Losing it would turn a planned draft into an unplanned one.
    const state = parseNovel(JSON.stringify(v1))
    expect(state.chapters['chapter-1']?.synopsis).toBe('林越抵达青云宗')
    expect(state.chapters['chapter-1']?.plotTask).toBe('林越抵达青云宗')
  })

  it('marks the SOP-only records as not yet recorded', () => {
    const state = parseNovel(JSON.stringify(v1))
    expect(state.competitors).toEqual([])
    expect(state.baselines.medians).toEqual({})
    expect(state.pitch.memorablePoint).toBe('')
    expect(state.outline.opening).toHaveLength(7)
    expect(state.readings).toEqual([])
  })

  it('fills the new world fields rather than dropping the entry', () => {
    const state = migrateV1(v1 as never)
    expect(state.world['青云宗']).toMatchObject({ cost: '', limits: '' })
    expect(state.writing.openingGateChapters).toEqual([3, 10])
  })
})

describe('chapter contract', () => {
  it('reports every unanswered field', () => {
    const state = upsertChapter(emptyNovel(), { id: 'one', title: '一' }, at('2024-01-01T00:00:00.000Z'))
    expect(missingContractFields(state.chapters['one']!)).toEqual([
      'plotTask',
      'conflict',
      'emotionalPayoff',
      'infoGap',
      'beats',
      'hook',
    ])
  })

  it('treats a waiver as an answer', () => {
    const state = upsertChapter(
      emptyNovel(),
      {
        id: 'one',
        plotTask: 'x',
        conflict: 'y',
        emotionalPayoff: 'z',
        infoGap: 'g',
        beats: ['shuang'],
        hook: 'h',
      },
      at('2024-01-01T00:00:00.000Z'),
    )
    expect(missingContractFields(state.chapters['one']!)).toEqual([])

    const waived = upsertChapter(
      state,
      { id: 'one', waived: { hook: '本卷收束章不需要钩子' } },
      at('2024-01-02T00:00:00.000Z'),
    )
    expect(missingContractFields(waived.chapters['one']!)).toEqual([])
  })

  it('keeps the contract when only prose is written', () => {
    let state = upsertChapter(emptyNovel(), { id: 'one', title: '第一章', hook: '钟响' }, at('2024-01-01T00:00:00.000Z'))
    state = upsertChapter(state, { id: 'one', body: '青云宗。' }, at('2024-01-02T00:00:00.000Z'))
    expect(state.chapters['one']?.title).toBe('第一章')
    expect(state.chapters['one']?.hook).toBe('钟响')
    expect(state.chapters['one']?.wordCount).toBe(3)
  })

  it('refuses a patch that identifies nothing', () => {
    expect(() => upsertChapter(emptyNovel(), { body: 'orphan' })).toThrow(NovelInputError)
  })
})

describe('links', () => {
  it('requires a note when creating and keeps the rest on update', () => {
    expect(() => upsertLink(emptyNovel(), { id: 'ghost' })).toThrow(/does not exist yet/)
    let state = upsertLink(emptyNovel(), { id: 'sword', note: '断剑来历', dueAt: '5', payoff: '认主' })
    state = upsertLink(state, { id: 'sword', status: 'paid' })
    expect(state.links['sword']).toMatchObject({ note: '断剑来历', dueAt: '5', payoff: '认主', status: 'paid' })
  })
})

describe('progressOf', () => {
  it('derives stock, contract completeness, and overdue promises', () => {
    let state = upsertChapter(
      emptyNovel(),
      { id: 'a', number: 1, body: '青云宗', status: 'final', plotTask: 'x', conflict: 'y', emotionalPayoff: 'z', infoGap: 'g', beats: ['shuang'], hook: 'h' },
      at('2024-01-01T00:00:00.000Z'),
    )
    state = upsertChapter(
      state,
      { id: 'b', number: 2, body: '山门', status: 'drafting', plotTask: 'x', conflict: 'y', emotionalPayoff: 'z', infoGap: 'g', beats: ['turn'], hook: 'h' },
      at('2024-01-01T00:00:00.000Z'),
    )
    state = upsertChapter(state, { id: 'c', number: 3, title: '试炼' }, at('2024-01-01T00:00:00.000Z'))
    state = upsertLink(state, { id: 'sword', note: '断剑来历', dueAt: '2' })
    state = upsertLink(state, { id: 'ring', note: '母亲的戒指', dueAt: '3' })

    const progress = progressOf(state)
    expect(progress.chapters).toBe(3)
    // Chapter 1 is `final` (published), chapter 2 is written but unpublished.
    expect(progress.stockChapters).toBe(1)
    // Chapters a and b answer every contract field; chapter c was planned with
    // a title only, so it is the one still incomplete.
    expect(progress.contractedChapters).toBe(2)
    expect(progress.emptyChapters).toEqual(['c'])
    // Nobody reported delivery yet (`delivered` is empty), so nothing counts as
    // delivered even though the contracts are complete.
    expect(progress.deliveredChapters).toBe(0)
    expect(progress.openLinks).toEqual(['sword', 'ring'])
    // `sword` is due at chapter 2, which has prose, so it is overdue. `ring`
    // is due at chapter 3, which is still only planned — not overdue yet.
    expect(progress.overdueLinks).toEqual(['sword'])
  })

  it('returns the entry from upsertWorld, not the whole state', () => {
    // Regression: an earlier revision returned the state object from
    // upsertWorld, so every nested call treated a state as a world entry and
    // crashed on its `id`.
    const state = upsertWorld(emptyNovel(), {
      name: '青云宗',
      kind: 'faction',
      detail: '正道第一宗',
      cost: '献祭',
      limits: '不出山门',
    })
    expect(state.world['青云宗']).toEqual({
      id: '青云宗',
      kind: 'faction',
      name: '青云宗',
      detail: '正道第一宗',
      cost: '献祭',
      limits: '不出山门',
    })
    expect(state.world['青云宗']).not.toHaveProperty('schemaVersion')
  })

  it('flags numbering gaps', () => {
    let state = upsertChapter(emptyNovel(), { id: 'a', number: 1 }, at('2024-01-01T00:00:00.000Z'))
    state = upsertChapter(state, { id: 'b', number: 3 }, at('2024-01-01T00:00:00.000Z'))
    expect(progressOf(state).numberingIssues).toEqual(['b'])
  })
})

describe('assessStage', () => {
  /** Build a project that satisfies one phase's preconditions. */
  function withPitchAndCompetitors(): ReturnType<typeof emptyNovel> {
    const base = updatePitch(
      emptyNovel({ title: '青云记' }, at('2024-01-01T00:00:00.000Z')),
      { memorablePoint: '少年携带断剑上山', coreEmotion: '被承认', shuangPoints: ['打脸'], differentiators: ['剑有记忆'], kernel: '出身不等于命' },
      at('2024-01-01T00:00:00.000Z'),
    )
    return {
      ...base,
      competitors: Array.from({ length: 20 }, (_, index) => ({
        id: `c${String(index)}`,
        title: `同榜书 ${String(index)}`,
        tags: [],
        blurb: '',
        openingEvent: '',
        goldenFinger: '',
        protagonistDesire: '',
        antagonistMotive: '',
        shuangFrequency: '',
        emotionCurve: '',
        paywallPoint: '',
        chapterHooks: '',
        commentKeywords: [],
        takeaway: '',
      })),
    }
  }

  it('starts in planning and names what is missing', () => {
    const assessment = assessStage(emptyNovel())
    expect(assessment.stage).toBe('planning')
    expect(assessment.blockers.join(' ')).toMatch(/记忆点/)
    expect(assessment.blockers.join(' ')).toMatch(/竞品/)
  })

  it('moves to verification-prep once the pitch and 20 competitors exist', () => {
    const assessment = assessStage(withPitchAndCompetitors())
    expect(assessment.stage).toBe('verification-prep')
    expect(assessment.blockers.join(' ')).toMatch(/最小可行大纲/)
  })

  it('requires the opening package, including the checklist, before verifying', () => {
    let state = withPitchAndCompetitors()
    state = { ...state, outline: { ...state.outline, logline: '少年上山', minimal: '一屏摘要', acts: ['起'] } }
    state = upsertChapter(state, { id: 'c1', number: 1, plotTask: '上山' }, at('2024-01-01T00:00:00.000Z'))
    expect(assessStage(state).stage).toBe('verification-prep')
    expect(assessStage(state).blockers.join(' ')).toMatch(/开篇工程清单/)

    for (const check of state.outline.opening) {
      state = setOpeningCheck(state, check.key, true, '已确认', at('2024-01-01T00:00:00.000Z'))
    }
    // Opening package complete, but nobody has measured anything yet.
    expect(assessStage(state).stage).toBe('verification-prep')
    expect(assessStage(state).blockers.join(' ')).toMatch(/读数/)
  })

  it('requires a passing round before the full outline', () => {
    let state = withPitchAndCompetitors()
    state = updateBaselines(state, { medians: { readThrough3: 0.5, followRead10: 0.2 }, calibratedAt: '2024-01-01T00:00:00.000Z' })
    state = { ...state, outline: { ...state.outline, logline: '少年上山', minimal: '摘要', acts: ['起'] } }
    state = upsertChapter(state, { id: 'c1', number: 1, plotTask: '上山' }, at('2024-01-01T00:00:00.000Z'))
    for (const check of state.outline.opening) {
      state = setOpeningCheck(state, check.key, true, '', at('2024-01-01T00:00:00.000Z'))
    }
    state = addReading(state, {
      id: 'reading-1',
      at: '2024-01-02T00:00:00.000Z',
      period: 'new-book',
      atChapter: 3,
      values: { readThrough3: 0.3 },
      source: 'platform',
      note: '',
    })
    const failing = assessStage({ ...state, verifications: [{ ...emptyVerification, verdict: 'fail' }] })
    expect(failing.stage).toBe('verifying')
    expect(failing.blockers.join(' ')).toMatch(/验证未通过/)

    const passing = assessStage({ ...state, verifications: [{ ...emptyVerification, verdict: 'pass' }] })
    expect(passing.stage).toBe('full-outline')
    expect(passing.blockers.join(' ')).toMatch(/完整大纲/)
  })

  it('labels every phase in the SOP vocabulary', () => {
    for (const stage of ['planning', 'verification-prep', 'verifying', 'full-outline', 'serializing', 'completed'] as const) {
      expect(stageLabel(stage)).toMatch(/阶段/)
    }
  })

})

describe('renderManuscript', () => {
  it('renders in reading order and can include the contract', () => {
    let state = emptyNovel({ title: '青云记' }, at('2024-01-01T00:00:00.000Z'))
    state = upsertChapter(state, { id: 'b', title: '二', number: 2, body: 'second' }, at('2024-01-01T00:00:00.000Z'))
    state = upsertChapter(
      state,
      { id: 'a', title: '一', number: 1, body: 'first', plotTask: '上山', hook: '钟响' },
      at('2024-01-01T00:00:00.000Z'),
    )
    const plain = renderManuscript(state)
    expect(plain.indexOf('first')).toBeLessThan(plain.indexOf('second'))
    expect(plain).toContain('# 青云记')

    const withContract = renderManuscript(state, { includeContract: true })
    expect(withContract).toContain('> 剧情任务：上山')
    expect(withContract).toContain('> 钩子：钟响')
  })
})
