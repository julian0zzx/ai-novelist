# ai-webnovel-composer

English | [中文](README.zh.md)

A **DSH plugin** that turns DeepSeek Harness into an AI web-novel composer — and, more
precisely, into an executable copy of a web-novel production SOP. The agent gets a real
project file, a planning pipeline with gates, a story bible, a per-chapter contract, a
metric ledger calibrated against same-genre medians, and a manuscript exporter — instead
of holding a novel in its context window.

Built for [@deepseek-ai/dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) `0.1.5-rc.1`.

## What it adds

**Eight model-facing tools**, one per capability, matching the phases of the SOP
(see [The SOP this implements](#the-sop-this-implements) below).

| Tool | SOP phase | What it owns |
|---|---|---|
| `novel_init` | 一 策划 | The project and its commercial frame — platform, mode (paid/free), audience, genre, target readers, monetization — plus the calibration medians (`baselines`, same-genre metric medians from the last 30 days) and the writing parameters: outline window, opening gate chapters, stock target, outline ceiling. |
| `novel_plan` | 一/二/四 | The planning pipeline: `competitor`, `pitch`, `world`, `outline`, `volume`, `chapter`, `beat`, `opening`, `naming`. |
| `novel_bible` | 一/四/六 | Cast, world facts, and reader promises: `character`, `world`, `link`, `review`. A `link` is a promise with a planting point, a due chapter, a payoff and a status; open promises past their due chapter are reported. |
| `novel_verify` | 三 验证 | The validation gate: `round` records one small-cost test with its metrics and returns the verdict (`pass` / `partial` / `fail`); `assess` compares the latest reading without recording a round. |
| `novel_write` | 五 连载 | One chapter's prose plus the delivery report: `write`, `read`, `check`. Send the prose with `delivered=[…]` and it reports which planned fields the draft reached, which it missed, which were never planned, and whether the length landed. |
| `novel_metrics` | 五 放大 | The feedback loop: `record` (a reading → the rules it fires, each with an action *and* a scope), `iterate` (write the decision into the ledger), `outcome` (attach a later reading and report whether it actually worked), `rules` (the thresholds currently in force). |
| `novel_status` | 全流程 | The dashboard, entirely derived from the project — no second ledger to maintain: `dashboard` (default), `bible`, `plan`, `chapter`. |
| `novel_repo` | 六 复盘 | The closing phase: `export` (Markdown manuscript), `retro`, `asset`, `lesson`, `template`. |

**A `novelState` service** — the single, conflict-checked write path every tool and
surface shares, resolved per session.

**A Web UI tab** — "Novel Composer" in the right Sidebar, opened from the sidebar guide.

## The SOP this implements

The workflow is [`docs/sop.md`](docs/sop.md) — 爆款网文创作全流程 SOP 3.1, whose closed loop
is **假设 → 验证 → 放大 → 复盘 → 复用**: form a hypothesis from a competitor study and a
memorable point, validate it cheaply with a minimal viable outline and an opening package,
build the full skeleton only after it passes, iterate while serializing against calibrated
numbers, then turn the finished book into reusable structure.

The plugin's contribution is making that SOP *executable* rather than advisory:

- every step's output becomes a field in one project document, so nothing lives only in
  prose and gets forgotten;
- thresholds are computed from calibrated medians instead of being mental arithmetic —
  `novel_init` records the medians, `novel_metrics` and `novel_verify` apply the
  multipliers;
- the phase is derived from the data, so the tools always report where the project
  actually stands and what the next phase still needs;
- a call the SOP would rather you made later still succeeds, and returns `warnings` naming
  what is missing — the soft gate never refuses a call. The one deliberate exception is a
  validation round that did not pass: it must say where to fall back to and what would make
  you abandon the concept, or the round is refused, because that record would otherwise be
  meaningless.

[`docs/architecture.md`](docs/architecture.md) explains how this is built and why; read it
before changing anything.

### What it will not do

Stated plainly, because the SOP is explicit that these are human or platform jobs:

- **It never invents a metric.** Numbers come from the platform, an editor, a test cohort,
  or a human's judgement. The tool records them, compares them with your baselines,
  derives an action and a scope, and warns. If nobody reports a reading, there is no
  reading.
- **It never judges prose quality.** The delivery report compares a draft with the plan it
  was written against. The 去 AI 化 hints are countable statistics — paragraph length,
  dialogue density, repeated sentence openings — not a verdict on voice, and compliance is
  a checklist you confirm rather than a scanner that reports "clean".
- **It never rewrites published chapters.** It records the intended scope of an iteration
  and reports promises that were due and not paid; the decision and the edit stay with the
  author.
- **It measures nothing by itself.** No platform API, no crawler, no analytics.

## Install

From the DSH profile you want the composer in (`web` for the browser GUI):

```sh
pnpm install                      # in this repo, once
dsh plugin --profile web add -w "$(pwd)/packages/ai-webnovel-composer"
```

`-w` is not optional. `dsh plugin` forwards everything after `add` verbatim to pnpm running
in the profile directory, and that directory is itself a pnpm workspace root (its
`pnpm-workspace.yaml` sits next to its `package.json`), so pnpm only accepts a new dependency
there with `--workspace-root`.

`dsh plugin add` then reconciles `dsh.profile.bundles`: because `@ai-webnovel/composer`
declares `dsh.bundle.patch`, it joins the profile's layer stack automatically. Restart
`dsh web`; the eight tools appear in the next session, and the composer tab appears in the
sidebar guide.

That trailing spec is a **package name, not a command name** — `dsh plugin` forwards
everything after it to pnpm, so it must be something pnpm resolves. `@ai-webnovel/composer`
is the *bundle* (npm scope `@ai-webnovel`, package `composer`); the *plugin* it pulls in is
`@ai-webnovel/composer-host`, loaded under the row id `ai-webnovel-composer`.

Verify the composition without booting a session:

```sh
dsh --profile web --dump-config | grep -A2 ai-webnovel
```

To remove it again:

```sh
dsh plugin --profile web remove -w @ai-webnovel/composer
```

> **Working on the plugin itself?** After editing source, `pnpm run build` (or
> `pnpm --filter @ai-webnovel/composer-host run build --watch`); the profile links this
> checkout, so a rebuild is enough for the host half. The browser half is served from
> `packages/ai-webnovel-composer-host/lib/client.js` and needs a page refresh. The profile
> loads `lib/`, so a booted `dsh web` keeps the last built tools until you rebuild.

## Layout

```
packages/
  ai-webnovel-composer/         # BUNDLE  @ai-webnovel/composer
    cordis.patch.yml            #   inserts the plugin row into the profile tree
  ai-webnovel-composer-host/    # PLUGIN  @ai-webnovel/composer-host
    src/core/                   #   pure domain: types, state, plan checks, metric rules,
                                #   delivery reports, retrospectives, workspace policy
    src/host/                   #   ctx.fs store, session resolver, prompt section, tools
    src/client/                 #   Web UI tab (right Sidebar), built to lib/client.js
    src/index.ts                #   the Cordis plugin (name / inject / Config / apply)
```

Directory names mirror the package names: the plugin is `@ai-webnovel/composer-host`, so it
lives in `packages/ai-webnovel-composer-host`; the bundle is `@ai-webnovel/composer`, so it
lives in `packages/ai-webnovel-composer`.

Two packages, because a bundle's patch inserts a *row* naming a plugin package and a
package cannot insert a row for itself.

The host package has its own developer reference —
[`packages/ai-webnovel-composer-host/README.md`](packages/ai-webnovel-composer-host/README.md) —
with the module map, the schema-v2 data model, and the invariants a contributor must keep.

## Where the novel lives

One JSON document, `<workspace>/.novel/novel.json`, is the single source of truth: premise,
commercial frame, cast, world facts, promises, the plan, every chapter, the metric readings
and the iteration ledger move together, so no write can leave the project internally
inconsistent. It is plain JSON on purpose — you can read it, diff it in git, or edit it by
hand, and `novel_status` will show the result.

```
novel-workspace/
  .novel/
    novel.json             # the project (schemaVersion: 2)
    manuscript.md          # written by novel_repo operation="export"
    templates/             # written by novel_repo operation="template"
```

The document is `schemaVersion: 2`. A version-1 document is migrated automatically on read
and never lost: the old chapter `synopsis` becomes that chapter's task, the old premise,
cast, world facts and chapters are kept, and everything the SOP needs that version 1 did
not model starts empty (so the project simply lands in the phase its data supports). An
unsupported version is refused rather than guessed at.

### How a workspace becomes a novel workspace

A **workspace** in DSH is a directory the host registers; a **session** records the
directory (`cwd`) it runs in. The composer resolves the project from the **session's
workspace**, never from where the server happened to be launched — so one running
`dsh web` can host sessions for many novels, each with its own project.

The composer classifies each session's workspace and acts on it:

| What it finds | Verdict | What happens |
|---|---|---|
| `.novel/novel.json` (the project document) | `novel` | Adopted as-is — never rewritten. Tools and prompt are live. |
| a `.novel/` directory with no document yet | `novel` | Treated as a novel workspace; the document is left for `novel_init`. |
| three or more chapter-shaped files (`001-*.md`, `第3章.md`) | `novel` | Recognized as an existing draft; a project document is created beside it. |
| an empty directory | `fresh` | **Left untouched.** Ask the agent to start a novel here (or set `adoptEmptyWorkspace: true`). |
| a repo (`package.json`, `.git`, …) | `plain` | Left alone. The tools stay idle and the prompt says so. |
| anything else | `plain` | Left alone. |

A novel workspace also gets a **runtime-context section** in the system prompt every
step, naming the kind and reporting the current standing (chapters, 字数, unwritten
count, bible size) — so a session opened on a novel needs no discovery turn.

### One chat, one novel

There is no tool for switching projects, because the project follows the session: open the
other workspace in the UI and the tools resolve to its root automatically. A session that
records no `cwd` falls back to the configured `workspaceRoot`, and only then to the
process directory. `novel_status` reports the verdict for the *calling session's*
workspace, which is the authoritative answer for what you are editing.

All of it is conservative by design: a repo with a few Markdown files is *not* a draft,
only chapter-shaped filenames count, and nothing is written into an empty directory
unless you ask for it. To pin a directory regardless of detection:

```yaml
# your profile's cordis.patch.yml
- id: ai-webnovel-composer
  config:
    workspaceRoot: /Users/me/novels/qingyun   # fallback when a session records no cwd
    workspaceMode: auto                       # auto (default) | novel | off
    adoptEmptyWorkspace: false                # true: create the project in an empty directory at boot
```

`off` never writes anything at boot — the tools are still registered, and `novel_init`
works if the user asks for it explicitly.

## Packaging

`pnpm run dist` builds and then produces two distributions in `dist/`, both carrying the
same eight tools — the tool code is copied from this checkout, never re-implemented.

### 1. DSH plugin distribution — `dist/dsh-plugin/ai-webnovel-composer-<version>.tgz`

**One tarball, one package.** `@ai-webnovel/composer` is simultaneously the bundle, the
plugin and the browser half:

- it declares `dsh.bundle.patch`, which is what makes DSH append it to `dsh.profile.bundles`;
- its root export (and the `./host` alias) is the module that registers the eight tools;
- its `./client` export is the Web GUI half, served as a `window.__ModuleLoader__` bundle.

```sh
pnpm run dist
dsh plugin --profile web add -w dist/dsh-plugin/ai-webnovel-composer-0.1.0.tgz
```

The tarball carries the built `lib/`, so a target machine needs only Node and DSH — no
registry, no network install, no build step.

> **Two constraints the packaging satisfies, both learned by testing.** First, the patch
> row must name the **bare package**: the client-half scanner derives a package root with
> an exact-name rule, so a row named `@ai-webnovel/composer/host` resolves the plugin but
> silently leaves the browser half out of the boot graph. Second, the distribution has to
> be **one** package: pnpm's tarball install understands exactly one package per archive,
> so both a nested `file:./sub` (`ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND`) and two side-by-side
> packages (`file:../sibling`, which extracted only one of them) fail. The source
> repository keeps the two packages separate because they are built by different tools for
> different targets; only the distribution merges them, and the pack step rebuilds the
> browser half so its registration id matches the shipped package name.

### 2. SKILL distribution — `dist/skill/ai-webnovel-composer/`

A portable Agent Skill bundle: `SKILL.md` with the frontmatter DSH's filesystem provider
parses and a table of all eight tools, `references/` with the workflow, the tool reference
and the generated thresholds, `scripts/` with the installer, and `tools/` carrying the same
package as distribution 1.

```sh
node dist/skill/ai-webnovel-composer/scripts/setup.mjs --profile web
```

Copy the directory into any scanned skill root to make it discoverable — for a project,
`<git-root>/.dsh/skills/` or `<git-root>/.agents/skills/`; for the user,
`$DSH_HOME/skills/` or `~/.agents/skills/`.

> **The tools in a skill bundle are not declared by the skill.** A skill is instructions
> plus resources: its frontmatter admits `name`, `description`, `whenToUse`, `metadata`,
> `disable-model-invocation` and `user-invocable`, and nothing else — there is no field
> that registers a tool. A tool exists only once a plugin registers it on `ctx.tools`. So
> the skill bundle carries the code *and* the script that installs it, and `SKILL.md` says
> so plainly rather than implying the tools come for free. Its `metadata.tools` line and
> its "The eight tools" table both list all eight.

## Development

```sh
pnpm install
pnpm run check        # build → typecheck → test
pnpm run build        # tsc (host) + tsdown (browser bundle)
pnpm run dist         # build, then produce dist/dsh-plugin and dist/skill
pnpm test             # vitest: the SOP pipeline end to end, plus the store,
                      # workspace, prompt and bundle specs
```

[`docs/sop.md`](docs/sop.md) is the workflow the tools implement — the authoritative list
of phases, fields and thresholds. [`docs/architecture.md`](docs/architecture.md) explains
how the plugin is put together and why; it is the file to read before changing anything.

## License

MIT
