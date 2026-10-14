// ============================================================================
// Model Registry
// ============================================================================

/** Serialized output format for analysis results. "toon" is the compact
 *  token-oriented encoding via @byjohann/toon (formatOutput in
 *  src/rpc/workflow-engine.ts). */
export type OutputFormat = "json" | "md" | "toon";

/** Inference backend serving a model endpoint. Relevant for type "api" models;
 *  may also be set on "asr-api" models to document the serving backend. */
export type InferenceEngine = "vllm" | "llama-cpp" | "sglang" | "custom-openai-compatible" | "qwen-asr";

/** vLLM v0.25 repetition_detection parameters (top-level chat-completions body field). */
export interface RepetitionDetectionConfig {
  min_pattern_size: number;
  max_pattern_size: number;
  min_count: number;
}

/** Hyperparameters for LLM inference */
export interface ModelHyperparams {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  max_tokens?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  repetition_penalty?: number;
  [key: string]: unknown;
}

/** Named model configuration - endpoint/apiKey support "env:VAR_NAME" for env resolution; runtime credentials from MODEL_CONFIG */
export interface ModelConfig {
  name: string;
  /** "api" = OpenAI-compatible endpoint, "tool" = external shell script via AnalyseApi, "asr-api" = Qwen3-ASR multipart POST */
  type?: "api" | "tool" | "asr-api";
  /** Inference backend serving this model's endpoint. Gates vLLM-only request
   *  fields (e.g. repetition_detection, see resolveRepetitionDetection). */
  inferenceEngine?: InferenceEngine;
  endpoint?: string;       // e.g. "env:MY_VLM_ENDPOINT" or "http://localhost:9031" (optional, resolved from MODEL_CONFIG at runtime)
  apiKey?: string;         // e.g. "env:MLLM_API_KEY" or literal (optional, resolved from MODEL_CONFIG at runtime)
  model?: string;          // e.g. "env:MY_VLM_MODEL" or "gemma4-e4b-qat-w4a16" (optional, resolved from MODEL_CONFIG at runtime)
  /** For type "tool": the tool name passed to AnalyseApi.executeScript (e.g. "segment-scenes") */
  toolName?: string;
  /** For type "asr-api": language hint (e.g. "de" for German). Omit for auto-detect. */
  language?: string;
  /** For type "asr-api": max speech-segment length in seconds. Passed to
   *  temporal segmentation as `--max-len-speech` so ASR never receives audio
   *  the backend rejects (Qwen3-ASR encoder cache tops out ~150s). */
  maxLengthInSec?: number;
  /** For type "asr-api": which API protocol the ASR backend speaks.
   *  - "openai-chat" (default): OpenAI-compatible /v1/chat/completions with audio_url
   *  - "whisper-transcribe": legacy Whisper-style multipart POST /transcribe
   *  - "openai-transcriptions": OpenAI Audio API multipart POST /v1/audio/transcriptions */
  asrProtocol?: "openai-chat" | "whisper-transcribe" | "openai-transcriptions";
  hyperparams?: ModelHyperparams;
  parallelism?: number;    // max concurrent requests, default 4
  /** Default prompt for this model. Absent/undefined = model does not support prompts (UI hides input). String (even "") = model supports prompts (UI shows input, pre-fills with this value). */
  defaultPrompt?: string;
  /** Restrict which media segment types this model can be used with. When absent, compatibility is inferred from model type. */
  compatibleMediaTypes?: MediaSegmentType[];
  /** Maximum context window size in tokens. Informational (no runtime consumer). Default: 32768 */
  maxContextTokens?: number; // Distinct from hyperparams.max_tokens (output-token cap) — not interchangeable.
  /** Whether to enable extended thinking/CoT in chat_template_kwargs. Default: false */
  enableThinking?: boolean;
  /**
   * Native JSON-schema constrained decoding for OpenAI-compatible backends (vLLM).
   * Recommended: pin an explicit mode per model (`"response_format"` for current
   * vLLM) so decoding is deterministic and fail-fast — every plugin schema is
   * converter-compatible and proven schema-conformant by
   * test/e2e-plugin-schema-mode-live.test.ts.
   * - false → prompt-only JSON (explicitly disabled)
   * - undefined → callJson defaults to "auto" (probe once per endpoint+model,
   *   cached; graceful degrade to prompt-only if no transport)
   * - "auto" → probe endpoint+model once, pick a working transport
   * - "response_format" → OpenAI-standard response_format (no probe, fail fast)
   * - "structured_outputs" → vLLM-native structured_outputs.json (v0.12.0+)
   * - "legacy_guided_json" → old guided_json (pre-0.12.0 only)
   *
   * Converter policy (yupToJsonSchema, strict): optional Yup fields are emitted
   * as properties but kept OUT of required[]; their absence never errors. Only
   * unsupported nodes (mixed()) fail fast.
   */
  jsonSchemaMode?: import("../rpc/mllm-api.js").JsonSchemaMode;
  /**
   * Name sent as `response_format.json_schema.name` (response_format transport
   * only). Defaults to "archivar_response". Some backends validate/require a
   * specific name; set this to match. Ignored for structured_outputs/guided_json.
   */
  jsonSchemaName?: string;
  /**
   * Per-model structured-output overrides (max_tokens cap, temperature, retries).
   * When absent, defaults from src/lib/structured-output-defaults.ts are used.
   */
  structuredOutput?: import("./structured-output-defaults.js").StructuredOutputConfig;
  /**
   * Per-request-type start window (max_tokens of attempt 0) for structured
   * calls, resolved by callJson from the active requestPhaseCapture stage.
   * `caption` is intentionally absent — free-form captioning is capped by
   * hyperparams.max_tokens. Truncation bumps double the window up to the 64k
   * ceiling (STRUCTURED_MAX_TOKENS_CEILING); see JSON_MODE_ARCH.md section 6.
   */
  contextWindows?: {
    aggregation?: number;
    hoa?: number;
    summary?: number;
    /** Per-model override for the truncation-bump ceiling. Defaults to the
     *  top-level ArchivarConfig.contextWindows.maxInferenceContext, then to
     *  STRUCTURED_MAX_TOKENS_CEILING (65536). */
    maxInferenceContext?: number;
  };
  /**
   * Per-model ratios for pre-flight input estimation (see
   * src/lib/input-estimation.ts). Calibrated against the live tokenizer with
   * German production text (measured 1.79–1.80 tokens/word; vision ≈340
   * tokens/frame at ~640×360). Defaults apply when unset.
   */
  estimation?: {
    tokensPerWord?: number;
    tokensPerFrame?: number;
  };
  /**
   * Per-call request timeout in ms for this model's LLM calls. Overrides the
   * global default (DEFAULT_LLM_REQUEST_TIMEOUT_MS, 20 min) so a hung endpoint
   * fails fast instead of stalling the pipeline for hours. Set higher for slow
   * video/long-context models.
   */
  requestTimeoutMs?: number;
  /**
   * Inference-side mm_processor_kwargs passed to vLLM for multimodal input processing
   * (e.g. fps, do_sample_frames, video_num_frames). These override the per-method
   * defaults and are merged with any per-step overrides. The `do_sample_frames` and
   * `fps` keys here control how vLLM samples frames from the video during inference.
   */
  mmProcessorKwargs?: Record<string, unknown>;
  /** Whether this model is enabled. When false, the model is skipped by health checks and workflow discovery. Default: true */
  enabled?: boolean;
}

// ============================================================================
// Processing Pipeline
// ============================================================================

/** Media segment types produced by pre-processing tools */
export type MediaSegmentType = "speech" | "harmonic" | "noise" | "silence" | "scene" | "keyframe";

/** A single processing step in a workflow pipeline */
export interface ProcessingStep {
  /** Which media segment type this step processes */
  mediaType: MediaSegmentType;
  /** Reference to a ModelConfig.name */
  modelName: string;
  /** Prompt override (replaces default model prompt) */
  prompt?: string;
  /** System prompt prepended to the conversation */
  systemPrompt?: string;
  /** Per-step hyperparams override (merged with model defaults) */
  hyperparams?: ModelHyperparams;
  /** Per-step override for enableThinking (overrides model default) */
  enableThinking?: boolean;
  /**
   * Per-step mm_processor_kwargs override (merged on top of the model's
   * mmProcessorKwargs, same precedence as hyperparams).
   */
  mmProcessorKwargs?: Record<string, unknown>;
  /** Key under which results are stored (e.g. "caption", "transcription") */
  outputKey?: string;
  /** Whether this step is enabled */
  enabled?: boolean;
  /** For keyframe steps: only process when parent scene has invalid/missing caption.
   *  When true, keyframes are skipped if the corresponding scene caption is valid
   *  (>10 chars, not empty, not error marker). Requires scene processing to complete
   *  before keyframe processing. Default: false */
  enabledAsFallback?: boolean;

  /** When true, injects same-timeframe audio transcripts (speech, harmonics, noise)
   *  into the captioning prompt so the model can align visual and audio content.
   *  Requires audio steps to complete before this step runs.
   *  Valid for mediaType: 'scene' and 'keyframe'. Default: true (opt-out) */
  includeAudioContext?: boolean;

  /** When true, includes the previous scene's caption in the prompt so the model
   *  can classify the relationship between consecutive scenes (continuation,
   *  contrast, new topic, etc.). Forces sequential scene processing.
   *  Valid for mediaType: 'scene' and 'keyframe'. Default: true (opt-out) */
  includePreviousCaption?: boolean;

  /** When true, the captioning prompt includes the # Human Perception Matrix
   *  section with rhetoric/framing/emotion evaluation. Set to false for simpler
   *  captions without perception analysis. Default: true (opt-out) */
  enableHumanPerceptionEvaluation?: boolean;

  /** When true, the captioning prompt includes the # Visuelle Artefakte section
   *  that tracks logos, text overlays, dates, and other significant visual elements.
   *  Set to false to skip visual artifact tracking. Default: true (opt-out) */
  enableVisualArtifactTracking?: boolean;
}

export type ProcessingSteps = Array<ProcessingStep>;

// ============================================================================
// Pre-Processing
// ============================================================================

/**
 * Configuration for the segment-scenes pre-processor.
 *
 * The four numeric knobs exist because each downstream `mediaType: "scene"` model
 * has hard limits on how much video it can ingest (fps, seconds per clip, max
 * resolution). They are set explicitly per workflow — there is no auto-derivation
 * from the model definition.
 *
 * When omitted, the segment-scenes Python CLI applies its own built-in defaults
 * (fps=8, maxWidth=640, maxHeight=448, no max clip length).
 */
export interface SegmentScenesConfig {
  /** Master switch — equivalent to the legacy `segmentScenes: boolean` form.
   *  When omitted in the object form, resolveSegmentScenesConfig defaults it to true. */
  enabled?: boolean;
  /** Output frame rate for cut scene segments (maxLengthPerClipInSecs etc.). */
  fps?: number;
  /** Maximum scene duration in seconds; longer scenes are recursively split. */
  maxLengthPerClipInSecs?: number;
  /** Maximum width in pixels for extracted keyframe PNGs. */
  maxWidthPx?: number;
  /** Maximum height in pixels for cut scene segment videos. */
  maxHeightPx?: number;
  /**
   * Whether vLLM should sample frames from the scene video during inference
   * (inference-side mm_processor_kwargs.do_sample_frames). When omitted, the
   * key is not sent and the vLLM default applies.
   */
  doSampleFrames?: boolean;
  /**
   * Generate keyframe captions ONLY as fallback when video clip caption is missing/empty/invalid.
   * When true, keyframes are only captioned if the corresponding video clip:
   * - Has no caption or caption is < 10 characters
   * - Is shorter than 1 second
   * - Had an error during processing
   * Requires keyframes to be enabled in processing config.
   * Default: false (always generate keyframe captions)
   */
  enabledAsFallback?: boolean;
}

/** Temporal segmentation configuration — extends the boolean shorthand with
 *  optional resolution / fps / clip-length knobs for the external segment-temporal
 *  tool. When set as `true` (legacy form), all optional fields fall back to the
 *  tool's built-in defaults. */
export interface SegmentTemporalConfig {
  /** Master switch (same as `segmentTemporal: true`). Defaults to true. */
  enabled?: boolean;
  /** Maximum width in pixels for output video chunks. */
  maxWidthPx?: number;
  /** Maximum height in pixels for output video chunks. */
  maxHeightPx?: number;
  /** Sampling frame rate (frames per second) for output chunks. */
  fps?: number;
  /** Maximum speech-segment length in seconds (splits long audio for ASR). */
  maxLenSpeechSec?: number;
}

/** Pre-processing tool configuration */
export interface PreProcessingConfig {
  /** Run temporal segmentation (splits audio into speech/harmonic/noise/silence).
   *  Accepts a plain boolean (legacy form) or a SegmentTemporalConfig object for
   *  fine-grained control over resolution / fps / clip length. */
  segmentTemporal?: boolean | SegmentTemporalConfig;
  /**
   * Run scene segmentation (splits video into visual scenes + keyframes).
   * Accepts a plain boolean (legacy form) or a SegmentScenesConfig object for
   * fine-grained control over fps / clip length / resolution.
   */
  segmentScenes?: boolean | SegmentScenesConfig;
}

// ============================================================================
// Post-Processing Plugins
// ============================================================================

/**
 * Post-processing plugin registration within a workflow. The engine
 * dynamically imports `importPath` and calls the module's NAMED hook exports
 * (see PostProcessingPluginModule in plugin-types.ts) — there is no run()
 * entry-point contract.
 */
export interface PostProcessingPluginDefinition<T = unknown> {
  /** Unique name for this plugin */
  name: string;
  /** Human-readable description (shown in UI) */
  description?: string;
  /** Import path for dynamic import (relative to project root or package) */
  importPath: string;
  /** Execution order (lower = first). Default: 0 */
  order?: number;
  /** Whether this plugin is enabled */
  enabled?: boolean;
  /** Plugin-specific configuration */
  config?: T;
}

export type PostProcessingPluginDefinitions = Array<PostProcessingPluginDefinition>;

// ============================================================================
// Post-Processing Runtime Selection
// ============================================================================

/** Runtime override for post-processing (used by UI wizard and CLI) */
export interface PostProcessingSelection {
  /** Per-plugin enable/disable overrides */
  plugins: Array<{ name: string; enabled: boolean; config?: Record<string, unknown> }>;
}

// ============================================================================
// Workflow Definition
// ============================================================================

/** A complete workflow configuration */
export interface WorkflowDefinition {
  /** Unique workflow name (used as identifier) */
  name: string;
  /** Human-readable description */
  description?: string;
  /** Pre-processing steps (tool execution) */
  preProcessing?: PreProcessingConfig;
  /** Processing pipeline steps (model inference) */
  processing: ProcessingSteps;
  /** Post-processing plugins */
  postProcessing?: PostProcessingPluginDefinitions;
  /** Default output format for this workflow */
  outputFormat?: OutputFormat;
}

export type WorkflowDefinitions = Array<WorkflowDefinition>;

// ============================================================================
// Extended Archivar Config
// ============================================================================

/** Dynamic RPC API registration */
export interface AnalysisRpcApiRegistration {
  /** Display name */
  name: string;
  /** Import path for dynamic import */
  importPath: string;
  /** Methods to whitelist (default: ["start"]) */
  whitelistMethods?: string[];
}

/**
 * Allowed values for the visualCaptionFrequency / visualCaptionQuality
 * multipliers. 1 = 100% (no change), 0.5 = half, 0.25 = quarter.
 */
export type VisualCaptionScale = 1 | 0.5 | 0.25;

/**
 * Full archivar configuration. Supplied once at process start by the root
 * archivar.config.ts via setArchivarConfig(); consumed everywhere through the
 * archivar-config.ts accessors. Keep secrets out of this object — endpoint,
 * apiKey and model fields support "env:VAR_NAME" indirection, and the
 * MODEL_CONFIG env var supplies runtime credential overrides (see getModel()
 * in archivar-config.ts).
 */
export interface ArchivarConfig {
  auth: {
    users: Array<{
      username: string;
      password: string;
    }>;
  };
  /** Named model configurations */
  models?: ModelConfig[];
  /** Available analysis workflows */
  workflows?: WorkflowDefinitions;
  /** Dynamic RPC API plugins */
  analysisRpcApis?: AnalysisRpcApiRegistration[];
  /** vLLM repetition_detection defaults (v0.25+), sent on every chat-completions
   *  request to models with inferenceEngine "vllm" and type !== "asr-api". */
  repetitionDetection?: RepetitionDetectionConfig;
  /** Milder repetition_detection variant used on structured-output calls
   *  (large min_pattern_size so JSON syntax repetition never triggers). */
  repetitionDetectionStructured?: RepetitionDetectionConfig;
  /** Multiplier on the per-workflow segmentScenes base `fps`
   *  (0.5 → 0.5 FPS = 1 frame every 2 s, 0.25 → 1 frame every 4 s).
   *  Applied at config resolution; reaches segment-scenes (--fps),
   *  segment-temporal (--preprocess-fps) and the vLLM mm_processor_kwargs
   *  consistently. Defaults to 1 (100%) when unset. */
  visualCaptionFrequency?: VisualCaptionScale;
  /** Multiplier on the per-workflow segmentScenes base `maxWidthPx` and
   *  `maxHeightPx` for resolution reduction. Reaches segment-scenes
   *  (--max-width-px/--max-height-px) and segment-temporal
   *  (--preprocess-width/--preprocess-height). Defaults to 1 (100%) when unset. */
  visualCaptionQuality?: VisualCaptionScale;
  /** Short-clip rule: scene clips SHORTER than this many seconds are always
   *  processed with at least `shortClipMinFps` fps, regardless of
   *  visualCaptionFrequency. Applies per individual scene clip (also inside
   *  long videos). Only active when BOTH fields are set; unset = rule off. */
  shortClipMaxLengthSec?: number;
  /** Minimum fps guaranteed for clips shorter than `shortClipMaxLengthSec`.
   *  Also floors the physical re-encode fps (segment-scenes --fps), since
   *  inference cannot sample frames the file does not contain. */
  shortClipMinFps?: number;
  /** Global context-window knobs. */
  contextWindows?: {
    /** Hard ceiling for the truncation-bump ladder (structured calls via
     *  callJson and free-form captioning via callWithPrompt): max_tokens
     *  doubles on finish_reason "length" up to this value. Defaults to 65536.
     *  Per-model override: ModelConfig.contextWindows.maxInferenceContext.
     *  The deployment's --max-model-len stays the physical bound — the
     *  context-length clamp catches any overshoot (non-fatal). */
    maxInferenceContext?: number;
  };
  /** Default settings */
  defaults?: {
    /** Default workflow name */
    workflow?: string;
    /** Default output format */
    outputFormat?: OutputFormat;
  };
}

// ============================================================================
// Per-File Workflow Config (persisted as <filename>.workflow.json)
// ============================================================================

/** Per-media-type override (model + prompt) */
export interface FileWorkflowStepOverride {
  modelName: string;
  prompt?: string;
  systemPrompt?: string;
}

/** Persisted per-upload-file workflow configuration */
export interface FileWorkflowConfig {
  /** Base workflow name to start from */
  workflow: string;
  /** Sparse overrides keyed by media segment type */
  overrides?: Partial<Record<MediaSegmentType, FileWorkflowStepOverride>>;
  /** Post-processing overrides (plugin toggles) */
  postProcessing?: PostProcessingSelection;
  /** ISO timestamp of last analysis run */
  lastRun?: string;
}

// ============================================================================
// Post-Processing Plugin Interface
// ============================================================================

/** Type of media content in a time slice */
// REFACTOR(dry): duplicate of SliceType in src/lib/plugin-types.ts:68 and of
// MediaSegmentType above (line 106) — one union, three declarations; see the
// tag in plugin-types.ts for details.
export type SliceType = "speech" | "harmonic" | "noise" | "silence" | "scene" | "keyframe";

// ============================================================================
// Processing Timing
// ============================================================================

/** A single timing entry for a measured operation */
export interface TimingEntry {
  /** Human-readable label, e.g. "segmentTemporal", "scene segment #3" */
  label: string;
  /** Duration in milliseconds */
  durationMs: number;
  /** Optional child timings for hierarchical aggregation */
  children?: TimingEntries;
  /** Optional 1:1 reference to the output data (JSON path or file path) */
  reference?: string;
}

export type TimingEntries = Array<TimingEntry>;
