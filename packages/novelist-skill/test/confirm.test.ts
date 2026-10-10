import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { Config, apply } from '../src/index.ts'

/**
 * The two author checkpoints, driven end to end through the tool surface.
 *
 * This is the spec for the one failure the rest of the plugin could not catch:
 * a model that takes a one-line inspiration, decides the whole setup itself and
 * runs on to chapters. The soft gates everywhere else report a disagreement and
 * let the call stand, which is exactly how that happened; `novel_write` is
 * therefore the one hard gate, and these specs pin down both what it refuses and
 * what it takes to open it.
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
  return (await definition.execute(args, { signal: new AbortController().signal } as never)) as Record<
    string,
    unknown
  >
}

/** The rendered text of one tool call, for asserting what the model is told. */
async function callText(name: string, args: Record<string, unknown>): Promise<string> {
  const definition = tools.get(name)
  if (definition === undefined) throw new Error(`tool ${name} is not registered`)
  const value = (await definition.execute(args, { signal: new AbortController().signal } as never)) as Record<
    string,
    unknown
  >
  return definition.output
    .render(args, value as never)
    .map((block) => ('text' in block ? block.text : ''))
    .join('\n')
    // The body arrives as one text block whose payload is a line array; the
    // assertions below read it as prose, not as JSON.
    .replace(/\\n/gu, '\n')
}

/** A project with one planned chapter, signed off exactly as far as asked. */
async function seeded(options: { readonly confirmSettings?: boolean } = {}): Promise<void> {
  await call('novel_init', {
    title: '我在梦里开无双，醒了还要交房租',
    premise: '穷困潦倒的租客发现自己在梦里无所不能。',
  })
  await call('novel_plan', { operation: 'chapter', id: 'chapter-1', title: '房租', number: 1, plotTask: '交租' })
  await call('novel_plan', { operation: 'chapter', id: 'chapter-2', title: '梦醒', number: 2, plotTask: '醒来' })
  if (options.confirmSettings !== false) await signSettingsOff()
}

/** Two recorded rounds carrying the user's own words, then the sign-off. */
async function signPremiseOff(): Promise<void> {
  await call('novel_confirm', {
    operation: 'discuss',
    kind: 'settings',
    proposal: '第一版：梦里开无双，醒来交房租。',
    feedback: '别写成纯爽文，房租这条线要一直在。',
    topics: ['立意'],
  })
  await call('novel_confirm', {
    operation: 'discuss',
    kind: 'settings',
    proposal: '改了：每个梦境的收益都要折成现实里的房租。',
    feedback: '对，就这个。',
    topics: ['设定'],
  })
  await call('novel_confirm', {
    operation: 'confirm',
    kind: 'settings',
    summary: '梦境收益折现交房租，爽点与窘迫交替。',
    note: '对，就这个。',
  })
}

/**
 * Close every settings layer, in the SOP's order.
 *
 * The stage machine only leaves 阶段一 once 世界观、人物设定、全书大纲、分卷大纲 are
 * each confirmed, so a spec that wants to see the next phase has to walk them.
 */
async function signSettingsOff(): Promise<void> {
  await signPremiseOff()
  for (const [kind, label] of [
    ['world', '世界观设定'],
    ['cast', '人物设定'],
    ['outline', '全书大纲'],
    ['volume', '分卷大纲'],
  ] as const) {
    await call('novel_confirm', {
      operation: 'discuss',
      kind,
      proposal: `${label}这一层的第一版。`,
      feedback: '这一层可以。',
      topics: [label],
    })
    await call('novel_confirm', { operation: 'confirm', kind, summary: `${label}定稿。`, note: '这一层可以。' })
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ai-novelist-confirm-'))
  ctx = new Context()
  ctx.plugin(LocalFileSystem, { cwd: root, diffBasisMaxBytes: 64 * 1024 })
  ctx.plugin(recorder)
  await until(() => ctx.get('tools') !== undefined)
  apply(ctx, Config({ workspaceRoot: root }) as never)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
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

describe('the settings checkpoint in front of the prose', () => {
  it('refuses to write a chapter while the user has never signed the settings off', async () => {
    await seeded({ confirmSettings: false })
    await expect(call('novel_write', { chapterId: 'chapter-1', body: '房东在门外敲门。' })).rejects.toThrow(
      /设定还没有经过用户确认/u,
    )
    // The refusal is actionable: it names the calls that open the gate.
    await expect(call('novel_write', { chapterId: 'chapter-1', body: '房东在门外敲门。' })).rejects.toThrow(
      /novel_confirm operation="discuss" kind="settings"/u,
    )
  })

  it('records a discussion round only when the user actually said something', async () => {
    await seeded({ confirmSettings: false })
    await expect(
      call('novel_confirm', { operation: 'discuss', kind: 'settings', proposal: '我定好了：就这样写。' }),
    ).rejects.toThrow(/feedback/u)
    await expect(call('novel_confirm', { operation: 'discuss', kind: 'settings', feedback: '   ' })).rejects.toThrow(
      /feedback/u,
    )
  })

  it('refuses to confirm before the rounds that justify it exist', async () => {
    await seeded({ confirmSettings: false })
    await expect(
      call('novel_confirm', { operation: 'confirm', kind: 'settings', summary: '就这样' }),
    ).rejects.toThrow(/还差 2 轮/u)

    await call('novel_confirm', {
      operation: 'discuss',
      kind: 'settings',
      proposal: '第一版',
      feedback: '房租线要一直在',
    })
    // One round is a monologue with an answer; the SOP asks for a conversation.
    await expect(
      call('novel_confirm', { operation: 'confirm', kind: 'settings', summary: '就这样' }),
    ).rejects.toThrow(/还差 1 轮/u)

    await call('novel_confirm', {
      operation: 'discuss',
      kind: 'settings',
      proposal: '改好了',
      feedback: '可以',
    })
    const confirmed = await call('novel_confirm', {
      operation: 'confirm',
      kind: 'settings',
      summary: '梦境收益折现交房租',
      note: '可以',
    })
    expect(String(confirmed['detail'])).toMatch(/设定已确认/u)
  })

  it('needs the approved version AND the user\'s own words to confirm', async () => {
    await seeded({ confirmSettings: false })
    await call('novel_confirm', { operation: 'discuss', kind: 'settings', proposal: 'a', feedback: 'b' })
    await call('novel_confirm', { operation: 'discuss', kind: 'settings', proposal: 'c', feedback: 'd' })
    // The summary is the reference later chapters are held to…
    await expect(call('novel_confirm', { operation: 'confirm', kind: 'settings', note: '可以' })).rejects.toThrow(
      /summary/u,
    )
    // …and the note is the author actually speaking. Neither may be supplied by
    // the tool on the author's behalf.
    await expect(
      call('novel_confirm', { operation: 'confirm', kind: 'settings', summary: '就这样' }),
    ).rejects.toThrow(/note/u)
  })

  it('writes the prose once the checkpoint is closed, and keeps the ledger on disk', async () => {
    await seeded()
    const written = await call('novel_write', { chapterId: 'chapter-1', body: '房东在门外敲门。' })
    expect(String(written['detail'])).toMatch(/第 1 章已写入/u)

    const stored = JSON.parse(await readFile(join(root, '.novel/novel.json'), 'utf8')) as {
      discussions: { kind: string; feedback: string }[]
      confirmations: { kind: string; summary: string; rounds: number }[]
    }
    // One round per settings layer, in the SOP's order, and nothing skipped: the
    // premise's two rounds are recorded under its `settings` spelling.
    expect(stored.discussions.map((round) => round.kind)).toEqual([
      'settings',
      'settings',
      'world',
      'cast',
      'outline',
      'volume',
    ])
    expect(stored.discussions[0]?.feedback).toContain('房租')
    expect(stored.confirmations.map((entry) => entry.kind)).toEqual([
      'settings',
      'world',
      'cast',
      'outline',
      'volume',
    ])
    expect(stored.confirmations[0]).toMatchObject({ kind: 'settings', rounds: 2 })
    expect(stored.confirmations[0]?.summary).toContain('房租')
  })

  it('holds the SOP stage at phase one until the setup is signed off', async () => {
    await seeded({ confirmSettings: false })
    await call('novel_plan', {
      operation: 'pitch',
      memorablePoint: '梦里的神，现实里的租客',
      coreEmotion: '窘迫与翻盘的落差',
      shuangPoints: ['打脸'],
      differentiators: ['梦境收益折现'],
      kernel: '钱不是尊严的全部，但没有钱就没有尊严',
    })
    for (let index = 0; index < 20; index += 1) {
      await call('novel_plan', { operation: 'competitor', title: `同榜书 ${String(index)}` })
    }
    const pending = await call('novel_status', {})
    expect(pending['stage']).toMatch(/planning/u)
    expect((pending['blockers'] as string[]).join(' ')).toMatch(/设定还差 2 轮/u)

    await signSettingsOff()
    const advanced = await call('novel_status', {})
    expect(advanced['stage']).toMatch(/opening-package/u)
  })

  it('reports the checkpoints on the dashboard and in the tool envelope', async () => {
    await seeded({ confirmSettings: false })
    const dashboard = await callText('novel_status', {})
    expect(dashboard).toContain('设定分层确认（按顺序）')
    // Every layer is named, and the one in turn is marked — that is what makes
    // "按顺序与用户讨论" something the author can see rather than infer.
    expect(dashboard).toMatch(/立意与核心设定：未确认（已讨论 0\/2 轮/u)
    expect(dashboard).toMatch(/世界观设定：未确认/u)
    expect(dashboard).toMatch(/人物设定：未确认/u)
    expect(dashboard).toContain('← 现在这一层')
    expect(dashboard).toContain('竞品拆解.md')

    const status = await call('novel_status', {})
    expect((status['blockers'] as string[]).join(' ')).toMatch(/设定还差 2 轮/u)
  })
})

describe('the voice checkpoint after chapter 1', () => {
  it('refuses chapter 2 until the user has heard the voice', async () => {
    await seeded()
    await call('novel_write', { chapterId: 'chapter-1', body: '房东在门外敲门。' })

    await expect(call('novel_write', { chapterId: 'chapter-2', body: '梦里他站在楼顶。' })).rejects.toThrow(
      /确认文风/u,
    )
    // Chapter 1 stays revisable: the checkpoint is about running on, not about
    // freezing the chapter the user is being asked about.
    const revised = await call('novel_write', { chapterId: 'chapter-1', body: '房东在门外砸门。' })
    expect(String(revised['detail'])).toMatch(/第 1 章已写入/u)
  })

  it('refuses to confirm a voice before there is a chapter to hear it in', async () => {
    await seeded()
    await call('novel_confirm', {
      operation: 'discuss',
      kind: 'style',
      proposal: '我打算用短句。',
      feedback: '可以',
    })
    await expect(
      call('novel_confirm', { operation: 'confirm', kind: 'style', summary: '短句为主' }),
    ).rejects.toThrow(/第 1 章成稿/u)
  })

  it('opens the rest of the book once the voice is signed off', async () => {
    await seeded()
    await call('novel_write', { chapterId: 'chapter-1', body: '房东在门外敲门。' })
    await call('novel_confirm', {
      operation: 'discuss',
      kind: 'style',
      proposal: '第 1 章成稿，短句为主，对话推进。',
      feedback: '这个语感可以。',
      topics: ['文风'],
    })
    const confirmed = await call('novel_confirm', {
      operation: 'confirm',
      kind: 'style',
      summary: '短句为主、对话推进、少形容词。',
      note: '这个语感可以。',
    })
    expect(String(confirmed['detail'])).toMatch(/文风已确认/u)

    const second = await call('novel_write', { chapterId: 'chapter-2', body: '梦里他站在楼顶。' })
    expect(String(second['detail'])).toMatch(/第 2 章已写入/u)
  })

  it('stops reporting the chapter-2 blocker once the voice is confirmed', async () => {
    await seeded()
    await call('novel_write', { chapterId: 'chapter-1', body: '房东在门外敲门。' })
    const gated = await call('novel_write', { operation: 'check', chapterId: 'chapter-2' })
    expect((gated['blockers'] as string[]).join(' ')).toMatch(/确认文风/u)

    await call('novel_confirm', {
      operation: 'discuss',
      kind: 'style',
      proposal: '第 1 章成稿',
      feedback: '可以',
    })
    await call('novel_confirm', { operation: 'confirm', kind: 'style', summary: '短句为主', note: '可以' })
    const open = await call('novel_write', { operation: 'check', chapterId: 'chapter-2' })
    expect((open['blockers'] as string[]).join(' ')).not.toMatch(/确认文风/u)
  })
})

describe('the settings layers, settled one at a time in order', () => {
  /** A premise-signed project, so the layer walk can start. */
  async function premiseSigned(): Promise<void> {
    await seeded({ confirmSettings: false })
    await signPremiseOff()
  }

  /** The same, plus the pitch and the competitor study phase one also needs. */
  async function phaseOneReady(): Promise<void> {
    await seeded({ confirmSettings: false })
    await call('novel_plan', {
      operation: 'pitch',
      memorablePoint: '梦里的神，现实里的租客',
      coreEmotion: '窘迫与翻盘的落差',
      shuangPoints: ['打脸'],
      differentiators: ['梦境收益折现'],
      kernel: '钱不是尊严的全部',
    })
    for (let index = 0; index < 20; index += 1) {
      await call('novel_plan', { operation: 'competitor', title: `同榜书 ${String(index)}` })
    }
    await signPremiseOff()
  }

  it('refuses to confirm a later layer while an earlier one is still open', async () => {
    await premiseSigned()
    // 世界观 is the layer in turn; 人设 is behind it.
    await expect(
      call('novel_confirm', {
        operation: 'discuss',
        kind: 'cast',
        proposal: '人设第一版',
        feedback: '可以',
      }),
    ).rejects.toThrow(/设定要按顺序确定/u)
    await expect(
      call('novel_confirm', { operation: 'discuss', kind: 'cast', proposal: '人设第一版', feedback: '可以' }),
    ).rejects.toThrow(/世界观设定/u)

    // Confirming the layer in turn works, and moves the sequence on.
    const world = await call('novel_confirm', {
      operation: 'discuss',
      kind: 'world',
      proposal: '力量体系：借梦为力，代价是清醒时的记忆。',
      feedback: '代价再狠一点，别让他白拿。',
    })
    expect(String(world['detail'])).toMatch(/世界观设定讨论第 1 轮/u)
    const confirmed = await call('novel_confirm', {
      operation: 'confirm',
      kind: 'world',
      summary: '借梦为力，每用一次忘掉一件现实里的事。',
      note: '可以。',
    })
    expect(String(confirmed['detail'])).toMatch(/世界观设定已确认/u)

    // Now 人设 is the layer in turn.
    const cast = await call('novel_confirm', { operation: 'discuss', kind: 'cast', proposal: '人设', feedback: '可以' })
    expect(String(cast['detail'])).toMatch(/人物设定讨论第 1 轮/u)
  })

  it('needs one round per layer after the premise, and two for the premise itself', async () => {
    await seeded({ confirmSettings: false })
    // The premise is the SOP's 设定 checkpoint and keeps its two-round rule.
    await expect(
      call('novel_confirm', { operation: 'confirm', kind: 'settings', summary: '就这样', note: '可以' }),
    ).rejects.toThrow(/还差 2 轮/u)
    await call('novel_confirm', { operation: 'discuss', kind: 'settings', proposal: '第一版', feedback: '房租线要一直在' })
    await expect(
      call('novel_confirm', { operation: 'confirm', kind: 'settings', summary: '就这样', note: '可以' }),
    ).rejects.toThrow(/还差 1 轮/u)

    // Every later layer closes on a single recorded round.
    await premiseSigned()
    await call('novel_confirm', { operation: 'discuss', kind: 'world', proposal: '世界观', feedback: '可以' })
    await expect(
      call('novel_confirm', { operation: 'confirm', kind: 'world', summary: '世界观定稿' }),
    ).rejects.toThrow(/note/u)
  })

  it('treats `settings` and `premise` as the same checkpoint in the round count', async () => {
    await seeded({ confirmSettings: false })
    // Two rounds under the `settings` spelling…
    await call('novel_confirm', { operation: 'discuss', kind: 'settings', proposal: '第一版', feedback: '房租线要一直在' })
    await call('novel_confirm', { operation: 'discuss', kind: 'settings', proposal: '改好了', feedback: '可以' })
    // …are enough to confirm the layer under its other spelling, because they are
    // the same conversation and re-asking would be the tool forgetting its own log.
    const confirmed = await call('novel_confirm', {
      operation: 'confirm',
      kind: 'premise',
      summary: '梦境收益折现交房租。',
      note: '可以。',
    })
    expect(String(confirmed['detail'])).toMatch(/立意与核心设定已确认/u)
  })

  it('warns rather than refuses when a layer is written out of order, and refuses to confirm it', async () => {
    await premiseSigned()
    // Writing 分卷大纲 before 人设 is a disagreement, not a forbidden act: every
    // `novel_plan` gate is soft.
    const written = await call('novel_plan', {
      operation: 'volume',
      number: 1,
      title: '第一卷',
      goal: '入门',
      climax: '试剑台',
      conflict: '长老刁难',
      endHook: '剑鸣',
    })
    expect((written['warnings'] as string[]).join(' ')).toMatch(/设定要按顺序确定/u)

    // Recording it as settled is a different matter, and that is refused.
    await expect(
      call('novel_confirm', { operation: 'discuss', kind: 'volume', proposal: '分卷', feedback: '可以' }),
    ).rejects.toThrow(/设定要按顺序确定/u)
  })

  it('walks all five layers in order, and only then leaves phase one', async () => {
    await seeded({ confirmSettings: false })
    await signSettingsOff()
    // Phase one's own checklist (the pitch, 20 competitors) is a separate gate,
    // so the layer walk alone is not what moves the stage — but the layers are
    // all closed, which is what this spec is about.
    const status = await call('novel_confirm', { operation: 'status', kind: 'volume' })
    const text = String((status['body'] as string[]).join('\n'))
    expect(text).toContain('- [x] 立意与核心设定')
    expect(text).toContain('- [x] 世界观设定')
    expect(text).toContain('- [x] 人物设定')
    expect(text).toContain('- [x] 全书大纲')
    expect(text).toContain('- [x] 分卷大纲')
  })

  it('leaves phase one once the layers and the phase-one checklist are both closed', async () => {
    await seeded({ confirmSettings: false })
    await call('novel_plan', {
      operation: 'pitch',
      memorablePoint: '梦里的神，现实里的租客',
      coreEmotion: '窘迫与翻盘的落差',
      shuangPoints: ['打脸'],
      differentiators: ['梦境收益折现'],
      kernel: '钱不是尊严的全部',
    })
    for (let index = 0; index < 20; index += 1) {
      await call('novel_plan', { operation: 'competitor', title: `同榜书 ${String(index)}` })
    }
    // The pitch and the study exist, but the layers are open: still phase one.
    expect((await call('novel_status', {}))['stage']).toMatch(/planning/u)
    await signSettingsOff()
    expect((await call('novel_status', {}))['stage']).toMatch(/opening-package/u)
  })

  it('writes prose once the premise is confirmed, without waiting for the volume outline', async () => {
    await premiseSigned()
    // The gate is the premise: a chapter 1 drafted while the world is still being
    // argued about is allowed, because the ordering is carried by the layers and
    // `novel_confirm`, not by refusing the prose.
    const written = await call('novel_write', { chapterId: 'chapter-1', body: '房东在门外敲门。' })
    expect(String(written['detail'])).toMatch(/第 1 章已写入/u)

    // The stage machine still holds phase one open until the layers are settled.
    const status = await call('novel_status', {})
    expect(status['stage']).toMatch(/planning/u)
    expect((status['blockers'] as string[]).join(' ')).toMatch(/世界观设定尚未与用户讨论/u)
  })

  it('shows the layer in turn in the status body, with that layer\'s own brief', async () => {
    await phaseOneReady()
    const status = await call('novel_confirm', { operation: 'status' })
    const text = String((status['body'] as string[]).join('\n'))
    expect(text).toContain('← 现在这一层')
    expect(text).toMatch(/世界观设定/u)
    // The brief belongs to the layer in turn: the world layer's own list, not the
    // whole setup's — which is how a round starts from what this layer owes.
    expect(text).toMatch(/力量体系、代价、限制/u)

    const world = await call('novel_confirm', { operation: 'status', kind: 'world' })
    expect(String((world['body'] as string[]).join('\n'))).toMatch(/力量体系、代价、限制/u)
  })
})
