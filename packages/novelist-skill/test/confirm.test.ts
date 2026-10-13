import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { Config, apply } from '../src/index.ts'
import { addReview, emptyNovel, metadataOf, parseMetadata, serializeMetadata, stateOf } from '../src/core/index.ts'
import { STYLE_ARGS } from './style-fixture.ts'

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

/**
 * A project with four planned chapters, signed off exactly as far as asked.
 *
 * Four, because the 文风复核 now falls after the golden three chapters and gates
 * the fourth: a fixture with fewer chapters could not tell "the review is due"
 * apart from "there is nothing to review".
 */
async function seeded(options: { readonly confirmSettings?: boolean } = {}): Promise<void> {
  await call('novel_init', {
    title: '我在梦里开无双，醒了还要交房租',
    premise: '穷困潦倒的租客发现自己在梦里无所不能。',
  })
  await call('novel_plan', { operation: 'chapter', id: 'chapter-1', title: '房租', number: 1, plotTask: '交租' })
  await call('novel_plan', { operation: 'chapter', id: 'chapter-2', title: '梦醒', number: 2, plotTask: '醒来' })
  await call('novel_plan', { operation: 'chapter', id: 'chapter-3', title: '楼顶', number: 3, plotTask: '试手' })
  await call('novel_plan', { operation: 'chapter', id: 'chapter-4', title: '旧账', number: 4, plotTask: '收网' })
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
  // The 写作风格 block belongs to the 全书大纲 layer and gates the prose, so it is
  // written before that layer can be confirmed (SOP 3.6).
  await call('novel_plan', { operation: 'outline', logline: '梦里的神，现实里的租客', minimal: '一屏摘要', acts: ['起'], ...STYLE_ARGS })
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

describe('the 文风复核 after the golden three chapters', () => {
  /** Write the three chapters whose prose the author is asked to judge. */
  async function writeGoldenThree(): Promise<void> {
    for (const id of ['chapter-1', 'chapter-2', 'chapter-3']) {
      await call('novel_write', { chapterId: id, body: `第 ${id} 章的正文。` })
    }
  }

  /**
   * Record one 去 AI 化 review, the way `novel_review` records its own.
   *
   * The tool's receipt *is* the reviews ledger, so this writes the same entry the
   * tool would — the gate reads the record, not the call. Going through the core
   * codec keeps the file the store would have written.
   *
   * @param target - the chapter id the review looked at.
   */
  async function recordDeAi(target = 'chapter-1'): Promise<void> {
    const path = join(root, '.novel/novel.json')
    const { metadata } = parseMetadata(await readFile(path, 'utf8'))
    const state = stateOf(metadata, { outline: emptyNovel().outline, characters: {}, world: {}, chapters: {} })
    const next = addReview(
      state,
      {
        id: `review-${String(state.reviews.length + 1)}`,
        at: '2024-01-01T00:00:00.000Z',
        kind: 'ai-flavor',
        target,
        provider: 'test',
        model: 'test',
        promptVersion: 'review-rubric-2',
        summary: '对举句偏多',
        findings: [],
        artifact: '',
      },
      () => '2024-01-01T00:00:00.000Z',
    )
    await writeFile(path, serializeMetadata(metadataOf(next)), 'utf8')
  }

  it('lets the golden three chapters through before the review', async () => {
    await seeded()
    await writeGoldenThree()
    // The checkpoint is about running on, not about freezing the chapters the
    // user is being asked about: revising one stays possible.
    const revised = await call('novel_write', { chapterId: 'chapter-1', body: '房东在门外砸门。' })
    expect(String(revised['detail'])).toMatch(/第 1 章已写入/u)
  })

  it('refuses chapter 4 until the user has reviewed the voice', async () => {
    await seeded()
    await writeGoldenThree()
    await recordDeAi()
    await expect(call('novel_write', { chapterId: 'chapter-4', body: '梦里他站在楼顶。' })).rejects.toThrow(
      /复核文风/u,
    )
  })

  it('refuses chapter 4 until a 去 AI 化 diagnosis has actually been recorded', async () => {
    await seeded()
    await writeGoldenThree()
    // SOP step 23 used to depend on the model choosing to run it. The receipt is
    // the reviews ledger, so "nobody ever ran it" is now a refusal rather than a
    // book written in the same AI voice to chapter forty.
    await expect(call('novel_write', { chapterId: 'chapter-4', body: '梦里他站在楼顶。' })).rejects.toThrow(
      /去 AI 化/u,
    )
    await recordDeAi()
    // The gate is the receipt, not the wording of the refusal: one recorded
    // review opens it, and what the review found is the author's business.
    await expect(call('novel_write', { chapterId: 'chapter-4', body: '梦里他站在楼顶。' })).rejects.toThrow(
      /复核文风/u,
    )
  })

  it('refuses to review a voice before the golden three have prose', async () => {
    await seeded()
    await call('novel_write', { chapterId: 'chapter-1', body: '房东在门外敲门。' })
    await call('novel_confirm', {
      operation: 'discuss',
      kind: 'style',
      proposal: '第 1 章按大纲的写作风格写完了。',
      feedback: '先看两章再说。',
    })
    await expect(
      call('novel_confirm', { operation: 'confirm', kind: 'style', summary: '短句为主' }),
    ).rejects.toThrow(/黄金三章/u)
  })

  it('opens the rest of the book once the voice is reviewed', async () => {
    await seeded()
    await writeGoldenThree()
    await call('novel_confirm', {
      operation: 'discuss',
      kind: 'style',
      proposal: '黄金三章成稿，短句为主，对话推进。',
      feedback: '这个语感可以，但第三章的形容词还是多了点。',
      topics: ['文风'],
    })
    await recordDeAi()
    const confirmed = await call('novel_confirm', {
      operation: 'confirm',
      kind: 'style',
      summary: '短句为主、对话推进、少形容词；第三章起再加一档克制。',
      note: '这个语感可以。',
    })
    expect(String(confirmed['detail'])).toMatch(/文风复核已确认/u)

    const fourth = await call('novel_write', { chapterId: 'chapter-4', body: '梦里他站在楼顶。' })
    expect(String(fourth['detail'])).toMatch(/第 4 章已写入/u)
  })

  it('stops reporting the chapter-4 blocker once the voice is reviewed', async () => {
    await seeded()
    await writeGoldenThree()
    const gated = await call('novel_write', { operation: 'check', chapterId: 'chapter-4' })
    expect((gated['blockers'] as string[]).join(' ')).toMatch(/复核文风/u)

    await call('novel_confirm', {
      operation: 'discuss',
      kind: 'style',
      proposal: '黄金三章成稿，用户读过。',
      feedback: '不用改。',
    })
    await call('novel_confirm', { operation: 'confirm', kind: 'style', summary: '短句为主', note: '不用改。' })
    const open = await call('novel_write', { operation: 'check', chapterId: 'chapter-4' })
    expect((open['blockers'] as string[]).join(' ')).not.toMatch(/复核文风/u)
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

  it('refuses to confirm the 全书大纲 while its 写作风格 block is unwritten', async () => {
    await seeded({ confirmSettings: false })
    await premiseSigned()
    for (const kind of ['world', 'cast'] as const) {
      await call('novel_confirm', { operation: 'discuss', kind, proposal: `${kind} 草案`, feedback: '可以' })
      await call('novel_confirm', { operation: 'confirm', kind, summary: `${kind} 定稿`, note: '可以' })
    }
    await call('novel_confirm', { operation: 'discuss', kind: 'outline', proposal: '大纲草案', feedback: '故事可以' })
    // The style block is part of this layer and is what chapter 1 is written
    // against, so the layer cannot be recorded as settled without it.
    await expect(
      call('novel_confirm', { operation: 'confirm', kind: 'outline', summary: '大纲定稿', note: '可以' }),
    ).rejects.toThrow(/写作风格/u)

    await call('novel_plan', { operation: 'outline', ...STYLE_ARGS })
    const confirmed = await call('novel_confirm', {
      operation: 'confirm',
      kind: 'outline',
      summary: '大纲定稿（含写作风格七要素）',
      note: '可以',
    })
    expect(String(confirmed['detail'])).toMatch(/全书大纲（含写作风格）已确认/u)
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
    // Two gates are in play here and only one of them is about order. The launch
    // gate is hard and comes first: 分卷大纲 is stage-four work, so the SOP will
    // not have it built before a human has said `go`. Record that, and what
    // remains is the *ordering* question this spec is about — writing 分卷大纲
    // before 人设, which is a disagreement rather than a forbidden act.
    await call('novel_plan', { operation: 'launch', verdict: 'go' })
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

  it('writes prose once the premise is confirmed and the 写作风格 is written, without waiting for the volume outline', async () => {
    await premiseSigned()
    // Two gates are shut here, and the second is the point of SOP 3.6. The premise
    // is the author's sign-off on the setup; the 写作风格 block is what chapter 1 is
    // written *against*, so prose stays refused until it exists — even though the
    // world, the cast and the volumes are all still being argued about.
    await expect(call('novel_write', { chapterId: 'chapter-1', body: '房东在门外敲门。' })).rejects.toThrow(
      /写作风格/u,
    )
    await call('novel_plan', { operation: 'outline', ...STYLE_ARGS })
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
