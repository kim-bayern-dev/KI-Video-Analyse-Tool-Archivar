import { describe, it, expect, vi } from "vitest";
import * as yup from "yup";
import { dedupePromptText, DEDUP_NOTE, postProcessPerAggregation, MERGE_PARTIAL_ANALYSES_PROMPT } from "../plugins/default.js";
import { stripSingletonMarkers, stripSingletonMarkersDeep } from "../src/lib/prompt-dedupe.js";
import { setArchivarConfig } from "../src/lib/archivar-config.js";
import type { PluginRpcApiCompositeInstance } from "../src/lib/plugin-types";

// ---------------------------------------------------------------------------
// dedupePromptText
// ---------------------------------------------------------------------------
describe("dedupePromptText", () => {
  it("removes duplicate content lines but keeps table structure intact", () => {
    const table = `# Visuelle Artefakte
| Artefakt | Beschreibung | Confidence |
| --- | --- | --- |
| Logo | weiß | 1.0 |
| Preis | 29,99 € | 0.9 |`;
    const input = `${table}\n\n${table}`;
    const out = dedupePromptText(input);
    // The second, fully duplicated table vanishes entirely (no dangling empty table)
    expect(out.match(/\| Artefakt \|/g)).toHaveLength(1);
    expect(out.match(/\| Logo \|/g)).toHaveLength(1);
    expect(out.match(/\| Preis \|/g)).toHaveLength(1);
  });

  it("keeps the table when only some data rows are duplicates", () => {
    const input = `| A | B |
| --- | --- |
| r1 | x |
| r2 | y |

| A | B |
| --- | --- |
| r1 | x |
| r3 | z |`;
    const out = dedupePromptText(input);
    // both tables stay (each has a unique data row), r1 appears once
    expect(out.match(/\| A \| B \|/g)).toHaveLength(2);
    expect(out.match(/\| r1 \|/g)).toHaveLength(1);
    expect(out.match(/\| r2 \|/g)).toHaveLength(1);
    expect(out.match(/\| r3 \|/g)).toHaveLength(1);
  });

  it("keeps Schnitt markers and headers", () => {
    const input = `Schnitt 1 (Index 4):\n# Bildbeschreibung\nText A\nSchnitt 2 (Index 5):\n# Bildbeschreibung\nText A`;
    const out = dedupePromptText(input);
    expect(out.match(/Schnitt \d/g)).toHaveLength(2);
    expect(out.match(/# Bildbeschreibung/g)).toHaveLength(2);
    expect(out.match(/Text A/g)).toHaveLength(1);
  });

  it("is idempotent", () => {
    const input = "a\nb\na\nc\nb";
    expect(dedupePromptText(dedupePromptText(input))).toBe(dedupePromptText(input));
  });

  it("reduces a 73%-duplicate D1-style prompt drastically", () => {
    const block = `# Visuelle Artefakte
| A | B | C |
| --- | --- | --- |
| mw | Logo | 1.0 |
| p1 | x | 0.9 |
| p2 | y | 0.8 |
| p3 | z | 0.7 |
Some repeated caption line.
`;
    const input = Array.from({ length: 49 }, (_, i) => `Schnitt ${i + 1} (Index ${i}):\n${block}`).join("\n\n");
    const out = dedupePromptText(input);
    expect(out.length).toBeLessThan(input.length * 0.4);
    expect(out.match(/Schnitt \d+/g)).toHaveLength(49);
    expect(out.match(/\| mw \|/g)).toHaveLength(1);
    expect(out.match(/Some repeated caption line\./g)).toHaveLength(1);
  });

  it("marks deduplicated lines with their multiplicity and prepends the legend", () => {
    const input = "foo\nbar\nfoo\nfoo\nbar";
    const out = dedupePromptText(input);
    expect(out).toContain("foo (x3)");
    expect(out).toContain("bar (x2)");
    expect(out.startsWith(DEDUP_NOTE)).toBe(true);
  });

  it("marks table data rows after the closing pipe (no cell corruption)", () => {
    const input = `| A | B |\n| --- | --- |\n| r1 | x |\n\n| A | B |\n| --- | --- |\n| r1 | x |`;
    const out = dedupePromptText(input);
    expect(out).toContain("| r1 | x | (x2)");
  });

  it("leaves prompts without duplicates byte-identical (no legend, no markers)", () => {
    const input = "alpha\nbeta\n| A |\n| --- |\n| r1 |";
    expect(dedupePromptText(input)).toBe(input);
  });

  it("normalizes model-imitated (x1) singleton markers away before dedup", () => {
    const input = "foo (x1)\nfoo\n| A | B |\n| --- | --- |\n| r1 | x | (x1)";
    const out = dedupePromptText(input);
    // "foo (x1)" normalizes to "foo", making it an exact duplicate of "foo"
    expect(out).toContain("foo (x2)");
    expect(out).not.toContain("(x1)");
    // the table row loses its noise suffix
    expect(out.trimEnd().endsWith("| r1 | x |")).toBe(true);
    expect(out).not.toContain("| r1 | x | (x1)");
  });

  it("keeps repeated pure JSON-structure lines untouched (DGX Spark incident)", () => {
    // A prompt template's JSON format example repeats `  }` after every
    // object. Deduping it and marking the first `  } (x2)` made the model
    // emit the preceding object twice → "could not be parsed as JSON".
    const input = [
      '"perceptionMatrix": { "rhetoric": { "keyword": "..." } },',
      "  }",
      '"qualityAttributes": { "quality": "..." },',
      "  }",
    ].join("\n");
    const out = dedupePromptText(input);
    expect(out).not.toContain("(x2)");
    expect(out.match(/^  \}$/gm)).toHaveLength(2);
    expect(out.startsWith(DEDUP_NOTE)).toBe(false);
  });
});

describe("stripSingletonMarkers", () => {
  it("removes trailing ' (x1)' markers but keeps x≥2 and non-marker parens", () => {
    const input = "foo (x1)\nbar (x2)\nmath: f(x1)\nbaz (x12) (x1)";
    const out = stripSingletonMarkers(input);
    expect(out).toBe("foo\nbar (x2)\nmath: f(x1)\nbaz (x12)");
  });
});

describe("stripSingletonMarkersDeep", () => {
  it("strips markers in nested strings, leaves numbers/objects intact", () => {
    const input = {
      a: "foo (x1)\nbar (x2)",
      b: [{ c: "x (x1)" }, "y (x1)"],
      d: 42,
      e: null,
    };
    expect(stripSingletonMarkersDeep(input)).toEqual({
      a: "foo\nbar (x2)",
      b: [{ c: "x" }, "y"],
      d: 42,
      e: null,
    });
  });
});

// ---------------------------------------------------------------------------
// map-reduce flow in postProcessPerAggregation
// ---------------------------------------------------------------------------
const VALID_ANALYSIS = {
  summary: "s",
  setting: "studio",
  scene_type: "interview",
  timeline: [],
  subjects: [],
  camera_motion: "static",
  text_visible: [],
  uncertainties: [],
};

function makeApi() {
  const calls: Array<{ prompt: string }> = [];
  const api = {
    mllm: {
      callJson: vi.fn(async (args: { prompt: string }) => {
        calls.push({ prompt: args.prompt });
        return { ...VALID_ANALYSIS };
      }),
    },
    util: {
      limitConcurrency: async <T, R>(items: T[], _limit: number, fn: (x: T) => Promise<R>): Promise<R[]> =>
        Promise.all(items.map(fn)),
    },
  } as unknown as PluginRpcApiCompositeInstance;
  return { api, calls };
}

function makeSlices(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    type: "scene",
    from: i * 10,
    to: i * 10 + 9,
    plugin: { default: { summary: `slice ${i}`, setting: "s", scene_type: "interview", timeline: [], subjects: [], camera_motion: "static", text_visible: [], uncertainties: [] } },
  }));
}

describe("postProcessPerAggregation — map-reduce", () => {
  it("splits oversized aggregations into chunks and merges (map calls parallel-bounded)", async () => {
    // Tiny window so the full prompt always floors → map-reduce triggers.
    setArchivarConfig({
      auth: { users: [] },
      contextWindows: { maxInferenceContext: 2048 },
      models: [{ name: "test-model", type: "api", model: "test-model", estimation: { tokensPerWord: 2, tokensPerFrame: 340 } }],
    });
    const { api, calls } = makeApi();
    const patch = await postProcessPerAggregation(
      { id: "a0", index: 0, sliceIndexes: Array.from({ length: 10 }, (_, i) => i) } as never,
      makeSlices(10) as never,
      { config: { modelName: "test-model", mapReduceSlicesPerChunk: 3, maxConcurrency: 2, includeTypes: [] } } as never,
      api,
    );

    // 10 slices à 3 → 4 map calls + 1 merge call
    expect(calls).toHaveLength(5);
    const mergeCall = calls[calls.length - 1];
    expect(mergeCall.prompt).toContain("Teil 1:");
    expect(mergeCall.prompt).toContain("Teil 4:");
    // map prompts carry only their chunk's slices
    expect(calls[0].prompt).toContain("slice 0");
    expect(calls[0].prompt).not.toContain("slice 9");
    expect(patch.analysis).toBeDefined();
  });

  it("stays a single call when the prompt fits (deduped)", () => {
    setArchivarConfig({
      auth: { users: [] },
      contextWindows: { maxInferenceContext: 131072 },
      models: [{ name: "test-model", type: "api", model: "test-model", estimation: { tokensPerWord: 2, tokensPerFrame: 340 } }],
    });
    const { api, calls } = makeApi();
    return postProcessPerAggregation(
      { id: "a0", index: 0, sliceIndexes: [0, 1] } as never,
      makeSlices(2) as never,
      { config: { modelName: "test-model", mapReduceSlicesPerChunk: 8, includeTypes: [] } } as never,
      api,
    ).then(() => {
      expect(calls).toHaveLength(1);
    });
  });
});
