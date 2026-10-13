# ai-novelist

English | [中文](README.zh.md)

A **DSH plugin** that turns DeepSeek Harness into an AI web-novel composer — and, more
precisely, into an executable copy of a web-novel production SOP. The agent gets a real
project file, a planning pipeline with gates, a story bible, a per-chapter contract, a
metric ledger calibrated against same-genre medians, and a manuscript exporter — instead
of holding a novel in its context window.

Built for [@deepseek-ai/dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) `0.2.0-rc.2`.

## What it adds

**Nine model-facing tools**, one per capability, matching the phases of the SOP
(see [The SOP this implements](#the-sop-this-implements) below) — plus one that
deliberately sits outside them. Eight of them
**compute** — thresholds, gates, arithmetic, identical on every run. The ninth,
`novel_review`, **asks a model** to judge prose, because that is the one thing no
counter can decide; it is registered only where a model route exists.

Two of the nine exist because a pipeline that runs from an inspiration straight to
chapters is a pipeline that never asked the author anything. `novel_confirm` records
the checkpoints only the author can close — the **settings** sign-off, which must
exist before chapter 1 and is itself settled one layer at a time (立意 → 世界观 →
人物设定 → 全书大纲 → 分卷大纲), and the **文风复核** of the prose voice, due once the
golden three chapters (第 1–3 章) have prose and before chapter 4. Two things gate the
prose: the premise, and the 写作风格 block of the 全书大纲 — seven named elements
written before chapter 1, because a voice chosen while writing the first chapter is a
voice the author never got to steer.

| Tool | SOP phase | What it owns |
|---|---|---|
| `novel_init` | 一 策划 | The project and its commercial frame — platform, mode (paid/free), audience, genre, target readers, monetization — plus the calibration medians (`baselines`, same-genre metric medians from the last 30 days) and the writing parameters: outline window, opening gate chapters, stock target, outline ceiling. The **length plan** (总字数, 单章字数, 是否分卷/分几卷) is asked of the user, never assumed: unanswered questions come back as a checklist repeated every step, `totalChapters` is derived from total ÷ chapter length, and the numbers are cross-checked against each other and against the volume outline. |
| `novel_plan` | 一/二/三/四 | The planning pipeline: `competitor`, `pitch`, `world`, `outline`, `volume`, `chapter`, `beat`, `opening`, `naming`, and `launch` — the phase-three go/no-go on the opening package. `go` unlocks the full skeleton; `revise` and `abandon` must name a fallback target and an abandon condition or they are refused. |
| `novel_confirm` | 一/五 | The author checkpoints. **The settings are settled one layer at a time, in order** — 立意 (`kind="settings"`/`"premise"`) → 世界观 (`"world"`) → 人物设定 (`"cast"`) → 全书大纲 (`"outline"`, which owns the 写作风格 block) → 分卷大纲 (`"volume"`); `kind="style"` is the **文风复核** after the golden three chapters — hand 第 1–3 章 to the user, ask whether 文风/表达方式/遣词用句 need adjusting (writing any adjustment back into the outline and revising the affected chapters first), record the round and confirm. Put *one* layer in front of the user at a time; a later layer is refused while an earlier one is still open, because handing over the whole setup at once is what this ordering exists to prevent, and the 全书大纲 layer itself cannot be confirmed while its 写作风格 block is unwritten. `status` (default) reports where every layer stands and which is next; `discuss` records **one round** — what you put in front of the user (`proposal`) and what the user actually answered (`feedback`, required: a round with no user words is refused) — and `confirm` records the version the author approved (`summary`) together with the author's own words (`note`) — both required. The premise needs **two** recorded rounds before it can be confirmed; every later layer, and the voice review, needs one. Never confirm on the user's behalf, never invent a round. |
| `novel_bible` | 一/四/六 | Cast, world facts, and reader promises: `character`, `world`, `link`, `review`. A `link` is a promise with a planting point, a due chapter, a payoff and a status; open promises past their due chapter are reported. |
| `novel_write` | 五 连载 | One chapter's prose plus the delivery report: `write`, `read`, `check`. **The one hard-gating tool in the pipeline**: it refuses to write while the user has not signed the settings off, while the 写作风格 block of the 全书大纲 is not written out (`styleTone` … `styleTaboos`), and — once the golden three chapters have prose — while the user has not reviewed the voice **and** while no 去 AI 化 diagnosis has ever been recorded (第 4 章 onward); the refusal names the calls that open the gate. That refusal is the point: everywhere else the SOP reports a disagreement and lets the call stand, and that is precisely how a model produced four chapters without the author ever being asked. The **first draft is written to 125% of the chapter target** — 去 AI 化 and hand-editing delete a large share of a draft — and the finished chapter is then held to **-5%/+15%** (an asymmetric window: coming in under the promised length is the real failure, so the shortfall is capped at 5%); the tool picks the gate the chapter's status implies and prints both windows. Send the prose with `delivered=[…]` and it reports which planned fields the draft reached, which it missed, and which were never planned. Every write and check also returns the 去 AI 化 statistics — paragraph length, dialogue density, repeated sentence openings, the **对举句 count** (「不是 A，是 B」 and its variants, with two quoted hits) and any phrase of the book's own 负面清单 that appears — because those are the tells a counter can find and the ones a judge most often misses. The tool reports symptoms and never edits the prose, so a revision is yours to make and re-send. |
| `novel_assess` | 五 按需 | **Not a phase, and it gates nothing.** The on-demand investment evaluation — started when the author asks whether the book is still worth continuing. `record` (one hand-transcribed reading → the rules it fires, each with an action *and* a scope; it also accepts `baselines` to re-calibrate the medians on the spot), `iterate` (write the decision into the ledger), `evaluate` (the session: compares the reading against the calibrated medians, automatically back-fills every open change against it, and returns a verdict — 继续投入 / 换变量后继续 / 切书止损), `outcome` (the manual override: close one named change against one named reading, for the cases the automatic back-fill cannot infer), `history`, `rules`. A non-passing evaluation must say where to fall back to and what would end the book, and every evaluation must leave an appointment for the next one; a reading whose metrics all lack a median earns no verdict at all. |
| `novel_status` | 全流程 | The dashboard, entirely derived from the project — no second ledger to maintain: `dashboard` (default), `bible`, `plan`, `chapter`. |
| `novel_repo` | 六 复盘 | The closing phase: `export` (Markdown manuscript), `retro`, `asset`, `lesson`, `template`. |
| `novel_review` | 五/六 判断 | **The model-backed tool.** `ai-flavor` diagnoses one chapter against a versioned 去 AI 化 rubric **and against this book's own 写作风格 and 负面清单**, with the mechanically counted symptoms handed in so it judges rather than re-counts (and, with `rewrite=true`, proposes a rewritten draft as a file — never written into the chapter); `opening` reviews the gate chapters against the SOP opening checklist; `competitor` dismantles pasted competitor text into a record `novel_plan` can take; `retro` reads the project's own numbers and proposes reusable/avoid-this lessons. Every call records the provider, the model and the prompt version, and writes its transcript to `.novel/reviews/`. Nothing a model writes enters the ledger unless you pass `save=true`. |

**A `novelState` service** — the single, conflict-checked write path every tool and
surface shares, resolved per session.

**A Web UI** — two surfaces over the same project: a **Kanban** tab beside Chat and
Trajectory, and a "Novel Composer" tab in the right Sidebar opened from the sidebar guide.

| Surface | Where | What it shows |
|---|---|---|
| **Kanban** | The session's view tabs, next to Chat and Trajectory | The whole project at a glance, in two halves. **过程文档** — one card per planning artefact, in SOP order (立意与核心设定 / 竞品拆解 / 候选书名 / 世界观设定 / 人物设定 / 全书大纲 / 写作风格 / 分卷大纲 / 爽点节拍表 / 开篇工程清单 / 上线决策 / 连载数据 / 完本复盘) — each showing whether it has been started, how much of it exists (pitch fields, dismantled titles, candidate sets, cast entries, outline spine elements, style elements, volumes, beats, checklist items), which parts it still owes **by name**, and the gate it sits behind (`卡住正文` for the two the prose gate enforces, `go 之后才做` for the work the launch decision authorises). Below it the **章节看板**: columns are the chapter lifecycle — 待写 / 写作中 / 已修订 / 已完成 — and each card carries its number, title, volume, 字数 (drafting columns compare against the **125% draft target**, revised/final columns against the finished target), beats, and what its contract still owes (a missing chapter hook, unanswered 细纲 fields). Above both: the SOP stage and what blocks the next one, chapters written, total 字数, cast, world facts, open promises, naming candidates, and every author checkpoint layer by layer (立意 / 世界观 / 人设 / 全书大纲 / 分卷大纲 / 文风复核). |

The Kanban tab appears **only where there is a novel project**: it is added when the
session's workspace holds a `.novel/novel.json`, and a workspace without one keeps exactly
the Chat and Trajectory tabs it always had. It reads the project through the same codec the
host writes with, so it can lag the files but never disagree with them; press *重新读取* to
re-read after the agent writes.

## The SOP this implements

The workflow is [`docs/sop.md`](docs/sop.md) — 爆款网文创作全流程 SOP 3.5, whose closed loop
is **假设 → 验证 → 放大 → 复盘 → 复用**: form a hypothesis from a competitor study and a
memorable point, put the opening package in front of real readers, record a human go/no-go on
it, build the full skeleton only after a `go`, iterate while serializing, then turn the
finished book into reusable structure.

Two axes, and only one of them is the pipeline. The **pipeline** — plan, opening package,
launch decision, full skeleton, serial — advances on planned and written work alone; it never
waits for a platform number. The **data evaluation** (`novel_assess`) is started by the author
at the moment they ask whether the book is still worth continuing, normally once the platform
has numbers to transcribe by hand; it is what turns readings into the 继续投入 / 换变量后继续
/ 切书止损 decision. Nothing gates on it: a project nobody has ever measured is a normal
project, and a missing reading is never a reason to stop.

The plugin's contribution is making that SOP *executable* rather than advisory:

- every step's output becomes a field in one project document, so nothing lives only in
  prose and gets forgotten;
- thresholds are computed from calibrated medians instead of being mental arithmetic —
  `novel_init` records the medians, `novel_assess` applies the multipliers when an
  evaluation is run;
- the phase is derived from the project, so the tools always report where the project
  actually stands and what the next phase still needs;
- a call the SOP would rather you made later still succeeds, and returns `warnings` naming
  what is missing — the soft gate never refuses a call. There are two deliberate exceptions,
  both about stopping a decision from becoming a formality: a `novel_plan operation="launch"`
  verdict other than `go` must say where to fall back to and what would end the concept, and
  a `novel_assess operation="evaluate"` must leave an appointment for the next evaluation
  (and cannot answer at all when every metric lacks a comparable median).

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
  全书大纲.md            # logline, the narrative spine (synopsis, protagonist/support/antagonist arcs,
                        # faction shift, adversarial arcs, costs, gains), full outline, acts, minimal outline
  世界观设定.md          # one section per world fact
  人物设定.md            # one section per character
  分卷大纲.md            # one section per volume: the spine first (synopsis, arcs, factions, conflict,
                        # costs, gains), then goal/conflict/climax/hook + the volume's own rhythm (≈ volume/50)
  章节大纲.md            # the chapter table + the rhythm table (each contract ≈ chapter/10)
  竞品拆解.md            # one section per comparable title, twelve editable fields (20–50 of them)
  章节/
    第001章-山门.md      # prose
    第001章-山门.细纲.md # the contract: plot task, key turn, price paid, conflict, payoff, gap, beats, hook
  .novel/
    novel.json            # metadata + index (schemaVersion: 3)
    novel.v2.backup.json  # only after a migration; never overwritten
    manuscript.md         # written by novel_repo operation="export"
    templates/            # written by novel_repo operation="template"
    reviews/              # model transcripts and rewritten drafts
```

**Every outline layer is checked story first, payoffs second, length last** (SOP 3.5 §1.5). Each
layer names its narrative elements as fields, every empty one is reported, and the word-count line
is not printed until they are — an outline that filled every category and hit its length target but
cannot tell the whole story is reported as *no synopsis*, not as on target.

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
    reviewMaxTokens: 8192                     # output budget for one review call
    reviewReasoningEffort: off                # off | low | high | max | '' (adapter default)
```

`off` never writes anything at boot — the tools are still registered, and `novel_init`
works if the user asks for it explicitly.

`novel_review` is the only tool that needs a model, and it resolves its route in this order:
the `provider`/`model` named on the call itself (both, or the call is refused rather than
silently falling back), then the configured `reviewProvider`/`reviewModel`, then whatever
model the session is using. With no route at all the tool is not registered, so a profile
without a model keeps eight working tools instead of nine broken ones.

`reviewReasoningEffort` defaults to `off` for a reason worth knowing: a route that supports
reasoning applies its own default (high, for DeepSeek) when the caller asks for nothing, and
thinking tokens are billed against `reviewMaxTokens` together with the answer. A reviewer
left on its default could spend the entire budget thinking and return no text at all. The
effort is only sent when the exact route declares it, so pinning reviews to a non-reasoning
model is safe. Raise `reviewMaxTokens` if a whole-chapter rewrite comes back truncated.

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

AGPL-3.0
