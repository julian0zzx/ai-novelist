import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { Config, apply, inject, name } from '../src/index.ts'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

/**
 * Entry-point specs: everything a booted DSH tree does to this plugin.
 *
 * `dsh-tools` is not mounted here, so the tools registry is a recorder — the
 * point is that `apply` runs, provides the service, and registers the full tool
 * set against a context whose shape matches the real one.
 */
let root: string
let ctx: Context
let registered: ToolDefinition[]

/** Minimal stand-in for the `tools` service: records what a plugin registers. */
const recorder = {
  name: 'tools-recorder',
  apply(target: Context) {
    const definitions: ToolDefinition[] = []
    registered = definitions
    target.provide('tools', {
      register: (definition: ToolDefinition) => {
        definitions.push(definition)
        return () => {
          const index = definitions.indexOf(definition)
          if (index >= 0) definitions.splice(index, 1)
        }
      },
    })
  },
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ai-webnovel-entry-'))
  registered = []
  ctx = new Context()
  ctx.plugin(LocalFileSystem, { cwd: root, diffBasisMaxBytes: 64 * 1024 })
  ctx.plugin(recorder)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('plugin manifest surface', () => {
  it('declares a stable name and the services it needs', () => {
    expect(name).toBe('ai-webnovel-composer')
    expect(inject).toEqual(['fs', 'tools'])
  })

  it('defaults every config field', () => {
    const resolved = Config({}) as { workspaceRoot: string; workspaceMode: string }
    expect(resolved.workspaceRoot).toBe('')
    // `signal` is the default because the composer's most common first contact
    // is a folder holding a premise file and a few chapters, not an empty one.
    expect(resolved.workspaceMode).toBe('signal')
  })
})

describe('apply', () => {
  it('provides the novelState service for the deployment root and registers every tool', () => {
    apply(ctx, Config({ workspaceRoot: root }) as never)
    expect(ctx.get('novelState')).toBeDefined()
    expect(registered.map((definition) => definition.name).sort()).toEqual([
      'novel_bible',
      'novel_init',
      'novel_metrics',
      'novel_plan',
      'novel_repo',
      'novel_status',
      'novel_verify',
      'novel_write',
    ])
  })

  it('gives every tool a description, parameters, and a render projection', () => {
    apply(ctx, Config({ workspaceRoot: root }) as never)
    for (const definition of registered) {
      expect(definition.description.length, definition.name).toBeGreaterThan(40)
      expect(Object.keys(definition.parameters).length, definition.name).toBeGreaterThan(0)
      expect(typeof definition.output.render, definition.name).toBe('function')
      expect(definition.output.schema, definition.name).toMatchObject({ type: 'object' })
    }
  })

  /** Poll until `check` holds or the deadline passes. */
  async function until(check: () => Promise<boolean>, timeoutMs = 2000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await check()) return true
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return false
  }

  const projectPath = () => join(root, '.novel', 'novel.json')

  /** The `schemaVersion` recorded in the project document, or `undefined`. */
  async function readVersion(): Promise<number | undefined> {
    try {
      const parsed = JSON.parse(await readFile(projectPath(), 'utf8')) as { schemaVersion?: number }
      return parsed.schemaVersion
    } catch {
      return undefined
    }
  }

  it('leaves an empty workspace untouched by default', async () => {
    apply(ctx, Config({ workspaceRoot: root }) as never)
    await new Promise((resolve) => setTimeout(resolve, 200))
    await expect(readFile(projectPath(), 'utf8')).rejects.toThrow()
  })

  it('adopts an empty workspace when the deployment asks for it', async () => {
    apply(ctx, Config({ workspaceRoot: root, adoptEmptyWorkspace: true }) as never)
    const created = await until(async () => {
      try {
        await readFile(projectPath(), 'utf8')
        return true
      } catch {
        return false
      }
    })
    expect(created, 'boot should have written the project document').toBe(true)
    const state = JSON.parse(await readFile(projectPath(), 'utf8')) as { meta: { title: string; premise: string } }
    // The folder name is the provisional title; the model records the real one.
    expect(state.meta.title).toBe(root.split('/').at(-1))
    expect(state.meta.premise).toBe('')
  })

  it('leaves an unrelated project alone', async () => {
    await writeFile(join(root, 'package.json'), '{}\n', 'utf8')
    apply(ctx, Config({ workspaceRoot: root }) as never)
    await new Promise((resolve) => setTimeout(resolve, 200))
    await expect(readFile(projectPath(), 'utf8')).rejects.toThrow()
  })

  it('initializes a directory that holds unmistakable novel material', async () => {
    // The case that motivated `signal`: a folder with a premise file in it and no
    // other composer marker. Nothing here is a project document, but the folder
    // is plainly a book, and an empty scaffold is what makes the tools, the
    // prompt section and the board exist from the first message.
    await writeFile(join(root, '创意整理.md'), '# 创意整理\n', 'utf8')
    apply(ctx, Config({ workspaceRoot: root }) as never)
    const created = await until(async () => {
      try {
        await readFile(projectPath(), 'utf8')
        return true
      } catch {
        return false
      }
    })
    expect(created, 'the scaffold should have been written').toBe(true)
    const state = JSON.parse(await readFile(projectPath(), 'utf8')) as { meta: { title: string; premise: string } }
    // No story decisions are invented: the title is the folder's name and the
    // premise stays empty for the agent or the author to fill in.
    expect(state.meta.title).toBe(root.split('/').at(-1))
    expect(state.meta.premise).toBe('')
  })

  it('never initializes a code repository, however much markdown it holds', async () => {
    // Project markers win: a repo with a premise-shaped file is still a repo.
    await writeFile(join(root, 'package.json'), '{}\n', 'utf8')
    await writeFile(join(root, '创意整理.md'), '# 创意整理\n', 'utf8')
    await writeFile(join(root, 'outline.md'), '# outline\n', 'utf8')
    apply(ctx, Config({ workspaceRoot: root }) as never)
    await new Promise((resolve) => setTimeout(resolve, 200))
    await expect(readFile(projectPath(), 'utf8')).rejects.toThrow()
  })

  it('keeps the older quiet rule under workspaceMode=auto', async () => {
    await writeFile(join(root, '创意整理.md'), '# 创意整理\n', 'utf8')
    apply(ctx, Config({ workspaceRoot: root, workspaceMode: 'auto' }) as never)
    await new Promise((resolve) => setTimeout(resolve, 200))
    await expect(readFile(projectPath(), 'utf8')).rejects.toThrow()
  })

  it('never resets a project that already exists', async () => {
    await writeFile(join(root, 'package.json'), '{}\n', 'utf8') // keep it out of "fresh"
    apply(ctx, Config({ workspaceRoot: root }) as never)
    await new Promise((resolve) => setTimeout(resolve, 100))
    await mkdir(join(root, '.novel'), { recursive: true })
    // A pre-split document: reading it migrates it, and the whole point of the
    // backup is that the author's original bytes survive that upgrade.
    const first =
      '{"schemaVersion":1,"meta":{"title":"Draft","premise":"P"},"characters":{},"world":{},"chapters":{},' +
      '"createdAt":"2024-01-01T00:00:00.000Z","updatedAt":"2024-01-01T00:00:00.000Z"}\n'
    await writeFile(projectPath(), first, 'utf8')
    // Re-mounting the plugin (a second session, a reload) must not reset it.
    const other = new Context()
    other.plugin(LocalFileSystem, { cwd: root, diffBasisMaxBytes: 64 * 1024 })
    other.plugin(recorder)
    // The recorder announces `tools` on its own fiber, so wait for the service
    // before mounting the composer against it.
    await until(async () => other.get('tools') !== undefined)
    apply(other, Config({ workspaceRoot: root }) as never)
    // Migration happens on the boot read; poll for it rather than sleeping a
    // fixed interval, because under a loaded test pool the first read can land
    // later than any constant would guess.
    const upgraded = await until(async () => {
      const version = await readVersion()
      return version === 3
    })
    expect(upgraded).toBe(true)
    expect(await readFile(join(root, '.novel', 'novel.v2.backup.json'), 'utf8')).toBe(first)
    const migrated = JSON.parse(await readFile(projectPath(), 'utf8')) as { schemaVersion: number; meta: { title: string } }
    expect(migrated.schemaVersion).toBe(3)
    expect(migrated.meta.title).toBe('Draft')
    // A third mount sees a version-3 document and leaves everything alone: the
    // migration ran exactly once, and the backup was not overwritten.
    const third = new Context()
    third.plugin(LocalFileSystem, { cwd: root, diffBasisMaxBytes: 64 * 1024 })
    third.plugin(recorder)
    await until(async () => third.get('tools') !== undefined)
    apply(third, Config({ workspaceRoot: root }) as never)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(await readFile(join(root, '.novel', 'novel.v2.backup.json'), 'utf8')).toBe(first)
  })

  it('honours workspaceMode=off by writing nothing', async () => {
    apply(ctx, Config({ workspaceRoot: root, workspaceMode: 'off' }) as never)
    await new Promise((resolve) => setTimeout(resolve, 200))
    await expect(readFile(projectPath(), 'utf8')).rejects.toThrow()
  })

  it('honours workspaceMode=novel by adopting an unrelated project directory', async () => {
    await writeFile(join(root, 'package.json'), '{}\n', 'utf8')
    apply(ctx, Config({ workspaceRoot: root, workspaceMode: 'novel' }) as never)
    const created = await until(async () => {
      try {
        await readFile(projectPath(), 'utf8')
        return true
      } catch {
        return false
      }
    })
    expect(created).toBe(true)
  })

  /**
   * Announce a session the way the harness does — structurally, and without
   * waiting for the listeners, whose work is deliberately asynchronous.
   */
  function announceSession(cwd: string): void {
    const events = ctx as unknown as { emit(name: string, session: unknown): void }
    events.emit('session/created', { header: { cwd } })
  }

  /** A directory that already looks like a half-initialized novel project. */
  async function novelShapedDir(name: string): Promise<string> {
    const dir = join(root, name)
    await mkdir(join(dir, '.novel'), { recursive: true })
    return dir
  }

  it('classifies and adopts the workspace of the session that appears in it', async () => {
    // The deployment root stays a software project; the session works elsewhere.
    await writeFile(join(root, 'package.json'), '{}\n', 'utf8')
    const novelDir = await novelShapedDir('qingyun')
    apply(ctx, Config({ workspaceRoot: root }) as never)

    announceSession(novelDir)

    const document = join(novelDir, '.novel', 'novel.json')
    const created = await until(async () => {
      try {
        await readFile(document, 'utf8')
        return true
      } catch {
        return false
      }
    })
    expect(created, "the session's own workspace should have been adopted").toBe(true)
    const state = JSON.parse(await readFile(document, 'utf8')) as { meta: { title: string } }
    // The folder name is the provisional title; the model records the real one.
    expect(state.meta.title).toBe('qingyun')
  })

  it('leaves an empty directory alone when a session appears in it', async () => {
    await writeFile(join(root, 'package.json'), '{}\n', 'utf8')
    const emptyDir = join(root, 'blank')
    await mkdir(emptyDir, { recursive: true })
    apply(ctx, Config({ workspaceRoot: root }) as never)

    announceSession(emptyDir)
    await new Promise((resolve) => setTimeout(resolve, 200))

    // A session's cwd is a directory the user chose, so "empty" is an invitation
    // to call novel_init — not consent to write files nobody asked for.
    await expect(readFile(join(emptyDir, '.novel', 'novel.json'), 'utf8')).rejects.toThrow()
  })

  it('adopts an empty session workspace when the deployment opted in', async () => {
    await writeFile(join(root, 'package.json'), '{}\n', 'utf8')
    const emptyDir = join(root, 'blank')
    await mkdir(emptyDir, { recursive: true })
    apply(ctx, Config({ workspaceRoot: root, adoptEmptyWorkspace: true }) as never)

    announceSession(emptyDir)

    const created = await until(async () => {
      try {
        await readFile(join(emptyDir, '.novel', 'novel.json'), 'utf8')
        return true
      } catch {
        return false
      }
    })
    expect(created).toBe(true)
  })

  it('honours workspaceMode=off for a session that appears in a novel directory', async () => {
    await writeFile(join(root, 'package.json'), '{}\n', 'utf8')
    const novelDir = await novelShapedDir('qingyun')
    apply(ctx, Config({ workspaceRoot: root, workspaceMode: 'off' }) as never)

    announceSession(novelDir)
    await new Promise((resolve) => setTimeout(resolve, 200))

    await expect(readFile(join(novelDir, '.novel', 'novel.json'), 'utf8')).rejects.toThrow()
  })
})
