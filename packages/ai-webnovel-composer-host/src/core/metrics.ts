/**
 * Pure metric assessment: turn readings and baselines into verdicts and actions.
 *
 * This module exists because the SOP's iteration rules were unexecutable as
 * written. "三章读完低于同类中位 ×0.8" needs two things the prose never
 * supplied: the median, recorded somewhere durable, and a computation. Here the
 * medians are data ({@link MetricBaselines}), the multipliers are data with
 * defaults, and the comparison produces a decision instead of advice.
 *
 * The tool never invents a reading — a number only exists because a human or a
 * platform reported it — so everything here is a pure function of what was
 * recorded.
 *
 * @module @ai-webnovel/composer-host/core/metrics
 */

import type {
  ChangeScope,
  Iteration,
  MetricBaselines,
  MetricKey,
  MetricPeriod,
  MetricReading,
  NovelState,
  VerdictLevel,
} from './types.ts'

/** Direction a metric is read in. */
export const METRIC_DIRECTIONS: Readonly<Record<MetricKey, 'higher-better' | 'lower-better'>> = {
  clickRate: 'higher-better',
  readThrough3: 'higher-better',
  followRead10: 'higher-better',
  followRead24h: 'higher-better',
  retention7d: 'higher-better',
  favoriteRate: 'higher-better',
  firstSubscription: 'higher-better',
  averageSubscription: 'higher-better',
  collectToSubscribe: 'higher-better',
  followSubscription: 'higher-better',
  subscription24h: 'higher-better',
  completionRate: 'higher-better',
  retention: 'higher-better',
  adUnlock: 'higher-better',
  averageReadPerChapter: 'higher-better',
  // An author-reported quality score is the one metric where low is bad and the
  // threshold is absolute rather than relative to a median.
  chapterScore: 'higher-better',
}

/**
 * Default trigger lines, one per metric, as a fraction of the same-genre median.
 *
 * These are the SOP's numbers where the SOP gave one (三章读完 ×0.8, 10 章追读
 * ×0.7, 收藏转化 ×0.8, 整卷 ×0.6, 全书 ×0.5). The rest follow the same shape so
 * every metric is assessable; a deployment overrides any of them per metric
 * through {@link MetricBaselines.multipliers}.
 */
export const DEFAULT_MULTIPLIERS: Readonly<Partial<Record<MetricKey, number>>> = {
  clickRate: 0.8,
  readThrough3: 0.8,
  followRead10: 0.7,
  followRead24h: 0.75,
  retention7d: 0.8,
  favoriteRate: 0.8,
  firstSubscription: 0.75,
  averageSubscription: 0.75,
  collectToSubscribe: 0.8,
  followSubscription: 0.75,
  subscription24h: 0.75,
  completionRate: 0.8,
  retention: 0.8,
  adUnlock: 0.8,
  // The SOP names ×0.6 for "整卷节奏崩"; the other reading metrics sit at 0.8.
  averageReadPerChapter: 0.6,
  chapterScore: 0.6,
}

/** How many consecutive declining readings fire the sustained-decline rule. */
export const SUSTAINED_DECLINE_CHAPTERS = 5

/** How many ineffective iterations make the next verdict "cut the book". */
export const INEFFECTIVE_ITERATIONS_FOR_CUT = 2

/**
 * The sustained-depression line for the cut-loss rule: the SOP says "长期低于
 * 同类中位 50% 以上". This is deliberately separate from the per-metric trigger
 * multipliers because it answers a different question — not "is this reading
 * below par" but "has this book been running at half the market for long enough
 * that no amount of adjustment will save it".
 */
export const CUT_LOSS_MULTIPLIER = 0.5

/** Which metrics belong to which period, for a reading's completeness check. */
export const PERIOD_METRICS: Readonly<Record<MetricPeriod, readonly MetricKey[]>> = {
  'new-book': ['clickRate', 'readThrough3', 'followRead10', 'followRead24h', 'retention7d', 'favoriteRate'],
  paid: ['firstSubscription', 'averageSubscription', 'collectToSubscribe', 'followSubscription', 'subscription24h'],
  free: ['completionRate', 'retention', 'adUnlock', 'averageReadPerChapter'],
}

/** The outcome of comparing one metric against its baseline. */
export interface MetricAssessment {
  /** Which metric. */
  readonly metric: MetricKey
  /** The recorded value. */
  readonly value: number
  /** The baseline it was compared against, or `undefined` when none is calibrated. */
  readonly baseline: number | undefined
  /** The trigger line the value had to clear, or `undefined` without a baseline. */
  readonly threshold: number | undefined
  /** Whether the value cleared the line. `undefined` when incomparable. */
  readonly passed: boolean | undefined
  /** One line naming the comparison, for the tool output. */
  readonly note: string
}

/** One SOP rule that fired, with the action and scope it implies. */
export interface RuleOutcome {
  /** Stable rule key, used as the iteration's trigger. */
  readonly key: string
  /** The SOP rule in one line. */
  readonly label: string
  /** The comparisons behind it. */
  readonly evidence: readonly string[]
  /** What to do. */
  readonly action: string
  /** How far the change may reach. */
  readonly scope: ChangeScope
  /** Severity, for ordering: higher is more serious. */
  readonly severity: number
}

/**
 * The trigger line for one metric.
 *
 * @param metric - the metric.
 * @param baselines - the calibrated baselines.
 * @returns the threshold, or `undefined` when no median exists for the metric.
 */
export function thresholdFor(metric: MetricKey, baselines: MetricBaselines): number | undefined {
  const median = baselines.medians[metric]
  if (median === undefined || !Number.isFinite(median)) return undefined
  const multiplier = baselines.multipliers[metric] ?? DEFAULT_MULTIPLIERS[metric] ?? 0.8
  return median * multiplier
}

/**
 * Whether a reading matches the calibration's staleness tolerance.
 *
 * The SOP calibrates medians against the last 30 days; a calibration from long
 * ago silently makes every threshold wrong, so the age is reported rather than
 * trusted.
 *
 * @param baselines - the baselines.
 * @param now - the instant to measure from.
 * @param maxAgeDays - how old a calibration may be and still be called current.
 * @returns the age in days, and whether it is stale.
 */
export function calibrationAge(
  baselines: MetricBaselines,
  now: Date,
  maxAgeDays = 30,
): { readonly days: number | undefined; readonly stale: boolean } {
  if (baselines.calibratedAt === '') return { days: undefined, stale: true }
  const at = Date.parse(baselines.calibratedAt)
  if (!Number.isFinite(at)) return { days: undefined, stale: true }
  const days = (now.getTime() - at) / 86_400_000
  return { days, stale: days > maxAgeDays }
}

/**
 * Compare one reading against the baselines.
 *
 * @param reading - the reading to assess.
 * @param baselines - the calibrated baselines.
 * @returns one assessment per recorded metric, in a stable order.
 */
export function assessReading(
  reading: MetricReading,
  baselines: MetricBaselines,
): MetricAssessment[] {
  const metrics = Object.keys(reading.values).sort() as MetricKey[]
  return metrics.map((metric) => {
    const value = reading.values[metric]
    if (value === undefined) {
      return { metric, value: Number.NaN, baseline: undefined, threshold: undefined, passed: undefined, note: '' }
    }
    const baseline = baselines.medians[metric]
    const threshold = thresholdFor(metric, baselines)
    if (baseline === undefined || threshold === undefined) {
      return {
        metric,
        value,
        baseline,
        threshold,
        passed: undefined,
        note: `${metric} = ${String(value)}；未校准同类中位，无法比较（先在 novel_init 的 baselines 里录入）`,
      }
    }
    const passed = value >= threshold
    const ratio = baseline === 0 ? undefined : value / baseline
    return {
      metric,
      value,
      baseline,
      threshold,
      passed,
      note:
        `${metric} = ${String(value)}，同类中位 ${String(baseline)}`
        + `，触发线 ${String(Number(threshold.toFixed(4)))}`
        + `${ratio === undefined ? '' : `（为中位的 ${ratio.toFixed(2)} 倍）`}`
        + ` → ${passed ? '达标' : '低于阈值'}`,
    }
  })
}

/**
 * How many of one reading's metrics cleared their line.
 *
 * @param assessments - the assessments for one reading.
 * @returns counts of passing, failing, and incomparable metrics.
 */
export function tallyAssessments(assessments: readonly MetricAssessment[]): {
  readonly passed: number
  readonly failed: number
  readonly incomparable: number
} {
  let passed = 0
  let failed = 0
  let incomparable = 0
  for (const entry of assessments) {
    if (entry.passed === true) passed += 1
    else if (entry.passed === false) failed += 1
    else incomparable += 1
  }
  return { passed, failed, incomparable }
}

/**
 * The verdict a validation round earns from its reading.
 *
 * The SOP defines three outcomes (通过 / 部分通过 / 不通过) but not the boundary;
 * this fixes it: nothing failing is a pass, anything failing is a partial, and a
 * fail requires a *core* metric — the ones the SOP names as gates — to fail.
 *
 * @param assessments - the assessments for the round's reading.
 * @returns the verdict and the reasons behind it.
 */
export function verdictFromAssessments(assessments: readonly MetricAssessment[]): {
  readonly verdict: VerdictLevel
  readonly reasons: readonly string[]
} {
  const core: MetricKey[] = ['readThrough3', 'followRead10', 'clickRate', 'favoriteRate']
  const failures = assessments.filter((entry) => entry.passed === false)
  const coreFailures = failures.filter((entry) => core.includes(entry.metric))
  const incomparable = assessments.filter((entry) => entry.passed === undefined)
  const reasons = failures.map((entry) => entry.note)
  if (incomparable.length > 0) reasons.push(...incomparable.map((entry) => entry.note))

  if (assessments.length === 0) {
    return { verdict: 'fail', reasons: ['这一轮没有录入任何指标，无法裁决'] }
  }
  if (failures.length === 0) {
    const note =
      incomparable.length === 0
        ? '全部指标达标'
        : `已录入的指标全部达标；另有 ${String(incomparable.length)} 项因未校准中位而无法比较（不阻塞通过，但请补校准）`
    return { verdict: 'pass', reasons: [note, ...reasons] }
  }
  if (coreFailures.length === 0) {
    return {
      verdict: 'partial',
      reasons: [`非核心指标未达标 ${String(failures.length)} 项，可先改物料再验一轮`, ...reasons],
    }
  }
  return {
    verdict: 'fail',
    reasons: [`核心指标未达标：${coreFailures.map((entry) => entry.metric).join('、')}`, ...reasons],
  }
}

/**
 * The SOP's iteration rules, applied to a reading.
 *
 * Each outcome carries the action *and* the scope, because the SOP's discipline
 * is as much about how far a change may reach as about what to change.
 *
 * @param reading - the reading just recorded.
 * @param assessments - its assessments.
 * @param state - the project, for the iteration history the cut-loss rule needs.
 * @returns the rules that fired, most severe first.
 */
export function iterationRules(
  reading: MetricReading,
  assessments: readonly MetricAssessment[],
  state: NovelState,
): RuleOutcome[] {
  const outcomes: RuleOutcome[] = []
  const failed = assessments.filter((entry) => entry.passed === false)
  const failedMetrics = failed.map((entry) => entry.metric)

  // Rule: the opening package failed its gate. The SOP's fix is the opening and
  // the marketing material, never a rewrite of the whole book.
  const openingFails = failed.filter((entry) => entry.metric === 'readThrough3')
  if (openingFails.length > 0) {
    outcomes.push({
      key: 'rewrite-opening',
      label: '三章读完低于同类中位 ×0.8 → 改开篇',
      evidence: openingFails.map((entry) => entry.note),
      action: '重写第 1–3 章的开篇冲突与章末钩子；必要时同步检查简介与标签',
      scope: 'chapter',
      severity: 60,
    })
  }

  // Rule: the naming/blurb is not converting clicks.
  const namingFails = failed.filter((entry) => entry.metric === 'clickRate' || entry.metric === 'favoriteRate')
  if (namingFails.length > 0) {
    outcomes.push({
      key: 'change-naming',
      label: '点击率/收藏转化低于同类中位 ×0.8 → 换书名、简介、标签',
      evidence: namingFails.map((entry) => entry.note),
      action: '换用另一组备选书名/简介/标签（novel_plan operation="naming" 切换 active），再验一轮',
      scope: 'chapter',
      severity: 50,
    })
  }

  // Rule: sustained readership decline. Needs a trend, not one bad reading, so
  // it counts consecutive declining readings rather than a single value.
  const trend = decliningStreak(state, 'followRead10')
  const followFails = failed.filter((entry) => entry.metric === 'followRead10' || entry.metric === 'followRead24h')
  if (followFails.length > 0 && trend >= SUSTAINED_DECLINE_CHAPTERS) {
    outcomes.push({
      key: 'accelerate-volume',
      label: `追读连续 ${String(trend)} 章下滑 → 卷内加速、提前高潮、砍支线`,
      evidence: [...followFails.map((entry) => entry.note), `连续下滑 ${String(trend)} 章（阈值 ${String(SUSTAINED_DECLINE_CHAPTERS)}）`],
      action: '在当前卷内加速：提前安排中高潮、砍掉或合并支线、把细纲往下压实',
      scope: 'volume',
      severity: 80,
    })
  } else if (followFails.length > 0) {
    outcomes.push({
      key: 'tighten-hooks',
      label: '10 章追读低于同类中位 ×0.7 → 改节奏/钩子',
      evidence: followFails.map((entry) => entry.note),
      action: '检查后续细纲的章末钩子与信息差投放密度，逐章补强',
      scope: 'chapter',
      severity: 40,
    })
  }

  // Rule: the volume's own pacing collapsed.
  const volumeFails = failed.filter((entry) => entry.metric === 'averageReadPerChapter')
  if (volumeFails.length > 0) {
    outcomes.push({
      key: 'rework-volume',
      label: '卷内均读低于同类中位 ×0.6 → 改分卷大纲、换地图/换矛盾',
      evidence: volumeFails.map((entry) => entry.note),
      action: '改分卷大纲：换地图、换主要矛盾，或把本卷高潮前移',
      scope: 'volume',
      severity: 85,
    })
  }

  // Rule: the concept itself is not working. This is the SOP's "回阶段一/三".
  const coreKeys: MetricKey[] = ['readThrough3', 'followRead10', 'clickRate']
  const coreFailing = failedMetrics.filter((metric) => coreKeys.includes(metric))
  if (coreFailing.length >= 2) {
    outcomes.push({
      key: 'revisit-concept',
      label: '核心指标同时低于同类中位 → 判断开篇、卖点、平台是否错配',
      evidence: failed.filter((entry) => coreKeys.includes(entry.metric)).map((entry) => entry.note),
      action: '回阶段一/三：重新审视卖点与平台匹配度，必要时回退到策划重置方向',
      scope: 'whole-book',
      severity: 95,
    })
  }

  // Rule: cut losses. The SOP requires both halves — "连续 2–3 轮调整无效" *and*
  // "核心指标长期低于同类中位 50% 以上". The iteration ledger makes the first
  // half decidable; CUT_LOSS_MULTIPLIER is the second. Firing on only one half
  // would recommend abandoning a book that had one bad week.
  const ineffective = countIneffectiveIterations(state)
  const deeplyDepressed = assessments.filter(
    (entry) =>
      coreKeys.includes(entry.metric)
      && entry.baseline !== undefined
      && entry.baseline > 0
      && entry.value < entry.baseline * CUT_LOSS_MULTIPLIER,
  )
  if (ineffective >= INEFFECTIVE_ITERATIONS_FOR_CUT && deeplyDepressed.length > 0) {
    outcomes.push({
      key: 'cut-losses',
      label:
        `连续 ${String(ineffective)} 轮调整无效，且核心指标低于同类中位 `
        + `${String(Math.round((1 - CUT_LOSS_MULTIPLIER) * 100))}% 以上 → 切书止损`,
      evidence: [
        ...deeplyDepressed.map((entry) => entry.note),
        `已记录 ${String(ineffective)} 轮无改善的迭代（阈值 ${String(INEFFECTIVE_ITERATIONS_FOR_CUT)}）`,
      ],
      action: '切书止损：把可复用结构沉淀到 novel_repo，开新书周期',
      scope: 'whole-book',
      severity: 100,
    })
  }

  return outcomes.sort((a, b) => b.severity - a.severity)
}

/**
 * Count the readings in a row that declined against their predecessor.
 *
 * @param state - the project.
 * @param metric - the metric to trace.
 * @returns the length of the trailing decline, in readings.
 */
export function decliningStreak(state: NovelState, metric: MetricKey): number {
  const series = state.readings
    .filter((reading) => reading.values[metric] !== undefined)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  let streak = 0
  for (let index = series.length - 1; index >= 1; index -= 1) {
    const current = series[index]?.values[metric]
    const previous = series[index - 1]?.values[metric]
    if (current === undefined || previous === undefined || current >= previous) break
    streak += 1
  }
  return streak
}

/**
 * How many iterations were recorded, applied, and never improved anything.
 *
 * An iteration counts as ineffective when it has an outcome reading recorded and
 * that outcome did not clear the metric it was aiming at — or when the author
 * marked it directly.
 *
 * @param state - the project.
 * @returns the count.
 */
export function countIneffectiveIterations(state: NovelState): number {
  return state.iterations.filter((iteration) => {
    if (iteration.outcome === 'ineffective') return true
    if (iteration.outcome === 'effective') return false
    if (iteration.outcomeReadingId === '') return false
    const outcome = state.readings.find((reading) => reading.id === iteration.outcomeReadingId)
    if (outcome === undefined) return false
    const assessments = assessReading(outcome, state.baselines)
    return assessments.some((entry) => entry.passed === false)
  }).length
}

/**
 * Find the iteration an outcome reading closes, so results can be back-filled.
 *
 * The SOP's cut-loss rule needs "调整是否有效" to be answerable; without linking
 * an outcome back to its iteration, that question has no data.
 *
 * @param state - the project.
 * @param readingId - the reading just recorded.
 * @returns the iteration ids it should close.
 */
export function openIterationsFor(state: NovelState, readingId: string): string[] {
  void readingId
  return state.iterations.filter((iteration) => iteration.outcomeReadingId === '').map((iteration) => iteration.id)
}

/** One iteration's effect, as reported back to the author. */
export interface IterationOutcome {
  /** The iteration id. */
  readonly id: string
  /** What it was trying to change. */
  readonly trigger: string
  /** Whether the outcome reading improved on the baseline reading. */
  readonly improved: boolean
  /** One line on the comparison. */
  readonly note: string
}

/**
 * Compare an iteration's outcome reading with the reading it started from.
 *
 * @param state - the project.
 * @param iteration - the iteration to judge.
 * @returns the outcome, or `undefined` when either reading is missing.
 */
export function judgeIteration(state: NovelState, iteration: Iteration): IterationOutcome | undefined {
  const before = state.readings.find((reading) => reading.id === iteration.baselineReadingId)
  const after =
    iteration.outcomeReadingId === ''
      ? undefined
      : state.readings.find((reading) => reading.id === iteration.outcomeReadingId)
  if (before === undefined || after === undefined) return undefined

  const metrics = Object.keys(after.values).filter((key) => before.values[key as MetricKey] !== undefined) as MetricKey[]
  if (metrics.length === 0) {
    return { id: iteration.id, trigger: iteration.trigger, improved: false, note: '两轮读数没有共同指标，无法比较' }
  }
  const deltas = metrics.map((metric) => {
    const from = before.values[metric] ?? 0
    const to = after.values[metric] ?? 0
    const delta = to - from
    const direction = METRIC_DIRECTIONS[metric]
    return { metric, from, to, delta, better: direction === 'higher-better' ? delta > 0 : delta < 0 }
  })
  const improved = deltas.filter((entry) => entry.better).length
  return {
    id: iteration.id,
    trigger: iteration.trigger,
    improved: improved > 0,
    note:
      `${String(improved)}/${String(deltas.length)} 项改善：`
      + deltas.map((entry) => `${entry.metric} ${String(entry.from)}→${String(entry.to)}`).join('，'),
  }
}
