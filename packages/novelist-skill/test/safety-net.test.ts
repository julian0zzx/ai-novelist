import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { Config, apply } from '../src/index.ts'
import { STYLE_ARGS } from './style-fixture.ts'

/**
 * The three safety nets, driven through the tools a model actually calls.
 *
 * Each one answers a failure the rest of the project could not see: an overwrite
 * that destroyed a draft, a chapter dated before the one it follows, and a typo
 * that no amount of prose judgement would catch.
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
  return (await definition.execute(args, { signal: new AbortController().signal } as never)) as Record<string, unknown>
}

/** The body lines a tool produced, joined for assertions. */
function text(value: Record<string, unknown>): string {
  const body = value['body']
  return Array.isArray(body) ? (body as string[]).join('\n') : ''
}

/** Wait for a service to appear on the context. */
async function until<T>(read: () => T | undefined, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('service did not appear')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** Open the prose gate: the premise signed off, and the style block written. */
async function openGate(): Promise<void> {
  await call('novel_confirm', {
    operation: 'discuss',
    kind: 'settings',
    proposal: '沉默少年持断剑上山。',
    feedback: '主角再冷一点，别喊口号。',
  })
  await call('novel_confirm', {
    operation: 'discuss',
    kind: 'settings',
    proposal: '按你的意见改成沉默寡言。',
    feedback: '可以，就按这版来。',
  })
  await call('novel_confirm', {
    operation: 'confirm',
    kind: 'settings',
    summary: '沉默少年持断剑上山，冷开局。',
    note: '可以，就按这版来。',
  })
  await call('novel_plan', { operation: 'outline', ...STYLE_ARGS })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ai-novelist-safety-'))
  ctx = new Context()
  ctx.plugin(LocalFileSystem, { cwd: root, diffBasisMaxBytes: 64 * 1024 })
  ctx.plugin(recorder)
  await until(() => ctx.get('tools') !== undefined)
  apply(ctx, Config({ workspaceRoot: root }) as never)
  await call('novel_init', { title: '青云记', premise: '少年持断剑上山' })
  await openGate()
  await call('novel_plan', { operation: 'chapter', number: 1, id: 'ch1', title: '上山', plotTask: '上山', timeAnchor: '第五日 黄昏', place: '山门' })
  await call('novel_plan', { operation: 'chapter', number: 2, id: 'ch2', title: '查案', plotTask: '查案', timeAnchor: '第三日 清晨', place: '账房' })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('the overwrite archive', () => {
  it('keeps the replaced draft, and says where it went', async () => {
    await call('novel_write', { chapterId: 'ch1', body: '他把帐号写在纸上，手在抖。' })
    const second = await call('novel_write', { chapterId: 'ch1', body: '他把账号写在纸上，夜还没过。' })
    expect(text(second)).toContain('上一版正文已存档')
    expect(text(second)).toContain('.novel/versions')

    const files = await readdir(join(root, '.novel', 'versions'))
    expect(files).toHaveLength(1)
    const archived = await readFile(join(root, '.novel', 'versions', files[0] ?? ''), 'utf8')
    expect(archived).toContain('被覆盖前的存档')
    expect(archived).toContain('他把帐号写在纸上，手在抖。')
  })

  it('archives nothing when the chapter had no prose yet', async () => {
    await call('novel_write', { chapterId: 'ch1', body: '他把账号写在纸上。' })
    const files = await readdir(join(root, '.novel', 'versions')).catch(() => [])
    expect(files).toEqual([])
  })
})

describe('the timeline check', () => {
  it('reports a chapter dated before the one it follows', async () => {
    const review = await call('novel_bible', { kind: 'review' })
    expect(text(review)).toContain('时间线：已解析 2 章，逆序 1 处')
    expect(text(review)).toContain('第 2 章「第三日 清晨」早于第 1 章')
  })
})

describe('the proofreading pass', () => {
  it('names the wrong spelling on the write result', async () => {
    const written = await call('novel_write', { chapterId: 'ch1', body: '他把帐号写在纸上。' })
    expect(text(written)).toContain('校对：疑似错别字 1 处')
    expect(text(written)).toContain('「帐号」→「账号」')
  })

  it('aggregates across chapters in the submission package', async () => {
    await call('novel_write', { chapterId: 'ch1', body: '他把帐号写在纸上。' })
    await call('novel_write', { chapterId: 'ch2', body: '他的时侯不多了。' })
    const submission = await call('novel_repo', { operation: 'submission' })
    expect(text(submission)).toContain('投稿包已生成')
    const packageText = await readFile(join(root, '.novel', 'submission.md'), 'utf8')
    expect(packageText).toContain('## 五、自动校对（确定性规则，可整批替换）')
    expect(packageText).toContain('疑似错别字 2 处')
    expect(packageText).toContain('「帐号」→「账号」×1')
    expect(packageText).toContain('「时侯」→「时候」×1')
  })
})
