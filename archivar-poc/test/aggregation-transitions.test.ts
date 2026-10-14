/**
 * Tests for the aggregation transition pass (WS2) in plugins/default.ts and the
 * engine wiring in workflow-engine.ts.
 *
 * WHY: per-slice `relationship_to_previous` is unreliable because slice
 * captioning runs in parallel batches (a batch can't see same-batch
 * predecessors). The enrichAggregationTransitions hook runs AFTER all
 * aggregation analyses are final, so each adjacent pair can be judged
 * independently under bounded concurrency. The engine invokes it between
 * extractSemanticProfiles and postProcessHigherOrderAggregations, and the
 * per-aggregation analysis loop now runs under bounded concurrency (results
 * preserved by index).
 */
import { describe, it, expect, vi } from "vitest";
import type {
  PluginRpcApiCompositeInstance,
  SemanticAggregation,
  PostProcessingInput,
  PostProcessingPluginModule,
  TimeSlice,
  FileRef,
} from "../src/lib/plugin-types.js";
import type { PostProcessingPluginDefinition } from "../src/lib/workflow-types.js";

// Mock getModel so importing/running the plugin needs no archivar config/env.
// The engine module imports more symbols from archivar-config; stub them all.
vi.mock("../src/lib/archivar-config.js", () => ({
  getModel: () => ({
    resolvedEndpoint: "http://mock",
    resolvedModel: "mock-model",
    resolvedApiKey: "mock-key",
    jsonSchemaMode: "auto",
  }),
  getWorkflow: vi.fn(),
  getArchivarConfig: vi.fn(),
  resolveSegmentScenesConfig: vi.fn(),
  buildSegmentScenesCliArgs: vi.fn(),
  buildInferenceMmProcessorKwargs: vi.fn(),
}));

import {
  enrichAggregationTransitions,
  aggregationToText,
  transitionSchema,
} from "../plugins/default";
import { WorkflowEngine } from "../src/rpc/workflow-engine.js";

/** Mock API that tracks callJson calls; limitConcurrency executes the workers. */
function createMockApi(
  callJsonImpl?: (args: { prompt: string }) => Promise<unknown>,
): PluginRpcApiCompositeInstance {
  const callJson = vi.fn(
    callJsonImpl ??
      (async () => ({
        relationship_to_previous: "DIRECT_CONTINUATION",
        transition_description: "B setzt A nahtlos fort.",
      })),
  );
  return {
    file: { getMediaInfo: vi.fn(), listFiles: vi.fn(), readFile: vi.fn(), writeFile: vi.fn(), deleteFile: vi.fn() },
    cache: { get: vi.fn(), set: vi.fn() },
    analysis: { getAnalysisResults: vi.fn(), analyzeSegment: vi.fn() },
    mllm: { callRaw: vi.fn(), callJson },
    util: {
      parseJsonLoose: (c: string) => { try { return JSON.parse(c); } catch { return null; } },
      formatTime: vi.fn(),
      limitConcurrency: async <T, R>(items: T[], _limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> => {
        return Promise.all(items.map((item, i) => fn(item, i)));
      },
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    },
  } as unknown as PluginRpcApiCompositeInstance;
}

function makeAgg(index: number, analysis?: Record<string, unknown>): SemanticAggregation {
  return {
    id: `default:aggregation:${index}`,
    pluginName: "default",
    index,
    sliceIndexes: [index],
    sliceIds: [`slice-${index}`],
    from: `00:00:${String(index * 10).padStart(2, "0")}`,
    to: `00:00:${String(index * 10 + 10).padStart(2, "0")}`,
    fromSeconds: index * 10,
    toSeconds: index * 10 + 10,
    ...(analysis ? { analysis: analysis as never } : {}),
  };
}

const pluginDef = { config: { modelName: "test-model" } } as never;

describe("enrichAggregationTransitions (plugin)", () => {
  it("AT1: N aggregations produce exactly N-1 pair calls; results written, agg[0] untouched", async () => {
    const api = createMockApi();
    const aggs = [
      makeAgg(0, { summary: "Erster Beitrag" }),
      makeAgg(1, { summary: "Zweiter Beitrag", relationship_to_previous: "NO_RELATION" }),
      makeAgg(2, { summary: "Dritter Beitrag" }),
    ];

    await enrichAggregationTransitions(aggs, pluginDef, api);

    expect(api.mllm.callJson).toHaveBeenCalledTimes(2);
    // agg[0] untouched (no predecessor)
    expect(aggs[0].analysis).toEqual({ summary: "Erster Beitrag" });
    // agg[1]: unreliable slice-derived label overwritten, description added
    const a1 = aggs[1].analysis as Record<string, unknown>;
    expect(a1.relationship_to_previous).toBe("DIRECT_CONTINUATION");
    expect(a1.transition_description).toBe("B setzt A nahtlos fort.");
    expect(a1.summary).toBe("Zweiter Beitrag");
    // agg[2] enriched too
    const a2 = aggs[2].analysis as Record<string, unknown>;
    expect(a2.relationship_to_previous).toBe("DIRECT_CONTINUATION");
    expect(a2.transition_description).toBe("B setzt A nahtlos fort.");
    // Pair calls are text-only and schema-validated
    const callArgs = (api.mllm.callJson as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.filePaths).toEqual([]);
    expect(callArgs.schema).toBe(transitionSchema);
    expect(String(callArgs.prompt)).toContain("Beitrag A (vorheriger):");
    expect(String(callArgs.prompt)).toContain("Beitrag B (aktueller):");
  });

  it("AT2: fewer than 2 aggregations → no model calls", async () => {
    const api = createMockApi();
    await enrichAggregationTransitions([], pluginDef, api);
    await enrichAggregationTransitions([makeAgg(0, { summary: "Einziger" })], pluginDef, api);
    expect(api.mllm.callJson).not.toHaveBeenCalled();
  });

  it("AT3: enrichTransitions: false → no model calls", async () => {
    const api = createMockApi();
    const aggs = [makeAgg(0, { summary: "A" }), makeAgg(1, { summary: "B" })];
    await enrichAggregationTransitions(
      aggs,
      { config: { modelName: "test-model", enrichTransitions: false } } as never,
      api,
    );
    expect(api.mllm.callJson).not.toHaveBeenCalled();
    expect(aggs[1].analysis).toEqual({ summary: "B" });
  });

  it("AT4: one pair's callJson rejects → others still applied, no throw, failed pair untouched", async () => {
    let call = 0;
    const api = createMockApi(async () => {
      call++;
      if (call === 2) throw new Error("model down");
      return {
        relationship_to_previous: "NEW_TOPIC_SOFT_DRIFT",
        transition_description: `Uebergang ${call}`,
      };
    });
    const aggs = [
      makeAgg(0, { summary: "A" }),
      makeAgg(1, { summary: "B", relationship_to_previous: "NO_RELATION" }),
      makeAgg(2, { summary: "C" }),
    ];

    await expect(enrichAggregationTransitions(aggs, pluginDef, api)).resolves.toBeUndefined();
    expect(api.mllm.callJson).toHaveBeenCalledTimes(2);
    // Pair (0→1) succeeded
    const a1 = aggs[1].analysis as Record<string, unknown>;
    expect(a1.relationship_to_previous).toBe("NEW_TOPIC_SOFT_DRIFT");
    expect(a1.transition_description).toBe("Uebergang 1");
    // Pair (1→2) failed → agg[2] keeps existing values untouched
    expect(aggs[2].analysis).toEqual({ summary: "C" });
  });

  it("AT5: aggregationToText emits the transition line only when transition_description is present", async () => {
    const plain = aggregationToText(makeAgg(1, {
      summary: "B",
      relationship_to_previous: "DIRECT_CONTINUATION",
    }));
    expect(plain).toContain("Beziehung zur vorherigen: DIRECT_CONTINUATION");
    expect(plain).not.toContain("Übergang von vorheriger:");

    const enriched = aggregationToText(makeAgg(1, {
      summary: "B",
      relationship_to_previous: "DIRECT_CONTINUATION",
      transition_description: "B greift das Thema von A auf.",
    }));
    const relIdx = enriched.indexOf("Beziehung zur vorherigen:");
    const transIdx = enriched.indexOf("Übergang von vorheriger: B greift das Thema von A auf.");
    expect(transIdx).toBeGreaterThan(-1);
    // Transition line follows the relationship line
    expect(transIdx).toBeGreaterThan(relIdx);
  });
});

// ---------------------------------------------------------------------------
// Engine-level: hook ordering and parallel per-aggregation loop
// ---------------------------------------------------------------------------

const engine = new WorkflowEngine();
// The hook chain lives in a private method; access it via bracket notation.
const runPost = (
  engine as unknown as {
    runPostProcessingPlugins: (
      input: PostProcessingInput,
      pluginDefinition: PostProcessingPluginDefinition,
      api: PluginRpcApiCompositeInstance,
      pluginName: string,
      mod: PostProcessingPluginModule,
    ) => Promise<{
      aggregations: SemanticAggregation[];
      errors: Array<{ hook: string; message: string; aggregationId?: string }>;
    }>;
  }
).runPostProcessingPlugins.bind(engine);

function makeFileRef(name: string): FileRef {
  return {
    fileName: name,
    extension: "mp4",
    mediaType: "video",
    outputHash: "hash",
    serverUrl: "",
    containerPath: `/data/${name}`,
    hostPath: `/data/${name}`,
    relativePath: name,
  };
}

function makeSceneSlice(i: number, sceneIndex: number, from: number, to: number): TimeSlice {
  return {
    id: `scene:${sceneIndex}:${i}:${from}-${to}`,
    index: i,
    from: String(from),
    to: String(to),
    fromSeconds: from,
    toSeconds: to,
    durationSeconds: to - from,
    type: "scene",
    sceneIndex,
    caption: `scene ${sceneIndex}`,
    sourceFile: makeFileRef(`scene-${sceneIndex}.mp4`),
    parentFile: makeFileRef(`scene-${sceneIndex}.mp4`),
  };
}

function makeInput(slices: TimeSlice[]): PostProcessingInput {
  return {
    workflowName: "test",
    workflow: {} as never,
    run: { id: "test-run", startedAt: new Date().toISOString(), force: false },
    file: makeFileRef("parent.mp4"),
    analysisResult: {} as never,
    timeSlices: slices,
  };
}

// Keep every slice its own aggregation: disable both minimum-size rules.
function makePluginDef(extra: Record<string, unknown> = {}): PostProcessingPluginDefinition {
  return {
    name: "test",
    importPath: "./test",
    config: { minScenesPerAggregation: 1, minAggregationLengthInSec: 0, ...extra },
  } as never;
}

const stubApi = {} as PluginRpcApiCompositeInstance;

describe("engine wiring: transition hook + parallel per-aggregation loop", () => {
  it("EN1: hook order is extractSemanticProfiles → enrichAggregationTransitions → postProcessHigherOrderAggregations", async () => {
    const order: string[] = [];
    const mod: PostProcessingPluginModule = {
      decideForAggregation: async () => false,
      extractSemanticProfiles: async () => { order.push("profiles"); },
      enrichAggregationTransitions: async () => { order.push("transitions"); },
      postProcessHigherOrderAggregations: async () => { order.push("hoa"); return []; },
    };
    const slices = [0, 1, 2].map((s) => makeSceneSlice(s, s, s * 20, s * 20 + 20));
    await runPost(makeInput(slices), makePluginDef(), stubApi, "test", mod);
    expect(order).toEqual(["profiles", "transitions", "hoa"]);
  });

  it("EN2: missing enrichAggregationTransitions hook is skipped (optional)", async () => {
    const order: string[] = [];
    const mod: PostProcessingPluginModule = {
      decideForAggregation: async () => false,
      extractSemanticProfiles: async () => { order.push("profiles"); },
      postProcessHigherOrderAggregations: async () => { order.push("hoa"); return []; },
    };
    const slices = [0, 1].map((s) => makeSceneSlice(s, s, s * 20, s * 20 + 20));
    await runPost(makeInput(slices), makePluginDef(), stubApi, "test", mod);
    expect(order).toEqual(["profiles", "hoa"]);
  });

  it("EN3: a throwing enrichAggregationTransitions is recorded as an error, HOA still runs", async () => {
    const order: string[] = [];
    const mod: PostProcessingPluginModule = {
      decideForAggregation: async () => false,
      enrichAggregationTransitions: async () => { throw new Error("boom"); },
      postProcessHigherOrderAggregations: async () => { order.push("hoa"); return []; },
    };
    const slices = [0, 1].map((s) => makeSceneSlice(s, s, s * 20, s * 20 + 20));
    const res = await runPost(makeInput(slices), makePluginDef(), stubApi, "test", mod);
    expect(order).toEqual(["hoa"]);
    expect(res.errors.some((e) => e.hook === "enrichAggregationTransitions" && e.message === "boom")).toBe(true);
  });

  it("EN4: per-aggregation loop applies results in index order under bounded concurrency", async () => {
    let inFlight = 0;
    let peak = 0;
    const mod: PostProcessingPluginModule = {
      decideForAggregation: async () => false,
      postProcessPerAggregation: async (agg) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
        return { analysis: { summary: `analysis-${agg.index}` } };
      },
      summaryForAggregation: async (agg) => `summary-${agg.index}`,
    };
    const slices = [0, 1, 2, 3].map((s) => makeSceneSlice(s, s, s * 20, s * 20 + 20));
    const res = await runPost(
      makeInput(slices),
      makePluginDef({ maxConcurrency: 2 }),
      stubApi, "test", mod,
    );
    expect(res.aggregations).toHaveLength(4);
    res.aggregations.forEach((a, i) => {
      expect(a.index).toBe(i);
      expect((a.analysis as Record<string, unknown>).summary).toBe(`analysis-${i}`);
      expect(a.summary).toBe(`summary-${i}`);
    });
    // Bounded at maxConcurrency=2, and actually parallel
    expect(peak).toBe(2);
  });

  it("EN5: one aggregation's failure is recorded and does not kill the others", async () => {
    const mod: PostProcessingPluginModule = {
      decideForAggregation: async () => false,
      postProcessPerAggregation: async (agg) => {
        if (agg.index === 1) throw new Error("analysis failed");
        return { analysis: { summary: `analysis-${agg.index}` } };
      },
    };
    const slices = [0, 1, 2].map((s) => makeSceneSlice(s, s, s * 20, s * 20 + 20));
    const res = await runPost(makeInput(slices), makePluginDef(), stubApi, "test", mod);
    expect(res.aggregations).toHaveLength(3);
    expect((res.aggregations[0].analysis as Record<string, unknown>).summary).toBe("analysis-0");
    expect(res.aggregations[1].analysis).toBeUndefined();
    expect((res.aggregations[2].analysis as Record<string, unknown>).summary).toBe("analysis-2");
    expect(res.errors.some((e) => e.hook === "postProcessPerAggregation" && e.message === "analysis failed")).toBe(true);
  });
});
