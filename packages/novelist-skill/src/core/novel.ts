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

import { DEFAULT_STORAGE_LAYOUT, chapterPaths } from './paths.ts'
import {
  CHAPTER_STATUSES,
  CONTRACT_FIELDS,
  NOVEL_SCHEMA_VERSION,
  REVIEW_SEVERITIES,
  type Chapter,
  type ChapterStatus,
  type Character,
  type Competitor,
  type ContractField,
  type Iteration,
  type MetricBaselines,
  type MetricKey,
  type MetricReading,
  type NamingCandidate,
  type NovelMeta,
  type NovelMetadata,
  type NovelProgress,
  type NovelState,
  type Outline,
  type PlatformProfile,
  type Premise,
  type ProjectStage,
  type Retrospective,
  type ReviewFinding,
  type ReviewKind,
  type ReviewRecord,
  type ReviewSeverity,
  type StageAssessment,
  type StorageIndex,
  type StorageLayout,
  type StoryLink,
  type VerificationRound,
  type VolumePlan,
  type WorldEntry,
  type WritingPlan,
} from './types.ts'

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
    volumes: 0,
    totalChapters: 0,
    targetWords: 0,
    chapterPlanWindow: 15,
    openingGateChapters: [3, 10],
    stockTargetChapters: 10,
    chapterPlanCeiling: 40,
    updateRhythm: '',
  }
}

/** An outline with no decisions in it. */
export function emptyOutline(): Outline {
  return { logline: '', acts: [], minimal: '', volumes: [], beats: [], opening: [], fullOutlineDone: false }
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
    verifications: [],
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
 * @returns an index with no chapters and no hashes.
 */
export function emptyIndex(layout: StorageLayout = DEFAULT_STORAGE_LAYOUT): StorageIndex {
  return {
    outlineFile: layout.outlineFile,
    castFile: layout.castFile,
    worldFile: layout.worldFile,
    volumeFile: layout.volumeFile,
    chapterPlanFile: layout.chapterPlanFile,
    chapters: {},
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
  return {
    language: readString(value, 'language', meta.language),
    pov: readString(value, 'pov', meta.pov),
    volumes: readNumber(value, 'volumes', 0),
    totalChapters: readNumber(value, 'totalChapters', 0),
    targetWords: readNumber(value, 'targetWords', 0),
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
    description: readString(value, 'description', ''),
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
    goal: readString(value, 'goal', ''),
    conflict: readString(value, 'conflict', ''),
    climax: readString(value, 'climax', ''),
    endHook: readString(value, 'endHook', ''),
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
 * Read one validation round.
 *
 * @param value - the raw round.
 * @returns the round, or `undefined` without an id.
 */
function readVerification(value: Record<string, unknown>): VerificationRound | undefined {
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
    note: readString(value, 'note', ''),
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
    verifications: readList(parsed['verifications'], readVerification),
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
  return {
    outlineFile: readString(value, 'outlineFile', base.outlineFile),
    castFile: readString(value, 'castFile', base.castFile),
    worldFile: readString(value, 'worldFile', base.worldFile),
    volumeFile: readString(value, 'volumeFile', base.volumeFile),
    chapterPlanFile: readString(value, 'chapterPlanFile', base.chapterPlanFile),
    chapters,
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
    readonly chapters: Readonly<Record<string, Chapter>>
  },
): NovelState {
  const { opening, index, ...rest } = metadata
  void opening
  return {
    ...rest,
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
    verifications: state.verifications,
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
 * @param state - the state whose chapters need paths.
 * @param base - the index to extend, providing the five top-level names.
 * @returns the index with a chapter entry per chapter.
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
  return { ...base, chapters }
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
    verifications: [],
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
 * @param raw - the JSON text read from disk.
 * @returns the version found, the metadata, and the state when the document
 *   still held its content.
 * @throws {NovelStoreError} when the payload is not this plugin's document.
 */
export function parseMetadata(raw: string): {
  readonly version: number
  readonly metadata: NovelMetadata
  readonly legacy?: NovelState
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
  if (version !== NOVEL_SCHEMA_VERSION) {
    throw new NovelStoreError(
      `novel store schemaVersion ${String(version)} is not supported (expected ${String(NOVEL_SCHEMA_VERSION)}, 2, or 1)`,
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
    verifications: [...metadata.verifications],
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
    verifications: [...state.verifications],
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
 * Which SOP phase the project's data currently supports.
 *
 * The stage is **derived**, never stored: a stored stage is a second source of
 * truth that drifts the moment someone edits a chapter by hand. The blockers
 * name what the next phase still needs, which is exactly what `novel_plan`
 * reports as its soft gate.
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
  const passedVerification = state.verifications.some((round) => round.verdict === 'pass')

  // Phase one → two: the pitch and the competitor study are the SOP's own
  // checkpoint ("能否一句话说清谁看、为什么追、为什么付费？竞品 ≥20 本").
  const planningBlockers: string[] = []
  if (!hasPitch) planningBlockers.push('唯一记忆点未写入（novel_plan operation="pitch"）')
  if (competitors < 20) planningBlockers.push(`竞品拆解不足 20 本，当前 ${String(competitors)} 本`)
  if (planningBlockers.length > 0) return { stage: 'planning', blockers: planningBlockers, satisfied }
  satisfied.push('记忆点与竞品拆解已就绪')

  // Phase two → three: the opening verification package.
  const prepBlockers: string[] = []
  if (!hasMinimalOutline) prepBlockers.push('最小可行大纲未写入（operation="outline"）')
  if (chapterPlans.length === 0 && writtenChapters.length === 0) prepBlockers.push('尚无章节细纲（operation="chapter"）')
  if (!openingDone) {
    const pending = state.outline.opening.filter((check) => !check.done).length
    prepBlockers.push(`开篇工程清单尚有 ${String(pending)} 项未确认（operation="opening"）`)
  }
  if (prepBlockers.length > 0) return { stage: 'verification-prep', blockers: prepBlockers, satisfied }
  satisfied.push('开篇验证包已就绪')

  // Phase three → four: a passing round.
  if (state.readings.length === 0) {
    return { stage: 'verification-prep', blockers: ['尚无可比对的读数（novel_verify 会录入）'], satisfied }
  }
  if (!passedVerification) {
    return {
      stage: 'verifying',
      blockers: ['验证未通过：改开篇/简介/标签后重验，或按回退目标回到策划'],
      satisfied,
    }
  }
  satisfied.push('验证已通过')

  // Phase four → five: the full skeleton.
  const outlineBlockers: string[] = []
  if (!state.outline.fullOutlineDone) outlineBlockers.push('完整大纲未确认（operation="outline" 且 full=true）')
  if (state.outline.volumes.length === 0) outlineBlockers.push('分卷大纲未写入（operation="volume"）')
  if (state.outline.beats.length === 0) outlineBlockers.push('情绪节拍表为空（operation="beat"）')
  if (outlineBlockers.length > 0) return { stage: 'full-outline', blockers: outlineBlockers, satisfied }
  satisfied.push('完整骨架已确认')

  if (writtenChapters.length === 0) {
    return { stage: 'full-outline', blockers: ['尚未开始连载正文（novel_write）'], satisfied }
  }
  satisfied.push(`正文已开始（${String(writtenChapters.length)} 章）`)

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
    case 'verification-prep':
      return '阶段二 验证准备'
    case 'verifying':
      return '阶段三 小成本验证'
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
    description: patch.description ?? existing?.description ?? '',
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
