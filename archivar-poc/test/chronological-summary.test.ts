/**
 * WS3 — sliding-window chronological summarization in summaryFromAggregations.
 *
 * When the concatenated HOA descriptions exceed maxUnifiedSummaryInputTokens,
 * the unified single-call path is replaced by sequential windows of
 * chronologicalSummaryWindowSize HOAs (overlap chronologicalSummaryWindowOverlap)
 * whose paragraphs/keywords accumulate, followed by a final unified-summary call
 * over the chronological text. These tests drive the real plugin function with
 * a scriptable mllm.callJson mock (window prompts are identified by the
 * chronological template marker; the final call uses the unified template).
 */
import { describe, it, expect, vi } from "vitest";
import type {
  HigherOrderAggregation,
  PluginRpcApiCompositeInstance,
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
const { summaryFromAggregations } = await import("../plugins/default.js");

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Marker present only in window prompts (from chronological-summary-prompt.md) */
const WINDOW_MARKER = "chronologische Zusammenfassungs-Engine";

function makeHoa(index: number, description?: string): HigherOrderAggregation {
  return {
    id: `default:higher-order:${index}`,
    index,
    title: `HOA Title ${index + 1}`,
    description: description ?? `DESC-${index + 1} Makro-Abschnitt mit Details`,
    aggregationIndexes: [index],
    visualArtifacts: [],
  };
}

function makeHoas(count: number): HigherOrderAggregation[] {
  return Array.from({ length: count }, (_, i) => makeHoa(i));
}

type WindowResponse =
  | { new_paragraphs: string[]; new_keywords?: string[] }
  | { error: string };

function createScriptedApi(opts: {
  windowResponses: WindowResponse[];
  finalResponse?: Record<string, unknown>;
}): {
  api: PluginRpcApiCompositeInstance;
  callJsonCalls: Array<Record<string, unknown>>;
  windowCalls: Array<Record<string, unknown>>;
} {
  const callJsonCalls: Array<Record<string, unknown>> = [];
  const windowCalls: Array<Record<string, unknown>> = [];
  const api = {
    file: {},
    cache: {},
    analysis: {},
    mllm: {
      callRaw: vi.fn(),
      callJson: vi.fn(async (args: Record<string, unknown>) => {
        callJsonCalls.push(args);
        const prompt = String(args.prompt);
        if (prompt.includes(WINDOW_MARKER)) {
          const response = opts.windowResponses[windowCalls.length];
          windowCalls.push(args);
          if (!response) throw new Error("unexpected window call");
          if ("error" in response) throw new Error(response.error);
          return response;
        }
        return opts.finalResponse ?? { title: "Final Title", keywords: [] };
      }),
    },
    util: {},
  } as unknown as PluginRpcApiCompositeInstance;
  return { api, callJsonCalls, windowCalls };
}

function makePluginDef(config: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "default",
    importPath: "./plugins/default.ts",
    config: { modelName: "mock-model", ...config },
  };
}

/** Tiny budget + default 4/1 windowing for the windowed-path tests */
const WINDOWED_CONFIG = {
  maxUnifiedSummaryInputTokens: 10,
  chronologicalSummaryWindowSize: 4,
  chronologicalSummaryWindowOverlap: 1,
};

function windowResponse(paragraphs: string[], keywords: string[] = []): WindowResponse {
  return { new_paragraphs: paragraphs, new_keywords: keywords };
}

// ── Budget gate ─────────────────────────────────────────────────────────────

describe("summaryFromAggregations — budget gate", () => {
  it("below budget → single unified call with raw HOA descriptions, no window calls", async () => {
    const rec = createScriptedApi({ windowResponses: [] });
    const result = await summaryFromAggregations(
      [] as never,
      makePluginDef() as never,
      rec.api,
      undefined,
      makeHoas(3),
    );
    expect(rec.callJsonCalls).toHaveLength(1);
    expect(rec.windowCalls).toHaveLength(0);
    const prompt = String(rec.callJsonCalls[0].prompt);
    expect(prompt).toContain("DESC-1");
    expect(prompt).toContain("DESC-3");
    expect(result).toEqual({ title: "Final Title", keywords: [] });
  });

  it("1 HOA below budget → single call (unchanged)", async () => {
    const rec = createScriptedApi({ windowResponses: [] });
    await summaryFromAggregations([] as never, makePluginDef() as never, rec.api, undefined, makeHoas(1));
    expect(rec.callJsonCalls).toHaveLength(1);
    expect(String(rec.callJsonCalls[0].prompt)).toContain("DESC-1");
  });

  it("0 HOAs and 0 aggregations → returns null without any model call", async () => {
    const rec = createScriptedApi({ windowResponses: [] });
    const result = await summaryFromAggregations([] as never, makePluginDef() as never, rec.api, undefined, []);
    expect(result).toBeNull();
    expect(rec.callJsonCalls).toHaveLength(0);
  });
});

// ── Window partition ────────────────────────────────────────────────────────

describe("summaryFromAggregations — sliding windows", () => {
  it("10 HOAs above budget → windows [1-4], [4-7], [7-10] + 1 final call", async () => {
    const rec = createScriptedApi({
      windowResponses: [
        windowResponse(["P1", "P2", "P3", "P4"]),
        windowResponse(["P5", "P6", "P7"]),
        windowResponse(["P8", "P9", "P10"]),
      ],
    });
    await summaryFromAggregations([] as never, makePluginDef(WINDOWED_CONFIG) as never, rec.api, undefined, makeHoas(10));

    expect(rec.callJsonCalls).toHaveLength(4);
    expect(rec.windowCalls).toHaveLength(3);

    const w1 = String(rec.windowCalls[0].prompt);
    expect(w1).toContain("DESC-1");
    expect(w1).toContain("DESC-4");
    expect(w1).not.toContain("DESC-5");

    const w2 = String(rec.windowCalls[1].prompt);
    expect(w2).toContain("DESC-4"); // overlap context
    expect(w2).toContain("DESC-7");
    expect(w2).not.toContain("DESC-8");

    const w3 = String(rec.windowCalls[2].prompt);
    expect(w3).toContain("DESC-7"); // overlap context
    expect(w3).toContain("DESC-10");
  });

  it("11 HOAs → remainder window covers HOAs 10–11 (0-based 9,10), only HOA 11 is new", async () => {
    const rec = createScriptedApi({
      windowResponses: [
        windowResponse(["P1", "P2", "P3", "P4"]),
        windowResponse(["P5", "P6", "P7"]),
        windowResponse(["P8", "P9", "P10"]),
        windowResponse(["P11"]),
      ],
    });
    await summaryFromAggregations([] as never, makePluginDef(WINDOWED_CONFIG) as never, rec.api, undefined, makeHoas(11));

    expect(rec.windowCalls).toHaveLength(4);
    expect(rec.callJsonCalls).toHaveLength(5);

    const last = String(rec.windowCalls[3].prompt);
    expect(last).toContain("DESC-10"); // overlap context (0-based 9)
    expect(last).toContain("DESC-11"); // 0-based 10 — the only NEW HOA
    expect(last).not.toContain("DESC-9");
    expect(last).toContain("EXAKT 1 neue Absätze");
  });

  it("first window expects all its HOAs as new (EXAKT 4), later windows EXAKT 3", async () => {
    const rec = createScriptedApi({
      windowResponses: [
        windowResponse(["P1", "P2", "P3", "P4"]),
        windowResponse(["P5", "P6", "P7"]),
        windowResponse(["P8", "P9", "P10"]),
      ],
    });
    await summaryFromAggregations([] as never, makePluginDef(WINDOWED_CONFIG) as never, rec.api, undefined, makeHoas(10));
    expect(String(rec.windowCalls[0].prompt)).toContain("EXAKT 4 neue Absätze");
    expect(String(rec.windowCalls[1].prompt)).toContain("EXAKT 3 neue Absätze");
    expect(String(rec.windowCalls[2].prompt)).toContain("EXAKT 3 neue Absätze");
  });
});

// ── Accumulation semantics ──────────────────────────────────────────────────

describe("summaryFromAggregations — accumulation", () => {
  it("keyword carry-over: window 2 prompt contains window 1's keywords; dedup is case-insensitive", async () => {
    const rec = createScriptedApi({
      windowResponses: [
        windowResponse(["P1", "P2", "P3", "P4"], ["Alpha"]),
        windowResponse(["P5", "P6", "P7"], ["alpha", "Beta"]),
        windowResponse(["P8", "P9", "P10"], []),
      ],
      finalResponse: { title: "T", keywords: ["ALPHA", "Gamma"] },
    });
    const result = (await summaryFromAggregations(
      [] as never, makePluginDef(WINDOWED_CONFIG) as never, rec.api, undefined,
      // Keywords must be evidenced in the HOA descriptions (≥2 prose sightings)
      // to survive the deterministic evidence filter.
      Array.from({ length: 10 }, (_, i) => makeHoa(i, `DESC-${i + 1} über Alpha, Beta und Gamma`)),
    )) as { keywords: string[] };

    // Window 2 sees window 1's collected keywords
    expect(String(rec.windowCalls[1].prompt)).toContain("Alpha");
    // Window 3 sees the deduped union (Beta added, "alpha" not duplicated)
    const w3 = String(rec.windowCalls[2].prompt);
    expect(w3).toContain("Alpha");
    expect(w3).toContain("Beta");
    // Final keywords = union of collected + model's own (case-insensitive, first-seen order/casing)
    expect(result.keywords).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("paragraph overflow: extras beyond the expected new-count are dropped from the FRONT", async () => {
    const rec = createScriptedApi({
      windowResponses: [
        windowResponse(["P1", "P2", "P3", "P4"]),
        windowResponse(["DROP-ME", "KEEP-1", "KEEP-2", "KEEP-3"]), // 4 returned, 3 expected
        windowResponse(["P8", "P9", "P10"]),
      ],
    });
    await summaryFromAggregations([] as never, makePluginDef(WINDOWED_CONFIG) as never, rec.api, undefined, makeHoas(10));

    const finalPrompt = String(rec.callJsonCalls[3].prompt);
    expect(finalPrompt).not.toContain("DROP-ME");
    expect(finalPrompt).toContain("KEEP-1");
    expect(finalPrompt).toContain("KEEP-2");
    expect(finalPrompt).toContain("KEEP-3");
  });

  it("window failure → raw HOA descriptions of the NEW HOAs are appended; final call still happens", async () => {
    const rec = createScriptedApi({
      windowResponses: [
        windowResponse(["P1", "P2", "P3", "P4"]),
        { error: "model exploded" },
        windowResponse(["P8", "P9", "P10"]),
      ],
    });
    await summaryFromAggregations([] as never, makePluginDef(WINDOWED_CONFIG) as never, rec.api, undefined, makeHoas(10));

    expect(rec.callJsonCalls).toHaveLength(4);
    const finalPrompt = String(rec.callJsonCalls[3].prompt);
    // Failed window [4-7]: overlap HOA 4 is context only; raw DESC-5..DESC-7 appended
    expect(finalPrompt).toContain("DESC-5");
    expect(finalPrompt).toContain("DESC-6");
    expect(finalPrompt).toContain("DESC-7");
  });

  it("final call prompt contains the chronological paragraphs + collected keywords, NOT the raw HOA dump", async () => {
    const rec = createScriptedApi({
      windowResponses: [
        windowResponse(["Absatz Eins", "Absatz Zwei", "Absatz Drei", "Absatz Vier"], ["Schlagwort"]),
        windowResponse(["Absatz Fünf", "Absatz Sechs", "Absatz Sieben"]),
        windowResponse(["Absatz Acht", "Absatz Neun", "Absatz Zehn"]),
      ],
    });
    await summaryFromAggregations([] as never, makePluginDef(WINDOWED_CONFIG) as never, rec.api, undefined, makeHoas(10));

    const finalPrompt = String(rec.callJsonCalls[3].prompt);
    expect(finalPrompt).toContain("1. Absatz Eins");
    expect(finalPrompt).toContain("10. Absatz Zehn");
    expect(finalPrompt).toContain("Bisher gesammelte Keywords: Schlagwort");
    expect(finalPrompt).not.toContain("DESC-1");
    expect(finalPrompt).not.toContain("DESC-10");
  });

  it("keyword carry-over also feeds the previous paragraph for style continuity", async () => {
    const rec = createScriptedApi({
      windowResponses: [
        windowResponse(["Stil Absatz Eins", "P2", "P3", "P4"]),
        windowResponse(["P5", "P6", "P7"]),
        windowResponse(["P8", "P9", "P10"]),
      ],
    });
    await summaryFromAggregations([] as never, makePluginDef(WINDOWED_CONFIG) as never, rec.api, undefined, makeHoas(10));

    // First window gets the empty-state placeholder
    expect(String(rec.windowCalls[0].prompt)).toContain("(keine — erstes Fenster)");
    // Second window sees the LAST paragraph of window 1
    expect(String(rec.windowCalls[1].prompt)).toContain("P4");
  });
});
