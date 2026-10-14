/**
 * Tests for the lean dashboard payload shapers
 * ([`src/lib/analysis-view.ts`](../src/lib/analysis-view.ts)): per-hash caption
 * extraction and the reduced per-file analysis view.
 */
import { describe, it, expect } from "vitest";
import type { AnalysisResult } from "../src/db/db";
import { extractCaptionsByHash, buildAnalysisView } from "../src/lib/analysis-view";

describe("extractCaptionsByHash", () => {
  const tables: Record<string, { caption?: unknown }>[] = [
    {
      "abc123-0": { caption: "scene zero" },
      "abc123-1": { caption: "" },               // empty → skipped
      "abc123-2": { caption: 42 },               // non-string → skipped
      "other99-0": { caption: "other file" },    // other hash → skipped
    },
    {
      "abc123-speech-0": { caption: "speech caption" },
      "abc123-keyframe-3": { caption: "keyframe caption" },
      "abc123-harmonic-0": { caption: "harmonic caption" },
      "abc123-noise-1": { caption: "  " },       // whitespace-only → skipped
    },
  ];

  it("keeps only non-empty captions whose key contains the hash", () => {
    expect(extractCaptionsByHash(tables, "abc123")).toEqual({
      "abc123-0": "scene zero",
      "abc123-speech-0": "speech caption",
      "abc123-keyframe-3": "keyframe caption",
      "abc123-harmonic-0": "harmonic caption",
    });
  });

  it("returns an empty map when nothing matches", () => {
    expect(extractCaptionsByHash(tables, "nope")).toEqual({});
  });
});

describe("buildAnalysisView", () => {
  it("returns an empty view for a missing result", () => {
    const view = buildAnalysisView(null, null);
    expect(view.key).toBeNull();
    expect(view.scenes).toEqual([]);
    expect(view.resultView).toBeNull();
    expect(view.processingTime).toBeNull();
  });

  const fixture = {
    serverUrl: "http://x/file.mp4",
    fileName: "file.mp4",
    extension: ".mp4",
    outputHash: "abc123",
    mediaType: "video",
    scenes: [
      {
        index: 0, startTime: 0, endTime: 10,
        serverUrl: "http://x/scene0.mp4", fileName: "scene0.mp4", extension: ".mp4",
        outputHash: "abc123", mediaType: "video",
        caption: "scene caption",
        speech: [{ index: 0, startTime: 1, endTime: 5, caption: "hello", fileName: "s.mp3", extension: ".mp3", outputHash: "abc123", serverUrl: "http://x/s.mp3" }],
        keyframes: [],
        harmonic: [{ index: 0, startTime: 0, endTime: 10, caption: "music", fileName: "h.mp3", extension: ".mp3", outputHash: "abc123", serverUrl: "http://x/h.mp3" }],
        noise: [],
      },
    ],
    semanticAggregations: [
      { id: "default:aggregation:0", pluginName: "default", index: 0, sliceIndexes: [], sliceIds: [], from: "00:00", to: "00:10", fromSeconds: 0, toSeconds: 10, summary: { summary: "nested summary" } },
      { id: "default:aggregation:1", pluginName: "default", index: 1, sliceIndexes: [], sliceIds: [], from: "00:10", to: "00:20", fromSeconds: 10, toSeconds: 20, summary: "plain summary" },
    ],
    higherOrderAggregations: [
      { id: "default:higherOrderAggregation:0", index: 0, title: "Macro", description: "prose\n\n# Visuelle Artefakte\n\n| a | b |\n| - | - |\n\nmore", aggregationIndexes: [0, 1], visualArtifacts: [], perceptionMatrix: {}, intentionClassification: "INFORMATIONAL" },
    ],
    postProcessing: { default: { summary: { title: "T" } } },
    timing: { label: "workflow:x", durationMs: 10000, children: [
      { label: "preProcessing", durationMs: 2000, children: [] },
      { label: "processing", durationMs: 5000, children: [] },
      { label: "plugin:default", durationMs: 3000, children: [] },
    ] },
    tokenUsage: { input: 10, output: 5, total: 15 },
    nonFatalErrors: { count: 0, trace: [] },
  } as unknown as AnalysisResult;

  it("reduces the result to the lean dashboard shape", () => {
    const view = buildAnalysisView(fixture, "agg-key-1");
    expect(view.key).toBe("agg-key-1");

    // scenes: lean, no per-segment URLs/metadata
    expect(view.scenes).toHaveLength(1);
    const scene = view.scenes[0];
    expect(scene).toMatchObject({ index: 0, startTime: 0, endTime: 10, caption: "scene caption" });
    expect(scene.speech).toEqual([{ index: 0, startTime: 1, endTime: 5, caption: "hello" }]);
    expect(scene.harmonic).toEqual([{ index: 0, startTime: 0, endTime: 10, caption: "music" }]);
    expect(JSON.stringify(view.scenes)).not.toContain("serverUrl");
    expect(JSON.stringify(view.scenes)).not.toContain("outputHash");

    // aggregations: both summary forms flattened
    expect(view.semanticAggregations.map((a) => a.summary)).toEqual(["nested summary", "plain summary"]);
    expect(view.semanticAggregations[0]).toMatchObject({ id: "default:aggregation:0", fromSeconds: 0, toSeconds: 10 });

    // HOAs: only the timeline fields
    expect(view.higherOrderAggregations).toEqual([
      { id: "default:higherOrderAggregation:0", index: 0, aggregationIndexes: [0, 1], title: "Macro" },
    ]);

    // filtered summary view present, HOA description tables stripped
    const viewHoa = (view.resultView as unknown as { higherOrderAggregations: Array<{ description: string }> }).higherOrderAggregations[0];
    expect(viewHoa.description).not.toContain("Visuelle Artefakte");
    expect(viewHoa.description).toContain("prose");

    // provenance
    expect(view.processingTime).toMatchObject({ preProcessing: 2000, processing: 5000, postProcessing: 3000, total: 10000 });
    expect(view.processingTime?.rtf).toBeCloseTo(10000 / 10000, 5); // 10s work / 10s media
    expect(view.tokenUsage).toEqual({ input: 10, output: 5, total: 15 });
    expect(view.nonFatalErrors).toEqual({ count: 0, trace: [] });
  });
});
