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
 * @module @ai-webnovel/composer-host/src/host/store
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
  hashContent,
  metadataOf,
  parseDocument,
  parseMetadata,
  serializeMetadata,
  stateOf,
  type Clock,
  type YamlMap,
  systemClock,
} from '../core/index.ts'
import {
  DEFAULT_STORAGE_LAYOUT,
  METADATA_RELATIVE_PATH,
  MIGRATION_BACKUP_PATH,
  chapterPaths,
  isMarkdownFile,
  isOutlineFile,
  topLevelPaths,
} from '../core/paths.ts'
import type { NovelMetadata, NovelState, StorageIndex, StorageLayout } from '../core/types.ts'
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
  /** Filenames the five top-level content files use. */
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

  /** Filenames the five top-level content files use. */
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
    const target = await this.resolve()
    let info = await this.fs.stat(target)
    if (info === undefined || info.type !== 'file') return undefined
    const raw = await this.fs.readText(target)
    if (raw.trim() === '') return undefined

    const warnings: string[] = []
    const { metadata } = parseMetadata(raw)

    // Directory hygiene: put back whatever the index lost, and report files that
    // cannot be claimed at all rather than deleting or ignoring them silently.
    const claimed = await this.claim({ ...metadata.index }, warnings)
    const indexed = claimed.index
    const outlineFallback = metadata.opening

    const files: Record<string, string> = {}
    const paths = [
      indexed.outlineFile,
      indexed.castFile,
      indexed.worldFile,
      indexed.volumeFile,
      indexed.chapterPlanFile,
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
      assembled = composeContent(files, indexed, outlineFallback)
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
    // did not. A write here is safe: it is derived entirely from the files.
    if (refreshed.changed || claimed.changed) {
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
    const hashes: Record<string, string> = {}
    for (const [path, text] of Object.entries(files)) hashes[path] = hashContent(text)
    const next: StorageIndex = { ...index, chapters, files: hashes }
    return { index: next, changed: !sameIndex(index, next) }
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
        const id = await this.claimId(path)
        if (id === undefined) continue
        const bodyFile = `${stem}.md`
        const existing = chapters[id]
        const body = existing === undefined ? undefined : await this.readContent(existing.bodyFile)
        chapters[id] = {
          number: existing?.number ?? 0,
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
      const id = await this.claimId(path)
      if (id === undefined) {
        warnings.push(`${path} 没有 frontmatter id，无法认领；已保留原文件未做改动`)
        continue
      }
      const existing = chapters[id]
      chapters[id] = {
        number: existing?.number ?? 0,
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
   * Read the id a chapter file claims, if it claims one.
   *
   * @param path - the file to read.
   * @param stem - the filename stem, used to check the id is not merely derived.
   * @returns the id, or `undefined` when the file carries none.
   */
  private async claimId(path: string): Promise<string | undefined> {
    const text = await this.readContent(path)
    if (text === undefined) return undefined
    let frontmatter: YamlMap
    try {
      frontmatter = parseDocument(text, path).frontmatter
    } catch (error) {
      throw asStoreError(error)
    }
    const value = frontmatter['id']
    const id = typeof value === 'string' ? value.trim() : ''
    return id === '' ? undefined : id
  }

  // ── migration ───────────────────────────────────────────────────────────────

  /**
   * Migrate a pre-split document once per store instance.
   *
   * Reading is the natural trigger: a version-2 document cannot be read without
   * being converted, and the conversion must not run twice concurrently (two
   * readers would both generate files and race on the backup).
   *
   * The order is the plan's: **back up first**, then generate, then replace the
   * document. The backup is created with `createIfAbsent`, so an existing one is
   * never overwritten and two racing readers cannot clobber each other's copy.
   * If it already exists, the project was migrated by an earlier session whose
   * content files are the current truth, so there is nothing left to do.
   */
  private async ensureMigrated(policy: CallSandboxPolicy | undefined): Promise<void> {
    this.migration ??= this.enqueue(async () => {
      const target = await this.resolve()
      const info = await this.fs.stat(target)
      if (info === undefined || info.type !== 'file') return
      const raw = await this.fs.readText(target)
      if (raw.trim() === '') return
      const { version, legacy } = parseMetadata(raw)
      if (version === NOVEL_SCHEMA_VERSION || legacy === undefined) return
      if (!(await this.backup(raw, policy))) return
      const chapters = Object.keys(legacy.chapters).length
      await this.writeAll(legacy, info.version, policy, { forceRewrite: true })
      this.pendingReport = `novel.json 已升级 v${String(version)} → v${String(NOVEL_SCHEMA_VERSION)}：` +
        `生成 ${String(chapters)} 章的内容文件，原文档备份在 ${MIGRATION_BACKUP_PATH}`
    })
    return this.migration
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
   * chapter, have their hashes recomputed.
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
    if (!moved) return base
    return { ...base, chapters }
  }

  /**
   * Fill in the hashes of every file the write produced.
   *
   * Called after the content step, because the hashes depend on the bytes that
   * were actually written — and writing is what may have moved a chapter.
   *
   * @param index - the index to complete.
   * @param index - the index to complete.
   * @param files - the rendered files, keyed by path.
   * @returns the index with hashes for every chapter and file.
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
    if (!changed) return index
    return { ...index, chapters, files: hashAll(files) }
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
   * which is what makes a rename a rename rather than an orphan.
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
      [index.volumeFile]: parts.volumes,
      [index.chapterPlanFile]: parts.chapterPlan,
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
    return { ...base, chapters, files: { ...hashes } }
  }

  /**
   * Indexed paths that the new state no longer writes.
   *
   * Both indexes matter. The **previous** one knows the paths this state has
   * abandoned (a chapter that was renamed or renumbered). The **next** one knows
   * the paths that were never on disk before — and those must not be mistaken for
   * orphans: a chapter written for the first time appears in the new index and in
   * `files`, and treating it as an orphan would delete the chapter the write just
   * created.
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
    a.volumeFile !== b.volumeFile ||
    a.chapterPlanFile !== b.chapterPlanFile
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
  return true
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
