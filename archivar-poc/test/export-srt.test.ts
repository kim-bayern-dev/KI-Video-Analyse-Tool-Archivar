/**
 * Unit tests for the speech → SRT segment mapping (src/rpc/export.ts).
 *
 * Pure: builds AllResultsEvent[] by hand (no filesystem/cache) and verifies
 * the SRT export uses the EXACT per-clip ASR speech timings — not the coarser
 * scene/segment boundaries — and that non-speech events are excluded.
 */

import { describe, expect, it } from "vitest";
import { speechEventsToSegments, type AllResultsEvent } from "../src/rpc/export";
import { toSrt } from "../src/lib/srt";

describe("speechEventsToSegments", () => {
  it("selects only speech events, ignoring scenes/keyframes/aggregations", () => {
    const events: AllResultsEvent[] = [
      // A scene whose boundary differs from the speech clip below — must NOT leak in.
      { timeMs: 30_000, startMs: 30_000, endMs: 33_000, type: "scene", caption: "A wide shot." },
      { timeMs: 31_000, startMs: 31_000, endMs: 31_500, type: "speech", caption: "Hello." },
      { timeMs: 31_200, startMs: 31_200, endMs: 31_600, type: "sceneKeyframe", caption: "Keyframe." },
      { timeMs: 31_500, startMs: 31_500, endMs: 32_000, type: "speech", caption: "World." },
      { timeMs: 32_000, startMs: 32_000, endMs: 33_000, type: "semanticAggregation", caption: "Agg." },
    ];

    const segments = speechEventsToSegments(events);
    expect(segments).toEqual([
      { from: 31_000, to: 31_500, text: "Hello." },
      { from: 31_500, to: 32_000, text: "World." },
    ]);
  });

  it("uses the ASR clip's own start/end, not the enclosing scene timing", () => {
    // Scene spans 0–10s; the speech clip inside it is 2.5s–4.8s. The SRT must
    // carry the clip timing (2500→4820), proving segment boundaries are not used.
    const events: AllResultsEvent[] = [
      { timeMs: 0, startMs: 0, endMs: 10_000, type: "scene", caption: "scene" },
      { timeMs: 2_500, startMs: 2_500, endMs: 4_820, type: "speech", caption: "Clip transcript." },
    ];

    const segments = speechEventsToSegments(events);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toEqual({ from: 2_500, to: 4_820, text: "Clip transcript." });
  });

  it("preserves event order (feeds toSrt monotonically)", () => {
    const events: AllResultsEvent[] = [
      { timeMs: 5_000, startMs: 5_000, endMs: 6_000, type: "speech", caption: "second" },
      { timeMs: 1_000, startMs: 1_000, endMs: 2_000, type: "speech", caption: "first" },
    ];
    const segments = speechEventsToSegments(events);
    expect(segments.map((s) => s.text)).toEqual(["second", "first"]);
    // Even with unsorted input, toSrt still produces contiguous numbering in array order.
    const srt = toSrt(segments);
    expect(srt).toContain("1\n00:00:05,000 --> 00:00:06,000\nsecond");
    expect(srt).toContain("2\n00:00:01,000 --> 00:00:02,000\nfirst");
  });

  it("returns an empty array (→ empty SRT) when there is no speech", () => {
    const events: AllResultsEvent[] = [
      { timeMs: 0, startMs: 0, endMs: 5_000, type: "scene", caption: "silent scene" },
      { timeMs: 1_000, startMs: 1_000, endMs: 2_000, type: "noise", caption: "wind" },
    ];
    const segments = speechEventsToSegments(events);
    expect(segments).toEqual([]);
    expect(toSrt(segments)).toBe("\n");
  });
});
