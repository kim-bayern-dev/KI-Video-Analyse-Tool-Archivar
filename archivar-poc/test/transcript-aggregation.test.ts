import { describe, it, expect } from "vitest";
import type { TimeSlice, SemanticAggregation, FileRef } from "../src/lib/plugin-types";
import { collectSpeechTranscriptsForAggregation } from "../plugins/default";

/** Creates a minimal TimeSliceV3 for testing */
function createSlice(
  type: "scene" | "speech" | "keyframe",
  fromSeconds: number,
  toSeconds: number,
  caption = "test transcript",
): TimeSlice {
  return {
    id: `${type}:0:0:${fromSeconds}-${toSeconds}`,
    index: 0,
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

/** Creates a minimal SemanticAggregationV3 for testing */
function createAggregation(
  fromSeconds: number,
  toSeconds: number,
): SemanticAggregation {
  return {
    id: "test:aggregation:0",
    pluginName: "test",
    index: 0,
    sliceIndexes: [],
    sliceIds: [],
    from: String(fromSeconds),
    to: String(toSeconds),
    fromSeconds,
    toSeconds,
  };
}

describe("collectSpeechTranscriptsForAggregation", () => {
  it("returns empty array when no speech slices overlap", () => {
    const agg = createAggregation(100, 200);
    const slices: TimeSlice[] = [
      createSlice("scene", 50, 60),
      createSlice("speech", 10, 20, "before"),
      createSlice("speech", 300, 310, "after"),
    ];

    const result = collectSpeechTranscriptsForAggregation(agg, slices);
    expect(result).toHaveLength(0);
  });

  it("includes speech slice fully within aggregation range", () => {
    const agg = createAggregation(100, 200);
    const slices: TimeSlice[] = [
      createSlice("speech", 120, 150, "inside transcript"),
    ];

    const result = collectSpeechTranscriptsForAggregation(agg, slices);
    expect(result).toHaveLength(1);
    expect(result[0].transcript).toBe("inside transcript");
  });

  it("includes speech slice partially overlapping at start", () => {
    const agg = createAggregation(100, 200);
    const slices: TimeSlice[] = [
      createSlice("speech", 80, 120, "overlapping start"),
    ];

    const result = collectSpeechTranscriptsForAggregation(agg, slices);
    expect(result).toHaveLength(1);
    expect(result[0].transcript).toBe("overlapping start");
  });

  it("includes speech slice partially overlapping at end", () => {
    const agg = createAggregation(100, 200);
    const slices: TimeSlice[] = [
      createSlice("speech", 180, 220, "overlapping end"),
    ];

    const result = collectSpeechTranscriptsForAggregation(agg, slices);
    expect(result).toHaveLength(1);
    expect(result[0].transcript).toBe("overlapping end");
  });

  it("includes speech slice that spans the entire aggregation", () => {
    const agg = createAggregation(100, 200);
    const slices: TimeSlice[] = [
      createSlice("speech", 50, 250, "spanning"),
    ];

    const result = collectSpeechTranscriptsForAggregation(agg, slices);
    expect(result).toHaveLength(1);
    expect(result[0].transcript).toBe("spanning");
  });

  it("excludes speech slice entirely before aggregation", () => {
    const agg = createAggregation(100, 200);
    const slices: TimeSlice[] = [
      createSlice("speech", 10, 90, "before"),
    ];

    const result = collectSpeechTranscriptsForAggregation(agg, slices);
    expect(result).toHaveLength(0);
  });

  it("excludes speech slice entirely after aggregation", () => {
    const agg = createAggregation(100, 200);
    const slices: TimeSlice[] = [
      createSlice("speech", 210, 300, "after"),
    ];

    const result = collectSpeechTranscriptsForAggregation(agg, slices);
    expect(result).toHaveLength(0);
  });

  it("excludes scene slices even when overlapping", () => {
    const agg = createAggregation(100, 200);
    const slices: TimeSlice[] = [
      createSlice("scene", 110, 130, "not a transcript"),
      createSlice("keyframe", 140, 141, "also not"),
    ];

    const result = collectSpeechTranscriptsForAggregation(agg, slices);
    expect(result).toHaveLength(0);
  });

  it("returns multiple speech slices sorted chronologically", () => {
    const agg = createAggregation(100, 200);
    const slices: TimeSlice[] = [
      createSlice("speech", 150, 160, "second"),
      createSlice("speech", 100, 110, "first"),
      createSlice("speech", 180, 190, "third"),
    ];

    const result = collectSpeechTranscriptsForAggregation(agg, slices);
    expect(result).toHaveLength(3);
    expect(result[0].transcript).toBe("first");
    expect(result[1].transcript).toBe("second");
    expect(result[2].transcript).toBe("third");
  });

  it("handles exact boundary alignment (speech ends where agg starts)", () => {
    const agg = createAggregation(100, 200);
    const slices: TimeSlice[] = [
      // speech ends exactly when aggregation starts - overlap: toSeconds(100) >= fromSeconds(100)
      createSlice("speech", 90, 100, "boundary start"),
    ];

    const result = collectSpeechTranscriptsForAggregation(agg, slices);
    expect(result).toHaveLength(1);
    expect(result[0].transcript).toBe("boundary start");
  });

  it("handles exact boundary alignment (speech starts where agg ends)", () => {
    const agg = createAggregation(100, 200);
    const slices: TimeSlice[] = [
      // speech starts exactly when aggregation ends - overlap: fromSeconds(200) <= toSeconds(200)
      createSlice("speech", 200, 210, "boundary end"),
    ];

    const result = collectSpeechTranscriptsForAggregation(agg, slices);
    expect(result).toHaveLength(1);
    expect(result[0].transcript).toBe("boundary end");
  });

  it("preserves from/to formatted time strings from slices", () => {
    const agg = createAggregation(100, 200);
    const slice = createSlice("speech", 120, 150, "test");
    slice.from = "00:02:00";
    slice.to = "00:02:30";

    const result = collectSpeechTranscriptsForAggregation(agg, [slice]);
    expect(result).toHaveLength(1);
    expect(result[0].from).toBe("00:02:00");
    expect(result[0].to).toBe("00:02:30");
  });
});
