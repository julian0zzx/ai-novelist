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
 * @module @ai-webnovel/composer-host/core/repo
 */

import { progressOf } from './novel.ts'
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
  const rounds = state.verifications.length
  const passed = state.verifications.filter((round) => round.verdict === 'pass').length
  const iterations = state.iterations.length
  const ineffective = state.iterations.filter((iteration) => iteration.outcome === 'ineffective').length
  return [
    `共 ${String(progress.chapters)} 章（已写 ${String(written)} 章，${String(progress.totalWords)} 字）`,
    `验证 ${String(rounds)} 轮（通过 ${String(passed)} 轮）`,
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
