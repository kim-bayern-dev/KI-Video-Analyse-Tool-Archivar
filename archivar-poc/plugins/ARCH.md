# Architecture Reference-`plugins/`

This document describes the purpose and architectural significance of each TypeScript
file living in [`plugins/`](plugins/). These files implement the v3 post-processing
plugin lifecycle-a contract-based pipeline that runs after scene segmentation and
ASR, performing per-slice visual analysis, semantic aggregation decisions, and
whole-video summarization via a Multimodal Large Language Model (MLLM).

All plugins conform to the [`PluginApi`](src/lib/types.js)/
[`PluginConfig`](src/lib/types.js) contract consumed by the
[plugin module loader](src/rpc/post-processing/plugin-module-loader.ts) and the
[`WorkflowEngine`](src/rpc/workflow-engine.ts).

---

## `default.ts`

[`plugins/default.ts`](plugins/default.ts)

**Purpose:** The reference v3 post-processing plugin. It implements the full
v3 lifecycle (per-slice analysis → aggregation decisions → per-aggregation
analysis → semantic profiles → transition enrichment → higher-order aggregation
→ whole-video summary) and produces structured visual analyses of a video's time
slices, semantically groups them into "contributions" (aggregations), and emits a
whole-video summary. It is the default plugin loaded when no other plugin is
configured.

**Key Concerns:**

- **MLLM protocol (3rd-party LLM API):** Every analytical stage delegates to the
  same MLLM backend through [`api.mllm.callJson()`](src/rpc/post-processing/plugin-api.ts).
  Model identity, endpoint, and API key are resolved centrally via
  [`getModel()`](src/lib/archivar-config.ts) using the configured `modelName`
  (default `Qwen3.8-27B-FP8`). Each call sends a German prompt plus an optional
  media file (`mediaCategory` = `"image"` for keyframes, `"video"` otherwise),
  expects strict JSON back, and is paired with a Yup schema
  ([`sliceAnalysisSchema`](plugins/default.ts),
  [`aggregationDecisionSchema`](plugins/default.ts),
  [`wholeSummarySchema`](plugins/default.ts)) so that the API layer can
  auto-retry on validation failure. **Native schema mode is resolved by model
  family:** [`getModel()`](src/lib/archivar-config.ts) resolves `jsonSchemaMode`
  with precedence explicit-`ModelConfig.jsonSchemaMode` → model-name registry
  ([`json-schema-mode-defaults.ts`](src/lib/json-schema-mode-defaults.ts):
  `gemma*` → `response_format`, `qwen3*` → `structured_outputs`) → `"auto"`
  (probe). So Yup schemas are converted to JSON Schema and sent for vLLM
  constrained decoding without a per-call probe for known families. The
  structured-response `name` is configurable via `ModelConfig.jsonSchemaName`
  (default `"archivar_response"`). The Yup validation retry loop stays as a
  safety net. All prompt/schema pairs are proven schema-conformant per family by
  [`test/e2e-plugin-schema-mode-live.test.ts`](test/e2e-plugin-schema-mode-live.test.ts).
  The converter keeps optional fields (e.g. `audio_details`) out of `required[]`
  so their absence never errors.

- **Environment / config-driven path decisions:**
  - The model used is chosen via `config.modelName`, falling back to
    [`DEFAULT_VLM_MODEL`](plugins/default.ts). The actual endpoint URL, model
    id, and API key are looked up through [`getModel()`](src/lib/archivar-config.ts),
    which reads the global Archivar model registry (backed by
    [`archivar.config.ts`](archivar.config.ts) and environment variables).
  - The set of slice types processed is governed by
    `config.includeTypes` (default
    [`DEFAULT_POST_PROCESSING_INCLUDE_TYPES`](plugins/default.ts) = `["scene",
    "speech"]`). Including `"speech"` activates the entire transcript-aware code
    path (see below).
  - `config.reanalyzeVideoForAggregation` toggles whether the aggregation stage
    re-sends raw video files to the MLLM versus doing a text-only merge of
    per-slice analyses-a significant cost/quality tradeoff.
  - Concurrency is bounded by `config.maxConcurrency` (default
    [`DEFAULT_MAX_CONCURRENCY`](plugins/default.ts) = 2) via
    [`api.util.limitConcurrency()`](src/rpc/post-processing/plugin-api.ts).
  - All media files referenced come from `slice.sourceFile.containerPath` -
    already-resolved paths inside the per-file Archivar working directory; no
    new absolute paths are constructed here.

- **Cache management:** This plugin does not maintain its own cache. Per-slice
  and per-aggregation results are written back into the slice/aggregation
  objects' `plugin["default"]` / `analysis` fields and persisted downstream by
  the workflow engine. (There is no MLLM-call-layer response cache-repeated
  runs re-issue VLM calls unless the engine's per-segment/aggregated caches
  short-circuit whole stages.)
  **Cache key versioning (frozen):** the module exports
  `POST_PROCESSING_CACHE_VERSION` (string), which the workflow engine folds
  into the `aggregated` cache key. **Policy: the version is
  frozen at `"4"`-never bump it, never remove the export.** Cache
  invalidation after prompt/logic changes is done explicitly
  (`clear-cache --file …`); automatic version-based invalidation is unwanted
  (a bump orphans every existing entry, and a missing export counts as `"1"`,
  which would change the key just the same). Plugins without the export count
  as `"1"`.

- **Aggregation transition enrichment:** [`enrichAggregationTransitions()`]
  (plugins/default.ts) runs after all aggregation analyses and semantic profiles
  are final, before higher-order aggregation. For each adjacent pair
  `(agg[i-1], agg[i])` it makes one small **text-only** MLLM call
  ([`TRANSITION_PROMPT`](plugins/default.ts), validated by `transitionSchema`)
  that returns a reliable `relationship_to_previous` label (from
  `RELATIONSHIP_LABELS`) plus a 1–2-sentence `transition_description`, written
  into `agg[i].analysis` (overwriting the unreliable slice-derived label, which
  parallel caption batches cannot compute). Pair calls run under
  `api.util.limitConcurrency(config.maxConcurrency)`-safe because analyses are
  immutable at this point. A failed pair logs and leaves existing values
  untouched (never throws). Opt-out via `config.enrichTransitions = false`
  (default `true`). [`aggregationToText()`](plugins/default.ts) emits the
  enrichment as `Übergang von vorheriger: …`, so HOA boundary decisions and HOA
  prompts consume it.

- **Bounded-concurrency per-aggregation analysis:** the workflow engine runs
  `postProcessPerAggregation` + `summaryForAggregation` under bounded
  concurrency (the plugin's `config.maxConcurrency`, default 2), with results
  written back in index order. This is safe because each task mutates only its
  own aggregation, the transition pass (above) restores reliable boundary
  context afterwards, and `extractSemanticProfiles` stays sequential
  (auto-regressive-it needs order).

- **Transcript-aware aggregation algorithm:** When `config.includeTypes`
  contains `"speech"`, a parallel code path activates that fuses ASR transcripts
  with visual analysis:
  - In [`postProcessPerTimeSlice()`](plugins/default.ts), speech slices skip
    the VLM call entirely and instead store their existing caption as plugin
    data (`type: "speech_transcript"`), avoiding redundant inference.
  - In [`decideForAggregation()`](plugins/default.ts), the prompt template
    switches from [`DECISION_PROMPT`](plugins/default.ts) to
    [`DECISION_PROMPT_WITH_TRANSCRIPTS`](plugins/default.ts) when both
    adjacent slices carry transcripts-giving the model audio-visual context for
    the merge decision.
  - In [`postProcessPerAggregation()`](plugins/default.ts),
    [`collectSpeechTranscriptsForAggregation()`](plugins/default.ts)
    performs a **timeframe overlap query**: a speech slice is considered part of
    an aggregation iff `speech.toSeconds >= agg.fromSeconds && speech.fromSeconds
    <= agg.toSeconds`. Overlapping slices are sorted chronologically and injected
    into [`AGGREGATION_ANALYSIS_WITH_TRANSCRIPTS_PROMPT`](plugins/default.ts),
    instructing the model to use transcript text in lieu of "unsicher" audio
    placeholders.

- **Multi-branch aggregation dispatch algorithm:** [`postProcessPerAggregation()`]
  (plugins/default.ts:371) selects one of three prompt/call strategies in
  priority order:
  1. Transcript-aware text merge (when transcripts are present and configured).
  2. Video re-analysis (when `config.reanalyzeVideoForAggregation` is true and no
     transcripts)-collects and re-sends all member slices' video files.
  3. Text-only merge of per-slice analyses (default fallback, no media files).
  All three branches share [`baseCallArgs`](plugins/default.ts) and the
  [`sliceAnalysisSchema`](plugins/default.ts) so the output contract is
  uniform regardless of input modality. In that schema only `summary`,
  `setting`, `scene_type`, `text_visible` and `uncertainties` are required;
  `timeline`, `subjects` and `camera_motion` are optional detail fields (the
  converter keeps them out of `required[]`), because text-only aggregation
  calls have no media to ground them in and weaker models otherwise burn the
  validation retries emitting `""` for them.
  Every prompt built from repeated content (all three aggregation branches,
  HOA, unified/whole/chronological summary-and the per-slice caption prompt
  in the workflow engine) passes through
  [`dedupePromptText()`](src/lib/prompt-dedupe.ts): exact duplicate lines are
  removed, the survivor carries its multiplicity as " (xN)", and a legend line
  (`DEDUP_NOTE`) is prepended only when something was deduplicated.

- **Minimum-size aggregation constraints (model-free):** Because the pairwise
  [`decideForAggregation()`](plugins/default.ts) decision can always say
  "different", it can leave singleton / too-short groups. A deterministic
  post-grouping merge pass (shared pure helper
  [`aggregation-constraints.ts`](src/lib/aggregation-constraints.ts):
  `enforceMinGroupSize`) folds undersized groups into adjacent neighbours via a
  balanced forward sweep. It applies at two levels:
  - **Level 1-slice → aggregation** (in
    [`workflow-engine.ts`](src/rpc/workflow-engine.ts) right after the grouping
    loop): an aggregation is merged if it covers fewer than
    `config.minScenesPerAggregation` (default `2`) distinct scenes-but the
    scene-count rule is **skipped when the video has < 3 scenes** so two
    genuinely-different scenes are not force-collapsed-**OR** if it is shorter
    than `config.minAggregationLengthInSec` (default `10`), which is always on.
  - **Level 2-aggregation → HOA** (in
    [`postProcessHigherOrderAggregations()`](plugins/default.ts) right after
    the HOA boundary loop): a higher-order aggregation is merged if it contains
    fewer than `config.minAggregationsPerHigherOrder` (default `2`) aggregations
    when there are ≥ 2 aggregations total.
  Each knob accepts `1` (or `0` for length) to disable. A single group is always
  kept as-is regardless of size. Covered by
  [`test/aggregation-constraints.test.ts`](test/aggregation-constraints.test.ts),
  [`test/aggregation-constraints-engine.test.ts`](test/aggregation-constraints-engine.test.ts)
  and the HO10–HO12 cases in
  [`test/visual-artifacts-higher-order.test.ts`](test/visual-artifacts-higher-order.test.ts).

- **Editorial-content rule (technical errors never leak into outputs):** Every
  content-generating prompt in the post-processing chain-the four
  aggregation-analysis variants, `MERGE_PARTIAL_ANALYSES_PROMPT`,
  `WHOLE_SUMMARY_PROMPT`, `SEMANTIC_PROFILE_WITH_CONTEXT_PROMPT`, and the three
  external templates ([`higher-order-aggregation-prompt.md`](src/lib/higher-order-aggregation-prompt.md),
  [`unified-summary-prompt.md`](src/lib/unified-summary-prompt.md),
  [`chronological-summary-prompt.md`](src/lib/chronological-summary-prompt.md)) -
  carries `EDITORIAL_CONTENT_RULE`; the true/false classification prompts
  (`DECISION_PROMPT`, `DECISION_PROMPT_WITH_TRANSCRIPTS`, `TRANSITION_PROMPT`)
  carry the compact `EDITORIAL_CONTENT_RULE_DECISION`. Both instruct the model
  that purely technical error messages, pipeline/processing notes, and even its
  own *suspicion* of processing errors (e.g. a "Segmentierungsfehler" inferred
  from hard topic cuts in the source material) are not editorial content and
  must not appear in or influence titles, keywords, tags, summaries,
  descriptions, assessments, or reasons. The per-slice visual caption prompt is
  deliberately exempt: on-screen error text in a frame *is* legitimate visible
  content there.

- **Fact-fidelity rule (no hallucinated quotes/dates):** The scene-caption
  template ([`caption-prompt-template.md`](src/lib/caption-prompt-template.md))
  instructs the model that quotes, dates, times, names and numbers may only be
  reported when actually readable in the frame or audible in the audio context
 -never invented, completed or rounded. The aggregation chain carries
  `FACT_GROUNDING_RULE` (appended after `EDITORIAL_CONTENT_RULE`): the four
  aggregation-analysis variants, `MERGE_PARTIAL_ANALYSES_PROMPT`,
  `WHOLE_SUMMARY_PROMPT`, `SEMANTIC_PROFILE_WITH_CONTEXT_PROMPT`, and the three
  external templates. It restricts such facts to ones appearing verbatim in
  the stage's inputs and allows only genuinely important ones to bubble up -
  so a caption-level hallucination cannot be amplified upward into titles,
  keywords or summaries.

- **Graceful degradation:** Every MLLM-backed hook catches errors and records
  either a `_error` marker on the slice/aggregation or returns `false` / `null`
  / an empty patch rather than throwing-ensuring one bad slice or aggregation
  never aborts an entire run. [`decideForAggregation()`](plugins/default.ts)
  notably defaults to `false` on failure to prevent spurious cross-topic merges.

- **Fallback summarization strategy:** [`summaryFromTimeSlices()`](plugins/default.ts)
  is invoked when the aggregation phase produced zero aggregations; it builds a
  whole-video summary directly from per-slice analyses instead, reusing
  [`WHOLE_SUMMARY_PROMPT`](plugins/default.ts) and
  [`wholeSummarySchema`](plugins/default.ts).

- **Sliding-window chronological summarization:** In
  [`summaryFromAggregations()`](plugins/default.ts), the unified whole-video
  summary path estimates the token count of the concatenated HOA descriptions
  ([`estimateTokens()`](src/lib/token-estimate.ts), ~1.3 tokens/word). Within
  the budget (`config.maxUnifiedSummaryInputTokens`, default 96000) a single
  unified call is made, unchanged. Above the budget, sequential windows of
  `config.chronologicalSummaryWindowSize` (default 4) HOAs advance by
  size − `config.chronologicalSummaryWindowOverlap` (default 1, stride 3):
  `[1,2,3,4] → [4,5,6,7] → …`; short remainder windows are allowed. Each
  text-only window call ([`chronological-summary-prompt.md`](src/lib/chronological-summary-prompt.md),
  `chronologicalWindowSchema`) sees the window's HOA descriptions, the
  keywords collected so far, and the last paragraph (style continuity), and
  returns exactly one paragraph per NEW HOA (the leading overlap HOA is
  context only) plus only genuinely new keywords. Accumulation is
  deterministic: paragraphs append in order (overflow beyond the expected
  new-count is dropped from the front), keywords are deduped
  case-insensitively in code with first-seen casing. A failed window degrades
  to its new HOAs' raw descriptions (logged, never aborts). A final unified
  call then consumes the numbered chronological paragraphs plus a
  `Bisher gesammelte Keywords: …` line under the same `unifiedSummarySchema`;
  the final `keywords` are the union of collected window keywords and the
  model's own. Invalid knob values fall back to defaults (logged once).

- **Unified-summary schema contract:** in `unifiedSummarySchema` the ten core
  text fields (`title`, `abstract`, `keywords`, `tags`, `categorization`,
  `short_description`, `long_summary`, `overallIntention`, `narrativeArc`,
  `perceptionArc`) are `.required()`; only the two nested objects
  (`perception_matrix`, `qualityAttributes`) stay lenient. An all-optional
  schema converts to a structured-outputs grammar with `required: []`, which
  permits the empty object-observed in practice: a model returned `{}` in
  ~200 ms, yielding a whole-video summary with no title/keywords/summary and
  zero reported errors. Required fields make the empty object unrepresentable
  in guided mode and fail yup validation (engaging callJson's correction
  retries) in prompt-only modes. Regression coverage:
  [`test/unified-summary-schema.test.ts`](test/unified-summary-schema.test.ts).

- **Deterministic evidence filter:** both unified paths (single call and
  chronological-windowed) pass their result through
  [`filterUnifiedSummaryAgainstEvidence()`](plugins/default.ts) before
  returning. It re-checks the model's evidence judgement instead of trusting
  it: a keyword survives only via a STABLE `# Visuelle Artefakte` table row
  (Temporale Stabilität ≥ 2, mirroring the prompt's sighting rule) or ≥2
  prose sightings (variant misreads fragment to one), a 4-digit year in
  `title`/`short_description` only via such a stable table row. Removals are
  recorded on `result.evidenceFilter` and logged (never silent); long
  free-text fields are not filtered. Motivation: the A1 case (invented
  names/years in title/keywords while long summaries were fine). Tests:
  [`test/evidence-filter.test.ts`](test/evidence-filter.test.ts).

---

## `question-answer.ts`

[`plugins/question-answer.ts`](plugins/question-answer.ts)

**Purpose:** A configurable Q&A pipeline plugin that runs after the `default`
plugin and asks the MLLM a user-defined list of questions about the produced
summary. Each question is typed (boolean / oneOf / manyOf / singleClaim /
categorization), can be analyzed against either the whole-video summary or
per-aggregation summaries with a final conclusion, and is rendered as either a
Markdown table or a JSON block appended to the summary. Only
[`summaryFromAggregations()`](plugins/question-answer.ts) is implemented -
the engine auto-creates aggregations and the plugin relies on the default
plugin's persisted results.

**Key Concerns:**

- **MLLM protocol (3rd-party LLM API):** All questions are answered through
  [`api.mllm.callJson()`](src/rpc/post-processing/plugin-api.ts) with
  `enableThinking: false` and no media files (`filePaths: []`)-this is a
  pure text-in / JSON-out LLM interaction, distinct from the multimodal calls in
  [`default.ts`](plugins/default.ts). The model is resolved identically via
  [`getModel()`](src/lib/archivar-config.ts) using `qaConfig.modelName` /
  `config.modelName` (default [`DEFAULT_MODEL`](plugins/question-answer.ts) =
  `Qwen3.8-27B-FP8`). The endpoint, model id, and API key flow from the same
  central registry.

- **Dynamic prompt + schema generation by question type:** [`generatePrompt()`]
  (plugins/question-answer.ts:61) and [`createSchema()`](plugins/question-answer.ts)
  both switch on `question.type` to emit a type-specific German prompt and a
  matching Yup schema (`boolean` → `{answer, reasoning}`;
  `oneOf`/`manyOf` → constrained enum; `singleClaim` → free-form string;
  `categorization` → string array). This is a small but non-trivial
  type-dispatch algorithm guaranteeing the MLLM's JSON contract is enforced
  regardless of question shape.

- **Two analysis-scope strategies (multi-call algorithm):**
  - [`analyzeWholeSummary()`](plugins/question-answer.ts)-single MLLM call
    against the default plugin's whole-video summary.
  - [`analyzeEveryAggregationThenConclude()`](plugins/question-answer.ts) -
    a two-phase N+1 algorithm: Phase 1 asks the question once per aggregation
    that has a summary; Phase 2 feeds the per-segment answers back to the model
    as a "Zusammenfassung der segmentweisen Antworten" context to synthesize a
    final conclusion. The per-segment results are preserved in
    `ProcessedQuestion.perAggregation` for downstream traceability.

- **Auto-regressive answer aggregation:** When a question sets
  `enableAutoRegressiveAnswerAggregation`, its validated Q&A pair is formatted
  via [`formatQAForContext()`](plugins/question-answer.ts) and accumulated
  into `regressiveContext`. Subsequent questions receive
  `summaryText + "\n\n---\nBisherige Fragen und Antworten:\n" + regressiveContext`
  as their prompt context, enabling chain-of-thought style enrichment across the
  configured question list. This is a sequential, stateful loop in
  [`summaryFromAggregations()`](plugins/question-answer.ts).

- **Cross-plugin data dependency (cache-aware read):** The plugin reads the
  `default` plugin's already-computed results from
  `input.analysisResult.postProcessing["default"]` (see
  [`DEFAULT_PLUGIN_NAME`](plugins/question-answer.ts)). It expects both a
  `summary` and an `aggregations` array to be present from the prior plugin run;
  if either is missing the plugin warns and returns `null` without making any
  MLLM calls. This is the architectural hand-off point between the two plugins
  and is governed purely by plugin execution order, not by an explicit contract
  check.

- **Result rendering & summary mutation:** Based on `question.rendering`
  (default [`DEFAULT_RENDERING`](plugins/question-answer.ts) = `"none"`) and
  `question.resultFormat` (default [`DEFAULT_RESULT_FORMAT`](plugins/question-answer.ts)
  = `"json"`), results are either:
  - appended to the summary's `long_summary` text as Markdown tables (via
    [`formatAsMarkdown()`](plugins/question-answer.ts), which itself
    type-dispatches on `question.type`), or
  - appended as fenced JSON code blocks, or
  - stored only in the structured `question_answer_results` field.
  The final return value is a mutated copy of the default plugin's summary
  object-preserving all original fields and adding `question_answer_results`.

- **No environment-driven path decisions:** Unlike [`default.ts`](plugins/default.ts),
  this plugin performs no filesystem lookups and constructs no paths. All media
  paths are absent (text-only LLM calls). The only configuration knobs are the
  model name and the `questions` array.

- **Error isolation:** [`askQuestion()`](plugins/question-answer.ts) returns
  `{ result, error }` instead of throwing, so a single failed question is
  recorded as `{ _error }` in `structuredResults` without aborting the remaining
  questions or the summary mutation.
