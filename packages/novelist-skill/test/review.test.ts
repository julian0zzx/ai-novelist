import { describe, expect, it } from 'vitest'
import {
  AI_FLAVOR_DIMENSIONS,
  REVIEW_PROMPT_VERSION,
  buildAiFlavorRequest,
  buildCompetitorRequest,
  buildOpeningRequest,
  buildRetroRequest,
  buildRewriteRequest,
  clip,
  emptyNovel,
  parseReviewOutput,
  progressOf,
  projectBrief,
  renderReview,
  upsertChapter,
  type NovelState,
} from '../src/core/index.ts'

/**
 * The review layer's deterministic half.
 *
 * A model's answer cannot be pinned, but everything around it can: the rubric
 * that is sent, the framing that carries the project, the parser that reads a
 * reply back, and the rendering the author sees. Those are the parts that
 * silently rot — a rubric that stops mentioning a dimension, a parser that
 * starts throwing away findings — so they are specified here rather than
 * exercised only through a fake model.
 */

/** A project with one written chapter, for the request builders. */
function fixture(): NovelState {
  const base = emptyNovel(
    { title: '青云记', premise: '少年持断剑上山', genres: ['玄幻'], pov: 'third-limited' },
    () => '2026-01-01T00:00:00.000Z',
  )
  const withPlatform: NovelState = {
    ...base,
    platform: { ...base.platform, name: 'qidian', mode: 'paid', audience: 'male', genres: ['玄幻', '复仇'], readers: '男频老白' },
    pitch: { ...base.pitch, memorablePoint: '断剑认主，越用越强', coreEmotion: '爽', kernel: '复仇' },
    chapters: {},
  }
  return upsertChapter(
    withPlatform,
    {
      id: 'chapter-1',
      number: 1,
      title: '山门',
      plotTask: '林越抵达山门',
      emotionalPayoff: '被接纳的期待',
      hook: '山门后传来一声钟响。',
      body: '山门很高，云雾不散。他握紧断剑，没有回答守门弟子的问题。',
    },
    () => '2026-01-01T00:00:00.000Z',
  )
}

describe('review rubric', () => {
  it('pins the rubric version that every record carries', () => {
    // Bumping this is a decision, not a side effect: records cite it.
    expect(REVIEW_PROMPT_VERSION).toBe('review-rubric-1')
  })

  it('keeps the 去 AI 化 dimensions stable and distinct', () => {
    const keys = AI_FLAVOR_DIMENSIONS.map((dimension) => dimension.key)
    expect(keys).toEqual([
      '翻译腔',
      '整齐句式',
      '总结式抒情',
      '套话身体反应',
      '解释型对话',
      '告知而非呈现',
      '段落节奏',
      '章末钩子',
    ])
    expect(new Set(keys).size).toBe(keys.length)
    for (const dimension of AI_FLAVOR_DIMENSIONS) expect(dimension.rule.length).toBeGreaterThan(10)
  })
})

describe('clip', () => {
  it('leaves text inside the budget alone', () => {
    expect(clip('一二三', 3)).toBe('一二三')
  })

  it('marks what it dropped instead of truncating silently', () => {
    const clipped = clip('一二三四五', 3)
    expect(clipped.startsWith('一二三')).toBe(true)
    expect(clipped).toContain('截断')
  })
})

describe('projectBrief', () => {
  it('carries the commercial frame every judgement depends on', () => {
    const brief = projectBrief(fixture())
    expect(brief).toContain('青云记')
    expect(brief).toContain('玄幻、复仇')
    expect(brief).toContain('男频老白')
    expect(brief).toContain('断剑认主')
    expect(brief).toContain('third-limited')
  })

  it('says what is missing rather than inventing it', () => {
    const empty = projectBrief(emptyNovel({}, () => '2026-01-01T00:00:00.000Z'))
    expect(empty).toContain('（未定）')
    expect(empty).toContain('（未填）')
  })
})

describe('request builders', () => {
  it('frames the 去 AI 化 review around the rubric and the chapter', () => {
    const request = buildAiFlavorRequest({ state: fixture(), chapter: fixture().chapters['chapter-1']! })
    expect(request.system).toContain('翻译腔')
    expect(request.system).toContain('章末钩子')
    expect(request.system).toContain('"findings"')
    expect(request.system).toContain('宁少勿滥')
    expect(request.user).toContain('第 1 章「山门」')
    expect(request.user).toContain('林越抵达山门')
    expect(request.user).toContain('山门很高，云雾不散')
    expect(request.maxTokens).toBeGreaterThan(0)
  })

  it('narrows the rubric to the requested dimensions', () => {
    const request = buildAiFlavorRequest({
      state: fixture(),
      chapter: fixture().chapters['chapter-1']!,
      focus: ['翻译腔', '段落节奏'],
    })
    expect(request.system).toContain('翻译腔')
    expect(request.system).toContain('段落节奏')
    expect(request.system).not.toContain('解释型对话')
  })

  it('ignores a filter that matches nothing rather than sending an empty rubric', () => {
    const request = buildAiFlavorRequest({
      state: fixture(),
      chapter: fixture().chapters['chapter-1']!,
      focus: ['不存在的维度'],
    })
    expect(request.system).toContain('翻译腔')
  })

  it('asks a rewrite to preserve the plot and the ending', () => {
    const request = buildRewriteRequest({
      state: fixture(),
      chapter: fixture().chapters['chapter-1']!,
      findings: [
        { dimension: '总结式抒情', quote: '心中五味杂陈', why: '讲了情绪', fix: '换成动作', severity: 'high' },
      ],
    })
    expect(request.system).toContain('不得增删情节')
    expect(request.system).toContain('只输出重写后的正文')
    expect(request.user).toContain('总结式抒情')
    expect(request.user).toContain('心中五味杂陈')
    expect(request.user).toContain('山门很高，云雾不散')
  })

  it('shows the opening checklist with its current state and asks per chapter', () => {
    const state = fixture()
    const request = buildOpeningRequest({
      state,
      chapters: [state.chapters['chapter-1']!],
      checks: [
        { key: 'golden-finger', requirement: '金手指亮相', done: true, note: '' },
        { key: 'first-payoff', requirement: '第一个爽点落地', done: false, note: '' },
      ],
      gate: 3,
    })
    expect(request.system).toContain('前 3 章')
    expect(request.system).toContain('第N章 · 问题类型')
    expect(request.user).toContain('[x] 金手指亮相')
    expect(request.user).toContain('[ ] 第一个爽点落地')
    expect(request.user).toContain('开篇正文')
  })

  it('asks the competitor review for a dismantle object', () => {
    const request = buildCompetitorRequest({ state: fixture(), title: '断剑', text: '第一章……' })
    expect(request.system).toContain('"dismantle"')
    expect(request.system).toContain('goldenFinger')
    expect(request.system).toContain('无法判断')
    expect(request.user).toContain('竞品书名：断剑')
    expect(request.user).toContain('第一章……')
  })

  it('distils a retrospective from the project data alone', () => {
    const state = fixture()
    const request = buildRetroRequest({
      state,
      progress: progressOf(state),
      readings: [],
      iterations: [],
      lessons: [{ id: 'lesson-1', kind: 'avoid', statement: '开篇堆设定', evidence: '第3章读完低', area: 'opening' }],
    })
    expect(request.system).toContain('"lessons"')
    expect(request.system).toContain('不要编造因果')
    expect(request.user).toContain('（没有读数）')
    expect(request.user).toContain('1. [planned] 山门')
    expect(request.user).toContain('开篇堆设定')
  })
})

describe('parseReviewOutput', () => {
  const finding = (severity: string, dimension = '翻译腔'): string =>
    `{"dimension":"${dimension}","quote":"值得注意的是","why":"书面连接词","fix":"删掉","severity":"${severity}"}`

  it('reads a plain JSON reply', () => {
    const output = parseReviewOutput(`{"summary":"整体可以","findings":[${finding('high')}]}`)
    expect(output.parsed).toBe(true)
    expect(output.summary).toBe('整体可以')
    expect(output.findings).toHaveLength(1)
    expect(output.findings[0]?.severity).toBe('high')
  })

  it('reads through code fences and surrounding prose', () => {
    const output = parseReviewOutput(`好的，以下是结果：\n\`\`\`json\n{"summary":"可以","findings":[]}\n\`\`\`\n希望有帮助。`)
    expect(output.parsed).toBe(true)
    expect(output.summary).toBe('可以')
  })

  it('sorts findings by severity and defaults an unknown severity to medium', () => {
    const output = parseReviewOutput(
      `{"summary":"x","findings":[${finding('low')},${finding('severe')},${finding('high')}]}`,
    )
    expect(output.findings.map((entry) => entry.severity)).toEqual(['high', 'medium', 'low'])
  })

  it('drops entries that say nothing actionable', () => {
    const output = parseReviewOutput(
      `{"summary":"x","findings":[{"dimension":"","fix":""},{"dimension":"节奏","fix":"拆段","why":"","quote":"","severity":"low"}]}`,
    )
    expect(output.findings).toHaveLength(1)
    expect(output.findings[0]?.dimension).toBe('节奏')
  })

  it('keeps the raw reply when the model ignores the contract', () => {
    const output = parseReviewOutput('这一章读起来还行。\n但是有点平。')
    expect(output.parsed).toBe(false)
    expect(output.findings).toEqual([])
    expect(output.summary).toBe('这一章读起来还行。')
    expect(output.raw).toContain('有点平')
  })

  it('falls back to the first line when the summary is missing', () => {
    const output = parseReviewOutput('{"findings":[]}')
    expect(output.summary).toBe('{"findings":[]}')
    expect(output.parsed).toBe(true)
  })

  it('reads a competitor dismantle', () => {
    const output = parseReviewOutput(
      `{"summary":"x","findings":[],"dismantle":{"tags":["玄幻"],"goldenFinger":"断剑认主","commentKeywords":["断剑","热血"]}}`,
    )
    expect(output.dismantle).toMatchObject({ goldenFinger: '断剑认主' })
    expect(output.dismantle?.commentKeywords).toEqual(['断剑', '热血'])
    expect(output.dismantle?.blurb).toBe('')
  })

  it('reads lessons and normalizes their fields', () => {
    const output = parseReviewOutput(
      `{"summary":"x","findings":[],"lessons":[{"kind":"avoid","statement":"开篇堆设定","evidence":"数据差"},{"kind":"?","statement":"短段落好"}]}`,
    )
    expect(output.lessons).toHaveLength(2)
    expect(output.lessons?.[0]).toMatchObject({ kind: 'avoid', area: 'other' })
    expect(output.lessons?.[1]?.kind).toBe('reuse')
  })

  it('ignores a dismantle or lessons field that is not an array or object', () => {
    const output = parseReviewOutput('{"summary":"x","findings":[],"lessons":"none","dismantle":[]}')
    expect(output.dismantle).toBeUndefined()
    expect(output.lessons).toBeUndefined()
  })
})

describe('renderReview', () => {
  it('renders findings with a severity label, the quote, and the reason', () => {
    const lines = renderReview(
      parseReviewOutput(
        `{"summary":"总评","findings":[{"dimension":"翻译腔","quote":"值得注意的是","why":"书面词","fix":"删掉","severity":"high"}]}`,
      ),
      '去 AI 化诊断',
    )
    const text = lines.join('\n')
    expect(text).toContain('总评')
    expect(text).toContain('## 去 AI 化诊断（1 条，按严重度排序）')
    expect(text).toContain('- [高] 翻译腔：删掉')
    expect(text).toContain('原文：值得注意的是')
    expect(text).toContain('原因：书面词')
  })

  it('says so plainly when there is nothing to fix', () => {
    const lines = renderReview(parseReviewOutput('{"summary":"干净","findings":[]}'), '去 AI 化诊断')
    expect(lines.join('\n')).toContain('没有发现需要修改的问题')
  })

  it('warns that an unparsed reply produced no findings', () => {
    const lines = renderReview(parseReviewOutput('随便写了几句'), '去 AI 化诊断')
    expect(lines.join('\n')).toContain('没有按约定返回 JSON')
  })
})
