import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { Config, apply } from '../src/index.ts'
import {
  beatCadenceGaps,
  beatConflicts,
  cheatGaps,
  defaultOpeningChecks,
  emptyNovel,
  emptyOutline,
  parseChapterOutlineFile,
  parseOutlineFile,
  parseWorldFile,
  renderChapterOutlineFile,
  renderOutlineFile,
  renderWorldFile,
  sixElementRows,
  spaceTimeDebt,
  spaceTimeGaps,
  storyElementGaps,
  upsertChapter,
  upsertCharacter,
  upsertWorld,
  worldGaps,
  worldStructureGaps,
} from '../src/core/index.ts'
import type { Chapter, GoldenFinger, NovelState, StoryElementField, WorldEntry } from '../src/core/types.ts'

/**
 * The two "six element" frameworks, pinned end to end.
 *
 * The traditional 六要素 (时间/地点/人物/起因/经过/结果) and the web-novel 六要素
 * (人设/金手指/钩子期待感/分层世界观/情绪爽点/节奏可读性) are only *supported* if
 * they are data with a check behind them. These specs assert the data, the gap
 * checks, the Markdown round trip, and the tool calls that write them.
 */
const STAMP = '2026-01-01T00:00:00.000Z'

const STORY: Record<StoryElementField, string> = {
  time: '大胤三十七年秋，故事跨三年',
  place: '青云山外门→后山→王庭',
  cause: '父亲断剑被送回，林越上山问死因',
  process: '试剑台认主、后山夜战、账房对质，旧案一层层翻开',
  result: '旧案翻案，林越失去隐姓埋名的余地，留下断剑守山门',
}

const CHEAT: GoldenFinger = {
  name: '断剑认主',
  owner: 'lin-yue',
  rule: '断剑遇林越血脉发烫，能看见杀意留下的轨迹',
  cost: '每次认主折损一年寿元',
  limits: '不能斩同门；看不见没有杀意的剑',
  growth: '前三卷只认主三次；第四卷解锁残魂；终卷剑身重铸',
  firstReveal: '第2章',
}

const worldEntry = (overrides: Partial<WorldEntry> & Pick<WorldEntry, 'id' | 'name'>): WorldEntry => ({
  kind: 'place',
  detail: '',
  cost: '',
  limits: '',
  parent: '',
  level: 0,
  volume: 0,
  relations: '',
  ...overrides,
})

function stateWith(overrides: Partial<NovelState> = {}): NovelState {
  return {
    ...emptyNovel({ title: '青云记', premise: '少年持断剑上山' }, () => STAMP),
    ...overrides,
  }
}

describe('the traditional 六要素', () => {
  it('reports the five stored elements and derives 人物 from the cast', () => {
    const bare = stateWith()
    expect(storyElementGaps(bare.outline).map((gap) => gap.key)).toEqual(['time', 'place', 'cause', 'process', 'result'])
    expect(sixElementRows(bare).map((row) => row.key)).toEqual(['time', 'place', 'characters', 'cause', 'process', 'result'])
    expect(sixElementRows(bare).filter((row) => row.filled)).toHaveLength(0)

    const outlined = stateWith({
      outline: { ...bare.outline, story: STORY },
    })
    expect(storyElementGaps(outlined.outline)).toEqual([])
    // The stored five are filled, but 人物 is still empty: no main character yet.
    expect(sixElementRows(outlined).filter((row) => !row.filled).map((row) => row.key)).toEqual(['characters'])

    const cast = upsertCharacter(outlined, {
      id: 'lin-yue',
      name: '林越',
      role: 'protagonist',
      goal: '问清父亲的死因',
      personality: '外冷内倔',
      voice: '短句，先问价再动手',
      fear: '父亲真的背叛了师门',
      obsession: '断剑不离手',
      weakness: '受不得激',
      growthArc: '莽→忍→断',
    })
    expect(sixElementRows(cast).filter((row) => !row.filled)).toEqual([])
  })

  it('keeps the five elements and the cheat through a Markdown round trip', () => {
    const outline = { ...emptyOutline(), story: STORY, cheat: CHEAT }
    const text = renderOutlineFile({
      logline: outline.logline,
      story: outline.story,
      cheat: outline.cheat,
      spine: {
        synopsis: '',
        protagonistArc: '',
        supportArcs: '',
        antagonistArc: '',
        factionShift: '',
        conflictArcs: '',
        costs: '',
        gains: '',
      },
      style: outline.style,
      fullOutline: '',
      acts: [],
      minimal: '',
      fullOutlineDone: false,
    })
    expect(text).toContain('## 故事六要素')
    expect(text).toContain('### 时间')
    expect(text).toContain('## 金手指')
    expect(text).toContain('### 成长曲线')

    const parsed = parseOutlineFile(text, '全书大纲.md')
    expect(parsed.story).toEqual(STORY)
    expect(parsed.cheat).toEqual(CHEAT)
  })

  it('writes a time anchor and a place into the chapter contract', () => {
    const chapter: Chapter = {
      ...upsertChapter(emptyNovel(), { id: 'chapter-1', title: '山门' }, () => STAMP).chapters['chapter-1']!,
      timeAnchor: '第三日 黄昏',
      place: '青云山 外门石阶',
    }
    expect(spaceTimeGaps(chapter)).toEqual([])
    const text = renderChapterOutlineFile(chapter, STAMP)
    expect(text).toContain('## 时间')
    expect(text).toContain('第三日 黄昏')
    expect(text).toContain('## 地点')
    expect(text).toContain('青云山 外门石阶')

    const parsed = parseChapterOutlineFile(text, '第001章-山门.细纲.md', '第001章-山门.md')
    expect(parsed.timeAnchor).toBe('第三日 黄昏')
    expect(parsed.place).toBe('青云山 外门石阶')
    expect(spaceTimeDebt(stateWith({ chapters: { 'chapter-1': { ...chapter, timeAnchor: '', place: '' } } }))[0]?.missing)
      .toEqual(['timeAnchor', 'place'])
  })

  it('reports a cheat field by field, and an owner that is not in the cast', () => {
    const bare = stateWith()
    expect(cheatGaps(bare.outline).map((gap) => gap.key)).toEqual([
      'name',
      'owner',
      'rule',
      'cost',
      'limits',
      'growth',
      'firstReveal',
    ])
    const filled = stateWith({ outline: { ...bare.outline, cheat: CHEAT } })
    expect(cheatGaps(filled.outline)).toEqual([])
  })
})

describe('the layered world', () => {
  it('asks a rule for a price and a ceiling, but not a place', () => {
    const state = stateWith({
      world: {
        shanmen: worldEntry({ id: 'shanmen', name: '青云山', kind: 'place', detail: '外门在南麓，后山禁地' }),
        rule: worldEntry({ id: 'rule', name: '剑心通明', kind: 'rule', detail: '能看见剑的轨迹' }),
      },
    })
    const gaps = worldGaps(state)
    expect(gaps.map((gap) => gap.id)).toEqual(['rule'])
    expect(gaps[0]?.missing).toEqual(['cost', 'limits'])
  })

  it('reports a dangling parent, a self-parent and an unknown kind', () => {
    const state = stateWith({
      world: {
        city: worldEntry({ id: 'city', name: '青石城', parent: 'missing-region', level: 2, volume: 3 }),
        self: worldEntry({ id: 'self', name: '自指', parent: 'self' }),
        typo: worldEntry({ id: 'typo', name: '错类型', kind: 'power_system' }),
      },
    })
    const problems = worldStructureGaps(state).map((gap) => gap.problem).join(' ')
    expect(problems).toMatch(/missing-region/)
    expect(problems).toMatch(/自己/)
    expect(problems).toMatch(/power_system/)
  })

  it('keeps parent, level, volume and relations through the world file', () => {
    const entries: Record<string, WorldEntry> = {
      qingyun: worldEntry({ id: 'qingyun', name: '青云山', kind: 'place', detail: '南麓外门，北麓后山', level: 2, volume: 1 }),
      city: worldEntry({
        id: 'city',
        name: '青石城',
        kind: 'place',
        detail: '山脚县城',
        parent: 'qingyun',
        level: 3,
        volume: 2,
        relations: '依附青云宗',
      }),
    }
    const text = renderWorldFile(entries)
    expect(text).toContain('parent: "qingyun"')
    expect(text).toContain('level: 3')
    expect(text).toContain('volume: 2')
    expect(text).toContain('relations: "依附青云宗"')

    const parsed = parseWorldFile(text, '世界观设定.md')
    expect(parsed['city']).toMatchObject({ parent: 'qingyun', level: 3, volume: 2, relations: '依附青云宗' })
  })
})

describe('爽点节奏', () => {
  it('reports a gap longer than three chapters and a volume end with no beat', () => {
    const beats = { ...emptyOutline(), beats: [
      { chapter: 3, kind: 'shuang' as const, note: '' },
      { chapter: 13, kind: 'burn' as const, note: '' },
    ] }
    const state = stateWith({
      outline: {
        ...beats,
        volumes: [
          {
            number: 1,
            title: '',
            detail: '',
            goal: '',
            conflict: '',
            climax: '',
            endHook: '',
            synopsis: '',
            protagonistArc: '',
            antagonistArc: '',
            factionShift: '',
            mainConflict: '',
            costs: '',
            gains: '',
            chapters: [1, 20],
          },
        ],
      },
    })
    const notes = beatCadenceGaps(state).join(' ')
    expect(notes).toMatch(/第 3–13 章之间没有节拍/)
    expect(notes).toMatch(/第 1 卷卷末/)
  })

  it('reports a rhythm slot that contradicts the chapter contract', () => {
    const state = stateWith({
      outline: { ...emptyOutline(), beats: [{ chapter: 3, kind: 'shuang', note: '' }] },
      chapters: {
        'chapter-3': {
          ...upsertChapter(emptyNovel(), { id: 'chapter-3', number: 3 }, () => STAMP).chapters['chapter-3']!,
          beats: ['info'],
        },
      },
    })
    expect(beatConflicts(state)[0]).toMatch(/节拍表记「shuang」/)
  })
})

describe('the tools write the new elements', () => {
  let root: string
  let ctx: Context
  let tools: Map<string, ToolDefinition>

  const recorder = {
    name: 'tools-recorder',
    apply(target: Context) {
      const definitions = new Map<string, ToolDefinition>()
      tools = definitions
      target.provide('tools', {
        register: (definition: ToolDefinition) => {
          definitions.set(definition.name, definition)
          return () => definitions.delete(definition.name)
        },
      })
    },
  }

  async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const definition = tools.get(name)
    if (definition === undefined) throw new Error(`tool ${name} is not registered`)
    return (await definition.execute(args, { signal: new AbortController().signal } as never)) as Record<string, unknown>
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ai-novelist-six-elements-'))
    ctx = new Context()
    ctx.plugin(LocalFileSystem, { cwd: root, diffBasisMaxBytes: 64 * 1024 })
    ctx.plugin(recorder)
    // The recorder announces `tools` on its own fiber, so wait for the service
    // before mounting the composer against it.
    for (let attempt = 0; attempt < 100 && ctx.get('tools') === undefined; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    apply(ctx, Config({ workspaceRoot: root }) as never)
    await call('novel_init', { title: '青云记', premise: '少年持断剑上山' })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('writes the 六要素 and the 金手指 into 全书大纲.md, and reports both', async () => {
    const outline = await call('novel_plan', {
      operation: 'outline',
      ...Object.fromEntries(
        Object.entries(STORY).map(([key, value]) => [`story${key[0]?.toUpperCase() ?? ''}${key.slice(1)}`, value]),
      ),
    })
    expect((outline['warnings'] as string[]).join(' ')).toMatch(/故事六要素还没写全：人物/)

    const cheat = await call('novel_plan', {
      operation: 'cheat',
      cheatName: CHEAT.name,
      cheatOwner: CHEAT.owner,
      cheatRule: CHEAT.rule,
      cheatCost: CHEAT.cost,
      cheatLimits: CHEAT.limits,
      cheatGrowth: CHEAT.growth,
      cheatReveal: CHEAT.firstReveal,
    })
    expect((cheat['warnings'] as string[]) ?? []).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/金手指还缺/)]),
    )

    const text = await readFile(join(root, '全书大纲.md'), 'utf8')
    expect(text).toContain('## 故事六要素')
    expect(text).toContain('大胤三十七年秋')
    expect(text).toContain('## 金手指')
    expect(text).toContain('断剑认主')
    expect(text).toContain('### 成长曲线')

    const status = await call('novel_status', { detail: 'plan' })
    expect((status['body'] as string[]).join('\n')).toContain('故事六要素')
    expect((status['body'] as string[]).join('\n')).toContain('金手指')
  })

  it('writes a layered place and the chapter time/place anchors', async () => {
    await call('novel_bible', {
      kind: 'world',
      id: 'qingyun',
      name: '青云山',
      worldKind: 'place',
      detail: '南麓外门，北麓后山',
      level: 2,
      volume: 1,
    })
    await call('novel_bible', {
      kind: 'world',
      id: 'qingshi',
      name: '青石城',
      worldKind: 'place',
      detail: '山脚县城',
      parent: 'qingyun',
      level: 3,
      volume: 2,
      relations: '依附青云宗',
    })
    const world = await readFile(join(root, '世界观设定.md'), 'utf8')
    expect(world).toContain('parent: "qingyun"')
    expect(world).toContain('level: 3')

    const chapter = await call('novel_plan', {
      operation: 'chapter',
      id: 'chapter-1',
      title: '山门',
      plotTask: '林越上山',
      timeAnchor: '第三日 黄昏',
      place: '青云山 外门石阶',
    })
    expect((chapter['warnings'] as string[]).join(' ')).not.toMatch(/缺时空锚点/)
    const contract = await readFile(join(root, '章节', '第001章-山门.细纲.md'), 'utf8')
    expect(contract).toContain('## 时间')
    expect(contract).toContain('第三日 黄昏')
    expect(contract).toContain('## 地点')
    expect(contract).toContain('青云山 外门石阶')

    const bible = await call('novel_status', { detail: 'bible' })
    const bibleText = (bible['body'] as string[]).join('\n')
    expect(bibleText).toContain('时间线（按章）')
    expect(bibleText).toContain('世界设定（按类型/层级）')
    expect(bibleText).toContain('第三日 黄昏')

    const review = await call('novel_bible', { kind: 'review' })
    const reviewText = (review['body'] as string[]).join('\n')
    expect(reviewText).toContain('故事六要素')
    expect(reviewText).toContain('金手指')
  })
})
