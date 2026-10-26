import { describe, expect, it } from 'vitest'
import { buildSubmissionPackage, emptyNovel, upsertChapter } from '../src/core/index.ts'

/**
 * The submission package is assembled from project facts, never invented.
 *
 * The two things worth pinning: it must carry the real title/hooks, and it must
 * leave the blurb slot empty rather than have a tool write marketing prose.
 */
describe('submission package', () => {
  const now = () => '2026-10-26T00:00:00.000Z'

  it('assembles the work information, the first three chapters and the checklist', () => {
    let state = emptyNovel({ title: '测试书' })
    state = upsertChapter(state, {
      number: 1,
      title: '山门',
      plotTask: '主角被逐出师门',
      hook: '他捡起那块碎玉，玉里有人在说话。',
      body: '正文。'.repeat(400),
      status: 'final',
    })
    state = upsertChapter(state, { number: 2, title: '夜路', plotTask: '第一次交手', hook: '追兵到了。' })
    state = upsertChapter(state, { number: 3, title: '旧刀', plotTask: '亮出底牌', hook: '刀上有母亲的名字。' })
    state = upsertChapter(state, { number: 4, title: '未写', plotTask: '还没轮到的章' })

    const doc = buildSubmissionPackage(state, now)
    expect(doc).toContain('# 《测试书》投稿包')
    expect(doc).toContain('第 1 章「山门」')
    expect(doc).toContain('他捡起那块碎玉')
    expect(doc).toContain('前三章体检')
    expect(doc).toContain('投稿前自查')
    expect(doc).toContain('投稿记录')
    // Only the first three chapters are the editor's opening sample.
    expect(doc).not.toContain('第 4 章「未写」')
  })

  it('uses the active naming candidate for title, blurb and tags', () => {
    const base = emptyNovel({ title: '占位' })
    const state = {
      ...base,
      naming: [
        { id: 'a', title: '备用', blurb: '备用简介', tags: ['备用'], rationale: '', active: false },
        { id: 'b', title: '正式书名', blurb: '一句正式简介。', tags: ['都市', '系统'], rationale: '', active: true },
      ],
    }
    const doc = buildSubmissionPackage(state, now)
    expect(doc).toContain('# 《正式书名》投稿包')
    expect(doc).toContain('一句正式简介。')
    expect(doc).toContain('都市、系统')
  })

  it('leaves the blurb to the author instead of inventing marketing prose', () => {
    const state = emptyNovel({ title: '没有候选' })
    const doc = buildSubmissionPackage(state, now)
    expect(doc).toContain('还没有候选简介')
    expect(doc).toContain('生成器不代写')
  })

  it('reports missing hooks and thin contracts instead of assuming they are fine', () => {
    let state = emptyNovel({ title: '缺口' })
    state = upsertChapter(state, { number: 1, title: '空钩', body: '正文。'.repeat(100) })
    const doc = buildSubmissionPackage(state, now)
    expect(doc).toContain('❌ 缺')
    expect(doc).toContain('有正文但无钩 1 章')
  })
})
