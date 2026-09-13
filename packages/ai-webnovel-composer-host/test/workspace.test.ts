import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { emptyNovel, upsertChapter } from '../src/core/novel.ts'
import { classifyWorkspace, countDraftFiles, describeVerdict, looksLikeChapterFile } from '../src/core/workspace.ts'
import { NOVEL_RELATIVE_PATH, NovelStore } from '../src/host/store.ts'

/** Build a directory listing entry without touching disk. */
const entry = (name: string, type: 'file' | 'directory' = 'file') =>
  ({ name, type, target: { targetKey: name, displayPath: name } }) as never

describe('looksLikeChapterFile', () => {
  it('recognizes chapter naming in both scripts', () => {
    expect(looksLikeChapterFile('chapter-01.md')).toBe(true)
    expect(looksLikeChapterFile('Chapter 3.txt')).toBe(true)
    expect(looksLikeChapterFile('第3章.md')).toBe(true)
    expect(looksLikeChapterFile('003-青云宗.md')).toBe(true)
  })

  it('ignores non-manuscript files', () => {
    expect(looksLikeChapterFile('README.md')).toBe(false)
    expect(looksLikeChapterFile('notes.md')).toBe(false)
    expect(looksLikeChapterFile('chapter-1.docx')).toBe(false)
  })
})

describe('countDraftFiles', () => {
  it('counts only regular files, not directories that look like chapters', () => {
    expect(
      countDraftFiles([entry('001-a.md'), entry('002-b.md'), entry('003-c.md', 'directory'), entry('README.md')]),
    ).toBe(2)
  })
})

describe('classifyWorkspace', () => {
  it('treats an existing project document as authoritative', () => {
    const verdict = classifyWorkspace([entry('README.md'), entry('.novel', 'directory')], true, true)
    expect(verdict.kind).toBe('novel')
    expect(verdict.reason).toBe('project-document')
  })

  it('treats a bare .novel directory as a novel workspace', () => {
    const verdict = classifyWorkspace([entry('.novel', 'directory')], false, true)
    expect(verdict.kind).toBe('novel')
    expect(verdict.reason).toBe('novel-directory')
  })

  it('refuses to adopt a software project', () => {
    const verdict = classifyWorkspace([entry('package.json'), entry('.git', 'directory'), entry('README.md')], false, false)
    expect(verdict.kind).toBe('plain')
    expect(verdict.reason).toBe('unrelated-project')
  })

  it('treats an empty directory as the novel being started here', () => {
    const verdict = classifyWorkspace([], false, false)
    expect(verdict.kind).toBe('fresh')
    expect(verdict.reason).toBe('empty-directory')
  })

  it('adopts a directory that is already a draft', () => {
    const entries = [entry('001-one.md'), entry('002-two.md'), entry('003-three.md')]
    const verdict = classifyWorkspace(entries, false, false)
    expect(verdict.kind).toBe('novel')
    expect(verdict.reason).toBe('draft-files')
  })

  it('only invites when the signals are soft', () => {
    const verdict = classifyWorkspace([entry('outline.md'), entry('chapter-1.md')], false, false)
    expect(verdict.kind).toBe('fresh')
    expect(verdict.reason).toBe('soft-signals')
  })

  it('stays plain when nothing suggests a novel', () => {
    const verdict = classifyWorkspace([entry('notes.txt'), entry('photos', 'directory')], false, false)
    expect(verdict.kind).toBe('plain')
    expect(verdict.reason).toBe('no-novel-signals')
  })

  it('does not let a repo with a few markdown files look like a draft', () => {
    const verdict = classifyWorkspace(
      [entry('package.json'), entry('001.md'), entry('002.md'), entry('003.md')],
      false,
      false,
    )
    expect(verdict.kind).toBe('plain')
  })
})

describe('describeVerdict', () => {
  it('says what the workspace is, in every case', () => {
    for (const entries of [[], [entry('package.json')], [entry('outline.md')]] as const) {
      const text = describeVerdict(classifyWorkspace(entries, false, false))
      expect(text.length).toBeGreaterThan(20)
    }
  })
})

/**
 * Adoption is the "open an existing novel workspace and it just works" path, so
 * it is specified against the real filesystem backend.
 */
describe('NovelStore.probeWorkspace and adopt', () => {
  let root: string
  let ctx: Context
  let store: NovelStore
  const clock = '2024-07-01T00:00:00.000Z'

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ai-webnovel-ws-'))
    ctx = new Context()
    ctx.plugin(LocalFileSystem, { cwd: root, diffBasisMaxBytes: 64 * 1024 })
    store = new NovelStore(ctx, { workspaceRoot: root, clock: () => clock })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('classifies a fresh directory and adopts it', async () => {
    await expect(store.probeWorkspace()).resolves.toMatchObject({ kind: 'fresh', reason: 'empty-directory' })
    await expect(store.adopt(emptyNovel({ title: '青云记', premise: '少年上山' }, () => clock))).resolves.toBe('created')
    const onDisk = JSON.parse(await readFile(join(root, NOVEL_RELATIVE_PATH), 'utf8')) as { meta: { title: string } }
    expect(onDisk.meta.title).toBe('青云记')
  })

  it('is idempotent: a second adopt never resets an existing project', async () => {
    await store.adopt(emptyNovel({ title: 'First', premise: 'P1' }, () => clock))
    await expect(store.adopt(emptyNovel({ title: 'Second', premise: 'P2' }, () => clock))).resolves.toBe('existing')
    const state = await store.read()
    expect(state?.meta.title).toBe('First')
  })

  it('reports the novel it finds and does not touch it', async () => {
    await mkdir(join(root, '.novel'), { recursive: true })
    const seeded = upsertChapter(
      emptyNovel({ title: 'Existing', premise: 'already here' }, () => clock),
      { id: 'one', body: '青云宗' },
      () => clock,
    )
    await writeFile(join(root, NOVEL_RELATIVE_PATH), `${JSON.stringify(seeded, null, 2)}\n`, 'utf8')

    await expect(store.probeWorkspace()).resolves.toMatchObject({ kind: 'novel', reason: 'project-document' })
    await expect(store.adopt(emptyNovel({ title: 'Ignored' }, () => clock))).resolves.toBe('existing')
    expect((await store.read())?.meta.title).toBe('Existing')
  })

  it('classifies a software project as plain and adopts nothing', async () => {
    await writeFile(join(root, 'package.json'), '{}\n', 'utf8')
    await expect(store.probeWorkspace()).resolves.toMatchObject({ kind: 'plain', reason: 'unrelated-project' })
  })

  it('treats an unreadable project document as a novel workspace, not as absent', async () => {
    await mkdir(join(root, '.novel'), { recursive: true })
    await writeFile(join(root, NOVEL_RELATIVE_PATH), 'not json at all\n', 'utf8')
    await expect(store.probeWorkspace()).resolves.toMatchObject({ kind: 'novel' })
    await expect(store.adopt(emptyNovel({ title: 'X' }, () => clock))).resolves.toBe('existing')
    await expect(store.read()).rejects.toThrow(/not valid JSON/)
  })

  it('recognizes an existing draft by its chapter files', async () => {
    await writeFile(join(root, '001-山门.md'), 'x', 'utf8')
    await writeFile(join(root, '002-试炼.md'), 'x', 'utf8')
    await writeFile(join(root, '003-出宗.md'), 'x', 'utf8')
    await expect(store.probeWorkspace()).resolves.toMatchObject({ kind: 'novel', reason: 'draft-files' })
  })
})
