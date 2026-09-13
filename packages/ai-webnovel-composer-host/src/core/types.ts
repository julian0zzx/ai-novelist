/**
 * Domain vocabulary of the AI Web Novel Composer, as of schema version 2.
 *
 * Version 2 exists because the SOP this plugin implements is a *pipeline with
 * gates*, not a notebook: the phase you are in, the evidence that let you enter
 * it, the commitments you made to readers, and the numbers you promised to
 * watch all have to be data. Version 1 held a premise, a cast, and chapters;
 * everything else lived in prose and was forgotten.
 *
 * Conventions used throughout:
 *
 * - Every field is plain lossless JSON: no `Map`, no `Date`, no class instance,
 *   because the browser half and the harness session log both read these.
 * - Optional means "not recorded yet", never "empty".
 * - Anything derivable (word counts, stock, gate status) is **not** stored; it is
 *   computed on read so it cannot go stale.
 *
 * @module @ai-webnovel/composer-host/core/types
 */

/** On-disk schema version written by this build. */
export const NOVEL_SCHEMA_VERSION = 2 as const

/** Lifecycle of one chapter from plan to frozen prose. */
export const CHAPTER_STATUSES = ['planned', 'drafting', 'revised', 'final'] as const

/** One entry of {@link CHAPTER_STATUSES}. */
export type ChapterStatus = (typeof CHAPTER_STATUSES)[number]

/** Commercial model the novel is written for. */
export const PLATFORM_MODES = ['paid', 'free', 'unknown'] as const

/** One entry of {@link PLATFORM_MODES}. */
export type PlatformMode = (typeof PLATFORM_MODES)[number]

/** Reader channel. */
export const PLATFORM_AUDIENCES = ['male', 'female', 'general'] as const

/** One entry of {@link PLATFORM_AUDIENCES}. */
export type PlatformAudience = (typeof PLATFORM_AUDIENCES)[number]

/** The pipeline phases of the SOP, in order. */
export const PROJECT_STAGES = [
  'planning',
  'verification-prep',
  'verifying',
  'full-outline',
  'serializing',
  'completed',
] as const

/** One entry of {@link PROJECT_STAGES}. */
export type ProjectStage = (typeof PROJECT_STAGES)[number]

/** Metric families: which period of the release a reading belongs to. */
export const METRIC_PERIODS = ['new-book', 'paid', 'free'] as const

/** One entry of {@link METRIC_PERIODS}. */
export type MetricPeriod = (typeof METRIC_PERIODS)[number]

/** The metric keys the SOP watches, by period. */
export const METRIC_KEYS = [
  // new-book period
  'clickRate',
  'readThrough3',
  'followRead10',
  'followRead24h',
  'retention7d',
  'favoriteRate',
  // paid period
  'firstSubscription',
  'averageSubscription',
  'collectToSubscribe',
  'followSubscription',
  'subscription24h',
  // free period
  'completionRate',
  'retention',
  'adUnlock',
  'averageReadPerChapter',
  // author-reported quality signal, 0-100, used by the iteration rules
  'chapterScore',
] as const

/** One entry of {@link METRIC_KEYS}. */
export type MetricKey = (typeof METRIC_KEYS)[number]

/** Lifecycle of one foreshadowing or hook promise. */
export const LINK_STATUSES = ['open', 'paid', 'abandoned'] as const

/** One entry of {@link LINK_STATUSES}. */
export type LinkStatus = (typeof LINK_STATUSES)[number]

/** Outcome of one validation round. */
export const VERDICT_LEVELS = ['pass', 'partial', 'fail'] as const

/** One entry of {@link VERDICT_LEVELS}. */
export type VerdictLevel = (typeof VERDICT_LEVELS)[number]

/** How wide a revision or iteration is allowed to reach. */
export const CHANGE_SCOPES = ['chapter', 'volume', 'whole-book'] as const

/** One entry of {@link CHANGE_SCOPES}. */
export type ChangeScope = (typeof CHANGE_SCOPES)[number]

/** Beat kinds the SOP asks a chapter to carry. */
export const BEAT_KINDS = ['shuang', 'sweet', 'burn', 'tension', 'info', 'turn'] as const

/** One entry of {@link BEAT_KINDS}. */
export type BeatKind = (typeof BEAT_KINDS)[number]

/** The planning fields every chapter contract must answer. */
export const CONTRACT_FIELDS = [
  'plotTask',
  'conflict',
  'emotionalPayoff',
  'infoGap',
  'beats',
  'hook',
] as const

/** One entry of {@link CONTRACT_FIELDS}. */
export type ContractField = (typeof CONTRACT_FIELDS)[number]

// ── the project's commercial frame ────────────────────────────────────────────

/** Where the novel is published and how it earns. */
export interface PlatformProfile {
  /** Platform name, for example `qidian`, `fanqie`, `jinjiang`. */
  readonly name: string
  /** Commercial model the plan targets. */
  readonly mode: PlatformMode
  /** Reader channel. */
  readonly audience: PlatformAudience
  /** Genre and sub-genre tags as the platform spells them. */
  readonly genres: readonly string[]
  /** One line on who the target reader is. */
  readonly readers: string
  /** How the novel is expected to earn, in the author's words. */
  readonly monetization: string
}

/** One of the 3–5 candidate title/blurb/tag sets the SOP requires. */
export interface NamingCandidate {
  /** Stable id for referencing the candidate in verification rounds. */
  readonly id: string
  /** Candidate title. */
  readonly title: string
  /** Candidate blurb. */
  readonly blurb: string
  /** Candidate tags. */
  readonly tags: readonly string[]
  /** Why this set is expected to work. */
  readonly rationale: string
  /** Whether this set is the one currently published. */
  readonly active: boolean
}

/** Platform-calibrated medians a reading is compared against. */
export interface MetricBaselines {
  /**
   * Same-genre median per metric, as recorded from the platform's leaderboard
   * over the last 30 days. A metric with no baseline cannot be assessed — the
   * SOP's multipliers are meaningless without one.
   */
  readonly medians: Readonly<Partial<Record<MetricKey, number>>>
  /**
   * Per-metric override of the default threshold multiplier. Only metrics that
   * need a different trigger line belong here.
   */
  readonly multipliers: Readonly<Partial<Record<MetricKey, number>>>
  /** When the medians were read, so a stale calibration is visible. */
  readonly calibratedAt: string
  /** Where the numbers came from: the leaderboard, an editor, a cohort. */
  readonly source: string
}

/** The writing plan's operating parameters, one meaning each. */
export interface WritingPlan {
  /** Prose language. */
  readonly language: string
  /** Point of view. */
  readonly pov: string
  /** Planned volumes, 0 when undecided. */
  readonly volumes: number
  /** Planned total chapters, 0 when undecided. */
  readonly totalChapters: number
  /** Target total length in characters, 0 when undecided. */
  readonly targetWords: number
  /** Chapters of detailed outline kept ahead of the prose (the outline window). */
  readonly chapterPlanWindow: number
  /** Chapter positions the platform's opening metrics are read at. */
  readonly openingGateChapters: readonly number[]
  /** Chapters of unpublished prose to hold in stock. */
  readonly stockTargetChapters: number
  /** Hard ceiling on how far the rolling outline may run ahead. */
  readonly chapterPlanCeiling: number
  /** Update rhythm in the author's words, for example `daily-2`. */
  readonly updateRhythm: string
}

// ── story data ────────────────────────────────────────────────────────────────

/** The novel's premise, held verbatim so later chapters can re-read it. */
export interface NovelMeta {
  /** Working title. */
  readonly title: string
  /** One-paragraph premise. */
  readonly premise: string
  /** Genre and tone tags, free-form. */
  readonly genres: readonly string[]
  /** Point of view, for example `third-limited`. */
  readonly pov: string
  /** Language the prose is written in. */
  readonly language: string
}

/**
 * The one-sentence hook, the emotional promise, and the differentiators.
 *
 * {@link Premise.memorablePoint} is stored rather than remembered because three
 * separate SOP steps read it back: the pitch, the metrics diagnosis when clicks
 * are bad, and the validation verdict's "can a reader state what this novel is".
 */
export interface Premise {
  /** `protagonist + world + obsession + ability + opposition + emotion`, one sentence. */
  readonly memorablePoint: string
  /** What the reader comes for: the core emotional payoff. */
  readonly coreEmotion: string
  /** The payoff pattern, in the author's words. */
  readonly shuangPoints: readonly string[]
  /** How this differs from the comparable titles. */
  readonly differentiators: readonly string[]
  /** The theme the novel is actually about underneath the plot. */
  readonly kernel: string
}

/** One dismantled comparable title from the leaderboard. */
export interface Competitor {
  /** Stable id, usually a slug of the title. */
  readonly id: string
  /** Title as published. */
  readonly title: string
  /** Platform tags. */
  readonly tags: readonly string[]
  /** The blurb, verbatim (it is the marketing artifact being studied). */
  readonly blurb: string
  /** The event the first chapter opens on. */
  readonly openingEvent: string
  /** The cheat or edge the protagonist gets. */
  readonly goldenFinger: string
  /** What the protagonist wants. */
  readonly protagonistDesire: string
  /** Why the antagonist opposes them. */
  readonly antagonistMotive: string
  /** How often a payoff lands, for example `每章`, `每3章`. */
  readonly shuangFrequency: string
  /** The emotional curve, in the author's words. */
  readonly emotionCurve: string
  /** Where the paywall or ramp lands. */
  readonly paywallPoint: string
  /** Hook patterns used at chapter ends. */
  readonly chapterHooks: string
  /** High-frequency words in the comment section. */
  readonly commentKeywords: readonly string[]
  /** What is reusable from this book. */
  readonly takeaway: string
}

/** A person in the story, with the facts the prose must not contradict. */
export interface Character {
  /** Stable slug used to address the character everywhere. */
  readonly id: string
  /** Display name as it appears in prose. */
  readonly name: string
  /** Narrator-facing role, for example `protagonist` or `antagonist`. */
  readonly role: string
  /** Appearance, voice, habits, and anything else the prose must honor. */
  readonly description: string
  /** What this character wants; what drives their scenes. */
  readonly goal: string
  /** What they are afraid of, which is what makes them human. */
  readonly fear: string
  /** The obsession that makes them act against their own interest. */
  readonly obsession: string
  /** The weakness an opponent can press. */
  readonly weakness: string
  /** Which side they are on, for example `protagonist-camp`, `rival`, `neutral`. */
  readonly camp: string
  /** Arc across the novel, one line per stage when known. */
  readonly growthArc: string
  /** Free-form continuity notes; append-only by convention. */
  readonly notes: string
}

/** A setting fact the novel must keep consistent. */
export interface WorldEntry {
  /** Stable slug for the entry, for example `sect-qingyun`. */
  readonly id: string
  /** Kind of fact: `place`, `faction`, `power-system`, `item`, `history`, `rule`. */
  readonly kind: string
  /** Entry name as it appears in prose. */
  readonly name: string
  /** The fact itself, stated precisely enough to be contradicted. */
  readonly detail: string
  /**
   * What this rule costs or forbids. The SOP insists a power system is defined
   * by its price and limits, not its abilities; an entry without this is flagged
   * in the world review.
   */
  readonly cost: string
  /** What it cannot do. */
  readonly limits: string
}

/**
 * One promise made to the reader: a planted foreshadowing, a mystery, or a hook.
 *
 * The SOP requires a recovery plan at plant time and a closing check at volume
 * end; without status and a target chapter, an open promise can silently cross
 * volumes, which is the failure this record exists to prevent.
 */
export interface StoryLink {
  /** Stable slug. */
  readonly id: string
  /** The promise as planted, in prose terms. */
  readonly note: string
  /** Which kind: `foreshadow`, `mystery`, `hook`, `promise`. */
  readonly kind: string
  /** Chapter id or number it is planted in; empty when not yet planted. */
  readonly plantedAt: string
  /** Chapter id or number it must pay off by; empty when undecided. */
  readonly dueAt: string
  /** How it is intended to pay off. */
  readonly payoff: string
  /** Current state. */
  readonly status: LinkStatus
  /** Volume number the payoff belongs to, 0 when unknown. */
  readonly volume: number
}

// ── the plan ──────────────────────────────────────────────────────────────────

/** One volume of the outline. */
export interface VolumePlan {
  /** 1-based volume number. */
  readonly number: number
  /** Working title. */
  readonly title: string
  /** What this volume must accomplish on its own. */
  readonly goal: string
  /** The conflict that carries the volume. */
  readonly conflict: string
  /** The volume's own climax. */
  readonly climax: string
  /** The hook that closes the volume. */
  readonly endHook: string
  /** Chapter numbers this volume spans, inclusive; empty when open. */
  readonly chapters: readonly number[]
}

/** A beat placed at a chapter position, for the rhythm table. */
export interface BeatSlot {
  /** 1-based chapter number the beat lands on. */
  readonly chapter: number
  /** What kind of beat it is. */
  readonly kind: BeatKind
  /** One line on what happens. */
  readonly note: string
}

/** One item of the opening-engineering checklist. */
export interface OpeningCheck {
  /** Stable key, for example `first-300-words-conflict`. */
  readonly key: string
  /** What the SOP requires, in one line. */
  readonly requirement: string
  /** Whether the author has confirmed it holds. */
  readonly done: boolean
  /** Evidence or note when confirmed. */
  readonly note: string
}

/** The rolling outline: the premise-level shape plus per-chapter contracts. */
export interface Outline {
  /** One-sentence story. */
  readonly logline: string
  /** Act structure in the author's words, one entry per act. */
  readonly acts: readonly string[]
  /** The minimal viable outline's one-screen summary. */
  readonly minimal: string
  /** Volume plans in reading order. */
  readonly volumes: readonly VolumePlan[]
  /** The rhythm table. */
  readonly beats: readonly BeatSlot[]
  /** Opening-engineering checklist. */
  readonly opening: readonly OpeningCheck[]
  /** Whether the author has confirmed the full-outline stage. */
  readonly fullOutlineDone: boolean
}

/**
 * The contract one chapter owes the reader, and the prose that pays it.
 *
 * The SOP's fields are mandatory for a *planned* chapter; prose may be written
 * against a half-filled contract, but `novel_write` reports which fields were
 * never answered instead of pretending the chapter is planned.
 */
export interface Chapter {
  /** Stable slug used to address the chapter everywhere. */
  readonly id: string
  /** 1-based position in reading order. */
  readonly number: number
  /** Working title; may be empty while the chapter is only a plan. */
  readonly title: string
  /** Total of the contract below, for a one-line read. */
  readonly synopsis: string
  /** Current lifecycle stage. */
  readonly status: ChapterStatus
  /** Prose body. Empty until written. */
  readonly body: string
  /** Character count of {@link body}, refreshed on every write. */
  readonly wordCount: number
  /** ISO-8601 timestamp of the last write to this chapter. */
  readonly updatedAt: string
  /** Volume this chapter belongs to, 0 when not yet assigned. */
  readonly volume: number
  /** What this chapter must accomplish. */
  readonly plotTask: string
  /** The conflict that carries the chapter. */
  readonly conflict: string
  /** What the reader gets emotionally. */
  readonly emotionalPayoff: string
  /** The information gap the chapter opens or closes. */
  readonly infoGap: string
  /** Beats this chapter carries. */
  readonly beats: readonly BeatKind[]
  /** The chapter-end hook. */
  readonly hook: string
  /** Target length in characters; 0 when unset. */
  readonly targetWords: number
  /** Contract fields the author explicitly waived, with the reason. */
  readonly waived: Readonly<Partial<Record<ContractField, string>>>
  /** Fields the last write reached, recorded by `novel_write`. */
  readonly delivered: readonly ContractField[]
}

// ── feedback: readings, iterations, validation ────────────────────────────────

/** One recorded reading of the platform metrics. */
export interface MetricReading {
  /** Stable id. */
  readonly id: string
  /** ISO-8601 instant the reading was taken. */
  readonly at: string
  /** Which period of the release it belongs to. */
  readonly period: MetricPeriod
  /** The chapter position the reading describes, 0 when not applicable. */
  readonly atChapter: number
  /** The values read, keyed by metric. */
  readonly values: Readonly<Partial<Record<MetricKey, number>>>
  /** Where the numbers came from. */
  readonly source: string
  /** Free-form observation, including comment-section words. */
  readonly note: string
}

/** One applied change, with the reading that triggered it and its result. */
export interface Iteration {
  /** Stable id. */
  readonly id: string
  /** ISO-8601 instant the change was decided. */
  readonly at: string
  /** The rule key that fired, or `manual`. */
  readonly trigger: string
  /** The threshold comparison that fired it, in words. */
  readonly evidence: string
  /** What was decided. */
  readonly action: string
  /** How far the change reaches. */
  readonly scope: ChangeScope
  /** The reading id this change is measured against. */
  readonly baselineReadingId: string
  /** The reading taken after the change, empty until filled. */
  readonly outcomeReadingId: string
  /** Whether the change worked: `unknown` until an outcome is recorded. */
  readonly outcome: string
  /** Note on the result. */
  readonly note: string
}

/** One validation round of the SOP's phase three. */
export interface VerificationRound {
  /** Stable id. */
  readonly id: string
  /** Round number, 1-based, in the order they were run. */
  readonly round: number
  /** ISO-8601 instant. */
  readonly at: string
  /** Where the sample came from: `editor`, `readers`, `author-group`, `platform`. */
  readonly channel: string
  /** How many readers or titles the sample covers. */
  readonly sampleSize: number
  /** The reading id carrying this round's numbers. */
  readonly readingId: string
  /** Which naming candidate was under test, when the round tested naming. */
  readonly namingId: string
  /** The computed verdict. */
  readonly verdict: VerdictLevel
  /** Why that verdict, in the tool's words. */
  readonly reasons: readonly string[]
  /** Where to go back to when the round did not pass. */
  readonly fallback: string
  /** What would make the author abandon the concept. */
  readonly abandonIf: string
  /** The author's own reading of reader reactions. */
  readonly note: string
}

// ── retrospectives and reusable templates ─────────────────────────────────────

/** One thing worth keeping or avoiding, captured at completion. */
export interface Lesson {
  /** Stable id. */
  readonly id: string
  /** `reuse` for a pattern that worked, `avoid` for one that failed. */
  readonly kind: 'reuse' | 'avoid'
  /** The lesson in one line. */
  readonly statement: string
  /** The evidence behind it. */
  readonly evidence: string
  /** Which part of the craft it belongs to: `opening`, `rhythm`, `character`, … */
  readonly area: string
}

// ── model-backed reviews ──────────────────────────────────────────────────────

/**
 * The judgements `novel_review` can ask a model for.
 *
 * These are the SOP steps whose output is a *reading of language* rather than a
 * number: the tool layer cannot decide them, and the eight deterministic tools
 * deliberately do not try. Every one of them is recorded so the recommendation
 * can be audited against the model and prompt that produced it.
 */
export const REVIEW_KINDS = ['ai-flavor', 'opening', 'competitor', 'retro'] as const

/** One entry of {@link REVIEW_KINDS}. */
export type ReviewKind = (typeof REVIEW_KINDS)[number]

/** How much a finding matters, as judged by the model. */
export const REVIEW_SEVERITIES = ['high', 'medium', 'low'] as const

/** One entry of {@link REVIEW_SEVERITIES}. */
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number]

/** One thing wrong with the prose, anchored to the text that shows it. */
export interface ReviewFinding {
  /** What kind of problem: `翻译腔`, `节奏`, `钩子`, … */
  readonly dimension: string
  /** The offending text, quoted so the author can find it. */
  readonly quote: string
  /** Why it reads as machine-written or weak. */
  readonly why: string
  /** What to do instead. */
  readonly fix: string
  /** How much it matters. */
  readonly severity: ReviewSeverity
}

/**
 * One recorded review.
 *
 * The model and the prompt version are part of the record, not metadata: a
 * judgement produced by an unknown model under an unknown rubric cannot be
 * argued with or reproduced, and the SOP's whole discipline is that a decision
 * names its evidence.
 */
export interface ReviewRecord {
  /** Stable id, `review-<n>`. */
  readonly id: string
  /** ISO-8601 instant of the review. */
  readonly at: string
  /** Which judgement was asked for. */
  readonly kind: ReviewKind
  /** What was reviewed: a chapter id, or `''` for the whole project. */
  readonly target: string
  /** The provider route used. */
  readonly provider: string
  /** The model used. */
  readonly model: string
  /** Which rubric version was sent, so a later revision is distinguishable. */
  readonly promptVersion: string
  /** The model's one-paragraph verdict. */
  readonly summary: string
  /** The individual findings. */
  readonly findings: readonly ReviewFinding[]
  /** Workspace-relative path of the full transcript, or `''` when none was kept. */
  readonly artifact: string
}

/** One IP-ready asset extracted from the finished novel. */
export interface IpAsset {
  /** Stable id. */
  readonly id: string
  /** `character`, `setting`, `scene`, `quote`, `relationship`, `link`. */
  readonly kind: string
  /** Display label. */
  readonly label: string
  /** The asset itself, or a pointer into the chapters. */
  readonly content: string
  /** Where it came from: chapter id or number. */
  readonly source: string
}

/** A reusable structural template exported for the next novel. */
export interface ReusableTemplate {
  /** Template name, usually the source novel plus the date. */
  readonly name: string
  /** ISO-8601 instant of export. */
  readonly exportedAt: string
  /** Act structure copied from the source. */
  readonly acts: readonly string[]
  /** Volume rhythm copied from the source. */
  readonly volumeRhythm: readonly string[]
  /** Beat pattern, expressed as offsets rather than chapter numbers. */
  readonly beatPattern: readonly string[]
  /** Hook patterns that recurred. */
  readonly hookPatterns: readonly string[]
  /** The emotional template. */
  readonly emotionTemplate: string
  /**
   * Deliberately empty of cast and proper nouns: the SOP requires a variant
   * upgrade rather than a reused cast, and a template that cannot carry
   * characters cannot be copy-pasted into a clone.
   */
  readonly note: string
}

/** The retrospective record of a finished (or abandoned) novel. */
export interface Retrospective {
  /** ISO-8601 instant the retrospective was written. */
  readonly at: string
  /** Final numbers in the author's words. */
  readonly dataSummary: string
  /** What worked. */
  readonly highlights: readonly string[]
  /** What failed. */
  readonly problems: readonly string[]
  /** Structured lessons. */
  readonly lessons: readonly Lesson[]
  /** IP-ready assets. */
  readonly assets: readonly IpAsset[]
  /** Templates exported for the next novel. */
  readonly templates: readonly ReusableTemplate[]
}

// ── the document ──────────────────────────────────────────────────────────────

/**
 * The whole persisted novel project: one JSON document, one source of truth.
 *
 * Chapters, cast, world, plan, feedback, and retrospective move together, so no
 * write can leave the project internally inconsistent.
 */
export interface NovelState {
  /** On-disk schema version, checked on read. */
  readonly schemaVersion: number
  /** Premise and prose conventions. */
  readonly meta: NovelMeta
  /** Commercial frame. */
  readonly platform: PlatformProfile
  /** The memorable point and its supporting differentiators. */
  readonly pitch: Premise
  /** Candidate title/blurb/tag sets. */
  readonly naming: readonly NamingCandidate[]
  /** Leaderboard medians every reading is compared against. */
  readonly baselines: MetricBaselines
  /** Comparable titles dismantled for the SOP's competitor step. */
  readonly competitors: readonly Competitor[]
  /** Writing parameters, one meaning each. */
  readonly writing: WritingPlan
  /** Cast, keyed by {@link Character.id}. */
  readonly characters: Readonly<Record<string, Character>>
  /** World facts, keyed by {@link WorldEntry.id}. */
  readonly world: Readonly<Record<string, WorldEntry>>
  /** Reader promises awaiting payoff, keyed by {@link StoryLink.id}. */
  readonly links: Readonly<Record<string, StoryLink>>
  /** The plan. */
  readonly outline: Outline
  /** Chapters, keyed by {@link Chapter.id}. */
  readonly chapters: Readonly<Record<string, Chapter>>
  /** Metric readings in the order taken. */
  readonly readings: readonly MetricReading[]
  /** Applied changes with their evidence chain. */
  readonly iterations: readonly Iteration[]
  /** Validation rounds. */
  readonly verifications: readonly VerificationRound[]
  /**
   * Model-backed judgements in the order taken.
   *
   * Additive since the first release, so a document written before reviews
   * existed simply has none; the reader defaults it rather than refusing the
   * file, because losing a draft to a plugin upgrade is the one outcome the
   * codec must never allow.
   */
  readonly reviews: readonly ReviewRecord[]
  /** Retrospective and reusable material; absent until completion. */
  readonly retro?: Retrospective
  /** ISO-8601 timestamp of project creation. */
  readonly createdAt: string
  /** ISO-8601 timestamp of the last accepted write. */
  readonly updatedAt: string
}

/** Which SOP phase a project is in, and what is stopping the next one. */
export interface StageAssessment {
  /** The phase the project's data supports. */
  readonly stage: ProjectStage
  /** Preconditions not yet met for the *next* phase. */
  readonly blockers: readonly string[]
  /** Preconditions met, for orientation. */
  readonly satisfied: readonly string[]
}

/** Aggregate standing, derived on every read — never stored. */
export interface NovelProgress {
  /** Number of chapters in the project. */
  readonly chapters: number
  /** How many chapters sit in each status. */
  readonly byStatus: Readonly<Record<ChapterStatus, number>>
  /** Total characters of prose across every chapter. */
  readonly totalWords: number
  /** Chapters that exist but hold no prose yet. */
  readonly emptyChapters: readonly string[]
  /** Chapter ids whose number is duplicated or non-contiguous. */
  readonly numberingIssues: readonly string[]
  /** Chapters with prose but not yet marked published, by the run-length rule. */
  readonly stockChapters: number
  /** How many chapters answer every contract field. */
  readonly contractedChapters: number
  /** How many written chapters delivered every field they promised. */
  readonly deliveredChapters: number
  /** Promises still open. */
  readonly openLinks: readonly string[]
  /** Open promises whose due chapter is already written. */
  readonly overdueLinks: readonly string[]
}
