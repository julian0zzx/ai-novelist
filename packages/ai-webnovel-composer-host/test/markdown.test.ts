import { describe, expect, it } from 'vitest'
import {
  MarkdownError,
  escapeCell,
  findSection,
  frontBool,
  frontMap,
  frontNumber,
  frontString,
  frontStringArray,
  hashContent,
  parseDocument,
  parseFrontmatter,
  parseScalarToken,
  parseTable,
  readEntries,
  renderDocument,
  renderEntry,
  renderListSection,
  renderSection,
  renderTable,
  sectionList,
  sectionText,
  serializeFrontmatter,
  splitEntryBody,
  splitFrontmatter,
  splitSections,
} from '../src/core/markdown.ts'

/**
 * Codec specs: the dialect is small, so the edges are worth pinning exactly.
 *
 * The plan's §9 asks for the round trip, the frontmatter boundaries, and the
 * table rules; these specs are the executable form of that list.
 */
describe('frontmatter', () => {
  it('reads scalars, inline lists, and block lists the same way', () => {
    const map = parseFrontmatter(
      ['number: 3', 'title: "山门"', 'done: false', 'beats: [tension, shuang]', 'waived:', '  - infoGap', '  - hook'].join('\n'),
      'x.md',
    )
    expect(map['number']).toBe(3)
    expect(map['title']).toBe('山门')
    expect(map['done']).toBe(false)
    expect(frontStringArray(map, 'beats')).toEqual(['tension', 'shuang'])
    expect(frontStringArray(map, 'waived')).toEqual(['infoGap', 'hook'])
  })

  it('reads both `chapters: [1, 30]` and the block spelling as numbers', () => {
    const inline = parseFrontmatter('chapters: [1, 30]', 'x.md')
    const block = parseFrontmatter('chapters:\n  - 1\n  - 30', 'x.md')
    expect(inline['chapters']).toEqual([1, 30])
    expect(block['chapters']).toEqual([1, 30])
    // Numbers, not strings: a volume range is arithmetic, not display text.
    expect(block['chapters']).toEqual(inline['chapters'])
  })

  it('reads a one-level mapping such as waived reasons', () => {
    const map = parseFrontmatter('waived:\n  infoGap: 留到第 3 章\n  hook: 无需', 'x.md')
    expect(frontMap(map, 'waived')).toEqual({ infoGap: '留到第 3 章', hook: '无需' })
  })

  it('keeps a colon inside a quoted scalar intact', () => {
    const map = parseFrontmatter('hook: "钟声之后：山门后山传来剑鸣"', 'x.md')
    expect(frontString(map, 'hook', '')).toBe('钟声之后：山门后山传来剑鸣')
  })

  it('round-trips every scalar type through serialize and parse', () => {
    const map = {
      number: 1,
      title: '第一章',
      targetWords: 3000,
      done: true,
      empty: '',
      beats: ['tension', 'info'],
      waived: { infoGap: '留到第 3 章' },
      skipped: undefined,
    }
    const text = serializeFrontmatter(map)
    const back = parseFrontmatter(text, 'x.md')
    expect(frontNumber(back, 'number', 0)).toBe(1)
    expect(frontString(back, 'title', '')).toBe('第一章')
    expect(frontNumber(back, 'targetWords', 0)).toBe(3000)
    expect(frontBool(back, 'done', false)).toBe(true)
    expect(frontString(back, 'empty', 'sentinel')).toBe('')
    expect(frontStringArray(back, 'beats')).toEqual(['tension', 'info'])
    expect(back['skipped']).toBeUndefined()
  })

  it('tolerates a file with no frontmatter', () => {
    const doc = parseDocument('# 只有正文\n\n内容\n', 'x.md')
    expect(doc.hasFrontmatter).toBe(false)
    expect(doc.frontmatter).toEqual({})
    expect(doc.body).toContain('只有正文')
  })

  it('tolerates a file that is only frontmatter', () => {
    const doc = parseDocument('---\nid: "chapter-1"\n---\n', 'x.md')
    expect(doc.hasFrontmatter).toBe(true)
    expect(frontString(doc.frontmatter, 'id', '')).toBe('chapter-1')
    expect(doc.body.trim()).toBe('')
  })

  it('treats an empty file as having no frontmatter and no body', () => {
    expect(splitFrontmatter('')).toEqual({ found: false, frontmatter: '', body: '' })
    expect(parseDocument('', 'x.md')).toEqual({ hasFrontmatter: false, frontmatter: {}, body: '' })
  })

  it('reports an unclosed frontmatter block instead of guessing', () => {
    expect(() => splitFrontmatter('---\nid: "a"\n# no closing fence\n')).toThrow(MarkdownError)
  })

  it('reports a frontmatter line that is not key: value', () => {
    expect(() => parseFrontmatter('just some prose\n', 'x.md')).toThrow(/expected "key: value"/u)
  })

  it('reports a bad indentation instead of silently nesting it', () => {
    expect(() => parseFrontmatter('   stray: 1\n', 'x.md')).toThrow(/indented frontmatter line/u)
  })

  it('names the file and the offending line in every error', () => {
    expect(() => parseFrontmatter('bad line here\n', '章节/第001章.md')).toThrow(/章节\/第001章\.md/u)
  })

  it('reports an unclosed inline list', () => {
    expect(() => parseScalarToken('[a, b')).toThrow(/never closed/u)
  })
})

describe('sections', () => {
  it('splits on level-two headings and keeps prose newlines', () => {
    const sections = splitSections('# 标题\n\n## 剧情任务\n\n第一行\n第二行\n\n## 钩子\n\n钟响\n')
    expect(sections.map((section) => section.title)).toEqual(['剧情任务', '钩子'])
    expect(sectionText(sections, '剧情任务')).toBe('第一行\n第二行')
    expect(sectionText(sections, '钩子')).toBe('钟响')
  })

  it('does not treat a heading inside a fenced block as a section', () => {
    const sections = splitSections('## 一\n\n```yaml\nx: "## 不是小节"\n```\n\n正文\n\n## 二\n\n尾\n')
    expect(sections.map((section) => section.title)).toEqual(['一', '二'])
    expect(sectionText(sections, '一')).toContain('## 不是小节')
  })

  it('reports a missing section as an empty field, not as an error', () => {
    const sections = splitSections('## 剧情任务\n\n内容\n')
    expect(sectionText(sections, '章末钩子')).toBe('')
    expect(sectionList(sections, '三幕')).toEqual([])
    expect(findSection(sections, '章末钩子')).toBeUndefined()
  })

  it('reads an ordered list and tolerates the unordered spelling', () => {
    const ordered = splitSections(renderListSection('三幕', ['第一幕', '第二幕', '第三幕']))
    expect(sectionList(ordered, '三幕')).toEqual(['第一幕', '第二幕', '第三幕'])
    const unordered = splitSections('## 三幕\n\n- 甲\n- 乙\n')
    expect(sectionList(unordered, '三幕')).toEqual(['甲', '乙'])
  })

  it('accepts a list of one item, because the SOP says three but the tool does not refuse', () => {
    expect(sectionList(splitSections(renderListSection('三幕', ['独幕'])), '三幕')).toEqual(['独幕'])
  })

  it('round-trips Chinese punctuation and blank-line separated prose', () => {
    const body = '他问：「你是谁？」\n\n——山门之下，无人应答。'
    const sections = splitSections(renderSection('冲突', body))
    expect(sectionText(sections, '冲突')).toBe(body)
  })
})

describe('entry blocks', () => {
  it('reads the yaml block and the prose after it', () => {
    // `splitEntryBody` takes a section's *body*, which is what `splitSections`
    // hands it; the heading itself has already been peeled off by then.
    const raw = [
      '```yaml',
      'id: lin-yue',
      'role: protagonist',
      '```',
      '',
      '十六岁，瘦，左手虎口有旧疤……',
      '',
    ].join('\n')
    const { fields, prose } = splitEntryBody(raw)
    expect(frontString(parseFrontmatter(fields, 'x.md'), 'id', '')).toBe('lin-yue')
    expect(prose).toBe('十六岁，瘦，左手虎口有旧疤……')
  })

  it('peels the heading off before the block is read', () => {
    const raw = ['## 林越', '', '```yaml', 'id: lin-yue', '```', '', '十六岁。'].join('\n')
    const [entry] = readEntries(splitSections(raw), 'x.md')
    expect(entry).toEqual({ title: '林越', fields: { id: 'lin-yue' }, prose: '十六岁。' })
  })

  it('treats a section with no yaml block as all prose', () => {
    const { fields, prose } = splitEntryBody('直接就是正文\n\n第二段')
    expect(fields).toBe('')
    expect(prose).toBe('直接就是正文\n\n第二段')
  })

  it('reports a yaml fence that is never closed', () => {
    expect(() => splitEntryBody('```yaml\nid: a\n')).toThrow(/never closed/u)
  })

  it('round-trips one entry through renderEntry and readEntries', () => {
    const rendered = renderEntry('林越', { id: 'lin-yue', role: 'protagonist' }, '十六岁，瘦。')
    const sections = splitSections(rendered)
    const [entry] = readEntries(sections, 'x.md')
    expect(entry?.title).toBe('林越')
    expect(entry?.fields['id']).toBe('lin-yue')
    expect(entry?.prose).toBe('十六岁，瘦。')
  })

  it('renders an entry with no fields and no prose as a bare heading', () => {
    expect(renderEntry('守门弟子', {}, '')).toBe('## 守门弟子\n')
  })
})

describe('tables', () => {
  const plan = (body: string): string => `# 章节大纲\n\n## 章节表\n\n${body}\n`

  it('parses a table, skipping the separator row', () => {
    const table = parseTable(
      splitSections(plan('| 章 | 标题 | 卷 | 目标字数 | 一句话 |\n|---|---|---|---|---|\n| 1 | 山门 | 1 | 3000 | 林越抵达山门 |')),
      '章节表',
      'x.md',
    )
    expect(table?.header).toEqual(['章', '标题', '卷', '目标字数', '一句话'])
    expect(table?.rows).toEqual([['1', '山门', '1', '3000', '林越抵达山门']])
  })

  it('unescapes a literal pipe inside a cell', () => {
    const table = parseTable(
      splitSections(plan('| 章 | 标题 |\n|---|---|\n| 1 | 山门\\|后山 |')),
      '章节表',
      'x.md',
    )
    expect(table?.rows).toEqual([['1', '山门|后山']])
  })

  it('escapes a literal pipe when rendering', () => {
    expect(escapeCell('山门|后山')).toBe('山门\\|后山')
    const rendered = renderTable(['章', '标题'], [['1', '山门|后山']])
    const table = parseTable(splitSections(plan(rendered)), '章节表', 'x.md')
    expect(table?.rows).toEqual([['1', '山门|后山']])
  })

  it('flattens a newline in a cell rather than breaking the row', () => {
    expect(escapeCell('第一行\n第二行')).toBe('第一行 第二行')
  })

  it('reports a row with the wrong number of cells instead of shifting it', () => {
    expect(() =>
      parseTable(splitSections(plan('| 章 | 标题 | 卷 |\n|---|---|---|\n| 1 | 山门 |')), '章节表', 'x.md'),
    ).toThrow(/2 cells where the header has 3/u)
  })

  it('names the file and the section in a table error', () => {
    expect(() =>
      parseTable(splitSections(plan('| 章 | 标题 |\n|---|---|\n| 1 | 山门 | 多 |')), '章节表', '章节大纲.md'),
    ).toThrow(/章节大纲\.md.*章节表/u)
  })

  it('reports an absent table as undefined rather than an empty one', () => {
    expect(parseTable(splitSections('# 章节大纲\n'), '章节表', 'x.md')).toBeUndefined()
  })

  it('round-trips a row through render and parse with Chinese punctuation', () => {
    const rows = [['1', '山门', '1', '3000', '他问：「谁？」']]
    const header = ['章', '标题', '卷', '目标字数', '一句话']
    const table = parseTable(splitSections(plan(renderTable(header, rows))), '章节表', 'x.md')
    expect(table?.header).toEqual(header)
    expect(table?.rows).toEqual(rows)
  })
})

describe('documents and hashing', () => {
  it('round-trips a whole document', () => {
    const text = renderDocument({ id: 'chapter-1', number: 1 }, '第 1 章 山门', [
      renderSection('剧情任务', '抵达山门'),
      renderSection('冲突', '守门弟子拦路'),
    ])
    const doc = parseDocument(text, 'x.md')
    expect(frontString(doc.frontmatter, 'id', '')).toBe('chapter-1')
    expect(sectionText(splitSections(doc.body), '剧情任务')).toBe('抵达山门')
    // Rendering what was parsed is byte-identical: the codec is stable.
    const again = renderDocument(doc.frontmatter, '第 1 章 山门', [
      renderSection('剧情任务', '抵达山门'),
      renderSection('冲突', '守门弟子拦路'),
    ])
    expect(again).toBe(text)
  })

  it('hashes content deterministically and distinguishes edits', () => {
    expect(hashContent('abc')).toBe(hashContent('abc'))
    expect(hashContent('abc')).not.toBe(hashContent('abd'))
    expect(hashContent('abc')).toMatch(/^sha256:[0-9a-f]{64}$/u)
  })
})
