import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { Config, apply } from '../src/index.ts'

/**
 * `novel_status detail="craft"` is the runtime door to the writing-craft
 * sheets. This pins the door, not the prose in the sheets.
 */
describe('the craft detail', () => {
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
    root = await mkdtemp(join(tmpdir(), 'ai-novelist-craft-'))
    ctx = new Context()
    ctx.plugin(LocalFileSystem, { cwd: root, diffBasisMaxBytes: 64 * 1024 })
    ctx.plugin(recorder)
    for (let attempt = 0; attempt < 100 && ctx.get('tools') === undefined; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    apply(ctx, Config({ workspaceRoot: root }) as never)
    await call('novel_init', { title: '青云记', premise: '少年持断剑上山' })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('lists the sheets, serves one, and names the available topics on a typo', async () => {
    const index = await call('novel_status', { detail: 'craft' })
    const indexText = (index['body'] as string[]).join('\n')
    expect(indexText).toContain('写作知识库')
    expect(indexText).toContain('hooks')

    const hooks = await call('novel_status', { detail: 'craft', topic: 'hooks' })
    expect((hooks['body'] as string[]).join('\n')).toContain('章末钩')

    await expect(call('novel_status', { detail: 'craft', topic: 'nope' })).rejects.toThrow(/unknown craft topic/)
  })
})
