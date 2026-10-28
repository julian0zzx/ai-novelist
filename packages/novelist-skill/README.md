# @ai-novelist/novelist-skill

The plugin half of the AI Web Novel Composer. One package carries three DSH faces:

| Face | Declared in | Served as |
|---|---|---|
| Cordis plugin | `package.json` (`main`, no `dsh` field for this) | `apply(ctx, config)` — the row id is `ai-novelist` |
| Browser client | `dsh.client` | `exports["./client"]` → `lib/client.js`, loaded as a browser plugin |
| Library | `exports["."]`, `exports["./core"]` | plain Node ESM, for tests and for anyone embedding the domain |

The bundle package that a profile installs is `@ai-novelist/novelist-bundle`
(`packages/novelist-bundle`): its patch file inserts the loader row that names *this*
package. See the repository root [`README.md`](../../README.md) for install instructions and
[`../../docs/architecture.md`](../../docs/architecture.md) for why the layers sit where they do.

The workflow this package implements is [`../../docs/sop.md`](../../docs/sop.md).

## Entry point

`src/index.ts` is the only file DSH loads. It:

- exports `name = 'ai-novelist'` and `inject = ['fs', 'tools']`;
- defines `Config` (`workspaceRoot`, `workspaceMode`, `adoptEmptyWorkspace`) with Schemastery;
- builds the `ProjectResolver` and publishes it as the `novelState` service through
  `ctx.reflect.provide` **synchronously**, so a tool registered right after `apply` still
  finds it;
- classifies the deployment root, adopts a `novel` workspace (a marked project, an existing
  draft, or — under the default `workspaceMode: 'signal'` — unmistakable but unmarked novel
  material such as a `创意整理.md`), primes the prompt cache, and logs the decision. The
  scaffold it writes is empty: the folder's name as the title, every story field blank;
- classifies **every other workspace when a session opens in it** (`session/created`), so the
  tools, the prompt and adoption all follow the session's `cwd` — see `views.ts` below;
- registers the eight computing tools, the optional `novel_review`, and the runtime-context prompt section.
  The reviewer is mounted through `ctx.inject(['llm'], …)` and is therefore absent wherever no
  model route exists.

`workspaceMode` is the deployment's answer to "how eager is this composer": `signal`
(default) also claims an unmarked book folder, `auto` only a marked or opted-in one, `novel`
forces the mounted root, and `off` never writes. The `signal` policy is the only thing that
distinguishes them in `mayAdopt`; classification itself stays pure and mode-blind, and the
classifier's "project markers win" rule is what keeps a repository from ever being claimed
however much Markdown it holds.

Classification and adoption are contained: a workspace that cannot be probed logs a warning
and leaves the composer idle there rather than failing the mount or the session.

## Module map

Dependencies point one way: `client` and `host` may import `core`; `core` imports neither.

### `src/core/` — pure domain

No I/O, no `Date.now()`, no Cordis. Every mutation is `(state, patch, clock) => state` with
the clock injected, which is what makes the SOP's rules specifiable with plain assertions.

| Module | Owns |
|---|---|
| `sop.ts` | The SOP as data, and the single source every generated artifact reads: `SOP_VERSION`, `SOP_PHASES` (each bound to the `ProjectStage` it belongs to, with the reference that teaches it), `TOOL_SURFACE` (each tool's model-facing `summary`, its `selector` parameter and its operation list), `TOOL_ORDER`, `phaseForStage` / `phaseIndexFor`. `host/tools.ts` takes its descriptions from here and `scripts/pack.mjs` renders `SKILL.md`, `INSTALL.md` and `references/*.md` from it, so the surface has one description instead of three. Pure data with no imports, which is what lets the build script load it too. |
| `types.ts` | The persisted vocabulary: `NovelState`, `NovelMetadata` (what the document holds), `StorageIndex` (where the content lives), their records, `NOVEL_SCHEMA_VERSION = 5`, and the closed enums the tools validate against — `PROJECT_STAGES`, `METRIC_KEYS` / `METRIC_PERIODS`, `LINK_STATUSES`, `VERDICT_LEVELS`, `CHANGE_SCOPES`, `CHAPTER_STATUSES`, `BEAT_KINDS`, `CONTRACT_FIELDS`. |
| `novel.ts` | Every state transition (`emptyNovel`, `update*`, `upsert*`, `remove*`, `addReading`, `addIteration`, `addReview`, `setOpeningCheck`), the metadata codec (`parseMetadata`, `serializeMetadata`, `stateOf`, `metadataOf`, `migrateV1`, `migrateV2`) plus the whole-document codec (`parseNovel`, `serializeNovel`), and the derived views (`progressOf`, `assessStage`, `stageLabel`, `missingContractFields`, `renderManuscript`). Also the small utilities the rest of the core shares: `slugify`, `normalizeId`, `countWords`, `resolveChapterId`, the `read*` coercion helpers, and the `Clock` seam. |
| `markdown.ts` | The restricted Markdown dialect, with no dependency: `splitFrontmatter` / `parseFrontmatter` / `serializeFrontmatter` (scalars, string lists, one level of mapping, both list spellings), `splitSections` / `sectionText` / `sectionList` (fence-aware), `readEntries` / `renderEntry`, `parseTable` / `renderTable` / `escapeCell` (`\|` escapes, wrong-cell-count is an error not a shift), `parseDocument` / `renderDocument`, and `hashContent`. Every failure is a `MarkdownError` carrying the offending line. |
| `content.ts` | §4's ownership table: `decomposeContent` (state → the files that own each datum) and `composeContent` (files → outline, cast, world, chapters). Per-kind readers and renderers (`parseOutlineFile`, `parseCastFile`, `parseWorldFile`, `parseVolumeFile`, `parseChapterPlanFile`, `parseChapterOutlineFile`, `parseChapterBodyFile`, and their `render*` counterparts), each naming every other home in the same file, and all failures raised as `NovelContentError` naming the file. |
| `plan.ts` | "What does the plan still owe?" — `missingOutlineFields`, `missingPitchFields`, `worldGaps` (a rule with no cost/limits), `castGaps` (protagonist spine), `contractGaps` / `missingContract`, `contractRows`, `lengthCheck` (the two length gates: a first draft is written to `DRAFT_TARGET_RATIO` = 125% of the target, a `revised`/`final` chapter is held to `LENGTH_TOLERANCE` = -5%/+15%; `draftTargetWords` / `lengthStageFor` / `lengthWindow` / `lengthToleranceLabel` are the pieces), `rhythmExpectation`, `openingPackageGaps`. Also the **length plan**: `WRITING_PLAN_QUESTIONS` / `LENGTH_BENCHMARKS` (the questions the composer puts to the author, with tiers offered as choices), `writingPlanGaps` (what is still unanswered), `derivedTotalChapters` / `chaptersPerVolume` / `normalizeWritingPlan` (forward-only derivation), `writingPlanConflicts` / `volumeLengthNote` (where the numbers disagree), `describeWritingPlan` (which carries the per-chapter draft target). This is what the soft gate, the runtime context and the delivery report read. |
| `metrics.ts` | Baselines to decisions: `thresholdFor`, `calibrationAge` (30-day staleness), `assessReading`, `tallyAssessments`, `verdictFromAssessments`, `evaluationAction` / `evaluationActionLabel` (verdict → 继续投入 / 换变量后继续 / 切书止损), `evaluationHint` (the derived, advisory reminder to run one — `DEFAULT_EVALUATION_INTERVAL = 10` chapters), `iterationRules`, `decliningStreak`, `countIneffectiveIterations`, `openIterationsFor`, `judgeIteration`, plus `DEFAULT_MULTIPLIERS`, `SUSTAINED_DECLINE_CHAPTERS`, `INEFFECTIVE_ITERATIONS_FOR_CUT`, `PERIOD_METRICS`. |
| `write.ts` | The delivery report: `analyzeDelivery` (planned / waived / reached / missed / unplanned, plus both length gates — `draftLength` at 125% and `finalLength` at -5%/+15%, with the one the chapter's status implies as `length`), `blockersToFinal` (which judges on the finished gate), `complianceChecklist`, and two mechanical checks for the 去 AI 化 step: `styleObservations` (long paragraphs, average length, dialogue density, repeated openings, the **对举句 count** from `contrastFrames`, and hits on the book's own 负面清单 — never a quality verdict) and `contrastFrames` (the 「不是 A，是 B」/「是 A，不是 B」/「不是 A，而是 B」/「与其说 A，不如说 B」 frames, most specific first so one device is counted once). |
| `review.ts` | The model-backed rubrics as versioned data (`REVIEW_PROMPT_VERSION`, `AI_FLAVOR_DIMENSIONS`), the request builders for all four operations (`buildAiFlavorRequest`, `buildRewriteRequest`, `buildOpeningRequest`, `buildCompetitorRequest`, `buildRetroRequest`), the project brief every request carries, and the tolerant reply parser (`extractReviewJson`, `parseReviewOutput`, `renderReview`). Pure — the model is the only thing it does not own. |
| `repo.ts` | The closing phase's assembly: `buildTemplate`, `estimateVolumeLength`, `collectHookPatterns` / `classifyHook`, `extractAssets`, `summarizeCompletion`, `buildRetrospective`, `lessonPrompts`. |
| `workspace.ts` | Conservative classification from a directory listing plus two existence probes: `classifyWorkspace` → `novel` / `fresh` / `plain` with `reason` and `evidence`, `looksLikeChapterFile`, `looksLikeCreativeNote`, `countDraftFiles`, `novelSignalCount` (a creative filename weighs two, everything else one, each file counted once by its most specific rule), `hasNovelSignals`, `describeVerdict`, `adoptableVerdict` (whether that verdict justifies writing a project document), `NOVEL_DIR`. |
| `paths.ts` | The storage file tree as path arithmetic: `DEFAULT_STORAGE_LAYOUT`, `topLevelPaths`, `chapterPaths` / `chapterStem` / `sanitizeTitle` / `padChapterNumber`, `numberFromFileName`, `isOutlineFile`, and the migration backup path. Its own module so neither `novel.ts` nor `content.ts` has to import the other to spell a filename. |
| `index.ts` | Re-exports the above from one specifier, so the host layer has exactly one import shape. |

### `src/host/` — the deployment surface

| Module | Owns |
|---|---|
| `store.ts` | `NovelStore`: the single read/write path for one project — the metadata document at `<workspaceRoot>/.novel/novel.json` plus the Markdown files its `StorageIndex` names. Containment by path arithmetic (`contain`); initialization through the `createIfAbsent` write intent (`adopt`, idempotent); every mutation through `replaceIfVersion` **on the metadata only**, with the content files written first and the metadata last; writes serialized behind one promise chain; derived output (`writeDerived`) for the manuscript and templates. Reads assemble a `NovelState` from the files, adopt whatever they say, claim unindexed chapter files by their frontmatter `id`, and report orphan files as warnings. Raises `NovelConflictError` on a pure metadata conflict, `NovelWriteError` (with `filesWritten` / `filesNotWritten`) when a multi-file write dies halfway, and `NovelStoreError` on an unreadable, broken, or foreign document. `ensureMigrated` upgrades v1/v2 documents behind a `.novel/novel.v2.backup.json` that is never overwritten. `isRegularFile` and `isFsErrorCode` match the `dsh-fs` boundary structurally. |
| `resolver.ts` | `createProjectResolver`: which novel is *this session* working on. Caches one `NovelStore` per normalized root; `storeForSession` / `rootForSession` resolve `session.header.cwd` → configured `workspaceRoot` → `process.cwd()`; `verdictFor` classifies a session's root (the store it hands back can also `probeWorkspace`); `listProjects` and `registerWorkspace` expose the optional `@deepseek-ai/dsh-workspace` registry when it is mounted — the current tool set does not call them. Publishes the resolver as `ctx.novelState`. |
| `views.ts` | `createWorkspaceViews`: what the composer knows about one workspace, keyed by root. One `WorkspaceView` per directory holds the verdict, whether that classification is the call that wrote the document, and a snapshot cache; `classify()` runs at most once per root and hands concurrent callers the same promise; `viewForSession` routes a session to its own `cwd` and an agentless caller to the deployment root. The deployment's policy arrives as two callbacks (`normalize` for `workspaceMode`, `mayAdopt` for `adoptableVerdict`), so the registry itself knows nothing about profiles. `onSessionCreated` is the `global` lifecycle listener that starts classification when a session appears — global because a session's scope is not the plugin's. |
| `prompt.ts` | The runtime-context section (`composer:workspace`): `renderWorkspaceContext` renders the workspace kind, the document path, the project numbers and the per-kind conduct text; `createSnapshotCache` keeps those numbers in a 1.5 s TTL cache because the prompt registry resolves text synchronously; `registerWorkspacePrompt` files it after the sandbox facts and resolves *which* workspace per assembly, from the agent that assembly is for. A failed refresh keeps the last good numbers and records why. |
| `llm.ts` | The only module that talks to a model. `resolveRoute` (call override → configured `reviewProvider`/`reviewModel` → `agentDefaultModel.currentSelection()`; a half-given override is refused, not silently dropped), `runReview` (one `ctx.llm.stream` call assembled with the harness's `BlockAssembler`, with timeout, pre-flight cancellation, a caller-supplied output budget, an explicit reasoning effort chosen against the route's declared capabilities, and a by-cause empty-answer diagnosis), `resolveSubagentProvider` / `runReviewFanout` (the delegation half: `ctx.subagents` is a registry, so the provider name is read from `list()` rather than assumed, and each request becomes one child whose text is awaited and collected — a failed child is reported, not thrown), and `NovelReviewError`. |
| `reminder.ts` | The only module that talks to `ctx.schedule`. `syncEvaluationReminder` brings the host's durable reminder for one project into line with the project's state — create, refresh or delete at most one task, keyed by a stable title because the service keys tasks by an id this plugin does not persist. Every failure is returned as an outcome rather than thrown: the reminder wraps a step the SOP says gates nothing, so a chapter must not fail to record because the host could not persist a nudge. |
| `tools.ts` | The nine model-facing tools, their JSON schemas, the shared envelope and its renderer, `DEFAULT_MANUSCRIPT_PATH` / `DEFAULT_TEMPLATE_PATH` / `DEFAULT_REVIEW_PATH`, `registerTools`, and `registerReviewTool` (registered separately, because it needs a model the other eight never do). Each tool body resolves its store from the calling session, mutates through the store, then refreshes the view of *that* session's workspace. Tool descriptions are **not** here: they come from `core/sop.ts`, and `runCompetitorBatch` is the one body that delegates — a batch of competitors fanned out one child agent per book, degrading to the sequential `runReview` path wherever no provider is registered. |

### `src/client/` — the browser half

Two surfaces over one reader.

`remote.ts` holds the one thing the framework does not hand a surface through its props: the
Remote face. `apply` captures `ctx.remote` into it and releases it on unload; both surfaces
read it back with `clientRemote()`. One capture, so the panel and the view cannot end up with
different answers to "is there a Remote" — a second capture that nothing fills compiles fine
and fails at read time.

`project.ts` is that reader, shared by both. It reads the project through the composed Remote
(`ctx.remote.workspaceFiles`) so the host resolves the workspace root and neither surface
guesses a path, and assembles what it reads with the same `composeContent` the host uses, so
the browser holds no format knowledge of its own. The metadata document decides whether a
project exists at all; the content paths the index names resolve under `.novel/`, and a path
that is simply absent is "nothing recorded yet", never an error.

`index.tsx` registers the "Novel Composer" right-Sidebar tab as a page type
(`ctx.sidebarRightTabs.register`) plus its body in the `sidebar.right.pane.tab` seat, both
inside one `ctx.effect`.

`kanban.tsx` registers the **Kanban** conversation view beside Chat and Trajectory: one
`conversation.view` list entry at order 20, carrying a `label` thunk over the `novel-kanban`
locale namespace. Its component is what decides whether the tab exists — it reads the
session's workspace root from the standard `useSessions` hook, and returns `null` in exactly
one case (`status: 'none'`, no document). A view that renders nothing contributes no tab, so
a workspace without a novel keeps its two tabs; a document that is present but broken is
shown, because that is the case the user needs to see.

`board.ts` holds the projection as pure data, in the two halves a novel project has. The
**process documents** — one card per planning artefact in SOP order (立意与核心设定 / 竞品拆解 /
候选书名 / 世界观设定 / 人物设定 / 全书大纲 / 写作风格 / 分卷大纲 / 爽点节拍表 / 开篇工程清单 / 上线决策 /
连载数据 / 完本复盘) — each reporting whether it is started, how much of it exists, which parts
it still owes, and the gate it sits behind (`prose` for the two `novel_write` enforces,
`skeleton` for the work the launch decision authorises). The **chapter columns** per
`CHAPTER_STATUSES`, and per card the word count, beats, hook state and unanswered contract
fields, plus the derived stage and standing. Completeness is read from the core's own gap
checks (`castGaps`, `outlineSpineGaps`, …), so the board and `novel_status` cannot disagree
about a document. No React, which is what lets `test/board.test.ts` specify it without a
browser.

## The tool surface

One tool per capability, each owning one phase or one kind of state — except `novel_assess`,
which owns no phase: it is the on-demand data evaluation, started by the author when they ask
whether the book is still worth continuing, and nothing in the pipeline waits for it.

| Tool | Operations / kinds | Notes |
|---|---|---|
| `novel_init` | — (one call, idempotent) | Project, commercial frame, `baselines` + `multipliers`, writing parameters. The length plan (`targetWords`, `chapterWords`, `volumes`) is asked of the user and never guessed: `totalChapters` is derived from total ÷ chapter length, unanswered questions are reported as a checklist, and contradictions between the numbers are warned about. `volumes: 0` is the explicit 不分卷 answer; omitting it leaves the question open. Never overwrites an existing premise (it warns and points at `novel_plan operation="pitch"`). Unknown metric keys in `baselines` are ignored with a warning. |
| `novel_plan` | `competitor`, `pitch`, `world`, `outline`, `volume`, `chapter`, `beat`, `opening`, `naming`, `launch` | `competitor` writes each dismantle into `竞品拆解.md` (all twelve fields), so the study is a file the author can read and reuse. `outline` takes the narrative spine (`synopsis`, `protagonistArc`, `supportArcs`, `antagonistArc`, `factionShift`, `conflictArcs`, `costs`, `gains`), the 写作风格 block (`styleTone`, `stylePerspective`, `styleRhythm`, `styleDiction`, `styleDialogue`, `styleEmotion`, `styleTaboos` — all seven are a prose gate) and `fullOutline` (the `## 完整大纲` body); `volume` takes its own seven (`synopsis`, `protagonistArc`, `antagonistArc`, `factionShift`, `mainConflict`, `costs`, `gains`) and `detail` (the volume's own 分卷剧情大纲); `chapter` adds `keyBeat` and `price` to the contract. **Every layer reports story → 写作风格 → payoffs → length in that order**, and the ratio target (÷100 / ÷50 / ÷5) is only printed after the narrative elements have been reported; falling short of it is a **warning**, never a refusal, and is overridable per call with `targetWords`. A partial `volume` call keeps the elements it did not name. `chapter` accepts `waive` + `waiveReason`, `remove: true`, and derives the id from `id`/`title`. `opening` without a `key` lists the checklist and reports `ok: false` (nothing changed). `launch` records the phase-three human go/no-go (`verdict` = `go` / `revise` / `abandon`); `go` is what unlocks phase four, and a `revise` or `abandon` **throws** unless `fallback` and `abandonIf` are supplied. Writing a settings layer out of order is warned about, not refused. |
| `novel_bible` | `character`, `world`, `link`, `review` | `character` carries the tier (`scope` = `main` / `volume` / `cameo`) plus the walk-on register (`volume`, `firstAppearance`, `exit`), and warns when two entries share one display name; `link` carries `plantedAt` / `dueAt` / `payoff` / `status` / `volume`; `review` reports world gaps, cast gaps **by tier** (walk-on register gaps are listed separately and never as debt), an unknown `scope`, and unrecovered or overdue promises. `review` also checks chapter time anchors for story-time regressions. |
| `novel_confirm` | `status`, `discuss`, `confirm`; `kind` = `settings`/`premise`, `world`, `cast`, `outline`, `volume`, `style` | The author checkpoints, and the record of the conversation that closes them. The settings are settled **one layer at a time, in order** (立意 → 世界观 → 人物设定 → 全书大纲（含写作风格）→ 分卷大纲); a later layer's `discuss`/`confirm` **throws** while an earlier one is open, and `status` reports every layer plus which one is in turn. The 全书大纲 layer **throws** on `confirm` while its 写作风格 block is incomplete, and `kind="style"` is the 文风复核 after the golden three chapters (第 1–3 章): it **throws** on `confirm` until those chapters have prose. `discuss` requires the user's own words in `feedback`; `confirm` requires both `summary` and `note`. The premise needs 2 rounds, every later layer and the voice review need 1. `settings` and `premise` are the same checkpoint two ways, and rounds recorded under either spelling count for both. |
| `novel_write` | `write`, `read`, `check` | **The one hard-gating tool**: `proseGate` **throws** while the premise layer is unsigned, while the 写作风格 block of the 全书大纲 is incomplete, and — once the golden three chapters (第 1–3 章) have prose — while the user has not reviewed the voice **and** while no 去 AI 化 diagnosis has been recorded at all (so chapter 4 onward waits; chapters 1–3 are written against a style the author has already seen, and the diagnosis is the receipt that the SOP's step 23 actually happened rather than depending on the model choosing to run it). `chapterId` is required; `write` replaces the body (never appends) and takes `delivered` = the contract fields the draft reached. A first draft is written to 125% of the chapter target (去 AI 化与手改会成段删减), so the tool prints both length windows and checks the draft against whichever gate the chapter's status implies (`planned`/`drafting` = 125%, `revised`/`final` = -5%/+15%). Every `write` and `check` also returns the SOP's 去 AI 化 statistics — long paragraphs, average paragraph length, dialogue density, repeated sentence openings, the 对举句 count with two quoted hits, and any phrase of the book's 负面清单 that appears — as countable symptoms; the tool never edits the prose, so a revision goes back through `write`. Marking `status: 'final'` prints the pre-publish blockers and the compliance checklist, but does not refuse. An overwrite archives the replaced draft under `.novel/versions/` and names the file; every write/check also runs a deterministic 校对 pass (fixed spellings and punctuation), reported with counts and never as a "passed" line. |
| `novel_assess` | `record`, `iterate`, `evaluate`, `outcome`, `history`, `rules` | `record` needs at least one numeric metric and returns the rules it fires (action + scope); `record`/`evaluate` also accept `baselines` to re-calibrate on the spot. `iterate` needs an `action`. `evaluate` compares the reading with the calibrated medians, back-fills every open iteration against it, and returns the verdict → action mapping; it **throws** without `nextAtChapter`/`nextTrigger`, throws without `fallback`/`abandonIf` when the verdict is not a pass, and refuses to answer when every metric lacks a median. `outcome` is the manual override for the automatic back-fill: it closes the named `iterationId` against the named `outcomeReadingId` (defaulting to the most recent of each), throws when that reading is the change's own baseline, and reports whether it improved. `history` lists the evaluations with their verdicts, fallback, abandon condition and next appointment; `rules` prints every metric's median, multiplier and trigger line. |
| `novel_status` | `detail`: `dashboard`, `bible`, `plan`, `chapter`, `craft`; `topic` for `craft` | Pure read. `dashboard` includes the chapter table (first 30), promise recovery, the derived evaluation hint and last evaluation, the latest reading against its thresholds, adjustments awaiting a back-fill, and the calling session's workspace verdict. `craft` returns one writing-craft sheet (`genres`, `trends`, `platforms`, `overseas`, `hooks`, `payoffs`, `rhythm`, `naming`, `voice`, `continuity`, `submission`, `fanfic`, `script`, `teaching`, generated from `docs/craft/`) or the index when `topic` is omitted; an unknown topic throws with the available list. |
| `novel_repo` | `export`, `submission`, `retro`, `asset`, `lesson`, `template` | `export` requires chapters; `submission` writes the editor-facing package (work information, blurb slots left to the author, the first three chapters' contracts and hooks, a checklist and a submission log) to `.novel/submission.md` by default; `retro` derives the data summary, assets and one template; `lesson`/`asset` create the retro record if it does not exist; `template` warns when no retrospective has been written yet. |

### The shared envelope

Every tool returns the same shape, rendered as one text block:

```
ok          the tool's own claim about whether it changed anything: a no-op listing
            (`novel_plan operation="opening"` without a key) or a chapter read reports
            `false`, `novel_status` reports `true`
operation   which operation ran
detail      one line on what happened
stage       the derived SOP phase, e.g. `serializing（阶段五 连载与放大）`
blockers    what the SOP still needs before the next phase (from `assessStage`)
warnings?   the soft gate: the call succeeded, but the SOP disagrees with the position
evaluationDue?  the on-demand evaluation is suggested (never a warning, never a blocker)
progress    chapters, words, written, contracted, stock, openLinks, overdueLinks
```

`blockers` is the phase's own missing preconditions; `warnings` is everything else the call
noticed (a chapter contract that is incomplete, a world rule with no cost, a promise with no
`dueAt`, thin competitor coverage, a stale calibration, an undelivered contract field).
Neither ever refuses a call — with two deliberate exceptions, both about keeping a decision
from becoming a formality: `novel_plan operation="launch"` refuses a non-`go` verdict without
`fallback` / `abandonIf`, and `novel_assess operation="evaluate"` refuses a session with no
appointment for the next evaluation and refuses to answer when no metric has a comparable
median. Every tool also refuses to guess a chapter it cannot resolve.

## Schema v5 data model

The novel is split. `.novel/novel.json` holds metadata, the evidence chain, and an index; the
content lives in the Markdown files that index names, so an author can read and revise it.

**In the document:**

| Group | Fields |
|---|---|
| Meta | `schemaVersion`, `meta` (title, premise, genres, pov, language), `platform` (name, mode, audience, genres, readers, monetization), `createdAt`, `updatedAt` |
| Pitch | `pitch` (`memorablePoint`, `coreEmotion`, `shuangPoints`, `differentiators`, `kernel`), `naming[]` (candidate title/blurb/tags sets, one `active`) |
| Research | `competitors[]` (the dismantled leaderboard titles), `baselines` (`medians`, `multipliers`, `calibratedAt`, `source`) |
| Writing plan | `writing`: `language`, `pov`, `volumes`, `totalChapters`, `targetWords`, `chapterPlanWindow`, `openingGateChapters`, `stockTargetChapters`, `chapterPlanCeiling`, `updateRhythm` |
| Promises | `links` (map) — status and recovery chapter feed the volume-end gate, so this must be atomic |
| Feedback | `readings[]`, `iterations[]` (with `baselineReadingId` / `outcomeReadingId` / `outcome`), `evaluations[]` (with `nextAtChapter` / `nextTrigger`), `launchDecisions[]` (the phase-three go/no-go with its `fallback` / `abandonIf`), `reviews[]` |
| Checklist | `opening[]`: the opening-engineering items whose `done` flags gate phase two |
| Index | `index`: `outlineFile`, `castFile`, `worldFile`, `volumeDir`, `chapterPlanFile`, `competitorFile`, `chapters` (id → number, title, `bodyFile`, `outlineFile`, both hashes), `volumes` (number → `number`, `file`, `hash`), `files` (path → hash) |
| Closing | `retro?` (dataSummary, highlights, problems, lessons, assets, templates) |

**In the files** (`docs/plan-markdown-storage.md` §4 is the authority):

| File | Holds |
|---|---|
| `全书大纲.md` | `logline`, the `## 故事六要素` block (时间/地点/起因/经过/结果 as `###` subsections; 人物 is read from the cast), the `## 叙事骨架` block (eight named narrative elements as `###` subsections), the `## 金手指` block (name/owner/rule/cost/limits/growth/firstReveal), the `## 写作风格` block (seven named style elements, same dialect), the `## 完整大纲` body (`fullOutline`), `acts[]`, `minimal`, `fullOutlineDone` |
| `人物设定.md` | One `##` section per character, sorted by tier (leads first, walk-ons last): `id`, `role`, `scope`, `volume`, `firstAppearance`, `exit`, `goal`, `personality`, `voice`, `fear`, `obsession`, `weakness`, `camp`, `relations`, `growthArc`, `notes`, and the prose `description`. `scope` decides what the entry owes — `main` the full spine, `volume` role/goal/personality/voice, `cameo` only 「他是谁 + 首次出场章」 — and an absent `scope` falls back to `role`, so a pre-tier file is held to exactly what it was |
| `世界观设定.md` | One `##` section per fact: `id`, `kind`, `name`, `cost`, `limits`, `parent`, `level`, `volume`, `relations`, and the prose `detail`. Only rule-shaped kinds (rule/power-system) owe cost+limits; `parent`/`level`/`volume` are what make the world layered |
| `分卷大纲/第N卷.md` | **One file per volume.** Frontmatter: `number`, `title`, `goal`, `conflict`, `climax`, `endHook`, `chapters`. Body: `## 卷内节奏` (the volume's own 分卷剧情大纲) plus the volume's seven narrative elements as `##` sections. Any further `##` section the author writes is folded back into the pacing detail, in file order. The file is named by number alone, so a retitle never moves it; a version-3 project's single `分卷大纲.md` is split into these by the store's migration |
| `章节大纲.md` | The whole-book part: the `## 开篇工程清单` checklist (whose `done` flags gate phase two) and a derived `## 分卷章节表` index saying which file holds which volume's chapters, and over which chapter numbers |
| `章节大纲/第N卷.md` | **One file per volume.** The chapter table (number, title, volume, target words, one-line summary, synopsis) and the rhythm table for the chapters filed under that volume. `未分卷.md` holds the chapters filed under no volume — for a deliberately 不分卷 book, the whole book. A volume with neither rows nor beats gets no file at all, and a chapter moving between volumes moves its row between files |
| `竞品拆解.md` | One `##` section per comparable title: `id`, `title`, `tags`, `blurb`, `openingEvent`, `goldenFinger`, `protagonistDesire`, `antagonistMotive`, `shuangFrequency`, `emotionCurve`, `paywallPoint`, `chapterHooks`, `commentKeywords`, `takeaway` |
| `章节/第NNN章-*.md` | `status` and the prose (`wordCount` is derived: recomputed on read, back-filled on write) |
| `章节/第NNN章-*.细纲.md` | `beats`, `waived`, `delivered`, and the contract sections (剧情任务、时间、地点、关键转折、代价与收获、冲突、情绪回报、信息差、章末钩子). `时间`/`地点` are **space-time anchors**, not contract fields: reported by `spaceTimeGaps`, never counted as an incomplete contract |

`title`, `volume`, and `targetWords` live **only** in the chapter plan table; the contract file
does not repeat them, so a title edited there is a title changed everywhere. `id` is the stable
key and travels in each file's frontmatter, which is how a rename can be recovered.

`竞品拆解.md` is the one top-level file whose absence is not "empty": dismantles recorded before
the file existed live in `novel.json`, and a read falls back to them rather than losing research.
It is also the file behind the SOP's 20-title gate — a dismantle typed straight into it counts.

### Narrative completeness, then 写作风格, then payoffs, then length

An outline's length is checkable; whether it *tells the story* was not, so a 20k-character outline
that filled every structural category and beat its 1/100 target was reported as fine while a reader
could not say what happens in the book. The check therefore runs in a fixed order, and the order is
the rule:

1. **Story** — `outlineSpineGaps` / `volumeSpineGaps` report each named element that is empty:
   eight on the whole-book outline (故事梗概、主角成长线、伙伴成长线、反派成长线、阵营演变、对抗副本、
   失去了什么、获得了什么), seven on a volume, plus `keyBeat`/`price` on a chapter contract.
2. **Style** — `outlineStyleGaps` reports each of the seven 写作风格 elements that is empty
   (文风基调、人称与视角、句式与节奏、遣词用句、对话与描写、情绪与爽点落点、负面清单), and the block is a
   *prose gate*: `novel_write` refuses a chapter while any of them is empty, because a voice
   chosen while writing chapter 1 is a voice the author never got to steer. The layer itself
   cannot be confirmed either until the block is written.
3. **Payoffs** — `outlinePayoffGaps` reports an empty rhythm table and volumes with no climax or
   end hook to be the 爆点's landing point.
4. **Length** — only then is the ratio target printed.

`novel_plan` prints them in that order for every layer, `novel_status detail="plan"` shows the same
spine per volume, and phase four is not complete while a spine is incomplete. Every element is a
named field, so a missing one is reported by name rather than absorbed into a prose blob; anything
the author deliberately skips is waived out loud (`waive` + `waiveReason` on a chapter contract).

The checks live in `src/core/spine.ts`, apart from `plan.ts` so the stage machine can use them
without closing a cycle (`plan.ts` already depends on `novel.ts`).

### Planning length budgets

A chapter's length is checkable against a stated target; an outline's was not, so a two-line
全书大纲 and a twenty-thousand-character one passed the same checks. Each planning layer is
therefore budgeted as a fraction of the prose it governs — as a **ratio**, not a word count,
because the book's length is the author's own answer and "10000 字" is wrong for a 30 万字 short
serial and a 300 万字 epic alike:

| Layer | Ratio | Written where |
|---|---|---|
| 全书大纲 (`fullOutline`) | 总字数 ÷ 100 | `## 完整大纲` in `全书大纲.md` |
| 分卷大纲 (`detail`) | 本卷字数 ÷ 50 | the `## 卷内节奏` section of that volume's own file |
| 章节大纲 (the contract fields) | 单章字数 ÷ 5 | the contract sections in `*.细纲.md` |

The ratios are SOP constants (`OUTLINE_LAYER_RATIOS`), reportable at `novel_plan` time and
overridable per call with an explicit `targetWords`. Falling short is a **warning**, never a
refusal: a short outline is often short for a reason, and the SOP's hard gate is the premise
sign-off, not a word count. An unanswered length question produces no target at all rather than
an invented denominator.

Two conventions hold everywhere:

- **Everything is plain lossless JSON** — no `Map`, no `Date`, no class instance — because
  the browser half and the harness session log both read these.
- **Optional means "not recorded yet", never "empty"**, and **anything derivable is not
  stored**: word counts, totals, stock, contract/delivery counts, open and overdue promises,
  and the project's stage are all recomputed by `progressOf` / `assessStage` on every read,
  so a hand-edited file cannot carry a stale number and there is no second source of truth.

### Versioning and migration

`parseNovel` accepts `schemaVersion` 1 through 5 and refuses anything else with a
`NovelStoreError` naming the supported versions, and `migrateDocument` upgrades
each in turn:

- **Version 3** kept its content in files but every volume outline in one
  collection file: the store splits it into `分卷大纲/第N卷.md` and deletes the
  collection — new files first, collection last, so an interrupted run reruns on
  the next read.
- **Version 4** had per-volume outlines but the whole chapter plan in one file:
  the store splits the chapter and rhythm tables into `章节大纲/第N卷.md` by each
  row's `卷` column, rewrites `章节大纲.md` with the opening checklist and the
  index of where they went, and reruns idempotently if interrupted. A version-3
  document gets both splits in one pass.

Version 5 is what this build writes.

`migrateV1` keeps the whole draft: the v1 chapter `synopsis` becomes `plotTask` (an existing
plan must not be silently emptied by an upgrade), premise, cast, world entries and chapters
survive, `meta.genres` becomes the platform's genres, and `meta.language` / `meta.pov` seed
the writing plan. Records v1 never modelled (pitch, naming, baselines, competitors,
outline body, readings, evaluations, iterations, launch decisions) start empty, and the
project simply lands in the phase its data supports. A version-3 document that still carries
the pre-3.2 `verifications` key is read into `evaluations`, so an older project keeps its
ledger.

## Metric rules in force

`DEFAULT_MULTIPLIERS` (per-metric override through `baselines.multipliers`):

| Metric | Multiplier | Metric | Multiplier |
|---|---|---|---|
| `clickRate` | 0.8 | `firstSubscription` | 0.75 |
| `readThrough3` | 0.8 | `averageSubscription` | 0.75 |
| `followRead10` | 0.7 | `collectToSubscribe` | 0.8 |
| `followRead24h` | 0.75 | `followSubscription` | 0.75 |
| `retention7d` | 0.8 | `subscription24h` | 0.75 |
| `favoriteRate` | 0.8 | `completionRate` | 0.8 |
| `retention` | 0.8 | `adUnlock` | 0.8 |
| `averageReadPerChapter` | 0.8 | `chapterScore` | 0.6 |

A threshold exists only when a median exists: `thresholdFor(metric) = medians[metric] ×
(multipliers[metric] ?? DEFAULT_MULTIPLIERS[metric] ?? 0.8)`. A reading against an uncalibrated
metric is reported as "无法比较" and never blocks a pass — but `calibrationAge` flags a
calibration older than 30 days, and `novel_assess` warns when there is none.

`iterationRules` renders the SOP's quantified table as `key` → action + scope:
`rewrite-opening` (chapter), `change-naming` (chapter), `tighten-hooks` (chapter),
`accelerate-volume` (volume, only when a follow metric fails *and*
`decliningStreak` has reached `SUSTAINED_DECLINE_CHAPTERS = 5`),
`rework-volume` (volume), `revisit-concept` (whole-book, ≥ 2 core metrics failing),
`cut-losses` (whole-book, `INEFFECTIVE_ITERATIONS_FOR_CUT = 2` ineffective iterations *and* a
failing core metric).

Two places where the code and the SOP's wording differ on purpose, both worth knowing:

- a rule **label** quotes the SOP's own arithmetic (卷内均读 ×0.6) while the trigger line
  actually applied is the metric's calibrated multiplier — `averageReadPerChapter` defaults to
  0.8, so override `baselines.multipliers.averageReadPerChapter` to `0.6` if you want the SOP's
  volume rule literally. The cut-loss rule likewise fires on two ineffective iterations plus
  *any* failing core metric, not specifically ×0.5: the SOP's ×0.5 survives in the warning
  text, not in the comparison;
- the verdict boundary is not in the SOP, so `verdictFromAssessments` fixes it: no failure is
  `pass`, any failure without a *core* failure (`readThrough3`, `followRead10`, `clickRate`,
  `favoriteRate`) is `partial`, and a failing core metric is `fail`. `evaluationAction` maps
  those three onto the decision the author actually makes — `pass` → 继续投入, `partial` →
  换变量后继续, `fail` → 切书止损.

## Invariants a contributor must not break

1. **The core stays pure.** No I/O, no Cordis import, no wall clock in `src/core/`: the clock
   is a `Clock` parameter (`() => string`) with `systemClock` as the default. Patches never
   destroy unstated fields (`upsertChapter(state, { id, body })` keeps the title, contract and
   status), and derived data is never stored. If a rule needs the filesystem or the current
   time, it belongs in `host`.
2. **All state goes through the store, and content before metadata.** `NovelStore` is the
   only writer of a project: initialize with the `createIfAbsent` intent, mutate the metadata
   with `replaceIfVersion` carrying the version token read inside the write queue, and write
   derived output only through `writeDerived` (which `contain`s the path inside the workspace
   root by path arithmetic). Content files are written **before** the metadata document, so
   the index may lag but never dangles. Never compare timestamps or re-read-and-compare by
   hand — the backend's version token is exact and a hand-rolled guard cannot fire. A file
   that cannot be parsed is reported and left alone: no write path may overwrite one. Reads
   are not a source of truth — the files are — so nothing the author edited is ever
   shadowed.
3. **The browser bundle stays a `window.__ModuleLoader__.load({...})` CJS factory.** The
   registered `id` must equal the package name (`@ai-novelist/novelist-skill`), the emitted
   file must be `lib/client.js` (`outExtensions` overrides rolldown's `.cjs`), and React plus
   every `@deepseek-ai/*` package stay unbundled — the shell owns those module instances, and
   a second copy breaks plugin identity and hook state. `test/client-bundle.test.ts` executes
   the built artifact in a stubbed `window` to keep this honest.
4. **The prompt context text is resolved synchronously.** `SystemPrompt` calls
   `entry.text(context)` without awaiting, so the section must read `SnapshotCache.current()`
   and never touch the filesystem: no `await`, no throwing, no unbounded work in the render
   path. Boot primes the cache and every successful tool write refreshes it (`resync`); a
   failed refresh keeps the last good numbers and records the error.
5. **Tools resolve per execution, not per mount.** Every tool body asks the resolver for the
   store of `exec.agent?.session`, so two sessions in two novel directories never share
   state, and one `dsh web` serves many novels. `NovelStore` stays a plain class —
   `ctx.novelState` is the resolver and can be provided only once.
6. **The tools record and warn; they do not measure, judge or rewrite.** No metric is ever
   invented (a number exists only because a human or a platform reported it), the delivery
   report compares prose with its own plan rather than rating it, and no code path edits a
   published chapter. New behaviour that fabricates data or blocks an authorial decision
   belongs in a warning, not in an enforced write. The two exceptions are the author
   checkpoints themselves, and they are narrow: `novel_write` refuses prose without a signed
   premise or a written 写作风格, and `novel_confirm` refuses a layer that would be recorded as
   settled without the user's words.
7. **A browser surface decides visibility from data, not from a registry guess.** A
   `conversation.view` entry has to be registered for its component to run, so "is there a
   novel here?" is answered *inside* the component (render `null` for `status: 'none'`) and
   never by registering or disposing the entry as sessions change. The session's workspace
   root comes from the standard `useSessions` hook, because the shell already resolved it and
   a second derivation is how two answers start to disagree.

## Build and test

```sh
pnpm run build       # tsc → lib/index.js + lib/types/**; tsdown → lib/client.js
pnpm run typecheck   # tsc -p tsconfig.json (src + test, no emit)
pnpm test            # vitest run
pnpm run check       # all three, from the repo root: build → typecheck → test
```

The host build uses `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`, so
source imports `./x.ts` and emits `./x.js`. The profile loads `lib/`, which means a running
`dsh web` keeps serving the last built tools until `pnpm run build` runs again.
