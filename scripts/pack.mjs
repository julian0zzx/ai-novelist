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
 *    installer, and `tools/` carries the same package as distribution 1.
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
import { fileURLToPath } from 'node:url'
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

/** The nine tools every distribution must carry. */
const EXPECTED_TOOLS = [
  'novel_init',
  'novel_plan',
  'novel_bible',
  'novel_verify',
  'novel_write',
  'novel_metrics',
  'novel_status',
  'novel_repo',
  'novel_review',
]

/** The tool surface, as documented by every distribution. */
const TOOL_TABLE = [
  ['`novel_init`', '—', 'project, commercial frame, calibration medians, writing parameters, naming candidates'],
  [
    '`novel_plan`',
    'competitor, pitch, world, outline, volume, chapter, beat, opening, naming',
    'the planning pipeline, soft-gated: it never refuses a call, it reports what the SOP still wants',
  ],
  ['`novel_bible`', 'character, world, link, review', 'cast, world facts, reader promises, and their review'],
  [
    '`novel_verify`',
    'round, assess',
    'validation: metrics in, pass/partial/fail out; a non-passing round must name its fallback and abandon condition',
  ],
  ['`novel_write`', 'write, read, check', 'prose, the contract-delivery report, and the automatic 去 AI 化 statistics'],
  ['`novel_metrics`', 'record, iterate, outcome, rules', 'readings, the SOP iteration rules, and outcome back-fill'],
  ['`novel_status`', 'dashboard, bible, plan, chapter', 'the derived SOP dashboard'],
  [
    '`novel_repo`',
    'export, retro, asset, lesson, template',
    'retrospective, IP assets, reusable templates, manuscript export',
  ],
  [
    '`novel_review`',
    'ai-flavor, opening, competitor, retro',
    'the one model-backed tool: prose judgement under a versioned rubric, recorded with the model that produced it',
  ],
]

/**
 * Render the tool table as Markdown rows.
 *
 * @returns the table body, one line per tool.
 */
function toolTableRows() {
  return TOOL_TABLE.map(([tool, operations, purpose]) => `| ${tool} | ${operations} | ${purpose} |`).join('\n')
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
 * Assert that a built host package really registers the nine tools.
 *
 * The distributions copy build output, so a stale or partial `lib/` would ship
 * silently. Matching the bare name keeps this independent of the emitted
 * literal's quoting, which is the bundler's business.
 *
 * @param hostDir - the host package directory to inspect.
 * @returns the built file's size in bytes.
 */
async function assertBuiltTools(hostDir) {
  const entry = join(hostDir, 'lib', 'host', 'tools.js')
  const source = await readFile(entry, 'utf8')
  const missing = EXPECTED_TOOLS.filter((tool) => !source.includes(tool))
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
    license: bundleManifest.license ?? 'MIT',
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
    files: ['lib', 'src', 'cordis.patch.yml', 'INSTALL.md', 'README.md'],
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
  await writeFile(join(stage, 'INSTALL.md'), installNotes(version), 'utf8')

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
function installNotes(version) {
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

Eight tools are pure computation and need nothing but a filesystem.
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
\`\`\`

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
${toolTableRows()}

The workflow they implement is \`docs/sop.md\` in the source repository.
`
}

// ── distribution 2: the SKILL package ─────────────────────────────────────────

/**
 * The `SKILL.md` body, with frontmatter DSH's filesystem provider accepts.
 *
 * @param version - the version string.
 * @returns the Markdown document.
 */
function skillDocument(version) {
  return `---
name: ai-novelist
description: Plan, validate, write, and iterate a Chinese web novel (网文) with the 爆款网文 SOP — a gated pipeline from premise and competitor study through validation, serialization, metrics-driven iteration, and retrospective. Use when the user wants to start, continue, validate, or troubleshoot a web novel, or asks about 追读/首订/开篇/大纲/伏笔 for one.
whenToUse: The user mentions a web novel, 网文, 追读/首订/三章读完, 开篇, 细纲, 伏笔, or asks to continue a novel project in this workspace.
license: MIT
metadata:
  version: ${version}
  tools: ${EXPECTED_TOOLS.join(', ')}
---

# AI Web Novel Composer

Drives a Chinese web novel through the 爆款网文 SOP 3.1: **假设 → 验证 → 放大 → 复盘 →
复用**. It is a pipeline with gates, not a notebook. Eight of the nine tools do the
bookkeeping; you do the writing; \`novel_review\` buys a second opinion on it.

## The nine tools

Eight compute, and are registered unconditionally. The ninth, \`novel_review\`,
asks a model — it appears only in a profile that has a model route, and it is the
only tool here whose answer is a judgement rather than a derived fact. All nine
travel in the DSH plugin under \`tools/\` — set it up first (see *Set up the
tools* below). Nothing here works until they exist.

| tool | operations | what it owns |
|---|---|---|
${toolTableRows()}

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
a plugin registers it on \`ctx.tools\`, so the plugin travels in \`tools/\` and one
script wires it into a profile:

\`\`\`sh
node scripts/setup.mjs --profile web      # installs tools/ into the named profile
\`\`\`

Then restart the DSH process. Confirm with \`novel_status\`; if it is missing, the
plugin is not installed in the profile that session runs under.

## The loop

1. **假设** — \`novel_init\` records the commercial frame *and the calibration
   medians*. Without same-genre medians the threshold rules cannot run, and every
   metric verdict degrades to "无法比较". Then \`novel_plan\` for the pitch (the
   one-sentence memorable point) and 20–50 competitor dismantles.
2. **验证** — the minimal viable outline plus the opening package
   (\`novel_plan operation="outline"\` then \`"chapter"\` then \`"opening"\`), then
   \`novel_verify\` with real numbers. A round that does not pass **must** name its
   fallback and its abandon condition; the tool refuses the round otherwise.
3. **放大** — \`novel_write\` per chapter, reporting which contract fields the
   draft delivered **and the 去 AI 化 statistics** (paragraph length, dialogue
   density, repeated sentence openings). Those numbers are symptoms, not a
   verdict, and nothing edits the prose for you: rewrite the chapter and send it
   back through \`operation="write"\`, or re-read the numbers later with
   \`operation="check"\` or \`novel_status detail="chapter"\`. When a chapter needs a
   real reading rather than a count, ask \`novel_review operation="ai-flavor"\`.
   Then \`novel_metrics\` for readings and the SOP's iteration rules, each carrying
   an action *and a scope*.
4. **复盘** — \`novel_repo operation="retro"\` derives the summary, the IP assets,
   and a structural template; \`novel_review operation="retro"\` reads the same data
   and proposes the reusable and avoid-this lessons, which you accept with
   \`save=true\` or edit in by hand.
5. **复用** — the template carries acts, volume rhythm, beat offsets and hook
   shapes, and deliberately no cast: the next book must be a variant, not a clone.

## Read before acting

- \`references/sop.md\` — the full workflow, with checkpoints and fallback targets
  per phase. Read the phase you are in, not the whole file.
- \`references/tools.md\` — every tool, every operation, every parameter, and the
  shared result envelope.
- \`references/thresholds.md\` — the metric keys, the default multipliers, and the
  exact conditions under which each iteration rule fires.

## What these tools will not do

- They do not measure anything. 点击率, 追读, 留存 and 首订 come from the platform
  or from readers; you record them, the tool compares them.
- The eight computing tools do not judge prose. The 去 AI 化 statistics report
  countable symptoms (paragraph length, dialogue density, repeated sentence
  openings) and nothing more. \`novel_review\` does judge — that is its whole job —
  but its output is advice recorded as advice, and it never lands in the ledgers
  (\`iterations\`, \`verifications\`) that thresholds act on.
- They do not rewrite published chapters. \`novel_metrics\` recommends an action
  and a scope; widening that scope is the author's decision.
- They do not fabricate thresholds. With no calibrated medians, a reading is
  recorded and reported as incomparable rather than silently judged.
`
}

/**
 * Build `dist/skill/ai-novelist/`: the portable Agent Skill bundle.
 *
 * @param version - the version string.
 * @returns the bundle directory and its content digest.
 */
async function packSkillDistribution(version) {
  const target = join(DIST, 'skill', 'ai-novelist')
  await rm(join(DIST, 'skill'), { recursive: true, force: true })
  await mkdir(target, { recursive: true })

  await copyPackage(join(DIST, 'dsh-plugin', 'stage', STAGE_NAME), join(target, 'tools'), [
    'cordis.patch.yml',
    'index.js',
    'INSTALL.md',
    'lib',
    'src',
  ])
  await writeFile(join(target, 'SKILL.md'), skillDocument(version), 'utf8')

  await mkdir(join(target, 'references'), { recursive: true })
  await cp(join(ROOT, 'docs', 'sop.md'), join(target, 'references', 'sop.md'))
  await writeFile(join(target, 'references', 'tools.md'), await toolsReference(), 'utf8')
  await writeFile(join(target, 'references', 'thresholds.md'), await thresholdsReference(), 'utf8')

  await mkdir(join(target, 'scripts'), { recursive: true })
  await writeFile(join(target, 'scripts', 'setup.mjs'), setupScript(), 'utf8')

  return { target, digest: hashDirectory(target) }
}

/**
 * The installer the skill bundle ships.
 *
 * @returns the script source.
 */
function setupScript() {
  return `#!/usr/bin/env node
/**
 * Install the bundled composer plugin into a DSH profile.
 *
 * The bundle ships the tools; this script is the seam between the skill's
 * instructions and the harness that can register them.
 *
 * Usage: node scripts/setup.mjs [--profile <name>] [--dry-run]
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = resolve(HERE, '..', 'tools')

const args = process.argv.slice(2)
const profileIndex = args.indexOf('--profile')
const profile = profileIndex === -1 ? 'web' : args[profileIndex + 1]
const dryRun = args.includes('--dry-run')

if (profile === undefined || profile === '') {
  console.error('setup: --profile needs a name (for example: --profile web)')
  process.exit(2)
}
if (!existsSync(join(BUNDLE, 'package.json'))) {
  console.error(\`setup: the bundled tools are missing at \${BUNDLE}\`)
  process.exit(1)
}

// A profile directory is itself a pnpm workspace root, so pnpm refuses the add
// without -w; and dsh forwards these arguments to pnpm verbatim.
const command = ['plugin', '--profile', profile, 'add', '-w', BUNDLE]
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
 * uses, so it cannot drift from the shipped surface.
 *
 * @returns the Markdown document.
 */
async function toolsReference() {
  const source = await readFile(join(HOST_DIR, 'README.md'), 'utf8')
  const marker = '## The nine tools'
  const start = source.indexOf(marker)
  const extracted = start === -1 ? '' : source.slice(start)
  return `# Tool reference

The nine tools, in the order the SOP uses them:

| tool | operations | what it owns |
|---|---|---|
${toolTableRows()}

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
  const skill = await packSkillDistribution(version)

  // Leave the checkout in its development state: the distribution build above
  // rewrote `lib/` under the shipped registration id.
  restoreDevelopmentBuild()

  const report = {
    version,
    builtToolsBytes,
    tools: EXPECTED_TOOLS,
    pluginDistribution: {
      tarball: relative(ROOT, plugin.tarball),
      bytes: plugin.bytes,
      digest: plugin.digest,
      package: PACKAGE_NAME,
      patchRowName: PACKAGE_NAME,
    },
    skillDistribution: {
      directory: relative(ROOT, skill.target),
      digest: skill.digest,
    },
  }
  await writeJson(join(DIST, 'manifest.json'), report)
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

await main()
