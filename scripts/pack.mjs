#!/usr/bin/env node
/**
 * Package the composer into the two distributions the project ships.
 *
 * Both contain the same nine tools — the tool code is copied from this
 * checkout's build, never re-implemented — but they answer different questions:
 *
 * 1. **DSH plugin distribution** (`dist/dsh-plugin/`): one tarball, one package.
 *    `@ai-novelist/novelist-bundle` is simultaneously the profile bundle (it declares
 *    `dsh.bundle.patch`), the plugin (its root and `./host` exports resolve to
 *    the module that registers the tools) and the browser half (`./client`).
 *
 * 2. **SKILL distribution** (`dist/skill/ai-novelist/`): the portable
 *    Agent Skill bundle. `SKILL.md` carries the frontmatter DSH's filesystem
 *    provider parses and a table of all nine tools, `references/` holds the
 *    workflow and the generated tool/threshold references, `scripts/` holds the
 *    installer, and `plugin/` carries distribution 1's own tarball.
 *
 * Why one merged package instead of a bundle plus a plugin: a distribution has to
 * be one installable artifact, and pnpm's tarball install understands exactly one
 * package per archive. Both alternatives were tested and failed — a nested
 * `file:./sub` resolves against the install site (`ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND`),
 * and two side-by-side packages with `file:../sibling` extracted only one of them.
 * The source repository keeps the two packages separate because they are built by
 * different tools for different targets; only the distribution merges them.
 *
 * @module scripts/pack
 */

import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const DIST = join(ROOT, 'dist')

/** Package directories, by the role they play in the build. */
const BUNDLE_DIR = join(ROOT, 'packages', 'novelist-bundle')
const HOST_DIR = join(ROOT, 'packages', 'novelist-skill')

/**
 * The shipped package name, which is also the patch row's name.
 *
 * The row must name the *bare package*: the client-half scanner derives a
 * package root with `exactPackageSpecifier(row.name)`, which returns `undefined`
 * for anything carrying a subpath, so a row named `@ai-novelist/novelist-bundle/host`
 * resolves the plugin but leaves the browser half out of the boot graph. The
 * root export is therefore the plugin module, and `./host` remains as an alias.
 */
const PACKAGE_NAME = '@ai-novelist/novelist-bundle'

/** The staged directory name inside the tarball. */
const STAGE_NAME = 'ai-novelist'

/** The development package that builds the plugin, named for the filter. */
const HOST_PACKAGE_NAME = '@ai-novelist/novelist-skill'

/**
 * The built SOP spec, loaded once from the plugin's own `lib/`.
 *
 * Every table, every revision number and the per-phase reference split come from
 * this one module, so a distribution cannot describe a surface the plugin does not
 * have. It is loaded **after** the build, from compiled output rather than from
 * `src/`, so what the tables describe is exactly what shipped.
 *
 * @type {Promise<Record<string, any>> | undefined}
 */
let specPromise

/**
 * Load the built spec, caching the import.
 *
 * @returns the `core/sop.js` module namespace.
 */
async function sop() {
  specPromise ??= import(pathToFileURL(join(HOST_DIR, 'lib', 'core', 'sop.js')).href)
  return specPromise
}

/** The built craft module, loaded once from the same `lib/` the distributions ship. */
let craftSpecPromise

/**
 * Load the built craft sheets, caching the import.
 *
 * @returns the `core/craft.generated.js` module namespace.
 */
async function craftSpec() {
  craftSpecPromise ??= import(pathToFileURL(join(HOST_DIR, 'lib', 'core', 'craft.generated.js')).href)
  return craftSpecPromise
}

/**
 * Render one tool's operations cell.
 *
 * @param tool - the spec's tool entry.
 * @returns the operations, or an em dash when the tool takes none.
 */
function operationsCell(tool) {
  return tool.operations.length === 0 ? '—' : tool.operations.join(', ')
}

/**
 * Render the tool table as Markdown rows, from the spec.
 *
 * @returns the table body, one line per tool.
 */
async function toolTableRows() {
  const { TOOL_SURFACE, TOOL_ORDER } = await sop()
  return TOOL_ORDER.map((name) => {
    const tool = TOOL_SURFACE[name]
    return `| \`${tool.name}\` | ${operationsCell(tool)} | ${tool.purpose} |`
  }).join('\n')
}

/**
 * Read one package manifest.
 *
 * @param dir - the package directory.
 * @returns the parsed manifest.
 */
async function manifestOf(dir) {
  return JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
}

/**
 * Assert that a built host package really registers every tool the spec lists.
 *
 * The distributions copy build output, so a stale or partial `lib/` would ship
 * silently. Matching the bare name keeps this independent of the emitted
 * literal's quoting, which is the bundler's business.
 *
 * The check reads the same {@link sop} spec the tables are rendered from, which is
 * what turns "the documentation is generated" into "the documentation cannot lie":
 * a tool removed from `tools.ts` but left in the spec fails the pack.
 *
 * @param hostDir - the host package directory to inspect.
 * @returns the built file's size in bytes.
 */
async function assertBuiltTools(hostDir) {
  const { TOOL_ORDER } = await sop()
  const entry = join(hostDir, 'lib', 'host', 'tools.js')
  const source = await readFile(entry, 'utf8')
  const missing = TOOL_ORDER.filter((tool) => !source.includes(tool))
  if (missing.length > 0) {
    throw new Error(
      `pack: ${relative(ROOT, entry)} does not mention ${missing.join(', ')} — run \`pnpm run build\` before packing`,
    )
  }
  return (await stat(entry)).size
}

/**
 * Copy one package into a destination, keeping only what ships.
 *
 * @param from - source package directory.
 * @param to - destination directory.
 * @param include - paths to copy relative to `from`.
 */
async function copyPackage(from, to, include) {
  await mkdir(to, { recursive: true })
  await cp(join(from, 'package.json'), join(to, 'package.json'))
  for (const path of include) {
    await cp(join(from, path), join(to, path), { recursive: true })
  }
}

/**
 * Write a JSON file with a trailing newline.
 *
 * @param path - destination path.
 * @param value - the value to serialize.
 */
async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/**
 * Compute a short content hash of one directory's shipping files.
 *
 * @param dir - the directory to hash.
 * @returns a 12-character hex digest.
 */
function hashDirectory(dir) {
  const hash = createHash('sha256')
  const listing = execFileSync('find', [dir, '-type', 'f', '-not', '-path', '*/node_modules/*'], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line !== '')
    .sort()
  for (const file of listing) {
    hash.update(relative(dir, file))
    hash.update(execFileSync('shasum', ['-a', '256', file], { encoding: 'utf8' }).split(' ')[0] ?? '')
  }
  return hash.digest('hex').slice(0, 12)
}

// ── distribution 1: the DSH plugin package ────────────────────────────────────

/**
 * Build `dist/dsh-plugin/`: one tarball holding both faces of the product.
 *
 * @param version - the version string.
 * @returns the tarball path, its size, and the staged tree's digest.
 */
async function packPluginDistribution(version) {
  const outDir = join(DIST, 'dsh-plugin')
  await rm(outDir, { recursive: true, force: true })
  const stage = join(outDir, 'stage', STAGE_NAME)
  await mkdir(stage, { recursive: true })

  // Rebuild the browser half under the shipped package name: the shell matches a
  // bundle's registered id against the package it serves, and the distribution's
  // package name differs from the development package's.
  buildHostForDistribution()

  const bundleManifest = await manifestOf(BUNDLE_DIR)
  const hostManifest = await manifestOf(HOST_DIR)

  const merged = {
    name: PACKAGE_NAME,
    version,
    description:
      bundleManifest.description
      + ' — the bundle and the plugin in one package, so a single tarball installs the nine tools with it.',
    type: 'module',
    license: bundleManifest.license ?? 'AGPL-3.0-only',
    main: './lib/index.js',
    types: './lib/index.d.ts',
    exports: {
      // The plugin. The patch row names the package itself, so the root export
      // must be the plugin module; `./host` stays as an explicit alias.
      '.': { types: './lib/index.d.ts', default: './lib/index.js' },
      './host': { types: './lib/index.d.ts', default: './lib/index.js' },
      // The browser half, discovered through the `dsh.client` declaration below.
      './client': { types: './lib/types/client/index.d.ts', default: './lib/client.js' },
      './core': { types: './lib/types/core/index.d.ts', default: './lib/core/index.js' },
      './package.json': './package.json',
    },
    files: ['lib', 'src', 'cordis.patch.yml', 'INSTALL.md', 'README.md', 'LICENSE'],
    dsh: {
      // The bundle half: what makes DSH append this package to the profile.
      bundle: { patch: './cordis.patch.yml' },
      // The browser half: scanned from loader entries for this package name.
      client: hostManifest.dsh.client,
    },
    dependencies: hostManifest.dependencies,
    peerDependencies: hostManifest.peerDependencies,
  }
  await writeJson(join(stage, 'package.json'), merged)

  // The patch must name the subpath: a row naming the bare package would mount
  // whatever the root export is, and the loader resolves a subpath inside the
  // package exactly like a bare name (verified against Node's resolver).
  const patchSource = await readFile(join(BUNDLE_DIR, 'cordis.patch.yml'), 'utf8')
  const patch = patchSource
    .replace(/name: '@ai-novelist\/novelist-skill'/u, `name: '${PACKAGE_NAME}'`)
    .replace(/^# The AI Web Novel Composer bundle patch\./mu, '# The AI Web Novel Composer distribution patch.')
  if (!patch.includes(`name: '${PACKAGE_NAME}'`)) {
    throw new Error(`pack: the distribution patch does not name ${PACKAGE_NAME}`)
  }
  await writeFile(join(stage, 'cordis.patch.yml'), patch, 'utf8')
  await cp(join(BUNDLE_DIR, 'index.js'), join(stage, 'index.js'))

  // The plugin's built output and sources, flattened into the one package.
  await cp(join(HOST_DIR, 'lib'), join(stage, 'lib'), { recursive: true })
  await cp(join(HOST_DIR, 'src'), join(stage, 'src'), { recursive: true })
  await cp(join(HOST_DIR, 'README.md'), join(stage, 'README.md'))
  await cp(join(ROOT, 'LICENSE'), join(stage, 'LICENSE'))
  await writeFile(join(stage, 'INSTALL.md'), await installNotes(version), 'utf8')

  const tarball = join(outDir, `ai-novelist-${version}.tgz`)
  execFileSync('tar', ['-czf', tarball, '-C', join(outDir, 'stage'), STAGE_NAME])
  return { tarball, bytes: (await stat(tarball)).size, digest: hashDirectory(stage) }
}

/**
 * Build the browser half under the shipped package name.
 *
 * The shell matches a bundle's registered id against the loader entry it serves,
 * and that entry is the package the client half belongs to — so the shipped id
 * must be the shipped package name, which differs from the development package's.
 *
 * @returns nothing; throws when the emitted bundle does not carry the right id.
 */
function buildHostForDistribution() {
  const previousId = process.env.DSH_CLIENT_ID
  process.env.DSH_CLIENT_ID = PACKAGE_NAME
  try {
    execFileSync('pnpm', ['--filter', HOST_PACKAGE_NAME, 'run', 'build:dist'], { cwd: ROOT, stdio: 'inherit' })
  } finally {
    if (previousId === undefined) delete process.env.DSH_CLIENT_ID
    else process.env.DSH_CLIENT_ID = previousId
  }
  const clientPath = join(HOST_DIR, 'lib', 'client.js')
  const source = readFileSync(clientPath, 'utf8')
  if (!source.includes(`id: "${PACKAGE_NAME}"`)) {
    throw new Error(`pack: the browser bundle does not register under ${PACKAGE_NAME} (${relative(ROOT, clientPath)})`)
  }
}

/**
 * Restore the development build after packing.
 *
 * The distribution build rewrites `lib/` with the shipped registration id; left
 * in place, a later `pnpm run build` would appear to produce the wrong id and a
 * profile installed from the checkout would stop finding its browser half.
 */
function restoreDevelopmentBuild() {
  execFileSync('pnpm', ['--filter', HOST_PACKAGE_NAME, 'run', 'build'], { cwd: ROOT, stdio: 'inherit' })
  const source = readFileSync(join(HOST_DIR, 'lib', 'client.js'), 'utf8')
  if (!source.includes(`id: "${HOST_PACKAGE_NAME}"`)) {
    throw new Error(`pack: the development build does not register under ${HOST_PACKAGE_NAME}`)
  }
}

/**
 * The install notes that travel with the plugin distribution.
 *
 * @param version - the version string.
 * @returns the Markdown document.
 */
async function installNotes(version) {
  const { SOP_VERSION } = await sop()
  const rows = await toolTableRows()
  return `# ai-novelist — DSH plugin distribution (v${version})

**One package, both faces.** \`${PACKAGE_NAME}\` is simultaneously:

- the profile **bundle** — its manifest declares \`dsh.bundle.patch\`, which is what
  makes DSH append the package to \`dsh.profile.bundles\`;
- the **plugin** — its root export (and the \`./host\` alias) is the module that
  registers the nine \`novel_*\` tools on \`ctx.tools\`;
- the **browser half** — \`./client\`, served to the Web GUI as a
  \`window.__ModuleLoader__\` bundle that adds the *Novel Composer* sidebar tab.

They ship as one package because a distribution has to be one installable
artifact, and pnpm's tarball install understands exactly one package per archive.
The source repository keeps them as two packages, because they are built by
different tools for different targets; only the distribution merges them.

## Install

\`\`\`sh
dsh plugin --profile web add -w ./ai-novelist-${version}.tgz
\`\`\`

The \`-w\` flag is required: a profile directory is itself a pnpm workspace root,
and pnpm refuses to add a dependency to a workspace root without it.

No registry and no network install — the tarball carries the built \`lib/\`, so a
target machine needs only Node and DSH.

Restart \`dsh web\` afterwards. The tool set is fixed when the process boots, so a
session that started earlier keeps the tools it began with.

## The one tool that needs a model

Seven tools are pure computation and need nothing but a filesystem.
\`novel_review\` asks a model to judge prose, so it exists only where a model
route does — in the Web profile, wherever you have selected a model. It follows
your session's model by default; to pin reviews to something cheaper or stronger,
add to the profile's row:

\`\`\`yaml
- id: ai-novelist
  name: ${PACKAGE_NAME}
  config:
    reviewProvider: deepseek
    reviewModel: deepseek-chat
    reviewTimeoutMs: 120000
    reviewMaxTokens: 8192
    reviewReasoningEffort: off
\`\`\`

\`reviewReasoningEffort\` defaults to \`off\`, because thinking tokens share
\`reviewMaxTokens\` with the answer: a reasoning model left on its own default
effort can spend the whole budget thinking and return no text at all. The effort
is sent only when the exact route declares it, so pointing reviews at a
non-reasoning model is safe.

Every review records the provider, the model and the prompt version it used, and
writes its full transcript to \`.novel/reviews/\` beside the project.

## Verify

\`\`\`sh
dsh --profile web --dump-config | grep -A2 ai-novelist
\`\`\`

Expect a row \`id: ai-novelist\` naming \`${PACKAGE_NAME}\`.

## Remove

\`\`\`sh
dsh plugin --profile web remove -w ${PACKAGE_NAME}
\`\`\`

## The nine tools

| tool | operations | purpose |
|---|---|---|
${rows}

The workflow they implement is the 爆款网文创作全流程 SOP ${SOP_VERSION}, shipped as
\`docs/sop.md\` in the source repository and split per phase for the skill bundle.
`
}

// ── distribution 2: the SKILL package ─────────────────────────────────────────

/**
 * The `SKILL.md` body, with frontmatter DSH's filesystem provider accepts.
 *
 * The body is an **index**, not the workflow: the phase the project is actually in
 * lives in its own generated reference, and the agent is told to load only that
 * one. The full workflow is 600 lines, and a skill that hands all of it over at
 * once spends the context it needs for the chapter it is writing.
 *
 * @param version - the version string.
 * @returns the Markdown document.
 */
async function skillDocument(version) {
  const { SOP_VERSION, TOOL_ORDER, SOP_PHASES } = await sop()
  const { CRAFT_SHEETS } = await craftSpec()
  const rows = await toolTableRows()
  const craftRows = CRAFT_SHEETS.map(
    (sheet) => `| \`${sheet.topic}\` | ${sheet.title} | ${sheet.summary} |`,
  ).join('\n')
  const phaseIndex = SOP_PHASES.map(
    (phase) =>
      `| ${phase.ordinal} | ${phase.title} | ${phase.goal} | \`${phase.reference}\` |`,
  ).join('\n')
  return `---
name: ai-novelist
description: Plan, validate, write, and iterate a Chinese web novel (网文) with the 爆款网文 SOP — a gated pipeline from premise and competitor study through validation, serialization, metrics-driven iteration, and retrospective. Use when the user wants to start, continue, validate, or troubleshoot a web novel, or asks about 追读/首订/开篇/大纲/伏笔 for one.
whenToUse: The user mentions a web novel, 网文, 追读/首订/三章读完, 开篇, 细纲, 伏笔, or asks to continue a novel project in this workspace.
license: AGPL-3.0-only
metadata:
  version: ${version}
  sop: ${SOP_VERSION}
  tools: ${TOOL_ORDER.join(', ')}
---

# AI Web Novel Composer

Drives a Chinese web novel through the 爆款网文创作全流程 SOP ${SOP_VERSION}:
**假设 → 验证 → 放大 → 复盘 → 复用**. It is a pipeline with gates, not a notebook.
Eight of the nine tools do the bookkeeping; you do the writing; \`novel_review\`
buys a second opinion on it.

Two checkpoints belong to the **user**, and \`novel_confirm\` is where they are
recorded: the settings sign-off (premise, cast, world, length, tone — discussed
over at least two recorded rounds) must exist **before** the first chapter, and the
voice review comes after the golden three chapters (第 1–3 章) and before chapter 4.
\`novel_write\` refuses prose while either gate is shut. An inspiration is the start of a conversation, not
a licence to produce chapters.

The pipeline advances on what has been planned and written. Phase three ends in a
declared \`go\` / \`revise\` / \`abandon\`, not in a metric: the data evaluation
(\`novel_assess\`) sits outside the phases and is started by the author when they
ask whether the book is still worth continuing.

## Read one phase, not the whole workflow

The SOP is six phases. Read \`references/common.md\` once — it carries the closed
loop, the vocabulary every phase shares, and the rules that apply throughout — then
read only the file for the phase your project is actually in. \`novel_status\`
reports that phase as \`stage\`, and the runtime context repeats its reference each
step.

| # | phase | what it is for | read |
|---|---|---|---|
${phaseIndex}

\`references/sop.md\` is the whole document, kept for search. Do not read it end to
end; it is the same text the six phase files are cut from.

## Writing craft: how it should read

The SOP decides what must be planned. It cannot teach how a hook lands or which
sentence reads like a machine. Those sheets live in \`references/craft/\`, and the
same text is available through \`novel_status detail="craft"\`:

| topic | sheet | what it answers |
|---|---|---|
${craftRows}

Read the one sheet that matches the current problem — choosing a lane (\`genres\`,
\`trends\`), platform and market (\`platforms\`, \`overseas\`), a chapter that feels flat
(\`payoffs\`), one that reads heavy (\`rhythm\`), a draft that sounds like AI (\`voice\`),
the book contradicting itself (\`continuity\`), the author's own bench (\`naming\`,
\`submission\`), or a neighbouring form (\`fanfic\`, \`script\`, \`teaching\`). The table
above is the index; each sheet ends with a checklist. They are checklists, not
platform law: every platform fact must be re-checked against the current official
announcement before submission.

## The nine tools

Eight compute, and are registered unconditionally. The ninth, \`novel_review\`,
asks a model — it appears only in a profile that has a model route, and it is the
only tool here whose answer is a judgement rather than a derived fact. All nine
travel in the DSH plugin tarball under \`plugin/\` — set it up first (see *Set up the
tools* below). Nothing here works until they exist.

| tool | operations | what it owns |
|---|---|---|
${rows}

Every tool answers with the same envelope, so whichever one you call you learn the
same orientation: \`ok\`, \`operation\`, \`detail\`, \`stage\` (the SOP phase the
recorded data supports), \`blockers\` (what the next phase still needs),
\`warnings\` (soft-gate notes), \`body\` and \`progress\`.

### When to reach for \`novel_review\`

It costs a model call, so use it where judgement is the whole job, not as a
routine step:

| you are | call |
|---|---|
| finishing a chapter and it reads flat, or you want a machine-eye pass | \`novel_review operation="ai-flavor" chapterId=…\` |
| about to publish the opening, or the 三章读完 numbers came back weak | \`novel_review operation="opening"\` |
| dismantling a competitor and you have its blurb or opening text in hand | \`novel_review operation="competitor" title=… text=…\` (add \`save=true\` once you have read the result) |
| finishing or abandoning a book, before writing the retrospective | \`novel_review operation="retro"\` |

Findings come back as \`dimension / quote / why / fix / severity\`, sorted worst
first. \`rewrite=true\` on \`ai-flavor\` adds a rewritten chapter, which is saved
beside the project as a **proposal** — it is never written into the chapter, and
\`novel_write\` is still the only way in. Reviews are recorded with the model and
the rubric version that produced them, so a second opinion can be compared with
the first rather than overwriting it.

## Set up the tools

A skill is instructions plus resources: its frontmatter admits \`name\`,
\`description\`, \`whenToUse\`, \`metadata\`, \`disable-model-invocation\` and
\`user-invocable\`, and **nothing that registers a tool**. A tool exists only once
a plugin registers it on \`ctx.tools\`, so the plugin travels in \`plugin/\` and one
script wires it into a profile:

\`\`\`sh
node scripts/setup.mjs --profile web      # installs plugin/*.tgz into the named profile
\`\`\`

Then restart the DSH process. Confirm with \`novel_status\`; if it is missing, the
plugin is not installed in the profile that session runs under.

## Before the first call: the length plan

Ask the user for four numbers **before** you call \`novel_init\` — none of them can
be read off the premise, and every later length check is measured against them:

| ask the user | lands in | why it matters |
|---|---|---|
| 这本书计划写多少字？ | \`targetWords\` | 篇幅口径：完本与上架预期 |
| 单章目标多少字？ | \`chapterWords\` | 细纲没写目标字数时继承它；初稿目标 = 成稿目标 × 125%，成稿落回 -5%/+15% |
| 要分卷吗？分几卷？ | \`volumes\`（\`0\` = 明确不分卷） | 分卷大纲的卷数纪律与卷末高潮章位 |

Offer common tiers as *choices*, never as the answer: 短篇 20–40 万字 / 单章 2000
字左右 / 不分卷或 3–5 卷；中篇 80–150 万字 / 单章 2500–3000 字 / 6–12 卷；长篇
200–400 万字 / 单章 3000–4000 字 / 15–30 卷。What gets recorded is what the user
said, not what the table says.

The chapter number you record is the **finished** length, and there are two gates
around it: the first draft is written to 125% of it — 去 AI 化 and hand-editing
delete a large share of a draft, so a draft written straight to the target arrives
at publication short — and the trimmed chapter must land back inside **-5%/+15%**,
an asymmetric window because coming in under the promised length is the real
failure while an overrun can still be cut. The
tools hold a chapter to whichever gate its status implies (planned/drafting =
125%, revised/final = -5%/+15%), print both windows whenever prose is handed back, and
carry the draft target in the runtime context.

Once \`targetWords\` and \`chapterWords\` are known, \`totalChapters\` is derived
(total ÷ chapter length) unless the user states one, and a chapters-per-volume
answer is converted into a volume count. The tool reports whatever is still
unanswered as a checklist on every \`novel_init\`, and the runtime context repeats
it each step, so an unasked number cannot quietly become an assumed one.
\`volumes: 0\` is a real answer (one volume); only an omitted one counts as
unanswered. The three numbers are then cross-checked — a chapter count that
contradicts the lengths, or an outline that outgrows the agreed volume count, is
reported rather than silently accepted.

## The loop

1. **假设** — ask the user for the length plan above, then \`novel_init\` records it
   along with the commercial frame *and the calibration medians*. Without
   same-genre medians the threshold rules cannot run, and every metric verdict
   degrades to "无法比较". Then \`novel_plan\` for the pitch (the one-sentence
   memorable point) and 20–50 competitor dismantles.
2. **验证** — the minimal viable outline plus the opening package
   (\`novel_plan operation="outline"\` then \`"chapter"\` then \`"opening"\`), then the
   launch decision: \`novel_plan operation="launch"\` with \`verdict\` = \`go\` |
   \`revise\` | \`abandon\`. It is a judgement, not a computed number, so it needs no
   platform data — but a verdict that is not \`go\` **must** name its fallback and
   its abandon condition, and the tool refuses it otherwise. The data check is
   \`novel_assess\`, run **on demand** when the author asks whether the book is
   still worth continuing; it owns no phase and nothing gates on it.
3. **放大** — \`novel_write\` per chapter, writing the first draft to **125% of the
   chapter target** (去 AI 化与手改会成段删减，初稿按成稿字数写必然偏短), reporting
   which contract fields the draft delivered **and the 去 AI 化 statistics**
   (paragraph length, dialogue density, repeated sentence openings). Those numbers
   are symptoms, not a
   verdict, and nothing edits the prose for you: rewrite the chapter and send it
   back through \`operation="write"\`, or re-read the numbers later with
   \`operation="check"\` or \`novel_status detail="chapter"\`. When a chapter needs a
   real reading rather than a count, ask \`novel_review operation="ai-flavor"\`.
   Then \`novel_assess\` when the author wants the numbers answer: \`record\` a
   reading, \`iterate\` the decided change with its scope, and \`evaluate\` to get the
   verdict (继续投入 / 换变量后继续 / 切书止损). An evaluation back-fills every open
   change and must leave a next appointment; it never moves the project stage.
4. **复盘** — \`novel_repo operation="retro"\` derives the summary, the IP assets,
   and a structural template; \`novel_review operation="retro"\` reads the same data
   and proposes the reusable and avoid-this lessons, which you accept with
   \`save=true\` or edit in by hand.
5. **复用** — the template carries acts, volume rhythm, beat offsets and hook
   shapes, and deliberately no cast: the next book must be a variant, not a clone.

## Read before acting

- \`references/common.md\` — the closed loop, the shared vocabulary (四种章数,
  三种信息), the on-demand evaluation, and the revision discipline. Applies to
  every phase; read it once.
- \`references/phase-*.md\` — one file per SOP phase, cut from \`references/sop.md\`
  at pack time. Read the one matching the \`stage\` you are in, not the others.
- \`references/sop.md\` — the whole workflow in one file, kept for search only.
- \`references/tools.md\` — every tool, every operation, every parameter, and the
  shared result envelope.
- \`references/thresholds.md\` — the metric keys, the default multipliers, and the
  exact conditions under which each iteration rule fires.
- \`references/craft/\` — the writing-craft sheets listed above. Read the one for
  the current problem; they are also served by \`novel_status detail="craft"\`.

## What these tools will not do

- They do not measure anything. 点击率, 追读, 留存 and 首订 come from the platform
  or from readers; you record them, the tool compares them.
- The eight computing tools do not judge prose. The 去 AI 化 statistics report
  countable symptoms (paragraph length, dialogue density, repeated sentence
  openings) and nothing more. \`novel_review\` does judge — that is its whole job —
  but its output is advice recorded as advice, and it never lands in the ledgers
  (\`iterations\`, \`evaluations\`, \`launchDecisions\`) that thresholds act on.
- They do not rewrite published chapters. \`novel_assess\` recommends an action
  and a scope; widening that scope is the author's decision.
- They do not fabricate thresholds. With no calibrated medians, a reading is
  recorded and reported as incomparable rather than silently judged.
- They do not choose the length plan. 总字数, 单章字数 and 卷数 are asked of the
  user; the tools record, derive and cross-check them, and report what is still
  unanswered instead of filling it in.
`
}

/**
 * Assert that the prose SOP announces the revision the code implements.
 *
 * `docs/sop.md` is the long-form workflow and `core/sop.ts` is the executable one;
 * the two are edited by hand in different files, which is exactly how the shipped
 * `SKILL.md` came to say "SOP 3.3" beside a 3.5 reference. Packing is the last
 * moment both are in hand, so it is where the disagreement is caught.
 *
 * @param source - the text of `docs/sop.md`.
 */
async function assertSopVersion(source) {
  const { SOP_VERSION } = await sop()
  const title = source.split('\n', 1)[0] ?? ''
  if (!title.includes(`SOP ${SOP_VERSION}`)) {
    throw new Error(
      `pack: docs/sop.md announces "${title}" but core/sop.ts implements SOP ${SOP_VERSION}`
        + ' — update one to match the other before packing',
    )
  }
}

/**
 * Cut `docs/sop.md` into the per-phase references the skill ships.
 *
 * The skill's whole point is that the agent reads the phase it is in rather than
 * all 600 lines; splitting at pack time means the phase files are the same text as
 * `sop.md` and cannot drift from it. Sections that are not a phase — the closed
 * loop, the shared vocabulary, the on-demand evaluation, the changelog — land in
 * `common.md`, which is read once.
 *
 * @param source - the text of `docs/sop.md`.
 * @param dir - the `references/` directory to write into.
 */
async function writePhaseReferences(source, dir) {
  const { SOP_VERSION, SOP_PHASES } = await sop()
  const lines = source.split('\n')

  // Split on top-level `## ` headings, keeping the preamble as section zero.
  const sections = []
  let current = { title: '', body: [] }
  for (const line of lines) {
    if (line.startsWith('## ')) {
      sections.push(current)
      current = { title: line.slice(3).trim(), body: [line] }
    } else {
      current.body.push(line)
    }
  }
  sections.push(current)

  const preamble = sections.shift()
  const used = new Set()
  for (const phase of SOP_PHASES) {
    const marker = `阶段${phase.ordinal}`
    const section = sections.find((entry) => entry.title.includes(marker) && !used.has(entry.title))
    if (section === undefined) {
      throw new Error(`pack: docs/sop.md has no section for phase ${phase.ordinal} (${phase.title})`)
    }
    used.add(section.title)
    const header = [
      `# 阶段${phase.ordinal} · ${phase.title}`,
      '',
      `> SOP ${SOP_VERSION} 的六个阶段之一：**${phase.goal}**。`,
      `> 使用的工具：${phase.tools.map((tool) => `\`${tool}\``).join(' · ')}。`,
      phase.closesWith === ''
        ? '> 本阶段没有单一收尾操作，完成即进入下一阶段。'
        : `> 本阶段由 \`${phase.closesWith}\` 收尾。`,
      '',
      '本文件由 `docs/sop.md` 在打包时切分生成，与 `references/sop.md` 同源。',
      '',
      '---',
      '',
    ].join('\n')
    await writeFile(join(dir, phase.reference.replace(/^references\//u, '')), header + section.body.join('\n'), 'utf8')
  }

  const rest = sections.filter((entry) => !used.has(entry.title))
  const common = [
    '# SOP 通用部分',
    '',
    `> 爆款网文创作全流程 SOP ${SOP_VERSION} 中适用于**每一个**阶段的部分：总闭环、粒度与口径、按需投入评估、变更清单。`,
    '> 开始任何阶段前读一遍；各阶段专属内容见 `phase-*.md`。',
    '',
    '本文件由 `docs/sop.md` 在打包时切分生成，与 `references/sop.md` 同源。',
    '',
    '---',
    '',
    preamble.body.join('\n').trim(),
    '',
    ...rest.map((entry) => entry.body.join('\n').trim()),
    '',
  ].join('\n')
  await writeFile(join(dir, 'common.md'), common, 'utf8')
}

/**
 * Build `dist/skill/ai-novelist/`: the portable Agent Skill bundle.
 *
 * @param version - the version string.
 * @returns the bundle directory and its content digest.
 */
async function packSkillDistribution(version, pluginTarball) {
  const target = join(DIST, 'skill', 'ai-novelist')
  await rm(join(DIST, 'skill'), { recursive: true, force: true })
  await mkdir(target, { recursive: true })

  // The plugin travels as the very tarball distribution 1 ships, not as an
  // unpacked copy: a bundle installed from a directory is a live symlink into
  // wherever the skill happens to sit, so moving the skill (or extracting it on
  // another machine) leaves a link that resolves to nothing. A tarball is
  // self-contained, and it is the same artifact that was already verified.
  await mkdir(join(target, 'plugin'), { recursive: true })
  await cp(pluginTarball, join(target, 'plugin', basename(pluginTarball)))
  await writeFile(join(target, 'SKILL.md'), await skillDocument(version), 'utf8')
  await writeFile(join(target, 'README.md'), skillReadme(version), 'utf8')
  await cp(join(ROOT, 'LICENSE'), join(target, 'LICENSE'))

  await mkdir(join(target, 'references'), { recursive: true })
  const sopSource = await readFile(join(ROOT, 'docs', 'sop.md'), 'utf8')
  await assertSopVersion(sopSource)
  await writeFile(join(target, 'references', 'sop.md'), sopSource, 'utf8')
  await writePhaseReferences(sopSource, join(target, 'references'))
  await writeFile(join(target, 'references', 'tools.md'), await toolsReference(), 'utf8')
  await writeFile(join(target, 'references', 'thresholds.md'), await thresholdsReference(), 'utf8')
  await cp(join(ROOT, 'docs', 'craft'), join(target, 'references', 'craft'), { recursive: true })

  await mkdir(join(target, 'scripts'), { recursive: true })
  await writeFile(join(target, 'scripts', 'setup.mjs'), setupScript(version), 'utf8')

  // The archive is the package: one file that carries the skill, its references
  // and the plugin tarball, alongside the directory so a contributor can read it.
  const archive = join(DIST, 'skill', `ai-novelist-${version}.tar.gz`)
  execFileSync('tar', ['-czf', archive, '-C', join(DIST, 'skill'), 'ai-novelist'])

  return { target, archive, digest: hashDirectory(target) }
}

/**
 * The install notes the skill bundle carries.
 *
 * Short on purpose: the SKILL.md is what a model reads, and this file is what a
 * person opens when they have extracted the archive and want the three commands
 * that make the tools exist.
 *
 * @param version - the version string.
 * @returns the Markdown.
 */
function skillReadme(version) {
  return `# ai-novelist — Agent Skill bundle (v${version})

The Skill half of the AI Web Novel Composer: a \`SKILL.md\` index, the workflow
under \`references/\`, the fourteen craft sheets under \`references/craft/\`, and the
DSH plugin tarball under \`plugin/\`.

## Install

\`\`\`sh
# 1. put the tools in a DSH profile
node scripts/setup.mjs --profile web

# or do it by hand, from this directory
dsh plugin --profile web add -w "$(pwd)/plugin/ai-novelist-${version}.tgz"

# 2. restart dsh web — the tool set is fixed when the process boots
\`\`\`

\`scripts/setup.mjs --dry-run\` prints the command without running it.

## What is where

| path | what it is |
|---|---|
| \`SKILL.md\` | the skill itself: when to use it, the phase table, the nine tools |
| \`references/sop.md\` | the whole workflow (SOP 3.9) |
| \`references/phase-*.md\` | one file per phase, cut from the SOP |
| \`references/tools.md\` | every tool, operation and parameter |
| \`references/thresholds.md\` | the metric keys and their default multipliers |
| \`references/craft/\` | the fourteen writing-craft sheets, also served by \`novel_status detail="craft"\` |
| \`plugin/ai-novelist-${version}.tgz\` | the DSH distribution the tools ship in |
| \`scripts/setup.mjs\` | installs that tarball into a profile |

License: AGPL-3.0-only. No registry and no network install — the tarball carries
the built \`lib/\`.
`
}

/**
 * The installer the skill bundle ships.
 *
 * @returns the script source.
 */
function setupScript(version) {
  return `#!/usr/bin/env node
/**
 * Install the bundled plugin tarball into a DSH profile.
 *
 * The skill is instructions; the tools live in plugin/ai-novelist-${version}.tgz.
 * This script is the seam between the two.
 *
 * Usage: node scripts/setup.mjs [--profile <name>] [--dry-run]
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = resolve(HERE, '..', 'plugin', 'ai-novelist-${version}.tgz')

const args = process.argv.slice(2)
const profileIndex = args.indexOf('--profile')
const profile = profileIndex === -1 ? 'web' : args[profileIndex + 1]
const dryRun = args.includes('--dry-run')

if (profile === undefined || profile === '') {
  console.error('setup: --profile needs a name (for example: --profile web)')
  process.exit(2)
}
if (!existsSync(PLUGIN)) {
  console.error(\`setup: the bundled plugin is missing at \${PLUGIN}\`)
  process.exit(1)
}

// A profile directory is itself a pnpm workspace root, so pnpm refuses the add
// without -w; and dsh forwards these arguments to pnpm verbatim.
const command = ['plugin', '--profile', profile, 'add', '-w', PLUGIN]
console.log(\`setup: dsh \${command.join(' ')}\`)
if (dryRun) process.exit(0)

try {
  execFileSync('dsh', command, { stdio: 'inherit' })
} catch (error) {
  console.error('setup: dsh plugin add failed — is dsh on PATH?')
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
console.log('')
console.log('setup: installed. Restart the DSH process; the tool set is fixed at boot.')
console.log(\`setup: verify with  dsh --profile \${profile} --dump-config | grep -A2 ai-novelist\`)
`
}

/**
 * Generate the tool reference from the shipped source.
 *
 * The nine-tool table comes from the same constant every other distribution
 * uses, so it cannot drift from the shipped surface; the parameters-and-behaviour
 * half is lifted from the plugin README's own tool-surface section, up to the
 * next top-level heading.
 *
 * @returns the Markdown document.
 */
async function toolsReference() {
  const { TOOL_ORDER } = await sop()
  const rows = await toolTableRows()
  const source = await readFile(join(HOST_DIR, 'README.md'), 'utf8')
  const marker = '## The tool surface'
  const start = source.indexOf(marker)
  let extracted = ''
  if (start !== -1) {
    const rest = source.slice(start + marker.length)
    const end = rest.indexOf('\n## ')
    extracted = (end === -1 ? rest : rest.slice(0, end)).trim()
  }
  return `# Tool reference

The ${TOOL_ORDER.length} tools, in the order the SOP uses them:

| tool | operations | what it owns |
|---|---|---|
${rows}

## The shared envelope

Every tool answers with the same shape, so whichever one you call you learn the same
orientation:

| field | meaning |
|---|---|
| \`ok\` | whether the call changed something (a pure read reports \`false\`) |
| \`operation\` | which operation ran |
| \`detail\` | what happened, in one line |
| \`stage\` | the SOP phase the recorded data supports |
| \`blockers\` | what the next phase still needs |
| \`warnings\` | soft-gate notes: the call succeeded, the SOP disagrees with the position |
| \`body\` | tool-specific detail lines |
| \`progress\` | chapters, words, written, contracted, stock, open and overdue promises |

## Parameters and behaviour

${extracted === '' ? 'See the package reference in the source repository.' : extracted}
`
}

/**
 * Generate the threshold reference from the code that enforces it.
 *
 * @returns the Markdown document.
 */
async function thresholdsReference() {
  const source = await readFile(join(HOST_DIR, 'src', 'core', 'metrics.ts'), 'utf8')
  const start = source.indexOf('export const DEFAULT_MULTIPLIERS')
  const end = source.indexOf('export const SUSTAINED_DECLINE_CHAPTERS')
  const block = start === -1 || end === -1 ? '' : source.slice(start, end)
  const rows = [...block.matchAll(/^\s{2}(\w+): ([\d.]+),/gmu)].map((match) => `| \`${match[1]}\` | ×${match[2]} |`)
  return `# Thresholds

Generated from \`core/metrics.ts\` at pack time. Every threshold is a metric's
same-genre median multiplied by the factor below, so **a metric with no calibrated
median cannot be judged** — the tool records the reading and reports it as
incomparable.

## Default multipliers

| metric | trigger line |
|---|---|
${rows.join('\n')}

## Rule conditions

| rule key | fires when | scope |
|---|---|---|
| \`rewrite-opening\` | \`readThrough3\` below its line | \`chapter\` — rewrite chapters 1–3 and check the blurb |
| \`change-naming\` | \`clickRate\` or \`favoriteRate\` below their lines | \`chapter\` — switch to another naming candidate |
| \`tighten-hooks\` | \`followRead10\`/\`followRead24h\` below their lines | \`chapter\` — strengthen the outlines' hooks |
| \`accelerate-volume\` | the same, plus \`SUSTAINED_DECLINE_CHAPTERS\` consecutive declining readings | \`volume\` — accelerate inside the current volume |
| \`rework-volume\` | \`averageReadPerChapter\` below its line | \`volume\` — change the volume outline, map or conflict |
| \`revisit-concept\` | two or more core metrics below their lines | \`whole-book\` — reconsider premise and platform fit |
| \`cut-losses\` | ≥2 ineffective iterations **and** a core metric below **half** its median | \`whole-book\` — stop and bank the reusable structure |

An iteration counts as ineffective once its outcome reading is recorded and the
metric it targeted did not improve. That is what makes "连续 2–3 轮调整无效"
decidable rather than a feeling.
`
}

// ── entry point ───────────────────────────────────────────────────────────────

async function main() {
  const host = await manifestOf(HOST_DIR)
  const version = host.version
  const builtToolsBytes = await assertBuiltTools(HOST_DIR)

  await mkdir(DIST, { recursive: true })
  const plugin = await packPluginDistribution(version)
  const skill = await packSkillDistribution(version, plugin.tarball)

  // Leave the checkout in its development state: the distribution build above
  // rewrote `lib/` under the shipped registration id.
  restoreDevelopmentBuild()

  const report = {
    version,
    builtToolsBytes,
    tools: (await sop()).TOOL_ORDER,
    pluginDistribution: {
      tarball: relative(ROOT, plugin.tarball),
      bytes: plugin.bytes,
      digest: plugin.digest,
      package: PACKAGE_NAME,
      patchRowName: PACKAGE_NAME,
    },
    skillDistribution: {
      directory: relative(ROOT, skill.target),
      archive: relative(ROOT, skill.archive),
      archiveBytes: (await stat(skill.archive)).size,
      digest: skill.digest,
    },
  }
  await writeJson(join(DIST, 'manifest.json'), report)
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

await main()
