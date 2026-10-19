/**
 * Domain vocabulary of the AI Web Novel Composer, as of schema version 3.
 *
 * Version 2 exists because the SOP this plugin implements is a *pipeline with
 * gates*, not a notebook: the phase you are in, the evidence that let you enter
 * it, the commitments you made to readers, and the numbers you promised to
 * watch all have to be data. Version 1 held a premise, a cast, and chapters;
 * everything else lived in prose and was forgotten.
 *
 * Version 3 exists because the novel's **content** moved out of the JSON
 * document into Markdown files a human can read and edit. `.novel/novel.json`
 * keeps what has to be atomic — the evidence chain the threshold rules compute
 * on, the foreshadowing ledger, the project's metadata — plus {@link StorageIndex},
 * which is the only record of where the content files actually live. The content
 * itself is assembled from those files on read and diffed back out on write, so
 * `core/*` still sees exactly the same {@link NovelState} it always did.
 *
 * Data has exactly one home; `docs/plan-markdown-storage.md` §4 is that table.
 * Where the plan's table does not name a home (candidate naming sets, dismantled
 * competitors, the opening checklist), the field stays in `novel.json`, because
 * "no home named" must never mean "silently dropped".
 *
 * Conventions used throughout:
 *
 * - Every field is plain lossless JSON: no `Map`, no `Date`, no class instance,
 *   because the browser half and the harness session log both read these.
 * - Optional means "not recorded yet", never "empty".
 * - Anything derivable (word counts, stock, gate status) is **not** stored; it is
 *   computed on read so it cannot go stale.
 *
 * @module @ai-novelist/novelist-skill/core/types
 */

/**
 * On-disk schema version written by this build.
 *
 * Version 4 moved the volume outlines out of one collection file
 * (`分卷大纲.md`) and into one file per volume (`分卷大纲/第1卷.md`), so a later
 * volume can be revised while the ones before it are being written. Version 3
 * documents are read by the store's migration, which splits the collection.
 *
 * Version 5 did the same for the chapter plan: the chapter table and the rhythm
 * table are one file per volume (`章节大纲/第1卷.md`), because a 1000-chapter
 * book is a 1000-row table and every plan change rewrote all of it. The
 * whole-book part that is left — the opening-engineering checklist and an index
 * of the per-volume files — stays in `章节大纲.md`. Version 4 documents are
 * split by the store's migration.
 */
export const NOVEL_SCHEMA_VERSION = 5 as const

/** Lifecycle of one chapter from plan to frozen prose. */
export const CHAPTER_STATUSES = ['planned', 'drafting', 'revised', 'final'] as const

/** One entry of {@link CHAPTER_STATUSES}. */
export type ChapterStatus = (typeof CHAPTER_STATUSES)[number]

/** Commercial model the novel is written for. */
export const PLATFORM_MODES = ['paid', 'free', 'unknown'] as const

/** One entry of {@link PLATFORM_MODES}. */
export type PlatformMode = (typeof PLATFORM_MODES)[number]

/** Reader channel. */
export const PLATFORM_AUDIENCES = ['male', 'female', 'general'] as const

/** One entry of {@link PLATFORM_AUDIENCES}. */
export type PlatformAudience = (typeof PLATFORM_AUDIENCES)[number]

/**
 * The pipeline phases of the SOP, in order.
 *
 * Every one of them is derived from what has been **planned and written**, never
 * from a metric reading. Data assessment is not a phase: it is an action the
 * author starts when they want to know whether the book is still worth the
 * investment (see {@link Evaluation}). Keeping the two apart is what lets a
 * project advance while the platform numbers are still unavailable.
 */
export const PROJECT_STAGES = [
  'planning',
  'opening-package',
  'opening-decision',
  'full-outline',
  'serializing',
  'completed',
] as const

/** One entry of {@link PROJECT_STAGES}. */
export type ProjectStage = (typeof PROJECT_STAGES)[number]

/** Metric families: which period of the release a reading belongs to. */
export const METRIC_PERIODS = ['new-book', 'paid', 'free'] as const

/** One entry of {@link METRIC_PERIODS}. */
export type MetricPeriod = (typeof METRIC_PERIODS)[number]

/** The metric keys the SOP watches, by period. */
export const METRIC_KEYS = [
  // new-book period
  'clickRate',
  'readThrough3',
  'followRead10',
  'followRead24h',
  'retention7d',
  'favoriteRate',
  // paid period
  'firstSubscription',
  'averageSubscription',
  'collectToSubscribe',
  'followSubscription',
  'subscription24h',
  // free period
  'completionRate',
  'retention',
  'adUnlock',
  'averageReadPerChapter',
  // author-reported quality signal, 0-100, used by the iteration rules
  'chapterScore',
] as const

/** One entry of {@link METRIC_KEYS}. */
export type MetricKey = (typeof METRIC_KEYS)[number]

/** Lifecycle of one foreshadowing or hook promise. */
export const LINK_STATUSES = ['open', 'paid', 'abandoned'] as const

/** One entry of {@link LINK_STATUSES}. */
export type LinkStatus = (typeof LINK_STATUSES)[number]

/** Outcome of one validation round. */
export const VERDICT_LEVELS = ['pass', 'partial', 'fail'] as const

/** One entry of {@link VERDICT_LEVELS}. */
export type VerdictLevel = (typeof VERDICT_LEVELS)[number]

/** How wide a revision or iteration is allowed to reach. */
export const CHANGE_SCOPES = ['chapter', 'volume', 'whole-book'] as const

/** One entry of {@link CHANGE_SCOPES}. */
export type ChangeScope = (typeof CHANGE_SCOPES)[number]

/** Beat kinds the SOP asks a chapter to carry. */
export const BEAT_KINDS = ['shuang', 'sweet', 'burn', 'tension', 'info', 'turn'] as const

/** One entry of {@link BEAT_KINDS}. */
export type BeatKind = (typeof BEAT_KINDS)[number]

/**
 * The planning fields every chapter contract must answer.
 *
 * The last two carry the chapter's share of the *story* rather than its share of
 * the plot machinery. `novel_plan`'s chapter step used to ask only "what happens"
 * (剧情任务、冲突、情绪回报、信息差、节拍、章末钩子), so a rolling outline of chapters
 * could be complete, rhythmic, and still never say how anyone changed or what it
 * cost — which is how 爽点/爆点 tables end up hanging on nothing. They are
 * waivable like every other field, because a genuinely transitional chapter can
 * answer them in one clause, but they are not silent.
 */
export const CONTRACT_FIELDS = [
  'plotTask',
  'conflict',
  'emotionalPayoff',
  'infoGap',
  'beats',
  'hook',
  'keyBeat',
  'price',
] as const

/** One entry of {@link CONTRACT_FIELDS}. */
export type ContractField = (typeof CONTRACT_FIELDS)[number]

/**
 * The two 时空锚点 a chapter contract carries beside the eight story contracts.
 *
 * They are deliberately **not** in {@link CONTRACT_FIELDS}: the eight contract
 * fields are the prose's binding promises, and every chapter planned before these
 * existed would become "未完成" overnight. The anchors are checked by
 * {@link spaceTimeGaps} and reported by `novel_plan chapter` / `novel_write`
 * instead, so a 300-chapter project keeps its contract completeness while every
 * new chapter is asked when and where it happens.
 *
 * Traditional narrative asks for 时间、地点、人物、起因、经过、结果. 人物 is the cast,
 * and 起因/经过/结果 are the story's own spine; time and place are the two that a
 * scene cannot be written without, which is why they live beside the chapter
 * contract rather than inside the outline only.
 */
export const SPACE_TIME_FIELDS = ['timeAnchor', 'place'] as const

/** One entry of {@link SPACE_TIME_FIELDS}. */
export type SpaceTimeField = (typeof SPACE_TIME_FIELDS)[number]

/** What the two anchors are called wherever a tool or the board reports them. */
export const SPACE_TIME_LABELS: Readonly<Record<SpaceTimeField, string>> = {
  timeAnchor: '时间',
  place: '地点',
}

/** What a chapter's two narrative fields are called, for the tools. */
export const CONTRACT_FIELD_LABELS: Readonly<Record<ContractField, string>> = {
  plotTask: '剧情任务',
  conflict: '冲突',
  emotionalPayoff: '情绪回报',
  infoGap: '信息差',
  beats: '节拍',
  hook: '章末钩子',
  keyBeat: '关键转折',
  price: '代价与收获',
}

/**
 * The narrative-spine fields a volume plan answers, in report order.
 *
 * Deliberately the whole-book spine minus the two whole-book-only fields
 * (`supportArcs`, `conflictArcs`): a volume covers one stage of each arc rather
 * than the arc, so it advances the antagonist, the factions, and the cost — and
 * it advances the companions inside `protagonistArc` rather than re-telling the
 * book's companion roster.
 */
export const VOLUME_SPINE_FIELDS = [
  'synopsis',
  'protagonistArc',
  'antagonistArc',
  'factionShift',
  'mainConflict',
  'costs',
  'gains',
] as const

/** One entry of {@link VOLUME_SPINE_FIELDS}. */
export type VolumeSpineField = (typeof VOLUME_SPINE_FIELDS)[number]

/**
 * The six elements of narrative, in the order a reader meets them.
 *
 * 时间、地点、人物、起因、经过、结果. Five are stored on the outline as
 * {@link STORY_ELEMENT_FIELDS}; 人物 is deliberately *not* duplicated here — the cast
 * file already owns every person, and a second home would drift. The reported
 * list is {@link SIX_ELEMENT_ORDER}, where 人物 is derived from the cast.
 */
export const SIX_ELEMENT_ORDER = ['time', 'place', 'characters', 'cause', 'process', 'result'] as const

/** One entry of {@link SIX_ELEMENT_ORDER}. */
export type SixElementKey = (typeof SIX_ELEMENT_ORDER)[number]

/** The six elements as the author reads them. */
export const SIX_ELEMENT_LABELS: Readonly<Record<SixElementKey, string>> = {
  time: '时间',
  place: '地点',
  characters: '人物',
  cause: '起因',
  process: '经过',
  result: '结果',
}

/**
 * The five story elements the whole-book outline stores.
 *
 * 人物 is the cast, so it is not stored a second time; every other element is a
 * named field of `全书大纲.md`'s `## 故事六要素` block. This is what turns "时间/地点
 * 没地方写" into a gap the tools can name.
 */
export const STORY_ELEMENT_FIELDS = ['time', 'place', 'cause', 'process', 'result'] as const

/** One entry of {@link STORY_ELEMENT_FIELDS}. */
export type StoryElementField = (typeof STORY_ELEMENT_FIELDS)[number]

/** What each stored story element is called. */
export const STORY_ELEMENT_LABELS: Readonly<Record<StoryElementField, string>> = {
  time: SIX_ELEMENT_LABELS.time,
  place: SIX_ELEMENT_LABELS.place,
  cause: SIX_ELEMENT_LABELS.cause,
  process: SIX_ELEMENT_LABELS.process,
  result: SIX_ELEMENT_LABELS.result,
}

/**
 * The fields of the protagonist's 金手指, in report order.
 *
 * A cheat is not a one-line label. The SOP asks for its 规则、限制、成长曲线
 * (step 5), and a cheat whose price and ceiling are unstated is the same failure
 * as a power system without a cost: it can win any scene it is asked to win.
 * `owner` names the character it belongs to, `firstReveal` the chapter a reader
 * first sees it — both were previously only prose inside a setting entry.
 */
export const CHEAT_FIELDS = ['name', 'owner', 'rule', 'cost', 'limits', 'growth', 'firstReveal'] as const

/** One entry of {@link CHEAT_FIELDS}. */
export type CheatField = (typeof CHEAT_FIELDS)[number]

/** What each cheat field is called wherever it is reported. */
export const CHEAT_LABELS: Readonly<Record<CheatField, string>> = {
  name: '金手指名称',
  owner: '归属',
  rule: '规则',
  cost: '代价',
  limits: '限制',
  growth: '成长曲线',
  firstReveal: '首次亮相',
}

/**
 * The protagonist's edge, with the price and ceiling that make it a story device.
 *
 * Stored in `全书大纲.md`'s `## 金手指` block rather than in `novel.json`, for the
 * same reason the competitor study is a file: the author has to be able to read
 * and edit it. A cheat that exists only in the metadata is a cheat the author
 * cannot correct.
 */
export interface GoldenFinger {
  /** The name a reader will learn, for example `断剑认主`. */
  readonly name: string
  /** The character it belongs to: a character id or the display name. */
  readonly owner: string
  /** How it works, stated precisely enough to be contradicted. */
  readonly rule: string
  /** What using it costs. */
  readonly cost: string
  /** What it cannot do. */
  readonly limits: string
  /** How it grows across the book: first form, unlock nodes, final form. */
  readonly growth: string
  /** The chapter it first appears in (a chapter id or number). */
  readonly firstReveal: string
}

/**
 * How one narrative-spine element is labelled, wherever it is reported.
 *
 * One table for both layers: the same element must read the same in the volume
 * gap list and in the whole-book gap list, or the two lists stop being comparable.
 */
export const SPINE_LABELS: Readonly<
  Record<OutlineSpineField | VolumeSpineField | OutlineStyleField | StoryElementField | CheatField, string>
> = {
  synopsis: '故事梗概',
  protagonistArc: '主角成长线',
  supportArcs: '伙伴成长线',
  antagonistArc: '反派成长线',
  factionShift: '阵营演变（反派的队伍怎么长起来）',
  conflictArcs: '对抗副本（每一场对抗怎么打、奇遇在哪里）',
  mainConflict: '本卷核心对抗',
  costs: '失去了什么',
  gains: '获得了什么',
  tone: '文风基调',
  perspective: '人称与视角',
  rhythm: '句式与节奏',
  diction: '遣词用句',
  dialogue: '对话与描写',
  emotion: '情绪与爽点落点',
  taboos: '负面清单',
  time: '时间',
  place: '地点',
  cause: '起因',
  process: '经过',
  result: '结果',
  name: '金手指名称',
  owner: '归属',
  rule: '规则',
  cost: '代价',
  limits: '限制',
  growth: '成长曲线',
  firstReveal: '首次亮相',
}

/** One narrative element of a planning layer, with the requirement it answers. */
export interface SpinePart<Field extends string> {
  /** The field this part fills. */
  readonly field: Field
  /** The heading it lives under, which is also the label the tools report. */
  readonly heading: string
  /** What a complete answer says. */
  readonly requirement: string
}

/**
 * The narrative-spine fields the whole-book outline answers, in report order.
 *
 * This is the list the tool checks *before* it checks beats or length: a
 * detailed outline that cannot say what the story is, how the cast changes, how
 * the opposition grows, and what was won or lost has nothing for a 爽点 schedule
 * to be attached to.
 */
export const OUTLINE_SPINE_FIELDS = [
  'synopsis',
  'protagonistArc',
  'supportArcs',
  'antagonistArc',
  'factionShift',
  'conflictArcs',
  'costs',
  'gains',
] as const

/** One entry of {@link OUTLINE_SPINE_FIELDS}. */
export type OutlineSpineField = (typeof OUTLINE_SPINE_FIELDS)[number]

/**
 * The whole-book narrative spine as an ordered checklist.
 *
 * The headings are the `###` subheadings of `全书大纲.md`'s `## 叙事骨架` block, and
 * the requirements are what `novel_plan` reports per missing element. Both layers'
 * tables live here, beside the field lists they describe, so the codec and the
 * checks cannot disagree about what an element is called.
 */
export const OUTLINE_SPINE_PARTS: readonly SpinePart<OutlineSpineField>[] = [
  { field: 'synopsis', heading: '故事梗概', requirement: '整本书从开头到结局讲一遍：谁、要什么、遇到什么、最后怎样' },
  { field: 'protagonistArc', heading: '主角成长线', requirement: '主角从什么状态变成什么状态，中间跨过哪几道坎' },
  { field: 'supportArcs', heading: '伙伴成长线', requirement: '主要伙伴各自怎么变，在哪些节点改变' },
  { field: 'antagonistArc', heading: '反派成长线', requirement: '反派怎么变强、怎么动摇、最后败在哪一步' },
  { field: 'factionShift', heading: '阵营演变', requirement: '反派的队伍怎么扩张、怎么分裂，主角这边怎么成军' },
  { field: 'conflictArcs', heading: '对抗副本', requirement: '每一场对抗怎么打、奇遇在哪、结果与代价是什么' },
  { field: 'costs', heading: '失去了什么', requirement: '主角方失去了什么，逐项写清' },
  { field: 'gains', heading: '获得了什么', requirement: '主角方获得了什么，逐项写清' },
]

/**
 * The six elements of narrative as an ordered checklist.
 *
 * The headings are the `###` subsections of `全书大纲.md`'s `## 故事六要素` block.
 * 人物 is not one of the stored parts — it is read from the cast file — but it is
 * carried in {@link SIX_ELEMENT_ORDER}, so the report still answers the whole
 * question a reader asks of a story.
 */
export const STORY_ELEMENT_PARTS: readonly SpinePart<StoryElementField>[] = [
  {
    field: 'time',
    heading: '时间',
    requirement: '故事发生在什么时代/时段、跨过多长时间、关键时间节点（哪一年、第几日、多少年过去）',
  },
  {
    field: 'place',
    heading: '地点',
    requirement: '故事主要发生在哪些地方，空间如何转换（城/山门/秘境/位面），哪一张地图对应哪一卷',
  },
  {
    field: 'cause',
    heading: '起因',
    requirement: '故事为什么开始：谁要什么、什么事件打破平衡、主角为什么非动不可',
  },
  {
    field: 'process',
    heading: '经过',
    requirement: '冲突怎么升级：关键回合、转折、代价，以及每一卷把故事推到哪一步',
  },
  {
    field: 'result',
    heading: '结果',
    requirement: '故事怎么收束：最终结局、谁付出什么、留下什么，与开篇的欲望是否对上',
  },
]

/**
 * The 金手指 block as an ordered checklist.
 *
 * The headings are the `###` subsections of `全书大纲.md`'s `## 金手指` block. The
 * order is the order the questions have to be answered in: what it is, whose it
 * is, how it works, what it costs, what it cannot do, how it grows, when the
 * reader first sees it. A cheat with no 代价 or 限制 is reported as a gap, exactly
 * like a power system without one.
 */
export const CHEAT_PARTS: readonly SpinePart<CheatField>[] = [
  { field: 'name', heading: '名称', requirement: '读者会记住的名字，一句话说清它是什么' },
  { field: 'owner', heading: '归属', requirement: '它属于谁（人物 id 或姓名）；主角的金手指要指名主角' },
  { field: 'rule', heading: '规则', requirement: '它怎么运转、能做什么、触发条件是什么，写到能被后文违反的程度' },
  { field: 'cost', heading: '代价', requirement: '每次使用付出什么（寿命、记忆、资源、关系），代价要能逼出选择' },
  { field: 'limits', heading: '限制', requirement: '它做不到什么、什么时候失灵；没有限制的金手指会让任何冲突失去张力' },
  { field: 'growth', heading: '成长曲线', requirement: '从初始形态到最终形态怎么升级，在哪些节点解锁什么' },
  { field: 'firstReveal', heading: '首次亮相', requirement: '读者第一次看到它的是哪一章；开篇清单会对照这一项' },
]

/**
 * The 写作风格 elements the whole-book outline answers, in report order.
 *
 * The style used to be settled *after* chapter 1 was handed over, which is one
 * chapter too late: by then the voice of the book has already been chosen by
 * whoever wrote it, and the author is being asked to approve a fait accompli.
 * It is now part of the 全书大纲 layer — a named element each, checked for
 * presence before prose is allowed to exist, so chapter 1 is written against a
 * voice the author has already seen — and the checkpoint after the golden three
 * chapters is a *review* of what those three chapters actually sound like.
 */
export const OUTLINE_STYLE_FIELDS = [
  'tone',
  'perspective',
  'rhythm',
  'diction',
  'dialogue',
  'emotion',
  'taboos',
] as const

/** One entry of {@link OUTLINE_STYLE_FIELDS}. */
export type OutlineStyleField = (typeof OUTLINE_STYLE_FIELDS)[number]

/**
 * The `novel_plan operation="outline"` parameter that carries one style element.
 *
 * The field names are the file's `###` headings in code shape (`tone`), the
 * parameters are prefixed (`styleTone`), and every message the tool prints has to
 * spell the parameter the caller should actually send — so the mapping lives in
 * one function rather than in a template string per call site.
 *
 * @param field - the style element.
 * @returns the parameter name.
 */
export function styleParamName(field: OutlineStyleField): string {
  return `style${field[0]?.toUpperCase() ?? ''}${field.slice(1)}`
}

/**
 * The whole-book style guide as an ordered checklist.
 *
 * The headings are the `###` subheadings of `全书大纲.md`'s `## 写作风格` block.
 * The list is deliberately concrete — 基调、视角、节奏、用词、对话与描写、情绪落点、
 * 负面清单 — because "文风再稳一点" is not something a chapter can be held to,
 * whereas "单句成段只用在情绪拐点" is.
 */
export const OUTLINE_STYLE_PARTS: readonly SpinePart<OutlineStyleField>[] = [
  {
    field: 'tone',
    heading: '文风基调',
    requirement: '一句话说清这本书读起来是什么味道、参照哪一类语感，并给两三句「像这样写」的样例',
  },
  {
    field: 'perspective',
    heading: '人称与视角',
    requirement: '第几人称、镜头贴谁、能不能切视角、镜头远近；必须与 novel_init 定的 pov 一致',
  },
  { field: 'rhythm', heading: '句式与节奏', requirement: '长短句比例、段落长度、断句与单句成段用在哪' },
  {
    field: 'diction',
    heading: '遣词用句',
    requirement: '用词层级（书面/口语/方言/网络语）、称呼习惯、比喻与意象的密度、禁用的词',
  },
  { field: 'dialogue', heading: '对话与描写', requirement: '对话占比、内心戏怎么落地、动作与环境描写的密度与顺序' },
  { field: 'emotion', heading: '情绪与爽点落点', requirement: '情绪落在哪些可观察的细节上、爽点怎么给、每章收尾时读者该有什么感受' },
  {
    field: 'taboos',
    heading: '负面清单',
    requirement: '本书明令禁止的写法：AI 味句式、翻译腔、滥用副词与形容词、章末总结、把情绪直接说出来……',
  },
]


/**
 * The narrative spine one volume answers, in report order.
 *
 * Deliberately the whole-book spine minus the two whole-book-only fields: a
 * volume covers one *stage* of each arc rather than the arc, so it advances the
 * antagonist, the factions, and the cost, and it carries the companions inside
 * `protagonistArc` rather than re-telling the book's companion roster.
 */
export const VOLUME_SPINE_PARTS: readonly SpinePart<VolumeSpineField>[] = [
  { field: 'synopsis', heading: '本卷梗概', requirement: '这一卷从头到尾讲一遍，不看别的卷也读得懂' },
  { field: 'protagonistArc', heading: '主角成长', requirement: '主角在这一卷里跨过哪一步、变成什么样' },
  { field: 'antagonistArc', heading: '反派成长', requirement: '反派及其手下在这一卷里做了什么、变成什么样' },
  { field: 'factionShift', heading: '阵营演变', requirement: '双方阵营在这一卷里的扩张、分裂与倒戈' },
  { field: 'mainConflict', heading: '核心对抗', requirement: '这一卷的主对抗怎么打起来、怎么收场' },
  { field: 'costs', heading: '代价与失去', requirement: '这一卷失去了什么，逐项写清' },
  { field: 'gains', heading: '收获与获得', requirement: '这一卷获得了什么，逐项写清' },
]

/** One narrative-spine element that is still empty, with where it is written. */
export interface SpineGap {
  /** Which element. */
  readonly key: OutlineSpineField | VolumeSpineField | OutlineStyleField | StoryElementField | CheatField
  /** What the element has to answer. */
  readonly requirement: string
  /** The tool call that fills it. */
  readonly fill: string
}

/**
 * The checkpoints only the author can close.
 *
 * Both exist because the pipeline otherwise runs from an inspiration straight to
 * prose: the *settings* checkpoints cover the book's setup, and `style` is the
 * author's review of the prose voice — due once the golden three chapters have
 * prose, because 表达方式与遣词用句 need three chapters of material to be judged, and
 * because the style itself was already settled inside the 全书大纲 layer before
 * chapter 1 was written. A checkpoint is not a judgement the tool makes — it is a
 * record that the author was asked and answered (see {@link DiscussionRound}).
 *
 * The settings are decomposed into {@link SETTINGS_LAYERS} — 立意、世界观、人物设定、
 * 全书大纲、分卷大纲 — settled one at a time in that order. Most layers answer to
 * their own kind; the premise layer answers to both `premise` and `settings`,
 * because `settings` is what the SOP and every project recorded before the layers
 * existed call it.
 */
export const CONFIRMATION_KINDS = ['settings', 'premise', 'world', 'cast', 'outline', 'volume', 'style'] as const

/** One entry of {@link CONFIRMATION_KINDS}. */
export type ConfirmationKind = (typeof CONFIRMATION_KINDS)[number]

/**
 * Comparable titles the SOP's competitor step aims for (20–50).
 *
 * A floor rather than a target: below twenty dismantles the study cannot show
 * whether a device is a genre convention or this author's habit, which is the
 * only question it is there to answer. Named here because three separate places
 * report the same number — `assessStage`'s phase-one blocker, `novel_plan`'s
 * warnings, and the Kanban board's 竞品拆解 card — and a threshold that lives in
 * three places drifts.
 */
export const COMPETITOR_TARGET = 20

/**
 * Candidate title/blurb/tag sets the SOP asks for before validation.
 *
 * The validation step tests naming candidates against readers, so fewer than
 * three of them is not a smaller version of the same experiment — it is no
 * experiment. Shared by `openingPackageGaps` and the board's 候选物料 card for the
 * same reason as {@link COMPETITOR_TARGET}.
 */
export const NAMING_MIN_CANDIDATES = 3

/**
 * Discussion rounds each checkpoint needs before it can be signed off.
 *
 * Settings take more than one round on purpose: the SOP asks for the setup to be
 * *discussed*, not announced, and a single round is what "the model decided and
 * told the author" looks like. The style checkpoint follows the golden three
 * chapters, so one round — show the chapters, hear whether 文风/表达方式/遣词用句
 * need adjusting — is the honest shape.
 */
export const CONFIRMATION_MIN_ROUNDS: Readonly<Record<ConfirmationKind, number>> = {
  settings: 2,
  premise: 2,
  world: 1,
  cast: 1,
  outline: 1,
  volume: 1,
  style: 1,
}

/** The key of one settings layer, for addressing it in a tool call. */
export type SettingsLayerKey = 'premise' | 'world' | 'cast' | 'outline' | 'volume'

/** The confirmation kind that closes one settings layer. */
export type SettingsLayerKind = SettingsLayerKey

/** One entry of {@link SETTINGS_LAYERS}. */
export interface SettingsLayer {
  /** The layer's key, as a tool call addresses it. */
  readonly key: SettingsLayerKey
  /** The layer's name in the author's language. */
  readonly label: string
  /** The confirmation kind that closes it. */
  readonly kind: SettingsLayerKind
  /** Whether the layer gates the prose. */
  readonly gatesProse: boolean
}

/**
 * One layer of the settings, in the order the SOP settles them.
 *
 * The settings are **not one deliverable**. 世界观、人物设定、全书大纲、分卷大纲 are
 * each large enough that writing them in a single pass produces a setup the
 * author never had a chance to steer — the failure the checkpoints exist to
 * prevent, one level down. Each layer is therefore its own discussion and its
 * own sign-off, and a later layer may not be *started* until the one before it
 * is confirmed.
 *
 * `premise` is the exception the rest of the pipeline leans on: the pitch is the
 * smallest layer and the one `novel_write` hard-gates on, so it is the
 * pre-prose checkpoint. The 全书大纲 layer is the second exception in one narrow
 * respect: its 写作风格 block is itself a prose gate ({@link OUTLINE_STYLE_PARTS}),
 * because a chapter written before the voice is written down is a chapter the
 * author never had a chance to steer. The layers after the premise are otherwise
 * ordered and soft-gated — the tool reports that they are out of order rather
 * than refusing, because a model writing scene-setting notes early is not the
 * failure that produced four unapproved chapters.
 */
export const SETTINGS_LAYERS: readonly SettingsLayer[] = [
  { key: 'premise', label: '立意与核心设定', kind: 'premise', gatesProse: true },
  { key: 'world', label: '世界观设定', kind: 'world', gatesProse: false },
  { key: 'cast', label: '人物设定', kind: 'cast', gatesProse: false },
  { key: 'outline', label: '全书大纲（含写作风格）', kind: 'outline', gatesProse: false },
  { key: 'volume', label: '分卷大纲', kind: 'volume', gatesProse: false },
]

/**
 * The chapters the author reads before the voice is reviewed.
 *
 * The checkpoint used to fall after chapter 1 and before chapter 2, which made
 * the model stop for a sign-off before it had written anything the author could
 * judge a voice *by*: one chapter is a sample, three chapters are a rhythm. The
 * golden three are also the chapters the SOP engineers hardest (第 2 章亮金手指、
 * 第 3 章小爽点), so they are where 表达方式 and 遣词用句 are visible in enough
 * material to be judged.
 */
export const GOLDEN_CHAPTERS = 3

/**
 * The chapter the style must be reviewed after.
 *
 * Kept as its own name because the gate reads as a *position* ("past the golden
 * three"), while {@link GOLDEN_CHAPTERS} is the number the SOP talks about.
 */
export const STYLE_GATE_CHAPTER = GOLDEN_CHAPTERS

/**
 * Extract the chapter number a review looked at, from its target string.
 *
 * A review target is whatever the caller addressed the chapter by — an id
 * (`chapter-3`, `ch-003`), a title, or a number — so the number is read back out
 * of it rather than trusted. `0` means the target names no chapter, which is the
 * honest answer for a review of the whole project.
 *
 * @param target - the recorded target.
 * @returns the chapter number, or 0 when the target names none.
 */
export function chapterNumberOf(target: string): number {
  const explicit = /(?:^|[^0-9])(\d{1,4})(?:[^0-9]|$)/u.exec(target)
  return explicit?.[1] === undefined ? 0 : Number.parseInt(explicit[1], 10)
}

/**
 * The 去 AI 化 review the SOP requires before serialization continues.
 *
 * The SOP's step 23 puts 去 AI 化 in the pipeline but, unlike the data check, gave
 * it no appointment and no receipt: `novel_review operation="ai-flavor"` was a tool
 * the model could simply never call, and a book could reach chapter forty with its
 * 写作风格 负面清单 never once checked. This is the standing that closes that hole —
 * one recorded review, due with the voice review once the golden three chapters
 * have prose.
 *
 * It is deliberately a *receipt* check and not a quality check: the tool cannot
 * judge whether the prose improved, only whether the author was ever shown the
 * diagnosis. What the review finds is the author's business, and a review that
 * finds nothing is a valid, recorded outcome.
 */
export interface DeAiStanding {
  /** Whether at least one 去 AI 化 review is on the ledger. */
  readonly done: boolean
  /** When the latest one was taken, ISO-8601; empty when none was. */
  readonly at: string
  /** The chapter the latest review looked at, empty when none was. */
  readonly target: string
  /** Golden chapters that still have no review of their own, by number. */
  readonly unreviewed: readonly number[]
  /**
   * Whether the review is due — the golden three chapters have prose.
   *
   * Carried separately because "not done" and "not yet due" are different facts:
   * before the golden three exist there is nothing to diagnose.
   */
  readonly due: boolean
  /** Whether prose past {@link STYLE_GATE_CHAPTER} is held back until it is done. */
  readonly gatesProse: boolean
}

// ── the project's commercial frame ────────────────────────────────────────────

/** Where the novel is published and how it earns. */
export interface PlatformProfile {
  /** Platform name, for example `qidian`, `fanqie`, `jinjiang`. */
  readonly name: string
  /** Commercial model the plan targets. */
  readonly mode: PlatformMode
  /** Reader channel. */
  readonly audience: PlatformAudience
  /** Genre and sub-genre tags as the platform spells them. */
  readonly genres: readonly string[]
  /** One line on who the target reader is. */
  readonly readers: string
  /** How the novel is expected to earn, in the author's words. */
  readonly monetization: string
}

/** One of the 3–5 candidate title/blurb/tag sets the SOP requires. */
export interface NamingCandidate {
  /** Stable id for referencing the candidate in verification rounds. */
  readonly id: string
  /** Candidate title. */
  readonly title: string
  /** Candidate blurb. */
  readonly blurb: string
  /** Candidate tags. */
  readonly tags: readonly string[]
  /** Why this set is expected to work. */
  readonly rationale: string
  /** Whether this set is the one currently published. */
  readonly active: boolean
}

/** Platform-calibrated medians a reading is compared against. */
export interface MetricBaselines {
  /**
   * Same-genre median per metric, as recorded from the platform's leaderboard
   * over the last 30 days. A metric with no baseline cannot be assessed — the
   * SOP's multipliers are meaningless without one.
   */
  readonly medians: Readonly<Partial<Record<MetricKey, number>>>
  /**
   * Per-metric override of the default threshold multiplier. Only metrics that
   * need a different trigger line belong here.
   */
  readonly multipliers: Readonly<Partial<Record<MetricKey, number>>>
  /** When the medians were read, so a stale calibration is visible. */
  readonly calibratedAt: string
  /** Where the numbers came from: the leaderboard, an editor, a cohort. */
  readonly source: string
}

/** The writing plan's operating parameters, one meaning each. */
export interface WritingPlan {
  /** Prose language. */
  readonly language: string
  /** Point of view. */
  readonly pov: string
  /**
   * Planned volumes. `0` means the book deliberately runs as one volume
   * (不分卷) and `-1` means the user has not been asked yet — two different
   * answers, which is why the undecided state is not spelled `0`.
   */
  readonly volumes: number
  /** Planned total chapters, 0 when undecided. Derivable from the length numbers. */
  readonly totalChapters: number
  /** Target total length in characters, 0 when undecided. */
  readonly targetWords: number
  /**
   * Target length of one chapter in characters, 0 when undecided.
   *
   * The SOP's "1–3 万字" style gates are only checkable per chapter, so this is
   * the target a chapter contract inherits when it states none of its own.
   */
  readonly chapterWords: number
  /** Chapters of detailed outline kept ahead of the prose (the outline window). */
  readonly chapterPlanWindow: number
  /** Chapter positions the platform's opening metrics are read at. */
  readonly openingGateChapters: readonly number[]
  /** Chapters of unpublished prose to hold in stock. */
  readonly stockTargetChapters: number
  /** Hard ceiling on how far the rolling outline may run ahead. */
  readonly chapterPlanCeiling: number
  /** Update rhythm in the author's words, for example `daily-2`. */
  readonly updateRhythm: string
}

// ── story data ────────────────────────────────────────────────────────────────

/** The novel's premise, held verbatim so later chapters can re-read it. */
export interface NovelMeta {
  /** Working title. */
  readonly title: string
  /** One-paragraph premise. */
  readonly premise: string
  /** Genre and tone tags, free-form. */
  readonly genres: readonly string[]
  /** Point of view, for example `third-limited`. */
  readonly pov: string
  /** Language the prose is written in. */
  readonly language: string
}

/**
 * The one-sentence hook, the emotional promise, and the differentiators.
 *
 * {@link Premise.memorablePoint} is stored rather than remembered because three
 * separate SOP steps read it back: the pitch, the metrics diagnosis when clicks
 * are bad, and the validation verdict's "can a reader state what this novel is".
 */
export interface Premise {
  /** `protagonist + world + obsession + ability + opposition + emotion`, one sentence. */
  readonly memorablePoint: string
  /** What the reader comes for: the core emotional payoff. */
  readonly coreEmotion: string
  /** The payoff pattern, in the author's words. */
  readonly shuangPoints: readonly string[]
  /** How this differs from the comparable titles. */
  readonly differentiators: readonly string[]
  /** The theme the novel is actually about underneath the plot. */
  readonly kernel: string
}

/** One dismantled comparable title from the leaderboard. */
export interface Competitor {
  /** Stable id, usually a slug of the title. */
  readonly id: string
  /** Title as published. */
  readonly title: string
  /** Platform tags. */
  readonly tags: readonly string[]
  /** The blurb, verbatim (it is the marketing artifact being studied). */
  readonly blurb: string
  /** The event the first chapter opens on. */
  readonly openingEvent: string
  /** The cheat or edge the protagonist gets. */
  readonly goldenFinger: string
  /** What the protagonist wants. */
  readonly protagonistDesire: string
  /** Why the antagonist opposes them. */
  readonly antagonistMotive: string
  /** How often a payoff lands, for example `每章`, `每3章`. */
  readonly shuangFrequency: string
  /** The emotional curve, in the author's words. */
  readonly emotionCurve: string
  /** Where the paywall or ramp lands. */
  readonly paywallPoint: string
  /** Hook patterns used at chapter ends. */
  readonly chapterHooks: string
  /** High-frequency words in the comment section. */
  readonly commentKeywords: readonly string[]
  /** What is reusable from this book. */
  readonly takeaway: string
}

/** A person in the story, with the facts the prose must not contradict. */
export interface Character {
  /** Stable slug used to address the character everywhere. */
  readonly id: string
  /** Display name as it appears in prose. */
  readonly name: string
  /** Narrator-facing role, for example `protagonist` or `antagonist`. */
  readonly role: string
  /**
   * How much of the spine this character owes; see {@link CHARACTER_SCOPES}.
   *
   * Empty means "not decided", and the check falls back to {@link role}: a
   * protagonist-shaped role is `main`, anything else is `volume`. That default is
   * deliberately the stricter of the two, so a cast written before this field
   * existed is held to exactly what it was held to before.
   */
  readonly scope: string
  /**
   * The volume or map this character belongs to, 0 when unset.
   *
   * What makes a walk-on findable: "第 5 卷已经出场过哪些人" is the page a writer
   * opens when starting a chapter inside a map they have used before.
   */
  readonly volume: number
  /**
   * The chapter this character was first seen in: a chapter id or number.
   *
   * Free text like {@link StoryLink.plantedAt}, because the author may write
   * "第37章" before the chapter has an id, and because a cameo registered after
   * the fact should be able to name the chapter it already appeared in.
   */
  readonly firstAppearance: string
  /**
   * How they left the story, when they did: "第 52 章 被灭口".
   *
   * The failure this prevents is a walk-on who died in volume 2 walking back in
   * at volume 4 — nothing else in the project records that he is gone.
   */
  readonly exit: string
  /** Appearance, habits, and anything else the prose must honor. */
  readonly description: string
  /**
   * The personality the prose has to keep: their底色, their contradictions, and
   * what they do under pressure.
   *
   * A separate field from {@link description} because "some characters are not
   * fleshed out" is a finding about *behaviour*, and free prose about looks does
   * not make it checkable — see `castGaps`.
   */
  readonly personality: string
  /**
   * How this character talks: sentence length, catchphrases, how they address
   * people, and how their feelings reach the surface.
   *
   * Voice is what makes two characters distinguishable in a scene of dialogue
   * with no attributions, which is exactly where a thin cast reads as one person
   * wearing several names.
   */
  readonly voice: string
  /** What this character wants; what drives their scenes. */
  readonly goal: string
  /** What they are afraid of, which is what makes them human. */
  readonly fear: string
  /** The obsession that makes them act against their own interest. */
  readonly obsession: string
  /** The weakness an opponent can press. */
  readonly weakness: string
  /** Which side they are on, for example `protagonist-camp`, `rival`, `neutral`. */
  readonly camp: string
  /**
   * How this character stands to the others: ally, enemy, 师徒, 旧识, debt.
   *
   * A free-text relation line rather than a relation graph because it is what the
   * prose needs when two people share a scene: the same character can be a rival
   * in one volume and an ally in the next, and a stale edge table would say the
   * older thing. Reported in the bible and the cast review, but deliberately not
   * a debt check — a walk-on with no relations is normal.
   */
  readonly relations: string
  /** Arc across the novel, one line per stage when known. */
  readonly growthArc: string
  /** Free-form continuity notes; append-only by convention. */
  readonly notes: string
}

/**
 * How much of the cast spine a character is held to.
 *
 * The question a tier answers is not "how important is he" but two things the
 * prose actually depends on: **will he appear again**, and **does he speak**. A
 * 200-chapter novel has dozens of people who exist for one map — a 掌柜, a 队正,
 * a 守夜的老兵 — and demanding a personality and a voice from each of them
 * produces filler, not depth (see `castGaps`). What those people really need is
 * a *register*: a name nobody else already has, where they were seen, and
 * whether they are still around.
 *
 * - `main` — protagonist, antagonist, core companions: the full spine.
 * - `volume` — recurring within one volume or map, or a character with lines:
 *   owes a voice, not an arc.
 * - `cameo` — scenery, one appearance: owes a name, one line saying who they
 *   are, and the chapter they were seen in.
 */
export const CHARACTER_SCOPES = ['main', 'volume', 'cameo'] as const

/** One entry of {@link CHARACTER_SCOPES}. */
export type CharacterScope = (typeof CHARACTER_SCOPES)[number]

/** How each scope reads to the author, wherever it is reported. */
export const SCOPE_LABELS: Readonly<Record<CharacterScope, string>> = {
  main: '主要角色',
  volume: '配角（本卷/本地图）',
  cameo: '路人（一次性）',
}

/**
 * The kinds of fact the world file can hold.
 *
 * The set is closed so a typo (`power_system`, `place `) is reported rather than
 * silently becoming a seventh kind nobody groups by. `note` is the legacy default
 * a hand-written entry gets when it states no kind; it is treated as a rule for
 * the cost/limits check, because that is what the SOP asks a rule for.
 */
export const WORLD_KINDS = ['place', 'faction', 'power-system', 'item', 'history', 'rule'] as const

/** One entry of {@link WORLD_KINDS}. */
export type WorldKind = (typeof WORLD_KINDS)[number]

/** What each world kind is called in the author's language. */
export const WORLD_KIND_LABELS: Readonly<Record<WorldKind, string>> = {
  place: '地点',
  faction: '势力',
  'power-system': '力量体系',
  item: '物件',
  history: '历史',
  rule: '规则',
}

/** A setting fact the novel must keep consistent. */
export interface WorldEntry {
  /** Stable slug for the entry, for example `sect-qingyun`. */
  readonly id: string
  /** Kind of fact: one of {@link WORLD_KINDS}; `note` when a legacy entry states none. */
  readonly kind: string
  /** Entry name as it appears in prose. */
  readonly name: string
  /** The fact itself, stated precisely enough to be contradicted. */
  readonly detail: string
  /**
   * What this rule costs or forbids. The SOP insists a power system is defined
   * by its price and limits, not its abilities; an entry without this is flagged
   * in the world review. Only rule-shaped entries (rule, power-system, legacy
   * `note`) are held to it — a place or a historical event has no price to pay.
   */
  readonly cost: string
  /** What it cannot do. */
  readonly limits: string
  /**
   * The entry that contains this one: a region holds a city, a sect holds a hall.
   *
   * This is what makes the world **layered** rather than a flat list. `parent`
   * names another entry id; a dangling reference is reported by
   * `worldStructureGaps`, because a hierarchy nobody can resolve is worse than a
   * flat one.
   */
  readonly parent: string
  /**
   * Which level of the world this fact belongs to: 1 凡界/外门, 2 宗门/一城,
   * 3 灵界/王庭, and so on; 0 means unset.
   *
   * The number is the author's scale, not a fixed ontology — what matters is that
   * a reader can tell 低武 from 高武 and that a volume can name the layer it opens.
   */
  readonly level: number
  /**
   * The volume/map where this fact first becomes available; 0 means everywhere.
   *
   * A 秘境 that only exists from volume 3 belongs to volume 3; without this field
   * "第 5 卷有哪些地点" is unanswerable even though the place is written down.
   */
  readonly volume: number
  /**
   * How this faction/place stands to the others, in the author's words.
   *
   * Free text rather than an edge table for the same reason character relations
   * are: the stance changes across volumes, and the file the author edits should
   * carry the current answer. The bible review groups these lines by kind.
   */
  readonly relations: string
}

/**
 * One promise made to the reader: a planted foreshadowing, a mystery, or a hook.
 *
 * The SOP requires a recovery plan at plant time and a closing check at volume
 * end; without status and a target chapter, an open promise can silently cross
 * volumes, which is the failure this record exists to prevent.
 */
export interface StoryLink {
  /** Stable slug. */
  readonly id: string
  /** The promise as planted, in prose terms. */
  readonly note: string
  /** Which kind: `foreshadow`, `mystery`, `hook`, `promise`. */
  readonly kind: string
  /** Chapter id or number it is planted in; empty when not yet planted. */
  readonly plantedAt: string
  /** Chapter id or number it must pay off by; empty when undecided. */
  readonly dueAt: string
  /** How it is intended to pay off. */
  readonly payoff: string
  /** Current state. */
  readonly status: LinkStatus
  /** Volume number the payoff belongs to, 0 when unknown. */
  readonly volume: number
}

// ── the plan ──────────────────────────────────────────────────────────────────

/**
 * The filenames the top-level content files use.
 *
 * Fixed Chinese names by default, overridable through configuration; the index
 * is the only thing that records which names are actually in force, so nothing
 * downstream may hard-code them.
 */
export interface StorageLayout {
  /** Whole-book outline: logline, full outline, acts, minimal outline, `fullOutlineDone`. */
  readonly outlineFile: string
  /** Cast. */
  readonly castFile: string
  /** World facts. */
  readonly worldFile: string
  /**
   * Directory holding the per-volume outline files, one per volume.
   *
   * A volume outline is revised while the volumes before it are already being
   * written, so it is one file per volume (`分卷大纲/第1卷.md`) rather than one
   * collection file: editing volume 7 must not rewrite volumes 1–6, and a
   * 200 000-character outline is not a file anyone wants to re-read each time.
   * The filename carries the volume number only, so a volume's title can change
   * without its file moving.
   */
  readonly volumeDir: string
  /**
   * The chapter plan's whole-book file: the opening-engineering checklist and an
   * index of the per-volume chapter tables.
   *
   * The plan's chapter and rhythm tables are per volume (see
   * {@link chapterPlanDir}); what is genuinely whole-book stays here, and so does
   * the checklist whose `done` flags gate phase two.
   */
  readonly chapterPlanFile: string
  /**
   * Directory holding the chapter table and rhythm table, one file per volume
   * (`章节大纲/第1卷.md`).
   *
   * The chapter table grows one row per chapter — 1000 rows for a 1000-chapter
   * book — and every plan change used to rewrite the whole thing. Splitting it by
   * volume is what makes "write chapter 341" touch one file, and it puts a
   * volume's cadence next to the volume it paces. A chapter filed under no volume
   * goes to `未分卷.md` in the same directory.
   */
  readonly chapterPlanDir: string
  /**
   * The dismantled comparable titles.
   *
   * The competitor study is research the author has to be able to *read* — the
   * whole point of dismantling 20–50 titles is to go back to them while
   * planning — so it lives in a Markdown file beside the other settings rather
   * than only inside `.novel/novel.json`.
   */
  readonly competitorFile: string
  /** Directory holding the per-chapter prose and contract files. */
  readonly chapterDir: string
}

/**
 * Everything `.novel/novel.json` holds at schema version 3.
 *
 * Deliberately *not* a {@link NovelState}: this is what is written to the
 * metadata document, whereas a state is metadata **plus** the content assembled
 * from the Markdown files. Keeping the two apart is what makes "content files
 * first, metadata second" implementable without ever writing a half-state.
 */
export interface NovelMetadata {
  /** On-disk schema version. */
  readonly schemaVersion: number
  /** Premise and prose conventions. */
  readonly meta: NovelMeta
  /** Commercial frame. */
  readonly platform: PlatformProfile
  /** The memorable point and its supporting differentiators. */
  readonly pitch: Premise
  /** Candidate title/blurb/tag sets, awaiting validation. */
  readonly naming: readonly NamingCandidate[]
  /** Leaderboard medians every reading is compared against. */
  readonly baselines: MetricBaselines
  /** Comparable titles dismantled for the SOP's competitor step. */
  readonly competitors: readonly Competitor[]
  /** Writing parameters. */
  readonly writing: WritingPlan
  /** Reader promises: status and recovery chapter feed the volume-end gate. */
  readonly links: Readonly<Record<string, StoryLink>>
  /** Metric readings, in the order taken. */
  readonly readings: readonly MetricReading[]
  /** Applied changes with their evidence chain. */
  readonly iterations: readonly Iteration[]
  /** Investment evaluations: the SOP's data check, run on demand. */
  readonly evaluations: readonly Evaluation[]
  /** Stage-three go/no-go decisions, newest last. */
  readonly launchDecisions: readonly LaunchDecision[]
  /** Every round of the settings/style conversation with the author, in the order held. */
  readonly discussions: readonly DiscussionRound[]
  /** The author's sign-offs, newest last. */
  readonly confirmations: readonly Confirmation[]
  /** Model-backed judgements. */
  readonly reviews: readonly ReviewRecord[]
  /**
   * The opening-engineering checklist.
   *
   * Kept here because the plan's ownership table names no home for it, and the
   * rule for that case is "it stays in the metadata document" rather than
   * "it is dropped" — its `done` flags gate the move out of `opening-package`.
   */
  readonly opening: Outline['opening']
  /** Where the content files live, and what they last contained. */
  readonly index: StorageIndex
  /** Retrospective and reusable material; absent until completion. */
  readonly retro?: Retrospective
  /** ISO-8601 timestamp of project creation. */
  readonly createdAt: string
  /** ISO-8601 timestamp of the last accepted write. */
  readonly updatedAt: string
}

/** One volume of the outline. */
export interface VolumePlan {
  /** 1-based volume number. */
  readonly number: number
  /** Working title. */
  readonly title: string
  /**
   * The volume's own detail: the 分卷剧情大纲.
   *
   * The SOP asks step 16 for "每卷：独立目标、独立矛盾、阶段性高潮、卷末钩子、卷内节奏", and
   * the last of those — the volume's内部 rhythm — has nowhere to live in five
   * scalar fields. It is also the part that has to reach the length the plan
   * budgets for a volume outline, so it is a body of its own rather than one
   * more line in a list.
   */
  readonly detail: string
  /** What this volume must accomplish on its own. */
  readonly goal: string
  /** The conflict that carries the volume. */
  readonly conflict: string
  /** The volume's own climax. */
  readonly climax: string
  /** The hook that closes the volume. */
  readonly endHook: string
  /**
   * The volume told as a story, in this volume's own right.
   *
   * `detail` above carries the 卷内节奏 and is what the length target measures;
   * this is the thing that is supposed to be *complete* before that target is
   * worth checking — the reader's answer to "what happens in this volume".
   */
  readonly synopsis: string
  /** How the protagonist changes across this volume. */
  readonly protagonistArc: string
  /** How the antagonist and their side change across this volume. */
  readonly antagonistArc: string
  /** How the antagonist's organisation grows, splits, or is broken here. */
  readonly factionShift: string
  /** The volume's central confrontation as a story, not a label. */
  readonly mainConflict: string
  /** What the protagonist side loses across this volume, named. */
  readonly costs: string
  /** What the protagonist side gains across this volume, named. */
  readonly gains: string
  /** Chapter numbers this volume spans, inclusive; empty when open. */
  readonly chapters: readonly number[]
}

/** A beat placed at a chapter position, for the rhythm table. */
export interface BeatSlot {
  /** 1-based chapter number the beat lands on. */
  readonly chapter: number
  /** What kind of beat it is. */
  readonly kind: BeatKind
  /** One line on what happens. */
  readonly note: string
}

/** One item of the opening-engineering checklist. */
export interface OpeningCheck {
  /** Stable key, for example `first-300-words-conflict`. */
  readonly key: string
  /** What the SOP requires, in one line. */
  readonly requirement: string
  /** Whether the author has confirmed it holds. */
  readonly done: boolean
  /** Evidence or note when confirmed. */
  readonly note: string
}

/** The rolling outline: the premise-level shape plus per-chapter contracts. */
export interface Outline {
  /** One-sentence story. */
  readonly logline: string
  /**
   * The whole-book detailed outline: 三幕主线、核心剧情走向、全局伏笔、大高潮节点、
   * 终极冲突、结局框架、全书钩子体系.
   *
   * The SOP's step 15 is a *body of work*, not a line: it is what the plan
   * budgets at roughly 1/100 of the book's total length, and what a later volume
   * or chapter is checked against. `acts` keeps the coarse three-act shape; this
   * is the detailed skeleton beside it.
   */
  readonly fullOutline: string
  /**
   * The whole book told as a story, start to finish.
   *
   * This is the layer the pipeline checks *first*. `fullOutline` above is the
   * detailed skeleton — acts, turning points, foreshadowing, the ending frame —
   * and a project can fill every one of those boxes while never once saying what
   * actually happens to these people (which is exactly what happened to the book
   * this field was added for: 20k characters of detail, no synopsis). Beats and
   * length targets are checked only after this and {@link OUTLINE_SPINE_FIELDS}
   * can be read as one continuous story.
   */
  readonly synopsis: string
  /** How the protagonist changes across the whole book. */
  readonly protagonistArc: string
  /** How the companions change, one by one. */
  readonly supportArcs: string
  /** How the antagonist changes, and how their side grows. */
  readonly antagonistArc: string
  /** How the antagonist's organisation expands, splits, or is broken. */
  readonly factionShift: string
  /** The adversarial arcs: each confrontation, its奇遇, and how it turns. */
  readonly conflictArcs: string
  /** What the protagonist side loses across the book, named. */
  readonly costs: string
  /** What the protagonist side gains across the book, named. */
  readonly gains: string
  /**
   * The five stored elements of the traditional 六要素, one named field each.
   *
   * 人物 is not here: it is the cast. The other five are the `## 故事六要素` block of
   * `全书大纲.md`, and {@link storyElementGaps} reports them. They are the answer to
   * "这个故事的时空与因果骨架是什么", which the narrative spine alone cannot give:
   * a spine can be complete while never saying when or where anything happens.
   */
  readonly story: Readonly<Record<StoryElementField, string>>
  /**
   * The protagonist's 金手指, with its price, ceiling, growth curve and reveal
   * chapter. The `## 金手指` block of `全书大纲.md`.
   */
  readonly cheat: GoldenFinger
  /**
   * The book's 写作风格, one named element per entry.
   *
   * Part of this layer rather than a checkpoint of its own, because the voice has
   * to exist *before* the first chapter does — see {@link OUTLINE_STYLE_PARTS}.
   * `novel_write` refuses prose while any element here is empty.
   */
  readonly style: Readonly<Record<OutlineStyleField, string>>
  /** Act structure in the author's words, one entry per act. */
  readonly acts: readonly string[]
  /** The minimal viable outline's one-screen summary. */
  readonly minimal: string
  /** Volume plans in reading order. */
  readonly volumes: readonly VolumePlan[]
  /** The rhythm table. */
  readonly beats: readonly BeatSlot[]
  /** Opening-engineering checklist. */
  readonly opening: readonly OpeningCheck[]
  /** Whether the author has confirmed the full-outline stage. */
  readonly fullOutlineDone: boolean
}

/**
 * The contract one chapter owes the reader, and the prose that pays it.
 *
 * The SOP's fields are mandatory for a *planned* chapter; prose may be written
 * against a half-filled contract, but `novel_write` reports which fields were
 * never answered instead of pretending the chapter is planned.
 */
export interface Chapter {
  /** Stable slug used to address the chapter everywhere. */
  readonly id: string
  /** 1-based position in reading order. */
  readonly number: number
  /** Working title; may be empty while the chapter is only a plan. */
  readonly title: string
  /** Total of the contract below, for a one-line read. */
  readonly synopsis: string
  /** Current lifecycle stage. */
  readonly status: ChapterStatus
  /** Prose body. Empty until written. */
  readonly body: string
  /** Character count of {@link body}, refreshed on every write. */
  readonly wordCount: number
  /** ISO-8601 timestamp of the last write to this chapter. */
  readonly updatedAt: string
  /** Volume this chapter belongs to, 0 when not yet assigned. */
  readonly volume: number
  /** What this chapter must accomplish. */
  readonly plotTask: string
  /**
   * When this chapter happens, in story time: `第三日 黄昏`, `三日后`, `十年前`.
   *
   * A free-text anchor rather than a timestamp because a 200-chapter book has a
   * fictional calendar, not a Gregorian one. It is what lets
   * `novel_status detail="bible"` print a timeline in chapter order, and what
   * makes a flashback visible as a choice rather than as a continuity error.
   */
  readonly timeAnchor: string
  /**
   * Where this chapter mainly happens: a place name, ideally one registered as a
   * `place` entry in 世界观设定.md.
   *
   * The chapter's share of 地点. The world file owns the map; this is where the
   * chapter stands on it, and `spaceTimeGaps` names the chapters that never say.
   */
  readonly place: string
  /** The conflict that carries the chapter. */
  readonly conflict: string
  /** What the reader gets emotionally. */
  readonly emotionalPayoff: string
  /** The information gap the chapter opens or closes. */
  readonly infoGap: string
  /** Beats this chapter carries. */
  readonly beats: readonly BeatKind[]
  /** The chapter-end hook. */
  readonly hook: string
  /** The turn this chapter delivers: whose arc moves, and how. */
  readonly keyBeat: string
  /** What this chapter costs or leaves behind, in story terms. */
  readonly price: string
  /** Target length in characters; 0 when unset. */
  readonly targetWords: number
  /** Contract fields the author explicitly waived, with the reason. */
  readonly waived: Readonly<Partial<Record<ContractField, string>>>
  /** Fields the last write reached, recorded by `novel_write`. */
  readonly delivered: readonly ContractField[]
}

// ── feedback: readings, iterations, validation ────────────────────────────────

/** One recorded reading of the platform metrics. */
export interface MetricReading {
  /** Stable id. */
  readonly id: string
  /** ISO-8601 instant the reading was taken. */
  readonly at: string
  /** Which period of the release it belongs to. */
  readonly period: MetricPeriod
  /** The chapter position the reading describes, 0 when not applicable. */
  readonly atChapter: number
  /** The values read, keyed by metric. */
  readonly values: Readonly<Partial<Record<MetricKey, number>>>
  /** Where the numbers came from. */
  readonly source: string
  /** Free-form observation, including comment-section words. */
  readonly note: string
}

/** One applied change, with the reading that triggered it and its result. */
export interface Iteration {
  /** Stable id. */
  readonly id: string
  /** ISO-8601 instant the change was decided. */
  readonly at: string
  /** The rule key that fired, or `manual`. */
  readonly trigger: string
  /** The threshold comparison that fired it, in words. */
  readonly evidence: string
  /** What was decided. */
  readonly action: string
  /** How far the change reaches. */
  readonly scope: ChangeScope
  /** The reading id this change is measured against. */
  readonly baselineReadingId: string
  /** The reading taken after the change, empty until filled. */
  readonly outcomeReadingId: string
  /** Whether the change worked: `unknown` until an outcome is recorded. */
  readonly outcome: string
  /** Note on the result. */
  readonly note: string
}

/**
 * One investment evaluation: the SOP's data check, run on demand.
 *
 * This is **not** a pipeline phase and nothing gates on it. The author starts
 * one when they want the question "is this book still worth continuing?"
 * answered with numbers instead of a feeling — normally after the book has been
 * live long enough for the platform to report something, which is also when the
 * numbers can be transcribed by hand.
 *
 * What survives from the old phase-three gate is the discipline: an evaluation
 * that does not pass must name where to fall back to and what would make the
 * author stop, and every evaluation must leave an appointment for the next one.
 * Without that appointment an on-demand check quietly becomes no check at all.
 */
export interface Evaluation {
  /** Stable id. */
  readonly id: string
  /** Round number, 1-based, in the order they were run. */
  readonly round: number
  /** ISO-8601 instant. */
  readonly at: string
  /** Where the sample came from: `editor`, `readers`, `author-group`, `platform`. */
  readonly channel: string
  /** How many readers or titles the sample covers. */
  readonly sampleSize: number
  /** The reading id carrying this evaluation's numbers. */
  readonly readingId: string
  /** Which naming candidate was under test, when the evaluation tested naming. */
  readonly namingId: string
  /** The verdict the thresholds produced. */
  readonly verdict: VerdictLevel
  /** Why that verdict, in the tool's words. */
  readonly reasons: readonly string[]
  /** Where to go back to when the evaluation did not pass. */
  readonly fallback: string
  /** What would make the author stop investing in this book. */
  readonly abandonIf: string
  /** The chapter position to look again at, 0 when the author named no number. */
  readonly nextAtChapter: number
  /** The next appointment in the author's words, for example 卷末 or 数据异常时. */
  readonly nextTrigger: string
  /** The author's own reading of the numbers. */
  readonly note: string
}

/** The investment verdicts an evaluation can end in. */
export const EVALUATION_ACTIONS = ['continue', 'adjust', 'cut'] as const

/** One entry of {@link EVALUATION_ACTIONS}. */
export type EvaluationAction = (typeof EVALUATION_ACTIONS)[number]

/** The stage-three go/no-go verdicts. */
export const LAUNCH_VERDICTS = ['go', 'revise', 'abandon'] as const

/** One entry of {@link LAUNCH_VERDICTS}. */
export type LaunchVerdict = (typeof LAUNCH_VERDICTS)[number]

/**
 * The stage-three go/no-go: a human decision that the opening package is worth
 * building out into a full skeleton.
 *
 * It used to be a number. It is not one any more, because the evidence actually
 * available at that point — an editor's read, a dozen readers, the author's own
 * judgement — is judgement, and the SOP's own §1.2 keeps judgement out of the
 * threshold ledger. What is kept is the anti-formality rule: a decision that is
 * not `go` must name where to fall back to and what would make the author drop
 * the concept.
 */
export interface LaunchDecision {
  /** Stable id. */
  readonly id: string
  /** ISO-8601 instant. */
  readonly at: string
  /** `go` unlocks the full outline; `revise` stays here; `abandon` drops the concept. */
  readonly verdict: LaunchVerdict
  /** Where to go back to when the verdict is not `go`. */
  readonly fallback: string
  /** What would make the author drop the concept. */
  readonly abandonIf: string
  /** One line on the evidence the decision rests on. */
  readonly note: string
}

/**
 * One round of the settings/style conversation with the author.
 *
 * The record exists because the tool cannot tell a conversation from a
 * monologue, and the failure this guards against is exactly that: a model that
 * wrote the setup itself and went on to prose. What the tool *can* require is
 * that every round carries the author's own answer — a round without feedback is
 * refused — so a checkpoint cannot be closed without the author having spoken.
 */
export interface DiscussionRound {
  /** Stable id. */
  readonly id: string
  /** Which checkpoint the round belongs to. */
  readonly kind: ConfirmationKind
  /** ISO-8601 instant. */
  readonly at: string
  /** What the round put in front of the author: the draft, or what changed since the last round. */
  readonly proposal: string
  /** What the author answered, in their own words. */
  readonly feedback: string
  /** The settings the round settled, by name, so a later reader can see what moved. */
  readonly topics: readonly string[]
}

/**
 * The author's sign-off on one checkpoint.
 *
 * Append-only like every other ledger: a later revision of the setup or the
 * voice is a new sign-off with its own rounds, and the history of what the
 * author approved when is the point.
 */
export interface Confirmation {
  /** Stable id. */
  readonly id: string
  /** Which checkpoint was closed. */
  readonly kind: ConfirmationKind
  /** ISO-8601 instant. */
  readonly at: string
  /** The version the author approved, written down as the reference later chapters are held to. */
  readonly summary: string
  /** Where the sign-off came from, in the author's words. */
  readonly note: string
  /** How many discussion rounds of this kind had been recorded at sign-off. */
  readonly rounds: number
}

/**
 * Which checkpoints are closed, and what is still open.
 *
 * Derived, never stored — the standing is a function of the rounds and the
 * sign-offs, so a hand-edited ledger cannot disagree with itself.
 */
export interface ConfirmationStanding {
  /** The latest settings sign-off, or `undefined` when the author never gave one. */
  readonly settings: Confirmation | undefined
  /** The latest 文风复核 sign-off, or `undefined`. */
  readonly style: Confirmation | undefined
  /** Discussion rounds recorded since the settings sign-off (all of them, when there is none). */
  readonly settingsRounds: number
  /** Discussion rounds recorded since the 文风复核 sign-off. */
  readonly styleRounds: number
  /** One entry per settings layer, in the SOP's order. */
  readonly layers: readonly SettingsLayerStanding[]
  /** Whether the settings sign-off exists. */
  readonly settingsConfirmed: boolean
  /** Whether the 文风复核 sign-off exists. */
  readonly styleConfirmed: boolean
  /**
   * Whether every layer that gates prose has been confirmed.
   *
   * This is one of the two things `novel_write` hard-gates on: the premise. (The
   * other is the 写作风格 block of the 全书大纲, which is not a confirmation but a
   * field check — see `outlineStyleGaps`.) The remaining layers are ordered rather
   * than blocking, so an author can draft chapter 1 while the volume outline is
   * still being argued about.
   */
  readonly preProseConfirmed: boolean
  /** Whether the rounds recorded so far are enough to close the settings checkpoint. */
  readonly settingsReady: boolean
  /** Whether the rounds recorded so far are enough to close the 文风复核. */
  readonly styleReady: boolean
  /** The layer the author should be settling now, or `undefined` when all are confirmed. */
  readonly nextLayer: SettingsLayerStanding | undefined
  /**
   * The 去 AI 化 review's standing.
   *
   * Derived from the reviews ledger rather than from a checkpoint of its own: the
   * review is a tool call, so its record *is* the receipt, and a second ledger
   * would be a second thing to keep in step. See {@link DeAiStanding}.
   */
  readonly deAi: DeAiStanding
  /** The checkpoints still open, phrased as what has to happen next. */
  readonly blockers: readonly string[]
}

/**
 * Where one settings layer stands.
 *
 * A layer is `ready` when the layers before it are all confirmed — which is how
 * "按顺序" is enforced without a second ledger: the order is a function of the
 * confirmations that already exist.
 */
export interface SettingsLayerStanding {
  /** The layer's key, as a tool call addresses it. */
  readonly key: SettingsLayerKey
  /** The confirmation kind that closes it. */
  readonly kind: SettingsLayerKind
  /** The layer's name in the author's language. */
  readonly label: string
  /** Whether the layer's sign-off exists. */
  readonly confirmed: boolean
  /** Discussion rounds recorded for this layer since its last sign-off. */
  readonly rounds: number
  /** Rounds the layer needs before it can be signed off. */
  readonly roundsRequired: number
  /** Whether an earlier layer is still unconfirmed. */
  readonly blockedBy: SettingsLayerKey | undefined
  /** Whether this layer is the next one to settle. */
  readonly ready: boolean
  /** Whether this layer is the one that gates prose. */
  readonly gatesProse: boolean
}

/**
 * The derived "it may be time to look at the numbers" signal.
 *
 * Advisory by construction: it is computed from project state (chapters written,
 * the previous evaluation's appointment), so it needs no platform access, and it
 * is reported as a suggestion rather than a blocker so that an author who cannot
 * transcribe numbers is never stopped by it.
 */
export interface EvaluationHint {
  /** Whether the project suggests running an evaluation now. */
  readonly due: boolean
  /** The reason, in the author's language. */
  readonly reason: string
}

// ── retrospectives and reusable templates ─────────────────────────────────────

/** One thing worth keeping or avoiding, captured at completion. */
export interface Lesson {
  /** Stable id. */
  readonly id: string
  /** `reuse` for a pattern that worked, `avoid` for one that failed. */
  readonly kind: 'reuse' | 'avoid'
  /** The lesson in one line. */
  readonly statement: string
  /** The evidence behind it. */
  readonly evidence: string
  /** Which part of the craft it belongs to: `opening`, `rhythm`, `character`, … */
  readonly area: string
}

// ── model-backed reviews ──────────────────────────────────────────────────────

/**
 * The judgements `novel_review` can ask a model for.
 *
 * These are the SOP steps whose output is a *reading of language* rather than a
 * number: the tool layer cannot decide them, and the nine deterministic tools
 * deliberately do not try. Every one of them is recorded so the recommendation
 * can be audited against the model and prompt that produced it.
 */
export const REVIEW_KINDS = ['ai-flavor', 'opening', 'competitor', 'retro'] as const

/** One entry of {@link REVIEW_KINDS}. */
export type ReviewKind = (typeof REVIEW_KINDS)[number]

/** How much a finding matters, as judged by the model. */
export const REVIEW_SEVERITIES = ['high', 'medium', 'low'] as const

/** One entry of {@link REVIEW_SEVERITIES}. */
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number]

/** One thing wrong with the prose, anchored to the text that shows it. */
export interface ReviewFinding {
  /** What kind of problem: `翻译腔`, `节奏`, `钩子`, … */
  readonly dimension: string
  /** The offending text, quoted so the author can find it. */
  readonly quote: string
  /** Why it reads as machine-written or weak. */
  readonly why: string
  /** What to do instead. */
  readonly fix: string
  /** How much it matters. */
  readonly severity: ReviewSeverity
}

/**
 * One recorded review.
 *
 * The model and the prompt version are part of the record, not metadata: a
 * judgement produced by an unknown model under an unknown rubric cannot be
 * argued with or reproduced, and the SOP's whole discipline is that a decision
 * names its evidence.
 */
export interface ReviewRecord {
  /** Stable id, `review-<n>`. */
  readonly id: string
  /** ISO-8601 instant of the review. */
  readonly at: string
  /** Which judgement was asked for. */
  readonly kind: ReviewKind
  /** What was reviewed: a chapter id, or `''` for the whole project. */
  readonly target: string
  /** The provider route used. */
  readonly provider: string
  /** The model used. */
  readonly model: string
  /** Which rubric version was sent, so a later revision is distinguishable. */
  readonly promptVersion: string
  /** The model's one-paragraph verdict. */
  readonly summary: string
  /** The individual findings. */
  readonly findings: readonly ReviewFinding[]
  /** Workspace-relative path of the full transcript, or `''` when none was kept. */
  readonly artifact: string
}

/** One IP-ready asset extracted from the finished novel. */
export interface IpAsset {
  /** Stable id. */
  readonly id: string
  /** `character`, `setting`, `scene`, `quote`, `relationship`, `link`. */
  readonly kind: string
  /** Display label. */
  readonly label: string
  /** The asset itself, or a pointer into the chapters. */
  readonly content: string
  /** Where it came from: chapter id or number. */
  readonly source: string
}

/** A reusable structural template exported for the next novel. */
export interface ReusableTemplate {
  /** Template name, usually the source novel plus the date. */
  readonly name: string
  /** ISO-8601 instant of export. */
  readonly exportedAt: string
  /** Act structure copied from the source. */
  readonly acts: readonly string[]
  /** Volume rhythm copied from the source. */
  readonly volumeRhythm: readonly string[]
  /** Beat pattern, expressed as offsets rather than chapter numbers. */
  readonly beatPattern: readonly string[]
  /** Hook patterns that recurred. */
  readonly hookPatterns: readonly string[]
  /** The emotional template. */
  readonly emotionTemplate: string
  /**
   * Deliberately empty of cast and proper nouns: the SOP requires a variant
   * upgrade rather than a reused cast, and a template that cannot carry
   * characters cannot be copy-pasted into a clone.
   */
  readonly note: string
}

/** The retrospective record of a finished (or abandoned) novel. */
export interface Retrospective {
  /** ISO-8601 instant the retrospective was written. */
  readonly at: string
  /** Final numbers in the author's words. */
  readonly dataSummary: string
  /** What worked. */
  readonly highlights: readonly string[]
  /** What failed. */
  readonly problems: readonly string[]
  /** Structured lessons. */
  readonly lessons: readonly Lesson[]
  /** IP-ready assets. */
  readonly assets: readonly IpAsset[]
  /** Templates exported for the next novel. */
  readonly templates: readonly ReusableTemplate[]
}

// ── the document ──────────────────────────────────────────────────────────────

/**
 * Where one chapter's two content files live, and what they contained.
 *
 * The hashes are not a lock: the storage policy is "the file wins", so a hash
 * only distinguishes "byte-identical to what we parsed last time" (skip the
 * reparse) from "someone edited this" (re-read and adopt).
 */
export interface ChapterFileRef {
  /** 1-based position in reading order, as the chapter plan records it. */
  readonly number: number
  /** Working title, as the chapter plan records it; `''` while untitled. */
  readonly title: string
  /** Workspace-relative path of the prose file (`章节/第001章-山门.md`). */
  readonly bodyFile: string
  /** Workspace-relative path of the contract file (`章节/第001章-山门.细纲.md`). */
  readonly outlineFile: string
  /** `sha256:…` of the prose file's text at the last read or write. */
  readonly bodyHash: string
  /** `sha256:…` of the contract file's text at the last read or write. */
  readonly outlineHash: string
}

/**
 * Where one volume's outline file lives, and what it contained.
 *
 * The stable key is the **volume number**, which is also the filename
 * (`分卷大纲/第1卷.md`), so a retitled volume never moves its file — unlike a
 * chapter, whose name carries the title. `file` is recorded anyway, exactly as
 * `ChapterFileRef` records its paths: the author may have named the file
 * themselves, and "the file wins" means the index follows the file rather than
 * re-deriving a name over it.
 */
export interface VolumeFileRef {
  /** 1-based volume number, as the volume's own frontmatter records it. */
  readonly number: number
  /** Workspace-relative path of the volume's outline file. */
  readonly file: string
  /** `sha256:…` of that file's text at the last read or write. */
  readonly hash: string
}

/**
 * Where one volume's chapter table and rhythm table live, and what they held.
 *
 * Keyed by the volume the file covers, exactly as the filename spells it — `0`
 * is the file holding the chapters that are not filed under any volume, which
 * for a deliberately 不分卷 book is the whole book.
 */
export interface ChapterPlanFileRef {
  /** Volume this file covers; 0 for the chapters filed under no volume. */
  readonly volume: number
  /** Workspace-relative path of that volume's chapter-plan file. */
  readonly file: string
  /** `sha256:…` of that file's text at the last read or write. */
  readonly hash: string
}

/**
 * The index: the one place that records where content actually lives.
 *
 * The top-level names are fixed Chinese filenames by default and configurable
 * through `Config.storageLayout`; everything else is keyed by a stable id — a
 * chapter id, a volume number — so a retitle can be recovered from the file's
 * own frontmatter.
 *
 * `files` is a path→hash map rather than one field per kind because the reader
 * must not assume "one file per kind": the volume outlines are already one file
 * per volume, and the plan's own note on a 1000-chapter book leaves room for the
 * chapter plan to split per volume later. Code that reads this map is already
 * indifferent to that.
 */
export interface StorageIndex {
  /** Workspace-relative path of the whole-book outline file. */
  readonly outlineFile: string
  /** Workspace-relative path of the cast file. */
  readonly castFile: string
  /** Workspace-relative path of the world file. */
  readonly worldFile: string
  /** Workspace-relative path of the directory holding one file per volume. */
  readonly volumeDir: string
  /** Workspace-relative path of the chapter plan's whole-book file. */
  readonly chapterPlanFile: string
  /** Workspace-relative path of the directory holding one chapter plan per volume. */
  readonly chapterPlanDir: string
  /** Workspace-relative path of the competitor-dismantle file. */
  readonly competitorFile: string
  /** One entry per chapter, keyed by {@link Chapter.id}. */
  readonly chapters: Readonly<Record<string, ChapterFileRef>>
  /** One entry per volume, keyed by the volume number as a string. */
  readonly volumes: Readonly<Record<string, VolumeFileRef>>
  /** One entry per volume's chapter plan, keyed by the volume number as a string. */
  readonly chapterPlans: Readonly<Record<string, ChapterPlanFileRef>>
  /** `sha256:…` of every indexed content file, keyed by workspace-relative path. */
  readonly files: Readonly<Record<string, string>>
}

/**
 * The whole persisted novel project.
 *
 * As of schema version 3 this is *assembled*: the metadata fields below come from
 * `.novel/novel.json`, while `outline`, `characters`, `world`, and the chapters
 * come from the Markdown files {@link StorageIndex} points at. `core/*` neither
 * knows nor cares which is which.
 */
export interface NovelState {
  /** On-disk schema version, checked on read. */
  readonly schemaVersion: number
  /** Premise and prose conventions. */
  readonly meta: NovelMeta
  /** Commercial frame. */
  readonly platform: PlatformProfile
  /** The memorable point and its supporting differentiators. */
  readonly pitch: Premise
  /** Candidate title/blurb/tag sets. */
  readonly naming: readonly NamingCandidate[]
  /** Leaderboard medians every reading is compared against. */
  readonly baselines: MetricBaselines
  /** Comparable titles dismantled for the SOP's competitor step. */
  readonly competitors: readonly Competitor[]
  /** Writing parameters, one meaning each. */
  readonly writing: WritingPlan
  /** Cast, keyed by {@link Character.id}. */
  readonly characters: Readonly<Record<string, Character>>
  /** World facts, keyed by {@link WorldEntry.id}. */
  readonly world: Readonly<Record<string, WorldEntry>>
  /** Reader promises awaiting payoff, keyed by {@link StoryLink.id}. */
  readonly links: Readonly<Record<string, StoryLink>>
  /** The plan. */
  readonly outline: Outline
  /** Chapters, keyed by {@link Chapter.id}. */
  readonly chapters: Readonly<Record<string, Chapter>>
  /** Metric readings in the order taken. */
  readonly readings: readonly MetricReading[]
  /** Applied changes with their evidence chain. */
  readonly iterations: readonly Iteration[]
  /**
   * Investment evaluations, in the order run.
   *
   * Empty is the normal state of a project: an evaluation happens only when the
   * author asks whether the book is still worth continuing, and nothing in the
   * pipeline waits for one.
   */
  readonly evaluations: readonly Evaluation[]
  /** The stage-three go/no-go decisions and their reasons. */
  readonly launchDecisions: readonly LaunchDecision[]
  /**
   * The settings/style conversation with the author, round by round.
   *
   * Additive like the ledgers below it: a project written before the checkpoints
   * existed has none, which is precisely why the settings checkpoint reads as
   * open on such a project.
   */
  readonly discussions: readonly DiscussionRound[]
  /**
   * The author's sign-offs, one per checkpoint layer, newest last.
   *
   * The premise layer's sign-off is what unlocks prose: `novel_write` refuses to
   * write a chapter until it exists. The layers after it are recorded the same
   * way, under their own kinds, and `confirmationStanding` derives the order
   * from them rather than storing a sequence.
   */
  readonly confirmations: readonly Confirmation[]
  /**
   * Model-backed judgements in the order taken.
   *
   * Additive since the first release, so a document written before reviews
   * existed simply has none; the reader defaults it rather than refusing the
   * file, because losing a draft to a plugin upgrade is the one outcome the
   * codec must never allow.
   */
  readonly reviews: readonly ReviewRecord[]
  /**
   * Where the content files live, and what they last contained.
   *
   * Maintained by the store, never a content source: a fact that appears both
   * here and in a content file is read from the file. Optional only so a state
   * built in memory (a fixture, a migration input) need not fabricate one; the
   * store always writes it.
   */
  readonly index?: StorageIndex
  /** Retrospective and reusable material; absent until completion. */
  readonly retro?: Retrospective
  /** ISO-8601 timestamp of project creation. */
  readonly createdAt: string
  /** ISO-8601 timestamp of the last accepted write. */
  readonly updatedAt: string
}

/** Which SOP phase a project is in, and what is stopping the next one. */
export interface StageAssessment {
  /** The phase the project's data supports. */
  readonly stage: ProjectStage
  /** Preconditions not yet met for the *next* phase. */
  readonly blockers: readonly string[]
  /** Preconditions met, for orientation. */
  readonly satisfied: readonly string[]
}

/** Aggregate standing, derived on every read — never stored. */
export interface NovelProgress {
  /** Number of chapters in the project. */
  readonly chapters: number
  /** How many chapters sit in each status. */
  readonly byStatus: Readonly<Record<ChapterStatus, number>>
  /** Total characters of prose across every chapter. */
  readonly totalWords: number
  /** Chapters that exist but hold no prose yet. */
  readonly emptyChapters: readonly string[]
  /** Chapter ids whose number is duplicated or non-contiguous. */
  readonly numberingIssues: readonly string[]
  /** Chapters with prose but not yet marked published, by the run-length rule. */
  readonly stockChapters: number
  /** How many chapters answer every contract field. */
  readonly contractedChapters: number
  /** How many written chapters delivered every field they promised. */
  readonly deliveredChapters: number
  /** Promises still open. */
  readonly openLinks: readonly string[]
  /** Open promises whose due chapter is already written. */
  readonly overdueLinks: readonly string[]
}
