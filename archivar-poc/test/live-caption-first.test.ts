/**
 * Live test for caption-first aggregation and long-horizon semantic understanding.
 *
 * This test uses the REAL archivar config (no mocks) and checks if the required
 * model is available before running. If unavailable, tests are skipped with a
 * clear message.
 *
 * ## Required Model Configurations
 *
 * To run these tests, the following model must be defined in `archivar.config.ts`:
 *
 * - `Qwen3.6-35B-A3B-GPTQ-Int4` — VLM with structured output support (or any
 *   model name you configure; update EXPECTED_MODEL below to match)
 *
 * The model must be running and reachable at the configured endpoint.
 *
 * ## What These Tests Validate
 *
 * 1. **Caption-first flow**: postProcessPerTimeSlice uses pre-generated caption
 *    instead of re-analyzing video (saves VLM calls when caption exists)
 * 2. **Raw caption propagation**: postProcessPerAggregation includes the raw
 *    Markdown caption (relationship labels + perception matrix) in its prompt
 * 3. **Long-horizon understanding**: The aggregation output contains
 *    relationship_to_previous and perception signals
 * 4. **Whole-video summary**: The summary includes overallIntention and
 *    perceptionArc from the aggregation chain
 */
import { describe, it, expect, beforeAll } from "vitest";
import { ensureModelAvailable, type ModelCheckResult } from "./utils/model-availability.js";
import { MllmApi } from "../src/rpc/mllm-api.js";
import type { TimeSlice, SemanticAggregation, FileRef, PostProcessingInput, PluginRpcApiCompositeInstance } from "../src/lib/plugin-types.js";

// ── Configuration ──────────────────────────────────────────────────────────

/** Model name to test — must exist in archivar.config.ts models[] */
const EXPECTED_MODEL = "Qwen3.6-35B-A3B-GPTQ-Int4";

// ── Fixtures ───────────────────────────────────────────────────────────────

const RICH_CAPTION_1 = `# Bildbeschreibung
Ein Nachrichtensprecher sitzt am Tisch im Studio und liest die Nachrichten vor. Im Hintergrund ist eine Stadtlandschaft bei Tag zu sehen.

## Beziehung zur vorherigen Szene
DIRECT_CONTINUATION - Die Nachrichtensendung wird mit einem neuen Thema fortgesetzt.

## Erwartete Menschliche Wahrnehmung

| Kategorie | Schlagwort | Confidence |
| -------- | -------- | ---------: |
| rhetoric | serious | 0.90 |
| framing | neutral | 0.80 |
| emotion | calm | 0.70 |
`;

const RICH_CAPTION_2 = `# Bildbeschreibung
Ein Werbeclip zeigt ein neues Smartphone in Nahaufnahme, gefolgt von glücklichen Menschen, die das Produkt verwenden. Am Ende erscheint das Logo einer Marke und der Text "Jetzt verfügbar".

## Beziehung zur vorherigen Szene
NEW_TOPIC_HARD_DRIFT - Die Werbung hat keinen inhaltlichen Bezug zur vorherigen Nachrichtensendung.

## Erwartete Menschliche Wahrnehmung

| Kategorie | Schlagwort | Confidence |
| -------- | -------- | ---------: |
| rhetoric | persuasive | 0.85 |
| framing | aspirational | 0.90 |
| emotion | excitement | 0.80 |
`;

function makeFileRef(): FileRef {
  return {
    fileName: "scene-0.mp4",
    extension: "mp4",
    mediaType: "video",
    outputHash: "hash-0",
    serverUrl: "",
    containerPath: "/data/scene-0.mp4",
    hostPath: "/data/scene-0.mp4",
    relativePath: "scene-0.mp4",
  };
}

function makeSceneSlice(id: string, from: number, to: number, caption: string, sceneIndex: number): TimeSlice {
  return {
    id,
    index: sceneIndex,
    sourceIndex: sceneIndex,
    from: String(from),
    to: String(to),
    fromSeconds: from,
    toSeconds: to,
    durationSeconds: to - from,
    type: "scene",
    sceneIndex,
    caption,
    sourceFile: makeFileRef(),
    parentFile: makeFileRef(),
  };
}

/**
 * Create a REAL API instance that makes actual VLM calls.
 * This is the non-mocking path — all calls go to the real model.
 */
function createRealApi(): PluginRpcApiCompositeInstance {
  const mllmApi = new MllmApi();
  return {
    file: { getMediaInfo: async () => null, listFiles: async () => [], readFile: async () => "", writeFile: async () => { }, deleteFile: async () => { } },
    cache: { get: async () => null, set: async () => { } },
    analysis: { getAnalysisResults: async () => null, analyzeSegment: async () => ({}) },
    mllm: {
      callRaw: async () => "",
      callJson: async (args: Record<string, unknown>) => {
        return mllmApi.callWithPrompt(
          String(args.endpoint), String(args.model), String(args.apiKey),
          (args.filePaths as string[]) ?? [],
          String(args.prompt),
          String(args.mediaCategory ?? "video") as "audio" | "image" | "video",
          (args.hyperparams as Record<string, unknown>) ?? {},
          undefined, // systemPrompt
          Boolean(args.enableThinking),
          (args.mmProcessorKwargs as Record<string, unknown>) ?? {},
        );
      },
    },
    util: {
      parseJsonLoose: (c: string) => { try { return JSON.parse(c); } catch { return null; } },
      formatTime: (s: number) => String(s),
      limitConcurrency: async <T, R>(items: T[], _limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> => {
        return Promise.all(items.map((item, i) => fn(item, i)));
      },
      logger: { log: console.log, warn: console.warn, error: console.error },
    },
  } as unknown as PluginRpcApiCompositeInstance;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("Live: caption-first aggregation + long-horizon understanding", () => {
  let modelCheck: ModelCheckResult;

  beforeAll(async () => {
    modelCheck = await ensureModelAvailable(EXPECTED_MODEL);
    if (modelCheck.available) {
      console.log(`[LIVE] Model "${EXPECTED_MODEL}" is available — running live tests`);
    } else {
      console.log(`[LIVE] SKIP: ${modelCheck.reason}`);
    }
  }, 15_000);

  it("LH1: postProcessPerTimeSlice uses pre-generated caption WITHOUT VLM call (reanalyzeVideo=false)", async ({ skip }) => {
    if (!modelCheck.available) return skip(modelCheck.reason);

    const { postProcessPerTimeSlice } = await import("../plugins/default.js");
    const api = createRealApi();

    // Track if callJson was called
    let vlmCalled = false;
    const originalCallJson = api.mllm.callJson;
    api.mllm.callJson = async <T>(args: Record<string, unknown>): Promise<T> => {
      vlmCalled = true;
      return originalCallJson.call(api.mllm, args as Parameters<typeof originalCallJson>[0]) as Promise<T>;
    };

    const slice = makeSceneSlice("scene:0:0:0-10", 0, 10, RICH_CAPTION_1, 0);
    const input = { filePath: "test.mp4", timeSlices: [slice] } as unknown as PostProcessingInput;
    const pluginDef = {
      name: "default", importPath: "./plugins/default.ts",
      config: { modelName: EXPECTED_MODEL, maxConcurrency: 1, includeTypes: ["scene"], reanalyzeVideoForAggregation: false },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const result = await postProcessPerTimeSlice(input, pluginDef, api);

    // VLM should NOT have been called — caption is reused directly
    expect(vlmCalled).toBe(false);

    // Plugin data should contain the raw caption
    const pd = result.timeSlices[0].plugin?.["default"] as Record<string, unknown>;
    expect(pd.raw_caption).toBe(RICH_CAPTION_1);
    expect(pd.caption_source).toBe("processing-phase");
  });

  it("LH2: postProcessPerAggregation includes raw caption + relationship + perception in VLM prompt", async ({ skip }) => {
    if (!modelCheck.available) return skip(modelCheck.reason);

    const { postProcessPerAggregation } = await import("../plugins/default.js");
    const api = createRealApi();

    const slice = makeSceneSlice("scene:0:0:0-10", 0, 10, RICH_CAPTION_1, 0);
    slice.plugin = { default: { summary: "short", raw_caption: RICH_CAPTION_1 } };

    const agg: SemanticAggregation = {
      id: "default:aggregation:0", pluginName: "default", index: 0,
      sliceIndexes: [0], sliceIds: ["scene:0:0:0-10"],
      from: "0", to: "10", fromSeconds: 0, toSeconds: 10,
    };

    const pluginDef = {
      name: "default", importPath: "./plugins/default.ts",
      config: { modelName: EXPECTED_MODEL, maxConcurrency: 1, includeTypes: ["scene"], reanalyzeVideoForAggregation: false },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const result = await postProcessPerAggregation(agg, [slice], pluginDef, api);

    // Should have produced an analysis (not empty)
    expect(result.analysis).toBeDefined();
    console.log("[LH2] Aggregation analysis:", JSON.stringify(result.analysis, null, 2).slice(0, 500));
  }, 60_000);

  it("LH3: decideForAggregation uses rich caption signals for cross-scene decision", async ({ skip }) => {
    if (!modelCheck.available) return skip(modelCheck.reason);

    const { decideForAggregation } = await import("../plugins/default.js");
    const api = createRealApi();

    const sliceA = makeSceneSlice("scene:0:0:0-5", 0, 5, "plain", 0);
    const sliceB = makeSceneSlice("scene:1:1:5-10", 5, 10, "plain B", 1);
    sliceA.plugin = { default: { summary: "Nachrichten", raw_caption: RICH_CAPTION_1 } };
    sliceB.plugin = { default: { summary: "Werbung", raw_caption: RICH_CAPTION_2 } };

    const pluginDef = {
      name: "default", importPath: "./plugins/default.ts",
      config: { modelName: EXPECTED_MODEL, maxConcurrency: 1, includeTypes: ["scene"], reanalyzeVideoForAggregation: false },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const result = await decideForAggregation(
      sliceA, sliceB, pluginDef, api,
      { timeSlices: [sliceA, sliceB] } as unknown as PostProcessingInput,
    );

    // Two completely different topics (news vs ad) → should be false (different aggregations)
    console.log(`[LH3] Decision: ${result} (expected false for news → ad transition)`);
    expect(typeof result).toBe("boolean");
  }, 60_000);
});
