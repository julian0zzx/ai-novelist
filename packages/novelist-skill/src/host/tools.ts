/**
 * Model-facing tools: the nine surfaces of the SOP.
 *
 * One tool per capability, each owning one phase or one kind of state, so the
 * model's vocabulary matches the workflow instead of the storage layout:
 *
 * | tool | SOP phase | what it owns |
 * |---|---|---|
 * | `novel_init` | 一 策划 | project, platform, calibration medians, writing parameters |
 * | `novel_plan` | 一/二/四 | pitch, competitors, world, outline, volumes, beats, chapters, naming |
 * | `novel_bible` | 一/四/六 | cast, world facts, reader promises, and their review |
 * | `novel_verify` | 三 验证 | validation rounds: readings in, verdict out |
 * | `novel_write` | 五 连载 | prose plus the contract-delivery report |
 * | `novel_metrics` | 五 放大 | readings, rule-driven iteration, outcome back-fill |
 * | `novel_status` | 全流程 | the SOP dashboard, entirely derived |
 * | `novel_repo` | 六 复盘 | retrospective, IP assets, templates, manuscript export |
 *
 * Every tool answers with the same envelope — `ok`, `operation`, `detail`, the
 * derived stage, the next phase's blockers, soft-gate `warnings`, and a progress
 * line — so the model learns where the project stands and what the SOP expects
 * next whichever tool it happened to call.
 *
 * The soft gate is deliberate: `novel_plan` and friends never refuse a call
 * because the SOP would rather you were elsewhere. They do it, then tell you.
 *
 * @module @ai-novelist/novelist-skill/host/tools
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import {
  BEAT_KINDS,
  CHAPTER_STATUSES,
  CONTRACT_FIELDS,
  LENGTH_BENCHMARKS,
  LINK_STATUSES,
  METRIC_KEYS,
  PLATFORM_AUDIENCES,
  PLATFORM_MODES,
  REVIEW_KINDS,
  REVIEW_PROMPT_VERSION,
  WRITING_PLAN_QUESTIONS,
  NovelInputError,
  addIteration,
  addReading,
  addReview,
  analyzeDelivery,
  assessReading,
  assessStage,
  blockersToFinal,
  buildAiFlavorRequest,
  buildCompetitorRequest,
  buildOpeningRequest,
  buildRetroRequest,
  buildRetrospective,
  buildRewriteRequest,
  buildTemplate,
  calibrationAge,
  castGaps,
  chaptersPerVolume,
  complianceChecklist,
  contractGaps,
  contractRows,
  countIneffectiveIterations,
  describeWritingPlan,
  draftTargetWords,
  emptyNovel,
  iterationRules,
  judgeIteration,
  lessonPrompts,
  lengthCheck,
  lengthWindow,
  missingContract,
  normalizeId,
  normalizeWritingPlan,
  openingPackageGaps,
  parseReviewOutput,
  progressOf,
  removeChapter,
  removeLink,
  renderManuscript,
  renderReview,
  resolveChapterId,
  rhythmExpectation,
  setOpeningCheck,
  stageLabel,
  styleObservations,
  tallyAssessments,
  updateBaselines,
  updateMeta,
  updateOutline,
  updatePitch,
  updatePlatform,
  updateWriting,
  upsertBeat,
  upsertChapter,
  upsertCharacter,
  upsertLink,
  upsertVolume,
  upsertWorld,
  verdictFromAssessments,
  volumeLengthNote,
  worldGaps,
  writingPlanConflicts,
  writingPlanGaps,
  type Clock,
  type Chapter,
  type Lesson,
  type MetricKey,
  type MetricPeriod,
  type NovelState,
  type ReviewFinding,
  type ReviewKind,
  type ReviewRecord,
} from '../core/index.ts'
import { DEFAULT_MULTIPLIERS } from '../core/metrics.ts'
import { NovelReviewError, resolveRoute, runReview, type ReviewSettings } from './llm.ts'
import type { ProjectResolver } from './resolver.ts'
import { policyForSession, withSandboxPolicy } from './sandbox.ts'
import { NOVEL_RELATIVE_PATH } from './store.ts'
import type { SessionRef, WorkspaceViews } from './views.ts'

/** Default export destination for the rendered manuscript. */
export const DEFAULT_MANUSCRIPT_PATH = '.novel/manuscript.md'

/** Default directory for exported structural templates. */
export const DEFAULT_TEMPLATE_PATH = '.novel/templates'

/** Default directory for review transcripts and rewritten drafts. */
export const DEFAULT_REVIEW_PATH = '.novel/reviews'

/** The store type one execution resolves. */
type SessionStore = ReturnType<ProjectResolver['storeForSession']>

/**
 * Register one composer tool with the calling session's sandbox policy in scope.
 *
 * The composer writes through `ctx.fs` itself rather than through the
 * model-facing file tools, so it has to carry the same per-call sandbox policy
 * those tools do. Without it a confining backend fences every mutation against
 * the *deployment's* root instead of the session workspace — every write denied
 * while reads keep working, which is exactly the failure this wrapper exists to
 * make impossible. Wrapping the registration rather than each handler keeps that
 * guarantee in one place, so a tool added later cannot forget it.
 *
 * @param ctx - the plugin context carrying `fs` and `tools`.
 * @param tool - the definition to register.
 */
function registerScoped(ctx: Context, tool: ToolDefinition): void {
  const execute = tool.execute
  ctx.tools.register({
    ...tool,
    execute: (args, exec) =>
      withSandboxPolicy(policyForSession(ctx, exec.agent?.session), () => execute(args, exec)),
  })
}

/** The envelope fields every tool contributes. */
interface Envelope {
  readonly stage: string
  readonly blockers: string[]
  readonly warnings?: string[]
  readonly progress: {
    readonly chapters: number
    readonly words: number
    readonly written: number
    readonly contracted: number
    readonly stock: number
    readonly openLinks: number
    readonly overdueLinks: number
  }
}

/** JSON schema properties of the envelope, reused by every tool. */
const ENVELOPE_PROPERTIES = {
  ok: { type: 'boolean', required: true, description: 'Whether the call changed anything.' },
  operation: { type: 'string', required: true, description: 'Which operation ran.' },
  detail: { type: 'string', required: true, description: 'What happened, in one line.' },
  stage: { type: 'string', required: true, description: 'The SOP phase this project is in.' },
  blockers: {
    type: 'array',
    required: true,
    items: { type: 'string' },
    description: 'What the SOP still needs before the next phase.',
  },
  warnings: {
    type: 'array',
    items: { type: 'string' },
    description: 'Soft-gate notes: the call succeeded, but the SOP disagrees with the position.',
  },
  body: { type: 'array', items: { type: 'string' }, description: 'Tool-specific detail lines.' },
  progress: {
    type: 'object',
    required: true,
    additionalProperties: false,
    properties: {
      chapters: { type: 'integer', required: true },
      words: { type: 'integer', required: true },
      written: { type: 'integer', required: true },
      contracted: { type: 'integer', required: true },
      stock: { type: 'integer', required: true },
      openLinks: { type: 'integer', required: true },
      overdueLinks: { type: 'integer', required: true },
    },
  },
} as const

/** JSON schema for the envelope, reused by every tool. */
const ENVELOPE_SCHEMA = { type: 'object', additionalProperties: true, properties: ENVELOPE_PROPERTIES } as const

/**
 * Build the envelope's derived share.
 *
 * @param state - the project after the call.
 * @param warnings - soft-gate notes accumulated by the call.
 * @returns the envelope fields every tool shares.
 */
function envelope(state: NovelState, warnings: readonly string[] = []): Envelope {
  const assessment = assessStage(state)
  const progress = progressOf(state)
  return {
    stage: `${assessment.stage}（${stageLabel(assessment.stage)}）`,
    blockers: [...assessment.blockers],
    ...(warnings.length > 0 ? { warnings: [...warnings] } : {}),
    progress: {
      chapters: progress.chapters,
      words: progress.totalWords,
      written: progress.chapters - progress.emptyChapters.length,
      contracted: progress.contractedChapters,
      stock: progress.stockChapters,
      openLinks: progress.openLinks.length,
      overdueLinks: progress.overdueLinks.length,
    },
  }
}

/**
 * Append the SOP's 去 AI 化 statistics to a tool body.
 *
 * The SOP puts 去 AI 化 immediately after every chapter draft, so every
 * operation that hands prose back reports the same countable symptoms rather
 * than waiting to be asked. The header states what the numbers are — statistics,
 * not a verdict — because the rewrite itself is the author's work: nothing here
 * edits the prose, and a revised draft goes back through `novel_write`
 * `operation="write"`.
 *
 * @param body - the accumulator the calling tool is building.
 * @param prose - the chapter text to scan.
 */
function pushStyleHints(body: string[], prose: string): void {
  const observations = styleObservations(prose)
  if (observations.length === 0) return
  body.push('', '## 去 AI 化提示（机械统计，不是评价）')
  for (const observation of observations) body.push(`- ${observation}`)
}

/**
 * Append the chapter's two length gates to a tool body.
 *
 * A chapter is written long and published on target: the first draft runs to
 * 150% of the finished target because 去 AI 化 and hand-editing delete a large
 * share of it, and the finished chapter then has to land back inside the target
 * the user gave — never more than 5% under it, up to 15% over. Printing both
 * windows every time prose is handed back is
 * what keeps the 150% rule from existing only in the documentation — the writer
 * sees the number it is drafting against, and the stage decides which of the two
 * gates binds.
 *
 * @param body - the accumulator the calling tool is building.
 * @param chapter - the chapter whose gates to render.
 */
function pushLengthReport(body: string[], chapter: Chapter): void {
  if (chapter.targetWords <= 0) return
  const draft = draftTargetWords(chapter.targetWords)
  const finalWindow = lengthWindow(chapter.targetWords)
  const draftWindow = lengthWindow(draft)
  const round = (value: number): string => String(Math.round(value))
  body.push('', '## 字数（初稿 150%，成稿不许低于目标 5%、可高 15%）')
  body.push(
    `- 成稿目标 ${String(chapter.targetWords)} 字：允许 ${round(finalWindow.low)}–${round(finalWindow.high)} 字`
    + '（下限只差 5%：读者买的是这个长度；上限 +15% 留改稿余量）',
  )
  body.push(
    `- 初稿目标 ${String(draft)} 字（成稿目标 × 150%）：允许 ${round(draftWindow.low)}–${round(draftWindow.high)} 字`
    + '；去 AI 化与手改会成段删减，初稿按这个写才留得住成稿长度',
  )
  const gate = lengthCheck(chapter)
  if (gate !== undefined) body.push(`- 本章按${gate.stage === 'draft' ? '初稿' : '成稿'}口径：${gate.note}`)
}

/**
 * Render the envelope plus tool-specific lines as the text the model reads.
 *
 * @param value - the returned envelope.
 * @param body - tool-specific lines.
 * @returns the content blocks.
 */
function renderEnvelope(
  value: Record<string, unknown>,
  body: readonly string[],
): { type: 'text'; text: string }[] {
  const lines: string[] = [String(value['detail'] ?? '')]
  const lines2 = Array.isArray(value['body']) ? (value['body'] as string[]) : body
  if (lines2.length > 0) lines.push('', ...lines2)
  const warnings = value['warnings']
  if (Array.isArray(warnings) && warnings.length > 0) {
    lines.push('', '## 软拦（SOP 提醒，未阻止本次调用）')
    lines.push(...warnings.map((warning) => `- ${String(warning)}`))
  }
  lines.push('', `阶段：${String(value['stage'] ?? '')}`)
  const blockers = value['blockers']
  if (Array.isArray(blockers) && blockers.length > 0) {
    lines.push('下一阶段的缺口：')
    lines.push(...blockers.map((blocker) => `- ${String(blocker)}`))
  }
  const progress = value['progress'] as Record<string, number> | undefined
  if (progress !== undefined) {
    lines.push(
      '',
      `进度：${String(progress['chapters'])} 章 / ${String(progress['words'])} 字 · 已写 ${String(progress['written'])}`
        + ` · 细纲完整 ${String(progress['contracted'])} · 库存 ${String(progress['stock'])}`
        + ` · 未回收承诺 ${String(progress['openLinks'])}（逾期 ${String(progress['overdueLinks'])}）`,
    )
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

/** Shared `render` binding for the envelope tools. */
const renderTool = (args: unknown, value: unknown): { type: 'text'; text: string }[] =>
  renderEnvelope(value as Record<string, unknown>, [])

/** Shared body-collecting helper used by every tool body. */
interface Body {
  readonly lines: string[]
}

/**
 * Register every composer tool on `ctx.tools`.
 *
 * @param ctx - plugin context carrying the tool registry.
 * @param projects - resolves the novel store per calling session.
 * @param views - the per-root views whose numbers the prompt renders; a write
 *   refreshes the view of the *calling session's* workspace, never another one's.
 */
export function registerTools(ctx: Context, projects: ProjectResolver, views: WorkspaceViews): void {
  /** The store for one execution's session. */
  const storeFor = (session: SessionRef | undefined): SessionStore => projects.storeForSession(session)
  /** Re-read the writing session's project into the prompt after a successful write. */
  const resync = async (session: SessionRef | undefined): Promise<void> => {
    await views.viewForSession(session).refresh()
  }
  const now: Clock = () => new Date().toISOString()

  // ── novel_init ──────────────────────────────────────────────────────────────

  registerScoped(ctx,
    defineTool({
      name: 'novel_init',
      description:
        'Establish or complete the novel project in this workspace: premise, commercial frame (platform, mode, audience, '
        + 'genre, target readers, monetization), the calibration medians every later metric is compared against, and the '
        + 'writing parameters (outline window, opening gate chapters, stock target, outline ceiling). '
        + 'The length numbers — targetWords, chapterWords and volumes — are NOT yours to invent: ask the user for all '
        + 'three before or while calling this tool (offer LENGTH_BENCHMARKS-style tiers as choices), and pass what they '
        + 'said. Missing answers are recorded, reported back as a checklist, and repeated by the runtime context every '
        + 'step until they are settled. totalChapters is derived from targetWords ÷ chapterWords when the user does not '
        + 'state it. '
        + 'Call it once at the start, and again whenever the commercial frame changes — it never resets recorded work, and '
        + 'it refuses to overwrite a premise that already exists (use novel_plan operation="pitch" for that). '
        + 'The baselines are the load-bearing part: without same-genre medians over the last 30 days, the SOP threshold '
        + 'rules cannot run and every metric verdict becomes "无法比较".',
      parameters: {
        title: { type: 'string', description: 'Novel title.' },
        premise: { type: 'string', description: 'One-paragraph premise; kept if already set.' },
        platform: { type: 'string', description: 'Platform name, for example qidian / fanqie / jinjiang.' },
        mode: { type: 'string', enum: [...PLATFORM_MODES], description: 'paid | free | unknown.' },
        audience: { type: 'string', enum: [...PLATFORM_AUDIENCES], description: 'male | female | general.' },
        genres: { type: 'array', items: { type: 'string' }, description: 'Genre tags as the platform spells them.' },
        readers: { type: 'string', description: 'One line on the target reader.' },
        monetization: { type: 'string', description: 'How the novel is expected to earn.' },
        language: { type: 'string', description: 'Prose language, for example zh-CN.' },
        pov: { type: 'string', description: 'Point of view, for example third-limited.' },
        targetWords: {
          type: 'integer',
          description: 'Planned total length in characters. Ask the user; never guess. An unanswered question stays 0.',
        },
        chapterWords: {
          type: 'integer',
          description:
            'Target length of one chapter in characters — the length the reader gets, not the length to draft. Ask the '
            + 'user; chapters planned without their own target inherit this. The first draft is written to 150% of it '
            + '(去 AI 化与手改会大幅删减); a finished chapter must land within -5%/+15% of that target — never '
            + 'more than 5% under it — and novel_write checks a draft against 150% and a finished chapter against that window.',
        },
        totalChapters: {
          type: 'integer',
          description: 'Planned total chapters. Optional: derived from targetWords ÷ chapterWords when omitted.',
        },
        volumes: {
          type: 'integer',
          description:
            'Planned volumes. Ask "分卷吗？分几卷？": 0 is the explicit answer 不分卷（单卷到底）, and omitting it '
            + 'means the question is still unanswered (-1).',
        },
        chaptersPerVolume: {
          type: 'integer',
          description: 'Chapters per volume, when the user answered in that shape instead of a volume count.',
        },
        updateRhythm: { type: 'string', description: 'Update rhythm, for example daily-2.' },
        chapterPlanWindow: { type: 'integer', description: 'Chapters of detailed outline kept ahead of the prose.' },
        openingGateChapters: {
          type: 'array',
          items: { type: 'integer' },
          description: 'Chapter positions the opening metrics are read at, for example [3, 10].',
        },
        stockTargetChapters: { type: 'integer', description: 'Chapters of unpublished prose to hold in stock.' },
        chapterPlanCeiling: { type: 'integer', description: 'How far the rolling outline may run ahead at most.' },
        baselines: {
          type: 'object',
          additionalProperties: true,
          description:
            'Same-genre medians over the last 30 days, keyed by metric: clickRate, readThrough3, followRead10, '
            + 'followRead24h, retention7d, favoriteRate, firstSubscription, averageSubscription, collectToSubscribe, '
            + 'followSubscription, subscription24h, completionRate, retention, adUnlock, averageReadPerChapter, chapterScore.',
        },
        multipliers: {
          type: 'object',
          additionalProperties: true,
          description: 'Optional per-metric override of the default threshold multiplier.',
        },
        baselineSource: { type: 'string', description: 'Where the medians came from: leaderboard, editor, cohort.' },
        naming: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description:
            'Candidate title/blurb/tag sets to record at once, each {title, blurb, tags?, rationale?, active?}. '
            + 'The SOP asks for 3–5 of them before validation; more can be added later with novel_plan operation="naming".',
        },
      },
      output: { schema: ENVELOPE_SCHEMA, render: renderTool },
      execute: async (args, exec) => {
        const store = storeFor(exec.agent?.session)
        const existing = await store.read()
        const warnings: string[] = []
        if (existing === undefined) {
          await store.adopt(
            emptyNovel(
              {
                title: args.title ?? '',
                premise: args.premise ?? '',
                ...(args.genres !== undefined && { genres: args.genres }),
                ...(args.pov !== undefined && { pov: args.pov }),
                ...(args.language !== undefined && { language: args.language }),
              },
              now,
            ),
          )
        } else if (args.premise !== undefined && existing.meta.premise.trim() !== '') {
          warnings.push('premise 已存在，本次未覆盖；改用 novel_plan operation="pitch" 修订立意')
        }

        const next = await store.update((current) => {
          let state = updateMeta(
            current,
            {
              ...(args.title !== undefined && { title: args.title }),
              ...(args.premise !== undefined && current.meta.premise.trim() === '' && { premise: args.premise }),
              ...(args.genres !== undefined && { genres: args.genres }),
              ...(args.pov !== undefined && { pov: args.pov }),
              ...(args.language !== undefined && { language: args.language }),
            },
            now,
          )
          state = updatePlatform(
            state,
            {
              ...(args.platform !== undefined && { name: args.platform }),
              ...(args.mode !== undefined && { mode: args.mode }),
              ...(args.audience !== undefined && { audience: args.audience }),
              ...(args.genres !== undefined && { genres: args.genres }),
              ...(args.readers !== undefined && { readers: args.readers }),
              ...(args.monetization !== undefined && { monetization: args.monetization }),
            },
            now,
          )
          state = updateWriting(
            state,
            {
              ...(args.targetWords !== undefined && { targetWords: args.targetWords }),
              ...(args.chapterWords !== undefined && { chapterWords: args.chapterWords }),
              ...(args.totalChapters !== undefined && { totalChapters: args.totalChapters }),
              ...(args.volumes !== undefined && { volumes: args.volumes }),
              ...(args.updateRhythm !== undefined && { updateRhythm: args.updateRhythm }),
              ...(args.chapterPlanWindow !== undefined && { chapterPlanWindow: args.chapterPlanWindow }),
              ...(args.openingGateChapters !== undefined && { openingGateChapters: args.openingGateChapters }),
              ...(args.stockTargetChapters !== undefined && { stockTargetChapters: args.stockTargetChapters }),
              ...(args.chapterPlanCeiling !== undefined && { chapterPlanCeiling: args.chapterPlanCeiling }),
            },
            now,
          )
          // Derive only forward, and only what the answers imply: total chapters
          // from total length ÷ chapter length, volumes from a chapters-per-volume
          // answer. A stated answer is never overwritten.
          const plan = normalizeWritingPlan(state.writing, {
            ...(args.chaptersPerVolume !== undefined && { chaptersPerVolume: args.chaptersPerVolume }),
          })
          if (plan !== state.writing) state = { ...state, writing: plan, updatedAt: now() }
          if (args.naming !== undefined && args.naming.length > 0) {
            const incoming = args.naming.map((entry, index) => {
              const title = typeof entry['title'] === 'string' ? entry['title'] : ''
              const blurb = typeof entry['blurb'] === 'string' ? entry['blurb'] : ''
              return {
                id: normalizeId(typeof entry['id'] === 'string' ? entry['id'] : '') || normalizeId(title) || `candidate-${String(index + 1)}`,
                title,
                blurb,
                tags: Array.isArray(entry['tags']) ? entry['tags'].filter((tag): tag is string => typeof tag === 'string') : [],
                rationale: typeof entry['rationale'] === 'string' ? entry['rationale'] : '',
                active: entry['active'] === true,
              }
            })
            const activeIncoming = incoming.some((candidate) => candidate.active)
            state = {
              ...state,
              naming: [
                ...state.naming
                  .filter((existing) => !incoming.some((candidate) => candidate.id === existing.id))
                  .map((existing) => (activeIncoming ? { ...existing, active: false } : existing)),
                ...incoming,
              ],
              updatedAt: now(),
            }
          }
          if (args.baselines !== undefined || args.multipliers !== undefined || args.baselineSource !== undefined) {
            const medians: Partial<Record<MetricKey, number>> = { ...state.baselines.medians }
            for (const [key, value] of Object.entries(args.baselines ?? {})) {
              if (typeof value !== 'number' || !Number.isFinite(value)) continue
              if (!(METRIC_KEYS as readonly string[]).includes(key)) {
                warnings.push(`未知指标 "${key}" 已忽略；可用：${METRIC_KEYS.join(', ')}`)
                continue
              }
              Object.assign(medians, { [key]: value })
            }
            const multipliers: Partial<Record<MetricKey, number>> = { ...state.baselines.multipliers }
            for (const [key, value] of Object.entries(args.multipliers ?? {})) {
              if (typeof value === 'number' && Number.isFinite(value)) Object.assign(multipliers, { [key]: value })
            }
            state = updateBaselines(
              state,
              { medians, multipliers, calibratedAt: now(), ...(args.baselineSource !== undefined && { source: args.baselineSource }) },
              now,
            )
          }
          return state
        })

        if (next.naming.length > 0 && next.naming.length < 3) {
          warnings.push(`书名/简介/标签备选 ${String(next.naming.length)}/3：SOP 要求至少 3 组，验证阶段要逐个测`)
        }
        // The length numbers are the author's, so an unanswered one is reported as
        // a question to put to them, not as a value to assume.
        const planGaps = writingPlanGaps(next.writing)
        if (planGaps.length > 0) {
          warnings.push(
            `篇幅四问还有 ${String(planGaps.length)} 项没问用户：${planGaps.map((gap) => gap.requirement).join('、')}`
            + `（novel_init 补录，别自己定）`,
          )
        }
        warnings.push(...writingPlanConflicts(next.writing))

        const body = [
          `项目文档：${NOVEL_RELATIVE_PATH}`,
          `平台：${next.platform.name || '—'}（${next.platform.mode}/${next.platform.audience}）`,
          `篇幅：${describeWritingPlan(next.writing)}`,
        ]
        if (planGaps.length > 0) {
          body.push('', '## 初始化必问（把这几条问用户，答案回填 novel_init）')
          for (const question of WRITING_PLAN_QUESTIONS) {
            if (!planGaps.some((gap) => gap.key === question.key)) continue
            body.push(`- ${question.question}（决定：${question.decides}）`)
          }
          body.push('', '## 常见口径（当选项给用户选，不要替他定）')
          for (const tier of LENGTH_BENCHMARKS) {
            body.push(`- ${tier.name}：${tier.targetWords} · 单章 ${tier.chapterWords} · ${tier.volumes}（${tier.note}）`)
          }
        }

        await resync(exec.agent?.session)
        return {
          ok: true,
          operation: 'init',
          detail: `项目已就绪：「${next.meta.title || '(untitled)'}」，已校准 ${String(Object.keys(next.baselines.medians).length)} 项指标中位，候选物料 ${String(next.naming.length)} 组。`,
          ...envelope(next, warnings),
          body,
        }
      },
    }),
  )

  // ── novel_plan ──────────────────────────────────────────────────────────────

  registerScoped(ctx,
    defineTool({
      name: 'novel_plan',
      description:
        'The planning pipeline, in the SOP order. One operation per step; each feeds the next, and the tool reports what '
        + 'is still missing. '
        + 'competitor=dismantle one same-genre leaderboard title (aim for 20–50) · pitch=the one-sentence memorable point '
        + 'plus core emotion, payoff list, differentiators, kernel · world=one world rule (a rule without its cost and '
        + 'limit is flagged) · outline=logline, acts, minimal viable outline, or the full outline · volume=one volume\'s '
        + 'goal, conflict, climax, end hook · chapter=one chapter contract (plot task, conflict, emotional payoff, '
        + 'information gap, beats, hook, target length) — the target is the finished length, and the chapter is drafted '
        + 'at 150% of it · beat=place a rhythm beat · opening=confirm an opening-engineering '
        + 'checklist item (omit `key` to list it) · naming=a candidate title/blurb/tag set. '
        + 'Soft gate: a call always succeeds, but when the SOP would not have you here yet the result carries warnings '
        + 'naming what is still missing. Read them before writing prose.',
      parameters: {
        operation: {
          type: 'string',
          required: true,
          enum: ['competitor', 'pitch', 'world', 'outline', 'volume', 'chapter', 'beat', 'opening', 'naming'],
          description: 'Which planning step to write.',
        },
        id: { type: 'string', description: 'Slug of the record; derived from title/name when omitted.' },
        title: { type: 'string', description: 'Title of the competitor / volume / chapter / naming candidate.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'competitor/naming: platform tags.' },
        blurb: { type: 'string', description: 'competitor/naming: the blurb, verbatim.' },
        openingEvent: { type: 'string', description: 'competitor: the event chapter one opens on.' },
        goldenFinger: { type: 'string', description: 'competitor: the protagonist\'s edge.' },
        protagonistDesire: { type: 'string', description: 'competitor: what the protagonist wants.' },
        antagonistMotive: { type: 'string', description: 'competitor: why the antagonist opposes them.' },
        shuangFrequency: { type: 'string', description: 'competitor: how often a payoff lands.' },
        emotionCurve: { type: 'string', description: 'competitor: the emotional curve.' },
        paywallPoint: { type: 'string', description: 'competitor: where the paywall or ramp lands.' },
        chapterHooks: { type: 'string', description: 'competitor: chapter-end hook patterns.' },
        commentKeywords: { type: 'array', items: { type: 'string' }, description: 'competitor: high-frequency comment words.' },
        takeaway: { type: 'string', description: 'competitor: what is reusable from it.' },
        memorablePoint: { type: 'string', description: 'pitch: 主角+世界+执念+能力+对抗+情绪，一句话。' },
        coreEmotion: { type: 'string', description: 'pitch: the core emotional payoff.' },
        shuangPoints: { type: 'array', items: { type: 'string' }, description: 'pitch: the payoff list.' },
        differentiators: { type: 'array', items: { type: 'string' }, description: 'pitch: how it differs from the comparables.' },
        kernel: { type: 'string', description: 'pitch: the theme underneath the plot.' },
        name: { type: 'string', description: 'world: display name of the rule or fact.' },
        kind: { type: 'string', description: 'world: place|faction|power-system|item|history|rule.' },
        detail: { type: 'string', description: 'world: the fact itself.' },
        cost: { type: 'string', description: 'world: what the rule costs.' },
        limits: { type: 'string', description: 'world: what the rule forbids.' },
        logline: { type: 'string', description: 'outline: the one-sentence story.' },
        acts: { type: 'array', items: { type: 'string' }, description: 'outline: act structure, one entry per act.' },
        minimal: { type: 'string', description: 'outline: the minimal viable outline summary.' },
        full: { type: 'boolean', description: 'outline: true records the full-outline stage as confirmed.' },
        number: { type: 'integer', description: 'volume/chapter/beat: the 1-based position.' },
        goal: { type: 'string', description: 'volume: what this volume accomplishes on its own.' },
        conflict: { type: 'string', description: 'volume/chapter: the conflict that carries it.' },
        climax: { type: 'string', description: 'volume: the volume\'s own climax.' },
        endHook: { type: 'string', description: 'volume: the hook that closes the volume.' },
        chapters: { type: 'array', items: { type: 'integer' }, description: 'volume: chapter range, inclusive.' },
        plotTask: { type: 'string', description: 'chapter: what this chapter must accomplish.' },
        emotionalPayoff: { type: 'string', description: 'chapter: what the reader gets emotionally.' },
        infoGap: { type: 'string', description: 'chapter: the information gap opened or closed.' },
        beats: { type: 'array', items: { type: 'string', enum: [...BEAT_KINDS] }, description: 'chapter: beats carried.' },
        hook: { type: 'string', description: 'chapter: the chapter-end hook.' },
        targetWords: {
          type: 'integer',
          description:
            'chapter: the finished target length in characters; the first draft is written to 150% of it. Optional — a '
            + 'chapter planned without one inherits the per-chapter length settled at initialization '
            + '(novel_init chapterWords).',
        },
        synopsis: { type: 'string', description: 'chapter: one-line summary of the contract.' },
        volume: { type: 'integer', description: 'chapter: which volume it belongs to.' },
        waive: {
          type: 'array',
          items: { type: 'string', enum: [...CONTRACT_FIELDS] },
          description: 'chapter: contract fields to waive explicitly, with `waiveReason`.',
        },
        waiveReason: { type: 'string', description: 'chapter: why those fields are waived.' },
        remove: { type: 'boolean', description: 'chapter: delete this chapter instead of writing it.' },
        beatKind: { type: 'string', enum: [...BEAT_KINDS], description: 'beat: which kind of beat.' },
        note: { type: 'string', description: 'beat/opening: one line on what happens, or the evidence.' },
        key: { type: 'string', description: 'opening: the checklist key; omit to list the checklist.' },
        done: { type: 'boolean', description: 'opening: confirm (true) or unconfirm (false).' },
        rationale: { type: 'string', description: 'naming: why this set should work.' },
        active: { type: 'boolean', description: 'naming: whether this is the published set.' },
      },
      output: { schema: ENVELOPE_SCHEMA, render: renderTool },
      execute: async (args, exec) => {
        const store = storeFor(exec.agent?.session)
        const current = await store.read()
        if (current === undefined) {
          throw new NovelInputError(`no novel project at ${store.documentPath}; call novel_init first`)
        }
        const warnings: string[] = []
        const body: string[] = []
        let detail = ''
        let changed = true

        switch (args.operation) {
          case 'competitor': {
            if (args.title === undefined || args.title.trim() === '') {
              throw new NovelInputError('operation="competitor" needs the comparable title')
            }
            const title = args.title
            const id = normalizeId(args.id) || normalizeId(title) || title.trim()
            const next = await store.update((state) => ({
              ...state,
              competitors: [
                ...state.competitors.filter((entry) => entry.id !== id),
                {
                  id,
                  title,
                  tags: args.tags ?? [],
                  blurb: args.blurb ?? '',
                  openingEvent: args.openingEvent ?? '',
                  goldenFinger: args.goldenFinger ?? '',
                  protagonistDesire: args.protagonistDesire ?? '',
                  antagonistMotive: args.antagonistMotive ?? '',
                  shuangFrequency: args.shuangFrequency ?? '',
                  emotionCurve: args.emotionCurve ?? '',
                  paywallPoint: args.paywallPoint ?? '',
                  chapterHooks: args.chapterHooks ?? '',
                  commentKeywords: args.commentKeywords ?? [],
                  takeaway: args.takeaway ?? '',
                },
              ],
              updatedAt: now(),
            }))
            detail = `已拆解竞品「${title}」（第 ${String(next.competitors.length)} 本）`
            if (next.competitors.length < 20) {
              warnings.push(`竞品拆解 ${String(next.competitors.length)}/20：SOP 要求 20–50 本才看得清赛道`)
            }
            break
          }
          case 'pitch': {
            const next = await store.update((state) =>
              updatePitch(
                state,
                {
                  ...(args.memorablePoint !== undefined && { memorablePoint: args.memorablePoint }),
                  ...(args.coreEmotion !== undefined && { coreEmotion: args.coreEmotion }),
                  ...(args.shuangPoints !== undefined && { shuangPoints: args.shuangPoints }),
                  ...(args.differentiators !== undefined && { differentiators: args.differentiators }),
                  ...(args.kernel !== undefined && { kernel: args.kernel }),
                },
                now,
              ),
            )
            detail = `立意已更新：${next.pitch.memorablePoint || '（记忆点仍为空）'}`
            break
          }
          case 'world': {
            const next = await store.update((state) =>
              upsertWorld(
                state,
                {
                  ...(args.id !== undefined && { id: args.id }),
                  ...(args.name !== undefined && { name: args.name }),
                  ...(args.kind !== undefined && { kind: args.kind }),
                  ...(args.detail !== undefined && { detail: args.detail }),
                  ...(args.cost !== undefined && { cost: args.cost }),
                  ...(args.limits !== undefined && { limits: args.limits }),
                },
                now,
              ),
            )
            const id = normalizeId(args.id) || normalizeId(args.name) || ''
            detail = `世界设定「${next.world[id]?.name ?? id}」已写入`
            const gap = worldGaps(next).find((entry) => entry.id === id)
            if (gap !== undefined) {
              warnings.push(`该设定缺 ${gap.missing.join('、')}：力量体系必须写明代价与限制，否则无法生成冲突`)
            }
            break
          }
          case 'outline': {
            const next = await store.update((state) =>
              updateOutline(
                state,
                {
                  ...(args.logline !== undefined && { logline: args.logline }),
                  ...(args.acts !== undefined && { acts: args.acts }),
                  ...(args.minimal !== undefined && { minimal: args.minimal }),
                  ...(args.full !== undefined && { fullOutlineDone: args.full }),
                },
                now,
              ),
            )
            detail = args.full === true ? '完整大纲已标记为确认' : '大纲已更新'
            void next
            break
          }
          case 'volume': {
            if (args.number === undefined || args.number <= 0) {
              throw new NovelInputError('operation="volume" needs a positive `number`')
            }
            const number = args.number
            const next = await store.update((state) =>
              upsertVolume(
                state,
                {
                  number,
                  title: args.title ?? '',
                  goal: args.goal ?? '',
                  conflict: args.conflict ?? '',
                  climax: args.climax ?? '',
                  endHook: args.endHook ?? '',
                  chapters: args.chapters ?? [],
                },
                now,
              ),
            )
            detail = `第 ${String(number)} 卷已写入`
            const written = next.outline.volumes.find((volume) => volume.number === number)
            if (written !== undefined && (written.goal === '' || written.climax === '')) {
              warnings.push(`第 ${String(number)} 卷缺独立目标或高潮：SOP 要求每卷有自己的矛盾与高潮`)
            }
            // The volume count was settled with the user at initialization; the
            // outline has to stay answerable to it, and 0 means 不分卷.
            const declared = next.writing.volumes
            const plannedVolumes = next.outline.volumes.length
            if (declared === 0) {
              warnings.push('写作参数登记为「不分卷」，却写入了分卷大纲：要么回 novel_init 定卷数，要么把这一卷并回单卷')
            } else if (declared > 0 && plannedVolumes > declared) {
              warnings.push(`已写入 ${String(plannedVolumes)} 卷，超过初始化与用户确认的 ${String(declared)} 卷：补问用户改卷数，或合并卷`)
            } else if (declared < 0) {
              warnings.push('是否分卷还没问用户：先回 novel_init 定 volumes（0 = 不分卷），再写分卷大纲')
            }
            if (written !== undefined && written.chapters.length >= 2) {
              const span = (written.chapters.at(-1) ?? 0) - (written.chapters[0] ?? 0) + 1
              const note = volumeLengthNote(span, next.writing)
              if (note !== undefined) warnings.push(`第 ${String(number)} 卷：${note}`)
            }
            break
          }
          case 'chapter': {
            if (args.remove === true) {
              if (args.id === undefined) throw new NovelInputError('operation="chapter" with remove needs an `id`')
              const id = args.id
              const next = await store.update((state) => removeChapter(state, id, now))
              detail = `已删除章节 ${id}`
              void next
              break
            }
            if (args.id === undefined && args.title === undefined) {
              throw new NovelInputError('operation="chapter" needs an `id` or a `title`')
            }
            const waived: Partial<Record<(typeof CONTRACT_FIELDS)[number], string>> = {}
            for (const field of args.waive ?? []) {
              waived[field as (typeof CONTRACT_FIELDS)[number]] = args.waiveReason ?? '作者显式放弃'
            }
            const chapterId = resolveChapterId({ id: args.id, title: args.title })
            const next = await store.update((state) => {
              // A chapter that states no target inherits the per-chapter length the
              // user settled at initialization, so the length check has
              // something to compare against instead of silently doing nothing.
              const targetWords = args.targetWords ?? state.writing.chapterWords
              return upsertChapter(
                state,
                {
                  id: chapterId,
                  ...(args.title !== undefined && { title: args.title }),
                  ...(args.number !== undefined && { number: args.number }),
                  ...(args.synopsis !== undefined && { synopsis: args.synopsis }),
                  ...(args.plotTask !== undefined && { plotTask: args.plotTask }),
                  ...(args.conflict !== undefined && { conflict: args.conflict }),
                  ...(args.emotionalPayoff !== undefined && { emotionalPayoff: args.emotionalPayoff }),
                  ...(args.infoGap !== undefined && { infoGap: args.infoGap }),
                  ...(args.beats !== undefined && { beats: args.beats as NovelState['chapters'][string]['beats'] }),
                  ...(args.hook !== undefined && { hook: args.hook }),
                  ...(targetWords > 0 && { targetWords }),
                  ...(args.volume !== undefined && { volume: args.volume }),
                  ...(Object.keys(waived).length > 0 && { waived }),
                },
                now,
              )
            })
            const chapter = next.chapters[chapterId]
            detail = chapter === undefined
              ? '章节已写入'
              : `第 ${String(chapter.number)} 章「${chapter.title || chapterId}」契约已写入`
            // The contract's targetWords is the finished length; the draft this
            // chapter is now written to is 150% of it. Print both at planning
            // time, which is the last moment before prose exists.
            if (chapter !== undefined && chapter.targetWords > 0) {
              const draft = draftTargetWords(chapter.targetWords)
              body.push('## 本章字数')
              body.push(
                `- 成稿目标 ${String(chapter.targetWords)} 字（读者看到的长度，允许 -5%/+15%）`,
                `- 初稿目标 ${String(draft)} 字 = 成稿目标 × 150%：初稿按这个写，去 AI 化与手改删减后才留得住成稿长度`,
              )
            }
            const gaps = contractGaps(next, { only: [chapterId] })
            if (gaps[0] !== undefined) warnings.push(`第 ${String(gaps[0].number)} 章契约缺：${gaps[0].missing.join('、')}`)
            if (chapter !== undefined && chapter.targetWords <= 0) {
              warnings.push(
                `第 ${String(chapter.number)} 章没设目标字数，写作参数里也没有单章字数：先问用户单章多少字`
                + `（novel_init chapterWords），否则正文长度无从核对`,
              )
            }
            if (chapter !== undefined && !next.outline.beats.some((beat) => beat.chapter === chapter.number)) {
              const expected = rhythmExpectation(
                chapter.number,
                chaptersPerVolume(next.writing.totalChapters, next.writing.volumes),
              )
              if (expected !== undefined) {
                warnings.push(
                  `第 ${String(chapter.number)} 章按节奏应为「${expected}」，节拍表里还没有：novel_plan operation="beat"`,
                )
              }
            }
            const planned = Object.values(next.chapters).filter((entry) => entry.body.trim() === '').length
            if (planned > next.writing.chapterPlanCeiling) {
              warnings.push(
                `细纲已达 ${String(planned)} 章，超过上限 ${String(next.writing.chapterPlanCeiling)}：SOP 建议滚动推进，不必一次写完`,
              )
            }
            break
          }
          case 'beat': {
            if (args.number === undefined || args.number <= 0) {
              throw new NovelInputError('operation="beat" needs a positive `number` (the chapter)')
            }
            const chapter = args.number
            await store.update((state) =>
              upsertBeat(
                state,
                { chapter, kind: (args.beatKind ?? 'shuang') as NovelState['outline']['beats'][number]['kind'], note: args.note ?? '' },
                now,
              ),
            )
            detail = `第 ${String(chapter)} 章节拍已写入（${args.beatKind ?? 'shuang'}）`
            break
          }
          case 'opening': {
            if (args.key === undefined) {
              changed = false
              body.push('## 开篇工程清单')
              for (const check of current.outline.opening) {
                body.push(
                  `- [${check.done ? 'x' : ' '}] ${check.key} — ${check.requirement}${check.note === '' ? '' : `（${check.note}）`}`,
                )
              }
              detail = `开篇工程清单：${String(current.outline.opening.filter((check) => check.done).length)}/${String(current.outline.opening.length)} 项已确认`
              break
            }
            const key = args.key
            await store.update((state) => setOpeningCheck(state, key, args.done ?? true, args.note ?? '', now))
            detail = `开篇清单项 ${key} 已${args.done === false ? '取消确认' : '确认'}`
            break
          }
          case 'naming': {
            const id = normalizeId(args.id) || normalizeId(args.title) || `candidate-${String(current.naming.length + 1)}`
            const candidate = {
              id,
              title: args.title ?? '',
              blurb: args.blurb ?? '',
              tags: args.tags ?? [],
              rationale: args.rationale ?? '',
              active: args.active ?? false,
            }
            const next = await store.update((state) => ({
              ...state,
              naming: [
                ...state.naming
                  .filter((entry) => entry.id !== id)
                  .map((entry) => (candidate.active ? { ...entry, active: false } : entry)),
                candidate,
              ],
              updatedAt: now(),
            }))
            detail = `候选物料「${candidate.title || id}」已记录`
            if (next.naming.length < 3) {
              warnings.push(`书名/简介/标签备选 ${String(next.naming.length)}/3：SOP 要求至少 3 组，验证阶段要逐个测`)
            }
            break
          }
          default: {
            throw new NovelInputError(`unknown planning operation ${JSON.stringify(args.operation)}`)
          }
        }

        const final = (await store.read()) ?? current
        await resync(exec.agent?.session)

        // The soft gate: report the SOP's own preconditions for wherever the
        // project now stands, without ever refusing the call.
        const assessment = assessStage(final)
        if (assessment.stage === 'planning') warnings.push(...assessment.blockers)
        if (final.outline.minimal.trim() !== '' || final.outline.logline.trim() !== '') {
          for (const gap of openingPackageGaps(final)) warnings.push(`开篇包未完成：${gap.requirement}`)
        }

        return {
          ok: changed,
          operation: args.operation,
          detail,
          ...envelope(final, warnings),
          ...(body.length > 0 ? { body } : {}),
        }
      },
    }),
  )

  // ── novel_bible ─────────────────────────────────────────────────────────────

  registerScoped(ctx,
    defineTool({
      name: 'novel_bible',
      description:
        'The story bible: cast, world facts, and reader promises. '
        + 'kind="character" wants the SOP spine — goal, and for a protagonist also fear, obsession, weakness, growth arc. '
        + 'kind="world" states a rule with its cost and limits (a rule without them is flagged). '
        + 'kind="link" records a promise the reader is now waiting on: plant it, give it a due chapter, say how it pays '
        + 'off. Promises are what the SOP closes at volume end — an open promise whose due chapter is already written is '
        + 'reported as overdue. '
        + 'kind="review" reports every gap across the bible: missing traits, rules without a price, and unrecovered or '
        + 'overdue promises.',
      parameters: {
        kind: {
          type: 'string',
          required: true,
          enum: ['character', 'world', 'link', 'review'],
          description: 'character | world | link | review.',
        },
        id: { type: 'string', description: 'Slug of the entry; derived from name/note when omitted.' },
        name: { type: 'string', description: 'character/world: display name; required when creating.' },
        role: { type: 'string', description: 'character: protagonist | antagonist | foil | …' },
        description: { type: 'string', description: 'character: appearance, voice, habits.' },
        goal: { type: 'string', description: 'character: what they want.' },
        fear: { type: 'string', description: 'character: what they are afraid of.' },
        obsession: { type: 'string', description: 'character: the obsession that makes them act against interest.' },
        weakness: { type: 'string', description: 'character: the weakness an opponent can press.' },
        camp: { type: 'string', description: 'character: protagonist-camp | rival | neutral | …' },
        growthArc: { type: 'string', description: 'character: the arc across the novel.' },
        notes: { type: 'string', description: 'character: continuity notes. world: the entry kind.' },
        appendNotes: { type: 'boolean', description: 'character: append to existing notes instead of replacing them.' },
        detail: { type: 'string', description: 'world: the fact itself.' },
        cost: { type: 'string', description: 'world: what it costs.' },
        limits: { type: 'string', description: 'world: what it forbids.' },
        worldKind: { type: 'string', description: 'world: place | faction | power-system | item | history | rule.' },
        note: { type: 'string', description: 'link: the promise as planted, in prose terms.' },
        linkKind: { type: 'string', description: 'link: foreshadow | mystery | hook | promise.' },
        plantedAt: { type: 'string', description: 'link: chapter id or number where it is planted.' },
        dueAt: { type: 'string', description: 'link: chapter id or number it must pay off by.' },
        payoff: { type: 'string', description: 'link: how it pays off.' },
        status: { type: 'string', enum: [...LINK_STATUSES], description: 'link: open | paid | abandoned.' },
        volume: { type: 'integer', description: 'link: the volume the payoff belongs to.' },
        remove: { type: 'boolean', description: 'link: delete this promise instead of writing it.' },
      },
      output: { schema: ENVELOPE_SCHEMA, render: renderTool },
      execute: async (args, exec) => {
        const store = storeFor(exec.agent?.session)
        const current = await store.read()
        if (current === undefined) {
          throw new NovelInputError(`no novel project at ${store.documentPath}; call novel_init first`)
        }
        const warnings: string[] = []
        const body: string[] = []
        let detail = ''

        if (args.kind === 'review') {
          const world = worldGaps(current)
          const cast = castGaps(current)
          const progress = progressOf(current)
          body.push('## 设定复核')
          body.push(`- 世界设定 ${String(Object.keys(current.world).length)} 条，缺代价/限制 ${String(world.length)} 条`)
          for (const gap of world) body.push(`  - ${gap.name}（${gap.id}）缺 ${gap.missing.join('、')}`)
          body.push(`- 人物 ${String(Object.keys(current.characters).length)} 位，缺要素 ${String(cast.length)} 位`)
          for (const gap of cast) body.push(`  - ${gap.name}（${gap.id}）缺 ${gap.missing.join('、')}`)
          body.push(
            `- 承诺未回收 ${String(progress.openLinks.length)} 条，逾期 ${String(progress.overdueLinks.length)} 条`,
          )
          for (const id of progress.overdueLinks) {
            const link = current.links[id]
            if (link !== undefined) body.push(`  - 逾期：${link.note}（应回收于 ${link.dueAt || '未定'}）`)
          }
          detail = `复核完成：世界缺口 ${String(world.length)}，人物缺口 ${String(cast.length)}，未回收承诺 ${String(progress.openLinks.length)}`
        } else if (args.kind === 'character') {
          const next = await store.update((state) =>
            upsertCharacter(
              state,
              {
                ...(args.id !== undefined && { id: args.id }),
                ...(args.name !== undefined && { name: args.name }),
                ...(args.role !== undefined && { role: args.role }),
                ...(args.description !== undefined && { description: args.description }),
                ...(args.goal !== undefined && { goal: args.goal }),
                ...(args.fear !== undefined && { fear: args.fear }),
                ...(args.obsession !== undefined && { obsession: args.obsession }),
                ...(args.weakness !== undefined && { weakness: args.weakness }),
                ...(args.camp !== undefined && { camp: args.camp }),
                ...(args.growthArc !== undefined && { growthArc: args.growthArc }),
                ...(args.notes !== undefined && { notes: args.notes }),
                ...(args.appendNotes !== undefined && { appendNotes: args.appendNotes }),
              },
              now,
            ),
          )
          const id = normalizeId(args.id) || normalizeId(args.name) || ''
          detail = `人物「${next.characters[id]?.name ?? id}」已写入（共 ${String(Object.keys(next.characters).length)} 位）`
          const gap = castGaps(next).find((entry) => entry.id === id)
          if (gap !== undefined) warnings.push(`该人物缺 ${gap.missing.join('、')}：SOP 要求主角有欲望、恐惧、执念、软肋与成长线`)
        } else if (args.kind === 'world') {
          const next = await store.update((state) =>
            upsertWorld(
              state,
              {
                ...(args.id !== undefined && { id: args.id }),
                ...(args.name !== undefined && { name: args.name }),
                ...(args.detail !== undefined && { detail: args.detail }),
                ...(args.cost !== undefined && { cost: args.cost }),
                ...(args.limits !== undefined && { limits: args.limits }),
                ...(args.worldKind !== undefined && { kind: args.worldKind }),
              },
              now,
            ),
          )
          const id = normalizeId(args.id) || normalizeId(args.name) || ''
          detail = `世界设定「${next.world[id]?.name ?? id}」已写入（共 ${String(Object.keys(next.world).length)} 条）`
          const gap = worldGaps(next).find((entry) => entry.id === id)
          if (gap !== undefined) warnings.push(`该设定缺 ${gap.missing.join('、')}：只写能力不写代价与限制，无法生成冲突`)
        } else if (args.remove === true) {
          if (args.id === undefined) throw new NovelInputError('kind="link" with remove needs an `id`')
          const id = args.id
          await store.update((state) => removeLink(state, id, now))
          detail = `已删除承诺 ${id}`
        } else {
          const next = await store.update((state) =>
            upsertLink(
              state,
              {
                ...(args.id !== undefined && { id: args.id }),
                ...(args.note !== undefined && { note: args.note }),
                ...(args.linkKind !== undefined && { kind: args.linkKind }),
                ...(args.plantedAt !== undefined && { plantedAt: args.plantedAt }),
                ...(args.dueAt !== undefined && { dueAt: args.dueAt }),
                ...(args.payoff !== undefined && { payoff: args.payoff }),
                ...(args.status !== undefined && { status: args.status }),
                ...(args.volume !== undefined && { volume: args.volume }),
              },
              now,
            ),
          )
          const id = normalizeId(args.id) || normalizeId(args.note) || ''
          detail = `承诺「${next.links[id]?.note.slice(0, 30) ?? id}」已写入（未回收 ${String(progressOf(next).openLinks.length)} 条）`
          if (args.dueAt === undefined || args.dueAt.trim() === '') {
            warnings.push('未给 dueAt：SOP 要求埋下时就写明回收章节，否则逾期无法判定')
          }
        }

        const final = (await store.read()) ?? current
        await resync(exec.agent?.session)
        const progress = progressOf(final)
        if (progress.overdueLinks.length > 0) {
          warnings.push(`有 ${String(progress.overdueLinks.length)} 条承诺已到回收章仍未回收：${progress.overdueLinks.join('、')}`)
        }
        return {
          ok: true,
          operation: args.kind,
          detail,
          ...envelope(final, warnings),
          ...(body.length > 0 ? { body } : {}),
        }
      },
    }),
  )

  // ── novel_verify ────────────────────────────────────────────────────────────

  registerScoped(ctx,
    defineTool({
      name: 'novel_verify',
      description:
        'The SOP validation gate. operation="round" records one small-cost test — editor submission, reader sample, '
        + 'author group, platform new-book window — with its metrics, and returns the verdict computed by comparing every '
        + 'reading against the calibrated same-genre medians: pass, partial, or fail. '
        + 'A round that does not pass must name where to fall back to and what would make you abandon the concept; the '
        + 'tool refuses the round without them, because that requirement is what stops validation from becoming a '
        + 'formality. '
        + 'operation="assess" reports the latest readings against the thresholds without recording a round. '
        + 'The numbers come from the platform or from readers; the tool compares and decides, it never invents a value.',
      parameters: {
        operation: { type: 'string', required: true, enum: ['round', 'assess'], description: 'round (record) | assess (report).' },
        channel: { type: 'string', description: 'round: editor | readers | author-group | platform.' },
        sampleSize: { type: 'integer', description: 'round: how many readers or titles the sample covers.' },
        period: {
          type: 'string',
          enum: ['new-book', 'paid', 'free'],
          description: 'round: which release period the metrics belong to; defaults to new-book.',
        },
        atChapter: { type: 'integer', description: 'round: the chapter position the reading describes.' },
        metrics: {
          type: 'object',
          additionalProperties: true,
          description: 'round: values keyed by metric, for example {"readThrough3": 0.42, "followRead10": 0.18}.',
        },
        source: { type: 'string', description: 'round: where the numbers came from.' },
        namingId: { type: 'string', description: 'round: which naming candidate this round tested, if any.' },
        fallback: { type: 'string', description: 'round: required when not passing — which phase to fall back to.' },
        abandonIf: { type: 'string', description: 'round: required when not passing — what would make you drop the concept.' },
        note: { type: 'string', description: 'round: your own reading of the reader reaction.' },
        readingId: { type: 'string', description: 'assess: a specific reading; defaults to the latest.' },
      },
      output: { schema: ENVELOPE_SCHEMA, render: renderTool },
      execute: async (args, exec) => {
        const store = storeFor(exec.agent?.session)
        const current = await store.read()
        if (current === undefined) {
          throw new NovelInputError(`no novel project at ${store.documentPath}; call novel_init first`)
        }
        const warnings: string[] = []
        const body: string[] = []

        const values: Partial<Record<MetricKey, number>> = {}
        for (const [key, value] of Object.entries(args.metrics ?? {})) {
          if (typeof value === 'number' && Number.isFinite(value)) Object.assign(values, { [key]: value })
          else warnings.push(`指标 "${key}" 不是数字，已忽略`)
        }

        const age = calibrationAge(current.baselines, new Date())
        if (age.stale) {
          warnings.push(
            age.days === undefined
              ? '尚未校准同类中位：阈值规则无法执行，本轮只能记录不能裁决（novel_init 的 baselines）'
              : `中位校准已 ${String(Math.round(age.days))} 天（SOP 要求近 30 天）：建议重新校准`,
          )
        }

        if (args.operation === 'assess') {
          const reading =
            args.readingId === undefined
              ? current.readings.at(-1)
              : current.readings.find((entry) => entry.id === args.readingId)
          if (reading === undefined) throw new NovelInputError('没有可评估的读数；先用 operation="round" 录入一轮')
          const assessments = assessReading(reading, current.baselines)
          const tally = tallyAssessments(assessments)
          body.push(`## 读数评估（${reading.id}，${reading.period}）`)
          for (const entry of assessments) body.push(`- ${entry.note}`)
          body.push('', `达标 ${String(tally.passed)} · 未达标 ${String(tally.failed)} · 无法比较 ${String(tally.incomparable)}`)
          for (const outcome of iterationRules(reading, assessments, current)) {
            body.push('', `## 触发规则 [${outcome.key}]`, `- ${outcome.label}`, `  动作：${outcome.action}（范围：${outcome.scope}）`)
            for (const evidence of outcome.evidence) body.push(`  依据：${evidence}`)
          }
          return {
            ok: true,
            operation: 'assess',
            detail: `读数 ${reading.id}：达标 ${String(tally.passed)}，未达标 ${String(tally.failed)}，无法比较 ${String(tally.incomparable)}`,
            ...envelope(current, warnings),
            body,
          }
        }

        const readingId = `reading-${String(current.readings.length + 1)}`
        const reading = {
          id: readingId,
          at: now(),
          period: (args.period ?? 'new-book') as MetricPeriod,
          atChapter: args.atChapter ?? 0,
          values,
          source: args.source ?? args.channel ?? '',
          note: args.note ?? '',
        }
        const assessments = assessReading(reading, current.baselines)
        const { verdict, reasons } = verdictFromAssessments(assessments)
        if (verdict !== 'pass' && (args.fallback === undefined || args.fallback.trim() === '')) {
          throw new NovelInputError(
            `验证结论为「${verdict}」，必须给出 fallback（回退到哪个阶段）才能完成这一轮——`
            + 'SOP 要求不通过的验证写明回退目标，否则验证会变成走过场',
          )
        }
        if (verdict !== 'pass' && (args.abandonIf === undefined || args.abandonIf.trim() === '')) {
          throw new NovelInputError(`验证结论为「${verdict}」，必须给出 abandonIf（什么情况下放弃该概念）`)
        }

        const round = current.verifications.length + 1
        const fallback = args.fallback ?? ''
        const abandonIf = args.abandonIf ?? ''
        const note = args.note ?? ''
        const channel = args.channel ?? ''
        const sampleSize = args.sampleSize ?? 0
        const namingId = args.namingId ?? ''
        const next = await store.update(
          (state) =>
            addReading(
              {
                ...state,
                verifications: [
                  ...state.verifications,
                  {
                    id: `round-${String(round)}`,
                    round,
                    at: reading.at,
                    channel,
                    sampleSize,
                    readingId,
                    namingId,
                    verdict,
                    reasons,
                    fallback,
                    abandonIf,
                    note,
                  },
                ],
              },
              reading,
              now,
            ),
        )

        body.push(`## 第 ${String(round)} 轮验证（${channel || '未注明渠道'}）`)
        for (const reason of reasons) body.push(`- ${reason}`)
        if (verdict !== 'pass') body.push('', `回退目标：${fallback}`, `放弃条件：${abandonIf}`)
        for (const outcome of iterationRules(reading, assessments, next)) {
          body.push('', `## 建议动作 [${outcome.key}]`, `- ${outcome.action}（范围：${outcome.scope}）`)
        }

        await resync(exec.agent?.session)
        return {
          ok: true,
          operation: 'round',
          detail: `第 ${String(round)} 轮验证结论：${verdict === 'pass' ? '通过' : verdict === 'partial' ? '部分通过' : '不通过'}`,
          ...envelope(next, warnings),
          body,
        }
      },
    }),
  )

  // ── novel_write ─────────────────────────────────────────────────────────────

  registerScoped(ctx,
    defineTool({
      name: 'novel_write',
      description:
        'Write or revise one chapter of prose against its outline contract. '
        + 'Send the COMPLETE chapter text — this replaces the body, it does not append. '
        + 'A first draft is written to 150% of the chapter\'s target length, because 去 AI 化 and hand-editing delete a '
        + 'large share of a draft; the finished chapter is then trimmed back to within -5%/+15% of the target the user '
        + 'gave — the shortfall is held to 5%, because a chapter noticeably under its promised length is the real '
        + 'failure, while an overrun can still be cut. This '
        + 'tool holds the draft to whichever gate the chapter\'s status implies (planned/drafting = 150%, revised/final = '
        + '-5%/+15%) and prints both windows. '
        + 'Report which contract fields the draft actually delivered (delivered=[...]); the tool compares that report '
        + 'with the plan and returns what was missed, what was never planned, and whether the length landed. That '
        + 'comparison is the SOP\'s "严格对应细纲" made checkable — it is the only place the workflow notices a chapter '
        + 'that quietly ignored its plan. '
        + 'Marking a chapter final (published) still works but is warned when the contract or the delivery is incomplete. '
        + 'Both write and check also return the SOP\'s 去 AI 化 statistics — paragraph length, dialogue density, repeated '
        + 'sentence openings — as countable symptoms and never as a verdict. Nothing here edits the prose: revise the '
        + 'draft yourself and send it back through operation="write". '
        + 'operation="read" returns one chapter with its contract and prose; operation="check" returns the delivery report '
        + 'and the same statistics without writing anything.',
      parameters: {
        operation: { type: 'string', enum: ['write', 'read', 'check'], description: 'write (default) | read | check.' },
        chapterId: { type: 'string', required: true, description: 'Id, slug, or title of the chapter.' },
        body: { type: 'string', description: 'write: the complete chapter prose.' },
        delivered: {
          type: 'array',
          items: { type: 'string', enum: [...CONTRACT_FIELDS] },
          description: 'write: the contract fields this draft reached.',
        },
        status: { type: 'string', enum: [...CHAPTER_STATUSES], description: 'write: planned | drafting | revised | final.' },
        title: { type: 'string', description: 'write: replace the chapter title.' },
      },
      output: { schema: ENVELOPE_SCHEMA, render: renderTool },
      execute: async (args, exec) => {
        const store = storeFor(exec.agent?.session)
        const current = await store.read()
        if (current === undefined) {
          throw new NovelInputError(`no novel project at ${store.documentPath}; call novel_init first`)
        }
        const chapter = resolveChapter(current, args.chapterId)
        const warnings: string[] = []
        const body: string[] = []
        const operation = args.operation ?? 'write'

        if (operation === 'read') {
          body.push(`## 第 ${String(chapter.number)} 章「${chapter.title || chapter.id}」`)
          for (const row of contractRows(chapter)) body.push(`- ${row.field}：${row.text || '（未写）'}`)
          body.push('', chapter.body.trim() === '' ? '（尚无正文）' : chapter.body)
          return {
            ok: false,
            operation: 'read',
            detail: `第 ${String(chapter.number)} 章：${String(chapter.wordCount)} 字，${chapter.status}`,
            ...envelope(current),
            body,
          }
        }

        if (operation === 'check') {
          const report = analyzeDelivery(chapter)
          body.push(`## 契约兑现（第 ${String(chapter.number)} 章）`)
          for (const field of report.fields) {
            body.push(
              `- ${field.field}：计划=${field.plannedAtAll ? '有' : '无'} 兑现=${field.delivered ? '是' : '否'}`
                + `${field.waived === undefined ? '' : `（已放弃：${field.waived}）`}`,
            )
          }
          body.push('', report.summary)
          pushLengthReport(body, chapter)
          pushStyleHints(body, chapter.body)
          return {
            ok: report.missed.length === 0,
            operation: 'check',
            detail: report.summary,
            ...envelope(current, report.missed.length > 0 ? [`未兑现：${report.missed.join('、')}`] : []),
            body,
          }
        }

        if (args.body === undefined) throw new NovelInputError('operation="write" needs the complete chapter text in `body`')
        const text = args.body

        const next = await store.update(
          (state) =>
            upsertChapter(
              state,
              {
                id: chapter.id,
                body: text,
                ...(args.title !== undefined && { title: args.title }),
                ...(args.status !== undefined && { status: args.status }),
                ...(args.delivered !== undefined && {
                  delivered: args.delivered as NovelState['chapters'][string]['delivered'],
                }),
              },
              now,
            ),
        )
        const written = next.chapters[chapter.id]
        if (written === undefined) throw new NovelInputError(`chapter ${chapter.id} vanished during the write`)
        const report = analyzeDelivery(written)

        body.push(`## 第 ${String(written.number)} 章「${written.title || written.id}」`, report.summary)
        if (report.missed.length > 0) {
          body.push('', '未兑现的计划项（正文没写到，或 delivered 没报）：')
          for (const field of report.missed) {
            body.push(`- ${field}：${report.fields.find((entry) => entry.field === field)?.planned ?? ''}`)
          }
        }
        if (report.unplanned.length > 0) body.push('', `细纲本身没写：${report.unplanned.join('、')}`)
        pushLengthReport(body, written)
        pushStyleHints(body, written.body)
        if (args.status === 'final') {
          const blockers = blockersToFinal(written)
          if (blockers.length > 0) {
            body.push('', '## 发布前检查（未阻止标记为 final）')
            for (const blocker of blockers) body.push(`- ${blocker}`)
            warnings.push(`标记 final 但存在未完成项：${blockers.join('；')}`)
          }
          body.push('', '## 合规自查（人工确认，工具不代替阅读）')
          for (const item of complianceChecklist(written)) body.push(`- [ ] ${item.key}：${item.item}`)
        }
        if (report.missed.length > 0) {
          warnings.push(`本次未兑现 ${String(report.missed.length)} 项契约：${report.missed.join('、')}`)
        }
        // Writing a chapter can push a promise past its due chapter; the SOP
        // closes promises at volume end, so the writer learns about it now.
        const overdue = progressOf(next).overdueLinks
        if (overdue.length > 0) {
          warnings.push(
            `有 ${String(overdue.length)} 条 promise 已到回收章仍未回收：${overdue.join('、')}`
            + '（novel_bible kind="link" status="paid" 回收，或调整 dueAt）',
          )
        }

        await resync(exec.agent?.session)
        return {
          ok: true,
          operation: 'write',
          detail: `第 ${String(written.number)} 章已写入：${String(written.wordCount)} 字，${written.status}`,
          ...envelope(next, warnings),
          body,
        }
      },
    }),
  )

  // ── novel_metrics ───────────────────────────────────────────────────────────

  registerScoped(ctx,
    defineTool({
      name: 'novel_metrics',
      description:
        'The SOP feedback loop: record platform readings, apply the quantified iteration rules, and close the loop on '
        + 'earlier changes. '
        + 'operation="record" stores one reading and immediately reports which rules fired, each with its action and the '
        + 'scope the change may reach (chapter / volume / whole-book) — the SOP\'s discipline is as much about how far a '
        + 'change may reach as about what to change. '
        + 'operation="iterate" writes the change you decided on into the ledger, tied to the reading that triggered it. '
        + 'operation="outcome" attaches a later reading to an iteration and reports whether it actually improved — that is '
        + 'what makes "连续 2–3 轮调整无效 → 切书止损" decidable instead of a feeling. '
        + 'operation="rules" prints the thresholds currently in force. '
        + 'The numbers come from the platform; the tool compares them against your calibrated medians and hands back a '
        + 'decision.',
      parameters: {
        operation: {
          type: 'string',
          required: true,
          enum: ['record', 'iterate', 'outcome', 'rules'],
          description: 'record | iterate | outcome | rules.',
        },
        period: { type: 'string', enum: ['new-book', 'paid', 'free'], description: 'record: release period.' },
        atChapter: { type: 'integer', description: 'record: chapter position the reading describes.' },
        metrics: {
          type: 'object',
          additionalProperties: true,
          description: 'record: values keyed by metric, for example {"chapterScore": 62, "followRead10": 0.11}.',
        },
        source: { type: 'string', description: 'record: where the numbers came from.' },
        note: { type: 'string', description: 'record/iterate/outcome: free-form observation.' },
        trigger: { type: 'string', description: 'iterate: the rule key that fired, or "manual".' },
        action: { type: 'string', description: 'iterate: what you decided to change.' },
        scope: { type: 'string', enum: ['chapter', 'volume', 'whole-book'], description: 'iterate: how far the change reaches.' },
        evidence: { type: 'string', description: 'iterate: the comparison that triggered it.' },
        baselineReadingId: { type: 'string', description: 'iterate: the reading it responds to; defaults to the latest.' },
        iterationId: { type: 'string', description: 'outcome: which iteration to close.' },
        outcomeReadingId: { type: 'string', description: 'outcome: the reading taken after the change; defaults to the latest.' },
      },
      output: { schema: ENVELOPE_SCHEMA, render: renderTool },
      execute: async (args, exec) => {
        const store = storeFor(exec.agent?.session)
        const current = await store.read()
        if (current === undefined) {
          throw new NovelInputError(`no novel project at ${store.documentPath}; call novel_init first`)
        }
        const warnings: string[] = []
        const body: string[] = []

        if (args.operation === 'rules') {
          const age = calibrationAge(current.baselines, new Date())
          body.push('## 当前生效的阈值')
          body.push(
            age.days === undefined
              ? '尚未校准同类中位：所有阈值不可用，请先在 novel_init 的 baselines 里录入'
              : `中位校准于 ${current.baselines.calibratedAt}（${String(Math.round(age.days))} 天前）${age.stale ? ' — 已超过 30 天，建议重新校准' : ''}`,
          )
          for (const metric of METRIC_KEYS) {
            const median = current.baselines.medians[metric]
            const multiplier = current.baselines.multipliers[metric] ?? DEFAULT_MULTIPLIERS[metric] ?? 0.8
            body.push(
              median === undefined
                ? `- ${metric}：未校准`
                : `- ${metric}：中位 ${String(median)} × ${String(multiplier)} = 触发线 ${String(Number((median * multiplier).toFixed(4)))}`,
            )
          }
          return {
            ok: true,
            operation: 'rules',
            detail: `已校准 ${String(Object.keys(current.baselines.medians).length)} 项指标`,
            ...envelope(current, warnings),
            body,
          }
        }

        if (args.operation === 'iterate') {
          if (args.action === undefined || args.action.trim() === '') {
            throw new NovelInputError('operation="iterate" needs the `action` you decided on')
          }
          const baselineReadingId = args.baselineReadingId ?? current.readings.at(-1)?.id ?? ''
          const id = `iteration-${String(current.iterations.length + 1)}`
          const action = args.action
          const next = await store.update(
            (state) =>
              addIteration(
                state,
                {
                  id,
                  at: now(),
                  trigger: args.trigger ?? 'manual',
                  evidence: args.evidence ?? '',
                  action,
                  scope: (args.scope ?? 'chapter') as 'chapter' | 'volume' | 'whole-book',
                  baselineReadingId,
                  outcomeReadingId: '',
                  outcome: 'unknown',
                  note: args.note ?? '',
                },
                now,
              ),
          )
          body.push(`基准读数：${baselineReadingId || '（无）'}`, '下一次读数后用 operation="outcome" 回填结果。')
          await resync(exec.agent?.session)
          return {
            ok: true,
            operation: 'iterate',
            detail: `迭代 ${id} 已记录：${action}（范围 ${args.scope ?? 'chapter'}）`,
            ...envelope(next, warnings),
            body,
          }
        }

        if (args.operation === 'outcome') {
          const iterationId = args.iterationId ?? current.iterations.at(-1)?.id
          if (iterationId === undefined) throw new NovelInputError('没有可回填的迭代记录')
          const outcomeReadingId = args.outcomeReadingId ?? current.readings.at(-1)?.id ?? ''
          const note = args.note
          const linked = await store.update((state) => ({
            ...state,
            iterations: state.iterations.map((iteration) =>
              iteration.id === iterationId
                ? {
                    ...iteration,
                    outcomeReadingId,
                    outcome: 'pending',
                    ...(note !== undefined && { note }),
                  }
                : iteration,
            ),
            updatedAt: now(),
          }))
          const iteration = linked.iterations.find((entry) => entry.id === iterationId)
          const judged = iteration === undefined ? undefined : judgeIteration(linked, iteration)
          const final =
            judged === undefined
              ? linked
              : await store.update((state) => ({
                  ...state,
                  iterations: state.iterations.map((entry) =>
                    entry.id === iterationId ? { ...entry, outcome: judged.improved ? 'effective' : 'ineffective' } : entry,
                  ),
                  updatedAt: now(),
                }))
          const ineffective = countIneffectiveIterations(final)
          if (ineffective >= 2) {
            warnings.push(
              `已累计 ${String(ineffective)} 轮调整无效：SOP 的切书止损条件是「连续 2–3 轮无效且核心指标长期低于中位 50%」，请核对读数`,
            )
          }
          body.push(judged?.note ?? '缺少可比读数，未判定有效性')
          await resync(exec.agent?.session)
          return {
            ok: true,
            operation: 'outcome',
            detail:
              judged === undefined
                ? `迭代 ${iterationId} 已关联读数 ${outcomeReadingId}（尚无可比较的基准）`
                : `迭代 ${iterationId} 结果：${judged.improved ? '有效' : '无效'} — ${judged.note}`,
            ...envelope(final, warnings),
            body,
          }
        }

        const values: Partial<Record<MetricKey, number>> = {}
        for (const [key, value] of Object.entries(args.metrics ?? {})) {
          if (typeof value === 'number' && Number.isFinite(value)) Object.assign(values, { [key]: value })
          else warnings.push(`指标 "${key}" 不是数字，已忽略`)
        }
        if (Object.keys(values).length === 0) {
          throw new NovelInputError('operation="record" needs at least one numeric metric value in `metrics`')
        }
        if (calibrationAge(current.baselines, new Date()).days === undefined) {
          warnings.push('尚未校准同类中位：读数已记录，但阈值规则无法执行（novel_init 的 baselines）')
        }
        const reading = {
          id: `reading-${String(current.readings.length + 1)}`,
          at: now(),
          period: (args.period ?? 'new-book') as MetricPeriod,
          atChapter: args.atChapter ?? 0,
          values,
          source: args.source ?? '',
          note: args.note ?? '',
        }
        const next = await store.update((state) => addReading(state, reading, now))
        const assessments = assessReading(reading, next.baselines)
        const tally = tallyAssessments(assessments)
        const outcomes = iterationRules(reading, assessments, next)

        body.push(`## 读数 ${reading.id}（${reading.period}）`)
        for (const entry of assessments) body.push(`- ${entry.note}`)
        body.push('', `达标 ${String(tally.passed)} · 未达标 ${String(tally.failed)} · 无法比较 ${String(tally.incomparable)}`)
        if (outcomes.length > 0) {
          body.push('', '## 触发的规则与动作')
          for (const outcome of outcomes) {
            body.push(`- [${outcome.key}] ${outcome.label}`, `  动作：${outcome.action}`, `  范围：${outcome.scope}`)
            for (const evidence of outcome.evidence) body.push(`  依据：${evidence}`)
          }
          body.push('', '决定后用 operation="iterate" 把动作写入台账。')
        }
        const open = next.iterations.filter((iteration) => iteration.outcomeReadingId === '')
        if (open.length > 0) {
          body.push('', `待回填结果的迭代：${open.map((iteration) => iteration.id).join('、')}（operation="outcome"）`)
        }
        await resync(exec.agent?.session)
        return {
          ok: true,
          operation: 'record',
          detail: `读数 ${reading.id} 已记录：达标 ${String(tally.passed)}，未达标 ${String(tally.failed)}，触发 ${String(outcomes.length)} 条规则`,
          ...envelope(next, warnings),
          body,
        }
      },
    }),
  )

  // ── novel_status ────────────────────────────────────────────────────────────

  registerScoped(ctx,
    defineTool({
      name: 'novel_status',
      description:
        'The SOP dashboard, entirely derived from the project — nothing here is a second ledger you maintain by hand. '
        + 'Reports the stage, what the next phase still needs, chapter and word counts, contract completeness, unpublished '
        + 'stock, promise recovery (including overdue), the latest reading against its thresholds, and iterations still '
        + 'waiting for an outcome. '
        + 'detail="dashboard" (default) is the operating view; "bible" returns cast, world and promises; "plan" returns '
        + 'pitch, outline, volumes, beats, opening checklist and naming candidates; "chapter" with a chapterId returns one '
        + 'chapter\'s contract, delivery report, the 去 AI 化 statistics and the prose.',
      parameters: {
        detail: {
          type: 'string',
          enum: ['dashboard', 'bible', 'plan', 'chapter'],
          description: 'dashboard (default) | bible | plan | chapter.',
        },
        chapterId: { type: 'string', description: 'detail="chapter": the chapter to return.' },
      },
      output: { schema: ENVELOPE_SCHEMA, render: renderTool },
      execute: async (args, exec) => {
        const store = storeFor(exec.agent?.session)
        const state = await store.read()
        const detected = await projects.verdictFor(exec.agent?.session)
        if (state === undefined) {
          throw new NovelInputError(`no novel project at ${store.documentPath}; call novel_init first`)
        }
        const body: string[] = []
        const detail = args.detail ?? 'dashboard'

        if (detail === 'bible') {
          body.push('## 人物')
          for (const character of Object.values(state.characters)) {
            body.push(`- ${character.name}（${character.id}，${character.role || '角色'}）：${character.goal || '（无目标）'}`)
            if (character.obsession !== '') body.push(`  执念：${character.obsession}`)
            if (character.weakness !== '') body.push(`  软肋：${character.weakness}`)
          }
          body.push('', '## 世界设定')
          for (const entry of Object.values(state.world)) {
            body.push(`- [${entry.kind}] ${entry.name}（${entry.id}）：${entry.detail}`)
            if (entry.cost !== '') body.push(`  代价：${entry.cost}`)
            if (entry.limits !== '') body.push(`  限制：${entry.limits}`)
          }
          body.push('', '## 承诺（伏笔/悬念）')
          for (const link of Object.values(state.links)) {
            body.push(`- [${link.status}] ${link.id}：${link.note}（埋 ${link.plantedAt || '—'} → 收 ${link.dueAt || '—'}）`)
          }
        } else if (detail === 'plan') {
          body.push(
            '## 篇幅（初始化四问）',
            describeWritingPlan(state.writing),
          )
          for (const gap of writingPlanGaps(state.writing)) {
            body.push(`- 未问用户：${gap.requirement}（${gap.fill}）`)
          }
          body.push(
            '',
            '## 立意',
            state.pitch.memorablePoint || '（未写）',
            `情绪：${state.pitch.coreEmotion || '—'}`,
            `内核：${state.pitch.kernel || '—'}`,
            '',
            '## 大纲',
            `一句话：${state.outline.logline || '—'}`,
            `最小可行：${state.outline.minimal || '—'}`,
          )
          if (state.outline.acts.length > 0) {
            body.push('', '三幕：', ...state.outline.acts.map((act, index) => `${String(index + 1)}. ${act}`))
          }
          body.push('', '## 分卷')
          for (const volume of state.outline.volumes) {
            body.push(
              `- 第 ${String(volume.number)} 卷「${volume.title || '—'}」目标=${volume.goal || '—'} 高潮=${volume.climax || '—'} 卷末钩子=${volume.endHook || '—'}`,
            )
          }
          body.push('', '## 节拍表')
          for (const beat of state.outline.beats) body.push(`- 第 ${String(beat.chapter)} 章 [${beat.kind}] ${beat.note}`)
          body.push('', '## 开篇工程清单')
          for (const check of state.outline.opening) body.push(`- [${check.done ? 'x' : ' '}] ${check.requirement}`)
          body.push('', '## 候选物料')
          for (const candidate of state.naming) {
            body.push(`- ${candidate.active ? '★' : ' '} ${candidate.title || '（无题）'} — ${candidate.blurb.slice(0, 40)}`)
          }
        } else if (detail === 'chapter') {
          const chapter = resolveChapter(state, args.chapterId)
          body.push(`## 第 ${String(chapter.number)} 章「${chapter.title || chapter.id}」（${chapter.status}）`)
          for (const row of contractRows(chapter)) body.push(`- ${row.field}：${row.text || '（未写）'}`)
          body.push('', analyzeDelivery(chapter).summary)
          pushLengthReport(body, chapter)
          pushStyleHints(body, chapter.body)
          body.push('', chapter.body.trim() === '' ? '（尚无正文）' : chapter.body)
        } else {
          const progress = progressOf(state)
          const chapters = Object.values(state.chapters).sort((a, b) => a.number - b.number)
          body.push(
            '## 章节',
            `共 ${String(progress.chapters)} 章 / ${String(progress.totalWords)} 字（已写 ${String(progress.chapters - progress.emptyChapters.length)}，`
              + `库存 ${String(progress.stockChapters)}/${String(state.writing.stockTargetChapters)}）`,
            `细纲完整 ${String(progress.contractedChapters)} 章 · 契约兑现 ${String(progress.deliveredChapters)} 章`,
          )
          if (progress.numberingIssues.length > 0) body.push(`章号异常：${progress.numberingIssues.join('、')}`)
          for (const chapter of chapters.slice(0, 30)) {
            const missing = missingContract(chapter)
            const draft = draftTargetWords(chapter.targetWords)
            body.push(
              `${String(chapter.number).padStart(3, ' ')}. [${chapter.status}] ${chapter.title || chapter.id}`
                + ` ${String(chapter.wordCount)} 字${chapter.targetWords > 0 ? `/${String(chapter.targetWords)}` : ''}`
                + `${draft > 0 ? `（初稿 ${String(draft)}）` : ''}`
                + `${missing.length > 0 ? ` ⚠缺${missing.join('/')}` : ''}`,
            )
          }
          if (chapters.length > 30) body.push(`… 另有 ${String(chapters.length - 30)} 章`)
          body.push('', '## 承诺', `未回收 ${String(progress.openLinks.length)} 条，逾期 ${String(progress.overdueLinks.length)} 条`)
          for (const id of progress.overdueLinks) {
            const link = state.links[id]
            if (link !== undefined) body.push(`- 逾期：${link.note}（应回收于 ${link.dueAt}）`)
          }
          body.push('', '## 最近读数')
          const latest = state.readings.at(-1)
          if (latest === undefined) {
            body.push('（还没有读数：用 novel_verify 或 novel_metrics 录入）')
          } else {
            body.push(`${latest.id}（${latest.period}，第 ${String(latest.atChapter)} 章）`)
            for (const entry of assessReading(latest, state.baselines)) body.push(`- ${entry.note}`)
          }
          const openIterations = state.iterations.filter((iteration) => iteration.outcomeReadingId === '')
          if (openIterations.length > 0) {
            body.push('', `## 待回填的迭代（${String(openIterations.length)}）`)
            for (const iteration of openIterations) body.push(`- ${iteration.id}：${iteration.action}（${iteration.scope}）`)
          }
          // A failed validation round is a standing instruction until it passes,
          // so the dashboard repeats its fallback and abandon condition: the SOP
          // checkpoint is precisely "did this round say where to go back to".
          const failedRounds = state.verifications.filter((round) => round.verdict !== 'pass')
          if (failedRounds.length > 0) {
            const last = failedRounds.at(-1)
            body.push('', '## 未通过的验证轮次')
            for (const round of failedRounds) {
              body.push(`- 第 ${String(round.round)} 轮（${round.channel || '未注明渠道'}）：${round.verdict}`)
              if (round.fallback !== '') body.push(`  回退目标：${round.fallback}`)
              if (round.abandonIf !== '') body.push(`  放弃条件：${round.abandonIf}`)
            }
            if (last !== undefined && last.verdict === 'fail') {
              body.push('', `⚠ 最近一轮验证不通过：按「${last.fallback || '未写回退目标'}」回退后再验`)
            }
          }
          // Reviews are model judgements, not ledger facts, so the dashboard
          // reports them as a separate line: something to re-read, never
          // something a threshold acts on.
          if (state.reviews.length > 0) {
            const last = state.reviews.at(-1)
            body.push(
              '',
              `## 模型评审（${String(state.reviews.length)} 次）`,
              last === undefined
                ? '—'
                : `最近：${last.kind}（${last.target || '项目'}）@ ${last.model}，${String(last.findings.length)} 条问题 · ${last.id}`,
            )
            if (last !== undefined && last.findings.length > 0) {
              body.push(...last.findings.slice(0, 3).map((finding) => `- [${finding.severity}] ${finding.dimension}：${finding.fix}`))
            }
          }
          body.push('', `工作区判定：${detected?.kind ?? 'unknown'}（${detected?.reason ?? '—'}）`)
          // Where the novel actually lives, because since the split a human is
          // expected to open these files in their own editor. Reported, never
          // prescribed: the files win over anything in memory.
          const index = state.index
          if (index !== undefined) {
            body.push(
              '',
              '## 内容文件（可直接编辑；文件为准）',
              `- 元数据与索引：${NOVEL_RELATIVE_PATH}`,
              `- 全书大纲：${index.outlineFile}`,
              `- 人物设定：${index.castFile}`,
              `- 世界观设定：${index.worldFile}`,
              `- 分卷大纲：${index.volumeFile}`,
              `- 章节大纲：${index.chapterPlanFile}`,
            )
            for (const chapter of Object.values(state.chapters).sort((a, b) => a.number - b.number)) {
              const ref = index.chapters[chapter.id]
              if (ref === undefined) continue
              body.push(`- 第 ${String(chapter.number)} 章：${ref.bodyFile} · 细纲 ${ref.outlineFile}`)
            }
          }
        }

        return {
          ok: true,
          operation: detail,
          detail: `${state.meta.title || '(untitled)'} · ${stageLabel(assessStage(state).stage)} · ${String(progressOf(state).totalWords)} 字`,
          ...envelope(state),
          body,
        }
      },
    }),
  )

  // ── novel_repo ──────────────────────────────────────────────────────────────

  registerScoped(ctx,
    defineTool({
      name: 'novel_repo',
      description:
        'The SOP closing phase: manuscript export, retrospective, IP assets, and reusable templates. '
        + 'operation="export" renders the whole novel to Markdown beside the project. '
        + 'operation="retro" writes the completion retrospective (highlights, problems) and derives the data summary, the '
        + 'IP asset list, and a structural template from the project data. '
        + 'operation="lesson" adds one reusable or avoid-this lesson; operation="asset" adds one IP-ready asset. '
        + 'operation="template" exports the structural skeleton on its own — acts, volume rhythm, beat pattern expressed as '
        + 'offsets inside a volume, hook patterns, emotional template. '
        + 'Templates deliberately carry no cast and no proper nouns: the SOP requires a variant upgrade next time, and a '
        + 'template that cannot carry characters cannot turn into a clone.',
      parameters: {
        operation: {
          type: 'string',
          required: true,
          enum: ['export', 'retro', 'asset', 'lesson', 'template'],
          description: 'export | retro | asset | lesson | template.',
        },
        path: { type: 'string', description: 'export/template: destination relative to the workspace root.' },
        includeContract: { type: 'boolean', description: 'export: include each chapter\'s task and hook as a blockquote.' },
        dataSummary: { type: 'string', description: 'retro: override the derived completion summary.' },
        highlights: { type: 'array', items: { type: 'string' }, description: 'retro: what worked.' },
        problems: { type: 'array', items: { type: 'string' }, description: 'retro: what failed.' },
        statement: { type: 'string', description: 'lesson: the lesson in one line.' },
        lessonKind: { type: 'string', enum: ['reuse', 'avoid'], description: 'lesson: reuse | avoid.' },
        area: { type: 'string', description: 'lesson: opening | rhythm | character | …' },
        evidence: { type: 'string', description: 'lesson: the evidence behind it.' },
        assetKind: { type: 'string', description: 'asset: character | setting | scene | quote | relationship | link.' },
        label: { type: 'string', description: 'asset: display label.' },
        content: { type: 'string', description: 'asset: the asset itself.' },
        source: { type: 'string', description: 'asset: which chapter it came from.' },
      },
      output: { schema: ENVELOPE_SCHEMA, render: renderTool },
      execute: async (args, exec) => {
        const store = storeFor(exec.agent?.session)
        const current = await store.read()
        if (current === undefined) {
          throw new NovelInputError(`no novel project at ${store.documentPath}; call novel_init first`)
        }
        const warnings: string[] = []
        const body: string[] = []

        if (args.operation === 'export') {
          const chapters = Object.values(current.chapters)
          if (chapters.length === 0) throw new NovelInputError('还没有章节可导出，先用 novel_plan 与 novel_write')
          const destination = args.path ?? DEFAULT_MANUSCRIPT_PATH
          const path = await store.writeDerived(
            destination,
            renderManuscript(current, { includeContract: args.includeContract ?? false }),
          )
          const words = chapters.reduce((total, chapter) => total + chapter.wordCount, 0)
          body.push(`导出 ${String(chapters.length)} 章 / ${String(words)} 字到 ${path}`)
          return {
            ok: true,
            operation: 'export',
            detail: `成稿已导出：${path}`,
            ...envelope(current, warnings),
            body,
          }
        }

        if (args.operation === 'retro') {
          const retro = buildRetrospective(
            current,
            { dataSummary: args.dataSummary, highlights: args.highlights, problems: args.problems },
            now,
          )
          const next = await store.update((state) => ({ ...state, retro, updatedAt: now() }))
          body.push('## 完本数据', retro.dataSummary)
          if (retro.highlights.length > 0) body.push('', '## 亮点', ...retro.highlights.map((item) => `- ${item}`))
          if (retro.problems.length > 0) body.push('', '## 问题', ...retro.problems.map((item) => `- ${item}`))
          body.push('', `已归档 IP 素材 ${String(retro.assets.length)} 项，导出结构模板「${retro.templates[0]?.name ?? '—'}」`)
          body.push('', '## 待补的复盘问题（工具不替你回答）', ...lessonPrompts().map((prompt) => `- ${prompt}`))
          await resync(exec.agent?.session)
          return {
            ok: true,
            operation: 'retro',
            detail: `复盘已写入（素材 ${String(retro.assets.length)} 项，模板 ${String(retro.templates.length)} 个）`,
            ...envelope(next, warnings),
            body,
          }
        }

        if (args.operation === 'lesson') {
          if (args.statement === undefined || args.statement.trim() === '') {
            throw new NovelInputError('operation="lesson" needs the lesson `statement`')
          }
          const statement = args.statement
          const kind = args.lessonKind === 'avoid' ? ('avoid' as const) : ('reuse' as const)
          const next = await store.update((state) => {
            const retro = state.retro ?? buildRetrospective(state, {}, now)
            const lesson = {
              id: normalizeId(statement) || `lesson-${String(retro.lessons.length + 1)}`,
              kind,
              statement,
              evidence: args.evidence ?? '',
              area: args.area ?? '',
            }
            return {
              ...state,
              retro: { ...retro, lessons: [...retro.lessons.filter((entry) => entry.id !== lesson.id), lesson] },
              updatedAt: now(),
            }
          })
          return {
            ok: true,
            operation: 'lesson',
            detail: `已记录${kind === 'avoid' ? '避雷' : '复用'}经验（共 ${String(next.retro?.lessons.length ?? 0)} 条）`,
            ...envelope(next, warnings),
            body,
          }
        }

        if (args.operation === 'asset') {
          if (args.label === undefined || args.label.trim() === '') {
            throw new NovelInputError('operation="asset" needs a `label`')
          }
          const label = args.label
          const next = await store.update((state) => {
            const retro = state.retro ?? buildRetrospective(state, {}, now)
            const asset = {
              id: normalizeId(label) || `asset-${String(retro.assets.length + 1)}`,
              kind: args.assetKind ?? 'scene',
              label,
              content: args.content ?? '',
              source: args.source ?? '',
            }
            return {
              ...state,
              retro: { ...retro, assets: [...retro.assets.filter((entry) => entry.id !== asset.id), asset] },
              updatedAt: now(),
            }
          })
          return {
            ok: true,
            operation: 'asset',
            detail: `已归档素材「${label}」（共 ${String(next.retro?.assets.length ?? 0)} 项）`,
            ...envelope(next, warnings),
            body,
          }
        }

        const template = buildTemplate(current, now)
        const fileName = `${normalizeId(template.name) || 'template'}.json`
        const destination = args.path ?? `${DEFAULT_TEMPLATE_PATH}/${fileName}`
        const path = await store.writeDerived(destination, `${JSON.stringify(template, null, 2)}\n`)
        body.push(
          `模板已导出：${path}`,
          '',
          `结构骨架：三幕 ${String(template.acts.length)} 条，分卷节奏 ${String(template.volumeRhythm.length)} 条，节拍 ${String(template.beatPattern.length)} 条`,
          `钩子模式：${template.hookPatterns.join('、') || '（未识别）'}`,
          '',
          template.note,
        )
        if (current.retro === undefined) {
          warnings.push('尚未写复盘（operation="retro"）：模板已导出，但经验教训未归档')
        }
        return {
          ok: true,
          operation: 'template',
          detail: `结构模板已导出：${path}`,
          ...envelope(current, warnings),
          body,
        }
      },
    }),
  )
}

/**
 * Register `novel_review`: the one tool that asks a model instead of computing.
 *
 * It is registered separately from {@link registerTools} because it depends on a
 * service the rest of the composer does not: without `llm` mounted there is
 * nothing to review *with*, and a tool that can only fail is worse than an
 * absent one. The eight deterministic tools therefore stay unconditional, and
 * this one appears exactly where a model route exists.
 *
 * What it will not do is as much of the contract as what it does: it never
 * writes a chapter, never overwrites published prose, and never lets a model
 * judgement into `iterations` or `verifications` — the ledger entries that the
 * SOP's thresholds act on. A review is recorded as a review, with the model and
 * the rubric version that produced it.
 *
 * @param ctx - plugin context carrying the tool registry and a model route.
 * @param projects - resolves the novel store per calling session.
 * @param settings - configured review route and timeout.
 */
export function registerReviewTool(ctx: Context, projects: ProjectResolver, settings: ReviewSettings): void {
  const storeFor = (session: { readonly header: { readonly cwd?: string } } | undefined): SessionStore =>
    projects.storeForSession(session)
  const now: Clock = () => new Date().toISOString()

  registerScoped(ctx,
    defineTool({
      name: 'novel_review',
      description:
        'Ask a model to judge the prose — the one tool here that does not compute. The other eight are deterministic: '
        + 'thresholds, gates and arithmetic, identical on every run. Judging whether writing reads as machine-made, '
        + 'whether an opening holds a reader, what a competitor is doing, and which lessons a finished book actually '
        + 'taught cannot be computed, and the SOP assigns it to judgement (§1.2). This tool asks for that judgement '
        + 'under a versioned rubric, and records the answer with the model and rubric version that produced it. '
        + 'operation="ai-flavor" diagnoses one chapter (add rewrite=true for a rewritten draft); "opening" reviews the '
        + 'gate chapters against the SOP opening checklist; "competitor" dismantles pasted competitor text; "retro" '
        + 'distils the project\'s own data into reusable lessons. '
        + 'It never writes prose: a rewrite is a proposal saved beside the project, and only novel_write replaces a '
        + 'chapter. competitor/retro results are returned for inspection and are NOT saved unless you pass save=true. '
        + 'The route follows reviewProvider/reviewModel when configured, otherwise the model this session is using.',
      parameters: {
        operation: {
          type: 'string',
          required: true,
          enum: [...REVIEW_KINDS],
          description: 'ai-flavor | opening | competitor | retro.',
        },
        chapterId: { type: 'string', description: 'ai-flavor: the chapter to diagnose.' },
        focus: {
          type: 'array',
          items: { type: 'string' },
          description: 'ai-flavor: limit the rubric to these dimensions, for example ["翻译腔", "整齐句式"].',
        },
        rewrite: {
          type: 'boolean',
          description: 'ai-flavor: also produce a rewritten draft (a second model call; the file is a proposal only).',
        },
        title: { type: 'string', description: 'competitor: the competitor\'s title.' },
        text: {
          type: 'string',
          description: 'competitor: the competitor material to dismantle — blurb, opening chapters, or both.',
        },
        save: {
          type: 'boolean',
          description:
            'competitor/retro: write the structured result into the project (competitors / retro lessons). Default false, '
            + 'so a model draft never enters the ledger unreviewed.',
        },
        maxChapters: { type: 'integer', description: 'opening: how many chapters to review. Default: the first gate.' },
        provider: { type: 'string', description: 'Override the provider for this one call.' },
        model: { type: 'string', description: 'Override the model for this one call.' },
      },
      output: { schema: ENVELOPE_SCHEMA, render: renderTool },
      execute: async (args, exec) => {
        const store = storeFor(exec.agent?.session)
        const state = await store.read()
        if (state === undefined) {
          throw new NovelInputError(`no novel project at ${store.documentPath}; call novel_init first`)
        }
        const operation = args.operation as ReviewKind
        const route = resolveRoute(ctx, settings, { provider: args.provider, model: args.model })
        if (route === undefined) {
          throw new NovelReviewError(
            'no model route for novel_review: select a model in this session, or set reviewProvider/reviewModel in the '
            + 'plugin config. The other eight tools never need one.',
          )
        }
        const warnings: string[] = []
        const body: string[] = []
        const id = `review-${String(state.reviews.length + 1)}`
        const target =
          operation === 'ai-flavor'
            ? resolveChapter(state, args.chapterId).id
            : operation === 'competitor'
              ? (args.title ?? '').trim()
              : ''
        const request = buildRequest(state, operation, args, store)
        const result = await runReview(ctx, route, request, {
          signal: exec.signal,
          timeoutMs: settings.timeoutMs,
        })
        const output = parseReviewOutput(result.text)
        if (!output.parsed) {
          warnings.push('模型没有按 JSON 约定回复：findings 无法入库，请查看记录文件里的完整回复')
        }
        if (result.truncated) {
          warnings.push(`模型输出被 maxTokens 截断（${String(result.finish)}），结论可能不完整`)
        }
        const artifact = await store.writeDerived(
          `${DEFAULT_REVIEW_PATH}/${id}-${operation}.md`,
          transcript({ id, operation, target, route: `${route.provider}/${route.model}`, output, model: route.model }),
        )

        let rewritten = ''
        if (operation === 'ai-flavor' && args.rewrite === true) {
          const chapter = resolveChapter(state, args.chapterId)
          const second = await runReview(
            ctx,
            route,
            buildRewriteRequest({ state, chapter, findings: output.findings }),
            { signal: exec.signal, timeoutMs: settings.timeoutMs },
          )
          rewritten = await store.writeDerived(
            `${DEFAULT_REVIEW_PATH}/${id}-rewrite.md`,
            `${second.text.trim()}\n`,
          )
        }

        const saved = await persist(state, operation, args, output, store)
        const review: ReviewRecord = {
          id,
          at: now(),
          kind: operation,
          target,
          provider: route.provider,
          model: route.model,
          promptVersion: REVIEW_PROMPT_VERSION,
          summary: output.summary,
          findings: output.findings,
          artifact: `${DEFAULT_REVIEW_PATH}/${id}-${operation}.md`,
        }
        const next = await store.update((current) => addReview(current, review))

        body.push(`模型：${route.provider}/${route.model}（${route.source === 'call' ? '本次指定' : route.source === 'config' ? '插件配置' : '会话默认'}）`)
        body.push(...renderReview(output, `${operation} 诊断`))
        if (output.lessons !== undefined && output.lessons.length > 0) {
          body.push('', `## 经验（${String(output.lessons.length)} 条）`)
          for (const lesson of output.lessons) {
            body.push(`- [${lesson.kind === 'avoid' ? '避雷' : '复用'}] ${lesson.statement}｜证据：${lesson.evidence}`)
          }
        }
        if (saved !== '') body.push('', saved)
        body.push('', `记录文件：${artifact}`, `评审编号：${id}（prompt ${REVIEW_PROMPT_VERSION}）`)
        if (rewritten !== '') {
          body.push('', '## 改写稿（提案，未写入章节）', `文件：${rewritten}`, '')
          body.push('确认后把正文发给 novel_write 覆盖该章；工具不会自动改稿。')
        }
        if (operation === 'ai-flavor' && args.rewrite !== true) {
          const mechanical = styleObservations(resolveChapter(state, args.chapterId).body)
          if (mechanical.length > 0) {
            body.push('', '机械统计（可复现的对照项）：')
            for (const observation of mechanical) body.push(`- ${observation}`)
          }
        }
        if (operation === 'competitor' && args.save !== true) {
          body.push('', '尚未入库：确认拆解可用后重跑并加 save=true，或用 novel_plan operation="competitor" 手工录入。')
        }
        if (operation === 'retro' && args.save !== true && (output.lessons?.length ?? 0) > 0) {
          body.push('', '尚未归档：确认后用 save=true 写入复盘经验，或用 novel_repo operation="lesson" 逐条录入。')
        }
        return {
          ok: true,
          operation,
          detail: `第 ${String(next.reviews.length)} 次模型评审：${operation}（${route.provider}/${route.model}，`
            + `${String(output.findings.length)} 条问题${rewritten === '' ? '' : '，附改写稿'}）`,
          ...envelope(next, warnings),
          body,
        }
      },
    }),
  )
}

/** The arguments `novel_review` accepts, as the tool declares them. */
type ReviewArgs = Record<string, unknown> & {
  readonly chapterId?: string | undefined
  readonly focus?: readonly string[] | undefined
  readonly title?: string | undefined
  readonly text?: string | undefined
  readonly maxChapters?: number | undefined
}

/**
 * Build the request for one review operation.
 *
 * @param state - the project.
 * @param operation - which judgement to ask for.
 * @param args - the tool arguments.
 * @param store - the store, for error messages that name the document.
 * @returns the framed request.
 * @throws {NovelInputError} when the operation's own inputs are missing.
 */
function buildRequest(
  state: NovelState,
  operation: ReviewKind,
  args: ReviewArgs,
  store: SessionStore,
): ReturnType<typeof buildAiFlavorRequest> {
  if (operation === 'ai-flavor') {
    const chapter = resolveChapter(state, args.chapterId)
    if (chapter.body.trim() === '') {
      throw new NovelInputError(`第 ${String(chapter.number)} 章还没有正文，无法做去 AI 化诊断`)
    }
    return buildAiFlavorRequest({ state, chapter, focus: args.focus })
  }
  if (operation === 'opening') {
    const gates = state.writing.openingGateChapters
    const gate = gates.length > 0 ? Math.max(...gates) : 3
    const count = Math.max(1, Math.min(args.maxChapters ?? Math.min(gate, 3), 10))
    const chapters = Object.values(state.chapters)
      .sort((a, b) => a.number - b.number)
      .filter((chapter) => chapter.body.trim() !== '')
      .slice(0, count)
    if (chapters.length === 0) {
      throw new NovelInputError(`没有可体检的正文（${store.documentPath} 里还没有写出任何一章）`)
    }
    return buildOpeningRequest({ state, chapters, checks: state.outline.opening, gate })
  }
  if (operation === 'competitor') {
    if (args.text === undefined || args.text.trim() === '') {
      throw new NovelInputError('operation="competitor" needs the competitor material in `text`')
    }
    return buildCompetitorRequest({ state, title: args.title ?? '（未命名竞品）', text: args.text })
  }
  return buildRetroRequest({
    state,
    progress: progressOf(state),
    readings: state.readings,
    iterations: state.iterations,
    lessons: state.retro?.lessons ?? [],
  })
}

/**
 * Apply a review's structured result to the project, when asked to.
 *
 * Kept separate from recording the review itself: the review always lands in
 * the ledger, while the *content* it produced only lands when the author says
 * so, because a model draft is not yet a fact about the book.
 *
 * @param state - the project as read before the call.
 * @param operation - which judgement was asked for.
 * @param args - the tool arguments.
 * @param output - the parsed reply.
 * @param store - the store to write through.
 * @returns a line describing what was saved, or `''` when nothing was.
 */
async function persist(
  state: NovelState,
  operation: ReviewKind,
  args: ReviewArgs,
  output: ReturnType<typeof parseReviewOutput>,
  store: SessionStore,
): Promise<string> {
  const now = (): string => new Date().toISOString()
  if (operation === 'competitor' && args.save === true && output.dismantle !== undefined) {
    const draft = output.dismantle
    const title = draft.title === '' ? (args.title ?? '').trim() : draft.title
    const id = normalizeId(title) || normalizeId(args.title ?? '') || `competitor-${String(state.competitors.length + 1)}`
    const next = await store.update((current) => ({
      ...current,
      competitors: [...current.competitors.filter((entry) => entry.id !== id), { ...draft, id, title }],
      updatedAt: now(),
    }))
    return `已入库竞品「${title}」（第 ${String(next.competitors.length)} 本）`
  }
  if (operation === 'retro' && args.save === true && (output.lessons?.length ?? 0) > 0) {
    if (state.retro === undefined) {
      return '未归档经验：还没有复盘记录，先执行 novel_repo operation="retro"'
    }
    const lessons: Lesson[] = (output.lessons ?? []).map((lesson, index) => ({
      id: normalizeId(lesson.statement) || `lesson-review-${String(index + 1)}`,
      kind: lesson.kind,
      statement: lesson.statement,
      evidence: lesson.evidence,
      area: lesson.area,
    }))
    const retro = state.retro
    const next = await store.update((current) => ({
      ...current,
      retro: {
        ...(current.retro ?? retro),
        lessons: [
          ...(current.retro ?? retro).lessons.filter((entry) => !lessons.some((added) => added.id === entry.id)),
          ...lessons,
        ],
      },
      updatedAt: now(),
    }))
    return `已归档经验 ${String(lessons.length)} 条（共 ${String(next.retro?.lessons.length ?? 0)} 条）`
  }
  return ''
}

/**
 * Render the transcript kept beside the project.
 *
 * The raw reply is included on purpose: when a summary disagrees with the
 * findings, or parsing failed, the verbatim answer is the only way to tell
 * whether the model misbehaved or the rubric did.
 *
 * @param input - the review's identity and its parsed output.
 * @returns the Markdown document.
 */
function transcript(input: {
  readonly id: string
  readonly operation: ReviewKind
  readonly target: string
  readonly route: string
  readonly model: string
  readonly output: ReturnType<typeof parseReviewOutput>
}): string {
  const lines = [
    `# ${input.id} · ${input.operation}`,
    '',
    `- 时间：${new Date().toISOString()}`,
    `- 模型：${input.route}`,
    `- 提示词版本：${REVIEW_PROMPT_VERSION}`,
    `- 对象：${input.target === '' ? '（项目）' : input.target}`,
    `- 结构化解析：${input.output.parsed ? '成功' : '失败'}`,
    '',
    '## 总评',
    '',
    input.output.summary === '' ? '（无）' : input.output.summary,
    '',
    '## 问题',
    '',
  ]
  if (input.output.findings.length === 0) {
    lines.push('（无）')
  } else {
    for (const finding of input.output.findings) {
      lines.push(
        `### [${finding.severity}] ${finding.dimension}`,
        '',
        finding.quote === '' ? '' : `> ${finding.quote}`,
        '',
        `- 原因：${finding.why}`,
        `- 改法：${finding.fix}`,
        '',
      )
    }
  }
  if (input.output.dismantle !== undefined) {
    lines.push('## 竞品拆解', '', '```json', JSON.stringify(input.output.dismantle, null, 2), '```', '')
  }
  if (input.output.lessons !== undefined) {
    lines.push('## 经验', '', '```json', JSON.stringify(input.output.lessons, null, 2), '```', '')
  }
  lines.push('## 模型原始回复', '', '```', input.output.raw.trim(), '```', '')
  return lines.join('\n')
}

/**
 * Find a chapter by id, normalized id, or title.
 *
 * @param state - the state to search.
 * @param reference - the caller-supplied id, slug, or title.
 * @returns the matching chapter.
 * @throws {NovelInputError} when nothing matches.
 */
function resolveChapter(state: NovelState, reference: string | undefined): NovelState['chapters'][string] {
  const raw = reference?.trim() ?? ''
  const known = Object.keys(state.chapters).join(', ') || '(none)'
  if (raw === '') throw new NovelInputError(`a chapter reference is required; known ids: ${known}`)
  const normalized = normalizeId(raw)
  const found =
    state.chapters[raw]
    ?? state.chapters[normalized]
    ?? Object.values(state.chapters).find((chapter) => chapter.title === raw)
  if (found === undefined) throw new NovelInputError(`no chapter matches ${JSON.stringify(raw)}; known ids: ${known}`)
  return found
}
