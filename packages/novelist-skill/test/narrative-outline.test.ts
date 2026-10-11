import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { Config, apply } from '../src/index.ts'

/**
 * Narrative completeness as the tools report it: story first, payoffs second,
 * length last.
 *
 * These pin the sequence rather than the wording, because the sequence *is* the
 * rule: an outline that cannot tell its story has nothing for a 爽点 schedule or
 * a word-count target to be attached to, so the report has to say so before it
 * says anything about numbers. The book that motivated the change was 20k
 * characters long, exceeded its 1/100 target, and never told the story.
 */
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
  return (await definition.execute(args, { signal: new AbortController().signal } as never)) as Record<
    string,
    unknown
  >
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ai-novelist-narrative-'))
  ctx = new Context()
  ctx.plugin(LocalFileSystem, { cwd: root, diffBasisMaxBytes: 64 * 1024 })
  ctx.plugin(recorder)
  await until(() => ctx.get('tools') !== undefined)
  apply(ctx, Config({ workspaceRoot: root }) as never)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function until<T>(read: () => T | undefined, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('timed out waiting for the service')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/**
 * A project with the four length answers settled, so every target is computable.
 *
 * It also carries the author's `go`: the full skeleton is stage-four work, and the
 * SOP authorises `outline full=true`, `volume` and `beat` only after a declared
 * launch decision. These specs are about what the outline layers report, not about
 * the gate in front of them, so they record the decision they would have had.
 */
async function withLengths(): Promise<void> {
  await call('novel_init', {
    title: '青云记',
    targetWords: 1_000_000,
    chapterWords: 3000,
    volumes: 10,
    chaptersPerVolume: 40,
  })
  await call('novel_plan', { operation: 'launch', verdict: 'go' })
}

/** The whole-book spine, every element answered. */
const SPINE: Record<string, string> = {
  synopsis: '少年背着断剑上山，查清父亲的死因，最后把山门里那笔旧账翻了过来。',
  protagonistArc: '从只想问清死因，到愿意替别人扛事。',
  supportArcs: '同门阿吉从怕事到敢作证。',
  antagonistArc: '长老从压住旧案到被逼出手，败在自己留下的证据上。',
  factionShift: '后山一脉从旁观到分裂，前山成军。',
  conflictArcs: '试剑台认主、后山夜战、账房对质——三场对抗各有一次奇遇与一次代价。',
  costs: '他失去了隐姓埋名查案的可能，也失去了教他剑的师兄。',
  gains: '断剑认主、一个肯作证的同门、一条翻案的线索。',
}

const VOLUME_SPINE: Record<string, string> = {
  synopsis: '林越上山、被拦、入门，卷末在试剑台上让断剑认主。',
  protagonistArc: '从散修变成门内弟子。',
  antagonistArc: '长老第一次出手试探。',
  factionShift: '门内两派开始成形。',
  mainConflict: '入门试炼与试剑台比试。',
  costs: '失去了自由身与隐姓埋名的余地。',
  gains: '得了一个身份和一个肯说话的同门。',
}

describe('novel_plan reports the story before the numbers', () => {
  it('names every missing narrative element, and says so before the word count', async () => {
    await withLengths()
    const result = await call('novel_plan', { operation: 'outline', logline: '少年上山', fullOutline: '很短。' })
    const text = String((result['body'] as string[]).join('\n'))

    expect(text).toContain('## 叙事完整性')
    // The word-count block is still printed — it is advice, not a gate — but it
    // comes after the story's own debts.
    expect(text).toContain('## 全书大纲字数')
    expect(text.indexOf('## 叙事完整性')).toBeLessThan(text.indexOf('## 全书大纲字数'))
    // Every element is listed with its requirement, answered or not.
    expect(text).toMatch(/⬜ 故事梗概/)
    expect(text).toMatch(/⬜ 阵营演变/)
    expect(text).toMatch(/整本书从开头到结局讲一遍/u)
    expect((result['warnings'] as string[]).join(' ')).toMatch(/叙事骨架还缺 8 项/u)
    expect((result['warnings'] as string[]).join(' ')).toMatch(/先讲完故事，再看爽点与字数/u)
  })

  it('clears the spine warning once all eight elements are written', async () => {
    await withLengths()
    const result = await call('novel_plan', {
      operation: 'outline',
      logline: '少年上山',
      fullOutline: '甲'.repeat(10_000),
      ...SPINE,
    })
    const warnings = (result['warnings'] as string[]).join(' ')
    expect(warnings).not.toMatch(/叙事骨架还缺/u)
    // The length line is still reported, now on its own terms.
    expect(String((result['body'] as string[]).join('\n'))).toMatch(/已达到目标 10000 字/u)
  })

  it('reports the payoff schedule after the spine, and before the word count', async () => {
    await withLengths()
    const result = await call('novel_plan', {
      operation: 'outline',
      logline: '少年上山',
      fullOutline: '甲'.repeat(10_000),
      ...SPINE,
    })
    const text = String((result['body'] as string[]).join('\n'))
    const warnings = (result['warnings'] as string[]).join(' ')
    // No beats and no volumes yet: the 爆点 has no landing point, and the tool
    // says that rather than reporting a long outline as done.
    expect(warnings).toMatch(/爽点与爆点还没讲清/u)
    expect(warnings).toMatch(/情绪节拍表为空/u)
    expect(text.indexOf('## 叙事完整性')).toBeLessThan(text.indexOf('## 全书大纲字数'))
  })

  it('asks a volume for its own story, then reports its length', async () => {
    await withLengths()
    const short = await call('novel_plan', {
      operation: 'volume',
      number: 1,
      title: '第一卷',
      detail: '很短。',
      goal: '入门',
      conflict: '试炼',
      climax: '登顶',
      endHook: '钟响',
      chapters: [1, 40],
    })
    const text = String((short['body'] as string[]).join('\n'))
    expect(text).toContain('## 第 1 卷叙事完整性')
    expect(text).toContain('## 第 1 卷字数')
    expect(text.indexOf('## 第 1 卷叙事完整性')).toBeLessThan(text.indexOf('## 第 1 卷字数'))
    expect((short['warnings'] as string[]).join(' ')).toMatch(/第 1 卷的叙事骨架还缺 7 项/u)

    const full = await call('novel_plan', {
      operation: 'volume',
      number: 1,
      title: '第一卷',
      detail: '很短。',
      goal: '入门',
      conflict: '试炼',
      climax: '登顶',
      endHook: '钟响',
      chapters: [1, 40],
      ...VOLUME_SPINE,
    })
    expect((full['warnings'] as string[]).join(' ')).not.toMatch(/叙事骨架还缺/u)
  })

  it('asks a chapter contract for its turn and its price', async () => {
    await withLengths()
    const bare = await call('novel_plan', {
      operation: 'chapter',
      id: 'chapter-1',
      title: '山门',
      number: 1,
      plotTask: '林越抵达山门，被守门弟子拦下。',
      conflict: '守门弟子不许他进。',
      emotionalPayoff: '压抑后的第一次抬头。',
      infoGap: '他为何执意上山。',
      hook: '山门后传来一声钟响，他忽然发现剑在发烫。',
      beats: ['tension'],
    })
    expect((bare['warnings'] as string[]).join(' ')).toMatch(/契约缺：keyBeat、price/u)

    const answered = await call('novel_plan', {
      operation: 'chapter',
      id: 'chapter-1',
      keyBeat: '他第一次为了别人而不是父亲的死因出手。',
      price: '他把仅剩的盘缠留给了同门。',
    })
    expect((answered['warnings'] as string[]).join(' ')).not.toMatch(/契约缺/u)

    // A transitional chapter can waive them, but only out loud.
    const waived = await call('novel_plan', {
      operation: 'chapter',
      id: 'chapter-1',
      waive: ['keyBeat', 'price'],
      waiveReason: '纯过渡章，两条线都不动',
    })
    expect((waived['warnings'] as string[]).join(' ')).not.toMatch(/契约缺/u)
  })
})

describe('the narrative spine survives the file round trip', () => {
  it('writes the whole-book spine under named headings, and reads it back', async () => {
    await withLengths()
    await call('novel_plan', { operation: 'outline', logline: '少年上山', ...SPINE })

    const text = await readFile(join(root, '全书大纲.md'), 'utf8')
    expect(text).toContain('## 叙事骨架')
    expect(text).toContain('### 故事梗概')
    expect(text).toContain('### 对抗副本')
    expect(text).toContain(SPINE['conflictArcs'] as string)

    // Reading back through novel_status proves the parse, not just the render.
    const status = await call('novel_status', { detail: 'plan' })
    const body = String((status['body'] as string[]).join('\n'))
    expect(body).toContain('## 叙事完整性（全书）')
    expect(body).toMatch(/✅ 故事梗概/)
    expect(body).toMatch(/✅ 对抗副本/)
  })

  it('writes a volume spine as subsections of the volume entry, and does not turn it into a second volume', async () => {
    await withLengths()
    await call('novel_plan', {
      operation: 'volume',
      number: 1,
      title: '第一卷',
      detail: '卷一从前山石阶写到试剑台。',
      goal: '入门',
      conflict: '试炼',
      climax: '登顶',
      endHook: '钟响',
      chapters: [1, 40],
      ...VOLUME_SPINE,
    })

    const text = await readFile(join(root, '分卷大纲.md'), 'utf8')
    expect(text).toContain('### 本卷梗概')
    expect(text).toContain(VOLUME_SPINE['synopsis'] as string)
    // The entry stays one entry: exactly one `##` heading, the volume itself.
    expect(text.match(/^## /gmu)).toHaveLength(1)

    const status = await call('novel_status', { detail: 'plan' })
    const body = String((status['body'] as string[]).join('\n'))
    expect(body).toMatch(/第 1 卷「第一卷」/)
    expect(body).toMatch(/叙事骨架：完整/)
    // The pacing detail is not swallowed by the last spine element.
    expect(body).not.toMatch(/分卷大纲共缺 [1-9]/u)
  })

  it('keeps an element it was not asked to change', async () => {
    await withLengths()
    await call('novel_plan', { operation: 'volume', number: 1, title: '第一卷', ...VOLUME_SPINE })
    // A later call that only renames the volume must not wipe its story.
    await call('novel_plan', { operation: 'volume', number: 1, title: '第一卷·改' })
    const status = await call('novel_status', { detail: 'plan' })
    const body = String((status['body'] as string[]).join('\n'))
    expect(body).toMatch(/第 1 卷「第一卷·改」/)
    expect(body).toMatch(/叙事骨架：完整/)
  })
})
