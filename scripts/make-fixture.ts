/**
 * Write a realistic schema-3 novel project, for looking at the board by hand.
 *
 * The Kanban view reads a project through the same core codec the host writes
 * with, so a fixture that is not what the store would have written is a fixture
 * that tests nothing. This script therefore goes through those exact functions:
 * `decomposeContent` renders the Markdown, `hashContent` fills the index, and
 * `metadataOf` builds the document. Only `novel.json` and the content files are
 * produced — no `reviews/`, no session log — because those are the two things
 * the panel reads.
 *
 * Usage: node --experimental-strip-types scripts/make-fixture.ts <target-directory>
 *
 * @module scripts/make-fixture
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { decomposeContent } from '../packages/ai-webnovel-composer-host/src/core/content.ts'
import { hashContent } from '../packages/ai-webnovel-composer-host/src/core/markdown.ts'
import { emptyNovel, serializeMetadata } from '../packages/ai-webnovel-composer-host/src/core/novel.ts'
import { DEFAULT_STORAGE_LAYOUT, chapterPaths } from '../packages/ai-webnovel-composer-host/src/core/paths.ts'
import { metadataOf } from '../packages/ai-webnovel-composer-host/src/core/novel.ts'
import type { Chapter, ChapterStatus, NovelState, StoryLink } from '../packages/ai-webnovel-composer-host/src/core/types.ts'

/** Chapters to place: number, title, status, prose length, and contract answers. */
const CHAPTERS: readonly {
  readonly number: number
  readonly title: string
  readonly volume: number
  readonly status: ChapterStatus
  readonly words: number
  readonly beats: readonly Chapter['beats'][number][]
  readonly target: number
  readonly partial?: boolean
}[] = [
  { number: 1, title: '雨夜里的第七码头', volume: 1, status: 'final', words: 2600, target: 2800, beats: ['shuang', 'turn'] },
  { number: 2, title: '赊来的半张船票', volume: 1, status: 'final', words: 2450, target: 2800, beats: ['info', 'tension'] },
  { number: 3, title: '潮汐塔的第一课', volume: 1, status: 'revised', words: 2700, target: 2800, beats: ['sweet', 'info'] },
  { number: 4, title: '沉船名单上的名字', volume: 1, status: 'revised', words: 2510, target: 2800, beats: ['turn'] },
  { number: 5, title: '不该亮起的航标', volume: 1, status: 'drafting', words: 1800, target: 2800, beats: ['tension', 'burn'] },
  { number: 6, title: '第二位引潮人', volume: 1, status: 'drafting', words: 940, target: 2800, beats: ['shuang'] },
  { number: 7, title: '退潮之后的账本', volume: 1, status: 'planned', words: 0, target: 2800, beats: ['info'] },
  { number: 8, title: '旧锚链下的回声', volume: 1, status: 'planned', words: 0, target: 2800, beats: ['tension', 'turn'], partial: true },
  { number: 9, title: '借来的十分钟', volume: 1, status: 'planned', words: 0, target: 2800, beats: [], partial: true },
]

/**
 * Prose of roughly the requested length, so the board's counters differ.
 *
 * @param words - how many characters to produce.
 * @returns the prose.
 */
function prose(words: number): string {
  const sentence = '潮水漫过第七码头的石阶时，阿沅听见锚链在深处叹了一口气。她把那半张船票按进掌心，纸角硌得生疼。'
  if (words === 0) return ''
  return sentence.repeat(Math.ceil(words / sentence.length)).slice(0, words)
}

/**
 * Build the fixture state.
 *
 * @returns a state with chapters in every column, an open promise, and a cast.
 */
function fixture(): NovelState {
  const base = emptyNovel({ title: '引潮人', premise: '被潮汐钟选中的少女，靠借来的时间在沉没的港口里找回母亲的名字。' })
  const chapters: Record<string, Chapter> = {}
  for (const entry of CHAPTERS) {
    const id = `ch-${String(entry.number).padStart(3, '0')}`
    const body = prose(entry.words)
    chapters[id] = {
      id,
      number: entry.number,
      title: entry.title,
      synopsis: `第${String(entry.number)}章：${entry.title}。`,
      status: entry.status,
      body,
      wordCount: body.length,
      updatedAt: '2026-02-0' + String(Math.min(9, entry.number)) + 'T10:00:00.000Z',
      volume: entry.volume,
      plotTask: entry.partial === true ? '' : '推进主线：拿到下一段航线的许可。',
      conflict: entry.partial === true ? '' : '引潮人议会的沉默与主角的急迫相撞。',
      emotionalPayoff: entry.partial === true ? '' : '读者获得一次小而确定的胜利。',
      infoGap: entry.partial === true ? '' : '母亲的名字为什么被从沉船名单上抹掉。',
      beats: entry.beats,
      hook: entry.partial === true && entry.number === 9 ? '' : '章末：航标亮起，指向不该存在的第八码头。',
      targetWords: entry.target,
      waived: {},
      delivered: entry.status === 'final' ? ['plotTask', 'conflict'] : [],
    }
  }

  const links: Record<string, StoryLink> = {
    'mother-name': {
      id: 'mother-name',
      note: '母亲的名字被从沉船名单上抹掉',
      kind: 'mystery',
      plantedAt: '1',
      dueAt: '12',
      payoff: '在旧锚链下找到被凿去的铜牌',
      status: 'open',
      volume: 1,
    },
    'borrowed-time': {
      id: 'borrowed-time',
      note: '引潮人借来的时间以记忆偿付',
      kind: 'foreshadow',
      plantedAt: '3',
      dueAt: '5',
      payoff: '代价在第五码头第一次显形',
      status: 'open',
      volume: 1,
    },
  }

  return {
    ...base,
    meta: { ...base.meta, title: '引潮人', premise: base.meta.premise, genres: ['奇幻', '悬疑', '治愈'], pov: 'third-limited', language: 'zh-CN' },
    platform: { ...base.platform, name: 'qidian', mode: 'paid', audience: 'general', genres: ['奇幻'], readers: '喜欢慢热悬疑与海港氛围的读者', monetization: '订阅 + 全勤' },
    pitch: {
      ...base.pitch,
      memorablePoint: '一个只能借时间的少女，在每天沉没一次的港口里，用记忆赎回母亲的名字。',
      coreEmotion: '被夺走的东西，可以一点点换回来。',
      shuangPoints: ['以小博大', '层层揭开的旧案'],
      differentiators: ['潮汐作为时间货币', '港口会每天沉没一次'],
      kernel: '记忆就是一个人真正的家乡。',
    },
    naming: [
      { id: 'n1', title: '引潮人', blurb: '潮水退去时，她开始计时。', tags: ['奇幻', '悬疑'], rationale: '意象与题材同源', active: true },
      { id: 'n2', title: '第七码头的潮汐钟', blurb: '每一次涨潮，都要有人偿债。', tags: ['奇幻'], rationale: '地名钩子更强', active: false },
    ],
    competitors: Array.from({ length: 20 }, (_, index) => ({
      id: `comp-${String(index + 1)}`,
      title: `同类作品 ${String(index + 1)}`,
      tags: ['奇幻'],
      blurb: '一句话简介',
      openingEvent: '开场事件',
      goldenFinger: '金手指',
      protagonistDesire: '主角欲望',
      antagonistMotive: '对手动机',
      shuangFrequency: '每3章',
      emotionCurve: '低开高走',
      paywallPoint: '第12章',
      chapterHooks: '悬念式',
      commentKeywords: ['节奏', '设定'],
      takeaway: '可复用的开篇结构',
    })),
    characters: {
      ayuan: { id: 'ayuan', name: '阿沅', role: 'protagonist', description: '十七岁，引潮学徒', goal: '找回母亲的名字', fear: '忘记母亲的脸', obsession: '每天去第七码头等退潮', weakness: '不肯借别人的时间', camp: 'protagonist-camp', growthArc: '从惜时到敢于偿债', notes: '' },
      yan: { id: 'yan', name: '砚叔', role: 'mentor', description: '老引潮人，左手是铜的', goal: '守住潮汐钟', fear: '钟停', obsession: '记账', weakness: '旧伤', camp: 'neutral', growthArc: '从隐瞒到交底', notes: '' },
    },
    world: {
      'tide-clock': { id: 'tide-clock', kind: 'rule', name: '潮汐钟', detail: '每一次涨潮，港口结算一次时间。', cost: '借来的时间以记忆偿付', limits: '不能借未来，只能借已经过去的' },
      'seventh-pier': { id: 'seventh-pier', kind: 'place', name: '第七码头', detail: '沉船名单的公示处。', cost: '', limits: '' },
    },
    links,
    writing: { ...base.writing, language: 'zh-CN', pov: 'third-limited', volumes: 3, totalChapters: 120, targetWords: 300000, chapterPlanWindow: 10, openingGateChapters: [3, 10], stockTargetChapters: 5, chapterPlanCeiling: 20, updateRhythm: 'daily-2' },
    outline: {
      ...base.outline,
      logline: '一个只能借时间的少女，在每天沉没一次的港口里赎回母亲的名字。',
      acts: ['第一幕：赊账', '第二幕：偿债', '第三幕：改账'],
      minimal: '她借时间 → 代价显形 → 她选择偿债。',
      volumes: [
        { number: 1, title: '赊来的潮水', goal: '立住规则与人物', conflict: '议会沉默', climax: '航标亮起', endHook: '第八码头的名字', chapters: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
      ],
      beats: [
        { chapter: 1, kind: 'shuang', note: '开局小胜' },
        { chapter: 5, kind: 'burn', note: '代价显形' },
        { chapter: 8, kind: 'turn', note: '旧锚链下的线索' },
      ],
      fullOutlineDone: true,
    },
    readings: [
      { id: 'r1', at: '2026-02-05T10:00:00.000Z', period: 'new-book', atChapter: 3, values: { clickRate: 8.2, readThrough3: 46 }, source: '平台后台', note: '' },
    ],
    verifications: [
      { id: 'v1', round: 1, at: '2026-02-06T10:00:00.000Z', channel: 'readers', sampleSize: 20, readingId: 'r1', namingId: 'n1', verdict: 'pass', reasons: ['一句话能复述'], fallback: '' },
    ],
    chapters,
  }
}

/**
 * Write the project under a target directory.
 *
 * @param root - absolute directory to write into.
 */
async function main(root: string): Promise<void> {
  const state = fixture()
  const at = '2026-02-09T10:00:00.000Z'
  const parts = decomposeContent(state, at)
  const layout = DEFAULT_STORAGE_LAYOUT

  const files: Record<string, string> = {
    [layout.outlineFile]: parts.outline,
    [layout.castFile]: parts.cast,
    [layout.worldFile]: parts.world,
    [layout.volumeFile]: parts.volumes,
    [layout.chapterPlanFile]: parts.chapterPlan,
  }

  const chapters: Record<string, { number: number; title: string; bodyFile: string; outlineFile: string; bodyHash: string; outlineHash: string }> = {}
  for (const chapter of Object.values(state.chapters)) {
    const rendered = parts.chapters[chapter.id]
    if (rendered === undefined) continue
    const paths = chapterPaths(chapter.number, chapter.title, layout)
    files[paths.bodyFile] = rendered.body
    files[paths.outlineFile] = rendered.outline
    chapters[chapter.id] = {
      number: chapter.number,
      title: chapter.title,
      bodyFile: paths.bodyFile,
      outlineFile: paths.outlineFile,
      bodyHash: hashContent(rendered.body),
      outlineHash: hashContent(rendered.outline),
    }
  }

  const hashes: Record<string, string> = {}
  for (const [path, text] of Object.entries(files)) hashes[path] = hashContent(text)

  const index = {
    outlineFile: layout.outlineFile,
    castFile: layout.castFile,
    worldFile: layout.worldFile,
    volumeFile: layout.volumeFile,
    chapterPlanFile: layout.chapterPlanFile,
    chapters,
    files: hashes,
  }

  await mkdir(join(root, '.novel'), { recursive: true })
  for (const [path, text] of Object.entries(files)) {
    const target = join(root, '.novel', path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, text, 'utf8')
  }
  await writeFile(join(root, '.novel', 'novel.json'), serializeMetadata(metadataOf(state, index)), 'utf8')
  process.stdout.write(`wrote ${String(Object.keys(files).length)} content files + novel.json under ${root}\n`)
}

const target = process.argv[2]
if (target === undefined) {
  process.stderr.write('usage: node --experimental-strip-types scripts/make-fixture.ts <target-directory>\n')
  process.exit(2)
}
await main(resolve(target))
