import { getEnv } from "defuss-env";
import type { ArchivarConfig, ModelConfig, WorkflowDefinition, PreProcessingConfig, SegmentScenesConfig, SegmentTemporalConfig, RepetitionDetectionConfig, VisualCaptionScale } from "./workflow-types.js";
import type { VlmRequestType } from "./vlm-request-collector.js";
import { STRUCTURED_MAX_TOKENS_CEILING } from "./structured-output-defaults.js";
import { DEFAULT_TOKENS_PER_WORD, DEFAULT_TOKENS_PER_FRAME, type ModelEstimation } from "./input-estimation.js";
import { defaultJsonSchemaModeForModel } from "./json-schema-mode-defaults.js";

// Re-export the config type from workflow-types
export type { ArchivarConfig } from "./workflow-types.js";

/** Shape of one entry in the MODEL_CONFIG env-var JSON array: runtime
 *  endpoint/credential overrides for a statically declared model, matched by name. */
interface RuntimeModelEntry {
  name: string;
  endpoint?: string;
  apiKey?: string;
  model?: string;
}

let _config: ArchivarConfig | null = null;
let _modelConfigCache: Map<string, RuntimeModelEntry> | null = null;

/**
 * Load MODEL_CONFIG from environment variable and parse as JSON.
 * Returns a Map keyed by model name for fast lookups.
 * Parsed once, then cached for the process lifetime — the cache is cleared by
 * setArchivarConfig(), NOT re-read per call. A malformed MODEL_CONFIG degrades
 * to an empty override map so a bad env var never crashes startup.
 */
function loadModelConfigFromEnv(): Map<string, RuntimeModelEntry> {
  if (_modelConfigCache) return _modelConfigCache;
  const raw = getEnv("MODEL_CONFIG", "");
  if (!raw) {
    _modelConfigCache = new Map();
    return _modelConfigCache;
  }
  try {
    const entries: RuntimeModelEntry[] = JSON.parse(raw);
    _modelConfigCache = new Map(entries.map((e) => [e.name, e]));
  } catch (e) {
    console.warn("[archivar-config] Failed to parse MODEL_CONFIG:", e);
    _modelConfigCache = new Map();
  }
  return _modelConfigCache;
}

/**
 * Resolve "env:VAR_NAME" strings to their environment variable values.
 * Non-prefixed strings are returned as-is.
 *
 * Defensive against undefined/null: some optional config fields (e.g. a model
 * without an explicit `endpoint`, relying on MODEL_CONFIG override) reach here
 * as undefined and must not crash the whole server — return the fallback.
 */
export function resolveEnvValue(value: string | undefined | null, fallback?: string): string {
  if (!value) return fallback ?? "";
  if (value.startsWith("env:")) {
    const envKey = value.slice(4);
    return getEnv(envKey, fallback ?? "");
  }
  return value;
}

/**
 * Resolve the vLLM repetition_detection parameters for a model.
 * Returns the config-level repetitionDetection defaults only when the model is
 * served by vLLM AND is not an ASR model — ASR must never get repetition
 * detection (speakers legitimately repeat themselves).
 */
export function resolveRepetitionDetection(model: ModelConfig): RepetitionDetectionConfig | undefined {
  if (model.type === "asr-api" || model.inferenceEngine !== "vllm") return undefined;
  return getArchivarConfig().repetitionDetection;
}

/**
 * Get a model config by name, with env values resolved.
 * Merges static config (type, hyperparams, prompt, etc.) with runtime credentials
 * from MODEL_CONFIG env var (matched by model name).
 * 
 * Resolution order:
 * - endpoint: MODEL_CONFIG override > static config > env:VAR
 * - apiKey: MODEL_CONFIG override > static config > env:VAR
 * - model: static config (may contain env:VAR) > MODEL_CONFIG override
 */
export function getModel(name: string): ModelConfig & { resolvedEndpoint: string; resolvedApiKey?: string; resolvedModel: string; resolvedRepetitionDetection?: RepetitionDetectionConfig } {
  const config = getArchivarConfig();
  const model = config.models?.find((m) => m.name === name);
  if (!model) {
    throw new Error(`Model "${name}" not found in archivar config. Available: ${config.models?.map((m) => m.name).join(", ") ?? "none"}`);
  }

  // Load runtime overrides from MODEL_CONFIG
  const runtimeOverrides = loadModelConfigFromEnv();
  const override = runtimeOverrides.get(name);
  // REFACTOR(kiss): ~6 unconditional log lines per call, and getModel() runs on
  // every model lookup (per processing step, plugin hook, health probe) — gate
  // behind a debug env flag or collapse to a single summary line.
  console.log("[archivar-config] getModel(" + name + "): override=", override ? "found" : "none");

  // Resolve endpoint: override > static config > env:VAR
  let resolvedEndpoint: string;
  if (override?.endpoint) {
    resolvedEndpoint = override.endpoint;
    console.log("[archivar-config] getModel(" + name + "): endpoint from MODEL_CONFIG =", resolvedEndpoint);
  } else if (model.endpoint) {
    resolvedEndpoint = resolveEnvValue(model.endpoint);
    console.log("[archivar-config] getModel(" + name + "): endpoint from static config =", resolvedEndpoint);
  } else {
    resolvedEndpoint = "";
    console.warn("[archivar-config] getModel(" + name + "): NO endpoint found!");
  }

  // Resolve apiKey: override > static config > env:VAR
  let resolvedApiKey: string | undefined;
  if (override?.apiKey) {
    resolvedApiKey = override.apiKey;
    console.log("[archivar-config] getModel(" + name + "): apiKey from MODEL_CONFIG (len=" + resolvedApiKey.length + ")");
  } else if (model.apiKey) {
    resolvedApiKey = resolveEnvValue(model.apiKey);
    console.log("[archivar-config] getModel(" + name + "): apiKey from static config");
  } else {
    console.warn("[archivar-config] getModel(" + name + "): NO apiKey found!");
  }

  // Resolve model name: static config (may contain env:VAR) > MODEL_CONFIG override
  const resolvedModel = model.model ? resolveEnvValue(model.model) : (override?.model ?? name);
  console.log("[archivar-config] getModel(" + name + "): resolvedModel =", resolvedModel);

  // Resolve jsonSchemaMode with precedence:
  //   explicit ModelConfig.jsonSchemaMode  >  model-name registry default  >  undefined
  // (callJson then treats undefined as "auto" probe). The registry maps known
  // model families (gemma4 → response_format, qwen3 → structured_outputs) so
  // deployments get a deterministic, no-probe transport without per-model config.
  const registryDefault = defaultJsonSchemaModeForModel(resolvedModel);
  const resolvedJsonSchemaMode = model.jsonSchemaMode ?? registryDefault;
  console.log(
    "[archivar-config] getModel(" + name + "): jsonSchemaMode =",
    model.jsonSchemaMode ? `(config) ${String(model.jsonSchemaMode)}` : `(registry) ${registryDefault}`,
  );

  return {
    ...model,
    resolvedEndpoint,
    resolvedApiKey,
    resolvedModel,
    jsonSchemaMode: resolvedJsonSchemaMode as ModelConfig["jsonSchemaMode"],
    resolvedRepetitionDetection: resolveRepetitionDetection(model),
  };
}

/**
 * Structured-call repetition_detection defaults; undefined when unset or no
 * config installed. Read directly from the module singleton (safe at any time).
 */
export function getStructuredRepetitionDetection(): RepetitionDetectionConfig | undefined {
  return _config?.repetitionDetectionStructured;
}

/**
 * Top-level visualCaptionFrequency multiplier (on the segmentScenes base fps);
 * 1 (100%) when unset or no config installed. Read from the module singleton.
 */
export function getVisualCaptionFrequency(): VisualCaptionScale {
  return _config?.visualCaptionFrequency ?? 1;
}

/**
 * Top-level visualCaptionQuality multiplier (on the segmentScenes base
 * maxWidthPx/maxHeightPx); 1 (100%) when unset or no config installed.
 */
export function getVisualCaptionQuality(): VisualCaptionScale {
  return _config?.visualCaptionQuality ?? 1;
}

/** Active short-clip rule, or undefined when disabled (only one field set is
 * rejected at setArchivarConfig, so both-or-none holds here). */
export function getShortClipFpsRule(): { maxLengthSec: number; minFps: number } | undefined {
  const maxLengthSec = _config?.shortClipMaxLengthSec;
  const minFps = _config?.shortClipMinFps;
  if (maxLengthSec === undefined || minFps === undefined) return undefined;
  return { maxLengthSec, minFps };
}

/**
 * Per-scene-clip fps: clips shorter than the configured threshold
 * (shortClipMaxLengthSec) are processed with at least shortClipMinFps,
 * regardless of visualCaptionFrequency. Rule off or unknown duration →
 * baseFps unchanged. Pure function — exported for unit testing.
 */
export function resolveSegmentFps(baseFps: number, durationSec?: number): number {
  const rule = getShortClipFpsRule();
  if (!rule || durationSec === undefined) return baseFps;
  return durationSec < rule.maxLengthSec ? Math.max(baseFps, rule.minFps) : baseFps;
}

/**
 * Physical re-encode fps floor for segment-scenes (--fps): the file must
 * contain at least shortClipMinFps frames per second, otherwise short clips
 * would lack the frames resolveSegmentFps asks for at inference time.
 * Pure function — exported for unit testing.
 */
export function resolvePhysicalReencodeFps(baseFps: number): number {
  const rule = getShortClipFpsRule();
  return rule ? Math.max(baseFps, rule.minFps) : baseFps;
}

/**
 * Per-request-type start window (max_tokens of attempt 0) for structured calls.
 * Looks the model up by registry name or resolved model string and reads
 * contextWindows[type]; undefined when the model or the type key is absent.
 * caption/undefined always yield undefined — free-form captioning is capped by
 * hyperparams.max_tokens, not by the start-window map.
 */
export function resolveStartMaxTokens(model: string, type: VlmRequestType | undefined): number | undefined {
  if (type === undefined || type === "caption") return undefined;
  const m = _config?.models?.find((mc) => mc.name === model || mc.model === model);
  return m?.contextWindows?.[type];
}

/**
 * Hard ceiling for the truncation-bump ladder, resolved per model:
 * ModelConfig.contextWindows.maxInferenceContext → top-level
 * ArchivarConfig.contextWindows.maxInferenceContext → STRUCTURED_MAX_TOKENS_CEILING
 * (65536). The deployment's --max-model-len stays the physical bound — the
 * context-length clamp in mllm-api catches any overshoot (non-fatal).
 */
export function resolveMaxInferenceContext(model: string): number {
  const m = _config?.models?.find((mc) => mc.name === model || mc.model === model);
  return m?.contextWindows?.maxInferenceContext
    ?? _config?.contextWindows?.maxInferenceContext
    ?? STRUCTURED_MAX_TOKENS_CEILING;
}

/**
 * Optional structured-sampling extras (Qwen non-thinking profile). Returns the
 * per-model overrides when configured — presencePenalty / topP / topK from
 * ModelConfig.structuredOutput; all undefined when the model doesn't pin them,
 * which preserves the established defaults (presence 0, builder top_p/top_k).
 */
export function resolveStructuredExtras(model: string): { presencePenalty?: number; topP?: number; topK?: number } {
  const m = _config?.models?.find((mc) => mc.name === model || mc.model === model);
  return {
    presencePenalty: m?.structuredOutput?.presencePenalty,
    topP: m?.structuredOutput?.topP,
    topK: m?.structuredOutput?.topK,
  };
}

/**
 * Per-model input-estimation ratios for pre-flight context budgeting,
 * falling back to the measured defaults (see input-estimation.ts).
 */
export function resolveEstimation(model: string): ModelEstimation {
  const m = _config?.models?.find((mc) => mc.name === model || mc.model === model);
  return {
    tokensPerWord: m?.estimation?.tokensPerWord ?? DEFAULT_TOKENS_PER_WORD,
    tokensPerFrame: m?.estimation?.tokensPerFrame ?? DEFAULT_TOKENS_PER_FRAME,
  };
}

/**
 * Get a workflow config by name.
 */
export function getWorkflow(name: string): WorkflowDefinition {
  const config = getArchivarConfig();
  const workflow = config.workflows?.find((w) => w.name === name);
  if (!workflow) {
    throw new Error(`Workflow "${name}" not found in archivar config. Available: ${config.workflows?.map((w) => w.name).join(", ") ?? "none"}`);
  }
  return workflow;
}

/**
 * The workflow to use when the caller did not name one: the configured
 * `defaults.workflow`, else the first workflow in the config. Single source
 * for the default-workflow fallback (previously a hardcoded literal that
 * drifted). Throws when the config has no workflows at all.
 */
export function resolveDefaultWorkflowName(config: ArchivarConfig): string {
  const name = config.defaults?.workflow ?? config.workflows?.[0]?.name;
  if (!name) {
    throw new Error("No workflows configured in archivar config.");
  }
  return name;
}

/**
 * Resolve the VLM (scene captioning) and ASR (speech transcription) model
 * names of a workflow. Returns `{}` when the workflow is unknown (e.g.
 * renamed/removed from the config since the run).
 */
export function resolveWorkflowModels(workflowName: string): { vlm?: string; asr?: string } {
  try {
    const wf = getWorkflow(workflowName);
    return {
      vlm: wf.processing?.find((s) => s.mediaType === "scene" && s.enabled !== false)?.modelName,
      asr: wf.processing?.find((s) => s.mediaType === "speech" && s.enabled !== false)?.modelName,
    };
  } catch {
    return {};
  }
}

/**
 * List all available workflows (name + description).
 */
export function listWorkflows(): Array<{ name: string; description?: string }> {
  const config = getArchivarConfig();
  return (config.workflows ?? []).map((w) => ({ name: w.name, description: w.description }));
}

/**
 * Resolve the segmentScenes pre-processing entry into a normalized object form.
 *
 * Accepts the legacy boolean shorthand (`true`/`false`) or a SegmentScenesConfig
 * object. Returns `{ enabled: false }` when unset, so callers can always read
 * `cfg.enabled` without null-checks.
 *
 * Pure function — exported so workflow-engine and tests can share it.
 */
export function resolveSegmentScenesConfig(value: boolean | SegmentScenesConfig | undefined): SegmentScenesConfig {
  if (value === undefined || value === false) return { enabled: false };
  if (value === true) return { enabled: true };
  // Object form: spread first so an explicit `enabled` keeps precedence, then
  // default `enabled` to true when the caller omitted it.
  return { ...value, enabled: value.enabled ?? true };
}

/**
 * Legibility floor for visual captioning downscale caps, measured
 * against Qwen3.8-27B-FP8 (demo.mp4 overlay + product logo): at 608×342 the
 * model lost small object text, at 796×448 all text incl. object text was
 * read correctly, and upscaling beyond native added nothing — 796×448 is the
 * measured Pareto point. Multipliers and per-workflow config must never push
 * the effective caps below this.
 */
export const MIN_CAPTION_MAX_WIDTH_PX = 796;
export const MIN_CAPTION_MAX_HEIGHT_PX = 448;

/**
 * Resolve the segmentScenes config with the top-level visualCaptionFrequency /
 * visualCaptionQuality multipliers applied — the *effective* values every
 * consumer (segment-scenes CLI args, segment-temporal --preprocess-*
 * inheritance, inference mm_processor_kwargs) must use so preprocessing and
 * vLLM frame sampling stay consistent. The raw per-workflow base values are
 * never mutated; the multipliers read from the module singleton default to 1.
 *
 * fps stays fractional (0.5 / 0.25 are valid tool inputs); pixel dimensions
 * are rounded to integers and floored at MIN_CAPTION_MAX_* (legibility).
 */
export function resolveEffectiveSegmentScenesConfig(value: boolean | SegmentScenesConfig | undefined): SegmentScenesConfig {
  const cfg = resolveSegmentScenesConfig(value);
  const frequency = getVisualCaptionFrequency();
  const quality = getVisualCaptionQuality();
  const effective: SegmentScenesConfig = { ...cfg };
  if (effective.fps !== undefined) effective.fps = effective.fps * frequency;
  if (effective.maxWidthPx !== undefined) effective.maxWidthPx = Math.max(MIN_CAPTION_MAX_WIDTH_PX, Math.round(effective.maxWidthPx * quality));
  if (effective.maxHeightPx !== undefined) effective.maxHeightPx = Math.max(MIN_CAPTION_MAX_HEIGHT_PX, Math.round(effective.maxHeightPx * quality));
  return effective;
}

/**
 * Build the CLI argument array passed to `segment-scenes run.sh` from a config.
 * Only emits flags for explicitly provided values so the Python defaults take
 * effect otherwise. maxLengthPerClipInSecs maps to the existing `--max-len` flag.
 *
 * Pure function — exported for unit testing.
 */
export function buildSegmentScenesCliArgs(cfg: SegmentScenesConfig): string[] {
  const args: string[] = [];
  // NOTE: the segment-scenes `run.sh` wrapper does NOT accept the `--flag=value`
  // (equals) form — it rejects it as "Unknown option". Emit space-separated
  // argv tokens (`--flag`, `value`) to match the tool's documented usage.
  if (cfg.fps !== undefined) { args.push("--fps", String(cfg.fps)); }
  if (cfg.maxLengthPerClipInSecs !== undefined) { args.push("--max-len", String(cfg.maxLengthPerClipInSecs)); }
  if (cfg.maxWidthPx !== undefined) { args.push("--max-width-px", String(cfg.maxWidthPx)); }
  if (cfg.maxHeightPx !== undefined) { args.push("--max-height-px", String(cfg.maxHeightPx)); }
  return args;
}

/**
 * Resolve the segmentTemporal pre-processing entry into a normalized object form
 * (mirrors resolveSegmentScenesConfig). Accepts boolean or SegmentTemporalConfig.
 */
export function resolveSegmentTemporalConfig(value: boolean | SegmentTemporalConfig | undefined): SegmentTemporalConfig {
  if (value === undefined || value === false) return { enabled: false };
  if (value === true) return { enabled: true };
  return { ...value, enabled: value.enabled ?? true };
}

/**
 * Build the CLI argument array passed to `segment-temporal run.sh` from a config.
 * Only emits flags for explicitly provided values so the tool defaults apply otherwise.
 */
export function buildSegmentTemporalCliArgs(cfg: SegmentTemporalConfig): string[] {
  const args: string[] = [];
  if (cfg.fps !== undefined) { args.push("--preprocess-fps", String(cfg.fps)); }
  if (cfg.maxWidthPx !== undefined) { args.push("--preprocess-width", String(cfg.maxWidthPx)); }
  if (cfg.maxHeightPx !== undefined) { args.push("--preprocess-height", String(cfg.maxHeightPx)); }
  if (cfg.maxLenSpeechSec !== undefined) { args.push("--max-len-speech", String(cfg.maxLenSpeechSec)); }
  return args;
}

/**
 * Build the inference-side `mm_processor_kwargs` override object that gets passed
 * to vLLM when processing scene videos.
 *
 * Merges, in precedence order (later wins):
 * 1. model.mmProcessorKwargs (per-model defaults)
 * 2. step.mmProcessorKwargs   (per-step overrides)
 * 3. segmentScenesCfg.fps → fps key, segmentScenesCfg.doSampleFrames → do_sample_frames key
 *
 * Only scene-type segments get the fps/do_sample_frames injection, since those
 * knobs only apply to video frame sampling during inference.
 *
 * Pure function — exported for unit testing.
 */
export function buildInferenceMmProcessorKwargs(
  modelKwargs: Record<string, unknown> | undefined,
  stepKwargs: Record<string, unknown> | undefined,
  segmentScenesCfg: SegmentScenesConfig | undefined,
  mediaCategory: "audio" | "video" | "image",
  /** Duration of the individual scene clip in seconds — drives the short-clip
   *  fps rule (resolveSegmentFps). */
  durationSec?: number,
): Record<string, unknown> | undefined {
  const merged: Record<string, unknown> = {};
  if (modelKwargs) Object.assign(merged, modelKwargs);
  if (stepKwargs) Object.assign(merged, stepKwargs);

  if (mediaCategory === "video" && segmentScenesCfg) {
    // Inject fps and do_sample_frames from the pre-processing config so the
    // inference side samples frames at the same rate as the pre-processor.
    if (segmentScenesCfg.fps !== undefined) merged.fps = segmentScenesCfg.fps;
    if (segmentScenesCfg.doSampleFrames !== undefined) merged.do_sample_frames = segmentScenesCfg.doSampleFrames;
  }

  // Short-clip rule: individual clips under the threshold get at least
  // shortClipMinFps (the physical re-encode fps is floored correspondingly).
  if (mediaCategory === "video" && typeof merged.fps === "number") {
    merged.fps = resolveSegmentFps(merged.fps, durationSec);
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Apply default values before validation: the legacy boolean segmentScenes
 * form is normalized to the object form so downstream code sees a single shape.
 */
function applyDefaults(config: ArchivarConfig): void {
  for (const workflow of config.workflows ?? []) {
    const pre: PreProcessingConfig | undefined = workflow.preProcessing;
    if (!pre) continue;
    // Normalize legacy boolean form to the object form so downstream code has
    // a single shape to deal with.
    pre.segmentScenes = resolveSegmentScenesConfig(pre.segmentScenes);
  }
}

/** Cross-reference every workflow step's modelName against the model registry. */
function validateConfig(config: ArchivarConfig): void {
  const modelNames = new Set((config.models ?? []).map((m) => m.name));

  for (const workflow of config.workflows ?? []) {
    for (const step of workflow.processing) {
      if (!modelNames.has(step.modelName)) {
        throw new Error(
          `Workflow "${workflow.name}" references model "${step.modelName}" which is not defined. Available models: ${[...modelNames].join(", ") || "none"}`
        );
      }
    }
  }
}

const VALID_VISUAL_CAPTION_SCALES: readonly number[] = [1, 0.5, 0.25];

/**
 * Boundary check for the top-level visual caption multipliers. Runs on every
 * setArchivarConfig() — unlike validateConfig() it has no model/workflow
 * cross-reference dependency.
 */
function validateVisualCaptionScales(config: ArchivarConfig): void {
  for (const key of ["visualCaptionFrequency", "visualCaptionQuality"] as const) {
    const value = config[key];
    if (value !== undefined && !VALID_VISUAL_CAPTION_SCALES.includes(value)) {
      throw new Error(`Invalid ${key}: ${value}. Allowed values: 1, 0.5, 0.25.`);
    }
  }
}

/**
 * Boundary check for the short-clip fps rule: both fields must be set
 * together, and both must be positive. Runs on every setArchivarConfig().
 */
function validateShortClipFpsRule(config: ArchivarConfig): void {
  const { shortClipMaxLengthSec, shortClipMinFps } = config;
  if (shortClipMaxLengthSec === undefined && shortClipMinFps === undefined) return;
  if (shortClipMaxLengthSec === undefined || shortClipMinFps === undefined) {
    throw new Error(
      `Invalid short-clip rule: shortClipMaxLengthSec and shortClipMinFps must be set together (got ${shortClipMaxLengthSec} / ${shortClipMinFps}).`,
    );
  }
  if (shortClipMaxLengthSec <= 0 || shortClipMinFps <= 0) {
    throw new Error(
      `Invalid short-clip rule: both values must be positive (got ${shortClipMaxLengthSec} / ${shortClipMinFps}).`,
    );
  }
}

/**
 * Boundary check for per-model contextWindows start values. Runs on every
 * setArchivarConfig() alongside validateVisualCaptionScales. Start windows are
 * bounded by the default ceiling; maxInferenceContext itself is unbounded
 * (deployment-specific, guarded by the context clamp at runtime).
 */
function validateContextWindows(config: ArchivarConfig): void {
  const checkCeiling = (label: string, value: unknown): void => {
    if (value !== undefined && (!Number.isInteger(value) || (value as number) <= 0)) {
      throw new Error(`Invalid ${label}: ${value}. Must be a positive integer.`);
    }
  };
  checkCeiling("contextWindows.maxInferenceContext", config.contextWindows?.maxInferenceContext);
  for (const model of config.models ?? []) {
    for (const [key, value] of Object.entries(model.contextWindows ?? {})) {
      if (key === "maxInferenceContext") {
        checkCeiling(`contextWindows.maxInferenceContext for model "${model.name}"`, value);
        continue;
      }
      if (!Number.isInteger(value) || (value as number) <= 0 || (value as number) > STRUCTURED_MAX_TOKENS_CEILING) {
        throw new Error(
          `Invalid contextWindows.${key} for model "${model.name}": ${value}. Must be an integer in 1..${STRUCTURED_MAX_TOKENS_CEILING}.`
        );
      }
    }
    for (const [key, value] of Object.entries(model.estimation ?? {})) {
      if (typeof value !== "number" || !(value > 0)) {
        throw new Error(`Invalid estimation.${key} for model "${model.name}": ${value}. Must be a positive number.`);
      }
    }
  }
}

/**
 * Install the process-wide ArchivarConfig singleton. Called once at startup
 * from the root archivar.config.ts (and by tests with mock configs); all
 * accessors in this module read it. Re-setting swaps the config and clears
 * the MODEL_CONFIG cache so runtime overrides are re-read on next getModel().
 */
export function setArchivarConfig(config: ArchivarConfig) {
  validateVisualCaptionScales(config);
  validateShortClipFpsRule(config);
  validateContextWindows(config);
  applyDefaults(config);
  // Cross-validate only when BOTH registries exist: partial configs (models
  // without workflows or vice versa, e.g. in tests) must load without
  // throwing — dangling references still fail lazily at getModel()/getWorkflow().
  if (config.models && config.workflows) {
    validateConfig(config);
  }
  _config = config;
  // Clear MODEL_CONFIG cache so it reloads on next getModel()
  _modelConfigCache = null;
}

/**
 * Read the installed ArchivarConfig. Throws when unset — fail fast at first
 * use rather than letting a missing config surface as unrelated downstream
 * errors.
 */
export function getArchivarConfig(): ArchivarConfig {
  if (!_config) {
    throw new Error("ArchivarConfig not set. Call setArchivarConfig() first.");
  }
  return _config;
}
