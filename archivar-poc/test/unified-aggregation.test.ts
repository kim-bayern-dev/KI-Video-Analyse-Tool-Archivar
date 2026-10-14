/**
 * Tests for unified multi-modal aggregation in plugins/default.ts.
 *
 * WHY: Slices from the same scene (same sceneIndex) are auto-merged into a single
 * aggregation WITHOUT a model call — but only when both slices actually sit inside
 * that scene's timeframe (+ small tolerance). This keeps a scene's multi-modal
 * slices (scene + keyframes + in-range speech) together while PREVENTING a scene
 * from absorbing far-flung slices mis-attributed to it (e.g. a 0.5s scene hoarding
 * 14 minutes of speech), which would fuse into a 14-minute aggregation with no
 * model decision. The model only decides for adjacent SCENES or temporally-distant
 * slices sharing a sceneIndex.
 *
 */
import { describe, it, expect, vi } from "vitest";
import type { TimeSlice, PluginRpcApiCompositeInstance, FileRef } from "../src/lib/plugin-types";

// Mock getModel so importing/running the plugin needs no archivar config/env.
vi.mock("../src/lib/archivar-config.js", () => ({
  getModel: () => ({
    resolvedEndpoint: "http://mock",
    resolvedModel: "mock-model",
    resolvedApiKey: "mock-key",
    jsonSchemaMode: "auto",
  }),
}));

import { decideForAggregation } from "../plugins/default";

/** Format seconds as HH:MM:SS */
function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

/** Mock API that tracks callJson calls — returns true (same contribution) by default */
function createMockApi(): PluginRpcApiCompositeInstance {
  const callJson = vi.fn(async () => ({ same_contribution: true }));
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

function createSlice(
  type: TimeSlice["type"],
  sceneIndex: number,
  fromSeconds: number,
  toSeconds: number,
  caption = "",
  analysis?: Record<string, unknown>,
): TimeSlice {
  return {
    id: `${type}:${sceneIndex}:0:${fromSeconds}-${toSeconds}`,
    index: 0,
    from: formatTime(fromSeconds),
    to: formatTime(toSeconds),
    fromSeconds,
    toSeconds,
    durationSeconds: toSeconds - fromSeconds,
    type,
    sceneIndex,
    caption,
    sourceFile: { fileName: "", extension: "", mediaType: "video", outputHash: null, containerPath: "", hostPath: "", relativePath: "" } as FileRef,
    parentFile: { fileName: "", extension: "", mediaType: "video", outputHash: null, containerPath: "", hostPath: "", relativePath: "" } as FileRef,
    ...(analysis ? { plugin: { default: analysis as never } } : {}),
  };
}

/** Build a minimal PostProcessingInput carrying only timeSlices (the only field
 *  decideForAggregation reads from input). */
function makeInput(slices: TimeSlice[]): unknown {
  return { timeSlices: slices } as never;
}

const pluginDef = { config: { modelName: "test-model" } } as never;

describe("unified multi-modal aggregation — sceneIndex-based pre-merging", () => {
  it("UA1: scene + keyframe from same scene are merged WITHOUT model call", async () => {
    const api = createMockApi();
    const sceneSlice = createSlice("scene", 0, 0, 5, "Conference room scene", { summary: "Conference room scene" });
    const keyframeSlice = createSlice("keyframe", 0, 0, 0.5, "Person in suit speaking");

    const result = await decideForAggregation(
      sceneSlice,
      keyframeSlice,
      pluginDef,
      api,
      makeInput([sceneSlice, keyframeSlice]) as never,
    );

    // Same sceneIndex + both within scene 0's range [0,5] → auto-merge without model
    expect(result).toBe(true);
    expect(api.mllm.callJson).not.toHaveBeenCalled();
  });

  it("UA2: scene + speech from same scene are merged WITHOUT model call", async () => {
    const api = createMockApi();
    const sceneSlice = createSlice("scene", 3, 10, 20, "Studio anchor", { summary: "Studio anchor scene" });
    const speechSlice = createSlice("speech", 3, 12, 18, "Hier Stadt Frankfurt");

    const result = await decideForAggregation(
      sceneSlice,
      speechSlice,
      pluginDef,
      api,
      makeInput([sceneSlice, speechSlice]) as never,
    );

    // Speech [12,18] is within scene 3's range [10,20] → auto-merge
    expect(result).toBe(true);
    expect(api.mllm.callJson).not.toHaveBeenCalled();
  });

  it("UA3: two keyframes from same scene are merged WITHOUT model call", async () => {
    const api = createMockApi();
    // A scene slice is required so the auto-merge can find scene 5's time range.
    const scene5 = createSlice("scene", 5, 20, 22, "Cityscape", { summary: "Cityscape" });
    const kf1 = createSlice("keyframe", 5, 20, 20.5, "Wide shot of city");
    const kf2 = createSlice("keyframe", 5, 21, 21.5, "Close-up of building");

    const result = await decideForAggregation(
      kf1,
      kf2,
      pluginDef,
      api,
      makeInput([scene5, kf1, kf2]) as never,
    );

    expect(result).toBe(true);
    expect(api.mllm.callJson).not.toHaveBeenCalled();
  });

  it("UA4: scene from scene 0 + scene from scene 1 → model IS called", async () => {
    const api = createMockApi();
    const scene0 = createSlice("scene", 0, 0, 5, "Conference room", { summary: "Conference room" });
    const scene1 = createSlice("scene", 1, 5, 10, "Outdoor interview", { summary: "Outdoor interview" });

    const result = await decideForAggregation(
      scene0,
      scene1,
      pluginDef,
      api,
      makeInput([scene0, scene1]) as never,
    );

    // Different sceneIndex → model decides
    expect(result).toBe(true); // mock returns true
    expect(api.mllm.callJson).toHaveBeenCalledTimes(1);
  });

  it("UA5: last keyframe of scene 0 + first scene of scene 1 → model IS called", async () => {
    const api = createMockApi();
    const scene0 = createSlice("scene", 0, 0, 5, "Scene 0", { summary: "Scene 0" });
    const kfLastOf0 = createSlice("keyframe", 0, 4.5, 5, "Last keyframe of scene 0");
    const scene1 = createSlice("scene", 1, 5, 10, "Scene 1 content", { summary: "Scene 1" });

    const result = await decideForAggregation(
      kfLastOf0,
      scene1,
      pluginDef,
      api,
      makeInput([scene0, kfLastOf0, scene1]) as never,
    );

    expect(api.mllm.callJson).toHaveBeenCalledTimes(1);
  });

  it("UA6: all five modalities from same scene merge into ONE aggregation", async () => {
    const api = createMockApi();

    // Simulate the full slice sequence within one scene
    const scene = createSlice("scene", 7, 30, 40, "News studio", { summary: "News studio" });
    const speech = createSlice("speech", 7, 32, 38, "Breaking news");
    const keyframe1 = createSlice("keyframe", 7, 30, 30.5, "Anchor desk");
    const keyframe2 = createSlice("keyframe", 7, 35, 35.5, "Graphics display");
    const noise = createSlice("noise", 7, 33, 35, "");

    const input = makeInput([scene, speech, keyframe1, keyframe2, noise]) as never;

    // All pairs from the same scene (all within [30,40]) should auto-merge
    const pairs = [
      [scene, speech],
      [scene, keyframe1],
      [scene, keyframe2],
      [scene, noise],
      [speech, keyframe1],
      [speech, keyframe2],
      [keyframe1, keyframe2],
      [noise, keyframe1],
    ];

    for (const [a, b] of pairs) {
      const result = await decideForAggregation(a, b, pluginDef, api, input);
      expect(result).toBe(true);
    }

    // No model calls for any same-scene pair (all within scene 7's timeframe)
    expect(api.mllm.callJson).not.toHaveBeenCalled();
  });

  it("UA7: audio-only sceneIndex -1 has no scene range → model IS called (no auto-merge)", async () => {
    const api = createMockApi();
    // Slices with sceneIndex -1 (audio-only, no parent scene). There is no scene
    // slice with sceneIndex -1, so no scene time range exists → the auto-merge
    // cannot apply and the model decides.
    const audio1 = createSlice("noise", -1, 0, 5, "");
    const audio2 = createSlice("noise", -1, 5, 10, "");

    await decideForAggregation(
      audio1,
      audio2,
      pluginDef,
      api,
      makeInput([audio1, audio2]) as never,
    );

    expect(api.mllm.callJson).toHaveBeenCalledTimes(1);
  });

  it("UA8: same sceneIndex but temporally FAR from the scene → model IS called (mega-group prevention)", async () => {
    // Reproduces the real bug: a 0.5s scene (16) with far-flung speech slices tagged
    // sceneIndex 16 spanning minutes. They must NOT auto-merge into a mega-group;
    // the model must decide each boundary.
    const api = createMockApi();
    const scene16 = createSlice("scene", 16, 38.3, 38.78, "tiny scene", { summary: "tiny scene" });
    const farSpeech = createSlice("speech", 16, 127.8, 129.6, "distant speech");

    await decideForAggregation(
      scene16,
      farSpeech,
      pluginDef,
      api,
      makeInput([scene16, farSpeech]) as never,
    );

    // 127.8s is far outside scene 16's range [38.3,38.78] (+5s tol) → model decides
    expect(api.mllm.callJson).toHaveBeenCalledTimes(1);
  });

  it("UA9: within-tolerance speech just past the scene end still auto-merges", async () => {
    const api = createMockApi();
    const scene = createSlice("scene", 2, 20, 25, "scene", { summary: "scene" });
    // Speech ends at 29s — within the 5s tolerance past scene end (25).
    const speech = createSlice("speech", 2, 24, 29, "trailing speech");

    const result = await decideForAggregation(
      scene,
      speech,
      pluginDef,
      api,
      makeInput([scene, speech]) as never,
    );

    expect(result).toBe(true);
    expect(api.mllm.callJson).not.toHaveBeenCalled();
  });
});
