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
 *   view that renders nothing still shows a tab. {@link installKanbanView} keeps
 *   the entry on the ledger and the component renders nothing where the workspace
 *   holds no project, so a non-novel session has exactly the two tabs it always
 *   had.
 *
 * The view owns no state of its own beyond what it read: the board is a pure
 * projection of the project ({@link boardOf}), and the project is read through
 * the same Remote and the same core codec the sidebar panel uses — the one face
 * captured at activation in `./remote.ts`.
 *
 * @module @ai-novelist/novelist-skill/client/kanban
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Side-effect type imports: each contributes the augmentation this module needs —
// `ctx.slots`, the conversation ViewMap and its standard props, the session
// standard props carrying `sessionId` and the `useSessions` selector, and
// `ctx.locale` with the namespace table this module's dictionary joins. The
// Remote face is read from `./remote.ts`, which names its own augmentation.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ComposedProps } from '@deepseek-ai/dsh-client-ui-slots'
import { CHAPTER_STATUSES } from '../core/types.ts'
import type { ChapterStatus } from '../core/types.ts'
import { draftRatioLabel } from '../core/plan.ts'
import { describe, readProject } from './project.ts'
import type { ProjectRead, SessionId } from './project.ts'
import { clientRemote, NO_REMOTE_MESSAGE } from './remote.ts'
import { boardOf } from './board.ts'
import type { BoardCard, DocumentCard, KanbanBoard } from './board.ts'
import { documentViewsOf } from './document-views.ts'
import type { DocumentView } from './document-views.ts'

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
  'board.empty': '这个项目还没有章节。让 agent 用 novel_plan 写下章节细纲，卡片就会出现在这里；上面的过程文档是它们的依据。',
  'board.columns': '章节看板',
  'board.documents': '过程文档',
  'board.refresh': '重新读取',
  'board.reading': '正在读取小说项目…',
  'board.stale': '项目文档读取失败，下面是上一次读到的内容。',
  'board.unwritten': '未写正文',
  'board.words': '字',
  'board.noHook': '缺章末钩子',
  'board.contractGaps': '细纲未答',
  'board.spaceTimeGaps': '缺时间/地点',
  'board.stage': '阶段',
  'board.blockers': '进入下一阶段还缺',
  'board.cast': '人物',
  'board.world': '世界观',
  'board.links': '未兑现伏笔',
  'board.naming': '候选书名',
  'board.written': '已写',
  'board.updated': '更新于',
  'board.settings': '设定确认',
  'board.style': '文风复核',
  'board.confirmed': '已确认',
  'board.unconfirmed': '未确认',
  'board.notDue': '黄金三章后',
  'board.docMissing': '未开始',
  'board.docDraft': '待确认',
  'board.docConfirmed': '已完成',
  'board.docGaps': '还缺',
  'board.docGateProse': '卡住正文',
  'board.docGateSkeleton': 'go 之后才做',
  'board.docNext': '下一步',
  'board.docUnits': '条',
  'board.docVolumes': '卷',
  'board.docChapters': '章',
  'board.docFields': '项',
  'board.viewerClose': '关闭',
  'board.viewerBack': '返回列表',
  'board.viewerSource': '来源',
  'doc.pitch.label': '立意与核心设定',
  'doc.pitch.detail': '一句话记忆点、核心情绪、爽点清单、差异点、精神内核、篇幅四问',
  'doc.pitch.next': 'novel_plan operation="pitch" 写立意；再与用户讨论并确认（novel_confirm kind="settings"）',
  'doc.competitors.label': '竞品拆解',
  'doc.competitors.detail': '同榜 20–50 本的拆解，落盘在 .novel/竞品拆解.md',
  'doc.competitors.next': 'novel_plan operation="competitor" 每本一次',
  'doc.naming.label': '候选书名',
  'doc.naming.detail': '书名/简介/标签备选，验证阶段逐个测',
  'doc.naming.next': 'novel_plan operation="naming"（至少 3 组）',
  'doc.world.label': '世界观设定',
  'doc.world.detail': '地点、势力、力量体系、物件、历史：每条都要写清代价与限制',
  'doc.world.next': 'novel_bible kind="world"，写完与用户确认（novel_confirm kind="world"）',
  'doc.cast.label': '人物设定',
  'doc.cast.detail': '三档：主要角色全 spine（身份、欲望、性格、说话方式，另加恐惧、执念、软肋、成长线）；配角（本卷/本地图或有台词）要身份、欲望、性格、说话方式；路人只要「他是谁 + 首次出场章」，不计欠账',
  'doc.cast.next': 'novel_bible kind="character"，写完与用户确认（novel_confirm kind="cast"）',
  'doc.de-ai.label': '去 AI 化诊断',
  'doc.de-ai.detail': '黄金三章成稿后逐章做模型评审：对照本书《写作风格》七要素与负面清单，给出原文引用、为什么像 AI、具体怎么改',
  'doc.de-ai.next': 'novel_review operation="ai-flavor" chapterId=<章> 逐章诊断；只查了一部分时看板会点名还差哪几章。加 rewrite=true 另给一份改写提案，改完把整章重新 novel_write 覆盖',
  'doc.outline.label': '全书大纲',
  'doc.outline.detail': '故事梗概、主角/伙伴/反派成长线、阵营演变、对抗副本、得失，以及三幕与完整骨架',
  'doc.outline.next': 'novel_plan operation="outline" 先把故事讲完整，再与用户确认这一层',
  'doc.story.label': '故事六要素',
  'doc.story.detail': '时间、地点、人物、起因、经过、结果：前五项写在全书大纲的「故事六要素」，人物来自人物设定',
  'doc.story.next': 'novel_plan operation="outline" 的 storyTime / storyPlace / storyCause / storyProcess / storyResult 参数；人物用 novel_bible kind="character"',
  'doc.cheat.label': '金手指',
  'doc.cheat.detail': '名称、归属、规则、代价、限制、成长曲线、首次亮相：没有代价与限制的金手指会让任何冲突失去张力',
  'doc.cheat.next': 'novel_plan operation="cheat"（cheatName / cheatOwner / cheatRule / cheatCost / cheatLimits / cheatGrowth / cheatReveal）',
  'doc.style.label': '写作风格',
  'doc.style.detail': '文风基调、人称与视角、句式与节奏、遣词用句、对话与描写、情绪落点、负面清单',
  'doc.style.next': 'novel_plan operation="outline" 的七个 style* 参数：写全之前 novel_write 拒绝写正文',
  'doc.volumes.label': '分卷大纲',
  'doc.volumes.detail': '一卷一个文件（分卷大纲/第N卷.md）：独立目标、矛盾、阶段性高潮、卷末钩子、卷内节奏与叙事骨架。改后面的卷不重写前面的卷',
  'doc.volumes.next': 'novel_plan operation="volume" 每卷一次，再与用户确认（novel_confirm kind="volume"）',
  'doc.beats.label': '爽点节拍表',
  'doc.beats.detail': '每 3 章小爽点、每 10 章大爽点、每卷卷末爆点的落点',
  'doc.beats.next': 'novel_plan operation="beat"',
  'doc.opening.label': '开篇工程清单',
  'doc.opening.detail': '前 300 字冲突、章末钩子、金手指亮相、前 10 章小高潮等逐项确认',
  'doc.opening.next': 'novel_plan operation="opening"（不带 key 可以列出清单）',
  'doc.launch.label': '上线决策',
  'doc.launch.detail': '开篇包够不够格投入完整骨架：由人给 go / 改后再说 / 放弃',
  'doc.launch.next': 'novel_plan operation="launch"（非 go 必须写 fallback 与 abandonIf）',
  'doc.serial.label': '连载数据',
  'doc.serial.detail': '平台读数、迭代记录与投入评估；按需抄录，不阻断连载',
  'doc.serial.next': 'novel_assess operation="record" 抄读数，再 operation="evaluate" 拿裁决',
  'doc.retro.label': '完本复盘',
  'doc.retro.detail': '完本复盘、IP 素材与可复用模板',
  'doc.retro.next': 'novel_repo operation="retro"',
} as const

/**
 * The dictionary's key domain: what a `t` binding for this namespace accepts.
 *
 * Spelled as a union of the dictionary's own keys plus the document keys, which
 * are generated from the documents' ids rather than listed: a new document in
 * `./board.ts` brings three keys with it, and the type that says so is one line
 * rather than a table that can fall out of step with the copy.
 */
export type KanbanKey = keyof typeof zh | `doc.${string}.${'label' | 'detail' | 'next'}`

/**
 * The panel's translator, narrowed to this namespace's own keys.
 *
 * Spelled as a plain function type rather than the locale package's generic
 * `TranslateNS` so a component's props can be read without that machinery in
 * view; the `t` seat the framework injects for this namespace satisfies it
 * exactly.
 */
type Translator = (key: KanbanKey, params?: Record<string, unknown>) => string

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** This plugin's Kanban copy, registered with the view. */
    'novel-kanban': KanbanKey
  }
}

/** English dictionary, key for key with {@link zh}. */
const en: Record<KanbanKey, string> = {
  'view.kanban': 'Kanban',
  'board.empty': 'No chapters yet. Ask the agent to plan chapters with novel_plan and the cards appear here; the process documents above are what they rest on.',
  'board.columns': 'Chapter board',
  'board.documents': 'Process documents',
  'board.refresh': 'Refresh',
  'board.reading': 'Reading the novel project…',
  'board.stale': 'The project document could not be read; showing the last successful read.',
  'board.unwritten': 'no prose',
  'board.words': 'words',
  'board.noHook': 'no chapter hook',
  'board.contractGaps': 'contract gaps',
  'board.spaceTimeGaps': 'missing time/place',
  'board.stage': 'Stage',
  'board.blockers': 'Before the next stage',
  'board.cast': 'Cast',
  'board.world': 'World',
  'board.links': 'Open promises',
  'board.naming': 'Naming candidates',
  'board.written': 'written',
  'board.updated': 'updated',
  'board.settings': 'Settings sign-off',
  'board.style': 'Voice review',
  'board.confirmed': 'confirmed',
  'board.unconfirmed': 'not confirmed',
  'board.notDue': 'after the golden three',
  'board.docMissing': 'not started',
  'board.docDraft': 'awaiting sign-off',
  'board.docConfirmed': 'complete',
  'board.docGaps': 'still owes',
  'board.docGateProse': 'blocks prose',
  'board.docGateSkeleton': 'after the launch decision',
  'board.docNext': 'Next',
  'board.docUnits': 'entries',
  'board.docVolumes': 'vols',
  'board.docChapters': 'ch',
  'board.docFields': 'fields',
  'board.viewerClose': 'Close',
  'board.viewerBack': 'Back to list',
  'board.viewerSource': 'Source',
  'doc.pitch.label': 'Premise & core settings',
  'doc.pitch.detail': 'The one-sentence memorable point, core emotion, payoff list, differentiators, kernel, and the four length questions',
  'doc.pitch.next': 'novel_plan operation="pitch" for the premise, then discuss and confirm it with the author (novel_confirm kind="settings")',
  'doc.competitors.label': 'Competitor study',
  'doc.competitors.detail': '20–50 leaderboard titles dismantled, kept in .novel/竞品拆解.md',
  'doc.competitors.next': 'novel_plan operation="competitor", once per title',
  'doc.naming.label': 'Naming candidates',
  'doc.naming.detail': 'Candidate title/blurb/tag sets, tested one by one at validation',
  'doc.naming.next': 'novel_plan operation="naming" (at least 3 sets)',
  'doc.world.label': 'World',
  'doc.world.detail': 'Places, factions, power systems, items, history: every rule owes its cost and its limits',
  'doc.world.next': 'novel_bible kind="world", then confirm the layer with the author (novel_confirm kind="world")',
  'doc.cast.label': 'Cast',
  'doc.cast.detail': 'Three tiers: main characters owe the full spine (identity, goal, personality, voice, plus fear, obsession, weakness, arc); volume characters owe identity, goal, personality and voice; walk-ons owe only who they are and their first chapter, and never count as debt',
  'doc.cast.next': 'novel_bible kind="character", then confirm the layer with the author (novel_confirm kind="cast")',
  'doc.de-ai.label': 'De-AI diagnosis',
  'doc.de-ai.detail': 'Once the golden three chapters exist, one model review per chapter against the book’s 写作风格 and 负面清单, quoting the text, saying why it reads as machine-written, and how to fix it',
  'doc.de-ai.next': 'novel_review operation="ai-flavor" chapterId=<chapter>, one per chapter; the board names the chapters still unreviewed. rewrite=true adds a rewritten draft; send the revision back through novel_write',
  'doc.outline.label': 'Whole-book outline',
  'doc.outline.detail': 'The story, the protagonist/companion/antagonist arcs, the factions, each confrontation and its cost, plus acts and the full skeleton',
  'doc.outline.next': 'novel_plan operation="outline": tell the story whole, then confirm the layer',
  'doc.story.label': 'Six story elements',
  'doc.story.detail': 'Time, place, characters, cause, process, result — five live in the outline’s 故事六要素 block, characters come from the cast',
  'doc.story.next': 'the storyTime / storyPlace / storyCause / storyProcess / storyResult parameters of novel_plan operation="outline"; characters via novel_bible kind="character"',
  'doc.cheat.label': 'Golden finger',
  'doc.cheat.detail': 'Name, owner, rule, cost, limits, growth curve, first reveal — a cheat with no price or ceiling makes every conflict collapse',
  'doc.cheat.next': 'novel_plan operation="cheat" (cheatName / cheatOwner / cheatRule / cheatCost / cheatLimits / cheatGrowth / cheatReveal)',
  'doc.style.label': 'Writing style',
  'doc.style.detail': 'Tone, person and viewpoint, rhythm, diction, dialogue and description, emotional landing, negative list',
  'doc.style.next': 'the seven style* parameters of novel_plan operation="outline"; novel_write refuses prose until all seven are written',
  'doc.volumes.label': 'Volume outlines',
  'doc.volumes.detail': 'One file per volume (分卷大纲/第N卷.md): its own goal, conflict, stage climax, end hook, internal rhythm and narrative spine — revising a later volume leaves the earlier files alone',
  'doc.volumes.next': 'novel_plan operation="volume", once per volume, then confirm the layer (novel_confirm kind="volume")',
  'doc.beats.label': 'Payoff schedule',
  'doc.beats.detail': 'Where the small payoff every 3 chapters, the big one every 10 and the volume-end climax land',
  'doc.beats.next': 'novel_plan operation="beat"',
  'doc.opening.label': 'Opening checklist',
  'doc.opening.detail': 'Conflict in the first 300 characters, chapter-end hooks, the golden finger on stage, the first small climax by chapter 10',
  'doc.opening.next': 'novel_plan operation="opening" (omit key to list the checklist)',
  'doc.launch.label': 'Launch decision',
  'doc.launch.detail': 'Whether the opening package is worth building out: a human go / revise / abandon',
  'doc.launch.next': 'novel_plan operation="launch" (a verdict that is not go must name fallback and abandonIf)',
  'doc.serial.label': 'Serial data',
  'doc.serial.detail': 'Platform readings, iterations and investment evaluations; transcribed on demand, blocking nothing',
  'doc.serial.next': 'novel_assess operation="record" to transcribe a reading, then operation="evaluate" for the verdict',
  'doc.retro.label': 'Retrospective',
  'doc.retro.detail': 'The completion retrospective, IP assets and reusable templates',
  'doc.retro.next': 'novel_repo operation="retro"',
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
  'opening-package': '开篇包',
  'opening-decision': '上线决策',
  'full-outline': '完整大纲',
  serializing: '连载中',
  completed: '已完结',
}

/**
 * The three standings, as colours.
 *
 * One hue per state, chosen to stay distinguishable both as a text colour on a
 * light background and as a filled chip under white text: a settled document is
 * green, one still being written is amber, and one nobody has started is slate.
 * The card carries the hue three ways — a tinted fill, a coloured left rule and a
 * filled state badge — so the row is readable at a glance without reading every
 * label. The darker values are deliberate: they are used as chip backgrounds, and
 * white text on a mid-tone amber would not be legible.
 */
const DOC_STATE_TONES: Readonly<Record<DocumentCard['state'], string>> = {
  confirmed: '#1f7a58',
  draft: '#9a6207',
  missing: '#5f6673',
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
  docs: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '6px',
    // The process documents are what a project has *before* it has chapters, so
    // the section is capped and scrolls rather than pushing the chapter columns
    // off the pane — an author who wants the whole document row can scroll it,
    // and the chapters stay where they were.
    flex: '0 0 auto',
    maxHeight: '46%',
    minHeight: 0,
  },
  docRow: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: '6px',
    alignContent: 'flex-start' as const,
    overflowY: 'auto' as const,
    minHeight: 0,
    paddingBottom: '2px',
  },
  doc: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '2px',
    flex: '1 1 150px',
    minWidth: '140px',
    maxWidth: '240px',
    padding: '5px 7px',
    borderRadius: '5px',
    background: 'color-mix(in srgb, currentColor 5%, transparent)',
    border: '1px solid color-mix(in srgb, currentColor 12%, transparent)',
  },
  docMuted: { opacity: 0.6, borderStyle: 'dashed' as const },
  docFoot: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '6px' },
  docLabel: { fontWeight: 600, fontSize: '11px', whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis' },
  docState: {
    fontSize: '9px',
    padding: '0 5px',
    borderRadius: '999px',
    border: '1px solid transparent',
    color: '#fff',
    whiteSpace: 'nowrap' as const,
  },
  docClickable: { cursor: 'pointer' },
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
  backdrop: {
    position: 'fixed' as const,
    inset: 0,
    zIndex: 1000,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '16px',
    background: 'rgba(0, 0, 0, 0.45)',
  },
  modal: {
    display: 'flex',
    flexDirection: 'column' as const,
    width: 'min(880px, 94vw)',
    maxHeight: '86vh',
    minHeight: '160px',
    overflow: 'hidden',
    borderRadius: '8px',
    border: '1px solid color-mix(in srgb, currentColor 24%, transparent)',
    background: 'var(--dsh-color-bg, Canvas)',
    color: 'var(--dsh-color-fg, CanvasText)',
    boxShadow: '0 18px 48px rgba(0, 0, 0, 0.35)',
  },
  modalHead: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '9px 12px',
    borderBottom: '1px solid color-mix(in srgb, currentColor 16%, transparent)',
  },
  modalTitle: {
    flex: 1,
    minWidth: 0,
    fontSize: '13px',
    fontWeight: 600,
    whiteSpace: 'nowrap' as const,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  modalBody: { minHeight: 0, overflow: 'auto' as const, padding: '12px' },
  modalClose: {
    flex: '0 0 auto',
    width: '26px',
    height: '26px',
    padding: 0,
    fontSize: '16px',
    lineHeight: 1,
    borderRadius: '5px',
    border: '1px solid color-mix(in srgb, currentColor 30%, transparent)',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
  },
  viewList: { display: 'flex', flexDirection: 'column' as const, gap: '6px', margin: 0, padding: 0, listStyle: 'none' },
  viewItem: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'flex-start',
    gap: '2px',
    width: '100%',
    padding: '8px 10px',
    textAlign: 'left' as const,
    borderRadius: '5px',
    border: '1px solid color-mix(in srgb, currentColor 16%, transparent)',
    background: 'color-mix(in srgb, currentColor 5%, transparent)',
    color: 'inherit',
    cursor: 'pointer',
  },
  viewItemLabel: { fontSize: '12px', fontWeight: 600 },
  viewContent: {
    margin: 0,
    whiteSpace: 'pre-wrap' as const,
    overflowWrap: 'anywhere' as const,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: '11.5px',
    lineHeight: 1.65,
  },
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
    const remote = clientRemote()
    if (remote === undefined) {
      setProject({ status: 'error', message: NO_REMOTE_MESSAGE })
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

/**
 * One process document.
 *
 * The card is deliberately the *same size and shape* as a chapter card, because
 * the two are the two halves of one pipeline and an author reads them together:
 * the top row says what the document is and where it stands, the bottom row says
 * how much of it exists, what it still owes, and — when it gates something — that
 * it does.
 *
 * A card with readable content becomes a button: one click opens the file, or,
 * when the document owns several files, the list they are chosen from. A card
 * with nothing to read stays a plain card rather than a button that opens an
 * empty modal, which is why {@link DocumentView} emptiness is decided before it
 * reaches here.
 *
 * `next` is the card's tooltip rather than a line on the face of it: four lines of
 * Chinese action text per card would turn a twelve-card row into a wall, and the
 * tool is named for whoever goes looking.
 *
 * @param props - the document, the views it can open, the open callback, and the
 * panel's translator.
 * @returns the document card.
 */
function DocCard({
  document,
  views,
  onOpen,
  t,
}: {
  document: DocumentCard
  views: readonly DocumentView[]
  onOpen: () => void
  t: Translator
}): React.ReactNode {
  const id = String(document.id)
  const state =
    document.state === 'confirmed'
      ? t('board.docConfirmed')
      : document.state === 'draft'
        ? t('board.docDraft')
        : t('board.docMissing')
  const counts = countLabel(document, t)
  const gate =
    document.gates === 'prose'
      ? t('board.docGateProse')
      : document.gates === 'skeleton'
        ? t('board.docGateSkeleton')
        : undefined
  const viewable = views.length > 0
  const [highlighted, setHighlighted] = useState(false)
  // The state hue is carried by the fill, the left rule and the badge. Mixing
  // the line toward currentColor keeps it visible on both a light and a dark
  // shell; the fill stays a tint so the card's own text is never competed with.
  const tone = DOC_STATE_TONES[document.state]
  const edge = `color-mix(in srgb, ${tone} 72%, currentColor)`
  const fill = `color-mix(in srgb, ${tone} ${viewable ? 16 : 8}%, transparent)`
  const title = [t(`doc.${id}.detail`), `${t('board.docNext')}: ${t(`doc.${id}.next`)}`]
    .filter((line): line is string => line !== undefined && line !== '')
    .join('\n')
  const open = (): void => {
    if (viewable) onOpen()
  }
  return (
    <div
      style={{
        ...STYLE.doc,
        background: highlighted && viewable ? `color-mix(in srgb, ${tone} 25%, transparent)` : fill,
        borderColor: edge,
        boxShadow: `inset 3px 0 0 ${edge}`,
        ...(viewable ? STYLE.docClickable : STYLE.docMuted),
      }}
      title={title}
      role={viewable ? 'button' : undefined}
      tabIndex={viewable ? 0 : undefined}
      onClick={viewable ? open : undefined}
      onMouseEnter={
        viewable
          ? (): void => {
              setHighlighted(true)
            }
          : undefined
      }
      onMouseLeave={
        viewable
          ? (): void => {
              setHighlighted(false)
            }
          : undefined
      }
      onFocus={
        viewable
          ? (): void => {
              setHighlighted(true)
            }
          : undefined
      }
      onBlur={
        viewable
          ? (): void => {
              setHighlighted(false)
            }
          : undefined
      }
      onKeyDown={
        viewable
          ? (event): void => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                open()
              }
            }
          : undefined
      }
    >
      <div style={STYLE.docFoot}>
        <span style={STYLE.docLabel} title={t(`doc.${id}.label`)}>
          {t(`doc.${id}.label`)}
        </span>
        <span style={{ ...STYLE.docState, background: tone, borderColor: tone }}>{state}</span>
      </div>
      {(counts !== undefined || gate !== undefined) && (
        <div style={STYLE.docFoot}>
          {counts !== undefined && <span style={STYLE.meta}>{counts}</span>}
          {gate !== undefined && <span style={STYLE.warn}>{gate}</span>}
        </div>
      )}
      {document.gaps.length > 0 && (
        <span style={STYLE.meta} title={document.gaps.join('、')}>
          {t('board.docGaps')} {document.gaps.slice(0, 3).join('、')}
          {document.gaps.length > 3 ? ` +${String(document.gaps.length - 3)}` : ''}
        </span>
      )}
    </div>
  )
}

/**
 * How much of one document exists, as the card's one number.
 *
 * `done / total` when the document has a complete size, the bare count when it
 * does not (world facts and beats have no ceiling — "12 条" is the whole fact), and
 * nothing where the document counts nothing at all: 立意 counts its fields, 大纲 its
 * narrative elements, 分卷 its volumes, 竞品 its dismantled titles. The unit is chosen
 * per document because the documents genuinely count different things.
 *
 * @param document - the document to describe.
 * @param t - the panel's translator.
 * @returns the label, or undefined when there is no number to show.
 */
function countLabel(document: DocumentCard, t: Translator): string | undefined {
  const unit =
    document.id === 'volumes'
      ? t('board.docVolumes')
      : document.id === 'outline' || document.id === 'style' || document.id === 'pitch'
        ? t('board.docFields')
        : t('board.docUnits')
  if (document.total > 0) {
    return `${String(document.done)}/${String(document.total)} ${unit}`
  }
  return document.done > 0 ? `${String(document.done)} ${unit}` : undefined
}

/** What the document modal is showing: a list of views, or one view. */
interface ViewerState {
  /** The document's display name, used while the list is showing. */
  readonly title: string
  /** What this document can open. */
  readonly views: readonly DocumentView[]
  /** Index of the open view; `null` while the list is showing. */
  readonly index: number | null
}

/**
 * The document viewer.
 *
 * One modal serves both shapes the process documents need. A document with one
 * artefact opens straight into it; a document with several (`分卷大纲`, the payoff
 * schedule, the de-AI reviews) opens into a list first, and choosing an item
 * replaces the list with that artefact's text. The close button is always in the
 * same place, and Escape or a click on the backdrop closes it too — three ways
 * out because a modal with only one is the kind authors get stuck behind.
 *
 * Rendered inline rather than through a portal: the conversation view is a
 * normal pane, and `position: fixed` on a full-viewport backdrop is enough for a
 * dialog that should cover the board without pulling `react-dom` into the
 * plugin's module surface.
 *
 * @param props - the document's name, its views, the open index, the selection
 * and close callbacks, and the panel's translator.
 * @returns the dialog, or nothing while it is closed.
 */
function DocumentModal({
  title,
  views,
  index,
  onSelect,
  onClose,
  t,
}: {
  title: string
  views: readonly DocumentView[]
  index: number | null
  onSelect: (index: number | null) => void
  onClose: () => void
  t: Translator
}): React.ReactNode {
  const view = index === null ? undefined : views[index]
  const heading = view?.label ?? title
  return (
    <div
      style={STYLE.backdrop}
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        style={STYLE.modal}
        role="dialog"
        aria-modal="true"
        aria-label={heading}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            onClose()
          }
        }}
      >
        <div style={STYLE.modalHead}>
          {view !== undefined && views.length > 1 && (
            <button
              type="button"
              style={{ ...STYLE.button, alignSelf: 'center' }}
              onClick={() => onSelect(null)}
            >
              {t('board.viewerBack')}
            </button>
          )}
          <span style={STYLE.modalTitle} title={heading}>
            {heading}
          </span>
          <button
            type="button"
            style={STYLE.modalClose}
            onClick={onClose}
            aria-label={t('board.viewerClose')}
            title={t('board.viewerClose')}
            autoFocus
          >
            ×
          </button>
        </div>
        <div style={STYLE.modalBody}>
          {view === undefined ? (
            <ul style={STYLE.viewList}>
              {views.map((entry, entryIndex) => (
                <li key={entry.id}>
                  <button type="button" style={STYLE.viewItem} onClick={() => onSelect(entryIndex)}>
                    <span style={STYLE.viewItemLabel}>{entry.label}</span>
                    <span style={STYLE.meta} title={entry.source}>
                      {t('board.viewerSource')}: {entry.source}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <>
              <div style={STYLE.meta} title={view.source}>
                {t('board.viewerSource')}: {view.source}
              </div>
              <pre style={STYLE.viewContent}>{view.content}</pre>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * The process documents, as one row.
 *
 * This is the half of the board a project has before it has any chapters, which
 * is why it renders unconditionally: four empty chapter columns say "nothing has
 * been written", and the documents row says what *has* been decided. It also
 * owns the one piece of state the row needs — which document, if any, is open in
 * the viewer.
 *
 * @param props - the documents, the views each can open, and the panel's translator.
 * @returns the section, or nothing when the project has no documents to show.
 */
function Documents({
  documents,
  views,
  t,
}: {
  documents: readonly DocumentCard[]
  views: Readonly<Record<string, readonly DocumentView[]>>
  t: Translator
}): React.ReactNode {
  const [viewer, setViewer] = useState<ViewerState | null>(null)
  const close = useCallback(() => {
    setViewer(null)
  }, [])
  const select = useCallback((next: number | null) => {
    setViewer((current) => (current === null ? null : { ...current, index: next }))
  }, [])
  if (documents.length === 0) return null
  return (
    <section style={STYLE.docs}>
      <h2 style={STYLE.title}>{t('board.documents')}</h2>
      <div style={STYLE.docRow}>
        {documents.map((document) => {
          const found = views[document.id] ?? []
          return (
            <DocCard
              key={document.id}
              document={document}
              views={found}
              t={t}
              onOpen={() => {
                setViewer({
                  title: t(`doc.${document.id}.label`),
                  views: found,
                  // One artefact opens directly; several open into the list, so
                  // the author chooses rather than getting an arbitrary first.
                  index: found.length === 1 ? 0 : null,
                })
              }}
            />
          )
        })}
      </div>
      {viewer !== null && (
        <DocumentModal
          title={viewer.title}
          views={viewer.views}
          index={viewer.index}
          onSelect={select}
          onClose={close}
          t={t}
        />
      )}
    </section>
  )
}

/**
 * One chapter card.
 *
 * @param props - the card and the panel's translator.
 * @returns the card.
 */
function Card({ card, t }: { card: BoardCard; t: Translator }): React.ReactNode {
  const title = card.title.trim() === '' ? `第${String(card.number)}章` : card.title
  // The card shows the length the column is measured against: a first draft
  // runs to the draft ratio of the target so that 去 AI 化 and hand-cutting
  // cannot leave the finished chapter short, and the trimmed chapter is
  // measured at 100%.
  const gateWords = card.lengthGate === 'draft' ? card.draftWords : card.targetWords
  const gateHint =
    card.lengthGate === 'draft' && card.draftWords > 0
      ? `初稿目标 ${String(card.draftWords)} 字（成稿 ${String(card.targetWords)} 字的 ${draftRatioLabel()}）`
      : card.targetWords > 0
        ? `成稿目标 ${String(card.targetWords)} 字（-5%/+15%）`
        : undefined
  return (
    <div style={STYLE.card} title={card.synopsis.trim() === '' ? undefined : card.synopsis}>
      <div style={STYLE.cardTop}>
        <span style={STYLE.cardNumber}>{String(card.number).padStart(3, '0')}</span>
        <span style={STYLE.cardTitle}>{title}</span>
        {card.volume > 0 && <span style={STYLE.cardNumber}>卷{String(card.volume)}</span>}
      </div>
      <div style={STYLE.cardRow}>
        <span style={STYLE.meta} title={gateHint}>
          {String(card.wordCount)}
          {gateWords > 0 ? ` / ${String(gateWords)}` : ''} {t('board.words')}
        </span>
        {!card.written && <span style={STYLE.warn}>{t('board.unwritten')}</span>}
      </div>
      {(card.beats.length > 0 || card.missing.length > 0 || card.spaceTimeMissing.length > 0 || !card.hasHook) && (
        <div style={STYLE.cardRow}>
          {card.beats.map((beat) => (
            <span key={beat} style={STYLE.beat}>
              {beat}
            </span>
          ))}
          {!card.hasHook && <span style={STYLE.warn}>{t('board.noHook')}</span>}
          {card.spaceTimeMissing.length > 0 && (
            <span style={STYLE.warn}>
              {t('board.spaceTimeGaps')} {card.spaceTimeMissing.join('/')}
            </span>
          )}
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
  const layers = board.confirmations.layers
  // One row per settings layer, so the panel shows *which* layer is still open
  // rather than a single "settings: not confirmed" an author cannot act on.
  const layerRows: readonly { readonly label: string; readonly value: string }[] = layers.map((layer) => ({
    label: layer.label,
    value: layer.confirmed
      ? t('board.confirmed')
      : `${t('board.unconfirmed')} ${String(layer.rounds)}/${String(layer.roundsRequired)}`,
  }))
  const stats: readonly { readonly label: string; readonly value: string }[] = [
    { label: t('board.written'), value: `${String(written)}/${String(progress.chapters)}` },
    { label: t('board.words'), value: String(progress.totalWords) },
    { label: t('board.cast'), value: String(board.cast) },
    { label: t('board.world'), value: String(board.world) },
    { label: t('board.links'), value: String(board.openLinks.length) },
    { label: t('board.naming'), value: String(board.naming) },
    ...layerRows,
    {
      label: t('board.style'),
      value: board.confirmations.styleConfirmed
        ? t('board.confirmed')
        : board.styleDue ? t('board.unconfirmed') : t('board.notDue'),
    },
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
    () =>
      read === undefined
        ? undefined
        : {
            board: boardOf(read.state),
            // Built once with the board: the viewer reads the same files the state
            // was assembled from, so opening a card cannot show a different project
            // than the one the cards were counted from.
            views: documentViewsOf(read.state, read.metadata.index, read.files),
            at: read.state.updatedAt,
          },
    [read?.state, read?.metadata, read?.files],
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
      {shown !== undefined && (
        <Board board={shown.board} views={shown.views} meta={metaOf(shown.at, t)} onRefresh={refresh} t={t} />
      )}
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
  views,
  meta,
  onRefresh,
  t,
}: {
  board: KanbanBoard
  views: Readonly<Record<string, readonly DocumentView[]>>
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
      <Documents documents={board.documents} views={views} t={t} />
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
  }, 'ai-novelist-client: kanban view')
}
