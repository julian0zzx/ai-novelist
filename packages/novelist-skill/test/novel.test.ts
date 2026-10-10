import { describe, expect, it } from 'vitest'
import {
  NOVEL_SCHEMA_VERSION,
  NovelInputError,
  NovelStoreError,
  addConfirmation,
  addDiscussionRound,
  addEvaluation,
  addLaunchDecision,
  assessStage,
  confirmationStanding,
  countWords,
  emptyNovel,
  missingContractFields,
  migrateV1,
  migrateV2,
  parseNovel,
  progressOf,
  proseGate,
  renderManuscript,
  serializeNovel,
  setOpeningCheck,
  slugify,
  stageLabel,
  updatePitch,
  upsertChapter,
  upsertCharacter,
  upsertLink,
  upsertVolume,
  upsertWorld,
} from '../src/core/index.ts'

/** Fixed clock so every timestamp assertion is exact. */
const at = (iso: string) => () => iso

/** A minimal launch decision; spreads override just the verdict. */
const emptyLaunchDecision = {
  id: 'launch-1',
  at: '2024-01-02T00:00:00.000Z',
  verdict: 'revise' as const,
  fallback: '阶段二：改开篇三章',
  abandonIf: '再改一轮仍留不住读者就换概念',
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
    expect(state.evaluations).toEqual([])
    expect(state.launchDecisions).toEqual([])
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

  it('reads a document that still calls the evaluation ledger `verifications`', () => {
    // 3.2 renamed the ledger and added the evaluation's next appointment. A
    // document written before that must keep its rounds rather than silently
    // losing them to a renamed key.
    const legacy = parseNovel(JSON.stringify({
      schemaVersion: 3,
      meta: { title: '青云记' },
      verifications: [
        {
          id: 'round-1',
          round: 1,
          at: '2024-01-02T00:00:00.000Z',
          channel: 'readers',
          sampleSize: 12,
          readingId: 'reading-1',
          verdict: 'fail',
          reasons: ['三章读完低于阈值'],
          fallback: '阶段二：改开篇',
          abandonIf: '再验一轮仍不达标就换概念',
          note: '',
        },
      ],
    }))
    expect(legacy.evaluations).toHaveLength(1)
    expect(legacy.evaluations[0]?.fallback).toBe('阶段二：改开篇')
    // Fields the old record never carried default rather than being invented.
    expect(legacy.evaluations[0]?.nextAtChapter).toBe(0)
    expect(legacy.evaluations[0]?.nextTrigger).toBe('')
    expect(legacy.launchDecisions).toEqual([])
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

  it('reads a document written before the length plan as "not asked yet", not as 不分卷', () => {
    // Releases before the length questions persisted `volumes: 0` as an
    // untouched default. Reading that as an explicit 不分卷 would answer a
    // question the author was never asked, so the absence of `chapterWords`
    // marks the document as legacy and the zero as undecided.
    const legacy = parseNovel(JSON.stringify({
      schemaVersion: 3,
      meta: { title: '青云记' },
      writing: { language: 'zh-CN', pov: 'third-limited', volumes: 0, totalChapters: 0, targetWords: 0 },
    }))
    expect(legacy.writing.volumes).toBe(-1)
    expect(legacy.writing.chapterWords).toBe(0)

    // A stated volume count is an answer even in a legacy document.
    const stated = parseNovel(JSON.stringify({ schemaVersion: 3, meta: { title: '青云记' }, writing: { volumes: 12 } }))
    expect(stated.writing.volumes).toBe(12)
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

/**
 * Record the two discussion rounds and the sign-off the premise layer needs.
 *
 * @param state - the project to sign off on.
 * @returns the project with the pre-prose checkpoint closed.
 */
function signPremiseOff(state: ReturnType<typeof emptyNovel>): ReturnType<typeof emptyNovel> {
  let next = addDiscussionRound(
    state,
    { id: 'd1', kind: 'settings', at: '2024-01-01T01:00:00.000Z', proposal: '第一版设定', feedback: '主角冷一点', topics: ['人设'] },
    at('2024-01-01T01:00:00.000Z'),
  )
  next = addDiscussionRound(
    next,
    { id: 'd2', kind: 'settings', at: '2024-01-01T02:00:00.000Z', proposal: '改成沉默寡言', feedback: '可以', topics: ['人设'] },
    at('2024-01-01T02:00:00.000Z'),
  )
  return addConfirmation(
    next,
    { id: 'c1', kind: 'settings', at: '2024-01-01T03:00:00.000Z', summary: '沉默少年持断剑上山', note: '可以', rounds: 2 },
    at('2024-01-01T03:00:00.000Z'),
  )
}

/**
 * Close one settings layer after the premise — one round, then the sign-off.
 *
 * @param state - the project.
 * @param kind - the layer's confirmation kind.
 * @returns the project with the layer closed.
 */
function signLayerOff(
  state: ReturnType<typeof emptyNovel>,
  kind: 'world' | 'cast' | 'outline' | 'volume',
): ReturnType<typeof emptyNovel> {
  let next = addDiscussionRound(
    state,
    { id: `d-${kind}`, kind, at: '2024-01-01T04:00:00.000Z', proposal: `${kind} 第一版`, feedback: '可以', topics: [] },
    at('2024-01-01T04:00:00.000Z'),
  )
  next = addConfirmation(
    next,
    { id: `c-${kind}`, kind, at: '2024-01-01T05:00:00.000Z', summary: `${kind} 定稿`, note: '可以', rounds: 1 },
    at('2024-01-01T05:00:00.000Z'),
  )
  return next
}

/**
 * Close every settings layer, in the SOP's order.
 *
 * The stage machine only leaves 阶段一 once all five layers are signed off, so
 * every spec that walks past planning goes through here.
 *
 * @param state - the project to sign off on.
 * @returns the project with every settings layer closed.
 */
function signSettingsOff(state: ReturnType<typeof emptyNovel>): ReturnType<typeof emptyNovel> {
  let next = signPremiseOff(state)
  for (const kind of ['world', 'cast', 'outline', 'volume'] as const) next = signLayerOff(next, kind)
  return next
}

describe('assessStage', () => {
  /** A project with a pitch and 20 competitors, before any author sign-off. */
  function pitchedWithCompetitors(): ReturnType<typeof emptyNovel> {
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

  /** The same project once the author has signed the settings off. */
  function withPitchAndCompetitors(): ReturnType<typeof emptyNovel> {
    return signSettingsOff(pitchedWithCompetitors())
  }

  it('starts in planning and names what is missing', () => {
    const assessment = assessStage(emptyNovel())
    expect(assessment.stage).toBe('planning')
    expect(assessment.blockers.join(' ')).toMatch(/记忆点/)
    expect(assessment.blockers.join(' ')).toMatch(/竞品/)
    expect(assessment.blockers.join(' ')).toMatch(/设定还差 2 轮/)
  })

  it('holds phase one open until the author signs the settings off', () => {
    const unsigned = assessStage(pitchedWithCompetitors())
    // The pitch and the competitor study are done; the setup is still nobody
    // else's to approve, so the phase is not.
    expect(unsigned.stage).toBe('planning')
    expect(unsigned.blockers.join(' ')).toMatch(/设定还差 2 轮与用户讨论/)

    const oneRound = addDiscussionRound(
      pitchedWithCompetitors(),
      { id: 'd1', kind: 'settings', at: '', proposal: '第一版', feedback: '主角冷一点', topics: [] },
      at('2024-01-01T01:00:00.000Z'),
    )
    expect(assessStage(oneRound).blockers.join(' ')).toMatch(/设定还差 1 轮/)

    const discussed = addDiscussionRound(
      oneRound,
      { id: 'd2', kind: 'settings', at: '', proposal: '改好了', feedback: '可以', topics: [] },
      at('2024-01-01T02:00:00.000Z'),
    )
    // Rounds are enough, but only the author closes the checkpoint.
    expect(assessStage(discussed).stage).toBe('planning')
    expect(assessStage(discussed).blockers.join(' ')).toMatch(/已讨论但用户尚未确认/)

    expect(assessStage(signSettingsOff(pitchedWithCompetitors())).stage).toBe('opening-package')
  })

  it('holds serialization at the voice checkpoint once chapter 1 has prose', () => {
    let state = withPitchAndCompetitors()
    state = { ...state, outline: { ...state.outline, logline: '少年上山', minimal: '摘要', acts: ['起'] } }
    state = upsertChapter(
      state,
      { id: 'c1', number: 1, plotTask: '上山', body: '山门很高。' },
      at('2024-01-01T00:00:00.000Z'),
    )
    for (const check of state.outline.opening) {
      state = setOpeningCheck(state, check.key, true, '', at('2024-01-01T00:00:00.000Z'))
    }
    state = addLaunchDecision(
      state,
      { ...emptyLaunchDecision, verdict: 'go', fallback: '', abandonIf: '' },
      at('2024-01-02T00:00:00.000Z'),
    )
    state = { ...state, outline: { ...state.outline, fullOutlineDone: true } }
    state = upsertVolume(
      state,
      { number: 1, title: '第一卷', detail: '', goal: '入门', conflict: '试炼', climax: '登顶', endHook: '钟响', chapters: [1] },
      at('2024-01-02T00:00:00.000Z'),
    )
    state = {
      ...state,
      outline: { ...state.outline, beats: [{ chapter: 3, kind: 'shuang', note: '小高潮' }] },
    }
    const gated = assessStage(state)
    expect(gated.stage).toBe('serializing')
    expect(gated.blockers.join(' ')).toMatch(/确认文风/)

    const signed = addConfirmation(
      state,
      { id: 'c2', kind: 'style', at: '2024-01-03T00:00:00.000Z', summary: '短句为主', note: '可以', rounds: 1 },
      at('2024-01-03T00:00:00.000Z'),
    )
    expect(assessStage(signed).blockers.join(' ')).toMatch(/完本复盘/)
  })

  it('moves to opening-package once the pitch and 20 competitors exist', () => {
    const assessment = assessStage(withPitchAndCompetitors())
    expect(assessment.stage).toBe('opening-package')
    expect(assessment.blockers.join(' ')).toMatch(/最小可行大纲/)
  })

  it('requires the opening package, including the checklist, before the launch decision', () => {
    let state = withPitchAndCompetitors()
    state = { ...state, outline: { ...state.outline, logline: '少年上山', minimal: '一屏摘要', acts: ['起'] } }
    state = upsertChapter(state, { id: 'c1', number: 1, plotTask: '上山' }, at('2024-01-01T00:00:00.000Z'))
    expect(assessStage(state).stage).toBe('opening-package')
    expect(assessStage(state).blockers.join(' ')).toMatch(/开篇工程清单/)

    for (const check of state.outline.opening) {
      state = setOpeningCheck(state, check.key, true, '已确认', at('2024-01-01T00:00:00.000Z'))
    }
    // Opening package complete. Nothing has been measured, and nothing needs to
    // be: the phase ends in a declared decision, not in a reading.
    expect(assessStage(state).stage).toBe('opening-decision')
    expect(assessStage(state).blockers.join(' ')).toMatch(/上线决策/)
  })

  it('unlocks the full outline on a declared `go` alone, with no reading recorded', () => {
    let state = withPitchAndCompetitors()
    state = { ...state, outline: { ...state.outline, logline: '少年上山', minimal: '摘要', acts: ['起'] } }
    state = upsertChapter(state, { id: 'c1', number: 1, plotTask: '上山' }, at('2024-01-01T00:00:00.000Z'))
    for (const check of state.outline.opening) {
      state = setOpeningCheck(state, check.key, true, '', at('2024-01-01T00:00:00.000Z'))
    }
    // No baselines, no readings, no evaluations — the point of the redesign.
    const decided = addLaunchDecision(
      state,
      { ...emptyLaunchDecision, verdict: 'go', fallback: '', abandonIf: '' },
      at('2024-01-02T00:00:00.000Z'),
    )
    const passing = assessStage(decided)
    expect(passing.stage).toBe('full-outline')
    expect(passing.blockers.join(' ')).toMatch(/完整大纲/)
  })

  it('holds at the launch decision for `revise` and `abandon`, repeating the fallback and abandon condition', () => {
    let state = withPitchAndCompetitors()
    state = { ...state, outline: { ...state.outline, logline: '少年上山', minimal: '摘要', acts: ['起'] } }
    state = upsertChapter(state, { id: 'c1', number: 1, plotTask: '上山' }, at('2024-01-01T00:00:00.000Z'))
    for (const check of state.outline.opening) {
      state = setOpeningCheck(state, check.key, true, '', at('2024-01-01T00:00:00.000Z'))
    }
    const revising = assessStage(addLaunchDecision(state, emptyLaunchDecision, at('2024-01-02T00:00:00.000Z')))
    expect(revising.stage).toBe('opening-decision')
    expect(revising.blockers.join(' ')).toMatch(/阶段二：改开篇三章/)
    expect(revising.blockers.join(' ')).toMatch(/换概念/)

    const abandoning = assessStage(
      addLaunchDecision(state, { ...emptyLaunchDecision, id: 'launch-2', verdict: 'abandon' }, at('2024-01-03T00:00:00.000Z')),
    )
    expect(abandoning.stage).toBe('opening-decision')
    expect(abandoning.blockers.join(' ')).toMatch(/放弃该概念/)
  })

  it('labels every phase in the SOP vocabulary', () => {
    for (const stage of ['planning', 'opening-package', 'opening-decision', 'full-outline', 'serializing', 'completed'] as const) {
      expect(stageLabel(stage)).toMatch(/阶段/)
    }
  })

})

describe('the author checkpoints', () => {
  it('reports the rounds recorded since the last sign-off, not the lifetime total', () => {
    let state = signSettingsOff(emptyNovel({ title: '青云记' }))
    expect(confirmationStanding(state).settingsConfirmed).toBe(true)
    expect(confirmationStanding(state).settingsRounds).toBe(0)

    state = addDiscussionRound(
      state,
      { id: 'd3', kind: 'settings', at: '', proposal: '篇幅改成 80 万字', feedback: '可以，但别超 100 万', topics: ['篇幅'] },
      at('2024-02-01T00:00:00.000Z'),
    )
    // The earlier sign-off still stands — recording a round about a possible
    // change does not withdraw the author's approval — but confirming the change
    // takes two fresh rounds, not the two that are already spent.
    const standing = confirmationStanding(state)
    expect(standing.settingsConfirmed).toBe(true)
    expect(standing.settingsRounds).toBe(1)
    expect(standing.settingsReady).toBe(false)
    expect(standing.blockers).toEqual([])
  })

  it('counts style rounds on their own ledger', () => {
    const state = addDiscussionRound(
      emptyNovel({ title: '青云记' }),
      { id: 's1', kind: 'style', at: '', proposal: '第 1 章初稿', feedback: '短句可以，形容词少一点', topics: ['文风'] },
      at('2024-01-01T00:00:00.000Z'),
    )
    const standing = confirmationStanding(state)
    expect(standing.styleRounds).toBe(1)
    expect(standing.settingsRounds).toBe(0)
    expect(standing.styleReady).toBe(true)
    // Not due before the gate chapter exists.
    expect(standing.blockers.join(' ')).not.toMatch(/文风/)
  })
})

describe('proseGate', () => {
  it('refuses every chapter while the settings are unsigned', () => {
    const gate = proseGate(emptyNovel({ title: '青云记' }), 1)
    expect(gate.allowed).toBe(false)
    expect(gate.reasons.join(' ')).toMatch(/设定还没有经过用户确认/)
    expect(gate.next.join(' ')).toMatch(/kind="settings"/)
  })

  it('lets chapter 1 through once the settings are signed, and holds chapter 2 at the voice', () => {
    const signed = signSettingsOff(emptyNovel({ title: '青云记' }))
    expect(proseGate(signed, 1).allowed).toBe(true)

    const second = proseGate(signed, 2)
    expect(second.allowed).toBe(false)
    expect(second.reasons.join(' ')).toMatch(/确认文风/)
    expect(second.next.join(' ')).toMatch(/kind="style"/)
  })

  it('opens the rest of the book once both checkpoints are closed', () => {
    let state = signSettingsOff(emptyNovel({ title: '青云记' }))
    state = upsertChapter(state, { id: 'c1', number: 1, body: '山门很高。' }, at('2024-01-01T04:00:00.000Z'))
    state = addDiscussionRound(
      state,
      { id: 's1', kind: 'style', at: '', proposal: '第 1 章成稿', feedback: '这个语感可以', topics: ['文风'] },
      at('2024-01-01T05:00:00.000Z'),
    )
    state = addConfirmation(
      state,
      { id: 'c2', kind: 'style', at: '2024-01-01T06:00:00.000Z', summary: '短句、口语、少形容词', note: '可以', rounds: 1 },
      at('2024-01-01T06:00:00.000Z'),
    )
    expect(proseGate(state, 7)).toEqual({ allowed: true, reasons: [], next: [] })
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
