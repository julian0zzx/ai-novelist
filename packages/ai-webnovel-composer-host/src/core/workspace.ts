/**
 * Workspace classification: is the directory this agent runs in a novel project?
 *
 * The composer tools are useless in an unrelated repository and indispensable in
 * a novel directory, so the plugin decides once at boot rather than leaving the
 * model to guess. The decision is deliberately conservative and explainable: a
 * workspace is only *adopted* (marked with a project document the agent can see)
 * when it already carries a composer marker, or when it is an empty/new
 * directory — because a directory that was just created for a session is the one
 * case where "start a novel here" is unambiguously the intent.
 *
 * @module @ai-webnovel/composer-host/core/workspace
 */

import type { FsDirEntry } from '@deepseek-ai/dsh-fs'

/** What the workspace looks like to the composer. */
export const WORKSPACE_KINDS = ['novel', 'fresh', 'plain'] as const

/** One entry of {@link WORKSPACE_KINDS}. */
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number]

/** Project directory name; also the marker that identifies a novel workspace. */
export const NOVEL_DIR = '.novel'

/** Filenames that mark a draft-in-progress novel when they sit at the root. */
const NOVEL_ROOT_FILES = ['novel.json', 'outline.md', 'story-bible.md', 'bible.md', 'characters.md', 'synopsis.md']

/** How many loose Markdown files it takes to look like a manuscript directory. */
const DRAFT_FILE_THRESHOLD = 3

/** Entry names that mean "this directory is a project of some kind", not a novel draft. */
const NON_NOVEL_MARKERS = [
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'CMakeLists.txt',
  'composer.json',
  'Gemfile',
  'Makefile',
  '.git',
]

/** Why the workspace was classified the way it was; shown to the user, not the model. */
export type WorkspaceReason =
  | 'project-document'
  | 'novel-directory'
  | 'draft-files'
  | 'empty-directory'
  | 'soft-signals'
  | 'unrelated-project'
  | 'no-novel-signals'

/** The classification plus the evidence behind it. */
export interface WorkspaceVerdict {
  /** What the composer should do here. */
  readonly kind: WorkspaceKind
  /** The signal that decided it. */
  readonly reason: WorkspaceReason
  /** Whether the workspace carries a `.novel` directory already. */
  readonly hasProjectDocument: boolean
  /** Human-readable evidence, for the panel and the prompt section. */
  readonly evidence: readonly string[]
}

/** Filenames that read as chapter prose, in either script. */
const CHAPTER_FILE = /^(?:chapter|ch|chap|第)\s*[-_.]?\s*\d+/iu

/**
 * Whether a filename looks like a chapter or a manuscript section.
 *
 * @param name - the file's basename.
 * @returns true for `chapter-01.md`, `第3章.md`, `003-青云宗.md`, and similar.
 */
export function looksLikeChapterFile(name: string): boolean {
  const lower = name.toLowerCase()
  if (!lower.endsWith('.md') && !lower.endsWith('.txt')) return false
  if (CHAPTER_FILE.test(name)) return true
  // `003-title.md`: a bare index prefix, which is how most long drafts are named.
  return /^\d{1,4}[-_.\s]/u.test(name)
}

/**
 * Count the loose manuscript-looking files directly inside a directory listing.
 *
 * Only regular files at the root count: a `docs/` directory full of Markdown is
 * documentation, not a draft.
 *
 * @param entries - the directory's entries.
 * @returns how many entries look like chapters.
 */
export function countDraftFiles(entries: readonly FsDirEntry[]): number {
  return entries.filter((entry) => entry.type === 'file' && looksLikeChapterFile(entry.name)).length
}

/**
 * Classify a workspace from one listing of its root plus the presence of the
 * composer's own document.
 *
 * Precedence, most decisive first:
 *
 * 1. `.novel/novel.json` present → `novel` (the project document is authoritative).
 * 2. a `.novel` directory present → `novel` (a half-initialized project is still one).
 * 3. an unrelated project root (`package.json`, `.git`, …) → `plain`, even with
 *    a few Markdown files: a repo README is not a novel.
 * 4. an empty directory → `fresh` (this is the "make me a novel here" case).
 * 5. three or more chapter-shaped files → `novel`, adopted from an existing draft.
 * 6. a novel-shaped root file or one chapter-shaped file → `fresh` (soft signals:
 *    invite, but do not silently claim the directory).
 * 7. anything else → `plain`.
 *
 * @param entries - the workspace root's entries.
 * @param hasProjectDocument - whether `<root>/.novel/novel.json` exists.
 * @param hasNovelDir - whether `<root>/.novel` exists at all.
 * @returns the verdict with its evidence.
 */
export function classifyWorkspace(
  entries: readonly FsDirEntry[],
  hasProjectDocument: boolean,
  hasNovelDir: boolean,
): WorkspaceVerdict {
  const names = entries.map((entry) => entry.name)
  const draftFiles = countDraftFiles(entries)
  const softRootFiles = names.filter((name) => NOVEL_ROOT_FILES.includes(name.toLowerCase()))
  const projectMarkers = names.filter((name) => NON_NOVEL_MARKERS.includes(name))

  if (hasProjectDocument) {
    return { kind: 'novel', reason: 'project-document', hasProjectDocument: true, evidence: [`${NOVEL_DIR}/novel.json`] }
  }
  if (hasNovelDir) {
    return { kind: 'novel', reason: 'novel-directory', hasProjectDocument: true, evidence: [`${NOVEL_DIR}/`] }
  }
  if (projectMarkers.length > 0) {
    return { kind: 'plain', reason: 'unrelated-project', hasProjectDocument: false, evidence: projectMarkers }
  }
  if (entries.length === 0) {
    return { kind: 'fresh', reason: 'empty-directory', hasProjectDocument: false, evidence: ['(empty workspace)'] }
  }
  if (draftFiles >= DRAFT_FILE_THRESHOLD) {
    return {
      kind: 'novel',
      reason: 'draft-files',
      hasProjectDocument: false,
      evidence: [`${String(draftFiles)} chapter-shaped files`],
    }
  }
  if (softRootFiles.length > 0 || draftFiles > 0) {
    return {
      kind: 'fresh',
      reason: 'soft-signals',
      hasProjectDocument: false,
      evidence: [...softRootFiles, ...(draftFiles > 0 ? [`${String(draftFiles)} chapter-shaped file(s)`] : [])],
    }
  }
  return { kind: 'plain', reason: 'no-novel-signals', hasProjectDocument: false, evidence: names.slice(0, 5) }
}

/**
 * One line describing the verdict, for the prompt section and the panel.
 *
 * @param verdict - the classification.
 * @returns prose naming the workspace kind and its evidence.
 */
export function describeVerdict(verdict: WorkspaceVerdict): string {
  const evidence = verdict.evidence.join(', ')
  switch (verdict.reason) {
    case 'project-document':
      return `This workspace holds a novel project (${evidence}).`
    case 'novel-directory':
      return `This workspace holds a novel project directory (${evidence}) but no project document yet.`
    case 'draft-files':
      return `This workspace looks like an existing novel draft (${evidence}).`
    case 'empty-directory':
      return 'This workspace is empty, so it is the novel project being started here.'
    case 'soft-signals':
      return `This workspace may be a novel project (${evidence}), but it is not marked as one yet.`
    case 'unrelated-project':
      return `This workspace is a software project (${evidence}), not a novel workspace.`
    case 'no-novel-signals':
      return 'This workspace shows no sign of being a novel project.'
  }
}
