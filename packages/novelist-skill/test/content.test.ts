import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STORAGE_LAYOUT,
  NovelContentError,
  VOLUME_SPINE_PARTS,
  chapterPaths,
  chapterPlanPath,
  chapterStem,
  composeContent,
  decomposeContent,
  defaultOpeningChecks,
  emptyIndex,
  emptyNovel,
  isVolumePath,
  numberFromFileName,
  parseCastFile,
  parseChapterPlanCollectionFile,
  parseChapterPlanFile,
  parseChapterPlanVolumeFile,
  parseVolumeCollectionFile,
  parseVolumeFile,
  planVolumesOf,
  renderVolumeFile,
  sanitizeTitle,
  upsertChapter,
  volumeFileName,
  volumeNumberFromFileName,
  volumePath,
  type ChapterPlanRow,
} from '../src/core/index.ts'
import type { NovelState, StorageIndex } from '../src/core/types.ts'
import { STYLE_BLOCK } from './style-fixture.ts'

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
        scope: '',
        volume: 0,
        firstAppearance: '',
        exit: '',
        description: '十六岁，瘦，左手虎口有旧疤。\n他问：「父亲的剑，为何断在|山门？」',
        personality: '外冷内倔，受不得激；压力越大越沉默，沉默过后下狠手',
        voice: '短句，先问价再动手；急了才连说两句',
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
        scope: '',
        volume: 0,
        firstAppearance: '',
        exit: '',
        description: '',
        personality: '',
        voice: '',
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
      // The 写作风格 block is part of this file since SOP 3.6: seven named elements
      // under `## 写作风格`, round-tripped like the narrative spine beside it.
      style: STYLE_BLOCK,
      logline: '一个断剑少年，为了父亲的死因上山，却在山门里发现了更深的背叛。',
      acts: ['第一幕：上山', '第二幕：立住脚｜站稳', '第三幕：断剑认主'],
      minimal: '少年上山——被刁难——试剑台认主——发现真相。\n一句话说完。',
      volumes: [
        {
          number: 1,
          title: '山门',
          detail: '卷一从前山石阶写到试剑台：林越先被守门弟子刁难，再被长老试出剑骨，卷末在试剑台上认主。',
          goal: '林越拜入山门并立住脚',
          conflict: '守门弟子与长老的刁难',
          climax: '试剑台上断剑认主',
          endHook: '钟声之后，山门后山传来父亲的剑鸣',
          synopsis: '林越背着断剑上山，被守门弟子拦下，靠剑骨进了门，卷末在试剑台上让断剑认了主。',
          protagonistArc: '从「只想问清父亲死因」变成「愿意在山门里站住脚」',
          antagonistArc: '守门弟子从刁难变成服气；长老露出第一次试探的底色',
          factionShift: '山门内部派系第一次显形：后山一脉开始盯上他',
          mainConflict: '试剑台上一场以断剑认主收场的比试',
          costs: '他失去了「悄悄查父亲死因」的可能',
          gains: '剑骨被承认、一个肯替他说话的同门',
          chapters: [1, 30],
        },
        {
          number: 2,
          title: '后山',
          detail: '',
          goal: '',
          conflict: '',
          climax: '',
          endHook: '',
          synopsis: '',
          protagonistArc: '',
          antagonistArc: '',
          factionShift: '',
          mainConflict: '',
          costs: '',
          gains: '',
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
    [index.chapterPlanFile]: parts.chapterPlan.wholeBook,
  }
  for (const [key, text] of Object.entries(parts.volumes)) {
    files[index.volumes[key]?.file ?? volumePath(Number.parseInt(key, 10))] = text
  }
  for (const [key, text] of Object.entries(parts.chapterPlan.volumes)) {
    files[parts.chapterPlan.paths[key] ?? chapterPlanPath(Number.parseInt(key, 10))] = text
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
  const volumes: Record<string, StorageIndex['volumes'][string]> = {}
  for (const volume of state.outline.volumes) {
    volumes[String(volume.number)] = { number: volume.number, file: volumePath(volume.number), hash: '' }
  }
  const chapterPlans: Record<string, StorageIndex['chapterPlans'][string]> = {}
  for (const volume of planVolumesOf(state.chapters, state.outline.beats)) {
    chapterPlans[String(volume)] = { volume, file: chapterPlanPath(volume), hash: '' }
  }
  return { ...base, chapters, volumes, chapterPlans }
}

describe('content codec round trip', () => {
  it('preserves the outline, cast, world, and volumes field for field', () => {
    const state = fixture()
    const { back } = roundTrip(state)
    expect(back.outline.style).toEqual(state.outline.style)
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

  it('round-trips a 路人 register entry, tiers included', () => {
    const state = fixture()
    const withCameo: NovelState = {
      ...state,
      characters: {
        ...state.characters,
        'shouye-laobing': {
          id: 'shouye-laobing',
          name: '守夜的老兵',
          role: '',
          scope: 'cameo',
          volume: 2,
          firstAppearance: '第37章',
          exit: '第52章 被灭口',
          description: '左腿有点瘸，认得后山的每条路。',
          personality: '',
          voice: '',
          goal: '',
          fear: '',
          obsession: '',
          weakness: '',
          camp: '',
          growthArc: '',
          notes: '',
        },
      },
    }
    const index = indexOf(withCameo)
    const parts = decomposeContent(withCameo, STAMP)
    const back = composeContent({ [index.castFile]: parts.cast }, index, defaultOpeningChecks())
    expect(back.characters['shouye-laobing']).toEqual(withCameo.characters['shouye-laobing'])
    // The cameo's own section carries the register keys and none of the spine.
    const section = parts.cast.slice(parts.cast.indexOf('## 守夜的老兵'))
    expect(section).toContain('scope: "cameo"')
    expect(section).toContain('firstAppearance: "第37章"')
    expect(section).toContain('exit: "第52章 被灭口"')
    expect(section).not.toContain('personality:')
    expect(section).not.toContain('goal:')
  })

  it('orders the cast file by tier, so the protagonist is not buried among walk-ons', () => {
    const state = fixture()
    const parts = decomposeContent(
      {
        ...state,
        characters: {
          ...state.characters,
          'a-cameo': {
            ...Object.values(state.characters)[0]!,
            id: 'a-cameo',
            name: '阿三',
            scope: 'cameo',
            description: '茶楼跑堂。',
            firstAppearance: '第2章',
          },
        },
      },
      STAMP,
    )
    // 林越 (main) sorts before the id `a-cameo`, which would win a plain id sort.
    expect(parts.cast.indexOf('## 林越')).toBeLessThan(parts.cast.indexOf('## 阿三'))
    // …and the render is stable, so tier ordering does not churn the file.
    const again = decomposeContent(fixture(), STAMP)
    expect(again.cast).toBe(decomposeContent(fixture(), STAMP).cast)
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
    expect(again.volumes).toEqual({
      '1': files[volumePath(1)],
      '2': files[volumePath(2)],
    })
    expect(again.chapterPlan.wholeBook).toBe(files[index.chapterPlanFile])
    // Volume 1 holds both chapters; 未分卷 holds the beat placed on chapter 3,
    // which no chapter row claims yet.
    expect(again.chapterPlan.volumes).toEqual({
      '0': files[chapterPlanPath(0)],
      '1': files[chapterPlanPath(1)],
    })
  })

  it('recomputes wordCount from the prose rather than trusting the file', () => {
    const state = fixture()
    const index = indexOf(state)
    const parts = decomposeContent(state, STAMP)
    const withLie = parts.chapters['chapter-1']!.body.replace(/wordCount: \d+/u, 'wordCount: 99999')
    const back = composeContent(
      {
        [index.chapterPlanFile]: parts.chapterPlan.wholeBook,
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
        [index.chapterPlanFile]: parts.chapterPlan.wholeBook,
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

  it('puts one volume per file in the volume directory, named by number alone', () => {
    expect(volumePath(1)).toBe('分卷大纲/第1卷.md')
    expect(volumePath(12)).toBe('分卷大纲/第12卷.md')
    // The number is the whole name, so a retitled volume never moves its file.
    expect(volumeFileName(3)).toBe('第3卷.md')
    expect(volumeNumberFromFileName('分卷大纲/第12卷.md')).toBe(12)
    expect(volumeNumberFromFileName('分卷大纲/卷一.md')).toBeUndefined()
    expect(isVolumePath('分卷大纲/第1卷.md')).toBe(true)
    expect(isVolumePath('分卷大纲/第1卷/续.md')).toBe(false)
  })
})

describe('volume outline files', () => {
  /** A volume with every field written, so the round trip has something to lose. */
  function written(): ReturnType<typeof parseVolumeFile> {
    return parseVolumeFile(
      renderVolumeFile({
        number: 1,
        title: '山门',
        detail: '卷一从前山石阶写到试剑台。',
        goal: '林越拜入山门并立住脚',
        conflict: '守门弟子与长老的刁难',
        climax: '试剑台上断剑认主',
        endHook: '钟声之后，后山传来父亲的剑鸣',
        synopsis: '林越背着断剑上山，卷末在试剑台上让断剑认了主。',
        protagonistArc: '从「只想问清父亲死因」变成「愿意在山门里站住脚」',
        antagonistArc: '长老露出第一次试探的底色',
        factionShift: '后山一脉开始盯上他',
        mainConflict: '试剑台上一场以断剑认主收场的比试',
        costs: '他失去了「悄悄查父亲死因」的可能',
        gains: '剑骨被承认',
        chapters: [1, 30],
      }),
      '分卷大纲/第1卷.md',
    )
  }

  it('round-trips every field of one volume', () => {
    const volume = written()
    expect(volume.number).toBe(1)
    expect(volume.title).toBe('山门')
    expect(volume.goal).toBe('林越拜入山门并立住脚')
    expect(volume.detail).toBe('卷一从前山石阶写到试剑台。')
    expect(volume.synopsis).toContain('让断剑认了主')
    expect(volume.mainConflict).toContain('试剑台')
    expect(volume.costs).toContain('悄悄查父亲死因')
    expect(volume.chapters).toEqual([1, 30])
  })

  it('names the pacing detail, and gives each element a `##` of its own', () => {
    const text = renderVolumeFile(written())
    expect(text).toContain('# 第 1 卷 山门')
    expect(text).toContain('number: 1')
    expect(text).toContain('## 卷内节奏')
    expect(text).toContain('## 本卷梗概')
    // Seven elements plus the pacing detail, and no nested collection entry.
    expect(text.match(/^## /gmu)).toHaveLength(1 + VOLUME_SPINE_PARTS.length)
  })

  it('keeps prose above the first heading, and an invented section, in detail', () => {
    const raw = [
      '---',
      'number: 4',
      'title: 手写',
      '---',
      '',
      '# 第 4 卷 手写',
      '',
      '标题下面直接写的节奏安排。',
      '',
      '## 卷内节奏',
      '',
      '命名的节奏段落。',
      '',
      '## 阶段推进',
      '',
      '作者自己加的小节。',
      '',
      '## 本卷梗概',
      '',
      '第四卷的故事。',
      '',
      '',
    ].join('\n')
    const volume = parseVolumeFile(raw, '分卷大纲/第4卷.md')
    expect(volume.number).toBe(4)
    expect(volume.detail).toContain('标题下面直接写的节奏安排。')
    expect(volume.detail).toContain('命名的节奏段落。')
    expect(volume.detail).toContain('## 阶段推进')
    expect(volume.detail).toContain('作者自己加的小节。')
    expect(volume.synopsis).toBe('第四卷的故事。')
    // Re-rendering cannot nest one `## 卷内节奏` inside another.
    const again = parseVolumeFile(renderVolumeFile(volume), '分卷大纲/第4卷.md')
    expect(again.detail).toBe(volume.detail)
    expect((renderVolumeFile(again).match(/## 卷内节奏/gu) ?? [])).toHaveLength(1)
  })

  it('takes the number from the filename when the frontmatter leaves it out', () => {
    const volume = parseVolumeFile(
      ['---', 'title: 手写的第三卷', '---', '', '# 第 3 卷 手写的第三卷', '', '## 卷内节奏', '', '手写的节奏。', ''].join('\n'),
      '分卷大纲/第3卷.md',
    )
    expect(volume.number).toBe(3)
    expect(volume.title).toBe('手写的第三卷')
    expect(volume.detail).toBe('手写的节奏。')
  })

  it('reads the pre-version-4 collection file for the migration', () => {
    const raw = [
      '# 分卷大纲',
      '',
      '## 第 1 卷 山门',
      '',
      '```yaml',
      'number: 1',
      'title: 山门',
      'chapters: [1, 30]',
      '```',
      '',
      '卷一从前山石阶写到试剑台。',
      '',
      '### 本卷梗概',
      '',
      '林越背着断剑上山。',
      '',
      '## 第 2 卷 后山',
      '',
      '```yaml',
      'number: 2',
      'title: 后山',
      '```',
      '',
      '后山的雾。',
      '',
      '',
    ].join('\n')
    const volumes = parseVolumeCollectionFile(raw, '分卷大纲.md')
    expect(volumes.map((volume) => volume.number)).toEqual([1, 2])
    expect(volumes[0]?.detail).toBe('卷一从前山石阶写到试剑台。')
    expect(volumes[0]?.synopsis).toBe('林越背着断剑上山。')
    expect(volumes[0]?.chapters).toEqual([1, 30])
    expect(volumes[1]?.detail).toBe('后山的雾。')
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
    expect(() => parseChapterPlanVolumeFile(raw, '章节大纲/第1卷.md')).toThrow(/chapter 1 appears twice/u)
  })

  it('reports a volume with no number in its frontmatter and none in its filename', () => {
    const raw = ['---', 'title: 山门', '---', '', '# 第 1 卷 山门', '', '## 卷内节奏', '', '从前山写到试剑台。', ''].join('\n')
    const index: StorageIndex = {
      ...emptyIndex(),
      volumes: { '1': { number: 1, file: '分卷大纲/手写的一卷.md', hash: '' } },
    }
    expect(() => composeContent({ '分卷大纲/手写的一卷.md': raw }, index, [])).toThrow(/needs a positive integer/u)
  })

  it('reports an unknown beat kind rather than storing it', () => {
    const raw = ['## 情绪节拍表', '', '| 章 | 类型 | 一句话 |', '|---|---|---|', '| 3 | 乱写 | 甲 |', ''].join('\n')
    expect(() => parseChapterPlanVolumeFile(raw, '章节大纲/第1卷.md')).toThrow(/unknown kind "乱写"/u)
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
      chapterPlans: { '2': { volume: 2, file: '章节大纲/第2卷.md', hash: '' } },
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
        '章节大纲/第2卷.md': plan,
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

  it('refuses one chapter planned in two volumes\' files, naming both', () => {
    const index: StorageIndex = {
      ...emptyIndex(),
      chapterPlans: {
        '1': { volume: 1, file: '章节大纲/第1卷.md', hash: '' },
        '2': { volume: 2, file: '章节大纲/第2卷.md', hash: '' },
      },
    }
    const row = (volume: number): string =>
      ['## 章节表', '', '| 章 | 标题 | 卷 | 目标字数 | 一句话 |', '|---|---|---|---|---|', `| 1 | 山门 | ${String(volume)} | | |`, ''].join('\n')
    expect(() =>
      composeContent(
        { '章节大纲/第1卷.md': row(1), '章节大纲/第2卷.md': row(2) },
        index,
        [],
      ),
    ).toThrow(/chapter 1 is planned twice: 章节大纲\/第1卷\.md and 章节大纲\/第2卷\.md/u)
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

  it('renders each volume its own plan file, with the rows that belong to it', () => {
    const state = fixture()
    const parts = decomposeContent(state, STAMP)
    // Both fixture chapters are in volume 1; 未分卷 exists because the fixture
    // also places a beat on chapter 3, which no chapter row claims yet.
    expect(Object.keys(parts.chapterPlan.volumes)).toEqual(['0', '1'])
    expect(parts.chapterPlan.paths['1']).toBe('章节大纲/第1卷.md')
    const rows: readonly ChapterPlanRow[] = parseChapterPlanVolumeFile(
      parts.chapterPlan.volumes['1'] ?? '',
      '章节大纲/第1卷.md',
    ).rows
    expect(rows).toEqual([
      { number: 1, title: '山门', volume: 1, targetWords: 3000, oneLine: '林越抵达山门', synopsis: '林越抵达山门' },
      { number: 2, title: '石阶', volume: 1, targetWords: 0, oneLine: '一夜', synopsis: '一夜' },
    ])
    // …and the whole-book file carries the checklist plus the index of where it went.
    expect(parts.chapterPlan.wholeBook).toContain('## 分卷章节表')
    expect(parts.chapterPlan.wholeBook).toContain('第 1 卷：第 1–2 章（共 2 章）→ 章节大纲/第1卷.md')
    expect(parts.chapterPlan.wholeBook).not.toContain('| 章 |')
  })

  it('puts a chapter filed under no volume in 未分卷.md, and moves it when it is filed', () => {
    // Beats are pinned to their chapter's volume, so this one watches the rows.
    const bare = { ...fixture(), outline: { ...fixture().outline, beats: [] } }
    const loose = upsertChapter(bare, { id: 'chapter-9', number: 9, title: '路上', synopsis: '赶路' }, () => STAMP)
    const parts = decomposeContent(loose, STAMP)
    expect(Object.keys(parts.chapterPlan.volumes).sort()).toEqual(['0', '1'])
    expect(parts.chapterPlan.paths['0']).toBe('章节大纲/未分卷.md')
    expect(parts.chapterPlan.wholeBook).toContain('未分卷：第 9 章（共 1 章）→ 章节大纲/未分卷.md')

    // Filing it under volume 2 moves the row: the 未分卷 file goes away and the
    // volume's file is the only other thing that changes.
    const filed = { ...loose, chapters: { ...loose.chapters, 'chapter-9': { ...loose.chapters['chapter-9']!, volume: 2 } } }
    const moved = decomposeContent(filed, STAMP)
    expect(Object.keys(moved.chapterPlan.volumes).sort()).toEqual(['1', '2'])
    expect(moved.chapterPlan.volumes['1']).toBe(parts.chapterPlan.volumes['1'])
  })

  it('refuses a chapter or rhythm table left in the whole-book file', () => {
    const state = fixture()
    const parts = decomposeContent(state, STAMP)
    // The tables live per volume; a table in the whole-book file is a plan that
    // nothing would read, so it is named rather than ignored.
    const withTable = `${parts.chapterPlan.wholeBook}\n## 章节表\n\n| 章 | 标题 | 卷 | 目标字数 | 一句话 | 梗概 |\n|---|---|---|---|---|---|\n| 9 | 路上 | 1 | | 赶路 | 赶路 |\n`
    expect(() => parseChapterPlanFile(withTable, '章节大纲.md', [])).toThrow(/已经按卷拆开/u)
    // An *empty* table is tolerated: it is what a just-split file looks like.
    expect(() =>
      parseChapterPlanFile(`${parts.chapterPlan.wholeBook}\n## 章节表\n\n| 章 | 标题 | 卷 | 目标字数 | 一句话 | 梗概 |\n|---|---|---|---|---|---|\n`, '章节大纲.md', []),
    ).not.toThrow()
  })

  it('reads the pre-version-5 whole-book plan file for the migration', () => {
    const raw = [
      '# 章节大纲',
      '',
      '## 章节表',
      '',
      '| 章 | 标题 | 卷 | 目标字数 | 一句话 | 梗概 |',
      '|---|---|---|---|---|---|',
      '| 1 | 山门 | 1 | 3000 | 抵达山门 | 抵达山门 |',
      '| 41 | 后山 | 2 | 3000 | 进后山 | 进后山 |',
      '',
      '## 情绪节拍表',
      '',
      '| 章 | 类型 | 一句话 |',
      '|---|---|---|',
      '| 1 | tension | 拦路 |',
      '| 41 | turn | 翻案 |',
      '',
      '## 开篇工程清单',
      '',
      '- [x] chapter-1-hook — 开篇已写（章末留钩子）',
      '',
    ].join('\n')
    const parsed = parseChapterPlanCollectionFile(raw, '章节大纲.md', [])
    expect(parsed.rows.map((row) => [row.number, row.volume])).toEqual([[1, 1], [41, 2]])
    expect(parsed.beats.map((beat) => beat.chapter)).toEqual([1, 41])
    expect(parsed.opening).toHaveLength(1)
    expect(parsed.opening[0]?.done).toBe(true)
  })

  it('keeps the opening checklist, whose done flags gate phase two', () => {
    const state = { ...fixture(), outline: { ...fixture().outline, opening: defaultOpeningChecks() } }
    const parts = decomposeContent(state, STAMP)
    const back = composeContent(
      { [DEFAULT_STORAGE_LAYOUT.chapterPlanFile]: parts.chapterPlan.wholeBook },
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
      { [DEFAULT_STORAGE_LAYOUT.chapterPlanFile]: parts.chapterPlan.wholeBook },
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
