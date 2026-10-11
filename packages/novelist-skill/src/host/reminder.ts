/**
 * The durable half of the on-demand evaluation.
 *
 * `core`'s `evaluationReminder` decides whether a check-in is warranted; this
 * module is the only place that talks to `ctx.schedule`, for the same reason
 * `host/llm.ts` is the only place that talks to `ctx.llm`: a capability the
 * deployment may not have should be contained to one file that can be faked, and
 * should degrade to doing nothing rather than to failing.
 *
 * Why a *host* reminder rather than another prompt line: the prompt reaches an
 * author who is already in the session. The SOP's stated failure for this step is
 * not "the hint was unclear" but *"没人再问"* — nobody asking again — and the only
 * thing that reaches an author who is not in the session is a reminder the host
 * holds and delivers for them. That is what `ctx.schedule` is.
 *
 * @module @ai-novelist/novelist-skill/host/reminder
 */

import type { ScheduleService } from '@deepseek-ai/dsh-schedule'
import { evaluationReminder, type NovelState } from '../core/index.ts'

/**
 * The title that identifies this plugin's reminder among the host's tasks.
 *
 * Required by the schedule service (it rejects a blank title) and used here as the
 * stable key for find / update / delete, because the service keys tasks by an id
 * this plugin does not persist. A title is the cheapest durable identity available
 * without adding a field to the project document and a schema migration with it.
 */
export const REMINDER_TITLE = '网文投入评估检查'

/**
 * How often the reminder repeats.
 *
 * `off` never arms one; the default is a weekly nudge, because a serialized web
 * novel is measured in weeks and anything more frequent is noise.
 */
export type ReminderCadence = 'off' | 'daily' | 'weekly'

/** The session id type the schedule service keys on, taken from the service itself. */
type ScheduleSessionId = Parameters<ScheduleService['create']>[0]

/** The create request, taken from the service so this file cannot drift from it. */
type CreateRequest = Parameters<ScheduleService['create']>[1]

/** The record the service returns, likewise. */
type Record_ = Awaited<ReturnType<ScheduleService['list']>>[number]

/** What one synchronisation did, for the tool result to report. */
export interface ReminderOutcome {
  /** The action taken, or why none was. */
  readonly action: 'created' | 'updated' | 'removed' | 'kept' | 'skipped' | 'failed'
  /** One line describing it. */
  readonly note: string
}

/**
 * The recurrence selector for a cadence.
 *
 * The service requires an explicit IANA zone, because a wall-clock reminder whose
 * zone is implied is a reminder that moves when the host does. The deployment
 * supplies one; `UTC` is the default so an unconfigured host still gets a valid,
 * unsurprising rule rather than a refused create.
 *
 * @param cadence - the configured cadence, never `off` here.
 * @param timeZone - the IANA zone to anchor the wall-clock time in.
 * @returns the recurrence half of a create request.
 */
function recurrenceFor(cadence: 'daily' | 'weekly', timeZone: string): Partial<CreateRequest> {
  return cadence === 'daily'
    ? { daily: { time: '09:00:00', time_zone: timeZone } }
    : { weekly: { time: '09:00:00', time_zone: timeZone, weekdays: [1] } }
}

/**
 * Bring the host's reminder for one project into line with the project's state.
 *
 * Idempotent, and safe to call on every write: it lists the session's tasks,
 * decides from the *project* alone whether one should exist, and then creates,
 * refreshes or removes at most one.
 *
 * Every failure is reported rather than thrown. A reminder is a convenience
 * around a step the SOP says gates nothing; a project must not fail to record a
 * chapter because the host could not persist a nudge.
 *
 * @param schedule - the host schedule service, or `undefined` where none is mounted.
 * @param sessionId - the session the reminder should be delivered to.
 * @param state - the project, after the write.
 * @param cadence - the deployment's configured cadence.
 * @param timeZone - the IANA zone the wall-clock reminder is anchored in.
 * @param signal - cancellation for the schedule calls.
 * @returns what was done.
 */
export async function syncEvaluationReminder(
  schedule: ScheduleService | undefined,
  sessionId: string | undefined,
  state: NovelState,
  cadence: ReminderCadence,
  timeZone: string,
  signal?: AbortSignal,
): Promise<ReminderOutcome> {
  const plan = evaluationReminder(state)
  if (cadence === 'off') return { action: 'skipped', note: '提醒已关闭（evaluationReminder: off）' }
  if (schedule === undefined) return { action: 'skipped', note: '本 profile 没有 schedule 服务，不建提醒' }
  if (sessionId === undefined || sessionId === '') {
    return { action: 'skipped', note: '没有会话 id，提醒无处投递' }
  }

  const key = sessionId as ScheduleSessionId
  try {
    const tasks = await schedule.list({ sessionId: key })
    const existing = tasks.find((task) => task.title === REMINDER_TITLE)

    if (!plan.arm) {
      if (existing === undefined) return { action: 'skipped', note: plan.reason }
      await schedule.delete({ sessionId: key, id: existing.id }, signal)
      return { action: 'removed', note: `提醒已撤下：${plan.reason}` }
    }

    if (existing === undefined) {
      await schedule.create(
        key,
        { title: REMINDER_TITLE, prompt: plan.text, ...recurrenceFor(cadence, timeZone) } as CreateRequest,
        signal,
      )
      return { action: 'created', note: `已建${cadence === 'daily' ? '每日' : '每周'}提醒：${plan.reason}` }
    }

    // Refresh only when the text actually changed, so a routine write does not
    // rewrite the host's storage on every chapter.
    if (existing.prompt !== plan.text) {
      await schedule.update(
        { sessionId: key, id: existing.id, expected: existing as Record_, prompt: plan.text },
        signal,
      )
      return { action: 'updated', note: '提醒内容已随项目状态更新' }
    }
    return { action: 'kept', note: '提醒已在位，内容未变' }
  } catch (error) {
    return {
      action: 'failed',
      note: `提醒同步失败（不影响本次写入）：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
