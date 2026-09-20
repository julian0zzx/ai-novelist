import { describe, expect, it } from 'vitest'
import { emptyNovel } from '../src/core/novel.ts'
import { CHAPTER_STATUSES } from '../src/core/types.ts'
import type { Chapter, NovelState } from '../src/core/types.ts'
import { boardOf } from '../src/client/board.ts'
import type { BoardCard } from '../src/client/board.ts'

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
    // plotTask, conflict, emotionalPayoff, infoGap are still unanswered; the
    // declared beat and hook are not.
    expect(card?.missing).toEqual(['plotTask', 'conflict', 'emotionalPayoff', 'infoGap'])
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
    // A draft is measured against the 150% it is written to; a published chapter
    // against the target the user gave.
    expect(card(1)?.draftWords).toBe(4500)
    expect(card(1)?.lengthGate).toBe('draft')
    expect(card(2)?.draftWords).toBe(4500)
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
