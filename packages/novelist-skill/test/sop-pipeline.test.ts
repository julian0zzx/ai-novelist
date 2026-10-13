import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { Config, apply } from '../src/index.ts'
import { STYLE_ARGS } from './style-fixture.ts'

/**
 * The SOP pipeline, driven end to end through the eight tools.
 *
 * This is the spec that answers "does the workflow the SOP describes actually
 * run?" — every phase in order, using only the tool surface a model has, with
 * the gates asserted where the SOP makes a claim about them.
 */
let root: string
let ctx: Context
let tools: Map<string, ToolDefinition>

/**
 * The narrative spine a "finished skeleton" answers.
 *
 * Stage four is not done while a layer cannot tell its story (SOP 3.5 §1.5), so
 * the phase-four specs have to write the spine the way a real project would.
 */
const SPINE = {
  synopsis: '少年上山查案，最后把旧账翻了过来。',
  protagonistArc: '从只想问清死因，到愿意替别人扛事',
  supportArcs: '同门从怕事到敢作证',
  antagonistArc: '长老从压住旧案到被逼出手',
  factionShift: '后山一脉分裂，前山成军',
  conflictArcs: '试剑台认主、后山夜战、账房对质',
  costs: '失去了隐姓埋名的余地',
  gains: '断剑认主与一条翻案线索',
}

/** The per-volume spine a "finished volume plan" answers. */
const VOLUME_SPINE = {
  synopsis: '少年入门，卷末登顶。',
  protagonistArc: '从散修变成门内弟子',
  antagonistArc: '对手第一次露头',
  factionShift: '门内两派成形',
  mainConflict: '入门试炼',
  costs: '失去了自由身',
  gains: '得了一个身份',
}

/** Minimal stand-in for the `tools` service: records what a plugin registers. */
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

/** One tool call, as the agent loop would dispatch it. */
async function call(
  name: string,
  args: Record<string, unknown>,
  session?: { readonly header: { readonly cwd?: string } },
): Promise<Record<string, unknown>> {
  const definition = tools.get(name)
  if (definition === undefined) throw new Error(`tool ${name} is not registered`)
  const exec = { signal: new AbortController().signal, ...(session !== undefined && { agent: { session } }) }
  return (await definition.execute(args, exec as never)) as Record<string, unknown>
}

/**
 * Close the premise layer the way the SOP asks for it: two recorded rounds
 * carrying the author's own words, then the author's sign-off.
 *
 * Every spec below that writes prose goes through here, because `novel_write`
 * refuses to write without it — which is the behaviour a separate spec asserts.
 */
async function confirmPremise(): Promise<void> {
  await call('novel_confirm', {
    operation: 'discuss',
    kind: 'settings',
    proposal: '第一版设定：沉默少年持断剑上山，冷开局，先写外门底层。',
    feedback: '主角再冷一点，别一上来就热血，也别喊口号。',
    topics: ['立意', '人设'],
  })
  await call('novel_confirm', {
    operation: 'discuss',
    kind: 'settings',
    proposal: '按你的意见改成沉默寡言，删掉复仇宣言，篇幅按单章 3000 字、80 万字。',
    feedback: '可以，就按这版来。',
    topics: ['人设', '篇幅'],
  })
  await call('novel_confirm', {
    operation: 'confirm',
    kind: 'settings',
    summary: '沉默少年持断剑上山，冷开局，单章 3000 字、总 80 万字。',
    note: '可以，就按这版来。',
  })
}

/**
 * Close one of the layers after the premise: one recorded round, then the sign-off.
 *
 * @param kind - the layer's confirmation kind.
 * @param label - the layer's name, for the round's proposal text.
 */
async function confirmLayer(kind: 'world' | 'cast' | 'outline' | 'volume', label: string): Promise<void> {
  await call('novel_confirm', {
    operation: 'discuss',
    kind,
    proposal: `${label}这一层的第一版：${label === '分卷大纲' ? '第一卷立住脚，卷末认主。' : `先按最小可用来。`}`,
    feedback: `这一层可以，就这样定。`,
    topics: [label],
  })
  await call('novel_confirm', {
    operation: 'confirm',
    kind,
    summary: `${label}定稿。`,
    note: '这一层可以，就这样定。',
  })
}

/**
 * Close every settings layer, in the SOP's order.
 *
 * The stage machine only leaves 阶段一 once all five layers are signed off, so
 * every spec that walks the pipeline past planning goes through this.
 */
async function confirmSettings(): Promise<void> {
  await confirmPremise()
  await confirmLayer('world', '世界观设定')
  await confirmLayer('cast', '人物设定')
  // The 写作风格 block is part of the 全书大纲 layer and gates the prose, so a project
  // that walks the pipeline far enough to write chapters has to write it first.
  await call('novel_plan', { operation: 'outline', ...STYLE_ARGS })
  await confirmLayer('outline', '全书大纲')
  await confirmLayer('volume', '分卷大纲')
}

/** Close the 文风复核 once the golden three chapters exist. */
async function confirmStyle(): Promise<void> {
  await call('novel_confirm', {
    operation: 'discuss',
    kind: 'style',
    proposal: '把黄金三章交给你读：短句为主，对话推进，形容词少。',
    feedback: '这个语感可以，别加解释性段落。',
    topics: ['文风'],
  })
  await call('novel_confirm', {
    operation: 'confirm',
    kind: 'style',
    summary: '短句为主、对话推进、形容词少、不加解释性段落。',
    note: '这个语感可以。',
  })
}

/** The rendered text of one tool call, for asserting what the model is told. */
async function callText(name: string, args: Record<string, unknown>): Promise<string> {
  const definition = tools.get(name)
  if (definition === undefined) throw new Error(`tool ${name} is not registered`)
  const value = (await definition.execute(args, { signal: new AbortController().signal } as never)) as Record<
    string,
    unknown
  >
  const blocks = definition.output.render(args, value as never)
  return blocks.map((block) => ('text' in block ? block.text : '')).join('\n')
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ai-novelist-sop-'))
  ctx = new Context()
  ctx.plugin(LocalFileSystem, { cwd: root, diffBasisMaxBytes: 64 * 1024 })
  ctx.plugin(recorder)
  // The recorder announces `tools` on its own fiber, so wait for the service
  // before mounting the composer against it.
  await until(() => ctx.get('tools') !== undefined)
  apply(ctx, Config({ workspaceRoot: root }) as never)
})

/** Wait for a service to appear on the context. */
async function until<T>(read: () => T | undefined, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('timed out waiting for the service')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('phase one: planning', () => {
  it('starts by naming what the SOP still needs', async () => {
    await call('novel_init', { title: '青云记', premise: '少年携断剑上山。', platform: 'qidian', mode: 'paid', audience: 'male' })
    const status = await call('novel_status', {})
    const blockers = status['blockers'] as string[]
    expect(status['stage']).toMatch(/planning/)
    expect(blockers.join(' ')).toMatch(/记忆点/)
    expect(blockers.join(' ')).toMatch(/竞品/)
  })

  it('soft-gates instead of refusing: a competitor call works before the pitch exists', async () => {
    await call('novel_init', { title: '青云记' })
    const result = await call('novel_plan', { operation: 'competitor', title: '同榜书 A', goldenFinger: '签到系统' })
    expect(result['ok']).toBe(true)
    expect((result['warnings'] as string[]).join(' ')).toMatch(/竞品拆解 1\/20/)
  })

  it('warns when a world rule has no cost or limits', async () => {
    await call('novel_init', { title: '青云记' })
    const bare = await call('novel_plan', { operation: 'world', name: '剑心通明', detail: '能看见剑的轨迹' })
    expect((bare['warnings'] as string[]).join(' ')).toMatch(/代价与限制/)

    const complete = await call('novel_plan', {
      operation: 'world',
      name: '剑心通明',
      detail: '能看见剑的轨迹',
      cost: '每用一次寿命减一日',
      limits: '看不见没有杀意的剑',
    })
    expect((complete['warnings'] as string[]) ?? []).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/代价与限制/)]),
    )
  })

  it('warns that a protagonist is missing the SOP spine', async () => {
    await call('novel_init', { title: '青云记' })
    const thin = await call('novel_bible', { kind: 'character', name: '林越', role: 'protagonist', goal: '上山' })
    expect((thin['warnings'] as string[]).join(' ')).toMatch(/恐惧|执念|软肋|成长线/)
  })

  it('reports the 写作风格 block when the outline is written, and warns while it is missing', async () => {
    await call('novel_init', { title: '青云记' })
    const bare = await callText('novel_plan', { operation: 'outline', logline: '少年上山' })
    expect(bare).toContain('## 写作风格')
    expect(bare).toContain('文风基调')
    expect(bare).toMatch(/⬜.*文风基调/u)

    const written = await callText('novel_plan', { operation: 'outline', ...STYLE_ARGS })
    expect(written).toMatch(/✅.*文风基调/u)
    expect(written).toMatch(/✅.*负面清单/u)
  })

  it('holds every character to 性格 and 说话方式, and names the thin ones on review', async () => {
    await call('novel_init', { title: '青云记' })
    // A name and a goal is all this one has: exactly the "不够丰满" case.
    const thin = await call('novel_bible', { kind: 'character', name: '林越', role: 'protagonist', goal: '上山' })
    expect((thin['warnings'] as string[]).join(' ')).toMatch(/性格|说话方式/)

    // A walk-on with a role, a goal, a personality and a voice is complete.
    const walkOn = await call('novel_bible', {
      kind: 'character',
      name: '守门弟子',
      role: 'gatekeeper',
      goal: '拦住上山的人',
      personality: '死板，认规矩不认人',
      voice: '一句话不问第二遍',
    })
    expect(((walkOn['warnings'] as string[] | undefined) ?? []).join(' ')).not.toMatch(/性格|说话方式/)

    const review = await callText('novel_bible', { kind: 'review' })
    expect(review).toMatch(/人物丰满度|缺要素/u)
    expect(review).toMatch(/林越.*缺.*性格/u)

    // …and the dashboard counts them, so it is a number rather than an impression.
    const dashboard = await callText('novel_status', {})
    expect(dashboard).toMatch(/人物不够丰满 1 位/u)
  })
})

describe('phase one: the length plan', () => {
  it('asks the user for the length numbers instead of assuming them', async () => {
    const answer = await call('novel_init', { title: '青云记' })
    expect((answer['warnings'] as string[]).join(' ')).toMatch(/篇幅四问/)
    const body = (answer['body'] as string[]).join('\n')
    expect(body).toMatch(/总字数/)
    expect(body).toMatch(/单章目标多少字/)
    expect(body).toMatch(/分几卷/)
    // The tiers are offered as choices, not asserted as the answer.
    expect(body).toMatch(/短篇/)
  })

  it('records the answers, derives the chapter count, and stops asking', async () => {
    const planned = await call('novel_init', {
      title: '青云记',
      targetWords: 1200000,
      chapterWords: 3000,
      volumes: 12,
    })
    expect((planned['warnings'] as string[]) ?? []).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/篇幅四问/)]),
    )
    expect((planned['body'] as string[]).join('\n')).toMatch(
      /篇幅：总字数 1200000 · 单章 3000 字 · 12 卷 · 共约 400 章/,
    )
  })

  it('warns when the recorded numbers contradict each other', async () => {
    const result = await call('novel_init', {
      title: '青云记',
      targetWords: 1000000,
      chapterWords: 3000,
      totalChapters: 100,
    })
    expect((result['warnings'] as string[]).join(' ')).toMatch(/相差 70%/)
  })

  it('gives a chapter the per-chapter length settled at initialization', async () => {
    await call('novel_init', { title: '青云记', targetWords: 900000, chapterWords: 3000, volumes: 9 })
    const planned = await call('novel_plan', { operation: 'chapter', id: 'chapter-1', title: '山门', number: 1 })
    expect((planned['warnings'] as string[]) ?? []).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/没设目标字数/)]),
    )
    // The inherited target is what the dashboard shows a draft against.
    expect(await callText('novel_status', {})).toMatch(/0 字\/3000/)
    // And the contract is told, at planning time, the length its first draft is
    // written to: 125% of the finished target.
    const plannedText = await callText('novel_plan', { operation: 'chapter', id: 'chapter-1', title: '山门', number: 1 })
    expect(plannedText).toContain('成稿目标 3000 字')
    expect(plannedText).toContain('初稿目标 3750 字')
  })

  it('warns about a chapter target when the user never gave one', async () => {
    await call('novel_init', { title: '青云记' })
    const planned = await call('novel_plan', { operation: 'chapter', id: 'chapter-1', title: '山门', number: 1 })
    expect((planned['warnings'] as string[]).join(' ')).toMatch(/没设目标字数/)
  })

  it('keeps the volume outline answerable to the volume count the user gave', async () => {
    await call('novel_init', { title: '青云记', targetWords: 600000, chapterWords: 3000, volumes: 0 })
    // 分卷大纲 is stage-four work: the SOP opens it only after a `go`, and this
    // spec is about the volume-count rule, not the gate in front of it.
    await call('novel_plan', { operation: 'launch', verdict: 'go' })
    const single = await call('novel_plan', { operation: 'volume', number: 1, goal: '入门', climax: '初战' })
    expect((single['warnings'] as string[]).join(' ')).toMatch(/不分卷/)

    await call('novel_init', { title: '青云记', volumes: 1 })
    const over = await call('novel_plan', { operation: 'volume', number: 2, goal: '反击', climax: '夺山' })
    expect((over['warnings'] as string[]).join(' ')).toMatch(/超过初始化与用户确认的 1 卷/)
  })

  it('suggests the beat the rhythm rule expects once the volume length is known', async () => {
    await call('novel_init', { title: '青云记', targetWords: 1200000, chapterWords: 3000, volumes: 12 })
    await call('novel_plan', { operation: 'launch', verdict: 'go' })
    const planned = await call('novel_plan', { operation: 'chapter', id: 'chapter-3', title: '试剑', number: 3 })
    expect((planned['warnings'] as string[]).join(' ')).toMatch(/按节奏应为「小高潮」/)

    await call('novel_plan', { operation: 'beat', number: 3, beatKind: 'shuang' })
    const replanned = await call('novel_plan', { operation: 'chapter', id: 'chapter-3', title: '试剑', number: 3 })
    expect((replanned['warnings'] as string[]) ?? []).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/按节奏应为/)]),
    )
  })
})

describe('phase two: the opening package', () => {
  /** Fill in everything phase one requires, so the stage advances. */
  async function completePlanning(): Promise<void> {
    await call('novel_init', { title: '青云记', premise: '少年携断剑上山。' })
    await call('novel_plan', {
      operation: 'pitch',
      memorablePoint: '携断剑的少年在宗门底层一路向上',
      coreEmotion: '被承认',
      shuangPoints: ['打脸', '揭底'],
      differentiators: ['剑有记忆'],
      kernel: '出身不等于命',
    })
    for (let index = 0; index < 20; index += 1) {
      await call('novel_plan', { operation: 'competitor', title: `同榜书 ${String(index)}` })
    }
    // Phase one is not finished until the author has signed the setup off.
    await confirmSettings()
  }

  it('advances to opening-package and then blocks on the opening checklist', async () => {
    await completePlanning()
    const atPrep = await call('novel_status', {})
    expect(atPrep['stage']).toMatch(/opening-package/)
    expect((atPrep['blockers'] as string[]).join(' ')).toMatch(/最小可行大纲/)

    await call('novel_plan', { operation: 'outline', logline: '少年上山', minimal: '一屏摘要', acts: ['起', '承', '转'] })
    await call('novel_plan', { operation: 'chapter', id: 'chapter-1', title: '山门', number: 1, plotTask: '抵达山门' })

    const blocked = await call('novel_status', {})
    expect((blocked['blockers'] as string[]).join(' ')).toMatch(/开篇工程清单/)
  })

  it('will not leave opening-package until the checklist and the naming candidates exist', async () => {
    await completePlanning()
    await call('novel_plan', { operation: 'outline', logline: '少年上山', minimal: '摘要', acts: ['起'] })
    await call('novel_plan', { operation: 'chapter', id: 'chapter-1', title: '山门', number: 1 })

    const listed = await callText('novel_plan', { operation: 'opening' })
    expect(listed).toContain('开篇工程清单')
    for (const key of [
      'chapter-1-conflict-300',
      'chapter-1-hook',
      'chapter-2-golden-finger',
      'chapter-3-payoff',
      'first-10-goal-rival',
      'first-10-climax',
      'first-30k-unit',
    ]) {
      await call('novel_plan', { operation: 'opening', key, done: true, note: '已确认' })
    }
    const checklistDone = await call('novel_status', {})
    expect((checklistDone['blockers'] as string[]).join(' ')).not.toMatch(/开篇工程清单/)

    // The SOP also wants 3–5 naming candidates before the package is testable.
    // With the package complete the project asks for a launch decision — not for
    // a reading, which is the whole point of moving the data check off the track.
    const beforeNaming = await call('novel_status', {})
    expect((beforeNaming['blockers'] as string[]).join(' ')).toMatch(/上线决策/)
    for (const [index, title] of ['断剑问心', '剑有记忆', '宗门底层'].entries()) {
      await call('novel_plan', { operation: 'naming', title, blurb: `简介 ${String(index)}`, tags: ['xianxia'] })
    }
    const namingWarning = await call('novel_plan', { operation: 'naming', title: '第四组' })
    expect(((namingWarning['warnings'] as string[]) ?? []).join(' ')).not.toMatch(/备选 3\/3/)
  })
})

describe('phase three: the launch decision', () => {
  /** A project sitting at the launch decision, opening package complete. */
  async function readyToLaunch(): Promise<void> {
    await call('novel_init', {
      title: '青云记',
      premise: '少年携断剑上山。',
      baselines: { readThrough3: 0.5, followRead10: 0.2, clickRate: 0.08, favoriteRate: 0.3 },
      baselineSource: '同榜中位',
    })
    await call('novel_plan', {
      operation: 'pitch',
      memorablePoint: '携断剑的少年向上',
      coreEmotion: '被承认',
      shuangPoints: ['打脸'],
      differentiators: ['剑有记忆'],
      kernel: '出身不等于命',
    })
    for (let index = 0; index < 20; index += 1) {
      await call('novel_plan', { operation: 'competitor', title: `同榜书 ${String(index)}` })
    }
    await call('novel_plan', { operation: 'outline', logline: '少年上山', minimal: '摘要', acts: ['起'] })
    await call('novel_plan', { operation: 'chapter', id: 'chapter-1', title: '山门', number: 1 })
    for (const key of [
      'chapter-1-conflict-300',
      'chapter-1-hook',
      'chapter-2-golden-finger',
      'chapter-3-payoff',
      'first-10-goal-rival',
      'first-10-climax',
      'first-30k-unit',
    ]) {
      await call('novel_plan', { operation: 'opening', key, done: true })
    }
    await confirmSettings()
  }

  it('asks for a launch decision once the opening package is complete', async () => {
    await readyToLaunch()
    const status = await call('novel_status', {})
    expect(status['stage']).toMatch(/opening-decision/)
    expect((status['blockers'] as string[]).join(' ')).toMatch(/上线决策/)
  })

  it('unlocks the full outline on a declared go, with no reading and no evaluation', async () => {
    await readyToLaunch()
    const decided = await call('novel_plan', {
      operation: 'launch',
      verdict: 'go',
      note: '编辑内投反馈正面，开篇包够格',
    })
    expect(String(decided['detail'])).toMatch(/进入完整大纲/)
    // The stage moves on planned work alone: the platform numbers this project
    // will eventually transcribe are nowhere in the decision.
    expect(decided['stage']).toMatch(/full-outline/)
    const stored = JSON.parse(await readFile(join(root, '.novel/novel.json'), 'utf8')) as {
      readings: unknown[]
      evaluations: unknown[]
      launchDecisions: unknown[]
    }
    expect(stored.readings).toEqual([])
    expect(stored.evaluations).toEqual([])
    expect(stored.launchDecisions).toHaveLength(1)
  })

  it('refuses a non-go launch decision that does not say where to fall back to', async () => {
    await readyToLaunch()
    await expect(call('novel_plan', { operation: 'launch', verdict: 'revise' })).rejects.toThrow(/必须给出 fallback/)
  })

  it('refuses a non-go launch decision that does not say what would end the concept', async () => {
    await readyToLaunch()
    await expect(
      call('novel_plan', { operation: 'launch', verdict: 'revise', fallback: '阶段二 改开篇' }),
    ).rejects.toThrow(/必须给出 abandonIf/)
  })

  it('holds the project at the decision and repeats the fallback and abandon condition', async () => {
    await readyToLaunch()
    const result = await call('novel_plan', {
      operation: 'launch',
      verdict: 'revise',
      fallback: '阶段二：重写开篇三章',
      abandonIf: '再改一轮仍留不住读者就换概念',
      note: '编辑说前三章信息太密',
    })
    expect(String(result['detail'])).toMatch(/改后再说/)
    expect(result['stage']).toMatch(/opening-decision/)
    // The fallback and the abandon condition are recorded with the decision; the
    // dashboard is where they resurface as a standing instruction.
    const dashboard = await callText('novel_status', {})
    expect(dashboard).toContain('阶段二：重写开篇三章')
    expect(dashboard).toContain('再改一轮仍留不住读者就换概念')
  })

  it('records a later go alongside the earlier revise', async () => {
    await readyToLaunch()
    await call('novel_plan', {
      operation: 'launch',
      verdict: 'revise',
      fallback: '阶段二：改开篇',
      abandonIf: '再改一轮无改善',
    })
    const go = await call('novel_plan', { operation: 'launch', verdict: 'go' })
    expect(go['stage']).toMatch(/full-outline/)
    const stored = JSON.parse(await readFile(join(root, '.novel/novel.json'), 'utf8')) as {
      launchDecisions: { verdict: string }[]
    }
    expect(stored.launchDecisions.map((entry) => entry.verdict)).toEqual(['revise', 'go'])
  })
})

describe('phase five: the on-demand investment evaluation', () => {
  /** A serializing project with medians calibrated. */
  async function serializingWithMedians(): Promise<void> {
    await call('novel_init', {
      title: '青云记',
      premise: '少年携断剑上山。',
      baselines: { followRead10: 0.2, averageReadPerChapter: 0.4, chapterScore: 60 },
      baselineSource: '同榜中位',
    })
    await call('novel_plan', { operation: 'outline', logline: '少年上山', minimal: '摘要', acts: ['起'] })
    await call('novel_plan', { operation: 'chapter', id: 'chapter-1', title: '山门', number: 1, plotTask: '抵达山门' })
  }

  it('fires the SOP rules with an action and a scope when a reading is recorded', async () => {
    await serializingWithMedians()
    const result = await call('novel_assess', {
      operation: 'record',
      period: 'new-book',
      atChapter: 10,
      metrics: { followRead10: 0.05 },
    })
    const text = String((result['body'] as string[]).join('\n'))
    expect(text).toContain('触发的规则与动作')
    expect(text).toMatch(/改节奏|钩子|加速/u)
    expect(text).toMatch(/范围：(chapter|volume|whole-book)/)
    // Recording is not deciding.
    expect(text).toMatch(/不会自动发生/)
  })

  it('evaluates on demand and hands back a verdict with an appointment', async () => {
    await serializingWithMedians()
    // followRead10 clears its line; followRead24h does not. Only a *core* metric
    // failing is a 不通过, so this is a 部分通过 — change a variable, keep going.
    await call('novel_assess', {
      operation: 'record',
      period: 'new-book',
      atChapter: 10,
      metrics: { followRead10: 0.19, followRead24h: 0.01 },
      baselines: { followRead24h: 0.2 },
    })
    const evaluated = await call('novel_assess', {
      operation: 'evaluate',
      channel: 'platform',
      sampleSize: 400,
      fallback: '阶段二：重写开篇三章',
      abandonIf: '连续两轮调整无效就切书',
      nextAtChapter: 30,
      note: '追读只有中位的四分之一',
    })
    const detail = String(evaluated['detail'])
    expect(detail).toMatch(/第 1 次投入评估/)
    expect(detail).toMatch(/部分通过/)
    expect(detail).toMatch(/换变量后继续/)
    const text = String((evaluated['body'] as string[]).join('\n'))
    expect(text).toContain('下次评估')
    expect(text).toContain('第 30 章')
  })

  it('requires a fallback, an abandon condition, and a next appointment', async () => {
    await serializingWithMedians()
    await call('novel_assess', {
      operation: 'record',
      atChapter: 10,
      metrics: { followRead10: 0.05 },
    })
    await expect(call('novel_assess', { operation: 'evaluate' })).rejects.toThrow(/必须给出 fallback/)
    await expect(
      call('novel_assess', { operation: 'evaluate', fallback: '阶段二' }),
    ).rejects.toThrow(/必须给出 abandonIf/)
    await expect(
      call('novel_assess', { operation: 'evaluate', fallback: '阶段二', abandonIf: '再降就切' }),
    ).rejects.toThrow(/下一次评估的约定/)
  })

  it('does not need a fallback for a passing evaluation, but still asks for an appointment', async () => {
    await serializingWithMedians()
    await call('novel_assess', { operation: 'record', atChapter: 10, metrics: { followRead10: 0.19 } })
    await expect(call('novel_assess', { operation: 'evaluate' })).rejects.toThrow(/下一次评估的约定/)
    const passed = await call('novel_assess', { operation: 'evaluate', nextTrigger: '卷末再看' })
    expect(String(passed['detail'])).toMatch(/通过/)
    expect(String(passed['detail'])).toMatch(/继续投入/)
  })

  it('never moves the project stage: the data check is not a phase', async () => {
    await serializingWithMedians()
    const before = await call('novel_status', {})
    await call('novel_assess', { operation: 'record', atChapter: 10, metrics: { followRead10: 0.05 } })
    await call('novel_assess', {
      operation: 'evaluate',
      fallback: '阶段二',
      abandonIf: '再降就切',
      nextAtChapter: 30,
    })
    const after = await call('novel_status', {})
    expect(after['stage']).toBe(before['stage'])
  })

  it('back-fills the earlier change, so the cut-loss rule is decidable', async () => {
    await serializingWithMedians()
    await call('novel_assess', { operation: 'record', atChapter: 10, metrics: { followRead10: 0.05 } })
    const written = await call('novel_assess', {
      operation: 'iterate',
      trigger: 'tighten-hooks',
      action: '逐章补强章末钩子',
      scope: 'chapter',
      evidence: 'followRead10 = 0.05，低于中位 0.2 × 0.7',
    })
    expect(String(written['detail'])).toMatch(/iteration-1/)

    await call('novel_assess', { operation: 'record', atChapter: 15, metrics: { followRead10: 0.19 } })
    // The evaluation is where the previous change is judged: an on-demand check
    // inherits the job the per-reading outcome operation used to do.
    const evaluated = await call('novel_assess', { operation: 'evaluate', nextAtChapter: 40 })
    const text = String((evaluated['body'] as string[]).join('\n'))
    expect(text).toContain('上次调整的结果')
    expect(text).toMatch(/iteration-1：有效/)
  })

  it('counts ineffective adjustments so the cut-loss rule is decidable', async () => {
    await serializingWithMedians()
    for (let index = 0; index < 3; index += 1) {
      await call('novel_assess', { operation: 'record', atChapter: 10 + index, metrics: { followRead10: 0.05 } })
      await call('novel_assess', { operation: 'iterate', action: `第 ${String(index)} 轮调整`, scope: 'chapter' })
      await call('novel_assess', { operation: 'record', atChapter: 20 + index, metrics: { followRead10: 0.04 } })
      await call('novel_assess', {
        operation: 'evaluate',
        fallback: '阶段二',
        abandonIf: '再降就切',
        nextAtChapter: 20 + index,
      })
    }
    // Two ineffective adjustments plus a failing core metric is the SOP's
    // cut-loss condition; the next reading must name it.
    const text = await callText('novel_assess', {
      operation: 'record',
      atChapter: 40,
      metrics: { followRead10: 0.03, averageReadPerChapter: 0.1 },
    })
    expect(text).toMatch(/切书止损/)
    expect(text).toMatch(/whole-book/)
    const rules = await callText('novel_assess', { operation: 'rules' })
    expect(rules).toContain('触发线')
  })

  it('does not recommend cutting a book that merely dipped below its trigger line', async () => {
    // The SOP requires BOTH halves: ineffective adjustment AND a core metric at
    // half the market median. 0.09 is below the ×0.7 trigger (0.14) but well
    // above half the median (0.1 is the line), so the book is fixable.
    await serializingWithMedians()
    for (let index = 0; index < 3; index += 1) {
      await call('novel_assess', { operation: 'record', atChapter: 10 + index, metrics: { followRead10: 0.09 } })
      await call('novel_assess', { operation: 'iterate', action: `第 ${String(index)} 轮微调`, scope: 'chapter' })
      await call('novel_assess', { operation: 'record', atChapter: 20 + index, metrics: { followRead10: 0.11 } })
      await call('novel_assess', {
        operation: 'evaluate',
        fallback: '阶段二',
        abandonIf: '再降就切',
        nextAtChapter: 20 + index,
      })
    }
    const text = await callText('novel_assess', { operation: 'record', atChapter: 40, metrics: { followRead10: 0.11 } })
    expect(text).not.toMatch(/切书止损/)
  })

  it('reports the thresholds it is actually enforcing', async () => {
    await serializingWithMedians()
    const text = await callText('novel_assess', { operation: 'rules' })
    expect(text).toContain('followRead10：中位 0.2 × 0.7 = 触发线 0.14')
    expect(text).toMatch(/未校准/)
  })

  it('will not judge a reading whose medians are all missing', async () => {
    await call('novel_init', { title: '无校准' })
    const result = await call('novel_assess', {
      operation: 'record',
      period: 'new-book',
      metrics: { readThrough3: 0.4 },
    })
    expect((result['warnings'] as string[]).join(' ')).toMatch(/尚未校准同类中位/)
    const text = await callText('novel_assess', { operation: 'record', metrics: { readThrough3: 0.4 } })
    expect(text).toContain('无法比较')
    // Answering "继续投入" on zero comparable metrics would be inventing a
    // verdict, so the evaluation refuses instead.
    await expect(call('novel_assess', { operation: 'evaluate', nextAtChapter: 20 })).rejects.toThrow(/没有可比的同类中位/)
  })

  it('re-calibrates the medians at the moment the numbers are transcribed', async () => {
    await serializingWithMedians()
    const result = await call('novel_assess', {
      operation: 'record',
      atChapter: 10,
      metrics: { followRead10: 0.05 },
      baselines: { followRead10: 0.25 },
      baselineSource: '本期同榜中位',
    })
    expect(((result['warnings'] as string[] | undefined) ?? []).join(' ')).not.toMatch(/尚未校准/)
    const text = await callText('novel_assess', { operation: 'rules' })
    expect(text).toContain('followRead10：中位 0.25 × 0.7 = 触发线 0.175')
  })

  it('lets the author close one adjustment manually against a named reading', async () => {
    await serializingWithMedians()
    await call('novel_assess', { operation: 'record', atChapter: 10, metrics: { followRead10: 0.05 } })
    await call('novel_assess', { operation: 'iterate', action: '补强钩子', scope: 'chapter' })
    // A reading recorded after the change, judged by hand rather than by the
    // automatic back-fill — the case `evaluate` cannot infer on its own.
    await call('novel_assess', { operation: 'record', atChapter: 15, metrics: { followRead10: 0.18 } })
    await call('novel_assess', { operation: 'evaluate', nextAtChapter: 40 })
    await call('novel_assess', { operation: 'record', atChapter: 22, metrics: { followRead10: 0.19 } })

    const closed = await call('novel_assess', {
      operation: 'outcome',
      iterationId: 'iteration-1',
      outcomeReadingId: 'reading-3',
      note: '第 22 章复查',
    })
    expect(String(closed['detail'])).toMatch(/调整 iteration-1 结果：有效/)
    const stored = JSON.parse(await readFile(join(root, '.novel/novel.json'), 'utf8')) as {
      iterations: { id: string; outcome: string; outcomeReadingId: string; note: string }[]
    }
    const iteration = stored.iterations.find((entry) => entry.id === 'iteration-1')
    expect(iteration?.outcome).toBe('effective')
    expect(iteration?.outcomeReadingId).toBe('reading-3')
    expect(iteration?.note).toBe('第 22 章复查')
  })

  it('refuses to close an adjustment with the reading it started from', async () => {
    await serializingWithMedians()
    await call('novel_assess', { operation: 'record', atChapter: 10, metrics: { followRead10: 0.05 } })
    await call('novel_assess', { operation: 'iterate', action: '补强钩子', scope: 'chapter' })
    // reading-1 is the baseline of iteration-1; closing against it would compare
    // a reading with itself and report nothing. The default reading (the latest,
    // which is also reading-1 here) hits the same guard.
    await expect(
      call('novel_assess', { operation: 'outcome', iterationId: 'iteration-1', outcomeReadingId: 'reading-1' }),
    ).rejects.toThrow(/等于没比较/)
    await expect(call('novel_assess', { operation: 'outcome' })).rejects.toThrow(/等于没比较/)
  })

  it('refuses to close an adjustment when there is nothing to judge against', async () => {
    await call('novel_init', { title: '无读数' })
    await call('novel_assess', { operation: 'iterate', action: '凭直觉改一次', scope: 'chapter' })
    await expect(call('novel_assess', { operation: 'outcome' })).rejects.toThrow(/没有可用于结项的读数/)
  })

  it('judges against the medians transcribed in the same call', async () => {
    await serializingWithMedians()
    await call('novel_assess', { operation: 'record', atChapter: 10, metrics: { followRead10: 0.18 } })
    // 0.18 clears the stored median's line (0.2 × 0.7 = 0.14) but not the one
    // just read off the platform (0.5 × 0.7 = 0.35). The verdict must use the
    // numbers the author transcribed in this call, not last month's.
    const evaluated = await call('novel_assess', {
      operation: 'evaluate',
      baselines: { followRead10: 0.5 },
      fallback: '阶段二',
      abandonIf: '再降就切',
      nextAtChapter: 30,
    })
    expect(String(evaluated['detail'])).toMatch(/不通过/)
    const rules = await callText('novel_assess', { operation: 'rules' })
    expect(rules).toContain('followRead10：中位 0.5 × 0.7 = 触发线 0.35')
  })

  it('suggests an evaluation from project state alone, and never gates on it', async () => {
    await serializingWithMedians()
    // The hint is derived, not measured: it fires on chapter count and on the
    // appointment the previous evaluation left, so it works with no platform
    // access at all.
    const early = await callText('novel_assess', { operation: 'history' })
    expect(early).toContain('还没有做过投入评估')
    expect(early).toMatch(/评估提示：暂不需要/)
  })
})

describe('phase five: serialization and iteration', () => {
  /** A project in serialization with calibrated medians and one written chapter. */
  async function serializing(): Promise<void> {
    await call('novel_init', {
      title: '青云记',
      premise: '少年携断剑上山。',
      baselines: { followRead10: 0.2, averageReadPerChapter: 0.4, chapterScore: 60 },
      baselineSource: '同榜中位',
    })
    await call('novel_plan', { operation: 'outline', logline: '少年上山', minimal: '摘要', acts: ['起'] })
    await call('novel_plan', {
      operation: 'chapter',
      id: 'chapter-1',
      title: '山门',
      number: 1,
      plotTask: '林越抵达山门',
      conflict: '守门弟子不许他进',
      emotionalPayoff: '被接纳的期待',
      infoGap: '为何执意上山',
      beats: ['tension'],
      hook: '山门后传来一声钟响。',
      targetWords: 30,
    })
    await confirmSettings()
  }

  it('writes prose and reports which contract fields the draft reached', async () => {
    await serializing()
    const result = await call('novel_write', {
      chapterId: 'chapter-1',
      body: '山门很高，云雾不散，守门弟子横剑拦住去路，问他凭什么。他没有回答，只是握紧了那把断剑。',
      delivered: ['plotTask', 'conflict', 'hook'],
      status: 'drafting',
    })
    const warnings = (result['warnings'] as string[]).join(' ')
    expect(warnings).toMatch(/未兑现 3 项契约/)
    expect(warnings).toMatch(/emotionalPayoff|infoGap|beats/)

    const read = await callText('novel_write', { operation: 'read', chapterId: 'chapter-1' })
    expect(read).toContain('林越抵达山门')
    expect(read).toContain('山门很高')
  })

  it('warns when a chapter is marked final with an incomplete delivery', async () => {
    await serializing()
    const result = await call('novel_write', {
      chapterId: 'chapter-1',
      body: '山门很高。',
      delivered: ['plotTask'],
      status: 'final',
    })
    const text = String((result['body'] as string[]).join('\n'))
    expect(text).toContain('发布前检查')
    expect(text).toContain('合规自查')
    expect((result['warnings'] as string[]).join(' ')).toMatch(/标记 final/)
  })

  it('drafts to 125% of the target and prints both length gates', async () => {
    await serializing()
    // 38 characters is the draft target for this 30-character chapter: the first
    // draft is written long so that 去 AI 化 and hand-cutting cannot leave the
    // finished chapter short.
    const result = await call('novel_write', {
      chapterId: 'chapter-1',
      body: '甲'.repeat(38),
      delivered: ['plotTask'],
      status: 'drafting',
    })
    const text = String((result['body'] as string[]).join('\n'))
    expect(text).toContain('成稿目标 30 字')
    expect(text).toContain('初稿目标 38 字')
    expect(text).toMatch(/按初稿口径/)
    expect((result['warnings'] as string[]) ?? []).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/低于初稿目标/)]),
    )
  })

  it('calls a draft written to the finished target short of the 125% it needs', async () => {
    await serializing()
    const result = await call('novel_write', {
      chapterId: 'chapter-1',
      body: '甲'.repeat(30),
      delivered: ['plotTask'],
      status: 'drafting',
    })
    const text = String((result['body'] as string[]).join('\n'))
    expect(text).toMatch(/低于初稿目标 38 字/)
    expect(text).toMatch(/初稿要按 125% 写/)
  })

  it('holds a revised chapter to the finished target, not to the draft target', async () => {
    await serializing()
    const result = await call('novel_write', {
      chapterId: 'chapter-1',
      body: '甲'.repeat(30),
      delivered: ['plotTask'],
      status: 'revised',
    })
    const text = String((result['body'] as string[]).join('\n'))
    expect(text).toMatch(/按成稿口径/)
    expect(text).not.toMatch(/低于初稿目标/)
  })

  it('flags a finished chapter that is 10% under target, which a symmetric ±15% would have passed', async () => {
    await serializing()
    const result = await call('novel_write', {
      chapterId: 'chapter-1',
      body: '甲'.repeat(27),
      delivered: ['plotTask'],
      status: 'revised',
    })
    const text = String((result['body'] as string[]).join('\n'))
    expect(text).toContain('允许 29–35 字')
    expect(text).toMatch(/成稿不能比目标少太多/)
  })

  it('reports the 去 AI 化 statistics on every write, and again on check', async () => {
    await serializing()
    const prose = `${'甲'.repeat(221)}\n\n${'乙'.repeat(221)}\n\n${'他看向山门。'.repeat(5)}`
    const written = await call('novel_write', { chapterId: 'chapter-1', body: prose, delivered: ['plotTask'] })
    const writtenText = String((written['body'] as string[]).join('\n'))
    expect(writtenText).toContain('去 AI 化提示')
    expect(writtenText).toContain('超过 220 字')
    expect(writtenText).toContain('以「他看」开头的句子出现 4 次')

    const before = await readFile(join(root, '.novel/novel.json'), 'utf8')
    const checked = await callText('novel_write', { operation: 'check', chapterId: 'chapter-1' })
    expect(checked).toContain('去 AI 化提示')
    expect(checked).toContain('段落平均')
    // `check` reports; it does not touch the stored chapter.
    expect(await readFile(join(root, '.novel/novel.json'), 'utf8')).toBe(before)
  })

})

describe('phase six: promises, retrospective, and reuse', () => {
  it('reports an open promise as overdue once its due chapter is written', async () => {
    await call('novel_init', { title: '青云记' })
    await call('novel_plan', { operation: 'chapter', id: 'chapter-1', title: '山门', number: 1 })
    // A promise is stage-four work in the SOP's list, so it sits behind the same
    // `go` as the outline; this spec is about the overdue check, not the gate.
    await call('novel_plan', { operation: 'launch', verdict: 'go' })
    await call('novel_bible', { kind: 'link', id: 'sword', note: '断剑的来历', dueAt: '1', payoff: '掌门认剑' })
    await confirmSettings()
    const written = await call('novel_write', { chapterId: 'chapter-1', body: '山门很高。' })
    expect((written['warnings'] as string[]).join(' ')).toMatch(/已到回收章仍未回收/)

    const review = await callText('novel_bible', { kind: 'review' })
    expect(review).toContain('逾期')
  })

  it('warns when a promise is planted without a due chapter', async () => {
    await call('novel_init', { title: '青云记' })
    await call('novel_plan', { operation: 'launch', verdict: 'go' })
    const result = await call('novel_bible', { kind: 'link', id: 'sword', note: '断剑的来历' })
    expect((result['warnings'] as string[]).join(' ')).toMatch(/未给 dueAt/)
  })

  it('derives the retrospective, its assets, and a cast-free template', async () => {
    await call('novel_init', { title: '青云记', premise: '少年携断剑上山。' })
    await call('novel_plan', { operation: 'pitch', memorablePoint: '携断剑的少年向上', coreEmotion: '被承认' })
    await call('novel_plan', { operation: 'outline', logline: '少年上山', acts: ['起', '承', '转'] })
    await call('novel_plan', { operation: 'launch', verdict: 'go' })
    await call('novel_plan', {
      operation: 'chapter',
      id: 'chapter-1',
      title: '山门',
      number: 1,
      hook: '山门后传来一声钟响，他忽然发现剑在发烫。',
      body: '山门很高。',
    })
    await call('novel_bible', { kind: 'character', name: '林越', role: 'protagonist', goal: '上山', fear: '被逐', obsession: '证明', weakness: '怕水', growthArc: '外门→执剑' })
    await call('novel_bible', { kind: 'world', name: '青云宗', detail: '正道第一宗', cost: '献祭', limits: '不出山门' })
    await call('novel_bible', { kind: 'link', id: 'sword', note: '断剑的来历', dueAt: '5', payoff: '认剑' })

    await call('novel_repo', { operation: 'retro', highlights: ['开篇冲突有效'], problems: ['第二卷节奏塌了'] })
    await call('novel_repo', { operation: 'lesson', statement: '前三章不要超过两条信息线', lessonKind: 'reuse', area: 'opening' })

    const state = JSON.parse(await readFile(join(root, '.novel/novel.json'), 'utf8')) as {
      retro: { dataSummary: string; assets: { kind: string }[]; lessons: { statement: string }[]; templates: { acts: string[]; note: string; beatPattern: string[] }[] }
    }
    expect(state.retro.dataSummary).toMatch(/共 \d+ 章/)
    expect(state.retro.lessons[0]?.statement).toContain('信息线')
    expect(state.retro.assets.some((asset) => asset.kind === 'character')).toBe(true)
    expect(state.retro.assets.some((asset) => asset.kind === 'setting')).toBe(true)
    expect(state.retro.templates[0]?.acts).toEqual(['起', '承', '转'])
    // The template must not be a clone: it carries structure and says so.
    expect(state.retro.templates[0]?.note).toMatch(/不含人名/)
  })

  it('exports the manuscript and a standalone template', async () => {
    await call('novel_init', { title: '青云记' })
    await call('novel_plan', { operation: 'chapter', id: 'chapter-1', title: '山门', number: 1, body: '山门很高。' })
    const exported = await call('novel_repo', { operation: 'export' })
    expect(String(exported['detail'])).toContain('.novel/manuscript.md')
    expect(await readFile(join(root, '.novel/manuscript.md'), 'utf8')).toContain('# 青云记')

    const template = await call('novel_repo', { operation: 'template' })
    expect(String(template['detail'])).toMatch(/\.novel\/templates\//)
    expect((template['warnings'] as string[]).join(' ')).toMatch(/尚未写复盘/)
  })

  it('reaches the completed stage only once the retrospective exists', async () => {
    await call('novel_init', { title: '青云记', premise: 'x', baselines: { readThrough3: 0.5 } })
    await call('novel_plan', { operation: 'pitch', memorablePoint: 'm', coreEmotion: 'e', shuangPoints: ['s'], differentiators: ['d'], kernel: 'k' })
    for (let index = 0; index < 20; index += 1) {
      await call('novel_plan', { operation: 'competitor', title: `同榜书 ${String(index)}` })
    }
    // The launch decision authorises the full skeleton, so it precedes the
    // outline, volume and beat work below — that ordering is the pipeline's own
    // rule ("go 才解锁阶段四"), not this spec's convenience. The stage machine
    // then reaches serialization on written work alone: a declaration, no reading,
    // no evaluation.
    await call('novel_plan', { operation: 'launch', verdict: 'go' })
    await call('novel_plan', {
      operation: 'outline',
      logline: 'l',
      minimal: 'm',
      acts: ['a'],
      ...SPINE,
      full: true,
    })
    await call('novel_plan', {
      operation: 'volume',
      number: 1,
      title: '第一卷',
      goal: '入门',
      climax: '试炼',
      conflict: 'c',
      endHook: 'h',
      ...VOLUME_SPINE,
    })
    await call('novel_plan', { operation: 'beat', number: 3, beatKind: 'shuang' })
    await call('novel_plan', { operation: 'chapter', id: 'chapter-1', title: '山门', number: 1 })
    for (const key of ['chapter-1-conflict-300', 'chapter-1-hook', 'chapter-2-golden-finger', 'chapter-3-payoff', 'first-10-goal-rival', 'first-10-climax', 'first-30k-unit']) {
      await call('novel_plan', { operation: 'opening', key, done: true })
    }
    await confirmSettings()
    await call('novel_write', { chapterId: 'chapter-1', body: '山门很高。' })

    // The 文风复核 is due once the golden three chapters have prose (here the book
    // plans a single chapter, so that one chapter is the sample), and the stage
    // reports it rather than letting the book run on.
    const gated = await call('novel_status', {})
    expect(gated['stage']).toMatch(/serializing/)
    expect((gated['blockers'] as string[]).join(' ')).toMatch(/复核文风/)
    await confirmStyle()

    const before = await call('novel_status', {})
    expect(before['stage']).toMatch(/serializing/)

    await call('novel_repo', { operation: 'retro' })
    const after = await call('novel_status', {})
    expect(after['stage']).toMatch(/completed/)
    expect(after['blockers']).toEqual([])
  })
})

describe('the workspace the tools read', () => {
  it('follows the calling session, not the deployment root', async () => {
    const other = join(root, 'sibling')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(other, { recursive: true })
    await call('novel_init', { title: 'Root book' })
    await call('novel_init', { title: 'Other book' }, { header: { cwd: other } })

    const rootStatus = String((await call('novel_status', {}))['detail'])
    expect(rootStatus).toContain('Root book')
    const otherStatus = String((await call('novel_status', {}, { header: { cwd: other } }))['detail'])
    expect(otherStatus).toContain('Other book')
  })
})

describe('the file is the source of truth', () => {
  it('adopts a hand-edited contract, and the next write judges against it', async () => {
    await call('novel_init', { title: '青云记', premise: '少年持断剑上山。' })
    await call('novel_plan', {
      operation: 'chapter',
      id: 'chapter-1',
      title: '山门',
      number: 1,
      plotTask: '抵达山门',
      conflict: '守门弟子拦路',
      emotionalPayoff: '被接纳的期待',
      // `infoGap` is deliberately left unanswered: the author edits it in below.
      beats: ['tension'],
      hook: '山门后传来一声钟响。',
    })
    await confirmSettings()
    await call('novel_write', { chapterId: 'chapter-1', body: '山门很高，云雾不散。', delivered: ['plotTask'] })

    // A human edits the chapter-end hook in their own editor. Nothing tells the
    // plugin; the next read simply finds it.
    const planPath = join(root, '章节大纲.md')
    const contractPath = join(root, '章节/第001章-山门.细纲.md')
    const contract = await readFile(contractPath, 'utf8')

    // The check reports contract completeness, computed from the file — so an
    // edit that answers a field the author left open changes the verdict.
    const before = await callText('novel_write', { operation: 'check', chapterId: 'chapter-1' })
    // `infoGap` was left open when the plan was written, so the check lists it.
    expect(before).toMatch(/- infoGap：计划=无/u)

    // Two hand edits at once: one answers an open field, one rewrites the hook.
    const edited = contract
      .replace('## 信息差\n', '## 信息差\n\n父亲当年为何执意上山。\n')
      .replace('山门后传来一声钟响。', '钟声之后，后山传来父亲的剑鸣。')
    await writeFile(contractPath, edited, 'utf8')

    const after = await callText('novel_write', { operation: 'check', chapterId: 'chapter-1' })
    // The hand edit answered it, so the very same check now plans it.
    expect(after).toMatch(/- infoGap：计划=有/u)
    // The hook the author renamed is what the stored chapter carries.
    const stored = JSON.parse(await readFile(join(root, '.novel/novel.json'), 'utf8')) as {
      index: { chapters: Record<string, { outlineFile: string }> }
    }
    expect(stored.index.chapters['chapter-1']?.outlineFile).toBe('章节/第001章-山门.细纲.md')
    expect(await readFile(contractPath, 'utf8')).toContain('钟声之后，后山传来父亲的剑鸣。')
    // The chapter plan file itself is untouched: the edit was in the contract.
    expect(await readFile(planPath, 'utf8')).toContain('山门')
  })

  it('reports a hand-broken file by name and refuses to write over it', async () => {
    await call('novel_init', { title: '青云记' })
    await call('novel_plan', { operation: 'chapter', id: 'chapter-1', title: '山门', number: 1 })
    await confirmSettings()
    await call('novel_write', { chapterId: 'chapter-1', body: '山门很高。', delivered: ['plotTask'] })

    const bodyPath = join(root, '章节/第001章-山门.md')
    const corrupt = '---\nid: "chapter-1"\nnumber: 1\n\n# 第 1 章 山门\n\n正文还在。\n'
    await writeFile(bodyPath, corrupt, 'utf8')

    // The error names the file, and the tool surface does not pretend it succeeded.
    await expect(call('novel_write', { chapterId: 'chapter-1', body: '新正文。' })).rejects.toThrow(/章节\/第001章-山门\.md/u)
    expect(await readFile(bodyPath, 'utf8')).toBe(corrupt)
    await expect(call('novel_status', {})).rejects.toThrow(/章节\/第001章-山门\.md/u)
    expect(await readFile(bodyPath, 'utf8')).toBe(corrupt)
  })

  it('renames the chapter files, and the plan, when the title changes', async () => {
    await call('novel_init', { title: '青云记' })
    await call('novel_plan', { operation: 'chapter', id: 'chapter-1', title: '山门', number: 1, plotTask: '抵达' })
    await confirmSettings()
    await call('novel_write', { chapterId: 'chapter-1', body: '山门很高。', delivered: ['plotTask'] })

    await call('novel_plan', { operation: 'chapter', id: 'chapter-1', title: '山门之下' })

    expect(await readFile(join(root, '章节/第001章-山门之下.md'), 'utf8')).toContain('山门很高。')
    await expect(readFile(join(root, '章节/第001章-山门.md'), 'utf8')).rejects.toThrow()
    expect(await readFile(join(root, '章节大纲.md'), 'utf8')).toContain('山门之下')
    // The chapter is still addressable by its id, which is what did not change.
    const status = await callText('novel_status', { detail: 'chapter', chapterId: 'chapter-1' })
    expect(status).toContain('山门之下')
  })
})
