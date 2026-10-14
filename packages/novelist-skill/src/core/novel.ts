/**
 * Pure domain core of the AI Web Novel Composer: the document itself.
 *
 * Nothing here touches the filesystem, the Cordis context, or the wall clock
 * except through an injected `now`. Every state change is a pure function from
 * one {@link NovelState} to the next, which is what makes the SOP's gates cheap
 * to test and impossible to half-apply.
 *
 * Reading is tolerant where it can be and strict where it must be: unknown
 * fields are dropped, missing fields are defaulted, a version-1 document is
 * **migrated** (a draft must never be lost to a plugin upgrade), and anything
 * else is rejected rather than guessed at.
 *
 * @module @ai-novelist/novelist-skill/core/novel
 */

import { DEFAULT_STORAGE_LAYOUT, LEGACY_VOLUME_FILE, chapterPaths, volumePath } from './paths.ts'
import {
  CHAPTER_STATUSES,
  CHARACTER_SCOPES,
  COMPETITOR_TARGET,
  CONFIRMATION_KINDS,
  CONFIRMATION_MIN_ROUNDS,
  CONTRACT_FIELDS,
  GOLDEN_CHAPTERS,
  NOVEL_SCHEMA_VERSION,
  OUTLINE_STYLE_FIELDS,
  REVIEW_SEVERITIES,
  SETTINGS_LAYERS,
  SPINE_LABELS,
  styleParamName,
  STYLE_GATE_CHAPTER,
  chapterNumberOf,
  type Chapter,
  type ChapterStatus,
  type Character,
  type CharacterScope,
  type Competitor,
  type Confirmation,
  type ConfirmationKind,
  type ConfirmationStanding,
  type ContractField,
  type DeAiStanding,
  type DiscussionRound,
  type Evaluation,
  type Iteration,
  type LaunchDecision,
  type MetricBaselines,
  type MetricKey,
  type MetricReading,
  type NamingCandidate,
  type NovelMeta,
  type NovelMetadata,
  type NovelProgress,
  type NovelState,
  type Outline,
  type OutlineStyleField,
  type PlatformProfile,
  type Premise,
  type ProjectStage,
  type Retrospective,
  type SettingsLayerKey,
  type SettingsLayerStanding,
  type ReviewFinding,
  type ReviewKind,
  type ReviewRecord,
  type ReviewSeverity,
  type StageAssessment,
  type StorageIndex,
  type StorageLayout,
  type StoryLink,
  type VolumePlan,
  type WorldEntry,
  type WritingPlan,
} from './types.ts'
// The spine checks live in their own module precisely so this file can use them:
// `plan.ts` depends on this one, and importing them from there would close a
// cycle between the two.
import { outlineSpineGaps, outlineStyleGaps, volumeSpineGaps } from './spine.ts'

/** Raised for input that cannot become a valid state. */
export class NovelInputError extends Error {
  override readonly name = 'NovelInputError'
}

/** Raised when a stored document is absent, unparsable, or a foreign version. */
export class NovelStoreError extends Error {
  // Declared as `string` rather than the literal: `NovelWriteError` extends this
  // class to carry the written/not-written lists, and a literal type here would
  // make its own name unassignable.
  override readonly name: string = 'NovelStoreError'
}

/** Clock seam: production passes nothing, tests pass a fixed instant. */
export type Clock = () => string

/** Default clock: the current instant as ISO-8601. */
export const systemClock: Clock = () => new Date().toISOString()

// ── small helpers ─────────────────────────────────────────────────────────────

/**
 * Derive a stable id from a human title.
 *
 * Keeps ASCII letters, digits, CJK, and separators; collapses every other run
 * into a single dash.
 *
 * @param title - the free-form title or name.
 * @returns the slug, possibly empty when the title carries nothing usable.
 */
export function slugify(title: string): string {
  return title
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
}

/**
 * Count the prose length of a body.
 *
 * CJK text is counted per ideograph, because that is what a web-novel author
 * means by 字数; runs of Latin script are counted per whitespace-separated
 * token. Punctuation and whitespace contribute nothing.
 *
 * @param body - the chapter prose.
 * @returns the mixed character/word count.
 */
export function countWords(body: string): number {
  const cjk = body.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/gu)?.length ?? 0
  const latin = body
    .replace(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/gu, ' ')
    .split(/\s+/u)
    .filter((token) => /[\p{L}\p{N}]/u.test(token)).length
  return cjk + latin
}

/**
 * Narrow an unknown value to a plain JSON object.
 *
 * @param value - the value to test.
 * @returns whether the value is a non-null, non-array object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read a string field, substituting a default for a missing or non-string one.
 *
 * @param source - the record to read.
 * @param key - the field name.
 * @param fallback - value used when the field is absent or not a string.
 * @returns the field value or the fallback.
 */
export function readString(source: Record<string, unknown>, key: string, fallback: string): string {
  const value = source[key]
  return typeof value === 'string' ? value : fallback
}

/**
 * Read a finite-number field.
 *
 * @param source - the record to read.
 * @param key - the field name.
 * @param fallback - value used when the field is absent or not finite.
 * @returns the field value or the fallback.
 */
export function readNumber(source: Record<string, unknown>, key: string, fallback: number): number {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * Read a boolean field.
 *
 * @param source - the record to read.
 * @param key - the field name.
 * @param fallback - value used when the field is absent or not a boolean.
 * @returns the field value or the fallback.
 */
export function readBool(source: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = source[key]
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Read a string-array field, dropping non-string members.
 *
 * @param source - the record to read.
 * @param key - the field name.
 * @returns the normalized array, empty when absent.
 */
export function readStringArray(source: Record<string, unknown>, key: string): string[] {
  const value = source[key]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

/**
 * Read a finite-number-array field, dropping other members.
 *
 * @param source - the record to read.
 * @param key - the field name.
 * @returns the normalized array, empty when absent.
 */
export function readNumberArray(source: Record<string, unknown>, key: string): number[] {
  const value = source[key]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
}

/**
 * Read an array field through a per-item parser, dropping items that reject.
 *
 * @param value - the raw array.
 * @param parse - per-item parser, `undefined` to drop the item.
 * @returns the parsed items.
 */
export function readList<T>(value: unknown, parse: (item: Record<string, unknown>) => T | undefined): T[] {
  if (!Array.isArray(value)) return []
  const result: T[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const parsed = parse(item)
    if (parsed !== undefined) result.push(parsed)
  }
  return result
}

/**
 * Read a string-keyed map field through a per-entry parser.
 *
 * @param source - the record to read.
 * @param key - the field name.
 * @param parse - per-entry parser.
 * @returns the parsed map, keyed by the same keys.
 */
export function readMap<T>(
  source: Record<string, unknown>,
  key: string,
  parse: (id: string, entry: Record<string, unknown>) => T,
): Record<string, T> {
  const value = source[key]
  if (!isRecord(value)) return {}
  const result: Record<string, T> = {}
  for (const [id, entry] of Object.entries(value)) {
    if (!isRecord(entry)) continue
    result[id] = parse(id, entry)
  }
  return result
}

/**
 * Drop `undefined` values so an object can be spread over defaults under
 * `exactOptionalPropertyTypes`.
 *
 * @param source - the partial object.
 * @returns the same fields, minus any explicitly-undefined ones.
 */
export function stripUndefined<T extends object>(source: T): Partial<T> {
  const result: Partial<T> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) Object.assign(result, { [key]: value })
  }
  return result
}

/**
 * Narrow an unknown value to a chapter status.
 *
 * @param value - the candidate status.
 * @returns the status, or `planned` when unrecognized.
 */
export function readStatus(value: unknown): ChapterStatus {
  return CHAPTER_STATUSES.find((status) => status === value) ?? 'planned'
}

/**
 * Narrow an unknown value to a contract-field list, in canonical order.
 *
 * @param value - the candidate array.
 * @returns the recognized fields.
 */
export function readContractFields(value: unknown): ContractField[] {
  if (!Array.isArray(value)) return []
  return CONTRACT_FIELDS.filter((field) => value.includes(field))
}

/**
 * Normalize a caller-supplied slug: slugified when it carries a usable form,
 * otherwise the trimmed literal so an explicit id is never silently mangled.
 *
 * @param value - the raw id.
 * @returns the canonical id, or empty when the caller supplied nothing usable.
 */
export function normalizeId(value: string | undefined): string {
  const trimmed = value?.trim() ?? ''
  if (trimmed === '') return ''
  return slugify(trimmed) || trimmed
}

/**
 * Decide the id of an entry from a patch's `id` or `name`.
 *
 * @param patch - the patch whose fields identify the entry.
 * @returns the canonical id.
 * @throws {NovelInputError} when neither field yields an id.
 */
export function entryIdOf(patch: {
  readonly id?: string | undefined
  readonly name?: string | undefined
}): string {
  const id = normalizeId(patch.id) || slugify(patch.name ?? '')
  if (id === '') throw new NovelInputError('identify the entry with `id` or `name`')
  return id
}

/** A tiny stable hash, used only to mint ids for unnamed records on read. */
function hash(text: string): number {
  let value = 0
  for (const char of text) value = (value * 31 + (char.codePointAt(0) ?? 0)) | 0
  return value
}

/**
 * Which cast tier a character is held to.
 *
 * An explicit, recognized {@link CHARACTER_SCOPES} value wins. Otherwise the
 * answer comes from the role — a protagonist-shaped role is `main`, everything
 * else `volume` — which reproduces exactly what the cast check demanded before
 * tiers existed, so an older `人物设定.md` needs no migration and no entry is
 * quietly let off the stricter requirement by an upgrade. An unrecognized value
 * is treated the same way rather than guessed at, and `novel_bible
 * kind="review"` names it so the typo is visible instead of silently demoting
 * someone.
 *
 * @param character - the cast entry.
 * @returns the scope to hold it to.
 */
export function characterScope(character: { readonly role: string; readonly scope: string }): CharacterScope {
  const declared = character.scope.trim().toLowerCase()
  const known = CHARACTER_SCOPES.find((scope) => scope === declared)
  if (known !== undefined) return known
  return /protagonist|主角|lead/iu.test(character.role) ? 'main' : 'volume'
}

/**
 * Whether a cast entry declares a scope this build does not know.
 *
 * @param character - the cast entry.
 * @returns true when `scope` is written but is not one of the three tiers.
 */
export function unknownScope(character: { readonly scope: string }): boolean {
  const declared = character.scope.trim().toLowerCase()
  return declared !== '' && !CHARACTER_SCOPES.some((scope) => scope === declared)
}

/** A default cast entry: a name with nothing decided about it yet. */
export function emptyCharacter(): Character {
  return {
    id: '',
    name: '',
    role: '',
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
  }
}

// ── defaults ──────────────────────────────────────────────────────────────────

/** A project that exists but has no premise yet. */
export function emptyMeta(): NovelMeta {
  return { title: '', premise: '', genres: [], pov: 'third-limited', language: 'zh-CN' }
}

/** A commercial frame with nothing decided. */
export function emptyPlatform(): PlatformProfile {
  return { name: '', mode: 'unknown', audience: 'general', genres: [], readers: '', monetization: '' }
}

/** A pitch with nothing decided. */
export function emptyPitch(): Premise {
  return { memorablePoint: '', coreEmotion: '', shuangPoints: [], differentiators: [], kernel: '' }
}

/** Baselines that have not been calibrated yet. */
export function emptyBaselines(): MetricBaselines {
  return { medians: {}, multipliers: {}, calibratedAt: '', source: '' }
}

/** Writing parameters at the SOP's default operating points. */
export function emptyWriting(): WritingPlan {
  return {
    language: 'zh-CN',
    pov: 'third-limited',
    // The length questions start unanswered, which is why `volumes` is -1 and
    // not 0: 0 is the author's "不分卷" answer, a different fact entirely.
    volumes: -1,
    totalChapters: 0,
    targetWords: 0,
    chapterWords: 0,
    chapterPlanWindow: 15,
    openingGateChapters: [3, 10],
    stockTargetChapters: 10,
    chapterPlanCeiling: 40,
    updateRhythm: '',
  }
}

/** An all-empty 写作风格 block, for a project that has not written one yet. */
export function emptyOutlineStyle(): Readonly<Record<OutlineStyleField, string>> {
  const style = {} as Record<OutlineStyleField, string>
  for (const field of OUTLINE_STYLE_FIELDS) style[field] = ''
  return style
}

/** An outline with no decisions in it. */
export function emptyOutline(): Outline {
  return {
    logline: '',
    fullOutline: '',
    synopsis: '',
    protagonistArc: '',
    supportArcs: '',
    antagonistArc: '',
    factionShift: '',
    conflictArcs: '',
    costs: '',
    gains: '',
    style: emptyOutlineStyle(),
    acts: [],
    minimal: '',
    volumes: [],
    beats: [],
    opening: [],
    fullOutlineDone: false,
  }
}

/**
 * The opening-engineering checklist the SOP prescribes.
 *
 * @returns the seven checks, all unconfirmed.
 */
export function defaultOpeningChecks(): Outline['opening'] {
  return [
    { key: 'chapter-1-conflict-300', requirement: '第 1 章前 300 字出现冲突', done: false, note: '' },
    { key: 'chapter-1-hook', requirement: '第 1 章章末强钩子', done: false, note: '' },
    { key: 'chapter-2-golden-finger', requirement: '第 2 章展示金手指/核心矛盾/主角目标', done: false, note: '' },
    { key: 'chapter-3-payoff', requirement: '第 3 章小爽点 + 更大期待', done: false, note: '' },
    { key: 'first-10-goal-rival', requirement: '前 10 章交代目标、对手、金手指规则、地图势力初显', done: false, note: '' },
    { key: 'first-10-climax', requirement: '前 10 章出现第一次小高潮', done: false, note: '' },
    { key: 'first-30k-unit', requirement: '前 3 万字完成第一个完整情绪单元', done: false, note: '' },
  ]
}

/**
 * Build the initial state of a new project.
 *
 * @param meta - premise fields supplied at creation; missing fields default.
 * @param now - timestamp for `createdAt`/`updatedAt`.
 * @returns a valid, empty {@link NovelState}.
 */
export function emptyNovel(meta: Partial<NovelMeta> = {}, now: Clock = systemClock): NovelState {
  const stamp = now()
  const merged = { ...emptyMeta(), ...stripUndefined(meta) }
  return {
    schemaVersion: NOVEL_SCHEMA_VERSION,
    meta: merged,
    platform: { ...emptyPlatform(), genres: merged.genres },
    pitch: emptyPitch(),
    naming: [],
    baselines: emptyBaselines(),
    competitors: [],
    writing: { ...emptyWriting(), language: merged.language, pov: merged.pov },
    characters: {},
    world: {},
    links: {},
    outline: { ...emptyOutline(), opening: defaultOpeningChecks() },
    chapters: {},
    readings: [],
    iterations: [],
    evaluations: [],
    launchDecisions: [],
    discussions: [],
    confirmations: [],
    reviews: [],
    index: emptyIndex(),
    createdAt: stamp,
    updatedAt: stamp,
  }
}

/**
 * The empty index for a fresh project, pointing at the default layout.
 *
 * Declared here rather than imported from `content.ts`, which imports this
 * module for `countWords` and the slug helpers: a cycle between the two would
 * make module evaluation order load-bearing for no benefit.
 *
 * @param layout - the filenames the index should point at.
 * @returns an index with no chapters, no volumes, and no hashes.
 */
export function emptyIndex(layout: StorageLayout = DEFAULT_STORAGE_LAYOUT): StorageIndex {
  return {
    outlineFile: layout.outlineFile,
    castFile: layout.castFile,
    worldFile: layout.worldFile,
    volumeDir: layout.volumeDir,
    chapterPlanFile: layout.chapterPlanFile,
    competitorFile: layout.competitorFile,
    chapters: {},
    volumes: {},
    files: {},
  }
}

// ── chapter ids and ordering ──────────────────────────────────────────────────

/**
 * Decide which chapter a patch addresses.
 *
 * @param patch - the patch under consideration.
 * @returns the chapter id to write.
 * @throws {NovelInputError} when nothing identifies the chapter.
 */
export function resolveChapterId(patch: {
  readonly id?: string | undefined
  readonly title?: string | undefined
}): string {
  const explicit = normalizeId(patch.id)
  if (explicit !== '') return explicit
  const derived = slugify(patch.title ?? '')
  if (derived !== '') return derived
  throw new NovelInputError('identify the chapter with `id`, or a `title` that yields a slug')
}

/**
 * Find the next free 1-based chapter number.
 *
 * @param state - current state.
 * @returns one past the highest existing number.
 */
export function nextChapterNumber(state: NovelState): number {
  const numbers = Object.values(state.chapters).map((chapter) => chapter.number)
  return numbers.length === 0 ? 1 : Math.max(...numbers) + 1
}

/**
 * Re-key a chapter map into reading order so serialization is stable and diffs
 * stay small.
 *
 * @param chapters - chapter map in any order.
 * @returns a new map ordered by `number`, then id.
 */
export function sortChapters(chapters: Readonly<Record<string, Chapter>>): Record<string, Chapter> {
  const ordered = Object.values(chapters).sort((a, b) => a.number - b.number || a.id.localeCompare(b.id))
  const result: Record<string, Chapter> = {}
  for (const chapter of ordered) result[chapter.id] = chapter
  return result
}

// ── per-record readers ────────────────────────────────────────────────────────

/**
 * Read the premise block.
 *
 * @param value - the raw `meta` field.
 * @returns the normalized meta.
 */
export function readMeta(value: unknown): NovelMeta {
  if (!isRecord(value)) return emptyMeta()
  return {
    title: readString(value, 'title', ''),
    premise: readString(value, 'premise', ''),
    genres: readStringArray(value, 'genres'),
    pov: readString(value, 'pov', 'third-limited'),
    language: readString(value, 'language', 'zh-CN'),
  }
}

/**
 * Read the commercial frame, falling back to the premise's tags.
 *
 * @param value - the raw `platform` field.
 * @param meta - the parsed meta, used as the fallback source for genres.
 * @returns the normalized platform profile.
 */
function readPlatform(value: unknown, meta: NovelMeta): PlatformProfile {
  if (!isRecord(value)) return { ...emptyPlatform(), genres: meta.genres }
  const mode = readString(value, 'mode', 'unknown')
  const audience = readString(value, 'audience', 'general')
  return {
    name: readString(value, 'name', ''),
    mode: mode === 'paid' || mode === 'free' ? mode : 'unknown',
    audience: audience === 'male' || audience === 'female' ? audience : 'general',
    genres: readStringArray(value, 'genres'),
    readers: readString(value, 'readers', ''),
    monetization: readString(value, 'monetization', ''),
  }
}

/**
 * Read the pitch block.
 *
 * @param value - the raw `pitch` field.
 * @returns the normalized pitch.
 */
function readPitch(value: unknown): Premise {
  if (!isRecord(value)) return emptyPitch()
  return {
    memorablePoint: readString(value, 'memorablePoint', ''),
    coreEmotion: readString(value, 'coreEmotion', ''),
    shuangPoints: readStringArray(value, 'shuangPoints'),
    differentiators: readStringArray(value, 'differentiators'),
    kernel: readString(value, 'kernel', ''),
  }
}

/**
 * Read one naming candidate.
 *
 * @param value - the raw candidate.
 * @returns the candidate, or `undefined` when it carries neither title nor blurb.
 */
function readNaming(value: Record<string, unknown>): NamingCandidate | undefined {
  const title = readString(value, 'title', '')
  const blurb = readString(value, 'blurb', '')
  if (title === '' && blurb === '') return undefined
  return {
    id: readString(value, 'id', slugify(title) || `candidate-${String(Math.abs(hash(title + blurb)))}`),
    title,
    blurb,
    tags: readStringArray(value, 'tags'),
    rationale: readString(value, 'rationale', ''),
    active: readBool(value, 'active', false),
  }
}

/**
 * Read the baselines block.
 *
 * @param value - the raw `baselines` field.
 * @returns the normalized baselines.
 */
function readBaselines(value: unknown): MetricBaselines {
  if (!isRecord(value)) return emptyBaselines()
  const medians: Partial<Record<MetricKey, number>> = {}
  const multipliers: Partial<Record<MetricKey, number>> = {}
  const rawMedians = isRecord(value['medians']) ? value['medians'] : {}
  const rawMultipliers = isRecord(value['multipliers']) ? value['multipliers'] : {}
  for (const [key, entry] of Object.entries(rawMedians)) {
    if (typeof entry === 'number' && Number.isFinite(entry)) Object.assign(medians, { [key]: entry })
  }
  for (const [key, entry] of Object.entries(rawMultipliers)) {
    if (typeof entry === 'number' && Number.isFinite(entry)) Object.assign(multipliers, { [key]: entry })
  }
  return {
    medians,
    multipliers,
    calibratedAt: readString(value, 'calibratedAt', ''),
    source: readString(value, 'source', ''),
  }
}

/**
 * Read one competitor record.
 *
 * @param value - the raw competitor.
 * @returns the competitor, or `undefined` without a title.
 */
function readCompetitor(value: Record<string, unknown>): Competitor | undefined {
  const title = readString(value, 'title', '')
  if (title === '') return undefined
  return {
    id: readString(value, 'id', slugify(title)),
    title,
    tags: readStringArray(value, 'tags'),
    blurb: readString(value, 'blurb', ''),
    openingEvent: readString(value, 'openingEvent', ''),
    goldenFinger: readString(value, 'goldenFinger', ''),
    protagonistDesire: readString(value, 'protagonistDesire', ''),
    antagonistMotive: readString(value, 'antagonistMotive', ''),
    shuangFrequency: readString(value, 'shuangFrequency', ''),
    emotionCurve: readString(value, 'emotionCurve', ''),
    paywallPoint: readString(value, 'paywallPoint', ''),
    chapterHooks: readString(value, 'chapterHooks', ''),
    commentKeywords: readStringArray(value, 'commentKeywords'),
    takeaway: readString(value, 'takeaway', ''),
  }
}

/**
 * Read the writing plan, falling back to the premise conventions.
 *
 * @param value - the raw `writing` field.
 * @param meta - the parsed meta.
 * @returns the normalized writing plan.
 */
function readWriting(value: unknown, meta: NovelMeta): WritingPlan {
  const base = emptyWriting()
  if (!isRecord(value)) return { ...base, language: meta.language, pov: meta.pov }
  const gates = readNumberArray(value, 'openingGateChapters')
  const volumes = readNumber(value, 'volumes', base.volumes)
  // Documents written before the length questions existed carry `volumes: 0` as
  // an untouched default that was never an answer. With no `chapterWords` field
  // at all, a zero there reads as "not asked yet" so the question gets asked
  // rather than being silently recorded as the author's 不分卷 decision.
  const legacy = value['chapterWords'] === undefined
  return {
    language: readString(value, 'language', meta.language),
    pov: readString(value, 'pov', meta.pov),
    volumes: legacy && volumes === 0 ? -1 : volumes,
    totalChapters: readNumber(value, 'totalChapters', 0),
    targetWords: readNumber(value, 'targetWords', 0),
    chapterWords: readNumber(value, 'chapterWords', 0),
    chapterPlanWindow: readNumber(value, 'chapterPlanWindow', base.chapterPlanWindow),
    openingGateChapters: gates.length > 0 ? gates : base.openingGateChapters,
    stockTargetChapters: readNumber(value, 'stockTargetChapters', base.stockTargetChapters),
    chapterPlanCeiling: readNumber(value, 'chapterPlanCeiling', base.chapterPlanCeiling),
    updateRhythm: readString(value, 'updateRhythm', ''),
  }
}

/**
 * Read one cast member.
 *
 * @param id - the map key.
 * @param value - the raw entry.
 * @returns the character.
 */
function readCharacter(id: string, value: Record<string, unknown>): Character {
  return {
    id,
    name: readString(value, 'name', id),
    role: readString(value, 'role', ''),
    scope: readString(value, 'scope', ''),
    volume: readNumber(value, 'volume', 0),
    firstAppearance: readString(value, 'firstAppearance', ''),
    exit: readString(value, 'exit', ''),
    description: readString(value, 'description', ''),
    personality: readString(value, 'personality', ''),
    voice: readString(value, 'voice', ''),
    goal: readString(value, 'goal', ''),
    fear: readString(value, 'fear', ''),
    obsession: readString(value, 'obsession', ''),
    weakness: readString(value, 'weakness', ''),
    camp: readString(value, 'camp', ''),
    growthArc: readString(value, 'growthArc', ''),
    notes: readString(value, 'notes', ''),
  }
}

/**
 * Read one world fact.
 *
 * @param id - the map key.
 * @param value - the raw entry.
 * @returns the world entry.
 */
function readWorldEntry(id: string, value: Record<string, unknown>): WorldEntry {
  return {
    id,
    kind: readString(value, 'kind', 'note'),
    name: readString(value, 'name', id),
    detail: readString(value, 'detail', ''),
    cost: readString(value, 'cost', ''),
    limits: readString(value, 'limits', ''),
  }
}

/**
 * Read one reader promise.
 *
 * @param id - the map key.
 * @param value - the raw entry.
 * @returns the link.
 */
function readLink(id: string, value: Record<string, unknown>): StoryLink {
  const status = readString(value, 'status', 'open')
  return {
    id,
    note: readString(value, 'note', ''),
    kind: readString(value, 'kind', 'foreshadow'),
    plantedAt: readString(value, 'plantedAt', ''),
    dueAt: readString(value, 'dueAt', ''),
    payoff: readString(value, 'payoff', ''),
    status: status === 'paid' || status === 'abandoned' ? status : 'open',
    volume: readNumber(value, 'volume', 0),
  }
}

/**
 * Read one opening-engineering item.
 *
 * @param value - the raw item.
 * @returns the item, or `undefined` without a key.
 */
function readOpeningCheck(value: Record<string, unknown>): Outline['opening'][number] | undefined {
  const key = readString(value, 'key', '')
  if (key === '') return undefined
  return {
    key,
    requirement: readString(value, 'requirement', ''),
    done: readBool(value, 'done', false),
    note: readString(value, 'note', ''),
  }
}

/**
 * Read one volume plan.
 *
 * @param value - the raw volume.
 * @returns the volume, or `undefined` without a number.
 */
function readVolume(value: Record<string, unknown>): VolumePlan | undefined {
  const number = readNumber(value, 'number', 0)
  if (number <= 0) return undefined
  return {
    number,
    title: readString(value, 'title', ''),
    detail: readString(value, 'detail', ''),
    goal: readString(value, 'goal', ''),
    conflict: readString(value, 'conflict', ''),
    climax: readString(value, 'climax', ''),
    endHook: readString(value, 'endHook', ''),
    synopsis: readString(value, 'synopsis', ''),
    protagonistArc: readString(value, 'protagonistArc', ''),
    antagonistArc: readString(value, 'antagonistArc', ''),
    factionShift: readString(value, 'factionShift', ''),
    mainConflict: readString(value, 'mainConflict', ''),
    costs: readString(value, 'costs', ''),
    gains: readString(value, 'gains', ''),
    chapters: readNumberArray(value, 'chapters'),
  }
}

/**
 * Read one rhythm beat.
 *
 * @param value - the raw beat.
 * @returns the beat, or `undefined` without a chapter.
 */
function readBeat(value: Record<string, unknown>): Outline['beats'][number] | undefined {
  const chapter = readNumber(value, 'chapter', 0)
  if (chapter <= 0) return undefined
  return {
    chapter,
    kind: readString(value, 'kind', 'shuang') as Outline['beats'][number]['kind'],
    note: readString(value, 'note', ''),
  }
}

/**
 * Read the outline's 写作风格 block.
 *
 * A document written before the style moved into the outline layer has no
 * `style` object at all, and reads as an all-empty block — which is what the
 * prose gate reports, rather than a parse failure.
 *
 * @param value - the raw `style` field.
 * @returns one entry per style element.
 */
function readStyle(value: unknown): Outline['style'] {
  const style = { ...emptyOutlineStyle() } as Record<OutlineStyleField, string>
  if (isRecord(value)) {
    for (const field of OUTLINE_STYLE_FIELDS) style[field] = readString(value, field, '')
  }
  return style
}

/**
 * Read the outline.
 *
 * @param value - the raw `outline` field.
 * @returns the normalized outline.
 */
function readOutline(value: unknown): Outline {
  if (!isRecord(value)) return { ...emptyOutline(), opening: defaultOpeningChecks() }
  const opening = readList(value['opening'], readOpeningCheck)
  return {
    logline: readString(value, 'logline', ''),
    fullOutline: readString(value, 'fullOutline', ''),
    synopsis: readString(value, 'synopsis', ''),
    protagonistArc: readString(value, 'protagonistArc', ''),
    supportArcs: readString(value, 'supportArcs', ''),
    antagonistArc: readString(value, 'antagonistArc', ''),
    factionShift: readString(value, 'factionShift', ''),
    conflictArcs: readString(value, 'conflictArcs', ''),
    costs: readString(value, 'costs', ''),
    gains: readString(value, 'gains', ''),
    style: readStyle(value['style']),
    acts: readStringArray(value, 'acts'),
    minimal: readString(value, 'minimal', ''),
    volumes: readList(value['volumes'], readVolume),
    beats: readList(value['beats'], readBeat),
    opening: opening.length > 0 ? opening : defaultOpeningChecks(),
    fullOutlineDone: readBool(value, 'fullOutlineDone', false),
  }
}

/**
 * Read one chapter, recomputing derived fields so a hand-edited file cannot
 * carry a stale word count.
 *
 * @param id - the map key.
 * @param value - the raw chapter.
 * @returns the chapter.
 */
function readChapter(id: string, value: Record<string, unknown>): Chapter {
  const body = readString(value, 'body', '')
  const synopsis = readString(value, 'synopsis', '')
  const plotTask = readString(value, 'plotTask', '')
  const waived: Partial<Record<ContractField, string>> = {}
  const rawWaived = isRecord(value['waived']) ? value['waived'] : {}
  for (const field of CONTRACT_FIELDS) {
    const reason = rawWaived[field]
    if (typeof reason === 'string' && reason !== '') Object.assign(waived, { [field]: reason })
  }
  return {
    id,
    number: readNumber(value, 'number', 0) || 1,
    title: readString(value, 'title', ''),
    synopsis,
    status: readStatus(value['status']),
    body,
    wordCount: countWords(body),
    updatedAt: readString(value, 'updatedAt', new Date(0).toISOString()),
    volume: readNumber(value, 'volume', 0),
    // A version-1 draft carried its whole plan in `synopsis`; keep it as the
    // chapter task so the upgrade does not empty the only plan that existed.
    plotTask: plotTask !== '' ? plotTask : synopsis,
    conflict: readString(value, 'conflict', ''),
    emotionalPayoff: readString(value, 'emotionalPayoff', ''),
    infoGap: readString(value, 'infoGap', ''),
    beats: readStringArray(value, 'beats') as Chapter['beats'],
    hook: readString(value, 'hook', ''),
    keyBeat: readString(value, 'keyBeat', ''),
    price: readString(value, 'price', ''),
    targetWords: readNumber(value, 'targetWords', 0),
    waived,
    delivered: readContractFields(value['delivered']),
  }
}

/**
 * Read one metric reading.
 *
 * @param value - the raw reading.
 * @returns the reading, or `undefined` without an id.
 */
function readReading(value: Record<string, unknown>): MetricReading | undefined {
  const id = readString(value, 'id', '')
  if (id === '') return undefined
  const period = readString(value, 'period', 'new-book')
  const values: Partial<Record<MetricKey, number>> = {}
  const raw = isRecord(value['values']) ? value['values'] : {}
  for (const [key, entry] of Object.entries(raw)) {
    if (typeof entry === 'number' && Number.isFinite(entry)) Object.assign(values, { [key]: entry })
  }
  return {
    id,
    at: readString(value, 'at', new Date(0).toISOString()),
    period: period === 'paid' || period === 'free' ? period : 'new-book',
    atChapter: readNumber(value, 'atChapter', 0),
    values,
    source: readString(value, 'source', ''),
    note: readString(value, 'note', ''),
  }
}

/**
 * Read one iteration.
 *
 * @param value - the raw iteration.
 * @returns the iteration, or `undefined` without an id.
 */
function readIteration(value: Record<string, unknown>): Iteration | undefined {
  const id = readString(value, 'id', '')
  if (id === '') return undefined
  const scope = readString(value, 'scope', 'chapter')
  return {
    id,
    at: readString(value, 'at', new Date(0).toISOString()),
    trigger: readString(value, 'trigger', 'manual'),
    evidence: readString(value, 'evidence', ''),
    action: readString(value, 'action', ''),
    scope: scope === 'volume' || scope === 'whole-book' ? scope : 'chapter',
    baselineReadingId: readString(value, 'baselineReadingId', ''),
    outcomeReadingId: readString(value, 'outcomeReadingId', ''),
    outcome: readString(value, 'outcome', 'unknown'),
    note: readString(value, 'note', ''),
  }
}

/**
 * Read one investment evaluation.
 *
 * @param value - the raw evaluation.
 * @returns the evaluation, or `undefined` without an id.
 */
function readEvaluation(value: Record<string, unknown>): Evaluation | undefined {
  const id = readString(value, 'id', '')
  if (id === '') return undefined
  const verdict = readString(value, 'verdict', 'fail')
  return {
    id,
    round: readNumber(value, 'round', 1),
    at: readString(value, 'at', new Date(0).toISOString()),
    channel: readString(value, 'channel', ''),
    sampleSize: readNumber(value, 'sampleSize', 0),
    readingId: readString(value, 'readingId', ''),
    namingId: readString(value, 'namingId', ''),
    verdict: verdict === 'pass' || verdict === 'partial' ? verdict : 'fail',
    reasons: readStringArray(value, 'reasons'),
    fallback: readString(value, 'fallback', ''),
    abandonIf: readString(value, 'abandonIf', ''),
    nextAtChapter: readNumber(value, 'nextAtChapter', 0),
    nextTrigger: readString(value, 'nextTrigger', ''),
    note: readString(value, 'note', ''),
  }
}

/**
 * Read one stage-three launch decision.
 *
 * @param value - the raw decision.
 * @returns the decision, or `undefined` without an id.
 */
function readLaunchDecision(value: Record<string, unknown>): LaunchDecision | undefined {
  const id = readString(value, 'id', '')
  if (id === '') return undefined
  const verdict = readString(value, 'verdict', 'revise')
  return {
    id,
    at: readString(value, 'at', new Date(0).toISOString()),
    verdict: verdict === 'go' || verdict === 'abandon' ? verdict : 'revise',
    fallback: readString(value, 'fallback', ''),
    abandonIf: readString(value, 'abandonIf', ''),
    note: readString(value, 'note', ''),
  }
}

/**
 * Read one round of the settings/style conversation.
 *
 * A round without the author's own answer is dropped, exactly as the writer
 * refuses to record one: the record's whole value is that a round means the
 * author spoke, and a stored round that does not say so would launder a
 * monologue into a discussion.
 *
 * @param value - the decoded entry.
 * @returns the round, or `undefined` when it carries no feedback.
 */
function readDiscussionRound(value: Record<string, unknown>): DiscussionRound | undefined {
  const id = readString(value, 'id', '')
  if (id === '') return undefined
  const feedback = readString(value, 'feedback', '')
  if (feedback === '') return undefined
  const kind = readString(value, 'kind', 'settings')
  return {
    id,
    kind: (CONFIRMATION_KINDS as readonly string[]).includes(kind) ? (kind as ConfirmationKind) : 'settings',
    at: readString(value, 'at', new Date(0).toISOString()),
    proposal: readString(value, 'proposal', ''),
    feedback,
    topics: readStringArray(value, 'topics'),
  }
}

/**
 * Read one author sign-off.
 *
 * Dropped when it names no id or no checkpoint: an entry that cannot say what
 * the author approved must not be read as "the author approved".
 *
 * @param value - the decoded entry.
 * @returns the confirmation, or `undefined` when it is unusable.
 */
function readConfirmation(value: Record<string, unknown>): Confirmation | undefined {
  const id = readString(value, 'id', '')
  if (id === '') return undefined
  const kind = readString(value, 'kind', 'settings')
  return {
    id,
    kind: (CONFIRMATION_KINDS as readonly string[]).includes(kind) ? (kind as ConfirmationKind) : 'settings',
    at: readString(value, 'at', new Date(0).toISOString()),
    summary: readString(value, 'summary', ''),
    note: readString(value, 'note', ''),
    rounds: readNumber(value, 'rounds', 0),
  }
}

/**
 * Read the retrospective.
 *
 * @param value - the raw `retro` field.
 * @returns the retrospective.
 */
function readRetro(value: Record<string, unknown>): Retrospective {
  return {
    at: readString(value, 'at', new Date(0).toISOString()),
    dataSummary: readString(value, 'dataSummary', ''),
    highlights: readStringArray(value, 'highlights'),
    problems: readStringArray(value, 'problems'),
    lessons: readList(value['lessons'], (item) => {
      const statement = readString(item, 'statement', '')
      if (statement === '') return undefined
      return {
        id: readString(item, 'id', slugify(statement)),
        kind: readString(item, 'kind', 'reuse') === 'avoid' ? ('avoid' as const) : ('reuse' as const),
        statement,
        evidence: readString(item, 'evidence', ''),
        area: readString(item, 'area', ''),
      }
    }),
    assets: readList(value['assets'], (item) => {
      const label = readString(item, 'label', '')
      if (label === '') return undefined
      return {
        id: readString(item, 'id', slugify(label)),
        kind: readString(item, 'kind', 'scene'),
        label,
        content: readString(item, 'content', ''),
        source: readString(item, 'source', ''),
      }
    }),
    templates: readList(value['templates'], (item) => {
      const name = readString(item, 'name', '')
      if (name === '') return undefined
      return {
        name,
        exportedAt: readString(item, 'exportedAt', ''),
        acts: readStringArray(item, 'acts'),
        volumeRhythm: readStringArray(item, 'volumeRhythm'),
        beatPattern: readStringArray(item, 'beatPattern'),
        hookPatterns: readStringArray(item, 'hookPatterns'),
        emotionTemplate: readString(item, 'emotionTemplate', ''),
        note: readString(item, 'note', ''),
      }
    }),
  }
}

// ── reading and writing the document ──────────────────────────────────────────

/**
 * Normalize a current-version metadata document.
 *
 * The content half — outline, cast, world, chapters — is deliberately **absent**
 * here. It lives in Markdown files, and the store assembles it onto this
 * metadata when it builds a {@link NovelState}; a metadata document that still
 * carries those keys (a hand-edited file, a document written by a build that
 * lost the split) has them ignored rather than trusted, because the files are
 * authoritative.
 *
 * @param parsed - the decoded document.
 * @returns the metadata.
 */
export function readMetadata(parsed: Record<string, unknown>): NovelMetadata {
  const stamp = readString(parsed, 'updatedAt', new Date(0).toISOString())
  const meta = readMeta(parsed['meta'])
  const index = readIndex(parsed['index'], meta)
  return {
    schemaVersion: NOVEL_SCHEMA_VERSION,
    meta,
    platform: readPlatform(parsed['platform'], meta),
    pitch: readPitch(parsed['pitch']),
    naming: readList(parsed['naming'], readNaming),
    baselines: readBaselines(parsed['baselines']),
    competitors: readList(parsed['competitors'], readCompetitor),
    writing: readWriting(parsed['writing'], meta),
    links: readMap(parsed, 'links', readLink),
    readings: readList(parsed['readings'], readReading),
    iterations: readList(parsed['iterations'], readIteration),
    // `verifications` is the pre-3.2 name of the same ledger. Reading it keeps a
    // document written before the rename from silently losing its rounds.
    evaluations: readList(parsed['evaluations'] ?? parsed['verifications'], readEvaluation),
    launchDecisions: readList(parsed['launchDecisions'], readLaunchDecision),
    discussions: readList(parsed['discussions'], readDiscussionRound),
    confirmations: readList(parsed['confirmations'], readConfirmation),
    reviews: readList(parsed['reviews'], readReview),
    opening: readOpeningList(parsed['opening']),
    index,
    ...(isRecord(parsed['retro']) ? { retro: readRetro(parsed['retro']) } : {}),
    createdAt: readString(parsed, 'createdAt', stamp),
    updatedAt: stamp,
  }
}

/**
 * Read the storage index, defaulting whatever the document does not say.
 *
 * A missing or partial index is recoverable rather than fatal: the store scans
 * the directory and claims the files it finds, so a document that predates the
 * index (or lost it) still reads its novel back.
 *
 * @param value - the raw `index` field.
 * @param meta - the project metadata, consulted only for diagnostics.
 * @returns the normalized index.
 */
function readIndex(value: unknown, meta: NovelMeta): StorageIndex {
  void meta
  const base = emptyIndex()
  if (!isRecord(value)) return base
  const chapters: Record<string, StorageIndex['chapters'][string]> = {}
  if (isRecord(value['chapters'])) {
    for (const [id, raw] of Object.entries(value['chapters'])) {
      if (!isRecord(raw)) continue
      const bodyFile = readString(raw, 'bodyFile', '')
      const outlineFile = readString(raw, 'outlineFile', '')
      if (bodyFile === '' && outlineFile === '') continue
      chapters[id] = {
        number: readNumber(raw, 'number', 0),
        title: readString(raw, 'title', ''),
        bodyFile,
        outlineFile,
        bodyHash: readString(raw, 'bodyHash', ''),
        outlineHash: readString(raw, 'outlineHash', ''),
      }
    }
  }
  const files: Record<string, string> = {}
  if (isRecord(value['files'])) {
    for (const [path, hash] of Object.entries(value['files'])) {
      if (typeof hash === 'string') files[path] = hash
    }
  }
  const volumes: Record<string, StorageIndex['volumes'][string]> = {}
  if (isRecord(value['volumes'])) {
    for (const [key, raw] of Object.entries(value['volumes'])) {
      if (!isRecord(raw)) continue
      const file = readString(raw, 'file', '')
      if (file === '') continue
      const number = readNumber(raw, 'number', Number.parseInt(key, 10))
      if (!Number.isInteger(number) || number <= 0) continue
      volumes[key] = { number, file, hash: readString(raw, 'hash', '') }
    }
  }
  return {
    outlineFile: readString(value, 'outlineFile', base.outlineFile),
    castFile: readString(value, 'castFile', base.castFile),
    worldFile: readString(value, 'worldFile', base.worldFile),
    // A version-3 document names its single volume collection file here instead;
    // this falls back to the directory the version-4 layout uses, and the store's
    // migration is what splits the collection into it. An empty string is not a
    // directory: it would make the workspace root the volume directory.
    volumeDir: readString(value, 'volumeDir', base.volumeDir) || base.volumeDir,
    chapterPlanFile: readString(value, 'chapterPlanFile', base.chapterPlanFile),
    competitorFile: readString(value, 'competitorFile', base.competitorFile),
    chapters,
    volumes,
    files,
  }
}

/**
 * Read the opening-engineering checklist out of the metadata document.
 *
 * @param value - the raw `opening` field.
 * @returns the checklist, defaulting to the SOP's seven items when absent.
 */
function readOpeningList(value: unknown): Outline['opening'] {
  const opening = readList(value, readOpeningCheck)
  return opening.length > 0 ? opening : defaultOpeningChecks()
}

/**
 * Assemble a full state: metadata plus the content the caller read from files.
 *
 * @param metadata - the metadata document.
 * @param content - the outline, cast, world, and chapters from the content files.
 * @returns the assembled state.
 */
export function stateOf(
  metadata: NovelMetadata,
  content: {
    readonly outline: Outline
    readonly characters: Readonly<Record<string, Character>>
    readonly world: Readonly<Record<string, WorldEntry>>
    readonly competitors?: readonly Competitor[]
    readonly chapters: Readonly<Record<string, Chapter>>
  },
): NovelState {
  const { opening, index, ...rest } = metadata
  void opening
  return {
    ...rest,
    // The competitor file is the content half's home for the dismantles; the
    // metadata document keeps them as the fallback a project that predates the
    // file reads from. An explicitly empty file therefore falls back rather than
    // wiping research.
    competitors: content.competitors ?? rest.competitors,
    outline: content.outline,
    characters: content.characters,
    world: content.world,
    chapters: sortChapters(content.chapters),
    index,
  }
}

/**
 * Split a state into the metadata document and the content it owns.
 *
 * The opening checklist rides along in the metadata because the plan's ownership
 * table names no content home for it, and the rule for an unnamed field is that
 * it stays in `novel.json` rather than being dropped.
 *
 * @param state - the state to split.
 * @param index - the index to record, defaulting to the state's own.
 * @returns the metadata half.
 */
export function metadataOf(state: NovelState, index?: StorageIndex): NovelMetadata {
  // Spelled out field by field rather than by spreading the state minus a few
  // keys: a `...rest` taken after destructuring re-adds everything that was
  // destructured out, which is how the content half of the state (chapters,
  // cast, world) once leaked back into the metadata document.
  return {
    schemaVersion: NOVEL_SCHEMA_VERSION,
    meta: state.meta,
    platform: state.platform,
    pitch: state.pitch,
    naming: state.naming,
    baselines: state.baselines,
    competitors: state.competitors,
    writing: state.writing,
    links: state.links,
    readings: state.readings,
    iterations: state.iterations,
    evaluations: state.evaluations,
    launchDecisions: state.launchDecisions,
    discussions: state.discussions,
    confirmations: state.confirmations,
    reviews: state.reviews,
    // The checklist lives beside the plan it gates, but its home is the metadata
    // document — see `NovelMetadata.opening`.
    opening: state.outline.opening,
    index: index ?? state.index ?? emptyIndex(),
    ...(state.retro === undefined ? {} : { retro: state.retro }),
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  }
}

/**
 * Migrate a version-2 document.
 *
 * Version 2 kept the whole novel in one JSON document; version 3 keeps the
 * metadata there and the content in Markdown. This function performs the **data**
 * half of that move — content extracted from the document, metadata returned in
 * the new shape. Writing the backup, the Markdown files, and the new document is
 * the store's half, because only it has a filesystem.
 *
 * @param parsed - the decoded version-2 document.
 * @returns the migrated metadata and the content the caller must write out.
 */
export function migrateV2(parsed: Record<string, unknown>): { readonly metadata: NovelMetadata; readonly state: NovelState } {
  const metadata = readMetadata({ ...parsed, schemaVersion: NOVEL_SCHEMA_VERSION })
  const content = {
    outline: readOutline(parsed['outline']),
    characters: readMap(parsed, 'characters', readCharacter),
    world: readMap(parsed, 'world', readWorldEntry),
    chapters: sortChapters(readMap(parsed, 'chapters', readChapter)),
  }
  const state = stateOf(metadata, content)
  return {
    metadata: { ...metadata, index: indexFor(state, metadata.index) },
    state: { ...state, index: indexFor(state, metadata.index) },
  }
}

/**
 * Point an index at the files a state's content would occupy.
 *
 * Used by migration, where the content has never been written and therefore has
 * no recorded paths yet. Hashes stay empty: the store fills them in as it writes.
 *
 * @param state - the state whose chapters and volumes need paths.
 * @param base - the index to extend, providing the top-level names.
 * @returns the index with a chapter entry per chapter and a volume entry per volume.
 */
function indexFor(state: NovelState, base: StorageIndex): StorageIndex {
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
    volumes[String(volume.number)] = {
      number: volume.number,
      file: base.volumes[String(volume.number)]?.file ?? volumePath(volume.number, base),
      hash: '',
    }
  }
  return { ...base, chapters, volumes }
}

/**
 * Read one recorded review.
 *
 * A review without an id is dropped rather than repaired: the id is how the
 * transcript on disk is found, so an entry that lost it cannot be used.
 *
 * @param value - the decoded entry.
 * @returns the review, or `undefined` when it is unusable.
 */
function readReview(value: Record<string, unknown>): ReviewRecord | undefined {
  const id = readString(value, 'id', '')
  if (id === '') return undefined
  const kind = readString(value, 'kind', 'ai-flavor')
  const artifact = readString(value, 'artifact', '')
  return {
    id,
    at: readString(value, 'at', new Date(0).toISOString()),
    kind: (['ai-flavor', 'opening', 'competitor', 'retro'] as const).includes(kind as ReviewKind)
      ? (kind as ReviewKind)
      : 'ai-flavor',
    target: readString(value, 'target', ''),
    provider: readString(value, 'provider', ''),
    model: readString(value, 'model', ''),
    promptVersion: readString(value, 'promptVersion', ''),
    summary: readString(value, 'summary', ''),
    findings: readList(value['findings'], readFinding),
    artifact,
  }
}

/**
 * Read one finding.
 *
 * Findings are the point of a review, so one that carries neither a dimension
 * nor a fix is dropped instead of being shown as an empty bullet.
 *
 * @param value - the decoded entry.
 * @returns the finding, or `undefined` when it carries nothing actionable.
 */
function readFinding(value: Record<string, unknown>): ReviewFinding | undefined {
  const dimension = readString(value, 'dimension', '')
  const fix = readString(value, 'fix', '')
  if (dimension === '' && fix === '') return undefined
  const severity = readString(value, 'severity', 'medium')
  return {
    dimension,
    quote: readString(value, 'quote', ''),
    why: readString(value, 'why', ''),
    fix,
    severity: (REVIEW_SEVERITIES as readonly string[]).includes(severity)
      ? (severity as ReviewSeverity)
      : 'medium',
  }
}

/**
 * Migrate a version-1 document: premise, cast, world, and chapters survive.
 *
 * The old `synopsis` becomes the chapter task (see `readChapter`), so an
 * existing plan is not silently emptied by the upgrade. Everything the SOP needs
 * that version 1 did not model starts empty, and the project lands in whatever
 * stage its data supports.
 *
 * @param parsed - the decoded version-1 document.
 * @returns the migrated state.
 */
export function migrateV1(parsed: Record<string, unknown>): NovelState {
  const meta = readMeta(parsed['meta'])
  const stamp = readString(parsed, 'updatedAt', new Date(0).toISOString())
  const base: NovelState = {
    schemaVersion: NOVEL_SCHEMA_VERSION,
    meta,
    platform: { ...emptyPlatform(), genres: meta.genres },
    pitch: emptyPitch(),
    naming: [],
    baselines: emptyBaselines(),
    competitors: [],
    writing: { ...emptyWriting(), language: meta.language, pov: meta.pov },
    characters: readMap(parsed, 'characters', readCharacter),
    world: readMap(parsed, 'world', readWorldEntry),
    links: {},
    outline: { ...emptyOutline(), opening: defaultOpeningChecks() },
    chapters: sortChapters(readMap(parsed, 'chapters', readChapter)),
    readings: [],
    iterations: [],
    evaluations: [],
    launchDecisions: [],
    discussions: [],
    confirmations: [],
    reviews: [],
    index: emptyIndex(),
    createdAt: readString(parsed, 'createdAt', stamp),
    updatedAt: stamp,
  }
  return { ...base, index: indexFor(base, emptyIndex()) }
}

/**
 * Parse a persisted metadata document **without** its content.
 *
 * Version 2 still carries the content inline; the caller must route that case
 * through {@link migrateV2}, which is why this function reports the version it
 * found instead of pretending to have a complete state. Version 1 is upgraded
 * for the same reason, and lands in the same "content still in the document"
 * shape as version 2 so one migration path serves both.
 *
 * Version 3 is the version whose content already lives in files, but whose
 * volumes still share one collection file. Its metadata reads back unchanged;
 * what the caller has to be told is where that collection file is, because only
 * a caller with a filesystem can split it — see {@link ParsedMetadata.legacyVolumeFile}.
 *
 * @param raw - the JSON text read from disk.
 * @returns the version found, the metadata, the state when the document still
 *   held its content, and the version-3 volume collection path when there is one.
 * @throws {NovelStoreError} when the payload is not this plugin's document.
 */
export function parseMetadata(raw: string): {
  readonly version: number
  readonly metadata: NovelMetadata
  readonly legacy?: NovelState
  readonly legacyVolumeFile?: string
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new NovelStoreError('novel store is not valid JSON', { cause })
  }
  if (!isRecord(parsed)) throw new NovelStoreError('novel store must be a JSON object')
  const version = parsed['schemaVersion']
  if (version === 1) {
    const legacy = migrateV1(parsed)
    return { version: 1, metadata: metadataOf(legacy), legacy }
  }
  if (version === 2) {
    const migrated = migrateV2(parsed)
    return { version: 2, metadata: migrated.metadata, legacy: migrated.state }
  }
  if (version === 3) {
    // The index is where the collection file was recorded, and it is the only
    // place that knows: the filename is configurable, so it cannot be assumed.
    const index = isRecord(parsed['index']) ? parsed['index'] : {}
    return {
      version: 3,
      metadata: readMetadata(parsed),
      legacyVolumeFile: readString(index, 'volumeFile', LEGACY_VOLUME_FILE),
    }
  }
  if (version !== NOVEL_SCHEMA_VERSION) {
    throw new NovelStoreError(
      `novel store schemaVersion ${String(version)} is not supported (expected ${String(NOVEL_SCHEMA_VERSION)}, 3, 2, or 1)`,
    )
  }
  return { version: NOVEL_SCHEMA_VERSION, metadata: readMetadata(parsed) }
}

/**
 * Parse a self-contained novel document.
 *
 * Kept for the migration path and for callers that hold a whole document in
 * memory; {@link parseMetadata} is what the multi-file store uses.
 *
 * @param raw - the JSON text read from disk.
 * @returns the normalized state at the current schema version.
 * @throws {NovelStoreError} when the payload is not this plugin's document.
 */
export function parseNovel(raw: string): NovelState {
  const { metadata, legacy } = parseMetadata(raw)
  if (legacy !== undefined) return legacy
  return stateOf(metadata, {
    outline: { ...emptyOutline(), opening: metadata.opening },
    characters: {},
    world: {},
    chapters: {},
  })
}

/**
 * Serialize a metadata document for persistence: stable ordering, trailing newline.
 *
 * @param metadata - the metadata to write.
 * @returns pretty-printed JSON.
 */
export function serializeMetadata(metadata: NovelMetadata): string {
  const normalized: NovelMetadata = {
    ...metadata,
    readings: [...metadata.readings],
    iterations: [...metadata.iterations],
    evaluations: [...metadata.evaluations],
    launchDecisions: [...metadata.launchDecisions],
    discussions: [...metadata.discussions],
    confirmations: [...metadata.confirmations],
    reviews: [...metadata.reviews],
  }
  return `${JSON.stringify(normalized, null, 2)}\n`
}

/**
 * Serialize a whole state as one document, content included.
 *
 * Only used for a document that is not split across files — a migration input,
 * a test fixture, an export. The store writes {@link serializeMetadata}.
 *
 * @param state - the state to write.
 * @returns pretty-printed JSON.
 */
export function serializeNovel(state: NovelState): string {
  const normalized: NovelState = {
    ...state,
    chapters: sortChapters(state.chapters),
    readings: [...state.readings],
    iterations: [...state.iterations],
    evaluations: [...state.evaluations],
    launchDecisions: [...state.launchDecisions],
    discussions: [...state.discussions],
    confirmations: [...state.confirmations],
    reviews: [...state.reviews],
  }
  return `${JSON.stringify(normalized, null, 2)}\n`
}

// ── derived views ─────────────────────────────────────────────────────────────

/**
 * Contract fields a chapter has neither answered nor explicitly waived.
 *
 * `beats` counts as answered when at least one beat is declared; every other
 * field counts as answered when its text is non-empty.
 *
 * @param chapter - the chapter to inspect.
 * @returns the unanswered field names, in canonical order.
 */
export function missingContractFields(chapter: Chapter): ContractField[] {
  return CONTRACT_FIELDS.filter((field) => {
    if (chapter.waived[field] !== undefined) return false
    if (field === 'beats') return chapter.beats.length === 0
    const value = chapter[field]
    return typeof value === 'string' ? value.trim() === '' : value === undefined
  })
}

/**
 * Derive aggregate progress. Never stored: a stale counter in the document
 * would be a second source of truth.
 *
 * @param state - the state to summarize.
 * @returns chapter counts, prose length, stock, contract and promise standing.
 */
export function progressOf(state: NovelState): NovelProgress {
  const chapters = Object.values(state.chapters)
  const byStatus = { planned: 0, drafting: 0, revised: 0, final: 0 }
  for (const chapter of chapters) byStatus[chapter.status] += 1

  const numbers = chapters.map((chapter) => chapter.number).sort((a, b) => a - b)
  const numberingIssues: string[] = []
  numbers.forEach((number, index) => {
    if (number !== index + 1) {
      const offender = chapters.find((chapter) => chapter.number === number)
      if (offender !== undefined) numberingIssues.push(offender.id)
    }
  })

  const written = chapters.filter((chapter) => chapter.body.trim() !== '')
  const openLinks = Object.values(state.links).filter((link) => link.status === 'open')
  const writtenNumbers = new Set(written.map((chapter) => chapter.number))
  const overdueLinks = openLinks
    .filter((link) => {
      const due = Number.parseInt(link.dueAt.replace(/[^0-9]/gu, ''), 10)
      return Number.isFinite(due) && writtenNumbers.has(due)
    })
    .map((link) => link.id)

  return {
    chapters: chapters.length,
    byStatus,
    totalWords: chapters.reduce((total, chapter) => total + chapter.wordCount, 0),
    emptyChapters: chapters.filter((chapter) => chapter.body.trim() === '').map((chapter) => chapter.id),
    numberingIssues,
    // Stock is prose that exists but has not been published: written chapters
    // that are not yet `final`.
    stockChapters: chapters.filter((chapter) => chapter.body.trim() !== '' && chapter.status !== 'final').length,
    contractedChapters: chapters.filter((chapter) => missingContractFields(chapter).length === 0).length,
    deliveredChapters: written.filter((chapter) => chapter.delivered.length > 0 && missingContractFields(chapter).length === 0)
      .length,
    openLinks: openLinks.map((link) => link.id),
    overdueLinks,
  }
}

/**
 * The latest sign-off of one checkpoint.
 *
 * @param state - the project.
 * @param kind - which checkpoint.
 * @returns the newest sign-off, or `undefined` when the author never gave one.
 */
export function latestConfirmation(state: NovelState, kind: ConfirmationKind): Confirmation | undefined {
  return state.confirmations.filter((entry) => entry.kind === kind).at(-1)
}

/**
 * How many discussion rounds of one kind were recorded after its last sign-off.
 *
 * A sign-off stores how many rounds of that kind existed when it was given, so
 * the distance is a subtraction rather than a search: the ledgers are
 * append-only, and re-opening a checkpoint means recording new rounds.
 *
 * @param state - the project.
 * @param kind - which checkpoint.
 * @returns the round count, never negative.
 */
function roundsSince(state: NovelState, kind: ConfirmationKind, confirmation: Confirmation | undefined): number {
  const total = state.discussions.filter((round) => round.kind === kind).length
  return Math.max(0, total - (confirmation?.rounds ?? 0))
}

/**
 * Whether the golden three chapters all have prose.
 *
 * The style review is not "due" until they do: the author is being asked whether
 * 表达方式与遣词用句 need adjusting, and three chapters is the shortest sample in
 * which a voice is actually visible. A book whose whole plan is shorter than
 * three chapters (an experiment, a 短篇) is judged on what exists.
 *
 * @param state - the project.
 * @returns whether the chapters the review reads are written.
 */
export function styleGateReached(state: NovelState): boolean {
  const chapters = Object.values(state.chapters)
    .filter((chapter) => chapter.number > 0)
    .sort((a, b) => a.number - b.number)
  if (chapters.length === 0) return false
  return chapters.slice(0, GOLDEN_CHAPTERS).every((chapter) => chapter.body.trim() !== '')
}

/**
 * How many discussion rounds of one settings layer were recorded after its last sign-off.
 *
 * The premise layer has two spellings — `settings`, the SOP's umbrella name for
 * the pre-prose checkpoint, and `premise`, the layer's own key — and a project
 * talked through under one spelling must not be asked to repeat itself because
 * the tooling later preferred the other. So both count, and only for the premise:
 * the later layers never had an alias.
 *
 * @param state - the project.
 * @param layer - which settings layer.
 * @param confirmation - the layer's latest sign-off, or `undefined`.
 * @returns the round count, never negative.
 */
export function settingsLayerRounds(
  state: NovelState,
  layer: SettingsLayerKey,
  confirmation: Confirmation | undefined,
): number {
  if (layer !== 'premise') return roundsSince(state, layer, confirmation)
  const total = state.discussions.filter((round) => round.kind === 'settings' || round.kind === 'premise').length
  return Math.max(0, total - (confirmation?.rounds ?? 0))
}

/**
 * The phase-one blocker for the settings layer that is next in turn.
 *
 * Phase one is not finished until the layers are settled, but the useful thing
 * to report is the **next** layer rather than all of them: a model told "世界观
 * still needs talking about" can act, whereas a list of four open layers invites
 * it to batch them — which is the failure the ordering exists to prevent.
 *
 * @param standing - the derived checkpoint standing.
 * @returns the blocker line, or `undefined` when every layer is closed.
 */
export function nextLayerBlocker(standing: ConfirmationStanding): string | undefined {
  const layer = standing.nextLayer
  if (layer === undefined) return undefined
  const missing = layer.roundsRequired - layer.rounds
  const kind = layer.key === 'premise' ? 'settings' : layer.kind
  return missing > 0
    ? `${layer.label}尚未与用户讨论：还差 ${String(missing)} 轮（novel_confirm operation="discuss" kind="${kind}"），再由用户确认`
    : `${layer.label}已讨论但用户尚未确认（novel_confirm operation="confirm" kind="${kind}"）`
}

/**
 * Which author checkpoints are closed, and what is still open.
 *
 * The two top-level checkpoints answer the two ways the pipeline used to run
 * away from the author: settings announced rather than discussed, and a voice
 * chosen by the model alone. Neither is a judgement this function makes — it
 * reads what the author said, and reports what has not been asked.
 *
 * The settings checkpoint is decomposed one level further. 世界观、人物设定、全书大纲、
 * 分卷大纲 are each settled on their own, in order, so a layer's standing is a
 * function of the confirmations *before* it: the order is derived, not stored.
 * `settingsConfirmed` is therefore true only once every layer is closed, while
 * `preProseConfirmed` — the one `novel_write` hard-gates on — is true once the
 * premise layer is, because chapter 1 does not need the volume outline to exist.
 *
 * @param state - the project.
 * @returns the sign-offs, the per-layer standing, the round counts, and the open checkpoints.
 */
export function confirmationStanding(state: NovelState): ConfirmationStanding {
  const settings = latestConfirmation(state, 'settings')
  const style = latestConfirmation(state, 'style')
  const settingsRounds = roundsSince(state, 'settings', settings)
  const styleRounds = roundsSince(state, 'style', style)
  const settingsReady = settingsRounds >= CONFIRMATION_MIN_ROUNDS.settings
  const styleReady = styleRounds >= CONFIRMATION_MIN_ROUNDS.style

  const layers: SettingsLayerStanding[] = []
  for (const layer of SETTINGS_LAYERS) {
    // The premise layer is closed by the umbrella `settings` sign-off; every
    // layer after it carries its own kind. One checkpoint, two spellings, so an
    // existing project's `settings` confirmation keeps counting.
    const confirmation = layer.kind === 'premise' ? settings : latestConfirmation(state, layer.kind)
    const rounds = settingsLayerRounds(state, layer.key, confirmation)
    // "按顺序" falls out of the confirmations that already exist: a layer is
    // blocked when any earlier layer is still open.
    const earlier = layers.find((entry) => !entry.confirmed)
    layers.push({
      key: layer.key,
      kind: layer.kind,
      label: layer.label,
      confirmed: confirmation !== undefined,
      rounds,
      roundsRequired: CONFIRMATION_MIN_ROUNDS[layer.kind],
      blockedBy: earlier?.key,
      ready: earlier === undefined,
      gatesProse: layer.gatesProse,
    })
  }

  const preProse = layers.filter((layer) => layer.gatesProse)
  const preProseConfirmed = preProse.every((layer) => layer.confirmed)
  const settingsConfirmed = layers.every((layer) => layer.confirmed)
  const nextLayer = layers.find((layer) => !layer.confirmed)

  // The 去 AI 化 standing, read from the reviews ledger: the review is a tool call,
  // so its record is the receipt and a second ledger would be a second thing to
  // keep in step with it. `due` and `gatesProse` are the same condition as the
  // voice review's — the golden three chapters exist — because the SOP puts the
  // two steps together (第 21、23 步) and an author reading three chapters should be
  // asked about the voice and shown the AI-flavour diagnosis in one sitting.
  const deAiReviews = state.reviews.filter((review) => review.kind === 'ai-flavor')
  const latestDeAi = deAiReviews.at(-1)
  const reviewedNumbers = new Set(deAiReviews.map((review) => chapterNumberOf(review.target)))
  const golden = Object.values(state.chapters)
    .filter((chapter) => chapter.number > 0 && chapter.number <= GOLDEN_CHAPTERS && chapter.body.trim() !== '')
    .sort((left, right) => left.number - right.number)
  const goldenReached = styleGateReached(state)
  const deAi: DeAiStanding = {
    done: latestDeAi !== undefined,
    at: latestDeAi?.at ?? '',
    target: latestDeAi?.target ?? '',
    unreviewed: golden.filter((chapter) => !reviewedNumbers.has(chapter.number)).map((chapter) => chapter.number),
    due: goldenReached,
    gatesProse: goldenReached,
  }

  const blockers: string[] = []
  for (const layer of layers) {
    if (layer.confirmed) continue
    const missing = layer.roundsRequired - layer.rounds
    const discuss = `novel_confirm operation="discuss" kind="${layer.kind}"`
    const confirm = `novel_confirm operation="confirm" kind="${layer.kind}"`
    if (layer.key === 'premise') {
      // The pre-prose checkpoint keeps the SOP's own wording: it is the layer the
      // author is asked about first and the one that blocks `novel_write`.
      blockers.push(
        missing > 0
          ? `设定尚未与用户讨论：还差 ${String(missing)} 轮（${discuss}），再由用户确认`
          : `设定已讨论但用户尚未确认（${confirm}）`,
      )
      continue
    }
    const order = layer.ready ? '' : `（顺序上先关掉「${labelOf(layers, layer.blockedBy)}」）`
    blockers.push(
      missing > 0
        ? `${layer.label}尚未与用户讨论${order}：还差 ${String(missing)} 轮（${discuss}），再由用户确认`
        : `${layer.label}已讨论但用户尚未确认${order}（${confirm}）`,
    )
  }
  // The 去 AI 化 receipt comes first, because it is the prerequisite of the voice
  // review rather than a sibling of it: the author is meant to have the diagnosis
  // in hand when they read the three chapters and answer whether the voice needs
  // adjusting. Reporting only "文风待确认" would let the diagnosis be skipped
  // silently, which is exactly what this gate exists to stop.
  if (!deAi.done && deAi.due) {
    blockers.push(
      `第 1–${String(GOLDEN_CHAPTERS)} 章已成稿，但还没有做过一次去 AI 化诊断：`
      + '先 novel_review operation="ai-flavor"（每章一次更准），把「原文引用 + 为什么像 AI + 怎么改」拿到手，'
      + '改完再让用户读稿复核文风——诊断没做过，第 '
      + `${String(GOLDEN_CHAPTERS + 1)} 章起不写（novel_write 会拒绝）`,
    )
  } else if (deAi.unreviewed.length > 0) {
    // Not a gate: one recorded review satisfies the requirement. This is the
    // advisory half, so an author who reviewed chapter 1 is told which of the
    // golden chapters nobody has looked at.
    const missingChapters = deAi.unreviewed.map((number) => String(number)).join('、')
    blockers.push(
      `去 AI 化诊断只覆盖了部分黄金三章：第 ${missingChapters} 章还没有诊断过`
      + '（novel_review operation="ai-flavor" chapterId=<章>）',
    )
  }
  if (style === undefined && styleGateReached(state)) {
    blockers.push(
      styleReady
        ? `第 ${String(STYLE_GATE_CHAPTER)} 章已成稿，文风待用户确认（novel_confirm operation="confirm" kind="style"）`
        : `第 ${String(STYLE_GATE_CHAPTER)} 章已成稿，请让用户读过后确认文风（novel_confirm operation="discuss" 再 operation="confirm" kind="style"）`,
    )
  }

  return {
    settings,
    style,
    settingsRounds,
    styleRounds,
    layers,
    settingsConfirmed,
    styleConfirmed: style !== undefined,
    preProseConfirmed,
    settingsReady,
    styleReady,
    nextLayer,
    deAi,
    blockers,
  }
}

/** The label of one settings layer, for a blocker that names what comes first. */
function labelOf(layers: readonly SettingsLayerStanding[], key: SettingsLayerKey | undefined): string {
  return layers.find((layer) => layer.key === key)?.label ?? String(key ?? '')
}

/** Whether prose may be written, and what has to happen first when it may not. */
export interface ProseGate {
  /** Whether the chapter may be written. */
  readonly allowed: boolean
  /** Why it may not, in the SOP's own terms. */
  readonly reasons: readonly string[]
  /** The calls that open the gate. */
  readonly next: readonly string[]
}

/**
 * The checkpoint gate in front of the prose.
 *
 * This is the one hard gate in the pipeline, and it is hard on purpose: the soft
 * gates elsewhere report a disagreement and let the call stand, which is exactly
 * how a model ran from an inspiration to four finished chapters without the
 * author ever being asked. What is enforced here is narrow and cheap — the
 * author must have signed the **premise** layer off before chapter one exists,
 * the 写作风格 block of the 全书大纲 must be written before any chapter exists
 * (a voice chosen while writing is a voice the author never got to steer), and
 * the voice must be **reviewed** once the golden three chapters have prose and
 * before chapter four — so an author who talks to the tool is never stopped, and
 * a chapter 1 that is drafted while the volume outline is still being argued
 * about is not blocked by this gate. The layers after the premise are otherwise
 * enforced by order, not by refusal: `confirmationStanding` reports them as
 * blockers for the *next* layer, and `novel_confirm` refuses to skip ahead.
 *
 * @param state - the project.
 * @param chapterNumber - the chapter about to be written.
 * @returns whether the write may proceed.
 */
export function proseGate(state: NovelState, chapterNumber: number): ProseGate {
  const standing = confirmationStanding(state)
  const reasons: string[] = []
  const next: string[] = []
  if (!standing.preProseConfirmed) {
    const layer = standing.nextLayer
    // The premise layer answers to both names; `settings` is the one the SOP and
    // the error messages have always used, so the gate points at that spelling.
    const kind = layer === undefined || layer.key === 'premise' ? 'settings' : layer.kind
    reasons.push(
      '设定还没有经过用户确认：用户给的灵感只是起点，书名/立意/人设/世界观/篇幅必须**先与用户讨论并确认**，'
      + '确认之后才写正文',
    )
    next.push(`novel_confirm operation="discuss" kind="${kind}"（每一轮都写下用户的原话）`)
    next.push(`novel_confirm operation="confirm" kind="${kind}"（用户认可后才能确认）`)
  }
  const styleSpec = outlineStyleGaps(state.outline)
  if (styleSpec.length > 0) {
    reasons.push(
      '全书大纲还没有写明《写作风格》：基调/人称与视角/句式与节奏/遣词用句/对话与描写/情绪落点/负面清单'
      + `七项里还缺 ${String(styleSpec.length)} 项（${styleSpec.map((gap) => SPINE_LABELS[gap.key]).join('、')}）。`
      + '文风若等到第 1 章之后再定，第 1 章就只能按模型自己的口味写——先把它写进大纲，正文才有基准',
    )
    next.push(`novel_plan operation="outline" ${OUTLINE_STYLE_FIELDS.map((field) => `${styleParamName(field)}=…`).join(' ')}`)
    next.push('写作风格写完后，与用户讨论并确认「全书大纲」这一层（novel_confirm kind="outline"）')
  }
  if (!standing.styleConfirmed && chapterNumber > STYLE_GATE_CHAPTER) {
    reasons.push(
      `黄金三章（第 1–${String(STYLE_GATE_CHAPTER)} 章）已经成稿，第 ${String(STYLE_GATE_CHAPTER + 1)} 章之前要先让用户复核文风：`
      + '把这三章交给用户读，问清表达方式与遣词用句要不要调整；要调就先改风格与已写章节，再确认，'
      + '否则整本书会带着同一种跑偏的语感写完',
    )
    next.push('novel_confirm operation="discuss" kind="style"（用户读稿后对文风/表达方式/遣词用句的原话）')
    next.push('novel_confirm operation="confirm" kind="style"（用户认可这一版文风基准）')
  }
  // The 去 AI 化 receipt. Reporting an AI-flavoured book was possible before only
  // by the model choosing to ask for the diagnosis; this makes one recorded review
  // a condition of writing on, so "nobody ever ran it" is no longer a silent
  // outcome. It sits before the voice review in the author's sequence because the
  // diagnosis is what the author should be holding when they read the three
  // chapters and answer the voice question.
  if (!standing.deAi.done && chapterNumber > STYLE_GATE_CHAPTER && standing.deAi.due) {
    reasons.push(
      `黄金三章（第 1–${String(STYLE_GATE_CHAPTER)} 章）已经成稿，但还没有做过一次去 AI 化诊断：`
      + '去 AI 化是 SOP 第 23 步，不是可选项——先对成稿跑 novel_review operation="ai-flavor"（逐章更准），'
      + '拿到「原文引用 + 为什么像 AI + 怎么改」，你自己改完再让用户读稿复核文风；'
      + '没有这一步，AI 味会带着写完整本书',
    )
    next.push('novel_review operation="ai-flavor" chapterId=…（黄金三章逐章诊断；加 rewrite=true 会另给一份改写提案）')
    next.push('按诊断改完把整章重新 novel_write 覆盖，再 novel_confirm operation="discuss"/"confirm" kind="style"')
  }
  return { allowed: reasons.length === 0, reasons, next }
}

/**
 * The launch gate in front of the full skeleton.
 *
 * The SOP states one boundary in so many words — *"go（通过）→ 进入阶段四：完整大纲、
 * 分卷、伏笔、上架卡点"*, and principle 3, *"上线决策 go 后才投入完整大纲、分卷、
 * 伏笔、上架卡点"* — and until this gate existed it was the one declared boundary
 * nothing enforced. A project whose author had not yet decided whether the opening
 * package was worth betting on could still have a volume outline, a beat sheet and
 * a foreshadowing ledger built for it, which is precisely the investment stage
 * three exists to withhold.
 *
 * It stays narrow. Everything *before* the launch decision remains soft-gated, as
 * the SOP's principle 10 requires ("判断归人，纪律归工具"): an author who plans a
 * chapter early is warned about, not stopped. What this refuses is only the work
 * the SOP explicitly postpones until after a human has said `go`.
 *
 * @param state - the project.
 * @param what - the work being attempted, named for the refusal message.
 * @returns whether the work may proceed.
 */
export function skeletonGate(state: NovelState, what: string): ProseGate {
  const decision = state.launchDecisions.at(-1)
  if (decision?.verdict === 'go') return { allowed: true, reasons: [], next: [] }
  const verdict =
    decision === undefined
      ? '上线决策还没有记录'
      : decision.verdict === 'revise'
        ? '最近一次上线决策是「改后再说」，不是 go'
        : '最近一次上线决策是「放弃」，不是 go'
  return {
    allowed: false,
    reasons: [
      `${verdict}：${what}是 SOP 放在「go 之后」的投入（阶段四），`
      + '先让作者对开篇包拍板，再搭完整骨架——否则阶段三就成了一次没有内容的授权',
    ],
    next: [
      'novel_plan operation="launch"（verdict = go / revise / abandon；非 go 必须写 fallback 与 abandonIf）',
    ],
  }
}

/** The single next thing the state machine asks for. */
export interface NextStep {
  /** The one call to make now, in the SOP's own terms. */
  readonly action: string
  /**
   * Whether a hard gate is shut.
   *
   * A blocked step is not advice: nothing else substitutes for it, and
   * `novel_write` refuses prose until it is cleared.
   */
  readonly blocked: boolean
}

/**
 * The state machine's output: what to do now, out of everything the SOP wants.
 *
 * `assessStage` already reports the phase and the ordered list of what the next
 * one still needs; the problem with handing a model a list is that a list is not
 * a decision. This picks the one step that comes first — the shut hard gate if
 * there is one, otherwise the first blocker — so every tool result ends with the
 * same imperative rather than an assortment to choose from.
 *
 * @param state - the project.
 * @returns the step, and whether a hard gate is what demands it.
 */
export function nextStep(state: NovelState): NextStep {
  const highest = Object.values(state.chapters).reduce((max, chapter) => Math.max(max, chapter.number), 0)
  // The chapter about to be written, which is what the style gate keys on: it
  // opens the moment the gate chapter has prose.
  const gate = proseGate(state, highest + 1)
  if (!gate.allowed) {
    return { action: gate.next[0] ?? gate.reasons[0] ?? '', blocked: true }
  }
  const assessment = assessStage(state)
  const blocker = assessment.blockers[0]
  if (blocker !== undefined) return { action: blocker, blocked: false }
  return { action: `「${stageLabel(assessment.stage)}」阶段已完成，可以进入下一阶段`, blocked: false }
}

/** Whether a durable check-in should be armed for a project, and what it says. */
export interface EvaluationReminder {
  /** Whether the host should hold a recurring reminder for this project. */
  readonly arm: boolean
  /** Why it should not be armed, when it should not be. */
  readonly reason: string
  /** What the reminder delivers. Empty when `arm` is false. */
  readonly text: string
}

/**
 * The on-demand evaluation's one failure mode, addressed from project state.
 *
 * The SOP is explicit that the data check gates nothing and that *"它唯一的失败方式
 * 是没人再问"* — its only failure is that nobody asks again. A hint printed into a
 * prompt only reaches an author who is already in the session; a durable reminder
 * reaches them next week whether or not they were. This function decides whether
 * one is warranted; `host/reminder.ts` does the I/O.
 *
 * It is deliberately narrow about *when*: only while the book is actually being
 * serialized. Before that there is nothing to look at, and after it there is
 * nothing left to decide — which is what keeps the reminder from becoming the
 * always-present line that trains an author to ignore it.
 *
 * @param state - the project.
 * @returns whether to arm one, why not, and the text.
 */
export function evaluationReminder(state: NovelState): EvaluationReminder {
  const assessment = assessStage(state)
  if (assessment.stage === 'completed') {
    return { arm: false, reason: '已完本，投入评估不再需要提醒', text: '' }
  }
  if (assessment.stage !== 'serializing') {
    return {
      arm: false,
      reason: `项目还在「${stageLabel(assessment.stage)}」阶段，没有连载读数可提醒`,
      text: '',
    }
  }
  const written = Object.values(state.chapters).filter((chapter) => chapter.body.trim() !== '').length
  const last = state.evaluations.at(-1)
  const title = state.meta.title === '' ? '这本书' : `《${state.meta.title}》`
  const appointment =
    last === undefined
      ? '还没有做过第一次投入评估'
      : last.nextAtChapter > 0
        ? `按约定在第 ${String(last.nextAtChapter)} 章复查`
        : last.nextTrigger === ''
          ? '上次评估没有留下下次约定'
          : `按约定：${last.nextTrigger}`
  return {
    arm: true,
    reason: '连载中：按需评估唯一的失败方式是没人再问',
    text:
      `${title}已写 ${String(written)} 章，${appointment}。`
      + '平台上有数据时用 novel_assess operation="record" 抄一次读数，再用 operation="evaluate" 拿裁决；'
      + '这一步按需，不阻断连载，也不拦任何阶段。',
  }
}

/**
 * Which SOP phase the project has actually reached.
 *
 * The stage is **derived**, never stored: a stored stage is a second source of
 * truth that drifts the moment someone edits a chapter by hand. The blockers
 * name what the next phase still needs, which is exactly what `novel_plan`
 * reports as its soft gate.
 *
 * Only planned and written work can move it. Metric readings deliberately cannot:
 * phase three ends in a declared launch decision, and the data assessment that
 * used to sit there is now an on-demand action ({@link Evaluation}) that gates
 * nothing, so a project advances whether or not the platform numbers are
 * available.
 *
 * @param state - the state to assess.
 * @returns the stage plus the blockers for the next one.
 */
export function assessStage(state: NovelState): StageAssessment {
  const satisfied: string[] = []
  const competitors = state.competitors.length
  const hasPitch = state.pitch.memorablePoint.trim() !== ''
  const chapterPlans = Object.values(state.chapters).filter((chapter) => chapter.body.trim() === '')
  const writtenChapters = Object.values(state.chapters).filter((chapter) => chapter.body.trim() !== '')
  const openingDone = state.outline.opening.length > 0 && state.outline.opening.every((check) => check.done)
  const hasMinimalOutline = state.outline.minimal.trim() !== '' || state.outline.logline.trim() !== ''
  const lastDecision = state.launchDecisions.at(-1)
  const standing = confirmationStanding(state)

  // The voice review is a gate on the *position*, not a phase: it applies the
  // moment the golden three chapters have prose, wherever the phase machine
  // happens to be. It therefore rides on every phase's blocker list rather than
  // only on 阶段五's — a project that wrote its first three chapters before its
  // outline existed is still a project whose author has not heard the voice.
  const styleBlocker =
    !standing.styleConfirmed && styleGateReached(state)
      ? `黄金三章（第 1–${String(STYLE_GATE_CHAPTER)} 章）已成稿：先让用户读稿并复核文风`
        + `（novel_confirm operation="discuss" 再 operation="confirm" kind="style"），`
        + `再写第 ${String(STYLE_GATE_CHAPTER + 1)} 章`
      : undefined
  // The 去 AI 化 receipt rides on the same position as the voice review, and is
  // reported before it: the diagnosis is what the author reads the three chapters
  // against. It is a hard gate for the chapter after the golden three (see
  // `proseGate`), so the stage report must name it rather than leaving the author
  // to discover it at the refusal.
  const deAiBlocker =
    !standing.deAi.done && standing.deAi.due
      ? `黄金三章已成稿，但还没有做过一次去 AI 化诊断：先 novel_review operation="ai-flavor" 逐章诊断`
        + `（去 AI 化是 SOP 第 23 步，未做过前 novel_write 拒绝写第 ${String(STYLE_GATE_CHAPTER + 1)} 章）`
      : undefined
  const gated = (blockers: readonly string[]): string[] => [
    ...(deAiBlocker === undefined ? [] : [deAiBlocker]),
    ...(styleBlocker === undefined ? [] : [styleBlocker]),
    ...blockers,
  ]

  // Phase one → two: the pitch and the competitor study are the SOP's own
  // checkpoint ("能否一句话说清谁看、为什么追、为什么付费？竞品 ≥20 本"),
  // and the author's sign-off on the setup closes the phase — the settings are
  // something the two of them settle together, not something the tool announces.
  const planningBlockers: string[] = []
  if (!hasPitch) planningBlockers.push('唯一记忆点未写入（novel_plan operation="pitch"）')
  if (competitors < COMPETITOR_TARGET) {
    planningBlockers.push(`竞品拆解不足 ${String(COMPETITOR_TARGET)} 本，当前 ${String(competitors)} 本`)
  }
  if (!standing.settingsConfirmed) {
    const missing = CONFIRMATION_MIN_ROUNDS.settings - standing.settingsRounds
    planningBlockers.push(
      missing > 0
        ? `设定还差 ${String(missing)} 轮与用户讨论（novel_confirm operation="discuss" kind="settings"）`
        : '设定已讨论但用户尚未确认（novel_confirm operation="confirm" kind="settings"）',
    )
  }
  // Which layer of the settings is next in turn, so "按顺序" is visible from the
  // stage report and not only from `novel_confirm`'s own status call.
  const nextLayer = nextLayerBlocker(standing)
  if (nextLayer !== undefined) planningBlockers.push(nextLayer)
  if (planningBlockers.length > 0) return { stage: 'planning', blockers: gated(planningBlockers), satisfied }
  satisfied.push('记忆点、竞品拆解与用户确认的设定已就绪')

  // Phase two → three: the opening package.
  const prepBlockers: string[] = []
  if (!hasMinimalOutline) prepBlockers.push('最小可行大纲未写入（operation="outline"）')
  if (chapterPlans.length === 0 && writtenChapters.length === 0) prepBlockers.push('尚无章节细纲（operation="chapter"）')
  if (!openingDone) {
    const pending = state.outline.opening.filter((check) => !check.done).length
    prepBlockers.push(`开篇工程清单尚有 ${String(pending)} 项未确认（operation="opening"）`)
  }
  if (prepBlockers.length > 0) return { stage: 'opening-package', blockers: gated(prepBlockers), satisfied }
  satisfied.push('开篇包已就绪')

  // Phase three: the launch decision. A declared judgement, never a reading —
  // the evidence available here (an editor's read, a handful of readers) is
  // judgement, and a project whose author cannot transcribe platform numbers
  // must still be able to move on. What is enforced is the anti-formality rule:
  // a decision that is not `go` has to say where to fall back to and what would
  // end the concept.
  if (lastDecision === undefined) {
    return {
      stage: 'opening-decision',
      blockers: gated(['上线决策未记录：开篇包够不够格投入完整骨架？（novel_plan operation="launch"）']),
      satisfied,
    }
  }
  if (lastDecision.verdict === 'abandon') {
    return {
      stage: 'opening-decision',
      blockers: gated([
        `已判定放弃该概念${lastDecision.abandonIf === '' ? '' : `（放弃条件：${lastDecision.abandonIf}）`}：换概念后从阶段一重来`,
      ]),
      satisfied,
    }
  }
  if (lastDecision.verdict === 'revise') {
    return {
      stage: 'opening-decision',
      blockers: gated([
        `上次决策为「改后再说」：${lastDecision.fallback === '' ? '未写回退目标' : lastDecision.fallback}`
        + `；放弃条件：${lastDecision.abandonIf === '' ? '未写' : lastDecision.abandonIf}`,
      ]),
      satisfied,
    }
  }
  satisfied.push('上线决策已通过（go）')

  // Phase four → five: the full skeleton. The outline and volume layers are
  // confirmed *here* — stage three is what authorises building them out — so this
  // phase is not done until the author has approved both, not merely until the
  // text exists.
  const outlineBlockers: string[] = []
  if (!state.outline.fullOutlineDone) outlineBlockers.push('完整大纲未确认（operation="outline" 且 full=true）')
  if (state.outline.volumes.length === 0) outlineBlockers.push('分卷大纲未写入（operation="volume"）')
  if (state.outline.beats.length === 0) outlineBlockers.push('情绪节拍表为空（operation="beat"）')
  // The story's own debts block the phase that depends on them, and they are
  // reported first among the outline blockers: a skeleton with no narrative spine
  // is the one gap that makes the beats below it unreadable, and the 爆点 has
  // nothing to land on. The spine is a soft gate everywhere else — this is only
  // the "is phase four finished" question.
  // The story's own debts block the phase that depends on them, and they are
  // reported first among the outline blockers: a skeleton with no narrative spine
  // is the one gap that makes the beats below it unreadable, and the 爆点 has
  // nothing to land on. The style block is the same kind of debt — the outline
  // layer owns it, and `novel_write` refuses prose until it is written. Both are
  // soft gates everywhere else: this is only the "is phase four finished"
  // question, answered in the SOP's order (故事 → 文风 → 其余).
  const contentGaps: string[] = []
  const spineGaps = outlineSpineGaps(state.outline)
  if (spineGaps.length > 0) {
    contentGaps.push(
      `全书大纲叙事骨架缺 ${String(spineGaps.length)} 项（${spineGaps.map((gap) => gap.key).join('、')}）：`
      + '先把故事讲完整（novel_plan operation="outline"）',
    )
  }
  const styleGaps = outlineStyleGaps(state.outline)
  if (styleGaps.length > 0) {
    contentGaps.push(
      `全书大纲《写作风格》缺 ${String(styleGaps.length)} 项（${styleGaps.map((gap) => SPINE_LABELS[gap.key]).join('、')}）：`
      + '基调、人称与视角、句式与节奏、遣词用句、对话与描写、情绪落点、负面清单都要写下来'
      + '（novel_plan operation="outline"）——正文按它写',
    )
  }
  if (contentGaps.length > 0) outlineBlockers.unshift(...contentGaps)
  const volumeSpineDebt = state.outline.volumes.filter((volume) => volumeSpineGaps(volume).length > 0)
  if (volumeSpineDebt.length > 0) {
    outlineBlockers.push(
      `分卷大纲叙事骨架缺项：第 ${volumeSpineDebt.map((volume) => String(volume.number)).join('、')} 卷`
      + '（novel_plan operation="volume"）',
    )
  }
  const outlineLayer = standing.layers.find((layer) => layer.key === 'outline')
  const volumeLayer = standing.layers.find((layer) => layer.key === 'volume')
  if (outlineLayer !== undefined && !outlineLayer.confirmed) {
    outlineBlockers.push(`全书大纲未与用户确认（novel_confirm kind="outline"）`)
  }
  if (volumeLayer !== undefined && !volumeLayer.confirmed) {
    outlineBlockers.push(`分卷大纲未与用户确认（novel_confirm kind="volume"）`)
  }
  if (outlineBlockers.length > 0) return { stage: 'full-outline', blockers: gated(outlineBlockers), satisfied }
  satisfied.push('完整骨架已确认')

  if (writtenChapters.length === 0) {
    return { stage: 'full-outline', blockers: gated(['尚未开始连载正文（novel_write）']), satisfied }
  }
  satisfied.push(`正文已开始（${String(writtenChapters.length)} 章）`)

  // The style checkpoint. It is reported as a blocker at the moment it becomes
  // due — the gate chapter has prose — because that is precisely the step a
  // model skips when it is being helpful: it writes chapter 2 while the author
  // has not yet read chapter 1.
  if (styleBlocker !== undefined) {
    return { stage: 'serializing', blockers: [styleBlocker], satisfied }
  }
  satisfied.push('文风已经用户确认')

  if (state.retro === undefined) {
    return { stage: 'serializing', blockers: ['完本复盘未写（novel_repo operation="retro"）'], satisfied }
  }
  satisfied.push('复盘已完成')
  return { stage: 'completed', blockers: [], satisfied }
}

/**
 * The SOP's name for one phase, for tool output.
 *
 * @param stage - the stage value.
 * @returns the phase label in Chinese, matching the SOP document.
 */
export function stageLabel(stage: ProjectStage): string {
  switch (stage) {
    case 'planning':
      return '阶段一 策划'
    case 'opening-package':
      return '阶段二 开篇包'
    case 'opening-decision':
      return '阶段三 上线决策'
    case 'full-outline':
      return '阶段四 完整大纲'
    case 'serializing':
      return '阶段五 连载与放大'
    case 'completed':
      return '阶段六 复盘与复用'
  }
}

// ── mutations ─────────────────────────────────────────────────────────────────

/**
 * Replace the premise fields.
 *
 * @param state - the state to derive from.
 * @param patch - premise fields to set; omitted fields keep their value.
 * @param now - timestamp for `updatedAt`.
 * @returns a new state with the premise updated.
 */
export function updateMeta(state: NovelState, patch: Partial<NovelMeta>, now: Clock = systemClock): NovelState {
  const meta = { ...state.meta, ...stripUndefined(patch) }
  return {
    ...state,
    meta,
    writing: { ...state.writing, language: meta.language, pov: meta.pov },
    updatedAt: now(),
  }
}

/**
 * Replace the commercial frame.
 *
 * @param state - the state to derive from.
 * @param patch - platform fields to set.
 * @param now - timestamp for `updatedAt`.
 * @returns a new state.
 */
export function updatePlatform(
  state: NovelState,
  patch: Partial<PlatformProfile>,
  now: Clock = systemClock,
): NovelState {
  return { ...state, platform: { ...state.platform, ...stripUndefined(patch) }, updatedAt: now() }
}

/**
 * Replace the pitch fields.
 *
 * @param state - the state to derive from.
 * @param patch - pitch fields to set.
 * @param now - timestamp for `updatedAt`.
 * @returns a new state.
 */
export function updatePitch(state: NovelState, patch: Partial<Premise>, now: Clock = systemClock): NovelState {
  return { ...state, pitch: { ...state.pitch, ...stripUndefined(patch) }, updatedAt: now() }
}

/**
 * Replace writing parameters.
 *
 * @param state - the state to derive from.
 * @param patch - writing fields to set.
 * @param now - timestamp for `updatedAt`.
 * @returns a new state.
 */
export function updateWriting(state: NovelState, patch: Partial<WritingPlan>, now: Clock = systemClock): NovelState {
  return { ...state, writing: { ...state.writing, ...stripUndefined(patch) }, updatedAt: now() }
}

/**
 * Replace the baselines.
 *
 * @param state - the state to derive from.
 * @param patch - baseline fields to set.
 * @param now - timestamp for `updatedAt`.
 * @returns a new state.
 */
export function updateBaselines(
  state: NovelState,
  patch: Partial<MetricBaselines>,
  now: Clock = systemClock,
): NovelState {
  return {
    ...state,
    baselines: {
      medians: patch.medians ?? state.baselines.medians,
      multipliers: patch.multipliers ?? state.baselines.multipliers,
      calibratedAt: patch.calibratedAt ?? state.baselines.calibratedAt,
      source: patch.source ?? state.baselines.source,
    },
    updatedAt: now(),
  }
}

/**
 * Append a metric reading.
 *
 * @param state - the state to derive from.
 * @param reading - the reading to append.
 * @param now - timestamp for `updatedAt`.
 * @returns a new state.
 */
export function addReading(state: NovelState, reading: MetricReading, now: Clock = systemClock): NovelState {
  return { ...state, readings: [...state.readings, reading], updatedAt: now() }
}

/**
 * Append an iteration record.
 *
 * @param state - the state to derive from.
 * @param iteration - the iteration to append.
 * @param now - timestamp for `updatedAt`.
 * @returns a new state.
 */
export function addIteration(state: NovelState, iteration: Iteration, now: Clock = systemClock): NovelState {
  return { ...state, iterations: [...state.iterations, iteration], updatedAt: now() }
}

/**
 * Append one investment evaluation.
 *
 * Evaluations accumulate: the point of an on-demand check is to compare this
 * look at the numbers with the last one, which needs the earlier record to still
 * exist.
 *
 * @param state - the state to derive from.
 * @param evaluation - the evaluation to append.
 * @param now - timestamp for `updatedAt`.
 * @returns a new state.
 */
export function addEvaluation(state: NovelState, evaluation: Evaluation, now: Clock = systemClock): NovelState {
  return { ...state, evaluations: [...state.evaluations, evaluation], updatedAt: now() }
}

/**
 * Append one stage-three launch decision.
 *
 * Decisions accumulate for the same reason evaluations do: a `revise` followed
 * by a `go` is the record of what changed between them.
 *
 * @param state - the state to derive from.
 * @param decision - the decision to append.
 * @param now - timestamp for `updatedAt`.
 * @returns a new state.
 */
export function addLaunchDecision(state: NovelState, decision: LaunchDecision, now: Clock = systemClock): NovelState {
  return { ...state, launchDecisions: [...state.launchDecisions, decision], updatedAt: now() }
}

/**
 * Append one round of the settings/style conversation.
 *
 * Rounds accumulate so a checkpoint keeps the trail that justifies it: what was
 * proposed, what the author said back, and — read in order — how the setup
 * actually changed between the first idea and the version that was approved.
 *
 * @param state - the state to derive from.
 * @param round - the round to append.
 * @param now - timestamp for `updatedAt`.
 * @returns a new state carrying the round.
 */
export function addDiscussionRound(
  state: NovelState,
  round: DiscussionRound,
  now: Clock = systemClock,
): NovelState {
  return { ...state, discussions: [...state.discussions, round], updatedAt: now() }
}

/**
 * Append one author sign-off.
 *
 * @param state - the state to derive from.
 * @param confirmation - the sign-off to append.
 * @param now - timestamp for `updatedAt`.
 * @returns a new state carrying the sign-off.
 */
export function addConfirmation(
  state: NovelState,
  confirmation: Confirmation,
  now: Clock = systemClock,
): NovelState {
  return { ...state, confirmations: [...state.confirmations, confirmation], updatedAt: now() }
}

/**
 * Append one recorded review.
 *
 * Reviews accumulate rather than replace: a second opinion on the same chapter
 * after a revision is exactly what makes the revision's effect visible, and the
 * SOP's evidence chain needs the earlier judgement to still exist.
 *
 * @param state - the state to derive from.
 * @param review - the record to append.
 * @param now - timestamp for `updatedAt`.
 * @returns a new state carrying the review.
 */
export function addReview(state: NovelState, review: ReviewRecord, now: Clock = systemClock): NovelState {
  return { ...state, reviews: [...state.reviews, review], updatedAt: now() }
}

/**
 * Create or update one chapter.
 *
 * A write never destroys unstated fields: supplying `body` alone keeps the
 * existing contract. The word count is always recomputed from the stored body.
 *
 * @param state - the state to derive from.
 * @param patch - the fields to set; `id` or `title` must identify the chapter.
 * @param now - timestamp for `updatedAt`.
 * @returns a new state with the chapter upserted.
 * @throws {NovelInputError} when neither `id` nor `title` identifies a chapter.
 */
export function upsertChapter(
  state: NovelState,
  patch: Partial<Chapter> & { readonly id?: string | undefined },
  now: Clock = systemClock,
): NovelState {
  const id = resolveChapterId(patch)
  const existing = state.chapters[id]
  const body = patch.body ?? existing?.body ?? ''
  const chapter: Chapter = {
    id,
    number: patch.number ?? existing?.number ?? nextChapterNumber(state),
    title: patch.title ?? existing?.title ?? '',
    synopsis: patch.synopsis ?? existing?.synopsis ?? '',
    status: patch.status ?? existing?.status ?? 'planned',
    body,
    wordCount: countWords(body),
    updatedAt: now(),
    volume: patch.volume ?? existing?.volume ?? 0,
    plotTask: patch.plotTask ?? existing?.plotTask ?? '',
    conflict: patch.conflict ?? existing?.conflict ?? '',
    emotionalPayoff: patch.emotionalPayoff ?? existing?.emotionalPayoff ?? '',
    infoGap: patch.infoGap ?? existing?.infoGap ?? '',
    beats: patch.beats ?? existing?.beats ?? [],
    hook: patch.hook ?? existing?.hook ?? '',
    keyBeat: patch.keyBeat ?? existing?.keyBeat ?? '',
    price: patch.price ?? existing?.price ?? '',
    targetWords: patch.targetWords ?? existing?.targetWords ?? 0,
    waived: patch.waived ?? existing?.waived ?? {},
    delivered: patch.delivered ?? existing?.delivered ?? [],
  }
  return {
    ...state,
    chapters: sortChapters({ ...state.chapters, [id]: chapter }),
    updatedAt: chapter.updatedAt,
  }
}

/**
 * Remove one chapter.
 *
 * @param state - the state to derive from.
 * @param id - the chapter id.
 * @param now - timestamp for `updatedAt`.
 * @returns the new state, unchanged when the id is unknown.
 * @throws {NovelInputError} when the id is empty.
 */
export function removeChapter(state: NovelState, id: string, now: Clock = systemClock): NovelState {
  const key = normalizeId(id)
  if (key === '') throw new NovelInputError('a chapter id is required')
  if (state.chapters[key] === undefined) return state
  const chapters = { ...state.chapters }
  delete chapters[key]
  return { ...state, chapters: sortChapters(chapters), updatedAt: now() }
}

/**
 * Create or update one cast member.
 *
 * @param state - the state to derive from.
 * @param patch - the fields to set.
 * @param now - timestamp for `updatedAt`.
 * @returns a new state with the character upserted.
 */
export function upsertCharacter(
  state: NovelState,
  patch: Partial<Character> & { readonly id?: string | undefined; readonly appendNotes?: boolean | undefined },
  now: Clock = systemClock,
): NovelState {
  const id = entryIdOf(patch)
  const existing = state.characters[id]
  if (existing === undefined && (patch.name === undefined || patch.name.trim() === '')) {
    throw new NovelInputError(`character "${id}" does not exist yet; supply \`name\` to create it`)
  }
  const notes =
    patch.appendNotes === true && patch.notes !== undefined
      ? [existing?.notes ?? '', patch.notes].filter((part) => part !== '').join('\n')
      : patch.notes ?? existing?.notes ?? ''
  const character: Character = {
    id,
    name: patch.name ?? existing?.name ?? id,
    role: patch.role ?? existing?.role ?? '',
    scope: patch.scope ?? existing?.scope ?? '',
    volume: patch.volume ?? existing?.volume ?? 0,
    firstAppearance: patch.firstAppearance ?? existing?.firstAppearance ?? '',
    exit: patch.exit ?? existing?.exit ?? '',
    description: patch.description ?? existing?.description ?? '',
    personality: patch.personality ?? existing?.personality ?? '',
    voice: patch.voice ?? existing?.voice ?? '',
    goal: patch.goal ?? existing?.goal ?? '',
    fear: patch.fear ?? existing?.fear ?? '',
    obsession: patch.obsession ?? existing?.obsession ?? '',
    weakness: patch.weakness ?? existing?.weakness ?? '',
    camp: patch.camp ?? existing?.camp ?? '',
    growthArc: patch.growthArc ?? existing?.growthArc ?? '',
    notes,
  }
  return { ...state, characters: { ...state.characters, [id]: character }, updatedAt: now() }
}

/**
 * Create or update one world fact.
 *
 * @param state - the state to derive from.
 * @param patch - the fields to set.
 * @param now - timestamp for `updatedAt`.
 * @returns a new state with the entry upserted.
 */
export function upsertWorld(
  state: NovelState,
  patch: Partial<WorldEntry> & { readonly id?: string | undefined },
  now: Clock = systemClock,
): NovelState {
  const id = entryIdOf(patch)
  const existing = state.world[id]
  if (existing === undefined && (patch.name === undefined || patch.name.trim() === '')) {
    throw new NovelInputError(`world fact "${id}" does not exist yet; supply \`name\` to create it`)
  }
  const entry: WorldEntry = {
    id,
    kind: patch.kind ?? existing?.kind ?? 'note',
    name: patch.name ?? existing?.name ?? id,
    detail: patch.detail ?? existing?.detail ?? '',
    cost: patch.cost ?? existing?.cost ?? '',
    limits: patch.limits ?? existing?.limits ?? '',
  }
  return { ...state, world: { ...state.world, [id]: entry }, updatedAt: now() }
}

/**
 * Read one world fact back out of a state.
 *
 * Exists because `upsert*` returns a new state, and callers routinely need the
 * entry they just wrote; an earlier revision accidentally returned the state
 * from `upsertWorld`, which every nested call then treated as an entry.
 *
 * @param state - the state to read.
 * @param id - the entry id.
 * @returns the entry, or `undefined`.
 */
export function worldEntryOf(state: NovelState, id: string): WorldEntry | undefined {
  return state.world[normalizeId(id) || id]
}

/**
 * Create or update one reader promise.
 *
 * @param state - the state to derive from.
 * @param patch - the fields to set.
 * @param now - timestamp for `updatedAt`.
 * @returns a new state with the link upserted.
 */
export function upsertLink(
  state: NovelState,
  patch: Partial<StoryLink> & { readonly id?: string | undefined },
  now: Clock = systemClock,
): NovelState {
  const id = normalizeId(patch.id) || slugify(patch.note ?? '')
  if (id === '') throw new NovelInputError('identify the promise with `id`, or a `note` that yields a slug')
  const existing = state.links[id]
  if (existing === undefined && (patch.note === undefined || patch.note.trim() === '')) {
    throw new NovelInputError(`promise "${id}" does not exist yet; supply \`note\` to create it`)
  }
  const link: StoryLink = {
    id,
    note: patch.note ?? existing?.note ?? '',
    kind: patch.kind ?? existing?.kind ?? 'foreshadow',
    plantedAt: patch.plantedAt ?? existing?.plantedAt ?? '',
    dueAt: patch.dueAt ?? existing?.dueAt ?? '',
    payoff: patch.payoff ?? existing?.payoff ?? '',
    status: patch.status ?? existing?.status ?? 'open',
    volume: patch.volume ?? existing?.volume ?? 0,
  }
  return { ...state, links: { ...state.links, [id]: link }, updatedAt: now() }
}

/**
 * Remove one reader promise.
 *
 * @param state - the state to derive from.
 * @param id - the promise id.
 * @param now - timestamp for `updatedAt`.
 * @returns the new state, unchanged when the id is unknown.
 */
export function removeLink(state: NovelState, id: string, now: Clock = systemClock): NovelState {
  const key = normalizeId(id)
  if (key === '' || state.links[key] === undefined) return state
  const links = { ...state.links }
  delete links[key]
  return { ...state, links, updatedAt: now() }
}

/**
 * Replace the outline wholesale.
 *
 * @param state - the state to derive from.
 * @param patch - outline fields to set.
 * @param now - timestamp for `updatedAt`.
 * @returns a new state.
 */
export function updateOutline(state: NovelState, patch: Partial<Outline>, now: Clock = systemClock): NovelState {
  return { ...state, outline: { ...state.outline, ...stripUndefined(patch) }, updatedAt: now() }
}

/**
 * Add or replace one volume plan, keeping the list ordered by number.
 *
 * @param state - the state to derive from.
 * @param volume - the volume to write.
 * @param now - timestamp for `updatedAt`.
 * @returns a new state.
 */
export function upsertVolume(state: NovelState, volume: VolumePlan, now: Clock = systemClock): NovelState {
  const volumes = state.outline.volumes.filter((entry) => entry.number !== volume.number)
  volumes.push(volume)
  volumes.sort((a, b) => a.number - b.number)
  return { ...state, outline: { ...state.outline, volumes }, updatedAt: now() }
}

/**
 * Add or replace one beat in the rhythm table, keeping the list ordered.
 *
 * @param state - the state to derive from.
 * @param beat - the beat to write.
 * @param now - timestamp for `updatedAt`.
 * @returns a new state.
 */
export function upsertBeat(state: NovelState, beat: Outline['beats'][number], now: Clock = systemClock): NovelState {
  const beats = state.outline.beats.filter((entry) => entry.chapter !== beat.chapter)
  beats.push(beat)
  beats.sort((a, b) => a.chapter - b.chapter)
  return { ...state, outline: { ...state.outline, beats }, updatedAt: now() }
}

/**
 * Confirm or unconfirm one opening-engineering item.
 *
 * @param state - the state to derive from.
 * @param key - the checklist key.
 * @param done - the new state of the item.
 * @param note - evidence for the change.
 * @param now - timestamp for `updatedAt`.
 * @returns a new state.
 * @throws {NovelInputError} when the key is unknown.
 */
export function setOpeningCheck(
  state: NovelState,
  key: string,
  done: boolean,
  note: string,
  now: Clock = systemClock,
): NovelState {
  if (!state.outline.opening.some((check) => check.key === key)) {
    throw new NovelInputError(
      `unknown opening checklist key "${key}"; known keys: ${state.outline.opening.map((check) => check.key).join(', ')}`,
    )
  }
  const opening = state.outline.opening.map((check) =>
    check.key === key ? { ...check, done, note: note === '' ? check.note : note } : check,
  )
  return { ...state, outline: { ...state.outline, opening }, updatedAt: now() }
}

/**
 * Render the novel as one Markdown manuscript.
 *
 * @param state - the state to render.
 * @param options - `includeContract` prepends each chapter's task and hook.
 * @returns the manuscript, chapters in reading order.
 */
export function renderManuscript(state: NovelState, options: { readonly includeContract?: boolean } = {}): string {
  const chapters = Object.values(state.chapters).sort((a, b) => a.number - b.number)
  const header = `# ${state.meta.title === '' ? 'Untitled' : state.meta.title}\n`
  const body = chapters
    .map((chapter) => {
      const title = chapter.title === '' ? `Chapter ${String(chapter.number)}` : chapter.title
      const contract =
        options.includeContract === true && chapter.plotTask !== ''
          ? `\n> 剧情任务：${chapter.plotTask}\n> 钩子：${chapter.hook}\n`
          : ''
      return `\n## ${String(chapter.number)}. ${title}\n${contract}\n${chapter.body.trim()}\n`
    })
    .join('')
  return `${header}${body}`
}
