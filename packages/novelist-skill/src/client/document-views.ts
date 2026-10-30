/**
 * What each process document can show, as data.
 *
 * The Kanban board's top half is a row of process documents, and a card that
 * only reports a standing ("2/5 fields", "still owes 主角成长线") leaves the
 * author with no way to read the artefact behind it. This module answers the
 * other question — *what is in this document?* — without adding a second copy of
 * the storage format to the browser:
 *
 * - documents the project keeps in a Markdown file are shown as that file's own
 *   text (`全书大纲.md`, `人物设定.md`, …);
 * - documents that are one block of a shared file are shown as that block
 *   (`故事六要素`, `写作风格`, …), read through the same `##` section parser the
 *   codec uses;
 * - documents the plan keeps in `.novel/novel.json` (the pitch, the launch
 *   decisions, the serial ledgers, the retrospective) are rendered into readable
 *   Markdown here, because a raw JSON dump is a file only a developer can read.
 *
 * One document can own **more than one** view: a volume outline is one file per
 * volume, the payoff schedule is one rhythm table per chapter-plan file, and the
 * de-AI diagnosis is one review per chapter. The view layer shows those as a
 * list and opens one at a time, which is why the source is a list rather than a
 * single string.
 *
 * The module is deliberately pure: it takes the state, the index and the raw
 * file text, and returns plain objects. Whether a modal is open is the view's
 * business; what a document contains is testable without a browser.
 *
 * @module @ai-novelist/novelist-skill/client/document-views
 */

import { CHAPTER_PLAN_SECTIONS, OUTLINE_SECTIONS, VOLUME_DETAIL_HEADING } from '../core/content.ts'
import type { ContentFiles } from '../core/content.ts'
import { findSection, splitDocument, splitFrontmatter } from '../core/markdown.ts'
import { volumePath } from '../core/paths.ts'
import {
  CHEAT_PARTS,
  OUTLINE_SPINE_PARTS,
  OUTLINE_STYLE_PARTS,
  STORY_ELEMENT_PARTS,
  VOLUME_SPINE_PARTS,
} from '../core/types.ts'
import type {
  Character,
  Competitor,
  Evaluation,
  Iteration,
  MetricReading,
  NovelState,
  ReviewRecord,
  StorageIndex,
  VolumePlan,
  WorldEntry,
} from '../core/types.ts'

/** One readable artefact behind a process document. */
export interface DocumentView {
  /** Stable id within its document, so a list item keeps its identity across re-reads. */
  readonly id: string
  /** What the list item and the modal's title say. */
  readonly label: string
  /** Where the text came from: a workspace path, or `.novel/novel.json`. */
  readonly source: string
  /** The text the modal shows; Markdown, as the files themselves are. */
  readonly content: string
}

/** The metadata document, named as its own source in every generated view. */
const METADATA_SOURCE = '.novel/novel.json'

/**
 * All viewable artefacts, grouped by the document card that owns them.
 *
 * A document with no entry — or with an empty list — has nothing to open, which
 * is exactly what the card uses to decide whether to look clickable. A fresh
 * project writes every content file, empty ones included, so "the file exists"
 * is not the test; {@link hasContent} is.
 *
 * @param state - the assembled project.
 * @param index - the storage index naming the content files.
 * @param files - the raw text of each content file that exists.
 * @returns one list per document id, in the board's own vocabulary.
 */
export function documentViewsOf(
  state: NovelState,
  index: StorageIndex,
  files: ContentFiles,
): Readonly<Record<string, readonly DocumentView[]>> {
  const views: Record<string, readonly DocumentView[]> = {
    pitch: pitchViews(state),
    competitors: competitorViews(state, index, files),
    naming: namingViews(state),
    world: worldViews(state, index, files),
    cast: castViews(state, index, files),
    'de-ai': deAiViews(state),
    story: storyViews(state, index, files),
    cheat: cheatViews(state, index, files),
    outline: outlineViews(state, index, files),
    style: styleViews(state, index, files),
    volumes: volumeViews(state, index, files),
    beats: beatViews(state, index, files),
    opening: openingViews(state, index, files),
    launch: launchViews(state),
    serial: serialViews(state),
    retro: retroViews(state),
  }
  // Every view is filtered here rather than at each construction site: the
  // storage layer writes a heading-only file for an untouched document, and a
  // card must not look openable because its file exists.
  const readable: Record<string, readonly DocumentView[]> = {}
  for (const [id, list] of Object.entries(views)) readable[id] = list.filter(hasContent)
  return readable
}

// ── documents kept whole in one file ─────────────────────────────────────────

/**
 * 竞品拆解 — the research file, or a rendering of the metadata when the file is
 * empty and the dismantles only survive in `.novel/novel.json`.
 */
function competitorViews(
  state: NovelState,
  index: StorageIndex,
  files: ContentFiles,
): readonly DocumentView[] {
  const file = wholeFileView('competitors', '竞品拆解.md', index.competitorFile, files)
  if (file !== undefined && hasContent(file)) return [file]
  if (state.competitors.length === 0) return []
  return [madeView('competitors', '竞品拆解', METADATA_SOURCE, renderCompetitors(state.competitors))]
}

/** 世界观设定 — the world file, or the entries rendered from state. */
function worldViews(
  state: NovelState,
  index: StorageIndex,
  files: ContentFiles,
): readonly DocumentView[] {
  const file = wholeFileView('world', '世界观设定.md', index.worldFile, files)
  if (file !== undefined) return [file]
  const entries = Object.values(state.world)
  if (entries.length === 0) return []
  return [madeView('world', '世界观设定', METADATA_SOURCE, renderWorld(entries))]
}

/** 人物设定 — the cast file, or the characters rendered from state. */
function castViews(
  state: NovelState,
  index: StorageIndex,
  files: ContentFiles,
): readonly DocumentView[] {
  const file = wholeFileView('cast', '人物设定.md', index.castFile, files)
  if (file !== undefined) return [file]
  const characters = Object.values(state.characters)
  if (characters.length === 0) return []
  return [madeView('cast', '人物设定', METADATA_SOURCE, renderCast(characters))]
}

/** 全书大纲 — the whole outline file, or the outline rendered from state. */
function outlineViews(
  state: NovelState,
  index: StorageIndex,
  files: ContentFiles,
): readonly DocumentView[] {
  const file = wholeFileView('outline', '全书大纲.md', index.outlineFile, files)
  if (file !== undefined) return [file]
  const outline = state.outline
  const lines = ['# 全书大纲']
  if (outline.logline.trim() !== '') lines.push('', outline.logline.trim())
  const spine = renderParts(OUTLINE_SPINE_PARTS, outline)
  if (spine !== '') lines.push('', '## 叙事骨架', '', spine)
  if (outline.fullOutline.trim() !== '') lines.push('', '## 完整大纲', '', outline.fullOutline.trim())
  if (outline.minimal.trim() !== '') lines.push('', '## 最小可行大纲', '', outline.minimal.trim())
  if (lines.length === 1) return []
  return [madeView('outline', '全书大纲', METADATA_SOURCE, lines.join('\n'))]
}

// ── documents that are one block of a shared file ────────────────────────────

/** 故事六要素 — the outline's `## 故事六要素` block, or the fields from state. */
function storyViews(
  state: NovelState,
  index: StorageIndex,
  files: ContentFiles,
): readonly DocumentView[] {
  const section = sectionView('story', '故事六要素', index.outlineFile, OUTLINE_SECTIONS.story, files)
  if (section !== undefined) return [section]
  const story = state.outline.story
  const body = renderParts(STORY_ELEMENT_PARTS, story)
  const people = Object.values(state.characters)
    .map((character) => character.name.trim())
    .filter((name) => name !== '')
  if (body === '' && people.length === 0) return []
  const lines = ['# 故事六要素']
  if (body !== '') lines.push('', body)
  // 人物 is one of the six elements but lives in the cast file; showing it here
  // answers the whole question without pretending it is stored in the outline.
  if (people.length > 0) lines.push('', '## 人物', '', ...people.map((name) => `- ${name}`))
  return [madeView('story', '故事六要素', METADATA_SOURCE, lines.join('\n'))]
}

/** 金手指 — the outline's `## 金手指` block, or the cheat fields from state. */
function cheatViews(
  state: NovelState,
  index: StorageIndex,
  files: ContentFiles,
): readonly DocumentView[] {
  const section = sectionView('cheat', '金手指', index.outlineFile, OUTLINE_SECTIONS.cheat, files)
  if (section !== undefined) return [section]
  const cheat = state.outline.cheat
  const body = renderParts(CHEAT_PARTS, cheat)
  if (body === '') return []
  return [madeView('cheat', '金手指', METADATA_SOURCE, `# 金手指\n\n${body}`)]
}

/** 写作风格 — the outline's `## 写作风格` block, or the seven elements from state. */
function styleViews(
  state: NovelState,
  index: StorageIndex,
  files: ContentFiles,
): readonly DocumentView[] {
  const section = sectionView('style', '写作风格', index.outlineFile, OUTLINE_SECTIONS.style, files)
  if (section !== undefined) return [section]
  const body = renderParts(OUTLINE_STYLE_PARTS, state.outline.style)
  if (body === '') return []
  return [madeView('style', '写作风格', METADATA_SOURCE, `# 写作风格\n\n${body}`)]
}

/** 开篇工程清单 — the chapter plan's checklist block, or the checklist from state. */
function openingViews(
  state: NovelState,
  index: StorageIndex,
  files: ContentFiles,
): readonly DocumentView[] {
  const section = sectionView(
    'opening',
    '开篇工程清单',
    index.chapterPlanFile,
    CHAPTER_PLAN_SECTIONS.opening,
    files,
  )
  if (section !== undefined) return [section]
  const checks = state.outline.opening
  if (checks.length === 0) return []
  const lines = checks.map(
    (check) =>
      `- [${check.done ? 'x' : ' '}] ${check.key}`
      + (check.note === '' ? '' : ` — ${check.note}`)
      + (check.requirement === '' ? '' : `（${check.requirement}）`),
  )
  return [madeView('opening', '开篇工程清单', METADATA_SOURCE, `# 开篇工程清单\n\n${lines.join('\n')}`)]
}

// ── documents made of one file per unit ──────────────────────────────────────

/** 分卷大纲 — one view per volume, in reading order. */
function volumeViews(
  state: NovelState,
  index: StorageIndex,
  files: ContentFiles,
): readonly DocumentView[] {
  const views: DocumentView[] = []
  const volumes = [...state.outline.volumes].sort((left, right) => left.number - right.number)
  for (const volume of volumes) {
    const path = index.volumes[String(volume.number)]?.file ?? volumePath(volume.number, index)
    const label = volumeLabel(volume)
    const file = wholeFileView(`volume-${String(volume.number)}`, label, path, files)
    views.push(
      file !== undefined && hasContent(file)
        ? file
        : madeView(`volume-${String(volume.number)}`, label, METADATA_SOURCE, renderVolume(volume)),
    )
  }
  return views.filter(hasContent)
}

/** 爽点节拍表 — one view per chapter-plan file that carries a rhythm table. */
function beatViews(
  state: NovelState,
  index: StorageIndex,
  files: ContentFiles,
): readonly DocumentView[] {
  const views: DocumentView[] = []
  for (const [key, ref] of Object.entries(index.chapterPlans)) {
    const volume = Number(key)
    const label = `${volume > 0 ? `第 ${String(volume)} 卷` : '未分卷'} · 情绪节拍表`
    const section = sectionView(`beats-${key}`, label, ref.file, CHAPTER_PLAN_SECTIONS.beats, files)
    if (section !== undefined) views.push(section)
  }
  if (views.length > 0) return views
  return generatedBeatViews(state)
}

/** Render the beats from state when no chapter-plan file owns them. */
function generatedBeatViews(state: NovelState): readonly DocumentView[] {
  if (state.outline.beats.length === 0) return []
  const volumesOfChapter = new Map<number, number>()
  for (const chapter of Object.values(state.chapters)) volumesOfChapter.set(chapter.number, chapter.volume)
  const byVolume = new Map<number, typeof state.outline.beats>()
  for (const beat of state.outline.beats) {
    const volume = volumesOfChapter.get(beat.chapter) ?? 0
    byVolume.set(volume, [...(byVolume.get(volume) ?? []), beat])
  }
  const views: DocumentView[] = []
  for (const [volume, beats] of [...byVolume.entries()].sort((left, right) => left[0] - right[0])) {
    const label = `${volume > 0 ? `第 ${String(volume)} 卷` : '未分卷'} · 情绪节拍表`
    const rows = [...beats]
      .sort((left, right) => left.chapter - right.chapter)
      .map((beat) => `- 第 ${String(beat.chapter)} 章 · ${beat.kind}${beat.note === '' ? '' : ` — ${beat.note}`}`)
    views.push(madeView(`beats-${String(volume)}`, label, METADATA_SOURCE, `# ${label}\n\n${rows.join('\n')}`))
  }
  return views
}

// ── documents kept in the metadata ledger ─────────────────────────────────────

/** 立意与核心设定 — the pitch, framed by the commercial frame it was written for. */
function pitchViews(state: NovelState): readonly DocumentView[] {
  const pitch = state.pitch
  const written =
    [pitch.memorablePoint, pitch.coreEmotion, pitch.kernel].some((value) => value.trim() !== '')
    || pitch.shuangPoints.length > 0
    || pitch.differentiators.length > 0
  if (!written) return []

  const lines = ['# 立意与核心设定', '']
  lines.push(`- 一句话记忆点：${orTodo(pitch.memorablePoint)}`)
  lines.push(`- 核心情绪：${orTodo(pitch.coreEmotion)}`)
  lines.push(`- 精神内核：${orTodo(pitch.kernel)}`)
  if (pitch.shuangPoints.length > 0) {
    lines.push('', '## 爽点清单', '', ...pitch.shuangPoints.map((point) => `- ${point}`))
  }
  if (pitch.differentiators.length > 0) {
    lines.push('', '## 差异点', '', ...pitch.differentiators.map((point) => `- ${point}`))
  }
  const frame: string[] = []
  if (state.meta.title.trim() !== '') frame.push(`- 书名：${state.meta.title.trim()}`)
  if (state.meta.premise.trim() !== '') frame.push(`- 一句话简介：${state.meta.premise.trim()}`)
  if (state.platform.name.trim() !== '') frame.push(`- 平台：${state.platform.name.trim()}`)
  if (state.platform.readers.trim() !== '') frame.push(`- 目标读者：${state.platform.readers.trim()}`)
  if (state.platform.genres.length > 0) frame.push(`- 品类：${state.platform.genres.join(' / ')}`)
  if (state.writing.targetWords > 0) {
    frame.push(
      `- 篇幅：总 ${String(state.writing.targetWords)} 字`
      + (state.writing.chapterWords > 0 ? ` / 单章 ${String(state.writing.chapterWords)} 字` : '')
      + (state.writing.volumes >= 0 ? ` / ${state.writing.volumes === 0 ? '不分卷' : `${String(state.writing.volumes)} 卷`}` : ''),
    )
  }
  if (frame.length > 0) lines.push('', '## 商业框架', '', ...frame)
  return [madeView('pitch', '立意与核心设定', METADATA_SOURCE, lines.join('\n'))]
}

/** 候选书名 — every title/blurb/tag set under test. */
function namingViews(state: NovelState): readonly DocumentView[] {
  const candidates = state.naming.filter(
    (candidate) => candidate.title.trim() !== '' || candidate.blurb.trim() !== '',
  )
  if (candidates.length === 0) return []
  const lines = ['# 候选书名', '']
  candidates.forEach((candidate, index) => {
    lines.push(`## ${String(index + 1)}. ${orTodo(candidate.title)}${candidate.active ? '（当前发布）' : ''}`, '')
    lines.push(`- 简介：${orTodo(candidate.blurb)}`)
    if (candidate.tags.length > 0) lines.push(`- 标签：${candidate.tags.join(' / ')}`)
    if (candidate.rationale.trim() !== '') lines.push(`- 理由：${candidate.rationale.trim()}`)
    lines.push('')
  })
  return [madeView('naming', '候选书名', METADATA_SOURCE, lines.join('\n'))]
}

/** 去 AI 化诊断 — one review per chapter, newest last, as the ledger keeps them. */
function deAiViews(state: NovelState): readonly DocumentView[] {
  return state.reviews
    .filter((review) => review.kind === 'ai-flavor')
    .map((review) => {
      const chapter = state.chapters[review.target]
      const where =
        chapter === undefined
          ? review.target.trim() === '' ? '全书' : review.target.trim()
          : `第 ${String(chapter.number)} 章${chapter.title.trim() === '' ? '' : ` · ${chapter.title.trim()}`}`
      const label = `${where} · 去 AI 化诊断`
      return madeView(`de-ai-${review.id}`, label, METADATA_SOURCE, renderReview(label, review))
    })
}

/** 上线决策 — one view per recorded go/no-go, newest first. */
function launchViews(state: NovelState): readonly DocumentView[] {
  const decisions = state.launchDecisions
  return decisions
    .map((decision, index) => {
      const round = index + 1
      const label = `第 ${String(round)} 次上线决策 · ${decision.verdict}`
      const lines = [
        `# ${label}`,
        '',
        `- 时间：${decision.at}`,
        `- 结论：${decision.verdict}`,
        decision.fallback.trim() === '' ? '- 回退目标：—' : `- 回退目标：${decision.fallback}`,
        decision.abandonIf.trim() === '' ? '- 放弃条件：—' : `- 放弃条件：${decision.abandonIf}`,
      ]
      if (decision.note.trim() !== '') lines.push('', '## 依据', '', decision.note.trim())
      return madeView(`launch-${decision.id}`, label, METADATA_SOURCE, lines.join('\n'))
    })
    .reverse()
}

/** 连载数据 — readings, iterations and evaluations, one view per record. */
function serialViews(state: NovelState): readonly DocumentView[] {
  return [
    ...state.readings.map((reading) => readingView(reading)),
    ...state.iterations.map((iteration) => iterationView(iteration)),
    ...state.evaluations.map((evaluation) => evaluationView(evaluation)),
  ]
}

/** 完本复盘 — the retrospective, when there is one. */
function retroViews(state: NovelState): readonly DocumentView[] {
  const retro = state.retro
  if (retro === undefined) return []
  const lines = ['# 完本复盘', '']
  if (retro.dataSummary.trim() !== '') lines.push(retro.dataSummary.trim(), '')
  if (retro.highlights.length > 0) {
    lines.push('## 做对了什么', '', ...retro.highlights.map((item) => `- ${item}`), '')
  }
  if (retro.problems.length > 0) {
    lines.push('## 出了什么问题', '', ...retro.problems.map((item) => `- ${item}`), '')
  }
  if (retro.lessons.length > 0) {
    lines.push('## 可复用 / 要避开', '')
    for (const lesson of retro.lessons) {
      lines.push(`- [${lesson.kind === 'reuse' ? '复用' : '避开'}] ${lesson.statement}`)
      if (lesson.evidence.trim() !== '') lines.push(`  - 证据：${lesson.evidence.trim()}`)
      if (lesson.area.trim() !== '') lines.push(`  - 领域：${lesson.area.trim()}`)
    }
    lines.push('')
  }
  if (retro.assets.length > 0) {
    lines.push('## IP 素材', '')
    for (const asset of retro.assets) {
      lines.push(`- ${asset.label}（${asset.kind}）${asset.content}`)
    }
    lines.push('')
  }
  if (retro.templates.length > 0) {
    lines.push('## 可复用模板', '', ...retro.templates.map((template) => `- ${template.name}`), '')
  }
  return [madeView('retro', '完本复盘', METADATA_SOURCE, lines.join('\n').trimEnd())]
}

// ── renderers ─────────────────────────────────────────────────────────────────

/** Render one review with its quotes and fixes, so the modal is the receipt itself. */
function renderReview(label: string, review: ReviewRecord): string {
  const lines = [
    `# ${label}`,
    '',
    `- 时间：${review.at}`,
    `- 模型：${review.provider === '' ? '' : `${review.provider} / `}${review.model}`,
    `- 提示词版本：${review.promptVersion}`,
  ]
  if (review.artifact.trim() !== '') lines.push(`- 完整记录：${review.artifact.trim()}`)
  if (review.summary.trim() !== '') lines.push('', '## 结论', '', review.summary.trim())
  if (review.findings.length > 0) {
    lines.push('', '## 发现')
    review.findings.forEach((finding, index) => {
      lines.push('', `### ${String(index + 1)}. [${finding.dimension}]（${finding.severity}）`)
      if (finding.quote.trim() !== '') lines.push('', `> ${finding.quote.trim()}`)
      if (finding.why.trim() !== '') lines.push('', `为什么：${finding.why.trim()}`)
      if (finding.fix.trim() !== '') lines.push('', `怎么改：${finding.fix.trim()}`)
    })
  }
  return lines.join('\n')
}

/** Render one metric reading as a small table of the values it carries. */
function readingView(reading: MetricReading): DocumentView {
  const label = `平台读数 · ${reading.at}`
  const lines = [
    `# ${label}`,
    '',
    `- 阶段：${reading.period}`,
    `- 章节位置：${reading.atChapter > 0 ? `第 ${String(reading.atChapter)} 章` : '—'}`,
    `- 来源：${reading.source.trim() === '' ? '—' : reading.source.trim()}`,
  ]
  const values = Object.entries(reading.values).filter(
    (entry): entry is [string, number] => entry[1] !== undefined,
  )
  if (values.length > 0) {
    lines.push('', '## 指标', '', '| 指标 | 数值 |', '| --- | --- |')
    for (const [metric, value] of values) lines.push(`| ${metric} | ${String(value)} |`)
  }
  if (reading.note.trim() !== '') lines.push('', '## 观察', '', reading.note.trim())
  return madeView(`reading-${reading.id}`, label, METADATA_SOURCE, lines.join('\n'))
}

/** Render one applied change with the evidence that triggered it. */
function iterationView(iteration: Iteration): DocumentView {
  const label = `迭代记录 · ${iteration.at}`
  const lines = [
    `# ${label}`,
    '',
    `- 触发规则：${iteration.trigger}`,
    `- 范围：${iteration.scope}`,
    `- 基准读数：${iteration.baselineReadingId}`,
    `- 结果读数：${iteration.outcomeReadingId === '' ? '尚未回填' : iteration.outcomeReadingId}`,
    `- 结果：${iteration.outcome}`,
  ]
  if (iteration.evidence.trim() !== '') lines.push('', '## 证据', '', iteration.evidence.trim())
  if (iteration.action.trim() !== '') lines.push('', '## 决定', '', iteration.action.trim())
  if (iteration.note.trim() !== '') lines.push('', '## 备注', '', iteration.note.trim())
  return madeView(`iteration-${iteration.id}`, label, METADATA_SOURCE, lines.join('\n'))
}

/** Render one investment evaluation with its verdict, fallback and next appointment. */
function evaluationView(evaluation: Evaluation): DocumentView {
  const label = `投入评估 · 第 ${String(evaluation.round)} 轮`
  const lines = [
    `# ${label}`,
    '',
    `- 时间：${evaluation.at}`,
    `- 渠道：${evaluation.channel}`,
    `- 样本：${String(evaluation.sampleSize)}`,
    `- 裁决：${evaluation.verdict}`,
    `- 读数：${evaluation.readingId}`,
  ]
  if (evaluation.namingId.trim() !== '') lines.push(`- 被测书名：${evaluation.namingId}`)
  if (evaluation.reasons.length > 0) {
    lines.push('', '## 触发规则', '', ...evaluation.reasons.map((reason) => `- ${reason}`))
  }
  if (evaluation.fallback.trim() !== '') lines.push('', '## 回退目标', '', evaluation.fallback.trim())
  if (evaluation.abandonIf.trim() !== '') lines.push('', '## 放弃条件', '', evaluation.abandonIf.trim())
  const next = [
    evaluation.nextAtChapter > 0 ? `第 ${String(evaluation.nextAtChapter)} 章` : '',
    evaluation.nextTrigger.trim(),
  ].filter((part) => part !== '').join(' · ')
  if (next !== '') lines.push('', '## 下次评估', '', next)
  if (evaluation.note.trim() !== '') lines.push('', '## 备注', '', evaluation.note.trim())
  return madeView(`evaluation-${evaluation.id}`, label, METADATA_SOURCE, lines.join('\n'))
}

/** Render competitors when only the metadata copy survives. */
function renderCompetitors(competitors: readonly Competitor[]): string {
  const lines = ['# 竞品拆解', '']
  for (const competitor of competitors) {
    lines.push(`## ${competitor.title}`, '')
    if (competitor.tags.length > 0) lines.push(`- 标签：${competitor.tags.join(' / ')}`)
    if (competitor.blurb.trim() !== '') lines.push('', competitor.blurb.trim(), '')
    const fields: readonly (readonly [string, string])[] = [
      ['开场事件', competitor.openingEvent],
      ['金手指', competitor.goldenFinger],
      ['主角欲望', competitor.protagonistDesire],
      ['反派动机', competitor.antagonistMotive],
      ['爽点频率', competitor.shuangFrequency],
      ['情绪曲线', competitor.emotionCurve],
      ['付费点', competitor.paywallPoint],
      ['章末钩子', competitor.chapterHooks],
      ['可复用点', competitor.takeaway],
    ]
    for (const [label, value] of fields) if (value.trim() !== '') lines.push(`- ${label}：${value.trim()}`)
    if (competitor.commentKeywords.length > 0) {
      lines.push(`- 评论高频词：${competitor.commentKeywords.join(' / ')}`)
    }
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

/** Render world entries when only the metadata copy survives. */
function renderWorld(entries: readonly WorldEntry[]): string {
  const lines = ['# 世界观设定', '']
  for (const entry of entries) {
    lines.push(`## ${entry.name}`, '')
    lines.push(`- 类型：${entry.kind}`)
    if (entry.level > 0) lines.push(`- 层级：${String(entry.level)}`)
    if (entry.volume > 0) lines.push(`- 首次可用卷：第 ${String(entry.volume)} 卷`)
    if (entry.parent.trim() !== '') lines.push(`- 上级：${entry.parent.trim()}`)
    if (entry.relations.trim() !== '') lines.push(`- 关系：${entry.relations.trim()}`)
    if (entry.detail.trim() !== '') lines.push('', entry.detail.trim(), '')
    if (entry.cost.trim() !== '') lines.push(`- 代价：${entry.cost.trim()}`)
    if (entry.limits.trim() !== '') lines.push(`- 限制：${entry.limits.trim()}`)
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

/** Render characters when only the metadata copy survives. */
function renderCast(characters: readonly Character[]): string {
  const lines = ['# 人物设定', '']
  for (const character of characters) {
    lines.push(`## ${character.name}`, '')
    if (character.role.trim() !== '') lines.push(`- 角色：${character.role.trim()}`)
    if (character.scope.trim() !== '') lines.push(`- 档位：${character.scope.trim()}`)
    if (character.volume > 0) lines.push(`- 所属卷：第 ${String(character.volume)} 卷`)
    if (character.firstAppearance.trim() !== '') lines.push(`- 首次出场：${character.firstAppearance.trim()}`)
    if (character.goal.trim() !== '') lines.push(`- 欲望：${character.goal.trim()}`)
    if (character.personality.trim() !== '') lines.push(`- 性格：${character.personality.trim()}`)
    if (character.voice.trim() !== '') lines.push(`- 说话方式：${character.voice.trim()}`)
    if (character.fear.trim() !== '') lines.push(`- 恐惧：${character.fear.trim()}`)
    if (character.obsession.trim() !== '') lines.push(`- 执念：${character.obsession.trim()}`)
    if (character.weakness.trim() !== '') lines.push(`- 软肋：${character.weakness.trim()}`)
    if (character.growthArc.trim() !== '') lines.push(`- 成长线：${character.growthArc.trim()}`)
    if (character.description.trim() !== '') lines.push('', character.description.trim())
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

/** Render one volume when its file does not exist. */
function renderVolume(volume: VolumePlan): string {
  const lines = [`# ${volumeLabel(volume)}`]
  if (volume.detail.trim() !== '') lines.push('', `## ${VOLUME_DETAIL_HEADING}`, '', volume.detail.trim())
  const spine = renderParts(VOLUME_SPINE_PARTS, volume)
  if (spine !== '') lines.push('', spine)
  const scalars: readonly (readonly [string, string])[] = [
    ['本卷目标', volume.goal],
    ['核心矛盾', volume.conflict],
    ['阶段性高潮', volume.climax],
    ['卷末钩子', volume.endHook],
  ]
  for (const [heading, value] of scalars) {
    if (value.trim() !== '') lines.push('', `## ${heading}`, '', value.trim())
  }
  return lines.join('\n')
}

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * One view of a whole file.
 *
 * Absence and emptiness are different outcomes: a missing file yields nothing,
 * while a file that exists only as frontmatter and headings fails
 * {@link hasContent} and is treated as having nothing to read.
 */
function wholeFileView(
  id: string,
  label: string,
  path: string,
  files: ContentFiles,
): DocumentView | undefined {
  const raw = files[path]
  if (raw === undefined) return undefined
  return madeView(id, label, path, raw)
}

/** One view of a `##` block inside a file. */
function sectionView(
  id: string,
  label: string,
  path: string,
  heading: string,
  files: ContentFiles,
): DocumentView | undefined {
  const raw = files[path]
  if (raw === undefined) return undefined
  const section = findSection(splitDocument(splitFrontmatter(raw).body).sections, heading)
  if (section === undefined) return undefined
  const content = section.body.trim() === '' ? '' : `## ${section.title}\n\n${section.body.trim()}`
  return madeView(id, label, `${path} · ${heading}`, content)
}

/** Assemble a view; emptiness is filtered once, by {@link documentViewsOf}. */
function madeView(id: string, label: string, source: string, content: string): DocumentView {
  return { id, label, source, content: content.trim() }
}

/** Whether a document should be filtered out for having no readable text. */
function hasContent(view: DocumentView): boolean {
  if (view.content === '') return false
  // A freshly initialized project writes every content file with its headings
  // and no bodies. Headings alone are a table of contents, not the document, so
  // they do not make a card worth opening.
  const body = splitFrontmatter(view.content).body
  const stripped = body
    .replace(/^#{1,6}[ \t]+.*$/gmu, '')
    .replace(/^[ \t]*[-*+][ \t]+(\[[ xX]\][ \t]+)?/gmu, '')
    .replace(/^[ \t]*\d+\.[ \t]+/gmu, '')
    .replace(/^[ \t|:-]+$/gmu, '')
    .trim()
  return stripped !== ''
}

/**
 * Render an ordered list of spine parts.
 *
 * @param parts - field/heading pairs, in report order.
 * @param values - the object holding each field's text.
 * @returns the `##` blocks that have text, joined; `''` when none do.
 */
function renderParts<Field extends string>(
  parts: readonly { readonly field: Field; readonly heading: string }[],
  values: Readonly<Record<Field, string>>,
): string {
  return parts
    .filter((part) => values[part.field].trim() !== '')
    .map((part) => `## ${part.heading}\n\n${values[part.field].trim()}`)
    .join('\n\n')
}

/** The title a volume is listed under. */
function volumeLabel(volume: VolumePlan): string {
  const title = volume.title.trim()
  return title === '' ? `第 ${String(volume.number)} 卷` : `第 ${String(volume.number)} 卷 · ${title}`
}

/** A field's text, or the marker that says it has not been written. */
function orTodo(value: string): string {
  return value.trim() === '' ? '（未写）' : value.trim()
}
