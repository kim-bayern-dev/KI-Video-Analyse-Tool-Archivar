# Architecture: `src/rpc/`

This directory contains the server-side RPC layer for Archivar: the orchestrators, protocol
adapters, cache API, and the post-processing plugin subsystem. Every RPC-callable API surface
on the server originates here.

---

## `src/rpc/`

### `analyse-api.ts`
→ [`analyse-api.ts`](src/rpc/analyse-api.ts)

**Purpose:** Public analysis RPC surface. Bridges high-level operations (run a workflow, list
workflows, analyze a single segment, get analysis defaults) down to the underlying tooling
and model backends. Also provides the generic shell-script execution primitive used by
pre-processing tools.

**Key Concerns:**

- **Environment-driven path decisions:** [`AnalyseApi.executeScript()`](src/rpc/analyse-api.ts)
  resolves tool directories via `RELATIVE_TOOLS_PATH` (default `..`), joining
  `process.cwd()` + relative path + `toolName` + `run.sh`. [`AnalyseApi.resolveDataPath()`](src/rpc/analyse-api.ts)
  resolves media data paths via `SAMPLE_DATA_SUBDIR` (default `sample_data/archivar`) and
  `RELATIVE_SAMPLE_DATA_PATH` (default `../${SAMPLE_DATA_SUBDIR}`).

- **External tool protocols (non-HTTP):** [`AnalyseApi.executeScript()`](src/rpc/analyse-api.ts)
  spawns child processes (`spawn`, `shell: false`, `execve` semantics), streams stdout/stderr in
  real-time, strips null bytes to prevent binary corruption, and robustly extracts the last JSON
  object from stdout (tool banners precede JSON). Wrapped methods:
  [`AnalyseApi.segmentScenes()`](src/rpc/analyse-api.ts), [`AnalyseApi.segmentTemporal()`](src/rpc/analyse-api.ts).
  (The former `AnalyseApi.asr()` wrapper was removed together with the retired
  external ASR tool; ASR runs as a processing step via `asr-api` models.)

- **3rd-party API protocol selection (LLM/ASR):** [`AnalyseApi.analyzeSegment()`](src/rpc/analyse-api.ts)
  dispatches on `model.type`-`tool` (shell script), `asr-api` (ASR transcription via
  [`MllmApi.transcribeQwen3Asr()`](src/rpc/mllm-api.ts), protocol selected per model by
  `asrProtocol`), or default `api` (OpenAI-compatible
  chat/completions via [`MllmApi.callWithPrompt()`](src/rpc/mllm-api.ts)). This is the
  polymorphic model-invocation hub.

- **Model compatibility logic:** [`AnalyseApi.getCompatibleModels()`](src/rpc/analyse-api.ts)
  and [`AnalyseApi.getCompatibleModelTypes()`](src/rpc/analyse-api.ts) map media segment
  types (speech/scene/keyframe/...) to allowed model types, preferring
  `ModelConfig.compatibleMediaTypes` when set and falling back to type-based inference.

- **Per-file media-type gating:** [`AnalyseApi.getAllAnalysisDefaults()`](src/rpc/analyse-api.ts)
  classifies the input by extension and, per processing step, reports both `enabled`
  (auto-disabled when inapplicable) and `compatible` (UI-only flag; the upload wizard hides
  incompatible tabs). Keyframe analysis IS image analysis-single-image input is analyzed
  as one keyframe-so keyframe applies to video+image, scene is video-only, and the audio
  family (speech/harmonic/noise) applies to video+audio. Keyframe steps are default-disabled
  in the shipped workflows (opt-in for video/audio via wizard checkbox or CLI override);
  for image input the keyframe step is reported `enabled: true` regardless-it is the only
  analysis path for images (mirrored engine-side by `resolveEnabledProcessingSteps()`).

- **Per-file workflow config:** [`AnalyseApi.getFileWorkflowConfig()`](src/rpc/analyse-api.ts),
  [`AnalyseApi.saveFileWorkflowConfig()`](src/rpc/analyse-api.ts), and
  [`AnalyseApi.getEffectiveWorkflowConfig()`](src/rpc/analyse-api.ts) expose the `*.workflow.json`
  override layer.

---

### `auth.ts`
→ [`auth.ts`](src/rpc/auth.ts)

**Purpose:** Authentication RPC API. Performs login/logout against the static user list declared
in the Archivar config.

**Key Concerns:**

- **Credential resolution:** [`AuthApi.login()`](src/rpc/auth.ts) resolves credentials via
  [`resolveEnvValue()`](src/lib/archivar-config.ts) from [`getArchivarConfig()`](src/lib/archivar-config.ts),
  so usernames/passwords may be sourced from environment variables. No session/cookie handling
  lives here-it is purely a credential check returning a `uid`/`email`/`name`.

---

### `cache-api.ts`
→ [`cache-api.ts`](src/rpc/cache-api.ts)

**Purpose:** Key/value cache RPC API backed by file-based storage providers. Provides the
persistence layer for scene/audio/keyframe/speech/aggregated/summary analysis results.

**Key Concerns:**

- **Cache management:** At module load, six [`FileStorageProvider`](src/db/db.ts) instances are
  instantiated via [`makeNewFileStorageBackend()`](src/db/db.ts), each pinned to its own
  database file: `scene.db`, `audio.db`, `keyframe.db`, `speech.db`, `aggregated.db`,
  `summary.db`. The table name selects which backend is used.

- **Prefix-based invalidation:** [`CacheApi.removeByPrefix()`](src/rpc/cache-api.ts) is the
  critical cache-invalidation path-it scans all keys for a substring (typically the
  `outputHash`) and removes matching entries. This is how [`FileApi`](src/rpc/file-api.ts)
  purges analysis state for a file across all tables without per-key knowledge, and how the
  workflow engine's `--force` path purges stale entries for a file's `outputHash` before re-running.

- **Orphan cleanup:** [`CacheApi.purgeOrphans()`](src/rpc/cache-api.ts) scans the data directory
  for every existing `out_*` folder, collects their trailing hash segments, then removes any cache
  entry whose key references none of those hashes (read-then-remove, safe on a live system). Exposed
  via the `archivar purge-orphans` CLI maintenance command.

- **Lean dashboard payloads:** [`CacheApi.getCaptionsByHash()`](src/rpc/cache-api.ts)
  returns `cacheId → caption` for one file's hash across the four segment
  tables (replacing client-side full-table `getAll` fetches, ~8 MB → KBs), and
  [`CacheApi.getAnalysisViewByHash()`](src/rpc/cache-api.ts) returns the lean
  per-file [`AnalysisView`](src/lib/analysis-view.ts) (captions, aggregation/HOA
  regions, filtered summary view, provenance) with the preferred-plugin cache
  key (`question-answer` first) chosen server-side-one call
  per file click instead of a multi-MB full-result transfer. RPC-only; no
  CLI/REST exposure.

- **TabelName union:** Operations are constrained to the literal table-name union
  (`scene | audio | keyframe | speech | aggregated | summary`).

---

### `export.ts`
→ [`export.ts`](src/rpc/export.ts)

**Purpose:** Export generator for analysis results. Produces downloadable exports in ten
formats-`docx`, `md`, `json`, `raw`, `log`, `srt`, `vct`, `errors`, `vlm-requests`, `asr-requests`-written to `<file>.archivar/exports/`
(`result.docx|md|json|raw.json|log|srt|vct.md`, plus verbatim copies `errors.json`/`vlm-requests.json`/`asr-requests.json`) and reused on subsequent requests unless `force` is set.

**Key Concerns:**

- **Formats:** `docx` and `md` replicate the CSR "All Results" tab 1:1 (summary block,
  higher-order aggregations, chronological event list with the UI's ordering rule: by rounded
  seconds, semantic aggregations before clips on ties; events without captions are hidden
  exactly like the UI). `json` is the curated Download view (`toJsonDownload` + provenance);
  `raw` a verbatim copy of `<file>.archivar/debug.json`; `log` a verbatim copy of
  `<file>.archivar/debug.log`; `srt` a SubRip subtitle file built from the **exact per-clip ASR
  speech timings** (not scene/segment boundaries) via the pure serializer
  [`toSrt()`](src/lib/srt.ts), reusing the same caption cache-fallback the dashboard renders.
  `srt` = SubRip subtitles from the exact per-clip ASR speech timings;
  `vct` = Vision Caption Transcript (same SRT structure but with Markdown scene/keyframe
  captions as content, NO aggregations). `raw`/`log`/`srt`/`vct` are verbatim artifacts and never use the filtered view (only docx/md/json do).
  `errors` and `vlm-requests` are likewise verbatim artifacts: copies of
  `<file>.archivar/errors.json` (all non-fatal errors with `ERR-N` ids, stack
  traces and wire context) and `<file>.archivar/vlm-requests.json` (per-request
  actual token usage + elapsed, with min/max aggregates). `asr-requests` copies
  `<file>.archivar/asr-requests.json` (per-ASR-request ids `ASR-N`, model,
  audio length in minutes, elapsed).
- **Canonical model:** The docx/md builders share one canonical `AllResultsModel` assembled
  from the `aggregated` cache entry (key selected by `outputHash` substring, preferring
  question-answer workflows, mirroring the dashboard) with caption fallback from
  the scene/keyframe/speech/audio cache tables.
- **Filtered result view:** [`exportFile()`](src/rpc/export.ts) and
  [`loadAllResultsModel()`](src/rpc/export.ts) accept a `filtered` flag (default `false`).
  With `filtered=true`, docx/md are rendered from the reduced result view (summary +
  higherOrderAggregations only, HOA descriptions stripped of the aggregated
  artifact/perception tables) and json from the dedicated `toJsonDownload`
  transformer (provenance metadata + 10 summary fields + HOAs as
  `{title, summary}`)-see [`src/lib/result-view.ts`](src/lib/result-view.ts).
  Filtered docx/md also carry provenance: a metadata preamble/frontmatter
  (File, Workflow, Exported, ASR/VLM Model, Processing time as
  "N Min. [pre/main/post]" summed from `result.timing`); the docx preamble
  gains a Processing time row. Aggregation fragments without timing are
  skipped as holes. Filtered exports are cached as
  `result.filtered-v<N>.<ext>` ([`FILTERED_EXPORT_VERSION`](src/rpc/export.ts)
 -bump on generator changes so stale filtered caches self-invalidate) and
  never collide with the unfiltered cache files. Only the
  dashboard download links (`GET /api/export?...&view=filtered`) use this; the CLI
  (`ExportApi`), eager exports from `POST /api/analyze`, and stored data are unchanged.
- **Extended summary rendering:** docx/md render (when present) the summary's
  `abstract`, `tags`, `categorization`, `overallIntention`, `narrativeArc` and
  `perceptionArc` in addition to title/keywords/short_description/long_summary;
  `long_summary` renders under a "Chronological Summary" heading (level 2,
  same as `short_description`).
- **Model provenance:** `loadMetadata` reads the VLM/ASR model names from
  `status.json` (`models`, recorded at workflow start by
  [`AnalyseApi.runWorkflow`](src/rpc/analyse-api.ts) via
  [`resolveWorkflowModels()`](src/lib/archivar-config.ts)) with fallback to
  the current config's workflow definition;
  [`StatusApi.getStatus()`](src/rpc/status-api.ts) applies the same config
  fallback as read-time enrichment (never persisted), so the dashboard
  provenance footer shows models for runs that predate the recording. Runs
  whose workflow was renamed/removed from the config have no model metadata.
- **Provenance preamble (docx):** The docx opens with a metadata preamble (File, Workflow,
  VLM model, ASR model, export timestamp). The workflow name comes from `status.json`
  (fallback: parsed from the aggregated cache key); the VLM/ASR models are read from the
  workflow definition's `scene`/`speech` processing steps.
- **Markdown → docx conversion:** Markdown fields are converted to docx elements via the
  `marked` lexer; the docx document is built with the `docx` package.
- **Export references:** Exports are referenced as `{ path, size, mimeType }`
  ([`ExportedFileInfo`](src/rpc/export.ts)) with `path` relative to the data dir; the
  [`ExportMap`](src/rpc/export.ts) type (`Partial<Record<ExportFormat, ExportedFileInfo>>`)
  is the shape surfaced by RPC, webhook, and poll responses.

---

### `export-api.ts`
→ [`export-api.ts`](src/rpc/export-api.ts)

**Purpose:** RPC facade for analysis result exports. Registered in [`src/rpc.ts`](src/rpc.ts)
(`RpcApi` + whitelist) and consumed by the CLI, the `GET /api/export` download route, and the
workflow engine (eager exports requested via `POST /api/analyze`).

**Key Concerns:**

- **Methods:** [`ExportApi.export(fileName, formats, force?)`](src/rpc/export-api.ts)
  generates (or reuses, unless `force`) the requested formats and returns an `ExportMap`;
  [`ExportApi.list(fileName)`](src/rpc/export-api.ts) returns the exports that already exist
  on disk without generating. Format names are validated against
  [`EXPORT_FORMATS`](src/rpc/export.ts) (`docx | md | json | raw | log | srt | vct | errors | vlm-requests | asr-requests`).

---

### `health-api.ts`
→ [`health-api.ts`](src/rpc/health-api.ts)

**Purpose:** RPC facade for config validation and model health checks. Registered in
[`src/rpc.ts`](src/rpc.ts) (`RpcApi` + whitelist) and consumed by the CLI
(`validate`, `health` commands) and scripts/harnesses.

**Key Concerns:**

- **Methods:** [`HealthApi.validateConfig()`](src/rpc/health-api.ts) structurally validates the
  loaded archivar config-per-type required model fields, workflow → model references,
  post-processing plugin `importPath` resolution, default-workflow existence-and returns
  `{ ok, errors, defaultWorkflow, workflows, models }` (inventory included).
  [`HealthApi.checkModels()`](src/rpc/health-api.ts) runs the real per-model inference checks
  and returns `{ status, checks, models }`-the same data as `GET /health`.
- **Single source of truth:** The actual checks live in
  [`src/lib/model-health.ts`](src/lib/model-health.ts) (`runModelHealthChecks`), shared with
  the `/health` endpoint so CLI, RPC, and HTTP never diverge.

---

### `file-api.ts`
→ [`file-api.ts`](src/rpc/file-api.ts)

**Purpose:** File-system RPC API. Enumerates media files and their derived output artifacts,
clears and deletes files (with cache purge), and reads file contents (debug logs/JSON) from the
data directory.

**Key Concerns:**

- **Heavy environment-driven path decisions:** Nearly every method recomputes `dataDir` from
  `SAMPLE_DATA_SUBDIR` (default `sample_data/archivar`), `RELATIVE_SAMPLE_DATA_PATH` (default
  `../${SAMPLE_DATA_SUBDIR}`), `ABSOLUTE_SAMPLE_DATA_PATH`, `RELATIVE_DIR_PREFIX`,
  `ABSOLUTE_DIR_PREFIX`, `SAMPLE_DATA_SERVER`, and `SAMPLE_DATA_BASE_PATH`. These power the
  Docker host-vs-container path dualism (host paths for local tooling, container paths for the
  runtime, server URLs for the browser). See [`FileApi.listFiles()`](src/rpc/file-api.ts).

- **Lightweight listing (`listFilesSummary`):** [`FileApi.listFilesSummary()`](src/rpc/file-api.ts)
  returns only selection fields ([`FileSummary`](src/rpc/file-api.ts): fileName/mediaType/extension/
  outputHash/outputFolderName)-NO per-segment arrays, NO `out_*` content glob. `outputHash` comes
  from one shallow `out_<name>_<ext>_*` dir glob. WHY: the full `listFiles` payload is ~65MB for a
  data dir with many analyzed files (every segment × ~5 path strings); the sidebar/CLI list only
  render fileName + media type. Verified **65MB → 38KB** (1718×). Consumers: dashboard sidebar
  (`browseInputFiles` + `FileList`, which only reads the summary subset), CLI `cmdList`, and
  `/api/list` (default summary; `?full=1` for the complete `FileInfo[]`). The full single-file
  `FileInfo` (with segments) is fetched on demand via `listFiles(fileName)` when a file is selected
  (dashboard `onFileChange`).

- **Output-folder naming convention (critical convention):** [`FileApi.listFiles()`](src/rpc/file-api.ts)
  derives output folders via the `out_<name>_<ext>_<hash>` glob pattern. The trailing hash segment
  (`parts[parts.length-1]` after splitting on `_`) is the canonical [`outputHash`](src/rpc/file-api.ts)
  used as a cache key everywhere. Changing this convention breaks cache coherence.

- **Segment-classification heuristics:** Output files are bucketed into keyframes/scene_keyframes/
  scenes/silence/harmonic/noise/speech via substring tests on their paths
  (e.g. `'/keyframes/'`, `'_silence_'`). Timing metadata is parsed from underscore-delimited
  filenames (`index`, `startTime`, `endTime`).

- **Single-image unification (fallback only):** an image file with no discovered `out_*`
  segments is treated as a keyframe set with one entry-itself-so unprocessed images stay
  analyzable. Once pre-processing produced real `scene_keyframes` (the converted+resized PNG
  artifact, see `workflow-engine.ts` single-image branch), the discovered segments win and the
  original file is no longer captioned directly.

- **Cache management integration:** [`FileApi._clearCacheAndOutputs()`](src/rpc/file-api.ts)
  is the shared purge pipeline: it extracts the `outputHash` from output folder names via
  [`FileApi._extractOutputHash()`](src/rpc/file-api.ts), then calls
  [`CacheApi.removeByPrefix()`](src/rpc/cache-api.ts) across all six tables, then removes the
  output folders via [`FileApi._removeOutputFolders()`](src/rpc/file-api.ts), and finally
  removes the per-file `<name>.archivar/` debug-artifact directory and the `<name>.workflow.json`
  per-file config. Used by both [`FileApi.clearFileCache()`](src/rpc/file-api.ts) and
  [`FileApi.deleteFile()`](src/rpc/file-api.ts).

- **Security:** All path-accepting methods (`clearFileCache`, `deleteFile`, `readFile`,
  `checkFileExists`) run `basename()` + a `startsWith(dataDir)` containment check to defeat path
  traversal. [`sanitizeFileName()`](src/rpc/file-api.ts) strips unsafe characters.

---

### `file-upload-api.ts`
→ [`file-upload-api.ts`](src/rpc/file-upload-api.ts)

**Purpose:** Binary upload RPC handler. Receives complete uploaded files from defuss-rpc's
binary transport and writes them to the data directory with integrity verification.

**Key Concerns:**

- **Environment-driven path decisions:** [`getDataDir()`](src/rpc/file-upload-api.ts)
  resolves the destination via the same `SAMPLE_DATA_SUBDIR` / `RELATIVE_SAMPLE_DATA_PATH`
  convention as [`FileApi`](src/rpc/file-api.ts).

- **defuss-rpc binary protocol:** The handler is registered via
  [`addUploadHandler()`](src/rpc/file-upload-api.ts) (from `defuss-rpc/server`). defuss-rpc
  streams chunks to a temp file and only invokes the handler once
  `bytesReceived >= originalSize`. The handler receives the full payload as a `Uint8Array`.

- **Integrity verification:** Server-side SHA-256 is computed and compared against the
  client-provided `meta.sha256`; on mismatch the written file is unlinked and an error is thrown.

- **Chunked upload protocol (proxy-timeout-proof):** the `file-chunk` handler stores one
  24 MiB slice per request under `<dataDir>/.chunks/<uploadId>/NNNNN.part` (the chunk index
  rides in the uploadId suffix `-c<index>` because defuss-rpc forwards only a fixed header
  set). [`assembleChunkedUpload()`](src/rpc/file-upload-api.ts) then concatenates chunks in
  order, verifies the total size, removes the chunk dir, and refuses to overwrite existing
  files; [`discardChunkedUpload()`](src/rpc/file-upload-api.ts) drops all chunks
  (cancel/failure cleanup). Both are exposed via `FileApi.finalizeChunkedUpload` /
  `FileApi.discardChunkedUpload`. WHY: the fronting proxy kills requests whose upstream
  stays silent for ~60s (measured: 502 after ~60s)-each chunk POST and
  the finalize RPC respond in seconds, so uploads of any size survive. The `.chunks` dir is
  dot-prefixed so in-flight uploads never appear in `FileApi.listFiles`. defuss-rpc's own
  resume mode is unusable for this (it invokes the handler per chunk and deletes the temp
  file after each response).

- **Security:** Same `basename()` + `sanitizeFileName()` + `startsWith(dataDir)` containment
  guard as [`FileApi`](src/rpc/file-api.ts). Also refuses to overwrite existing files.

- **Legacy path:** A commented-out chunked-upload RPC class is preserved for reference but is
  not active.

---

### `mllm-api.ts`
→ [`mllm-api.ts`](src/rpc/mllm-api.ts)

**Purpose:** Multimodal LLM protocol adapter. The single point of contact with OpenAI-compatible
chat servers and the Qwen3-ASR transcription service. Used by the workflow engine, analyse API,
and plugin API.

**Key Concerns:**

- **Config-driven model resolution (quick-caption methods):** the ad-hoc caption
  methods ([`captionVideos()`](src/rpc/mllm-api.ts), [`captionImage()`](src/rpc/mllm-api.ts),
  [`captionAudios()`](src/rpc/mllm-api.ts), [`captionSound()`](src/rpc/mllm-api.ts))
  resolve endpoint/model/apiKey per call via [`getModel()`](src/lib/archivar-config.ts).
  Their default model is **not** a hardcoded name: the private
  `resolveDefaultModelName("vlm" | "asr")` reads the configured default
  workflow's scene-step (VLM) / speech-step (ASR) model via
  [`resolveWorkflowModels()`](src/lib/archivar-config.ts) (fallback: the first
  model of that type). `captionSound`/`transcribeQwen3Asr` accept an explicit
  `modelName` and fall back to that configured default when omitted. The
  constructor only keeps the optional `MLLM_API_KEY` fallback.

- **OpenAI-compatible protocol (primary):** every method POSTs raw JSON to
  `${endpoint}/v1/chat/completions` with the OpenAI chat schema
  ([`OpenAIChatRequest`](src/rpc/mllm-api.ts)), carrying vLLM-specific extras
  (`chat_template_kwargs`, `mm_processor_kwargs`, `documents`). Internal messages
  ([`InternalChatMessage`](src/rpc/mllm-api.ts)) are translated to OpenAI content parts via
  [`MllmApi.convertToOpenAIFormat()`](src/rpc/mllm-api.ts)-`audio`→`audio_url`,
  `image`→`image_url`, `video`→`video_url`.

- **3rd-party API protocol-ASR (three protocols, `ModelConfig.asrProtocol`):**
  [`MllmApi.transcribeQwen3Asr()`](src/rpc/mllm-api.ts) branches per model.
  `"openai-chat"` (default): OpenAI-compatible `POST /v1/chat/completions` with an
  `audio_url` `file://` reference (the server reads the file itself) and Bearer auth.
  `"whisper-transcribe"`: legacy Whisper-style multipart `FormData` POST to
  `/transcribe` (optional `?language=` query param, array of `{ text, language }`
  results) via [`transcribeViaTranscribeEndpoint()`](src/rpc/mllm-api.ts).
  `"openai-transcriptions"`: OpenAI Audio API multipart POST to
  `/v1/audio/transcriptions` (one `file` part per request; fields `model`,
  `response_format="json"`, optional `language`; response `{ text }`) via
  [`transcribeViaAudioTranscriptions()`](src/rpc/mllm-api.ts)-multiple input files
  are transcribed one request per file and joined with newlines.
  Both multipart protocols must use the global fetch, never `longFetch` (its
  undici Agent drops multipart form parts).

- **URL normalization:** [`MllmApi.toValidRemoteUrl()`](src/rpc/mllm-api.ts) converts local
  paths to `file://` URLs for the LLM server while leaving `http(s)://` and `data:` URIs intact.
  For image media, [`MllmApi.toValidImageUrl()`](src/rpc/mllm-api.ts) goes further: local image
  files are re-encoded via `sharp` and inlined as `data:` URLs-ffmpeg-extracted keyframes can
  carry HDR color-metadata chunks (`cICP`/`cHRM`/`gAMA`) that crash vLLM's image loader (HTTP 500),
  and `data:` URLs sidestep vLLM's `--allowed-local-media-path` policy. Files not readable on the
  host fall back to the plain `file://` pass-through (the LLM server may resolve them in its own
  container mount).

- **Segment defaults:** [`AnalyseApi.getAnalysisDefaults()`](src/rpc/analyse-api.ts) resolves
  the prompt as `step.prompt → model.defaultPrompt → ""`-media types without a workflow step
  (e.g. `keyframe` in `default-analysis`) still prefill the model's configured `defaultPrompt`.

- **Config-driven `mm_processor_kwargs` propagation:** The generic methods
  [`callWithPrompt()`](src/rpc/mllm-api.ts) and [`callWithPromptRaw()`](src/rpc/mllm-api.ts)
  (and the video-specific [`captionVideos()`](src/rpc/mllm-api.ts)) accept an optional
  `mmProcessorKwargsOverride` parameter. The pure helper [`resolveMmProcessorKwargs()`](src/rpc/mllm-api.ts)
  builds the final kwargs by starting from hardcoded media-type defaults
  (video: `{ return_audio: false, use_audio_in_video: false, fps: 1 }`-frame
  limiting is the engine's `--media-io-kwargs` concern or the encoder-cache
  clamp's; `video_num_frames` is silently ignored by vLLM's mm processor)
  and applying the config-driven override on top-every key the override sets wins. When no
  override is passed, the original hardcoded defaults are preserved for backward compatibility.
  The override is assembled by [`buildInferenceMmProcessorKwargs()`](src/lib/archivar-config.ts) in
  `archivar-config.ts`, which merges `ModelConfig.mmProcessorKwargs < ProcessingStep.mmProcessorKwargs
  < SegmentScenesConfig.fps/doSampleFrames` (highest precedence last).
  [`WorkflowEngine.callModelForSegment()`](src/rpc/workflow-engine.ts) resolves the
  segment-scenes config once per processing loop and passes it through, so the vLLM instance
  receives `fps` and `do_sample_frames` dynamically from the workflow config.
  All engine consumers (segment-scenes CLI args, the segment-temporal
  `--preprocess-*` inheritance, and this override) resolve the config through
  `resolveEffectiveSegmentScenesConfig()`, i.e. with the top-level
  `visualCaptionFrequency`/`visualCaptionQuality` multipliers applied-so
  preprocessing output and vLLM frame sampling always agree on the effective
  fps/resolution.
  **Frame sampling server-side:** sampling happens in the
  vLLM MediaIO loader (engine default `VIDEO_FPS=1`); the HF processor runs
  with `do_sample_frames:false`, so `mm_processor_kwargs.fps` is inert.
  `callWithPrompt`/`callWithPromptRaw` therefore forward the resolved video
  `fps` as top-level `media_io_kwargs.video.fps`-the only per-request
  frame-rate knob this server honors (verified: 0.5/1/2 fps → 0.5×/1×/2×
  prompt tokens).
  The forwarded fps is per scene clip: `callModelForSegment` passes the
  clip's duration into `buildInferenceMmProcessorKwargs()`, where the
  short-clip rule (`resolveSegmentFps`) raises clips shorter than
  `shortClipMaxLengthSec` to at least `shortClipMinFps`.

- **Long-running fetches:** All requests go through [`longFetch()`](src/lib/long-fetch.ts) with
  `AbortSignal.timeout(43_200_000)` (~12 h), reflecting that LLM inference can take many minutes.

- **Response normalization:** [`MllmApi.callWithPrompt()`](src/rpc/mllm-api.ts) attempts
  JSON extraction and prefers `transcription`/`desc`/`text` fields; [`MllmApi.callWithPromptRaw()`](src/rpc/mllm-api.ts)
  returns the raw model string for plugins that parse JSON themselves. JSON extraction logic
  is consolidated in [`parseJsonLoose()`](src/lib/parse-json.ts) (handles markdown fences,
  trailing braces/brackets); `extractAndParseJson` delegates to it.

- **Return shape + token usage:** the transport methods return a structured
  [`RawCallResult`](src/rpc/mllm-api.ts) `{ content, usage? }` (not a bare string).
  [`callWithPromptRaw()`](src/rpc/mllm-api.ts), [`callWithPrompt()`](src/rpc/mllm-api.ts),
  [`captionVideos()`](src/rpc/mllm-api.ts) and [`transcribeQwen3Asr()`](src/rpc/mllm-api.ts)
  surface the OpenAI-style `usage` block (`prompt_tokens`/`completion_tokens`/`total_tokens`)
  the chat-completions backends already return; it is `undefined` for protocols that omit it
  (`/v1/audio/transcriptions`, `/transcribe`). The object-returning caption methods
  ([`captionImage`](src/rpc/mllm-api.ts), [`captionAudios`](src/rpc/mllm-api.ts),
  [`captionSound`](src/rpc/mllm-api.ts)) carry an added `usage?` field. Pipeline glue
  ([`WorkflowEngine`](src/rpc/workflow-engine.ts), [`AnalyseApi.analyzeSegment`](src/rpc/analyse-api.ts))
  extracts `.content` so the pipeline result/cache shapes are unchanged; the plugin
  [`callRaw`](src/lib/plugin-types.ts) propagates the full `RawCallResult` so plugins can read
  real token counts. `callJson` still returns the Yup-validated `T` (it consumes `.content`
  internally). Grounded by [`test/e2e-response-format-live.test.ts`](test/e2e-response-format-live.test.ts).

- **Native JSON-schema mode (opt-in):** [`OpenAIChatRequest`](src/rpc/mllm-api.ts) carries
  top-level structured-output fields (`response_format`, `structured_outputs.json`,
  legacy `guided_json`)-all top-level body keys, never nested under `extra_body`.
  [`callWithPromptRaw()`](src/rpc/mllm-api.ts) / [`callWithPrompt()`](src/rpc/mllm-api.ts)
  accept `jsonSchema` + `jsonSchemaMode`; the transport is resolved via
  [`resolveJsonSchemaTransport()`](src/lib/json-schema-probe.ts) (cached per
  endpoint+model+thinking). Transport rejection (HTTP 400) →
  [`JsonSchemaUnsupportedError`](src/lib/errors.ts); truncation
  (`finish_reason:"length"`) → [`TruncatedStructuredOutputError`](src/lib/errors.ts).
  Both are preserved (not re-wrapped) through the catch block so the plugin retry loop
  can react. See [`JSON_MODE_ARCH.md`](src/rpc/JSON_MODE_ARCH.md).

- **vLLM repetition_detection (v0.25+):** [`OpenAIChatRequest`](src/rpc/mllm-api.ts)
  carries the top-level `repetition_detection` body field (`min_pattern_size` /
  `max_pattern_size` / `min_count`). [`callWithPrompt()`](src/rpc/mllm-api.ts) /
  [`callWithPromptRaw()`](src/rpc/mllm-api.ts) attach it only when the caller passes
  a resolved value (`resolvedRepetitionDetection` from
  [`getModel()`](src/lib/archivar-config.ts)-set for `inferenceEngine: "vllm"`
  models, never for `type: "asr-api"`). The defaults live once at
  `ArchivarConfig.repetitionDetection` in `archivar.config.ts`. On structured-output
  calls (active `response_format` / `structured_outputs` / `guided_json` transport)
  the milder `ArchivarConfig.repetitionDetectionStructured` variant is sent instead
  (read via `getStructuredRepetitionDetection()`): its large `min_pattern_size`
  (64) never matches legitimate JSON syntax repetition (table separators, array
  braces-which at 8/3 truncated documents mid-JSON, deterministically failing
  same-seed retries), while prose/keyword-list loops are still caught. On
  schema-validation retries (`callJson` attempt N), the effective parameters are
  progressively relaxed via `relaxRepetitionDetection()` (pattern sizes ×2,
  min_count +1 per attempt) so a same-seed retry escapes detector truncation.

- **Context-length overflow clamp:** on an HTTP 400 whose body matches vLLM's
  "maximum context length is C … at least I input tokens" message,
  [`callWithPromptRaw()`](src/rpc/mllm-api.ts) retries with
  `max_tokens = C − I − margin` (parsed by `parseContextLengthClamp()`), because long
  videos produce aggregation prompts whose size can't be predicted by a static
  `max_tokens` default. The reported input count is a lower bound (media tokens are
  undercounted), so the margin grows exponentially per attempt (1k, 8k, 64k, …) via
  the internal `contextClampAttempt` parameter-strictly decreasing, so no retry
  loop; below 512 tokens of output budget the error propagates.

- **MM encoder-cache frame clamp:** on an HTTP 400 matching vLLM's "video item
  with N embedding tokens … exceeds the pre-allocated encoder cache size C"
  (oversized frame budget), both
  [`callWithPrompt()`](src/rpc/mllm-api.ts) and [`callWithPromptRaw()`](src/rpc/mllm-api.ts)
  retry with a reduced `num_frames = floor(frames × C/N × 0.9)`
  (parsed by `parseEncoderCacheFrameClamp()`, internal `encoderCacheAttempt`
  parameter, max 3 retries, video only)-strictly decreasing, so no retry loop.
  The retry also DROPS `fps`/`do_sample_frames` from `mm_processor_kwargs`.
  NOTE: since frame sampling moved to the MediaIO loader,
  `num_frames` is inert on the current server-this clamp no longer reduces
  the effective input (dropping fps also drops the `media_io_kwargs` forward,
  so the retry falls back to the engine default). Classified as non-fatal
  reason `context`.

- **Media-specific `mm_processor_kwargs`:** Video requests inject `use_audio_in_video: false`,
  `fps: 1`; audio requests set `return_audio: false`. This tuning is
  duplicated across several methods.

---

### `workflow-engine.ts`
→ [`workflow-engine.ts`](src/rpc/workflow-engine.ts)

**Purpose:** The pipeline orchestrator. Runs pre-processing tools, executes per-segment
model inference, aggregates captions into scenes, runs post-processing plugins (v1/v2/v3),
persists plugin-produced summaries, generates requested exports, caches results, collects
timing, and writes debug artifacts. This is the most complex and central file in the
directory.

**Key Concerns:**

- **Workflow config layering (precedence):** [`WorkflowEngine.runWorkflow()`](src/rpc/workflow-engine.ts)
  merges configs in this order: base workflow from [`getWorkflow()`](src/lib/archivar-config.ts) →
  per-file `*.workflow.json` overrides via [`loadFileWorkflowConfig()`](src/lib/file-workflow-config.ts)
  + [`mergeWithWorkflow()`](src/lib/file-workflow-config.ts) → ad-hoc RPC `overrides` (highest).
  `--only "stage:name"` filters execution to a single stage (`preProcessing`/`processing`/
  `postProcessing`).

- **Cache management (multi-table):**
  - Aggregated result keyed `${workflowName}-${outputHash}-${versions}` in the `aggregated` table,
    built once per run by [`resolveAggregatedCacheKey()`](src/rpc/workflow-engine.ts) and used at
    both the read (Step 3, unless `--force`; cache-hit short-circuits the entire pipeline) and the
    write (Step 9). `versions` joins each configured (enabled) post-processing plugin's exported
    `POST_PROCESSING_CACHE_VERSION` (missing export → `"1"`, no plugins → `"1"`). Policy:
    versions are frozen-never bumped; explicit `clear-cache` is the invalidation
    path. The version join remains in the key for backward-compatible key stability only.
  - Per-segment captions keyed `${segment.outputHash}-${mediaType}-${index}` in the
    `scene`/`audio`/`keyframe`/`speech` tables ([`WorkflowEngine.getCacheTable()`](src/rpc/workflow-engine.ts)
    maps media type → table). Checked before each model call-**bypassed when `--force`** is set.
  - Scene results persisted in Step 7; aggregated result persisted in Step 9. Summaries are
    always produced by post-processing plugins-there is no separate summary stage.
  - Cache IDs built by [`getCacheId()`](src/rpc/workflow-engine.ts).
  - **`--force` semantics (full re-run):** when set, the aggregated read is skipped, the workflow
    engine purges every entry matching the file's `outputHash` across all six tables via
    [`CacheApi.removeByPrefix()`](src/rpc/cache-api.ts), **removes the file's `out_*` output
    folders before pre-processing re-runs** ([`FileApi.removeFileOutputs()`](src/rpc/file-api.ts) -
    root-owned Docker outputs are removed via [`removeDirectoryRobust()`](src/lib/output-cleanup.ts);
    the run fails fast if removal fails, since stale segments would otherwise mix with fresh ones
    during file discovery), pre-processing tools re-run even if
    `out_*` folders already exist ([`WorkflowEngine._hasPreProcessingOutputs()`](src/rpc/workflow-engine.ts)),
    and the per-segment LLM cache is bypassed so models are re-called for every segment. Fresh
    results are always written at Steps 7/9.

- **Pre-processing output cache (skip-if-present):** [`WorkflowEngine.runPreProcessing()`](src/rpc/workflow-engine.ts)
  checks [`WorkflowEngine._hasPreProcessingOutputs()`](src/rpc/workflow-engine.ts) before invoking
  each external tool (temporal segmentation, scene segmentation). When an `out_*` folder
  already exists and `--force` is not set, the tool is skipped to avoid redundant re-processing.
  First runs (no outputs) always run; `--force` always overrides.
- **Parallel segmentation:** temporal and scene segmentation run concurrently
  (`Promise.allSettled`) when both apply-they are independent tools with
  disjoint write sets in the shared `out_*` folder; neither consumes the
  other's outputs. Both finish before the first rejection is rethrown (partial
  outputs survive a single failure). A single applicable tool (audio file,
  `--only`, skip) keeps sequential behavior.

- **Single-image pre-processing (synthesized keyframe):** for `mediaType ===
  "image"` no external tool ever runs; instead `runPreProcessing()` itself
  writes the keyframe artifact `out_<name>_<ext>_<hash>/scene_keyframes/0_0_0.png`
  via [`convertImageToKeyframePng()`](src/lib/image-keyframe.ts)-PNG
  conversion, EXIF auto-orient, shrink-only resize to the effective
  `segmentScenes` `maxWidthPx`/`maxHeightPx` (the `visualCaptionQuality`
  multiplier included). The `<hash>` is content-based
  ([`computeImageKeyframeHash()`](src/lib/image-keyframe.ts)), which gives
  images real per-segment/aggregated cache keys (previously `outputHash` was
  `null`, colliding across different images). Gated on an enabled `keyframe`
  processing step (not on `segmentScenes.enabled`-the config only donates
  the pixel limits), counted as `segmentScenes` for `--only` filtering, and
  covered by the same skip-if-present/`--force` semantics as the external
  tools. The STEP 2 re-discovery then picks the artifact up like any video
  keyframe.

- **Batching & concurrency:** [`processBatch()`](src/rpc/workflow-engine.ts) processes
  segments in configurable batches (size from `model.parallelism`, default 4). Batches run
  sequentially; each processor also receives `previousResult`-the finished result of the
  previous index, which is only available across a batch boundary (same-batch predecessors
  run concurrently and stay invisible). Scene captioning with `includePreviousCaption` uses
  it to inject the previous scene's caption into the context-aware prompt
  ([`buildContextAwarePrompt()`](src/lib/caption-prompt-builder.ts)). The assembled
  per-slice prompt (context-aware or plain) passes through
  [`dedupePromptText()`](src/lib/prompt-dedupe.ts)-exact duplicate lines are
  removed, multiplicity survives as " (xN)" markers with a legend line. Within
  [`WorkflowEngine.runProcessingSteps()`](src/rpc/workflow-engine.ts), speech steps and
  visual/audio steps run in two parallel `runGroup` tracks; when context-aware captioning is
  needed, a phased audio-first execution runs scene steps with batch size 1 (full context
  chain) and keyframe steps afterwards.

- **Speech re-analysis heuristic:** In [`WorkflowEngine.runProcessingSteps()`](src/rpc/workflow-engine.ts),
  if a noise/harmonic model returns `audio_type === "speech"`, the segment is re-analyzed with
  the speech model and additionally cached under the `speech` table.

- **Keyframe `enabledAsFallback` invariants:** Keyframe steps ship default-disabled
  (`enabled: false` + `enabledAsFallback: true`): they run only for single-image input or
  when explicitly enabled (see `resolveEnabledProcessingSteps()`). When a keyframe step does
  run for a video, the skip-filter compares a keyframe's parent
  scene caption by *filtered* scene index (sub-1s scenes are dropped from scene captioning),
  never the raw `fileInfo.scenes` position. After `processBatch`, captions are remapped from
  the processed-sublist basis onto the full filtered index basis
  ([`remapProcessedCaptions()`](src/lib/caption-index.ts))-the basis `aggregateResults` reads.
  Keyframe slice paths resolve via `fileInfo.sceneKeyframes` (the list assigned into scenes);
  `fileInfo.keyframes` is empty for videos.

- **Segment aggregation algorithm:** [`WorkflowEngine.aggregateResults()`](src/rpc/workflow-engine.ts)
  assigns each speech/keyframe/harmonic/noise segment to the scene with the
  **largest temporal overlap** ([`findBestOverlapSceneIndex()`](src/lib/scene-assignment.ts),
  ties → earliest scene). Segments with no overlap fall back to
  [`findNearestSceneIndexWithinGap()`](src/lib/scene-assignment.ts)
  (midpoint-distance nearest, capped by `MAX_SCENE_ASSIGNMENT_GAP_SEC = 5.0`,
  [workflow-engine.ts](src/rpc/workflow-engine.ts)). Segments still unmatched stay
  **unassigned** (wrong attribution is worse than none): they are kept out of scene
  arrays and emitted by [`buildPostProcessingInput()`](src/rpc/workflow-engine.ts)
  as audio-only slices with `sceneIndex: -1`, where `decideForAggregation`'s
  temporal cap lets the model decide. For audio-only files with no scenes, a
  single virtual scene spanning `[0, maxEnd]` is synthesized.

- **Completeness invariant over time slices (WS5):** right after the first
  [`buildPostProcessingInput()`](src/rpc/workflow-engine.ts) call of a run,
  [`findCompletenessViolations()`](src/lib/slice-completeness.ts) checks that
  every scene slice ≥ 1s has a caption, every shorter scene slice has its own
  or a same-scene keyframe caption, and every speech slice has a transcript
  (stored in `caption`). Violations are logged (count + first few) and
  recorded into `debug.json` as `result.postProcessingWarnings`-the run
  never fails on them.

- **Incremental `debug.json` writes (durability during long runs):** instead of writing
  `<outputDir>/debug.json` only once at the very end, [`writeDebugJson()`](src/rpc/workflow-engine.ts)
  is called at every milestone-cache-hit, after Step 6 aggregation (`after-aggregation`), after each
  post-processing plugin (`after-plugin:<name>`), on the Step 5→9 error path (`error`, then rethrow),
  and the final write (`final`). Each write attaches a partial [`TimingCollector.snapshot()`](src/lib/timing-collector.ts)
  (non-destructive, unlike `finalize()`). This ensures a timeout/crash leaves THIS run's most recent
  milestone on disk instead of a stale file from the previous run, and observers can read partial
  results before the slow post-processing tail completes. Sync `writeFileSync` (<100ms even for ~730KB).

- **Per-run token-usage aggregation (`tokenUsage`):** `runWorkflow` enters a
  [`tokenUsageCapture`](src/lib/token-usage-collector.ts) AsyncLocalStorage (same mechanism as the
  scoped debug capture). Every transport call-engine captioning/ASR, plugin `callJson`/`callRaw`
  (incl. retries), and the JSON-schema probe-calls [`recordTokenUsage()`](src/lib/token-usage-collector.ts)
  after each backend response, so the whole async tree's `usage` is summed into one
  [`TokenUsageAccumulator`](src/lib/token-usage-collector.ts). On success and on the error path the
  accumulator is summarized into `result.tokenUsage = { input, output, total }` (next to
  `result.timing`); a cache hit reuses the cached result's own `tokenUsage`. Surfaced in the JSON
  output, the Markdown/Word `Token usage:` line, and the dashboard provenance footer.

- **Per-run non-fatal-error aggregation (`nonFatalErrors`):** same AsyncLocalStorage mechanism as
  `tokenUsage` ([`nonFatalErrorCapture`](src/lib/non-fatal-error-collector.ts)). Recovered errors
  are recorded via [`recordNonFatalError()`](src/lib/non-fatal-error-collector.ts) at: `callJson`
  retries (schema/parse/truncation), `callWithPromptRaw`'s context-clamp retry, each per-segment
  captioning/ASR failure (the `callModelForSegment` wrapper), and plugin-hook failures + plugin
  crashes. Each entry carries a coarse `reason` (`schema|context|transport|timeout|unknown`,
  classified in [`classifyNonFatalReason`](src/lib/non-fatal-error-collector.ts)), the resolved
  `model`, and the capped primary `details` (no stack). `result.nonFatalErrors = { count, trace }` is
  attached before the cache write. Surfaced in JSON (full trace) and Markdown/Word/UI (count + reason
  breakdown). Fatal run-killing errors are NOT counted here.

- **Pre-flight model-endpoint gate:** after the workflow definition is final
  (file config + ad-hoc overrides applied) and BEFORE pre-processing starts,
  `runWorkflow` calls [`preflightWorkflowModels()`](src/lib/preflight-models.ts)
  once per run. It probes every model endpoint the run will call (enabled
  processing steps incl. fallbacks + enabled plugin `config.modelName`s,
  narrowed by `--only <stage>`) with a tiny `GET <origin>/v1/models` (5 s
  timeout; any HTTP response = reachable, 401/403 = auth failure) and throws an
  actionable error listing every unreachable endpoint. Without it, a dead
  endpoint surfaced only as hundreds of recovered per-segment `nonFatalErrors`
  and an empty-shell "OK" result (the gemma4 incident).

- **Path resolution per media category (critical):** [`WorkflowEngine.callModelForSegment()`](src/rpc/workflow-engine.ts)
  uses `segment.hostAbsolutePath` for audio/speech (consumed by local ASR tooling) but
  `segment.absolutePath` (container-visible) for video/image (consumed by the LLM server). This
  host-vs-container duality is intentional and load-bearing.

- **3rd-party API protocol dispatch:** [`WorkflowEngine.callModelForSegment()`](src/rpc/workflow-engine.ts)
  branches on `model.type`: `tool` → [`AnalyseApi.executeScript()`](src/rpc/analyse-api.ts);
  `asr-api` → [`MllmApi.transcribeQwen3Asr()`](src/rpc/mllm-api.ts); default `api` →
  [`MllmApi.callWithPrompt()`](src/rpc/mllm-api.ts).

- **Post-processing plugin lifecycle (v3):** [`WorkflowEngine.runPostProcessingPlugins()`](src/rpc/workflow-engine.ts)
  executes the ordered v3 hook chain: `postProcessPerTimeSlice` → `decideForAggregation`
  (greedy adjacent-slice grouping + deterministic minimum-size enforcement) →
  `postProcessPerAggregation` + `summaryForAggregation` → `extractSemanticProfiles` →
  `enrichAggregationTransitions` (optional) → `postProcessHigherOrderAggregations` →
  `summaryFromAggregations` / `summaryFromTimeSlices`. Errors are collected per-hook rather than
  fatal. The per-aggregation pair (`postProcessPerAggregation` + `summaryForAggregation`) runs
  under bounded concurrency (plugin's `config.maxConcurrency`, default 2) via an engine-local
  index-preserving worker pool-each task mutates only its own aggregation, so result order is
  preserved by index; `extractSemanticProfiles` stays sequential (auto-regressive).
  v2 plugins receive `PostProcessingInput` (TimeSlice[]); v1/legacy receive the raw
  `AnalysisResult`.

- **Debug artifacts:** `runWorkflow` tees `console.log/error/warn` into a `debug.log` and writes
  `debug.json` in a `<fileName>.archivar/` folder adjacent to the host file, even on cache hits.
  The tee serializes `Error` arguments as `name: message` + stack (their properties are
  non-enumerable, so plain `JSON.stringify` would log `{}`).
  [`TimingCollector`](src/lib/timing-collector.js) + [`renderTimingTree()`](src/lib/timing-tree-renderer.js)
  produce an ASCII timing tree appended to the log.

- **Caption degeneration guard:** after each API-type `callModelForSegment` caption,
  [`hasAtypicalSymbols()`](src/lib/text-degeneration.ts) checks for characters outside the
  typical latin-language printable ranges (symbol-soup failure mode); on a hit the caption
  is retried once with temperature −0.2. The same detector guards
  [`callJson()`](src/rpc/post-processing/plugin-api.ts) (post-processing structured calls):
  an atypical raw response triggers ONE extra attempt with a prepended language note
  ("Last time the output wasn't in the primary language … should not mix languages"),
  replayed outside the schema-retry budget; a still-atypical second response continues
  through the normal parse/validation path.

- **Speech-segment length cap:** the speech model's `maxLengthInSec` (ModelConfig, e.g. 110
  for Qwen3-ASR) is passed to temporal segmentation as `--max-len-speech` during
  pre-processing, so ASR never receives audio the backend's encoder cache rejects.

- **Output formats:** [`WorkflowEngine.formatOutput()`](src/rpc/workflow-engine.ts) supports
  `json`, `md` ([`renderAsMarkdown()`](src/rpc/workflow-engine.ts)), and `toon` (via
  [`@byjohann/toon`](https://www.npmjs.com/package/@byjohann/toon) `encode`).

- **Status tracking:** [`WorkflowEngine`](src/rpc/workflow-engine.ts) writes `status.json` to
  `<file>.archivar/status.json` at workflow start (status: "processing"), on completion (status: "done"),
  and on error (status: "error"). Uses [`StatusApi`](src/rpc/status-api.ts) for persistence.

- **Webhook delivery:** When a `webHookUrl` is provided, [`WorkflowEngine`](src/rpc/workflow-engine.ts)
  calls [`WebhookApi.deliverWebhook()`](src/rpc/webhook-api.ts) after successful completion.
  Webhook is called exactly once with retry logic (3 attempts, exponential backoff).

- **Export generation on completion:** `runWorkflow` accepts an optional `exportFormats`
  parameter (`ExportFormat[]`, threaded from `POST /api/analyze`'s `exports` field through
  [`AnalyseApi.runWorkflow()`](src/rpc/analyse-api.ts)). When set, the engine generates
  the requested exports via [`export.ts`](src/rpc/export.ts) on completion-on both the
  fresh-run and cache-hit paths-and awaits them before `markDone`/webhook delivery so the
  references already exist on disk when clients are notified. Export failures are logged,
  never fail the workflow.

---

### `status-api.ts`
→ [`status-api.ts`](src/rpc/status-api.ts)

**Purpose:** Per-file workflow status management. Manages `status.json` files that track workflow state
for each file, enabling polling-based status checking from CLI, API routes, and UI.

**Status file structure:**
```typescript
{
  status: "processing" | "done" | "error",
  file: string,
  workflow?: string,
  models?: { asr?: string, vlm?: string },  // resolved at workflow start, for export provenance
  startedAt: string,        // ISO timestamp
  heartbeatAt?: string,     // ISO timestamp, refreshed while the workflow is alive
  completedAt?: string,     // ISO timestamp when done
  error?: string,          // Error message if status === "error"
  webHookUrl?: string,    // URL to call when done
  webHookDelivered?: boolean
}
```

**Key Concerns:**
- **File location:** Status files stored at `<file>.archivar/status.json`.
- **Lifecycle:** Written immediately on `runWorkflow` call (status: "processing"), updated on
  completion (status: "done") or error (status: "error"). `AnalyseApi.runWorkflow()` additionally
  catches any engine failure outside the engine's own stages (e.g. pre-processing) and marks
  the status "error", so a thrown run never stays "processing".
- **Liveness (heartbeat):** `startProcessing` registers the status file in a module-level
  heartbeat registry; a shared interval (`HEARTBEAT_INTERVAL_MS`, 15s) refreshes `heartbeatAt`
  while the workflow is alive. `markDone`/`markError`/`clearStatus` unregister. Readers
  (`getStatus`, `listStatuses`) treat a "processing" status whose last heartbeat (falling back
  to `startedAt`) is older than `STALE_AFTER_MS` (3min) as dead-killed, crashed, or the
  server restarted-and persist a one-time transition to "error" with a `stale: no heartbeat…`
  message.
- **Listing:** [`StatusApi.listStatuses(statusFilter?)`](src/rpc/status-api.ts) globs all
  `*.archivar/status.json` under the data dir, applies the stale transition, optionally filters
  by status, and returns them sorted by `startedAt` descending. Backs the CLI `status` command
  and `GET /api/status`.
- **RPC exposure:** Methods exposed via defuss-rpc for API route consumption.

---

### `webhook-api.ts`
→ [`webhook-api.ts`](src/rpc/webhook-api.ts)

**Purpose:** Webhook delivery management. Handles delivery of webhooks when workflows complete.
Webhook is called exactly once with retry logic.

**Key Concerns:**
- **Webhook file:** URL stored at `<file>.archivar/webhook.json` before workflow starts.
- **Delivery:** Reads `debug.json` and POSTs to the webhook URL with:
  ```typescript
  { file: string, status: "done", result: AnalysisResult, exports?: ExportMap }
  ```
  `exports` ([`ExportMap`](src/rpc/export.ts)) is included only when export files exist on
  disk under `<file>.archivar/exports/`; each entry is `{ path, size, mimeType }` with `path`
  relative to the data dir.
- **Retry logic:** 3 attempts with exponential backoff (1s, 2s, 4s).
- **Exactly-once:** Webhook file deleted after successful delivery.
- **Non-blocking:** Delivery is fire-and-forget from the workflow engine perspective.

---

## `src/rpc/post-processing/`

### `aggregate-rundown-items.js`
→ [`aggregate-rundown-items.js`](src/rpc/post-processing/aggregate-rundown-items.js)

**Purpose:** DEPRECATED: legacy v2 `run()`-contract plugin kept for reference. The engine
only invokes named v3 `PostProcessingPluginModule` hooks, nothing calls `run()`, and no
active workflow references this file. It tallies counts per slice type and logs a
per-slice rundown, returning the input unchanged.

**Key Concerns:**

- **v2 contract:** Exports `version = 2` and a `run(input, config)` entrypoint
  matching the retired v2 plugin shape. No cache, no env-driven paths, no external
  protocols.

---

### `plugin-api.ts`
→ [`plugin-api.ts`](src/rpc/post-processing/plugin-api.ts)

**Purpose:** Builds the [`PluginApi`](src/lib/types.ts) facade handed to v3 plugins-the
sandboxed surface through which plugins reach file ops, cache, analysis, the MLLM, and utilities.

**Key Concerns:**

- **Dependency injection:** [`buildPluginApi()`](src/rpc/post-processing/plugin-api.ts) takes
  the [`MllmApi`](src/rpc/mllm-api.ts), [`CacheApi`](src/rpc/cache-api.ts),
  [`FileApi`](src/rpc/file-api.ts), and [`AnalyseApi`](src/rpc/analyse-api.ts) instances
  (with `new` defaults), wiring them into `file`/`cache`/`analysis`/`mllm`/`util` namespaces.

- **LLM JSON-with-schema retries (high-complexity algorithm):** [`callJson()`](src/rpc/post-processing/plugin-api.ts)
  calls [`MllmApi.callWithPromptRaw()`](src/rpc/mllm-api.ts), then
  [`parseJsonLoose()`](src/rpc/post-processing/plugin-api.ts), then validates against a
  [`yup`](https://www.npmjs.com/package/yup) schema. On JSON-parse or validation failure it
  retries up to `maxRetries` (default 2) using [`buildCorrectionPrompt()`](src/rpc/post-processing/plugin-api.ts)
 -which quotes the model's previous invalid answer and the exact field-level errors from
  [`formatYupError()`](src/rpc/post-processing/plugin-api.ts)-so the model can self-correct.
  Media files are re-sent on every attempt. Each retry is recorded as a non-fatal error.

- **Soft degradation on schema exhaustion (no fatal throw):** when schema-validation retries are
  exhausted, `callJson` does NOT throw-it returns the best-effort parsed object as a degraded
  fallback (the model's best answer for the slice, even if not fully schema-conformant) and
  records a final `"Schema validation exhausted"` non-fatal error. This keeps the run alive
  (the workflow engine additionally isolates per-hook crashes), and the operator sees every
  degradation in `result.nonFatalErrors`. The only remaining fatal throw is unparseable JSON
  after all retries (no structured data to degrade to).

- **Loose JSON parsing:** [`parseJsonLoose()`](src/rpc/post-processing/plugin-api.ts) tries
  direct parse → markdown-fenced extraction → trailing-brace extraction → bracket extraction,
  returning `null` on total failure.

- **Concurrency utility:** [`limitConcurrency()`](src/rpc/post-processing/plugin-api.ts)
  implements a worker-pool concurrency limiter available to plugins.

---

### `plugin-module-loader.ts`
→ [`plugin-module-loader.ts`](src/rpc/post-processing/plugin-module-loader.ts)

**Purpose:** Shared, process-level cache for post-processing plugin modules.
Replaces the former ad-hoc dynamic `import()` per run, which routed through the
Vite module runner in dev and repeatedly failed mid-workflow with
"Vite module runner has been closed", killing the post-processing phase.

**Key Concerns:**

- **No mid-run imports:** modules are loaded once per process and eagerly at
  workflow start ([`preloadPluginModules()`](src/rpc/post-processing/plugin-module-loader.ts)
  from `runWorkflow`, before the long processing stage). The post-processing
  step and [`resolveAggregatedCacheKey()`](src/rpc/workflow-engine.ts) reuse
  the cached module, so no dynamic import ever runs mid-workflow.
- **Failure handling:** failed imports do not poison the cache (the entry is
  evicted so the next call retries). Preload failures are logged and skipped -
  the post-processing step surfaces them through its own error handling.
- **Dev-server reloads:** a Vite module-runner reload re-instantiates this
  module too, so the cache never serves stale plugin code across reloads.

- **TypeScript caveat:** On `.ts` import failure in a plain Node runtime, it surfaces an
  explicit "run with tsx or provide a compiled .js plugin" error rather than a cryptic
  module-not-found.

---

## Cross-cutting notes

- **Environment variable reference** (defaults in parentheses): `RELATIVE_TOOLS_PATH` (`..`),
  `SAMPLE_DATA_SUBDIR` (`sample_data/archivar`), `RELATIVE_SAMPLE_DATA_PATH`
  (`../${SAMPLE_DATA_SUBDIR}`), `ABSOLUTE_SAMPLE_DATA_PATH` (`/${SAMPLE_DATA_SUBDIR}`),
  `RELATIVE_DIR_PREFIX` (`""`), `SAMPLE_DATA_SERVER`
  (`http://127.0.0.1:8080`), `SAMPLE_DATA_BASE_PATH` (`${SAMPLE_DATA_SUBDIR}`),
  `MLLM_API_KEY` (optional fallback key; per-model keys come from `MODEL_CONFIG`/config).
- **Host-vs-container path duality** is pervasive: audio/speech paths reach local tooling via
  `hostAbsolutePath` (the absolute path the file was discovered at), while video/image
  paths reach the LLM server via `absolutePath` (container-visible, `/sample_data/...`).
- **Cache key conventions:** `${outputHash}` (file-level), `${outputHash}-${mediaType}-${index}`
  (segment-level), `${workflowName}-${outputHash}` (summary-level),
  `${workflowName}-${outputHash}-${pluginVersions}` (aggregated-level, see
  [`resolveAggregatedCacheKey()`](src/rpc/workflow-engine.ts)). The
  [`outputHash`](src/rpc/file-api.ts) is the trailing segment of the `out_<name>_<ext>_<hash>`
  output folder name-any change to that naming convention invalidates all caches.
