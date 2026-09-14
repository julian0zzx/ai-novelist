/**
 * Reading a novel project from the browser half.
 *
 * Both composer surfaces — the sidebar panel and the Kanban conversation view —
 * show the same project, and neither may guess where it lives or how it is
 * stored. Every read therefore goes through the session-addressed Remote the
 * file preview uses (`ctx.remote.workspaceFiles`), which resolves the session's
 * workspace root on the host, and through the **same core codec** the host
 * writes with: `parseMetadata` for the document, `composeContent` for the
 * Markdown the index names, `stateOf` to assemble the two. No format knowledge
 * is duplicated in the browser, so a panel can only lag the files, never drift
 * from them.
 *
 * @module @ai-webnovel/composer-host/client/project
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Side-effect type imports: the Remote face (`ctx.remote.workspaceFiles`) is a
// declaration-merged member of the client Context, so it exists here only if the
// assembly that provides it has been imported.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { composeContent, parseMetadata, stateOf } from '../core/index.ts'
import { METADATA_RELATIVE_PATH } from '../core/paths.ts'
import type { NovelMetadata, NovelState } from '../core/types.ts'

/**
 * The session identity a Remote file read is addressed by.
 *
 * Taken from the session list the shell publishes rather than restated: it is a
 * branded type, and a second declaration of the brand would not be the same type.
 */
export type SessionId = SessionListState['ids'][number]

/** What one read of the project produced. */
export type ProjectRead =
  | { status: 'loading' }
  | { status: 'none' }
  | { status: 'ready'; raw: string; metadata: NovelMetadata; state: NovelState }
  | { status: 'error'; message: string }

/** The Remote face, as the composer's client half uses it. */
type Remote = ClientContext['remote']

/**
 * Error codes that mean "there is no such text file here".
 *
 * The Remote answers a missing path with its own `workspace-file/*` code; a
 * backend reached directly reports the filesystem's `FS_*` code. Either spelling
 * means the same thing to a caller whose content files are allowed to not exist
 * yet, so both are treated as absence.
 */
const ABSENT_CODES = new Set(['workspace-file/not-found', 'workspace-file/not-regular-file', 'FS_NOT_FOUND', 'FS_NOT_REGULAR_FILE'])

/**
 * Read one file, answering `undefined` for a file that is simply not there.
 *
 * @param remote - the client Remote face.
 * @param sessionId - the session whose workspace holds the file.
 * @param path - absolute, or relative to the session's workspace root.
 * @param signal - aborted when the reader unmounts or the session switches.
 * @returns the file's text, or undefined when no such text file exists.
 * @throws when the read failed for a reason other than absence.
 */
export async function readProjectFile(
  remote: Remote,
  sessionId: SessionId,
  path: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const result = await remote.workspaceFiles.read(sessionId, path, {}, signal)
  if (result.ok) {
    if (result.value.eof) return result.value.text
    // The document is larger than one page. Ask for the whole thing rather than
    // assembling a partial JSON document, which would fail as malformed.
    const whole = await remote.workspaceFiles.readAll(sessionId, path, signal)
    if (!whole.ok) throw new Error(`${path}: ${whole.error.code}: ${whole.error.message}`)
    return decodeBase64(whole.value.data)
  }
  if (ABSENT_CODES.has(result.error.code)) return undefined
  throw new Error(`${path}: ${result.error.code}: ${result.error.message}`)
}

/**
 * Decode the Remote's base64 byte window as UTF-8 text.
 *
 * @param base64 - the encoded bytes.
 * @returns the decoded text.
 */
function decodeBase64(base64: string): string {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new TextDecoder().decode(bytes)
}

/**
 * Whether a value is a JSON object carrying a schema version.
 *
 * The Kanban tab appears on this answer, so it is deliberately cheap and
 * forgiving: a document that names its version is a composer project even if its
 * body has since been corrupted, and the panel is the right place to say so.
 *
 * @param raw - the document's text.
 * @returns the document's self-described version, or undefined when it is not one.
 */
export function novelDocumentVersion(raw: string): number | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const version = (parsed as Record<string, unknown>)['schemaVersion']
  return typeof version === 'number' ? version : undefined
}

/**
 * Join a workspace root and a workspace-relative path.
 *
 * The Remote resolves a relative path against the session's own header-derived
 * root, which is exactly the root the caller was given; naming it explicitly
 * simply removes the second guesswork.
 *
 * @param root - the session's workspace root.
 * @param path - a workspace-relative path.
 * @returns an absolute path under that root.
 */
export function underRoot(root: string, path: string): string {
  const trimmed = root.replace(/[/\\]+$/u, '')
  return trimmed === '' ? path : `${trimmed}/${path}`
}

/**
 * Read the whole project behind one session's workspace.
 *
 * Only two reads are unavoidable per chapter — the prose file, which carries
 * `status` and the word count, and the contract file, which carries the beats and
 * the hook. The five whole-book files are read once each.
 *
 * @param remote - the client Remote face.
 * @param sessionId - the session whose workspace to read.
 * @param signal - aborted when the caller unmounts or the session switches.
 * @param workspaceRoot - the session's workspace root; content paths resolve against it.
 * @returns the assembled project, or why there is none.
 */
export async function readProject(
  remote: Remote,
  sessionId: SessionId,
  signal: AbortSignal,
  workspaceRoot: string,
): Promise<ProjectRead> {
  const readFile = (path: string): Promise<string | undefined> =>
    readProjectFile(remote, sessionId, underRoot(workspaceRoot, path), signal)

  let raw: string | undefined
  try {
    raw = await readFile(METADATA_RELATIVE_PATH)
  } catch (error) {
    return { status: 'error', message: describe(error) }
  }
  if (raw === undefined) return { status: 'none' }

  try {
    const { metadata } = parseMetadata(raw)
    const index = metadata.index
    const channels = Object.values(index.chapters)
    const paths = [
      index.outlineFile,
      index.castFile,
      index.worldFile,
      index.volumeFile,
      index.chapterPlanFile,
      ...channels.flatMap((ref) => [ref.bodyFile, ref.outlineFile]),
    ]

    const files: Record<string, string> = {}
    const loaded = await Promise.all(
      [...new Set(paths.filter((path) => path !== ''))].map(async (path) => [path, await readFile(path)] as const),
    )
    for (const [path, text] of loaded) if (text !== undefined) files[path] = text

    const assembled = composeContent(files, index, metadata.opening)
    return { status: 'ready', raw, metadata, state: stateOf(metadata, assembled) }
  } catch (error) {
    return { status: 'error', message: describe(error) }
  }
}

/**
 * Render one failure as the single line a panel shows.
 *
 * @param error - the thrown value.
 * @returns its message, or its string form when it is not an Error.
 */
export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
