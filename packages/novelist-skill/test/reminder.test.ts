import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { Config, apply } from '../src/index.ts'
import { evaluationReminder, emptyNovel, type NovelState } from '../src/core/index.ts'
import { syncEvaluationReminder, REMINDER_TITLE } from '../src/host/reminder.ts'
import { NovelStore } from '../src/host/store.ts'

/**
 * The durable evaluation reminder.
 *
 * The SOP's stated failure for the on-demand data check is not that a rule was
 * wrong but that *"没人再问"* — nobody asks again. A prompt line only reaches an
 * author already in the session; `ctx.schedule` reaches them next week. These
 * specs pin both halves: the pure decision (`evaluationReminder`) and the I/O that
 * acts on it (`syncEvaluationReminder`), including that it degrades to silence
 * rather than to failure wherever the host has no schedule service.
 *
 * The project the decision is asked about is built through the real tools rather
 * than assembled by hand: "is this book serializing?" is `assessStage`'s answer,
 * and a fixture that hand-waved the outline layers would be asserting against a
 * project state the pipeline cannot actually produce.
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

const VOLUME_SPINE = {
  synopsis: '少年入门，卷末登顶。',
  protagonistArc: '从散修变成门内弟子',
  antagonistArc: '对手第一次露头',
  factionShift: '门内两派成形',
  mainConflict: '入门试炼',
  costs: '失去了自由身',
  gains: '得了一个身份',
}

/** A stand-in for `ctx.schedule`, recording what the plugin asked of it. */
function fakeSchedule() {
  const tasks: { id: string; title: string; prompt: string }[] = []
  let calls: string[] = []
  let failing = false
  return {
    tasks,
    /** What the plugin asked of the host since the last reset. */
    calls: () => [...calls],
    fail(on: boolean) {
      failing = on
    },
    /** Forget the traffic so far, keeping the tasks — the project walk is not the test. */
    reset() {
      calls = []
      failing = false
    },
    /** Forget everything, including any task the walk armed. */
    clear() {
      calls = []
      failing = false
      tasks.length = 0
    },
    service: {
      async list() {
        calls.push('list')
        if (failing) throw new Error('storage is unavailable')
        return [...tasks]
      },
      async create(_sessionId: string, request: { title: string; prompt: string }) {
        calls.push('create')
        if (failing) throw new Error('storage is unavailable')
        const task = { id: `task-${String(tasks.length + 1)}`, title: request.title, prompt: request.prompt }
        tasks.push(task)
        return task
      },
      async delete() {
        calls.push('delete')
        if (failing) throw new Error('storage is unavailable')
        tasks.length = 0
        return { deleted: true }
      },
      async update(request: { id: string; prompt?: string }) {
        calls.push('update')
        if (failing) throw new Error('storage is unavailable')
        const task = tasks.find((entry) => entry.id === request.id)
        if (task !== undefined && request.prompt !== undefined) task.prompt = request.prompt
        return { id: request.id, updated: true, record: task }
      },
    },
  }
}

let root: string
let ctx: Context
let tools: Map<string, ToolDefinition>
let fake: ReturnType<typeof fakeSchedule>

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

const scheduleProvider = {
  name: 'schedule-provider',
  apply(target: Context) {
    target.provide('schedule', fake.service)
  },
}

/** One tool call, as the agent loop would dispatch it, bound to a real session id. */
async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const definition = tools.get(name)
  if (definition === undefined) throw new Error(`tool ${name} is not registered`)
  const exec = {
    signal: new AbortController().signal,
    agent: { session: { header: { cwd: root, id: 'session-1' } } },
  }
  return (await definition.execute(args, exec as never)) as Record<string, unknown>
}

/** Two recorded rounds carrying the author's own words, then the sign-off. */
async function closePremise(): Promise<void> {
  await call('novel_confirm', {
    operation: 'discuss',
    kind: 'settings',
    proposal: '第一版设定',
    feedback: '主角再冷一点',
  })
  await call('novel_confirm', { operation: 'discuss', kind: 'settings', proposal: '改后的设定', feedback: '可以' })
  await call('novel_confirm', { operation: 'confirm', kind: 'settings', summary: '设定定稿', note: '可以' })
}

/** Close one later settings layer: one recorded round, then the sign-off. */
async function closeLayer(kind: string, label: string): Promise<void> {
  await call('novel_confirm', { operation: 'discuss', kind, proposal: `${label}草案`, feedback: '可以', topics: [label] })
  await call('novel_confirm', { operation: 'confirm', kind, summary: `${label}定稿`, note: '可以' })
}

/** Close the voice checkpoint, which the stage machine holds open after chapter 1. */
async function closeStyle(): Promise<void> {
  await call('novel_confirm', { operation: 'discuss', kind: 'style', proposal: '第 1 章成稿', feedback: '语感可以' })
  await call('novel_confirm', { operation: 'confirm', kind: 'style', summary: '短句为主', note: '可以' })
}

/**
 * Drive a project to stage five through the tool surface.
 *
 * @returns the project as the store reads it back.
 */
async function serializingProject(): Promise<NovelState> {
  await call('novel_init', {
    title: '青云记',
    premise: '少年携断剑上山。',
    baselines: { readThrough3: 0.5 },
    targetWords: 900000,
    chapterWords: 3000,
    volumes: 9,
  })
  await call('novel_plan', { operation: 'pitch', memorablePoint: 'm', coreEmotion: 'e', shuangPoints: ['s'], differentiators: ['d'], kernel: 'k' })
  for (let index = 0; index < 20; index += 1) {
    await call('novel_plan', { operation: 'competitor', title: `同榜书 ${String(index)}` })
  }
  await call('novel_plan', { operation: 'launch', verdict: 'go' })
  await call('novel_plan', { operation: 'outline', logline: 'l', minimal: 'm', acts: ['a'], ...SPINE, full: true })
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
  await closePremise()
  await closeLayer('world', '世界观设定')
  await closeLayer('cast', '人物设定')
  await closeLayer('outline', '全书大纲')
  await closeLayer('volume', '分卷大纲')
  await call('novel_write', { chapterId: 'chapter-1', body: '山门很高。' })

  return readState()
}

/** The project as the store reads it back off disk. */
async function readState(): Promise<NovelState> {
  const store = new NovelStore(ctx, { workspaceRoot: root, clock: () => '2026-01-01T00:00:00.000Z' })
  const state = await store.read()
  if (state === undefined) throw new Error('the project did not survive the walk')
  return state
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ai-novelist-reminder-'))
  tools = new Map()
  fake = fakeSchedule()
  ctx = new Context()
  ctx.plugin(LocalFileSystem, { cwd: root, diffBasisMaxBytes: 64 * 1024 })
  ctx.plugin(recorder)
  ctx.plugin(scheduleProvider)
  await new Promise((resolve) => setTimeout(resolve, 0))
  apply(ctx, Config({ workspaceRoot: root }) as never)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('when a reminder is warranted', () => {
  it('arms only while the book is actually being serialized, and stops at completion', async () => {
    // Nothing planned yet: there is no reading to prompt anyone about, and an
    // always-present line is one an author learns to ignore.
    const fresh = evaluationReminder(emptyNovel())
    expect(fresh.arm).toBe(false)
    expect(fresh.reason).toMatch(/阶段/u)
    expect(fresh.text).toBe('')

    const walking = await serializingProject()
    const armed = evaluationReminder(walking)
    expect(armed.arm).toBe(true)
    expect(armed.text).toContain('《青云记》')
    expect(armed.text).toContain('novel_assess')
    // It must never read as a gate: the SOP is explicit that this blocks nothing.
    expect(armed.text).toContain('不阻断连载')

    // The voice sign-off closes the position gate, but the book is still running.
    await closeStyle()
    expect(evaluationReminder(await readState()).arm).toBe(true)

    await call('novel_repo', { operation: 'retro' })
    const finished = evaluationReminder(await readState())
    expect(finished.arm).toBe(false)
    expect(finished.reason).toMatch(/完本/u)
  })
})

describe('synchronising the reminder with the project', () => {
  it('creates one task, keeps it while the appointment stands, and refreshes it when it moves', async () => {
    const state = await serializingProject()
    fake.clear()

    const created = await syncEvaluationReminder(fake.service as never, 'session-1', state, 'weekly', 'Asia/Shanghai')
    expect(created.action).toBe('created')
    expect(fake.tasks).toHaveLength(1)
    expect(fake.tasks[0]?.title).toBe(REMINDER_TITLE)

    const again = await syncEvaluationReminder(fake.service as never, 'session-1', state, 'weekly', 'Asia/Shanghai')
    expect(again.action).toBe('kept')
    // One task, not two: the title is the durable key.
    expect(fake.tasks).toHaveLength(1)
    expect(fake.calls().filter((entry) => entry === 'create')).toHaveLength(1)

    const moved: NovelState = {
      ...state,
      evaluations: [
        {
          id: 'evaluation-1',
          round: 1,
          at: '2026-01-02T00:00:00.000Z',
          channel: 'platform',
          sampleSize: 1,
          readingId: 'reading-1',
          namingId: '',
          verdict: 'pass',
          reasons: [],
          fallback: '',
          abandonIf: '',
          nextAtChapter: 30,
          nextTrigger: '',
          note: '',
        },
      ],
    }
    const updated = await syncEvaluationReminder(fake.service as never, 'session-1', moved, 'weekly', 'UTC')
    expect(updated.action).toBe('updated')
    expect(fake.tasks).toHaveLength(1)
    expect(fake.tasks[0]?.prompt).toContain('第 30 章')
  })

  it('stays silent when the feature is off, the host has no service, or there is no session', async () => {
    // All three short-circuit before the project is consulted at all, which is
    // what makes an unhosted deployment cost nothing.
    const fresh = emptyNovel()
    const off = await syncEvaluationReminder(fake.service as never, 'session-1', fresh, 'off', 'UTC')
    expect(off.action).toBe('skipped')
    expect(fake.calls()).toEqual([])

    const absent = await syncEvaluationReminder(undefined, 'session-1', fresh, 'weekly', 'UTC')
    expect(absent.action).toBe('skipped')
    expect(absent.note).toMatch(/schedule/u)

    const anonymous = await syncEvaluationReminder(fake.service as never, undefined, fresh, 'weekly', 'UTC')
    expect(anonymous.action).toBe('skipped')
    expect(fake.calls()).toEqual([])
  })

  it('withdraws the reminder once the book is complete', async () => {
    await serializingProject()
    // The book is complete once the voice is signed off and the retrospective
    // exists — the two conditions `assessStage` reports as `completed`.
    await closeStyle()
    const styled = await readState()
    expect(fake.tasks).toHaveLength(1)

    const removed = await syncEvaluationReminder(
      fake.service as never,
      'session-1',
      { ...styled, retro: { at: '2026-01-01T00:00:00.000Z' } } as never,
      'weekly',
      'UTC',
    )
    expect(removed.action).toBe('removed')
    expect(fake.tasks).toHaveLength(0)
  })

  it('reports a host failure instead of throwing, because this step gates nothing', async () => {
    const state = await serializingProject()
    fake.clear()
    fake.fail(true)
    const outcome = await syncEvaluationReminder(fake.service as never, 'session-1', state, 'weekly', 'UTC')
    expect(outcome.action).toBe('failed')
    expect(outcome.note).toMatch(/不影响本次写入/u)
  })
})

describe('the tool layer holds up its end', () => {
  it('arms the reminder as the project reaches serialization, and withdraws it at completion', async () => {
    // The walk writes the chapter that makes the book live; that is where the
    // tool layer consults the host, with no extra call of its own.
    await serializingProject()
    expect(fake.calls()).toContain('list')
    expect(fake.tasks).toHaveLength(1)
    expect(fake.tasks[0]?.title).toBe(REMINDER_TITLE)
    expect(fake.tasks[0]?.prompt).toMatch(/青云记/u)

    await closeStyle()
    const retro = await call('novel_repo', { operation: 'retro' })
    expect(retro['ok']).toBe(true)
    expect(fake.tasks).toHaveLength(0)
  })

  it('surfaces a host failure as a soft warning rather than failing the write', async () => {
    await call('novel_init', { title: '青云记' })
    await call('novel_plan', { operation: 'chapter', id: 'chapter-1', title: '山门', number: 1 })
    await closePremise()
    fake.reset()
    fake.fail(true)

    const written = await call('novel_write', { chapterId: 'chapter-1', body: '山门很高。' })
    expect(written['ok']).toBe(true)
    expect((written['warnings'] as string[]).join(' ')).toMatch(/提醒同步失败/u)
  })
})
