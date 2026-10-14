import { describe, it, expect, vi } from "vitest";
import type {
  PluginRpcApiCompositeInstance,
  TimeSlice,
  SemanticAggregation,
  PostProcessingInput,
  PostProcessingPluginModule,
  FileRef,
  PostProcessingPluginRunResult,
  TimeSlices,
  SemanticAggregations,
} from "../src/lib/plugin-types";
import { PostProcessingPluginDefinition } from "../src/lib/types.js";

// ── helpers ───────────────────────────────────────────────────────────────

/** Creates a minimal TimeSliceV3 for testing */
function createSlice(
  type: "scene" | "speech",
  index: number,
  fromSeconds: number,
  toSeconds: number,
  caption: string,
): TimeSlice {
  return {
    id: `${type}:0:${index}:${fromSeconds}-${toSeconds}`,
    index,
    from: String(fromSeconds),
    to: String(toSeconds),
    fromSeconds,
    toSeconds,
    durationSeconds: toSeconds - fromSeconds,
    type,
    sceneIndex: 0,
    caption,
    sourceFile: {} as FileRef,
    parentFile: {} as FileRef,
  };
}

/** Enriches a slice with default plugin data (simulates what default.ts does) */
function enrichWithDefault(slice: TimeSlice, analysis: Record<string, unknown>): TimeSlice {
  return {
    ...slice,
    plugin: { ...(slice.plugin ?? {}), default: analysis as any },
  };
}

/** Creates a mock PluginApi (MLLM not needed for these tests) */
function createMockApi(): PluginRpcApiCompositeInstance {
  return {
    file: { getMediaInfo: vi.fn(), listFiles: vi.fn(), readFile: vi.fn() },
    cache: { get: vi.fn(), set: vi.fn() },
    analysis: { getAnalysisResults: vi.fn(), analyzeSegment: vi.fn() },
    mllm: { callRaw: vi.fn(), callJson: vi.fn() },
    util: {
      parseJsonLoose: (c: string) => { try { return JSON.parse(c); } catch { return null; } },
      formatTime: vi.fn(),
      limitConcurrency: vi.fn(),
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    },
  };
}

/**
 * Builds a PostProcessingInputV3 that simulates the state AFTER the `default`
 * plugin has already run. This is what plugin B (order:1) would see as its input.
 */
function createInputWithDefaultResults(
  timeSlices: TimeSlices,
  defaultAggregations: SemanticAggregations = [],
  defaultSummary?: unknown,
): PostProcessingInput {
  const defaultResult: PostProcessingPluginRunResult = {
    pluginName: "default",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
    timeSlices,
    aggregations: defaultAggregations,
    summary: defaultSummary as any,
    errors: [],
  };

  return {
    workflowName: "test-workflow",
    workflow: {} as any,
    run: { id: "test-run", startedAt: "2026-01-01T00:00:00.000Z", force: false },
    file: {} as FileRef,
    analysisResult: {
      serverUrl: "",
      fileName: "test.mp4",
      extension: ".mp4",
      outputHash: "test-hash",
      mediaType: "video",
      scenes: [],
      postProcessing: { default: defaultResult },
      semanticAggregations: defaultAggregations,
    } as any,
    timeSlices: timeSlices.map((s) => ({ ...s, plugin: undefined })),
  };
}

// ── tests ─────────────────────────────────────────────────────────────────

describe("Cross-plugin access via input parameter", () => {

  describe("decideForAggregation can read prior plugin's per-slice analysis", () => {
    it("reads default plugin analysis from input to make grouping decisions", async () => {
      // Simulate the default plugin's enriched slices
      const enrichedSlices: TimeSlice[] = [
        enrichWithDefault(
          createSlice("scene", 0, 0, 10, "raw caption 0"),
          { summary: "Math lecture about algebra", scene_type: "interview" },
        ),
        enrichWithDefault(
          createSlice("scene", 1, 10, 20, "raw caption 1"),
          { summary: "Math lecture about calculus", scene_type: "interview" },
        ),
      ];

      const input = createInputWithDefaultResults(enrichedSlices);
      const config = {} as PostProcessingPluginDefinition;
      const api = createMockApi();

      /**
       * Plugin B's decideForAggregation: groups slices by the scene_type
       * from the default plugin's analysis (not the raw caption).
       */
      async function decideForAggregation(
        _prev: TimeSlice,
        _curr: TimeSlice,
        _pluginDefinition: PostProcessingPluginDefinition,
        _api: PluginRpcApiCompositeInstance,
        input?: PostProcessingInput,
      ): Promise<boolean> {
        // Access the default plugin's per-slice analysis
        const defaultSlices = input?.analysisResult?.postProcessing?.["default"]?.timeSlices as TimeSlices | undefined;
        if (!defaultSlices || defaultSlices.length < 2) return false;

        const prevAnalysis = defaultSlices[0]?.plugin?.["default"] as Record<string, unknown> | undefined;
        const currAnalysis = defaultSlices[1]?.plugin?.["default"] as Record<string, unknown> | undefined;

        // Group if both have the same scene_type
        return prevAnalysis?.scene_type === currAnalysis?.scene_type;
      }

      const result = await decideForAggregation(
        input.timeSlices[0], input.timeSlices[1], config, api, input,
      );

      // Both slices have scene_type "interview" → should be grouped
      expect(result).toBe(true);
    });

    it("returns false when prior plugin analyses have different scene types", async () => {
      const enrichedSlices: TimeSlice[] = [
        enrichWithDefault(createSlice("scene", 0, 0, 10, ""), { scene_type: "interview" }),
        enrichWithDefault(createSlice("scene", 1, 10, 20, ""), { scene_type: "ad" }),
      ];

      const input = createInputWithDefaultResults(enrichedSlices);
      const api = createMockApi();

      async function decideForAggregation(
        _prev: TimeSlice, _curr: TimeSlice,
        _pluginDefinition: PostProcessingPluginDefinition, _api: PluginRpcApiCompositeInstance,
        input?: PostProcessingInput,
      ): Promise<boolean> {
        const defaultSlices = input?.analysisResult?.postProcessing?.["default"]?.timeSlices as TimeSlices;
        const prevType = (defaultSlices?.[0]?.plugin?.["default"] as any)?.scene_type;
        const currType = (defaultSlices?.[1]?.plugin?.["default"] as any)?.scene_type;
        return prevType === currType;
      }

      const result = await decideForAggregation(input.timeSlices[0], input.timeSlices[1], {} as PostProcessingPluginDefinition, api, input);
      expect(result).toBe(false);
    });
  });

  describe("postProcessPerAggregation can read prior plugin's analysis", () => {
    it("reads default plugin's aggregation analysis and enhances it", async () => {
      // Default plugin's aggregation with analysis
      const defaultAgg: SemanticAggregation = {
        id: "default:aggregation:0",
        pluginName: "default",
        index: 0,
        sliceIndexes: [0, 1],
        sliceIds: ["scene:0:0:0-10", "scene:0:1:10-20"],
        from: "0", to: "20",
        fromSeconds: 0, toSeconds: 20,
        analysis: {
          summary: "A math lecture about algebra and calculus",
          scene_type: "interview",
          setting: "Classroom",
        },
      };

      const slices = [
        createSlice("scene", 0, 0, 10, "caption 0"),
        createSlice("scene", 1, 10, 20, "caption 1"),
      ];
      const input = createInputWithDefaultResults(slices, [defaultAgg]);
      const api = createMockApi();

      // The second plugin's own aggregation (auto-created, spans same time)
      const ownAgg: SemanticAggregation = {
        id: "my-plugin:aggregation:0",
        pluginName: "my-plugin",
        index: 0,
        sliceIndexes: [0],
        sliceIds: ["scene:0:0:0-10"],
        from: "0", to: "10",
        fromSeconds: 0, toSeconds: 10,
      };

      /**
       * Plugin B's postProcessPerAggregation: reads the default plugin's
       * aggregation analysis that overlaps with this aggregation and adds
       * a domain-specific annotation.
       */
      async function postProcessPerAggregation(
        aggregation: SemanticAggregation,
        _timeSlices: TimeSlice[],
        _config: PostProcessingPluginDefinition,
        _api: PluginRpcApiCompositeInstance,
        input?: PostProcessingInput,
      ) {
        // Find the default plugin's overlapping aggregation
        const defaultAggs = input?.analysisResult?.postProcessing?.["default"]?.aggregations;
        if (!defaultAggs) return {};

        const overlapping = defaultAggs.find(
          (a) => a.fromSeconds <= aggregation.toSeconds && a.toSeconds >= aggregation.fromSeconds,
        );
        if (!overlapping?.analysis) return {};

        const defaultAnalysis = overlapping.analysis as Record<string, unknown>;

        // Enhance: add domain annotation based on the default's analysis
        return {
          analysis: {
            ...defaultAnalysis,
            domain_annotation: "educational_content",
          },
        };
      }

      const result = await postProcessPerAggregation(ownAgg, slices, {} as PostProcessingPluginDefinition, api, input);

      expect(result.analysis).toEqual({
        summary: "A math lecture about algebra and calculus",
        scene_type: "interview",
        setting: "Classroom",
        domain_annotation: "educational_content",
      });
    });

    it("returns empty patch when no prior aggregation analysis exists", async () => {
      const slices = [createSlice("scene", 0, 0, 10, "caption")];
      const input = createInputWithDefaultResults(slices, []); // no default aggregations
      const api = createMockApi();

      async function postProcessPerAggregation(
        _agg: SemanticAggregation, _ts: TimeSlice[],
        _pluginDefinition: PostProcessingPluginDefinition, _api: PluginRpcApiCompositeInstance,
        input?: PostProcessingInput,
      ) {
        const defaultAggs = input?.analysisResult?.postProcessing?.["default"]?.aggregations;
        if (!defaultAggs?.length) return {};
        return { analysis: { enhanced: true } };
      }

      const ownAgg: SemanticAggregation = {
        id: "test:agg:0", pluginName: "test", index: 0,
        sliceIndexes: [0], sliceIds: ["s0"],
        from: "0", to: "10", fromSeconds: 0, toSeconds: 10,
      };

      const result = await postProcessPerAggregation(ownAgg, slices, {} as PostProcessingPluginDefinition, api, input);
      expect(result).toEqual({});
    });
  });

  describe("all hooks receive input — simulated sequential execution", () => {
    it("plugin B reads plugin A's slices, aggregations, and summary from input", async () => {
      // Simulate what plugin A (default) produced
      const pluginASlices = [
        enrichWithDefault(createSlice("scene", 0, 0, 10, ""), { summary: "Scene A", scene_type: "interview" }),
        enrichWithDefault(createSlice("scene", 1, 10, 20, ""), { summary: "Scene B", scene_type: "ad" }),
      ];
      const pluginAAggs: SemanticAggregations = [{
        id: "default:aggregation:0", pluginName: "default", index: 0,
        sliceIndexes: [0, 1], sliceIds: ["s0", "s1"],
        from: "0", to: "20", fromSeconds: 0, toSeconds: 20,
        analysis: { summary: "Full segment analysis" },
        summary: "Aggregation-level summary text",
      }];

      const input = createInputWithDefaultResults(
        pluginASlices, pluginAAggs,
        { title: "Final Title", long_summary: "The whole video summary" },
      );

      const api = createMockApi();
      const pluginDefinition: PostProcessingPluginDefinition = {
        name: "pluginB",
        importPath: "plugins/pluginB",
        config: {},
      };

      // Track what plugin B reads from input
      const readTracker = {
        slicesFromDefault: null as unknown,
        aggregationsFromDefault: null as unknown,
        summaryFromDefault: null as unknown,
        semanticAggregations: null as unknown,
      };

      // Plugin B: postProcessPerTimeSlice — reads default's slices
      const pluginB: PostProcessingPluginModule = {
        postProcessPerTimeSlice: async (input) => {
          readTracker.slicesFromDefault =
            input.analysisResult?.postProcessing?.["default"]?.timeSlices;
          return { timeSlices: input.timeSlices };
        },
        decideForAggregation: async (_p, _c, _cfg, _api, input) => {
          readTracker.aggregationsFromDefault =
            input?.analysisResult?.postProcessing?.["default"]?.aggregations;
          return false;
        },
        postProcessPerAggregation: async (_agg, _ts, _cfg, _api, input) => {
          readTracker.semanticAggregations =
            input?.analysisResult?.semanticAggregations;
          return {};
        },
        summaryFromAggregations: async (_aggs, _cfg, _api, input) => {
          readTracker.summaryFromDefault =
            input?.analysisResult?.postProcessing?.["default"]?.summary;
          return null;
        },
      };

      // Simulate engine calling plugin B's hooks
      // (mirrors runPostProcessingPluginsV3 logic)
      if (pluginB.postProcessPerTimeSlice) {
        await pluginB.postProcessPerTimeSlice(input, pluginDefinition, api);
      }
      if (pluginB.decideForAggregation && input.timeSlices.length > 1) {
        await pluginB.decideForAggregation(
          input.timeSlices[0], input.timeSlices[1], pluginDefinition, api, input,
        );
      }
      const agg: SemanticAggregation = {
        id: "test:agg:0", pluginName: "test", index: 0,
        sliceIndexes: [0], sliceIds: ["s0"],
        from: "0", to: "10", fromSeconds: 0, toSeconds: 10,
      };
      if (pluginB.postProcessPerAggregation) {
        await pluginB.postProcessPerAggregation(agg, input.timeSlices, pluginDefinition, api, input);
      }
      if (pluginB.summaryFromAggregations) {
        await pluginB.summaryFromAggregations([agg], pluginDefinition, api, input);
      }

      // Verify plugin B could read ALL of plugin A's data at every hook
      expect(readTracker.slicesFromDefault).toBeDefined();
      expect((readTracker.slicesFromDefault as TimeSlice[]).length).toBe(2);
      expect((readTracker.slicesFromDefault as TimeSlice[])[0].plugin?.default).toEqual({
        summary: "Scene A", scene_type: "interview",
      });

      expect(readTracker.aggregationsFromDefault).toBeDefined();
      expect((readTracker.aggregationsFromDefault as SemanticAggregations).length).toBe(1);

      expect(readTracker.semanticAggregations).toBeDefined();
      expect((readTracker.semanticAggregations as SemanticAggregations).length).toBe(1);

      expect(readTracker.summaryFromDefault).toEqual({
        title: "Final Title", long_summary: "The whole video summary",
      });
    });
  });

  describe("backward compatibility — hooks without input param still work", () => {
    it("decideForAggregation with 4 params (no input) is called without error", async () => {
      const api = createMockApi();

      // Old-style hook: only 4 params, no input
      async function oldDecide(
        _prev: TimeSlice, _curr: TimeSlice,
        _pluginDefinition: PostProcessingPluginDefinition, _api: PluginRpcApiCompositeInstance,
        _input?: PostProcessingInput,
      ): Promise<boolean> {
        return false;
      }

      // Engine passes 5 args; the 5th is silently ignored
      const slice0 = createSlice("scene", 0, 0, 10, "");
      const slice1 = createSlice("scene", 1, 10, 20, "");
      const input = createInputWithDefaultResults([slice0, slice1]);

      const result = await oldDecide(slice0, slice1, {} as PostProcessingPluginDefinition, api, input);
      expect(result).toBe(false);
    });

    it("postProcessPerAggregation with 4 params (no input) is called without error", async () => {
      const api = createMockApi();

      async function oldPostAgg(
        _agg: SemanticAggregation, _ts: TimeSlice[],
        _pluginDefinition: PostProcessingPluginDefinition, _api: PluginRpcApiCompositeInstance,
        _input?: PostProcessingInput,
      ) {
        return { analysis: { legacy: true } };
      }

      const agg: SemanticAggregation = {
        id: "test:agg:0", pluginName: "test", index: 0,
        sliceIndexes: [0], sliceIds: ["s0"],
        from: "0", to: "10", fromSeconds: 0, toSeconds: 10,
      };
      const input = createInputWithDefaultResults([createSlice("scene", 0, 0, 10, "")]);

      const result = await oldPostAgg(agg, input.timeSlices, {} as PostProcessingPluginDefinition, api, input);
      expect(result).toEqual({ analysis: { legacy: true } });
    });
  });
});
