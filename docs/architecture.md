# Architecture

How the AI Web Novel Composer is put together, and why each layer sits where it does.
Read this before changing anything: most of the structure is dictated by how DSH loads
plugins, and the parts that look redundant are load-bearing.

## The three faces of a DSH plugin

DSH has no plugin manifest format of its own. Everything is an ordinary ESM package plus
one `dsh` field in its `package.json`, and each of the three things a plugin can be is a
different value of that field.

| Face | `package.json` | What DSH does with it |
|---|---|---|
| **Plugin** | — | Loads the package root as a Cordis plugin: `name`, `inject`, `Config`, `apply`. |
| **Bundle** | `dsh.bundle.patch` | Adds the package to `dsh.profile.bundles` and composes its patch file over the profile tree. |
| **Client (browser)** | `dsh.client` | Scans the loader tree, composes `window.__DSH_BOOT__`, serves `exports["./client"]` at `/plugins/<id>/client.js`, and loads it as a browser plugin. |

This repo uses all three, spread over two packages:

```
@ai-novelist/novelist-bundle  → bundle      (packages/novelist-bundle)
@ai-novelist/novelist-skill   → plugin + client (packages/novelist-skill)
```

### Naming

Three different strings are in play, and conflating them is the easiest mistake to make
here. The plugin's *name* is `ai-novelist` — that is the Cordis plugin name and the
loader row id. The plugin's *package* is `@ai-novelist/novelist-skill`. The *bundle* package
— the one an install command names — is `@ai-novelist/novelist-bundle`.

```sh
dsh plugin --profile web add -w "$(pwd)/packages/novelist-bundle"
#                               └── directory of the BUNDLE package
```

`dsh plugin` forwards everything after `add` verbatim to pnpm inside the profile, so that
argument must be a spec pnpm resolves: a package name or a path to one. It is not the
plugin's name and cannot be shortened to one. `-w` (`--workspace-root`) is required because
the profile directory is itself a pnpm workspace root — it carries a `pnpm-workspace.yaml`
next to its `package.json`, and pnpm refuses to add a dependency to a workspace root without
it. The plugin itself is pulled in as the bundle's dependency and loaded under the row id
`ai-novelist`.

### Why the bundle is a separate package

`dsh plugin --profile <name> add -w <spec>` runs pnpm inside the profile and then
*reconciles* `dsh.profile.bundles`: any installed dependency that resolves to a
`dsh.bundle`-declaring package joins the layer stack (a bundle-less dependency is
installed as a plain library and warns). The layer stack is what composes the tree.

A bundle's patch file works by **inserting loader rows**, and a row has a `name` — a module
specifier. So the bundle must name the plugin package in its patch, which means the plugin
package cannot itself be the bundle: a package cannot depend on itself, and the profile
would not find a row pointing at a package that is not installed.

```
profile package.json  dsh.profile.bundles: [… , '@ai-novelist/novelist-bundle']
        │
        ▼  compose cordis.patch.yml
   - insert:
       - id: ai-novelist
         name: '@ai-novelist/novelist-skill'   ← resolved from the profile's node_modules
        │
        ▼  Loader mounts the row
   @ai-novelist/novelist-skill  →  apply(ctx, config)
```

The bundle package therefore contains almost nothing: a manifest, a patch document, and a
comment explaining what the patch is allowed to do. It deliberately only ever `insert`s —
it never overrides an existing row id, so installing it cannot change how the layers below
it behave.

## Layering inside the plugin

Inside `novelist-skill`, the three layers exist so that the interesting rules can be tested
without booting a harness, and so that the file-access rules exist in exactly one place.

```
src/core/          pure domain — no I/O, no clock, no Cordis
  types.ts           the persisted vocabulary (NovelState, NovelMetadata, StorageIndex, Chapter, …)
  paths.ts           the file tree of plan-markdown-storage.md §2 as path arithmetic and sanitizing
  sop.ts             the SOP as data: the tool surface, its model-facing text, and the six phases
  markdown.ts        the restricted dialect: frontmatter, sections, tables, hashing
  content.ts         the §4 ownership table: state ⇄ Markdown files, per kind
  novel.ts           every state transition as a pure function, the metadata codec, derived views
  plan.ts            what the plan still owes: pitch/world/cast(tiered)/contract gaps and the length targets
  spine.ts           what a planning layer owes the story, checked before it owes a word count
  metrics.ts         baselines → thresholds → verdicts → iteration rules → the evaluation hint
  write.ts           the delivery report: did the prose pay for the plan? (plus the 去 AI 化 statistics)
  review.ts          the model-backed rubrics, their request framing, and the tolerant reply parser
  repo.ts            retrospective, assets, and the structural template
  workspace.ts       novel | fresh | plain, from a directory listing
src/host/          the deployment surface
  store.ts           one project's ctx.fs access: containment, version guard, write queue
  resolver.ts        which novel is this session in; the ctx.novelState service
  views.ts           one workspace's view: classification, adoption, and the numbers behind it
  prompt.ts          the runtime-context section and the cache it reads
  llm.ts             the one seam that calls a model: route resolution, one streamed call
  tools.ts           the nine model-facing tools (thin adapters over core)
src/client/        the browser surface
  index.tsx          the right-Sidebar tab type + its body
  kanban.tsx         the conversation view beside Chat and Trajectory
  board.ts           the board a NovelState projects onto (process documents + chapters), as pure data
  project.ts         the one project reader both surfaces share
  remote.ts          the Remote face captured at activation, and its release
src/index.ts       the Cordis plugin: Config, resolver construction, tool registration
```

### `core` — the domain

Every mutation is `(state, patch, clock) => state`. Nothing here opens a file, reads the
wall clock (a `Clock` function is injected), or knows that Cordis exists. That is what lets
the composition rules — id derivation, chapter numbering, note appending, numbering-gap
detection, manuscript ordering — be specified with plain assertions, and it is what lets the
SOP's own rules (the contract check, the metric thresholds, the iteration rules, the template
skeleton) be tested without a harness. The domain is split by *SOP concern* rather than by
record type — `plan.ts` answers "what does the plan still owe", `metrics.ts` turns readings
into verdicts and actions, `write.ts` compares a draft with its plan, `repo.ts` assembles the
closing material — so each rule file has one question to answer.

Two rules worth knowing:

- **Patches never destroy unstated fields.** `upsertChapter(state, { id, body })` keeps the
  existing title, contract fields, waivers, and status. A revision that only sends prose
  cannot silently drop the plan it was written against.
- **Derived data is never stored.** Word counts, progress, stock, open promises, and the
  project's stage are recomputed on every read, so a hand-edited file cannot carry a stale
  value, and there is no second source of truth to drift.

`countWords` counts CJK per ideograph and Latin per whitespace-separated token, which is
what a web-novel author means by 字数.

### `host/store.ts` — the split storage, its order, and its failure report

`NovelStore` is the single writer of one project. It is not a Cordis service — the resolver
is (`ctx.novelState`), because one process serves many workspaces — but it is still the only
place that decides where a project lives and how a write may land.

**Two kinds of state, two kinds of guarantee.** `.novel/novel.json` holds metadata, the
evidence chain the threshold rules compute on, the foreshadowing ledger, and the
`StorageIndex`; the novel's content — outline, cast, world, volumes, chapter plan, and every
chapter's prose and contract — lives in Markdown files the author can open. `core/*` sees the
same `NovelState` either way, because `core/content.ts` decomposes a state into files and
composes a state back out of them. `core/paths.ts` owns the file tree, so neither side has to
import the other to spell a filename.

- **Containment.** Every path is derived from the workspace root, never supplied by the
  model, and `contain()` decides containment with path arithmetic rather than a string
  prefix — a prefix test would accept a sibling directory whose name merely starts with the
  root's. Derived output (`novel_repo operation="export"` and `operation="template"`) goes
  through the same `contain()`.
- **The metadata document is atomic; the content files are not.** `novel.json` still moves
  in a single `replaceIfVersion` under the version token read. Content is written **first**
  and metadata **last**, so for the length of one write the index may point at older content
  but never at a file that does not exist.
- **A failed write names the files.** `NovelWriteError` carries `filesWritten` and
  `filesNotWritten`, so a caller that lost the disk halfway can say exactly what landed
  instead of reporting a clean failure over invisible half-state. A pure metadata conflict,
  with nothing committed, stays a plain `NovelConflictError`.
- **The file wins.** Every read adopts whatever the files now say and refreshes the index;
  a chapter file dropped in by hand is *claimed* by its frontmatter `id`, a volume file by the
  number in its name, and a file that carries neither is reported as an orphan and left where
  it is. The one refusal is syntax: a file that cannot be parsed raises a `NovelStoreError`
  naming the file and the parser's complaint, and nothing overwrites it.
- **One file per unit, not one file per kind.** A volume's outline and its chapter table are
  each their own file (`分卷大纲/第1卷.md`, `章节大纲/第1卷.md`, named by number alone so a
  retitle cannot move them), because a volume gets rewritten while the volumes before it are
  being serialized, and because a chapter table grows one row per chapter — 1000 rows for a
  1000-chapter book, all of it rewritten by any plan change. Chapters are two files each.
  `StorageIndex.volumes` and `StorageIndex.chapterPlans` record which file each unit actually
  lives in; the two collection files older builds wrote (`分卷大纲.md`, and a `章节大纲.md` that
  carried the tables) are split by the store's migration.
- **Writes are a structural diff.** The store renders the state it read and the state it is
  about to write and writes only the files whose bytes differ, so a one-field change to a
  1000-chapter book touches one file rather than two thousand. Deletions come last, which is
  what makes a chapter rename a rename: the new paths land before the old ones go.
- **Writes serialize** behind one promise chain, and the read→mutate→write window stays
  closed for the whole mutation (a mutation may be async). Concurrent tool calls therefore
  queue instead of losing one another's work.
- **Parsed files are cached by content hash.** The cache is keyed by `sha256` of the file's
  text, so a changed file is reparsed and an unchanged one is not; losing the cache costs
  time and nothing else, because it is never a source of truth.

Two `dsh-fs` details are load-bearing. Guard rejections are detected by `FsErrorCode`
(`FS_STALE_VERSION`, `FS_NOT_OBSERVED`) rather than by class identity, because the error
crosses the service boundary. And the service deliberately exposes no delete or rename
primitive, so deleting an orphaned content file asks the backend for the target's
`processPath` and unlinks it — the same escape hatch `host/resolver.ts` uses for `mkdir`,
with containment already decided by `contain()`.

### `core/markdown.ts` and `core/content.ts` — the codec

The dialect is deliberately four constructs and nothing else: YAML frontmatter, `##`
sections, fenced ```yaml blocks, and pipe tables. `markdown.ts` parses and serializes them
with no dependency, because the promise the store makes — *a broken file is named, never
silently replaced* — is easier to keep when the parser's exact limits are visible in one
file. `content.ts` maps those constructs onto the domain: the ownership table in
[`plan-markdown-storage.md`](plan-markdown-storage.md) §4, one datum in one home. `wordCount`
is the deliberate exception to "the file wins": it is derived, so it is recomputed on every
read and back-filled on every write.

### `host/tools.ts` — the model's vocabulary

**Nine** tools — eight registered unconditionally plus `novel_review`, mounted only where a
model route exists — one per SOP capability, so the model's vocabulary matches the workflow
rather than the storage layout. They are deliberately thin: each parses arguments, calls a
`core` function through the store, and renders a result the model can act on.

Their descriptions are not written here. Every tool's model-facing text, its phase, its
selector parameter and its operation list come from [`core/sop.ts`](../packages/novelist-skill/src/core/sop.ts),
which is also what `scripts/pack.mjs` renders the shipped `SKILL.md`, `INSTALL.md` and
`references/tools.md` from. One text describes the surface, so the documentation cannot
describe a tool the plugin does not register — `test/sop-spec.test.ts` holds the two together.

**Eight compute; one asks a model.** That split is the load-bearing decision in this file.
`novel_assess` comparing a reading against a calibrated median must give the same verdict
every time, or the SOP's evidence chain (C5, C8) collapses; `novel_review` judging whether a
chapter reads as machine-written cannot be computed at all, and the SOP assigns it to
judgement (§1.2). Mixing the two would break both, so the model never touches the ledgers
(`iterations`, `evaluations`) that thresholds act on: a review is recorded as a review,
with the provider, the model and the rubric version that produced it.

**One body delegates.** The SOP's competitor study is twenty to fifty *independent* books —
the one step whose cost is pure latency — so `novel_review operation="competitor"` also takes
`targets` and dismantles the batch with one child agent per book (`runReviewFanout`, one of
the two capabilities `host/llm.ts` contains). It degrades rather than fails: no `subagents`
service, a single target, or no agent on the execution runs the same requests sequentially
through `runReview`, and a child that dies costs its own book rather than the batch. A
partial result is still a result, which is why the fan-out merges survivors instead of
retrying the set.

### `host/reminder.ts` — the durable half of an on-demand step

The data evaluation gates nothing, and the SOP names its only failure mode: *"没人再问"* —
nobody asks again. A line in the runtime context reaches an author who is already in the
session; `ctx.schedule` reaches them next week. `syncEvaluationReminder` keeps at most one
durable task in step with the project — armed while the book is serializing, refreshed when
the appointment moves, withdrawn at completion — and reports every failure as an outcome
instead of throwing, because a nudge the host could not persist must never fail a chapter
write. What is *not* here is the decision: `core`'s `evaluationReminder` says whether a
reminder is warranted, and this module only acts on it.

| Tool | SOP phase | Owns |
|---|---|---|
| `novel_init` | 一 策划 | The project, its commercial frame, the calibration medians, and the writing parameters — including the **length plan** (`targetWords` / `chapterWords` / `volumes`), which is asked of the user, derived where the answers imply it, and cross-checked |
| `novel_plan` | 一/二/三/四 | `competitor` · `pitch` · `world` · `outline` · `volume` · `chapter` · `beat` · `opening` · `naming` · `launch` (the phase-three go/no-go) |
| `novel_bible` | 一/四/六 | `character` · `world` · `link` · `review` |
| `novel_write` | 五 连载 | `write` · `read` · `check` — prose, the contract-delivery report, and the automatic 去 AI 化 statistics |
| `novel_assess` | 五 按需 | `record` · `iterate` · `evaluate` · `outcome` · `history` · `rules` — the on-demand investment evaluation; it owns no phase and gates nothing |
| `novel_status` | 全流程 | `dashboard` (default) · `bible` · `plan` · `chapter` |
| `novel_repo` | 六 复盘 | `export` · `retro` · `asset` · `lesson` · `template` |
| `novel_review` | 五/六 判断 | **model-backed** — `ai-flavor` · `opening` · `competitor` · `retro` |

Design rules the tools follow:

- **One envelope for every call.** `ok`, `operation`, `detail`, the derived `stage`, the next
  phase's `blockers`, optional soft-gate `warnings`, an optional `evaluationDue` hint, and a
  `progress` line. Whichever tool the
  model happens to call, it learns where the project stands and what the SOP expects next.
  `renderEnvelope` is the only renderer, so this cannot drift tool by tool.
- **Results state where the novel now stands.** Every write returns the chapter index and
  totals, so the model does not need a follow-up read to know what changed.
- **Errors teach.** A missing project says `call novel_init first`; an unknown chapter lists
  the known ids. The tools registry turns a thrown error into an ordinary error result, so a
  recoverable mistake does not end the turn.
- **Chapter references are forgiving.** `resolveChapter` accepts an id, a slugified id, or a
  title, because that is how a user talks about chapters.
- **Word counts are never trusted from the caller.** They are recomputed from the body.
- **Refusal is reserved for data integrity.** Two records are rejected because they cannot be
  valid without something the SOP requires and the caller omitted: a `novel_plan`
  `operation="launch"` verdict that is not `go` without `fallback` and `abandonIf`, and a
  `novel_assess operation="evaluate"` without an appointment for the next evaluation (or with
  no comparable median at all). Both are the SOP's point that a decision has to say where it
  goes back to; everything else the SOP would rather you did differently comes back as a
  warning on a successful call.

The tool descriptions are part of the product: they are the only place the model learns the
workflow, so they carry the ordering, the "plan is not prose" distinction, and the
"send the complete body" rule.

### `host/llm.ts` — the one seam that calls a model

Everything above this line is arithmetic over a JSON document. `novel_review` is the
deliberate exception, and this module is where the exception is contained: nothing else in
the plugin touches `ctx.llm`, so the judgement layer has exactly one dependency to fake in a
spec.

- **Routing is a resolution, not a guess.** A per-call `provider`/`model` wins, then the
  configured `reviewProvider`/`reviewModel`, then `agentDefaultModel.currentSelection()` —
  the model the session is already using, so switching models in the GUI switches the
  reviewer. A per-call override must name **both** halves; one half alone used to be dropped
  in silence, which left the author reviewing on a different model than the one they asked
  for. With none of the three, the tool is **not registered at all** (the plugin injects the
  capability inside `ctx.inject(['llm'], …)`); a profile with no model keeps eight working
  tools rather than a ninth that can only fail. That injection is used as a *trigger*, not
  as the mounting context: a service context exposes the injected dependency and nothing
  else, so registration happens against the plugin's own ctx, which carries `tools`.
- **The output budget and the reasoning effort are the caller's call, not the adapter's.**
  A route that declares reasoning materializes its own default effort when the caller omits
  one — `deepseek-official` defaults to `high` — and thinking tokens are billed against the
  same `maxTokens` ceiling as the answer. That combination is a trap for a one-shot judging
  call: with the old hardcoded `4096` and no effort, a reviewer could spend the whole budget
  thinking and emit *no text block at all*, which the seam then reported as "returned no
  text". Reviews therefore send an explicit effort (`reviewReasoningEffort`, `off` by
  default) and an explicit budget (`reviewMaxTokens`). The effort is sent only after asking
  the adapter what the exact route offers, because an effort a route does not declare is
  rejected outright (`UNSUPPORTED_REASONING_EFFORT`); a route that declares no reasoning, or
  whose capabilities cannot be read, is sent none.
- **One streamed call per request.** `ctx.llm.stream` is the only call shape the service
  offers, so a one-shot is assembled with the harness's own `BlockAssembler` — the same
  interpreter the agent loop uses. A truncated answer (`max-tokens`) is reported as
  truncated rather than read as complete; a `tool-calls` finish is an error, because no
  tools were offered; an `error` finish carries its failure message. An empty reply is
  diagnosed by cause instead of lumped together: a budget exhausted before a word was
  written, a model that answered entirely in its reasoning channel, and a genuinely empty
  stop name different settings. Reasoning blocks are never part of the answer, and the
  number of characters dropped that way is returned and warned about instead of vanishing.
  A call cancelled before it starts is reported as cancelled, not left to the adapter to
  notice an abort that already fired.
- **The judgement is recorded with its provenance.** `ReviewRecord` carries the provider,
  the model and `REVIEW_PROMPT_VERSION`, which is why the rubric lives in `core/review.ts`
  as versioned data rather than as a string inside a tool. A second opinion on the same
  chapter accumulates instead of overwriting the first.
- **A model draft is not a fact.** Findings, dismantles and lessons are returned for
  inspection; `save=true` is what writes a dismantle into `competitors` or a lesson into the
  retrospective, and a rewritten chapter lands in `.novel/reviews/` as a proposal that only
  `novel_write` can put into the book.
- **A reply that ignores the JSON contract is still a reply.** Parsing takes the first `{`
  to the last `}`, tolerates code fences and surrounding prose, drops findings that carry
  nothing actionable, and — when there is no object at all — keeps the model's text as the
  summary, warns, and writes the verbatim answer to the transcript. A contract split across
  *sibling* objects (`{"summary": …}` then `{"findings": …}`, observed on a real opening
  review) is merged, with string-aware brace matching so braces inside quoted prose do not
  move the boundaries; if any sibling fails to decode, the whole reply is treated as
  unparsed rather than half-merged.

### `client/index.tsx` — the browser half

Both browser surfaces read the project through `client/project.ts`, which reads the metadata
document first and then the content files the index names, assembling them with the same
`composeContent` the host uses. No format knowledge is duplicated in the browser: a surface
cannot drift from the files, only lag behind them. The content paths are resolved under
`.novel/` (`METADATA_RELATIVE_PATH`'s directory), which is where the store writes them and
where `novel.json`'s own `index` records them from.

The tab registers through exactly the same two-stage public path the shipped sidebar types
use, with no privileged access:

1. `ctx.sidebarRightTabs.register({ id, kind, title, guide })` — the *type*. It is a page
   type (no resource `patterns`), so it opens by kind from the guide page rather than by
   opening a file address. The `guide` entry is what puts a capsule in the sidebar's
   start page.
2. `ctx.slots.register({ name: 'sidebar.right.pane.tab', key: id, inject }, Body)` — the
   *body*, filed under the same `id` the type registered with. The body reads its tab
   through the framework-bound `useTabInfo` hook, so the same component renders correctly
   when the tab is docked, floated, split into a second pane, or reopened.

Both calls are owned by one `ctx.effect`, so unloading the plugin removes the type and its
body together — a type without a body would render the sidebar's "nothing can view this"
notice.

Neither surface is handed the Remote by the framework: slot props carry the session
identity, store bindings and hooks, and no business service. `apply` therefore captures
`ctx.remote` once, into `client/remote.ts`, and both the panel and the Kanban view read it
back through `clientRemote()`. The single capture is the point. A surface that keeps a
reference of its own does not fail to compile when nothing fills it; it fails at read time
with "the composer client half has no Remote face" — for that surface while the other one
works, which is a bug the compiler cannot catch and the browser reports as a project error.
`releaseRemote()` runs in the same effect's disposer, so a disposed plugin leaves no face
behind.

### `client/kanban.tsx` — the third conversation view

Chat and Trajectory are what the shell ships for every session. The composer adds a third —
**Kanban** — and adds it *only where a novel project is*: a workspace whose
`.novel/novel.json` identifies one gets the tab, and every other workspace keeps exactly the
two tabs it always had.

A conversation view is a `conversation.view` **list** entry, so it registers the way the
shipped two do: one `ctx.slots.inject('conversation.view', () => ctx.slots.register(…))`
call carrying an `id`, an `order` (20 — after Chat's 0 and Trajectory's 10) and a `label`
thunk over a registered locale namespace. `ctx.slots.inject` is what covers boot order: the
Conversation package may declare the slot after this plugin applies, and the callback runs
when it does.

Visibility is the one place the framework forces a choice, and the choice is documented
because it looks like a compromise:

* An entry must be **on the ledger** for its component to run at all, so a registry-level
  decision would have to know the workspace before the view could ask for it.
* A view that **renders nothing** contributes no tab chip — the shell omits it.

So the entry is registered unconditionally and the *component* answers the question: it
reads the session's workspace root from the standard `useSessions` hook (not from an
injected value — the shell already resolved it, and re-deriving it is how two answers
disagree), reads `.novel/novel.json`, and returns `null` in exactly one case, `status:
'none'`. Absent document, no tab. Every other state renders — including the error state,
because a document that is there but broken is precisely what the user needs to be told, and
hiding the tab would hide the diagnosis with it.

`client/board.ts` holds the projection itself: `boardOf(state)` returns the process
documents, the four `CHAPTER_STATUSES` columns, each card's word count, beats, hook state and
unanswered contract fields, plus the stage `assessStage` derives and the standing
`progressOf` derives. It is pure data with no React in sight, which is what makes the board
specifiable in `test/board.test.ts` without a browser.

The projection has two halves because a novel project does. The chapter columns answer "how
far along is the prose", which is silence for a project that is still settling its settings —
the common state of a new book. `boardOf.documents` answers the other question, one card per
planning artefact in the order the SOP produces them:

| id | artefact | finished when |
|---|---|---|
| `pitch` | 立意与核心设定 | the five pitch fields are written **and** the premise layer is signed off |
| `competitors` | 竞品拆解 | ≥ 20 titles dismantled |
| `naming` | 候选书名 | ≥ 3 candidate sets |
| `world` | 世界观设定 | every entry has a detail, a cost and a limit, and the layer is signed off |
| `cast` | 人物设定 | no `castDebt` remains (the people who owe a spine — a walk-on register is reported by `castGaps` but never counted), and the layer is signed off |
| `outline` | 全书大纲 | the narrative spine reads whole, and the layer is signed off |
| `style` | 写作风格 | all seven elements are written |
| `volumes` | 分卷大纲 | every volume's spine is complete, and the layer is signed off |
| `beats` | 爽点节拍表 | at least one beat is placed |
| `de-ai` | 去 AI 化诊断 | one `ai-flavor` review is on the ledger (and it names the golden chapters nobody has diagnosed) |
| `opening` | 开篇工程清单 | every item is confirmed |
| `launch` | 上线决策 | the latest decision is `go` |
| `serial` | 连载数据 | a reading and an evaluation exist |
| `retro` | 完本复盘 | the retrospective holds lessons |

Three properties of that table are the point:

* **Completion and sign-off are separate questions.** `cardState` takes both, and
  `needsSignOff` is what distinguishes the artefacts the SOP runs a checkpoint over (立意、
  世界观、人物设定、全书大纲、分卷大纲) from the ones it never checks back on (竞品、候选物料、
  写作风格、节拍表、开篇清单). Without it a complete competitor study would read as unfinished
  because no author "confirmed" it; with it, a full outline nobody has been shown reads as
  `draft` — which is the state the checkpoints exist to empty.
* **The completeness checks are the core's own** (`missingPitchFields`, `worldGaps`,
  `castDebt`, `outlineSpineGaps`, `outlineStyleGaps`, `volumeSpineGaps`, plus
  `COMPETITOR_TARGET` and `NAMING_MIN_CANDIDATES`, which the tools share), so the board and
  `novel_status` cannot report different findings and a threshold lives in one place. `gaps`
  carries the domain's own labels, which is what a card's tooltip shows.
* **Order is read from `confirmationStanding`, never re-derived.** 「按顺序」 is a property of
  that function; a second copy of the rule in the board is how a board starts disagreeing
  with `novel_confirm`.

A card is labelled and described by the view's dictionary (`doc.<id>.label` / `.detail` /
`.next` in `client/kanban.tsx`), not by the projection: copy is not project state. The key
type is a template literal over the document ids, so a new document in `board.ts` brings its
three keys with it as a type error rather than as a blank card. The cards render in one
scrollable row between the overview and the chapter columns, and each carries the gate it
sits behind (`卡住正文` for the three the prose gate enforces, `go 之后才做` for the work the
launch decision authorises) — an open document should say why it matters, not only that it is
open.

The 去 AI 化 statistics have the same shape, and grew for the same reason the gate did. The
mechanical pass in `write.ts` reports what a counter can find — long paragraphs, average length,
dialogue density, repeated sentence openings — and now also the **对举句 count** and the book's own
**负面清单** hits, because the pattern that shipped a whole book of AI-sounding prose
(「不是 A，是 B」 several times a chapter) is invisible to all four of the original checks: it is
neither a long paragraph nor a repeated opening, and the sentence heads differ. `contrastFrames`
walks the four frames most-specific-first and lets a match consume its span, so one device reads
as one device. The judge then gets two things it did not used to: `styleBrief` — the book's seven
style elements and its 负面清单, unwritten ones included — so the review is a comparison against a
written standard instead of a taste, and the counted symptoms, so it spends its attention on what
a counter cannot see. Rubric version 1 → 2 records that the instruction moved.


## Workspace awareness

A composer that sits inert until someone calls `novel_init` is a toolbox, not a product:
the first session in a novel directory has to discover that it is one. So the plugin
decides **what the workspace is**, and publishes that decision to both the model and the
browser.

### The project root belongs to the session, not the process

The first revision resolved everything from `process.cwd()` at boot. That is wrong in a
harness where a *workspace* is a directory the host registers and a *session* carries its
own `cwd` (`SessionHeader.cwd`): one long-running `dsh web` hosts sessions for many
directories, so a workspace created in the UI had no effect at all — the plugin kept
reading whatever directory the server was launched from. The harness says so itself:
`dsh-api-workspace-files` resolves a file's root as
`header.cwd ?? sandboxPolicy.workspaceRoot` (`lib/index.js:385`), not from the process.

`host/resolver.ts` now owns that mapping:

```
tool call → exec.agent.session.header.cwd    the session's own workspace
          → configured workspaceRoot          when the session records none
          → process.cwd()                     last resort
          → Map<root, NovelStore>             one store per directory, cached
```

Two consequences shaped the code:

- **`NovelStore` is not a service.** It briefly extended `Service`, which registers
  `ctx.novelState` on construction — and a Cordis service name may be registered once, so
  a second workspace threw `service "novelState" has been registered`. The store is now a
  plain class parameterized by root, and the *resolver* is the service
  (`ctx.novelState`), published synchronously through `ctx.reflect.provide` so a caller
  inspecting the composition right after `apply` sees it.
- **Tools resolve per execution, not per mount.** Every tool body asks the resolver for
  the store of the calling session (`exec.agent?.session`), so two sessions in two novel
  directories never share state.
- **The prompt resolves per assembly, for the same reason.** `dsh-agent` sets
  `agent` on every prompt assembly, so the runtime-context provider reads *that* agent's
  `session.header.cwd` and describes the directory the session is actually in. It briefly
  did not: the section was built once at boot from the deployment root, so a server started
  in a software repository told every session — including one opened in an empty novel
  folder — "this workspace is a software project, not a novel workspace. Do not create a
  novel project here", and the model obeyed. A section that describes the wrong directory
  is worse than no section at all.

### Classification and adoption

Classification is per **workspace root**, and there are two moments it starts:

```
mount    → views.viewFor(deploymentRoot).classify()      the directory the operator mounted on
session  → views.viewForSession(session).classify()      every session the harness creates
render   → views.viewForSession(agent.session)           whatever the two above missed

classify → resolver.storeFor(root).probeWorkspace()      listDir(root) + stat(.novel/novel.json)
         → store.read() migration check                  v2/v1 documents are upgraded here
         → classifyWorkspace(entries, …)                 pure: novel | fresh | plain, with evidence
         → policy.normalize(root, …)                     workspaceMode, for the deployment root only
         → policy.mayAdopt(verdict) → adopt(…)           see "How eager the composer is" below
         → snapshotCache.refresh()                       primes the numbers the prompt renders
```

`host/views.ts` owns the registry: one `WorkspaceView` per normalized root, holding the
verdict, whether this classification is the one that wrote the document, and the snapshot
cache. Sessions in one directory share a view; the classification runs once, and concurrent
callers await the same promise. `refresh()` — what every tool calls after a write — re-probes
the directory as well as the numbers, because a write can change what the directory *is*:
`novel_init` in an empty workspace is precisely what turns `fresh` into `novel`, and a section
that kept recommending initialization while quoting the title it had just recorded would be
contradicting itself. A refresh never adopts; that decision belongs to `classify`.

Four rules make this safe:

- **Conservative classification.** `core/workspace.ts` is pure and takes a directory
  listing, so the whole policy is testable without a filesystem. A repo root
  (`package.json`, `.git`, …) is `plain` even when it holds Markdown, whatever else is
  there; only chapter-shaped filenames (`001-*.md`, `第3章.md`) count as chapters; a
  single soft signal yields `fresh` (an invitation) rather than a claim.
- **Nothing is written unasked.** An empty directory is `fresh` and is left alone;
  adoption there requires the deployment to opt in (`adoptableVerdict`). A directory that
  already looks like a novel is adopted idempotently through the `createIfAbsent` write
  intent, so a second boot — or a second session against the same directory — leaves the
  document byte-identical. `novel_init` is idempotent for the same reason: a recorded
  premise is never overwritten — the call keeps it and warns that
  `novel_plan operation="pitch"` is how a premise is revised.
- **The deployment's mode is about the deployment's directory.** `workspaceMode: novel`
  forces *the mounted root* to be treated as a project (that is what pinning a profile row
  to one directory means); a session that opens elsewhere is judged on its own evidence.
  `workspaceMode: off` is the one global veto: it suppresses adoption for every root, and
  the section says `plain` for the deployment's own.
- **Synchronous prompt, asynchronous data.** `SystemPrompt` resolves context text
  synchronously (`entry.text(context)`, no await), so the provider reads the view's cache
  rather than the filesystem — a step never blocks, and a failed refresh keeps the last good
  numbers and records the error rather than blanking the section. The classification a
  session triggers therefore **races the first assembly**, which is why `views.viewFor`
  starts one on demand and why an unclassified workspace renders nothing (the same silence
  the boot path always had). In practice the session hook wins: creation is announced before
  the first turn, and the probe is a `listDir` plus a `stat`. The cost of losing the race is
  one step without orientation — never a step that describes the wrong directory. The provider
  itself cannot re-probe (it is synchronous and runs per step), so a workspace edited by hand
  *while a session is open* keeps the verdict it had until some tool writes through the
  composer; `novel_status` re-probes on every call and stays the authoritative answer for what
  the calling session is editing.

### How eager the composer is

The question "when may the composer write?" has more than one defensible answer, so it is
a deployment setting rather than a constant. `workspaceMode` now has four values, and the
two that matter are the first two:

| Mode | Writes the scaffold when… | Meant for |
|---|---|---|
| `signal` (default) | the directory is a **marked** project (`.novel/`, or a draft the classifier names), **or** it carries unmistakable novel material: a creative note such as `创意整理.md` / `人物设定.md` / `story-outline.md`, two novel-shaped root files, or a few chapters | the ordinary case — someone made a folder for a book and wrote something down in it |
| `auto` | only a **marked** project, a draft, or an empty directory the deployment opted into | deployments that must never create a file on their own |
| `novel` | always, for the mounted root | a profile row pinned to one project directory |
| `off` | never | a shared or managed machine |

The distinction that makes `signal` safe is between two halves of `novel_init`, which the
earlier policy treated as one thing:

- **The scaffold** is `.novel/novel.json` with the folder's name as the title and every
  story field empty. It is idempotent (`createIfAbsent`), it destroys nothing, it records
  no decision the author did not make — and it is what makes the tools, the prompt section
  and the Kanban board exist at all.
- **The content** — premise, baselines, pitch, chapter contracts — is what the book *is*,
  and no heuristic should invent any of it.

`signal` automates only the first. Everything in `novelSignalCount` is about deciding when a
directory is a book rather than a repository, and the two guards that carry the weight are
that **project markers win outright** (a repo with `package.json` is `plain` however much
Markdown it holds) and that **a creative filename is worth two signals while a generic one
is worth none**, so a lone `README.md` never claims a directory. Each file is weighed by
the most specific rule that matches it and counted once: `outline.md` is a novel-shaped
root file, not also a note, which is the kind of double count that would let one file
claim a folder by itself.

Undoing an unwanted claim is one command, and the plugin is honest about the possibility
in its README:

```sh
rm -rf <the-directory>/.novel      # the next classification sees `plain` again
```

The other half of the same complaint — a model that answers "write me a novel" with prose
instead of a project — is not something a host plugin can fix, because the user's message
never passes through it. What it can do is say what to do: `CONDUCT.plain` now names the
phrasings users actually type (`write a novel here`, `给我 300 字大纲`, `建立小说项目`) and
tells the model to call `novel_init` first and record what it was told. Mode `signal` and
that instruction are complementary: the scaffold appears whether or not the model obeys,
and the instruction is what fills it.

### Finding and switching novels

There is no project-switching tool, because the project follows the session: the tools
resolve their store from `session.header.cwd` on every call, so opening another workspace in
the UI is the whole of "switch project". What remains in `host/resolver.ts` is the seam a
switching tool would need — `listProjects()` enumerates `ctx.workspaceRegistry.list()` when
`@deepseek-ai/dsh-workspace` is mounted (resolved structurally, so a composition without it
reports no projects and everything else keeps working), `registerWorkspace()` creates and
registers a directory, and `readProject()` reads one root — and the current tool set leaves
it unused. A session that records no `cwd` falls back to the configured `workspaceRoot`, and
only then to the process directory.

### The browser half reads through the host, not the disk

The panel shows the real project, which means it needs the file. It asks the composed
Remote (`ctx.remote.workspaceFiles.read(sessionId, path, range, signal)`) rather than
fetching bytes itself: the host resolves the session's workspace root on the wire, so
the panel never guesses a path, and the read is subject to the same filesystem policy as
everything else. That path is why the client's `inject` carries `'remote'` and
`'remote.workspaceFiles'`, and why this package declares `@deepseek-ai/dsh-api-remotes`
as a client dependency.

A failed read is reported, not swallowed: only `FS_NOT_FOUND`/`FS_NOT_TEXT` render the
"no project here yet" copy, while everything else shows the error and a retry — a
transport fault must not look like an invitation to start over.

## The SOP pipeline

The domain is not a notebook. A notebook records whatever the author says; a pipeline has
phases, checkpoints between them, and evidence that a checkpoint was passed. [`docs/sop.md`](sop.md)
is the workflow this plugin implements, and the shape of the data follows from one
observation: the SOP's failure modes are *forgotten* things — a memorable point nobody wrote
down, a threshold nobody can compare against, a promise nobody closes. The only way a tool
prevents forgetting is to make each of them a field.

That is why the document is at version 4. It holds, as data: the commercial frame and the
calibration medians (`platform`, `baselines`), the commitments made to readers (`links`), the
readings, the evaluation and iteration ledger (`readings`, `evaluations`, `iterations`), the
launch decisions behind phase three (`launchDecisions`), the closing material (`retro`), the
opening checklist whose `done` flags gate phase two, and the index that says where the content
files are. The per-chapter contract and `targetWords`/`waived`/
`delivered` moved into the chapter files, because they are things an author reads and revises.

Version 2 kept all of that in one JSON document, and version 1 held only a premise, a cast and
chapters; everything else lived in prose and was forgotten. What the pipeline deliberately
does *not* store is the phase itself: `assessStage(state)` derives the stage and the next
phase's blockers on every read, so a stored stage cannot drift away from the work it claims to
describe.

### The migration policy

`parseMetadata` accepts version 1 through version 5, and refuses anything else with a
`NovelStoreError` naming the versions it supports. Because content migration needs a
filesystem, the *store* performs it, not the pure codec: `migrateV2` extracts the content and
returns both halves, and `NovelStore.migrateDocument` writes the original document to
`.novel/novel.v2.backup.json` (with `createIfAbsent`, so an existing backup is never
overwritten), generates every Markdown file, then writes back current-version metadata. A
version-1 document takes the same path after `migrateV1`:

Version 4 split the volume outlines but still kept the whole chapter plan in one file, so it
takes the same route once more: split the chapter and rhythm tables per volume by each row's `卷`
column, leave the opening checklist and an index of the resulting files in the whole-book file, and
write the per-volume files before rewriting it. Version 3 takes both splits in one pass, because its
two collection paths are keyed independently.

Version 3 is a different kind of upgrade, and takes a different route. Its content already
lives in files; only the volume outlines still share one collection file. `migrateDocument`
reads that collection, writes one file per volume, and deletes the collection **last**, so an
interrupted run leaves the only copy of the content in place and the next read simply repeats
the split. No document backup is taken, because nothing is removed from the document — the
volume content is re-rendered into the files that replace the collection before the collection
goes away. A version-3 document with no collection file is upgraded in shape only, and invents
no volumes. The version-1 path is:

- the v1 chapter `synopsis` becomes `plotTask` — a draft must never be emptied by an upgrade;
- premise, cast, world entries and chapters survive as they are, and `readChapter` fills the
  SOP fields the old record did not have;
- `meta.genres` becomes the platform's genres, `meta.language` / `meta.pov` seed the writing
  plan;
- the records v1 never modelled (pitch, naming, baselines, competitors, the outline body,
  readings, evaluations, iterations, launch decisions) start empty. A version-3 document that
  still carries the old `verifications` key is read into `evaluations`, so nothing recorded
  before the 3.2 revision is lost.

**The backup is kept forever.** A human's draft does not disappear because the plugin changed
its storage layout. Every migration is idempotent too: a second read changes nothing, and the
migration report is returned once, by the read that triggered it.

The project therefore lands in whatever stage its data supports — a migrated draft usually
reports `planning`, with `blockers` naming exactly what the SOP now wants next. Each `read*`
helper coerces one field and falls back to a default, so an unknown or malformed key is
dropped rather than trusted.

### The soft gate

The SOP has checkpoints ("竞品 ≥20 本", "说不清 → 回第 2/3 步"), and the obvious
implementation — refusing a call that has not met them — turns the plugin into an obstacle:
an author who knows what they are doing, or who is midway through repairing the plan, cannot
proceed. So the gate is soft. Every tool writes what it was asked to write, and *then*
reports: `blockers` names what the next phase still needs (`assessStage`), while `warnings`
names everything else the call noticed — a chapter whose contract is half empty, a world rule
with no cost, a promise with no `dueAt`, competitor coverage below twenty, a stale calibration,
a contract field the draft did not deliver.

`novel_plan` computes this by re-reading the project *after* the write and running the gap
checks over the new state (`worldGaps`, `castGaps`, `contractGaps`, `openingPackageGaps`,
`assessStage`), so the report describes where the project now stands rather than what the
call's arguments said. The same shape recurs in every other tool, which is why the envelope
is rendered by one function instead of nine.

The refusals that survive on purpose are data-integrity requirements rather than workflow
opinions. Two come from the SOP's anti-formality rule: a `novel_plan operation="launch"`
verdict that is not `go` without `fallback` and `abandonIf` throws (a failure has to state
where it goes back to — the record cannot be valid without it), and a
`novel_assess operation="evaluate"` refuses a session that names no next appointment, and
refuses to answer at all when every metric in the reading lacks a comparable median. A third
is a plain lookup error: a chapter reference that matches nothing throws with the known ids
listed. "The record would be meaningless" is a different thing from "the SOP would rather you
did this later".

**One refusal is a workflow opinion, and it is the exception that proves the rule.**
`novel_write` refuses prose in three situations, all of them receipts rather than judgements:

1. the author has not signed the **premise** layer off, and the 写作风格 block of the 全书大纲 is
   not written (`proseGate`, `novel_confirm`) — a book whose voice was chosen while writing
   chapter 1 is a book whose voice nobody was asked about;
2. once the golden three chapters have prose, the **voice has not been reviewed** — the author
   has read a rhythm, not a sample;
3. once the golden three chapters have prose, **no 去 AI 化 diagnosis has been recorded at all**
   (`confirmationStanding.deAi`). SOP step 23 said to run `novel_review operation="ai-flavor"`
   and nothing observed whether anyone had; the receipt is the `reviews` ledger entry the tool
   writes, so "nobody ever ran it" now stops the pipeline at chapter 4 instead of surfacing
   forty chapters later.

Every other gate here reports a disagreement and lets the call stand, and that is exactly how a
model once went from a one-line inspiration to four finished chapters without the author being
asked anything. A soft warning is the right shape for "the SOP would rather you had an outline
first"; it is the wrong shape for "you are about to write a book for someone who was never
consulted", and equally wrong for "this book is being written in a voice nobody has diagnosed".
The gate stays narrow — one pre-prose layer, the voice, and one diagnosis receipt, all owned by
the author, all cheap to close — so it can never be the thing that stops an author who is
talking to the tool. The 去 AI 化 gate is a *receipt* check and not a quality check: the tool
cannot tell whether the prose improved, only whether the diagnosis was ever put in front of the
author, and a review that finds nothing is a valid, recorded outcome.

**The settings are settled one layer at a time.** `SETTINGS_LAYERS` fixes the order —
立意 → 世界观 → 人物设定 → 全书大纲 → 分卷大纲 — and `confirmationStanding` derives each
layer's standing from the confirmations that already exist, so `blockedBy` and `ready` are
functions of the ledger rather than a second state to keep in step. That derivation is what
lets the plugin hold two lines at once: `novel_confirm` **refuses** a `discuss` or `confirm`
for a layer whose predecessor is open (the order is the feature), while `novel_plan` only
**warns** when a layer is written out of order, and `novel_write` gates on the premise **and on
one part of the 全书大纲 layer**: the 写作风格 block. The layers after the premise otherwise do not
block chapter 1 — an author may be arguing about the volume outline while the opening is already
drafted — and the stage machine still holds phase one open until all five are closed, because
"the settings are settled" is what phase one claims. The style block is the exception because it
is not an ordering question but a *voice* question: the moment chapter 1 is written the book's
voice exists, and an author shown it afterwards can only accept it or rewrite the chapter. Seven
named elements, checked for presence before prose, and the second checkpoint (`kind="style"`) is
the **review** of what the golden three chapters actually sound like — due after chapter 3 and
before chapter 4.

`settingsConfirmed` (all five layers) and `preProseConfirmed` (the premise) are deliberately
distinct: the stage machine and the board read the first, `proseGate` reads the second. The
`settings` and `premise` kinds are the same checkpoint two ways — `settings` is what the SOP and
every existing document call it — so rounds recorded under either spelling count for both, via
`settingsLayerRounds`, and a project talked through before the layers existed is not asked to
repeat itself.

**Planning layers carry length budgets, not length gates.** A chapter's length was checkable
against a stated target from the start; an outline's was not, so a two-line 全书大纲 and a
twenty-thousand-character one passed the same checks. `OUTLINE_LAYER_RATIOS` budgets each layer
as a fraction of the prose it governs — 1/100, 1/50, 1/5 — and `layerLengthCheck` compares what
was written against it. The ratio is chosen over a word count on purpose: the book's length is
the author's `novel_init` answer, and a hard-coded "10000 字" is wrong for a 30 万字 serial and
a 300 万字 epic alike. An unanswered length question yields **no** target rather than an
invented denominator, the comparison is reported as a `warning` (the SOP's hard gate is the
premise sign-off, not a word count), and a per-call `targetWords` replaces the ratio.

**And a budget is checked last, because it cannot detect a missing story.** The same ratio that
made "大纲太薄" checkable also made a long, category-complete, story-free outline checkable as
*adequate*: length is a proxy for work, not for narrative. `spine.ts` is therefore a separate,
prior check over per-layer **named** elements — eight on the whole-book outline, seven on a
volume, `keyBeat`/`price` on a chapter contract — and `novel_plan`, `novel_status` and
`assessStage` all report in the fixed order story → payoffs → length. The two findings stay
distinguishable on purpose: "this layer does not say what happens" and "this layer is shorter
than its target" need different fixes, and the second must not be able to mask the first.
`spine.ts` sits beside `plan.ts` rather than inside it because the stage machine needs it and
`plan.ts` already depends on `novel.ts`.

### Two axes: the pipeline and the on-demand evaluation

Only one of the two things the plugin tracks is a phase.

**The pipeline.** `assessStage` derives the stage from planned and written work alone —
pitch, competitor coverage, the author's settings sign-off, the outline and its narrative
spine, the opening checklist, the launch decision, the volume and beat tables, chapters with
prose, the voice sign-off, the retrospective. It never consults a reading or
an evaluation. That is what lets a project advance while the platform numbers are unavailable:
the phase-three gate is a declared human `go` (`novel_plan operation="launch"`), not a
computed pass, and the evidence behind it — an editor's read, a handful of readers, an author
group — is judgement, which the SOP files under §1.2's second category. What the tool enforces
is only the anti-formality rule: a verdict that is not `go` must name a fallback target and an
abandon condition.

**The data evaluation.** `novel_assess` is started by the author when they want to know
whether the book is still worth continuing, normally once the platform has numbers that can be
transcribed by hand. Nothing waits for it and nothing gates on it: a project that has never
been measured is a normal project, and `evaluationDue` — the hint in `core/metrics.ts` that
compares chapters written against the previous evaluation's appointment — surfaces as an
optional envelope field, a dashboard line and a prompt line, never as a warning or a blocker.
The bridge between the axes is that both are recorded in the same document: the author makes a
decision in the pipeline, and the evaluation is the evidence they can pull on whenever they
choose to look.

### Metrics become decisions

A number only enters the project because a platform, an editor, a test cohort or a human
reported it: `novel_assess operation="record"` accepts the values a caller supplies, drops
anything that is not a finite number with a warning, and never synthesises a value. A metric
nobody calibrated is reported as incomparable rather than guessed at. From there the chain is
arithmetic:

1. **Baselines.** `novel_init` records same-genre medians over the last 30 days. No median
   means no threshold: `thresholdFor` returns `undefined`, `assessReading` reports the metric
   as 无法比较 with a note pointing at `baselines`, and `calibrationAge` flags a calibration
   older than 30 days rather than trusting it.
2. **Multipliers.** `threshold = median × (baselines.multipliers[metric] ?? DEFAULT_MULTIPLIERS[metric])`,
   so a deployment can move one trigger line without touching the code. A rule's *label*
   quotes the SOP's own arithmetic while the line actually applied is the calibrated
   multiplier; override `multipliers.averageReadPerChapter` to `0.6` if you want the SOP's
   volume rule literally.
3. **Verdicts.** `verdictFromAssessments` fixes the boundary the SOP leaves open: nothing
   failing is `pass`, a failure without a *core* failure (`readThrough3`, `followRead10`,
   `clickRate`, `favoriteRate`) is `partial`, and a failing core metric is `fail`.
4. **Rules.** `iterationRules` turns that into the SOP's table of actions, each with the scope
   it may reach (`chapter` / `volume` / `whole-book`) and a severity for ordering. Two rules
   need history rather than one reading: the volume-acceleration rule needs a failing follow
   metric *and* `decliningStreak` at `SUSTAINED_DECLINE_CHAPTERS` (5), and the cut-loss rule
   needs `INEFFECTIVE_ITERATIONS_FOR_CUT` (2) ineffective iterations *and* a failing core
   metric.
5. **The ledger.** `novel_assess iterate` writes the decision into `iterations` with the
   reading it responds to, and the next `novel_assess operation="evaluate"` back-fills every
   open iteration against the reading it is evaluating; `judgeIteration` compares the two
   readings' shared metrics and marks the iteration effective or ineffective, which is what
   `countIneffectiveIterations` counts in step 4.

That back-fill is the piece the SOP asked for and prose could not supply: "连续 2–3 轮调整无效
→ 切书止损" is only decidable if the earlier rounds were recorded *and* closed. What the tool
still does not do is enforce any of it — the action, the scope and the outcome are recorded,
never policed, because deciding whether a change worked is the author's call and the numbers
are only evidence.

### The promise closing check

A `StoryLink` is a promise with a planting point (`plantedAt`), a due chapter (`dueAt`), a
payoff, a status (`open` / `paid` / `abandoned`) and a volume. Writing one without a `dueAt`
warns, because an undated promise can never be overdue. From there the check is arithmetic:
`progressOf` collects the `open` promises and marks as overdue every one whose `dueAt`
contains a chapter number that already has prose, and that list surfaces in three places —
the `novel_bible review` body, a warning appended to every `novel_bible` call, and the
`novel_status` dashboard (progress line and per-promise detail). This is the SOP's
卷末闭合检查: registering a foreshadowing is a write, but *closing* it is a derived fact the
author is shown without asking.

### Why templates exclude the cast

`novel_repo operation="template"` exports the structural skeleton and nothing else: the acts,
the volume rhythm, the beat pattern expressed as **offsets inside a volume**
(`estimateVolumeLength` gives the median volume length, so the template does not depend on how
long the source book happened to be), the recurring hook *shapes* (`classifyHook` labels with
counts — never the hook text), and the emotional template. No character record, no cast list
and no name field is copied, and the artifact carries a `note` saying so. The SOP's
requirement — "不要直接复用人设，做变体升级" — is therefore a property of the artifact rather
than a reminder in a document (change C12). The honest limit: the volume-rhythm lines are the
author's own free text, so a proper noun written into a volume goal travels with the template;
what a template cannot carry is the cast *as data*.

## Build

Two build steps, because the two halves have different output contracts.

| Half | Tool | Output | Why |
|---|---|---|---|
| Host | `tsc` | `lib/index.js` + `lib/types/**` | Plain Node ESM. `allowImportingTsExtensions` + `rewriteRelativeImportExtensions` let source import `./x.ts` and emit `./x.js`. |
| Browser | `tsdown` | `lib/client.js` | Must be a CJS factory registered on `window.__ModuleLoader__` — see below. |

The installed profile loads `lib/`, not `src/`, so a running `dsh web` keeps serving the last
built tools until `pnpm run build` runs again — relevant after any change to the tool set.

### The client bundle is not plain ESM

The shell serves `/plugins/<id>/client.js` and its module table expects the file to
register a CommonJS-style factory, exactly like every shipped `dsh-client-ui-*` bundle:

```js
window.__ModuleLoader__.load({
  id: '@ai-novelist/novelist-skill',
  factory: (require) => { var module = {exports:{}}; /* … */ return module.exports },
})
```

`tsdown.config.ts` produces this with a `banner`/`footer` wrapper around a CJS build.
Three details are contract, not preference:

- **`outExtensions: () => ({ js: '.js' })`** — under `"type": "module"` rolldown otherwise
  emits `client.cjs`, and the shell only ever asks for `client.js`.
- **The `id` must equal the package name.** `dsh-client-modules` strips a trailing
  `/client` from specifiers and matches rows by package name; a mismatch fails the boot
  with "bundle loaded without registering".
- **React and every `@deepseek-ai/*` package stay unbundled.** The shell owns those module
  instances; a second copy breaks plugin identity and React hook state across copies.

`test/client-bundle.test.ts` executes the built artifact in a stubbed `window` and asserts
the registered id, the plugin shape, and that nothing unexpected was bundled in.

## What is verified, and what is not

`pnpm run check` runs the suite (build → typecheck → test; 122 specs across the two packages
when this was written, and `pnpm test` prints the current count). It covers:
- the SOP pipeline end to end through the nine tools, using only the tool surface a model
  has (`test/sop-pipeline.test.ts`): the phases in order, the soft gate (a competitor call
  succeeds before a pitch exists *and* says what is missing), the opening-checklist gate, the
  launch decision and the two arguments a non-`go` verdict is refused without, the verdict
  arithmetic an `evaluate` session runs, the appointment it is refused without, the delivery
  report and the `final` warning, the iteration rules with their actions and scopes,
  the automatic outcome back-fill and the ineffective-iteration count, the overdue-promise
  check, and the retrospective with its cast-free template,
- the domain, the codec and the derived views (`test/novel.test.ts`): id derivation and 字数
  counting, the version-2 defaults, serialization round-trips, the version-1 migration, the
  chapter contract (missing fields, waivers, prose-only revisions), reader promises, derived
  progress (stock, contract completeness, overdue promises, numbering gaps), the stage
  assessment and its phase labels, and manuscript rendering,
- the store against the **real** local filesystem backend, including the conflict guard and
  containment (`test/store.test.ts`),
- workspace classification and idempotent adoption, pure and against the real backend
  (`test/workspace.test.ts`),
- session-scoped project resolution: each session's own `cwd`, the fallback chain, store
  independence per directory, and the workspace list (`test/resolver.test.ts`),
- the per-root workspace views against the real backend (`test/views.test.ts`): classification
  on demand, adoption and its refusal, one shared classification for concurrent callers,
  routing a session to its own root, the refresh after a write, and a classification that fails
  staying contained,
- the prompt section's text and cache policy (`test/prompt.test.ts`), and — through the
  **real `@deepseek-ai/dsh-system-prompt` registry** — that it actually reaches a composed
  model prompt, describing the assembly's *own* agent rather than the deployment
  (`test/prompt-wiring.test.ts`),
- the plugin entry as a booted tree drives it: the tools it registers, boot-time adoption and
  the `workspaceMode` switch, the workspace of a session announced after boot, and that
  re-mounting never resets an existing project (`test/entry.test.ts`),
- the built browser bundle's shape, including that the Kanban view lands in
  `conversation.view` at order 20 under its own locale namespace
  (`test/client-bundle.test.ts`),
- the activation wiring both surfaces depend on: the Remote face is absent before the plugin
  activates, is the assembly's own face afterwards, and is released on unload
  (`test/client-remote.test.ts`),
- the client reader against a **store-written** project: the document plus the Markdown it
  indexes become the state the board projects, and a workspace with no document answers
  `status: 'none'` so no tab appears (`test/client-read.test.ts`),
- the board projection: columns per lifecycle status in pipeline order, per-column and
  whole-book prose totals, unwritten cards, unanswered contract fields versus waived ones,
  and the empty project (`test/board.test.ts`),
- the patch document, its ids, and that every row it inserts is a declared dependency
  (`packages/novelist-bundle/test/patch.test.ts`).

There is also a fixture generator for looking at the surfaces by hand:
`pnpm run fixture <dir>` writes a schema-3 project with chapters in all four columns, an
open promise, a cast, and a world file. It goes through `decomposeContent` and
`metadataOf` — the same functions the store writes with — so what it produces is what a
real project looks like on disk, not an approximation of one.

Verified by hand against a booted profile, not by the suite:

- booting `dsh web` from an empty directory creates the project document, titled after the
  folder;
- booting it from an existing novel project leaves the file byte-identical;
- the out-of-tree plugin resolves through the profile's module fallback, and the client
  half appears in `window.__DSH_BOOT__`.

Not covered anywhere, because it needs a human at a browser: that the sidebar tab and the
Kanban view render their content, and that the guide capsule opens the tab. The registration
path is the documented public one and the bundle is verified to load, so treat the first
launch as the real test — if the panel stays empty, open the browser console: a
`client-modules` composition error names the offending package, and a panel error message is
the panel itself reporting a failed read rather than a failed load.
