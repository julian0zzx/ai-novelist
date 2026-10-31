/**
 * The plugin's `novelState` service: project state assembled from a metadata
 * document plus the Markdown files that hold the novel's content.
 *
 * Why a service instead of direct file access in each tool: every reader and
 * both surfaces (model tools and the Web UI) then share one containment rule,
 * one write order, and one failure report, so a chapter can never be written
 * through a code path that skipped them.
 *
 * The shape of the storage, and why:
 *
 * - **Metadata is atomic, content is not.** `.novel/novel.json` still moves in a
 *   single version-guarded `replaceIfVersion`, because it holds the index and the
 *   evidence chain the threshold rules compute on. The novel's prose is a set of
 *   files a human edits, and a multi-file write has no transaction — so content
 *   is written **first** and metadata **last** ({@link NovelStore.update}). The
 *   index is a signpost: for the length of one write it may point at older
 *   content, but it must never point at a file that does not exist.
 * - **The file wins.** An edit made in the author's own editor is authoritative,
 *   so every read adopts it and refreshes the index. The one guard rail is
 *   syntax: a file that cannot be parsed is reported **with its path and the
 *   parser's complaint** and is never overwritten, because guessing at a broken
 *   file is how a draft gets destroyed.
 * - **Failures name the files.** A write that dies halfway reports exactly which
 *   files landed and which did not ({@link NovelStoreError.filesWritten}), so the
 *   caller can finish the job instead of re-running it blind.
 * - **Containment is path arithmetic.** Every path goes through
 *   {@link NovelStore.contain}, never a string-prefix test.
 *
 * @module @ai-novelist/novelist-skill/src/host/store
 */

import type { Context } from '@deepseek-ai/cordis'
import { unlink } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'
import type { FileSystem, FsDirEntry, FsInfo, FsTarget, FsVersion } from '@deepseek-ai/dsh-fs'
import {
  NOVEL_SCHEMA_VERSION,
  NovelContentError,
  NovelStoreError,
  composeContent,
  decomposeContent,
  emptyIndex,
  frontNumber,
  hashContent,
  metadataOf,
  parseCastFile,
  parseChapterPlanCollectionFile,
  parseChapterPlanVolumeFile,
  parseDocument,
  parseMetadata,
  parseOutlineFile,
  parseVolumeFile,
  planVolumesOf,
  parseVolumeCollectionFile,
  renderCastFile,
  renderChapterPlanFile,
  renderChapterPlanVolumeFile,
  renderChapterVersion,
  renderOutlineFile,
  renderVolumeFile,
  renderWorldFile,
  serializeMetadata,
  stateOf,
  parseWorldFile,
  type Chapter,
  type Clock,
  type YamlMap,
  systemClock,
  versionPath,
} from '../core/index.ts'
import {
  DEFAULT_STORAGE_LAYOUT,
  DUPLICATE_BACKUP_DIR,
  LEGACY_SETTINGS_DIR,
  METADATA_RELATIVE_PATH,
  MIGRATION_BACKUP_PATH,
  canonicalChapterOutlinePath,
  chapterPaths,
  chapterPlanPath,
  chapterPlanVolumeFromFileName,
  isMarkdownFile,
  isOutlineFile,
  legacyChapterOutlinePath,
  settingsDocumentKind,
  topLevelPaths,
  volumeNumberFromFileName,
  volumePath,
} from '../core/paths.ts'
import type {
  BeatSlot,
  Character,
  NovelMetadata,
  NovelState,
  StorageIndex,
  StorageLayout,
  VolumePlan,
  WorldEntry,
} from '../core/types.ts'
import type { ChapterPlanGroup, ChapterPlanRow } from '../core/content.ts'
import { NOVEL_DIR, classifyWorkspace, type WorkspaceVerdict } from '../core/workspace.ts'
import { currentSandboxPolicy, type CallSandboxPolicy } from './sandbox.ts'

/**
 * Document path, relative to the session workspace root.
 *
 * Re-exported from the core rather than restated: the browser half reads this
 * path without loading the host, so the constant has to live where both halves
 * may import it.
 */
export const NOVEL_RELATIVE_PATH = METADATA_RELATIVE_PATH

/**
 * Largest metadata document this build will write, in bytes.
 *
 * `.novel/novel.json` is an index plus the evidence ledger: it is expected to
 * stay in the low hundreds of kilobytes even for a two-million-character book,
 * because prose, cast, world and volume pacing all live in their own Markdown
 * files. A document that approaches this bound has almost always had content
 * leak back into the metadata (the pre-fix `metadataOf` did exactly that), or a
 * group of writers has been re-escaping one another's strings. Refusing the
 * write is deliberately loud: a 25 MB `novel.json` is not a project the next
 * read can repair, and silently writing it is how the file became unrecoverable.
 */
export const MAX_METADATA_BYTES = 8 * 1024 * 1024

/** Raised when the document changed underneath the caller's read. */
export class NovelConflictError extends Error {
  override readonly name = 'NovelConflictError'
}

/** Registered service name: the resolver, not one store; see `host/resolver.ts`. */
export const NOVEL_SERVICE_NAME = 'novelState'

/** A state together with the version token it was read at. */
export interface VersionedNovel {
  /** The parsed project, assembled from metadata plus content files. */
  readonly state: NovelState
  /** The backend's version token for `.novel/novel.json` at read time. */
  readonly version: FsVersion
  /**
   * Things the read had to work around: an orphan file, a file claimed into the
   * index, an index entry that pointed at nothing. Warnings, never errors —
   * "the file wins" means an unexpected file is adopted or reported, not fatal.
   */
  readonly warnings: readonly string[]
  /**
   * The one-line migration report, when this read is the one that upgraded the
   * project from a pre-split document. Absent otherwise.
   */
  readonly migration?: string | undefined
}

/** What one write did, for the failure report and for `novel_write`'s output. */
export interface WriteReport {
  /** Workspace-relative paths written, in the order they landed. */
  readonly written: readonly string[]
  /** Workspace-relative paths deleted. */
  readonly deleted: readonly string[]
  /** Warnings collected while assembling the state this write derived from. */
  readonly warnings: readonly string[]
  /** True when this write created the project document. */
  readonly created: boolean
}

/** What folding one `设定/` duplicate did, and whether the original can go. */
interface FoldResult {
  /** What happened, for the warning line. */
  readonly note: string
  /** Whether the original was understood and can be archived and removed. */
  readonly archive: boolean
}

/**
 * Raised when a multi-file write failed.
 *
 * The two lists are the point of the class: a caller that sees `filesWritten`
 * non-empty knows the workspace is mid-write and can say so, rather than
 * reporting a clean failure that leaves invisible half-state.
 *
 * Deliberately a **sibling** of {@link NovelConflictError} rather than a
 * subclass: the store raises a plain conflict only when nothing at all was
 * written, so "was anything committed?" is answerable from the error's type.
 */
export class NovelWriteError extends NovelStoreError {
  override readonly name = 'NovelWriteError'

  /** Paths that landed before the failure. */
  readonly filesWritten: readonly string[]

  /** Paths that did not. */
  readonly filesNotWritten: readonly string[]

  /**
   * @param message - what failed.
   * @param detail - the files that landed and the files that did not.
   * @param options - the underlying cause.
   */
  constructor(
    message: string,
    detail: { readonly written: readonly string[]; readonly notWritten: readonly string[] },
    options?: { readonly cause?: unknown },
  ) {
    super(message, options)
    this.filesWritten = detail.written
    this.filesNotWritten = detail.notWritten
  }
}

/** Options accepted by {@link NovelStore}. */
export interface NovelStoreOptions {
  /** Workspace root the content paths resolve against; defaults to the process working directory. */
  readonly workspaceRoot?: string
  /** Clock seam for deterministic tests. */
  readonly clock?: Clock
  /** Names of the top-level content files and the two content directories. */
  readonly layout?: StorageLayout
}

/**
 * Whether a resolved target currently holds a regular file.
 *
 * `FileSystem.stat` returns `undefined` for a missing target, so a directory, a
 * device, or a dangling symlink is reported as "not our document" rather than
 * being read or overwritten.
 *
 * @param fs - the deployment's filesystem service.
 * @param target - the resolved target to inspect.
 * @returns true when a regular file exists at the target.
 */
export async function isRegularFile(fs: FileSystem, target: FsTarget): Promise<boolean> {
  const info = await fs.stat(target)
  return info !== undefined && info.type === 'file'
}

/**
 * Whether an error is one of the backend's guard rejections.
 *
 * Matched structurally rather than by class identity: the error crosses the
 * `dsh-fs` service boundary, so two copies of the package in one process must
 * still agree on what a rejected guard means.
 *
 * @param error - the thrown value.
 * @param code - the `FsErrorCode` to look for.
 * @returns true when the error carries that code.
 */
export function isFsErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}

/**
 * Access to one project: `.novel/novel.json` plus the Markdown files it indexes.
 *
 * Deliberately **not** a Cordis service: one process hosts many projects (one
 * per session workspace), and a service name can only be registered once — an
 * earlier revision extended `Service` and threw `service "novelState" has been
 * registered` the moment a second workspace appeared. The service is the
 * resolver (`ctx.novelState`), which hands out these plain stores.
 *
 * Writes serialize behind one promise chain, re-read immediately before writing,
 * and carry the metadata version they read so the backend rejects the last step
 * if anything landed in between. Reads are cheap but not free — each indexed file
 * is `stat`ed and, when its hash moved, reparsed — so the parsed form of every
 * unchanged file is kept in a process-local cache keyed by content hash. That
 * cache is never a source of truth: dropping it costs time, not correctness.
 */
export class NovelStore {
  /** Absolute root every content path resolves against. */
  readonly workspaceRoot: string

  /** Names of the top-level content files and the two content directories. */
  readonly layout: StorageLayout

  /** The context whose `fs` service every read and write goes through. */
  private readonly ctx: Context

  /** Timestamp source for writes. */
  private readonly clock: Clock

  /** Tail of the write queue; every mutation chains onto it. */
  private queue: Promise<unknown> = Promise.resolve()

  /** One in-flight or completed migration, so concurrent readers migrate once. */
  private migration: Promise<void> | undefined

  /**
   * The migration report the next read returns, cleared as it is consumed.
   *
   * Held rather than returned directly because migration is triggered by
   * `ensureMigrated`, which runs *before* the read that benefits from it.
   */
  private pendingReport: string | undefined

  /**
   * Content hashes seen in this process, mapped to the path they were read at.
   *
   * Not a source of truth — dropping it costs a reparse and nothing else — just
   * the "this file is byte-identical to what we already handled" short circuit.
   */
  private readonly seenHashes = new Map<string, string>()

  /**
   * @param ctx - the context carrying the filesystem service.
   * @param options - workspace root, clock, and layout seams.
   */
  constructor(ctx: Context, options: NovelStoreOptions = {}) {
    this.ctx = ctx
    this.workspaceRoot = options.workspaceRoot ?? process.cwd()
    this.clock = options.clock ?? systemClock
    this.layout = options.layout ?? DEFAULT_STORAGE_LAYOUT
  }

  /** The document path, absolute in the filesystem's execution world. */
  get documentPath(): string {
    return `${this.workspaceRoot.replace(/[/\\]+$/u, '')}/${NOVEL_RELATIVE_PATH}`
  }

  /** The five top-level content paths, workspace-relative. */
  get contentPaths(): readonly string[] {
    return topLevelPaths(this.layout)
  }

  /** The directory holding the per-chapter files, workspace-relative. */
  get chapterDirectory(): string {
    return this.layout.chapterDir
  }

  /** The filesystem service this store writes through. */
  private get fs(): FileSystem {
    return this.ctx.fs
  }

  /**
   * Read the project without its version token.
   *
   * A missing document is not an error: it means the project was never
   * initialized, which the tools surface as orientation rather than a failure.
   *
   * @returns the stored state, or `undefined` when no project exists yet.
   * @throws {NovelStoreError} when the document or an indexed file is unreadable.
   */
  async read(): Promise<NovelState | undefined> {
    const loaded = await this.readVersioned()
    return loaded?.state
  }

  /**
   * Read the project together with the version token a later write must match.
   *
   * @param policy - sandbox policy for this call. Sampled here, at the entry,
   *   and carried down as a value: the write queue below crosses async contexts,
   *   so a queued continuation must never resolve the scope itself.
   * @returns the versioned state, or `undefined` when no project exists yet.
   * @throws {NovelStoreError} when the document or an indexed file is unreadable.
   */
  async readVersioned(
    policy: CallSandboxPolicy | undefined = currentSandboxPolicy(),
  ): Promise<VersionedNovel | undefined> {
    await this.ensureMigrated(policy)
    const loaded = await this.load(policy)
    return loaded === undefined
      ? undefined
      : {
          state: loaded.state,
          version: loaded.version,
          warnings: loaded.warnings,
          ...(loaded.migration === undefined ? {} : { migration: loaded.migration }),
        }
  }

  /**
   * Classify the workspace: is this a novel project, a fresh directory, or
   * something unrelated?
   *
   * One listing of the root plus one existence probe. Failure to list is not an
   * error — an unreadable or absent root classifies as `plain`, which is the
   * conservative answer and keeps boot resilient.
   *
   * @returns the verdict with the evidence behind it.
   */
  async probeWorkspace(): Promise<WorkspaceVerdict> {
    const root = await this.fs.resolve(this.workspaceRoot)
    let entries: FsDirEntry[] = []
    try {
      entries = await this.fs.listDir(root)
    } catch {
      entries = []
    }
    return classifyWorkspace(entries, await this.documentExists(), entries.some((entry) => entry.name === NOVEL_DIR))
  }

  /**
   * Whether `<root>/.novel/novel.json` currently exists.
   *
   * Existence is probed with `stat` rather than by reading, so a document that is
   * present but unreadable still counts as "this directory is a novel workspace"
   * and surfaces as a read error instead of being silently re-initialized.
   *
   * @returns true when the document exists.
   */
  private async documentExists(): Promise<boolean> {
    const target = await this.resolve()
    return (await this.fs.stat(target)) !== undefined
  }

  /**
   * Create the project if the workspace has none, and report what happened.
   *
   * Used at boot for a workspace the composer owns: an existing project is left
   * exactly as it is, and a second call is a no-op, so re-mounting the plugin (or
   * booting a second session against one directory) can never reset a draft.
   *
   * @param state - the state to persist when nothing exists yet.
   * @returns `'created'` when this call wrote the project, `'existing'` otherwise.
   */
  async adopt(
    state: NovelState,
    policy: CallSandboxPolicy | undefined = currentSandboxPolicy(),
  ): Promise<'created' | 'existing'> {
    return this.enqueue(async () => {
      if (await isRegularFile(this.fs, await this.resolve())) return 'existing'
      try {
        await this.writeAll(state, undefined, policy)
        return 'created'
      } catch (error) {
        // A concurrent boot won the race; the workspace now has a project, which
        // is the outcome adoption wanted.
        if (isFsErrorCode(error, 'FS_NOT_OBSERVED')) return 'existing'
        throw error
      }
    })
  }

  /**
   * Create the project, refusing to touch an existing one.
   *
   * @param state - the state to persist.
   * @throws {NovelConflictError} when a project already exists.
   */
  async create(
    state: NovelState,
    policy: CallSandboxPolicy | undefined = currentSandboxPolicy(),
  ): Promise<void> {
    await this.enqueue(async () => {
      if (await isRegularFile(this.fs, await this.resolve())) {
        throw new NovelConflictError(`a novel project already exists at ${NOVEL_RELATIVE_PATH}`)
      }
      try {
        await this.writeAll(state, undefined, policy)
      } catch (error) {
        if (isFsErrorCode(error, 'FS_NOT_OBSERVED')) {
          throw new NovelConflictError(`a novel project already exists at ${NOVEL_RELATIVE_PATH}`)
        }
        throw error
      }
    })
  }

  /**
   * Apply one mutation: read, transform, write the content files, then write the
   * metadata under the version the read carried.
   *
   * The mutation may be async, and the read-to-metadata-write window stays open
   * while it runs. The version guard covers `novel.json` only — deliberately, so
   * that an author editing a chapter in their editor during the call has their
   * work adopted rather than causing a conflict. What the guard prevents is the
   * *index* being overwritten by a write that read a different index.
   *
   * @param mutate - transformation from the current state to the next.
   * @returns the persisted state.
   * @throws {NovelStoreError} when no project has been initialized, or a file is unreadable.
   * @throws {NovelConflictError} when `.novel/novel.json` changed since the read.
   * @throws {NovelWriteError} when a content file could not be written.
   */
  async update(
    mutate: (current: NovelState) => NovelState | Promise<NovelState>,
    policy: CallSandboxPolicy | undefined = currentSandboxPolicy(),
  ): Promise<NovelState> {
    return this.enqueue(async () => {
      const loaded = await this.load(policy)
      if (loaded === undefined) {
        throw new NovelStoreError(`no novel project at ${NOVEL_RELATIVE_PATH}; initialize one first`)
      }
      // `load` builds the state fresh on every call, so nothing it returns is
      // aliased by the file-level caches; it is safe to use as the write's
      // baseline as well as the mutation's input, and that is what keeps the
      // structural diff honest.
      const baseline = loaded.state
      const next = await mutate(baseline)
      return this.write(next, loaded.version, baseline, policy)
    })
  }

  /**
   * Write derived output beside the project — the manuscript, an outline dump,
   * a character sheet. Paths are resolved against the same workspace root as the
   * content files, so an export can never land outside the project directory.
   *
   * @param relativePath - destination relative to the workspace root.
   * @param content - the full text to write.
   * @returns the absolute display path that was written.
   * @throws {NovelStoreError} when the path escapes the workspace root.
   */
  async writeDerived(
    relativePath: string,
    content: string,
    policy: CallSandboxPolicy | undefined = currentSandboxPolicy(),
  ): Promise<string> {
    const destination = this.contain(relativePath)
    const target = await this.fs.resolve(destination)
    await this.fs.writeText(target, content, undefined, undefined, policy)
    return target.displayPath
  }

  /**
   * Archive the body a write is about to replace.
   *
   * The prose is the only artefact here that cannot be re-derived from a
   * conversation, so every overwrite leaves the previous draft on disk under
   * `.novel/versions/` before the state changes. A write that creates the body
   * (no previous prose) archives nothing: there is nothing to lose.
   *
   * @param chapter - the chapter as it stands, before the overwrite.
   * @param at - the ISO-8601 write time, also used in the file name.
   * @returns the absolute display path that was written.
   */
  async archiveChapterVersion(chapter: Chapter, at: string): Promise<string> {
    return this.writeDerived(versionPath(chapter, at), renderChapterVersion(chapter, at))
  }

  /**
   * Resolve one caller-supplied relative path inside the workspace root.
   *
   * Containment is decided by path arithmetic (`resolve` plus a separator-exact
   * prefix test), not by a bare string-prefix test: a prefix test alone would
   * accept a sibling directory whose name merely starts with the root's, and
   * would miss `.`/`..` segments that only collapse once resolved.
   *
   * @param relativePath - the destination, relative to the workspace root.
   * @returns the absolute destination path.
   * @throws {NovelStoreError} when the path escapes the root.
   */
  contain(relativePath: string): string {
    const root = resolve(this.workspaceRoot)
    const destination = resolve(root, relativePath)
    const inside = destination === root || destination.startsWith(root + sep)
    if (isAbsolute(relativePath) || !inside) {
      throw new NovelStoreError(`refusing to write outside the workspace root: ${relativePath}`)
    }
    return destination
  }

  // ── reading ─────────────────────────────────────────────────────────────────

  /**
   * Read the metadata document and assemble the state from the files it indexes.
   *
   * The document is upgraded **first**, inside this call, so every reader — a
   * model tool and the browser half alike — sees a current project rather than
   * one whose content still lives somewhere this build no longer looks.
   *
   * @returns the assembled state with the metadata's version token, or `undefined`.
   */
  private async load(policy: CallSandboxPolicy | undefined): Promise<
    | {
        readonly state: NovelState
        readonly version: FsVersion
        readonly warnings: readonly string[]
        readonly migration?: string | undefined
      }
    | undefined
  > {
    const before = await this.readDocument()
    if (before === undefined) return undefined
    // Parse once on the ordinary path. An older document is migrated and then
    // parsed again, because migration is what changes it.
    let parsed = parseMetadata(before.raw)
    let document = before
    if (parsed.version !== NOVEL_SCHEMA_VERSION) {
      document = (await this.migrateDocument(before.raw, before.info, policy)) ?? before
      parsed = parseMetadata(document.raw)
    }
    // A document the migration could not bring to the current version — a
    // version-3 project with no collection file to split — is upgraded by the
    // metadata write below instead: its index shape and version are what change.
    const upgrade = parsed.version !== NOVEL_SCHEMA_VERSION
    const info = document.info

    const warnings: string[] = []
    const metadata = parsed.metadata

    // A second copy of a settings document is folded into the canonical file
    // before anything is read. It has to run first: the volume case *creates*
    // per-volume files, and `claimVolumes` is what adopts them.
    await this.consolidateDuplicateSettings(metadata.index, warnings, policy)

    // Directory hygiene: put back whatever the index lost, and report files that
    // cannot be claimed at all rather than deleting or ignoring them silently.
    const claimed = await this.claim({ ...metadata.index }, warnings)
    const volumeClaim = await this.claimVolumes(claimed.index, warnings)
    // Contracts now live in `章节大纲/`, so this pass claims a hand-written one
    // there as well as the per-volume tables — one directory listing for both.
    const planClaim = await this.claimChapterPlans(volumeClaim.index, warnings)
    // Chapter contracts moved from `章节/` to `章节大纲/` in 0.3.8. The move is
    // done on read so a project written by an older build keeps working without
    // a version bump: the index ends up naming the new path, and the old file is
    // deleted only after the new one has landed.
    const movedContracts = await this.migrateChapterContracts(planClaim.index, warnings, policy)
    const indexed = movedContracts.index
    const outlineFallback = metadata.opening

    const files: Record<string, string> = {}
    const paths = [
      indexed.outlineFile,
      indexed.castFile,
      indexed.worldFile,
      indexed.chapterPlanFile,
      indexed.competitorFile,
      ...Object.values(indexed.volumes).map((ref) => ref.file),
      ...Object.values(indexed.chapterPlans).map((ref) => ref.file),
      ...Object.values(indexed.chapters).flatMap((ref) => [ref.bodyFile, ref.outlineFile]),
    ]
    for (const path of new Set(paths.filter((path) => path !== ''))) {
      const text = await this.readContent(path)
      if (text === undefined) {
        warnings.push(`索引登记的 ${path} 已不存在；该条记录按空处理`)
        continue
      }
      files[path] = text
    }

    let assembled: ReturnType<typeof composeContent>
    try {
      assembled = composeContent(files, indexed, outlineFallback, metadata.competitors)
    } catch (error) {
      throw asStoreError(error)
    }

    const refreshed = this.refreshIndex(indexed, assembled, files)
    // `stateOf` rather than `metadataOf`: the metadata stays the authority for
    // everything it owns, while the outline (and with it the opening checklist a
    // human ticks in `章节大纲.md`) comes from the files.
    const state = stateOf({ ...metadata, index: refreshed.index }, assembled)

    // The index is a cache of what is on disk, so keeping it in step costs one
    // metadata write on the reads that changed it and nothing on the reads that
    // did not. A write here is safe: it is derived entirely from the files. A
    // document written by an older build is rewritten even when the index it
    // produced matches, because the version and the index's own shape are part
    // of what this write brings up to date.
    if (
      refreshed.changed
      || claimed.changed
      || volumeClaim.changed
      || planClaim.changed
      || movedContracts.changed
      || upgrade
    ) {
      const written = await this.writeMetadataText(
        serializeMetadata(metadataOf(state, refreshed.index)),
        info.version,
        policy,
      )
      const report = take(this.pendingReport)
      this.pendingReport = undefined
      return { state, version: written.version, warnings, ...report }
    }
    const report = take(this.pendingReport)
    this.pendingReport = undefined
    return { state, version: info.version, warnings, ...report }
  }

  /**
   * Read the metadata document itself.
   *
   * @returns its text and current info, or `undefined` when there is no project.
   */
  private async readDocument(): Promise<{ readonly raw: string; readonly info: FsInfo } | undefined> {
    const target = await this.resolve()
    const info = await this.fs.stat(target)
    if (info === undefined || info.type !== 'file') return undefined
    const raw = await this.fs.readText(target)
    if (raw.trim() === '') return undefined
    return { raw, info }
  }

  /**
   * Read one content file, reusing the parsed form when its hash is unchanged.
   *
   * @param path - the workspace-relative path.
   * @returns the file text, or `undefined` when it does not exist.
   * @throws {NovelStoreError} when the file exists but is not a regular file.
   */
  private async readContent(path: string): Promise<string | undefined> {
    const target = await this.fs.resolve(this.contain(path))
    const info = await this.fs.stat(target)
    if (info === undefined) return undefined
    if (info.type !== 'file') {
      throw new NovelStoreError(`${path} is not a regular file; refusing to read it as novel content`)
    }
    const text = await this.fs.readText(target)
    this.seenHashes.set(hashContent(text), path)
    if (this.seenHashes.size > 4096) this.seenHashes.clear()
    return text
  }

  /**
   * Rebuild the index from what was actually read, and hash every file.
   *
   * @param index - the index as recorded in the metadata document.
   * @param assembled - the state assembled from the files.
   * @param files - the raw text of each file that was read.
   * @returns the refreshed index and whether it differs from the recorded one.
   */
  private refreshIndex(
    index: StorageIndex,
    assembled: ReturnType<typeof composeContent>,
    files: Readonly<Record<string, string>>,
  ): { readonly index: StorageIndex; readonly changed: boolean } {
    const chapters: Record<string, StorageIndex['chapters'][string]> = {}
    for (const chapter of Object.values(assembled.chapters)) {
      const recorded = index.chapters[chapter.id]
      const paths = recorded === undefined || recorded.number !== chapter.number || recorded.title !== chapter.title
        ? chapterPaths(chapter.number, chapter.title, this.layout)
        : { bodyFile: recorded.bodyFile, outlineFile: recorded.outlineFile }
      const body = files[paths.bodyFile]
      const outline = files[paths.outlineFile]
      if (body === undefined && outline === undefined) continue
      chapters[chapter.id] = {
        number: chapter.number,
        title: chapter.title,
        bodyFile: paths.bodyFile,
        outlineFile: paths.outlineFile,
        bodyHash: body === undefined ? (recorded?.bodyHash ?? '') : hashContent(body),
        outlineHash: outline === undefined ? (recorded?.outlineHash ?? '') : hashContent(outline),
      }
    }
    // A volume's path follows its number, so the recorded path is kept as-is:
    // the author may have named the file themselves, and the file wins.
    const volumes: Record<string, StorageIndex['volumes'][string]> = {}
    for (const volume of assembled.outline.volumes) {
      const key = String(volume.number)
      const recorded = index.volumes[key]
      const path = recorded?.file ?? volumePath(volume.number, index)
      const text = files[path]
      // A path whose file was not read keeps the hash the index recorded; a
      // claimed file was read but is not in `files`, and keeps its claimed hash.
      volumes[key] = {
        number: volume.number,
        file: path,
        hash: text === undefined ? (recorded?.hash ?? '') : hashContent(text),
      }
    }
    // A volume's chapter plan is derived from the chapters filed under it, so a
    // chapter moving between volumes moves the row between files.
    const chapterPlans: Record<string, StorageIndex['chapterPlans'][string]> = {}
    for (const volume of planVolumesOf(assembled.chapters, assembled.outline.beats)) {
      const key = String(volume)
      const recorded = index.chapterPlans[key]
      const path = recorded?.file ?? chapterPlanPath(volume, index)
      const text = files[path]
      chapterPlans[key] = {
        volume,
        file: path,
        hash: text === undefined ? (recorded?.hash ?? '') : hashContent(text),
      }
    }
    const hashes: Record<string, string> = {}
    for (const [path, text] of Object.entries(files)) hashes[path] = hashContent(text)
    const next: StorageIndex = { ...index, chapters, volumes, chapterPlans, files: hashes }
    return { index: next, changed: !sameIndex(index, next) }
  }

  /**
   * Adopt volume outline files the index does not know about, and report the ones
   * that cannot be claimed.
   *
   * The volume directory is the per-volume analogue of `章节/`, so it gets the
   * same treatment: a file dropped in by hand — `分卷大纲/第7卷.md`, or a copy an
   * author made to draft the next volume — is claimed by its number on the next
   * read instead of silently existing on disk. A second file claiming a number
   * that another present file already owns is reported rather than guessed at,
   * because "which of these two is volume 7" is not a question to answer by
   * file order.
   *
   * @param index - the recorded index, returned extended with whatever was claimed.
   * @param warnings - collector for what could not be claimed.
   * @returns the claimed index and whether anything changed.
   */
  private async claimVolumes(
    index: StorageIndex,
    warnings: string[],
  ): Promise<{ readonly index: StorageIndex; readonly changed: boolean }> {
    const directory = await this.fs.resolve(this.contain(index.volumeDir))
    const info = await this.fs.stat(directory)
    if (info === undefined || info.type !== 'directory') return { index, changed: false }

    let entries: FsDirEntry[] = []
    try {
      entries = await this.fs.listDir(directory)
    } catch {
      return { index, changed: false }
    }

    const known = new Set(Object.values(index.volumes).map((ref) => ref.file))
    const volumes = { ...index.volumes }
    let changed = false
    for (const entry of entries) {
      if (entry.type !== 'file') continue
      const path = `${index.volumeDir}/${entry.name}`
      if (known.has(path) || !isMarkdownFile(path)) continue
      const text = await this.readContent(path)
      if (text === undefined) continue
      const number = volumeNumberFromFileName(path) ?? this.volumeNumberIn(text, path)
      if (number === undefined) {
        warnings.push(`${path} 既没有形如「第7卷.md」的文件名，frontmatter 里也没有卷号，无法认领；已保留原文件未做改动`)
        continue
      }
      const current = volumes[String(number)]
      // The indexed file may simply have been renamed, in which case it is gone
      // from disk and this file legitimately takes its place.
      if (current !== undefined && (await this.contentExists(current.file))) {
        warnings.push(`${path} 与已登记的 ${current.file} 都声明为第 ${String(number)} 卷，未认领；请删掉其中一个`)
        continue
      }
      volumes[String(number)] = { number, file: path, hash: hashContent(text) }
      known.add(path)
      changed = true
      warnings.push(`认领了未登记的分卷大纲 ${path}`)
    }
    return { index: { ...index, volumes }, changed }
  }

  /**
   * Adopt chapter-plan files the index does not know about.
   *
   * The same "file wins" rule as the volume outlines, with one difference that
   * matters: a plan file's contents *create* the chapters it lists, so a
   * hand-written `章节大纲/第5卷.md` with rows for chapters 101–140 is how an
   * author plans ahead. Nothing here may therefore drop a file because no
   * chapter currently claims its volume — the rows are what will claim it.
   *
   * @param index - the recorded index, returned extended with whatever was claimed.
   * @param warnings - collector for what could not be claimed.
   * @returns the claimed index and whether anything changed.
   */
  private async claimChapterPlans(
    index: StorageIndex,
    warnings: string[],
  ): Promise<{ readonly index: StorageIndex; readonly changed: boolean }> {
    const directory = await this.fs.resolve(this.contain(index.chapterPlanDir))
    const info = await this.fs.stat(directory)
    if (info === undefined || info.type !== 'directory') return { index, changed: false }

    let entries: FsDirEntry[] = []
    try {
      entries = await this.fs.listDir(directory)
    } catch {
      return { index, changed: false }
    }

    const known = new Set(Object.values(index.chapterPlans).map((ref) => ref.file))
    const knownNumbers = new Set(Object.values(index.chapters).map((ref) => ref.number))
    const knownOutlines = new Set(Object.values(index.chapters).map((ref) => ref.outlineFile))
    const chapterPlans = { ...index.chapterPlans }
    const chapters = { ...index.chapters }
    let changed = false
    let chaptersChanged = false
    for (const entry of entries) {
      if (entry.type !== 'file') continue
      const path = `${index.chapterPlanDir}/${entry.name}`
      if (!isMarkdownFile(path)) continue
      // Chapter contracts share this directory with the per-volume tables. One
      // dropped in by hand is claimed against its chapter id — the same rule the
      // prose directory has — instead of being read as a volume's plan.
      if (isOutlineFile(path)) {
        if (knownOutlines.has(path)) continue
        const front = await this.claimFrontmatter(path)
        const id = front === undefined ? undefined : frontId(front)
        if (front === undefined || id === undefined) {
          warnings.push(`${path} 没有 frontmatter id，无法认领；已保留原文件未做改动`)
          continue
        }
        const existing = chapters[id]
        const stem = entry.name.replace(/\.细纲\.md$/u, '')
        chapters[id] = {
          number: existing?.number ?? frontNumber(front, 'number', 0),
          title: existing?.title ?? '',
          bodyFile: existing?.bodyFile ?? `${this.layout.chapterDir}/${stem}.md`,
          outlineFile: path,
          bodyHash: existing?.bodyHash ?? '',
          outlineHash: hashContent((await this.readContent(path)) ?? ''),
        }
        knownOutlines.add(path)
        chaptersChanged = true
        warnings.push(`认领了未登记的细纲 ${path}`)
        continue
      }
      if (known.has(path)) continue
      const text = await this.readContent(path)
      if (text === undefined) continue
      const volume = chapterPlanVolumeFromFileName(path)
      if (volume === undefined) {
        warnings.push(
          `${path} 的文件名既不是「第N卷.md」也不是「未分卷.md」，无法认领；已保留原文件未做改动`,
        )
        continue
      }
      // A plan row only fills in a chapter that exists — the chapter's contract
      // file is what brings it into being — so a table whose chapters nobody has
      // planned yet has nothing to adopt. Claiming it anyway would drop it from
      // the index on the same read and claim it again on the next one, which is a
      // metadata write per read for a file nobody can use yet. It is named
      // instead, and claiming it works as soon as the chapters exist.
      let adoptable = false
      try {
        const parsed = parseChapterPlanVolumeFile(text, path)
        adoptable = parsed.rows.some((row) => knownNumbers.has(row.number))
          || parsed.beats.some((beat) => knownNumbers.has(beat.chapter))
      } catch (error) {
        throw asStoreError(error)
      }
      if (!adoptable) {
        warnings.push(
          `${path} 里没有本项目已有的章节（章节大纲只补全已存在的章）：先用 novel_plan operation="chapter" 建章，`
          + '文件已原样保留',
        )
        continue
      }
      const current = chapterPlans[String(volume)]
      // A renamed file legitimately takes over from the indexed one; two present
      // files for one volume is a question only the author can answer.
      if (current !== undefined && (await this.contentExists(current.file))) {
        warnings.push(`${path} 与已登记的 ${current.file} 都覆盖第 ${String(volume)} 卷，未认领；请删掉其中一个`)
        continue
      }
      chapterPlans[String(volume)] = { volume, file: path, hash: hashContent(text) }
      known.add(path)
      changed = true
      warnings.push(`认领了未登记的章节大纲 ${path}`)
    }
    return {
      index: chaptersChanged ? { ...index, chapterPlans, chapters } : { ...index, chapterPlans },
      changed: changed || chaptersChanged,
    }
  }

  /**
   * Move every chapter contract that still lives in `章节/` into `章节大纲/`.
   *
   * Chapter contracts are outlines, so they belong beside the per-volume chapter
   * tables rather than beside the prose they describe. The move is per chapter
   * and path-driven: the file is written at its new home first and the old copy
   * removed second, so an interrupted run leaves the contract recoverable.
   *
   * A contract that is already missing is not an error — a planned chapter with
   * no contract yet is ordinary — so the index is simply re-pointed at the new
   * directory and the next write creates the file there. Two copies with
   * different bytes are a conflict the author has to see: the canonical copy is
   * adopted, the legacy one is kept under `.novel/duplicates/`, never deleted.
   *
   * @param index - the index as recorded.
   * @param warnings - collector for the duplicates it had to report.
   * @param policy - sandbox policy for this call.
   * @returns the re-pointed index and whether any path moved.
   */
  private async migrateChapterContracts(
    index: StorageIndex,
    warnings: string[],
    policy: CallSandboxPolicy | undefined,
  ): Promise<{ readonly index: StorageIndex; readonly changed: boolean }> {
    const chapters: Record<string, StorageIndex['chapters'][string]> = {}
    const legacyPrefix = `${this.layout.chapterDir}/`
    let changed = false
    let moved = 0
    for (const [id, ref] of Object.entries(index.chapters)) {
      if (!ref.outlineFile.startsWith(legacyPrefix) || !isOutlineFile(ref.outlineFile)) {
        chapters[id] = ref
        continue
      }
      const legacy = legacyChapterOutlinePath(ref.outlineFile, this.layout)
      const target = canonicalChapterOutlinePath(ref.outlineFile, this.layout)
      const legacyText = await this.readContent(legacy)
      if (legacyText !== undefined) {
        if (await this.contentExists(target)) {
          const targetText = (await this.readContent(target)) ?? ''
          if (hashContent(targetText) === hashContent(legacyText)) {
            await this.remove(legacy)
          } else {
            const archived = await this.archiveDuplicate(legacy, legacyText, policy)
            const line = `${legacy} 与 ${target} 都是同一章的细纲：已采用 ${target}，旧文件备份到 ${archived}`
            warnings.push(line)
            this.report(line)
          }
        } else {
          const destination = await this.fs.resolve(this.contain(target))
          await this.writeGuarded(destination, legacyText, policy)
          await this.remove(legacy)
          moved += 1
        }
      }
      chapters[id] = { ...ref, outlineFile: target }
      changed = true
    }
    if (moved > 0) {
      this.report(
        `章节细纲已移到 ${this.layout.chapterPlanDir}/：${String(moved)} 个文件`
        + `（章节/ 现在只放正文）`,
      )
    }
    return { index: changed ? { ...index, chapters } : index, changed }
  }

  /**
   * Fold a duplicate `设定/` directory into the canonical settings files.
   *
   * The tool has one home per document; a numbered `设定/` folder is a *second*
   * copy, and two copies of an outline is how a project ends up with a root
   * outline nobody edited and a `设定/` outline everybody did. Rather than
   * reporting the duplicate on every read and leaving the author to reconcile
   * it, the content is folded in — missing fields and entries are filled, never
   * overwritten — and the original file is archived under `.novel/duplicates/`.
   *
   * Only the four settings documents are touched. Anything else in `设定/`
   * (premise notes, research) is left exactly where it is: the composer owns a
   * fixed set of files, not every note an author keeps in a folder.
   *
   * @param index - the canonical paths to fold into.
   * @param warnings - collector for what was folded and what could not be.
   * @param policy - sandbox policy for this call.
   */
  private async consolidateDuplicateSettings(
    index: StorageIndex,
    warnings: string[],
    policy: CallSandboxPolicy | undefined,
  ): Promise<void> {
    const directory = await this.fs.resolve(this.contain(LEGACY_SETTINGS_DIR))
    const info = await this.fs.stat(directory)
    if (info === undefined || info.type !== 'directory') return

    let entries: FsDirEntry[] = []
    try {
      entries = await this.fs.listDir(directory)
    } catch {
      return
    }
    const canonical = (kind: ReturnType<typeof settingsDocumentKind>): string =>
      kind === 'outline' ? index.outlineFile
        : kind === 'cast' ? index.castFile
          : kind === 'world' ? index.worldFile
            : `${index.volumeDir}/`
    for (const entry of entries) {
      if (entry.type !== 'file') continue
      const kind = settingsDocumentKind(entry.name)
      if (kind === undefined) continue
      const source = `${LEGACY_SETTINGS_DIR}/${entry.name}`
      const raw = await this.readContent(source)
      if (raw === undefined) continue
      let folded: FoldResult
      try {
        folded = kind === 'outline' ? await this.foldOutlineDuplicate(index.outlineFile, raw, source, policy)
          : kind === 'cast' ? await this.foldCastDuplicate(index.castFile, raw, source, policy)
            : kind === 'world' ? await this.foldWorldDuplicate(index.worldFile, raw, source, policy)
              : await this.foldVolumeDuplicate(index, raw, source, policy)
      } catch (error) {
        warnings.push(
          `${source} 与 ${canonical(kind)} 是同一种设定，但内容合并失败（${describe(error)}）：`
          + `原文件已保留，请手工把它的内容并进 ${canonical(kind)} 后删除它`,
        )
        continue
      }
      if (!folded.archive) {
        warnings.push(`${source}：${folded.note}；原文件已原样保留`)
        continue
      }
      const archived = await this.archiveDuplicate(source, raw, policy)
      const line = `发现重复的设定文件 ${source}：${folded.note}；原文件已备份到 ${archived}`
      warnings.push(line)
      this.report(line)
    }
  }

  /**
   * Fold one duplicate outline into the canonical `全书大纲.md`.
   *
   * Missing fields are filled from the duplicate; a field the canonical file
   * already answers is never overwritten, because two versions of a synopsis
   * merged field-by-field would be a third synopsis nobody wrote.
   *
   * @param target - the canonical outline path.
   * @param raw - the duplicate's text.
   * @param source - the duplicate's path, for errors.
   * @param policy - sandbox policy for this call.
   * @returns what happened, and whether the original can be archived.
   */
  private async foldOutlineDuplicate(
    target: string,
    raw: string,
    source: string,
    policy: CallSandboxPolicy | undefined,
  ): Promise<FoldResult> {
    const duplicate = parseOutlineFile(raw, source)
    if (!outlineHasContent(duplicate)) {
      if (raw.trim() === '') return { note: '空文件，已归档', archive: true }
      return {
        note: `看起来不是工具格式的《全书大纲》（没有 ## 一句话 / ## 故事六要素 等小节），未折并；`
          + `如需保留其中内容，请手工并进 ${target}`,
        archive: false,
      }
    }
    const existingText = await this.readContent(target)
    if (existingText === undefined) {
      await this.writeAt(target, renderOutlineFile(duplicate), policy)
      return { note: `其内容已写入 ${target}`, archive: true }
    }
    const existing = parseOutlineFile(existingText, target)
    const story = fillRecord(existing.story, duplicate.story)
    const spine = fillRecord(existing.spine, duplicate.spine)
    const style = fillRecord(existing.style, duplicate.style)
    const cheat = fillRecord(existing.cheat, duplicate.cheat)
    const logline = fillText(existing.logline, duplicate.logline)
    const fullOutline = fillText(existing.fullOutline, duplicate.fullOutline)
    const minimal = fillText(existing.minimal, duplicate.minimal)
    const acts = existing.acts.length === 0 && duplicate.acts.length > 0
      ? duplicate.acts
      : existing.acts
    const filled = story.filled + spine.filled + style.filled + cheat.filled
      + logline.filled + fullOutline.filled + minimal.filled
    const conflicts = story.conflicts + spine.conflicts + style.conflicts + cheat.conflicts
      + logline.conflicts + fullOutline.conflicts + minimal.conflicts
    if (filled === 0) {
      return {
        note: conflicts === 0
          ? `与 ${target} 内容一致`
          : `与 ${target} 有 ${String(conflicts)} 处不同，以 ${target} 为准（差异在备份里）`,
        archive: true,
      }
    }
    const merged = {
      ...existing,
      logline: logline.value,
      story: story.value,
      spine: spine.value,
      style: style.value,
      cheat: cheat.value,
      fullOutline: fullOutline.value,
      minimal: minimal.value,
      acts,
      fullOutlineDone: existing.fullOutlineDone || duplicate.fullOutlineDone,
    }
    const rendered = renderOutlineFile(merged)
    if (rendered !== existingText) await this.writeAt(target, rendered, policy)
    return {
      note: `补进了 ${target} 空着的 ${String(filled)} 项`
        + (conflicts === 0 ? '' : `（${String(conflicts)} 处两边都有内容，保留了 ${target}）`),
      archive: true,
    }
  }

  /**
   * Fold one duplicate cast file into the canonical `人物设定.md`.
   *
   * @param target - the canonical cast path.
   * @param raw - the duplicate's text.
   * @param source - the duplicate's path, for errors.
   * @param policy - sandbox policy for this call.
   * @returns what happened, and whether the original can be archived.
   */
  private async foldCastDuplicate(
    target: string,
    raw: string,
    source: string,
    policy: CallSandboxPolicy | undefined,
  ): Promise<FoldResult> {
    const duplicate = parseCastFile(raw, source)
    const count = Object.keys(duplicate).length
    if (count === 0) return { note: '没有可识别的人物条目，已归档', archive: true }
    const existingText = await this.readContent(target)
    if (existingText === undefined) {
      await this.writeAt(target, renderCastFile(duplicate), policy)
      return { note: `其 ${String(count)} 位人物已写入 ${target}`, archive: true }
    }
    const existing = parseCastFile(existingText, target)
    const merged: Record<string, Character> = { ...existing }
    let added = 0
    let conflicts = 0
    for (const [id, character] of Object.entries(duplicate)) {
      if (merged[id] === undefined) {
        merged[id] = character
        added += 1
      } else if (JSON.stringify(merged[id]) !== JSON.stringify(character)) {
        conflicts += 1
      }
    }
    if (added > 0) await this.writeAt(target, renderCastFile(merged), policy)
    return {
      note: added === 0
        ? (conflicts === 0
            ? `与 ${target} 内容一致`
            : `与 ${target} 有 ${String(conflicts)} 位人物不同，以 ${target} 为准（差异在备份里）`)
        : `补进了 ${target} 缺的 ${String(added)} 位人物`
          + (conflicts === 0 ? '' : `（${String(conflicts)} 位两边都有，保留了 ${target}）`),
      archive: true,
    }
  }

  /**
   * Fold one duplicate world file into the canonical `世界观设定.md`.
   *
   * @param target - the canonical world path.
   * @param raw - the duplicate's text.
   * @param source - the duplicate's path, for errors.
   * @param policy - sandbox policy for this call.
   * @returns what happened, and whether the original can be archived.
   */
  private async foldWorldDuplicate(
    target: string,
    raw: string,
    source: string,
    policy: CallSandboxPolicy | undefined,
  ): Promise<FoldResult> {
    const duplicate = parseWorldFile(raw, source)
    const count = Object.keys(duplicate).length
    if (count === 0) return { note: '没有可识别的世界设定条目，已归档', archive: true }
    const existingText = await this.readContent(target)
    if (existingText === undefined) {
      await this.writeAt(target, renderWorldFile(duplicate), policy)
      return { note: `其 ${String(count)} 条设定已写入 ${target}`, archive: true }
    }
    const existing = parseWorldFile(existingText, target)
    const merged: Record<string, WorldEntry> = { ...existing }
    let added = 0
    let conflicts = 0
    for (const [id, entry] of Object.entries(duplicate)) {
      if (merged[id] === undefined) {
        merged[id] = entry
        added += 1
      } else if (JSON.stringify(merged[id]) !== JSON.stringify(entry)) {
        conflicts += 1
      }
    }
    if (added > 0) await this.writeAt(target, renderWorldFile(merged), policy)
    return {
      note: added === 0
        ? (conflicts === 0
            ? `与 ${target} 内容一致`
            : `与 ${target} 有 ${String(conflicts)} 条不同，以 ${target} 为准（差异在备份里）`)
        : `补进了 ${target} 缺的 ${String(added)} 条设定`
          + (conflicts === 0 ? '' : `（${String(conflicts)} 条两边都有，保留了 ${target}）`),
      archive: true,
    }
  }

  /**
   * Fold a duplicate volume collection into one canonical file per volume.
   *
   * A duplicate may be the pre-version-4 collection (`## 第 1 卷` entries) or a
   * single volume's own file; both are accepted. Volumes the canonical directory
   * already has are kept as they are, because the per-volume file is the one the
   * author edits while writing that volume.
   *
   * @param index - the canonical paths.
   * @param raw - the duplicate's text.
   * @param source - the duplicate's path, for errors.
   * @param policy - sandbox policy for this call.
   * @returns what happened, and whether the original can be archived.
   */
  private async foldVolumeDuplicate(
    index: StorageIndex,
    raw: string,
    source: string,
    policy: CallSandboxPolicy | undefined,
  ): Promise<FoldResult> {
    let volumes: VolumePlan[]
    try {
      volumes = parseVolumeCollectionFile(raw, source)
    } catch {
      volumes = [parseVolumeFile(raw, source)]
    }
    if (volumes.length === 0) return { note: '空文件，已归档', archive: true }
    let added = 0
    const kept: number[] = []
    for (const volume of volumes) {
      const path = index.volumes[String(volume.number)]?.file ?? volumePath(volume.number, index)
      if (await this.contentExists(path)) {
        kept.push(volume.number)
        continue
      }
      await this.writeAt(path, renderVolumeFile(volume), policy)
      added += 1
    }
    const keptNote = kept.length === 0 ? '' : `（第 ${kept.join('、')} 卷已有自己的文件，保留原文件）`
    return {
      note: added === 0
        ? `与 ${index.volumeDir}/ 中已有的卷重复${keptNote}`
        : `补写了 ${index.volumeDir}/ 中缺的 ${String(added)} 卷${keptNote}`,
      archive: true,
    }
  }

  /**
   * Preserve a duplicate under `.novel/duplicates/` and remove the original.
   *
   * The archive is written **before** the delete: a failure to keep the copy
   * aborts the operation, because "we removed the other copy" must never be the
   * last thing that happened to an author's text.
   *
   * @param source - the duplicate's workspace-relative path.
   * @param raw - its text.
   * @param policy - sandbox policy for this call.
   * @returns the archive path.
   */
  private async archiveDuplicate(
    source: string,
    raw: string,
    policy: CallSandboxPolicy | undefined,
  ): Promise<string> {
    const base = source.split('/').pop() ?? 'duplicate.md'
    const stem = base.replace(/\.md$/u, '')
    let target = `${DUPLICATE_BACKUP_DIR}/${base}`
    for (let n = 2; await this.contentExists(target); n += 1) {
      target = `${DUPLICATE_BACKUP_DIR}/${stem}-${n}.md`
    }
    await this.writeAt(target, raw, policy)
    await this.remove(source)
    return target
  }

  /**
   * Write one content file by its workspace-relative path.
   *
   * @param path - the destination.
   * @param text - the full content.
   * @param policy - sandbox policy for this call.
   */
  private async writeAt(path: string, text: string, policy: CallSandboxPolicy | undefined): Promise<void> {
    const target = await this.fs.resolve(this.contain(path))
    await this.writeGuarded(target, text, policy)
  }

  /**
   * Append a line to the one-shot migration report.
   *
   * @param line - the report line.
   */
  private report(line: string): void {
    this.pendingReport = this.pendingReport === undefined ? line : `${this.pendingReport}；${line}`
  }

  /**
   * Read the volume number out of a volume file's own frontmatter.
   *
   * The fallback for a file an author renamed; a file with neither a number in
   * its name nor one in its frontmatter is reported instead of guessed at.
   *
   * @param text - the file's text.
   * @param path - the file, for error messages.
   * @returns the number, or `undefined` when the file carries none.
   */
  private volumeNumberIn(text: string, path: string): number | undefined {
    let frontmatter: YamlMap
    try {
      frontmatter = parseDocument(text, path).frontmatter
    } catch (error) {
      throw asStoreError(error)
    }
    const value = frontmatter['number']
    const number = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
    return Number.isInteger(number) && number > 0 ? number : undefined
  }

  /**
   * Whether a workspace-relative content path currently holds a regular file.
   *
   * @param path - the path to probe.
   * @returns true when the file exists.
   */
  private async contentExists(path: string): Promise<boolean> {
    if (path === '') return false
    return isRegularFile(this.fs, await this.fs.resolve(this.contain(path)))
  }

  /**
   * Adopt chapter files the index does not know about, and report orphan ones.
   *
   * This is "the file wins" applied to discovery: a chapter dropped into
   * `章节/` by hand, or left behind by an interrupted write, is claimed on the
   * next read so it appears in the plan instead of silently existing on disk.
   * A file with no frontmatter `id` cannot be claimed — there would be nothing to
   * key it by — so it is reported and left exactly where it is.
   *
   * @param index - the recorded index, mutated into the claimed one.
   * @param warnings - collector for what could not be claimed.
   * @returns the claimed index and whether anything changed.
   */
  private async claim(
    index: StorageIndex,
    warnings: string[],
  ): Promise<{ readonly index: StorageIndex; readonly changed: boolean }> {
    const directory = await this.fs.resolve(this.contain(this.layout.chapterDir))
    const info = await this.fs.stat(directory)
    if (info === undefined || info.type !== 'directory') return { index, changed: false }

    let entries: FsDirEntry[] = []
    try {
      entries = await this.fs.listDir(directory)
    } catch {
      return { index, changed: false }
    }

    const known = new Set(Object.values(index.chapters).flatMap((ref) => [ref.bodyFile, ref.outlineFile]))
    const chapters = { ...index.chapters }
    let changed = false
    for (const entry of entries) {
      if (entry.type !== 'file') continue
      const path = `${this.layout.chapterDir}/${entry.name}`
      if (known.has(path) || !isMarkdownFile(path)) continue
      if (isOutlineFile(path)) {
        // A contract without prose is normal; claim it against a body path that
        // may not exist yet, which is exactly how a planned chapter reads.
        const stem = path.replace(/\.细纲\.md$/u, '')
        const front = await this.claimFrontmatter(path)
        const id = front === undefined ? undefined : frontId(front)
        if (front === undefined || id === undefined) continue
        const bodyFile = `${stem}.md`
        const existing = chapters[id]
        const body = existing === undefined ? undefined : await this.readContent(existing.bodyFile)
        chapters[id] = {
          // The number its own frontmatter records, so a chapter claimed from a
          // hand-written contract is addressable before any plan table names it.
          number: existing?.number ?? frontNumber(front, 'number', 0),
          title: existing?.title ?? '',
          bodyFile: body === undefined ? bodyFile : existing?.bodyFile ?? bodyFile,
          outlineFile: path,
          bodyHash: existing?.bodyHash ?? '',
          outlineHash: hashContent((await this.readContent(path)) ?? ''),
        }
        known.add(path)
        changed = true
        warnings.push(`认领了未登记的细纲 ${path}`)
        continue
      }
      const stem = path.replace(/\.md$/u, '')
      const front = await this.claimFrontmatter(path)
      const id = front === undefined ? undefined : frontId(front)
      if (front === undefined || id === undefined) {
        warnings.push(`${path} 没有 frontmatter id，无法认领；已保留原文件未做改动`)
        continue
      }
      const existing = chapters[id]
      chapters[id] = {
        number: existing?.number ?? frontNumber(front, 'number', 0),
        title: existing?.title ?? '',
        bodyFile: path,
        outlineFile: existing?.outlineFile ?? `${stem}.细纲.md`,
        bodyHash: hashContent((await this.readContent(path)) ?? ''),
        outlineHash: existing?.outlineHash ?? '',
      }
      known.add(path)
      changed = true
      warnings.push(`认领了未登记的正文 ${path}`)
    }
    return { index: { ...index, chapters }, changed }
  }

  /**
   * Read the frontmatter a chapter file claims, if it claims any.
   *
   * A file with no frontmatter at all is not an error here — the claim simply has
   * nothing to key it by, which the caller reports. A file whose frontmatter is
   * *malformed* is a different thing, and is raised.
   *
   * @param path - the file to read.
   * @returns the parsed frontmatter, or `undefined` when the file carries none.
   */
  private async claimFrontmatter(path: string): Promise<YamlMap | undefined> {
    const text = await this.readContent(path)
    if (text === undefined) return undefined
    try {
      const document = parseDocument(text, path)
      return document.hasFrontmatter ? document.frontmatter : undefined
    } catch (error) {
      throw asStoreError(error)
    }
  }

  // ── migration ───────────────────────────────────────────────────────────────

  /**
   * Migrate an older document once per store instance, before the reads run.
   *
   * Reading is the natural trigger: an older document cannot be read without
   * being converted, and the conversion must not run twice concurrently (two
   * readers would both generate files and race on the backup). This wrapper is
   * what serializes that; {@link migrateDocument} is the work, and {@link load}
   * calls it directly because it may already be running inside the write queue,
   * where enqueuing again would deadlock.
   */
  private async ensureMigrated(policy: CallSandboxPolicy | undefined): Promise<void> {
    this.migration ??= this.enqueue(async () => {
      const document = await this.readDocument()
      if (document === undefined) return
      await this.migrateDocument(document.raw, document.info, policy)
    })
    return this.migration
  }

  /**
   * Bring one document up to the current schema, and report what was left on disk.
   *
   * Two upgrades live here, and they are different in kind:
   *
   * - **Versions 1 and 2** kept the whole novel inside `novel.json`. The
   *   conversion is the plan's: **back up first**, then generate every content
   *   file, then replace the document. The backup is created with
   *   `createIfAbsent`, so an existing one is never overwritten and two racing
   *   readers cannot clobber each other's copy.
   * - **Version 3** already kept its content in files, but kept every volume
   *   outline in one collection file. That is split into one file per volume and
   *   the collection is deleted. No backup of the document is taken: nothing is
   *   removed from it, and the volume content is re-rendered into the files that
   *   replace the collection before the collection goes away.
   * - **Version 4** split those volume outlines but still kept the whole chapter
   *   plan — the chapter table, one row per chapter — in one file. That is split
   *   the same way: one file per volume for the tables, and the whole-book file
   *   left holding the opening checklist and the index of where they went.
   *
   * A version-3 document needs both splits, in that order, and gets them: the
   * two are keyed on different recorded paths, so one pass does both.
   *
   * @param raw - the document's current text.
   * @param info - the document's current filesystem info, for the version guard.
   * @param policy - sandbox policy for this call.
   * @returns the document as it now stands when this call migrated it, or
   *   `undefined` when there was nothing to do.
   */
  private async migrateDocument(
    raw: string,
    info: FsInfo,
    policy: CallSandboxPolicy | undefined,
  ): Promise<{ readonly raw: string; readonly info: FsInfo } | undefined> {
    const { version, legacy, legacyVolumeFile, legacyChapterPlanFile } = parseMetadata(raw)
    if (version === NOVEL_SCHEMA_VERSION) return undefined
    let migrated = false
    if (legacy !== undefined) {
      if (!(await this.backup(raw, policy))) return undefined
      const chapters = Object.keys(legacy.chapters).length
      await this.writeAll(legacy, info.version, policy, { forceRewrite: true })
      this.pendingReport = `novel.json 已升级 v${String(version)} → v${String(NOVEL_SCHEMA_VERSION)}：` +
        `生成 ${String(chapters)} 章的内容文件，原文档备份在 ${MIGRATION_BACKUP_PATH}`
      migrated = true
    } else {
      // A collection file that is not on disk has nothing to split; the ordinary
      // index refresh is what upgrades the document's shape.
      if (legacyVolumeFile !== undefined && (await this.splitLegacyVolumes(legacyVolumeFile, policy))) {
        migrated = true
      }
      if (legacyChapterPlanFile !== undefined && (await this.splitLegacyChapterPlan(legacyChapterPlanFile, policy))) {
        migrated = true
      }
    }
    if (!migrated) return undefined
    const after = await this.readDocument()
    return after
  }

  /**
   * Split the pre-version-5 chapter plan into one file per volume.
   *
   * The per-volume files are written first and the whole-book file is rewritten
   * last, so an interrupted run leaves the tables where the next attempt will
   * still find them: they are re-read from the whole-book file, not from the
   * files this call just created. A file with nothing to split is left exactly as
   * it is, which is what makes the second call a no-op.
   *
   * @param legacyPath - the whole-book file's workspace-relative path.
   * @param policy - sandbox policy for this call.
   * @returns true when there were tables to split.
   */
  private async splitLegacyChapterPlan(legacyPath: string, policy: CallSandboxPolicy | undefined): Promise<boolean> {
    let text: string | undefined
    try {
      text = await this.readContent(legacyPath)
    } catch (error) {
      throw asStoreError(error)
    }
    if (text === undefined) return false
    let parsed: ReturnType<typeof parseChapterPlanCollectionFile>
    try {
      parsed = parseChapterPlanCollectionFile(text, legacyPath, [])
    } catch (error) {
      throw asStoreError(error)
    }
    if (parsed.rows.length === 0 && parsed.beats.length === 0) return false

    const volumeOf = new Map<number, number>()
    const rowsByVolume = new Map<number, ChapterPlanRow[]>()
    for (const row of parsed.rows) {
      const volume = row.volume > 0 ? row.volume : 0
      volumeOf.set(row.number, volume)
      rowsByVolume.set(volume, [...(rowsByVolume.get(volume) ?? []), row])
    }
    const beatsByVolume = new Map<number, BeatSlot[]>()
    for (const beat of parsed.beats) {
      // A beat whose chapter is not in the table has no volume yet; it lands in
      // 未分卷 and moves itself the first time that chapter is filed.
      const volume = volumeOf.get(beat.chapter) ?? 0
      beatsByVolume.set(volume, [...(beatsByVolume.get(volume) ?? []), beat])
    }
    const groups: ChapterPlanGroup[] = []
    for (const volume of [...new Set([...rowsByVolume.keys(), ...beatsByVolume.keys()])].sort((a, b) => a - b)) {
      const rows = rowsByVolume.get(volume) ?? []
      const beats = beatsByVolume.get(volume) ?? []
      const path = chapterPlanPath(volume, this.layout)
      const target = await this.fs.resolve(this.contain(path))
      await this.writeGuarded(target, renderChapterPlanVolumeFile({ rows, beats }, volume, ''), policy)
      if (rows.length > 0) {
        const numbers = rows.map((row) => row.number)
        groups.push({
          volume,
          file: path,
          first: Math.min(...numbers),
          last: Math.max(...numbers),
          count: rows.length,
        })
      }
    }
    const target = await this.fs.resolve(this.contain(legacyPath))
    await this.writeGuarded(target, renderChapterPlanFile({ opening: parsed.opening, groups }), policy)
    this.pendingReport = `章节大纲已按卷拆分：${legacyPath} → ${this.layout.chapterPlanDir}/` +
      `（${String(groups.length)} 个文件，一卷一个；开篇工程清单与各卷索引留在原文件）`
    return true
  }

  /**
   * Split the version-3 volume collection into one file per volume.
   *
   * The files are written first and the collection is deleted last, so an
   * interrupted run leaves the collection — the only copy of the content until
   * the split finishes — in place, and the next read simply runs it again.
   *
   * @param legacyPath - the collection file's workspace-relative path.
   * @param policy - sandbox policy for this call.
   * @returns true when the collection existed and was split.
   */
  private async splitLegacyVolumes(legacyPath: string, policy: CallSandboxPolicy | undefined): Promise<boolean> {
    let text: string | undefined
    try {
      text = await this.readContent(legacyPath)
    } catch (error) {
      throw asStoreError(error)
    }
    if (text === undefined) return false
    let volumes: ReturnType<typeof parseVolumeCollectionFile>
    try {
      volumes = parseVolumeCollectionFile(text, legacyPath)
    } catch (error) {
      throw asStoreError(error)
    }
    for (const volume of [...volumes].sort((a, b) => a.number - b.number)) {
      const path = volumePath(volume.number, this.layout)
      const target = await this.fs.resolve(this.contain(path))
      await this.writeGuarded(target, renderVolumeFile(volume), policy)
    }
    await this.remove(legacyPath)
    this.pendingReport = `分卷大纲已按卷拆分：${legacyPath} → ${this.layout.volumeDir}/` +
      `（${String(volumes.length)} 个文件，一卷一个），原文件已删除`
    return true
  }

  /**
   * Keep the pre-migration document, and report whether this call is the one
   * that migrated the project.
   *
   * @param raw - the original document's text.
   * @returns true when the project still needs migrating, false when an earlier
   *   session already kept a backup.
   */
  private async backup(raw: string, policy: CallSandboxPolicy | undefined): Promise<boolean> {
    const target = await this.fs.resolve(this.contain(MIGRATION_BACKUP_PATH))
    if ((await this.fs.stat(target)) !== undefined) return false
    try {
      await this.fs.writeText(target, raw, { kind: 'createIfAbsent' }, undefined, policy)
      return true
    } catch (error) {
      // A concurrent migration won the race and is doing the work; this read
      // simply follows it.
      if (isFsErrorCode(error, 'FS_NOT_OBSERVED')) return false
      throw error
    }
  }


  // ── writing ─────────────────────────────────────────────────────────────────

  /**
   * Persist a state: content files first, metadata last, guarded by the version
   * the caller read.
   *
   * @param next - the state to write.
   * @param expected - version token from the read this state derives from.
   * @param baseline - the state as it was read, before the mutation. The write
   *   diffs against it, so what lands on disk is exactly what the mutation
   *   changed.
   * @returns the persisted state, with a fresh `updatedAt`.
   * @throws {NovelConflictError} when the metadata document moved on.
   * @throws {NovelWriteError} when a content file could not be written.
   */
  private async write(
    next: NovelState,
    expected: FsVersion,
    baseline: NovelState,
    policy: CallSandboxPolicy | undefined,
  ): Promise<NovelState> {
    const stamped: NovelState = { ...next, updatedAt: this.clock() }
    // Order matters: the index decides where a renamed chapter's files go, and
    // only then can the files be rendered at their new paths. Rendering first
    // would place the new content at the old path and leave the rename invisible.
    const index = this.alignIndex(stamped)
    const planned: NovelState = { ...stamped, index }
    const files = this.planFiles(planned, index)
    await this.writeContent(files, index, baseline, policy)
    const completed = this.rehash(index, files)
    const persisted: NovelState = { ...planned, index: completed }
    await this.persistMetadata(persisted, expected, baseline, policy)
    this.remember(persisted)
    return persisted
  }

  /**
   * Write the metadata document, unless it already says exactly this.
   *
   * The skip is not only an optimization: `novel_write operation="check"` is
   * specified to *report* without touching the stored chapter, and a spec pins
   * that by comparing `.novel/novel.json` before and after. Comparing the
   * serialized text honors that promise even when the write path recomputed the
   * index, because a recomputed index that describes the same files serializes
   * to the same bytes.
   *
   * @param persisted - the state to record.
   * @param expected - the version to guard on.
   * @param baseline - the state this write derived from.
   * @throws {NovelConflictError} when the metadata document moved on.
   */
  private async persistMetadata(
    persisted: NovelState,
    expected: FsVersion,
    baseline: NovelState,
    policy: CallSandboxPolicy | undefined,
  ): Promise<void> {
    const text = serializeMetadata(metadataOf(persisted, persisted.index ?? emptyIndex(this.layout)))
    const before = baseline.index
    if (
      before !== undefined &&
      sameIndex(before, persisted.index ?? before) &&
      sameScalars(before === undefined ? undefined : metadataOf(baseline, before), persisted)
    ) {
      return
    }
    try {
      await this.writeMetadataText(text, expected, policy)
    } catch (error) {
      if (isFsErrorCode(error, 'FS_STALE_VERSION')) {
        throw new NovelConflictError(
          `${NOVEL_RELATIVE_PATH} changed since it was read; re-read the project and reapply the change`,
        )
      }
      throw error
    }
  }

  /**
   * Point an index at the paths the files are actually written to.
   *
   * When nothing about a chapter's number or title moved, the index the read
   * produced is already correct and is reused verbatim — which is what lets
   * {@link NovelStore.persistMetadata} skip a metadata write for a change that
   * touched no content file. Only the chapters whose paths moved, plus any new
   * chapter, have their hashes recomputed. A volume's path follows its number
   * and cannot move, so volumes only ever appear or disappear here.
   *
   * @param state - the state being written.
   * @param files - the rendered files, keyed by path.
   * @returns the index to record.
   */
  private alignIndex(state: NovelState): StorageIndex {
    const base = state.index ?? emptyIndex(this.layout)
    const chapters: Record<string, StorageIndex['chapters'][string]> = {}
    let moved = false
    for (const [id, chapter] of Object.entries(state.chapters)) {
      const paths = chapterPaths(chapter.number, chapter.title, this.layout)
      const recorded = base.chapters[id]
      const samePaths =
        recorded !== undefined && recorded.bodyFile === paths.bodyFile && recorded.outlineFile === paths.outlineFile
      if (!samePaths) moved = true
      chapters[id] = {
        number: chapter.number,
        title: chapter.title,
        bodyFile: paths.bodyFile,
        outlineFile: paths.outlineFile,
        // An unmoved chapter keeps the hash the read recorded; a moved one is
        // assigned its hash by `rehash` once the files are rendered.
        bodyHash: samePaths ? (recorded?.bodyHash ?? '') : '',
        outlineHash: samePaths ? (recorded?.outlineHash ?? '') : '',
      }
    }
    const volumes: Record<string, StorageIndex['volumes'][string]> = {}
    for (const volume of state.outline.volumes) {
      const key = String(volume.number)
      const recorded = base.volumes[key]
      volumes[key] = {
        number: volume.number,
        file: recorded?.file ?? volumePath(volume.number, base),
        hash: recorded?.hash ?? '',
      }
    }
    const chapterPlans: Record<string, StorageIndex['chapterPlans'][string]> = {}
    for (const volume of planVolumesOf(state.chapters, state.outline.beats)) {
      const key = String(volume)
      const recorded = base.chapterPlans[key]
      chapterPlans[key] = {
        volume,
        file: recorded?.file ?? chapterPlanPath(volume, base),
        hash: recorded?.hash ?? '',
      }
    }
    if (!moved && sameVolumes(base.volumes, volumes) && sameChapterPlans(base.chapterPlans, chapterPlans)) return base
    return { ...base, chapters, volumes, chapterPlans }
  }

  /**
   * Fill in the hashes of every file the write produced.
   *
   * Called after the content step, because the hashes depend on the bytes that
   * were actually written — and writing is what may have moved a chapter.
   *
   * @param index - the index to complete.
   * @param files - the rendered files, keyed by path.
   * @returns the index with hashes for every chapter, volume, and file.
   */
  private rehash(index: StorageIndex, files: Readonly<Record<string, string>>): StorageIndex {
    let changed = false
    const chapters: Record<string, StorageIndex['chapters'][string]> = {}
    for (const [id, ref] of Object.entries(index.chapters)) {
      const bodyHash = files[ref.bodyFile] === undefined ? ref.bodyHash : hashContent(files[ref.bodyFile] ?? '')
      const outlineHash =
        files[ref.outlineFile] === undefined ? ref.outlineHash : hashContent(files[ref.outlineFile] ?? '')
      if (bodyHash !== ref.bodyHash || outlineHash !== ref.outlineHash) changed = true
      chapters[id] = { ...ref, bodyHash, outlineHash }
    }
    const volumes: Record<string, StorageIndex['volumes'][string]> = {}
    for (const [key, ref] of Object.entries(index.volumes)) {
      const hash = files[ref.file] === undefined ? ref.hash : hashContent(files[ref.file] ?? '')
      if (hash !== ref.hash) changed = true
      volumes[key] = { ...ref, hash }
    }
    const chapterPlans: Record<string, StorageIndex['chapterPlans'][string]> = {}
    for (const [key, ref] of Object.entries(index.chapterPlans)) {
      const hash = files[ref.file] === undefined ? ref.hash : hashContent(files[ref.file] ?? '')
      if (hash !== ref.hash) changed = true
      chapterPlans[key] = { ...ref, hash }
    }
    if (!changed) return index
    return { ...index, chapters, volumes, chapterPlans, files: hashAll(files) }
  }

  /**
   * Write every content file the state implies, and delete the ones it orphaned.
   *
   * Order matters: additions and updates land before deletions, so a rename never
   * leaves a window in which neither path exists.
   *
   * @param state - the state to persist.
   * @returns the paths written, in order.
   * @throws {NovelWriteError} naming exactly what landed and what did not.
   */
  private async writeContent(
    files: Readonly<Record<string, string>>,
    index: StorageIndex,
    previous: NovelState,
    policy: CallSandboxPolicy | undefined,
  ): Promise<string[]> {
    // The structural diff the plan asks for: render the *previous* state with its
    // own timestamp, compare it against what the next state renders to, and write
    // only the files whose bytes actually differ. Without this every
    // `novel_plan` call would rewrite the whole novel, because each rendered file
    // carries a fresh `updatedAt` — correct, but hundreds of writes for a
    // one-field change on a long book.
    const before = this.planFiles(previous)
    // Verify the files the baseline claims are on disk in the state it recorded.
    // `novel_write operation="check"` promises to report without touching the
    // stored chapter, and a spec pins that by calling it in a loop — so a file
    // that was deleted or edited behind our back is rewritten, and a file that is
    // already exactly this content is left alone.
    const changed: string[] = []
    for (const [path, text] of Object.entries(files)) {
      if (text === before[path] && (await this.onDiskMatches(path, previous, text))) continue
      changed.push(path)
    }
    const written: string[] = []
    const pending = new Set(changed)
    try {
      for (const path of changed) {
        const target = await this.fs.resolve(this.contain(path))
        await this.writeGuarded(target, files[path] ?? '', policy)
        written.push(path)
        pending.delete(path)
      }
      // Deletions last, so a rename never leaves a window with neither path.
      const orphaned = this.orphanedPaths(previous.index ?? emptyIndex(this.layout), index, files)
      for (const path of orphaned) await this.remove(path)
      this.forget(orphaned)
    } catch (error) {
      const notWritten = [...pending]
      throw new NovelWriteError(
        `writing ${String(written.length)} of ${String(pending.size + written.length)} files failed: ${describe(error)}`,
        { written, notWritten },
        { cause: error },
      )
    }
    return written
  }

  /**
   * Whether a file the baseline indexed already holds exactly this content.
   *
   * The fast path is one `stat`: `writeContent` only asks about files whose
   * rendered bytes equal what the baseline rendered, and the baseline's recorded
   * hash is by construction the hash of those bytes, so a size match settles it.
   * A file that was deleted, or that no longer has the recorded size (an external
   * edit), answers `false` and is rewritten — which is what makes an external
   * deletion self-healing and makes `novel_write operation="check"` genuinely
   * leave the stored chapter untouched.
   *
   * @param path - the workspace-relative path.
   * @param baseline - the state the write derived from.
   * @param text - the content the write would produce.
   * @returns true when the file is present with exactly this content.
   */
  private async onDiskMatches(path: string, baseline: NovelState, text: string): Promise<boolean> {
    const target = await this.fs.resolve(this.contain(path))
    const info = await this.fs.stat(target)
    if (info === undefined || info.type !== 'file') return false
    // An unknown size (a backend that cannot report one) forces the write rather
    // than risking a stale file being left behind.
    return info.size !== undefined && info.size === Buffer.byteLength(text, 'utf8')
  }

  /**
   * Write every file of a state, with no previous index and no version guard.
   *
   * Used by {@link adopt}, {@link create}, and migration — the three cases where
   * the project is being established rather than updated.
   *
   * @param state - the state to write.
   * @param expected - metadata version to guard on, when one exists.
   * @param options - `forceRewrite` writes content even when a hash matches.
   * @returns the paths written.
   */
  private async writeAll(
    state: NovelState,
    expected: FsVersion | undefined,
    policy: CallSandboxPolicy | undefined,
    options: { readonly forceRewrite?: boolean } = {},
  ): Promise<NovelState> {
    const stamped: NovelState = { ...state, updatedAt: state.updatedAt || this.clock() }
    const files = this.planFiles(stamped)
    const index = this.indexFor(stamped, hashAll(files))
    const persisted: NovelState = { ...stamped, index }
    const written: string[] = []
    const pending = new Set(Object.keys(files))
    try {
      for (const [path, text] of Object.entries(files)) {
        const known = stamped.index?.files[path]
        if (options.forceRewrite !== true && known === index.files[path]) {
          pending.delete(path)
          continue
        }
        const target = await this.fs.resolve(this.contain(path))
        await this.writeGuarded(target, text, policy)
        written.push(path)
        pending.delete(path)
      }
      await this.writeMetadataText(serializeMetadata(metadataOf(persisted, index)), expected, policy)
    } catch (error) {
      if (isFsErrorCode(error, 'FS_NOT_OBSERVED') || isFsErrorCode(error, 'FS_STALE_VERSION')) throw error
      throw new NovelWriteError(
        `writing ${String(written.length)} of ${String(pending.size + written.length)} files failed: ${describe(error)}`,
        { written, notWritten: [...pending] },
        { cause: error },
      )
    }
    this.remember(persisted)
    return persisted
  }

  /**
   * The text of every content file a state implies, keyed by path.
   *
   * Paths come from the state's own index — never re-derived from titles — so a
   * chapter whose file is named by hand keeps its name across writes. Only a
   * chapter whose number or title actually changed is re-pathed at read time,
   * which is what makes a rename a rename rather than an orphan. A volume's path
   * is derived from its number when the index has not recorded one, which is the
   * same rule in its simplest form: the number is the whole name.
   *
   * @param state - the state to render.
   * @param index - the index whose recorded paths are honored; defaults to the
   *   state's own, and is passed explicitly when rendering a *previous* state
   *   whose in-memory index has already been replaced by the new one.
   * @returns path → file text.
   */
  private planFiles(state: NovelState, index: StorageIndex = state.index ?? emptyIndex(this.layout)): Record<string, string> {
    // The rendering itself is a pure function of the state, so passing `index`
    // through changes no byte: it decides only *where* each chapter's files are
    // placed. That is what makes the diff in `writeContent` sound — rendering a
    // previous state with the index it was read under reproduces exactly the
    // bytes that state was written as.
    const parts = decomposeContent({ ...state, index }, state.updatedAt)
    const files: Record<string, string> = {
      [index.outlineFile]: parts.outline,
      [index.castFile]: parts.cast,
      [index.worldFile]: parts.world,
      [index.competitorFile]: parts.competitors,
    }
    for (const [key, text] of Object.entries(parts.volumes)) {
      const recorded = index.volumes[key]
      const path = recorded?.file ?? volumePath(Number.parseInt(key, 10), index)
      files[path] = text
    }
    files[index.chapterPlanFile] = parts.chapterPlan.wholeBook
    for (const [key, text] of Object.entries(parts.chapterPlan.volumes)) {
      const path = parts.chapterPlan.paths[key] ?? chapterPlanPath(Number.parseInt(key, 10), index)
      files[path] = text
    }
    for (const [id, chapter] of Object.entries(parts.chapters)) {
      const recorded = index.chapters[id]
      const paths = recorded === undefined
        ? chapterPaths(state.chapters[id]?.number ?? 0, state.chapters[id]?.title ?? '', this.layout)
        : { bodyFile: recorded.bodyFile, outlineFile: recorded.outlineFile }
      files[paths.bodyFile] = chapter.body
      files[paths.outlineFile] = chapter.outline
    }
    return files
  }

  /**
   * The index a state's files imply, without touching the filesystem.
   *
   * @param state - the state.
   * @param hashes - `sha256:…` per rendered path, from {@link hashAll}.
   * @returns the index.
   */
  private indexFor(state: NovelState, hashes: Readonly<Record<string, string>>): StorageIndex {
    const base = state.index ?? emptyIndex(this.layout)
    const chapters: Record<string, StorageIndex['chapters'][string]> = {}
    for (const chapter of Object.values(state.chapters)) {
      const recorded = base.chapters[chapter.id]
      const paths = recorded === undefined
        ? chapterPaths(chapter.number, chapter.title, this.layout)
        : { bodyFile: recorded.bodyFile, outlineFile: recorded.outlineFile }
      chapters[chapter.id] = {
        number: chapter.number,
        title: chapter.title,
        bodyFile: paths.bodyFile,
        outlineFile: paths.outlineFile,
        bodyHash: hashes[paths.bodyFile] ?? '',
        outlineHash: hashes[paths.outlineFile] ?? '',
      }
    }
    const volumes: Record<string, StorageIndex['volumes'][string]> = {}
    for (const volume of state.outline.volumes) {
      const key = String(volume.number)
      const path = base.volumes[key]?.file ?? volumePath(volume.number, base)
      volumes[key] = { number: volume.number, file: path, hash: hashes[path] ?? '' }
    }
    const chapterPlans: Record<string, StorageIndex['chapterPlans'][string]> = {}
    for (const volume of planVolumesOf(state.chapters, state.outline.beats)) {
      const key = String(volume)
      const path = base.chapterPlans[key]?.file ?? chapterPlanPath(volume, base)
      chapterPlans[key] = { volume, file: path, hash: hashes[path] ?? '' }
    }
    return { ...base, chapters, volumes, chapterPlans, files: { ...hashes } }
  }

  /**
   * Indexed paths that the new state no longer writes.
   *
   * Both indexes matter. The **previous** one knows the paths this state has
   * abandoned (a chapter that was renamed or renumbered, a volume that was
   * dropped). The **next** one knows the paths that were never on disk before —
   * and those must not be mistaken for orphans: a chapter or volume written for
   * the first time appears in the new index and in `files`, and treating it as an
   * orphan would delete the content the write just created.
   *
   * @param previous - the index the write started from.
   * @param next - the index the write produces.
   * @param files - the files the new state writes.
   * @returns the paths to delete.
   */
  private orphanedPaths(
    previous: StorageIndex,
    next: StorageIndex,
    files: Readonly<Record<string, string>>,
  ): string[] {
    const keep = new Set(Object.keys(files))
    const candidates = [
      ...Object.values(previous.chapters).flatMap((ref) => [ref.bodyFile, ref.outlineFile]),
      ...Object.values(next.chapters).flatMap((ref) => [ref.bodyFile, ref.outlineFile]),
      ...Object.values(previous.volumes).map((ref) => ref.file),
      ...Object.values(next.volumes).map((ref) => ref.file),
      ...Object.values(previous.chapterPlans).map((ref) => ref.file),
      ...Object.values(next.chapterPlans).map((ref) => ref.file),
      ...topLevelPaths(this.layout),
    ]
    return [...new Set(candidates)].filter((path) => path !== '' && !keep.has(path))
  }

  /**
   * Write one file under the backend's own guard.
   *
   * A file that already exists is replaced against its current version, so a
   * write that loses a race fails loudly instead of clobbering; a file that does
   * not exist is created with `createIfAbsent` for the same reason.
   *
   * @param target - the resolved target.
   * @param text - the full content.
   */
  private async writeGuarded(
    target: FsTarget,
    text: string,
    policy: CallSandboxPolicy | undefined,
  ): Promise<void> {
    const info = await this.fs.stat(target)
    if (info === undefined) {
      await this.fs.writeText(target, text, { kind: 'createIfAbsent' }, undefined, policy)
      return
    }
    await this.fs.writeText(target, text, { kind: 'replaceIfVersion', version: info.version }, undefined, policy)
  }

  /**
   * Delete one content file, tolerating a file that is already gone.
   *
   * Deletion goes through Node's filesystem rather than `ctx.fs`, because the
   * `FileSystem` service deliberately exposes no delete or rename primitive: it
   * offers resolution, `stat`, read, list, write, and edit, and a plugin that
   * needs to *unlink* has to ask the backend for the process path of a target it
   * has already resolved and contained. `host/resolver.ts` takes the same route
   * for `mkdir`. Containment is unaffected: the target came from
   * {@link NovelStore.contain} and every path written here is one the store
   * itself derived from the layout, never a caller-supplied string.
   *
   * @param path - the workspace-relative path.
   * @throws {NovelStoreError} when the backend cannot map the target to a process path.
   */
  private async remove(path: string): Promise<void> {
    const target = await this.fs.resolve(this.contain(path))
    if ((await this.fs.stat(target)) === undefined) return
    const processPath = this.fs.processPath(target)
    if (processPath === undefined || processPath === '') {
      throw new NovelStoreError(`cannot delete ${path}: the filesystem backend exposes no process path for it`)
    }
    try {
      await unlink(processPath)
    } catch (error) {
      // A path that vanished between the stat and the unlink is the outcome the
      // delete wanted; anything else is a real failure.
      if ((error as { code?: string }).code !== 'ENOENT') throw error
    }
  }

  /**
   * Write the metadata document, guarded by the version the caller read.
   *
   * @param text - the serialized metadata to persist.
   * @param expected - the version to match, or `undefined` to create.
   * @returns the file's info after the write, whose `version` the next guarded
   *   write must match.
   * @throws when the backend rejects the guard.
   */
  private async writeMetadataText(
    text: string,
    expected: FsVersion | undefined,
    policy: CallSandboxPolicy | undefined,
  ): Promise<FsInfo> {
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > MAX_METADATA_BYTES) {
      const size = `${(bytes / (1024 * 1024)).toFixed(1)} MB`
      const limit = `${String(MAX_METADATA_BYTES / (1024 * 1024))} MB`
      throw new NovelStoreError(
        `refusing to write ${NOVEL_RELATIVE_PATH}: the metadata document would be ${size}, over the ${limit} limit. `
        + 'Chapter prose, cast, world and volume pacing belong in their Markdown files, not in the metadata document. '
        + 'This usually means content leaked back into metadata, or several writers raced and re-escaped one another. '
        + 'Nothing was written; re-read the project and inspect the largest fields before retrying.',
      )
    }
    const target = await this.resolve()
    if (expected === undefined) {
      await this.fs.writeText(target, text, { kind: 'createIfAbsent' }, undefined, policy)
    } else {
      await this.fs.writeText(target, text, { kind: 'replaceIfVersion', version: expected }, undefined, policy)
    }
    const info = await this.fs.stat(target)
    if (info === undefined) throw new NovelStoreError(`${NOVEL_RELATIVE_PATH} disappeared immediately after being written`)
    return info
  }

  /**
   * Resolve the metadata document path through the deployment's filesystem.
   *
   * @returns the stable target, valid even before the file exists.
   */
  private resolve(): Promise<FsTarget> {
    return this.fs.resolve(this.documentPath)
  }

  /**
   * Serialize one operation behind every earlier one.
   *
   * @param operation - the work to run exclusively.
   * @returns the operation's result.
   */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  // ── in-process parse cache ──────────────────────────────────────────────────

  /**
   * Remember what a state's files now contain, keyed by their hash.
   *
   * @param state - the state that was just written.
   */
  private remember(state: NovelState): void {
    const index = state.index
    if (index === undefined) return
    for (const [path, hash] of Object.entries(index.files)) this.seenHashes.set(hash, path)
    if (this.seenHashes.size > 4096) this.seenHashes.clear()
  }

  /**
   * Drop cache entries for paths the write removed.
   *
   * @param removed - the paths that no longer exist.
   */
  private forget(removed: readonly string[]): void {
    if (removed.length === 0) return
    const gone = new Set(removed)
    for (const [hash, path] of this.seenHashes) {
      if (gone.has(path)) this.seenHashes.delete(hash)
    }
  }
}

/**
 * Whether two metadata documents agree on everything except their indexes.
 *
 * Used to decide whether a write needs to touch `.novel/novel.json` at all: if
 * the scalars and the index both match, the document on disk already says
 * exactly what this write would say.
 *
 * @param a - one metadata document, or `undefined`.
 * @param b - the state the write produced.
 * @returns true when every scalar field matches.
 */
function sameScalars(a: NovelMetadata | undefined, b: NovelState): boolean {
  if (a === undefined) return false
  const left = JSON.stringify({ ...a, index: undefined })
  const right = JSON.stringify({ ...metadataOf(b, undefined), index: undefined })
  return left === right
}

/** The `id` a claimed file's frontmatter carries, or `undefined` when it has none. */
function frontId(frontmatter: YamlMap): string | undefined {
  const value = frontmatter['id']
  const id = typeof value === 'string' ? value.trim() : ''
  return id === '' ? undefined : id
}

/**
 * Whether two indexes record the same thing.
 *
 * @param a - one index.
 * @param b - the other.
 * @returns true when paths, hashes, numbers, and titles all match.
 */
function sameIndex(a: StorageIndex, b: StorageIndex): boolean {
  if (
    a.outlineFile !== b.outlineFile ||
    a.castFile !== b.castFile ||
    a.worldFile !== b.worldFile ||
    a.volumeDir !== b.volumeDir ||
    a.chapterPlanFile !== b.chapterPlanFile ||
    a.chapterPlanDir !== b.chapterPlanDir ||
    a.competitorFile !== b.competitorFile
  ) {
    return false
  }
  const aFiles = Object.entries(a.files)
  const bFiles = Object.entries(b.files)
  if (aFiles.length !== bFiles.length) return false
  for (const [path, hash] of aFiles) if (b.files[path] !== hash) return false
  const aChapters = Object.entries(a.chapters)
  const bChapters = Object.entries(b.chapters)
  if (aChapters.length !== bChapters.length) return false
  for (const [id, ref] of aChapters) {
    const other = b.chapters[id]
    if (other === undefined) return false
    if (
      other.number !== ref.number ||
      other.title !== ref.title ||
      other.bodyFile !== ref.bodyFile ||
      other.outlineFile !== ref.outlineFile ||
      other.bodyHash !== ref.bodyHash ||
      other.outlineHash !== ref.outlineHash
    ) {
      return false
    }
  }
  return sameVolumes(a.volumes, b.volumes) && sameChapterPlans(a.chapterPlans, b.chapterPlans)
}

/**
 * Whether two chapter-plan maps record the same files and hashes.
 *
 * @param a - one map, keyed by volume number as a string.
 * @param b - the other.
 * @returns true when they match entry for entry.
 */
function sameChapterPlans(
  a: StorageIndex['chapterPlans'],
  b: StorageIndex['chapterPlans'],
): boolean {
  const entries = Object.entries(a)
  if (entries.length !== Object.keys(b).length) return false
  for (const [key, ref] of entries) {
    const other = b[key]
    if (other === undefined) return false
    if (other.volume !== ref.volume || other.file !== ref.file || other.hash !== ref.hash) return false
  }
  return true
}

/**
 * Whether two volume maps record the same files and hashes.
 *
 * @param a - one map, keyed by volume number as a string.
 * @param b - the other.
 * @returns true when they match entry for entry.
 */
function sameVolumes(
  a: StorageIndex['volumes'],
  b: StorageIndex['volumes'],
): boolean {
  const entries = Object.entries(a)
  if (entries.length !== Object.keys(b).length) return false
  for (const [key, ref] of entries) {
    const other = b[key]
    if (other === undefined) return false
    if (other.number !== ref.number || other.file !== ref.file || other.hash !== ref.hash) return false
  }
  return true
}


/**
 * Whether a parsed outline answered anything at all.
 *
 * Used to tell "this is a duplicate of the outline, written in the tool's own
 * dialect" from "this is a prose outline the author wrote by hand": the second
 * parses to an empty record, and folding it would archive a real draft while
 * reporting it as identical. An unrecognised file is named and left alone.
 *
 * @param outline - the parsed duplicate.
 * @returns true when at least one named field carries text.
 */
function outlineHasContent(outline: ReturnType<typeof parseOutlineFile>): boolean {
  if (outline.logline.trim() !== '' || outline.fullOutline.trim() !== '' || outline.minimal.trim() !== '') return true
  if (outline.fullOutlineDone || outline.acts.length > 0) return true
  return [outline.story, outline.spine, outline.style, outline.cheat]
    .some((record) => Object.values(record).some((value) => value.trim() !== ''))
}

/**
 * Fill one empty string from a duplicate, without ever overwriting an answer.
 *
 * @param base - the canonical value.
 * @param extra - the duplicate's value.
 * @returns the value to keep, how many characters were filled, and whether both
 *   sides had a non-empty but different answer.
 */
function fillText(base: string, extra: string): { value: string; filled: number; conflicts: number } {
  const current = base.trim()
  const other = extra.trim()
  if (current === '' && other !== '') return { value: extra, filled: 1, conflicts: 0 }
  if (current !== '' && other !== '' && base !== extra) return { value: base, filled: 0, conflicts: 1 }
  return { value: base, filled: 0, conflicts: 0 }
}

/**
 * Fill a record's empty fields from a duplicate document.
 *
 * Deliberately field-by-field rather than a whole-document overwrite: an outline
 * that answered its logline but not its synopsis should gain the synopsis, not
 * become the other file's version of the logline.
 *
 * @param base - the canonical record.
 * @param extra - the duplicate's record.
 * @returns the merged record, how many fields were filled, and how many disagreed.
 */
function fillRecord<Field extends string>(
  base: Readonly<Record<Field, string>>,
  extra: Readonly<Record<Field, string>>,
): { value: Record<Field, string>; filled: number; conflicts: number } {
  const value: Record<Field, string> = { ...base }
  let filled = 0
  let conflicts = 0
  for (const key of Object.keys(extra) as Field[]) {
    const merged = fillText(value[key] ?? '', extra[key] ?? '')
    if (merged.filled > 0) {
      value[key] = merged.value
      filled += 1
    }
    conflicts += merged.conflicts
  }
  return { value, filled, conflicts }
}

/**
 * Consume a one-shot message into a spreadable object.
 *
 * The caller clears {@link NovelStore.pendingReport} immediately after, so a
 * report is delivered exactly once: by the first read that follows the
 * migration, whichever branch of `load` that read takes.
 *
 * @param message - the message, or `undefined`.
 * @returns `{ migration }` when there is one, `{}` otherwise.
 */
function take(message: string | undefined): { readonly migration?: string } {
  return message === undefined ? {} : { migration: message }
}

/**
 * Hash every rendered file, keyed by path.
 *
 * @param files - path → file text.
 * @returns path → `sha256:…`.
 */
function hashAll(files: Readonly<Record<string, string>>): Record<string, string> {
  const hashes: Record<string, string> = {}
  for (const [path, text] of Object.entries(files)) hashes[path] = hashContent(text)
  return hashes
}

/** Wrap a codec failure as a store error, keeping its message and cause. */
function asStoreError(error: unknown): NovelStoreError {
  if (error instanceof NovelStoreError) return error
  if (error instanceof NovelContentError) return new NovelStoreError(error.message, { cause: error })
  return new NovelStoreError(describe(error), { cause: error })
}

/** Read a message out of an unknown thrown value. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
