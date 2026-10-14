/**
 * Engine-level integration tests for the Level 1 aggregation minimum-size
 * constraints (slice -> aggregation grouping in workflow-engine.ts).
 *
 * These drive the real (private) `WorkflowEngine.runPostProcessingPlugins` with a
 * fake plugin module whose `decideForAggregation` ALWAYS returns false — i.e.
 * every scene is treated as a different contribution. This isolates the
 * deterministic minimum-size merge pass from the model decision logic.
 *
 * Verified behaviour:
 *  - >= 3 scenes: singletons are merged so each aggregation covers >= minScenes.
 *  - exactly 2 long scenes: NOT force-merged (the scene-count rule is skipped).
 *  - short scenes: the duration rule ("always") merges them regardless.
 *  - opt-out knobs (minScenesPerAggregation: 1, minAggregationLengthInSec: 0).
 */
import { describe, it, expect } from "vitest";
import { WorkflowEngine } from "../src/rpc/workflow-engine.js";
import { countDistinctScenes, groupDurationSeconds } from "../src/lib/aggregation-constraints.js";
import type {
  TimeSlice,
  FileRef,
  PostProcessingInput,
  PostProcessingPluginModule,
  PluginRpcApiCompositeInstance,
} from "../src/lib/plugin-types.js";
import type { PostProcessingPluginDefinition } from "../src/lib/workflow-types.js";

const engine = new WorkflowEngine();
// The grouping logic lives in a private method; access it via bracket notation.
const runPost = (
  engine as unknown as {
    runPostProcessingPlugins: (
      input: PostProcessingInput,
      pluginDefinition: PostProcessingPluginDefinition,
      api: PluginRpcApiCompositeInstance,
      pluginName: string,
      mod: PostProcessingPluginModule,
    ) => Promise<{ aggregations: Array<{ sliceIndexes: number[] }> }>;
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

/** One scene slice per scene (so scene count == slice count). */
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

/** A plugin module where every adjacent pair is considered a DIFFERENT contribution. */
const alwaysSplitMod: PostProcessingPluginModule = {
  decideForAggregation: async () => false,
};

const stubApi = {} as PluginRpcApiCompositeInstance;

function makePluginDef(config: Record<string, unknown> = {}): PostProcessingPluginDefinition {
  return { name: "test", importPath: "./test", config } as never;
}

describe("WorkflowEngine Level 1 minimum-size constraints", () => {
  it("ENG1: 4 long scenes are merged into 2 aggregations of 2 scenes each (scene-count rule)", async () => {
    const slices = [0, 1, 2, 3].map((s) => makeSceneSlice(s, s, s * 20, s * 20 + 20));
    const res = await runPost(makeInput(slices), makePluginDef(), stubApi, "test", alwaysSplitMod);
    // 4 singletons (each 1 scene, 20s) -> balanced into 2 aggregations of 2 scenes.
    expect(res.aggregations).toHaveLength(2);
    expect(res.aggregations[0].sliceIndexes).toEqual([0, 1]);
    expect(res.aggregations[1].sliceIndexes).toEqual([2, 3]);
    for (const agg of res.aggregations) {
      const scenes = countDistinctScenes(agg.sliceIndexes.map((i) => slices[i]));
      expect(scenes).toBeGreaterThanOrEqual(2);
    }
  });

  it("ENG2: exactly 2 long scenes are NOT force-merged (2 aggregations)", async () => {
    const slices = [makeSceneSlice(0, 0, 0, 20), makeSceneSlice(1, 1, 20, 40)];
    const res = await runPost(makeInput(slices), makePluginDef(), stubApi, "test", alwaysSplitMod);
    // Scene-count rule skipped (only 2 scenes); each is 20s >= minLen -> keep both.
    expect(res.aggregations).toHaveLength(2);
    expect(res.aggregations[0].sliceIndexes).toEqual([0]);
    expect(res.aggregations[1].sliceIndexes).toEqual([1]);
  });

  it("ENG3: exactly 2 SHORT scenes ARE merged by the duration rule (1 aggregation)", async () => {
    const slices = [makeSceneSlice(0, 0, 0, 5), makeSceneSlice(1, 1, 5, 10)];
    const res = await runPost(makeInput(slices), makePluginDef(), stubApi, "test", alwaysSplitMod);
    // Scene-count skipped, but each is 5s < minLen(10) -> duration merges them.
    expect(res.aggregations).toHaveLength(1);
    expect(res.aggregations[0].sliceIndexes).toEqual([0, 1]);
    expect(groupDurationSeconds(res.aggregations[0].sliceIndexes.map((i) => slices[i]))).toBe(10);
  });

  it("ENG4: minScenesPerAggregation=1 disables the scene-count rule (4 singletons kept)", async () => {
    const slices = [0, 1, 2, 3].map((s) => makeSceneSlice(s, s, s * 20, s * 20 + 20));
    const res = await runPost(
      makeInput(slices),
      makePluginDef({ minScenesPerAggregation: 1 }),
      stubApi, "test", alwaysSplitMod,
    );
    // Scene-count disabled; each 20s slice is not too short -> no merge.
    expect(res.aggregations).toHaveLength(4);
  });

  it("ENG5: minAggregationLengthInSec=0 disables the duration rule (short singletons kept)", async () => {
    const slices = [makeSceneSlice(0, 0, 0, 5), makeSceneSlice(1, 1, 5, 10)];
    const res = await runPost(
      makeInput(slices),
      makePluginDef({ minAggregationLengthInSec: 0 }),
      stubApi, "test", alwaysSplitMod,
    );
    // Both rules disabled for 2 scenes -> 2 separate short aggregations.
    expect(res.aggregations).toHaveLength(2);
  });

  it("ENG6: a sub-second trailing scene (0.84s) is merged, never a standalone aggregation", async () => {
    // Reproduces the real-world case: several long scenes + a tiny 0.84s clip at
    // the end. With every pair split, the sub-second scene must NOT become its own
    // aggregation — it folds into a neighbour by the scene-count rule.
    const slices = [
      makeSceneSlice(0, 0, 0, 20),
      makeSceneSlice(1, 1, 20, 40),
      makeSceneSlice(2, 2, 40, 60),
      makeSceneSlice(3, 3, 60, 60.84), // 0.84s — below MIN_SCENE_DURATION_SEC
    ];
    const res = await runPost(makeInput(slices), makePluginDef(), stubApi, "test", alwaysSplitMod);
    // scene3 (0.84s) is never alone: it merges into the aggregation with scene2.
    expect(res.aggregations).toHaveLength(2);
    expect(res.aggregations[0].sliceIndexes).toEqual([0, 1]);
    expect(res.aggregations[1].sliceIndexes).toEqual([2, 3]);
    const tiny = slices[3];
    const owner = res.aggregations.find((a) => a.sliceIndexes.includes(3));
    expect(owner).toBeDefined();
    expect(owner!.sliceIndexes.length).toBeGreaterThanOrEqual(2);
    // No aggregation is just the sub-second scene.
    expect(res.aggregations.some((a) => JSON.stringify(a.sliceIndexes) === "[3]")).toBe(false);
    void tiny;
  });
});
