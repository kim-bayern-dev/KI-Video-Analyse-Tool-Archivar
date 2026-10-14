/**
 * Result-view filter (src/lib/result-view.ts).
 *
 * The filtered view lets only `summary` and `higherOrderAggregations` entries
 * pass (deep allowlist); it is applied when READING a result for rendering or
 * download, never before writing.
 */
import { describe, it, expect } from "vitest";
import { filterJsonKeys, toResultView, toJsonDownload, stripAggregatedTables, summarizeProcessingTime, formatProcessingTime, formatMsAsMinSec, RESULT_VIEW_KEYS } from "../src/lib/result-view.js";
import type { AnalysisResult } from "../src/db/db.js";

describe("formatMsAsMinSec / formatProcessingTime", () => {
  it("formats a millisecond duration as zero-padded MM:SS Min.", () => {
    expect(formatMsAsMinSec(0)).toBe("00:00 Min.");
    expect(formatMsAsMinSec(20_000)).toBe("00:20 Min.");
    expect(formatMsAsMinSec(65_000)).toBe("01:05 Min.");
    expect(formatMsAsMinSec(3_661_000)).toBe("61:01 Min.");
  });

  it("renders pre/main/post/total with mm:ss and a summed total", () => {
    // 20s pre, 10s main, 15s post → total 45s
    const out = formatProcessingTime({ preProcessing: 20_000, processing: 10_000, postProcessing: 15_000, total: 45_000 });
    expect(out).toBe("00:20 Min. [pre], 00:10 Min. [main], 00:15 Min. [post], 00:45 Min. [total]");
  });

  it("no longer zeroes out sub-minute stages (the old Math.round(ms/60000) bug)", () => {
    expect(formatProcessingTime({ preProcessing: 5_000, processing: 500, postProcessing: 0, total: 5_500 }))
      .toBe("00:05 Min. [pre], 00:01 Min. [main], 00:00 Min. [post], 00:06 Min. [total]");
  });

  it("appends the RTF when present (< 1 = faster than real-time)", () => {
    expect(formatProcessingTime({ preProcessing: 5_000, processing: 0, postProcessing: 0, total: 5_000, rtf: 0.5 }))
      .toBe("00:05 Min. [pre], 00:00 Min. [main], 00:00 Min. [post], 00:05 Min. [total], 0.50x [rtf]");
  });

  it("omits RTF when undefined (no media duration)", () => {
    expect(formatProcessingTime({ preProcessing: 5_000, processing: 0, postProcessing: 0, total: 5_000 }))
      .toBe("00:05 Min. [pre], 00:00 Min. [main], 00:00 Min. [post], 00:05 Min. [total]");
  });
});

describe("filterJsonKeys", () => {
  it("keeps allowed keys verbatim at any depth, including ancestor paths", () => {
    const input = {
      postProcessing: {
        default: { pluginName: "default", errors: [], summary: { title: "T" } },
        qa: { summary: { title: "T2" }, timeSlices: [1, 2] },
      },
    };
    expect(filterJsonKeys(input, RESULT_VIEW_KEYS)).toEqual({
      postProcessing: {
        default: { summary: { title: "T" } },
        qa: { summary: { title: "T2" } },
      },
    });
  });

  it("keeps an allowed key's whole subtree verbatim (no recursion inside)", () => {
    const input = { summary: { title: "T", other: { nested: true } } };
    expect(filterJsonKeys(input, RESULT_VIEW_KEYS)).toEqual(input);
  });

  it("drops keys without any allowed descendant", () => {
    const input = { scenes: [{ caption: "x", speech: [{ caption: "y" }] }], timing: { ms: 1 } };
    expect(filterJsonKeys(input, RESULT_VIEW_KEYS)).toBeUndefined();
  });

  it("keeps surviving array elements and drops empty ones", () => {
    const input = { items: [{ summary: "a" }, { caption: "b" }, { summary: "c" }] };
    expect(filterJsonKeys(input, RESULT_VIEW_KEYS)).toEqual({ items: [{ summary: "a" }, { summary: "c" }] });
  });

  it("keeps an allowed key verbatim even when its value is empty", () => {
    expect(filterJsonKeys({ higherOrderAggregations: [] }, RESULT_VIEW_KEYS)).toEqual({ higherOrderAggregations: [] });
  });

  it("drops primitives that are not under an allowed key", () => {
    expect(filterJsonKeys("text", RESULT_VIEW_KEYS)).toBeUndefined();
    expect(filterJsonKeys({ fileName: "a.mp4" }, RESULT_VIEW_KEYS)).toBeUndefined();
  });
});

describe("toResultView", () => {
  it("reduces an AnalysisResult to summaries and higher-order aggregations", () => {
    const result = {
      serverUrl: "http://x",
      fileName: "a.mp4",
      extension: ".mp4",
      outputHash: "hash",
      mediaType: "video",
      scenes: [{ index: 0, startTime: 0, endTime: 1, caption: "scene" }],
      semanticAggregations: [
        { id: "agg-1", index: 0, fromSeconds: 0, toSeconds: 5, summary: "agg summary" },
      ],
      higherOrderAggregations: [
        { id: "hoa-1", index: 0, title: "HOA", description: "d", aggregationIndexes: [0], visualArtifacts: [] },
      ],
      postProcessing: { default: { pluginName: "default", summary: { title: "T" }, errors: [] } },
      timing: { ms: 1 },
    } as unknown as AnalysisResult;

    const view = toResultView(result);

    // summaries pass (postProcessing path preserved)
    expect(view.postProcessing).toEqual({ default: { summary: { title: "T" } } });
    // higher-order aggregations pass verbatim
    expect(view.higherOrderAggregations).toEqual(result.higherOrderAggregations);
    // scenes / timing / identity fields are gone
    expect(view.scenes).toBeUndefined();
    expect(view.timing).toBeUndefined();
    expect(view.outputHash).toBeUndefined();
    // semantic aggregations survive only as { summary } fragments (no timing/id)
    expect(view.semanticAggregations).toEqual([{ summary: "agg summary" }]);
  });

  it("returns an empty object when nothing passes", () => {
    const result = { scenes: [] } as unknown as AnalysisResult;
    expect(toResultView(result)).toEqual({});
  });
});

describe("stripAggregatedTables", () => {
  const description = [
    "Prose paragraph about the section.",
    "",
    "# Visuelle Artefakte",
    "| Artefakt | Bildbeschreibung | Confidence |",
    "|---|---|---|",
    "| Logo | Sichtbar | 0.9 |",
    "",
    "# Erwartete Menschliche Wahrnehmung",
    "| Kategorie | Schlüsselwörter | Confidence |",
    "|---|---|---|",
    "| Emotion | Freude | 0.95 |",
  ].join("\n");

  it("removes German table sections and keeps the prose", () => {
    expect(stripAggregatedTables(description)).toBe("Prose paragraph about the section.");
  });

  it("removes English heading variants", () => {
    const input = "Prose.\n\n## Visual Artifacts\n| a | b |\n\n## Human Perception Matrix\n| c | d |";
    expect(stripAggregatedTables(input)).toBe("Prose.");
  });

  it("keeps following sections of the same or higher level", () => {
    const input = "Prose.\n\n# Visuelle Artefakte\n| a | b |\n\n# Intention\nPromotional.";
    expect(stripAggregatedTables(input)).toBe("Prose.\n\n# Intention\nPromotional.");
  });

  it("is a no-op without matching headings", () => {
    const input = "Just prose.\n\n# Something else\nMore prose.";
    expect(stripAggregatedTables(input)).toBe(input);
  });
});

describe("toResultView HOA table stripping", () => {
  it("strips HOA description tables top-level and under postProcessing, without mutating the input", () => {
    const hoaDescription = "Prose.\n\n# Visuelle Artefakte\n| a | b |";
    const result = {
      scenes: [],
      higherOrderAggregations: [{ id: "h1", index: 0, title: "H1", description: hoaDescription }],
      postProcessing: {
        default: {
          summary: { title: "T" },
          higherOrderAggregations: [{ id: "h2", index: 0, title: "H2", description: hoaDescription }],
        },
      },
    } as unknown as AnalysisResult;

    const view = toResultView(result) as unknown as {
      higherOrderAggregations: { description: string }[];
      postProcessing: { default: { higherOrderAggregations: { description: string }[] } };
    };

    expect(view.higherOrderAggregations[0].description).toBe("Prose.");
    expect(view.postProcessing.default.higherOrderAggregations[0].description).toBe("Prose.");
    // input untouched
    expect(result.higherOrderAggregations![0].description).toBe(hoaDescription);
  });
});

describe("toJsonDownload", () => {
  it("picks exactly the summary fields in order and reduces HOAs to {title, summary}", () => {
    const result = {
      scenes: [{ caption: "x" }],
      higherOrderAggregations: [{ title: "TOP", description: "top prose" }],
      postProcessing: {
        default: {
          pluginName: "default",
          summary: {
            long_summary: "long",
            title: "T",
            perception_matrix: { internal: true },
            qualityAttributes: { quality: "high" },
            abstract: "abs",
            keywords: ["k1"],
            tags: ["t1"],
            categorization: "Werbung",
            overallIntention: "PROMOTIONAL",
            short_description: "short",
            narrativeArc: "arc",
            perceptionArc: "perc",
          },
          higherOrderAggregations: [
            { id: "h1", index: 0, title: "H1", description: "Prose.\n\n# Visuelle Artefakte\n| a | b |", visualArtifacts: [] },
          ],
        },
      },
    } as unknown as AnalysisResult;

    const view = toJsonDownload(result);

    expect(Object.keys(view)).toEqual([
      "title", "abstract", "keywords", "tags", "categorization", "overallIntention",
      "short_description", "long_summary", "narrativeArc", "perceptionArc",
      "higherOrderAggregations",
    ]);
    expect(view.perception_matrix).toBeUndefined();
    expect(view.qualityAttributes).toBeUndefined();
    expect(view.higherOrderAggregations).toEqual([{ title: "H1", summary: "Prose." }]);
  });

  it("falls back to top-level higherOrderAggregations", () => {
    const result = {
      postProcessing: { default: { summary: { title: "T" } } },
      higherOrderAggregations: [{ title: "TOP", description: "top prose" }],
    } as unknown as AnalysisResult;

    expect(toJsonDownload(result).higherOrderAggregations).toEqual([{ title: "TOP", summary: "top prose" }]);
  });

  it("tolerates missing postProcessing.default", () => {
    const result = { scenes: [] } as unknown as AnalysisResult;
    expect(toJsonDownload(result)).toEqual({ higherOrderAggregations: [] });
  });
});

describe("summarizeProcessingTime", () => {
  it("sums top-level timing children into pre/main/post stages", () => {
    const result = {
      timing: {
        label: "workflow:x",
        durationMs: 100,
        children: [
          { label: "preProcessing", durationMs: 50 },
          { label: "processing", durationMs: 25 },
          { label: "aggregation", durationMs: 1 },
          { label: "plugin:default", durationMs: 20 },
          { label: "summary", durationMs: 4 },
        ],
      },
    } as unknown as AnalysisResult;

    expect(summarizeProcessingTime(result)).toEqual({
      preProcessing: 50,
      processing: 25,
      postProcessing: 25,
      total: 100,
    });
  });

  it("returns null without timing children", () => {
    expect(summarizeProcessingTime({ scenes: [] } as unknown as AnalysisResult)).toBeNull();
  });
});

describe("toJsonDownload metadata", () => {
  it("prepends models/processingTime/fileName/workflow/exportTime before the summary fields", () => {
    const result = {
      postProcessing: { default: { summary: { title: "T" } } },
      higherOrderAggregations: [],
    } as unknown as AnalysisResult;

    const view = toJsonDownload(result, {
      fileName: "a.mp4",
      workflow: "wf",
      exportTime: "28.7.2026, 19:57:04",
      models: { asr: "asr-model", vlm: "vlm-model" },
      processingTime: { preProcessing: 1, processing: 2, postProcessing: 3, total: 6 },
    });

    expect(Object.keys(view)).toEqual([
      "models", "processingTime", "fileName", "workflow", "exportTime",
      "title", "higherOrderAggregations",
    ]);
    expect(view.models).toEqual({ asr: "asr-model", vlm: "vlm-model" });
    expect(view.processingTime).toEqual({ preProcessing: 1, processing: 2, postProcessing: 3, total: 6 });
    expect(view.fileName).toBe("a.mp4");
    expect(view.workflow).toBe("wf");
    expect(view.exportTime).toBe("28.7.2026, 19:57:04");
  });

  it("includes tokenUsage when provided in the meta", () => {
    const result = {
      postProcessing: { default: { summary: { title: "T" } } },
      higherOrderAggregations: [],
    } as unknown as AnalysisResult;

    const view = toJsonDownload(result, {
      fileName: "a.mp4",
      workflow: "wf",
      exportTime: "now",
      models: { asr: "asr-model", vlm: "vlm-model" },
      processingTime: { preProcessing: 1, processing: 2, postProcessing: 3, total: 6 },
      tokenUsage: { input: 100, output: 50, total: 150 },
    });

    expect(view.tokenUsage).toEqual({ input: 100, output: 50, total: 150 });
  });

  it("includes nonFatalErrors when provided in the meta", () => {
    const result = {
      postProcessing: { default: { summary: { title: "T" } } },
      higherOrderAggregations: [],
    } as unknown as AnalysisResult;

    const nfe = { count: 2, trace: [{ reason: "schema", model: "m", details: "validation failed" }] };
    const view = toJsonDownload(result, {
      fileName: "a.mp4",
      workflow: "wf",
      exportTime: "now",
      models: { asr: "asr-model", vlm: "vlm-model" },
      nonFatalErrors: nfe as any,
    });

    expect(view.nonFatalErrors).toEqual(nfe);
  });
});
