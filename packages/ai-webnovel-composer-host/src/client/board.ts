/**
 * The Kanban board a novel project projects onto, as data.
 *
 * The board is **derived, never stored**: columns come from the chapter
 * lifecycle the domain already defines ({@link CHAPTER_STATUSES}) and every
 * number on a card is computed from the state, exactly as `progressOf` computes
 * the aggregate. The view is then a pure function of this value, which is what
 * makes the reading testable without a browser.
 *
 * Column order is the SOP's own: a chapter is planned, then drafted, then
 * revised, then final — the same four states `planned → final` the plan's rhythm
 * table uses, so a board read left to right is a board read in pipeline order.
 *
 * @module @ai-webnovel/composer-host/client/board
 */

import { CHAPTER_STATUSES } from '../core/types.ts'
import type { Chapter, ChapterStatus, NovelState } from '../core/types.ts'
import { missingContract } from '../core/plan.ts'
import { assessStage, progressOf } from '../core/novel.ts'

/** One chapter as the board shows it; every field is a fact about the state. */
export interface BoardCard {
  /** Chapter id, stable across title changes. */
  readonly id: string
  /** 1-based position in reading order. */
  readonly number: number
  /** Working title, empty while the chapter is only a plan. */
  readonly title: string
  /** Volume the chapter belongs to, 0 when unassigned. */
  readonly volume: number
  /** Lifecycle column the card sits in. */
  readonly status: ChapterStatus
  /** Character count of the prose written so far. */
  readonly wordCount: number
  /** Target length, 0 when the plan set none. */
  readonly targetWords: number
  /** Whether the chapter holds any prose at all. */
  readonly written: boolean
  /** Beats the chapter carries, in the contract's own order. */
  readonly beats: readonly string[]
  /** Whether the contract states a chapter-end hook. */
  readonly hasHook: boolean
  /** Contract fields neither answered nor waived. */
  readonly missing: readonly string[]
  /** Contract fields the last write actually delivered. */
  readonly delivered: readonly string[]
  /** The chapter's one-line synopsis, for the card's tooltip. */
  readonly synopsis: string
}

/** One lifecycle column. */
export interface BoardColumn {
  /** The status this column collects. */
  readonly status: ChapterStatus
  /** Cards in reading order. */
  readonly cards: readonly BoardCard[]
  /** Prose written across the column. */
  readonly words: number
}

/** Everything the board view renders, computed once per project read. */
export interface KanbanBoard {
  /** Cards by lifecycle, in {@link CHAPTER_STATUSES} order, one column each. */
  readonly columns: readonly BoardColumn[]
  /** The SOP phase the data supports, and what stops the next one. */
  readonly stage: ReturnType<typeof assessStage>
  /** Aggregate standing: counts, prose length, stock, gaps, promises. */
  readonly progress: ReturnType<typeof progressOf>
  /** Cast size. */
  readonly cast: number
  /** World facts recorded. */
  readonly world: number
  /** Naming candidates under test. */
  readonly naming: number
  /** Open reader promises, with the chapter they are due by. */
  readonly openLinks: readonly { readonly id: string; readonly note: string; readonly dueAt: string }[]
  /** Open promises whose due chapter is already written. */
  readonly overdueLinks: readonly string[]
}

/**
 * Project a novel state onto the Kanban board.
 *
 * @param state - the assembled project.
 * @returns the columns, the stage, and the aggregate standing.
 */
export function boardOf(state: NovelState): KanbanBoard {
  const chapters = Object.values(state.chapters).sort((left, right) => left.number - right.number)

  const columns = CHAPTER_STATUSES.map((status) => {
    const cards = chapters.filter((chapter) => chapter.status === status).map(cardOf)
    return { status, cards, words: cards.reduce((total, card) => total + card.wordCount, 0) }
  })

  const progress = progressOf(state)
  const overdue = new Set(progress.overdueLinks)
  const openLinks = Object.values(state.links)
    .filter((link) => link.status === 'open')
    .map((link) => ({ id: link.id, note: link.note, dueAt: link.dueAt }))

  return {
    columns,
    stage: assessStage(state),
    progress,
    cast: Object.keys(state.characters).length,
    world: Object.keys(state.world).length,
    naming: state.naming.length,
    openLinks,
    overdueLinks: [...overdue],
  }
}

/**
 * One chapter as a card.
 *
 * @param chapter - the chapter to read.
 * @returns the card's facts.
 */
function cardOf(chapter: Chapter): BoardCard {
  return {
    id: chapter.id,
    number: chapter.number,
    title: chapter.title,
    volume: chapter.volume,
    status: chapter.status,
    wordCount: chapter.wordCount,
    targetWords: chapter.targetWords,
    written: chapter.body.trim() !== '',
    beats: chapter.beats,
    hasHook: chapter.hook.trim() !== '',
    missing: missingContract(chapter),
    delivered: chapter.delivered,
    synopsis: chapter.synopsis,
  }
}
