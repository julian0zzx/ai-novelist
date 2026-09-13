/**
 * The model-backed review layer: what to ask, and how to read the answer back.
 *
 * Eight of the nine tools decide things — thresholds, gates, arithmetic — and
 * they do it in code, because a verdict that changes between runs is not a
 * verdict. This module is the deliberate exception. Judging prose is not
 * arithmetic: no counter can tell 翻译腔 from voice, and the SOP says so
 * (第 23 步, §1.2 "主观判断，不替判"). So the judgement is asked of a model,
 * under a rubric that lives here, versioned, and recorded beside the answer.
 *
 * Everything in this file is pure. Building a request is a function of the
 * project state; parsing a reply is a function of text. That is what makes a
 * non-deterministic feature testable: the model is the only thing the specs
 * cannot pin, so it is the only thing they fake.
 *
 * @module @ai-webnovel/composer-host/core/review
 */

import { countWords } from './novel.ts'
import type {
  Chapter,
  Competitor,
  Iteration,
  Lesson,
  MetricReading,
  NovelProgress,
  NovelState,
  OpeningCheck,
  ReviewFinding,
  ReviewSeverity,
} from './types.ts'
import { REVIEW_SEVERITIES } from './types.ts'

/**
 * Version of every rubric in this file, stamped onto each record.
 *
 * A review is only arguable if the instruction that produced it is known, so
 * the version travels with the result. Bump it whenever the wording below
 * changes in a way that could move a judgement.
 */
export const REVIEW_PROMPT_VERSION = 'review-rubric-1'

/** Output ceiling for one review call. */
export const REVIEW_MAX_TOKENS = 4096

/** How much prose one review may carry, in characters, before it is clipped. */
export const REVIEW_MAX_INPUT_CHARS = 24000

/**
 * The 去 AI 化 rubric, dimension by dimension.
 *
 * Each entry is a symptom an editor would actually mark in a web-novel draft,
 * phrased so the model can point at text rather than at a vibe.
 */
export const AI_FLAVOR_DIMENSIONS: readonly { readonly key: string; readonly rule: string }[] = [
  { key: '翻译腔', rule: '「值得注意的是」「在这个过程中」「在一定程度上」这类书面连接词，被动句，超长定语从句，名词化动词' },
  { key: '整齐句式', rule: '三句排比、对仗、每句等长、每段结构一致——人写不出这么整齐的节奏' },
  { key: '总结式抒情', rule: '把情绪讲出来而不是演出来：「这一刻，他明白了什么是……」「心中五味杂陈」' },
  { key: '套话身体反应', rule: '「嘴角勾起一抹弧度」「瞳孔骤然一缩」「心中一凛」「不由自主地」等网文套件' },
  { key: '解释型对话', rule: '对话在替作者交代设定：人人说话都完整、文雅、信息密度过高，没有打断、抢话、答非所问' },
  { key: '告知而非呈现', rule: '直接给结论（他很生气／她很美／局势危险），缺少可感知的动作、物件、感官细节' },
  { key: '段落节奏', rule: '网文阅读节奏：段落过长、一句一段滥用、动作与信息没有按段落推进' },
  { key: '章末钩子', rule: '章末是否留下具体悬念或未完成的动作；「欲知后事如何」式的空钩子不算' },
]

/** One model request, already framed for the provider. */
export interface ReviewRequest {
  /** System instruction: the rubric and the output contract. */
  readonly system: string
  /** User content: the project brief plus the material under review. */
  readonly user: string
  /** Output ceiling for this call. */
  readonly maxTokens: number
}

/** A competitor dismantle as the model returns it, before it is keyed. */
export type CompetitorDraft = Omit<Competitor, 'id'> & { readonly id?: string }

/** A lesson as the model returns it, before it is keyed. */
export type LessonDraft = Omit<Lesson, 'id'> & { readonly id?: string }

/** What one review produced. */
export interface ReviewOutput {
  /** The model's one-paragraph verdict, or its first line when parsing failed. */
  readonly summary: string
  /** The findings, in the order the model returned them. */
  readonly findings: readonly ReviewFinding[]
  /** `competitor` only: the dismantle, when the reply carried a usable one. */
  readonly dismantle?: CompetitorDraft
  /** `retro` only: the lessons, when the reply carried usable ones. */
  readonly lessons?: readonly LessonDraft[]
  /** The verbatim reply, kept for the transcript on disk. */
  readonly raw: string
  /** Whether the structured part could be read. False means "summary only". */
  readonly parsed: boolean
}

// ── shared framing ────────────────────────────────────────────────────────────

/**
 * Clip text to a character budget, marking the cut.
 *
 * A chapter can be longer than a review needs; truncating loudly is better than
 * silently reviewing half a chapter and reporting on it as if it were whole.
 *
 * @param text - the text to clip.
 * @param max - the character budget.
 * @returns the text, with a marker appended when anything was dropped.
 */
export function clip(text: string, max: number = REVIEW_MAX_INPUT_CHARS): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n\n（正文超过 ${String(max)} 字，以上为截断部分）`
}

/**
 * The project brief every review is prefixed with.
 *
 * Genre, platform and the memorable point are what make a judgement specific:
 * "too slow" means something different in 男频玄幻 and 女频甜宠.
 *
 * @param state - the project.
 * @returns the brief as plain text.
 */
export function projectBrief(state: NovelState): string {
  const genres = state.platform.genres.length > 0 ? state.platform.genres.join('、') : '（未填）'
  return [
    `书名：${state.meta.title || '（未定）'}`,
    `品类：${genres}｜频道：${state.platform.audience}｜模式：${state.platform.mode}`,
    `目标读者：${state.platform.readers || '（未填）'}`,
    `一句话卖点：${state.pitch.memorablePoint || state.meta.premise || '（未填）'}`,
    `核心情绪：${state.pitch.coreEmotion || '（未填）'}｜内核：${state.pitch.kernel || '（未填）'}`,
    `人称：${state.writing.pov}｜语言：${state.writing.language}`,
  ].join('\n')
}

/**
 * The output contract appended to every system prompt.
 *
 * One shape for all four reviews: the tool then has one parser, one record
 * shape, and one way to render an answer, and the model has one thing to
 * remember.
 *
 * @param extra - additional keys the specific review asks for.
 * @returns the contract text.
 */
function outputContract(extra = ''): string {
  return [
    '输出要求：',
    '1. 只输出一个 JSON 对象，不要 Markdown 代码块，不要任何解释性前后缀。',
    '2. 结构：{"summary": "一段话总评", "findings": [{"dimension": "问题类型", "quote": "原文引用", "why": "为什么算问题", "fix": "具体怎么改", "severity": "high|medium|low"}]}',
    '3. quote 必须是原文中的连续片段（40 字以内）；无法引用就不要写这条。',
    '4. 宁少勿滥：只报你确信的问题，最多 12 条，按 severity 从高到低排列。没有问题时 findings 返回空数组。',
    '5. 用中文写 summary / why / fix。不要客套，不要总结剧情，直接说问题。',
    extra === '' ? '' : extra,
  ]
    .filter((line) => line !== '')
    .join('\n')
}

/** Shared instruction: this is advice, not a rewrite of the author's book. */
const REVIEWER_STANCE =
  '你是一位中文网文编辑，正在给作者的稿子做上线前的诊断。你的读者是作者本人，不是读者群体。'
  + '只诊断，不夸奖；不要复述剧情；不要给出与原文无关的通用写作建议。'

// ── 1. 去 AI 化 ───────────────────────────────────────────────────────────────

/**
 * Build the 去 AI 化 review request for one chapter.
 *
 * @param input - the project, the chapter, and the optional dimension filter.
 * @returns the framed request.
 */
export function buildAiFlavorRequest(input: {
  readonly state: NovelState
  readonly chapter: Chapter
  readonly focus?: readonly string[] | undefined
}): ReviewRequest {
  const selected = input.focus === undefined || input.focus.length === 0
    ? AI_FLAVOR_DIMENSIONS
    : AI_FLAVOR_DIMENSIONS.filter((dimension) => input.focus?.includes(dimension.key) === true)
  const rubric = (selected.length > 0 ? selected : AI_FLAVOR_DIMENSIONS)
    .map((dimension, index) => `${String(index + 1)}. ${dimension.key}：${dimension.rule}`)
    .join('\n')
  const chapter = input.chapter
  const system = [
    REVIEWER_STANCE,
    '',
    `任务：找出这一章里"像 AI 写的"和"网文语感差"的具体位置。按以下维度逐条检查（只报命中的维度）：`,
    rubric,
    '',
    '判断标准是"读者会不会出戏"，不是"文笔够不够文学"。宁可少报，也不要为了凑数把正常句子算作问题。',
    '',
    outputContract(),
  ].join('\n')
  const user = [
    projectBrief(input.state),
    '',
    `第 ${String(chapter.number)} 章「${chapter.title || chapter.id}」（${String(countWords(chapter.body))} 字）`,
    `本章任务：${chapter.plotTask || '（未填）'}`,
    `情绪回报：${chapter.emotionalPayoff || '（未填）'}`,
    `章末钩子（计划）：${chapter.hook || '（未填）'}`,
    '',
    '正文：',
    clip(chapter.body),
  ].join('\n')
  return { system, user, maxTokens: REVIEW_MAX_TOKENS }
}

/**
 * Build the rewrite request that follows a 去 AI 化 review.
 *
 * The rewritten chapter is a proposal: it is written beside the project, never
 * over it, and only `novel_write` may replace a chapter body.
 *
 * @param input - the project, the chapter, and the findings to fix.
 * @returns the framed request.
 */
export function buildRewriteRequest(input: {
  readonly state: NovelState
  readonly chapter: Chapter
  readonly findings: readonly ReviewFinding[]
}): ReviewRequest {
  const chapter = input.chapter
  const list = input.findings
    .map(
      (finding, index) =>
        `${String(index + 1)}. [${finding.severity}] ${finding.dimension}`
        + `${finding.quote === '' ? '' : `「${finding.quote}」`}：${finding.why} → ${finding.fix}`,
    )
    .join('\n')
  const system = [
    REVIEWER_STANCE,
    '',
    '任务：按给定的诊断重写这一章。硬性要求：',
    '1. 剧情、人物、信息点、章末钩子与原文完全一致，不得增删情节，不得改变结局。',
    '2. 只改写法：去掉 AI 味、口语化、短段落、动作与画面优先、对话像人说话。',
    '3. 字数与原文相当（±15%）。',
    '4. 只输出重写后的正文，不要任何说明、标题、Markdown 标记或 JSON 包装。',
  ].join('\n')
  const user = [
    projectBrief(input.state),
    '',
    `第 ${String(chapter.number)} 章「${chapter.title || chapter.id}」`,
    `需修正的问题：`,
    list === '' ? '（无）' : list,
    '',
    '原文：',
    clip(chapter.body),
  ].join('\n')
  return { system, user, maxTokens: REVIEW_MAX_TOKENS }
}

// ── 2. 开篇体检 ───────────────────────────────────────────────────────────────

/**
 * Build the opening-package review for the gate chapters.
 *
 * @param input - the project, the chapters under the gate, and the SOP checklist.
 * @returns the framed request.
 */
export function buildOpeningRequest(input: {
  readonly state: NovelState
  readonly chapters: readonly Chapter[]
  readonly checks: readonly OpeningCheck[]
  readonly gate: number
}): ReviewRequest {
  const checklist = input.checks
    .map((check) => `${check.done ? '[x]' : '[ ]'} ${check.requirement}`)
    .join('\n')
  const material = input.chapters
    .map((chapter) =>
      [
        `第 ${String(chapter.number)} 章「${chapter.title || chapter.id}」（${String(countWords(chapter.body))} 字）`,
        `任务：${chapter.plotTask || '（未填）'}｜钩子：${chapter.hook || '（未填）'}`,
        chapter.body.trim() === '' ? '（尚无正文）' : clip(chapter.body, 8000),
      ].join('\n'),
    )
    .join('\n\n')
  const system = [
    REVIEWER_STANCE,
    '',
    `任务：体检前 ${String(input.gate)} 章（平台考核开篇门禁）。读者只给这几章的机会，判断标准是"读完之后还想不想读第 ${String(input.gate + 1)} 章"。`,
    '逐章检查：主角是否在第一章就立起来（欲望/困境/性格）；金手指或核心设定是否亮相；第一个爽点是否落地；信息是否克制（有没有一次倒设定）；章末钩子是否具体；三章之间是否在推进而不是重复。',
    '在 findings 的 dimension 里用「第N章 · 问题类型」标明章号。',
    '',
    outputContract(),
  ].join('\n')
  const user = [
    projectBrief(input.state),
    '',
    'SOP 开篇工程清单当前状态：',
    checklist === '' ? '（清单为空）' : checklist,
    '',
    '开篇正文：',
    material === '' ? '（没有可体检的章节）' : material,
  ].join('\n')
  return { system, user, maxTokens: REVIEW_MAX_TOKENS }
}

// ── 3. 竞品拆解 ───────────────────────────────────────────────────────────────

/**
 * Build the competitor-dismantle request from pasted source text.
 *
 * @param input - the project, the competitor title, and its text.
 * @returns the framed request.
 */
export function buildCompetitorRequest(input: {
  readonly state: NovelState
  readonly title: string
  readonly text: string
}): ReviewRequest {
  const system = [
    REVIEWER_STANCE,
    '',
    '任务：拆解一本同榜竞品，产出可直接入库的结构化情报。只依据给定文本，不要凭记忆补充该书内容；看不出来的字段写「无法判断」。',
    '',
    outputContract(
      '6. 另外在顶层加一个 "dismantle" 对象，字段：tags(数组)、blurb、openingEvent、goldenFinger、'
        + 'protagonistDesire、antagonistMotive、shuangFrequency、emotionCurve、paywallPoint、chapterHooks、commentKeywords(数组)、takeaway。',
    ),
  ].join('\n')
  const user = [
    projectBrief(input.state),
    '',
    `竞品书名：${input.title}`,
    '',
    '竞品原文（简介／开篇／章节）：',
    clip(input.text),
  ].join('\n')
  return { system, user, maxTokens: REVIEW_MAX_TOKENS }
}

// ── 4. 复盘提炼 ───────────────────────────────────────────────────────────────

/**
 * Build the retrospective-distillation request from the project's own data.
 *
 * Only derived facts go in: the model is asked to read the numbers and the
 * chapter table, not to remember the book. That is the same rule the SOP sets
 * for every threshold (§1.2).
 *
 * @param input - the project and its history.
 * @returns the framed request.
 */
export function buildRetroRequest(input: {
  readonly state: NovelState
  readonly progress: NovelProgress
  readonly readings: readonly MetricReading[]
  readonly iterations: readonly Iteration[]
  readonly lessons: readonly Lesson[]
}): ReviewRequest {
  const cells = (reading: MetricReading): string =>
    Object.entries(reading.values)
      .map(([key, value]) => `${key}=${String(value ?? '—')}`)
      .join(' ')
  const readings = input.readings
    .slice(-8)
    .map(
      (reading) =>
        `${reading.id}（${reading.period}，第 ${String(reading.atChapter)} 章）：${cells(reading)}`,
    )
    .join('\n')
  const iterations = input.iterations
    .slice(-12)
    .map(
      (iteration) =>
        `${iteration.id} [${iteration.outcome}] 范围=${iteration.scope} 动作=${iteration.action} 触发=${iteration.trigger}`,
    )
    .join('\n')
  const chapters = Object.values(input.state.chapters)
    .sort((a, b) => a.number - b.number)
    .map(
      (chapter) =>
        `${String(chapter.number)}. [${chapter.status}] ${chapter.title || chapter.id} ${String(chapter.wordCount)}字`
        + ` 兑现=${String(chapter.delivered.length)}/7`,
    )
    .join('\n')
  const existing = input.lessons.map((lesson) => `[${lesson.kind}] ${lesson.statement}`).join('\n')
  const system = [
    REVIEWER_STANCE,
    '',
    '任务：读完这本书的运行数据，产出可复用的经验。分两类：',
    '- reuse：有效的做法（数据支持、结构可迁移）。',
    '- avoid：踩过的坑（数据变差、返工、验证不通过）。',
    '每条经验必须能指向上面的具体证据（某次读数、某次迭代、某段章节区间），不要写"要努力""多读书"这类空话。',
    '只依据给定数据；数据不足时明确说"数据不足，无法判断"，不要编造因果。',
    '',
    outputContract(
      '6. 另外在顶层加一个 "lessons" 数组，每项：{"kind": "reuse|avoid", "statement": "一句话经验", '
        + '"evidence": "指向数据里的哪条证据", "area": "opening|rhythm|character|hook|pacing|other"}。',
    ),
  ].join('\n')
  const user = [
    projectBrief(input.state),
    '',
    `进度：${String(input.progress.chapters)} 章 / ${String(input.progress.totalWords)} 字；`
      + `已写 ${String(input.progress.chapters - input.progress.emptyChapters.length)}；`
      + `库存 ${String(input.progress.stockChapters)}/${String(input.state.writing.stockTargetChapters)}`,
    `承诺：未回收 ${String(input.progress.openLinks.length)}，逾期 ${String(input.progress.overdueLinks.length)}`,
    '',
    '读数（最近 8 次）：',
    readings === '' ? '（没有读数）' : readings,
    '',
    '迭代台账（最近 12 次）：',
    iterations === '' ? '（没有迭代记录）' : iterations,
    '',
    '章节：',
    chapters === '' ? '（没有章节）' : chapters,
    '',
    '已归档的经验：',
    existing === '' ? '（无）' : existing,
  ].join('\n')
  return { system, user, maxTokens: REVIEW_MAX_TOKENS }
}

// ── parsing ───────────────────────────────────────────────────────────────────

/**
 * Pull the JSON object out of a model reply.
 *
 * Models wrap JSON in code fences, prepend "好的，以下是……", or append a note.
 * Taking the first `{` to the last `}` handles all three without pretending the
 * reply was clean.
 *
 * @param text - the verbatim reply.
 * @returns the parsed object, or `undefined` when there is none.
 */
export function extractReviewJson(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Read a model reply into the shape the tool records and renders.
 *
 * A reply that cannot be parsed is not an error: the tool still has the model's
 * prose, and reporting "the model answered but not in the requested shape" is
 * more useful than discarding the call the author paid for.
 *
 * @param text - the verbatim reply.
 * @returns the normalized output.
 */
export function parseReviewOutput(text: string): ReviewOutput {
  const raw = text
  const parsed = extractReviewJson(text)
  if (parsed === undefined) {
    return { summary: firstLine(text), findings: [], raw, parsed: false }
  }
  const findings = readFindings(parsed['findings'])
  const dismantle = readDismantle(parsed['dismantle'])
  const lessons = readLessons(parsed['lessons'])
  return {
    summary: typeof parsed['summary'] === 'string' && parsed['summary'].trim() !== ''
      ? parsed['summary'].trim()
      : firstLine(text),
    findings,
    ...(dismantle === undefined ? {} : { dismantle }),
    ...(lessons === undefined ? {} : { lessons }),
    raw,
    parsed: true,
  }
}

/**
 * The first non-empty line, used as a fallback summary.
 *
 * @param text - the reply.
 * @returns the line, clipped to a readable length.
 */
function firstLine(text: string): string {
  const line = text
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry !== '')
  return (line ?? '').slice(0, 200)
}

/**
 * Read the `findings` array, dropping entries that carry nothing actionable.
 *
 * @param value - the decoded field.
 * @returns the findings.
 */
function readFindings(value: unknown): ReviewFinding[] {
  if (!Array.isArray(value)) return []
  const findings: ReviewFinding[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const entry = item as Record<string, unknown>
    const dimension = text(entry['dimension'])
    const fix = text(entry['fix'])
    if (dimension === '' && fix === '') continue
    const severity = text(entry['severity']).toLowerCase()
    findings.push({
      dimension,
      quote: text(entry['quote']),
      why: text(entry['why']),
      fix,
      severity: (REVIEW_SEVERITIES as readonly string[]).includes(severity)
        ? (severity as ReviewSeverity)
        : 'medium',
    })
  }
  return findings.sort(bySeverity)
}

/** Order findings high → medium → low, stable within a severity. */
function bySeverity(a: ReviewFinding, b: ReviewFinding): number {
  const rank = (finding: ReviewFinding): number =>
    finding.severity === 'high' ? 0 : finding.severity === 'medium' ? 1 : 2
  return rank(a) - rank(b)
}

/**
 * Read the competitor `dismantle` object.
 *
 * @param value - the decoded field.
 * @returns the draft, or `undefined` when it is not an object.
 */
function readDismantle(value: unknown): CompetitorDraft | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const entry = value as Record<string, unknown>
  return {
    title: text(entry['title']),
    tags: texts(entry['tags']),
    blurb: text(entry['blurb']),
    openingEvent: text(entry['openingEvent']),
    goldenFinger: text(entry['goldenFinger']),
    protagonistDesire: text(entry['protagonistDesire']),
    antagonistMotive: text(entry['antagonistMotive']),
    shuangFrequency: text(entry['shuangFrequency']),
    emotionCurve: text(entry['emotionCurve']),
    paywallPoint: text(entry['paywallPoint']),
    chapterHooks: text(entry['chapterHooks']),
    commentKeywords: texts(entry['commentKeywords']),
    takeaway: text(entry['takeaway']),
  }
}

/**
 * Read the retrospective `lessons` array.
 *
 * @param value - the decoded field.
 * @returns the drafts, or `undefined` when the reply carried none.
 */
function readLessons(value: unknown): LessonDraft[] | undefined {
  if (!Array.isArray(value)) return undefined
  const lessons: LessonDraft[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const entry = item as Record<string, unknown>
    const statement = text(entry['statement'])
    if (statement === '') continue
    lessons.push({
      kind: text(entry['kind']) === 'avoid' ? 'avoid' : 'reuse',
      statement,
      evidence: text(entry['evidence']),
      area: text(entry['area']) === '' ? 'other' : text(entry['area']),
    })
  }
  return lessons
}

/**
 * Coerce an unknown field to a trimmed string.
 *
 * @param value - the field.
 * @returns the string, or `''`.
 */
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Coerce an unknown field to a list of non-empty strings.
 *
 * @param value - the field.
 * @returns the list.
 */
function texts(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((entry) => text(entry)).filter((entry) => entry !== '')
}

// ── rendering ─────────────────────────────────────────────────────────────────

/**
 * Render one review as the lines the tool returns.
 *
 * @param output - the parsed reply.
 * @param heading - the section heading, for example `去 AI 化诊断`.
 * @returns the body lines.
 */
export function renderReview(output: ReviewOutput, heading: string): string[] {
  const lines: string[] = [output.summary === '' ? '（模型未给出总评）' : output.summary]
  if (!output.parsed) {
    lines.push(
      '',
      '⚠ 模型没有按约定返回 JSON，以上为原始回复的首行；完整回复见下方记录文件，findings 无法入库。',
    )
    return lines
  }
  if (output.findings.length === 0) {
    lines.push('', '## ' + heading, '- 没有发现需要修改的问题。')
    return lines
  }
  lines.push('', `## ${heading}（${String(output.findings.length)} 条，按严重度排序）`)
  for (const finding of output.findings) {
    const severity = finding.severity === 'high' ? '高' : finding.severity === 'medium' ? '中' : '低'
    lines.push(`- [${severity}] ${finding.dimension}：${finding.fix}`)
    if (finding.quote !== '') lines.push(`  原文：${finding.quote}`)
    if (finding.why !== '') lines.push(`  原因：${finding.why}`)
  }
  return lines
}
