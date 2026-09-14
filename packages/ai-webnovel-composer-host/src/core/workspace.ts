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
  | 'novel-signals'
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
 * Filenames that read as a creative-writing note rather than a project document.
 *
 * This is what a book folder actually contains on the first day: the premise
 * written down, the cast, the outline, the notes — in Chinese or in English.
 * Matched anywhere in the stem so `创意整理.md`, `故事大纲.md` and
 * `story-notes.md` all count. Only Markdown and text files qualify: a
 * `SETUP.md` in a repository is documentation, and repositories are excluded
 * earlier anyway.
 */
const CREATIVE_NOTE_FILE =
  /(?:创意|设定|大纲|细纲|人设|角色|故事|小说|剧情|梗概|文案|素材|灵感|novel|story|stories|plot|outline|premise|character|setting|chapter|manuscript|draft|synopsis|prose)/iu

/** How many independent signals make a directory unmistakably a novel draft. */
const STRONG_SIGNAL_THRESHOLD = 2

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
 * Whether a filename reads as a creative-writing note.
 *
 * @param name - the file's basename.
 * @returns true for `创意整理.md`, `人物设定.md`, `story-notes.md`, and similar.
 */
export function looksLikeCreativeNote(name: string): boolean {
  const lower = name.toLowerCase()
  if (!lower.endsWith('.md') && !lower.endsWith('.txt')) return false
  return CREATIVE_NOTE_FILE.test(name)
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
 * 5. unmistakable novel material → `novel` with reason `novel-signals`: three or
 *    more chapter-shaped files, two or more novel-shaped root files, or a single
 *    creative-writing note — see {@link hasNovelSignals} for why a note is worth
 *    two signals.
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
  const evidence = novelEvidence(entries)
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
  if (evidence.drafts >= DRAFT_FILE_THRESHOLD) {
    return {
      kind: 'novel',
      reason: 'draft-files',
      hasProjectDocument: false,
      evidence: [`${String(evidence.drafts)} chapter-shaped files`],
    }
  }
  if (evidence.weight >= STRONG_SIGNAL_THRESHOLD) {
    return { kind: 'novel', reason: 'novel-signals', hasProjectDocument: false, evidence: evidence.names }
  }
  if (evidence.roots.length > 0 || evidence.drafts > 0) {
    return {
      kind: 'fresh',
      reason: 'soft-signals',
      hasProjectDocument: false,
      evidence: [...evidence.roots, ...(evidence.drafts > 0 ? [`${String(evidence.drafts)} chapter-shaped file(s)`] : [])],
    }
  }
  return { kind: 'plain', reason: 'no-novel-signals', hasProjectDocument: false, evidence: names.slice(0, 5) }
}

/** The unmarked novel evidence one listing carries, each file counted once. */
interface NovelEvidence {
  /** Every signal's display name, for the verdict's evidence line. */
  readonly names: readonly string[]
  /** Files named like a novel component the composer knows by name. */
  readonly roots: readonly string[]
  /** Chapter-shaped files. */
  readonly drafts: number
  /** The weighted total compared against {@link STRONG_SIGNAL_THRESHOLD}. */
  readonly weight: number
}

/**
 * Read the unmarked novel evidence in one directory listing.
 *
 * Each file counts **once**, by the most specific rule that matches it: a
 * chapter-shaped file is a chapter, a name the composer knows is a root file, and
 * anything else whose name reads as creative writing is a note. Counting a file
 * under two rules is how `outline.md` would otherwise weigh two all by itself,
 * which is exactly the kind of accident that makes a heuristic claim a directory.
 *
 * @param entries - the directory's entries.
 * @returns the evidence, ready to weigh.
 */
function novelEvidence(entries: readonly FsDirEntry[]): NovelEvidence {
  const names: string[] = []
  const roots: string[] = []
  let drafts = 0
  let notes = 0
  for (const entry of entries) {
    if (entry.type !== 'file') continue
    const name = entry.name
    if (looksLikeChapterFile(name)) {
      drafts += 1
      names.push(name)
      continue
    }
    if (NOVEL_ROOT_FILES.includes(name.toLowerCase())) {
      roots.push(name)
      names.push(name)
      continue
    }
    if (looksLikeCreativeNote(name)) {
      notes += 1
      names.push(name)
    }
  }
  return { names, roots, drafts, weight: notes * 2 + roots.length + drafts }
}

/**
 * Weigh the unmarked novel evidence in one directory listing.
 *
 * A creative-writing note is worth **two** signals on its own, and everything
 * else one. That asymmetry is the whole rule: a file whose name says "premise"
 * or "creative notes" is not a generic Markdown file — it is the most specific
 * evidence available without a project document, and in practice it is the first
 * thing a folder made for a book contains. A lone `README.md` weighs nothing;
 * a `创意整理.md`, a `人物设定.md` or a `story-outline.md` is already a draft
 * someone is writing.
 *
 * @param entries - the directory's entries.
 * @returns the evidence weight, compared against {@link STRONG_SIGNAL_THRESHOLD}.
 */
export function novelSignalCount(entries: readonly FsDirEntry[]): number {
  return novelEvidence(entries).weight
}

/**
 * Whether a verdict justifies creating the project document.
 *
 * The rule is the one the plugin has always applied at boot, extracted so the
 * *session's* workspace can be held to exactly the same standard as the
 * deployment's: evidence of a novel (`novel`) is enough, and a merely empty
 * directory (`fresh`) is only enough when the deployment opted in — a workspace
 * is a directory the user chose, and writing files into it before they ask is a
 * surprise.
 *
 * @param verdict - the classification to judge.
 * @param options - the deployment's adoption policy.
 * @param options.adoptEmptyWorkspace - whether an empty directory may be claimed.
 * @returns true when the composer may write the project document there.
 */
export function adoptableVerdict(
  verdict: WorkspaceVerdict,
  options: { readonly adoptEmptyWorkspace: boolean },
): boolean {
  return verdict.kind === 'novel' || (verdict.kind === 'fresh' && options.adoptEmptyWorkspace)
}

/**
 * Whether a directory that is *not* a code project is unmistakably a novel draft.
 *
 * The composer's most common first contact is not an empty directory and not a
 * marked project: it is a folder someone made for a book, holding what they have
 * written down so far — a premise file, a cast file, a few chapters. None of
 * those is the project document, so {@link classifyWorkspace} cannot call the
 * directory a novel one; but a deployment that has opted into
 * `workspaceMode: 'signal'` may still initialize the project there, because a
 * `.novel/novel.json` scaffold is idempotent, carries no story decisions, and is
 * what makes the composer's tools, prompt section and board exist at all.
 *
 * The threshold is deliberately **two** independent signals, not one. One
 * Markdown file is true of half the directories on a laptop (a README, a note, a
 * licence summary); two novel-shaped ones — say a premise file *and* a cast file,
 * or a premise file *and* a chapter — are a draft being written. A directory
 * carrying project markers is never eligible, however much Markdown it holds:
 * that is a repository with documentation.
 *
 * @param verdict - the classification to judge.
 * @returns true when the workspace shows unmistakable, unmarked novel evidence.
 */
export function hasNovelSignals(verdict: WorkspaceVerdict): boolean {
  return verdict.reason === 'novel-signals'
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
    case 'novel-signals':
      return `This workspace holds novel material (${evidence}) but no project document yet.`
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
