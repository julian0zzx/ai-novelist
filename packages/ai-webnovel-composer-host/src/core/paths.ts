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
 * @module @ai-webnovel/composer-host/core/paths
 */

import type { StorageLayout } from './types.ts'

/** The layout the plan fixes: five Chinese filenames and a `章节/` directory. */
export const DEFAULT_STORAGE_LAYOUT: StorageLayout = {
  outlineFile: '全书大纲.md',
  castFile: '人物设定.md',
  worldFile: '世界观设定.md',
  volumeFile: '分卷大纲.md',
  chapterPlanFile: '章节大纲.md',
  chapterDir: '章节',
}

/** The path of the metadata document, relative to the workspace root. */
export const METADATA_RELATIVE_PATH = '.novel/novel.json'

/** Where a pre-split document is preserved during migration, before it is overwritten. */
export const MIGRATION_BACKUP_PATH = '.novel/novel.v2.backup.json'

/**
 * The five top-level content paths, in the order they are written.
 *
 * Read path-driven rather than position-driven: the plan's own note on a
 * 1000-chapter book leaves room for the chapter plan to split per volume later,
 * and code that iterates this list will not have to change when it does.
 *
 * @param layout - the storage layout.
 * @returns the workspace-relative paths.
 */
export function topLevelPaths(layout: StorageLayout = DEFAULT_STORAGE_LAYOUT): string[] {
  return [layout.outlineFile, layout.castFile, layout.worldFile, layout.volumeFile, layout.chapterPlanFile]
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
  const stem = `${layout.chapterDir}/${chapterStem(number, title)}`
  return { bodyFile: `${stem}.md`, outlineFile: `${stem}.细纲.md` }
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
