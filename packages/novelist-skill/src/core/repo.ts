/**
 * Pure retrospective assembly: turn a finished novel into reusable material.
 *
 * The SOP's last phase is the one most often skipped, because it produces
 * nothing for the current book. Its output is the *next* book's head start, so
 * the functions here extract the parts that transfer — structure, rhythm, beat
 * pattern, hook patterns, emotional template — and deliberately leave the cast
 * and the proper nouns behind, which is how the SOP's "不要直接复用人设，做变体
 * 升级" becomes a property of the artifact instead of a reminder.
 *
 * @module @ai-novelist/novelist-skill/core/repo
 */

import { progressOf } from './novel.ts'
import { proofread } from './proofread.ts'
import { missingContract } from './plan.ts'
import type {
  Chapter,
  IpAsset,
  Lesson,
  NovelState,
  Outline,
  ReusableTemplate,
  Retrospective,
} from './types.ts'

/** What a template export refuses to carry, stated in the artifact itself. */
const TEMPLATE_EXCLUSION =
  '本模板只含结构骨架：不含人名、地名、门派名与专有设定。使用时须做变体升级，不得直接套用上一本的人设。'

/**
 * Build a reusable structural template from a novel.
 *
 * Beat positions are converted to **offsets within a volume** so the template is
 * independent of how long the source book happened to be.
 *
 * @param state - the finished (or abandoned) novel.
 * @param now - timestamp for `exportedAt`.
 * @returns the template.
 */
export function buildTemplate(state: NovelState, now: () => string): ReusableTemplate {
  const volumeLength = estimateVolumeLength(state.outline)
  return {
    name: `${state.meta.title || 'untitled'} 结构模板`,
    exportedAt: now(),
    acts: [...state.outline.acts],
    volumeRhythm: state.outline.volumes.map(
      (volume) =>
        `第 ${String(volume.number)} 卷：目标=${volume.goal || '—'}；矛盾=${volume.conflict || '—'}；高潮=${volume.climax || '—'}；卷末钩子=${volume.endHook || '—'}`,
    ),
    beatPattern: state.outline.beats.map((beat) => {
      const offset = volumeLength > 0 ? ((beat.chapter - 1) % volumeLength) + 1 : beat.chapter
      return `卷内第 ${String(offset)} 章：${beat.kind}${beat.note === '' ? '' : `（${beat.note}）`}`
    }),
    hookPatterns: collectHookPatterns(state),
    emotionTemplate: state.pitch.coreEmotion,
    note: TEMPLATE_EXCLUSION,
  }
}

/**
 * Estimate chapters per volume from the outline's chapter ranges.
 *
 * @param outline - the outline.
 * @returns the median volume length, or 0 when nothing is known.
 */
export function estimateVolumeLength(outline: Outline): number {
  const lengths = outline.volumes
    .map((volume) => (volume.chapters.length >= 2 ? (volume.chapters.at(-1) ?? 0) - (volume.chapters[0] ?? 0) + 1 : 0))
    .filter((length) => length > 0)
  if (lengths.length > 0) {
    lengths.sort((a, b) => a - b)
    return lengths[Math.floor(lengths.length / 2)] ?? 0
  }
  // Fall back to the plan's own chapter count divided by its volume count.
  return 0
}

/**
 * Collect the hook patterns that recur across the written chapters.
 *
 * A hook pattern is the *shape* of the chapter-end promise (a question, a
 * reversal, a new arrival), which is what transfers to the next book; the
 * specific hook text does not.
 *
 * @param state - the novel.
 * @returns up to six recurring shapes, with counts.
 */
export function collectHookPatterns(state: NovelState): string[] {
  const chapters = Object.values(state.chapters).filter((chapter) => chapter.hook.trim() !== '')
  const shapes = new Map<string, number>()
  for (const chapter of chapters) {
    const shape = classifyHook(chapter.hook)
    shapes.set(shape, (shapes.get(shape) ?? 0) + 1)
  }
  return [...shapes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([shape, count]) => `${shape}（${String(count)} 次）`)
}

/**
 * Classify one hook into a transferable shape by its cue words.
 *
 * @param hook - the hook text.
 * @returns the shape label.
 */
export function classifyHook(hook: string): string {
  if (/[？?]|为何|难道|究竟/u.test(hook)) return '疑问式钩子'
  if (/突然|忽然|却|竟|反手|逆转/u.test(hook)) return '反转式钩子'
  if (/出现|来了|抵达|走入|登场/u.test(hook)) return '新元素登场'
  if (/死|杀|碎|崩|爆/u.test(hook)) return '危机式钩子'
  if (/原来|真相|秘密|身世/u.test(hook)) return '揭秘式钩子'
  if (/决定|必须|只剩|来不及/u.test(hook)) return '抉择式钩子'
  return '其他'
}

/**
 * Extract IP-ready assets from the novel's own data.
 *
 * The assets come from the records the project already holds plus the chapter
 * hooks, so a retrospective does not require re-reading the manuscript.
 *
 * @param state - the novel.
 * @returns the assets, cast first, then world, then scenes and quotes.
 */
export function extractAssets(state: NovelState): IpAsset[] {
  const assets: IpAsset[] = []
  for (const character of Object.values(state.characters)) {
    assets.push({
      id: `character-${character.id}`,
      kind: 'character',
      label: `${character.name}（${character.role || '角色'}）`,
      content: [character.description, character.goal === '' ? '' : `欲望：${character.goal}`, character.obsession === '' ? '' : `执念：${character.obsession}`, character.weakness === '' ? '' : `软肋：${character.weakness}`]
        .filter((part) => part !== '')
        .join('；'),
      source: 'cast',
    })
  }
  for (const entry of Object.values(state.world)) {
    assets.push({
      id: `setting-${entry.id}`,
      kind: 'setting',
      label: `${entry.name}（${entry.kind}）`,
      content: [entry.detail, entry.cost === '' ? '' : `代价：${entry.cost}`, entry.limits === '' ? '' : `限制：${entry.limits}`]
        .filter((part) => part !== '')
        .join('；'),
      source: 'world',
    })
  }
  for (const link of Object.values(state.links)) {
    assets.push({
      id: `link-${link.id}`,
      kind: 'link',
      label: `伏笔：${link.note.slice(0, 24)}`,
      content: `埋于 ${link.plantedAt || '—'}，回收于 ${link.dueAt || '—'}：${link.payoff}（${link.status}）`,
      source: 'links',
    })
  }
  for (const chapter of Object.values(state.chapters).filter((entry) => entry.hook.trim() !== '')) {
    assets.push({
      id: `scene-${chapter.id}`,
      kind: 'scene',
      label: `第 ${String(chapter.number)} 章钩子`,
      content: chapter.hook,
      source: `chapter-${String(chapter.number)}`,
    })
  }
  return assets
}

/**
 * Derive the data summary a retrospective opens with.
 *
 * @param state - the novel.
 * @returns counts and totals in one sentence.
 */
export function summarizeCompletion(state: NovelState): string {
  const progress = progressOf(state)
  const written = progress.chapters - progress.emptyChapters.length
  const evaluations = state.evaluations.length
  const cuts = state.evaluations.filter((round) => round.verdict === 'fail').length
  const decisions = state.launchDecisions.length
  const iterations = state.iterations.length
  const ineffective = state.iterations.filter((iteration) => iteration.outcome === 'ineffective').length
  return [
    `共 ${String(progress.chapters)} 章（已写 ${String(written)} 章，${String(progress.totalWords)} 字）`,
    `上线决策 ${String(decisions)} 次`,
    `投入评估 ${String(evaluations)} 次（其中判定切书 ${String(cuts)} 次）`,
    `迭代 ${String(iterations)} 次（其中 ${String(ineffective)} 次判定无效）`,
    `未回收伏笔 ${String(progress.openLinks.length)} 条`,
  ].join('；')
}

/**
 * Assemble a complete retrospective.
 *
 * @param state - the novel.
 * @param input - the author's own material.
 * @param now - timestamp for `at`.
 * @returns the retrospective, with derived material filled in.
 */
export function buildRetrospective(
  state: NovelState,
  input: {
    readonly dataSummary?: string | undefined
    readonly highlights?: readonly string[] | undefined
    readonly problems?: readonly string[] | undefined
    readonly lessons?: readonly Lesson[] | undefined
  },
  now: () => string,
): Retrospective {
  const summary = input.dataSummary ?? summarizeCompletion(state)
  return {
    at: now(),
    dataSummary: summary,
    highlights: [...(input.highlights ?? [])],
    problems: [...(input.problems ?? [])],
    lessons: [...(input.lessons ?? [])],
    assets: extractAssets(state),
    templates: [buildTemplate(state, now)],
  }
}

/**
 * The lessons an author most often needs to record, as prompts.
 *
 * Offered rather than generated: the tool does not know whether the opening
 * worked, and a fabricated lesson is worse than an empty field.
 *
 * @returns prompt lines for the retrospective.
 */
export function lessonPrompts(): string[] {
  return [
    '开篇（前 3 章）实际留住了哪类读者，靠的是哪一句/哪个事件？',
    '哪一个爽点频率被证明是对的，哪一个过密或过疏？',
    '哪条伏笔埋了却没回收，原因是什么？',
    '哪一卷节奏塌了，塌在什么地方？',
    '这本书里最值得抄进下一本的结构是什么（不含人设）？',
    '哪一类题材/平台错配让你白花了力气？',
  ]
}

/** A chapter with prose, for scene extraction. */
export type WrittenChapter = Chapter

/**
 * Build the submission package: the material a platform's editor actually asks
 * for, assembled from what the project already holds.
 *
 * It deliberately does **not** write the blurb or the one-line pitch. Those are
 * authorial prose, and a tool that invents them produces exactly the confident
 * garbage this project exists to avoid: it assembles the facts (length, tags,
 * the three opening chapters, the promises each one makes) and leaves the
 * sentences to the author, with a slot for each.
 *
 * @param state - the project to package.
 * @param now - timestamp for the header.
 * @returns the Markdown document.
 */
export function buildSubmissionPackage(state: NovelState, now: () => string): string {
  const active = state.naming.find((candidate) => candidate.active) ?? state.naming[0]
  const title = active?.title || state.meta.title || '（未定书名）'
  const progress = progressOf(state)
  const chapters = Object.values(state.chapters).sort((left, right) => left.number - right.number)
  const opening = chapters.slice(0, 3)
  const written = chapters.filter((chapter) => chapter.body.trim() !== '')
  const tags = (active?.tags.length ?? 0) > 0 ? active?.tags.join('、') : state.platform.genres.join('、')
  const target = state.writing.targetWords > 0 ? `${String(state.writing.targetWords)} 字` : '（未定）'
  const chapterTarget = state.writing.chapterWords > 0 ? `${String(state.writing.chapterWords)} 字` : '（未定）'
  const modeLabel = state.platform.mode === 'paid' ? '付费' : state.platform.mode === 'free' ? '免费' : '（未填）'
  const audienceLabel =
    state.platform.audience === 'male' ? '男频' : state.platform.audience === 'female' ? '女频' : '通用'

  const lines: string[] = [
    `# 《${title}》投稿包`,
    '',
    `> 生成于 ${now()}；由项目数据自动汇编，不代写简介与卖点。改成你自己的话再投。`,
    '',
    '## 一、作品信息',
    '',
    `- 书名：${title}`,
    `- 平台：${state.platform.name || '（未填）'}`,
    `- 模式：${modeLabel}｜频道：${audienceLabel}`,
    `- 题材：${state.platform.genres.join('、') || '（未填）'}`,
    `- 目标读者：${state.platform.readers || '（未填）'}`,
    `- 篇幅：目标 ${target}｜单章 ${chapterTarget}｜已写 ${String(written.length)} 章 / ${String(progress.totalWords)} 字`,
    `- 标签：${tags || '（未记录）'}`,
    '',
    '## 二、简介',
    '',
    '### 一句话版（30 字内）',
    '',
    '（作者写：身份 + 困境 + 他决定做什么。生成器不代写。）',
    '',
    '### 一段版（100–150 字）',
    '',
    active?.blurb.trim() === '' || active === undefined
      ? '（还没有候选简介：`novel_plan operation="naming"` 先准备 3–5 组书名/简介/标签。）'
      : active.blurb,
    '',
    `> 候选卖点：${state.pitch.memorablePoint || '（未写）'}`,
    '',
    '### 三章版素材（由前三章细纲汇编，需改写成简介）',
    '',
  ]

  if (opening.length === 0) {
    lines.push('（还没有章节细纲。）')
  } else {
    for (const chapter of opening) {
      lines.push(
        `- 第 ${String(chapter.number)} 章「${chapter.title || '—'}」：${chapter.plotTask || '（细纲未写）'}`,
        `  - 章末钩：${chapter.hook || '（未写）'}`,
      )
    }
  }

  lines.push(
    '',
    '## 三、前三章体检',
    '',
    '| 章 | 标题 | 字数 | 章末钩 | 细纲完整 |',
    '|---|---|---|---|---|',
  )
  for (const chapter of opening) {
    const missing = missingContract(chapter)
    lines.push(
      `| ${String(chapter.number)} | ${chapter.title || '—'} | ${String(chapter.wordCount)} | `
      + `${chapter.hook.trim() === '' ? '❌ 缺' : '✅'} | ${missing.length === 0 ? '✅' : `❌ 缺 ${missing.join('/')}`} |`,
    )
  }
  if (opening.length === 0) lines.push('| — | — | — | — | — |')

  const noHook = written.filter((chapter) => chapter.hook.trim() === '').length
  const short = state.writing.chapterWords > 0
    ? written.filter((chapter) => chapter.wordCount < state.writing.chapterWords * 0.85).length
    : 0
  // A deterministic 校对 pass over everything with prose. It reports what it found
  // and never says "clean": the rules cover fixed spellings only, and a clean scan
  // is not a proofread — the sensitive-content check stays in the checklist above
  // and in the author's own reading.
  const typos = new Map<string, { right: string; count: number; chapters: number[] }>()
  const punctuation = new Map<string, number>()
  for (const chapter of written) {
    const result = proofread(chapter.body)
    for (const hit of result.typos) {
      const entry = typos.get(hit.wrong) ?? { right: hit.right, count: 0, chapters: [] }
      entry.count += hit.count
      entry.chapters.push(chapter.number)
      typos.set(hit.wrong, entry)
    }
    for (const hit of result.punctuation) {
      punctuation.set(hit.label, (punctuation.get(hit.label) ?? 0) + hit.count)
    }
  }
  const typoTotal = [...typos.values()].reduce((sum, entry) => sum + entry.count, 0)
  const punctuationTotal = [...punctuation.values()].reduce((sum, count) => sum + count, 0)
  const proofreadLines: string[] = []
  if (written.length === 0) {
    proofreadLines.push('- 还没有正文可校对')
  } else if (typoTotal === 0 && punctuationTotal === 0) {
    proofreadLines.push(
      `- 全稿 ${String(written.length)} 章：未命中固定词形错别字与标点异常——`
      + '规则只覆盖确定性词形，不等于通读通过',
    )
  } else {
    proofreadLines.push(
      `- 全稿 ${String(written.length)} 章：疑似错别字 ${String(typoTotal)} 处，标点异常 ${String(punctuationTotal)} 处`,
    )
    for (const [wrong, entry] of [...typos.entries()].slice(0, 6)) {
      const where = [...new Set(entry.chapters)].slice(0, 4).map((number) => `第 ${String(number)} 章`).join('、')
      proofreadLines.push(`- 「${wrong}」→「${entry.right}」×${String(entry.count)}（${where}）`)
    }
    if (punctuation.size > 0) {
      proofreadLines.push(
        `- 标点：${[...punctuation.entries()].map(([label, count]) => `${label}×${String(count)}`).join('；')}`,
      )
    }
  }

  lines.push(
    '',
    '## 四、投稿前自查',
    '',
    `- [ ] 字数达到平台当期门槛（当前 ${String(progress.totalWords)} 字；以官方公告为准）`,
    '- [ ] 更新节奏稳定，断更风险已评估',
    `- [ ] 前三章每章都有章末钩（有正文但无钩 ${String(noHook)} 章）`,
    `- [ ] 单章长度贴近目标（低于目标 85% 的有 ${String(short)} 章）`,
    '- [ ] 书名含题材词 + 身份/能力 + 冲突/爽点',
    '- [ ] 简介三版都能独立成立，最后一句是钩子不是总结',
    '- [ ] 标签 3–5 个，与内容一致，不互相矛盾',
    '- [ ] 敏感内容按平台后台/当期规范自查（色情、暴力、政治、宗教、未成年、现实人物、侵权）',
    '- [ ] 错别字：的地得 / 在再 / 做作 / 账帐 / 即既',
    '- [ ] 投稿材料齐全（表单/邮件要求的文件、字数统计、联系方式）',
    '',
    '> 自查表来自 `docs/craft/submission.md`；工具只汇总状态，不替你判断内容是否合规。',
    '',
    '## 五、自动校对（确定性规则，可整批替换）',
    '',
    ...proofreadLines,
    '',
    '## 六、投稿记录',
    '',
    '| 日期 | 平台 | 字数 | 结果 | 拒因/反馈（照抄原话） | 下一步 |',
    '|---|---|---|---|---|---|',
    '| | | | | | |',
    '',
    '## 七、下一步',
    '',
    '- 按 `novel_status detail="craft" topic="submission"` 逐项过一遍；',
    '- 前三章问题用 `novel_review operation="opening"` 复查；',
    '- 被拒先看题材/字数/开篇，不要先改文笔。',
    '',
  )
  return lines.join('\n')
}
