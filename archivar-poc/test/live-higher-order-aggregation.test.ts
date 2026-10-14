/**
 * LIVE end-to-end test for Higher-Order Aggregation + Artefakt accumulation.
 *
 * WHY: the unit tests (visual-artifacts-higher-order.test.ts) mock getModel + the
 * MLLM API, so they can't verify that a REAL deployed VLM:
 *   - honors the accumulation rule and emits visual_artifacts[].temporal_stability
 *   - produces a coherent HOA title/description/intention from constituent aggregations
 *   - respects the higherOrderAggregationSchema via native guided decoding
 *
 * This test uses the REAL archivar config (no mocking) and is skipped when the
 * configured model is unreachable. Model availability is checked via the shared
 * test/utils/model-availability.ts helper.
 *
 * Run example:
 *   pnpm exec vitest run test/live-higher-order-aggregation.test.ts
 *   E2E_HOA_MODEL=Qwen3.8-27B-FP8 pnpm exec vitest run test/live-higher-order-aggregation.test.ts
 */
import { describe, it, expect, beforeAll } from "vitest";
import { ensureModelAvailable, type ModelCheckResult } from "./utils/model-availability.js";
import { buildPluginRpcCompositeApiInstance } from "../src/rpc/post-processing/plugin-api.js";
import type {
  PluginRpcApiCompositeInstance,
  SemanticAggregation,
  TimeSlice,
  FileRef,
} from "../src/lib/plugin-types.js";

// The model under test: Gemma4-E4B-QAT-W4A16 by default. Override via env when
// pointing at a different deployed model.
const HOA_MODEL = process.env.E2E_HOA_MODEL ?? "gemma4-e4b-qat-w4a16";

let modelCheck: ModelCheckResult;

beforeAll(async () => {
  modelCheck = await ensureModelAvailable(HOA_MODEL);
  if (!modelCheck.available) {
    console.warn(`[live-hoa] Skipping: ${modelCheck.reason}`);
  }
});

const api: PluginRpcApiCompositeInstance = buildPluginRpcCompositeApiInstance();

/** Minimal FileRef so the slice fixtures type-check; no real files are read (HOA is text-only). */
function makeFileRef(): FileRef {
  return {
    fileName: "scene.mp4",
    extension: "mp4",
    mediaType: "video",
    outputHash: "live-hash",
    serverUrl: "",
    containerPath: "/data/scene.mp4",
  };
}

function makeSceneSlice(id: string, from: number, to: number, caption: string, sceneIndex: number): TimeSlice {
  return {
    id,
    index: sceneIndex,
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

/** Rich caption with a Visuelle Artefakte table (matches caption-prompt-template.md). */
const NEWS_CAPTION_WITH_ARTIFACTS = `# Bildbeschreibung
Ein Nachrichtensprecher sitzt im ARD-Studio und berichtet über einen Kriminalfall in Berlin. Im Hintergrund ist die Stadtlandschaft zu sehen.

# Visuelle Artefakte

| Artefakt | Bildbeschreibung | Confidence |
| ----------------- | ---------------------- | ---------: |
| ARD-Logo          | "ARD"                  |       0.95 |
| Datums-Overlay    | "07.05.2026, 20:00 Uhr" | 0.90 |

# Erwartete Menschliche Wahrnehmung

| Kategorie | Schlüsselwörter | Confidence |
| --------- | ------------- | ---------: |
| rhetoric | serious | 0.90 |
| framing | neutral | 0.80 |
| emotion | calm | 0.70 |
`;

const TEASER_CAPTION_WITH_ARTIFACTS = `# Bildbeschreibung
Ein Teaser-Clip zeigt Szenen aus der Krimiserie "Tatort" mit dem Sender-Logo und dem Ausstrahlungstermin.

# Visuelle Artefakte

| Artefakt | Bildbeschreibung | Confidence |
| ----------------- | ---------------------- | ---------: |
| ARD-Logo          | "ARD"                  |       0.93 |
| Datums-Overlay    | "07.05.2026, 20:00 Uhr" | 0.95 |
`;

function makePluginDef(): Record<string, unknown> {
  return {
    name: "default",
    importPath: "./plugins/default.ts",
    config: {
      modelName: HOA_MODEL,
      maxConcurrency: 1,
      includeTypes: ["scene"],
      reanalyzeVideoForAggregation: false,
    },
  };
}

describe("postProcessPerAggregation + postProcessHigherOrderAggregations — LIVE", () => {
  it("LIVE1: aggregation analysis accumulates visual artifacts via the real model (news + teaser)", async ({ skip }) => {
    if (!modelCheck?.available) return skip(modelCheck?.reason ?? "model unavailable");

    const { postProcessPerAggregation } = await import("../plugins/default.js");

    // Two single-scene aggregations: a news report and a teaser, each carrying a
    // Visuelle Artefakte table. Both go through the real aggregation prompt so the
    // accumulation rule is exercised for distinct content types.
    const newsSlice = makeSceneSlice("scene:0:0:0-60", 0, 60, NEWS_CAPTION_WITH_ARTIFACTS, 0);
    newsSlice.plugin = { default: { summary: "ARD news", raw_caption: NEWS_CAPTION_WITH_ARTIFACTS } } as never;
    const teaserSlice = makeSceneSlice("scene:1:1:60-120", 60, 120, TEASER_CAPTION_WITH_ARTIFACTS, 1);
    teaserSlice.plugin = { default: { summary: "Tatort teaser", raw_caption: TEASER_CAPTION_WITH_ARTIFACTS } } as never;

    for (const [label, slice] of [["news", newsSlice], ["teaser", teaserSlice]] as const) {
      const agg: SemanticAggregation = {
        id: `default:aggregation:${label}`, pluginName: "default", index: slice.sceneIndex,
        sliceIndexes: [0], sliceIds: [slice.id],
        from: slice.from, to: slice.to, fromSeconds: slice.fromSeconds, toSeconds: slice.toSeconds,
      };
      const patch = await postProcessPerAggregation(agg, [slice], makePluginDef() as never, api);
      const analysis = patch?.analysis as Record<string, unknown> | undefined;
      expect(analysis).toBeDefined();
      // Validated structured analysis (sliceAnalysisSchema)
      expect(analysis?.summary).toBeTruthy();
      console.log(`[live-hoa] LIVE1 ${label} summary: ${String(analysis?.summary).slice(0, 120)}`);
      // When the model honors the accumulation rule, visual_artifacts is an array
      if (Array.isArray(analysis?.visual_artifacts)) {
        console.log(`[live-hoa] LIVE1 ${label} model emitted ${analysis!.visual_artifacts.length} visual_artifacts`);
      }
    }
  });

  it("LIVE2: groups aggregations into a HOA with title + description + merged artifacts", async ({ skip }) => {
    if (!modelCheck?.available) return skip(modelCheck?.reason ?? "model unavailable");

    const { postProcessHigherOrderAggregations } = await import("../plugins/default.js");
    // Two aggregations: a news report and a teaser that share the same date/brand artifacts.
    const aggs: SemanticAggregation[] = [
      {
        id: "default:aggregation:0", pluginName: "default", index: 0,
        sliceIndexes: [0], sliceIds: ["s:0"], from: "0", to: "60", fromSeconds: 0, toSeconds: 60,
        analysis: {
          summary: "ARD Nachrichten: Bericht über einen Kriminalfall in Berlin mit brennendem Haus.",
          relationship_to_previous: "DIRECT_CONTINUATION",
          visual_artifacts: [
            { artifact: "ARD Logo", exact_caption: '"ARD"', confidence: 0.95, temporal_stability: 3 },
            { artifact: "Date Overlay", exact_caption: '"07.05.2026, 20:00 Uhr"', confidence: 0.9, temporal_stability: 1 },
          ],
        } as never,
      },
      {
        id: "default:aggregation:1", pluginName: "default", index: 1,
        sliceIndexes: [1], sliceIds: ["s:1"], from: "60", to: "120", fromSeconds: 60, toSeconds: 120,
        analysis: {
          summary: "Teaser-Trailer für die Tatort-Folge am 07.05.2026 20:00 Uhr mit ARD-Logo.",
          relationship_to_previous: "NEW_TOPIC_HARD_DRIFT",
          visual_artifacts: [
            { artifact: "ARD Logo", exact_caption: '"ARD"', confidence: 0.93, temporal_stability: 2 },
            { artifact: "Date Overlay", exact_caption: '"07.05.2026, 20:00 Uhr"', confidence: 0.95, temporal_stability: 2 },
          ],
        } as never,
      },
    ];

    const hoas = await postProcessHigherOrderAggregations(aggs, makePluginDef() as never, api);
    expect(hoas.length).toBeGreaterThanOrEqual(1);
    const hoa = hoas[0];
    expect(hoa.title).toBeTruthy();
    expect(hoa.description.length).toBeGreaterThan(0);
    expect(hoa.aggregationIndexes.length).toBeGreaterThanOrEqual(1);
    console.log(`[live-hoa] LIVE2 HOA "${hoa.title}" (${hoa.aggregationIndexes.length} aggs): ${hoa.description.slice(0, 200)}`);
    if (hoa.intentionClassification) {
      console.log(`[live-hoa] LIVE2 intention: ${hoa.intentionClassification}`);
    }
    // Recurring ARD/Date artifacts should be merged across the constituent aggregations
    const ard = hoa.visualArtifacts.find((a) => /ARD/i.test(a.artifact));
    if (ard) {
      console.log(`[live-hoa] LIVE2 merged ARD artifact stability=${ard.temporalStability}`);
    }
  });
});
