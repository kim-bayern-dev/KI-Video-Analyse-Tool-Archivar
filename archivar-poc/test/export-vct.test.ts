/**
 * Unit tests for the vision-caption → VCT segment mapping (src/rpc/export.ts).
 *
 * Pure: builds AllResultsEvent[] by hand (no filesystem/cache) and verifies
 * the VCT export selects scene + sceneKeyframe events (vision captions) with
 * their exact clip timings, and excludes speech/aggregations/noise.
 */

import { describe, expect, it } from "vitest";
import { visionCaptionEventsToSegments, type AllResultsEvent } from "../src/rpc/export";
import { toSrt } from "../src/lib/srt";

describe("visionCaptionEventsToSegments", () => {
  it("selects only scene + sceneKeyframe events", () => {
    const events: AllResultsEvent[] = [
      { timeMs: 0, startMs: 0, endMs: 6_000, type: "scene", caption: "# Bildbeschreibung\nA wide shot." },
      { timeMs: 1_000, startMs: 1_000, endMs: 2_000, type: "speech", caption: "Hello." },
      { timeMs: 1_200, startMs: 1_200, endMs: 1_600, type: "sceneKeyframe", caption: "# Keyframe\nClose-up." },
      { timeMs: 3_000, startMs: 3_000, endMs: 5_000, type: "noise", caption: "wind" },
      { timeMs: 3_000, startMs: 3_000, endMs: 5_000, type: "semanticAggregation", caption: "Agg." },
    ];

    const segments = visionCaptionEventsToSegments(events);
    expect(segments).toEqual([
      { from: 0, to: 6_000, text: "# Bildbeschreibung\nA wide shot." },
      { from: 1_200, to: 1_600, text: "# Keyframe\nClose-up." },
    ]);
  });

  it("uses the scene's own start/end timing", () => {
    const events: AllResultsEvent[] = [
      { timeMs: 225, startMs: 225, endMs: 6_150, type: "scene", caption: "# Bildbeschreibung\nMarkdown content." },
    ];

    const segments = visionCaptionEventsToSegments(events);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toEqual({ from: 225, to: 6_150, text: "# Bildbeschreibung\nMarkdown content." });
  });

  it("renders valid SRT structure with Markdown content via toSrt", () => {
    const events: AllResultsEvent[] = [
      { timeMs: 225, startMs: 225, endMs: 6_150, type: "scene", caption: "# Bildbeschreibung\nA detailed description." },
      { timeMs: 7_000, startMs: 7_000, endMs: 12_000, type: "sceneKeyframe", caption: "# Keyframe\nAnother caption." },
    ];

    const srt = toSrt(visionCaptionEventsToSegments(events));
    // SRT index numbering + timeframe format
    expect(srt).toContain("1\n00:00:00,225 --> 00:00:06,150\n# Bildbeschreibung");
    expect(srt).toContain("2\n00:00:07,000 --> 00:00:12,000\n# Keyframe");
  });

  it("returns empty array when there are no vision captions", () => {
    const events: AllResultsEvent[] = [
      { timeMs: 1_000, startMs: 1_000, endMs: 2_000, type: "speech", caption: "audio only" },
      { timeMs: 3_000, startMs: 3_000, endMs: 5_000, type: "noise", caption: "wind" },
    ];
    expect(visionCaptionEventsToSegments(events)).toEqual([]);
    expect(toSrt(visionCaptionEventsToSegments(events))).toBe("\n");
  });

  it("does NOT include semantic aggregations", () => {
    const events: AllResultsEvent[] = [
      { timeMs: 0, startMs: 0, endMs: 5_000, type: "scene", caption: "scene caption" },
      { timeMs: 0, startMs: 0, endMs: 5_000, type: "semanticAggregation", caption: "aggregation summary" },
    ];
    const segments = visionCaptionEventsToSegments(events);
    expect(segments).toHaveLength(1);
    expect(segments[0].text).toBe("scene caption");
  });
});
