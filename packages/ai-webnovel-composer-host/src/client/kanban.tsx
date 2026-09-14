/**
 * The Kanban conversation view.
 *
 * Chat and Trajectory are the two views the shell ships for every session; this
 * module adds a third, and only where one makes sense. A workspace whose
 * `.novel/novel.json` identifies a composer project gets a **Kanban** tab beside
 * them: the project's own state, projected onto the four chapter-lifecycle
 * columns and read straight from the files the agent writes.
 *
 * Two framework facts shape the whole module:
 *
 * - A conversation view is a `conversation.view` list entry, so it is registered
 *   through `ctx.slots.register` with a label and an order, exactly like Chat
 *   (order 0) and Trajectory (order 10). This one sits at 20.
 * - Whether the tab exists at all is decided **before** it renders, because a
 *   view that renders nothing still shows a tab. {@link installKanbanTab} probes
 *   the session's workspace and registers or disposes the entry as the answer
 *   changes, so a non-novel session has exactly the two tabs it always had.
 *
 * The view owns no state of its own beyond what it read: the board is a pure
 * projection of the project ({@link boardOf}), and the project is read through
 * the same Remote and the same core codec the sidebar panel uses.
 *
 * @module @ai-webnovel/composer-host/client/kanban
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Side-effect type imports: each contributes the augmentation this module needs —
// `ctx.slots` / `ctx.remote`, the conversation ViewMap and its standard props,
// the session standard props carrying `sessionId` and the `useSessions` selector,
// and `ctx.locale` with the namespace table this module's dictionary joins.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ComposedProps } from '@deepseek-ai/dsh-client-ui-slots'
import { CHAPTER_STATUSES } from '../core/types.ts'
import type { ChapterStatus } from '../core/types.ts'
import { describe, readProject } from './project.ts'
import type { ProjectRead, SessionId } from './project.ts'
import { boardOf } from './board.ts'
import type { BoardCard, KanbanBoard } from './board.ts'

/** Unique identity of this view among the conversation's views. */
export const KANBAN_VIEW_ID = 'novel-kanban'

/** Position in the view roster: after Chat (0) and Trajectory (10). */
export const KANBAN_VIEW_ORDER = 20

/** Dictionary namespace owned by this plugin. */
export const KANBAN_NS = 'novel-kanban'

/** The slot a conversation view registers into. */
const VIEW_SLOT = 'conversation.view'

/** Dictionaries. Simplified Chinese is the source of truth; English mirrors it key for key. */
const zh = {
  'view.kanban': '看板',
  'board.empty': '这个项目还没有章节。让 agent 用 novel_plan 写下章节细纲，卡片就会出现在这里。',
  'board.columns': '章节看板',
  'board.refresh': '重新读取',
  'board.reading': '正在读取小说项目…',
  'board.stale': '项目文档读取失败，下面是上一次读到的内容。',
  'board.unwritten': '未写正文',
  'board.words': '字',
  'board.noHook': '缺章末钩子',
  'board.contractGaps': '细纲未答',
  'board.stage': '阶段',
  'board.blockers': '进入下一阶段还缺',
  'board.cast': '人物',
  'board.world': '世界观',
  'board.links': '未兑现伏笔',
  'board.naming': '候选书名',
  'board.written': '已写',
  'board.updated': '更新于',
} as const

/** The dictionary's key domain: what a `t` binding for this namespace accepts. */
export type KanbanKey = keyof typeof zh

/**
 * The panel's translator, narrowed to this namespace's own keys.
 *
 * Spelled as a plain function type rather than the locale package's generic
 * `TranslateNS` so a component's props can be read without that machinery in
 * view; the `t` seat the framework injects for this namespace satisfies it
 * exactly.
 */
type Translator = (key: KanbanKey) => string

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** This plugin's Kanban copy, registered with the view. */
    'novel-kanban': KanbanKey
  }
}

/** English dictionary, key for key with {@link zh}. */
const en: Record<KanbanKey, string> = {
  'view.kanban': 'Kanban',
  'board.empty': 'No chapters yet. Ask the agent to plan chapters with novel_plan and the cards appear here.',
  'board.columns': 'Chapter board',
  'board.refresh': 'Refresh',
  'board.reading': 'Reading the novel project…',
  'board.stale': 'The project document could not be read; showing the last successful read.',
  'board.unwritten': 'no prose',
  'board.words': 'words',
  'board.noHook': 'no chapter hook',
  'board.contractGaps': 'contract gaps',
  'board.stage': 'Stage',
  'board.blockers': 'Before the next stage',
  'board.cast': 'Cast',
  'board.world': 'World',
  'board.links': 'Open promises',
  'board.naming': 'Naming candidates',
  'board.written': 'written',
  'board.updated': 'updated',
}

/** Human labels for the lifecycle columns, in the panel's own language. */
const STATUS_LABELS: Readonly<Record<ChapterStatus, string>> = {
  planned: '待写',
  drafting: '写作中',
  revised: '已修订',
  final: '已完成',
}

/** Human labels for the SOP phases. */
const STAGE_LABELS: Readonly<Record<string, string>> = {
  planning: '策划',
  'verification-prep': '开篇验证包',
  verifying: '验证中',
  'full-outline': '完整大纲',
  serializing: '连载中',
  completed: '已完结',
}

/**
 * Palette kept local, as the sidebar panel's is: the composer carries no
 * dependency on the design system, and every colour is one the shell already
 * defines or a neutral fallback.
 */
const STYLE = {
  root: {
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100%',
    minHeight: 0,
    gap: '8px',
    padding: '10px 12px',
    fontSize: '12px',
    overflow: 'hidden',
  },
  head: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' as const },
  title: { fontSize: '14px', fontWeight: 600 },
  dim: { opacity: 0.7, lineHeight: 1.55 },
  meta: { opacity: 0.6, fontSize: '11px', lineHeight: 1.5 },
  badge: {
    fontSize: '10px',
    padding: '1px 6px',
    borderRadius: '999px',
    border: '1px solid currentColor',
    opacity: 0.75,
    whiteSpace: 'nowrap' as const,
  },
  overview: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: '8px 14px',
    padding: '8px 10px',
    border: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
    borderRadius: '6px',
  },
  stat: { display: 'flex', flexDirection: 'column' as const, gap: '1px', minWidth: '54px' },
  statValue: { fontSize: '13px', fontWeight: 600 },
  blockers: { flexBasis: '100%', opacity: 0.7, lineHeight: 1.5 },
  boardHead: { display: 'flex', alignItems: 'center', gap: '8px' },
  board: {
    display: 'flex',
    gap: '8px',
    alignItems: 'flex-start',
    overflowX: 'auto' as const,
    overflowY: 'auto' as const,
    flex: 1,
    minHeight: 0,
    paddingBottom: '4px',
  },
  column: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '6px',
    flex: '1 1 180px',
    minWidth: '170px',
    padding: '6px',
    borderRadius: '6px',
    background: 'color-mix(in srgb, currentColor 5%, transparent)',
  },
  columnHead: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '6px' },
  columnTitle: { fontWeight: 600, fontSize: '11px' },
  card: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '3px',
    padding: '6px 7px',
    borderRadius: '5px',
    background: 'color-mix(in srgb, currentColor 7%, transparent)',
    border: '1px solid color-mix(in srgb, currentColor 12%, transparent)',
  },
  cardTop: { display: 'flex', alignItems: 'baseline', gap: '5px' },
  cardNumber: { opacity: 0.55, fontSize: '10px', fontVariantNumeric: 'tabular-nums' },
  cardTitle: { flex: 1, minWidth: 0, whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis' },
  cardRow: { display: 'flex', flexWrap: 'wrap' as const, gap: '3px 6px', alignItems: 'center' },
  beat: {
    fontSize: '10px',
    padding: '0 4px',
    borderRadius: '3px',
    background: 'color-mix(in srgb, currentColor 12%, transparent)',
    opacity: 0.85,
  },
  warn: { fontSize: '10px', color: 'var(--dsh-color-warning, #d08b1a)' },
  error: { color: 'var(--dsh-color-danger, #d9534f)', lineHeight: 1.5, whiteSpace: 'pre-wrap' as const },
  button: {
    alignSelf: 'flex-start' as const,
    padding: '3px 8px',
    fontSize: '11px',
    borderRadius: '4px',
    border: '1px solid currentColor',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
  },
} as const

/**
 * Read the project of one session, re-reading whenever `attempt` changes.
 *
 * @param sessionId - the session to read.
 * @param workspaceRoot - the session's workspace root, or undefined while the
 * session list has not resolved it; reading before then would resolve the
 * document against a root this session does not have.
 * @param attempt - bump to re-read.
 * @returns the read.
 */
function useProject(sessionId: SessionId, workspaceRoot: string | undefined, attempt: number): ProjectRead {
  const [project, setProject] = useState<ProjectRead>({ status: 'loading' })

  useEffect(() => {
    if (workspaceRoot === undefined) return
    const controller = new AbortController()
    setProject({ status: 'loading' })
    const remote = clientRemoteRef.current
    if (remote === undefined) {
      setProject({ status: 'error', message: 'the composer client half has no Remote face' })
      return () => {
        controller.abort()
      }
    }
    void readProject(remote, sessionId, controller.signal, workspaceRoot).then(
      (next) => {
        if (!controller.signal.aborted) setProject(next)
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setProject({ status: 'error', message: describe(error) })
      },
    )
    return () => {
      controller.abort()
    }
  }, [sessionId, workspaceRoot, attempt])

  return project
}

/** The Remote face captured at activation; the slot props do not carry services. */
const clientRemoteRef: { current: ClientContext['remote'] | undefined } = { current: undefined }

/**
 * One chapter card.
 *
 * @param props - the card and the panel's translator.
 * @returns the card.
 */
function Card({ card, t }: { card: BoardCard; t: Translator }): React.ReactNode {
  const title = card.title.trim() === '' ? `第${String(card.number)}章` : card.title
  return (
    <div style={STYLE.card} title={card.synopsis.trim() === '' ? undefined : card.synopsis}>
      <div style={STYLE.cardTop}>
        <span style={STYLE.cardNumber}>{String(card.number).padStart(3, '0')}</span>
        <span style={STYLE.cardTitle}>{title}</span>
        {card.volume > 0 && <span style={STYLE.cardNumber}>卷{String(card.volume)}</span>}
      </div>
      <div style={STYLE.cardRow}>
        <span style={STYLE.meta}>
          {String(card.wordCount)}
          {card.targetWords > 0 ? ` / ${String(card.targetWords)}` : ''} {t('board.words')}
        </span>
        {!card.written && <span style={STYLE.warn}>{t('board.unwritten')}</span>}
      </div>
      {(card.beats.length > 0 || card.missing.length > 0 || !card.hasHook) && (
        <div style={STYLE.cardRow}>
          {card.beats.map((beat) => (
            <span key={beat} style={STYLE.beat}>
              {beat}
            </span>
          ))}
          {!card.hasHook && <span style={STYLE.warn}>{t('board.noHook')}</span>}
          {card.missing.length > 0 && (
            <span style={STYLE.warn}>
              {t('board.contractGaps')} {String(card.missing.length)}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * The project overview above the board.
 *
 * @param props - the board and the panel's translator.
 * @returns the overview strip.
 */
function Overview({ board, t }: { board: KanbanBoard; t: Translator }): React.ReactNode {
  const { progress, stage } = board
  const written = progress.chapters - progress.emptyChapters.length
  const stats: readonly { readonly label: string; readonly value: string }[] = [
    { label: t('board.written'), value: `${String(written)}/${String(progress.chapters)}` },
    { label: t('board.words'), value: String(progress.totalWords) },
    { label: t('board.cast'), value: String(board.cast) },
    { label: t('board.world'), value: String(board.world) },
    { label: t('board.links'), value: String(board.openLinks.length) },
    { label: t('board.naming'), value: String(board.naming) },
  ]

  return (
    <div style={STYLE.overview}>
      <div style={STYLE.stat}>
        <span style={STYLE.meta}>{t('board.stage')}</span>
        <span style={STYLE.statValue}>{STAGE_LABELS[stage.stage] ?? stage.stage}</span>
      </div>
      {stats.map((stat) => (
        <div key={stat.label} style={STYLE.stat}>
          <span style={STYLE.meta}>{stat.label}</span>
          <span style={STYLE.statValue}>{stat.value}</span>
        </div>
      ))}
      {stage.blockers.length > 0 && (
        <div style={STYLE.blockers}>
          {t('board.blockers')}: {stage.blockers.join(' · ')}
        </div>
      )}
    </div>
  )
}

/**
 * One lifecycle column.
 *
 * @param props - the column's status, cards, and the panel's translator.
 * @returns the column.
 */
function Column({
  status,
  cards,
  words,
  t,
}: {
  status: ChapterStatus
  cards: readonly BoardCard[]
  words: number
  t: Translator
}): React.ReactNode {
  return (
    <div style={STYLE.column}>
      <div style={STYLE.columnHead}>
        <span style={STYLE.columnTitle}>{STATUS_LABELS[status]}</span>
        <span style={STYLE.meta}>
          {String(cards.length)} · {String(words)} {t('board.words')}
        </span>
      </div>
      {cards.map((card) => (
        <Card key={card.id} card={card} t={t} />
      ))}
    </div>
  )
}

/**
 * The tab body.
 *
 * Whether the tab is *shown* is decided here rather than at registration, for a
 * reason the framework makes unavoidable: a `conversation.view` entry must be on
 * the ledger for its component to run at all, so a registry-level decision would
 * need the workspace before the view could ask for it. Rendering nothing is
 * therefore what "this workspace has no novel project" looks like — the shell
 * omits a view that renders nothing, so the tab simply is not there.
 *
 * The workspace root comes from the session list through the standard
 * `useSessions` hook, not from an injected value: it is a property of the session
 * the shell already resolved, and reading it here keeps the registration free of
 * anything that could disagree with it.
 *
 * @param props - composed slot props: the session identity, the standard session
 * list selector, the owner's view request, and the bound translator.
 * @returns the Kanban board, or nothing where the workspace holds no project.
 */
function KanbanView({
  sessionId,
  useSessions,
  viewRequest,
  completeViewRequest,
  t,
}: ComposedProps<typeof VIEW_SLOT, string, never, undefined, object, never, typeof KANBAN_NS>): React.ReactNode {
  const [attempt, setAttempt] = useState(0)
  const workspaceRoot = useSessions((list: SessionListState) => list.byId[sessionId]?.cwd)
  const project = useProject(sessionId, workspaceRoot, attempt)
  const read = project.status === 'ready' ? project : undefined

  // Projected once per read rather than once per render: the board is cheap but
  // not free, and a pane re-renders for reasons that have nothing to do with the
  // project.
  const shown = useMemo(
    () => (read === undefined ? undefined : { board: boardOf(read.state), at: read.state.updatedAt }),
    [read?.state],
  )

  const refresh = useCallback(() => {
    setAttempt((value) => value + 1)
  }, [])

  // A focus request addressed to this view is the shell's own "show me this
  // again" signal, so it re-reads rather than waiting to be asked twice.
  const focus = viewRequest === null ? undefined : viewRequest.focus
  useEffect(() => {
    if (focus === undefined) return
    completeViewRequest()
    refresh()
  }, [focus, completeViewRequest, refresh])

  // The workspace root is not known until the session list resolves it; reading
  // before then would resolve the document against the wrong directory.
  if (workspaceRoot === undefined) return null
  // A workspace that is not a composer project gets no tab: the one state that
  // means "there is no novel here" is the only one that renders nothing.
  if (project.status === 'none') return null

  return (
    <div style={STYLE.root}>
      {project.status === 'loading' && <div style={STYLE.dim}>{t('board.reading')}</div>}
      {project.status === 'error' && (
        <div>
          <div style={STYLE.error}>{project.message}</div>
          {shown !== undefined && <div style={STYLE.meta}>{t('board.stale')}</div>}
        </div>
      )}
      {shown !== undefined && <Board board={shown.board} meta={metaOf(shown.at, t)} onRefresh={refresh} t={t} />}
    </div>
  )
}

/**
 * The header line's right-hand facts.
 *
 * @param at - when the project was last written.
 * @param t - the panel's translator.
 * @returns the fact, or undefined while there is nothing to say.
 */
function metaOf(at: string, t: Translator): string | undefined {
  return at === '' ? undefined : `${t('board.updated')} ${at}`
}

/**
 * The board, its header, and its refresh control.
 *
 * @param props - the board, the header's meta line, and the refresh callback.
 * @returns the board.
 */
function Board({
  board,
  meta,
  onRefresh,
  t,
}: {
  board: KanbanBoard
  meta: string | undefined
  onRefresh: () => void
  t: Translator
}): React.ReactNode {
  return (
    <>
      <div style={STYLE.boardHead}>
        <h2 style={STYLE.title}>{t('board.columns')}</h2>
        {meta !== undefined && <span style={STYLE.meta}>{meta}</span>}
        <span style={{ flex: 1 }} />
        <button type="button" style={STYLE.button} onClick={onRefresh}>
          {t('board.refresh')}
        </button>
      </div>
      <Overview board={board} t={t} />
      {board.progress.chapters === 0 ? (
        <p style={STYLE.dim}>{t('board.empty')}</p>
      ) : (
        <div style={STYLE.board}>
          {board.columns.map((column) => (
            <Column key={column.status} status={column.status} cards={column.cards} words={column.words} t={t} />
          ))}
        </div>
      )}
    </>
  )
}

/** What one probe of a session's workspace found. */
export type NovelProbe = 'novel' | 'absent' | 'unknown'

/**
 * Register the Kanban view beside Chat and Trajectory.
 *
 * The entry goes on the ledger once, through `ctx.slots.inject` — which also
 * covers the ordinary boot order, where the Conversation package declares
 * `conversation.view` after this plugin applies. Whether the tab is *visible* is
 * the component's answer, not the registry's; see {@link KanbanView}.
 *
 * @param ctx - client root context carrying the slot registry and the locale
 * registry.
 */
export function installKanbanView(ctx: ClientContext): void {
  const t = ctx.locale.bind(KANBAN_NS)
  ctx.effect(() => {
    const disposeLocale = ctx.locale.register(KANBAN_NS, { zh, en })
    const disposeView = ctx.slots.inject(VIEW_SLOT, () =>
      ctx.slots.register(
        {
          name: VIEW_SLOT,
          id: KANBAN_VIEW_ID,
          order: KANBAN_VIEW_ORDER,
          label: () => t('view.kanban'),
          locale: KANBAN_NS,
          registrant: KANBAN_VIEW_ID,
        },
        KanbanView,
      ),
    )
    return () => {
      disposeView()
      disposeLocale()
    }
  }, 'ai-webnovel-composer-client: kanban view')
}
