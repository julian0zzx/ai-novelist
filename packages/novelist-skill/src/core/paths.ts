/**
 * Where the content files live: the plan's §2 file tree, as pure path arithmetic.
 *
 * Split out from the codec because both sides of the storage layer need it —
 * `core/novel` to point a migrated index at the files it is about to create, and
 * `core/content` to read and write them — and neither should have to import the
 * other to spell a filename.
 *
 * The **stable key is the chapter `id`**, not the filename: the id travels in the
 * file's own frontmatter, so a title change (and the rename it triggers) can be
 * recovered by looking the id up in the index rather than by re-deriving a name.
 *
 * @module @ai-novelist/novelist-skill/core/paths
 */

import type { StorageLayout } from './types.ts'

/** The layout the plan fixes: five Chinese filenames and two content directories. */
export const DEFAULT_STORAGE_LAYOUT: StorageLayout = {
  outlineFile: '全书大纲.md',
  castFile: '人物设定.md',
  worldFile: '世界观设定.md',
  volumeDir: '分卷大纲',
  chapterPlanFile: '章节大纲.md',
  chapterPlanDir: '章节大纲',
  competitorFile: '竞品拆解.md',
  chapterDir: '章节',
}

/** The path of the metadata document, relative to the workspace root. */
export const METADATA_RELATIVE_PATH = '.novel/novel.json'

/** Where a pre-split document is preserved during migration, before it is overwritten. */
export const MIGRATION_BACKUP_PATH = '.novel/novel.v2.backup.json'

/**
 * The directory a model or author may have invented for "the settings".
 *
 * The composer has exactly one home per document (the five top-level files and
 * the two per-item directories), so a numbered `设定/` folder is always a second
 * copy of something the tool already writes elsewhere. The store folds its
 * contents into the canonical files and archives the originals instead of
 * letting two versions of the same outline drift apart. See
 * {@link settingsDocumentKind}.
 */
export const LEGACY_SETTINGS_DIR = '设定'

/** Where a duplicate that was folded into a canonical file is preserved. */
export const DUPLICATE_BACKUP_DIR = '.novel/duplicates'

/** The canonical documents a `设定/` file can duplicate. */
export type SettingsDocumentKind = 'outline' | 'cast' | 'world' | 'volumes'

/**
 * Which canonical settings document a file in {@link LEGACY_SETTINGS_DIR} copies.
 *
 * Matched on the basename only, and deliberately loose: the folder is not a
 * format, it is an accident, and the numbered prefixes (`02-…`) carry no meaning
 * worth parsing. A file that names none of the four documents is left alone —
 * the composer does not own everything an author puts in a folder.
 *
 * @param fileName - a basename or a path such as `设定/04-全书大纲.md`.
 * @returns the document it duplicates, or `undefined` when it duplicates none.
 */
export function settingsDocumentKind(fileName: string): SettingsDocumentKind | undefined {
  const base = (fileName.split('/').pop() ?? fileName).toLowerCase()
  if (/分卷大纲|卷纲/u.test(base)) return 'volumes'
  if (/全书大纲|总大纲/u.test(base)) return 'outline'
  if (/人物设定|人设|角色设定/u.test(base)) return 'cast'
  if (/世界观设定|世界观/u.test(base)) return 'world'
  return undefined
}

/**
 * The old single-file home of the volume outlines, kept only so the version-3
 * reader can find it.
 *
 * Version 4 moved every volume into its own file under {@link
 * DEFAULT_STORAGE_LAYOUT.volumeDir}; a document written before that names its
 * collection file in `index.volumeFile`, which the migration reads and then
 * deletes once the per-volume files exist.
 */
export const LEGACY_VOLUME_FILE = '分卷大纲.md'

/**
 * The top-level content paths, in the order they are written.
 *
 * Read path-driven rather than position-driven: the plan's own note on a
 * 1000-chapter book leaves room for the chapter plan to split per volume later,
 * and code that iterates this list will not have to change when it does. The
 * volume outlines and the chapters are not here: each of them is one file per
 * unit inside its own directory.
 *
 * @param layout - the storage layout.
 * @returns the workspace-relative paths.
 */
export function topLevelPaths(layout: StorageLayout = DEFAULT_STORAGE_LAYOUT): string[] {
  return [
    layout.outlineFile,
    layout.castFile,
    layout.worldFile,
    layout.chapterPlanFile,
    layout.competitorFile,
  ]
}

/**
 * Sanitize a chapter title for use in a filename.
 *
 * Removes the characters both Windows and POSIX treat specially, strips control
 * characters and surrounding whitespace or dots, and truncates to 40 characters
 * (the plan's own limit, chosen so `第001章-` plus a title stays well inside a
 * filesystem's name budget).
 *
 * @param title - the chapter title.
 * @returns the sanitized fragment, possibly `''`.
 */
export function sanitizeTitle(title: string): string {
  return title
    .replace(/[/\\:*?"<>|]/gu, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/gu, '')
    .slice(0, 40)
}

/**
 * Format a chapter number the way the plan spells it in filenames.
 *
 * @param number - the 1-based chapter number.
 * @returns the zero-padded, three-digit form.
 */
export function padChapterNumber(number: number): string {
  return String(Math.max(0, Math.trunc(number))).padStart(3, '0')
}

/**
 * The base filename of one chapter, without extension.
 *
 * @param number - the chapter number.
 * @param title - the chapter title; `''` yields the bare `第001章`.
 * @returns the filename stem.
 */
export function chapterStem(number: number, title: string): string {
  const clean = sanitizeTitle(title)
  return clean === '' ? `第${padChapterNumber(number)}章` : `第${padChapterNumber(number)}章-${clean}`
}

/**
 * Both workspace-relative paths of one chapter.
 *
 * The prose and its contract deliberately live apart: the prose is the
 * manuscript (`章节/`), while the contract is an outline and belongs with the
 * rest of the outlines (`章节大纲/`). Keeping two files that describe the same
 * chapter in one directory made `章节/` read like "everything about chapters" —
 * so the folder filled with plans a reader of the manuscript never wants, and
 * the contract was the harder file to find.
 *
 * @param number - the chapter number.
 * @param title - the chapter title.
 * @param layout - the storage layout.
 * @returns the prose path and the contract path.
 */
export function chapterPaths(
  number: number,
  title: string,
  layout: StorageLayout = DEFAULT_STORAGE_LAYOUT,
): { readonly bodyFile: string; readonly outlineFile: string } {
  const stem = chapterStem(number, title)
  return {
    bodyFile: `${layout.chapterDir}/${stem}.md`,
    outlineFile: `${layout.chapterPlanDir}/${stem}.细纲.md`,
  }
}

/**
 * Where a chapter contract lived before it moved into the chapter-plan directory.
 *
 * Used only by the read-time migration, which moves every `章节/*.细纲.md` to
 * its canonical home; a project written by this build never produces this path.
 *
 * @param fileName - the old contract path (or basename).
 * @param layout - the storage layout.
 * @returns the workspace-relative legacy path.
 */
export function legacyChapterOutlinePath(
  fileName: string,
  layout: StorageLayout = DEFAULT_STORAGE_LAYOUT,
): string {
  const base = fileName.split('/').pop() ?? fileName
  return `${layout.chapterDir}/${base}`
}

/**
 * The canonical path of a chapter contract, for a file that may sit at the
 * legacy `章节/` location.
 *
 * @param fileName - the contract path (or basename).
 * @param layout - the storage layout.
 * @returns the workspace-relative canonical path.
 */
export function canonicalChapterOutlinePath(
  fileName: string,
  layout: StorageLayout = DEFAULT_STORAGE_LAYOUT,
): string {
  const base = fileName.split('/').pop() ?? fileName
  return `${layout.chapterPlanDir}/${base}`
}

/**
 * Recover a chapter number from a filename, for a file that arrived without one.
 *
 * Only a fallback: the number recorded in the file's own frontmatter wins, and
 * the index is consulted before either.
 *
 * @param fileName - a path or basename such as `章节/第001章-山门.md`.
 * @returns the number, or `undefined` when the name carries none.
 */
export function numberFromFileName(fileName: string): number | undefined {
  const match = /第(\d{1,6})章/u.exec(fileName)
  if (match === null) return undefined
  const value = Number.parseInt(match[1] ?? '', 10)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

// ── volume outlines ───────────────────────────────────────────────────────────

/**
 * The filename of one volume's outline.
 *
 * The number is the whole name — no title, no zero padding. A title in the name
 * would move the file every time the author retitled a volume, which is the one
 * thing a per-volume file exists to avoid; and padding would only matter for a
 * directory listing nobody sorts by hand, since every reader sorts by the number
 * in the file's frontmatter.
 *
 * @param number - the 1-based volume number.
 * @returns the basename, e.g. `第1卷.md`.
 */
export function volumeFileName(number: number): string {
  return `第${String(Math.max(0, Math.trunc(number)))}卷.md`
}

/**
 * The path of one volume's outline file.
 *
 * Takes just the directory rather than a whole {@link StorageLayout}, because
 * both halves of the storage layer compute it: the codec with the configured
 * layout, and the migration with a {@link StorageIndex}, which records the
 * directory but not the rest of the layout.
 *
 * @param number - the volume number.
 * @param home - the layout, or anything carrying the volume directory.
 * @returns the path, e.g. `分卷大纲/第1卷.md`.
 */
export function volumePath(
  number: number,
  home: { readonly volumeDir: string } = DEFAULT_STORAGE_LAYOUT,
): string {
  return `${home.volumeDir}/${volumeFileName(number)}`
}

/**
 * Recover a volume number from a volume outline's filename.
 *
 * @param fileName - a path or basename such as `分卷大纲/第1卷.md`.
 * @returns the number, or `undefined` when the name carries none.
 */
export function volumeNumberFromFileName(fileName: string): number | undefined {
  const match = /第(\d{1,6})卷/u.exec(fileName)
  if (match === null) return undefined
  const value = Number.parseInt(match[1] ?? '', 10)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

// ── chapter plans ─────────────────────────────────────────────────────────────

/**
 * The name of the chapter-plan file holding the chapters filed under no volume.
 *
 * A chapter can be planned before it is assigned to a volume — and a 不分卷 book
 * never assigns one — so the directory needs a bucket that is not a volume.
 * `未分卷.md` says what it is in both cases, which `第0卷.md` would not.
 */
export const UNASSIGNED_VOLUME_FILE = '未分卷.md'

/**
 * The filename of one volume's chapter table and rhythm table.
 *
 * The volume number is the whole name, for the same reason the volume outlines
 * are named that way: a file that never moves is a file nobody has to re-find.
 *
 * @param volume - the volume the file covers; 0 for the unassigned bucket.
 * @returns the basename, e.g. `第1卷.md` or `未分卷.md`.
 */
export function chapterPlanFileName(volume: number): string {
  const number = Math.trunc(volume)
  return number > 0 ? volumeFileName(number) : UNASSIGNED_VOLUME_FILE
}

/**
 * The workspace-relative path of one volume's chapter-plan file.
 *
 * @param volume - the volume the file covers; 0 for the unassigned bucket.
 * @param home - the layout, or anything carrying the chapter-plan directory.
 * @returns the path, e.g. `章节大纲/第1卷.md`.
 */
export function chapterPlanPath(
  volume: number,
  home: { readonly chapterPlanDir: string } = DEFAULT_STORAGE_LAYOUT,
): string {
  return `${home.chapterPlanDir}/${chapterPlanFileName(volume)}`
}

/**
 * Recover the volume a chapter-plan file covers from its filename.
 *
 * @param fileName - a path or basename such as `章节大纲/第1卷.md`.
 * @returns the volume, `0` for `未分卷.md`, or `undefined` when the name carries neither.
 */
export function chapterPlanVolumeFromFileName(fileName: string): number | undefined {
  const base = fileName.split('/').pop() ?? fileName
  if (base === UNASSIGNED_VOLUME_FILE) return 0
  return volumeNumberFromFileName(base)
}

/**
 * Whether a path sits inside the volume-outline directory.
 *
 * @param relativePath - a workspace-relative path.
 * @param layout - the storage layout.
 * @returns true when the path is a direct child of the volume directory.
 */
export function isVolumePath(relativePath: string, layout: StorageLayout = DEFAULT_STORAGE_LAYOUT): boolean {
  const prefix = `${layout.volumeDir}/`
  if (!relativePath.startsWith(prefix)) return false
  const rest = relativePath.slice(prefix.length)
  return rest !== '' && !rest.includes('/')
}

/**
 * Whether a path is a chapter *contract* file rather than prose.
 *
 * @param relativePath - a workspace-relative path.
 * @returns true for `*.细纲.md`.
 */
export function isOutlineFile(relativePath: string): boolean {
  return /\.细纲\.md$/u.test(relativePath)
}

/**
 * Whether a path is a Markdown file this plugin might own.
 *
 * @param relativePath - a workspace-relative path.
 * @returns true for `*.md`.
 */
export function isMarkdownFile(relativePath: string): boolean {
  return /\.md$/u.test(relativePath)
}

/**
 * Whether a path sits inside the chapter directory.
 *
 * @param relativePath - a workspace-relative path.
 * @param layout - the storage layout.
 * @returns true when the path is a direct child of the chapter directory.
 */
export function isChapterPath(relativePath: string, layout: StorageLayout = DEFAULT_STORAGE_LAYOUT): boolean {
  const prefix = `${layout.chapterDir}/`
  if (!relativePath.startsWith(prefix)) return false
  const rest = relativePath.slice(prefix.length)
  return rest !== '' && !rest.includes('/')
}
