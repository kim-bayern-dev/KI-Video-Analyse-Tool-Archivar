/**
 * Tests for caption-first aggregation flow.
 *
 * These tests verify the ACTUAL logic of the default plugin functions — not just
 * that "the mock was called". The mock API captures the exact prompt that would be
 * sent to the VLM so we can assert on its CONTENT (relationship labels, perception
 * matrix, raw caption are present), which is what matters for long-horizon understanding.
 *
 * Three behaviors tested:
 * 1. postProcessPerTimeSlice uses existing caption (no VLM call) when reanalyzeVideo=false
 * 2. postProcessPerAggregation includes raw caption + relationship + perception in prompt
 * 3. decideForAggregation prefers rich caption with relationship signals over generic summary
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PostProcessingInput, TimeSlice, SemanticAggregation, PluginRpcApiCompositeInstance, FileRef } from "../src/lib/plugin-types.js";

// Mock archivar-config — only getModel is needed, the rest of default.ts runs real
vi.mock("../src/lib/archivar-config.js", () => ({
  getModel: () => ({
    resolvedEndpoint: "http://mock",
    resolvedModel: "mock-model",
    resolvedApiKey: "mock-key",
    jsonSchemaMode: "auto",
    jsonSchemaName: undefined,
    structuredOutput: { maxTokens: 1000, temperature: 0.8, maxRetries: 2 },
    hyperparams: {},
    parallelism: 4,
    mmProcessorKwargs: {},
    maxContextTokens: 32768,
  }),
}));

// Import AFTER vi.mock is registered so getModel is stubbed
const { postProcessPerTimeSlice, postProcessPerAggregation, decideForAggregation } = await import("../plugins/default.js");

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Rich Markdown caption with all three sections (caption, relationship, perception) */
const RICH_CAPTION = `## Bildbeschreibung
Ein Nachrichtensprecher sitzt am Tisch und liest die Nachrichten vor. Im Hintergrund ist eine Stadtlandschaft zu sehen.

## Beziehung zur vorherigen Szene
DIRECT_CONTINUATION - Die Nachrichtensendung wird fortgesetzt mit einem neuen Thema.

## Erwartete Menschliche Wahrnehmung

| Kategorie | Schlagwort | Confidence |
| -------- | -------- | ---------: |
| rhetoric | serious | 0.90 |
| framing | neutral | 0.80 |
| emotion | calm | 0.70 |
`;

function makeFileRef(name = "scene-0.mp4"): FileRef {
  return {
    fileName: name,
    extension: "mp4",
    mediaType: "video",
    outputHash: "hash-123",
    serverUrl: "",
    containerPath: "/data/scene-0.mp4",
    hostPath: "/data/scene-0.mp4",
    relativePath: "scene-0.mp4",
  };
}

function makeSceneSlice(
  id: string,
  fromSeconds: number,
  toSeconds: number,
  caption: string | undefined,
  sceneIndex = 0,
): TimeSlice {
  return {
    id,
    index: 0,
    sourceIndex: sceneIndex,
    from: String(fromSeconds),
    to: String(toSeconds),
    fromSeconds,
    toSeconds,
    durationSeconds: toSeconds - fromSeconds,
    type: "scene",
    sceneIndex,
    caption: caption ?? "",
    sourceFile: makeFileRef(),
    parentFile: makeFileRef(),
  };
}

function makeAggregation(index: number, sliceIndexes: number[], from: number, to: number): SemanticAggregation {
  return {
    id: `default:aggregation:${index}`,
    pluginName: "default",
    index,
    sliceIndexes,
    sliceIds: sliceIndexes.map((i) => `slice:${i}`),
    from: String(from),
    to: String(to),
    fromSeconds: from,
    toSeconds: to,
  };
}

/**
 * Create a recording API that captures the exact args passed to callJson.
 * This lets us assert on prompt CONTENT, not just "was it called".
 */
function createRecordingApi(resolvedValue: unknown = { summary: "mock" }): {
  api: PluginRpcApiCompositeInstance;
  callJsonCalls: Array<Record<string, unknown>>;
  callJsonCallCount: number;
} {
  const callJsonCalls: Array<Record<string, unknown>> = [];

  const api: PluginRpcApiCompositeInstance = {
    file: {
      getMediaInfo: vi.fn(),
      listFiles: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
      deleteFile: vi.fn(),
    },
    cache: {
      get: vi.fn(),
      set: vi.fn(),
    },
    analysis: {
      getAnalysisResults: vi.fn(),
      analyzeSegment: vi.fn(),
    },
    mllm: {
      callRaw: vi.fn(),
      callJson: vi.fn(async (args: Record<string, unknown>) => {
        callJsonCalls.push(args);
        return resolvedValue;
      }),
    },
    util: {
      parseJsonLoose: (c: string) => { try { return JSON.parse(c); } catch { return null; } },
      formatTime: (s: number) => String(s),
      limitConcurrency: async <T, R>(items: T[], _limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> => {
        return Promise.all(items.map((item, i) => fn(item, i)));
      },
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    },
  } as unknown as PluginRpcApiCompositeInstance;

  return { api, callJsonCalls, get callJsonCallCount() { return callJsonCalls.length; } };
}

/** Build a plugin def — returns any to satisfy DefaultPostProcessingConfig generic */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makePluginDef(config: Record<string, unknown> = {}): any {
  return {
    name: "default",
    importPath: "./plugins/default.ts",
    config: {
      modelName: "mock-model",
      maxConcurrency: 1,
      includeTypes: ["scene"],
      reanalyzeVideoForAggregation: false,
      ...config,
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("Caption-first aggregation flow", () => {
  let recordingApi: ReturnType<typeof createRecordingApi>;

  beforeEach(() => {
    recordingApi = createRecordingApi();
  });

  // FIX 1: postProcessPerTimeSlice — caption-first (no VLM re-analysis)
  describe("postProcessPerTimeSlice — caption-first", () => {
    it("CF1: uses pre-generated rich caption WITHOUT calling VLM (reanalyzeVideo=false)", async () => {
      const slice = makeSceneSlice("scene:0:0:0-10", 0, 10, RICH_CAPTION);
      const input = { filePath: "test.mp4", timeSlices: [slice] } as unknown as PostProcessingInput;

      const result = await postProcessPerTimeSlice(input, makePluginDef(), recordingApi.api);

      // CRITICAL: VLM was NOT called — caption is used directly
      expect(recordingApi.callJsonCallCount).toBe(0);

      // Plugin data contains the raw caption preserved
      const pluginData = result.timeSlices[0].plugin?.["default"] as Record<string, unknown>;
      expect(pluginData).toBeDefined();
      expect(pluginData.raw_caption).toBe(RICH_CAPTION);
      expect(pluginData.caption_source).toBe("processing-phase");
    });

    it("CF2: calls VLM when reanalyzeVideo=true (forces re-analysis)", async () => {
      const slice = makeSceneSlice("scene:0:0:0-10", 0, 10, RICH_CAPTION);
      const input = { filePath: "test.mp4", timeSlices: [slice] } as unknown as PostProcessingInput;

      await postProcessPerTimeSlice(
        input,
        makePluginDef({ reanalyzeVideoForAggregation: true }),
        recordingApi.api,
      );

      expect(recordingApi.callJsonCallCount).toBe(1);
    });

    it("CF3: calls VLM when no caption exists (nothing to reuse)", async () => {
      const slice = makeSceneSlice("scene:0:0:0-10", 0, 10, "");
      const input = { filePath: "test.mp4", timeSlices: [slice] } as unknown as PostProcessingInput;

      await postProcessPerTimeSlice(input, makePluginDef(), recordingApi.api);

      expect(recordingApi.callJsonCallCount).toBe(1);
    });

    it("CF4: speech slices get transcript stored without VLM call", async () => {
      const slice: TimeSlice = {
        ...makeSceneSlice("speech:0:0:0-5", 0, 5, "Hello world"),
        type: "speech",
      };
      const input = { filePath: "test.mp4", timeSlices: [slice] } as unknown as PostProcessingInput;

      await postProcessPerTimeSlice(
        input,
        makePluginDef({ includeTypes: ["scene", "speech"] }),
        recordingApi.api,
      );

      expect(recordingApi.callJsonCallCount).toBe(0);
      const pd = slice.plugin?.["default"] as Record<string, unknown>;
      expect(pd.transcript).toBe("Hello world");
    });
  });

  // FIX 2: postProcessPerAggregation — raw caption in prompt
  describe("postProcessPerAggregation — raw caption propagation", () => {
    it("CF5: prompt includes raw caption with relationship label and perception matrix", async () => {
      const slice = makeSceneSlice("scene:0:0:0-10", 0, 10, RICH_CAPTION);
      slice.plugin = { default: { summary: "short", raw_caption: RICH_CAPTION } };

      const agg = makeAggregation(0, [0], 0, 10);

      await postProcessPerAggregation(agg, [slice], makePluginDef(), recordingApi.api);

      expect(recordingApi.callJsonCallCount).toBe(1);
      const prompt = String(recordingApi.callJsonCalls[0].prompt);
      // The raw caption with its rich signals must be in the prompt
      expect(prompt).toContain("DIRECT_CONTINUATION");
      expect(prompt).toContain("rhetoric");
      expect(prompt).toContain("serious");
      expect(prompt).toContain(RICH_CAPTION.slice(0, 50)); // First part of caption
    });

    it("CF6: works without raw caption (backward compatible)", async () => {
      const slice = makeSceneSlice("scene:0:0:0-10", 0, 10, undefined);
      slice.plugin = { default: { summary: "structured analysis only" } };

      const agg = makeAggregation(0, [0], 0, 10);

      await postProcessPerAggregation(agg, [slice], makePluginDef(), recordingApi.api);

      expect(recordingApi.callJsonCallCount).toBe(1);
      // Should still work — just without raw caption section
      const prompt = String(recordingApi.callJsonCalls[0].prompt);
      expect(prompt).toContain("structured analysis only");
    });
  });

  // FIX 3: decideForAggregation — rich caption preference
  describe("decideForAggregation — rich caption preference", () => {
    it("CF7: same sceneIndex auto-merges without model call (pre-merge)", async () => {
      const sliceA = makeSceneSlice("scene:0:0:0-5", 0, 5, "A", 0);
      const sliceB = makeSceneSlice("keyframe:0:1:0-5", 0, 5, "B", 0);

      const result = await decideForAggregation(
        sliceA, sliceB, makePluginDef(), recordingApi.api,
        { timeSlices: [sliceA, sliceB] } as unknown as PostProcessingInput,
      );

      expect(result).toBe(true);
      expect(recordingApi.callJsonCallCount).toBe(0);
    });

    it("CF8: cross-scene decision uses raw_caption from plugin data when rich signals present", async () => {
      const sliceA = makeSceneSlice("scene:0:0:0-5", 0, 5, "plain", 0);
      const sliceB = makeSceneSlice("scene:1:1:5-10", 5, 10, "plain B", 1);

      // Enrich A with rich caption in plugin data
      sliceA.plugin = { default: { summary: "short summary", raw_caption: RICH_CAPTION } };

      await decideForAggregation(
        sliceA, sliceB, makePluginDef(), recordingApi.api,
        { timeSlices: [sliceA, sliceB] } as unknown as PostProcessingInput,
      );

      expect(recordingApi.callJsonCallCount).toBe(1);
      const prompt = String(recordingApi.callJsonCalls[0].prompt);
      // The rich caption (with relationship label) should be in the prompt,
      // NOT just the short "short summary"
      expect(prompt).toContain("DIRECT_CONTINUATION");
      expect(prompt).toContain("Nachrichtensprecher");
    });

    it("CF9: cross-scene decision uses generic summary when no rich signals", async () => {
      const sliceA = makeSceneSlice("scene:0:0:0-5", 0, 5, undefined, 0);
      const sliceB = makeSceneSlice("scene:1:1:5-10", 5, 10, undefined, 1);

      sliceA.plugin = { default: { summary: "generic analysis summary" } };
      sliceB.plugin = { default: { summary: "another summary" } };

      await decideForAggregation(
        sliceA, sliceB, makePluginDef(), recordingApi.api,
        { timeSlices: [sliceA, sliceB] } as unknown as PostProcessingInput,
      );

      expect(recordingApi.callJsonCallCount).toBe(1);
      const prompt = String(recordingApi.callJsonCalls[0].prompt);
      expect(prompt).toContain("generic analysis summary");
    });
  });
});
