import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { Config, apply } from '../src/index.ts'

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
  root = await mkdtemp(join(tmpdir(), 'ai-webnovel-sop-'))
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
  }

  it('advances to verification-prep and then blocks on the opening checklist', async () => {
    await completePlanning()
    const atPrep = await call('novel_status', {})
    expect(atPrep['stage']).toMatch(/verification-prep/)
    expect((atPrep['blockers'] as string[]).join(' ')).toMatch(/最小可行大纲/)

    await call('novel_plan', { operation: 'outline', logline: '少年上山', minimal: '一屏摘要', acts: ['起', '承', '转'] })
    await call('novel_plan', { operation: 'chapter', id: 'chapter-1', title: '山门', number: 1, plotTask: '抵达山门' })

    const blocked = await call('novel_status', {})
    expect((blocked['blockers'] as string[]).join(' ')).toMatch(/开篇工程清单/)
  })

  it('will not leave verification-prep until the checklist and the naming candidates exist', async () => {
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
    const beforeNaming = await call('novel_status', {})
    expect((beforeNaming['blockers'] as string[]).join(' ')).toMatch(/读数/)
    for (const [index, title] of ['断剑问心', '剑有记忆', '宗门底层'].entries()) {
      await call('novel_plan', { operation: 'naming', title, blurb: `简介 ${String(index)}`, tags: ['xianxia'] })
    }
    const namingWarning = await call('novel_plan', { operation: 'naming', title: '第四组' })
    expect(((namingWarning['warnings'] as string[]) ?? []).join(' ')).not.toMatch(/备选 3\/3/)
  })
})

describe('phase three: verification', () => {
  /** A project sitting at the verification gate, with medians calibrated. */
  async function readyToVerify(): Promise<void> {
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
  }

  it('computes a passing round when every metric clears its threshold', async () => {
    await readyToVerify()
    const result = await call('novel_verify', {
      operation: 'round',
      channel: 'readers',
      sampleSize: 30,
      atChapter: 3,
      metrics: { readThrough3: 0.45, followRead10: 0.18 },
    })
    expect(result['detail']).toMatch(/通过/)
    expect(result['stage']).toMatch(/full-outline/)
  })

  it('refuses a failing round that does not say where to fall back to', async () => {
    await readyToVerify()
    // readThrough3 0.2 is below median 0.5 × 0.8 = 0.4, and it is a core metric.
    await expect(
      call('novel_verify', {
        operation: 'round',
        channel: 'readers',
        metrics: { readThrough3: 0.2 },
      }),
    ).rejects.toThrow(/必须给出 fallback/)
  })

  it('refuses a failing round that does not say what would make you abandon the concept', async () => {
    await readyToVerify()
    await expect(
      call('novel_verify', {
        operation: 'round',
        channel: 'readers',
        metrics: { readThrough3: 0.2 },
        fallback: '阶段二 改开篇',
      }),
    ).rejects.toThrow(/必须给出 abandonIf/)
  })

  it('records the round, its verdict, and the fallback once both are given', async () => {
    await readyToVerify()
    const result = await call('novel_verify', {
      operation: 'round',
      channel: 'readers',
      metrics: { readThrough3: 0.2, followRead10: 0.05 },
      fallback: '阶段二：重写开篇三章',
      abandonIf: '再验一轮仍低于中位 50% 就换概念',
      note: '读者说前三章信息太密',
    })
    const detail = String(result['detail'])
    expect(detail).toMatch(/不通过/)
    expect(result['stage']).toMatch(/verifying/)
    // The round's fallback and abandon condition are recorded with the round;
    // the dashboard is where they resurface.
    const dashboard = await callText('novel_status', {})
    expect(dashboard).toContain('阶段二：重写开篇三章')
    const assessed = await callText('novel_verify', { operation: 'assess' })
    expect(assessed).toMatch(/低于阈值/)
    expect(assessed).toMatch(/rewrite-opening|改开篇/)
  })

  it('says a reading cannot be judged when no medians are calibrated', async () => {
    await call('novel_init', { title: '无校准' })
    const result = await call('novel_metrics', {
      operation: 'record',
      period: 'new-book',
      metrics: { readThrough3: 0.4 },
    })
    expect((result['warnings'] as string[]).join(' ')).toMatch(/尚未校准同类中位/)
    const text = await callText('novel_metrics', { operation: 'record', metrics: { readThrough3: 0.4 } })
    expect(text).toContain('无法比较')
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

  it('fires the SOP iteration rules with an action and a scope', async () => {
    await serializing()
    const result = await call('novel_metrics', {
      operation: 'record',
      period: 'new-book',
      atChapter: 10,
      metrics: { followRead10: 0.05 },
    })
    const text = String((result['body'] as string[]).join('\n'))
    expect(text).toContain('触发的规则与动作')
    expect(text).toMatch(/改节奏|钩子|加速/u)
    expect(text).toMatch(/范围：(chapter|volume|whole-book)/)
  })

  it('closes the loop: an iteration is written, then judged effective by a later reading', async () => {
    await serializing()
    await call('novel_metrics', { operation: 'record', atChapter: 10, metrics: { followRead10: 0.05 } })
    const written = await call('novel_metrics', {
      operation: 'iterate',
      trigger: 'tighten-hooks',
      action: '逐章补强章末钩子',
      scope: 'chapter',
      evidence: 'followRead10 = 0.05，低于中位 0.2 × 0.7',
    })
    expect(String(written['detail'])).toMatch(/iteration-1/)

    await call('novel_metrics', { operation: 'record', atChapter: 15, metrics: { followRead10: 0.16 } })
    const closed = await call('novel_metrics', { operation: 'outcome', iterationId: 'iteration-1' })
    expect(String(closed['detail'])).toMatch(/有效/)
  })

  it('counts ineffective iterations so the cut-loss rule is decidable', async () => {
    await serializing()
    for (let index = 0; index < 3; index += 1) {
      await call('novel_metrics', { operation: 'record', atChapter: 10 + index, metrics: { followRead10: 0.05 } })
      await call('novel_metrics', { operation: 'iterate', action: `第 ${String(index)} 轮调整`, scope: 'chapter' })
      await call('novel_metrics', { operation: 'record', atChapter: 20 + index, metrics: { followRead10: 0.04 } })
      await call('novel_metrics', { operation: 'outcome', iterationId: `iteration-${String(index + 1)}` })
    }
    // Two ineffective iterations plus a failing core metric is the SOP's
    // cut-loss condition; the next reading must name it.
    const text = await callText('novel_metrics', {
      operation: 'record',
      atChapter: 40,
      metrics: { followRead10: 0.03, averageReadPerChapter: 0.1 },
    })
    expect(text).toMatch(/切书止损/)
    expect(text).toMatch(/whole-book/)
    const rules = await callText('novel_metrics', { operation: 'rules' })
    expect(rules).toContain('触发线')
  })

  it('does not recommend cutting a book that merely dipped below its trigger line', async () => {
    // The SOP requires BOTH halves: ineffective adjustment AND a core metric at
    // half the market median. 0.09 is below the ×0.7 trigger (0.14) but well
    // above half the median (0.1 is the line), so the book is fixable.
    await serializing()
    for (let index = 0; index < 3; index += 1) {
      await call('novel_metrics', { operation: 'record', atChapter: 10 + index, metrics: { followRead10: 0.09 } })
      await call('novel_metrics', { operation: 'iterate', action: `第 ${String(index)} 轮微调`, scope: 'chapter' })
      await call('novel_metrics', { operation: 'record', atChapter: 20 + index, metrics: { followRead10: 0.11 } })
      await call('novel_metrics', { operation: 'outcome', iterationId: `iteration-${String(index + 1)}` })
    }
    const text = await callText('novel_metrics', { operation: 'record', atChapter: 40, metrics: { followRead10: 0.11 } })
    expect(text).not.toMatch(/切书止损/)
  })

  it('reports the thresholds it is actually enforcing', async () => {
    await serializing()
    const text = await callText('novel_metrics', { operation: 'rules' })
    expect(text).toContain('followRead10：中位 0.2 × 0.7 = 触发线 0.14')
    expect(text).toMatch(/未校准/)
  })
})

describe('phase six: promises, retrospective, and reuse', () => {
  it('reports an open promise as overdue once its due chapter is written', async () => {
    await call('novel_init', { title: '青云记' })
    await call('novel_plan', { operation: 'chapter', id: 'chapter-1', title: '山门', number: 1 })
    await call('novel_bible', { kind: 'link', id: 'sword', note: '断剑的来历', dueAt: '1', payoff: '掌门认剑' })
    const written = await call('novel_write', { chapterId: 'chapter-1', body: '山门很高。' })
    expect((written['warnings'] as string[]).join(' ')).toMatch(/已到回收章仍未回收/)

    const review = await callText('novel_bible', { kind: 'review' })
    expect(review).toContain('逾期')
  })

  it('warns when a promise is planted without a due chapter', async () => {
    await call('novel_init', { title: '青云记' })
    const result = await call('novel_bible', { kind: 'link', id: 'sword', note: '断剑的来历' })
    expect((result['warnings'] as string[]).join(' ')).toMatch(/未给 dueAt/)
  })

  it('derives the retrospective, its assets, and a cast-free template', async () => {
    await call('novel_init', { title: '青云记', premise: '少年携断剑上山。' })
    await call('novel_plan', { operation: 'pitch', memorablePoint: '携断剑的少年向上', coreEmotion: '被承认' })
    await call('novel_plan', { operation: 'outline', logline: '少年上山', acts: ['起', '承', '转'] })
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
    await call('novel_plan', { operation: 'outline', logline: 'l', minimal: 'm', acts: ['a'], full: true })
    await call('novel_plan', { operation: 'volume', number: 1, title: '第一卷', goal: '入门', climax: '试炼', conflict: 'c', endHook: 'h' })
    await call('novel_plan', { operation: 'beat', number: 3, beatKind: 'shuang' })
    await call('novel_plan', { operation: 'chapter', id: 'chapter-1', title: '山门', number: 1 })
    for (const key of ['chapter-1-conflict-300', 'chapter-1-hook', 'chapter-2-golden-finger', 'chapter-3-payoff', 'first-10-goal-rival', 'first-10-climax', 'first-30k-unit']) {
      await call('novel_plan', { operation: 'opening', key, done: true })
    }
    await call('novel_verify', { operation: 'round', channel: 'readers', metrics: { readThrough3: 0.45 } })
    await call('novel_write', { chapterId: 'chapter-1', body: '山门很高。' })

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
