/**
 * Unit + engine-level tests for speech-to-scene assignment.
 *
 * Pure-helper tests cover the assignment primitives in src/lib/scene-assignment.ts
 * (largest-overlap wins, gap-capped nearest fallback, boundary/edge cases).
 *
 * The engine-level regression test reproduces the production anomaly shape —
 * a 0.5s scene plus long speech segments spanning many scenes — and drives the
 * real (private) `WorkflowEngine.aggregateResults` via bracket-notation cast
 * (same pattern as test/aggregation-constraints-engine.test.ts), asserting that
 * speech lands on the dominant-overlap scene instead of the first overlapping
 * one, and that far-away segments stay unassigned and surface as sceneIndex -1
 * slices via the exported `buildPostProcessingInput`.
 *
 * Fully hermetic: no network, no env, no filesystem.
 */
import { describe, it, expect } from "vitest";
import {
  findBestOverlapSceneIndex,
  findNearestSceneIndexWithinGap,
} from "../src/lib/scene-assignment.js";
import { WorkflowEngine, buildPostProcessingInput } from "../src/rpc/workflow-engine.js";
import type { UnassignedSegment } from "../src/rpc/workflow-engine.js";
import type { FileInfo } from "../src/rpc/file-api.js";
import type { AnalysisResult, AnalysisResultScene } from "../src/db/db.js";
import type { MediaSegmentType, WorkflowDefinition } from "../src/lib/workflow-types.js";

const GAP = 5;

// ── findBestOverlapSceneIndex ──────────────────────────────────────────────

describe("findBestOverlapSceneIndex", () => {
  it("dominant overlap wins over first overlap", () => {
    // Segment 0–10 overlaps scene A (0–2) by 2s and scene B (2–10) by 8s.
    // First-overlap assignment would pick A; largest-overlap must pick B.
    const scenes = [
      { startTime: 0, endTime: 2 },
      { startTime: 2, endTime: 10 },
    ];
    expect(findBestOverlapSceneIndex(0, 10, scenes)).toEqual({ index: 1, overlapSeconds: 8 });
  });

  it("returns null when no scene overlaps", () => {
    const scenes = [{ startTime: 0, endTime: 5 }];
    expect(findBestOverlapSceneIndex(10, 20, scenes)).toBeNull();
  });

  it("tie in overlap goes to the earliest scene", () => {
    const scenes = [
      { startTime: 0, endTime: 5 },
      { startTime: 5, endTime: 10 },
    ];
    expect(findBestOverlapSceneIndex(0, 10, scenes)).toEqual({ index: 0, overlapSeconds: 5 });
  });

  it("touching boundaries (zero-duration overlap) do not count", () => {
    const scenes = [
      { startTime: 0, endTime: 10 },
      { startTime: 10, endTime: 20 },
    ];
    // Segment 10–15 only touches scene A at t=10 (overlap 0) → scene B.
    expect(findBestOverlapSceneIndex(10, 15, scenes)).toEqual({ index: 1, overlapSeconds: 5 });
  });
});

// ── findNearestSceneIndexWithinGap ─────────────────────────────────────────

describe("findNearestSceneIndexWithinGap", () => {
  it("zero scenes → null", () => {
    expect(findNearestSceneIndexWithinGap(0, 10, [], GAP)).toBeNull();
  });

  it("single scene within gap → 0", () => {
    const scenes = [{ startTime: 12, endTime: 20 }];
    expect(findNearestSceneIndexWithinGap(0, 10, scenes, GAP)).toBe(0);
  });

  it("single scene beyond gap → null", () => {
    const scenes = [{ startTime: 30, endTime: 40 }];
    expect(findNearestSceneIndexWithinGap(0, 10, scenes, GAP)).toBeNull();
  });

  it("zero overlap, nearest within gap → nearest index", () => {
    const scenes = [
      { startTime: 0, endTime: 50 },
      { startTime: 112, endTime: 130 },
    ];
    // Segment 100–110: gap to scene B is 2s (within 5s); midpoint distance also favors B.
    expect(findNearestSceneIndexWithinGap(100, 110, scenes, GAP)).toBe(1);
  });

  it("zero overlap, nearest beyond gap → null", () => {
    const scenes = [
      { startTime: 0, endTime: 50 },
      { startTime: 120, endTime: 130 },
    ];
    // Segment 100–110: nearest scene is B, but the gap is 10s > 5s.
    expect(findNearestSceneIndexWithinGap(100, 110, scenes, GAP)).toBeNull();
  });

  it("gap exactly equal to maxGapSec is still within", () => {
    const scenes = [{ startTime: 15, endTime: 30 }];
    expect(findNearestSceneIndexWithinGap(0, 10, scenes, GAP)).toBe(0);
  });

  it("segment entirely before the first scene uses the boundary gap", () => {
    const scenes = [
      { startTime: 100, endTime: 200 },
      { startTime: 300, endTime: 400 },
    ];
    expect(findNearestSceneIndexWithinGap(96, 99, scenes, GAP)).toBe(0); // gap 1
    expect(findNearestSceneIndexWithinGap(80, 90, scenes, GAP)).toBeNull(); // gap 10
  });

  it("segment entirely after the last scene uses the boundary gap", () => {
    const scenes = [
      { startTime: 0, endTime: 100 },
      { startTime: 200, endTime: 300 },
    ];
    expect(findNearestSceneIndexWithinGap(301, 305, scenes, GAP)).toBe(1); // gap 1
    expect(findNearestSceneIndexWithinGap(310, 320, scenes, GAP)).toBeNull(); // gap 10
  });

  it("overlapping segment has gap 0 and resolves to the nearest scene", () => {
    const scenes = [
      { startTime: 0, endTime: 10 },
      { startTime: 10, endTime: 20 },
    ];
    expect(findNearestSceneIndexWithinGap(8, 12, scenes, GAP)).not.toBeNull();
  });
});

// ── Engine-level regression: the 0.5s-scene anomaly ────────────────────────

const engine = new WorkflowEngine();
// The assignment logic lives in a private method; access it via bracket notation.
const aggregateResults = (
  engine as unknown as {
    aggregateResults: (
      captions: Map<MediaSegmentType, Map<number, string>>,
      fileInfo: FileInfo,
      resultScenes: AnalysisResultScene[],
    ) => UnassignedSegment[];
  }
).aggregateResults.bind(engine);

function makeFileInfo(partial: Partial<FileInfo>): FileInfo {
  return {
    hostAbsolutePath: "/data/parent.mp4",
    absolutePath: "/data/parent.mp4",
    relativePath: "parent.mp4",
    path: "/data/parent.mp4",
    mediaType: "video",
    fileName: "parent.mp4",
    extension: ".mp4",
    outputFolderName: null,
    outputHash: "hash",
    keyframes: [],
    sceneKeyframes: [],
    scenes: [],
    silence: [],
    harmonic: [],
    noise: [],
    speech: [],
    ...partial,
  };
}

function makeSpeechSegment(index: number, start: number, end: number): FileInfo {
  return makeFileInfo({
    fileName: `speech-${index}.wav`,
    extension: ".wav",
    mediaType: "audio",
    startTime: start,
    endTime: end,
    index,
  });
}

function makeScene(index: number, start: number, end: number): AnalysisResultScene {
  return {
    index,
    startTime: start,
    endTime: end,
    serverUrl: "",
    fileName: `scene-${index}.mp4`,
    extension: ".mp4",
    outputHash: "hash",
    mediaType: "video",
    caption: "",
    speech: [],
    keyframes: [],
    harmonic: [],
    noise: [],
  };
}

describe("WorkflowEngine.aggregateResults (regression: 0.5s-scene anomaly)", () => {
  // Anomaly shape: one tiny 0.5s scene + normal scenes; long ASR segments
  // spanning many scenes must NOT be dumped wholesale into the first
  // overlapping (tiny) scene. Fixtures are built per test because
  // aggregateResults mutates the scenes array.
  function makeFixtures() {
    const scenes = [
      makeScene(0, 0, 0.5),
      makeScene(1, 0.5, 120),
      makeScene(2, 120, 600),
      makeScene(3, 600, 900),
    ];
    const speechSegments = [
      makeSpeechSegment(0, 0, 10), // overlaps scene 0 by 0.5s, scene 1 by 9.5s
      makeSpeechSegment(1, 127, 893), // overlaps scene 2 by 473s, scene 3 by 293s
      makeSpeechSegment(2, 2000, 2010), // 1100s past the last scene → unassigned
    ];
    const captions = new Map<MediaSegmentType, Map<number, string>>([
      ["speech", new Map([
        [0, "intro words"],
        [1, "long monologue"],
        [2, "far-away words"],
      ])],
    ]);
    const fileInfo = makeFileInfo({ speech: speechSegments });
    return { scenes, captions, fileInfo };
  }

  it("assigns spanning speech to the dominant-overlap scene, not the first overlapping one", () => {
    const { scenes, captions, fileInfo } = makeFixtures();
    const unassigned = aggregateResults(captions, fileInfo, scenes);

    // Old behavior: segment 0 landed on scene 0 (first overlap, 0.5s).
    expect(scenes[0].speech).toEqual([]);
    expect(scenes[1].speech.map((s) => s.caption)).toEqual(["intro words"]);
    expect(scenes[2].speech.map((s) => s.caption)).toEqual(["long monologue"]);
    expect(scenes[3].speech).toEqual([]);

    // Far-away segment is attributed to NO scene (wrong attribution > none).
    expect(unassigned.map((u) => u.caption)).toEqual(["far-away words"]);
  });

  it("unassigned segments reach timeSlices as sceneIndex -1 (not dropped)", () => {
    const { scenes, captions, fileInfo } = makeFixtures();
    const unassigned = aggregateResults(captions, fileInfo, scenes);
    const result: AnalysisResult = {
      serverUrl: "",
      fileName: fileInfo.fileName,
      extension: fileInfo.extension,
      outputHash: fileInfo.outputHash,
      mediaType: fileInfo.mediaType,
      scenes,
    };
    const input = buildPostProcessingInput(
      result,
      fileInfo,
      {} as WorkflowDefinition,
      "test-workflow",
      false,
      undefined,
      unassigned,
    );

    const speechSlices = input.timeSlices.filter((s) => s.type === "speech");
    const byCaption = new Map(speechSlices.map((s) => [s.caption, s.sceneIndex]));
    expect(byCaption.get("intro words")).toBe(1);
    expect(byCaption.get("long monologue")).toBe(2);
    expect(byCaption.get("far-away words")).toBe(-1);
    // Nothing disappeared: all three speech segments are slices.
    expect(speechSlices).toHaveLength(3);
  });
});
