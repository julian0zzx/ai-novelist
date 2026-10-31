/**
 * The board's save channel, from the browser side.
 *
 * The Web client's file Remote is read-only by design, so a save cannot be a
 * file write from this half. It is a **command** instead: `ctx.remote.commands`
 * runs a registered command against the session's agent without creating a model
 * message, which is exactly the shape of "the author pressed Save". The host
 * half registers `novel-save`; this module builds its line and maps the Remote
 * result onto the two outcomes the modal renders.
 *
 * @module @ai-novelist/novelist-skill/client/save
 */

import { SAVE_COMMAND, chapterSaveLine } from '../core/save.ts'
import type { ChapterSavePayload } from '../core/save.ts'
import type { ClientRemote } from './remote.ts'
import type { SessionId } from './project.ts'

/** What one save attempt reports to the modal. */
export type SaveOutcome =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly message: string }

/**
 * The `commands` namespace of the Remote, as far as a save uses it.
 *
 * Declared structurally, matching the `remote.commands` name rather than an
 * import: the namespace belongs to the Harness assembly, not to this plugin,
 * and the board only needs `execute`.
 */
interface CommandsFace {
  /**
   * Run one command line against a session's agent.
   * @param sessionId - the Session whose agent receives it.
   * @param line - the complete slash-command line.
   * @param attachments - none for a save.
   * @param signal - caller cancellation.
   * @returns the settled execution, or a transport failure.
   */
  execute(
    sessionId: SessionId,
    line: string,
    attachments: readonly never[],
    signal?: AbortSignal,
  ): Promise<
    | {
        readonly ok: true
        readonly value:
          | {
              readonly result:
                | { readonly kind: 'success'; readonly text?: string }
                | { readonly kind: 'error'; readonly text: string }
            }
          | undefined
      }
    | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
  >
}

/**
 * Save one edited chapter body.
 *
 * @param remote - the captured Remote face.
 * @param sessionId - the session whose project is being edited.
 * @param payload - the complete new body plus the body the editor opened with.
 * @param signal - aborted when the modal closes or the save is superseded.
 * @returns the host's confirmation line, or the message to show the author.
 */
export async function saveChapterBody(
  remote: ClientRemote,
  sessionId: SessionId,
  payload: ChapterSavePayload,
  signal?: AbortSignal,
): Promise<SaveOutcome> {
  const commands = (remote as unknown as { commands?: CommandsFace }).commands
  if (commands === undefined) {
    return {
      ok: false,
      message: '这个界面没有命令通道，保存不到项目里：请让部署方在 profile 里启用 commands 服务（Web 版自带）。',
    }
  }
  let result: Awaited<ReturnType<CommandsFace['execute']>>
  try {
    result = await commands.execute(sessionId, chapterSaveLine(payload), [], signal)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
  if (!result.ok) {
    return { ok: false, message: `${result.error.code}：${result.error.message}` }
  }
  // An unknown command resolves to `undefined` rather than throwing: that is
  // what a host that has not restarted since the plugin was built looks like.
  if (result.value === undefined) {
    return {
      ok: false,
      message: `宿主还没有注册 ${SAVE_COMMAND} 命令：重启 dsh web（或重启 DSH 进程）后再保存。`,
    }
  }
  const settled = result.value.result
  if (settled.kind === 'success') return { ok: true, text: settled.text ?? `${SAVE_COMMAND} 已完成` }
  return { ok: false, message: settled.text }
}
