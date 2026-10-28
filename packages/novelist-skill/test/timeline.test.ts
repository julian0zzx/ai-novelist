import { describe, expect, it } from 'vitest'
import { parseNumeral, readAnchor, timelineReport, timelineLines } from '../src/core/index.ts'
import { renderChapterVersion, versionPath, versionStamp, VERSIONS_DIR } from '../src/core/index.ts'
import type { Chapter } from '../src/core/types.ts'

/**
 * The 时间账本 and the version archive, pinned.
 *
 * The timeline parser is deliberately conservative, so the specs that matter are
 * the two kinds of quiet: a shape it does not know must not create a regression,
 * and a flashback must not move the cursor for the chapters after it.
 */

const chapter = (number: number, timeAnchor: string, title = `第${String(number)}章`): Chapter =>
  ({ number, title, timeAnchor }) as Chapter

describe('parseNumeral', () => {
  it('reads digits and the Chinese forms an anchor actually uses', () => {
    expect(parseNumeral('12')).toBe(12)
    expect(parseNumeral('十二')).toBe(12)
    expect(parseNumeral('二十')).toBe(20)
    expect(parseNumeral('三十五')).toBe(35)
    expect(parseNumeral('一百零五')).toBe(105)
    expect(parseNumeral('两百')).toBe(200)
  })

  it('refuses text that is not a numeral', () => {
    expect(parseNumeral('明天')).toBeUndefined()
    expect(parseNumeral('')).toBeUndefined()
  })
})

describe('readAnchor', () => {
  it('places absolute days, relative jumps and flashbacks', () => {
    expect(readAnchor('第三日 黄昏')).toEqual({ kind: 'absolute', day: 3 })
    expect(readAnchor('三日后')).toEqual({ kind: 'relative', days: 3 })
    expect(readAnchor('五天后')).toEqual({ kind: 'relative', days: 5 })
    expect(readAnchor('次日')).toEqual({ kind: 'relative', days: 1 })
    expect(readAnchor('同日')).toEqual({ kind: 'relative', days: 0 })
    expect(readAnchor('前一日')).toEqual({ kind: 'relative', days: -1 })
    expect(readAnchor('十年前')).toEqual({ kind: 'flashback' })
    expect(readAnchor('回忆：那年冬天')).toEqual({ kind: 'flashback' })
  })

  it('calls an unfamiliar phrasing unknown instead of guessing', () => {
    expect(readAnchor('灵潮退去后的第二年')).toEqual({ kind: 'unknown' })
    expect(readAnchor('')).toEqual({ kind: 'unknown' })
  })
})

describe('timelineReport', () => {
  it('reports the chapter whose story day goes backwards', () => {
    const report = timelineReport([chapter(1, '第三日'), chapter(2, '第五日'), chapter(3, '第四日')])
    expect(report.regressions).toHaveLength(1)
    expect(report.regressions[0]).toMatchObject({ chapter: 3, anchor: '第四日', reachedDay: 5, reachedBy: 2 })
    expect(timelineLines(report)[0]).toContain('第 3 章「第四日」早于第 2 章 已到的第 5 日')
  })

  it('follows a relative jump from the day already reached', () => {
    const report = timelineReport([chapter(1, '第三日'), chapter(2, '三日后')])
    expect(report.regressions).toHaveLength(0)
    expect(report.lastDay).toBe(6)
  })

  it('does not let a flashback drag the cursor backwards', () => {
    const report = timelineReport([chapter(1, '第三日'), chapter(2, '十年前'), chapter(3, '第四日')])
    expect(report.regressions).toHaveLength(0)
    expect(report.lastDay).toBe(4)
  })

  it('skips an anchor it cannot place, without inventing a regression', () => {
    const report = timelineReport([
      chapter(1, '第三日'),
      chapter(2, '灵潮退去后的第二年'),
      chapter(3, '第四日'),
    ])
    expect(report.regressions).toHaveLength(0)
    expect(report.unparsed).toEqual([2])
    expect(report.parsed).toBe(2)
  })

  it('names the chapters with no anchor at all', () => {
    const report = timelineReport([chapter(1, '第三日'), chapter(2, ''), chapter(3, '   ')])
    expect(report.missing).toEqual([2, 3])
    expect(timelineLines(report).join(' ')).toContain('缺时间锚点 2 章')
  })

  it('says nothing when every anchor agrees', () => {
    const report = timelineReport([chapter(1, '第一日'), chapter(2, '次日'), chapter(3, '第三日')])
    expect(report.regressions).toHaveLength(0)
    expect(report.missing).toHaveLength(0)
    expect(timelineLines(report)).toEqual([])
  })
})

describe('chapter version archive', () => {
  const archived = {
    number: 7,
    title: '断剑',
    status: 'revised',
    wordCount: 12,
    updatedAt: '2024-04-30T10:00:00.000Z',
    body: '他走进山门。',
  } as Chapter

  it('builds a sortable, Windows-safe file name', () => {
    expect(versionStamp('2024-05-01T00:00:00.000Z')).toBe('20240501T000000Z')
    expect(versionPath(archived, '2024-05-01T00:00:00.000Z')).toBe(`${VERSIONS_DIR}/007-20240501T000000Z.md`)
  })

  it('keeps the header restorable by hand and the body verbatim', () => {
    const text = renderChapterVersion(archived, '2024-05-01T00:00:00.000Z')
    expect(text).toContain('# 第 7 章 断剑（被覆盖前的存档）')
    expect(text).toContain('存档时状态 revised')
    expect(text.endsWith('他走进山门。\n')).toBe(true)
  })
})
