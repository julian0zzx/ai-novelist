import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CRAFT_SHEETS, CRAFT_TOPICS, craftSheet, TOOL_SURFACE } from '../src/core/index.ts'

/**
 * The craft sheets are the "how it should read" half of the SOP. These specs
 * keep them from silently becoming empty stubs, and keep the generated module
 * in step with the Markdown a contributor actually edits.
 */
describe('writing-craft sheets', () => {
  it('ships the fourteen topics the tool advertises, in reading order', () => {
    expect([...CRAFT_TOPICS]).toEqual([
      'genres',
      'trends',
      'platforms',
      'overseas',
      'hooks',
      'payoffs',
      'rhythm',
      'naming',
      'voice',
      'continuity',
      'submission',
      'fanfic',
      'script',
      'teaching',
    ])
  })

  it('gives every sheet a title, a summary and real body text', () => {
    for (const sheet of CRAFT_SHEETS) {
      expect(sheet.title.length, sheet.topic).toBeGreaterThan(0)
      expect(sheet.summary.length, sheet.topic).toBeGreaterThan(20)
      expect(sheet.body.length, sheet.topic).toBeGreaterThan(1500)
      expect(sheet.body.startsWith('# '), sheet.topic).toBe(true)
    }
  })

  it('resolves a topic and refuses an unknown one', () => {
    expect(craftSheet('hooks')?.body).toContain('章末钩')
    expect(craftSheet('nope')).toBeUndefined()
  })

  it('names every topic in the novel_status description', () => {
    const summary = TOOL_SURFACE.novel_status.summary
    for (const topic of CRAFT_TOPICS) {
      expect(summary, topic).toContain(topic)
    }
  })

  it('is generated from exactly the Markdown files in docs/craft', async () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const source = resolve(here, '..', '..', '..', 'docs', 'craft')
    const files = (await readdir(source)).filter((name) => name.endsWith('.md') && name !== 'README.md')
    expect(files.map((name) => name.slice(0, -3)).sort()).toEqual([...CRAFT_TOPICS].sort())
    for (const topic of CRAFT_TOPICS) {
      const text = await readFile(join(source, `${topic}.md`), 'utf8')
      expect(craftSheet(topic)?.body.trimEnd()).toBe(text.trimEnd())
    }
  })
})
