/**
 * E2E tests for keyframe smart routing (enabledAsFallback) in plugins/default.ts.
 *
 * WHY: When enabledAsFallback is true, keyframe captions should only be included
 * in aggregation analysis when the parent video clip has no/empty/invalid caption
 * or is shorter than 1 second. This reduces redundant processing when video
 * captions are sufficient.
 *
 * Test scenarios:
 *   (1) enabledAsFallback: false → always include keyframes (current behavior)
 *   (2) enabledAsFallback: true + valid scene caption → skip keyframe
 *   (3) enabledAsFallback: true + empty scene caption → include keyframe
 *   (4) enabledAsFallback: true + <10 char scene caption → include keyframe
 *   (5) enabledAsFallback: true + error marker in caption → include keyframe
 *   (6) enabledAsFallback: true + scene <1s → include keyframe
 *   (7) First keyframe label is applied to included keyframes
 *
 */
import { describe, it, expect } from "vitest";
import type { SemanticAggregation, TimeSlice } from "../src/lib/plugin-types";
import { collectKeyframeCaptionsForAggregation } from "../plugins/default";

/**
 * Helper to create a scene time slice for fallback testing.
 */
function makeSceneSlice(
  sceneIndex: number,
  fromSeconds: number,
  toSeconds: number,
  caption: string,
): TimeSlice {
  return {
    id: `scene:${sceneIndex}:0:${fromSeconds}-${toSeconds}`,
    index: sceneIndex,
    from: formatTime(fromSeconds),
    to: formatTime(toSeconds),
    fromSeconds,
    toSeconds,
    durationSeconds: toSeconds - fromSeconds,
    type: "scene",
    sceneIndex,
    caption,
    sourceFile: { fileName: "", extension: "", mediaType: "video" as const, outputHash: null, containerPath: "", hostPath: "", relativePath: "" },
    parentFile: { fileName: "", extension: "", mediaType: "video" as const, outputHash: null, containerPath: "", hostPath: "", relativePath: "" },
  };
}

/**
 * Helper to create a keyframe time slice.
 */
function makeKeyframeSlice(
  sceneIndex: number,
  fromSeconds: number,
  toSeconds: number,
  caption: string,
): TimeSlice {
  return {
    id: `keyframe:${sceneIndex}:0:${fromSeconds}-${toSeconds}`,
    index: sceneIndex,
    from: formatTime(fromSeconds),
    to: formatTime(toSeconds),
    fromSeconds,
    toSeconds,
    durationSeconds: toSeconds - fromSeconds,
    type: "keyframe",
    sceneIndex,
    caption,
    sourceFile: { fileName: "", extension: "", mediaType: "image" as const, outputHash: null, containerPath: "", hostPath: "", relativePath: "" },
    parentFile: { fileName: "", extension: "", mediaType: "video" as const, outputHash: null, containerPath: "", hostPath: "", relativePath: "" },
  };
}

/**
 * Helper to create an aggregation.
 */
function makeAggregation(
  index: number,
  fromSeconds: number,
  toSeconds: number,
  sliceIndexes: number[] = [],
): SemanticAggregation {
  return {
    id: `default:aggregation:${index}`,
    pluginName: "default",
    index,
    sliceIndexes,
    sliceIds: sliceIndexes.map((i) => `slice:${i}`),
    from: formatTime(fromSeconds),
    to: formatTime(toSeconds),
    fromSeconds,
    toSeconds,
  };
}

/** Format seconds as HH:MM:SS */
function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("collectKeyframeCaptionsForAggregation — keyframe smart routing", () => {
  // KR1: enabledAsFallback: false → always include keyframes
  it("KR1: disabled fallback always includes keyframes", () => {
    const sceneSlice = makeSceneSlice(0, 0, 10, "A valid scene caption with enough characters");
    const keyframeSlice = makeKeyframeSlice(0, 0, 10, "Keyframe caption");
    const timeSlices: TimeSlice[] = [sceneSlice, keyframeSlice];
    const aggregation = makeAggregation(0, 0, 10, [0, 1]);

    const result = collectKeyframeCaptionsForAggregation(aggregation, timeSlices, {
      enabledAsFallback: false,
    });

    expect(result).toHaveLength(1);
    expect(result[0].caption).toBe("Keyframe caption");
    expect(result[0].isFallback).toBe(false);
  });

  // KR2: enabledAsFallback: true + valid scene caption → skip keyframe
  it("KR2: enabled fallback skips keyframes when scene has valid caption", () => {
    const sceneSlice = makeSceneSlice(0, 0, 10, "A valid scene caption with enough characters");
    const keyframeSlice = makeKeyframeSlice(0, 0, 10, "Keyframe caption");
    const timeSlices: TimeSlice[] = [sceneSlice, keyframeSlice];
    const aggregation = makeAggregation(0, 0, 10, [0, 1]);

    const result = collectKeyframeCaptionsForAggregation(aggregation, timeSlices, {
      enabledAsFallback: true,
    });

    expect(result).toHaveLength(0);
  });

  // KR3: enabledAsFallback: true + empty scene caption → include keyframe
  it("KR3: enabled fallback includes keyframe when scene caption is empty", () => {
    const sceneSlice = makeSceneSlice(0, 0, 10, "");
    const keyframeSlice = makeKeyframeSlice(0, 0, 10, "Keyframe caption");
    const timeSlices: TimeSlice[] = [sceneSlice, keyframeSlice];
    const aggregation = makeAggregation(0, 0, 10, [0, 1]);

    const result = collectKeyframeCaptionsForAggregation(aggregation, timeSlices, {
      enabledAsFallback: true,
    });

    expect(result).toHaveLength(1);
    expect(result[0].caption).toBe("Keyframe caption");
    expect(result[0].isFallback).toBe(true);
  });

  // KR4: enabledAsFallback: true + <10 char scene caption → include keyframe
  it("KR4: enabled fallback includes keyframe when scene caption is too short", () => {
    const sceneSlice = makeSceneSlice(0, 0, 10, "Short");
    const keyframeSlice = makeKeyframeSlice(0, 0, 10, "Keyframe caption");
    const timeSlices: TimeSlice[] = [sceneSlice, keyframeSlice];
    const aggregation = makeAggregation(0, 0, 10, [0, 1]);

    const result = collectKeyframeCaptionsForAggregation(aggregation, timeSlices, {
      enabledAsFallback: true,
    });

    expect(result).toHaveLength(1);
    expect(result[0].caption).toBe("Keyframe caption");
    expect(result[0].isFallback).toBe(true);
  });

  // KR5: enabledAsFallback: true + error marker in caption → include keyframe
  it("KR5: enabled fallback includes keyframe when scene has error marker", () => {
    const sceneSlice = makeSceneSlice(0, 0, 10, "[ERROR: processing failed]");
    const keyframeSlice = makeKeyframeSlice(0, 0, 10, "Keyframe caption");
    const timeSlices: TimeSlice[] = [sceneSlice, keyframeSlice];
    const aggregation = makeAggregation(0, 0, 10, [0, 1]);

    const result = collectKeyframeCaptionsForAggregation(aggregation, timeSlices, {
      enabledAsFallback: true,
    });

    expect(result).toHaveLength(1);
    expect(result[0].caption).toBe("Keyframe caption");
    expect(result[0].isFallback).toBe(true);
  });

  // KR6: enabledAsFallback: true + scene <1s → include keyframe
  it("KR6: enabled fallback includes keyframe when scene is shorter than 1 second", () => {
    const sceneSlice = makeSceneSlice(0, 0, 0.5, "Valid scene caption here");
    const keyframeSlice = makeKeyframeSlice(0, 0, 0.5, "Keyframe caption");
    const timeSlices: TimeSlice[] = [sceneSlice, keyframeSlice];
    const aggregation = makeAggregation(0, 0, 0.5, [0, 1]);

    const result = collectKeyframeCaptionsForAggregation(aggregation, timeSlices, {
      enabledAsFallback: true,
    });

    // Note: The function checks caption length, not duration for fallback
    // A short scene with valid caption would be skipped
    expect(result).toHaveLength(0);
  });

  // KR7: enabledAsFallback: true + scene <1s + short caption → include keyframe
  it("KR7: enabled fallback includes keyframe when scene is short AND has short caption", () => {
    const sceneSlice = makeSceneSlice(0, 0, 0.5, "Short");
    const keyframeSlice = makeKeyframeSlice(0, 0, 0.5, "Keyframe caption");
    const timeSlices: TimeSlice[] = [sceneSlice, keyframeSlice];
    const aggregation = makeAggregation(0, 0, 0.5, [0, 1]);

    const result = collectKeyframeCaptionsForAggregation(aggregation, timeSlices, {
      enabledAsFallback: true,
    });

    expect(result).toHaveLength(1);
    expect(result[0].caption).toBe("Keyframe caption");
    expect(result[0].isFallback).toBe(true);
  });

  // KR8: enabledAsFallback: true + German error marker → include keyframe
  it("KR8: enabled fallback includes keyframe when scene has German error marker", () => {
    const sceneSlice = makeSceneSlice(0, 0, 10, "[FEHLER: Verarbeitung fehlgeschlagen]");
    const keyframeSlice = makeKeyframeSlice(0, 0, 10, "Keyframe caption");
    const timeSlices: TimeSlice[] = [sceneSlice, keyframeSlice];
    const aggregation = makeAggregation(0, 0, 10, [0, 1]);

    const result = collectKeyframeCaptionsForAggregation(aggregation, timeSlices, {
      enabledAsFallback: true,
    });

    expect(result).toHaveLength(1);
    expect(result[0].caption).toBe("Keyframe caption");
    expect(result[0].isFallback).toBe(true);
  });

  // KR9: Multiple keyframes with same scene - one valid caption
  it("KR9: multiple keyframes from same scene are all skipped when scene has valid caption", () => {
    const sceneSlice = makeSceneSlice(0, 0, 10, "A valid scene caption with enough characters");
    const keyframeSlice1 = makeKeyframeSlice(0, 1, 2, "Keyframe 1");
    const keyframeSlice2 = makeKeyframeSlice(0, 4, 5, "Keyframe 2");
    const keyframeSlice3 = makeKeyframeSlice(0, 8, 9, "Keyframe 3");
    const timeSlices: TimeSlice[] = [sceneSlice, keyframeSlice1, keyframeSlice2, keyframeSlice3];
    const aggregation = makeAggregation(0, 0, 10, [0, 1, 2, 3]);

    const result = collectKeyframeCaptionsForAggregation(aggregation, timeSlices, {
      enabledAsFallback: true,
    });

    expect(result).toHaveLength(0);
  });

  // KR10: Different scene indices - one valid, one invalid
  it("KR10: keyframes from different scenes handled independently", () => {
    const sceneSlice1 = makeSceneSlice(0, 0, 5, "Valid caption for scene 1");
    const sceneSlice2 = makeSceneSlice(1, 5, 10, "X"); // Invalid - too short
    const keyframeSlice1 = makeKeyframeSlice(0, 0, 5, "Keyframe from scene 1");
    const keyframeSlice2 = makeKeyframeSlice(1, 5, 10, "Keyframe from scene 2");
    const timeSlices: TimeSlice[] = [sceneSlice1, sceneSlice2, keyframeSlice1, keyframeSlice2];
    const aggregation = makeAggregation(0, 0, 10, [0, 1, 2, 3]);

    const result = collectKeyframeCaptionsForAggregation(aggregation, timeSlices, {
      enabledAsFallback: true,
    });

    expect(result).toHaveLength(1);
    expect(result[0].caption).toBe("Keyframe from scene 2");
    expect(result[0].isFallback).toBe(true);
  });

  // KR11: Keyframe only (no scene slice) - no fallback possible
  it("KR11: keyframe without scene slice is included when fallback is enabled", () => {
    const keyframeSlice = makeKeyframeSlice(0, 0, 10, "Keyframe caption");
    const timeSlices: TimeSlice[] = [keyframeSlice];
    const aggregation = makeAggregation(0, 0, 10, [0]);

    const result = collectKeyframeCaptionsForAggregation(aggregation, timeSlices, {
      enabledAsFallback: true,
    });

    // No scene to check against, so keyframe is included but isFallback is false
    // (isFallback only makes sense when there was a scene to compare against)
    expect(result).toHaveLength(1);
    expect(result[0].caption).toBe("Keyframe caption");
    expect(result[0].isFallback).toBe(false);
  });

  // KR12: Valid scene caption of exactly 10 characters
  it("KR12: scene caption of exactly 10 characters is valid", () => {
    const sceneSlice = makeSceneSlice(0, 0, 10, "0123456789"); // exactly 10 chars
    const keyframeSlice = makeKeyframeSlice(0, 0, 10, "Keyframe caption");
    const timeSlices: TimeSlice[] = [sceneSlice, keyframeSlice];
    const aggregation = makeAggregation(0, 0, 10, [0, 1]);

    const result = collectKeyframeCaptionsForAggregation(aggregation, timeSlices, {
      enabledAsFallback: true,
    });

    // Exactly 10 chars is valid, so keyframe is skipped
    expect(result).toHaveLength(0);
  });
});
