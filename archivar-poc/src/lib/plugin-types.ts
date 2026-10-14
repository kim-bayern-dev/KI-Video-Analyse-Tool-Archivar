/**
 * Post-processing plugin contract (v3).
 *
 * The stable interface between the workflow engine
 * (src/rpc/workflow-engine.ts) and post-processing plugins: the data shapes
 * flowing in (PostProcessingInput, TimeSlice) and out
 * (PostProcessingPluginRunResult, SemanticAggregation), the helper API
 * surface available to hooks (PluginRpcApiCompositeInstance), and the hook
 * signatures a plugin module implements (PostProcessingPluginModule).
 * There is intentionally no run() entry point — the engine dynamic-import()s
 * the plugin module and calls whichever NAMED hooks it exports.
 */
import type { AnalysisResult } from "../db/db";
import type { MediaSegmentType, OutputFormat, PostProcessingPluginDefinition, WorkflowDefinition } from "./workflow-types";

// ============================================================================
// JSON Primitives
// ============================================================================

/** JSON primitive types */
export type JsonPrimitive = string | number | boolean | null;

/** Recursive JSON value type */
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

// ============================================================================
// File Reference
// ============================================================================

/**
 * Reference to a media file with path information for different environments.
 * Used in plugins to provide clear path context.
 */
export interface FileRef {
  /** Base filename without path */
  fileName: string;
  /** File extension (e.g. ".mp4", ".wav") */
  extension: string;
  /** Media type classification */
  // REFACTOR(dry): this inline union repeats at FileInfo.mediaType below and at
  // src/rpc/file-api.ts:15 — extract a named alias (which would also document
  // what "kfs" means).
  mediaType: "video" | "audio" | "image" | "kfs";
  /** Output hash for cache lookups */
  outputHash: string | null;
  /** URL for accessing the file via server */
  serverUrl?: string;
  /** Path visible inside the Archivar container. */
  containerPath: string;
  /** Path visible to host/tooling when configured. */
  hostPath?: string;
  /** Original relative path inside sample data. */
  relativePath?: string;
}

// ============================================================================
// Time Slice
// ============================================================================

/** Type of media content in a time slice */
// REFACTOR(dry): the same 6-member union is declared 3x — here, MediaSegmentType
// (src/lib/workflow-types.ts:106) and SliceType (src/lib/workflow-types.ts:355).
// The duplication already forced an explicit re-export workaround in
// src/lib/types.ts:8-10 (TS2308). Keep one declaration and alias the rest.
export type SliceType = "speech" | "harmonic" | "noise" | "silence" | "scene" | "keyframe";

/**
 * A single time slice with rich metadata for post-processing.
 */
export interface TimeSlice {
  /** Stable ID: `${type}:${sceneIndex}:${index}:${fromSeconds}-${toSeconds}` */
  id: string;
  /** Chronological index in post-processing input */
  index: number;
  /** Original segment index (if available) */
  sourceIndex?: number;
  /** Start time as formatted string (HH:MM:SS) */
  from: string;
  /** End time as formatted string (HH:MM:SS) */
  to: string;
  /** Start time in seconds */
  fromSeconds: number;
  /** End time in seconds */
  toSeconds: number;
  /** Duration in seconds */
  durationSeconds: number;
  /** Media segment type */
  type: SliceType;
  /** Parent scene index (-1 for audio-only/no scenes) */
  sceneIndex: number;
  /** Legacy normalized caption */
  caption: string;
  /** Raw model output if available */
  captionRaw?: string;
  /** Parsed existing caption if valid JSON */
  captionJson?: JsonValue;
  /** Flag indicating this keyframe was captioned as fallback (video clip caption was insufficient).
   *  Only relevant for type "keyframe". */
  captionedAsFallback?: boolean;
  /** Segment media file reference */
  sourceFile: FileRef;
  /** Uploaded/original media file reference */
  parentFile: FileRef;
  /** Per-plugin annotations, keyed by plugin name */
  plugin?: Record<string, JsonValue>;
}

export type TimeSlices = Array<TimeSlice>;

// ============================================================================
// Post-Processing Input
// ============================================================================

/**
 * Rich input context for post-processing plugins.
 * Provides file metadata, workflow configuration, and analysis results.
 */
export interface PostProcessingInput {
  /** Name of the workflow being executed */
  workflowName: string;
  /** Full workflow configuration */
  workflow: WorkflowDefinition;
  /** Run-specific metadata */
  run: {
    /** Unique run identifier */
    id: string;
    /** ISO timestamp when run started */
    startedAt: string;
    /** Whether --force flag was used */
    force: boolean;
    /** --only filter if specified */
    only?: string;
  };
  /** File being processed */
  file: FileRef;
  /** Original analysis result from processing stage */
  analysisResult: AnalysisResult;
  /** Time slices to be post-processed */
  timeSlices: TimeSlice[];
}

// ============================================================================
// Semantic Aggregation
// ============================================================================

/**
 * A group of adjacent time slices that belong to the same semantic contribution.
 * Constructed by the ENGINE from plugin.decideForAggregation() boolean
 * decisions (plus minimum-size enforcement, which may force-merge undersized
 * groups), then enriched in place by the later per-aggregation hooks.
 */
export interface SemanticAggregation {
  /** ID: `${pluginName}:aggregation:${n}` */
  id: string;
  /** Name of the plugin that created this aggregation */
  pluginName: string;
  /** Aggregation index (chronological order) */
  index: number;
  /** Indices of time slices in this aggregation */
  sliceIndexes: number[];
  /** IDs of time slices in this aggregation */
  sliceIds: string[];
  /** Start time of aggregation span */
  from: string;
  /** End time of aggregation span */
  to: string;
  /** Start time in seconds */
  fromSeconds: number;
  /** End time in seconds */
  toSeconds: number;
  /** Summary of this aggregation (optional) */
  summary?: JsonValue | string;
  /** Unified analysis of this aggregation (optional) */
  analysis?: JsonValue;
  /** Replacement slices if modified by post-processing (optional) */
  replacementSlices?: TimeSlice[];
  /** Multi-dimensional semantic profile for cross-aggregation comparison (optional).
   *  Extracted auto-regressively during aggregation processing. */
  semanticProfile?: SemanticProfile;
  /** Aggregation IDs this aggregation belongs to semantically (long-range relationships).
   *  Populated auto-regressively by comparing with all previous aggregations. */
  belongsToSemantically?: string[];
}

/**
 * Multi-dimensional semantic profile for cross-aggregation comparison.
 * Used to detect long-range semantic relationships between aggregations.
 */
export interface SemanticProfile {
  /** Primary topics/themes (2-5 key topics) */
  topics: string[];
  /** Location/environment (e.g., "studio", "outdoor", "office") */
  setting: string;
  /** Named speakers or speaker types */
  speakers: string[];
  /** Emotional/narrative tone (e.g., "serious", "light", "dramatic") */
  mood: string;
  /** Visual style category (e.g., "news-broadcast", "documentary", "entertainment") */
  visualStyle: string;
  /** Audio character (e.g., "speech-with-music", "ambient-only", "silence") */
  audioCharacter: string;
  /** Primary intention detected */
  primaryIntention: 'inform' | 'entertain' | 'promote' | 'educate' | 'mixed';
  /** Confidence score for the profile (0.0 - 1.0) */
  confidence: number;
}

/** Result of semantic profile extraction with relationship claims */
export interface SemanticProfileWithRelationships {
  profile: SemanticProfile;
  /** IDs of aggregations this one belongs to semantically */
  relatedAggregationIds: string[];
  /** Brief reason explaining why these relationships were claimed */
  reason: string;
}

export type SemanticAggregations = Array<SemanticAggregation>;

/**
 * Patch to apply to a semantic aggregation during post-processing.
 */
export interface SemanticAggregationPatch {
  /** Unified analysis result */
  analysis?: JsonValue;
  /** Summary text or structured data */
  summary?: JsonValue | string;
  /** Replacement slices */
  replacementSlices?: TimeSlice[];
}

// ============================================================================
// Visuelle Artefakte
// ============================================================================

/** Significant visual element tracked across scenes → aggregations → HOAs */
export interface VisualArtifact {
  /** Name/type of the artifact (e.g., "ARD Logo", "Date Overlay") */
  artifact: string;
  /** Exact text/caption shown (e.g., "ARD", "07.05.2026, 20:00 Uhr") */
  exactCaption: string;
  /** Detection confidence (0.0–1.0) */
  confidence: number;
  /** Accumulated count of appearances across scenes/aggregations.
   *  Higher values indicate persistent, significant elements. */
  temporalStability: number;
}

// ============================================================================
// Higher-Order Aggregation
// ============================================================================

/** Macro-level semantic section grouping multiple aggregations */
export interface HigherOrderAggregation {
  /** Unique identifier */
  id: string;
  /** 0-based index */
  index: number;
  /** Human-readable title (e.g., "News Flash: Crime Scene Berlin") */
  title: string;
  /** Description referencing constituent aggregations */
  description: string;
  /** Indices of constituent SemanticAggregation.index values */
  aggregationIndexes: number[];
  /** Merged visual artifacts with accumulated temporal stability */
  visualArtifacts: VisualArtifact[];
  /** Aggregated perception matrix for this HOA */
  perceptionMatrix?: PerceptionMatrix;
  /** Intention classification for this HOA (INFORMATIONAL, PROMOTIONAL, etc.) */
  intentionClassification?: string;
}

export type HigherOrderAggregations = Array<HigherOrderAggregation>;

/** Perception entry for rhetoric/framing/emotion categories */
export interface PerceptionEntry {
  keyword: string;
  confidence: number;
}

/** Perception matrix with rhetoric/framing/emotion dimensions */
export interface PerceptionMatrix {
  rhetoric?: PerceptionEntry;
  framing?: PerceptionEntry;
  emotion?: PerceptionEntry;
}

// ============================================================================
// Plugin Result
// ============================================================================

/**
 * Complete result from running a plugin.
 * Persisted in AnalysisResult.postProcessing[pluginName].
 */
export interface PostProcessingPluginRunResult {
  /** Name of the plugin */
  pluginName: string;
  /** ISO timestamp when plugin started */
  startedAt: string;
  /** ISO timestamp when plugin completed */
  completedAt: string;
  /** Time slices after post-processing */
  timeSlices: TimeSlices;
  /** Semantic aggregations created */
  aggregations: SemanticAggregations;
  /** Whole-video summary (optional) */
  summary?: JsonValue | string;
  /** Higher-order aggregations grouping aggregations into macro-sections (optional).
   *  Populated by postProcessHigherOrderAggregations when enabled. */
  higherOrderAggregations?: HigherOrderAggregations;
  /** Errors encountered during plugin execution. Collected per hook instead of
   *  thrown — a plugin run always completes and reports partial results. */
  errors: Array<{
    /** Hook name that failed */
    hook: string;
    /** Error message */
    message: string;
    /** Slice ID if error was slice-specific */
    sliceId?: string;
    /** Aggregation ID if error was aggregation-specific */
    aggregationId?: string;
  }>;
}

// ============================================================================
// Plugin Configuration
// ============================================================================

/**
 * Base shape for a plugin's typed configuration — extended by each plugin's
 * own config interface (DefaultPostProcessingConfig in plugins/default.ts,
 * QuestionAnswerConfig in src/lib/question-types.ts) and carried on
 * PostProcessingPluginDefinition.config.
 * NOT the 2nd hook argument: hooks receive PostProcessingPluginDefinition
 * (workflow-types.ts), which wraps this config with registration metadata
 * (name, importPath, order).
 */
// REFACTOR(consistency): near-name-collision with PostProcessingPluginDefinition
// (src/lib/workflow-types.ts:231) — different layers (config payload vs.
// workflow registration) under confusingly similar names, both re-exported via
// src/lib/types.ts. Renaming this one (e.g. PluginConfigBase) would ripple into
// plugins/default.ts and src/lib/question-types.ts.
export interface PluginDefinition<T = unknown> {
  /** Model name to use for analysis calls. Defaults to workflow default. */
  modelName?: string;
  /** Maximum concurrent MLLM requests. Default: 2 */
  maxConcurrency?: number;
  /** Per-plugin LLM sampling overrides passed to callJson/callRaw. Overrides the
   *  model's own hyperparams for plugin LLM calls (temperature, top_p, top_k,
   *  max_tokens, etc.). Note: applyStructuredSampling overrides temperature/top_p/
   *  top_k/penalties for guided-JSON calls regardless. */
  hyperparams?: Record<string, unknown>;
  /** Plugin-specific configuration. */
  config: T;
}

// ============================================================================
// Plugin API Helper Object
// ============================================================================

/**
 * Helper functions available to plugins for interacting with the system.
 * Provides access to file operations, cache, analysis, and MLLM calls.
 *
 * The ONLY sanctioned surface between plugins and the runtime: implemented by
 * src/rpc/post-processing/plugin-api.ts and handed to every hook — plugins
 * must not import from src/rpc directly.
 */
export interface PluginRpcApiCompositeInstance {
  /** File operations */
  file: {
    /** Get media information for a file path */
    getMediaInfo(filePath: string): Promise<FileInfo | null>;
    /** List files matching a glob pattern */
    listFiles(pattern?: string): Promise<FileInfo[]>;
    /** Read file content as string */
    readFile(relativePath: string): Promise<string>;
  };

  /** Cache operations */
  cache: {
    /** Get value from cache table */
    get<T>(table: TableName, key: string, defaultValue: T): Promise<T>;
    /** Set value in cache table */
    set<T>(table: TableName, key: string, value: T): Promise<void>;
  };

  /** Analysis operations */
  analysis: {
    /** Get analysis results for a file */
    getAnalysisResults(filePath: string, analysisType?: MediaSegmentType): Promise<unknown>;
    /** Analyze a segment with specified model and prompt */
    analyzeSegment(args: {
      filePath: string;
      mediaType: MediaSegmentType;
      modelName: string;
      prompt: string;
      systemPrompt?: string;
      enableThinking?: boolean;
    }): Promise<string>;
  };

  /** MLLM operations */
  mllm: {
    /** Call MLLM and receive the raw model response plus backend token `usage`
     *  (no JSON normalization). `usage` is present for chat-completions backends
     *  and `undefined` for protocols that don't report it (e.g. /v1/audio/transcriptions). */
    callRaw(args: {
      endpoint: string;
      model: string;
      apiKey?: string;
      filePaths: string[];
      mediaCategory: "audio" | "video" | "image";
      prompt: string;
      systemPrompt?: string;
      hyperparams?: Record<string, unknown>;
      enableThinking?: boolean;
      mmProcessorKwargs?: Record<string, unknown>;
      /** Optional JSON Schema to enable native guided decoding. */
      jsonSchema?: Record<string, unknown>;
      /** Native guided-decoding transport: "auto" (probe) | explicit mode | false/undefined. */
      jsonSchemaMode?: import("../rpc/mllm-api.js").JsonSchemaMode;
      /** Structured-output overrides from ModelConfig.structuredOutput. */
      structuredMaxTokens?: number;
      structuredTemperature?: number;
      structuredFrequencyPenalty?: number;
      structuredRepetitionPenalty?: number;
      /** Name for response_format.json_schema.name (response_format transport only). */
      jsonSchemaName?: string;
      /** Resolved vLLM repetition_detection (from model config; omitted when undefined). */
      repetitionDetection?: import("./workflow-types.js").RepetitionDetectionConfig;
    }): Promise<import("../rpc/mllm-api.js").RawCallResult>;
    /**
     * Call MLLM, parse JSON, validate against yup schema. On validation or
     * JSON-parse failure, retries up to `maxRetries` times (default 2) by
     * re-prompting the model with its previous invalid answer and the exact
     * field-level validation errors so it can self-correct. When
     * `jsonSchemaMode` is set, the schema is converted to JSON Schema and sent
     * for native constrained decoding (Yup validation stays as a safety net).
     */
    callJson<T>(args: {
      endpoint: string;
      model: string;
      apiKey?: string;
      filePaths: string[];
      mediaCategory: "audio" | "video" | "image";
      prompt: string;
      systemPrompt?: string;
      schema: unknown; // yup.Schema<T> - using unknown to avoid import issues
      hyperparams?: Record<string, unknown>;
      enableThinking?: boolean;
      /** Max validation/parse-error retries before throwing. Default: 2. */
      maxRetries?: number;
      mmProcessorKwargs?: Record<string, unknown>;
      /** Native guided-decoding mode. "auto" probes; explicit modes fail fast on unsupported schema; off = prompt-only. */
      jsonSchemaMode?: import("../rpc/mllm-api.js").JsonSchemaMode;
      /** Structured-output overrides from ModelConfig.structuredOutput. */
      structuredMaxTokens?: number;
      structuredTemperature?: number;
      structuredFrequencyPenalty?: number;
      structuredRepetitionPenalty?: number;
      /** Name for response_format.json_schema.name (response_format transport only). */
      jsonSchemaName?: string;
      /** Resolved vLLM repetition_detection (from model config; omitted when undefined). */
      repetitionDetection?: import("./workflow-types.js").RepetitionDetectionConfig;
    }): Promise<T>;
  };

  /** Utility functions */
  util: {
    /** Parse JSON loosely (handles markdown code blocks, etc.) */
    parseJsonLoose(content: string): unknown;
    /** Format seconds to HH:MM:SS string */
    formatTime(seconds: number): string;
    /** Run async operations with concurrency limit */
    limitConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]>;
    /** Logger instance */
    logger: Pick<Console, "log" | "warn" | "error">;
  };
}

// ============================================================================
// FileInfo type (needed for PluginApi.file)
// ============================================================================

/** File information returned by PluginApi.file operations */
// REFACTOR(dry): duplicated field-for-field (minus these docs) by the FileInfo
// interface in src/rpc/file-api.ts:10-38 — keep one definition and import it
// on the RPC side.
export interface FileInfo {
  /** Absolute path on host system */
  hostAbsolutePath: string;
  /** Absolute path in container */
  absolutePath: string;
  /** Relative path */
  relativePath: string;
  /** Path string */
  path: string;
  /** Media type classification */
  mediaType: "video" | "audio" | "image" | "kfs";
  /** Base filename */
  fileName: string;
  /** File extension */
  extension: string;
  /** Output folder name */
  outputFolderName: string | null;
  /** Output hash for cache lookups */
  outputHash: string | null;
  /** Keyframe files */
  keyframes: Array<FileInfo>;
  /** Scene keyframe files */
  sceneKeyframes: Array<FileInfo>;
  /** Scene files */
  scenes: Array<FileInfo>;
  /** Silence segment files */
  silence: Array<FileInfo>;
  /** Harmonic segment files */
  harmonic: Array<FileInfo>;
  /** Noise segment files */
  noise: Array<FileInfo>;
  /** Speech segment files */
  speech: Array<FileInfo>;
  /** Start time in seconds */
  startTime?: number;
  /** End time in seconds */
  endTime?: number;
  /** Segment index */
  index?: number;
  /** Server URL for accessing the file */
  serverUrl?: string;
  /** All output files */
  outputFiles?: Array<FileInfo>;
  /** Current action */
  // DEPRECATED: action/allowedActions/actionOutputFormat only feed the
  // permanently hidden Actions panel in csr dashboard.tsx.
  action?: string;
  /** Allowed actions */
  allowedActions?: string[];
  /** Output format */
  actionOutputFormat?: OutputFormat;
  /** Status */
  // REFACTOR(magic): "..." is a placeholder that leaked into the status union
  // (duplicated at src/rpc/file-api.ts:37). Part of the RPC payload, so
  // renaming to e.g. "Processing" needs a matching client-side sweep.
  status?: "New" | "..." | "Done" | "Failed";
}

// ============================================================================
// TableName type (needed for PluginApi.cache)
// ============================================================================

/** Cache table names */
// DEPRECATED member: "summary" is an unused cache table (nothing writes or
// reads it); kept in the union so purge/clear paths still cover old files.
export type TableName = "scene" | "audio" | "keyframe" | "speech" | "aggregated" | "summary";

// ============================================================================
// Plugin Hook Function Types
// ============================================================================

/** Hook: Process each time slice individually */
export type PostProcessPerTimeSliceFn = (
  input: PostProcessingInput,
  pluginDefinition: PostProcessingPluginDefinition,
  api: PluginRpcApiCompositeInstance,
) => Promise<PostProcessingTimeSliceResult | void>;

/** Hook: Decide if two adjacent slices belong to same aggregation.
 *  The optional `input` gives access to accumulated results from plugins
 *  that ran earlier in the same workflow (via input.analysisResult.postProcessing). */
export type DecideForAggregationFn = (
  previous: TimeSlice,
  current: TimeSlice,
  pluginDefinition: PostProcessingPluginDefinition,
  api: PluginRpcApiCompositeInstance,
  input?: PostProcessingInput,
) => Promise<boolean>;

/** Hook: Post-process a semantic aggregation.
 *  The optional `input` gives access to accumulated results from plugins
 *  that ran earlier in the same workflow (via input.analysisResult.postProcessing).
 *  This enables enrichment plugins to read and extend prior per-slice or
 *  per-aggregation analyses without re-analyzing from scratch. */
export type PostProcessPerAggregationFn = (
  aggregation: SemanticAggregation,
  timeSlices: TimeSlices,
  pluginDefinition: PostProcessingPluginDefinition,
  api: PluginRpcApiCompositeInstance,
  input?: PostProcessingInput,
) => Promise<SemanticAggregationPatch | void>;

/** Hook: Generate summary for a single aggregation.
 *  The optional `input` gives access to accumulated results from plugins
 *  that ran earlier in the same workflow (via input.analysisResult.postProcessing). */
export type SummaryForAggregationFn = (
  aggregation: SemanticAggregation,
  pluginDefinition: PostProcessingPluginDefinition,
  api: PluginRpcApiCompositeInstance,
  input?: PostProcessingInput,
) => Promise<JsonValue | string | void>;

/** Hook: Generate whole-video summary from aggregations.
 *  The optional `input` gives access to accumulated results from plugins
 *  that ran earlier in the same workflow (via input.analysisResult.postProcessing).
 *  This enables summary-enhancement plugins to read and extend previous summaries.
 *  The optional `higherOrderAggregations` gives the HOAs produced by the same
 *  plugin's postProcessHigherOrderAggregations hook (when enabled) so the summary
 *  can consume the macro-section descriptions with their final markdown tables. */
export type SummaryFromAggregationsFn = (
  aggregations: SemanticAggregations,
  pluginDefinition: PostProcessingPluginDefinition,
  api: PluginRpcApiCompositeInstance,
  input?: PostProcessingInput,
  higherOrderAggregations?: HigherOrderAggregations,
) => Promise<JsonValue | string | void>;

/** Hook: Generate whole-video summary from time slices (fallback) */
export type SummaryFromTimeSlicesFn = (
  input: PostProcessingInput,
  pluginDefinition: PostProcessingPluginDefinition,
  api: PluginRpcApiCompositeInstance,
) => Promise<JsonValue | string | void>;

/** Hook: Extract semantic profiles and detect long-range relationships.
 *  Runs auto-regressively over all aggregations to build semantic profiles
 *  and detect cross-aggregation relationships.
 *  Modifies aggregations in place, adding semanticProfile and belongsToSemantically fields. */
export type ExtractSemanticProfilesFn = (
  aggregations: SemanticAggregations,
  pluginDefinition: PostProcessingPluginDefinition,
  api: PluginRpcApiCompositeInstance,
) => Promise<void>;

/** Hook: Enrich boundary transitions between adjacent aggregations.
 *  Runs after extractSemanticProfiles (all analyses final and immutable) and
 *  before postProcessHigherOrderAggregations, so HOA boundary decisions can
 *  consume reliable cross-aggregation context. Modifies aggregations in place
 *  (typically overwriting analysis.relationship_to_previous and adding
 *  analysis.transition_description). */
export type EnrichAggregationTransitionsFn = (
  aggregations: SemanticAggregations,
  pluginDefinition: PostProcessingPluginDefinition,
  api: PluginRpcApiCompositeInstance,
  input?: PostProcessingInput,
) => Promise<void>;

/** Hook: Group aggregations into higher-order macro-sections (HOAs) and analyze them.
 *  Uses the same semantic-boundary pattern as decideForAggregation but compares
 *  whole aggregations. Each resulting HOA carries a title, description, merged
 *  visual artifacts, perception matrix and an intention classification.
 *  Runs after extractSemanticProfiles (step 3.5) and before the whole-video summary. */
export type PostProcessHigherOrderAggregationsFn = (
  aggregations: SemanticAggregations,
  pluginDefinition: PostProcessingPluginDefinition,
  api: PluginRpcApiCompositeInstance,
) => Promise<HigherOrderAggregations>;

// ============================================================================
// Plugin Module Interface (composition of all hooks)
// ============================================================================

/**
 * The plugin module contract: a composition of OPTIONAL named hooks.
 * The engine dynamic-import()s the module from
 * PostProcessingPluginDefinition.importPath and calls whichever hooks are
 * exported, in this fixed order (runPostProcessingPlugins in
 * src/rpc/workflow-engine.ts):
 *
 *   1. postProcessPerTimeSlice            — per-slice analysis/enrichment
 *   2. decideForAggregation               — adjacent-slice grouping (boolean)
 *   3. postProcessPerAggregation          — per-aggregation analysis patch
 *   4. summaryForAggregation              — per-aggregation summary
 *   5. extractSemanticProfiles            — in-place, sequential (auto-regressive)
 *   6. enrichAggregationTransitions       — in-place boundary enrichment
 *   7. postProcessHigherOrderAggregations — macro-sections (HOAs)
 *   8. summaryFromAggregations            — whole-video summary, or
 *      summaryFromTimeSlices when no aggregations were produced
 *
 * Conventions:
 * - No run() entry point — the named hooks are the only interface.
 * - Returning void/undefined means "no change": prior slices, aggregations,
 *   or summary are kept.
 * - After step 2 the engine may force-merge undersized groups (plugin config
 *   minScenesPerAggregation / minAggregationLengthInSec) — grouping decisions
 *   are advisory, not final.
 * - Steps 3+4 run per aggregation under bounded concurrency (plugin config
 *   maxConcurrency, default 2); step 5 stays sequential because it is
 *   auto-regressive over previous aggregations.
 * - Hook exceptions are caught per hook and collected into
 *   PostProcessingPluginRunResult.errors — a plugin run never throws.
 */
export interface PostProcessingPluginModule {
  /** Process each time slice individually */
  postProcessPerTimeSlice?: PostProcessPerTimeSliceFn;
  /** Decide if two adjacent slices belong to same aggregation */
  decideForAggregation?: DecideForAggregationFn;
  /** Post-process a semantic aggregation */
  postProcessPerAggregation?: PostProcessPerAggregationFn;
  /** Generate summary for a single aggregation */
  summaryForAggregation?: SummaryForAggregationFn;
  /** Generate whole-video summary from aggregations */
  summaryFromAggregations?: SummaryFromAggregationsFn;
  /** Generate whole-video summary from time slices (fallback) */
  summaryFromTimeSlices?: SummaryFromTimeSlicesFn;
  /** Extract semantic profiles and detect long-range semantic relationships */
  extractSemanticProfiles?: ExtractSemanticProfilesFn;
  /** Enrich boundary transitions between adjacent aggregations.
   *  Runs after extractSemanticProfiles and before postProcessHigherOrderAggregations. */
  enrichAggregationTransitions?: EnrichAggregationTransitionsFn;
  /** Group aggregations into higher-order macro-sections and analyze them.
   *  Runs after extractSemanticProfiles and before the whole-video summary. */
  postProcessHigherOrderAggregations?: PostProcessHigherOrderAggregationsFn;
}

/** Result from post-processing a single time slice */
export interface PostProcessingTimeSliceResult {
  /** Modified time slices */
  timeSlices: TimeSlices;
}
