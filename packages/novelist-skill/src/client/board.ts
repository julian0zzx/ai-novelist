/**
 * The Kanban board a novel project projects onto, as data.
 *
 * The board is **derived, never stored**: columns come from the chapter
 * lifecycle the domain already defines ({@link CHAPTER_STATUSES}), the process
 * documents from the SOP layers the domain already models, and every number on a
 * card is computed from the state, exactly as `progressOf` computes the
 * aggregate. The view is then a pure function of this value, which is what makes
 * the reading testable without a browser.
 *
 * It carries two halves, because a novel project has two kinds of work:
 *
 * - {@link KanbanBoard.documents} — the **planning artefacts** the SOP produces
 *   before and around the prose: 立意与核心设定、竞品拆解、候选书名、世界观、人物设定、
 *   全书大纲、写作风格、分卷大纲、爽点节拍、开篇工程、上线决策、连载数据、完本复盘. A
 *   project can be full of these and hold no chapter at all, which is exactly the
 *   state the four chapter columns used to render as an empty board.
 * - {@link KanbanBoard.columns} — the chapters, by lifecycle status.
 *
 * Document order is the SOP's own production order, so the row reads left to
 * right as the pipeline runs, and {@link DocumentCard.gates} carries the gate the
 * SOP puts in front of the prose or of the full skeleton rather than leaving the
 * author to infer it.
 *
 * Column order is likewise the SOP's: a chapter is planned, then drafted, then
 * revised, then final — the same four states `planned → final` the plan's rhythm
 * table uses, so a board read left to right is a board read in pipeline order.
 *
 * @module @ai-novelist/novelist-skill/client/board
 */

import {
  CHAPTER_STATUSES,
  COMPETITOR_TARGET,
  NAMING_MIN_CANDIDATES,
  OUTLINE_SPINE_PARTS,
  OUTLINE_STYLE_PARTS,
  SPINE_LABELS,
} from '../core/types.ts'
import type { Chapter, ChapterStatus, NovelState, SettingsLayerStanding } from '../core/types.ts'
import { castGaps, draftTargetWords, lengthStageFor, missingContract, missingPitchFields, worldGaps } from '../core/plan.ts'
import { assessStage, confirmationStanding, progressOf, styleGateReached } from '../core/novel.ts'
import { outlineSpineGaps, outlineStyleGaps, volumeSpineGaps } from '../core/spine.ts'

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
  /** First-draft target (the draft ratio of {@link targetWords}), 0 when unset. */
  readonly draftWords: number
  /** Which length gate the card's stage is measured against. */
  readonly lengthGate: 'draft' | 'final'
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

/**
 * Where one process document stands.
 *
 * Three states, and the third is what makes the row worth having: a project can
 * hold a complete outline that the author has never been shown, which `done`
 * alone would report as finished. `draft` is that case, and it is the state the
 * SOP's checkpoints exist to empty.
 *
 * Spelled with hyphens rather than dots because the id doubles as a dictionary
 * key tail in the view, and a dotted key would be split into a path.
 */
export type DocumentState = 'missing' | 'draft' | 'confirmed'

/**
 * One planning artefact of the SOP, as the board shows it.
 *
 * The card carries the document's **identity and standing** and nothing about how
 * it is drawn: the labels, the qualifiers and the action hints are the view's
 * dictionary, keyed by {@link id}, because they are copy rather than project
 * state. Everything here is a fact about the state, so the projection stays
 * testable without a browser — the same rule the chapter columns follow.
 */
export interface DocumentCard {
  /**
   * Stable id of the document, in SOP order.
   *
   * Also the view's dictionary key tail: `novel-kanban` owns `doc.<id>.label`,
   * `doc.<id>.detail` and `doc.<id>.next`, so a new document is a data change
   * plus three lines of copy rather than a new component.
   */
  readonly id: string
  /** Which of the three standings the document is in. */
  readonly state: DocumentState
  /** Whatever the document counts, when it counts anything: entries, fields, chapters. */
  readonly done: number
  /** What a complete document holds; 0 when the document does not count things. */
  readonly total: number
  /**
   * The gate the SOP puts in front of this document, when it is still open.
   *
   * `prose` is the hard gate `novel_write` enforces (the premise layer, the
   * outline's 写作风格); `skeleton` is the launch gate in front of the full
   * outline; empty means the document blocks nothing by itself. Carried so the
   * card can say *why* an open document matters rather than only that it is open.
   */
  readonly gates: 'prose' | 'skeleton' | ''
  /**
   * The names of the parts this document still owes.
   *
   * Filled from the core's own gap checks (`outlineSpineGaps`, `castGaps`,
   * …) rather than recomputed here, so the board and the tools can never
   * disagree about what a document is missing. The labels are the domain's
   * Chinese ones — this is the same vocabulary the tools print — and they are
   * what the card's tooltip shows.
   */
  readonly gaps: readonly string[]
}

/** Everything the board view renders, computed once per project read. */
export interface KanbanBoard {
  /**
   * The process documents, in the order the SOP produces them.
   *
   * Before the chapters and one row down from the overview, because this is what
   * a project has while it has no chapters at all — the state four empty columns
   * say nothing about.
   */
  readonly documents: readonly DocumentCard[]
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
  /**
   * The author checkpoints, layer by layer.
   *
   * On the board because they are the project's most consequential open items:
   * the premise layer and the outline's 写作风格 block gate all prose, the layers
   * after the premise must be settled in order, and the 文风复核 blocks everything
   * after the golden three chapters.
   */
  readonly confirmations: ReturnType<typeof confirmationStanding>
  /**
   * Whether the 文风复核 is due — the golden three chapters have prose.
   *
   * Carried separately because "not confirmed" and "not yet due" are different
   * facts on the board: the first is an open checkpoint, the second is one whose
   * material does not exist yet.
   */
  readonly styleDue: boolean
}

/**
 * Project a novel state onto the Kanban board.
 *
 * @param state - the assembled project.
 * @returns the documents, the columns, the stage, and the aggregate standing.
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
  const confirmations = confirmationStanding(state)

  return {
    documents: documentsOf(state, confirmations, chapters),
    columns,
    stage: assessStage(state),
    progress,
    cast: Object.keys(state.characters).length,
    world: Object.keys(state.world).length,
    naming: state.naming.length,
    openLinks,
    overdueLinks: [...overdue],
    confirmations,
    styleDue: styleGateReached(state),
  }
}

/**
 * The planning artefacts, in the SOP's production order.
 *
 * Every entry answers the same three questions — does anything exist, is it
 * complete enough to act on, and, where the SOP put a checkpoint in front of it,
 * did the author sign it off — from the state alone. The completeness checks are
 * the core's own (`missingPitchFields`, `castGaps`, `outlineSpineGaps`, …), so
 * "the board says the outline is thin" and "`novel_status` says the outline is
 * thin" are one finding with two renderings.
 *
 * The layer lookups go through the derived standing rather than re-deriving the
 * order: `confirmationStanding` is what makes 「按顺序」 true, and a second copy of
 * that rule here is how a board starts disagreeing with `novel_confirm`.
 *
 * @param state - the project.
 * @param standing - the derived checkpoints, passed in so they are computed once.
 * @param chapters - the project's chapters, in reading order.
 * @returns one card per document, in SOP order.
 */
function documentsOf(
  state: NovelState,
  standing: ReturnType<typeof confirmationStanding>,
  chapters: readonly Chapter[],
): DocumentCard[] {
  const layer = (key: SettingsLayerStanding['key']): SettingsLayerStanding | undefined =>
    standing.layers.find((entry) => entry.key === key)

  const pitchGaps = missingPitchFields(state.pitch)
  const competitors = state.competitors.length
  const naming = state.naming.filter((candidate) => candidate.title !== '' || candidate.blurb !== '')
  const world = Object.values(state.world)
  const worldDebt = worldGaps(state)
  const cast = Object.values(state.characters)
  const castDebt = castGaps(state)
  const outlineGaps = outlineSpineGaps(state.outline)
  const styleGaps = outlineStyleGaps(state.outline)
  const volumes = state.outline.volumes
  const volumeDebt = volumes.filter((volume) => volumeSpineGaps(volume).length > 0)
  const opening = state.outline.opening
  const openingDone = opening.filter((check) => check.done).length
  const beats = state.outline.beats.length
  const launch = state.launchDecisions.at(-1)
  const opened = launch?.verdict === 'go'
  const retro = state.retro

  return [
    // 立意与核心设定 — the pre-prose checkpoint. Its sign-off is the one hard gate a
    // brand-new project has to clear, so the card says so by name.
    {
      id: 'pitch',
      state: cardState({
        complete: pitchGaps.length === 0,
        started: state.pitch.memorablePoint.trim() !== '',
        needsSignOff: true,
        signedOff: layer('premise')?.confirmed === true,
      }),
      done: PITCH_TOTAL - pitchGaps.length,
      total: PITCH_TOTAL,
      gates: layer('premise')?.gatesProse === true ? 'prose' : '',
      gaps: pitchGaps.map((gap) => gap.key),
    },
    // 竞品拆解、候选物料 — the SOP's own counts, with no checkpoint of their own:
    // twenty dismantles and three candidate sets are complete by definition.
    {
      id: 'competitors',
      state: cardState({
        complete: competitors >= COMPETITOR_TARGET,
        started: competitors > 0,
        needsSignOff: false,
        signedOff: false,
      }),
      done: competitors,
      total: COMPETITOR_TARGET,
      gates: '',
      gaps: [],
    },
    {
      id: 'naming',
      state: cardState({
        complete: naming.length >= NAMING_MIN_CANDIDATES,
        started: naming.length > 0,
        needsSignOff: false,
        signedOff: false,
      }),
      done: naming.length,
      total: NAMING_MIN_CANDIDATES,
      gates: '',
      gaps: [],
    },
    // 世界观与人物设定 — complete when every entry answers what it owes *and* the
    // author has confirmed the layer, which is the SOP's order applied one level
    // down: 世界观 first, then 人物设定.
    {
      id: 'world',
      state: cardState({
        complete: world.length > 0 && worldDebt.length === 0,
        started: world.length > 0,
        needsSignOff: true,
        signedOff: layer('world')?.confirmed === true,
      }),
      done: world.length,
      total: 0,
      gates: '',
      gaps: worldDebt.map((gap) => gap.name),
    },
    {
      id: 'cast',
      state: cardState({
        complete: cast.length > 0 && castDebt.length === 0,
        started: cast.length > 0,
        needsSignOff: true,
        signedOff: layer('cast')?.confirmed === true,
      }),
      done: cast.length,
      total: 0,
      gates: '',
      gaps: castDebt.map((gap) => gap.name),
    },
    // 去 AI 化诊断 — the receipt the SOP's step 23 never used to leave. It sits
    // beside the prose rather than among the planning layers because that is when
    // it runs: once the golden three chapters exist, and before chapter 4, which
    // `novel_write` now enforces. The card reports the diagnosis, not the prose —
    // a review that found nothing is a finished review.
    {
      id: 'de-ai',
      state: cardState({
        complete: standing.deAi.done,
        started: standing.deAi.done,
        needsSignOff: false,
        signedOff: false,
      }),
      done: standing.deAi.done ? 1 : 0,
      total: 1,
      gates: standing.deAi.gatesProse ? 'prose' : '',
      gaps: standing.deAi.unreviewed.map((number) => `第 ${String(number)} 章`),
    },
    // 全书大纲 — complete when its narrative spine reads whole. Its sign-off is the
    // layer's, and the 写作风格 beside it is a card of its own because a voice that
    // has not been written down is the one thing that stops chapter 1 existing.
    {
      id: 'outline',
      state: cardState({
        complete: outlineGaps.length === 0,
        started: outlineStarted(state),
        needsSignOff: true,
        signedOff: layer('outline')?.confirmed === true,
      }),
      done: OUTLINE_SPINE_TOTAL - outlineGaps.length,
      total: OUTLINE_SPINE_TOTAL,
      gates: layer('outline')?.gatesProse === true ? 'prose' : '',
      gaps: outlineGaps.map((gap) => SPINE_LABELS[gap.key]),
    },
    // 写作风格 — no checkpoint of its own and no ledger entry to look for: it is
    // complete when its seven elements are written, and `novel_write` is what
    // enforces it from there.
    {
      id: 'style',
      state: cardState({
        complete: styleGaps.length === 0,
        started: styleStarted(state),
        needsSignOff: false,
        signedOff: false,
      }),
      done: OUTLINE_STYLE_TOTAL - styleGaps.length,
      total: OUTLINE_STYLE_TOTAL,
      gates: 'prose',
      gaps: styleGaps.map((gap) => SPINE_LABELS[gap.key]),
    },
    // 分卷大纲与节拍表 — the work the SOP explicitly postpones until a human has
    // said go, so both cards carry that gate while the decision is short of `go`.
    {
      id: 'volumes',
      state: cardState({
        complete: volumes.length > 0 && volumeDebt.length === 0,
        started: volumes.length > 0,
        needsSignOff: true,
        signedOff: layer('volume')?.confirmed === true,
      }),
      done: volumes.length - volumeDebt.length,
      total: volumes.length,
      gates: opened ? '' : 'skeleton',
      gaps: volumeDebt.map((volume) => `第 ${String(volume.number)} 卷`),
    },
    {
      id: 'beats',
      state: cardState({ complete: beats > 0, started: beats > 0, needsSignOff: false, signedOff: false }),
      done: beats,
      total: 0,
      gates: opened ? '' : 'skeleton',
      gaps: [],
    },
    {
      id: 'opening',
      state: cardState({
        complete: opening.length > 0 && openingDone === opening.length,
        // The checklist ships with its seven items already listed, so its length
        // says nothing about whether anyone has worked on it: the first confirmed
        // item is what "in progress" means here.
        started: openingDone > 0,
        needsSignOff: false,
        signedOff: false,
      }),
      done: openingDone,
      total: opening.length,
      gates: '',
      gaps: opening.filter((check) => !check.done).map((check) => check.key),
    },
    // 上线决策 — the go/no-go that authorises the full skeleton. Not a document the
    // agent writes but a decision the author records, which is exactly why it is on
    // the board: nothing else in the project shows that it is still outstanding.
    {
      id: 'launch',
      state: launch === undefined ? 'missing' : launch.verdict === 'go' ? 'confirmed' : 'draft',
      done: 0,
      total: 0,
      gates: '',
      // A verdict that is not `go` is a standing instruction, so its own word is
      // what the card shows rather than a count of anything.
      gaps: launch === undefined || launch.verdict === 'go' ? [] : [launch.verdict],
    },
    // 连载数据与完本复盘 — the data side and the closing phase. Both are reported
    // as they are and gate nothing, like `novel_assess` itself.
    {
      id: 'serial',
      state: cardState({
        complete: state.readings.length > 0 && state.evaluations.length > 0,
        started: state.readings.length > 0 || state.iterations.length > 0,
        needsSignOff: false,
        signedOff: false,
      }),
      done: state.evaluations.length,
      total: 0,
      gates: '',
      gaps: [],
    },
    {
      id: 'retro',
      state: cardState({
        complete: retro !== undefined && retro.lessons.length > 0,
        started: retro !== undefined,
        needsSignOff: false,
        signedOff: false,
      }),
      done: retro?.lessons.length ?? 0,
      total: 0,
      gates: '',
      gaps: [],
    },
  ]
}

/** How many fields the pitch owes. */
const PITCH_TOTAL = 5

/** How many narrative elements the whole-book outline owes. */
const OUTLINE_SPINE_TOTAL = OUTLINE_SPINE_PARTS.length

/** How many elements the 写作风格 block owes. */
const OUTLINE_STYLE_TOTAL = OUTLINE_STYLE_PARTS.length

/**
 * Whether the whole-book outline holds anything at all.
 *
 * Any one of its layers counts as a start: a project that has written its logline
 * and nothing else has an outline in progress, and one that has written only an
 * act list has not written nothing. The narrative spine is a separate question —
 * that is what {@link DocumentState} reports — so this is "has anyone opened the
 * document", not "is it any good".
 *
 * @param state - the project.
 * @returns whether the outline is started.
 */
function outlineStarted(state: NovelState): boolean {
  const outline = state.outline
  return (
    outline.logline.trim() !== ''
    || outline.minimal.trim() !== ''
    || outline.fullOutline.trim() !== ''
    || outline.synopsis.trim() !== ''
    || outline.acts.length > 0
  )
}

/**
 * Whether the 写作风格 block holds anything at all.
 *
 * @param state - the project.
 * @returns whether any of the seven elements is written.
 */
function styleStarted(state: NovelState): boolean {
  return Object.values(state.outline.style).some((element) => element.trim() !== '')
}

/**
 * The standing of one artefact, as one expression.
 *
 * Completion and sign-off are two different questions, and `needsSignOff` is what
 * keeps them apart: the artefacts the SOP runs a checkpoint over (立意、世界观、
 * 人物设定、全书大纲、分卷大纲) are finished only once the author has signed them off,
 * while the ones it never checks back on (竞品拆解、候选物料、写作风格、节拍表、开篇清单)
 * are finished when they are written. Asking those for a sign-off would report a
 * complete competitor study as unfinished because nobody "confirmed" it.
 *
 * @param options - what is true of the artefact: whether it answers everything it
 * owes, whether it holds anything at all, whether the SOP put a checkpoint in
 * front of it, and whether that checkpoint is closed.
 * @returns the standing.
 */
function cardState(options: {
  readonly complete: boolean
  readonly started: boolean
  readonly needsSignOff: boolean
  readonly signedOff: boolean
}): DocumentState {
  if (options.complete && (!options.needsSignOff || options.signedOff)) return 'confirmed'
  return options.started ? 'draft' : 'missing'
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
    draftWords: draftTargetWords(chapter.targetWords),
    lengthGate: lengthStageFor(chapter.status),
    written: chapter.body.trim() !== '',
    beats: chapter.beats,
    hasHook: chapter.hook.trim() !== '',
    missing: missingContract(chapter),
    delivered: chapter.delivered,
    synopsis: chapter.synopsis,
  }
}
