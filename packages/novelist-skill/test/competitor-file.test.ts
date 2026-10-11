import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { DEFAULT_STORAGE_LAYOUT } from '../src/core/paths.ts'
import { decomposeContent, parseCompetitorFile, renderCompetitorFile } from '../src/core/content.ts'
import { emptyOutline } from '../src/core/novel.ts'
import { Config, apply } from '../src/index.ts'

/**
 * `竞品拆解.md`: the competitor study as a file the author can read.
 *
 * The SOP's step 2 asks for 20–50 dismantled titles, and the whole value of the
 * study is that the author goes *back* to it while planning. Keeping it only
 * inside `.novel/novel.json` made that impossible, so these specs pin the two
 * halves of the fix: the codec round-trips every field, and the tool writes the
 * file into the workspace where the author can open it.
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
  root = await mkdtemp(join(tmpdir(), 'ai-novelist-competitor-'))
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

describe('the competitor codec', () => {
  it('round-trips every dismantle field, including the lists', () => {
    const competitor = {
      id: '断剑',
      title: '断剑',
      tags: ['玄幻', '热血'],
      blurb: '少年持断剑上山。',
      openingEvent: '第一章：山门前的拦路',
      goldenFinger: '断剑认主',
      protagonistDesire: '查明父亲死因',
      antagonistMotive: '长老要压住旧案',
      shuangFrequency: '每 3 章一次小爽点',
      emotionCurve: '压抑—抬头—被认可',
      paywallPoint: '第 30 章试剑台',
      chapterHooks: '章末必有未答之问',
      commentKeywords: ['爽', '节奏快'],
      takeaway: '开篇三章内必须给一次小胜',
    }
    const text = renderCompetitorFile({ [competitor.id]: competitor })
    expect(text).toContain('# 竞品拆解')
    expect(text).toContain('## 断剑')
    // The rendered document lists `tags` inline; the reader must get them back.
    expect(text).toContain('tags: ["玄幻", "热血"]')

    const back = parseCompetitorFile(text, DEFAULT_STORAGE_LAYOUT.competitorFile)
    expect(back).toHaveLength(1)
    expect(back?.[0]).toEqual(competitor)
  })

  it('keeps hand-written prose beside an entry as research, not as loss', () => {
    const raw = [
      '# 竞品拆解',
      '',
      '## 断剑',
      '',
      '```yaml',
      'id: 断剑',
      'title: 断剑',
      'goldenFinger: 断剑认主',
      '```',
      '',
      '评论区反复提「节奏快」，但第 12 章之后明显注水。',
      '',
    ].join('\n')
    const back = parseCompetitorFile(raw, DEFAULT_STORAGE_LAYOUT.competitorFile)
    expect(back?.[0]?.goldenFinger).toBe('断剑认主')
    expect(back?.[0]?.takeaway).toContain('注水')
  })

  it('reports a duplicate id by name instead of merging two titles', () => {
    const raw = [
      '# 竞品拆解',
      '',
      '## 甲',
      '',
      '```yaml',
      'id: same',
      'title: 甲',
      '```',
      '',
      '## 乙',
      '',
      '```yaml',
      'id: same',
      'title: 乙',
      '```',
      '',
    ].join('\n')
    expect(() => parseCompetitorFile(raw, '竞品拆解.md')).toThrow(/duplicate competitor id "same"/u)
  })

  it('round-trips a state through the file, so an edit on disk is what is read', () => {
    const state = {
      competitors: [
        {
          id: 'a',
          title: 'A 书',
          tags: [],
          blurb: '',
          openingEvent: '',
          goldenFinger: '签到',
          protagonistDesire: '',
          antagonistMotive: '',
          shuangFrequency: '',
          emotionCurve: '',
          paywallPoint: '',
          chapterHooks: '',
          commentKeywords: [],
          takeaway: '',
        },
      ],
    }
    const text = renderCompetitorFile(Object.fromEntries(state.competitors.map((entry) => [entry.id, entry])))
    const parsed = parseCompetitorFile(text, '竞品拆解.md')
    expect(parsed?.map((entry) => entry.id)).toEqual(['a'])
  })

  it('is one of the content files a state decomposes into', () => {
    const parts = decomposeContent(
      {
        competitors: [],
        characters: {},
        world: {},
        // The core's own empty shape, so a new outline field cannot silently
        // turn this fixture into an undefined read.
        outline: emptyOutline(),
        chapters: {},
      } as never,
      '2024-01-01T00:00:00.000Z',
    )
    expect(parts.competitors).toContain('# 竞品拆解')
  })
})

describe('the competitor study as a file in the workspace', () => {
  it('writes 竞品拆解.md when a competitor is recorded, and the author can read it', async () => {
    await call('novel_init', { title: '青云记' })
    const result = await call('novel_plan', {
      operation: 'competitor',
      title: '断剑',
      tags: ['玄幻'],
      blurb: '少年持断剑上山。',
      goldenFinger: '断剑认主',
      protagonistDesire: '查明父亲死因',
      antagonistMotive: '长老要压住旧案',
      shuangFrequency: '每 3 章',
      emotionCurve: '压抑—被认可',
      paywallPoint: '第 30 章',
      chapterHooks: '章末留问',
      commentKeywords: ['节奏快'],
      takeaway: '开篇给一次小胜',
    })
    expect(String(result['detail'])).toContain('已拆解竞品')

    const file = await readFile(join(root, DEFAULT_STORAGE_LAYOUT.competitorFile), 'utf8')
    expect(file).toContain('# 竞品拆解')
    expect(file).toContain('## 断剑')
    // Frontmatter values are always quoted, so a title beginning with a digit or
    // spelling `true` still reads back as the string it is.
    expect(file).toContain('goldenFinger: "断剑认主"')
    expect(file).toContain('takeaway: "开篇给一次小胜"')
    // The whole point: the author's own eyes, not a JSON blob.
    expect(file).toContain('每 3 章')
  })

  it('adds a second dismantle without dropping the first', async () => {
    await call('novel_init', { title: '青云记' })
    await call('novel_plan', { operation: 'competitor', title: '甲书' })
    await call('novel_plan', { operation: 'competitor', title: '乙书' })

    const file = await readFile(join(root, DEFAULT_STORAGE_LAYOUT.competitorFile), 'utf8')
    expect(file).toContain('## 甲书')
    expect(file).toContain('## 乙书')

    // And the state reads them back from the file.
    const status = await call('novel_status', {})
    expect(status['ok']).toBe(true)
    const dashboard = String((status['body'] as string[]).join('\n'))
    expect(dashboard).toContain(DEFAULT_STORAGE_LAYOUT.competitorFile)
  })

  it('counts a dismantle written by hand in the file toward the 20-title study', async () => {
    await call('novel_init', { title: '青云记' })
    const handWritten = renderCompetitorFile({
      hand: {
        id: 'hand',
        title: '手写的竞品',
        tags: [],
        blurb: '',
        openingEvent: '',
        goldenFinger: '',
        protagonistDesire: '',
        antagonistMotive: '',
        shuangFrequency: '',
        emotionCurve: '',
        paywallPoint: '',
        chapterHooks: '',
        commentKeywords: [],
        takeaway: '',
      },
    })
    await write(join(root, DEFAULT_STORAGE_LAYOUT.competitorFile), handWritten)

    const result = await call('novel_plan', { operation: 'pitch', memorablePoint: 'x' })
    // The stage blocker counts what the project actually holds — including a
    // dismantle typed straight into the file — not what this session wrote.
    expect((result['blockers'] as string[]).join(' ')).toMatch(/竞品拆解不足 20 本，当前 1 本/u)
  })
})

/** Write a workspace-relative file. */
async function write(path: string, text: string): Promise<void> {
  await writeFile(path, text, 'utf8')
}

/**
 * The planning length budgets as the tool reports them.
 *
 * `layerLengthCheck` is specified in `plan.test.ts`; what these specs pin is that
 * `novel_plan` actually *applies* the ratio at the moment a layer is written —
 * with the target the author's own length answers imply, and as a warning rather
 * than a refusal.
 */
describe('novel_plan reports each layer against its length budget', () => {
  /** A project with the length answers the ratios need, and the `go` they sit behind. */
  async function withLengths(): Promise<void> {
    await call('novel_init', {
      title: '青云记',
      targetWords: 1_000_000,
      chapterWords: 3000,
      volumes: 10,
      chaptersPerVolume: 40,
    })
    // The length budgets are checked on stage-four layers, and the SOP opens those
    // only after a declared `go`. This spec is about the budgets, not the gate.
    await call('novel_plan', { operation: 'launch', verdict: 'go' })
  }

  it('budgets 全书大纲 at 1/100 of the total and warns when it is far short', async () => {
    await withLengths()
    const short = await call('novel_plan', { operation: 'outline', logline: '少年上山', fullOutline: '很短。' })
    const text = String((short['body'] as string[]).join('\n'))
    expect(text).toContain('## 全书大纲字数')
    expect(text).toMatch(/低于目标 10000 字（1\/100）/u)
    expect((short['warnings'] as string[]).join(' ')).toMatch(/全书大纲 3 字低于目标 10000 字/u)

    const enough = await call('novel_plan', {
      operation: 'outline',
      fullOutline: '甲'.repeat(10_000),
    })
    expect((enough['warnings'] as string[]).join(' ')).not.toMatch(/低于目标/u)
    expect(String((enough['body'] as string[]).join('\n'))).toMatch(/已达到目标 10000 字/u)
  })

  it('lets an explicit target replace the ratio', async () => {
    await withLengths()
    const explicit = await call('novel_plan', {
      operation: 'outline',
      fullOutline: '甲'.repeat(500),
      targetWords: 500,
    })
    expect((explicit['warnings'] as string[]).join(' ')).not.toMatch(/低于目标/u)
    expect(String((explicit['body'] as string[]).join('\n'))).toMatch(/显式目标/u)
  })

  it('says so instead of inventing a target when 总字数 was never asked', async () => {
    await call('novel_init', { title: '青云记' })
    await call('novel_plan', { operation: 'launch', verdict: 'go' })
    const result = await call('novel_plan', { operation: 'outline', fullOutline: '甲'.repeat(50) })
    expect((result['warnings'] as string[]).join(' ')).toMatch(/总字数还没问用户/u)
  })

  it('budgets 分卷大纲 at 1/50 of the volume it governs', async () => {
    await withLengths()
    // 100 万字 / 3000 字 = 333 章，10 卷 → 每卷 33 章 → 9.9 万字一卷 → 1980 字.
    const result = await call('novel_plan', {
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
    const text = String((result['body'] as string[]).join('\n'))
    expect(text).toContain('## 第 1 卷字数')
    expect(text).toMatch(/低于目标 1980 字（1\/50）/u)
  })

  it('budgets the chapter contract at 1/10 of the chapter, and reports it', async () => {
    await withLengths()
    const result = await call('novel_plan', {
      operation: 'chapter',
      id: 'chapter-1',
      title: '山门',
      number: 1,
      plotTask: '林越抵达山门，被守门弟子拦下。',
      conflict: '守门弟子不许他进。',
      emotionalPayoff: '压抑后的第一次抬头。',
      infoGap: '他为何执意上山。',
      hook: '山门后传来一声钟响，他忽然发现剑在发烫。',
    })
    const text = String((result['body'] as string[]).join('\n'))
    expect(text).toContain('## 本章细纲字数')
    expect(text).toMatch(/建议 300 字/u)
    // The contract above is well under 300 characters, so the disagreement is
    // reported — as a warning, because a short contract can be a deliberate one.
    expect((result['warnings'] as string[]).join(' ')).toMatch(/章节大纲.*低于目标 300 字/u)
  })
})
