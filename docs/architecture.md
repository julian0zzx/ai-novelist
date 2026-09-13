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
@ai-webnovel/composer        → bundle      (packages/ai-webnovel-composer)
@ai-webnovel/composer-host   → plugin + client (packages/ai-webnovel-composer-host)
```

### Naming

Three different strings are in play, and conflating them is the easiest mistake to make
here. The plugin's *name* is `ai-webnovel-composer` — that is the Cordis plugin name and the
loader row id. The plugin's *package* is `@ai-webnovel/composer-host`. The *bundle* package
— the one an install command names — is `@ai-webnovel/composer`.

```sh
dsh plugin --profile web add -w "$(pwd)/packages/ai-webnovel-composer"
#                               └── directory of the BUNDLE package
```

`dsh plugin` forwards everything after `add` verbatim to pnpm inside the profile, so that
argument must be a spec pnpm resolves: a package name or a path to one. It is not the
plugin's name and cannot be shortened to one. `-w` (`--workspace-root`) is required because
the profile directory is itself a pnpm workspace root — it carries a `pnpm-workspace.yaml`
next to its `package.json`, and pnpm refuses to add a dependency to a workspace root without
it. The plugin itself is pulled in as the bundle's dependency and loaded under the row id
`ai-webnovel-composer`.

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
profile package.json  dsh.profile.bundles: [… , '@ai-webnovel/composer']
        │
        ▼  compose cordis.patch.yml
   - insert:
       - id: ai-webnovel-composer
         name: '@ai-webnovel/composer-host'   ← resolved from the profile's node_modules
        │
        ▼  Loader mounts the row
   @ai-webnovel/composer-host  →  apply(ctx, config)
```

The bundle package therefore contains almost nothing: a manifest, a patch document, and a
comment explaining what the patch is allowed to do. It deliberately only ever `insert`s —
it never overrides an existing row id, so installing it cannot change how the layers below
it behave.

## Layering inside the plugin

Inside `composer-host`, the three layers exist so that the interesting rules can be tested
without booting a harness, and so that the file-access rules exist in exactly one place.

```
src/core/          pure domain — no I/O, no clock, no Cordis
  types.ts           the persisted vocabulary (NovelState, Chapter, StoryLink, …)
  novel.ts           every state transition as a pure function, the codec, derived views
  plan.ts            what the plan still owes: outline/pitch/world/cast/contract gaps
  metrics.ts         baselines → thresholds → verdicts → iteration rules
  write.ts           the delivery report: did the prose pay for the plan? (plus the 去 AI 化 statistics)
  review.ts          the model-backed rubrics, their request framing, and the tolerant reply parser
  repo.ts            retrospective, assets, and the structural template
  workspace.ts       novel | fresh | plain, from a directory listing
src/host/          the deployment surface
  store.ts           one project's ctx.fs access: containment, version guard, write queue
  resolver.ts        which novel is this session in; the ctx.novelState service
  prompt.ts          the runtime-context section and the cache it reads
  llm.ts             the one seam that calls a model: route resolution, one streamed call
  tools.ts           the nine model-facing tools (thin adapters over core)
src/client/        the browser surface
  index.tsx          the right-Sidebar tab type + its body
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

### `host/store.ts` — atomicity and containment

`NovelStore` is the single writer of one project document. It is not a Cordis service — the
resolver is (`ctx.novelState`), because one process serves many workspaces — but it is still
the only place that decides where the project lives and how a write may land.

- **Containment.** The document is always `<workspaceRoot>/.novel/novel.json`. The model
  never supplies the path, so it cannot write the project outside the workspace. Derived
  output (`novel_repo operation="export"` and operation="template") goes through `contain()`,
  which decides containment with path arithmetic rather than string prefixes — a prefix test
  would accept a sibling directory whose name merely starts with the root's.
- **Atomicity comes from the filesystem's own guards, not from comparisons.**
  Initialization uses the `createIfAbsent` write intent; every mutation reads the target's
  version token and writes with `replaceIfVersion`. If anything wrote the document in
  between, the backend rejects the write and the store raises `NovelConflictError`. An
  earlier draft compared `updatedAt` timestamps by hand; it was wrong — the store re-reads
  before writing, so the value it compared against was always its own fresh read, and the
  guard could never fire. The version token is the backend's, so the check is exact.
- **Writes serialize** behind one promise chain, and the read→mutate→write window stays
  closed for the whole mutation (a mutation may be async). Concurrent tool calls therefore
  queue instead of losing one another's work.
- **Reads are uncached.** The document is small, and a cached copy would be a second source
  of truth for a file the model can also edit with its normal file tools.

Guard rejections are detected by `FsErrorCode` (`FS_STALE_VERSION`, `FS_NOT_OBSERVED`)
rather than by class identity, because the error crosses the `dsh-fs` service boundary.

### `host/tools.ts` — the model's vocabulary

Nine tools, one per SOP capability, so the model's vocabulary matches the workflow rather
than the storage layout. They are deliberately thin: each parses arguments, calls a `core`
function through the store, and renders a result the model can act on.

**Eight compute; one asks a model.** That split is the load-bearing decision in this file.
`novel_metrics` comparing a reading against a calibrated median must give the same verdict
every time, or the SOP's evidence chain (C5, C8) collapses; `novel_review` judging whether a
chapter reads as machine-written cannot be computed at all, and the SOP assigns it to
judgement (§1.2). Mixing the two would break both, so the model never touches the ledgers
(`iterations`, `verifications`) that thresholds act on: a review is recorded as a review,
with the provider, the model and the rubric version that produced it.

| Tool | SOP phase | Owns |
|---|---|---|
| `novel_init` | 一 策划 | The project, its commercial frame, the calibration medians, and the writing parameters |
| `novel_plan` | 一/二/四 | `competitor` · `pitch` · `world` · `outline` · `volume` · `chapter` · `beat` · `opening` · `naming` |
| `novel_bible` | 一/四/六 | `character` · `world` · `link` · `review` |
| `novel_verify` | 三 验证 | `round` (record a validation round) · `assess` |
| `novel_write` | 五 连载 | `write` · `read` · `check` — prose, the contract-delivery report, and the automatic 去 AI 化 statistics |
| `novel_metrics` | 五 放大 | `record` · `iterate` · `outcome` · `rules` |
| `novel_status` | 全流程 | `dashboard` (default) · `bible` · `plan` · `chapter` |
| `novel_repo` | 六 复盘 | `export` · `retro` · `asset` · `lesson` · `template` |
| `novel_review` | 五/六 判断 | **model-backed** — `ai-flavor` · `opening` · `competitor` · `retro` |

Design rules the tools follow:

- **One envelope for every call.** `ok`, `operation`, `detail`, the derived `stage`, the next
  phase's `blockers`, optional soft-gate `warnings`, and a `progress` line. Whichever tool the
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
- **Refusal is reserved for data integrity.** A non-passing validation round without
  `fallback` and `abandonIf` is rejected, because the SOP's point is that a failure has to
  say where it goes back to; everything else the SOP would rather you did differently comes
  back as a warning on a successful call.

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
  reviewer. With none of the three, the tool is **not registered at all** (the plugin
  injects the capability inside `ctx.inject(['llm'], …)`); a profile with no model keeps
  eight working tools rather than a ninth that can only fail. That injection is used as a
  *trigger*, not as the mounting context: a service context exposes the injected dependency
  and nothing else, so registration happens against the plugin's own ctx, which carries
  `tools`.
- **One streamed call per request.** `ctx.llm.stream` is the only call shape the service
  offers, so a one-shot is assembled with the harness's own `BlockAssembler` — the same
  interpreter the agent loop uses. A truncated answer (`max-tokens`) is reported as
  truncated rather than read as complete; a `tool-calls` finish is an error, because no
  tools were offered.
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
  summary, warns, and writes the verbatim answer to the transcript.

### `client/index.tsx` — the browser half

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

### Classification and adoption

```
boot → resolver.storeFor(defaultRoot).probeWorkspace()   listDir(root) + stat(.novel/novel.json)
     → classifyWorkspace(entries, …)                     pure: novel | fresh | plain, with evidence
     → modeVerdict(config.workspaceMode)                 operator override: auto | novel | off
     → adopt(…) only for a novel workspace                (or `adoptEmptyWorkspace: true`)
     → snapshotCache.refresh()                           primes the numbers the prompt renders
     → systemPrompt.context('composer:workspace')
```

Three rules make this safe:

- **Conservative classification.** `core/workspace.ts` is pure and takes a directory
  listing, so the whole policy is testable without a filesystem. A repo root
  (`package.json`, `.git`, …) is `plain` even when it holds Markdown; only
  chapter-shaped filenames (`001-*.md`, `第3章.md`) count toward "this is a draft"; a
  single soft signal yields `fresh` (an invitation) rather than `novel` (a claim).
- **Nothing is written unasked.** An empty directory is `fresh` and is left alone;
  adoption there requires the deployment to opt in. A directory that already looks like a
  novel is adopted idempotently through the `createIfAbsent` write intent, so a second
  boot — or a second session against the same directory — leaves the document
  byte-identical. `novel_init` is idempotent for the same reason: a recorded premise is
  never overwritten — the call keeps it and warns that `novel_plan operation="pitch"` is how
  a premise is revised.
- **Synchronous prompt, asynchronous data.** `SystemPrompt` resolves context text
  synchronously (`entry.text(context)`, no await), so `host/prompt.ts` reads a small
  cache that boot primes and every tool write refreshes (`resync`). A step therefore never
  blocks on the filesystem, a failed refresh keeps the last good numbers and records the
  error rather than blanking the section, and a workspace that cannot be probed at all
  leaves the composer idle instead of failing the mount. The prompt section is
  process-scoped while the tools are session-scoped, so the section describes the
  deployment's root; `novel_status` reports the *session's* verdict, which is the
  authoritative answer.

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

That is why the document is at version 2. It holds, as data: the commercial frame and the
calibration medians (`platform`, `baselines`), the commitments made to readers (`links`), the
per-chapter contract (`plotTask` … `hook`, `targetWords`, `waived`, `delivered`), the readings
and the iteration ledger (`readings`, `iterations`, `verifications`), and the closing material
(`retro`). Version 1 held a premise, a cast and chapters; everything else lived in prose and
was forgotten. What the pipeline deliberately does *not* store is the phase itself:
`assessStage(state)` derives the stage and the next phase's blockers on every read, so a
stored stage cannot drift away from the work it claims to describe.

### The migration policy

`parseNovel` accepts version 1 and version 2, and refuses anything else with a
`NovelStoreError` naming the versions it supports. A version-1 document is migrated on read
and written back in the new shape by the next store write:

- the v1 chapter `synopsis` becomes `plotTask` — a draft must never be emptied by an upgrade;
- premise, cast, world entries and chapters survive as they are, and `readChapter` fills the
  SOP fields the old record did not have;
- `meta.genres` becomes the platform's genres, `meta.language` / `meta.pov` seed the writing
  plan;
- the records v1 never modelled (pitch, naming, baselines, competitors, the outline body,
  readings, iterations, verifications) start empty.

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
is rendered by one function instead of eight.

Two refusals survive on purpose, and both are data-integrity requirements rather than workflow
opinions: a non-passing `novel_verify round` without `fallback` and `abandonIf` throws (the
SOP's rule is that a failure has to state where it goes back to — the record cannot be valid
without it), and a chapter reference that matches nothing throws with the known ids listed.
"The record would be meaningless" is a different thing from "the SOP would rather you did
this later".

### Metrics become decisions

A number only enters the project because a platform, an editor, a test cohort or a human
reported it: `novel_verify round` and `novel_metrics record` accept the values a caller
supplies, drop anything that is not a finite number with a warning, and never synthesise a
value. A metric nobody calibrated is reported as incomparable rather than guessed at. From
there the chain is arithmetic:

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
5. **The ledger.** `novel_metrics iterate` writes the decision into `iterations` with the
   reading it responds to, and `novel_metrics outcome` attaches a later reading to it;
   `judgeIteration` compares the two readings' shared metrics and marks the iteration
   effective or ineffective, which is what `countIneffectiveIterations` counts in step 4.

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
  id: '@ai-webnovel/composer-host',
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
  verdict arithmetic plus the two arguments a non-passing round is refused without, the
  delivery report and the `final` warning, the iteration rules with their actions and scopes,
  the outcome back-fill and the ineffective-iteration count, the overdue-promise check, and
  the retrospective with its cast-free template,
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
- the prompt section's text and cache policy (`test/prompt.test.ts`), and — through the
  **real `@deepseek-ai/dsh-system-prompt` registry** — that it actually reaches a composed
  model prompt (`test/prompt-wiring.test.ts`),
- the plugin entry as a booted tree drives it: the tools it registers, boot-time adoption and
  the `workspaceMode` switch, and that re-mounting never resets an existing project
  (`test/entry.test.ts`),
- the built browser bundle's shape (`test/client-bundle.test.ts`),
- the patch document, its ids, and that every row it inserts is a declared dependency
  (`packages/ai-webnovel-composer/test/patch.test.ts`).

Verified by hand against a booted profile, not by the suite:

- booting `dsh web` from an empty directory creates the project document, titled after the
  folder;
- booting it from an existing novel project leaves the file byte-identical;
- the out-of-tree plugin resolves through the profile's module fallback, and the client
  half appears in `window.__DSH_BOOT__`.

Not covered anywhere, because it needs a human at a browser: that the sidebar tab renders
its content and that the guide capsule opens it. The registration path is the documented
public one and the bundle is verified to load, so treat the first launch as the real test —
if the panel stays empty, open the browser console: a `client-modules` composition error
names the offending package, and a panel error message is the panel itself reporting a
failed read rather than a failed load.
