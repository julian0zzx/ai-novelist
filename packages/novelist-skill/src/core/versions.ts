/**
 * The safety net under `novel_write`: keep the previous body of a chapter that is
 * about to be replaced.
 *
 * A chapter's prose is the one thing in this project that cannot be re-derived —
 * the outline, the bible and the ledger can all be rebuilt from a conversation,
 * but a deleted draft is gone. So an overwrite archives what it is about to
 * destroy, under `.novel/versions/`, one file per chapter per write.
 *
 * The archive is deliberately plain Markdown rather than a field on `Chapter`: it
 * has to survive a state migration, be readable without the plugin, and cost
 * nothing when the author never overwrites anything.
 *
 * @module @ai-novelist/novelist-skill/core/versions
 */

import type { Chapter } from './types.ts'

/** Where overwritten chapter bodies are kept, workspace-relative. */
export const VERSIONS_DIR = '.novel/versions'

/**
 * A filesystem- and sort-friendly stamp for one archive file.
 *
 * Colons are dropped because the name has to be legal on Windows, and the
 * milliseconds are dropped because two writes in the same second are the same
 * save as far as a human is concerned.
 *
 * @param at - the ISO-8601 write time.
 * @returns e.g. `20240501T000000Z`.
 */
export function versionStamp(at: string): string {
  return at.replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')
}

/**
 * The path one archived body is written to, workspace-relative.
 *
 * The chapter number is padded so a directory listing sorts in reading order, and
 * the timestamp keeps two archives of the same chapter apart.
 *
 * @param chapter - the chapter being overwritten.
 * @param at - the ISO-8601 write time.
 * @returns the relative path.
 */
export function versionPath(chapter: Chapter, at: string): string {
  return `${VERSIONS_DIR}/${String(chapter.number).padStart(3, '0')}-${versionStamp(at)}.md`
}

/**
 * The archived document.
 *
 * The header repeats what the state said at the moment of the overwrite — status,
 * word count, timestamp — because the file is meant to be restorable by hand:
 * everything a person needs to decide "put this back" is on the first three lines.
 *
 * @param chapter - the chapter as it was before the overwrite.
 * @param at - the ISO-8601 write time.
 * @returns the file content.
 */
export function renderChapterVersion(chapter: Chapter, at: string): string {
  const title = chapter.title.trim() === '' ? '' : ` ${chapter.title}`
  return [
    `# 第 ${String(chapter.number)} 章${title}（被覆盖前的存档）`,
    '',
    `> 存档于 ${at}；存档时状态 ${chapter.status}；${String(chapter.wordCount)} 字；原 updatedAt ${chapter.updatedAt}。`,
    '> 这是上一版正文，要恢复就整段复制回 `novel_write`。',
    '',
    chapter.body.trimEnd(),
    '',
  ].join('\n')
}
