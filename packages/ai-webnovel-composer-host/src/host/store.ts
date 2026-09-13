/**
 * The plugin's `novelState` service: atomic, single-project state access over
 * the harness filesystem.
 *
 * Why a service instead of direct file access in each tool: every reader and
 * both surfaces (model tools and the Web UI) then share one containment rule,
 * one conflict check, and one write path, so a chapter can never be written
 * through a code path that skipped them.
 *
 * Atomicity rests on the filesystem's own write intents — `createIfAbsent` for
 * initialization and `replaceIfVersion` for every mutation — rather than on a
 * hand-rolled comparison. The version token is the backend's, so an external
 * writer (the model's normal file tools, another session, the user's editor) is
 * detected exactly, not heuristically.
 *
 * @module @ai-webnovel/composer-host/host/store
 */

import type { Context } from '@deepseek-ai/cordis'
import { isAbsolute, resolve, sep } from 'node:path'
import type { FileSystem, FsDirEntry, FsTarget, FsVersion } from '@deepseek-ai/dsh-fs'
import { NovelStoreError, parseNovel, serializeNovel, type Clock, systemClock } from '../core/novel.ts'
import type { NovelState } from '../core/types.ts'
import { NOVEL_DIR, classifyWorkspace, type WorkspaceVerdict } from '../core/workspace.ts'

/** Document path, relative to the session workspace root. */
export const NOVEL_RELATIVE_PATH = '.novel/novel.json'

/** Raised when the document changed underneath the caller's read. */
export class NovelConflictError extends Error {
  override readonly name = 'NovelConflictError'
}

/** Registered service name: the resolver, not one store; see `host/resolver.ts`. */
export const NOVEL_SERVICE_NAME = 'novelState'

/** A state together with the version token it was read at. */
export interface VersionedNovel {
  /** The parsed project. */
  readonly state: NovelState
  /** The backend's version token for the document at read time. */
  readonly version: FsVersion
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

/** Options accepted by {@link NovelStore}. */
export interface NovelStoreOptions {
  /** Workspace root the document path resolves against; defaults to the process working directory. */
  readonly workspaceRoot?: string
  /** Clock seam for deterministic tests. */
  readonly clock?: Clock
}

/**
 * Access to one project's `.novel/novel.json`.
 *
 * Deliberately **not** a Cordis service: one process hosts many projects (one
 * per session workspace), and a service name can only be registered once — an
 * earlier revision extended `Service` and threw `service "novelState" has been
 * registered` the moment a second workspace appeared. The service is the
 * resolver (`ctx.novelState`), which hands out these plain stores.
 *
 * Reads are uncached: the file is small, and a cached copy would be a second
 * source of truth for a document the model may also edit through its normal
 * file tools. Writes serialize behind one promise chain, re-read immediately
 * before writing, and carry the version they read so the backend rejects the
 * write if anything landed in between.
 */
export class NovelStore {
  /** Absolute root the document path resolves against. */
  readonly workspaceRoot: string

  /** The context whose `fs` service every read and write goes through. */
  private readonly ctx: Context

  /** Timestamp source for writes. */
  private readonly clock: Clock

  /** Tail of the write queue; every mutation chains onto it. */
  private queue: Promise<unknown> = Promise.resolve()

  /**
   * @param ctx - the context carrying the filesystem service.
   * @param options - workspace root and clock seams.
   */
  constructor(ctx: Context, options: NovelStoreOptions = {}) {
    this.ctx = ctx
    this.workspaceRoot = options.workspaceRoot ?? process.cwd()
    this.clock = options.clock ?? systemClock
  }

  /** The document path, absolute in the filesystem's execution world. */
  get documentPath(): string {
    return `${this.workspaceRoot.replace(/[/\\]+$/u, '')}/${NOVEL_RELATIVE_PATH}`
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
   * @throws {NovelStoreError} when a document exists but is unreadable.
   */
  async read(): Promise<NovelState | undefined> {
    const loaded = await this.readVersioned()
    return loaded?.state
  }

  /**
   * Read the project together with the version token a later write must match.
   *
   * @returns the versioned state, or `undefined` when no project exists yet.
   * @throws {NovelStoreError} when a document exists but is unreadable.
   */
  async readVersioned(): Promise<VersionedNovel | undefined> {
    const target = await this.resolve()
    const info = await this.fs.stat(target)
    if (info === undefined || info.type !== 'file') return undefined
    const raw = await this.fs.readText(target)
    if (raw.trim() === '') return undefined
    return { state: parseNovel(raw), version: info.version }
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
   * Create the project document if the workspace has none, and report what
   * happened.
   *
   * Used at boot for a workspace the composer owns: an existing project is left
   * exactly as it is, and a second call is a no-op, so re-mounting the plugin (or
   * booting a second session against one directory) can never reset a draft.
   *
   * @param state - the state to persist when nothing exists yet.
   * @returns `'created'` when this call wrote the document, `'existing'` otherwise.
   */
  async adopt(state: NovelState): Promise<'created' | 'existing'> {
    return this.enqueue(async () => {
      const target = await this.resolve()
      if (await isRegularFile(this.fs, target)) return 'existing'
      try {
        await this.fs.writeText(target, serializeNovel(state), { kind: 'createIfAbsent' })
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
   * Apply one mutation atomically: read, transform, write under the read version.
   *
   * The mutation may be async, but the read-to-write window stays open while it
   * runs: anything that writes the document in that window makes this write fail
   * as a conflict rather than silently clobbering it.
   *
   * @param mutate - transformation from the current state to the next.
   * @returns the persisted state.
   * @throws {NovelStoreError} when no project has been initialized.
   * @throws {NovelConflictError} when the document changed since the read.
   */
  async update(mutate: (current: NovelState) => NovelState | Promise<NovelState>): Promise<NovelState> {
    return this.enqueue(async () => {
      const loaded = await this.readVersioned()
      if (loaded === undefined) {
        throw new NovelStoreError(`no novel project at ${this.documentPath}; initialize one first`)
      }
      const next = await mutate(loaded.state)
      return this.write(next, loaded.version)
    })
  }

  /**
   * Create the project document, refusing to touch an existing one.
   *
   * @param state - the state to persist.
   * @throws {NovelConflictError} when a project already exists.
   */
  async create(state: NovelState): Promise<void> {
    await this.enqueue(async () => {
      const target = await this.resolve()
      try {
        await this.fs.writeText(target, serializeNovel(state), { kind: 'createIfAbsent' })
      } catch (error) {
        if (isFsErrorCode(error, 'FS_NOT_OBSERVED')) {
          throw new NovelConflictError(`a novel project already exists at ${this.documentPath}`)
        }
        throw error
      }
    })
  }

  /**
   * Write derived output beside the project — the manuscript, an outline dump,
   * a character sheet. Paths are resolved against the same workspace root as the
   * document, so an export can never land outside the project directory.
   *
   * @param relativePath - destination relative to the workspace root.
   * @param content - the full text to write.
   * @returns the absolute display path that was written.
   * @throws {NovelStoreError} when the path escapes the workspace root.
   */
  async writeDerived(relativePath: string, content: string): Promise<string> {
    const destination = this.contain(relativePath)
    const target = await this.fs.resolve(destination)
    await this.fs.writeText(target, content)
    return target.displayPath
  }

  /**
   * Resolve one caller-supplied relative path inside the workspace root.
   *
   * Containment is decided by path arithmetic (`relative`), not by string
   * prefixes: a prefix test would accept a sibling directory whose name merely
   * starts with the root's, and would miss `.`/`..` segments that only collapse
   * once resolved.
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

  /**
   * Persist a state guarded by the version the caller read.
   *
   * @param next - the state to write.
   * @param expected - version token from the read this state derives from.
   * @returns the persisted state, with a fresh `updatedAt`.
   * @throws {NovelConflictError} when the stored document moved on.
   */
  private async write(next: NovelState, expected: FsVersion): Promise<NovelState> {
    const stamped: NovelState = { ...next, updatedAt: this.clock() }
    const target = await this.resolve()
    try {
      await this.fs.writeText(target, serializeNovel(stamped), { kind: 'replaceIfVersion', version: expected })
    } catch (error) {
      if (isFsErrorCode(error, 'FS_STALE_VERSION')) {
        throw new NovelConflictError(
          `${NOVEL_RELATIVE_PATH} changed since it was read; re-read the project and reapply the change`,
        )
      }
      throw error
    }
    return stamped
  }

  /**
   * Resolve the document path through the deployment's filesystem.
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
}
