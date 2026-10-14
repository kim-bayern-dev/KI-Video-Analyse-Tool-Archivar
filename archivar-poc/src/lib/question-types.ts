/**
 * Type definitions for the generalized question-answer pipeline plugin.
 *
 * These types define the configurable contract between the user's
 * `archivar.config.ts` and the `plugins/question-answer.ts` plugin.
 * Importing them gives full type-safety and IDE autocompletion for
 * question configurations.
 */
import { PluginDefinition } from "./types";

/**
 * The kind of answer expected from the MLLM.
 * - `Boolean`: yes/no → true/false
 * - `OneOf`: enum — choose exactly one from `options`
 * - `ManyOf`: enum — choose many from `options` (constrained tagging)
 * - `SingleClaim`: one sentence, free text
 * - `Categorization`: limited set of freely-chosen categories (unconstrained tagging)
 */
export enum QuestionType {
  Boolean = "boolean",
  OneOf = "oneOf",
  ManyOf = "manyOf",
  SingleClaim = "singleClaim",
  Categorization = "categorization",
}

/**
 * What input text the question should be asked against.
 * - `WholeSummary`: ask based on the whole-video summary from the default plugin
 * - `EveryAggregationSummaryThenConclude`: ask per aggregation, then synthesize a final conclusion
 */
export enum AnalysisScope {
  WholeSummary = "wholeSummary",
  EveryAggregationSummaryThenConclude = "everyAggregationSummaryThenConclude",
}

/**
 * How to format the result for rendering.
 * - `Json`: structured JSON object (rendered in `<pre>` by the UI)
 * - `MarkdownTable`: rendered as a Markdown table (rendered as HTML by the UI)
 */
export enum ResultFormat {
  Json = "json",
  MarkdownTable = "markdownTable",
}

/**
 * Where to put the result.
 * - `AppendToSummary`: appended to the summary's `long_summary` text
 * - `None`: stored only in `result.postProcessing[pluginName]` (visible in debug.json)
 */
export enum Rendering {
  AppendToSummary = "appendToSummary",
  None = "none",
}

// ── Question Config ───────────────────────────────────────────────────────

/**
 * Configuration for a single question in the pipeline.
 * Each question triggers one (or more) MLLM calls and produces a
 * structured result that can be rendered as markdown or stored as JSON.
 */
export interface QuestionConfig {
  /** The question prompt to ask the MLLM */
  prompt: string;

  /** Type of answer expected — determines prompt template and Yup schema.
   *  Accepts the enum member or its string value (runtime compares string values). */
  type: QuestionType | `${QuestionType}`;

  /** Available choices (required for `OneOf` and `ManyOf` types) */
  options?: string[];

  /** What input text to analyze.
   *  Accepts the enum member or its string value (runtime compares string values). */
  analyze: AnalysisScope | `${AnalysisScope}`;

  /** JSON key under which the result is stored */
  label: string;

  /** How to format the result. Default: `ResultFormat.Json` */
  resultFormat?: ResultFormat;

  /** Where to render the result. Default: `Rendering.None` */
  rendering?: Rendering;

  /**
   * When true, this question's Q&A pair is accumulated into a running context
   * that is passed to all subsequent questions' prompts. This enables
   * chain-of-thought reasoning where later questions build on earlier answers.
   * Default: `false`.
   *
   * Example: Set `true` on Q1-Q8, `false` on Q9 (Kurzfazit). Q9 receives
   * all previous answers as context but does not add its own.
   */
  // REFACTOR(typo): the standard term is "autoregressive" — but this key is
  // user-facing config surface (20+ uses in archivar.config.ts, consumed by
  // plugins/question-answer.ts), so renaming is a breaking config change and
  // should only ride along with a config-schema migration.
  enableAutoRegressiveAnswerAggregation?: boolean;

  /**
   * Optional system prompt override for this question's MLLM call.
   * When provided, this replaces the model's default system prompt for that call.
   * Use this to inject dynamic context (e.g., current date, domain-specific instructions)
   * without changing the model's global configuration.
   */
  systemPrompt?: string;
}

export type QuestionConfigs = Array<QuestionConfig>;

/**
 * Plugin-level configuration for the question-answer pipeline.
 * Passed as `config` in the workflow's `postProcessing` array.
 */
export interface QuestionAnswerConfig extends PluginDefinition {
  /** Array of questions to ask sequentially */
  questions: QuestionConfigs;
}

// ── Result Types ──────────────────────────────────────────────────────────

/** Validated result from a boolean question */
export interface BooleanResult {
  answer: boolean;
  reasoning: string;
}

/** Validated result from a oneOf question */
export interface OneOfResult {
  answer: string;
  reasoning: string;
}

/** Validated result from a manyOf question */
export interface ManyOfResult {
  answers: string[];
  reasoning: string;
}

/** Validated result from a singleClaim question */
export interface SingleClaimResult {
  answer: string;
  reasoning: string;
}

/** Validated result from a categorization question */
export interface CategorizationResult {
  categories: string[];
  reasoning: string;
}

/**
 * Union of all possible validated result shapes.
 * Deliberately NOT a discriminated union (no `type` field) — the shapes mirror
 * what the MLLM returns per question type. Narrow via property presence
 * (`"answers" in result`, `"categories" in result`) or via the originating
 * `QuestionConfig.type`, which is the authoritative discriminator.
 */
export type QuestionResult =
  | BooleanResult
  | OneOfResult
  | ManyOfResult
  | SingleClaimResult
  | CategorizationResult;

/**
 * Result of processing a single question, including metadata
 * about how it was analyzed and how it should be rendered.
 */
export interface ProcessedQuestion {
  /** The original question config */
  config: QuestionConfig;

  /** The validated MLLM answer */
  result: QuestionResult;

  /** For `everyAggregationSummaryThenConclude`: per-aggregation breakdown */
  perAggregation?: Array<{
    aggregationId: string;
    from: string;
    to: string;
    result: QuestionResult;
  }>;

  /** Formatted as markdown (if `resultFormat: "markdownTable"`) */
  markdown?: string;

  /** Any error that occurred (null on success) */
  error: string | null;
}
