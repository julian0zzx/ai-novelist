/**
 * The content codec: `NovelState`'s content half, as Markdown files.
 *
 * This module owns exactly one idea — the plan's §4 table, "one datum, one
 * home". {@link decomposeContent} turns the content half of a state into the
 * files that own it; {@link composeContent} turns those files back into a state.
 * The store calls those two and does the I/O, so neither the tools nor `core`'s
 * pure mutations ever learn that the novel stopped being one JSON document.
 *
 * Three rules from the plan are load-bearing here:
 *
 * 1. **The file is authoritative.** Whatever a human edited is what the next read
 *    returns; the index is a signpost, never a content source.
 * 2. **A broken file is named, never replaced.** Parse failures carry the file
 *    path and the parser's own complaint, and no caller may write over one.
 * 3. **A derived value is not content.** `wordCount` is recomputed from the prose
 *    on every read and back-filled on every write, so a hand-typed wrong number
 *    is corrected rather than adopted.
 *
 * @module @ai-webnovel/composer-host/core/content
 */

import {
  BEAT_KINDS,
  CHAPTER_STATUSES,
  CONTRACT_FIELDS,
  type Chapter,
  type ChapterStatus,
  type Character,
  type ContractField,
  type NovelState,
  type Outline,
  type StorageIndex,
  type VolumePlan,
  type WorldEntry,
  type BeatKind,
} from './types.ts'
import {
  MarkdownError,
  findSection,
  frontBool,
  frontMap,
  frontNumber,
  frontString,
  frontStringArray,
  hashContent,
  parseDocument,
  parseFrontmatter,
  parseTable,
  readEntries,
  renderDocument,
  renderEntry,
  renderListSection,
  renderSection,
  renderTable,
  sectionList,
  sectionText,
  splitSections,
  type MdSection,
  type YamlScalar,
  type YamlValue,
} from './markdown.ts'
import { emptyIndex, countWords, emptyOutline, normalizeId, slugify } from './novel.ts'
import { chapterPaths, numberFromFileName } from './paths.ts'

/** Raised when content files cannot be assembled into a state. */
export class NovelContentError extends Error {
  override readonly name = 'NovelContentError'
}

// ── layout ────────────────────────────────────────────────────────────────────

/** The section names the chapter contract fixes, in order. */
export const CONTRACT_SECTIONS: Readonly<Record<ContractField, string>> = {
  plotTask: '剧情任务',
  conflict: '冲突',
  emotionalPayoff: '情绪回报',
  infoGap: '信息差',
  hook: '章末钩子',
  // `beats` lives in the frontmatter; it has no section of its own.
  beats: '',
}

/** The `##` headings a chapter contract file carries, in file order. */
export const CONTRACT_SECTION_ORDER: readonly string[] = [
  '剧情任务',
  '冲突',
  '情绪回报',
  '信息差',
  '章末钩子',
]

/** The five top-level `##` sections of `章节大纲.md`. */
export const CHAPTER_PLAN_SECTIONS = {
  table: '章节表',
  beats: '情绪节拍表',
  opening: '开篇工程清单',
} as const

// ── names ─────────────────────────────────────────────────────────────────────

// ── outline file ──────────────────────────────────────────────────────────────

/** The Mutable subset of {@link Outline} that `全书大纲.md` owns. */
export interface OutlineFileContent {
  /** One-sentence story. */
  readonly logline: string
  /** Act structure. */
  readonly acts: readonly string[]
  /** The minimal viable outline. */
  readonly minimal: string
  /** Whether the full-outline stage is confirmed. */
  readonly fullOutlineDone: boolean
}

/**
 * Parse `全书大纲.md`.
 *
 * @param raw - the file text.
 * @param where - the file path, for error messages.
 * @returns the outline fields the file owns.
 * @throws {NovelContentError} when the file is not in the dialect.
 */
export function parseOutlineFile(raw: string, where: string): OutlineFileContent {
  const sections = sectionsOf(raw, where)
  const front = docFrontmatter(raw, where)
  return {
    logline: sectionText(sections, '一句话'),
    acts: sectionList(sections, '三幕'),
    minimal: sectionText(sections, '最小可行大纲'),
    fullOutlineDone: frontBool(front, 'fullOutlineDone', false),
  }
}

/**
 * Render `全书大纲.md`.
 *
 * @param outline - the fields the file owns.
 * @returns the file text.
 */
export function renderOutlineFile(outline: OutlineFileContent): string {
  // `fullOutlineDone` but no `updatedAt`: the plan's sample shows both, and the
  // timestamp is deliberately omitted here because the store writes content files
  // only when their bytes change — a timestamp no one reads would make every
  // unrelated edit rewrite the whole outline.
  return renderDocument({ fullOutlineDone: outline.fullOutlineDone }, '全书大纲', [
    renderSection('一句话', outline.logline),
    renderListSection('三幕', outline.acts),
    renderSection('最小可行大纲', outline.minimal),
  ])
}

// ── cast file ─────────────────────────────────────────────────────────────────

/**
 * Parse `人物设定.md` into characters, keyed by id.
 *
 * An entry without an `id` takes one from its heading; two entries that resolve
 * to the same id are an error rather than a last-one-wins merge, because the id
 * keys the index and address the character everywhere else.
 *
 * @param raw - the file text.
 * @param where - the file path, for error messages.
 * @returns characters keyed by id.
 * @throws {NovelContentError} on a duplicate id or an unidentifiable entry.
 */
export function parseCastFile(raw: string, where: string): Record<string, Character> {
  const text = bodyText(raw, where)
  const characters: Record<string, Character> = {}
  for (const entry of readEntries(splitSections(text), where)) {
    const id = normalizeId(frontString(entry.fields, 'id', '')) || slugify(entry.title)
    if (id === '') {
      throw new NovelContentError(`${where}: entry "## ${entry.title}" has no \`id\` and a heading that yields no slug`)
    }
    if (characters[id] !== undefined) {
      throw new NovelContentError(`${where}: duplicate character id "${id}" (first seen as "${characters[id]?.name ?? ''}")`)
    }
    const declared = frontString(entry.fields, 'description', '')
    characters[id] = {
      id,
      name: frontString(entry.fields, 'name', '') || entry.title,
      role: frontString(entry.fields, 'role', ''),
      // The prose after the block is the long description; an explicit
      // `description:` key is kept ahead of it, because a keyed value is a
      // deliberate one whereas prose may have accumulated from several edits.
      description: [declared, entry.prose].filter((part) => part !== '').join('\n\n'),
      goal: frontString(entry.fields, 'goal', ''),
      fear: frontString(entry.fields, 'fear', ''),
      obsession: frontString(entry.fields, 'obsession', ''),
      weakness: frontString(entry.fields, 'weakness', ''),
      camp: frontString(entry.fields, 'camp', ''),
      growthArc: frontString(entry.fields, 'growthArc', ''),
      notes: frontString(entry.fields, 'notes', ''),
    }
  }
  return characters
}

/**
 * Render `人物设定.md`.
 *
 * @param characters - the cast, keyed by id.
 * @returns the file text.
 */
export function renderCastFile(characters: Readonly<Record<string, Character>>): string {
  const sections = Object.values(characters)
    .sort((a, b) => a.id.localeCompare(b.id, 'zh-Hans-CN'))
    .map((character) =>
      renderEntry(
        character.name === '' ? character.id : character.name,
        dropEmpty({
          id: character.id,
          name: character.name,
          role: character.role,
          goal: character.goal,
          fear: character.fear,
          obsession: character.obsession,
          weakness: character.weakness,
          camp: character.camp,
          growthArc: character.growthArc,
          notes: character.notes,
        }),
        character.description,
      ),
    )
  // No `updatedAt`: the plan's own sample for this file has none, and a
  // timestamp in a file whose content did not change would turn every metadata
  // edit into a cast-file rewrite.
  return renderDocument({}, '人物设定', sections)
}

// ── world file ────────────────────────────────────────────────────────────────

/**
 * Parse `世界观设定.md` into world entries, keyed by id.
 *
 * @param raw - the file text.
 * @param where - the file path, for error messages.
 * @returns entries keyed by id.
 * @throws {NovelContentError} on a duplicate id or an unidentifiable entry.
 */
export function parseWorldFile(raw: string, where: string): Record<string, WorldEntry> {
  const text = bodyText(raw, where)
  const world: Record<string, WorldEntry> = {}
  for (const entry of readEntries(splitSections(text), where)) {
    const id = normalizeId(frontString(entry.fields, 'id', '')) || slugify(entry.title)
    if (id === '') {
      throw new NovelContentError(`${where}: entry "## ${entry.title}" has no \`id\` and a heading that yields no slug`)
    }
    if (world[id] !== undefined) {
      throw new NovelContentError(`${where}: duplicate world id "${id}" (first seen as "${world[id]?.name ?? ''}")`)
    }
    const declared = frontString(entry.fields, 'detail', '')
    world[id] = {
      id,
      kind: frontString(entry.fields, 'kind', 'note'),
      name: frontString(entry.fields, 'name', '') || entry.title,
      detail: [declared, entry.prose].filter((part) => part !== '').join('\n\n'),
      // Required by the SOP: a rule with no cost or limit is reported as a gap
      // by `worldGaps`, which cannot fire if the codec silently drops the keys.
      cost: frontString(entry.fields, 'cost', ''),
      limits: frontString(entry.fields, 'limits', ''),
    }
  }
  return world
}

/**
 * Render `世界观设定.md`.
 *
 * @param world - the entries, keyed by id.
 * @returns the file text.
 */
export function renderWorldFile(world: Readonly<Record<string, WorldEntry>>): string {
  const sections = Object.values(world)
    .sort((a, b) => a.id.localeCompare(b.id, 'zh-Hans-CN'))
    .map((entry) =>
      renderEntry(
        entry.name === '' ? entry.id : entry.name,
        dropEmpty({
          id: entry.id,
          kind: entry.kind,
          name: entry.name,
          cost: entry.cost,
          limits: entry.limits,
        }),
        entry.detail,
      ),
    )
  // No `updatedAt`: see {@link renderCastFile}.
  return renderDocument({}, '世界观设定', sections)
}

// ── volume file ───────────────────────────────────────────────────────────────

/**
 * Parse `分卷大纲.md` into volumes, sorted by number.
 *
 * @param raw - the file text.
 * @param where - the file path, for error messages.
 * @returns the volumes in reading order.
 * @throws {NovelContentError} on an entry without a positive `number`.
 */
export function parseVolumeFile(raw: string, where: string): VolumePlan[] {
  const text = bodyText(raw, where)
  const volumes: VolumePlan[] = []
  for (const entry of readEntries(splitSections(text), where)) {
    const number = frontNumber(entry.fields, 'number', 0)
    if (!Number.isInteger(number) || number <= 0) {
      throw new NovelContentError(
        `${where}: volume "## ${entry.title}" needs a positive integer \`number\` (found ${JSON.stringify(entry.fields['number'] ?? null)})`,
      )
    }
    // A repeated number is the same volume written twice, not two volumes: the
    // later entry wins, which is what makes an in-place edit idempotent.
    const existing = volumes.findIndex((volume) => volume.number === number)
    const volume: VolumePlan = {
      number,
      title: frontString(entry.fields, 'title', '') || entry.title.replace(/^第\s*\d+\s*卷\s*/u, '').trim(),
      goal: frontString(entry.fields, 'goal', ''),
      conflict: frontString(entry.fields, 'conflict', ''),
      climax: frontString(entry.fields, 'climax', ''),
      endHook: frontString(entry.fields, 'endHook', ''),
      chapters: numberList(entry.fields['chapters']),
    }
    if (existing >= 0) volumes[existing] = volume
    else volumes.push(volume)
  }
  return volumes.sort((a, b) => a.number - b.number)
}

/**
 * Render `分卷大纲.md`.
 *
 * @param volumes - the volume plans.
 * @returns the file text.
 */
export function renderVolumeFile(volumes: readonly VolumePlan[]): string {
  const sections = [...volumes]
    .sort((a, b) => a.number - b.number)
    .map((volume) =>
      renderEntry(
        `第 ${String(volume.number)} 卷${volume.title === '' ? '' : ` ${volume.title}`}`,
        dropEmpty({
          number: volume.number,
          title: volume.title,
          goal: volume.goal,
          conflict: volume.conflict,
          climax: volume.climax,
          endHook: volume.endHook,
          chapters: [...volume.chapters],
        }),
        '',
      ),
    )
  // No `updatedAt`: see {@link renderCastFile}.
  return renderDocument({}, '分卷大纲', sections)
}

// ── chapter plan file ─────────────────────────────────────────────────────────

/** One row of the chapter plan table: the plan layer's whole record of a chapter. */
export interface ChapterPlanRow {
  /** 1-based chapter number. */
  readonly number: number
  /** Working title. */
  readonly title: string
  /** Volume the chapter belongs to; 0 when unassigned. */
  readonly volume: number
  /** Target length; 0 when unset. */
  readonly targetWords: number
  /** The chapter's one-line summary, from the plan's own `一句话` column. */
  readonly oneLine: string
  /** The contract's short description; see {@link planRowsOf}. */
  readonly synopsis: string
}

/** Everything `章节大纲.md` owns. */
export interface ChapterPlanFileContent {
  /** The chapter table, in reading order. */
  readonly rows: readonly ChapterPlanRow[]
  /** The rhythm table: one beat per chapter position. */
  readonly beats: readonly { readonly chapter: number; readonly kind: BeatKind; readonly note: string }[]
  /** The opening-engineering checklist, whose `done` flags gate phase two. */
  readonly opening: Outline['opening']
}

/**
 * Parse `章节大纲.md`.
 *
 * The chapter table is the **only** home of a chapter's number, title, volume,
 * target length, and one-line summary; the contract file deliberately does not
 * repeat them, so a title edited here is a title changed everywhere.
 *
 * @param raw - the file text.
 * @param where - the file path, for error messages.
 * @param openingFallback - checklist to keep when the section is absent.
 * @returns the plan rows, beats, and checklist.
 * @throws {NovelContentError} on a malformed number or a repeated chapter.
 */
export function parseChapterPlanFile(
  raw: string,
  where: string,
  openingFallback: Outline['opening'],
): ChapterPlanFileContent {
  const sections = sectionsOf(raw, where)
  const rows: ChapterPlanRow[] = []
  const seen = new Set<number>()
  const table = parseTable(sections, CHAPTER_PLAN_SECTIONS.table, where)
  for (const row of table?.rows ?? []) {
    const number = Number.parseInt((row[0] ?? '').trim(), 10)
    if (!Number.isFinite(number) || number <= 0) {
      throw new NovelContentError(`${where}: chapter table row has no usable chapter number: ${JSON.stringify(row[0] ?? '')}`)
    }
    if (seen.has(number)) {
      throw new NovelContentError(`${where}: chapter ${String(number)} appears twice in the chapter table`)
    }
    seen.add(number)
    rows.push({
      number,
      title: (row[1] ?? '').trim(),
      volume: Number.parseInt((row[2] ?? '').trim(), 10) || 0,
      targetWords: Number.parseInt((row[3] ?? '').trim(), 10) || 0,
      oneLine: (row[4] ?? '').trim(),
      // The five-column spelling the plan sketched has no separate synopsis, so
      // the one-line summary is read as both rather than losing the field.
      synopsis: (row[5] ?? row[4] ?? '').trim(),
    })
  }
  rows.sort((a, b) => a.number - b.number)

  const beats: { chapter: number; kind: BeatKind; note: string }[] = []
  const beatSeen = new Set<number>()
  const beatTable = parseTable(sections, CHAPTER_PLAN_SECTIONS.beats, where)
  for (const row of beatTable?.rows ?? []) {
    const chapter = Number.parseInt((row[0] ?? '').trim(), 10)
    if (!Number.isFinite(chapter) || chapter <= 0) {
      throw new NovelContentError(`${where}: rhythm table row has no usable chapter number: ${JSON.stringify(row[0] ?? '')}`)
    }
    if (beatSeen.has(chapter)) {
      throw new NovelContentError(`${where}: chapter ${String(chapter)} appears twice in the rhythm table`)
    }
    beatSeen.add(chapter)
    const kind = (row[1] ?? '').trim()
    if (!(BEAT_KINDS as readonly string[]).includes(kind)) {
      throw new NovelContentError(
        `${where}: rhythm table row for chapter ${String(chapter)} has unknown kind "${kind}"; expected one of ${BEAT_KINDS.join(', ')}`,
      )
    }
    beats.push({ chapter, kind: kind as BeatKind, note: (row[2] ?? '').trim() })
  }
  beats.sort((a, b) => a.chapter - b.chapter)

  return { rows, beats, opening: parseOpening(sections, openingFallback) }
}

/**
 * Read the opening-engineering checklist.
 *
 * The plan's §4 table does not name a home for this list, so by the rule that
 * "no home named must never mean silently dropped" it is written here, next to
 * the plan it belongs to, and kept in the metadata document as the default for a
 * project that has never had the section written.
 *
 * @param sections - the file's sections.
 * @param fallback - the checklist to keep when the section is absent.
 * @returns the checklist.
 */
function parseOpening(sections: readonly MdSection[], fallback: Outline['opening']): Outline['opening'] {
  const list = sectionList(sections, CHAPTER_PLAN_SECTIONS.opening)
  if (list.length === 0) return fallback
  let found = false
  const parsed = list.map((line) => {
    const match = /^\[(?<done>[ xX])\]\s*(?<rest>.*)$/u.exec(line.trim())
    const done = match?.groups?.['done']?.toLowerCase() === 'x'
    if (match !== null) found = true
    // Render order is `key — note（requirement）`; the requirement suffix is a
    // display aid, so strip it from the tail *before* splitting, and read the
    // key back out so a file that was only ever read still yields the key that
    // `novel_plan operation="opening"` addresses.
    const rest = (match?.groups?.['rest'] ?? line).trim()
    const stripped = rest.replace(/（(?<requirement>[^（）]*)）$/u, '')
    const requirement = /（(?<requirement>[^（）]*)）$/u.exec(rest)?.groups?.['requirement'] ?? ''
    const separator = stripped.indexOf('—')
    return {
      key: (separator >= 0 ? stripped.slice(0, separator) : stripped).trim(),
      requirement,
      done,
      note: separator >= 0 ? stripped.slice(separator + 1).trim() : '',
    }
  })
  if (!found) return fallback
  // Keep the fallback's requirement text, which is the SOP's own wording and is
  // not reproduced in the file; a key the fallback does not know is kept as-is.
  return parsed.map((check) => {
    const known = fallback.find((entry) => entry.key === check.key)
    if (known === undefined) return check
    return { ...check, requirement: known.requirement }
  })
}

/**
 * Render `章节大纲.md`.
 *
 * @param content - the plan rows, beats, and checklist.
 * @returns the file text.
 */
export function renderChapterPlanFile(content: ChapterPlanFileContent): string {
  // `synopsis` has a column of its own rather than sharing the one-line summary:
  // the summary describes the scene, the synopsis describes the contract, and the
  // plan's §4 gives both a home here. A sixth column is still one more than the
  // plan sketched, which is why the codec also reads the five-column spelling.
  const table = renderTable(
    ['章', '标题', '卷', '目标字数', '一句话', '梗概'],
    [...content.rows]
      .sort((a, b) => a.number - b.number)
      .map((row) => [
        String(row.number),
        row.title,
        row.volume === 0 ? '' : String(row.volume),
        row.targetWords === 0 ? '' : String(row.targetWords),
        row.oneLine,
        row.synopsis,
      ]),
  )
  const beatTable = renderTable(
    ['章', '类型', '一句话'],
    [...content.beats]
      .sort((a, b) => a.chapter - b.chapter)
      .map((beat) => [String(beat.chapter), beat.kind, beat.note]),
  )
  const opening = content.opening.map(
    (check) =>
      `- [${check.done ? 'x' : ' '}] ${check.key}${check.note === '' ? '' : ` — ${check.note}`}${check.requirement === '' ? '' : `（${check.requirement}）`}`,
  )
  const sections = [
    `## ${CHAPTER_PLAN_SECTIONS.table}\n\n${table}\n`,
    `## ${CHAPTER_PLAN_SECTIONS.beats}\n\n${beatTable}\n`,
    opening.length === 0
      ? `## ${CHAPTER_PLAN_SECTIONS.opening}\n`
      : `## ${CHAPTER_PLAN_SECTIONS.opening}\n\n${opening.join('\n')}\n`,
  ]
  return renderDocument({}, '章节大纲', sections)
}

// ── chapter files ─────────────────────────────────────────────────────────────

/** One chapter's two files, parsed but not yet merged with the plan layer. */
export interface ChapterFileContent {
  /** Chapter id, from the contract file's frontmatter or a generated fallback. */
  readonly id: string
  /** Chapter number, from the contract file or its filename. */
  readonly number: number
  /** Volume, used only when the plan table lists no row for this chapter. */
  readonly volume: number
  /** Lifecycle status, owned by the prose file. */
  readonly status: ChapterStatus
  /** Prose body, exactly as written after the `#` heading. */
  readonly body: string
  /** Write timestamp, read from whichever file carries one. */
  readonly updatedAt: string
  /** Target length, used only when the plan table lists no row. */
  readonly targetWords: number
  /** The contract sections. */
  readonly plotTask: string
  /** The conflict that carries the chapter. */
  readonly conflict: string
  /** What the reader gets emotionally. */
  readonly emotionalPayoff: string
  /** The information gap the chapter opens or closes. */
  readonly infoGap: string
  /** Beats this chapter carries. */
  readonly beats: readonly BeatKind[]
  /** The chapter-end hook. */
  readonly hook: string
  /** Contract fields the author explicitly waived, with the reason. */
  readonly waived: Readonly<Partial<Record<ContractField, string>>>
  /** Fields the last `novel_write` reached. */
  readonly delivered: readonly ContractField[]
}

/**
 * Read the prose of a chapter file: everything after the first `#` heading.
 *
 * Text before that heading is not prose, which is what keeps a stray note above
 * the title from being counted as — or written back into — the chapter.
 *
 * @param body - the text after the frontmatter.
 * @returns the prose.
 */
export function chapterBodyOf(body: string): string {
  const match = /^#\s+.*$/mu.exec(body)
  if (match === null) return body.replace(/^\s+|\s+$/gu, '')
  return body.slice(match.index + match[0].length).replace(/^\s+|\s+$/gu, '')
}

/**
 * Parse one chapter's contract file.
 *
 * `id` and `number` are read rather than inferred from the filename — the plan
 * makes the id the stable key precisely so a rename cannot lose the chapter.
 *
 * @param raw - the file text.
 * @param where - the file path, for error messages.
 * @param bodyFile - the prose path, used to derive the id when the contract has none.
 * @returns the contract fields.
 * @throws {NovelContentError} when neither the frontmatter nor the filename identifies the chapter.
 */
export function parseChapterOutlineFile(raw: string, where: string, bodyFile: string): ChapterFileContent {
  const frontmatter = docFrontmatter(raw, where)
  const sections = splitSections(bodyText(raw, where))
  const waived: Partial<Record<ContractField, string>> = { ...frontMap(frontmatter, 'waived') } as Partial<
    Record<ContractField, string>
  >
  for (const key of Object.keys(waived)) {
    if (!(CONTRACT_FIELDS as readonly string[]).includes(key)) delete waived[key as ContractField]
  }
  const number = frontNumber(frontmatter, 'number', numberFromFileName(bodyFile) ?? 0)
  const beats = frontStringArray(frontmatter, 'beats')
  return {
    id: normalizeId(frontString(frontmatter, 'id', '')) || slugify(stemOf(bodyFile)),
    number,
    volume: frontNumber(frontmatter, 'volume', 0),
    status: 'planned',
    body: '',
    updatedAt: frontString(frontmatter, 'updatedAt', ''),
    targetWords: frontNumber(frontmatter, 'targetWords', 0),
    plotTask: sectionText(sections, CONTRACT_SECTIONS.plotTask),
    conflict: sectionText(sections, CONTRACT_SECTIONS.conflict),
    emotionalPayoff: sectionText(sections, CONTRACT_SECTIONS.emotionalPayoff),
    infoGap: sectionText(sections, CONTRACT_SECTIONS.infoGap),
    beats: beats.filter((beat): beat is BeatKind => (BEAT_KINDS as readonly string[]).includes(beat)),
    hook: sectionText(sections, CONTRACT_SECTIONS.hook),
    waived,
    delivered: CONTRACT_FIELDS.filter((field) => frontStringArray(frontmatter, 'delivered').includes(field)),
  }
}

/**
 * Parse one chapter's prose file.
 *
 * @param raw - the file text.
 * @param where - the file path, for error messages.
 * @param bodyFile - the same path, used to derive the id when the frontmatter has none.
 * @returns the prose and the fields the prose file owns.
 * @throws {NovelContentError} when neither the frontmatter nor the filename identifies the chapter.
 */
export function parseChapterBodyFile(raw: string, where: string, bodyFile: string): ChapterFileContent {
  const frontmatter = docFrontmatter(raw, where)
  const body = bodyText(raw, where)
  return {
    id: normalizeId(frontString(frontmatter, 'id', '')) || slugify(stemOf(bodyFile)),
    number: frontNumber(frontmatter, 'number', numberFromFileName(bodyFile) ?? 0),
    volume: 0,
    status: statusOf(frontString(frontmatter, 'status', 'planned')),
    body: chapterBodyOf(body),
    updatedAt: frontString(frontmatter, 'updatedAt', ''),
    targetWords: 0,
    plotTask: '',
    conflict: '',
    emotionalPayoff: '',
    infoGap: '',
    beats: [],
    hook: '',
    waived: {},
    delivered: [],
  }
}

/**
 * Render one chapter's contract file.
 *
 * `volume` and `targetWords` are written for a human reading the file alone but
 * are **not** read back when the plan table has a row: the plan layer owns them.
 *
 * @param chapter - the chapter.
 * @param updatedAt - the write timestamp.
 * @returns the file text.
 */
export function renderChapterOutlineFile(chapter: Chapter, updatedAt: string): string {
  const title = chapter.title === '' ? `第 ${String(chapter.number)} 章` : `第 ${String(chapter.number)} 章 ${chapter.title}`
  return renderDocument(
    dropEmpty({
      id: chapter.id,
      number: chapter.number,
      volume: chapter.volume,
      targetWords: chapter.targetWords,
      beats: [...chapter.beats],
      ...(Object.keys(chapter.waived).length === 0 ? {} : { waived: waivedMap(chapter) }),
      delivered: [...chapter.delivered],
      updatedAt,
    }),
    `${title} 细纲`,
    CONTRACT_SECTION_ORDER.map((section) => renderSection(section, chapterFieldOf(chapter, section))),
  )
}

/**
 * Render one chapter's prose file.
 *
 * `wordCount` is written even though it is derived: it is the number a human
 * wants to see in the editor, and the reader recomputes it on the way back in.
 *
 * @param chapter - the chapter.
 * @param updatedAt - the write timestamp.
 * @returns the file text.
 */
export function renderChapterBodyFile(chapter: Chapter, updatedAt: string): string {
  const title = chapter.title === '' ? `第 ${String(chapter.number)} 章` : `第 ${String(chapter.number)} 章 ${chapter.title}`
  return renderDocument(
    { id: chapter.id, number: chapter.number, status: chapter.status, wordCount: chapter.wordCount, updatedAt },
    title,
    chapter.body === '' ? [] : [`${chapter.body.replace(/\s+$/u, '')}\n`],
  )
}

/** The chapter field one contract section carries. */
function chapterFieldOf(chapter: Chapter, section: string): string {
  switch (section) {
    case CONTRACT_SECTIONS.plotTask:
      return chapter.plotTask
    case CONTRACT_SECTIONS.conflict:
      return chapter.conflict
    case CONTRACT_SECTIONS.emotionalPayoff:
      return chapter.emotionalPayoff
    case CONTRACT_SECTIONS.infoGap:
      return chapter.infoGap
    case CONTRACT_SECTIONS.hook:
      return chapter.hook
    default:
      return ''
  }
}

/** The `waived` map as a serializable record; `{}` when nothing is waived. */
function waivedMap(chapter: Chapter): Record<string, YamlScalar> {
  const entries = Object.entries(chapter.waived).filter(([, reason]) => reason !== undefined && reason !== '')
  return Object.fromEntries(entries) as Record<string, YamlScalar>
}

// ── composing and decomposing ─────────────────────────────────────────────────

/**
 * The content-bearing slice of a state, as the files that own it.
 *
 * @param state - the state to slice.
 * @returns one rendered text per kind, keyed by the index's own field names.
 */
export function decomposeContent(state: NovelState, updatedAt: string): {
  readonly outline: string
  readonly cast: string
  readonly world: string
  readonly volumes: string
  readonly chapterPlan: string
  readonly chapters: Readonly<Record<string, { readonly body: string; readonly outline: string }>>
} {
  const chapters: Record<string, { body: string; outline: string }> = {}
  for (const chapter of Object.values(state.chapters)) {
    chapters[chapter.id] = {
      body: renderChapterBodyFile(chapter, updatedAt),
      outline: renderChapterOutlineFile(chapter, updatedAt),
    }
  }
  return {
    outline: renderOutlineFile({
      logline: state.outline.logline,
      acts: state.outline.acts,
      minimal: state.outline.minimal,
      fullOutlineDone: state.outline.fullOutlineDone,
    }),
    cast: renderCastFile(state.characters),
    world: renderWorldFile(state.world),
    volumes: renderVolumeFile(state.outline.volumes),
    chapterPlan: renderChapterPlanFile({
      rows: planRowsOf(state),
      beats: state.outline.beats,
      opening: state.outline.opening,
    }),
    chapters,
  }
}

/**
 * The chapter plan rows a state implies.
 *
 * @param state - the state to read.
 * @returns one row per chapter, in reading order.
 */
export function planRowsOf(state: NovelState): ChapterPlanRow[] {
  return Object.values(state.chapters)
    .sort((a, b) => a.number - b.number)
    .map((chapter) => ({
      number: chapter.number,
      title: chapter.title,
      volume: chapter.volume,
      targetWords: chapter.targetWords,
      // The one-line summary is the plan's to write, so the tool does not invent
      // one: it seeds the column with the synopsis the contract already carries
      // rather than leaving a blank the author has to fill in twice.
      oneLine: chapter.synopsis,
      synopsis: chapter.synopsis,
    }))
}

/** The raw text of every content file, keyed by workspace-relative path. */
export type ContentFiles = Readonly<Record<string, string>>

/**
 * Assemble the content half of a state from the files that hold it.
 *
 * Missing files are not an error: a project that has never had a cast file has
 * no cast, which is exactly what an absent file means. A file that exists but
 * cannot be parsed **is** an error, and it names the file.
 *
 * @param files - the raw text of each content file, keyed by path.
 * @param index - the index naming those paths.
 * @param openingFallback - checklist kept when the plan file has no such section.
 * @returns the outline, cast, world, and chapters.
 * @throws {NovelContentError} when a present file is malformed or a key repeats.
 */
export function composeContent(
  files: ContentFiles,
  index: StorageIndex,
  openingFallback: Outline['opening'],
): {
  readonly outline: Outline
  readonly characters: Readonly<Record<string, Character>>
  readonly world: Readonly<Record<string, WorldEntry>>
  readonly chapters: Readonly<Record<string, Chapter>>
} {
  const read = (path: string): string | undefined => files[path]

  const outlineFile = read(index.outlineFile)
  const outlineText =
    outlineFile === undefined
      ? { logline: '', acts: [], minimal: '', fullOutlineDone: false }
      : parseOutlineFile(outlineFile, index.outlineFile)

  const planFile = read(index.chapterPlanFile)
  const plan =
    planFile === undefined
      ? { rows: [], beats: [], opening: openingFallback }
      : parseChapterPlanFile(planFile, index.chapterPlanFile, openingFallback)

  const volumeFile = read(index.volumeFile)

  const outline: Outline = {
    ...emptyOutline(),
    logline: outlineText.logline,
    acts: outlineText.acts,
    minimal: outlineText.minimal,
    fullOutlineDone: outlineText.fullOutlineDone,
    volumes: volumeFile === undefined ? [] : parseVolumeFile(volumeFile, index.volumeFile),
    beats: plan.beats,
    opening: plan.opening,
  }

  const castFile = read(index.castFile)
  const worldFile = read(index.worldFile)
  const characters = castFile === undefined ? {} : parseCastFile(castFile, index.castFile)
  const world = worldFile === undefined ? {} : parseWorldFile(worldFile, index.worldFile)

  const chapters = composeChapters(files, index, plan.rows)
  return { outline, characters, world, chapters }
}

/**
 * Merge the plan layer and the contract layer into chapters.
 *
 * @param files - the raw text of every content file.
 * @param index - the index naming each chapter's paths.
 * @param rows - the plan rows, which own number, title, volume, target, synopsis.
 * @returns chapters keyed by id.
 * @throws {NovelContentError} on a duplicate chapter number or a missing id.
 */
function composeChapters(
  files: ContentFiles,
  index: StorageIndex,
  rows: readonly ChapterPlanRow[],
): Record<string, Chapter> {
  const byId: Record<string, Chapter> = {}
  const numbers = new Map<number, string>()
  for (const [id, ref] of Object.entries(index.chapters)) {
    const bodyRaw = files[ref.bodyFile]
    const outlineRaw = files[ref.outlineFile]
    const bodyPart = bodyRaw === undefined ? undefined : parseChapterBodyFile(bodyRaw, ref.bodyFile, ref.bodyFile)
    const outlinePart =
      outlineRaw === undefined ? undefined : parseChapterOutlineFile(outlineRaw, ref.outlineFile, ref.bodyFile)
    if (bodyPart === undefined && outlinePart === undefined) continue

    const number = outlinePart?.number ?? bodyPart?.number ?? ref.number ?? numberFromFileName(ref.bodyFile) ?? 1
    const planRow = rows.find((row) => row.number === number)
    const body = bodyPart?.body ?? ''
    const chapter: Chapter = {
      id,
      number,
      // The plan table owns the title; the index remembers it so a chapter whose
      // plan row was deleted by hand still reads back with its name.
      title: planRow?.title ?? ref.title ?? '',
      synopsis: planRow?.synopsis ?? '',
      status: bodyPart?.status ?? 'planned',
      body,
      wordCount: countWords(body),
      updatedAt: bodyPart?.updatedAt ?? outlinePart?.updatedAt ?? '',
      volume: planRow?.volume ?? outlinePart?.volume ?? 0,
      plotTask: outlinePart?.plotTask ?? '',
      conflict: outlinePart?.conflict ?? '',
      emotionalPayoff: outlinePart?.emotionalPayoff ?? '',
      infoGap: outlinePart?.infoGap ?? '',
      beats: outlinePart?.beats ?? [],
      hook: outlinePart?.hook ?? '',
      targetWords: planRow?.targetWords ?? outlinePart?.targetWords ?? 0,
      waived: outlinePart?.waived ?? {},
      delivered: outlinePart?.delivered ?? [],
    }
    const clash = numbers.get(number)
    if (clash !== undefined) {
      throw new NovelContentError(
        `chapter ${String(number)} is claimed twice: "${clash}" and "${id}" (see ${ref.outlineFile}); renumber one of them`,
      )
    }
    numbers.set(number, id)
    byId[id] = chapter
  }
  return sortById(byId)
}

/** Sort a chapter map into reading order, keyed by id. */
function sortById(chapters: Readonly<Record<string, Chapter>>): Record<string, Chapter> {
  const entries = Object.entries(chapters).sort(([, a], [, b]) => a.number - b.number || a.id.localeCompare(b.id))
  return Object.fromEntries(entries)
}

// ── shared small helpers ──────────────────────────────────────────────────────

/** The file lines a `#`-only slug is derived from: the basename minus extensions. */
function stemOf(path: string): string {
  const base = path.split('/').pop() ?? path
  return base.replace(/\.细纲\.md$/u, '').replace(/\.md$/u, '')
}

/** Narrow a raw status string. */
function statusOf(value: string): ChapterStatus {
  return CHAPTER_STATUSES.find((status) => status === value) ?? 'planned'
}

/** Parse a chapter-plan frontmatter value that should be a list of numbers. */
function numberList(value: YamlValue | undefined): number[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => (typeof item === 'number' ? item : Number.parseInt(String(item ?? ''), 10)))
    .filter((item) => Number.isFinite(item) && item > 0)
}

/** Parse a file's frontmatter, mapping a parse failure to {@link NovelContentError}. */
function docFrontmatter(raw: string, where: string): ReturnType<typeof parseDocument>['frontmatter'] {
  try {
    return parseDocument(raw, where).frontmatter
  } catch (cause) {
    throw wrap(cause, where)
  }
}

/** Split a file into sections, mapping a parse failure to {@link NovelContentError}. */
function sectionsOf(raw: string, where: string): MdSection[] {
  return splitSections(bodyText(raw, where))
}

/** The body of a file: its text after the frontmatter. */
function bodyText(raw: string, where: string): string {
  try {
    return parseDocument(raw, where).body
  } catch (cause) {
    throw wrap(cause, where)
  }
}

/** Re-raise a codec failure as a content failure that names the file. */
function wrap(cause: unknown, where: string): NovelContentError {
  if (cause instanceof NovelContentError) return cause
  const complaint = cause instanceof MarkdownError ? cause.message : String(cause)
  const message = complaint.includes(where) ? complaint : `${where}: ${complaint}`
  return new NovelContentError(message, { cause })
}

/** Drop keys whose value is `undefined` or an empty string. */
function dropEmpty(source: Readonly<Record<string, YamlValue | undefined>>): Record<string, YamlValue | undefined> {
  const result: Record<string, YamlValue | undefined> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (typeof value === 'string' && value === '') continue
    // An empty list is dropped — `beats: []` and no key mean the same thing —
    // but an empty *map* is kept: `waived: {}` is a recorded answer, and
    // dropping it would let a corrected waiver silently reappear.
    if (Array.isArray(value) && value.length === 0) continue
    Object.assign(result, { [key]: value })
  }
  return result
}

