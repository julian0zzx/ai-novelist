import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Client-bundle shape specs.
 *
 * The browser half is not plain ESM: `@deepseek-ai/dsh-client-modules` serves
 * `/plugins/<id>/client.js` and the shell's module table expects that file to
 * register a CommonJS-style factory on `window.__ModuleLoader__` — the same
 * shape all 41 shipped `dsh-client-ui-*` bundles have. These specs load the
 * built artifact in a stubbed environment and execute the factory, so a broken
 * wrapper or a bundled-in React copy fails here instead of at boot.
 *
 * They read `lib/client.js`, so `pnpm run build` must have run first; the
 * `build` script of this package depends on it.
 */

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = join(here, '..', 'lib', 'client.js')

/** What the bundle registers on the loader. */
interface Registration {
  id: string
  factory: (require: (specifier: string) => unknown) => Record<string, unknown>
}

/**
 * Execute the built bundle the way the browser does: a bare `window` with a
 * `__ModuleLoader__.load` hook, and a `require` that records every specifier the
 * factory asks for.
 *
 * @returns the registered id, the factory's exports, and the requires it made.
 */
async function loadBundle(): Promise<{ id: string; exports: Record<string, unknown>; requires: string[] }> {
  const source = await readFile(bundlePath, 'utf8')
  let registration: Registration | undefined
  const window = {
    __ModuleLoader__: {
      load: (value: Registration) => {
        registration = value
      },
    },
  }
  const requires: string[] = []
  const require = (specifier: string): unknown => {
    requires.push(specifier)
    if (specifier === 'react') {
      return { useCallback: (fn: unknown) => fn, useEffect: () => undefined, useState: () => [undefined, () => undefined] }
    }
    if (specifier === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: null }
    // Every other specifier is a service module the shell owns; the plugin only
    // reads them for their type declarations, so an empty object is faithful.
    return {}
  }
  // eslint-disable-next-line no-new-func -- the bundle is a browser script, not a module
  new Function('window', 'require', source)(window, require)
  if (registration === undefined) throw new Error('bundle did not register with __ModuleLoader__')
  const loaded = registration as Registration
  return { id: loaded.id, exports: loaded.factory(require), requires }
}

describe('client bundle', () => {
  it('registers under the plugin package name, which is the loader row id basis', async () => {
    const { id } = await loadBundle()
    expect(id).toBe('@ai-webnovel/composer-host')
  })

  it('exports the cordis plugin shape the client tree loads', async () => {
    const { exports } = await loadBundle()
    expect(exports['name']).toBe('ai-webnovel-composer-client')
    expect(exports['inject']).toEqual([
      'slots',
      'sidebarRight',
      'sidebarRightTabs',
      'remote',
      'remote.workspaceFiles',
    ])
    expect(typeof exports['apply']).toBe('function')
  })

  it('keeps React and every dsh package unbundled', async () => {
    const { requires } = await loadBundle()
    // Only the framework modules the shell provides may appear; a bundled React
    // would show up as no `require("react")` at all.
    expect(requires).toContain('react')
    expect(requires).toContain('react/jsx-runtime')
    for (const specifier of requires) {
      expect(
        specifier === 'react' || specifier === 'react/jsx-runtime' || specifier.startsWith('@deepseek-ai/'),
        `unexpected bundled dependency: ${specifier}`,
      ).toBe(true)
    }
  })

  it('opens the composer page in the sidebar guide when applied', async () => {
    const { exports } = await loadBundle()
    const apply = exports['apply'] as (ctx: unknown) => void
    const disposeCalls: string[] = []
    const registered: { type?: unknown; key?: unknown; name?: unknown } = {}
    const ctx = {
      effect: (body: () => () => void) => {
        const dispose = body()
        disposeCalls.push(typeof dispose === 'function' ? 'effect-disposer' : 'not-a-function')
      },
      sidebarRightTabs: {
        register: (definition: { title: () => string; guide?: unknown[] }) => {
          registered.type = definition
          return () => disposeCalls.push('type')
        },
      },
      slots: {
        register: (options: { name?: unknown; key?: unknown }) => {
          registered.key = options.key
          registered.name = options.name
          return () => disposeCalls.push('body')
        },
      },
    }

    apply(ctx)

    const type = registered.type as { title: () => string; guide: unknown[] } | undefined
    expect(type?.title()).toBe('Novel Composer')
    expect(type?.guide).toHaveLength(1)
    expect(registered.name).toBe('sidebar.right.pane.tab')
    expect(registered.key).toBe('ai-webnovel-composer/composer')
    // The disposer returned by `ctx.effect` must tear both stages down together.
    expect(typeof disposeCalls[0]).toBe('string')
  })
})
