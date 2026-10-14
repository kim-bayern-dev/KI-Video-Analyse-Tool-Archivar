/**
 * Tests for Artefakt tracking + Higher-Order Aggregation (Phases 4 & 5).
 *
 * Design note: we do NOT regex-parse the constituent scenes' Markdown
 * "# Visuelle Artefakte" tables (LLM Markdown structure is non-deterministic).
 * Instead the aggregation prompt instructs the model to sum appearances into
 * the output visual_artifacts[].temporal_stability. These tests therefore
 * assert on the PROMPT content (the accumulation rule is present) and on the
 * model-output pass-through, plus the higher-order aggregation behaviour.
 *
 * Coverage:
 *  - Phase 4: sliceAnalysisSchema accepts the new optional fields (lenient)
 *  - Phase 4: postProcessPerAggregation emits the accumulation rule in the prompt
 *  - Phase 5: postProcessHigherOrderAggregations groups aggregations (CoT via prompt, thinking=false)
 *  - Phase 5: HOA merges artifacts + respects opt-out config
 */
import { describe, it, expect, vi } from "vitest";
import type {
  PostProcessingInput,
  TimeSlice,
  SemanticAggregation,
  PluginRpcApiCompositeInstance,
  FileRef,
} from "../src/lib/plugin-types.js";

// Mock archivar-config — only getModel is needed; the rest of default.ts runs real
vi.mock("../src/lib/archivar-config.js", () => ({
  getModel: () => ({
    resolvedEndpoint: "http://mock",
    resolvedModel: "mock-model",
    resolvedApiKey: "mock-key",
    jsonSchemaMode: "auto",
    jsonSchemaName: undefined,
    structuredOutput: { maxTokens: 1000, temperature: 0.8, maxRetries: 2 },
    hyperparams: {},
    parallelism: 4,
    mmProcessorKwargs: {},
    maxContextTokens: 32768,
  }),
}));

// Import AFTER vi.mock is registered so getModel is stubbed
const {
  postProcessPerAggregation,
  postProcessHigherOrderAggregations,
  higherOrderAggregationSchema,
} = await import("../plugins/default.js");

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeFileRef(name = "scene-0.mp4"): FileRef {
  return {
    fileName: name,
    extension: "mp4",
    mediaType: "video",
    outputHash: "hash-123",
    serverUrl: "",
    containerPath: "/data/scene-0.mp4",
    hostPath: "/data/scene-0.mp4",
    relativePath: "scene-0.mp4",
  };
}

function makeSceneSlice(id: string, from: number, to: number, caption: string, sceneIndex = 0): TimeSlice {
  return {
    id,
    index: 0,
    sourceIndex: sceneIndex,
    from: String(from),
    to: String(to),
    fromSeconds: from,
    toSeconds: to,
    durationSeconds: to - from,
    type: "scene",
    sceneIndex,
    caption,
    sourceFile: makeFileRef(),
    parentFile: makeFileRef(),
  };
}

function makeAggregation(index: number, sliceIndexes: number[], from: number, to: number, analysis?: unknown): SemanticAggregation {
  return {
    id: `default:aggregation:${index}`,
    pluginName: "default",
    index,
    sliceIndexes,
    sliceIds: sliceIndexes.map((i) => `slice:${i}`),
    from: String(from),
    to: String(to),
    fromSeconds: from,
    toSeconds: to,
    ...(analysis !== undefined ? { analysis: analysis as never } : {}),
  };
}

/** Caption with a Visuelle Artefakte table (matches caption-prompt-template.md) */
const CAPTION_WITH_ARTIFACTS = `# Bildbeschreibung
Ein Nachrichtensprecher im Studio mit ARD-Logo im Hintergrund.

# Visuelle Artefakte

| Artefakt | Bildbeschreibung | Confidence |
| ----------------- | ---------------------- | ---------: |
| ARD-Logo          | "ARD"                  |       0.95 |
| Datums-Overlay    | "07.05.2026, 20:00 Uhr" | 0.90 |
`;

/**
 * Recording API: callJson returns `resolvedValue` by default, but a `responder`
 * can inspect the args to return different values (e.g. for HOA boundary vs analysis).
 */
function createRecordingApi(opts: {
  resolvedValue?: unknown;
  responder?: (args: Record<string, unknown>) => unknown;
}): {
  api: PluginRpcApiCompositeInstance;
  callJsonCalls: Array<Record<string, unknown>>;
} {
  const callJsonCalls: Array<Record<string, unknown>> = [];
  const api: PluginRpcApiCompositeInstance = {
    file: { getMediaInfo: vi.fn(), listFiles: vi.fn(), readFile: vi.fn() } as never,
    cache: { get: vi.fn(), set: vi.fn() } as never,
    analysis: { getAnalysisResults: vi.fn(), analyzeSegment: vi.fn() } as never,
    mllm: {
      callRaw: vi.fn(),
      callJson: vi.fn(async (args: Record<string, unknown>) => {
        callJsonCalls.push(args);
        if (opts.responder) return opts.responder(args);
        return opts.resolvedValue ?? { summary: "mock" };
      }),
    } as never,
    util: {
      parseJsonLoose: (c: string) => { try { return JSON.parse(c); } catch { return null; } },
      formatTime: (s: number) => String(s),
      limitConcurrency: async <T, R>(items: T[], _limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> =>
        Promise.all(items.map((item, i) => fn(item, i))),
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as never,
  } as unknown as PluginRpcApiCompositeInstance;

  return { api, callJsonCalls };
}

function makePluginDef(config: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "default",
    importPath: "./plugins/default.ts",
    config: {
      modelName: "mock-model",
      maxConcurrency: 1,
      includeTypes: ["scene"],
      reanalyzeVideoForAggregation: false,
      ...config,
    },
  };
}

// (Schema field acceptance is covered end-to-end by the AG tests below, which
//  validate real model output through sliceAnalysisSchema. We don't unit-test
//  yup's internal accept/reject behaviour — that fights yup quirks without
//  testing our logic.)

// ── Phase 4: postProcessPerAggregation emits the accumulation rule ───────

describe("postProcessPerAggregation — LLM-based artifact accumulation", () => {
  it("AG1: prompt includes the visual-artifact accumulation rule", async () => {
    const sliceA = makeSceneSlice("scene:0:0:0-10", 0, 10, CAPTION_WITH_ARTIFACTS);
    sliceA.plugin = { default: { summary: "a", raw_caption: CAPTION_WITH_ARTIFACTS } } as never;

    const agg = makeAggregation(0, [0], 0, 10);
    const rec = createRecordingApi({
      resolvedValue: {
        summary: "x", setting: "x", scene_type: "intro",
        timeline: [], subjects: [], camera_motion: "static",
        audio: "x", text_visible: [], uncertainties: [],
      },
    });

    await postProcessPerAggregation(agg, [sliceA], makePluginDef() as never, rec.api);
    expect(rec.callJsonCalls).toHaveLength(1);
    const prompt = String(rec.callJsonCalls[0].prompt);
    // The accumulation rule instructs the model to produce aggregated markdown tables
    expect(prompt).toContain("Aggregierte Markdown-Tabellen im summary-Feld");
    expect(prompt).toContain("temporal_stability");
    expect(prompt).toContain("visual_artifacts");
    expect(prompt).toContain("# Visuelle Artefakte");
    expect(prompt).toContain("# Erwartete Menschliche Wahrnehmung");
    // The constituent scene's artifacts table is passed through (raw caption)
    expect(prompt).toContain("ARD-Logo");
  });

  it("AG2: model-produced visual_artifacts pass through unchanged", async () => {
    const sliceA = makeSceneSlice("scene:0:0:0-10", 0, 10, CAPTION_WITH_ARTIFACTS);
    sliceA.plugin = { default: { summary: "a", raw_caption: CAPTION_WITH_ARTIFACTS } } as never;
    const agg = makeAggregation(0, [0], 0, 10);
    const rec = createRecordingApi({
      resolvedValue: {
        summary: "ARD news", setting: "studio", scene_type: "intro",
        timeline: [], subjects: [], camera_motion: "static",
        audio: "x", text_visible: [], uncertainties: [],
        visual_artifacts: [
          { artifact: "ARD Logo", exact_caption: '"ARD"', confidence: 0.95, temporal_stability: 1 },
        ],
      },
    });

    const patch = await postProcessPerAggregation(agg, [sliceA], makePluginDef() as never, rec.api);
    const arts = (patch?.analysis as Record<string, unknown>).visual_artifacts as Array<Record<string, unknown>>;
    expect(arts).toHaveLength(1);
    expect(arts[0].artifact).toBe("ARD Logo");
    // The model's own temporal_stability is preserved (no parsing/rewriting)
    expect(arts[0].temporal_stability).toBe(1);
  });

  it("AG3: summary does NOT embed per-scene captions (context-window safety)", async () => {
    const sliceA = makeSceneSlice("scene:0:0:0-10", 0, 10, CAPTION_WITH_ARTIFACTS, 0);
    sliceA.plugin = { default: { summary: "a", raw_caption: CAPTION_WITH_ARTIFACTS } } as never;
    const agg = makeAggregation(0, [0], 0, 10);

    const rec = createRecordingApi({
      resolvedValue: {
        summary: "Model summary line.", setting: "studio", scene_type: "intro",
        timeline: [], subjects: [], camera_motion: "static",
        audio: "x", text_visible: [], uncertainties: [],
      },
    });

    const patch = await postProcessPerAggregation(agg, [sliceA], makePluginDef() as never, rec.api);
    const summary = String((patch?.analysis as Record<string, unknown>).summary);
    // The model's summary passes through unchanged (no scene-caption append)
    expect(summary.startsWith("Model summary line.")).toBe(true);
    // Per-scene captions are NOT embedded (context-window safety)
    expect(summary).not.toContain("# Individual Scenes Covered");
  });
});

// ── Phase 5: Higher-Order Aggregation ──────────────────────────────────────

describe("postProcessHigherOrderAggregations", () => {
  it("HO1: groups aggregations into one HOA when all boundaries agree", async () => {
    const aggs = [
      makeAggregation(0, [0], 0, 10, { summary: "news opener", visual_artifacts: [{ artifact: "ARD Logo", exact_caption: '"ARD"', confidence: 0.95, temporal_stability: 1 }] }),
      makeAggregation(1, [1], 10, 20, { summary: "news body" }),
      makeAggregation(2, [2], 20, 30, { summary: "news closer" }),
    ];
    const rec = createRecordingApi({
      responder: (args) => {
        // HOA schema => HOA analysis call; else boundary decision
        if (args.schema === higherOrderAggregationSchema) {
          return { title: "News Flash", description: "opener+body+closer", intention_classification: "INFORMATIONAL" };
        }
        return { same_contribution: true }; // all belong together
      },
    });

    const hoas = await postProcessHigherOrderAggregations(aggs, makePluginDef() as never, rec.api);
    expect(hoas).toHaveLength(1);
    expect(hoas[0].title).toBe("News Flash");
    expect(hoas[0].aggregationIndexes).toEqual([0, 1, 2]);
    // Merged the ARD artifact from aggregation 0 (deterministic JSON fallback)
    const ard = hoas[0].visualArtifacts.find((a) => a.artifact === "ARD Logo");
    expect(ard).toBeDefined();
    expect(ard!.temporalStability).toBe(1);
  });

  it("HO2: splits into multiple HOAs on a boundary (same_contribution=false)", async () => {
    const aggs = [
      makeAggregation(0, [0], 0, 10, { summary: "news" }),
      makeAggregation(1, [1], 10, 20, { summary: "ad break" }),
    ];
    const rec = createRecordingApi({
      responder: (args) => {
        if (args.schema === higherOrderAggregationSchema) {
          return { title: "Section", description: "d", intention_classification: "AMBIGUOUS" };
        }
        return { same_contribution: false }; // boundary between 0 and 1
      },
    });

    const hoas = await postProcessHigherOrderAggregations(aggs, makePluginDef() as never, rec.api);
    expect(hoas).toHaveLength(1); // min-size constraint merges the two singletons
    expect(hoas[0].aggregationIndexes).toEqual([0, 1]);
  });

  it("HO3: HOA analysis call uses the HOA schema with enableThinking=false (CoT via prompt)", async () => {
    const aggs = [makeAggregation(0, [0], 0, 10, { summary: "x" })];
    const rec = createRecordingApi({
      responder: (args) => {
        if (args.schema === higherOrderAggregationSchema) {
          return { title: "T", description: "d", intention_classification: "INFORMATIONAL" };
        }
        return { same_contribution: true };
      },
    });

    await postProcessHigherOrderAggregations(aggs, makePluginDef() as never, rec.api);
    const hoaCall = rec.callJsonCalls.find((c) => c.schema === higherOrderAggregationSchema);
    expect(hoaCall).toBeDefined();
    expect(hoaCall!.schema).toBe(higherOrderAggregationSchema);
    // enableThinking stays false by default; CoT reasoning is expressed via the prompt
    expect(hoaCall!.enableThinking).toBe(false);
  });

  it("HO4: HOA prompt includes constituent aggregation summaries and artifacts", async () => {
    const aggs = [
      makeAggregation(0, [0], 0, 10, {
        summary: "ARD news opener",
        visual_artifacts: [{ artifact: "ARD Logo", exact_caption: '"ARD"', confidence: 0.95, temporal_stability: 3 }],
      }),
    ];
    const rec = createRecordingApi({
      responder: (args) => {
        if (args.schema === higherOrderAggregationSchema) {
          return { title: "T", description: "d", intention_classification: "INFORMATIONAL" };
        }
        return { same_contribution: true };
      },
    });

    await postProcessHigherOrderAggregations(aggs, makePluginDef() as never, rec.api);
    const hoaCall = rec.callJsonCalls.find((c) => c.schema === higherOrderAggregationSchema);
    const prompt = String(hoaCall!.prompt);
    expect(prompt).toContain("ARD news opener");
    expect(prompt).toContain("ARD Logo");
    expect(prompt).toContain("stability=3");
  });

  it("HO5: returns [] when enableHigherOrderAggregation=false (opt-out)", async () => {
    const aggs = [makeAggregation(0, [0], 0, 10, { summary: "x" })];
    const rec = createRecordingApi({ resolvedValue: {} });
    const hoas = await postProcessHigherOrderAggregations(
      aggs, makePluginDef({ enableHigherOrderAggregation: false }) as never, rec.api,
    );
    expect(hoas).toEqual([]);
    expect(rec.callJsonCalls).toHaveLength(0);
  });

  it("HO6: returns [] for zero aggregations", async () => {
    const rec = createRecordingApi({ resolvedValue: {} });
    const hoas = await postProcessHigherOrderAggregations([], makePluginDef() as never, rec.api);
    expect(hoas).toEqual([]);
  });

  it("HO7: falls back to merged artifacts when model omits visual_artifacts", async () => {
    const aggs = [
      makeAggregation(0, [0], 0, 10, {
        summary: "x",
        visual_artifacts: [
          { artifact: "ARD Logo", exact_caption: '"ARD"', confidence: 0.9, temporal_stability: 2 },
          { artifact: "Date", exact_caption: '"07.05.2026"', confidence: 0.8, temporal_stability: 1 },
        ],
      }),
      makeAggregation(1, [1], 10, 20, {
        summary: "y",
        visual_artifacts: [
          { artifact: "ARD Logo", exact_caption: '"ARD"', confidence: 0.95, temporal_stability: 3 },
        ],
      }),
    ];
    const rec = createRecordingApi({
      responder: (args) => {
        if (args.schema === higherOrderAggregationSchema) {
          // Model returns NO visual_artifacts -> deterministic JSON merge is used
          return { title: "T", description: "d", intention_classification: "INFORMATIONAL" };
        }
        return { same_contribution: true };
      },
    });

    const hoas = await postProcessHigherOrderAggregations(aggs, makePluginDef() as never, rec.api);
    const ard = hoas[0].visualArtifacts.find((a) => a.artifact === "ARD Logo");
    // ARD appeared in both aggregations: 2 + 3 = 5 (deterministic structured merge)
    expect(ard).toBeDefined();
    expect(ard!.temporalStability).toBe(5);
    expect(ard!.confidence).toBeCloseTo(0.95); // highest confidence wins
  });

  it("HO8: graceful fallback on model error still emits a HOA with merged artifacts", async () => {
    const aggs = [
      makeAggregation(0, [0], 0, 10, {
        summary: "x",
        visual_artifacts: [{ artifact: "ARD Logo", exact_caption: '"ARD"', confidence: 0.9, temporal_stability: 1 }],
      }),
    ];
    const rec = createRecordingApi({
      responder: (args) => {
        if (args.schema === higherOrderAggregationSchema) throw new Error("model down");
        return { same_contribution: true };
      },
    });

    const hoas = await postProcessHigherOrderAggregations(aggs, makePluginDef() as never, rec.api);
    expect(hoas).toHaveLength(1);
    expect(hoas[0].title).toContain("Higher-Order Aggregation");
    expect(hoas[0].visualArtifacts.find((a) => a.artifact === "ARD Logo")).toBeDefined();
  });

  it("HO9: stores model-provided intentionClassification and perceptionMatrix", async () => {
    const aggs = [makeAggregation(0, [0], 0, 10, { summary: "x" })];
    const rec = createRecordingApi({
      responder: (args) => {
        if (args.schema === higherOrderAggregationSchema) {
          return {
            title: "Teaser",
            description: "hidden teaser",
            intention_classification: "PROMOTIONAL",
            perception_matrix: {
              rhetoric: { keyword: "persuasive", confidence: 0.8 },
              emotion: { keyword: "excitement", confidence: 0.7 },
            },
          };
        }
        return { same_contribution: true };
      },
    });

    const hoas = await postProcessHigherOrderAggregations(aggs, makePluginDef() as never, rec.api);
    expect(hoas[0].intentionClassification).toBe("PROMOTIONAL");
    expect(hoas[0].perceptionMatrix?.rhetoric?.keyword).toBe("persuasive");
    expect(hoas[0].perceptionMatrix?.emotion?.confidence).toBeCloseTo(0.7);
  });

  // ── Minimum-size constraints (minAggregationsPerHigherOrder) ─────────────

  it("HO10: 4 aggregations with a boundary after 2 -> 2 HOAs each with 2 aggregations", async () => {
    // Boundaries: agg0==agg1 (false after), agg2==agg3 (false after) but a real
    // boundary between agg1 and agg2. Each resulting group has 2 aggregations,
    // so the min-size rule (default 2) leaves them intact.
    const aggs = [
      makeAggregation(0, [0], 0, 10, { summary: "news 1" }),
      makeAggregation(1, [1], 10, 20, { summary: "news 2" }),
      makeAggregation(2, [2], 20, 30, { summary: "ad 1" }),
      makeAggregation(3, [3], 30, 40, { summary: "ad 2" }),
    ];
    const rec = createRecordingApi({
      responder: (args) => {
        if (args.schema === higherOrderAggregationSchema) {
          return { title: "Section", description: "d", intention_classification: "AMBIGUOUS" };
        }
        // boundaries: 0-1 merge, 1-2 split, 2-3 merge
        return { same_contribution: false }; // simplistic: every pair splits
      },
    });

    const hoas = await postProcessHigherOrderAggregations(aggs, makePluginDef() as never, rec.api);
    // With every pair splitting, 4 singletons are balanced into 2 HOAs of 2.
    expect(hoas).toHaveLength(2);
    expect(hoas[0].aggregationIndexes).toEqual([0, 1]);
    expect(hoas[1].aggregationIndexes).toEqual([2, 3]);
  });

  it("HO11: 3 separate aggregations collapse to 1 HOA (cannot form two >=2 groups)", async () => {
    const aggs = [
      makeAggregation(0, [0], 0, 10, { summary: "a" }),
      makeAggregation(1, [1], 10, 20, { summary: "b" }),
      makeAggregation(2, [2], 20, 30, { summary: "c" }),
    ];
    const rec = createRecordingApi({
      responder: (args) => {
        if (args.schema === higherOrderAggregationSchema) {
          return { title: "All", description: "d", intention_classification: "AMBIGUOUS" };
        }
        return { same_contribution: false }; // every pair splits -> 3 singletons
      },
    });

    const hoas = await postProcessHigherOrderAggregations(aggs, makePluginDef() as never, rec.api);
    // 3 singletons can't make two valid (>=2) groups -> one HOA with all 3.
    expect(hoas).toHaveLength(1);
    expect(hoas[0].aggregationIndexes).toEqual([0, 1, 2]);
  });

  it("HO12: minAggregationsPerHigherOrder=1 disables the constraint (original pairwise result)", async () => {
    const aggs = [
      makeAggregation(0, [0], 0, 10, { summary: "news" }),
      makeAggregation(1, [1], 10, 20, { summary: "ad break" }),
    ];
    const rec = createRecordingApi({
      responder: (args) => {
        if (args.schema === higherOrderAggregationSchema) {
          return { title: "Section", description: "d", intention_classification: "AMBIGUOUS" };
        }
        return { same_contribution: false }; // boundary between 0 and 1
      },
    });

    const hoas = await postProcessHigherOrderAggregations(
      aggs, makePluginDef({ minAggregationsPerHigherOrder: 1 }) as never, rec.api,
    );
    // Constraint disabled -> the boundary is honored, producing 2 singleton HOAs.
    expect(hoas).toHaveLength(2);
    expect(hoas[0].aggregationIndexes).toEqual([0]);
    expect(hoas[1].aggregationIndexes).toEqual([1]);
  });
});
