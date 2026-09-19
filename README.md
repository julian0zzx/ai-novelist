# ai-novelist

English | [中文](README.zh.md)

A **DSH plugin** that turns DeepSeek Harness into an AI web-novel composer — and, more
precisely, into an executable copy of a web-novel production SOP. The agent gets a real
project file, a planning pipeline with gates, a story bible, a per-chapter contract, a
metric ledger calibrated against same-genre medians, and a manuscript exporter — instead
of holding a novel in its context window.

Built for [@deepseek-ai/dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) `0.1.5-rc.1`.

## What it adds

**Nine model-facing tools**, one per capability, matching the phases of the SOP
(see [The SOP this implements](#the-sop-this-implements) below). Eight of them
**compute** — thresholds, gates, arithmetic, identical on every run. The ninth,
`novel_review`, **asks a model** to judge prose, because that is the one thing no
counter can decide; it is registered only where a model route exists.

| Tool | SOP phase | What it owns |
|---|---|---|
| `novel_init` | 一 策划 | The project and its commercial frame — platform, mode (paid/free), audience, genre, target readers, monetization — plus the calibration medians (`baselines`, same-genre metric medians from the last 30 days) and the writing parameters: outline window, opening gate chapters, stock target, outline ceiling. The **length plan** (总字数, 单章字数, 是否分卷/分几卷) is asked of the user, never assumed: unanswered questions come back as a checklist repeated every step, `totalChapters` is derived from total ÷ chapter length, and the numbers are cross-checked against each other and against the volume outline. |
| `novel_plan` | 一/二/四 | The planning pipeline: `competitor`, `pitch`, `world`, `outline`, `volume`, `chapter`, `beat`, `opening`, `naming`. |
| `novel_bible` | 一/四/六 | Cast, world facts, and reader promises: `character`, `world`, `link`, `review`. A `link` is a promise with a planting point, a due chapter, a payoff and a status; open promises past their due chapter are reported. |
| `novel_verify` | 三 验证 | The validation gate: `round` records one small-cost test with its metrics and returns the verdict (`pass` / `partial` / `fail`); `assess` compares the latest reading without recording a round. |
| `novel_write` | 五 连载 | One chapter's prose plus the delivery report: `write`, `read`, `check`. Send the prose with `delivered=[…]` and it reports which planned fields the draft reached, which it missed, which were never planned, and whether the length landed. Every write and check also returns the 去 AI 化 statistics (paragraph length, dialogue density, repeated sentence openings) — the tool reports symptoms and never edits the prose, so a revision is yours to make and re-send. |
| `novel_metrics` | 五 放大 | The feedback loop: `record` (a reading → the rules it fires, each with an action *and* a scope), `iterate` (write the decision into the ledger), `outcome` (attach a later reading and report whether it actually worked), `rules` (the thresholds currently in force). |
| `novel_status` | 全流程 | The dashboard, entirely derived from the project — no second ledger to maintain: `dashboard` (default), `bible`, `plan`, `chapter`. |
| `novel_repo` | 六 复盘 | The closing phase: `export` (Markdown manuscript), `retro`, `asset`, `lesson`, `template`. |
| `novel_review` | 五/六 判断 | **The model-backed tool.** `ai-flavor` diagnoses one chapter against a versioned 去 AI 化 rubric (and, with `rewrite=true`, proposes a rewritten draft as a file — never written into the chapter); `opening` reviews the gate chapters against the SOP opening checklist; `competitor` dismantles pasted competitor text into a record `novel_plan` can take; `retro` reads the project's own numbers and proposes reusable/avoid-this lessons. Every call records the provider, the model and the prompt version, and writes its transcript to `.novel/reviews/`. Nothing a model writes enters the ledger unless you pass `save=true`. |

**A `novelState` service** — the single, conflict-checked write path every tool and
surface shares, resolved per session.

**A Web UI** — two surfaces over the same project: a **Kanban** tab beside Chat and
Trajectory, and a "Novel Composer" tab in the right Sidebar opened from the sidebar guide.

| Surface | Where | What it shows |
|---|---|---|
| **Kanban** | The session's view tabs, next to Chat and Trajectory | The whole project at a glance. Columns are the chapter lifecycle — 待写 / 写作中 / 已修订 / 已完成 — and each card carries its number, title, volume, 字数, beats, and what its contract still owes (a missing chapter hook, unanswered 细纲 fields). Above the board: the SOP stage and what blocks the next one, chapters written, total 字数, cast, world facts, open promises, and naming candidates. |

The Kanban tab appears **only where there is a novel project**: it is added when the
session's workspace holds a `.novel/novel.json`, and a workspace without one keeps exactly
the Chat and Trajectory tabs it always had. It reads the project through the same codec the
host writes with, so it can lag the files but never disagree with them; press *重新读取* to
re-read after the agent writes.

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
- **The eight computing tools never judge prose.** The delivery report compares a draft with
  the plan it was written against; the 去 AI 化 hints are countable statistics — paragraph
  length, dialogue density, repeated sentence openings — not a verdict on voice; and
  compliance is a checklist you confirm rather than a scanner that reports "clean".
  `novel_review` *does* judge, which is why it is a separate tool with a separate record:
  its findings cite the text, name the model and the rubric version, and enter no ledger a
  threshold acts on.
- **It never rewrites published chapters.** It records the intended scope of an iteration
  and reports promises that were due and not paid; the decision and the edit stay with the
  author.
- **It measures nothing by itself.** No platform API, no crawler, no analytics.

## Install

From the DSH profile you want the composer in (`web` for the browser GUI):

```sh
pnpm install                      # in this repo, once
dsh plugin --profile web add -w "$(pwd)/packages/novelist-bundle"
```

`-w` is not optional. `dsh plugin` forwards everything after `add` verbatim to pnpm running
in the profile directory, and that directory is itself a pnpm workspace root (its
`pnpm-workspace.yaml` sits next to its `package.json`), so pnpm only accepts a new dependency
there with `--workspace-root`.

`dsh plugin add` then reconciles `dsh.profile.bundles`: because `@ai-novelist/novelist-bundle`
declares `dsh.bundle.patch`, it joins the profile's layer stack automatically. Restart
`dsh web`; the eight computing tools appear in the next session, `novel_review` joins them
wherever a model is available, and the composer tab appears in the sidebar guide.

That trailing spec is a **package name, not a command name** — `dsh plugin` forwards
everything after it to pnpm, so it must be something pnpm resolves. `@ai-novelist/novelist-bundle`
is the *bundle* (npm scope `@ai-novelist`, package `composer`); the *plugin* it pulls in is
`@ai-novelist/novelist-skill`, loaded under the row id `ai-novelist`.

Verify the composition without booting a session:

```sh
dsh --profile web --dump-config | grep -A2 ai-novelist
```

To remove it again:

```sh
dsh plugin --profile web remove -w @ai-novelist/novelist-bundle
```

> **Working on the plugin itself?** After editing source, `pnpm run build` (or
> `pnpm --filter @ai-novelist/novelist-skill run build --watch`); the profile links this
> checkout, so a rebuild is enough for the host half. The browser half is served from
> `packages/novelist-skill/lib/client.js` and needs a page refresh. The profile
> loads `lib/`, so a booted `dsh web` keeps the last built tools until you rebuild.

## Layout

```
packages/
  novelist-bundle/                # BUNDLE  @ai-novelist/novelist-bundle
    cordis.patch.yml              #   inserts the plugin row into the profile tree
  novelist-skill/                 # PLUGIN  @ai-novelist/novelist-skill
    src/core/                     #   pure domain: types, state, plan checks, metric rules,
                                  #   delivery reports, retrospectives, workspace policy
    src/host/                     #   ctx.fs store, session resolver, workspace views,
                                  #   prompt section, tools
    src/client/                   #   the two Web UI surfaces, built to lib/client.js:
                                  #   the Kanban view and the right-Sidebar tab they share
    src/index.ts                  #   the Cordis plugin (name / inject / Config / apply)
```

Directory names mirror the package names: the plugin is `@ai-novelist/novelist-skill`, so it
lives in `packages/novelist-skill`; the bundle is `@ai-novelist/novelist-bundle`, so it
lives in `packages/novelist-bundle`.

Two packages, because a bundle's patch inserts a *row* naming a plugin package and a
package cannot insert a row for itself.

The host package has its own developer reference —
[`packages/novelist-skill/README.md`](packages/novelist-skill/README.md) —
with the module map, the schema-v3 data model, and the invariants a contributor must keep.

## Where the novel lives

The novel is **readable Markdown in your workspace**. `.novel/novel.json` holds only what has
to move atomically — the premise and commercial frame, the metric readings and the iteration
ledger, the foreshadowing ledger, and an index of where the content files are. Everything an
author reads and rewrites lives in a file they can open:

```
novel-workspace/
  全书大纲.md            # logline, acts, minimal outline
  人物设定.md            # one section per character
  世界观设定.md          # one section per world fact
  分卷大纲.md            # one section per volume
  章节大纲.md            # the chapter table + the rhythm table
  章节/
    第001章-山门.md      # prose
    第001章-山门.细纲.md # the six-field contract
  .novel/
    novel.json            # metadata + index (schemaVersion: 3)
    novel.v2.backup.json  # only after a migration; never overwritten
    manuscript.md         # written by novel_repo operation="export"
    templates/            # written by novel_repo operation="template"
    reviews/              # model transcripts and rewritten drafts
```

**The file wins.** Edit any of them by hand and the next read adopts what you wrote and
refreshes the index. The one guard rail is syntax: if a file cannot be parsed, the tool
reports the file and the reason and refuses to touch it, because guessing at a broken file is
how a draft gets destroyed. `wordCount` is the exception to "the file wins" — it is derived,
so it is recomputed from the prose on every read and back-filled on every write.

Writes go content-files-first and metadata-last, so the index may point at older content for
the length of one write but never at a file that does not exist. A failed write reports which
files landed and which did not.

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
| `.novel/novel.json` (metadata + index) | `novel` | Adopted as-is; the content files beside it are the novel. Tools and prompt are live. |
| the content `.md` files | `novel` | The file wins: your edit is adopted on the next read. |
| a `.novel/` directory with no document yet | `novel` | Treated as a novel workspace: the document is created empty and `novel_init` fills in the premise. |
| three or more chapter-shaped files (`001-*.md`, `第3章.md`) | `novel` | Recognized as an existing draft; a project document is created beside it. |
| a creative note (`创意整理.md`, `人物设定.md`, `story-outline.md`, …) | `novel` | Recognized as a book folder: an empty project document is created, titled after the folder. |
| an outline plus a chapter, or two novel-shaped files | `novel` | Same as above. |
| an empty directory | `fresh` | **Left untouched.** Ask the agent to start a novel here (or set `adoptEmptyWorkspace: true`). |
| a repo (`package.json`, `.git`, …) | `plain` | Left alone, whatever Markdown it holds. The tools stay idle and the prompt says so. |
| anything else | `plain` | Left alone. |

The deployment's own directory is classified when the plugin mounts; every other directory is
classified when a session opens in it. A novel workspace then gets a **runtime-context section**
in the system prompt on every step, naming the kind and reporting the current standing
(chapters, 字数, unwritten count, bible size) — so a session opened on a novel needs no
discovery turn, and a session opened somewhere else is never described with the numbers (or the
verdict) of the directory the server was launched from.

#### What "initialized" means, and how to undo it

Automatic initialization writes **only the empty scaffold**: `.novel/novel.json` with the
folder's name as the title and every story field blank. Nothing you wrote is touched, nothing
is overwritten (the write is `createIfAbsent`), and no story decision — premise, medians,
pitch, chapters — is invented. That is the whole point: the scaffold is what makes the tools,
the prompt section and the Kanban board exist from your first message instead of waiting for
someone to remember `novel_init`.

If it claims a directory you did not mean, delete it and the composer forgets:

```sh
rm -rf <that-directory>/.novel      # the next classification sees `plain` again
```

To turn the eagerness down, set `workspaceMode: auto` (only marked projects are adopted) or
`off` (nothing is ever written).

### One chat, one novel

There is no tool for switching projects, because the project follows the session: open the
other workspace in the UI and the tools resolve to its root automatically. A session that
records no `cwd` falls back to the configured `workspaceRoot`, and only then to the
process directory. `novel_status` reports the verdict for the *calling session's*
workspace, which is the authoritative answer for what you are editing.

All of it is conservative by design: a repo with a few Markdown files is *not* a draft,
only chapter-shaped filenames count as chapters, a single generic note claims nothing, and
nothing is written into an empty directory unless you ask for it. To pin a directory
regardless of detection:

```yaml
# your profile's cordis.patch.yml
- id: ai-novelist
  config:
    workspaceRoot: /Users/me/novels/qingyun   # fallback when a session records no cwd
    workspaceMode: signal                     # signal (default) | auto | novel | off
    adoptEmptyWorkspace: false                # true: create the project in an empty directory at boot
    reviewProvider: ''                        # empty: reviews follow the session's model
    reviewModel: ''                           # set both to pin novel_review to one model
    reviewTimeoutMs: 120000                   # per-call ceiling for a review
```

`off` never writes anything at boot — the tools are still registered, and `novel_init`
works if the user asks for it explicitly.

`novel_review` is the only tool that needs a model, and it resolves its route in this order:
the `provider`/`model` named on the call itself, then the configured `reviewProvider`/
`reviewModel`, then whatever model the session is using. With no route at all the tool is not
registered, so a profile without a model keeps eight working tools instead of nine broken ones.

## Packaging

`pnpm run dist` builds and then produces two distributions in `dist/`, both carrying the
same nine tools — the tool code is copied from this checkout, never re-implemented.

### 1. DSH plugin distribution — `dist/dsh-plugin/ai-novelist-<version>.tgz`

**One tarball, one package.** `@ai-novelist/novelist-bundle` is simultaneously the bundle, the
plugin and the browser half:

- it declares `dsh.bundle.patch`, which is what makes DSH append it to `dsh.profile.bundles`;
- its root export (and the `./host` alias) is the module that registers the nine tools;
- its `./client` export is the Web GUI half, served as a `window.__ModuleLoader__` bundle.

```sh
pnpm run dist
dsh plugin --profile web add -w dist/dsh-plugin/ai-novelist-0.1.0.tgz
```

The tarball carries the built `lib/`, so a target machine needs only Node and DSH — no
registry, no network install, no build step.

> **Two constraints the packaging satisfies, both learned by testing.** First, the patch
> row must name the **bare package**: the client-half scanner derives a package root with
> an exact-name rule, so a row named `@ai-novelist/novelist-bundle/host` resolves the plugin but
> silently leaves the browser half out of the boot graph. Second, the distribution has to
> be **one** package: pnpm's tarball install understands exactly one package per archive,
> so both a nested `file:./sub` (`ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND`) and two side-by-side
> packages (`file:../sibling`, which extracted only one of them) fail. The source
> repository keeps the two packages separate because they are built by different tools for
> different targets; only the distribution merges them, and the pack step rebuilds the
> browser half so its registration id matches the shipped package name.

### 2. SKILL distribution — `dist/skill/ai-novelist/`

A portable Agent Skill bundle: `SKILL.md` with the frontmatter DSH's filesystem provider
parses and a table of all nine tools, `references/` with the workflow, the tool reference
and the generated thresholds, `scripts/` with the installer, and `tools/` carrying the same
package as distribution 1.

```sh
node dist/skill/ai-novelist/scripts/setup.mjs --profile web
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
> its "The nine tools" table both list all nine.

## Development

```sh
pnpm install
pnpm run check        # build → typecheck → test
pnpm run build        # tsc (host) + tsdown (browser bundle)
pnpm run dist         # build, then produce dist/dsh-plugin and dist/skill
pnpm test             # vitest: the SOP pipeline end to end, plus the store,
                      # workspace, prompt, board and bundle specs
pnpm run fixture /tmp/ain-fixture
                      # write a sample schema-3 novel project (chapters in all
                      # four columns) to look at the surfaces by hand
```

To see the Kanban tab, install the bundle into a DSH profile, start `dsh web`, and open a
session **in the fixture directory** — the tab is part of the session's view row, so it
appears for the sessions whose workspace holds a novel project and nowhere else.

[`docs/sop.md`](docs/sop.md) is the workflow the tools implement — the authoritative list
of phases, fields and thresholds. [`docs/architecture.md`](docs/architecture.md) explains
how the plugin is put together and why; it is the file to read before changing anything.

## License

MIT
