import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { emptyNovel } from '../src/core/index.ts'
import type {
  BeatSlot,
  Chapter,
  Character,
  Competitor,
  Evaluation,
  Iteration,
  LaunchDecision,
  MetricReading,
  NovelState,
  Retrospective,
  ReviewRecord,
  VolumePlan,
  WorldEntry,
} from '../src/core/types.ts'
import { NovelStore } from '../src/host/store.ts'
import { documentViewsOf } from '../src/client/document-views.ts'
import type { DocumentView } from '../src/client/document-views.ts'
import { readProject } from '../src/client/project.ts'
import type { SessionId } from '../src/client/project.ts'
import type { ClientRemote } from '../src/client/remote.ts'

/**
 * Document-view specs: what one process-document card can open.
 *
 * The board projection is specified in `test/board.test.ts`; this is the second
 * half of the same feature — the artefacts behind the cards. The project is
 * written by the **store** and read back through the **client reader**, so a
 * change to the on-disk format fails here rather than in a browser.
 */

let root: string
let ctx: Context
let store: NovelStore
let clock: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ai-novelist-documents-'))
  clock = '2024-05-01T00:00:00.000Z'
  ctx = new Context()
  ctx.plugin(LocalFileSystem, { cwd: root, diffBasisMaxBytes: 64 * 1024 })
  store = new NovelStore(ctx, { workspaceRoot: root, clock: () => clock })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/**
 * The shell's Remote, as the reader calls it, backed by the real filesystem.
 *
 * Only the two calls the reader makes exist, and a missing file answers the
 * Remote's own absence code — the one the reader treats as "no such document".
 *
 * @param workspaceRoot - directory relative paths resolve against.
 * @returns the fake face.
 */
function remoteOver(workspaceRoot: string): ClientRemote {
  return {
    workspaceFiles: {
      read: async (_sessionId: string, path: string) => {
        const target = isAbsolute(path) ? path : join(workspaceRoot, path)
        try {
          return { ok: true as const, value: { text: await readFile(target, 'utf8'), eof: true } }
        } catch {
          return { ok: false as const, error: { code: 'workspace-file/not-found', message: target } }
        }
      },
      readBytes: () => Promise.reject(new Error('unexpected second page')),
    },
  } as unknown as ClientRemote
}

/** The session identity a read is addressed by; the fake ignores it. */
const SESSION = 'session-document-views' as SessionId

/**
 * Read the project back and project its document views.
 *
 * @returns the views, keyed by document id.
 */
async function viewsOf(): Promise<Readonly<Record<string, readonly DocumentView[]>>> {
  const read = await readProject(remoteOver(root), SESSION, new AbortController().signal, root)
  expect(read.status).toBe('ready')
  if (read.status !== 'ready') return {}
  return documentViewsOf(read.state, read.metadata.index, read.files)
}

/** Build one chapter with the fields the content codec reads. */
function chapter(overrides: Partial<Chapter> & { readonly number: number }): Chapter {
  return {
    id: `ch-${String(overrides.number).padStart(3, '0')}`,
    title: '',
    synopsis: '',
    status: 'planned',
    body: '',
    wordCount: 0,
    updatedAt: '2026-01-01T00:00:00.000Z',
    volume: 0,
    plotTask: '',
    timeAnchor: '',
    place: '',
    conflict: '',
    emotionalPayoff: '',
    infoGap: '',
    beats: [],
    hook: '',
    keyBeat: '',
    price: '',
    targetWords: 0,
    waived: {},
    delivered: [],
    ...overrides,
  }
}

/** A complete competitor, so the competitor file has every field. */
const COMPETITOR: Competitor = {
  id: 'qingyun',
  title: '青云录',
  tags: ['仙侠'],
  blurb: '少年上山。',
  openingEvent: '山门试剑',
  goldenFinger: '断剑认主',
  protagonistDesire: '查清旧案',
  antagonistMotive: '压住旧案',
  shuangFrequency: '每 3 章',
  emotionCurve: '压抑后翻盘',
  paywallPoint: '第 20 章',
  chapterHooks: '章末翻案',
  commentKeywords: ['断剑', '翻案'],
  takeaway: '低开高走',
}

/** A complete character, so the cast file has a readable entry. */
const CHARACTER: Character = {
  id: 'lin-zhao',
  name: '林照',
  role: 'protagonist',
  scope: 'main',
  volume: 1,
  firstAppearance: '第1章',
  exit: '',
  description: '沉默寡言的少年，随身佩一柄断剑。',
  personality: '压得住情绪，越急越沉默。',
  voice: '短句，少用感叹号，叫人多带名字。',
  goal: '查清父亲当年的死因。',
  fear: '再失去一个熟人。',
  obsession: '旧案。',
  weakness: '不肯求人。',
  camp: '主角阵营',
  relations: '与门主是旧识。',
  growthArc: '从只想问清死因，到愿意替别人扛事。',
  notes: '',
}

/** A complete world entry, with the cost and limit a rule owes. */
const WORLD: WorldEntry = {
  id: 'qingyun-sect',
  kind: 'faction',
  name: '青云门',
  detail: '山门分前山后山两脉，前山掌外门。',
  cost: '入门要交三年自由。',
  limits: '管不到后山禁地。',
  parent: '',
  level: 2,
  volume: 1,
  relations: '与后山一脉对立。',
}

/** One volume outline with its own narrative spine. */
function volume(number: number, title: string): VolumePlan {
  return {
    number,
    title,
    detail: '本卷的卷内节奏。',
    goal: '立住脚。',
    conflict: '入门试炼。',
    climax: '卷末登顶。',
    endHook: '旧案浮出。',
    synopsis: `第 ${String(number)} 卷从头到尾讲一遍。`,
    protagonistArc: '主角进一步。',
    antagonistArc: '反派第一次露头。',
    factionShift: '门内两派成形。',
    mainConflict: '入门试炼怎么打。',
    costs: '失去了自由身。',
    gains: '得了一个身份。',
    chapters: [number],
  }
}

/** One AI-flavour review, quoted and actionable. */
function review(id: string, target: string): ReviewRecord {
  return {
    id,
    at: clock,
    kind: 'ai-flavor',
    target,
    provider: 'test-provider',
    model: 'test-model',
    promptVersion: 'review-rubric-2',
    summary: '整体可用，但对举句偏多。',
    findings: [
      {
        dimension: '对举句',
        quote: '不是怕，是冷。',
        why: '一眼像模版生成的对照。',
        fix: '改成直接说他的反应。',
        severity: 'medium',
      },
    ],
    artifact: '',
  }
}

/** One launch decision: the first revise, then the go that unlocks the skeleton. */
function launch(id: string, verdict: LaunchDecision['verdict']): LaunchDecision {
  return {
    id,
    at: clock,
    verdict,
    fallback: verdict === 'go' ? '' : '回到开篇包',
    abandonIf: verdict === 'go' ? '' : '三轮读者都说记不住',
    note: '作者与编辑讨论后的结论。',
  }
}

/** A state with every document the viewer can open. */
function richState(): NovelState {
  const base = emptyNovel({ title: '青云记', premise: '少年持断剑上山。' }, () => clock)
  const beats: readonly BeatSlot[] = [
    { chapter: 1, kind: 'shuang', note: '断剑认主' },
    { chapter: 2, kind: 'turn', note: '旧案浮出' },
  ]
  const reading: MetricReading = {
    id: 'r-1',
    at: clock,
    period: 'new-book',
    atChapter: 3,
    values: { readThrough3: 0.42, followRead10: 0.18 },
    source: '平台后台',
    note: '第三章读完率还行。',
  }
  const iteration: Iteration = {
    id: 'i-1',
    at: clock,
    trigger: 'readThrough3',
    evidence: 'readThrough3 高于中位。',
    action: '把第三章的钩子提前。',
    scope: 'chapter',
    baselineReadingId: 'r-1',
    outcomeReadingId: '',
    outcome: 'unknown',
    note: '',
  }
  const evaluation: Evaluation = {
    id: 'e-1',
    round: 1,
    at: clock,
    channel: 'platform',
    sampleSize: 100,
    readingId: 'r-1',
    namingId: '',
    verdict: 'pass',
    reasons: ['readThrough3 高于中位'],
    fallback: '',
    abandonIf: '',
    nextAtChapter: 10,
    nextTrigger: '卷末',
    note: '',
  }
  const retro: Retrospective = {
    at: clock,
    dataSummary: '全书 80 万字，读完率 42%。',
    highlights: ['断剑亮相够早'],
    problems: ['中段节奏拖'],
    lessons: [
      { id: 'l-1', kind: 'reuse', statement: '金手指第一章就亮相', evidence: '第三章读完率高', area: 'opening' },
    ],
    assets: [{ id: 'a-1', kind: 'character', label: '林照', content: '沉默少年', source: '第1章' }],
    templates: [],
  }
  return {
    ...base,
    pitch: {
      memorablePoint: '沉默少年持断剑上山，翻出二十年前的旧案。',
      coreEmotion: '不甘',
      shuangPoints: ['断剑认主', '旧案翻盘'],
      differentiators: ['本土山门'],
      kernel: '执念',
    },
    naming: [
      {
        id: 'n-1',
        title: '青云志',
        blurb: '少年持断剑上山。',
        tags: ['仙侠'],
        rationale: '直白好记。',
        active: true,
      },
    ],
    competitors: [COMPETITOR],
    characters: { [CHARACTER.id]: CHARACTER },
    world: { [WORLD.id]: WORLD },
    outline: {
      ...base.outline,
      logline: '少年持断剑上山，翻出二十年前的旧案。',
      story: {
        time: '架空古代，跨三年。',
        place: '青云山与后山禁地。',
        cause: '父亲旧案。',
        process: '入门、试剑、夜战。',
        result: '翻案，山门重分。',
      },
      cheat: {
        name: '断剑认主',
        owner: 'lin-zhao',
        rule: '断剑在生死关头回应持有者。',
        cost: '每次回应削一段记忆。',
        limits: '不能主动唤醒。',
        growth: '从剑鸣到剑域。',
        firstReveal: '第1章',
      },
      style: {
        tone: '冷峻、克制。',
        perspective: '第三人称限知。',
        rhythm: '短句为主。',
        diction: '书面语，少成语。',
        dialogue: '对话占四成。',
        emotion: '情绪落在动作上。',
        taboos: '不写章末总结。',
      },
      volumes: [volume(1, '山门'), volume(2, '江湖')],
      beats,
    },
    chapters: {
      'ch-001': chapter({ number: 1, title: '山门', volume: 1 }),
      'ch-002': chapter({ number: 2, title: '旧案', volume: 2 }),
    },
    reviews: [review('review-1', 'ch-001'), review('review-2', 'ch-002')],
    launchDecisions: [launch('launch-1', 'revise'), launch('launch-2', 'go')],
    readings: [reading],
    iterations: [iteration],
    evaluations: [evaluation],
    retro,
  }
}

describe('documentViewsOf', () => {
  it('opens nothing for a fresh project beyond the checklist that already exists', async () => {
    await store.create(emptyNovel({ title: '空项目' }, () => clock))
    const views = await viewsOf()

    // Every content file exists, but an untouched document is headings and no
    // body: the card must stay a plain card rather than opening an empty modal.
    expect(views.cast ?? []).toEqual([])
    expect(views.world ?? []).toEqual([])
    expect(views.outline ?? []).toEqual([])
    expect(views.volumes ?? []).toEqual([])
    expect(views.beats ?? []).toEqual([])
    expect(views.launch ?? []).toEqual([])
    expect(views.serial ?? []).toEqual([])
    expect(views.retro ?? []).toEqual([])
    expect(views['de-ai'] ?? []).toEqual([])
    // The opening checklist is written with its seven items from the start, so
    // it is content the author can read before doing anything.
    expect((views.opening?.length ?? 0)).toBe(1)
  })

  it('exposes the file, the block, and the list behind each document', async () => {
    await store.create(richState())
    const views = await viewsOf()

    // One file: the cast is shown as the file itself, with the entry in it.
    const cast = views.cast ?? []
    expect(cast).toHaveLength(1)
    expect(cast[0]?.source).toBe('人物设定.md')
    expect(cast[0]?.content).toContain('## 林照')

    // One block of a shared file: the story is read from 全书大纲.md's section,
    // not from the whole outline.
    const story = views.story ?? []
    expect(story).toHaveLength(1)
    expect(story[0]?.source).toBe('全书大纲.md · 故事六要素')
    expect(story[0]?.content).toContain('## 时间')

    // Several files: one volume outline per volume, in reading order.
    const volumes = views.volumes ?? []
    expect(volumes.map((view) => view.label)).toEqual(['第 1 卷 · 山门', '第 2 卷 · 江湖'])
    expect(volumes.map((view) => view.source)).toEqual(['分卷大纲/第1卷.md', '分卷大纲/第2卷.md'])

    // Several blocks: one rhythm table per chapter-plan file.
    const beats = views.beats ?? []
    expect(beats.map((view) => view.label)).toEqual([
      '第 1 卷 · 情绪节拍表',
      '第 2 卷 · 情绪节拍表',
    ])
    expect(beats[0]?.content).toContain('断剑认主')

    // Several records: one diagnosis per reviewed chapter.
    const deAi = views['de-ai'] ?? []
    expect(deAi.map((view) => view.label)).toEqual([
      '第 1 章 · 山门 · 去 AI 化诊断',
      '第 2 章 · 旧案 · 去 AI 化诊断',
    ])
    expect(deAi[0]?.content).toContain('不是怕，是冷。')

    // Several decisions: newest first, so the standing verdict is the first one.
    const launch = views.launch ?? []
    expect(launch.map((view) => view.label)).toEqual(['第 2 次上线决策 · go', '第 1 次上线决策 · revise'])
    expect(launch[0]?.content).toContain('结论：go')

    // The serial ledgers each become their own readable record.
    const serial = views.serial ?? []
    expect(serial.map((view) => view.label)).toEqual([
      '平台读数 · 2024-05-01T00:00:00.000Z',
      '迭代记录 · 2024-05-01T00:00:00.000Z',
      '投入评估 · 第 1 轮',
    ])

    // Metadata-backed documents are readable Markdown, not a JSON dump.
    expect((views.pitch?.[0]?.content ?? '')).toContain('一句话记忆点')
    expect((views.retro?.[0]?.content ?? '')).toContain('做对了什么')
  })
})
