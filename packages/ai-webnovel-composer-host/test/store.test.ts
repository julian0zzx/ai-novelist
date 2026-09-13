import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { NovelStoreError, emptyNovel, hashContent, upsertChapter } from '../src/core/index.ts'
import { NOVEL_RELATIVE_PATH, NovelConflictError, NovelStore, isRegularFile } from '../src/host/store.ts'

/**
 * Store integration specs against the real local filesystem backend.
 *
 * The store's whole value is atomicity and containment, which only exist in
 * contact with a real backend — so these specs mount `@deepseek-ai/dsh-fs-local`
 * into a root context and drive the service exactly as the plugin does.
 */
let root: string
let ctx: Context
let store: NovelStore
let clock: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ai-webnovel-'))
  clock = '2024-05-01T00:00:00.000Z'
  ctx = new Context()
  ctx.plugin(LocalFileSystem, { cwd: root, diffBasisMaxBytes: 64 * 1024 })
  store = new NovelStore(ctx, { workspaceRoot: root, clock: () => clock })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Absolute path of the project document inside the temp workspace. */
const docPath = () => join(root, NOVEL_RELATIVE_PATH)

describe('NovelStore', () => {
  it('reports no project before initialization', async () => {
    await expect(store.read()).resolves.toBeUndefined()
  })

  it('creates the document and reads the same state back', async () => {
    const state = emptyNovel({ title: '青云记', premise: '少年上山' }, () => clock)
    await store.create(state)
    const read = await store.read()
    // The content half round-trips through the files; the index gains the hashes
    // of the five files the create wrote, which is the only difference from the
    // in-memory state that was handed in.
    expect(read).toEqual({
      ...state,
      index: { ...state.index, files: read?.index?.files },
    })
    expect(Object.keys(read?.index?.files ?? {}).sort()).toEqual([
      '世界观设定.md',
      '人物设定.md',
      '全书大纲.md',
      '分卷大纲.md',
      '章节大纲.md',
    ])
    const onDisk = JSON.parse(await readFile(docPath(), 'utf8')) as { meta: { title: string } }
    expect(onDisk.meta.title).toBe('青云记')
  })

  it('writes the novel as Markdown files a human can read', async () => {
    const state = emptyNovel({ title: '青云记', premise: '少年上山' }, () => clock)
    await store.create(state)
    const outline = await readFile(join(root, '全书大纲.md'), 'utf8')
    expect(outline).toContain('# 全书大纲')
    expect(outline).toContain('## 一句话')
    expect(outline).toContain('## 三幕')
    expect(outline).toContain('## 最小可行大纲')
    // The metadata document no longer carries the content.
    const onDisk = JSON.parse(await readFile(docPath(), 'utf8')) as Record<string, unknown>
    expect(onDisk['chapters']).toBeUndefined()
    expect(onDisk['outline']).toBeUndefined()
    expect(onDisk['characters']).toBeUndefined()
  })

  it('refuses to create over an existing project', async () => {
    await store.create(emptyNovel({ title: 'A' }, () => clock))
    await expect(store.create(emptyNovel({ title: 'B' }, () => clock))).rejects.toThrow(NovelConflictError)
    await expect(store.read()).resolves.toMatchObject({ meta: { title: 'A' } })
  })

  it('applies a mutation and persists the clock stamp', async () => {
    await store.create(emptyNovel({ title: 'A' }, () => clock))
    clock = '2024-05-02T00:00:00.000Z'
    const next = await store.update((current) => upsertChapter(current, { id: 'one', body: '青云宗' }, () => clock))
    expect(next.chapters['one']?.wordCount).toBe(3)
    expect(next.updatedAt).toBe('2024-05-02T00:00:00.000Z')
    const reread = await store.read()
    expect(reread?.chapters['one']?.body).toBe('青云宗')
  })

  it('refuses a mutation when no project exists', async () => {
    await expect(store.update((current) => current)).rejects.toThrow(/no novel project/)
  })

  it('re-reads the current document, so an external edit is not lost', async () => {
    await store.create(emptyNovel({ title: 'A' }, () => clock))
    // A concurrent writer (the model's own edit tool, another session) lands
    // before this mutation starts: the store re-reads, so the edit survives.
    const seen = await store.read()
    const forged = { ...seen!, meta: { ...seen!.meta, premise: 'changed elsewhere' } }
    await writeFile(docPath(), `${JSON.stringify(forged, null, 2)}\n`, 'utf8')
    const next = await store.update((current) => upsertChapter(current, { id: 'one', body: 'x' }, () => clock))
    expect(next.meta.premise).toBe('changed elsewhere')
    expect(next.chapters['one']).toBeDefined()
  })

  it('refuses a write when the document changes during the mutation', async () => {
    await store.create(emptyNovel({ title: 'A' }, () => clock))
    // A writer landing between the store's read and its guarded write is exactly
    // what the version guard exists for; without it this write would clobber
    // whatever arrived first.
    await expect(
      store.update(async (current) => {
        await writeFile(docPath(), `${JSON.stringify({ ...current, meta: { ...current.meta, premise: 'race' } }, null, 2)}\n`, 'utf8')
        return upsertChapter(current, { id: 'one', body: 'x' }, () => clock)
      }),
    ).rejects.toThrow(NovelConflictError)
  })

  it('serializes concurrent mutations instead of losing one', async () => {
    await store.create(emptyNovel({ title: 'A' }, () => clock))
    await Promise.all([
      store.update((current) => upsertChapter(current, { id: 'a', number: 1, body: 'first' }, () => clock)),
      store.update((current) => upsertChapter(current, { id: 'b', number: 2, body: 'second' }, () => clock)),
    ])
    const state = await store.read()
    expect(Object.keys(state?.chapters ?? {}).sort()).toEqual(['a', 'b'])
  })

  it('treats an empty document as uninitialized', async () => {
    await store.create(emptyNovel({ title: 'A' }, () => clock))
    await writeFile(docPath(), '\n', 'utf8')
    await expect(store.read()).resolves.toBeUndefined()
  })

  it('writes derived output beside the project', async () => {
    await store.create(emptyNovel({ title: 'A' }, () => clock))
    const written = await store.writeDerived('.novel/manuscript.md', '# A\n')
    expect(await readFile(written, 'utf8')).toBe('# A\n')
  })

  it('refuses a derived path that would escape the workspace root', async () => {
    await store.create(emptyNovel({ title: 'A' }, () => clock))
    await expect(store.writeDerived('../../escape.md', 'x')).rejects.toThrow(/outside the workspace root/)
    await expect(store.writeDerived('/tmp/escape.md', 'x')).rejects.toThrow(/outside the workspace root/)
    await expect(store.writeDerived('a/../../escape.md', 'x')).rejects.toThrow(/outside the workspace root/)
  })

  it('accepts a nested derived path that stays inside the root', async () => {
    await store.create(emptyNovel({ title: 'A' }, () => clock))
    const written = await store.writeDerived('exports/notes/outline.md', 'ok')
    expect(await readFile(written, 'utf8')).toBe('ok')
  })

  it('keeps the document path inside the workspace root', () => {
    expect(store.documentPath).toBe(join(root, NOVEL_RELATIVE_PATH))
  })
})

describe('NovelStore content files', () => {
  /** A project with one written, contracted chapter, through the store's own path. */
  async function seeded(): Promise<void> {
    await store.create(
      emptyNovel({ title: '青云记', premise: '少年持断剑上山' }, () => clock),
    )
    await store.update((state) =>
      upsertChapter(
        state,
        {
          id: 'chapter-1',
          number: 1,
          title: '山门',
          plotTask: '林越抵达山门',
          conflict: '守门弟子拦路',
          emotionalPayoff: '被接纳的期待',
          infoGap: '为何执意上山',
          beats: ['tension'],
          hook: '山门后传来一声钟响。',
          volume: 1,
          targetWords: 3000,
          body: '山门很高，云雾不散。',
        },
        () => clock,
      ),
    )
  }

  it('assembles the project from the files, not from the metadata document', async () => {
    await seeded()
    const onDisk = JSON.parse(await readFile(docPath(), 'utf8')) as Record<string, unknown>
    expect(onDisk['chapters']).toBeUndefined()
    const chapter = await readFile(join(root, '章节/第001章-山门.md'), 'utf8')
    expect(chapter).toContain('山门很高，云雾不散。')
    const contract = await readFile(join(root, '章节/第001章-山门.细纲.md'), 'utf8')
    expect(contract).toContain('## 剧情任务')
    expect(contract).toContain('## 章末钩子')
    const state = await store.read()
    expect(state?.chapters['chapter-1']?.hook).toBe('山门后传来一声钟响。')
    // Nine ideographs, one of which is the full stop — countWords ignores it.
    expect(state?.chapters['chapter-1']?.wordCount).toBe(8)
  })

  it('adopts an edit made in the author\'s own editor, and says which file it claimed', async () => {
    await seeded()
    const contractPath = join(root, '章节/第001章-山门.细纲.md')
    const before = await readFile(contractPath, 'utf8')
    await writeFile(contractPath, before.replace('山门后传来一声钟响。', '钟声之后，后山传来父亲的剑鸣。'), 'utf8')

    const loaded = await store.readVersioned()
    expect(loaded?.state.chapters['chapter-1']?.hook).toBe('钟声之后，后山传来父亲的剑鸣。')
    // The index was refreshed to the edited bytes, so the next write knows the
    // file moved on rather than believing its stale hash.
    expect(loaded?.state.index?.chapters['chapter-1']?.outlineHash).not.toBe('')
    const refreshed = JSON.parse(await readFile(docPath(), 'utf8')) as {
      index: { chapters: Record<string, { outlineHash: string }> }
    }
    expect(refreshed.index.chapters['chapter-1']?.outlineHash).toBe(
      hashContent(await readFile(contractPath, 'utf8')),
    )
  })

  it('claims a chapter file dropped into the directory by hand', async () => {
    await seeded()
    await writeFile(
      join(root, '章节/第002章-石阶.md'),
      '---\nid: "chapter-2"\nnumber: 2\nstatus: "drafting"\n---\n\n# 第 2 章 石阶\n\n他跪了一夜。\n',
      'utf8',
    )
    const loaded = await store.readVersioned()
    expect(loaded?.state.chapters['chapter-2']?.body).toBe('他跪了一夜。')
    expect(loaded?.state.chapters['chapter-2']?.status).toBe('drafting')
    expect(loaded?.warnings.join(' ')).toMatch(/认领/)
  })

  it('reports an orphan file without a frontmatter id and leaves it alone', async () => {
    await seeded()
    const orphan = join(root, '章节/手写的一章.md')
    await writeFile(orphan, '# 手写的一章\n\n没有 frontmatter。\n', 'utf8')
    const loaded = await store.readVersioned()
    expect(loaded?.warnings.join(' ')).toMatch(/没有 frontmatter id/)
    // Reported, never deleted: the author may still be typing.
    expect(await readFile(orphan, 'utf8')).toContain('没有 frontmatter')
  })

  it('renames a chapter\'s files when its title changes, and leaves no orphan behind', async () => {
    await seeded()
    await store.update((state) => upsertChapter(state, { id: 'chapter-1', title: '山门之下' }, () => clock))

    const state = await store.read()
    expect(state?.chapters['chapter-1']?.title).toBe('山门之下')
    expect(await readFile(join(root, '章节/第001章-山门之下.md'), 'utf8')).toContain('山门很高')
    expect(await readFile(join(root, '章节/第001章-山门之下.细纲.md'), 'utf8')).toContain('## 章末钩子')
    await expect(readFile(join(root, '章节/第001章-山门.md'), 'utf8')).rejects.toThrow()
    await expect(readFile(join(root, '章节/第001章-山门.细纲.md'), 'utf8')).rejects.toThrow()

    // The index and the chapter plan follow the rename.
    expect(state?.index?.chapters['chapter-1']?.bodyFile).toBe('章节/第001章-山门之下.md')
    expect(await readFile(join(root, '章节大纲.md'), 'utf8')).toContain('山门之下')
  })

  it('moves a chapter\'s files when its number changes, and renumbers the plan', async () => {
    await seeded()
    await store.update((state) => upsertChapter(state, { id: 'chapter-1', number: 4 }, () => clock))

    const state = await store.read()
    expect(state?.chapters['chapter-1']?.number).toBe(4)
    expect(await readFile(join(root, '章节/第004章-山门.md'), 'utf8')).toContain('山门很高')
    await expect(readFile(join(root, '章节/第001章-山门.md'), 'utf8')).rejects.toThrow()
    const plan = await readFile(join(root, '章节大纲.md'), 'utf8')
    // The plan table is the plan layer's home for the number, so it must show the
    // new one and no longer the old.
    const row = /^\|\s*(\d+)\s*\|\s*山门\s*\|/mu.exec(plan)
    expect(row?.[1]).toBe('4')
  })

  it('reports a broken file by name and does not touch it', async () => {
    await seeded()
    const broken = join(root, '章节/第001章-山门.md')
    // A frontmatter block that is never closed: the one failure the plan says
    // must never be adopted, because there is no way to know what it meant.
    const corrupt = '---\nid: "chapter-1"\nnumber: 1\n\n# 第 1 章 山门\n\n正文还在。\n'
    await writeFile(broken, corrupt, 'utf8')

    await expect(store.read()).rejects.toThrow(/章节\/第001章-山门\.md/u)
    await expect(store.read()).rejects.toThrow(NovelStoreError)
    // Not overwritten, not deleted, not "repaired".
    expect(await readFile(broken, 'utf8')).toBe(corrupt)
    // And the write path refuses too, rather than clobbering the broken file.
    await expect(store.update((state) => upsertChapter(state, { id: 'chapter-1', body: '新正文' }, () => clock))).rejects.toThrow(
      /章节\/第001章-山门\.md/u,
    )
    expect(await readFile(broken, 'utf8')).toBe(corrupt)
  })

  it('reports two chapters claiming the same number', async () => {
    await seeded()
    await writeFile(
      join(root, '章节/第001章-冒名.md'),
      '---\nid: "chapter-9"\nnumber: 1\n---\n\n# 第 1 章 冒名\n\n另一章。\n',
      'utf8',
    )
    await expect(store.read()).rejects.toThrow(/chapter 1 is claimed twice/u)
  })

  it('reports a duplicate character id across the cast file', async () => {
    await seeded()
    await writeFile(
      join(root, '人物设定.md'),
      [
        '---',
        '---',
        '',
        '# 人物设定',
        '',
        '## 甲',
        '',
        '```yaml',
        'id: "lin-yue"',
        '```',
        '',
        '## 乙',
        '',
        '```yaml',
        'id: "lin-yue"',
        '```',
        '',
      ].join('\n'),
      'utf8',
    )
    await expect(store.read()).rejects.toThrow(/人物设定\.md.*duplicate character id/u)
  })

  it('leaves the metadata document untouched when a check finds nothing to change', async () => {
    await seeded()
    const before = await readFile(docPath(), 'utf8')
    // Two reads in a row: the index is already correct, so neither may write.
    await store.read()
    await store.read()
    expect(await readFile(docPath(), 'utf8')).toBe(before)
  })
})

describe('NovelStore migration', () => {
  /** A version-2 document with one written chapter and one cast member. */
  function legacyDocument(): string {
    const state = upsertChapter(
      {
        ...emptyNovel({ title: '青云记', premise: '少年持断剑上山' }, () => clock),
        characters: {
          'lin-yue': {
            id: 'lin-yue',
            name: '林越',
            role: 'protagonist',
            description: '十六岁，瘦。',
            goal: '上山',
            fear: '被逐',
            obsession: '断剑不离手',
            weakness: '受不得激',
            camp: 'protagonist-camp',
            growthArc: '外门→执剑',
            notes: '',
          },
        },
      },
      { id: 'chapter-1', number: 1, title: '山门', plotTask: '抵达山门', hook: '钟响', body: '山门很高。' },
      () => clock,
    )
    const { index: _dropped, ...withoutIndex } = state
    return `${JSON.stringify({ ...withoutIndex, schemaVersion: 2 }, null, 2)}\n`
  }

  beforeEach(async () => {
    await mkdir(join(root, '.novel'), { recursive: true })
    await writeFile(docPath(), legacyDocument(), 'utf8')
  })

  it('migrates a v2 document: backup first, then every content file, then v3 metadata', async () => {
    const original = await readFile(docPath(), 'utf8')
    const loaded = await store.readVersioned()

    // 1. The original bytes survive, untouched.
    expect(await readFile(join(root, '.novel/novel.v2.backup.json'), 'utf8')).toBe(original)
    // 2. The content is now files a human can edit.
    expect(await readFile(join(root, '全书大纲.md'), 'utf8')).toContain('# 全书大纲')
    expect(await readFile(join(root, '人物设定.md'), 'utf8')).toContain('## 林越')
    expect(await readFile(join(root, '章节/第001章-山门.md'), 'utf8')).toContain('山门很高。')
    expect(await readFile(join(root, '章节/第001章-山门.细纲.md'), 'utf8')).toContain('抵达山门')
    // 3. The document is v3 and carries only metadata plus the index.
    const migrated = JSON.parse(await readFile(docPath(), 'utf8')) as {
      schemaVersion: number
      chapters?: unknown
      index: { chapters: Record<string, { bodyFile: string }> }
    }
    expect(migrated.schemaVersion).toBe(3)
    expect(migrated.chapters).toBeUndefined()
    expect(migrated.index.chapters['chapter-1']?.bodyFile).toBe('章节/第001章-山门.md')
    // 4. The read reports the migration and returns the migrated project whole.
    expect(loaded?.migration).toMatch(/v2 → v3/u)
    expect(loaded?.state.characters['lin-yue']?.growthArc).toBe('外门→执剑')
    expect(loaded?.state.chapters['chapter-1']?.body).toBe('山门很高。')
    expect(loaded?.state.chapters['chapter-1']?.plotTask).toBe('抵达山门')
  })

  it('is idempotent: a second read after migration changes nothing', async () => {
    await store.read()
    const document = await readFile(docPath(), 'utf8')
    const backup = await readFile(join(root, '.novel/novel.v2.backup.json'), 'utf8')
    const plan = await readFile(join(root, '章节大纲.md'), 'utf8')

    const again = await store.readVersioned()
    expect(again?.migration).toBeUndefined()
    expect(await readFile(docPath(), 'utf8')).toBe(document)
    expect(await readFile(join(root, '.novel/novel.v2.backup.json'), 'utf8')).toBe(backup)
    expect(await readFile(join(root, '章节大纲.md'), 'utf8')).toBe(plan)
    expect(again?.state.chapters['chapter-1']?.body).toBe('山门很高。')
  })

  it('never overwrites a backup an earlier session already kept', async () => {
    await mkdir(join(root, '.novel'), { recursive: true })
    await writeFile(join(root, '.novel/novel.v2.backup.json'), 'the author\'s own copy\n', 'utf8')
    await store.read()
    expect(await readFile(join(root, '.novel/novel.v2.backup.json'), 'utf8')).toBe('the author\'s own copy\n')
  })
})

describe('isRegularFile', () => {
  it('is false for a missing target and true for a written one', async () => {
    const target = await ctx.fs.resolve(join(root, 'probe.txt'))
    await expect(isRegularFile(ctx.fs, target)).resolves.toBe(false)
    await ctx.fs.writeText(target, 'hi')
    await expect(isRegularFile(ctx.fs, target)).resolves.toBe(true)
  })

  it('is false for a directory', async () => {
    const target = await ctx.fs.resolve(root)
    await expect(isRegularFile(ctx.fs, target)).resolves.toBe(false)
  })
})
