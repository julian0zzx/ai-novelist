/**
 * The one write the Kanban board itself performs: a human save of a chapter body.
 *
 * Every other write in the composer belongs to a tool call, and the board shows
 * what a tool call produced. A chapter's prose is the exception the workflow
 * itself acknowledges — 去 AI 化 and hand-cutting are author work — so the board
 * lets the author read a chapter and save an edit without leaving the view.
 *
 * The board cannot write files: the Web client's only file Remote is read-only
 * (`ctx.remote.workspaceFiles`), and a third-party plugin cannot add a Remote
 * namespace to the assembly. It therefore saves through a **command** — the
 * Harness's channel for a human action that runs against the agent without
 * becoming a model message — registered by this plugin's host half and
 * dispatched by the board's Save button. The payload rides in the command line
 * as one JSON object, which is why the shape is shared here: the two halves must
 * agree on the wire, and the parse is testable without a host or a browser.
 *
 * `base` is the body the editor opened with. The host refuses a save whose base
 * no longer matches what is on disk, so a chapter the agent wrote in the
 * meantime is never silently overwritten — the author reopens and edits the new
 * text instead.
 *
 * @module @ai-novelist/novelist-skill/core/save
 */

/** Command name the host registers and the board dispatches. */
export const SAVE_COMMAND = 'novel-save'

/** A human edit of one chapter body, as the board sends it. */
export interface ChapterSavePayload {
  /** Discriminator, so a future document save shares the command. */
  readonly kind: 'chapter'
  /** Chapter id, the stable key the board's cards already carry. */
  readonly id: string
  /** The complete new body. */
  readonly text: string
  /** The body the editor was opened with, for the stale-editor check. */
  readonly base: string
}

/** The outcome of parsing one command's raw input. */
export type SaveParseResult =
  | { readonly ok: true; readonly payload: ChapterSavePayload }
  | { readonly ok: false; readonly message: string }

/**
 * Largest body one save carries.
 *
 * A chapter is thousands of characters, not megabytes; the cap exists so a
 * malformed or hostile command line cannot make the host hold and write an
 * unbounded string. Two million characters is roughly two long volumes' worth
 * in one chapter — far above any real save, far below a memory problem.
 */
export const MAX_SAVE_CHARS = 2_000_000

/**
 * Encode a save as the complete slash-command line the board dispatches.
 *
 * JSON is the encoding because the body is arbitrary text, newlines included,
 * and the command grammar hands the handler everything after the name verbatim.
 *
 * @param payload - the chapter edit to send.
 * @returns the command line, leading slash included.
 */
export function chapterSaveLine(payload: ChapterSavePayload): string {
  return `/${SAVE_COMMAND} ${JSON.stringify(payload)}`
}

/**
 * Parse the raw input of one save command.
 *
 * Deliberately strict: a malformed save must fail loudly as an error result the
 * board shows, not write whatever fields happened to parse.
 *
 * @param rawInput - everything after the command name, exactly as the registry
 *   hands it to the handler.
 * @returns the payload, or the message the board displays.
 */
export function parseSaveInput(rawInput: string): SaveParseResult {
  const trimmed = rawInput.trim()
  if (trimmed === '') return { ok: false, message: '保存请求缺少内容：看板的保存按钮会带上要写的正文。' }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { ok: false, message: '保存请求不是合法 JSON：只有看板的保存按钮会生成它，手动输入请照 tools.md 的格式。' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, message: '保存请求必须是一个 JSON 对象。' }
  }
  const record = parsed as Record<string, unknown>
  if (record['kind'] !== 'chapter') {
    return { ok: false, message: `不认识的保存类型：${String(record['kind'] ?? '（缺 kind）')}。` }
  }
  const id = record['id']
  const text = record['text']
  const base = record['base']
  if (typeof id !== 'string' || id.trim() === '') return { ok: false, message: '保存请求缺少章节 id。' }
  if (typeof text !== 'string') return { ok: false, message: '保存请求缺少正文字符串。' }
  if (typeof base !== 'string') return { ok: false, message: '保存请求缺少 base：没有它就无法判断编辑器是不是旧的。' }
  if (text.length > MAX_SAVE_CHARS) {
    return { ok: false, message: `正文超过单次保存上限（${String(MAX_SAVE_CHARS)} 字符）：请分成两章，或先用 novel_write 写一次。` }
  }
  return { ok: true, payload: { kind: 'chapter', id, text, base } }
}
