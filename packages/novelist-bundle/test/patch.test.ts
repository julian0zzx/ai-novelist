import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

/**
 * Bundle contract specs.
 *
 * A bundle that composes wrongly does not fail here — it fails when a user
 * boots their profile. These specs assert the parts DSH reads: the manifest
 * declaration, the patch document's shape, and that every `name` the patch
 * inserts resolves to a package that this bundle actually depends on.
 */

const here = dirname(fileURLToPath(import.meta.url))
const packageDir = join(here, '..')
const require = createRequire(import.meta.url)

/** Read and parse this package's manifest. */
async function readManifest(): Promise<{
  dsh?: { bundle?: { patch?: string } }
  dependencies?: Record<string, string>
}> {
  return JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')) as never
}

/** One loader row as the patch states it. */
interface PatchRow {
  id?: string
  name?: string
  inject?: string[]
  config?: unknown
}

describe('bundle manifest', () => {
  it('declares the patch DSH composes profiles from', async () => {
    const manifest = await readManifest()
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
  })

  it('depends on every package its patch inserts', async () => {
    const manifest = await readManifest()
    const patch = parse(await readFile(join(packageDir, 'cordis.patch.yml'), 'utf8')) as unknown[]
    const rows = patch.flatMap((entry) => (entry as { insert?: PatchRow[] }).insert ?? [])
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.name, `row ${String(row.id)} has no name`).toBeTypeOf('string')
      expect(
        manifest.dependencies?.[row.name as string],
        `patch inserts ${String(row.name)} but the bundle does not depend on it`,
      ).toBeDefined()
    }
  })
})

describe('patch document', () => {
  it('is a top-level array of insert entries', async () => {
    const parsed = parse(await readFile(join(packageDir, 'cordis.patch.yml'), 'utf8')) as unknown
    expect(Array.isArray(parsed)).toBe(true)
    for (const entry of parsed as Record<string, unknown>[]) {
      // Only insertion: an id-targeted override here would silently change how
      // the layers below this bundle behave.
      expect(Object.keys(entry)).toEqual(['insert'])
      expect(Array.isArray(entry['insert'])).toBe(true)
    }
  })

  it('gives every row a unique id and a resolvable name', async () => {
    const patch = parse(await readFile(join(packageDir, 'cordis.patch.yml'), 'utf8')) as { insert: PatchRow[] }[]
    const rows = patch.flatMap((entry) => entry.insert)
    const ids = rows.map((row) => row.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const row of rows) {
      expect(row.id).toBeTypeOf('string')
      // Resolution from the bundle's own directory is the contract the profile
      // relies on when it loads the row.
      const resolved = require.resolve(`${row.name as string}/package.json`, { paths: [packageDir] })
      expect(resolved).toContain('package.json')
    }
  })

  it('inserts the composer host plugin under its documented row id', async () => {
    const patch = parse(await readFile(join(packageDir, 'cordis.patch.yml'), 'utf8')) as { insert: PatchRow[] }[]
    const rows = patch.flatMap((entry) => entry.insert)
    const composer = rows.find((row) => row.id === 'ai-novelist')
    expect(composer?.name).toBe('@ai-novelist/novelist-skill')
  })
})

describe('module surface', () => {
  it('exports the identifiers the patch and docs refer to', async () => {
    const module = (await import('../index.js')) as {
      bundleName: string
      pluginPackage: string
      pluginRowId: string
    }
    expect(module.bundleName).toBe('@ai-novelist/novelist-bundle')
    expect(module.pluginPackage).toBe('@ai-novelist/novelist-skill')
    expect(module.pluginRowId).toBe('ai-novelist')
  })
})
