/**
 * The host end of the board's save button.
 *
 * A command, not a tool: the author pressing Save in the Kanban is a human
 * action that must not become a model turn, and the Harness command plane is the
 * one channel that runs host code straight from the Web UI. The client half
 * dispatches `/<SAVE_COMMAND> <json>`; this half validates it, refuses a stale
 * editor, archives the replaced prose, and applies the edit through the same
 * `NovelStore.update` every tool writes through — so the board, the tools and the
 * files cannot disagree about what the chapter holds.
 *
 * The save deliberately bypasses `proseGate`: that gate exists so the *model*
 * does not run ahead of the author's sign-off, and this path is the author.
 *
 * @module @ai-novelist/novelist-skill/host/commands
 */

import type { Context } from '@deepseek-ai/cordis'
import { NovelInputError, systemClock, upsertChapter } from '../core/novel.ts'
import type { Clock } from '../core/novel.ts'
import type { ChapterStatus } from '../core/types.ts'
import { SAVE_COMMAND, parseSaveInput } from '../core/save.ts'
import type { ChapterSavePayload } from '../core/save.ts'
import type { ProjectResolver } from './resolver.ts'
import { policyForSession, withSandboxPolicy } from './sandbox.ts'
import type { NovelStore } from './store.ts'
import type { WorkspaceViews } from './views.ts'

/**
 * The command-registry slice this module uses.
 *
 * Declared structurally rather than imported from `@deepseek-ai/dsh-commands`:
 * the package is a service the *profile* provides, not a dependency of this
 * plugin, and importing it only for the type would tie the build to one
 * Harness version. The shape below is the part of `register` the save needs.
 */
interface CommandRegistry {
  /**
   * Register one global command.
   * @param definition - name, discovery copy, and the handler.
   * @returns the disposer that unregisters it.
   */
  register(definition: {
    readonly name: string
    readonly description: string
    readonly recordInput?: boolean
    readonly handler: (invocation: {
      readonly agent: { readonly session?: { readonly header: { readonly cwd?: string } } }
      readonly rawInput: string
    }) => Promise<{ readonly kind: 'success'; readonly text: string } | { readonly kind: 'error'; readonly text: string }>
  }): () => void
}

/** What one successful save reports back. */
export interface ChapterSaveOutcome {
  /** 1-based chapter number, for the confirmation line. */
  readonly number: number
  /** The new body's word count, as the board will count it. */
  readonly wordCount: number
  /** The status the chapter now holds; a first body promotes `planned`. */
  readonly status: ChapterStatus
  /** Where the replaced prose was archived, when there was prose to replace. */
  readonly archived?: string
}

/**
 * Apply one chapter edit.
 *
 * The stale check and the archive both run **inside** `store.update`, so they
 * see the same fresh read the write does; a body that changed between the
 * editor opening and the save is refused rather than overwritten. The archive
 * runs before the state changes, matching `novel_write`: the prose is the one
 * artefact a save cannot re-derive, so every overwrite leaves the previous
 * draft on disk.
 *
 * @param store - the session's project store.
 * @param payload - the validated chapter edit.
 * @param now - timestamp source, injectable for tests.
 * @returns the confirmation facts.
 * @throws {NovelInputError} when the chapter is gone or the editor is stale.
 */
export async function saveChapterEdit(
  store: NovelStore,
  payload: ChapterSavePayload,
  now: Clock = systemClock,
): Promise<ChapterSaveOutcome> {
  let archived: string | undefined
  const next = await store.update(async (state) => {
    const chapter = state.chapters[payload.id]
    if (chapter === undefined) throw new NovelInputError(`找不到章节 ${payload.id}：看板可能已经删掉了它，先点「重新读取」。`)
    if (chapter.body !== payload.base) {
      throw new NovelInputError(
        '这一章在编辑器打开之后被改过（可能是 agent 刚写过），为了避免覆盖，先关掉编辑器、点看板上的「重新读取」，再重开这一章。',
      )
    }
    if (chapter.body.trim() !== '' && chapter.body !== payload.text) {
      archived = await store.archiveChapterVersion(chapter, now())
    }
    // A first body is what turns a planned chapter into a drafted one; the rest
    // of the lifecycle stays the author's to move (a hand edit must not mark a
    // chapter revised or final on its own).
    const status: ChapterStatus = chapter.status === 'planned' && payload.text.trim() !== '' ? 'drafting' : chapter.status
    return upsertChapter(state, { id: chapter.id, body: payload.text, status }, now)
  })
  const written = next.chapters[payload.id]
  if (written === undefined) throw new NovelInputError(`章节 ${payload.id} 在保存过程中消失了，请重新读取项目。`)
  return {
    number: written.number,
    wordCount: written.wordCount,
    status: written.status,
    ...(archived === undefined ? {} : { archived }),
  }
}

/**
 * Register the save command on a context that carries a `commands` service.
 *
 * The caller decides whether the service exists (the profile may run without a
 * command surface), so this function does nothing when it is absent rather than
 * making `commands` a hard dependency of the plugin.
 *
 * @param ctx - the plugin context; the registration is owned by its fiber.
 * @param projects - the session-to-store resolver every tool uses.
 * @param views - the workspace views, refreshed so the runtime prompt agrees
 *   with the save immediately.
 */
export function registerSaveCommand(ctx: Context, projects: ProjectResolver, views: WorkspaceViews): void {
  const commands = ctx.reflect.get('commands') as CommandRegistry | undefined
  if (commands === undefined) return
  ctx.effect(() =>
    commands.register({
      name: SAVE_COMMAND,
      // The command is dispatched by the board's button; the hint is for the
      // one person who types it by hand or finds it in the command palette.
      description: '保存看板里编辑过的章节正文（由看板的保存按钮调用）',
      // The whole body is the payload. Logging it would duplicate a chapter into
      // the session log on every save, so only the outcome is recorded.
      recordInput: false,
      handler: async ({ agent, rawInput }) => {
        const parsed = parseSaveInput(rawInput)
        if (!parsed.ok) return { kind: 'error', text: parsed.message }
        let outcome: ChapterSaveOutcome
        try {
          // The command handler is not a tool execution, so it has no ambient
          // sandbox scope: resolve the *session's* policy and stamp it onto the
          // mutation, exactly as the tools do. Without it a confining backend
          // resolves the deployment root instead of this session's workspace and
          // refuses the write.
          const session = agent.session
          const store = projects.storeForSession(session)
          outcome = await withSandboxPolicy(policyForSession(ctx, session), () => saveChapterEdit(store, parsed.payload))
        } catch (error) {
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
        }
        // The write is what the author asked for; a prompt refresh that fails is
        // not a failed save. The next step re-renders the project anyway.
        await views.viewForSession(agent.session).refresh().catch(() => undefined)
        const archived = outcome.archived === undefined ? '' : `；上一版正文已存档：${outcome.archived}`
        return {
          kind: 'success',
          text: `第 ${String(outcome.number)} 章已保存：${String(outcome.wordCount)} 字${archived}`,
        }
      },
    }),
  )
}
