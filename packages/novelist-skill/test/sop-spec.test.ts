import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { Config, apply } from '../src/index.ts'
import { PROJECT_STAGES, SOP_PHASES, SOP_VERSION, TOOL_ORDER, TOOL_SURFACE } from '../src/core/index.ts'

/**
 * The single-source spec.
 *
 * `core/sop.ts` exists so that one text describes the surface: the model-facing
 * tool description, the tables `scripts/pack.mjs` renders into `SKILL.md`,
 * `INSTALL.md` and `references/tools.md`, and the revision number the skill
 * announces. Before it, those were three hand-maintained copies, and they had
 * already parted ways — the shipped skill said "SOP 3.3" beside a 3.5 reference,
 * and `architecture.md` said "Eight tools" while nine were registered.
 *
 * These specs are the guard: they fail the moment the plugin and the description
 * of the plugin stop agreeing, which is the only thing that keeps a generated
 * document from becoming a stale one.
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
  root = await mkdtemp(join(tmpdir(), 'ai-novelist-sop-spec-'))
  registered = []
  ctx = new Context()
  ctx.plugin(LocalFileSystem, { cwd: root, diffBasisMaxBytes: 64 * 1024 })
  ctx.plugin(recorder)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('the spec covers the surface the plugin registers', () => {
  it('names exactly the tools the plugin can register', () => {
    apply(ctx, Config({ workspaceRoot: root }) as never)
    // `novel_review` is mounted through `ctx.inject(['llm'], …)`, so the recorder
    // sees it only where a model route exists — which is why it is added by name
    // here rather than asserted absent.
    const surface = [...registered.map((definition) => definition.name), 'novel_review'].sort()
    expect(surface).toEqual([...TOOL_ORDER].sort())
  })

  it('gives every registered tool the spec text as its description', () => {
    apply(ctx, Config({ workspaceRoot: root }) as never)
    for (const definition of registered) {
      const spec = TOOL_SURFACE[definition.name as keyof typeof TOOL_SURFACE]
      expect(spec, definition.name).toBeDefined()
      expect(definition.description, definition.name).toBe(spec.summary)
    }
  })

  it('keys every entry by its own name, in surface order', () => {
    for (const name of TOOL_ORDER) {
      expect(TOOL_SURFACE[name].name).toBe(name)
    }
    expect(Object.keys(TOOL_SURFACE)).toEqual([...TOOL_ORDER])
  })

  it('lists the operations each tool actually accepts', () => {
    apply(ctx, Config({ workspaceRoot: root }) as never)
    for (const definition of registered) {
      // `defineTool` normalizes the declared parameters into an object schema, so
      // the enum lives one level down from the name the author writes.
      const schema = definition.parameters as { properties?: Record<string, { enum?: unknown[] }> }
      const spec = TOOL_SURFACE[definition.name as keyof typeof TOOL_SURFACE]
      if (spec.selector === '') {
        // A tool with no mode parameter must claim no operations.
        expect(spec.operations, definition.name).toEqual([])
        continue
      }
      const declared = schema.properties?.[spec.selector]?.enum
      expect(declared, `${definition.name}.${spec.selector}`).toBeDefined()
      expect([...declared!].sort(), definition.name).toEqual([...spec.operations].sort())
    }
  })
})

describe('the phases are the derived stages', () => {
  it('covers every project stage exactly once, in SOP order', () => {
    expect(SOP_PHASES.map((phase) => phase.stage)).toEqual([...PROJECT_STAGES])
  })

  it('gives each phase its own reference file', () => {
    const references = SOP_PHASES.map((phase) => phase.reference)
    expect(new Set(references).size).toBe(references.length)
    for (const phase of SOP_PHASES) {
      expect(phase.reference).toMatch(/^references\/phase-\d+-[a-z-]+\.md$/u)
    }
  })

  it('names only tools the spec knows, and closes phases with a real operation', () => {
    for (const phase of SOP_PHASES) {
      for (const tool of phase.tools) {
        expect(TOOL_ORDER, phase.title).toContain(tool)
      }
      if (phase.closesWith !== '') {
        const closers = SOP_PHASES.flatMap((entry) => entry.tools)
          .flatMap((tool) => [...TOOL_SURFACE[tool as keyof typeof TOOL_SURFACE].operations])
        expect(closers, phase.title).toContain(phase.closesWith)
      }
    }
  })
})

describe('the prose SOP and the executable SOP agree', () => {
  it('announces the revision the spec implements', async () => {
    const file = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'sop.md')
    const title = (await readFile(file, 'utf8')).split('\n', 1)[0] ?? ''
    expect(title).toContain(`SOP ${SOP_VERSION}`)
  })
})
