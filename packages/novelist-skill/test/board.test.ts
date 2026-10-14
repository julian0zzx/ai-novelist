import { describe, expect, it } from 'vitest'
import { emptyNovel } from '../src/core/novel.ts'
import { CHAPTER_STATUSES, COMPETITOR_TARGET, NAMING_MIN_CANDIDATES } from '../src/core/types.ts'
import type { Chapter, ConfirmationKind, NovelState } from '../src/core/types.ts'
import { boardOf } from '../src/client/board.ts'
import type { BoardCard, DocumentCard } from '../src/client/board.ts'
import { upsertCharacter, upsertWorld } from '../src/core/novel.ts'

/**
 * Kanban board specs.
 *
 * The board is a pure projection of a {@link NovelState}, so it is specified the
 * way the rest of the derived views are: build a state, read the board, assert
 * the facts. Nothing here touches React or the browser, which is the point of
 * keeping the projection in its own module.
 */

/**
 * Build a chapter from the fields the board reads, over the core's own defaults.
 *
 * @param overrides - what this chapter changes.
 * @returns the chapter.
 */
function chapter(overrides: Partial<Chapter> & { readonly number: number }): Chapter {
  return {
    id: `ch-${String(overrides.number).padStart(3, '0')}`,
    title: '',
    synopsis: '',
    status: 'planned',
    body: '',
    wordCount: 0,
    updatedAt: '2026-01-01T00:00:00.000Z',
    volume: 0,
    plotTask: '',
    conflict: '',
    emotionalPayoff: '',
    infoGap: '',
    beats: [],
    hook: '',
    keyBeat: '',
    price: '',
    targetWords: 0,
    waived: {},
    delivered: [],
    ...overrides,
  }
}

/**
 * A state holding exactly the given chapters.
 *
 * @param chapters - the chapters to place.
 * @returns the state.
 */
function stateOf(...chapters: readonly Chapter[]): NovelState {
  const byId: Record<string, Chapter> = {}
  for (const found of chapters) byId[found.id] = found
  return { ...emptyNovel(), chapters: byId }
}

describe('boardOf', () => {
  it('projects one column per lifecycle status, in pipeline order', () => {
    const board = boardOf(stateOf(chapter({ number: 1 })))
    expect(board.columns.map((column) => column.status)).toEqual([...CHAPTER_STATUSES])
  })

  it('places each chapter in its own status column, in reading order', () => {
    const board = boardOf(
      stateOf(
        chapter({ number: 3, status: 'drafting' }),
        chapter({ number: 1, status: 'final' }),
        chapter({ number: 2, status: 'drafting' }),
      ),
    )
    const column = (status: (typeof CHAPTER_STATUSES)[number]): readonly number[] =>
      (board.columns.find((found) => found.status === status)?.cards ?? []).map((card) => card.number)

    expect(column('planned')).toEqual([])
    expect(column('drafting')).toEqual([2, 3])
    expect(column('revised')).toEqual([])
    expect(column('final')).toEqual([1])
  })

  it('totals each column’s prose and the whole book', () => {
    const board = boardOf(
      stateOf(
        chapter({ number: 1, status: 'drafting', wordCount: 1000, body: '正文' }),
        chapter({ number: 2, status: 'drafting', wordCount: 1500, body: '正文' }),
        chapter({ number: 3, status: 'final', wordCount: 2000, body: '正文' }),
      ),
    )
    expect(board.columns.find((found) => found.status === 'drafting')?.words).toBe(2500)
    expect(board.progress.totalWords).toBe(4500)
  })

  it('marks a chapter with no prose, and counts what is missing from its contract', () => {
    const board = boardOf(stateOf(chapter({ number: 1, beats: ['shuang'], hook: '结尾钩子' })))
    const card = board.columns[0]?.cards[0]
    expect(card?.written).toBe(false)
    expect(card?.hasHook).toBe(true)
    expect(card?.beats).toEqual(['shuang'])
    // plotTask, conflict, emotionalPayoff, infoGap, keyBeat and price are still
    // unanswered; the declared beat and hook are not.
    expect(card?.missing).toEqual(['plotTask', 'conflict', 'emotionalPayoff', 'infoGap', 'keyBeat', 'price'])
  })

  it('carries the length gate its column is measured against', () => {
    const board = boardOf(
      stateOf(
        chapter({ number: 1, status: 'drafting', targetWords: 3000, wordCount: 4200, body: '正文' }),
        chapter({ number: 2, status: 'final', targetWords: 3000, wordCount: 3000, body: '正文' }),
      ),
    )
    const card = (number: number): BoardCard | undefined =>
      board.columns.flatMap((column) => column.cards).find((found) => found.number === number)
    // A draft is measured against the draft target it is written to; a published
    // chapter against the target the user gave.
    expect(card(1)?.draftWords).toBe(3750)
    expect(card(1)?.lengthGate).toBe('draft')
    expect(card(2)?.draftWords).toBe(3750)
    expect(card(2)?.lengthGate).toBe('final')
    // No target means no draft line, exactly as `draftTargetWords` says.
    expect(boardOf(stateOf(chapter({ number: 3 }))).columns[0]?.cards[0]?.draftWords).toBe(0)
  })

  it('honours a waived contract field rather than calling it missing', () => {
    const board = boardOf(
      stateOf(
        chapter({
          number: 1,
          plotTask: '推进',
          conflict: '冲突',
          emotionalPayoff: '爽',
          infoGap: '悬念',
          beats: ['turn'],
          hook: '钩子',
          keyBeat: '他第一次让出主动权',
          price: '丢了一个熟人',
          waived: { conflict: '本弧线不需要' },
        }),
      ),
    )
    expect(board.columns[0]?.cards[0]?.missing).toEqual([])
  })

  it('counts the whole-book facts the overview shows', () => {
    const board = boardOf(stateOf(chapter({ number: 1 })))
    expect(board.cast).toBe(0)
    expect(board.world).toBe(0)
    expect(board.naming).toBe(0)
    expect(board.openLinks).toEqual([])
    expect(board.stage.stage).toBe('planning')
  })

  it('carries an empty board for a project with no chapters', () => {
    const board = boardOf(stateOf())
    expect(board.progress.chapters).toBe(0)
    expect(board.columns.every((column) => column.cards.length === 0)).toBe(true)
  })
})

/**
 * Process-document specs.
 *
 * The board used to be four chapter columns, which is the whole story only for a
 * project that has chapters. These specs pin the other half: the artefacts the
 * SOP produces from 立意 to 复盘, each with its own standing, its own count and the
 * names of the parts it still owes.
 */

/**
 * A state built from a base and overrides.
 *
 * @param base - the project to start from.
 * @param overrides - what to change.
 * @returns the state.
 */
function over(base: NovelState, overrides: Partial<NovelState>): NovelState {
  return { ...base, ...overrides }
}

/**
 * One author sign-off.
 *
 * @param kind - the checkpoint closed.
 * @returns the record.
 */
function signOff(kind: ConfirmationKind) {
  return { id: `c-${kind}`, kind, at: '2026-01-01T00:00:00.000Z', summary: 'ok', note: '作者认可', rounds: 1 }
}

/**
 * The card of one document.
 *
 * @param board - the board to search.
 * @param id - the document id.
 * @returns the card, or undefined when the document is not on the board.
 */
function doc(board: { readonly documents: readonly DocumentCard[] }, id: string): DocumentCard | undefined {
  return board.documents.find((card) => card.id === id)
}

describe('boardOf documents', () => {
  it('lists every SOP process document, in production order', () => {
    const board = boardOf(stateOf())
    expect(board.documents.map((card) => card.id)).toEqual([
      'pitch',
      'competitors',
      'naming',
      'world',
      'cast',
      'de-ai',
      'outline',
      'style',
      'volumes',
      'beats',
      'opening',
      'launch',
      'serial',
      'retro',
    ])
  })

  it('reports a fresh project as having started nothing', () => {
    const board = boardOf(stateOf(chapter({ number: 1 })))
    expect(board.documents.every((card) => card.state === 'missing')).toBe(true)
    expect(doc(board, 'pitch')?.done).toBe(0)
    expect(doc(board, 'pitch')?.total).toBe(5)
    expect(doc(board, 'competitors')?.total).toBe(COMPETITOR_TARGET)
    expect(doc(board, 'naming')?.total).toBe(NAMING_MIN_CANDIDATES)
    // Both gates a fresh project is held to are on the board, on the documents
    // that carry them.
    expect(doc(board, 'pitch')?.gates).toBe('prose')
    expect(doc(board, 'style')?.gates).toBe('prose')
  })

  it('separates "written" from "signed off"', () => {
    const named = over(emptyNovel(), {
      naming: [1, 2, 3].map((index) => ({
        id: `n-${String(index)}`,
        title: `书名${String(index)}`,
        blurb: '简介',
        tags: [],
        rationale: '',
        active: false,
      })),
    })
    // Three candidates is the SOP's floor and nothing asks the author to sign
    // them off, so a complete set is a finished document — unlike the outline
    // below it, which is finished only once the author has read it.
    expect(doc(boardOf(named), 'naming')?.state).toBe('confirmed')

    // A full pitch that the author has never been shown is the case the three
    // states exist for: `done`, and not finished.
    const pitched = over(emptyNovel(), {
      pitch: {
        memorablePoint: '少年上山',
        coreEmotion: '不甘',
        shuangPoints: ['打脸'],
        differentiators: ['本土神话'],
        kernel: '执念',
      },
    })
    expect(doc(boardOf(pitched), 'pitch')?.state).toBe('draft')
    expect(doc(boardOf(pitched), 'pitch')?.done).toBe(5)
    // The premise layer answers to the SOP's umbrella `settings` sign-off as well
    // as to its own name, so the project carries both — which is what
    // `confirmationStanding` reads.
    const signed = { ...pitched, confirmations: [signOff('settings'), signOff('premise')] }
    expect(doc(boardOf(signed), 'pitch')?.state).toBe('confirmed')
  })

  it('keeps the 写作风格 block visible as the prose gate it is', () => {
    const board = boardOf(stateOf(chapter({ number: 1 })))
    expect(doc(board, 'style')?.done).toBe(0)
    expect(doc(board, 'style')?.total).toBe(7)

    const written = over(emptyNovel(), {
      outline: {
        ...emptyNovel().outline,
        style: {
          tone: '冷硬',
          perspective: '第三人称限知',
          rhythm: '短句为主',
          diction: '书面语',
          dialogue: '对话四成',
          emotion: '落在他数钱的沉默上',
          taboos: '禁翻译腔',
        },
      },
    })
    expect(doc(boardOf(written), 'style')?.state).toBe('confirmed')
    expect(doc(boardOf(written), 'style')?.gaps).toEqual([])
  })

  it('names the parts the outline and the cast still owe', () => {
    const board = boardOf(stateOf(chapter({ number: 1 })))
    // The gap names are the domain's own labels, not keys: the card shows the
    // same words `novel_status` prints.
    expect(doc(board, 'outline')?.gaps).toContain('故事梗概')
    expect(doc(board, 'outline')?.done).toBe(0)

    const thin = upsertCharacter(
      stateOf(),
      { id: 'lin', name: '林砚', role: 'protagonist', goal: '上山' },
      () => '2026-01-01T00:00:00.000Z',
    )
    // A name with a goal and no personality or voice is the finding `castGaps`
    // exists to report, so the card says so by name.
    expect(doc(boardOf(thin), 'cast')?.gaps).toEqual(['林砚'])
    expect(doc(boardOf(thin), 'cast')?.done).toBe(1)
    expect(doc(boardOf(thin), 'cast')?.total).toBe(0)
  })

  it('does not hold the cast card open for the people who appear once', () => {
    const walkOn = upsertCharacter(
      stateOf(),
      { id: 'laobing', name: '守夜的老兵', scope: 'cameo' },
      () => '2026-01-01T00:00:00.000Z',
    )
    const card = doc(boardOf(walkOn), 'cast')
    // The incomplete register is information, not a debt: there is nothing left
    // for the card to name, and only the layer's sign-off can confirm it.
    expect(card?.gaps).toEqual(['另有 1 位路人已登记（不计欠账）'])
    expect(card?.state).toBe('draft')
    // The card's number counts the people who owe a spine, not the register.
    expect(card?.done).toBe(0)

    const withLead = upsertCharacter(
      walkOn,
      {
        id: 'lin',
        name: '林砚',
        role: 'protagonist',
        scope: 'main',
        goal: '上山',
        personality: '外冷内倔',
        voice: '短句',
        fear: '被逐',
        obsession: '断剑',
        weakness: '受不得激',
        growthArc: '外门→执剑',
      },
      () => '2026-01-01T00:00:00.000Z',
    )
    expect(doc(boardOf(withLead), 'cast')?.done).toBe(1)
    expect(doc(boardOf(withLead), 'cast')?.gaps).toEqual(['另有 1 位路人已登记（不计欠账）'])
  })

  it('counts world rules that state no price', () => {
    const priced = upsertWorld(
      stateOf(),
      { id: 'qingyun', name: '青云诀', detail: '吸纳月华', cost: '折寿', limits: '不可近火' },
      () => '2026-01-01T00:00:00.000Z',
    )
    expect(doc(boardOf(priced), 'world')?.state).toBe('draft')
    expect(doc(boardOf(priced), 'world')?.gaps).toEqual([])

    const free = upsertWorld(
      stateOf(),
      { id: 'qingyun', name: '青云诀', detail: '吸纳月华' },
      () => '2026-01-01T00:00:00.000Z',
    )
    expect(doc(boardOf(free), 'world')?.gaps).toEqual(['青云诀'])
  })

  it('holds the skeleton behind the launch decision', () => {
    const board = boardOf(stateOf(chapter({ number: 1 })))
    // The SOP postpones the volumes and the beat table until a human has said
    // go, so both cards carry that gate while the decision is unrecorded.
    expect(doc(board, 'volumes')?.gates).toBe('skeleton')
    expect(doc(board, 'beats')?.gates).toBe('skeleton')
    expect(doc(board, 'launch')?.state).toBe('missing')

    const go = over(emptyNovel(), {
      launchDecisions: [
        { id: 'l-1', at: '2026-01-01T00:00:00.000Z', verdict: 'go', fallback: '', abandonIf: '', note: '编辑看过' },
      ],
    })
    expect(doc(boardOf(go), 'volumes')?.gates).toBe('')
    expect(doc(boardOf(go), 'launch')?.state).toBe('confirmed')

    const revise = over(emptyNovel(), {
      launchDecisions: [
        { id: 'l-2', at: '2026-01-01T00:00:00.000Z', verdict: 'revise', fallback: '重写第 1 章', abandonIf: '三章读完 <20%', note: '' },
      ],
    })
    // A decision that is not `go` is recorded and not passing: the card stays
    // open, because the skeleton is still not authorised.
    expect(doc(boardOf(revise), 'launch')?.state).toBe('draft')
    expect(doc(boardOf(revise), 'volumes')?.gates).toBe('skeleton')
  })

  it('reports the 去 AI 化 receipt the prose gate now requires', () => {
    // Fresh project: nothing to diagnose yet, so no gate and no standing.
    const fresh = boardOf(stateOf(chapter({ number: 1 })))
    expect(doc(fresh, 'de-ai')?.state).toBe('missing')
    expect(doc(fresh, 'de-ai')?.gates).toBe('')

    // The golden three have prose: the diagnosis is due and gates the prose
    // that comes after them, which is what the card has to show.
    const golden = boardOf(
      stateOf(
        chapter({ number: 1, body: '正文', wordCount: 2 }),
        chapter({ number: 2, body: '正文', wordCount: 2 }),
        chapter({ number: 3, body: '正文', wordCount: 2 }),
      ),
    )
    expect(doc(golden, 'de-ai')?.state).toBe('missing')
    expect(doc(golden, 'de-ai')?.gates).toBe('prose')
    expect(doc(golden, 'de-ai')?.gaps).toEqual(['第 1 章', '第 2 章', '第 3 章'])

    const reviewed = over(
      stateOf(
        chapter({ number: 1, body: '正文', wordCount: 2 }),
        chapter({ number: 2, body: '正文', wordCount: 2 }),
        chapter({ number: 3, body: '正文', wordCount: 2 }),
      ),
      {
      reviews: [
        {
          id: 'review-1',
          at: '2026-01-01T00:00:00.000Z',
          kind: 'ai-flavor',
          target: 'chapter-1',
          provider: 'test',
          model: 'test',
          promptVersion: 'review-rubric-2',
          summary: '对举句偏多',
          findings: [],
          artifact: '',
        },
      ],
      },
    )
    // One recorded review finishes the document, and the card names the golden
    // chapters nobody has looked at yet.
    expect(doc(boardOf(reviewed), 'de-ai')?.state).toBe('confirmed')
    expect(doc(boardOf(reviewed), 'de-ai')?.gaps).toEqual(['第 2 章', '第 3 章'])
  })

  it('counts the opening checklist the opening package is gated on', () => {
    const board = boardOf(stateOf(chapter({ number: 1 })))
    expect(doc(board, 'opening')?.done).toBe(0)
    expect(doc(board, 'opening')?.total).toBe(7)
    expect(doc(board, 'opening')?.gaps[0]).toBe('chapter-1-conflict-300')

    const checks = emptyNovel().outline.opening.map((check) => ({ ...check, done: true }))
    const done = over(emptyNovel(), { outline: { ...emptyNovel().outline, opening: checks } })
    expect(doc(boardOf(done), 'opening')?.state).toBe('confirmed')
  })
})
