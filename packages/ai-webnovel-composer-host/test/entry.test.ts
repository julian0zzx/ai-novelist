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
    expect(resolved.workspaceMode).toBe('auto')
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
})
