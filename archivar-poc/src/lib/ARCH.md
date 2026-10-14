# `src/lib/`-Architecture Reference

This directory contains shared library modules: configuration resolution, type
definitions, networking utilities, timing instrumentation, and the v3 plugin
contract.

---

## `aggregated-cache-key.ts`
[`src/lib/aggregated-cache-key.ts`](src/lib/aggregated-cache-key.ts)

**Purpose:** Reader-side matcher for the `aggregated` cache table. The engine
writes `${workflowName}-${outputHash}-${pluginVersions}`; readers without
access to plugin definitions (CSR dashboard, client-side full-analysis) match
by the `${workflowName}-${outputHash}` prefix via
[`findAggregatedCacheKey()`](src/lib/aggregated-cache-key.ts), preferring
versioned engine keys over legacy exact keys. Pure function, no I/O.

---

## `archivar-config.ts`
[`src/lib/archivar-config.ts`](src/lib/archivar-config.ts)

**Purpose:** Central singleton store for the parsed [`ArchivarConfig`](src/lib/archivar-config.ts),
plus the runtime API used throughout the codebase to resolve models
([`getModel()`](src/lib/archivar-config.ts)) and workflows
([`getWorkflow()`](src/lib/archivar-config.ts)). Also exposes pure helpers
for normalizing and building CLI arguments for the segment-scenes pre-processor.

**Key Concerns:**

- **Cache management (module-level singletons):** Two module-scoped variables -
  `_config` (the parsed config object) and `_modelConfigCache` (a `Map<string,
  RuntimeModelEntry>`)-are cached for the lifetime of the process.
  [`setArchivarConfig()`](src/lib/archivar-config.ts) clears
  `_modelConfigCache` on each call so runtime credentials reload on next
  [`getModel()`](src/lib/archivar-config.ts) invocation.

- **Environment-variable-driven path/credential resolution:** The
  [`MODEL_CONFIG`](src/lib/archivar-config.ts) environment variable is parsed
  as JSON and indexed by model name at
  [`loadModelConfigFromEnv()`](src/lib/archivar-config.ts). Its entries take
  precedence as runtime overrides. Additionally,
  [`resolveEnvValue()`](src/lib/archivar-config.ts) expands any string with
  the `env:` prefix (e.g. `"env:MLLM_API_KEY"`) into the corresponding
  environment variable value. The combined resolution priority for
  [`getModel()`](src/lib/archivar-config.ts) is:
  endpoint → `MODEL_CONFIG` override > static config (after `env:` expansion) >
  empty; apiKey → `MODEL_CONFIG` override > static config (after `env:`
  expansion) > absent; model → static config (after `env:` expansion) >
  `MODEL_CONFIG` override.

- **vLLM repetition_detection resolution:** [`resolveRepetitionDetection()`](src/lib/archivar-config.ts)
  returns the config-level `ArchivarConfig.repetitionDetection` defaults (vLLM
  v0.25+) only for models with `inferenceEngine === "vllm"` AND `type !==
  "asr-api"`-ASR never gets repetition detection because speakers
  legitimately repeat themselves. [`getModel()`](src/lib/archivar-config.ts)
  attaches the result as `resolvedRepetitionDetection` on the returned model
  config; callers pass it through to `MllmApi.callWithPrompt`/
  `callWithPromptRaw`, which attach it as the top-level `repetition_detection`
  body field.

- **Workflow model resolution:** [`resolveWorkflowModels()`](src/lib/archivar-config.ts)
  extracts the VLM (scene captioning) and ASR (speech transcription) model
  names from a workflow definition, returning `{}` when the workflow is
  unknown. Used to record `models` in `status.json` at workflow start and as
  the config fallback when exports read them back.

- **Config validation:** [`validateConfig()`](src/lib/archivar-config.ts)
  cross-references every workflow step's `modelName`
  against the declared model registry, throwing on dangling references.
  [`applyDefaults()`](src/lib/archivar-config.ts) normalizes the legacy
  boolean form of `segmentScenes` into the object form via
  [`resolveSegmentScenesConfig()`](src/lib/archivar-config.ts).
  Independently of that cross-reference, `validateVisualCaptionScales()` runs on
  every `setArchivarConfig()` and rejects `visualCaptionFrequency` /
  `visualCaptionQuality` values outside `{1, 0.5, 0.25}`.
  `validateContextWindows()` likewise rejects non-integer/out-of-range
  per-model `contextWindows` values (1..65536).

- **Per-type start windows:** [`resolveStartMaxTokens()`](src/lib/archivar-config.ts)
  resolves the `max_tokens` start window for structured calls from
  `ModelConfig.contextWindows` keyed by request type
  (`aggregation`/`hoa`/`summary`-`caption` always yields `undefined`;
  free-form captioning keeps `hyperparams.max_tokens`). `callJson` reads the
  type from the `requestPhaseCapture` ALS store, falls back to the
  plugin-passed `structuredMaxTokens`, and doubles on truncation up to the
  ceiling from [`resolveMaxInferenceContext()`](src/lib/archivar-config.ts)
  (per-model `contextWindows.maxInferenceContext` → top-level
  `ArchivarConfig.contextWindows.maxInferenceContext` → 65536 default).
  Free-form captioning (`callWithPrompt`) bumps the same way on
  `finish_reason: "length"` without a transport, returning partial content at
  the ceiling. The full strategy (ladder, context clamp, QA inheritance of the
  summary window) is documented in [`JSON_MODE_ARCH.md`](src/rpc/JSON_MODE_ARCH.md)
  section 6.

- **Pre-flight input estimation:** [`input-estimation.ts`](src/lib/input-estimation.ts)
  caps `max_tokens` per attempt at
  `resolveMaxInferenceContext(model) − inputEst − 1024`
  (words × `tokensPerWord` + frames × `tokensPerFrame`, ratios per model via
  [`resolveEstimation()`](src/lib/archivar-config.ts), calibrated live:
  1.79–1.80 tokens/word German → 2.0; ≈340 tokens/frame). On a residual 400,
  bounded halving runs (video: frames first, then output; text: output only -
  prompt content is never cut).

- **Inference-side `mm_processor_kwargs` merge:** [`buildInferenceMmProcessorKwargs()`](src/lib/archivar-config.ts)
  is the pure merge function that assembles the override object passed to vLLM's
  `mm_processor_kwargs` field. It merges three sources in precedence order (later wins):
  `ModelConfig.mmProcessorKwargs` (per-model defaults) → `ProcessingStep.mmProcessorKwargs`
  (per-step overrides) → `SegmentScenesConfig.fps`/`doSampleFrames` (per-workflow overrides,
  injected only for `mediaCategory: "video"`). Returns `undefined` when no source provides
  any key, so callers can detect "no override" and fall back to vLLM defaults.

---

## `file-workflow-config.ts`
[`src/lib/file-workflow-config.ts`](src/lib/file-workflow-config.ts)

**Purpose:** Manages per-upload-file workflow overrides that are persisted
alongside the media file as `<uploadFilePath>.workflow.json`, and merges them
with the base [`WorkflowConfig`](src/lib/workflow-types.ts) to produce the
effective pipeline for a given file.

**Key Concerns:**

- **File-system-based per-file config store:** Path convention is defined by
  [`getFileWorkflowConfigPath()`](src/lib/file-workflow-config.ts) (appends
  `.workflow.json`). [`loadFileWorkflowConfig()`](src/lib/file-workflow-config.ts)
  reads and JSON-parses it; [`saveFileWorkflowConfig()`](src/lib/file-workflow-config.ts)
  serializes and writes it. Read failures silently return `null`.

- **Merge algorithm:** [`mergeWithWorkflow()`](src/lib/file-workflow-config.ts)
  applies sparse per-media-type overrides (model name, prompt, system prompt)
  onto each processing step, then layers post-processing overrides -
  per-plugin enable/disable toggles by name-on top of the
  base workflow. The base workflow's pre-processing steps and plugin
  definitions are preserved.

- **Default workflow resolution:**
  [`getEffectiveWorkflow()`](src/lib/file-workflow-config.ts) falls back to
  [`resolveDefaultWorkflowName()`](src/lib/archivar-config.ts) (`defaults.workflow`,
  else the first configured workflow) when no explicit workflow name is supplied.

- **No request-time dynamic imports (dev-server constraint):** all imports in
  this module are static. A dynamic `await import()` inside SSR code runs
  through Vite's module runner, which is torn down on full reloads-any
  call after that throws `Vite module runner has been closed` (surfaced as
  RPC 500s from `getAllAnalysisDefaults`) until the next server
  restart. Prod builds are unaffected (imports become static chunks), which
  is why the failure is dev-only.

---

## `image-keyframe.ts`
[`src/lib/image-keyframe.ts`](src/lib/image-keyframe.ts)

**Purpose:** Single-image input support. An image file is analyzed as exactly
one keyframe; these helpers produce the on-disk keyframe artifact
(`out_<name>_<ext>_<hash>/scene_keyframes/0_0_0.png`) that the regular
keyframe pipeline then consumes-the image analog of what the external
segment-scenes tool produces for videos. Invoked from the workflow engine's
pre-processing stage ([`runPreProcessing()`](src/rpc/workflow-engine.ts)).

**Key Concerns:**

- **Conversion semantics:** [`convertImageToKeyframePng()`](src/lib/image-keyframe.ts)
  is the sharp equivalent of `convert <src> -auto-orient -resize '<W>x<H>>'
  -strip PNG32:<dest>`: `.rotate()` bakes EXIF orientation into pixels,
  `fit:"inside"` + `withoutEnlargement` is shrink-only, and sharp drops all
  metadata by default. Always re-encodes (even PNG inputs) so the VLM's pixel
  budget applies regardless of source format; resizes only when a max
  dimension is given. Fails fast with an actionable error on unreadable input.

- **Content-based output hash:** [`computeImageKeyframeHash()`](src/lib/image-keyframe.ts)
  returns 16 hex chars of sha256 over file bytes + effective pixel limits.
  Images get no hash from the external segmentation tools (they never run for
  images); without one, every image would share `outputHash=null` and their
  per-segment/aggregated cache keys would collide across different files.

---

## `long-fetch.ts`
[`src/lib/long-fetch.ts`](src/lib/long-fetch.ts)

**Purpose:** A `fetch` wrapper ([`longFetch()`](src/lib/long-fetch.ts)) that
raises Node/undici's hard-coded 5-minute `headersTimeout` / `bodyTimeout`
limits to 12 hours, so legitimately long-running RPC (analyze workflow) and
MLLM (video captioning) calls are not prematurely aborted. This is the sole
HTTP transport for calls that may run many minutes.

**Key Concerns:**

- **Cache management (Agent + import promise):** The undici dynamic import is
  cached in `undiciPromise` (loaded once); the long-lived undici `Agent` is
  cached in `longAgent` (created once on first use). Both persist for the
  process lifetime.

- **Runtime detection / graceful fallback:**
  [`loadUndici()`](src/lib/long-fetch.ts) checks `process.versions.node`;
  in non-Node runtimes (browsers, workers, test shims) it resolves `null` and
  [`longFetch()`](src/lib/long-fetch.ts) transparently falls back to the
  global `fetch`. In Node, it instantiates an undici `Agent` with
  `headersTimeout`/`bodyTimeout` set to 12 h and `connectTimeout` to 60 s,
  then dispatches through it.

- **Protocol significance:** This module is the reliability layer for all
  long-haul LLM/RPC HTTP traffic-without it, undici would throw
  `UND_ERR_HEADERS_TIMEOUT` on multi-minute inference calls.

---

## `model-health.ts`
[`src/lib/model-health.ts`](src/lib/model-health.ts)

**Purpose:** Shared model health checks-the single source of truth behind both
`GET /health` ([`src/pages/health.ts`](src/pages/health.ts)) and
[`HealthApi.checkModels()`](src/rpc/health-api.ts) (CLI `health` command).

**Key Concerns:**

- **Real inference probes:** [`runModelHealthChecks()`](src/lib/model-health.ts) checks every
  enabled model in parallel: `api` models get a minimal chat-completion (with test media
  attached when `compatibleMediaTypes` implies video/audio/image), `asr-api` models get a
  real transcription request in the protocol selected by the model's
  `asrProtocol` config-OpenAI-compatible `/v1/chat/completions` with an
  `audio_url` file reference (`"openai-chat"`, default), legacy multipart
  `/transcribe` (`"whisper-transcribe"`), or OpenAI Audio API multipart
  `/v1/audio/transcriptions` (`"openai-transcriptions"`)-mirroring
  [`MllmApi.transcribeQwen3Asr`](src/rpc/mllm-api.ts)-and `tool`
  models are checked for tool-directory existence. The pre-processing tools (`segment-temporal`, `segment-scenes`)
  are checked the same way. Result: `{ status: "ok"|"degraded"|"error", checks }` where each
  `ModelHealthCheck` records `ok/reachable/authorized/model_present/base_url/status_code/error`.
- **Test data dependency:** ASR checks need
  `<repoRoot>/../sample_data/archivar/test_data/test.mp3` (absolute host path derived
  from `PROJECT_ROOT`); VLM checks
  use `/sample_data/archivar/test_data/` (container path). Missing test files fail that
  model's check, not the whole run.
- **Used-model semantics (FAIL vs SKIP):** A failing check only degrades the
  aggregate status when the model is actually referenced by a workflow
  ([`computeUsedModelNames()`](src/lib/model-health.ts): `processing[].modelName`
  + plugin `config.modelName`). Unreferenced models are not probed at all -
  they are reported with `skipped: true` ("unused") and ignored by the aggregate
  (`/health` schema gains only this additive flag; the CLI prints `SKIP`).

- **Timeouts:** Every probe has a 10 s `AbortSignal.timeout` (30 s for ASR
  transcription probes), so unreachable endpoints degrade the aggregate status
  instead of hanging the endpoint. All Node built-ins are static imports -
  dynamic imports would throw "Vite module runner has been closed" when the
  dev server invalidates its module graph mid-request.

---

## `sample-data-path.ts`
[`src/lib/sample-data-path.ts`](src/lib/sample-data-path.ts)

**Purpose:** Single conversion from a host-side media path inside the
sample_data tree to the container-visible path: the tree is bind-mounted at
`/sample_data` in the inference containers, so everything before the first
`/sample_data/` segment is dropped. Paths outside the tree pass through
unchanged. Used by both the ASR transcription path
([`transcribeQwen3Asr`](src/rpc/mllm-api.ts)) and the model-health probe
([`model-health.ts`](src/lib/model-health.ts)).

---

## `preflight-models.ts`
[`src/lib/preflight-models.ts`](src/lib/preflight-models.ts)

**Purpose:** Pre-flight gate for `WorkflowEngine.runWorkflow`-fails a run
fast (before pre-processing) when a model endpoint it will call is dead,
instead of producing an empty-shell result full of recovered errors. Unlike
`model-health.ts` (real inference probes for /health), the probe here is
deliberately tiny: `GET <origin>/v1/models` with a 5 s timeout, asserting
reachability + authorization only (any HTTP status counts as reachable-some
ASR servers lack the route). `collectWorkflowModelNames()` gathers enabled
processing-step models (incl. `enabledAsFallback`) and enabled plugin
`config.modelName`s, narrowed by `--only <stage>`; the `fileMediaType`
parameter mirrors the engine's `resolveEnabledProcessingSteps()` rule, so a
default-disabled keyframe step's model is still probed for single-image input.
Local "tool" models need no
probe; a model with no configured endpoint is an actionable failure, not a
crash. Invoked exactly once per run-never per step/segment/batch. Coverage:
[`test/preflight-models.test.ts`](test/preflight-models.test.ts).

---

## `non-fatal-error-collector.ts`
[`src/lib/non-fatal-error-collector.ts`](src/lib/non-fatal-error-collector.ts)

**Purpose:** Per-run aggregation of recovered/isolated errors into
`AnalysisResult.nonFatalErrors`-plus the per-run **`errors.json`** artifact.
Each entry carries a sequential id (`ERR-N`), reason, model, capped details,
full `stackTrace` and-when the error came from a backend call-the original
`wire` context (exact request body, HTTP status, response headers, complete
response body). Transport code stamps `err.wire` before throwing so downstream
catch sites need no signature change; internal retries pass it explicitly.
Constructed with a path (by `runWorkflow`), every add rewrites
`<file>.archivar/errors.json`, so a crashing run leaves a complete artifact.
Mechanism: `AsyncLocalStorage` store (`nonFatalErrorCapture`) + leaf helper
`recordNonFatalError(err, model, wire?)`-no-op outside a run.
[`countFromErrorsJson()`](src/lib/non-fatal-error-collector.ts) parses the
artifact's error count for the CLI's degraded-run exit gate (returns `null` on
malformed content-"unknown" must not be confused with "clean").

---

## `plugin-types.ts`
[`src/lib/plugin-types.ts`](src/lib/plugin-types.ts)

**Purpose:** Defines the complete v3 post-processing plugin contract-the
data shapes that flow into and out of plugins, the helper API surface
available to them, and the hook function signatures that plugin modules
implement.

**Key Concerns:**

- **v3 plugin API protocol:** The [`PluginApi`](src/lib/plugin-types.ts)
  interface exposes four namespaces to plugins: `file` (media info + globbing),
  `cache` (keyed table get/set), `analysis` (segment analysis delegation), and
  `mllm` (raw and schema-validated MLLM calls with self-correcting JSON retry).
  This is the stable contract between the runtime and third-party/contrib
  plugins.

- **Semantic aggregation model:**
  [`SemanticAggregationV3`](src/lib/plugin-types.ts) and
  [`SemanticAggregationPatch`](src/lib/plugin-types.ts) define how adjacent
  time slices are grouped, summarized, and optionally replaced-the core data
  structure for multi-pass analysis.

- **Hook pipeline:**
  [`PostProcessingPluginModule`](src/lib/plugin-types.ts) declares the optional
  hooks that define the execution order of a plugin's lifecycle:
  per-slice, decide-aggregation, per-aggregation, summary per aggregation,
  extract-semantic-profiles, enrich-aggregation-transitions (reliable boundary
  context between adjacent aggregations, computed from final analyses before
  higher-order aggregation), higher-order aggregations, summary from
  aggregations, summary from time slices.

---

## `question-types.ts`
[`src/lib/question-types.ts`](src/lib/question-types.ts)

**Purpose:** Type definitions for the generalized question-answer pipeline
plugin ([`plugins/question-answer.ts`](plugins/question-answer.ts)), defining
the typed contract between user-supplied `archivar.config.ts` entries and the
plugin runtime.

**Key Concerns:**

- **Question taxonomy:**
  [`QuestionType`](src/lib/question-types.ts) enumerates five answer shapes
  (`boolean`, `oneOf`, `manyOf`, `singleClaim`, `categorization`), each with a
  corresponding validated result interface. These drive both prompt template
  selection and Yup schema construction in the plugin.

- **Auto-regressive context accumulation:**
  [`enableAutoRegressiveAnswerAggregation`](src/lib/question-types.ts) on
  [`QuestionConfig`](src/lib/question-types.ts) controls chain-of-thought
  behavior-when `true`, a question's Q&A pair is appended to a running
  context passed to all subsequent question prompts. This is the mechanism for
  multi-step reasoning across sequential MLLM calls.

- **Analysis scope:** [`AnalysisScope`](src/lib/question-types.ts) decides
  whether a question is asked against the whole-video summary or per
  aggregation then synthesized.

---

## `result-view.ts`
[`src/lib/result-view.ts`](src/lib/result-view.ts)

**Purpose:** Filtered "result view" used when *reading* an analysis result for
rendering or download (dashboard "All Results" tab, DOCX/MD/JSON exports via
`view=filtered`). Never applied before writing-stored data (debug.json,
cache tables) stays complete.

**Key Concerns:**

- **Deep allowlist:** [`filterJsonKeys()`](src/lib/result-view.ts) keeps a key
  verbatim when it is in the allowlist, or as an ancestor path to an allowed
  key; everything else is dropped (returns `undefined` when nothing survives).
  [`RESULT_VIEW_KEYS`](src/lib/result-view.ts) = `summary`,
  `higherOrderAggregations`.
- **`toResultView()`:** convenience wrapper over an
  [`AnalysisResult`](src/db/db.ts). Note: semantic aggregations carry a
  `summary` field, so they survive as `{ summary }` fragments without
  id/timing-renderers must treat those fragments as holes, not events.
  HOA descriptions (top-level and under each `postProcessing.*`) are mapped
  through `stripAggregatedTables` (non-mutating).
- **`stripAggregatedTables()`:** removes the LLM-generated
  `# Visuelle Artefakte` / `# Erwartete Menschliche Wahrnehmung` (and English
  variants) markdown table sections embedded in HOA description strings
  (see `VISUAL_ARTIFACT_ACCUMULATION_RULE` in `plugins/default.ts`)-the
  tables never appear in the UI or in filtered downloads.
- **`toJsonDownload()`:** dedicated transformer for the filtered JSON
  download-provenance metadata (when supplied via `JsonDownloadMeta`:
  `models: {asr, vlm}`, `processingTime`, `fileName`, `workflow`,
  `exportTime`), the summary fields (`JSON_DOWNLOAD_SUMMARY_FIELDS`: title,
  abstract, keywords, tags, categorization, overallIntention,
  short_description, long_summary, narrativeArc, perceptionArc) from
  `postProcessing.default.summary`, plus `higherOrderAggregations` (from
  `postProcessing.default`, falling back to the top-level array) reduced to
  `{ title, summary }` where `summary` is the table-stripped description.
- **`summarizeProcessingTime()`:** sums the top-level `result.timing`
  children into `{ preProcessing, processing, postProcessing }` milliseconds
  (`plugin:*`/`aggregation`/`summary` count as post-processing; everything
  except `preProcessing` and post-processing counts as processing). Returns
  null without timing data.
- Pure functions, `unknown` + narrowing, no I/O.

---

## `analysis-view.ts`
[`src/lib/analysis-view.ts`](src/lib/analysis-view.ts)

**Purpose:** Lean per-file payloads behind the dashboard RPC methods
[`CacheApi.getCaptionsByHash()` / `getAnalysisViewByHash()`](src/rpc/cache-api.ts).
The dashboard used to pull whole cache tables (`getAll("scene")` ≈ 6 MB) and
the file's full `AnalysisResult` (~1–3 MB) per click; these shapers cut that
to exactly what the UI renders.

**Key Concerns:**

- **`extractCaptionsByHash(tables, hash)`:** `cacheId → caption` for keys
  containing the file's hash with a non-empty string caption (same substring
  semantics as `getByKeySubstring`; key scheme
  `${outputHash}[-suffix]-${index}`).
- **`buildAnalysisView(result, key)`:** the per-click `AnalysisView`-scenes
  reduced to `{index, startTime, endTime, caption}` (+ nested speech/harmonic/
  noise), aggregations to their region fields (summaries flattened), HOAs to
  `{id, index, aggregationIndexes, title}`, plus `toResultView()` (summary +
  stripped HOAs) and the provenance fields (`summarizeProcessingTime()`,
  `tokenUsage`, `nonFatalErrors`). Per-segment `serverUrl`/`containerPath`/
  `fileName` duplication-the bulk of the full result-is dropped.
- Pure functions, unit-tested in
  [`test/analysis-view.test.ts`](test/analysis-view.test.ts).

---

## `scene-assignment.ts`
[`src/lib/scene-assignment.ts`](src/lib/scene-assignment.ts)

**Purpose:** Pure helpers that assign a temporal segment (speech, keyframe,
harmonic, noise) to the scene it belongs to. Used by
[`WorkflowEngine.aggregateResults()`](src/rpc/workflow-engine.ts).

**Key Concerns:**

- **Largest overlap wins, not first overlap:**
  [`findBestOverlapSceneIndex()`](src/lib/scene-assignment.ts) returns the
  scene with the largest overlap duration (`{ index, overlapSeconds }`), ties
  going to the earliest scene, `null` when nothing overlaps. Replaces the old
  first-overlap-wins loop that dumped long ASR segments spanning many scenes
  wholesale into the first overlapping scene.
- **Gap-capped nearest fallback:**
  [`findNearestSceneIndexWithinGap()`](src/lib/scene-assignment.ts) picks the
  midpoint-distance nearest scene but returns `null` when the temporal gap
  (range-to-range distance, 0 when overlapping; boundary distance for segments
  before the first / after the last scene) exceeds the caller's cap. Invariant:
  a wrong attribution is worse than none-uncapped segments stay unassigned
  and surface downstream as `sceneIndex: -1` slices.
- **Hermetic and side-effect-free:** pure functions over plain
  `{ startTime, endTime }` ranges; no I/O, no config, no globals.

---

## `slice-completeness.ts`
[`src/lib/slice-completeness.ts`](src/lib/slice-completeness.ts)

**Purpose:** Pure completeness-invariant check over post-processing
[`TimeSlice`](src/lib/plugin-types.ts) arrays. Used once per run by the
workflow engine right after `buildPostProcessingInput()`; violations are
logged and land in `debug.json` as `postProcessingWarnings` (never fatal).

**Key Concerns:**

- **Rules:** scene slice ≥ 1s without a caption → violation; scene slice < 1s
  without its own caption AND without a same-`sceneIndex` keyframe slice
  carrying a caption → violation; speech slice without a caption (the
  transcript lives in `caption`) → violation. Noise/harmonic/keyframe/silence
  slices are exempt; `sceneIndex: -1` scene slices still count.
- **Output contract:** human-readable violation strings; empty array = OK.

---

## `timing-collector.ts`
[`src/lib/timing-collector.ts`](src/lib/timing-collector.ts)

**Purpose:** Hierarchical timing instrumentation for workflow stages. Produces
[`TimingEntry`](src/lib/workflow-types.ts) trees that are later rendered by
[`timing-tree-renderer.ts`](src/lib/timing-tree-renderer.ts) into the debug log.

**Key Concerns:**

- **High-complexity algorithm (hierarchical scope tracking):** The
  [`TimingCollector`](src/lib/timing-collector.ts) / [`TimingHandle`](src/lib/timing-collector.ts)
  pair build a tree of [`TimingEntry`](src/lib/workflow-types.ts) nodes by
  reference: [`beginChild()`](src/lib/timing-collector.ts) creates a handle
  whose entry is pushed directly into the root's `children` array;
  [`beginGrandChild()`](src/lib/timing-collector.ts) on a handle pushes into
  that handle's entry's `children`. [`end()`](src/lib/timing-collector.ts)
  finalizes duration and logs `[TIMER] <label>: <ms>`. A `Set<TimingHandle>`
  (`_pending`) tracks not-yet-finalized scopes for ordering diagnostics.

- **High-resolution clock selection:** Uses
  [`performance.now()`](src/lib/timing-collector.ts) when available
  (Node.js / browsers) with `Date.now()` fallback, chosen once at module load.

---

## `timing-tree-renderer.ts`
[`src/lib/timing-tree-renderer.ts`](src/lib/timing-tree-renderer.ts)

**Purpose:** Pure function that renders a [`TimingEntry`](src/lib/workflow-types.ts)
tree as ASCII art (box-drawing connectors) for human-readable debug.log output.

**Key Concerns:**

- **High-complexity algorithm (recursive tree layout):**
  [`renderTimingTree()`](src/lib/timing-tree-renderer.ts) performs a
  depth-first recursive walk accumulating a vertical-connector prefix string
  (`│   ` for non-last ancestors, four spaces for last). At each node it emits
  `├──` or `└──` based on sibling position, skips connectors at depth 0 (root),
  and respects a configurable `maxDepth` to truncate deep trees. Duration
  formatting is selectable (`ms`, `s`, `human` auto-scaling ms → s → min).

---

## `token-estimate.ts`
[`src/lib/token-estimate.ts`](src/lib/token-estimate.ts)

**Purpose:** Shared rough token estimator (~1.3 tokens/word for European
languages). Used by the default plugin's unified-summary budget gate
([`plugins/default.ts`](plugins/default.ts)); kept in `src/lib` because
plugins must not import from `src/rpc`. Single pure function, no I/O.

---

## `types.ts`
[`src/lib/types.ts`](src/lib/types.ts)

**Purpose:** Umbrella barrel file. Re-exports everything from
[`workflow-types.ts`](src/lib/workflow-types.ts) and
[`plugin-types.ts`](src/lib/plugin-types.ts) so consumers can import from a
single stable path.

**Key Concerns:**

- **Import-path stabilization:** All external consumers should import from
  [`src/lib/types.ts`](src/lib/types.ts) rather than the individual modules, so
  internal restructuring does not break downstream imports.

---

## `workflow-types.ts`
[`src/lib/workflow-types.ts`](src/lib/workflow-types.ts)

**Purpose:** The foundational type layer for the entire archivar pipeline:
model registry, processing/pre-processing/post-processing configuration,
workflow definition, per-file overrides, legacy time-slice model, and timing
entry shape.

**Key Concerns:**

- **Model registry & LLM protocol surface:**
  [`ModelConfig`](src/lib/workflow-types.ts) is the central declaration for
  each inference backend. Its `type` discriminator (`"api"` = OpenAI-compatible
  endpoint, `"tool"` = external shell script via AnalyseApi, `"asr-api"` =
  Qwen3-ASR multipart POST) drives protocol selection in the RPC layer. The
  `inferenceEngine` field (`"vllm" | "llama-cpp" | "sglang" |
  "custom-openai-compatible" | "qwen-asr"`) declares the serving backend and
  gates vLLM-only request fields (see repetition_detection above). The
  `endpoint` / `apiKey` / `model` fields all support the `env:VAR_NAME`
  indirection resolved at runtime by [`archivar-config.ts`](src/lib/archivar-config.ts).
  [`enableThinking`](src/lib/workflow-types.ts) toggles chain-of-thought in
  `chat_template_kwargs`; [`maxContextTokens`](src/lib/workflow-types.ts)
  declares the model's context window in tokens (currently informational-no
  built-in stage consumes it).

- **Segment-scenes resolution model:**
  [`SegmentScenesConfig`](src/lib/workflow-types.ts) holds the four numeric
  knobs (fps, max clip length, max width/height) that constrain video ingest
  limits for downstream `"scene"` models. `enabled` is optional in the object
  form; `resolveSegmentScenesConfig()` defaults it to `true` when omitted.
  Its acceptance of `boolean |
  SegmentScenesConfig` in [`PreProcessingConfig`](src/lib/workflow-types.ts)
  is the legacy/structured dual form.
  The per-workflow values are *base* values: the engine consumes them through
  [`resolveEffectiveSegmentScenesConfig()`](src/lib/archivar-config.ts),
  which applies the top-level `visualCaptionFrequency` (fps multiplier) and
  `visualCaptionQuality` (maxWidthPx/maxHeightPx multiplier, `Math.round`-ed)
  knobs from `ArchivarConfig`-both default to 1 (100%) and are restricted to
  `{1, 0.5, 0.25}`. The raw configured values are never mutated. Effective
  pixel caps are floored at `MIN_CAPTION_MAX_WIDTH_PX`/`MIN_CAPTION_MAX_HEIGHT_PX`
  (796×448-measured legibility Pareto point: 608×342 lost small
  object text, 796×448 read everything; multipliers may never push below it).
  The **short-clip fps rule** (`shortClipMaxLengthSec` + `shortClipMinFps`,
  both-or-none, validated at `setArchivarConfig`) works per *individual scene
  clip*: [`resolveSegmentFps()`](src/lib/archivar-config.ts) raises the
  inference fps for clips shorter than the threshold (applied in
  `buildInferenceMmProcessorKwargs()` via the clip's duration), and
  [`resolvePhysicalReencodeFps()`](src/lib/archivar-config.ts) floors the
  segment-scenes `--fps` at the workflow-engine call site so the clip file
  physically contains those frames (inference cannot sample frames the file
  lacks; long clips are thinned back down at inference). Unset = rule off.

- **Dynamic plugin loading contract:**
  [`PostProcessingPlugin`](src/lib/workflow-types.ts) declares `importPath`
  for dynamic `import()` and `order` for execution sequencing-the runtime
  wiring that [`plugin-module-loader.ts`](src/rpc/post-processing/plugin-module-loader.ts)
  consumes.

- **Per-file override model:**
  [`FileWorkflowConfig`](src/lib/workflow-types.ts) defines the persisted
  shape consumed by [`file-workflow-config.ts`](src/lib/file-workflow-config.ts),
  including sparse per-media-type step overrides and post-processing selections.

---

## `aggregation-constraints.ts`
[`src/lib/aggregation-constraints.ts`](src/lib/aggregation-constraints.ts)

**Purpose:** Model-free minimum-size enforcement for grouping layers
(slice → aggregation in the workflow engine, aggregation → higher-order
aggregation in `plugins/default.ts`). `enforceMinGroupSize()` merges undersized
groups into adjacent neighbors via a balanced forward sweep. Pure, zero-dependency.

---

## `asr-url.ts`
[`src/lib/asr-url.ts`](src/lib/asr-url.ts)

**Purpose:** Normalizes configured ASR endpoint shapes (bare host, `/v1` suffix,
or full transcription path) so `buildEndpointUrl()` never produces doubled path
segments. Pure.

---

## `media-extensions.ts`
[`src/lib/media-extensions.ts`](src/lib/media-extensions.ts)

**Purpose:** The video/audio/image extension sets the app can ingest (what the
segment-* pre-processing services decode). Isomorphic and dependency-free -
shared by the server (file-api classification) and the client (sidebar globs).

---

## `caption-prompt-builder.ts`
[`src/lib/caption-prompt-builder.ts`](src/lib/caption-prompt-builder.ts)

**Purpose:** Builds the context-aware scene/keyframe caption prompt from the
external [`caption-prompt-template.md`](src/lib/caption-prompt-template.md)
(fail-fast at module load when missing), substituting audio context and the
previous scene's caption; supports opt-out section stripping
(`enableHumanPerceptionEvaluation` / `enableVisualArtifactTracking`).
`needsContextAwarePrompt()` is the gate the engine's phased execution consults.

---

## `errors.ts`
[`src/lib/errors.ts`](src/lib/errors.ts)

**Purpose:** Typed errors for the JSON-schema-mode feature:
`JsonSchemaUnsupportedError` (backend rejected the transport-fail-fast),
`TruncatedStructuredOutputError` (retryable truncation, carries `maxTokens`),
`UnsupportedYupNodeError` (converter fail-fast). Let callers distinguish
operator/config issues from retryable ones.

---

## `input-estimation.ts`
[`src/lib/input-estimation.ts`](src/lib/input-estimation.ts)

**Purpose:** Pre-flight context budgeting. Before every wire request,
`budgetCapForModel()` caps `max_tokens` at
`resolveMaxInferenceContext(model) − inputEst − CONTEXT_MARGIN_TOKENS`
(words × per-model `tokensPerWord` + frames × `tokensPerFrame`), floored at
`MIN_OUTPUT_TOKENS`. Deliberately overestimates (a smaller budget is recovered
by the truncation ladder; an undersized estimate costs a 400). See
[`JSON_MODE_ARCH.md`](src/rpc/JSON_MODE_ARCH.md) section 6.

---

## `json-schema-mode-defaults.ts`
[`src/lib/json-schema-mode-defaults.ts`](src/lib/json-schema-mode-defaults.ts)

**Purpose:** Model-name → default JSON-schema transport registry (coarse family
prefixes: `gemma` → `response_format`, `qwen3` → `structured_outputs`), so
deployments get a deterministic no-probe transport without per-model config.
Resolution precedence in `getModel()`: explicit `ModelConfig.jsonSchemaMode` →
this registry → `"auto"` (probe). Pure.

---

## `json-schema-probe.ts`
[`src/lib/json-schema-probe.ts`](src/lib/json-schema-probe.ts)

**Purpose:** vLLM structured-output capability probe with a per-key cache
(`endpoint|model|thinkingEnabled`; positive 1 h / negative 2 min TTL, in-flight
dedup). `"auto"` probes `response_format` → `structured_outputs` →
`legacy_guided_json` and caches the first working transport; explicit modes
never probe. `ARCHIVAR_JSON_SCHEMA_PROBE=0` disables probing.

---

## `parse-json.ts`
[`src/lib/parse-json.ts`](src/lib/parse-json.ts)

**Purpose:** Single tolerant JSON extractor for LLM responses
(`parseJsonLoose()`): direct parse → fence-stripped → embedded fence pair →
trailing object/array → balanced-substring scan. Consolidates the formerly
duplicated extractors; wrappers in mllm-api/plugin-api delegate here. Pure.

---

## `structured-output-defaults.ts`
[`src/lib/structured-output-defaults.ts`](src/lib/structured-output-defaults.ts)

**Purpose:** Single source of truth for structured-call sampling defaults
(`STRUCTURED_OUTPUT_DEFAULTS`: maxTokens 16384, temperature 0.2, maxRetries 2,
repetitionPenalty 1.05, frequencyPenalty 0.1) and the truncation-bump ceiling
(`STRUCTURED_MAX_TOKENS_CEILING` 65536). Per-model overrides via
`ModelConfig.structuredOutput` (`resolveStructuredConfig()`).

---

## `token-usage-collector.ts`
[`src/lib/token-usage-collector.ts`](src/lib/token-usage-collector.ts)

**Purpose:** Per-run token-usage accumulator behind `AnalysisResult.tokenUsage`.
Same `AsyncLocalStorage` pattern as the debug/non-fatal-error collectors:
`runWorkflow` enters the store once; every transport call (engine captioning,
plugin `callJson`/`callRaw`, the schema probe) records the backend-reported
`usage`. No-op outside a run.

---

## `yup-json-schema/`
[`src/lib/yup-json-schema/`](src/lib/yup-json-schema/index.ts)

**Purpose:** Dependency-free Yup → JSON Schema (draft-07) converter for
guided-decoding transports; strict by default (`additionalProperties: false`,
all fields required) with a fail-fast `UnsupportedYupNodeError` on unsupported
nodes. See its own [README](src/lib/yup-json-schema/README.md).

---

## `caption-index.ts`
[`src/lib/caption-index.ts`](src/lib/caption-index.ts)

**Purpose:** Index-basis remap for processing-stage captions. `processBatch`
keys results by position in the *processed* list; when a pre-filter removed
segments (e.g. keyframes skipped by `enabledAsFallback`), those positions no
longer match the full filtered list that `aggregateResults` reads via
`captions.get(i)`. `remapProcessedCaptions()` remaps onto the full-list basis
(identity fast-path when the lists are reference-identical).

**Key Concerns:**

- Pure and side-effect-free; matches elements by object identity (pre-filters
  must preserve references, `Array.prototype.filter` does).
- The matching `enabledAsFallback` parent-scene lookup in the workflow engine
  resolves the scene caption by *filtered* scene index (sub-1s scenes are
  dropped from scene captioning)-never the raw `fileInfo.scenes` position.

---

## `text-degeneration.ts`
[`src/lib/text-degeneration.ts`](src/lib/text-degeneration.ts)

**Purpose:** Cheap caption-degeneration guard. `countAtypicalSymbols()` counts
characters outside the typical latin-language printable ranges (ASCII,
Latin-1/Extended, General Punctuation, Currency, Letterlike); 3+ atypical
chars is the signal for one cooler retry (temperature −0.2) in
`WorkflowEngine.callModelForSegment()`-targets the observed symbol-soup
failure mode at higher sampling temperatures. The same check guards
`PluginApi.mllm.callJson()`: one extra attempt with a prepended language note
(outside the schema-retry budget) when a raw response is atypical.

**Key Concerns:**

- Pure, side-effect-free, no model call of its own; threshold is a parameter
  (`DEFAULT_ATYPICAL_SYMBOL_THRESHOLD = 3`).
- German typographic quotes, em-dashes, €, ™ and latin diacritics are
  explicitly inside the accepted ranges-false positives would cost a
  duplicate model call.

---

## `prompt-dedupe.ts`
[`src/lib/prompt-dedupe.ts`](src/lib/prompt-dedupe.ts)

**Purpose:** Deterministic exact-duplicate line removal for LLM prompts
(Stage 0 of the oversized-prompt strategy). Slice/aggregation analyses repeat
artifact tables and captions heavily (measured: 73% duplicate lines in a
49-slice aggregation prompt). `dedupePromptText()` drops only exact duplicate
content lines, keeps structure (`#` headers, `Schnitt N (Index i):` markers),
dedupes table data rows globally (fully duplicated tables vanish entirely)
and collapses consecutive blank lines. The surviving first occurrence carries
its multiplicity as a " (xN)" suffix (table rows: after the closing pipe, so
no cell content is corrupted), preserving the frequency signal for the model;
when anything was deduplicated, `DEDUP_NOTE` is prepended once as a legend.
Idempotent; prompts without duplicates stay byte-identical.
`stripSingletonMarkers()` / `stripSingletonMarkersDeep()` remove " (x1)"
line-suffix markers: dedupePromptText only emits x≥2, but models imitate the
convention and tag singletons-noise that also breaks exact-duplicate
matching. Stripped at both model-output ingress points (callJson's parsed
result-deep, since compact JSON hides value line breaks behind escaped
"\n"-and the per-segment caption path) and inside dedupePromptText itself.

**Key Concerns:**

- Pure, side-effect-free; applied at every repeated-content prompt site:
  `postProcessPerAggregation` (single + map chunks), HOA, unified/whole/
  chronological summary (`plugins/default.ts`, re-exported for tooling/tests)
  and the per-slice caption prompt in `WorkflowEngine.callModelForSegmentInner()`.

---

## `output-cleanup.ts`
[`src/lib/output-cleanup.ts`](src/lib/output-cleanup.ts)

**Purpose:** Robust removal of pre-processing output folders
(`removeDirectoryRobust`). Tool outputs are written by the segmentation
Docker containers as root, so plain `rmSync` fails with EACCES for the
dev-server user-silently leaving stale segments that the next run's file
discovery would mix with fresh ones (duplicated speech, mixed generations).
Falls back to a throwaway Docker container (`ARCHIVAR_CLEANUP_IMAGE`, default
`segment-scenes:latest`) and reports `{ ok, via, error }`-never throws.

**Key Concerns:**

- Used by `FileApi._removeOutputFolders` (clear-cache/delete paths, failures
  surfaced as `warnings` in the RPC result) and by `removeFileOutputs`
  (workflow engine's --force path, which fails fast on any failure).
- Docker escalation requires the docker group; the returned error message
  includes the manual `sudo rm -rf` command as last resort.

---

## `srt.ts`
[`src/lib/srt.ts`](src/lib/srt.ts)

**Purpose:** Pure SubRip (`.srt`) subtitle serializer backing the `srt` export
format. `toSrt(segments)` renders the whole ASR transcript as a standard SRT
file using each speech clip's own millisecond timings.

**Key Concerns:**

- Dependency-free and I/O-free: operates on plain `TranscriptSegment`
  (`{ from, to, text }`, ms) and returns a string. No file, cache, or config
  access-fully unit-testable and runtime-agnostic (Node/browser/worker).
- The export pipeline in [`src/rpc/export.ts`](src/rpc/export.ts) extracts the
  speech clips via `speechEventsToSegments()` (reusing the dashboard's caption
  cache-fallback) and feeds them here; this module only serializes.
- Guards against bad source data: `formatSrtTimestamp` throws on non-finite /
  negative values and `toSrt` throws when a segment's `to` precedes its `from`,
  so a malformed ASR clip fails loudly at the boundary rather than emitting a
  backwards subtitle a player silently drops.

---

## `vlm-request-collector.ts`
[`src/lib/vlm-request-collector.ts`](src/lib/vlm-request-collector.ts)

**Purpose:** Per-run, per-request VLM usage tracking-the **`vlm-requests.json`**
artifact. Each entry records the request id (`LLM-N`, matching the processing
log's fetch-completion line), the pipeline stage `type` (`caption` |
`aggregation` | `hoa` | `summary`-taken from the `requestPhaseCapture` store
that the workflow engine enters around processing and each post-processing
hook), the resolved model, the backend-reported
`usage` (input/output/total tokens-actuals, never estimates), the
`max_tokens` request parameter as sent, and wall-clock `timeElapsedSecs`.
The file shape adds min/max aggregates over all metrics plus a top-level
`model` (`"mixed"` when several). Recorded by `callWithPrompt`/
`callWithPromptRaw` only-this is a VLM-only artifact. ASR requests go to
`asr-requests.json` (see `asr-request-collector.ts`), regardless of protocol;
the multipart transcription protocols additionally carry no usage at all.
Constructed with a path by `runWorkflow`; every add rewrites
`<file>.archivar/vlm-requests.json`. Same `AsyncLocalStorage` pattern as the
other collectors-`recordVlmRequest()` is a no-op outside a run.

---

## `asr-request-collector.ts`
[`src/lib/asr-request-collector.ts`](src/lib/asr-request-collector.ts)

**Purpose:** Per-run ASR request tracking-the **`asr-requests.json`**
artifact. Mirrors `vlm-request-collector.ts` for speech transcription: each
entry carries a sequential id (`ASR-N`), `type` (always `"caption"`-ASR only
captions speech), the resolved `model`, the audio `lengthInMins` (segment
duration passed by the workflow engine; `null` when unknown) and wall-clock
`timeElapsedSecs`, plus min/max aggregates. Recorded by all three ASR protocol
branches in `mllm-api.ts` (`openai-chat`, `whisper-transcribe`,
`openai-transcriptions`); token usage is NOT tracked here (multipart protocols
carry none-chat-protocol ASR usage lands in `vlm-requests.json`). Same
`AsyncLocalStorage` pattern; no-op outside a run; every add rewrites
`<file>.archivar/asr-requests.json`. Exportable via `--format asr-requests`.
