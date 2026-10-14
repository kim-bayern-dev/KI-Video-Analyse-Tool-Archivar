# Test Suite Architecture

This document describes the architectural role of each test file in the `test/` directory.

---

## Live-test gating philosophy

Live tests (real LLM inference, real HTTP against the dev server) **run by
default**. The only legitimate skip reasons are:

1. **The required model is unhealthy**-the real per-model inference probe
   failed in this run, or
2. **The test is not applicable anymore** (e.g. it targets a feature or model
   that no longer exists in `archivar.config.ts`).

There are no opt-in env gates (`E2E_LLM_RUN` is gone). The global opt-out for
fast local runs is `SKIP_LIVE_TESTS=1`.

**Infrastructure:**

- [`test/utils/global-health-setup.ts`](test/utils/global-health-setup.ts) -
  vitest `globalSetup` (registered in [`vitest.config.ts`](vitest.config.ts)).
  Loads `.env.local` + the real `archivar.config.ts` and runs
  [`runModelHealthChecks()`](src/lib/model-health.ts) once per `vitest run`
  (~10-20s, real inference per configured model, parallel), writing
  `node_modules/.cache/archivar-health.json` (outside Vite's watched tree, so
  the write can't invalidate the dev server's module runner mid-request).
- [`test/utils/live-models.ts`](test/utils/live-models.ts)-the gate API:
  `getHealthReport()` (reads the cache; runs inline if missing),
  `isModelHealthy(name)`, `skipIfModelUnhealthy(name)` (returns a skip reason
  or null), `isServerUp()` (dev-server reachability).
- [`test/utils/model-availability.ts`](test/utils/model-availability.ts) -
  `ensureModelAvailable(name)` rebuilt on the shared health report (no more
  per-model pings; same public signature for existing suites).

---

## `webhook-api.test.ts`

[`test/webhook-api.test.ts`](test/webhook-api.test.ts)

**Purpose:** `WebhookApi.deliverWebhook` end-to-end without mocks: a real local
`node:http` receiver plus a real temp data dir (`RELATIVE_SAMPLE_DATA_PATH`
redirect), covering payload delivery (`{ file, status, result }`), the
conditional `exports` map (present only when export files exist on disk), and
`webhook.json` deletion after successful delivery.

---

## `cross-plugin-access.test.ts`

[`test/cross-plugin-access.test.ts`](test/cross-plugin-access.test.ts)

**Purpose:** Unit tests that validate the V3 post-processing plugin contract-specifically, that a later-ordered plugin (e.g. plugin B at `order: 1`) can read the per-slice analysis, aggregations, and summary produced by an earlier plugin (e.g. the `default` plugin at `order: 0`) through the shared [`PostProcessingInputV3`](src/lib/plugin-types.ts) parameter. These tests run entirely in-process with mocked dependencies (no live server, no LLM, no filesystem I/O).

**Key Concerns:**

- **Mocked cache & LLM surfaces:** Every test constructs a stub [`PluginApi`](src/lib/plugin-types.ts) via [`createMockApi()`](test/cross-plugin-access.test.ts) that provides no-op `vi.fn()` implementations of `cache.get`, `cache.set`, `mllm.callRaw`, `mllm.callJson`, and `analysis.*`. This isolates the cross-plugin data-flow contract from the real cache and 3rd-party API protocols, so the test is deterministic and side-effect-free.
- **Simulated sequential plugin execution:** [`createInputWithDefaultResults()`](test/cross-plugin-access.test.ts) builds a [`PostProcessingInputV3`](test/cross-plugin-access.test.ts) whose `analysisResult.postProcessing["default"]` field contains a fully-populated [`PluginRunResultV3`](src/lib/plugin-types.ts)-mirroring the shape of the state that the workflow engine would present to plugin B after the `default` plugin has already executed. The "simulated sequential execution" test block then manually invokes each hook of plugin B in the order the real engine would, asserting that every hook can read plugin A's slices, aggregations, and summary from `input`.
- **Backward-compatibility contract for hook signatures:** A dedicated `describe` block verifies that legacy 4-argument hooks (which do not declare the optional `input` parameter) still execute without error when the engine passes the 5th `input` argument. This is the regression guard for the API expansion that added `input?` to [`decideForAggregation`](src/lib/plugin-types.ts), [`postProcessPerAggregation`](src/lib/plugin-types.ts), and other hooks.
- **Aggregation overlap algorithm:** The `postProcessPerAggregation` tests embed an interval-overlap predicate (`a.fromSeconds <= aggregation.toSeconds && a.toSeconds >= aggregation.fromSeconds`) used to locate the prior plugin's aggregation whose time span intersects the current plugin's own aggregation. This is the same spatial-join logic the production aggregators rely on.
- **No environment-variable-driven paths, no real cache mutations, no network calls.** The entire file is hermetic.

---

## `pipeline.test.ts`

[`test/pipeline.test.ts`](test/pipeline.test.ts)

**Purpose:** End-to-end integration test that exercises the *complete* default-analysis pipeline-pre-processing, processing, and post-processing-against a live running Archivar server instance. It copies a small video fixture into the server's data directory, invokes the full workflow via RPC, and asserts on the structural shape of the produced analysis result, the file listing, and the debug artifacts.

**Key Concerns:**

- **Environment-variable-driven path & endpoint decisions:** Both the server endpoint and the API key are resolved at module load time from `process.env`, with hard-coded local-development fallbacks:
  - `SERVER_URL` (default `http://localhost:8802`, the container)
  - `API_KEY` (default `your-api-key`)
  These drive every [`rpcCall()`](test/pipeline.test.ts) invocation. The data directory is a *relative* path (`../sample_data/archivar`) resolved against the test file's own location, while the source fixture is resolved via `__dirname` derived from `import.meta.url`-meaning the test's behavior is coupled to the working-directory layout of the host that runs it.
- **DSON RPC protocol (3rd-party / custom API surface):** All server communication goes through [`rpcCall()`](test/pipeline.test.ts), which encodes the request body with `DSON.stringify` and decodes the response with `DSON.parse` (from the `defuss-dson` package). This is the wire protocol the test asserts the server speaks-a non-standard, non-JSON-shaped envelope around `{ className, methodName, args }`. Requests are authenticated via an `x-api-key` header and carry a 10-minute `AbortSignal.timeout` to tolerate the full multimodal-LLM pipeline latency.
- **Cache management-explicit invalidation as a precondition:** The first step of the single test case calls `CacheApi.clear(["scene"])` before running the workflow. This forces the scene-detection / captioning stage to re-run from scratch instead of returning a cached result, making the test sensitive to actual pipeline output rather than a previously cached artifact. This is the only direct cache interaction in the file; all other cache behavior is implicit inside the server.
- **Fixture lifecycle & filesystem side effects:** The `beforeAll` hook copies the shared `../sample_data/test/demo.mp4` into the server's data directory only if the destination does not already exist; the `afterAll` hook removes the copy only when this run made it (never the shared corpus file). This gives the test self-contained input provisioning but assumes write access to the relative data directory.
- **End-to-end output assertions:** The test parses the workflow result string (returned in `json` format), validates scene count and caption coverage, inspects the `pluginResults` array for a `default` plugin entry at `version === 3` with non-empty `aggregations`, optionally checks for a `summary`, verifies the file appears in `FileApi.listFiles`, and reads back both `debug.json` and `debug.log` artifacts from the `.archivar` sidecar directory-confirming that the workflow engine persisted both the structured debug document and the `[STEP`-prefixed step log.
- **High latency / long timeout:** The single `it` block declares an explicit `600_000` ms (10 min) timeout, reflecting the real cost of running the full multimodal-LLM pipeline. This test is therefore not suitable for inclusion in a fast unit-test gate.

---

## `speech-scene-assignment.test.ts`

[`test/speech-scene-assignment.test.ts`](test/speech-scene-assignment.test.ts)

**Purpose:** Unit + engine-level tests for speech-to-scene assignment. Covers the pure helpers in [`src/lib/scene-assignment.ts`](src/lib/scene-assignment.ts)-largest-overlap-wins (vs. the old first-overlap behavior), the gap-capped nearest-scene fallback, boundary gaps (segment before the first / after the last scene), and 0/1-scene edge cases-plus a regression test reproducing the production anomaly (a 0.5s scene plus long speech segments spanning many scenes) against the real private `WorkflowEngine.aggregateResults` (bracket-notation cast, same pattern as [`test/aggregation-constraints-engine.test.ts`](test/aggregation-constraints-engine.test.ts)). Asserts that spanning speech lands on the dominant-overlap scene, that segments beyond `MAX_SCENE_ASSIGNMENT_GAP_SEC` stay unassigned, and that [`buildPostProcessingInput()`](src/rpc/workflow-engine.ts) emits them as `sceneIndex: -1` slices instead of dropping them. Fully hermetic: no network, no env, no filesystem.

---

## `mm-processor-kwargs.test.ts`

[`test/mm-processor-kwargs.test.ts`](test/mm-processor-kwargs.test.ts)

**Purpose:** Pure unit tests for the two functions that assemble inference-side `mm_processor_kwargs` (fps, do_sample_frames) from the archivar config: [`buildInferenceMmProcessorKwargs()`](src/lib/archivar-config.ts) (the 3-source merge: model < step < segmentScenes) and [`resolveMmProcessorKwargs()`](src/rpc/mllm-api.ts) (vLLM default+override merge). No network, no I/O, fully hermetic.

---

## `mm-processor-kwargs-integration.test.ts`

[`test/mm-processor-kwargs-integration.test.ts`](test/mm-processor-kwargs-integration.test.ts)

**Purpose:** Integration test that mocks [`longFetch`](src/lib/long-fetch.ts) and inspects the actual JSON request body that [`MllmApi.callWithPrompt()`](src/rpc/mllm-api.ts) and [`callWithPromptRaw()`](src/rpc/mllm-api.ts) send to vLLM's `/v1/chat/completions`. Verifies that config-driven `mm_processor_kwargs` overrides (fps, do_sample_frames) propagate all the way into the HTTP request body, and that the hardcoded defaults are preserved when no override is passed.

**Key Concerns:**

- **Mocked network surface:** `vi.mock("../src/lib/long-fetch.js")` replaces the real `longFetch` with a `vi.fn()` that captures `init.body`, parses it as JSON, and returns a canned `OpenAIChatResponse`. This isolates the test from any real vLLM instance.
- **Request body inspection:** `lastRequestBody` captures the parsed JSON body. Each test asserts on the `mm_processor_kwargs` field to confirm the exact kwargs vLLM would receive.
- **No environment dependencies, no I/O.** The test is fully deterministic and runs in milliseconds.

---

## `aggregation-transitions.test.ts`

[`test/aggregation-transitions.test.ts`](test/aggregation-transitions.test.ts)

**Purpose:** Unit + engine-level tests for the aggregation transition pass (WS2). Plugin level: drives the real [`enrichAggregationTransitions()`](plugins/default.ts) with a hand-built mock `PluginRpcApiCompositeInstance` (`vi.fn()` `mllm.callJson`, `util.limitConcurrency` executing workers) and asserts the N−1 pair-call count, that `relationship_to_previous` is overwritten and `transition_description` written into `agg[i].analysis` while `agg[0]` stays untouched, the `enrichTransitions: false` opt-out, graceful degradation when one pair's call rejects, and the `Übergang von vorheriger:` line in `aggregationToText()`. Engine level: drives the private `WorkflowEngine.runPostProcessingPlugins` (bracket-notation cast, same pattern as [`test/aggregation-constraints-engine.test.ts`](test/aggregation-constraints-engine.test.ts)) with a fake plugin module recording hook call order-asserting the chain runs `extractSemanticProfiles` → `enrichAggregationTransitions` → `postProcessHigherOrderAggregations`, that the optional hook is skipped when absent, that a throwing hook is recorded as an error without aborting the chain, and that the parallel per-aggregation loop applies results in index order under bounded concurrency (peak in-flight == `maxConcurrency`) with one aggregation's failure not killing the others. Fully hermetic: `getModel` mocked via `vi.mock("../src/lib/archivar-config.js")`, no network, no filesystem.

---

## `aggregated-cache-key.test.ts`

[`test/aggregated-cache-key.test.ts`](test/aggregated-cache-key.test.ts)

**Purpose:** Unit tests for WS4 cache self-invalidation via the real [`resolveAggregatedCacheKey()`](src/rpc/workflow-engine.ts) helper. Uses tiny fixture plugin modules ([`test/fixtures/fake-plugin-versioned.ts`](test/fixtures/fake-plugin-versioned.ts), [`fake-plugin-versioned-bumped.ts`](test/fixtures/fake-plugin-versioned-bumped.ts), [`fake-plugin-unversioned.ts`](test/fixtures/fake-plugin-unversioned.ts)) to assert: the key format `${workflowName}-${outputHash}-${versions}`; a missing `POST_PROCESSING_CACHE_VERSION` export falls back to `"1"`; a version bump produces a different key (self-invalidation); versions of multiple enabled plugins are joined while disabled plugins are skipped; no plugins → `"1"`; an unloadable module degrades to `"1"` instead of throwing. A second block covers the WS4 CSR follow-up: [`findAggregatedCacheKey()`](src/lib/aggregated-cache-key.ts) prefix matching (versioned key by prefix, legacy exact key, versioned preferred over legacy, no cross-workflow/cross-hash matches). Fully hermetic.

---

## `chronological-summary.test.ts`

[`test/chronological-summary.test.ts`](test/chronological-summary.test.ts)

**Purpose:** Unit tests for WS3 sliding-window chronological summarization in the real [`summaryFromAggregations()`](plugins/default.ts). Uses a hand-built mock `PluginRpcApiCompositeInstance` with a scriptable `mllm.callJson` (window calls identified by the chronological template marker, scripted per-window responses including a rejecting window; `getModel` mocked via `vi.mock("../src/lib/archivar-config.js")`, same pattern as [`test/visual-artifacts-higher-order.test.ts`](test/visual-artifacts-higher-order.test.ts)). Covers: budget gate (below budget → exactly one unified call with raw HOA descriptions; 0 HOAs → `null`; 1 HOA → single call); window partition for 10 HOAs (`[1-4] [4-7] [7-10]` + final call) and the 11-HOA remainder window (`[10,11]`, one new HOA); expected-new-counts (`EXAKT 4` first window, `EXAKT 3` later); keyword carry-over with case-insensitive dedup and the final-union merge (collected + model's own); paragraph overflow dropped from the front; window failure degrading to raw descriptions of the new HOAs only; the final prompt containing the numbered chronological paragraphs plus the `Bisher gesammelte Keywords:` line and not the raw HOA dump; previous-paragraph style continuity. Fully hermetic.

---

## `slice-completeness.test.ts`

[`test/slice-completeness.test.ts`](test/slice-completeness.test.ts)

**Purpose:** Unit tests for WS5 completeness invariant via the pure [`findCompletenessViolations()`](src/lib/slice-completeness.ts) over synthetic [`TimeSlice`](src/lib/plugin-types.ts) fixtures. Covers: each rule fires (scene ≥ 1s uncaptioned, scene < 1s uncaptioned without keyframe fallback, speech without transcript); each rule is silent when satisfied; the keyframe fallback only counts for the same `sceneIndex`; noise/harmonic/keyframe/silence slices are exempt; `sceneIndex: -1` scene slices still count; multiple violations are collected together. Fully hermetic: no network, no env, no filesystem.

---

## `caption-index.test.ts`

[`test/caption-index.test.ts`](test/caption-index.test.ts)

**Purpose:** Regression tests for the keyframe caption misalignment in the `enabledAsFallback` path, via the pure [`remapProcessedCaptions()`](src/lib/caption-index.ts). Covers: identity fast-path, prefix-skip shift (the exact production case), holes in the middle, stray items, and failed-segment positions without captions. Fully hermetic.

---

## `text-degeneration.test.ts`

[`test/text-degeneration.test.ts`](test/text-degeneration.test.ts)

**Purpose:** Unit tests for the caption-degeneration guard ([`src/lib/text-degeneration.ts`](src/lib/text-degeneration.ts)). Covers: German captions with typographic punctuation are clean, latin diacritics clean, CJK/emoji/box-drawing counted as atypical, threshold semantics (default 3), empty/ASCII input. Fully hermetic.

---

## `output-cleanup.test.ts`

[`test/output-cleanup.test.ts`](test/output-cleanup.test.ts)

**Purpose:** Tests for [`removeDirectoryRobust()`](src/lib/output-cleanup.ts): fs-removal of a writable tree, idempotent success on nonexistent paths. The docker escalation path is verified manually on the dev host (requires the docker group), not in unit tests. Hermetic (uses OS temp dirs).

---

## `e2e-response-format-live.test.ts`

[`test/e2e-response-format-live.test.ts`](test/e2e-response-format-live.test.ts)

**Purpose:** Live e2e test that proves the FULL JSON response body returned by each backend protocol and, in particular, whether token metadata (`usage`) is present. It exists to ground the claim that [`OpenAIChatResponse`](src/rpc/mllm-api.ts) declares a `usage` block that every [`MllmApi`](src/rpc/mllm-api.ts) consumer discards (a codebase-wide search for `.usage | prompt_tokens` returns only the type declaration)-and to document which protocols could supply real token counts instead of the heuristic estimates in [`token-estimate.ts`](src/lib/token-estimate.ts).

**Coverage (4 tests), each gating on [`skipIfModelUnhealthy`](test/utils/live-models.ts):**

- **VLM chat-completions**-a minimal text-only `POST /v1/chat/completions` against `E2E_VLM_MODEL` (default `Qwen3.8-27B-FP8`); asserts `choices[0].message.content` is a string AND that `usage.prompt_tokens / completion_tokens / total_tokens` are numbers.
- **ASR openai-chat**-`POST /v1/chat/completions` with an `audio_url` `file://` ref (host→`/sample_data` path conversion mirrored from [`model-health.ts`](src/lib/model-health.ts)) against `E2E_ASR_CHAT_MODEL` (default `qwen-asr-0.6b`); reads the transcript from `message.content ?? message.reasoning` (Qwen3-ASR puts it in `reasoning`) and asserts `usage` numeric fields are present.
- **ASR openai-transcriptions**-multipart `POST /v1/audio/transcriptions` (global `fetch`; `longFetch`'s undici Agent drops form parts) against `E2E_ASR_TRANSCRIPTIONS_MODEL` (default `parakeet-primeline-de`); asserts the body is exactly `{ text }` and that `usage` is `undefined`.
- **Archivar layer surfacing**-drives [`MllmApi.callWithPromptRaw`](src/rpc/mllm-api.ts) with an empty `urls` text-only call and asserts it returns `{ content, usage }` with numeric `prompt_tokens`/`completion_tokens`/`total_tokens`-the regression guard that token metadata is now surfaced through the transport API (previously discarded).

**Key Concerns:**

- **Live by default, health-gated.** Each test resolves its target via `getModel` (+ `E2E_LLM_ENDPOINT`/`E2E_LLM_API_KEY` overrides) and skips when the model is unhealthy or `SKIP_LIVE_TESTS=1`. Test-data dirs mirror the constants in [`model-health.ts`](src/lib/model-health.ts) (`E2E_TEST_DATA_HOST`, `E2E_TEST_DATA_CONTAINER`); the ASR tests additionally skip when the `test.mp3` clip is absent.
- **Body capture for reasoning.** Every probe `console.log`s the FULL parsed body (`[e2e:vlm]`/`[e2e:asr-chat]`/`[e2e:asr-transcriptions] FULL BODY: …`) so the exact per-protocol shape (including vendor extras like `prompt_tokens_details`, `metrics`, `routed_experts`) is visible in the run output.

**Verified findings (live):** chat-completions backends (VLM and ASR vLLM servers) return `usage`; the `openai-transcriptions` protocol returns only `{ text }` with no token metadata. Re-run: `pnpm exec vitest run test/e2e-response-format-live.test.ts`.

---

## `token-usage-collector.test.ts`

[`test/token-usage-collector.test.ts`](test/token-usage-collector.test.ts)

**Purpose:** Unit + live tests for the per-run token-usage accumulator ([`src/lib/token-usage-collector.ts`](src/lib/token-usage-collector.ts)) that backs `AnalysisResult.tokenUsage`. Unit: `TokenUsageAccumulator.add` sums prompt/completion/total, ignores `undefined` usage (transcriptions protocol), guards non-numeric/partial fields, and falls back to `input+output` when `total_tokens` is missing; `recordTokenUsage` is a no-op outside a `tokenUsageCapture` scope and accumulates inside one. Live (health-gated on `E2E_VLM_MODEL`): `MllmApi.callWithPromptRaw` run inside a `tokenUsageCapture.run(...)` feeds the accumulator-asserts `summary.input/output > 0` and `summary.total === result.usage.total_tokens`, proving the mllm-api → `recordTokenUsage` → ALS wiring end-to-end.

---

## `non-fatal-error-collector.test.ts`

[`test/non-fatal-error-collector.test.ts`](test/non-fatal-error-collector.test.ts)

**Purpose:** Unit + integration tests for the per-run non-fatal-error accumulator + classifier ([`src/lib/non-fatal-error-collector.ts`](src/lib/non-fatal-error-collector.ts)) that backs `AnalysisResult.nonFatalErrors`. Covers: `classifyNonFatalReason` maps the typed errors (`TruncatedStructuredOutputError`→context, `JsonSchemaUnsupportedError`→transport, `UnsupportedYupNodeError`/yup `ValidationError`→schema) + obvious message patterns (context-length, transport fields, validation/parse, timeout/ECONNREFUSED) and falls back to `unknown`; `primaryMessage` caps + strips the stack; `NonFatalErrorAccumulator.add`/`summarize`; `recordNonFatalError` is a no-op outside a `nonFatalErrorCapture` scope and accumulates inside one; `nonFatalReasonBreakdown` ordering. Integration: a `callJson` schema-retry records exactly one `schema` non-fatal entry (with the model name) before succeeding-proving the callJson-retry → `recordNonFatalError` → ALS wiring.

---

## `list-files-summary.test.ts`

[`test/list-files-summary.test.ts`](test/list-files-summary.test.ts)

**Purpose:** Verifies the lightweight listing ([`FileApi.listFilesSummary`](src/rpc/file-api.ts)) against the real data dir: same file set as `listFiles` (by fileName, no dupes/missing), carries only selection fields with NO segment arrays leaking (`scenes`/`speech`/`keyframes` all undefined), matches `listFiles` on the shared summary fields (mediaType/extension/outputHash), and the payload is dramatically smaller. On this data dir the full list is ~65MB vs the summary ~38KB (1718× smaller), asserted as `< full/10` and `< 200KB`.

---

## `image-keyframe.test.ts`

[`test/image-keyframe.test.ts`](test/image-keyframe.test.ts)

**Purpose:** Hermetic unit tests for the single-image keyframe helpers ([`src/lib/image-keyframe.ts`](src/lib/image-keyframe.ts)). Fixtures are generated with sharp into a tmp dir: JPEG→PNG conversion (parent dirs created), shrink-only resize into the `maxWidthPx`/`maxHeightPx` box with aspect preserved (2000×1000 → 608×304 at 608×448 max), no enlargement of smaller images (`withoutEnlargement`, generated 382×377 solid), EXIF orientation baked into pixels with metadata stripped, no resize when no max is given, actionable failure on non-image input, and `computeImageKeyframeHash` determinism + content/dimension sensitivity.

---

## `analysis-defaults-image.test.ts`

[`test/analysis-defaults-image.test.ts`](test/analysis-defaults-image.test.ts)

**Purpose:** Hermetic unit tests for the per-file media-type gating in [`AnalyseApi.getAllAnalysisDefaults()`](src/rpc/analyse-api.ts) (the upload wizard's step-3 data source). Uses `setArchivarConfig` with a minimal scene+keyframe+speech workflow whose keyframe step is default-disabled (mirroring the shipped workflows), plus a variant with an explicitly enabled keyframe step. Asserts: for a `.png` the keyframe step is `enabled: true, compatible: true` (image exception-keyframe analysis IS image analysis) with the VLM in `availableModels` while scene/speech are incompatible and disabled; for `.mp3` keyframe stays disabled+incompatible; for `.mp4` scene/speech stay enabled while the default-disabled keyframe step arrives `enabled: false` but `compatible: true` (opt-in via wizard checkbox); an explicitly enabled keyframe step stays enabled for `.mp4`.

---

## `enabled-processing-steps.test.ts`

[`test/enabled-processing-steps.test.ts`](test/enabled-processing-steps.test.ts)

**Purpose:** Hermetic unit tests for [`resolveEnabledProcessingSteps()`](src/rpc/workflow-engine.ts), the engine's STEP-5 processing-step gate. Asserts: a default-disabled keyframe step is dropped for video/audio input but kept for single-image input (an image is its own keyframe), an explicitly enabled keyframe step runs for video, and non-keyframe disabled steps stay dropped even for images.
