import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STORAGE_LAYOUT,
  NovelContentError,
  chapterPaths,
  chapterStem,
  composeContent,
  decomposeContent,
  defaultOpeningChecks,
  emptyIndex,
  emptyNovel,
  numberFromFileName,
  parseCastFile,
  parseChapterPlanFile,
  sanitizeTitle,
  upsertChapter,
  type ChapterPlanRow,
} from '../src/core/index.ts'
import type { NovelState, StorageIndex } from '../src/core/types.ts'

/** Fixed clock so every rendered timestamp is exact. */
const STAMP = '2026-09-13T14:20:34.921Z'

/**
 * Content codec specs.
 *
 * The plan's §9 asks for the round trip to preserve **every** field including
 * the empty ones, pipes, multi-line prose, and Chinese punctuation. These specs
 * are that requirement, written so a dropped field fails loudly rather than
 * quietly disappearing from a user's novel.
 */

/**
 * A state with one of every content kind, deliberately full of the characters
 * that break naive formats: pipes, newlines, and full-width punctuation.
 *
 * @returns the fixture state.
 */
function fixture(): NovelState {
  let state = emptyNovel({ title: '青云记', premise: '少年上山' }, () => STAMP)
  state = {
    ...state,
    characters: {
      'lin-yue': {
        id: 'lin-yue',
        name: '林越',
        role: 'protagonist',
        description: '十六岁，瘦，左手虎口有旧疤。\n他问：「父亲的剑，为何断在|山门？」',
        goal: '上山问清父亲的死因',
        fear: '发现父亲确实背叛了师门',
        obsession: '断剑不离手',
        weakness: '受不得激',
        camp: 'protagonist-camp',
        growthArc: '第一幕：莽；第二幕：忍；第三幕：断',
        notes: '口癖：先问价，再动手',
      },
      'shoumen-dizi': {
        id: 'shoumen-dizi',
        name: '守门弟子',
        role: 'gatekeeper',
        description: '',
        goal: '',
        fear: '',
        obsession: '',
        weakness: '',
        camp: '',
        growthArc: '',
        notes: '',
      },
    },
    world: {
      'duanjian': {
        id: 'duanjian',
        name: '断剑',
        kind: 'item',
        detail: '剑身断去三寸，遇主人血脉则发烫。',
        cost: '每次认主折损持有者一年寿元',
        limits: '不能斩同门',
      },
      'wushi': {
        id: 'wushi',
        name: '无矢之规',
        kind: 'rule',
        detail: '',
        cost: '',
        limits: '',
      },
    },
    outline: {
      ...state.outline,
      logline: '一个断剑少年，为了父亲的死因上山，却在山门里发现了更深的背叛。',
      acts: ['第一幕：上山', '第二幕：立住脚｜站稳', '第三幕：断剑认主'],
      minimal: '少年上山——被刁难——试剑台认主——发现真相。\n一句话说完。',
      volumes: [
        {
          number: 1,
          title: '山门',
          goal: '林越拜入山门并立住脚',
          conflict: '守门弟子与长老的刁难',
          climax: '试剑台上断剑认主',
          endHook: '钟声之后，山门后山传来父亲的剑鸣',
          chapters: [1, 30],
        },
        {
          number: 2,
          title: '后山',
          goal: '',
          conflict: '',
          climax: '',
          endHook: '',
          chapters: [],
        },
      ],
      beats: [
        { chapter: 3, kind: 'shuang', note: '断剑第一次发烫' },
        { chapter: 1, kind: 'tension', note: '山门|石阶' },
      ],
      fullOutlineDone: true,
    },
  }
  state = upsertChapter(
    state,
    {
      id: 'chapter-1',
      number: 1,
      title: '山门',
      synopsis: '林越抵达山门',
      volume: 1,
      targetWords: 3000,
      status: 'drafting',
      body: '山门很高。\n\n他抬头，看见「青云」二字缺了一笔。\n\n——父亲当年，也是站在这级石阶上。',
      plotTask: '林越抵达山门，被守门弟子拦下。',
      conflict: '守门弟子与长老的刁难。',
      emotionalPayoff: '压抑后的第一次抬头。',
      infoGap: '父亲的死因被回避。',
      beats: ['tension', 'info'],
      hook: '钟声之后，后山传来父亲的剑鸣。',
      waived: { infoGap: '本章不设悬念，留到第 3 章' },
      delivered: ['plotTask', 'hook'],
    },
    () => STAMP,
  )
  state = upsertChapter(
    state,
    { id: 'chapter-2', number: 2, title: '石阶', synopsis: '一夜', volume: 1, targetWords: 0 },
    () => STAMP,
  )
  return state
}

/** Decompose a state and reassemble it, the way the store does. */
function roundTrip(state: NovelState): { readonly back: ReturnType<typeof composeContent>; readonly files: Record<string, string> } {
  const index = indexOf(state)
  const parts = decomposeContent(state, STAMP)
  const files: Record<string, string> = {
    [index.outlineFile]: parts.outline,
    [index.castFile]: parts.cast,
    [index.worldFile]: parts.world,
    [index.volumeFile]: parts.volumes,
    [index.chapterPlanFile]: parts.chapterPlan,
  }
  for (const [id, ref] of Object.entries(index.chapters)) {
    files[ref.bodyFile] = parts.chapters[id]?.body ?? ''
    files[ref.outlineFile] = parts.chapters[id]?.outline ?? ''
  }
  return { back: composeContent(files, index, defaultOpeningChecks()), files }
}

/** Build the index a state implies, the way the store does. */
function indexOf(state: NovelState): StorageIndex {
  const base = emptyIndex()
  const chapters: Record<string, StorageIndex['chapters'][string]> = {}
  for (const chapter of Object.values(state.chapters)) {
    const paths = chapterPaths(chapter.number, chapter.title)
    chapters[chapter.id] = {
      number: chapter.number,
      title: chapter.title,
      bodyFile: paths.bodyFile,
      outlineFile: paths.outlineFile,
      bodyHash: '',
      outlineHash: '',
    }
  }
  return { ...base, chapters }
}

describe('content codec round trip', () => {
  it('preserves the outline, cast, world, and volumes field for field', () => {
    const state = fixture()
    const { back } = roundTrip(state)
    expect(back.outline.logline).toBe(state.outline.logline)
    expect(back.outline.acts).toEqual(state.outline.acts)
    expect(back.outline.minimal).toBe(state.outline.minimal)
    expect(back.outline.fullOutlineDone).toBe(true)
    expect(back.outline.volumes).toEqual(state.outline.volumes)
    expect(back.outline.beats).toEqual([...state.outline.beats].sort((a, b) => a.chapter - b.chapter))
    expect(back.characters).toEqual(state.characters)
    expect(back.world).toEqual(state.world)
  })

  it('preserves a chapter field for field, including the empty ones', () => {
    const state = fixture()
    const { back } = roundTrip(state)
    const before = state.chapters['chapter-1']!
    const after = back.chapters['chapter-1']!
    expect(after).toEqual(before)
    // Spelled out, because "toEqual" alone would hide a field both sides dropped.
    expect(after.body).toContain('看见「青云」二字缺了一笔')
    expect(after.body.split('\n')).toHaveLength(5)
    expect(after.waived).toEqual({ infoGap: '本章不设悬念，留到第 3 章' })
    expect(after.delivered).toEqual(['plotTask', 'hook'])
    expect(after.beats).toEqual(['tension', 'info'])
    expect(after.targetWords).toBe(3000)
    expect(after.volume).toBe(1)
    expect(after.status).toBe('drafting')
  })

  it('preserves a chapter that is planned but has no prose yet', () => {
    const state = fixture()
    const { back } = roundTrip(state)
    const after = back.chapters['chapter-2']!
    expect(after.number).toBe(2)
    expect(after.title).toBe('石阶')
    expect(after.body).toBe('')
    expect(after.status).toBe('planned')
    expect(after.targetWords).toBe(0)
    expect(after.wordCount).toBe(0)
  })

  it('keeps a literal pipe in cast prose and in a table cell', () => {
    const state = fixture()
    const { back, files } = roundTrip(state)
    expect(files['人物设定.md']).toContain('山门？」')
    expect(back.characters['lin-yue']?.description).toContain('为何断在|山门')
    expect(back.outline.beats.find((beat) => beat.chapter === 1)?.note).toBe('山门|石阶')
    expect(back.chapters['chapter-1']?.synopsis).toBe('林越抵达山门')
  })

  it('is stable: writing what was read produces the same bytes', () => {
    const { back, files } = roundTrip(fixture())
    const index = indexOf(fixture())
    const again = decomposeContent({ ...fixture(), ...back, chapters: back.chapters }, STAMP)
    expect(again.outline).toBe(files[index.outlineFile])
    expect(again.cast).toBe(files[index.castFile])
    expect(again.world).toBe(files[index.worldFile])
    expect(again.volumes).toBe(files[index.volumeFile])
    expect(again.chapterPlan).toBe(files[index.chapterPlanFile])
  })

  it('recomputes wordCount from the prose rather than trusting the file', () => {
    const state = fixture()
    const index = indexOf(state)
    const parts = decomposeContent(state, STAMP)
    const withLie = parts.chapters['chapter-1']!.body.replace(/wordCount: \d+/u, 'wordCount: 99999')
    const back = composeContent(
      {
        [index.chapterPlanFile]: parts.chapterPlan,
        [index.chapters['chapter-1']!.bodyFile]: withLie,
        [index.chapters['chapter-1']!.outlineFile]: parts.chapters['chapter-1']!.outline,
      },
      index,
      defaultOpeningChecks(),
    )
    expect(back.chapters['chapter-1']?.wordCount).not.toBe(99999)
    expect(back.chapters['chapter-1']?.wordCount).toBe(state.chapters['chapter-1']?.wordCount)
  })

  it('treats a missing file as "nothing recorded" rather than an error', () => {
    const index = indexOf(fixture())
    const back = composeContent({}, index, defaultOpeningChecks())
    expect(back.outline.logline).toBe('')
    expect(back.characters).toEqual({})
    expect(back.world).toEqual({})
    expect(back.outline.volumes).toEqual([])
    expect(back.chapters).toEqual({})
    expect(back.outline.opening).toHaveLength(7)
  })

  it('treats a missing contract section as an empty field, as the plan requires', () => {
    const state = fixture()
    const index = indexOf(fixture())
    const parts = decomposeContent(state, STAMP)
    const stripped = parts.chapters['chapter-1']!.outline.replace(/## 章末钩子\n\n[\s\S]*$/u, '')
    const back = composeContent(
      {
        [index.chapterPlanFile]: parts.chapterPlan,
        [index.chapters['chapter-1']!.bodyFile]: parts.chapters['chapter-1']!.body,
        [index.chapters['chapter-1']!.outlineFile]: stripped,
      },
      index,
      defaultOpeningChecks(),
    )
    expect(back.chapters['chapter-1']?.hook).toBe('')
    // The other five sections are untouched.
    expect(back.chapters['chapter-1']?.plotTask).toBe('林越抵达山门，被守门弟子拦下。')
  })
})

describe('content codec file naming', () => {
  it('pads the chapter number to three digits', () => {
    expect(chapterStem(1, '山门')).toBe('第001章-山门')
    expect(chapterStem(42, '')).toBe('第042章')
    expect(chapterStem(1000, '终章')).toBe('第1000章-终章')
  })

  it('strips the characters a filesystem would object to', () => {
    expect(sanitizeTitle('山门/后山\\夜:第一*课?')).toBe('山门后山夜第一课')
    expect(sanitizeTitle('  ..山门..  ')).toBe('山门')
    expect(sanitizeTitle('a'.repeat(60))).toHaveLength(40)
    expect(sanitizeTitle('   ')).toBe('')
  })

  it('puts both chapter files in the chapter directory', () => {
    expect(chapterPaths(1, '山门')).toEqual({
      bodyFile: '章节/第001章-山门.md',
      outlineFile: '章节/第001章-山门.细纲.md',
    })
  })

  it('recovers a chapter number from a filename as a fallback', () => {
    expect(numberFromFileName('章节/第001章-山门.md')).toBe(1)
    expect(numberFromFileName('章节/第1000章.md')).toBe(1000)
    expect(numberFromFileName('章节/手写的一章.md')).toBeUndefined()
  })
})

describe('content codec errors', () => {
  it('reports a duplicate character id and names the file', () => {
    const raw = [
      '# 人物设定',
      '',
      '## 甲',
      '',
      '```yaml',
      'id: lin-yue',
      '```',
      '',
      '## 乙',
      '',
      '```yaml',
      'id: lin-yue',
      '```',
      '',
    ].join('\n')
    expect(() => parseCastFile(raw, '人物设定.md')).toThrow(NovelContentError)
    expect(() => parseCastFile(raw, '人物设定.md')).toThrow(/人物设定\.md.*duplicate character id "lin-yue"/u)
  })

  it('reports a duplicate chapter number and names both ids', () => {
    const raw = [
      '---',
      'updatedAt: "2026-09-13T14:20:34.921Z"',
      '---',
      '',
      '# 章节大纲',
      '',
      '## 章节表',
      '',
      '| 章 | 标题 | 卷 | 目标字数 | 一句话 |',
      '|---|---|---|---|---|',
      '| 1 | 山门 | 1 | 3000 | 甲 |',
      '| 1 | 后山 | 1 | 3000 | 乙 |',
      '',
    ].join('\n')
    expect(() => parseChapterPlanFile(raw, '章节大纲.md', [])).toThrow(/chapter 1 appears twice/u)
  })

  it('reports a volume without a number', () => {
    const raw = ['## 第一卷', '', '```yaml', 'title: 山门', '```', ''].join('\n')
    expect(() => composeContent({ '分卷大纲.md': raw }, emptyIndex(), [])).toThrow(/needs a positive integer/u)
  })

  it('reports an unknown beat kind rather than storing it', () => {
    const raw = ['## 情绪节拍表', '', '| 章 | 类型 | 一句话 |', '|---|---|---|', '| 3 | 乱写 | 甲 |', ''].join('\n')
    expect(() => parseChapterPlanFile(raw, '章节大纲.md', [])).toThrow(/unknown kind "乱写"/u)
  })

  it('reports two chapters claiming the same number across files', () => {
    const index: StorageIndex = {
      ...emptyIndex(),
      chapters: {
        'chapter-1': {
          number: 1,
          title: '山门',
          bodyFile: '章节/第001章-山门.md',
          outlineFile: '章节/第001章-山门.细纲.md',
          bodyHash: '',
          outlineHash: '',
        },
        'chapter-9': {
          number: 1,
          title: '另一章',
          bodyFile: '章节/第001章-另一章.md',
          outlineFile: '章节/第001章-另一章.细纲.md',
          bodyHash: '',
          outlineHash: '',
        },
      },
    }
    const files = {
      '章节/第001章-山门.细纲.md': '---\nid: "chapter-1"\nnumber: 1\n---\n\n## 剧情任务\n\n甲\n',
      '章节/第001章-另一章.细纲.md': '---\nid: "chapter-9"\nnumber: 1\n---\n\n## 剧情任务\n\n乙\n',
    }
    expect(() => composeContent(files, index, [])).toThrow(/chapter 1 is claimed twice/u)
  })
})

describe('chapter plan table ownership', () => {
  it('takes the title from the table, not the contract file', () => {
    const plan = [
      '## 章节表',
      '',
      '| 章 | 标题 | 卷 | 目标字数 | 一句话 |',
      '|---|---|---|---|---|',
      '| 1 | 表里的标题 | 2 | 2500 | 表里的一句话 |',
      '',
    ].join('\n')
    const index: StorageIndex = {
      ...emptyIndex(),
      chapters: {
        'chapter-1': {
          number: 1,
          title: '索引里的旧标题',
          bodyFile: '章节/第001章-表里的标题.md',
          outlineFile: '章节/第001章-表里的标题.细纲.md',
          bodyHash: '',
          outlineHash: '',
        },
      },
    }
    const back = composeContent(
      {
        [DEFAULT_STORAGE_LAYOUT.chapterPlanFile]: plan,
        '章节/第001章-表里的标题.md': '---\nid: "chapter-1"\nnumber: 1\nstatus: drafting\n---\n\n# 第 1 章 表里的标题\n\n正文。\n',
      },
      index,
      [],
    )
    const chapter = back.chapters['chapter-1']!
    expect(chapter.title).toBe('表里的标题')
    expect(chapter.volume).toBe(2)
    expect(chapter.targetWords).toBe(2500)
    expect(chapter.synopsis).toBe('表里的一句话')
    expect(chapter.body).toBe('正文。')
  })

  it('falls back to the index title when the plan row was deleted by hand', () => {
    const index: StorageIndex = {
      ...emptyIndex(),
      chapters: {
        'chapter-1': {
          number: 1,
          title: '索引里的标题',
          bodyFile: '章节/第001章-索引里的标题.md',
          outlineFile: '章节/第001章-索引里的标题.细纲.md',
          bodyHash: '',
          outlineHash: '',
        },
      },
    }
    const back = composeContent(
      { '章节/第001章-索引里的标题.md': '---\nid: "chapter-1"\nnumber: 1\n---\n\n# 第 1 章 索引里的标题\n\n正文。\n' },
      index,
      [],
    )
    expect(back.chapters['chapter-1']?.title).toBe('索引里的标题')
  })

  it('renders the plan rows the state implies', () => {
    const state = fixture()
    const parts = decomposeContent(state, STAMP)
    const rows: readonly ChapterPlanRow[] = parseChapterPlanFile(parts.chapterPlan, '章节大纲.md', []).rows
    expect(rows).toEqual([
      { number: 1, title: '山门', volume: 1, targetWords: 3000, oneLine: '林越抵达山门', synopsis: '林越抵达山门' },
      { number: 2, title: '石阶', volume: 1, targetWords: 0, oneLine: '一夜', synopsis: '一夜' },
    ])
  })

  it('keeps the opening checklist, whose done flags gate phase two', () => {
    const state = { ...fixture(), outline: { ...fixture().outline, opening: defaultOpeningChecks() } }
    const parts = decomposeContent(state, STAMP)
    const back = composeContent(
      { [DEFAULT_STORAGE_LAYOUT.chapterPlanFile]: parts.chapterPlan },
      indexOf(state),
      defaultOpeningChecks(),
    )
    expect(back.outline.opening).toHaveLength(7)
    expect(back.outline.opening.every((check) => !check.done)).toBe(true)
    expect(back.outline.opening[0]?.key).toBe('chapter-1-conflict-300')
    expect(back.outline.opening[0]?.requirement).toBe('第 1 章前 300 字出现冲突')
  })

  it('round-trips a confirmed checklist item without losing its key or note', () => {
    const opening = defaultOpeningChecks().map((check) =>
      check.key === 'chapter-1-hook' ? { ...check, done: true, note: '开篇已写' } : check,
    )
    const state = { ...fixture(), outline: { ...fixture().outline, opening } }
    const parts = decomposeContent(state, STAMP)
    const back = composeContent(
      { [DEFAULT_STORAGE_LAYOUT.chapterPlanFile]: parts.chapterPlan },
      indexOf(state),
      defaultOpeningChecks(),
    )
    const hook = back.outline.opening.find((check) => check.key === 'chapter-1-hook')
    expect(hook?.done).toBe(true)
    expect(hook?.note).toBe('开篇已写')
    // `setOpeningCheck` addresses items by key, so a suffixed key would break it.
    expect(back.outline.opening.map((check) => check.key)).toEqual(defaultOpeningChecks().map((check) => check.key))
  })
})
