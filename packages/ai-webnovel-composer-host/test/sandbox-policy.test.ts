import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { FsError, type FsTarget, type FsWriteIntent, type FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { emptyNovel } from '../src/core/index.ts'
import { NOVEL_RELATIVE_PATH, NovelStore } from '../src/host/store.ts'
import { policyForRoot, policyForSession, withSandboxPolicy } from '../src/host/sandbox.ts'

/**
 * The composer's half of the sandbox contract.
 *
 * The composer writes through `ctx.fs` directly, so under a confining backend it
 * must carry the same per-call sandbox policy the model-facing file tools carry.
 * These specs mount a stand-in for `dsh-fs-sandbox` that reproduces the two
 * facts which make that load-bearing: a mutation is refused unless the
 * *policy's* workspace root contains it, and a mutation that carries **no**
 * policy falls back to the deployment's root — which, for a long-running service
 * hosting many workspaces, is not the session workspace.
 *
 * The regression these pin is silent by construction: reads are unfenced, so a
 * composer missing the policy reports every project accurately and still cannot
 * write one.
 */

/** Where a policy-less mutation is fenced, standing in for the process cwd. */
let deploymentRoot = ''

/**
 * Whether a canonical target sits under a root, compared the way a real backend
 * compares it: on real paths, since a temporary root is reached through a
 * symlink on macOS.
 *
 * @param target - the resolved target key, already canonical.
 * @param root - the policy's workspace root.
 * @returns true when the target is the root or lives beneath it.
 */
async function isUnder(target: string, root: string): Promise<boolean> {
  const canonical = await realpath(root).catch(() => root)
  return target === canonical || target.startsWith(`${canonical}/`)
}

/** `dsh-fs-sandbox`'s fence, narrowed to the mutation the composer performs. */
class FencedFileSystem extends LocalFileSystem {
  /** The mode a confining backend reports, which is what makes the policy apply. */
  override get sandboxMode(): 'workspace-write' {
    return 'workspace-write'
  }

  /**
   * @param target - the resolved target to write.
   * @param content - the full new content.
   * @param expected - the guard the write carries.
   * @param signal - cancellation.
   * @param sandboxPolicy - the per-call policy; omitting it is the bug.
   * @returns the write outcome.
   */
  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: { readonly mode: string; readonly workspaceRoot: string },
  ): Promise<FsWriteOutcome> {
    // Exactly the backend's fallback: no policy means the deployment's root.
    const policy = sandboxPolicy ?? { mode: 'workspace-write', workspaceRoot: deploymentRoot }
    if (policy.mode === 'read-only' || !(await isUnder(target.targetKey as string, policy.workspaceRoot))) {
      throw new FsError(
        `cannot write "${target.displayPath}": file access denied under ${policy.mode} mode`,
        'FS_SANDBOX_DENIED',
      )
    }
    return super.writeText(target, content, expected, signal)
  }
}

let session: string
let deployment: string
let ctx: Context
let store: NovelStore
const clock = '2024-05-01T00:00:00.000Z'

beforeEach(async () => {
  session = await mkdtemp(join(tmpdir(), 'ai-webnovel-session-'))
  deployment = await mkdtemp(join(tmpdir(), 'ai-webnovel-deploy-'))
  deploymentRoot = await realpath(deployment)
  ctx = new Context()
  ctx.plugin(FencedFileSystem, { cwd: deployment, diffBasisMaxBytes: 64 * 1024 })
  ctx.provide('sandboxPolicy', {
    defaultMode: 'workspace-write',
    workspaceRoot: deploymentRoot,
    resolve: (request?: { readonly session?: { readonly header: { readonly cwd?: string } } }) => ({
      mode: 'workspace-write',
      workspaceRoot: request?.session?.header.cwd ?? deploymentRoot,
    }),
  })
  store = new NovelStore(ctx, { workspaceRoot: session, clock: () => clock })
})

afterEach(async () => {
  await rm(session, { recursive: true, force: true })
  await rm(deployment, { recursive: true, force: true })
})

/** The state every spec tries to persist. */
const state = () => emptyNovel({ title: '夜之国', premise: '梦里守夜' }, () => clock)

describe('sandbox policy', () => {
  it('denies a mutation that carries no policy, the way a forgetful caller is denied', async () => {
    await expect(store.create(state())).rejects.toThrow(/access denied/)
    await expect(readFile(join(session, NOVEL_RELATIVE_PATH), 'utf8')).rejects.toThrow()
  })

  it('writes into the session workspace once the call is scoped to its policy', async () => {
    await withSandboxPolicy(policyForSession(ctx, { header: { cwd: session } }), () => store.create(state()))
    await expect(readFile(join(session, NOVEL_RELATIVE_PATH), 'utf8')).resolves.toContain('夜之国')
    await expect(readFile(join(session, '全书大纲.md'), 'utf8')).resolves.toContain('# 全书大纲')
  })

  it('keeps the read path inside the same fence when it refreshes the index', async () => {
    await withSandboxPolicy(policyForSession(ctx, { header: { cwd: session } }), () => store.create(state()))
    // A read that changes the index writes the metadata document back, so the
    // read path mutates too and has to be fenced the same way.
    await expect(store.read()).resolves.toBeDefined()
  })

  it('roots a session-less adoption in the workspace it is classifying', async () => {
    await withSandboxPolicy(policyForRoot(ctx, session), () => store.adopt(state()))
    await expect(readFile(join(session, '全书大纲.md'), 'utf8')).resolves.toContain('# 全书大纲')
  })

  it('still refuses when the session itself is read-only', async () => {
    const policy = { mode: 'read-only' as const, workspaceRoot: session }
    await expect(withSandboxPolicy(policy, () => store.create(state()))).rejects.toThrow(/read-only/)
  })
})
