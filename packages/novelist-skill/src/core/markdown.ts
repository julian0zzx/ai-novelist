/**
 * The Markdown codec: the restricted dialect this plugin reads and writes.
 *
 * Why hand-rolled instead of a YAML dependency: the frontmatter this plugin
 * writes is a closed, tiny language (scalars, string arrays, one level of
 * mapping), and the promise the store makes — *a file the author broke is
 * reported with the file named and never silently replaced* — is easier to keep
 * when the parser's exact limits are visible in one file than when they live
 * inside a general-purpose library that would accept far more than we emit.
 *
 * The dialect is deliberately four things, and nothing else is inferred from
 * free text:
 *
 * | construct | where it appears |
 * |---|---|
 * | YAML frontmatter | the head of every content file |
 * | `##` sections | prose fields, one section per field |
 * | fenced ```yaml blocks | one entry's machine-readable keys |
 * | pipe tables | the chapter plan and the rhythm table |
 *
 * Every reader here throws {@link MarkdownError} with the file **and** the
 * specific complaint, because the caller's only correct response to a malformed
 * file is to name it and refuse, never to guess.
 *
 * @module @ai-novelist/novelist-skill/core/markdown
 */

import { createHash } from 'node:crypto'

/** Raised when a file is not in the dialect this codec writes. */
export class MarkdownError extends Error {
  override readonly name = 'MarkdownError'
}

// ── scalars ───────────────────────────────────────────────────────────────────

/** One frontmatter value: what the restricted YAML dialect can carry. */
export type YamlScalar = string | number | boolean | null

/** One parsed frontmatter value: a scalar, a list of scalars, or one nested mapping. */
export type YamlValue = YamlScalar | YamlScalar[] | Record<string, YamlScalar>

/** A parsed frontmatter block, in the order the keys appeared. */
export type YamlMap = Record<string, YamlValue>

// ── hashing ───────────────────────────────────────────────────────────────────

/**
 * Content hash of one file, for skip-unchanged caching and drift detection.
 *
 * Its job is *not* conflict interception — the storage policy is "the file
 * wins" — it is telling "this file is byte-identical to what we parsed last
 * time" apart from "someone edited this file".
 *
 * @param content - the full file text.
 * @returns the digest, prefixed `sha256:` so the algorithm is recorded.
 */
export function hashContent(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`
}

// ── frontmatter ───────────────────────────────────────────────────────────────

/**
 * Split a file into its frontmatter block and everything after it.
 *
 * A file with no frontmatter is legal (the plan calls for "缺 frontmatter" to be
 * tolerated), so this reports `found: false` rather than throwing; it is the
 * per-file readers that decide whether the block was mandatory.
 *
 * @param raw - the full file text.
 * @returns the frontmatter body (without the `---` fences) and the remaining text.
 */
export function splitFrontmatter(raw: string): { readonly found: boolean; readonly frontmatter: string; readonly body: string } {
  const lines = raw.split('\n')
  if ((lines[0] ?? '').trim() !== '---') return { found: false, frontmatter: '', body: raw }
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line.trim() === '---' || line.trim() === '...') {
      return {
        found: true,
        frontmatter: lines.slice(1, index).join('\n'),
        body: lines.slice(index + 1).join('\n'),
      }
    }
  }
  throw new MarkdownError('frontmatter block is never closed (no closing `---` line)')
}

/**
 * Parse one frontmatter block.
 *
 * @param text - the block's text, without the fences.
 * @param where - the file the text came from, for error messages.
 * @returns the parsed mapping, in key order.
 * @throws {MarkdownError} on a line that is not `key: value`, an indentation that
 *   implies a nesting depth the dialect does not have, or a nested block whose
 *   parent is not a mapping key.
 */
export function parseFrontmatter(text: string, where: string): YamlMap {
  const map: YamlMap = {}
  const lines = text.split('\n')
  let index = 0
  while (index < lines.length) {
    const raw = lines[index] ?? ''
    index += 1
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue
    if (/^\s/u.test(raw)) {
      throw new MarkdownError(`${where}: indented frontmatter line without a parent key: ${JSON.stringify(raw)}`)
    }
    const match = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*:(.*)$/u.exec(raw)
    if (match === null) {
      throw new MarkdownError(`${where}: expected "key: value" in frontmatter, found ${JSON.stringify(raw)}`)
    }
    const key = match[1] ?? ''
    const rest = (match[2] ?? '').trim()
    const collected: string[] = []
    while (index < lines.length && /^\s+\S/u.test(lines[index] ?? '')) {
      collected.push((lines[index] ?? '').trim())
      index += 1
    }
    if (collected.length === 0) {
      Object.assign(map, { [key]: parseScalarToken(rest) })
      continue
    }
    if (rest !== '') {
      throw new MarkdownError(`${where}: key "${key}" carries both an inline value and an indented block`)
    }
    Object.assign(map, { [key]: parseNested(collected, key, where) })
  }
  return map
}

/**
 * Parse the indented lines that follow one key.
 *
 * @param lines - the trimmed indented lines.
 * @param key - the parent key, for error messages.
 * @param where - the file, for error messages.
 * @returns the string array or nested mapping the lines describe.
 * @throws {MarkdownError} when the block mixes the two shapes or misindents.
 */
function parseNested(lines: readonly string[], key: string, where: string): YamlScalar[] | Record<string, YamlScalar> {
  const entries: [string, YamlScalar][] = []
  const items: YamlScalar[] = []
  for (const line of lines) {
    if (line.startsWith('- ') || line === '-') {
      const text = line === '-' ? '' : line.slice(2).trim()
      if (text.includes(': ') && /^[A-Za-z_][A-Za-z0-9_.-]*\s*:/u.test(text)) {
        const inner = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*:(.*)$/u.exec(text)
        if (inner === null) throw new MarkdownError(`${where}: cannot read list entry under "${key}": ${JSON.stringify(line)}`)
        entries.push([inner[1] ?? '', toScalar((inner[2] ?? '').trim())])
        continue
      }
      items.push(toScalar(text))
      continue
    }
    const match = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*:(.*)$/u.exec(line)
    if (match === null) {
      throw new MarkdownError(`${where}: cannot read nested value under "${key}": ${JSON.stringify(line)}`)
    }
    entries.push([match[1] ?? '', toScalar((match[2] ?? '').trim())])
  }
  if (items.length > 0 && entries.length > 0) {
    throw new MarkdownError(`${where}: list under "${key}" mixes "- item" and "key: value" lines`)
  }
  if (items.length > 0) return items
  const record: Record<string, YamlScalar> = {}
  for (const [entryKey, value] of entries) Object.assign(record, { [entryKey]: value })
  return record
}

/**
 * Read one inline token as a scalar or a list.
 *
 * @param text - the token text, already trimmed.
 * @returns the scalar, or the list when the token is `[a, b]`.
 * @throws {MarkdownError} when an inline list is never closed.
 */
export function parseScalarToken(text: string): YamlScalar | YamlScalar[] {
  if (text.startsWith('[')) {
    if (!text.endsWith(']')) throw new MarkdownError(`inline list is never closed: ${JSON.stringify(text)}`)
    const inner = text.slice(1, -1).trim()
    if (inner === '') return []
    return splitInlineList(inner).map((item) => toScalar(item))
  }
  return toScalar(text)
}

/**
 * Split an inline list body on commas that are not inside quotes.
 *
 * @param inner - the text between the brackets.
 * @returns the raw member tokens.
 */
function splitInlineList(inner: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  for (const char of inner) {
    if (quote !== undefined) {
      current += char
      if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === ',') {
      parts.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  parts.push(current.trim())
  return parts.filter((part) => part !== '')
}

/**
 * Coerce one written token to a scalar, stripping one layer of matching quotes.
 *
 * @param text - the raw token.
 * @returns the scalar.
 */
function toScalar(text: string): YamlScalar {
  const trimmed = text.trim()
  if (trimmed === '' || trimmed === '~' || trimmed === 'null') return null
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  const quoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  if (quoted) return trimmed.slice(1, -1)
  if (/^-?\d+$/u.test(trimmed)) return Number.parseInt(trimmed, 10)
  return trimmed
}

/** Escape a value so it survives a double-quoted YAML scalar. */
function quote(text: string): string {
  const escaped = text.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"').replace(/\n/gu, '\\n')
  return `"${escaped}"`
}

/**
 * Serialize one frontmatter value.
 *
 * Text is always quoted, so a title that begins with a digit or happens to spell
 * `true` still reads back as the string it is; numbers and booleans are emitted
 * bare so they round-trip as themselves.
 *
 * @param value - the value to serialize.
 * @returns the YAML text for one value.
 */
export function serializeScalar(value: YamlValue): string {
  if (typeof value === 'string') return quote(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null) return 'null'
  if (Array.isArray(value)) return `[${value.map((item) => serializeScalar(item)).join(', ')}]`
  return '{}'
}

/**
 * Serialize a frontmatter mapping.
 *
 * A one-level mapping is written as an indented block rather than an inline
 * `{}`, because the block spelling is the one a human reads and edits — and the
 * parser accepts both, so either round-trips.
 *
 * Keys whose value is `undefined` are omitted rather than written as `null`, so
 * "not recorded yet" survives a round trip as an absent key.
 *
 * @param map - the entries to write, in order.
 * @returns the frontmatter text, without fences.
 */
export function serializeFrontmatter(map: Readonly<Record<string, YamlValue | undefined>>): string {
  const lines: string[] = []
  for (const [key, value] of Object.entries(map)) {
    if (value === undefined) continue
    if (isNestedMap(value)) {
      lines.push(`${key}:`)
      for (const [entryKey, entryValue] of Object.entries(value)) {
        if (entryValue === undefined) continue
        lines.push(`  ${entryKey}: ${serializeScalar(entryValue)}`)
      }
      continue
    }
    lines.push(`${key}: ${serializeScalar(value)}`)
  }
  return lines.join('\n')
}

/** Whether a value is a nested mapping rather than a scalar or a list. */
function isNestedMap(value: YamlValue): value is Record<string, YamlScalar> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read a scalar field from a parsed mapping.
 *
 * @param map - the parsed frontmatter.
 * @param key - the field name.
 * @param fallback - value used when the field is absent or not a scalar.
 * @returns the value as a string, or the fallback.
 */
export function frontString(map: YamlMap, key: string, fallback: string): string {
  const value = map[key]
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return fallback
}

/**
 * Read a finite-number field from a parsed mapping.
 *
 * @param map - the parsed frontmatter.
 * @param key - the field name.
 * @param fallback - value used when the field is absent or not a finite number.
 * @returns the number or the fallback.
 */
export function frontNumber(map: YamlMap, key: string, fallback: number): number {
  const value = map[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return fallback
}

/**
 * Read a boolean field from a parsed mapping.
 *
 * @param map - the parsed frontmatter.
 * @param key - the field name.
 * @param fallback - value used when the field is absent or not a boolean.
 * @returns the boolean or the fallback.
 */
export function frontBool(map: YamlMap, key: string, fallback: boolean): boolean {
  const value = map[key]
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

/**
 * Read a scalar-list field from a parsed mapping.
 *
 * Accepts both spellings the plan requires: `key: [a, b]` (parsed as a list) and
 * a `key:` line followed by `- a` lines (parsed the same way).
 *
 * @param map - the parsed frontmatter.
 * @param key - the field name.
 * @returns the members as strings, empty when absent.
 */
export function frontStringArray(map: YamlMap, key: string): string[] {
  const value = map[key]
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is Exclude<YamlScalar, null> => item !== null)
    .map((item) => (typeof item === 'string' ? item : String(item)))
}

/**
 * Read a one-level mapping field from a parsed mapping.
 *
 * @param map - the parsed frontmatter.
 * @param key - the field name.
 * @returns the nested mapping as strings, empty when absent.
 */
export function frontMap(map: YamlMap, key: string): Record<string, string> {
  const value = map[key]
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Record<string, string> = {}
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (entryValue === null) continue
    result[entryKey] = typeof entryValue === 'string' ? entryValue : String(entryValue)
  }
  return result
}

// ── sections ──────────────────────────────────────────────────────────────────

/** One `##` section: its heading text and the text between it and the next one. */
export interface MdSection {
  /** Heading text with the `## ` prefix and trailing whitespace removed. */
  readonly title: string
  /** The section's body, trailing blank lines removed. */
  readonly body: string
}

/**
 * Split a body into its `##` sections.
 *
 * Headings inside fenced code blocks are not headings — a chapter contract may
 * legitimately contain ```yaml or a quoted scene containing `##`, and treating
 * those as structure would corrupt the section map.
 *
 * @param body - the file text after the frontmatter.
 * @returns the sections, in file order.
 */
export function splitSections(body: string): MdSection[] {
  const lines = body.split('\n')
  const sections: MdSection[] = []
  let fence: string | undefined
  let title: string | undefined
  let buffer: string[] = []
  const flush = (): void => {
    if (title === undefined) return
    sections.push({ title, body: buffer.join('\n').replace(/\s+$/u, '') })
  }
  for (const line of lines) {
    const marker = fenceMarker(line)
    if (marker !== undefined) {
      if (fence === undefined) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined
      if (title !== undefined) buffer.push(line)
      continue
    }
    const heading = fence === undefined ? /^##[ \t]+(.*?)[ \t]*$/u.exec(line) : null
    if (heading !== null) {
      flush()
      title = heading[1] ?? ''
      buffer = []
      continue
    }
    if (title !== undefined) buffer.push(line)
  }
  flush()
  return sections
}

/**
 * Detect a code-fence line.
 *
 * @param line - one line of text.
 * @returns the fence marker (backticks or tildes), or `undefined`.
 */
function fenceMarker(line: string): string | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})/u.exec(line)
  return match?.[1]
}

/**
 * Find one section by heading text.
 *
 * @param sections - the sections to search, typically from {@link splitSections}.
 * @param title - the exact heading text to match.
 * @returns the section, or `undefined`.
 */
export function findSection(sections: readonly MdSection[], title: string): MdSection | undefined {
  return sections.find((section) => section.title === title)
}

/**
 * Read the body of one section as a text field.
 *
 * @param sections - the sections to search.
 * @param title - the exact heading text.
 * @returns the trimmed section body, or `''` when the section is absent — which
 *   is the documented meaning of a missing contract section ("未写").
 */
export function sectionText(sections: readonly MdSection[], title: string): string {
  return findSection(sections, title)?.body.trim() ?? ''
}

/**
 * Read one section's body as an ordered list.
 *
 * Both `1.` and `-` markers are accepted; a section whose items wrap onto
 * continuation lines keeps them, because the item text is prose the author wrote.
 *
 * @param sections - the sections to search.
 * @param title - the exact heading text.
 * @returns the items in order, empty when the section is absent.
 */
export function sectionList(sections: readonly MdSection[], title: string): string[] {
  const body = sectionText(sections, title)
  if (body === '') return []
  const items: string[] = []
  for (const line of body.split('\n')) {
    const match = /^\s*(?:\d+[.)]|[-*])[ \t]+(.*)$/u.exec(line)
    if (match !== null) {
      items.push((match[1] ?? '').trim())
      continue
    }
    const last = items.length - 1
    if (last >= 0 && line.trim() !== '') items[last] = `${items[last] ?? ''}\n${line.trim()}`
  }
  return items
}

/**
 * Render a text field as a `##` section.
 *
 * @param title - the heading text.
 * @param body - the field value.
 * @returns the section, with a blank line between heading and body.
 */
export function renderSection(title: string, body: string): string {
  const text = body.replace(/\s+$/u, '')
  return text === '' ? `## ${title}\n` : `## ${title}\n\n${text}\n`
}

/**
 * Render an ordered list as a `##` section.
 *
 * @param title - the heading text.
 * @param items - the list items, in order.
 * @returns the section.
 */
export function renderListSection(title: string, items: readonly string[]): string {
  if (items.length === 0) return `## ${title}\n`
  return `## ${title}\n\n${items.map((item, index) => `${String(index + 1)}. ${item}`).join('\n')}\n`
}

// ── fenced yaml blocks ────────────────────────────────────────────────────────

/** A `##` section whose body is one ```yaml block followed by free prose. */
export interface EntryBlock {
  /** The section heading, which doubles as the entry's display name. */
  readonly title: string
  /** The parsed ```yaml block, empty when the section has none. */
  readonly fields: YamlMap
  /** Everything after the ```yaml block, trimmed. */
  readonly prose: string
}

/**
 * Split a section body into its leading ```yaml block and the prose after it.
 *
 * @param body - the section body.
 * @returns the two parts; either may be empty.
 * @throws {MarkdownError} when a ```yaml fence is opened and never closed.
 */
export function splitEntryBody(body: string): { readonly fields: string; readonly prose: string } {
  const lines = body.split('\n')
  let start = -1
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line.trim() === '') continue
    if (/^```ya?ml\s*$/iu.test(line.trim())) {
      start = index
      break
    }
    // The section's first content line is not a yaml block: all prose.
    return { fields: '', prose: body.trim() }
  }
  if (start < 0) return { fields: '', prose: body.trim() }
  for (let index = start + 1; index < lines.length; index += 1) {
    if ((lines[index] ?? '').trim() === '```') {
      return {
        fields: lines.slice(start + 1, index).join('\n'),
        prose: lines.slice(index + 1).join('\n').trim(),
      }
    }
  }
  throw new MarkdownError('```yaml block is never closed')
}

/**
 * Read every `##` section as an entry: heading, ```yaml block, trailing prose.
 *
 * @param sections - the sections to read.
 * @param where - the file name, for error messages.
 * @returns the entries in file order.
 * @throws {MarkdownError} when a section's yaml block is malformed.
 */
export function readEntries(sections: readonly MdSection[], where: string): EntryBlock[] {
  return sections.map((section) => {
    const { fields, prose } = splitEntryBody(section.body)
    return {
      title: section.title,
      fields: fields.trim() === '' ? {} : parseFrontmatter(fields, where),
      prose,
    }
  })
}

/**
 * Render one entry: `##` heading, a ```yaml block, then the prose.
 *
 * @param title - the heading text.
 * @param fields - the machine-readable keys.
 * @param prose - the free text after the block.
 * @returns the section text.
 */
export function renderEntry(title: string, fields: Readonly<Record<string, YamlValue | undefined>>, prose: string): string {
  const head = `## ${title}\n`
  const block = serializeFrontmatter(fields)
  const text = prose.replace(/\s+$/u, '')
  const parts = [head]
  if (block !== '') parts.push(`\n\`\`\`yaml\n${block}\n\`\`\`\n`)
  if (text !== '') parts.push(`\n${text}\n`)
  return parts.join('')
}

// ── tables ────────────────────────────────────────────────────────────────────

/** One parsed pipe table. */
export interface MdTable {
  /** The header row's cells. */
  readonly header: readonly string[]
  /** The body rows, each with exactly as many cells as the header. */
  readonly rows: readonly (readonly string[])[]
}

/** A character no author types, used to protect escaped pipes while splitting. */
const PIPE_SENTINEL = '\u0000'

/**
 * Parse the first pipe table inside one section.
 *
 * Rules, all of them from the plan: the first `|`-leading line is the header, a
 * separator row (`|---|---|`) is skipped, and `\|` is an escaped literal pipe. A
 * data row whose cell count differs from the header's is an **error**, not a
 * silently shifted row — misaligned prose is exactly the corruption this format
 * must not produce.
 *
 * @param sections - the sections to search.
 * @param title - the section heading that holds the table.
 * @param where - the file name, for error messages.
 * @returns the table, or `undefined` when the section has no table.
 * @throws {MarkdownError} when a row's cell count does not match the header's.
 */
export function parseTable(sections: readonly MdSection[], title: string, where: string): MdTable | undefined {
  const body = findSection(sections, title)?.body
  if (body === undefined) return undefined
  const rows: string[][] = []
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) continue
    const cells = splitRow(trimmed)
    if (cells.every((cell) => /^:?-{2,}:?$/u.test(cell.trim())) && cells.length > 0) continue
    rows.push(cells)
  }
  if (rows.length === 0) return undefined
  const header = rows[0] ?? []
  for (const row of rows.slice(1)) {
    if (row.length !== header.length) {
      throw new MarkdownError(
        `${where}: table under "## ${title}" has ${String(row.length)} cells where the header has ${String(header.length)}: ${row.join(' | ')}`,
      )
    }
  }
  return { header, rows: rows.slice(1) }
}

/**
 * Split one table line into cells, honoring `\|` escapes.
 *
 * @param line - the trimmed line, starting with `|`.
 * @returns the cell texts, unescaped and trimmed.
 */
function splitRow(line: string): string[] {
  const protectedLine = line.replace(/\\\|/gu, PIPE_SENTINEL)
  const trimmed = protectedLine.replace(/^\|/u, '').replace(/\|$/u, '')
  return trimmed.split('|').map((cell) => cell.split(PIPE_SENTINEL).join('|').trim())
}

/**
 * Escape a value so it survives one table cell.
 *
 * @param text - the value.
 * @returns the text with pipes escaped and newlines flattened.
 */
export function escapeCell(text: string): string {
  return text.replace(/\|/gu, '\\|').replace(/\r?\n/gu, ' ').trim()
}

/**
 * Render one pipe table, with the column widths padded for readability.
 *
 * @param header - the header cells.
 * @param rows - the body rows, each already the header's length.
 * @returns the table text, without a trailing newline.
 */
export function renderTable(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const escaped = rows.map((row) => row.map((cell) => escapeCell(cell)))
  const widths = header.map((cell, index) =>
    Math.max(3, cell.length, ...escaped.map((row) => (row[index] ?? '').length)),
  )
  const line = (cells: readonly string[]): string =>
    `| ${cells.map((cell, index) => cell.padEnd(widths[index] ?? 3)).join(' | ')} |`
  const separator = `|${widths.map((width) => '-'.repeat(width + 2)).join('|')}|`
  return [line(header), separator, ...escaped.map((row) => line(row))].join('\n')
}

// ── whole documents ───────────────────────────────────────────────────────────

/** A content file split into its frontmatter and its body. */
export interface MarkdownDocument {
  /** Whether the file carried a frontmatter block at all. */
  readonly hasFrontmatter: boolean
  /** The parsed frontmatter. */
  readonly frontmatter: YamlMap
  /** The text after the frontmatter. */
  readonly body: string
}

/**
 * Parse a whole content file.
 *
 * @param raw - the file text.
 * @param where - the file name, for error messages.
 * @returns the frontmatter and body.
 * @throws {MarkdownError} when the frontmatter is malformed.
 */
export function parseDocument(raw: string, where: string): MarkdownDocument {
  const { found, frontmatter, body } = splitFrontmatter(raw)
  return {
    hasFrontmatter: found,
    frontmatter: found ? parseFrontmatter(frontmatter, where) : {},
    body,
  }
}

/**
 * Render a whole content file: frontmatter, `#` title, then the sections.
 *
 * @param frontmatter - the machine-readable keys.
 * @param title - the level-one title line.
 * @param sections - the rendered sections, in order.
 * @returns the file text, ending in exactly one newline.
 */
export function renderDocument(
  frontmatter: Readonly<Record<string, YamlValue | undefined>>,
  title: string,
  sections: readonly string[],
): string {
  const entries = serializeFrontmatter(frontmatter)
  // A file with no machine-readable keys gets no frontmatter block at all: an
  // empty `---` pair is noise a human has to read past, and the parser treats
  // "absent" and "empty" identically.
  const head = entries === '' ? '' : `---\n${entries}\n---\n`
  const heading = title === '' ? '' : `\n# ${title}\n`
  const body = sections.map((section) => `\n${section.replace(/\s+$/u, '')}\n`).join('')
  return `${head}${heading}${body}`
}
