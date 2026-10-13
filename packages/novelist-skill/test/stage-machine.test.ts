import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { Config, apply } from '../src/index.ts'
import { STYLE_ARGS } from './style-fixture.ts'
import { SOP_PHASES, addLaunchDecision, emptyNovel, nextStep, skeletonGate } from '../src/core/index.ts'

/**
 * The state machine: what the pipeline refuses, and what it says to do instead.
 *
 * The SOP describes itself as mostly soft-gated — `novel_plan` reports what it
 * would rather you did differently and lets the call stand — with a small number
 * of boundaries it states as rules. Two of them are hard in code:
 *
 * - the **checkpoint** gate in front of the prose (`proseGate`), and
 * - the **launch** gate in front of the full skeleton (`skeletonGate`),
 *
 * and the second is the one that used to be enforced by nothing at all. A project
 * whose author had never decided whether the opening package was worth betting on
 * could still have its volume outline, beat sheet and foreshadowing ledger built.
 *
 * These specs pin both the refusal and the `next` step that tells the model how to
 * get out of it, because a gate that does not say which call opens it is a wall.
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
async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const definition = tools.get(name)
  if (definition === undefined) throw new Error(`tool ${name} is not registered`)
  const exec = { signal: new AbortController().signal }
  return (await definition.execute(args, exec as never)) as Record<string, unknown>
}

/** The `next` step a result carries. */
function nextOf(result: Record<string, unknown>): { action: string; blocked: boolean } {
  return result['next'] as { action: string; blocked: boolean }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ai-novelist-stage-machine-'))
  tools = new Map()
  ctx = new Context()
  ctx.plugin(LocalFileSystem, { cwd: root, diffBasisMaxBytes: 64 * 1024 })
  ctx.plugin(recorder)
  await new Promise((resolve) => setTimeout(resolve, 0))
  apply(ctx, Config({ workspaceRoot: root }) as never)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('the launch gate in front of the full skeleton', () => {
  it('refuses the volume outline, the beat sheet and the full outline without a go', async () => {
    await call('novel_init', { title: '青云记', targetWords: 900000, chapterWords: 3000, volumes: 9 })

    await expect(call('novel_plan', { operation: 'volume', number: 1, goal: '入门' })).rejects.toThrow(
      /novel_plan refused/u,
    )
    await expect(call('novel_plan', { operation: 'beat', number: 3, beatKind: 'shuang' })).rejects.toThrow(
      /novel_plan refused/u,
    )
    await expect(
      call('novel_plan', { operation: 'outline', fullOutline: '甲'.repeat(100), full: true }),
    ).rejects.toThrow(/novel_plan refused/u)
  })

  it('refuses a promise before the launch decision, and names the call that opens it', async () => {
    await call('novel_init', { title: '青云记' })
    await expect(
      call('novel_bible', { kind: 'link', id: 'sword', note: '断剑的来历', dueAt: '5', payoff: '认剑' }),
    ).rejects.toThrow(/novel_plan operation="launch"/u)
  })

  it('leaves the minimal outline alone: only the full skeleton is postponed', async () => {
    await call('novel_init', { title: '青云记' })
    // Stage two is *supposed* to write a minimal viable outline before any launch
    // decision exists, so the gate must not catch it.
    const minimal = await call('novel_plan', { operation: 'outline', logline: '少年上山', minimal: '上山查案' })
    expect(minimal['ok']).toBe(true)
  })

  it('still allows retiring a promise, because clearing one is never the investment', async () => {
    await call('novel_init', { title: '青云记' })
    const removed = await call('novel_bible', { kind: 'link', id: 'ghost', remove: true })
    expect(removed['ok']).toBe(true)
  })

  it('opens once a go is recorded, and refuses again after a revise', async () => {
    await call('novel_init', { title: '青云记', targetWords: 900000, chapterWords: 3000, volumes: 9 })
    await call('novel_plan', { operation: 'launch', verdict: 'go' })
    const opened = await call('novel_plan', { operation: 'volume', number: 1, goal: '入门', climax: '初战' })
    expect(opened['ok']).toBe(true)

    // Re-deciding is a real act: a later `revise` closes the gate again, because
    // the author has withdrawn the authorisation the skeleton was built on.
    await call('novel_plan', {
      operation: 'launch',
      verdict: 'revise',
      fallback: '阶段二 改开篇',
      abandonIf: '三轮改后仍无读者留存',
    })
    await expect(call('novel_plan', { operation: 'beat', number: 3, beatKind: 'shuang' })).rejects.toThrow(
      /不是 go/u,
    )
  })

  it('reads the gate from the same rule the tool enforces', () => {
    const fresh = emptyNovel()
    expect(skeletonGate(fresh, '分卷大纲').allowed).toBe(false)
    // Built through the real transition rather than a literal, so the fixture
    // cannot drift from `LaunchDecision` the way a hand-written object would.
    const decided = addLaunchDecision(fresh, {
      id: 'launch-1',
      at: '2026-01-01T00:00:00.000Z',
      verdict: 'go',
      fallback: '',
      abandonIf: '',
      note: '',
    })
    expect(skeletonGate(decided, '分卷大纲').allowed).toBe(true)
  })
})

describe('the next step the state machine reports', () => {
  it('marks a shut checkpoint gate as blocked, and names the calls that open it', async () => {
    await call('novel_init', { title: '青云记' })
    const status = await call('novel_status', {})
    const next = nextOf(status)
    expect(next.blocked).toBe(true)
    expect(next.action).toMatch(/novel_confirm operation="discuss" kind="settings"/u)
  })

  it('reports the first SOP blocker when no hard gate is shut', async () => {
    // The premise layer is signed off, so the settings gate is open — but the
    // 写作风格 block of the 全书大纲 is a second hard gate in front of the prose
    // (SOP 3.6), and it is shut until the style is written.
    await call('novel_init', { title: '青云记' })
    await call('novel_confirm', {
      operation: 'discuss',
      kind: 'settings',
      proposal: '立意草案',
      feedback: '主角动机再狠一点',
    })
    await call('novel_confirm', {
      operation: 'discuss',
      kind: 'settings',
      proposal: '改后的立意',
      feedback: '可以了',
    })
    await call('novel_confirm', { operation: 'confirm', kind: 'settings', summary: '立意定稿', note: '就这版' })

    const styleShut = nextOf(await call('novel_status', {}))
    expect(styleShut.blocked).toBe(true)
    expect(styleShut.action).toMatch(/styleTone/u)

    // With the style written too, no hard gate is shut and what remains is the
    // rest of phase one's own checklist.
    await call('novel_plan', { operation: 'outline', ...STYLE_ARGS })
    const status = await call('novel_status', {})
    const next = nextOf(status)
    expect(next.blocked).toBe(false)
    expect(next.action).toMatch(/唯一记忆点未写入/u)
  })

  it('derives from project state alone, so a bare project has a next step', () => {
    const step = nextStep(emptyNovel())
    expect(step.blocked).toBe(true)
    expect(step.action.length).toBeGreaterThan(0)
  })
})

describe('the phases the state machine walks', () => {
  it('binds every phase to a real project stage, in order', () => {
    expect(SOP_PHASES.map((phase) => phase.stage)).toEqual([
      'planning',
      'opening-package',
      'opening-decision',
      'full-outline',
      'serializing',
      'completed',
    ])
  })

  it('records that the launch decision is what closes phase three', () => {
    const decision = SOP_PHASES.find((phase) => phase.stage === 'opening-decision')
    expect(decision?.closesWith).toBe('launch')
  })
})
