/**
 * The SOP as data — the single source every other artifact is generated from.
 *
 * Two copies of a workflow drift. Before this module existed the nine-tool table
 * lived in `scripts/pack.mjs`, the model-facing wording lived here in `host/tools.ts`,
 * and the revision number lived in `docs/sop.md` — so the shipped `SKILL.md` announced
 * "SOP 3.3" beside a `references/sop.md` that said 3.5, and `architecture.md` said
 * "Eight tools" while nine were registered.
 *
 * Everything that describes the surface now comes from here:
 *
 * - `host/tools.ts` reads each tool's model-facing {@link SopTool.summary} — the text
 *   the model actually sees when it decides what to call;
 * - `scripts/pack.mjs` reads {@link TOOL_SURFACE} and {@link SOP_VERSION} to render the
 *   tables in `SKILL.md`, `INSTALL.md` and `references/tools.md`, and to split
 *   `docs/sop.md` into the per-phase references {@link SOP_PHASES} names.
 *
 * This module is pure data with no imports, so both the plugin bundle and the build
 * script can load it without a harness.
 *
 * @module @ai-novelist/novelist-skill/core/sop
 */

/**
 * The SOP revision this plugin implements.
 *
 * `docs/sop.md` carries the long-form workflow and is checked against this value by
 * `test/sop-spec.test.ts`, so the prose revision and the code revision cannot part ways.
 */
export const SOP_VERSION = '3.9'

/** One phase of the SOP, bound to the derived {@link ProjectStage} it belongs to. */
export interface SopPhase {
  /** The stage `assessStage` derives while the project sits in this phase. */
  readonly stage: string
  /** The Chinese ordinal the SOP uses in prose ("一" … "六"). */
  readonly ordinal: string
  /** The phase name. */
  readonly title: string
  /** What this phase is for, in one line. */
  readonly goal: string
  /**
   * The build-generated reference that teaches this phase.
   *
   * Loaded only when the project is actually in the phase, which is the point:
   * the full workflow is 600 lines, and an agent that reads all of it every step
   * spends its context on phases it is not in.
   */
  readonly reference: string
  /** The tools this phase uses. */
  readonly tools: readonly string[]
  /**
   * The operation that closes the phase, or `''` when the phase ends by moving on.
   *
   * This is what makes the phase a state machine rather than a heading: a phase
   * with a closer cannot be left until that closer has been recorded.
   */
  readonly closesWith: string
}

/**
 * The six phases, in SOP order.
 *
 * The order is load-bearing: {@link phaseIndexFor} ranks them, and the stage gate
 * refuses work that belongs to a phase the project has not reached.
 */
export const SOP_PHASES: readonly SopPhase[] = [
  {
    stage: 'planning',
    ordinal: '一',
    title: '策划',
    goal: '定赛道、定平台、定爆点、定基底',
    reference: 'references/phase-1-planning.md',
    tools: ['novel_init', 'novel_plan', 'novel_bible', 'novel_confirm'],
    closesWith: '',
  },
  {
    stage: 'opening-package',
    ordinal: '二',
    title: '开篇包',
    goal: '用最小成本做出够格做上线决策的开篇包',
    reference: 'references/phase-2-opening-package.md',
    tools: ['novel_plan'],
    closesWith: '',
  },
  {
    stage: 'opening-decision',
    ordinal: '三',
    title: '上线决策',
    goal: '对开篇包做一次由人负责的 go / 改后再说 / 放弃',
    reference: 'references/phase-3-launch-decision.md',
    tools: ['novel_plan'],
    closesWith: 'launch',
  },
  {
    stage: 'full-outline',
    ordinal: '四',
    title: '完整大纲',
    goal: '搭防崩、防卡文、防烂尾的完整骨架',
    reference: 'references/phase-4-full-outline.md',
    tools: ['novel_plan', 'novel_bible', 'novel_confirm'],
    closesWith: '',
  },
  {
    stage: 'serializing',
    ordinal: '五',
    title: '连载创作与放大',
    goal: '稳定量产 + 按需数据评估 + 放大爆款',
    reference: 'references/phase-5-serial.md',
    tools: ['novel_write', 'novel_assess', 'novel_status'],
    closesWith: '',
  },
  {
    stage: 'completed',
    ordinal: '六',
    title: '复盘与 IP 闭环',
    goal: '完本沉淀 + IP 素材 + 下本复用',
    reference: 'references/phase-6-retrospective.md',
    tools: ['novel_repo', 'novel_review'],
    closesWith: 'retro',
  },
]

/** One tool of the model-facing surface. */
export interface SopTool {
  /** The registered tool name. */
  readonly name: string
  /** The SOP phase column, as the tables spell it. */
  readonly phase: string
  /**
   * The parameter that carries the mode, or `''` when the tool has none.
   *
   * Most tools discriminate on `operation`, but not all do — `novel_bible` uses
   * `kind` and `novel_status` uses `detail`. Naming it here is what lets
   * `test/sop-spec.test.ts` compare {@link operations} against the schema the
   * plugin actually registers instead of against a convention some tools ignore.
   */
  readonly selector: string
  /** The values {@link selector} accepts; empty when the tool takes none. */
  readonly operations: readonly string[]
  /** One line for the generated tables. */
  readonly purpose: string
  /**
   * The complete model-facing description.
   *
   * This is the tool's user interface: it is where the model learns the ordering,
   * the "plan is not prose" distinction, and the "send the complete body" rule, so
   * it is written as prose and kept whole rather than summarised for the tables.
   */
  readonly summary: string
}

/**
 * The nine tools, keyed by name.
 *
 * The key order is the registration order and the order every generated table uses.
 */
export const TOOL_SURFACE = {
  novel_init: {
    name: "novel_init",
    phase: "一 策划",
    operations: [],
    selector: "",
    purpose: "project, commercial frame, calibration medians, the length plan (总字数 / 单章字数 / 卷数, asked of the user), naming candidates",
    summary:
        'Establish or complete the novel project in this workspace: premise, commercial frame (platform, mode, audience, '
        + 'genre, target readers, monetization), the calibration medians every later metric is compared against, and the '
        + 'writing parameters (outline window, opening gate chapters, stock target, outline ceiling). '
        + 'The length numbers — targetWords, chapterWords and volumes — are NOT yours to invent: ask the user for all '
        + 'three before or while calling this tool (offer LENGTH_BENCHMARKS-style tiers as choices), and pass what they '
        + 'said. Missing answers are recorded, reported back as a checklist, and repeated by the runtime context every '
        + 'step until they are settled. totalChapters is derived from targetWords ÷ chapterWords when the user does not '
        + 'state it. '
        + 'Call it once at the start, and again whenever the commercial frame changes — it never resets recorded work, and '
        + 'it refuses to overwrite a premise that already exists (use novel_plan operation="pitch" for that). '
        + 'What it records is a DRAFT for the user to react to, not a settled setup: after it, put the premise, cast, world '
        + 'rules and length plan in front of them, revise over recorded rounds (novel_confirm kind="settings"), and write '
        + 'no prose until they confirm. '
        + 'The baselines are the load-bearing part: without same-genre medians over the last 30 days, the SOP threshold '
        + 'rules cannot run and every metric verdict becomes "无法比较".',
  },
  novel_confirm: {
    name: "novel_confirm",
    phase: "一/五",
    operations: ["status", "discuss", "confirm"],
    selector: "operation",
    purpose: "the author checkpoints, with the settings settled one layer at a time in order (立意 → 世界观 → 人物设定 → 全书大纲（含写作风格）→ 分卷大纲), and the 文风复核 after the golden three chapters: a later layer is refused while an earlier one is open, `discuss` records one round carrying the user's own words (two rounds before the premise can be confirmed, one per later layer), and `confirm` needs both the approved summary and the author's own words in `note`",
    summary:
        'The author checkpoints, and the record of the conversation that closes them. SETTINGS ARE SETTLED ONE LAYER AT '
        + 'A TIME, IN ORDER — 立意 (kind="settings" / "premise") → 世界观 (kind="world") → 人物设定 (kind="cast") → '
        + '全书大纲 (kind="outline") → 分卷大纲 (kind="volume"). Put ONE layer in front of the user, record what they '
        + 'said, have them confirm it, and only then start the next: a later layer is refused while an earlier one is '
        + 'still open, because handing the user the whole setup at once is the failure this ordering exists to prevent. '
        + 'kind="settings" is the pre-prose checkpoint (premise, memorable point, length plan, tone) and `novel_write` '
        + 'refuses a chapter while it is missing; the layers after it are ordered but do not block chapter 1 — with one '
        + 'exception: the 写作风格 block belongs to the 全书大纲 layer, and `novel_write` refuses prose while any of its '
        + 'seven elements is empty, because a voice chosen while writing chapter 1 is a voice the author never got to '
        + 'steer. The 全书大纲 layer therefore cannot be confirmed either until that block is written. '
        + 'kind="style" is the 文风复核 (review of the voice), due once the golden three chapters (第 1–3 章) have prose: '
        + 'hand those chapters to the user and ask whether 文风/表达方式/遣词用句 need adjusting — if they do, write the '
        + 'adjustment back into the outline and revise the affected chapters first — then record the round and confirm. '
        + '`novel_write` refuses chapter 4 onward until that review is closed. '
        + 'operation="discuss" records ONE round: what you put in front of the user (`proposal`) and what the user actually '
        + 'answered (`feedback`). `feedback` is required and cannot be your own summary of the plan — a round without the '
        + 'user\'s words is refused, because that is exactly the failure this tool exists to prevent: the model deciding the '
        + 'setup alone and running on to chapters. The premise layer needs at least 2 such rounds before it can be '
        + 'confirmed; every other layer, and the voice review, needs 1. operation="confirm" records the author\'s sign-off '
        + 'with the approved `summary` and the user\'s own words in `note` — both required, because only the author can '
        + 'close a checkpoint: never confirm on their behalf, and never invent a round. operation="status" (default) '
        + 'reports where every layer stands, and which one is next, without changing anything.',
  },
  novel_plan: {
    name: "novel_plan",
    phase: "一/二/三/四",
    operations: ["competitor", "pitch", "world", "cheat", "outline", "volume", "chapter", "beat", "opening", "naming", "launch"],
    selector: "operation",
    purpose: "the planning pipeline, soft-gated: it never refuses a call, it reports what the SOP still wants. Competitor dismantles land in `竞品拆解.md`; the traditional 六要素 (`storyTime`…`storyResult`) and the 金手指 (`operation=\"cheat\"`) get named blocks in `全书大纲.md`; 世界观 carries parent/level/volume for a layered map; every chapter carries a time anchor and a place; the 写作风格 block is the prose gate; `launch` records the stage-three go/no-go",
    summary:
        'The planning pipeline, in the SOP order. One operation per step; each feeds the next, and the tool reports what '
        + 'is still missing. '
        + 'competitor=dismantle one same-genre leaderboard title (aim for 20–50) — every dismantle is written into '
        + '竞品拆解.md, the file beside the other settings, so the author can read and reuse the research '
        + '(每个字段都可写入：tags/blurb/openingEvent/goldenFinger/protagonistDesire/antagonistMotive/shuangFrequency/'
        + 'emotionCurve/paywallPoint/chapterHooks/commentKeywords/takeaway) · pitch=the one-sentence memorable point '
        + 'plus core emotion, payoff list, differentiators, kernel · world=one world fact (a rule without its cost and '
        + 'limit is flagged; a place/faction/item/history only needs its detail). A world fact can name its `parent`, '
        + 'its `level` (1 凡界/外门, 2 宗门/一城, 3 灵界 …), the `volume` it first becomes available in, and its '
        + '`relations` — that is what makes 分层世界观 answerable · cheat=the protagonist\'s 金手指: name, owner, rule, '
        + 'cost, limits, growth curve, first reveal chapter (a cheat with no price or ceiling is flagged) · '
        + 'outline=logline, the traditional 六要素 (storyTime=时间, storyPlace=地点, storyCause=起因, '
        + 'storyProcess=经过, storyResult=结果; 人物 is the cast), the narrative spine (synopsis=整本书的故事, 主角成长线, '
        + '伙伴成长线, 反派成长线, 阵营演变, 对抗副本, 失去了什么, 获得了什么), the 写作风格 block (styleTone=文风基调, '
        + 'stylePerspective=人称与视角, styleRhythm=句式与节奏, styleDiction=遣词用句, styleDialogue=对话与描写, '
        + 'styleEmotion=情绪与爽点落点, styleTaboos=负面清单 — all seven are the prose gate), the fullOutline skeleton, '
        + 'acts, the minimal viable outline, or the full outline flag · volume=one volume, in the same order (本卷梗概, '
        + '主角成长, 反派成长, 阵营演变, 核心对抗, 代价与失去, 收获与获得), then its goal, conflict, climax, end hook and '
        + '卷内节奏 detail · chapter=one chapter contract (plot task, time anchor, place, key turn, price paid, conflict, '
        + 'emotional payoff, information gap, beats, hook, target length) — the target is the finished length, and the '
        + 'chapter is drafted at 125% of it · beat=place a rhythm beat (cadence gaps and beat/contract conflicts are '
        + 'reported) · opening=confirm an opening-engineering checklist item (omit `key` to list it) · naming=a candidate '
        + 'title/blurb/tag set · launch=the stage-three go/no-go: whether the opening package is worth building out into '
        + 'a full skeleton. '
        + 'launch is a declared judgement, not a computed number — the evidence at that point is an editor and a handful '
        + 'of readers. A verdict that is not `go` must name where to fall back to (`fallback`) and what would make you '
        + 'drop the concept (`abandonIf`); the tool refuses it otherwise, because that requirement is what stops the '
        + 'decision from becoming a formality. Platform numbers are never required here: the data check is '
        + '`novel_assess`, run on demand. '
        + 'AT EVERY OUTLINE LAYER THE ORDER OF BUSINESS IS FIXED: (1) tell the whole story — 六要素, 梗概, 成长线, 阵营, '
        + '对抗副本, 得失; (2) write the 写作风格 the story is told in; (3) say the 爽点/爆点 clearly and place them; '
        + '(4) only then check the length. 体量是叙事完整性之上的要求，不是它的替代：'
        + 'a layer whose narrative spine is incomplete is reported as incomplete before its word count is compared with the '
        + 'ratio target, and a long outline does not pass by being long. Write the spine first, then the style, then the '
        + 'beats, then look at '
        + 'the length line the tool prints for that layer (全书大纲 ≈ 总字数/100, 分卷大纲 ≈ 本卷字数/50, 章节大纲 ≈ 单章字数/5). '
        + 'Soft gate: a call always succeeds, but when the SOP would not have you here yet the result carries warnings '
        + 'naming what is still missing. Read them before writing prose. '
        + 'THE SETTINGS ARE SETTLED ONE LAYER AT A TIME, IN ORDER: 世界观 → 人物设定 → 全书大纲 → 分卷大纲. Write a layer, '
        + 'put it to the user, record their answer with novel_confirm operation="discuss", and have them confirm it '
        + '(operation="confirm") before starting the next layer — the tool warns when a layer is written before the one '
        + 'before it is confirmed, because a whole setup decided in one pass is the failure this ordering exists to '
        + 'prevent. novel_write refuses prose until the premise layer is confirmed and the 写作风格 block is written.',
  },
  novel_bible: {
    name: "novel_bible",
    phase: "一/四/六",
    operations: ["character", "world", "link", "review"],
    selector: "kind",
    purpose: "cast, world facts, reader promises, and their review. A cast entry's `scope` sets what it owes — main (主角/反派/核心伙伴) the full spine, volume (本卷/本地图反复出现或有台词) 身份+欲望+性格+说话方式, cameo (一次性路人) only 「他是谁 + 首次出场章」; the review names the thin ones by tier and keeps walk-ons out of the debt",
    summary:
        'The story bible: cast, world facts, and reader promises. '
        + 'kind="character" takes a `scope` that decides what the entry owes. main（主角/反派/核心伙伴）要全 spine：role、'
        + 'goal、personality（性格底色与压力下的反应）、voice（说话方式：句长、口头禅、称呼、情绪怎么外化），另加 fear、'
        + 'obsession、weakness 与 growthArc。volume（一张地图/一卷内反复出现，或有台词的配角）只要 role、goal、personality、'
        + 'voice——有台词的人没有说话方式，一场对话就是一个人换几个名字在说；不要求成长线，因为给每个配角编弧光只会写出填充。'
        + 'cameo（一次性路人）只要一句「他是谁」与 firstAppearance 首次出场章：路人是**登记**，不是人物小传，'
        + '所以不计入人物欠账。省略 scope 时按 role 判：主角型算 main，其余算 volume（即旧版行为）。'
        + '可选 volume / exit 让「第 N 卷有哪些人」与「谁已经死了」查得到。 '
        + 'kind="world" states a fact with its cost and limits. Only rule-shaped kinds (rule, power-system) owe a price '
        + 'and a ceiling; a place, faction, item or historical event owes its detail. A world fact can name its `parent` '
        + '(the region/sect that contains it), its `level` (1 凡界/外门, 2 宗门/一城, 3 灵界 …), the `volume` it first becomes '
        + 'available in, and its `relations` — that is the layered world, and `kind="review"` reports a dangling parent '
        + 'or an unknown kind. '
        + 'kind="character" also takes `relations` (盟友/宿敌/师徒/旧识): the main cast is asked for it, but an empty one is '
        + 'reported as information rather than debt. '
        + 'kind="link" records a promise the reader is now waiting on: plant it, give it a due chapter, say how it pays '
        + 'off. Promises are what the SOP closes at volume end — an open promise whose due chapter is already written is '
        + 'reported as overdue. '
        + 'kind="review" reports every gap across the bible: the traditional 六要素 (时间/地点/人物/起因/经过/结果), the '
        + '金手指 fields, missing traits tier by tier (角色不够丰满 is reported character by character, and a walk-on '
        + 'register that is incomplete is reported separately, never as debt), rules without a price, world entries whose '
        + 'parent/kind does not resolve, and unrecovered or overdue promises. It also names a `scope` that is not one of '
        + 'the three values rather than guessing at it.',
  },
  novel_assess: {
    name: "novel_assess",
    phase: "五 按需",
    operations: ["record", "iterate", "evaluate", "outcome", "history", "rules"],
    selector: "operation",
    purpose: "the on-demand investment evaluation: readings in, verdict out; it owns no phase and gates nothing. `evaluate` back-fills every open change, refuses to judge a reading with no comparable median, and must leave a next appointment; a non-passing evaluation must name its fallback and abandon condition",
    summary:
        'The on-demand investment evaluation: "is this book still worth continuing?" '
        + 'It is deliberately NOT part of the pipeline. No stage waits for it, the project advances whether or not the '
        + 'platform numbers exist yet, and nothing here is ever a gate — which is what makes it usable in the common '
        + 'case where the data lives on the platform and has to be transcribed by hand. '
        + 'Run it when the author asks that question, normally after the book has been live long enough to report '
        + 'something. '
        + 'operation="record" stores one reading (period, chapter position, values) and immediately reports which '
        + 'threshold rules fire, each with its action and the scope it may reach (chapter / volume / whole-book). '
        + 'operation="iterate" writes the change you decided on into the ledger, tied to the reading that triggered it. '
        + 'operation="evaluate" runs the session: it compares the reading against the calibrated same-genre medians, '
        + 'back-fills the result of every earlier change against this reading, and returns the verdict — 继续投入 / '
        + '换变量后继续 / 切书止损 — with the rules that fired. '
        + 'An evaluation that does not pass must name where to fall back to (`fallback`) and what would make you stop '
        + '(`abandonIf`), and every evaluation must leave an appointment for the next one (`nextAtChapter` and/or '
        + '`nextTrigger`): without that appointment an on-demand check quietly turns into no check at all. '
        + 'record and evaluate also accept `baselines` to re-calibrate the medians while you are already on the platform '
        + 'copying numbers — they are a 30-day figure, so the moment of evaluation is the right moment to refresh them. '
        + 'operation="history" lists every evaluation with its verdict, fallback, abandon condition and next appointment; '
        + 'operation="rules" prints the thresholds currently in force. '
        + 'operation="outcome" is the manual override for the automatic back-fill: name the `iterationId` and the '
        + '`outcomeReadingId` that closes it, and the tool reports whether that reading improved on the one the change '
        + 'started from. Use it when an adjustment should be judged against a reading `evaluate` did not pick — an '
        + 'earlier one, or one recorded after the evaluation ran. '
        + 'The numbers come from the platform or from readers; the tool compares and decides, it never invents a value.',
  },
  novel_write: {
    name: "novel_write",
    phase: "五 连载",
    operations: ["write", "read", "check"],
    selector: "operation",
    purpose: "prose, the contract-delivery report, and the automatic 去 AI 化 statistics. The one hard gate in the pipeline: it refuses to write until the user has signed the premise layer off and the outline's 写作风格 is written, and — after the golden three chapters — until the user has reviewed the voice",
    summary:
        'Write or revise one chapter of prose against its outline contract. '
        + 'This is the ONE tool with a hard gate: it refuses to write while the user has not confirmed the settings '
        + '(novel_confirm kind="settings"), while the 写作风格 block of the 全书大纲 is not written out '
        + '(novel_plan operation="outline" styleTone=… stylePerspective=… styleRhythm=… styleDiction=… styleDialogue=… '
        + 'styleEmotion=… styleTaboos=…), and — once the golden three chapters (第 1–3 章) have prose — while the user has '
        + 'not reviewed the voice (novel_confirm kind="style"): 黄金三章之后把正文交给用户读，'
        + '问清表达方式与遣词用句要不要调整，要调就先改风格与已写章节，再确认，之后才写第 4 章。 '
        + 'The user\'s inspiration is the starting point of a conversation, not a licence to '
        + 'produce chapters: settle the setup with them first, and do not write chapter 1 with a voice nobody has seen. '
        + 'The refusal message names the calls that open the gate. '
        + 'Send the COMPLETE chapter text — this replaces the body, it does not append. '
        + 'A first draft is written to 125% of the chapter\'s target length, because 去 AI 化 and hand-editing delete a '
        + 'large share of a draft; the finished chapter is then trimmed back to within -5%/+15% of the target the user '
        + 'gave — the shortfall is held to 5%, because a chapter noticeably under its promised length is the real '
        + 'failure, while an overrun can still be cut. This '
        + 'tool holds the draft to whichever gate the chapter\'s status implies (planned/drafting = 125%, revised/final = '
        + '-5%/+15%) and prints both windows. '
        + 'Report which contract fields the draft actually delivered (delivered=[...]); the tool compares that report '
        + 'with the plan and returns what was missed, what was never planned, and whether the length landed. That '
        + 'comparison is the SOP\'s "严格对应细纲" made checkable — it is the only place the workflow notices a chapter '
        + 'that quietly ignored its plan. It also reports the chapter\'s 时空锚点 (the contract\'s 时间/地点): a scene with '
        + 'no time and no place is a planning debt, not a broken contract, so it is named as a warning rather than '
        + 'refused. '
        + 'Marking a chapter final (published) still works but is warned when the contract or the delivery is incomplete. '
        + 'Both write and check also return the SOP\'s 去 AI 化 statistics — paragraph length, dialogue density, repeated '
        + 'sentence openings — as countable symptoms and never as a verdict. Nothing here edits the prose: revise the '
        + 'draft yourself and send it back through operation="write". '
        + 'operation="read" returns one chapter with its contract and prose; operation="check" returns the delivery report '
        + 'and the same statistics without writing anything.',
  },
  novel_status: {
    name: "novel_status",
    phase: "全流程",
    operations: ["dashboard", "bible", "plan", "chapter", "craft"],
    selector: "detail",
    purpose: "the derived SOP dashboard, plus the writing-craft sheets",
    summary:
        'The SOP dashboard, entirely derived from the project — nothing here is a second ledger you maintain by hand. '
        + 'Reports the stage, what the next phase still needs, the two author checkpoints (设定确认 / 文风复核), chapter and '
        + 'word counts, contract completeness, unpublished stock, promise recovery (including overdue), the 写作风格 block '
        + 'of the outline and the characters that are still thin, the latest reading '
        + 'against its thresholds, and iterations still waiting for an outcome. '
        + 'detail="dashboard" (default) is the operating view; "bible" returns cast, world and promises; "plan" returns '
        + 'pitch, outline, volumes, beats, opening checklist and naming candidates; "chapter" with a chapterId returns one '
        + 'chapter\'s contract, delivery report, the 去 AI 化 statistics and the prose; "craft" returns one writing-craft '
        + 'sheet (topic=platforms|hooks|payoffs|naming|voice|submission) or the index of them, for the "how it should read" '
        + 'questions the SOP\'s fields assume but cannot teach.',
  },
  novel_repo: {
    name: "novel_repo",
    phase: "六 复盘",
    operations: ["export", "submission", "retro", "asset", "lesson", "template"],
    selector: "operation",
    purpose: "retrospective, IP assets, reusable templates, manuscript and submission export",
    summary:
        'The SOP closing phase: manuscript and submission export, retrospective, IP assets, and reusable templates. '
        + 'operation="export" renders the whole novel to Markdown beside the project. '
        + 'operation="submission" assembles the package an editor asks for — work information, blurb slots, the first '
        + 'three chapters\' contracts and hooks, a pre-submission checklist and a submission log — from the project data; '
        + 'it does not write the blurb. '
        + 'operation="retro" writes the completion retrospective (highlights, problems) and derives the data summary, the '
        + 'IP asset list, and a structural template from the project data. '
        + 'operation="lesson" adds one reusable or avoid-this lesson; operation="asset" adds one IP-ready asset. '
        + 'operation="template" exports the structural skeleton on its own — acts, volume rhythm, beat pattern expressed as '
        + 'offsets inside a volume, hook patterns, emotional template. '
        + 'Templates deliberately carry no cast and no proper nouns: the SOP requires a variant upgrade next time, and a '
        + 'template that cannot carry characters cannot turn into a clone.',
  },
  novel_review: {
    name: "novel_review",
    phase: "五/六 判断",
    operations: ["ai-flavor", "opening", "competitor", "retro"],
    selector: "operation",
    purpose: "the one model-backed tool: prose judgement under a versioned rubric, recorded with the model that produced it — and the one that fans out, one child agent per competitor",
    summary:
        'Ask a model to judge the prose — the one tool here that does not compute. The other eight are deterministic: '
        + 'thresholds, gates and arithmetic, identical on every run. Judging whether writing reads as machine-made, '
        + 'whether an opening holds a reader, what a competitor is doing, and which lessons a finished book actually '
        + 'taught cannot be computed, and the SOP assigns it to judgement (§1.2). This tool asks for that judgement '
        + 'under a versioned rubric, and records the answer with the model and rubric version that produced it. '
        + 'operation="ai-flavor" diagnoses one chapter (add rewrite=true for a rewritten draft); "opening" reviews the '
        + 'gate chapters against the SOP opening checklist; "competitor" dismantles pasted competitor text; "retro" '
        + 'distils the project\'s own data into reusable lessons. '
        + 'The competitor study is the SOP\'s most parallel step, so "competitor" also takes targets=[{title, text}, …] '
        + 'and dismantles the whole batch in one call — one child agent per book wherever the profile registers a '
        + 'subagent provider, sequentially where it does not, either way merged and saved together, with one transcript '
        + 'and one ledger record per book. '
        + 'It never writes prose: a rewrite is a proposal saved beside the project, and only novel_write replaces a '
        + 'chapter. competitor/retro results are returned for inspection and are NOT saved unless you pass save=true. '
        + 'The route follows reviewProvider/reviewModel when configured, otherwise the model this session is using.',
  },
} as const satisfies Record<string, SopTool>

/** The tool names in surface order. */
export const TOOL_ORDER = Object.keys(TOOL_SURFACE) as readonly (keyof typeof TOOL_SURFACE)[]

/** One entry of {@link TOOL_ORDER}. */
export type ToolName = (typeof TOOL_ORDER)[number]

/**
 * The phase a derived stage belongs to, or `undefined` for an unknown stage.
 *
 * @param stage - the stage `assessStage` derived.
 * @returns the matching phase.
 */
export function phaseForStage(stage: string): SopPhase | undefined {
  return SOP_PHASES.find((phase) => phase.stage === stage)
}

/**
 * Rank a stage in SOP order, for comparisons like "has this phase been reached".
 *
 * @param stage - the stage to rank.
 * @returns the zero-based index, or `-1` when the stage is unknown.
 */
export function phaseIndexFor(stage: string): number {
  return SOP_PHASES.findIndex((phase) => phase.stage === stage)
}

/**
 * The tool names the surface must register, in order.
 *
 * `scripts/pack.mjs` asserts the built plugin really registers these, which is what
 * stops a partial `lib/` from shipping a table describing tools that are not there.
 */
export const EXPECTED_TOOLS: readonly string[] = [...TOOL_ORDER]
