/**
 * Focused schema-mode tests for every prompt/schema pair in plugins/default.ts.
 *
 * WHY: Each MLLM call site in the default plugin MUST be migratable 1:1 onto
 * native JSON-schema guided decoding. The migration gate for each pair is:
 *   (1) the plugin forwards a non-disabled `jsonSchemaMode` (not false/undefined),
 *   (2) the Yup schema captured at the call converts cleanly under STRICT mode
 *       via yupToJsonSchema() (no UnsupportedYupNodeError),
 *   (3) the correct prompt branch fired (sanity: contains the JSON instruction).
 *
 * Each `it` drives the REAL plugin hook with a recording mock PluginApi and
 * asserts the gate. Sites backed by sliceAnalysisSchema (D1, D4, D5, D6) are
 * the documented MIGRATION GATE: they currently FAIL assertion (2) because
 * `audio_details` is `.optional()` and strict conversion rejects optional
 * fields. Once that schema shape is made converter-compatible, all 8 go green
 * and the plugin migrates by wiring alone.
 *
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as yup from "yup";
import type {
  PluginRpcApiCompositeInstance,
  PluginDefinition,
  PostProcessingInput,
  TimeSlice,
  SemanticAggregation,
  FileRef,
  HigherOrderAggregation,
} from "../src/lib/plugin-types";
import { yupToJsonSchema } from "../src/lib/yup-json-schema/index";
import { UnsupportedYupNodeError } from "../src/lib/errors";

// Mock getModel so importing/running the plugin needs no archivar config/env.
// Return jsonSchemaMode: "auto" to mirror the real default-on behaviour and
// to verify the plugin forwards a non-disabled mode.
vi.mock("../src/lib/archivar-config.js", () => ({
  getModel: () => ({
    resolvedEndpoint: "http://mock",
    resolvedModel: "mock-model",
    resolvedApiKey: "mock-key",
    // Mirrors callJson's default: unset → "auto". We set it explicitly so the
    // plugin forwards "auto" and the wiring assertion can observe it.
    jsonSchemaMode: "auto",
  }),
}));

import {
  postProcessPerTimeSlice,
  decideForAggregation,
  postProcessPerAggregation,
  summaryFromAggregations,
  summaryFromTimeSlices,
  DefaultPostProcessingConfig,
} from "../plugins/default";
import { PostProcessingPluginDefinition } from "../src/lib/types.js";

// ── helpers ───────────────────────────────────────────────────────────────

/** A single captured callJson invocation's contract-relevant args. */
interface CapturedCall {
  schema: unknown; // yup.Schema
  jsonSchemaMode: unknown;
  prompt: string;
  filePaths: string[];
  mediaCategory: string;
}

/**
 * Builds a mock PluginApi whose callJson records every call's schema/mode/prompt
 * AND faithfully validates the queued raw response against the schema (so the
 * hook completes its normal control flow). Retry is not simulated here.
 */
function createRecordingApi(rawResponse: string | string[]): {
  api: PluginRpcApiCompositeInstance;
  calls: CapturedCall[];
} {
  const queue = Array.isArray(rawResponse) ? [...rawResponse] : [rawResponse];
  const calls: CapturedCall[] = [];
  const parseJsonLoose = (c: string) => {
    try {
      return JSON.parse(c);
    } catch {
      return null;
    }
  };
  const callJson = vi.fn(async (args: {
    schema: { validate: (v: unknown, o: unknown) => Promise<unknown> };
    jsonSchemaMode?: unknown;
    prompt: string;
    filePaths: string[];
    mediaCategory: string;
  }) => {
    calls.push({
      schema: args.schema,
      jsonSchemaMode: args.jsonSchemaMode,
      prompt: args.prompt,
      filePaths: args.filePaths,
      mediaCategory: args.mediaCategory,
    });
    const raw = queue.length > 1 ? (queue.shift() as string) : (queue[0] ?? "");
    const parsed = parseJsonLoose(raw);
    if (parsed === null) {
      throw new Error("MLLM response could not be parsed as JSON");
    }
    return args.schema.validate(parsed, { abortEarly: false, stripUnknown: true });
  });

  return {
    calls,
    api: {
      file: { getMediaInfo: vi.fn(), listFiles: vi.fn(), readFile: vi.fn() },
      cache: { get: vi.fn(), set: vi.fn() },
      analysis: { getAnalysisResults: vi.fn(), analyzeSegment: vi.fn() },
      mllm: { callRaw: vi.fn(), callJson },
      util: {
        parseJsonLoose,
        formatTime: vi.fn(),
        // Real concurrency limiter: just run sequentially in tests.
        limitConcurrency: async <T, R>(items: T[], _limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> => {
          const out: R[] = [];
          for (let i = 0; i < items.length; i++) out.push(await fn(items[i], i));
          return out;
        },
        logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
      },
    } as unknown as PluginRpcApiCompositeInstance,
  };
}

/**
 * Returns true iff the Yup schema converts cleanly to JSON Schema under STRICT
 * mode (the vLLM invariant). This is the exact check callJson performs before
 * attaching native guided decoding; a false result means the call silently
 * degrades to prompt-only under "auto".
 */
function convertsCleanly(schema: unknown): boolean {
  try {
    yupToJsonSchema(schema as Parameters<typeof yupToJsonSchema>[0], { strict: true });
    return true;
  } catch (err) {
    if (err instanceof UnsupportedYupNodeError) return false;
    throw err;
  }
}

/** Shared assertion block: the migration gate for one captured call. */
function assertMigrationGate(call: CapturedCall) {
  // (1) Wiring: the plugin must NOT have explicitly disabled schema mode.
  expect(call.jsonSchemaMode, "jsonSchemaMode must not be disabled (false/undefined)").not.toBe(false);
  expect(call.jsonSchemaMode, "jsonSchemaMode must not be disabled (false/undefined)").not.toBeUndefined();
  // (3) Prompt invariant: a JSON-schema instruction was sent.
  expect(call.prompt).toMatch(/gültiges JSON/i);

  // (2) Convertibility gate — the target (green) state. Sites backed by
  // sliceAnalysisSchema are RED today because `audio_details` is `.optional()`
  // and strict conversion rejects optional fields; this is the documented
  // migration gate. Once that schema is converter-compatible, these go green
  // and the plugin migrates by wiring alone.
  expect(convertsCleanly(call.schema), "schema must convert cleanly under strict mode").toBe(true);
}

function fileRef(name = "scene-0.mp4"): FileRef {
  return {
    fileName: name,
    extension: ".mp4",
    mediaType: "video",
    outputHash: "h",
    containerPath: `/work/${name}`,
  };
}

function sceneSlice(id: string, fromSeconds: number, toSeconds: number, analysis?: Record<string, unknown>, sceneIndex: number = 0): TimeSlice {
  return {
    id,
    index: 0,
    from: String(fromSeconds),
    to: String(toSeconds),
    fromSeconds,
    toSeconds,
    durationSeconds: toSeconds - fromSeconds,
    type: "scene",
    sceneIndex,
    caption: "",
    sourceFile: fileRef(`${id}.mp4`),
    parentFile: fileRef("parent.mp4"),
    ...(analysis ? { plugin: { default: analysis as never } } : {}),
  };
}

function speechSlice(id: string, fromSeconds: number, toSeconds: number, caption: string): TimeSlice {
  return {
    id,
    index: 0,
    from: String(fromSeconds),
    to: String(toSeconds),
    fromSeconds,
    toSeconds,
    durationSeconds: toSeconds - fromSeconds,
    type: "speech",
    sceneIndex: 0,
    caption,
    sourceFile: fileRef(`${id}.wav`),
    parentFile: fileRef("parent.mp4"),
  };
}

function aggregation(sliceIndexes: number[], fromSeconds: number, toSeconds: number): SemanticAggregation {
  return {
    id: "test:aggregation:0",
    pluginName: "default",
    index: 0,
    sliceIndexes,
    sliceIds: sliceIndexes.map((i) => `s${i}`),
    from: String(fromSeconds),
    to: String(toSeconds),
    fromSeconds,
    toSeconds,
  };
}

function higherOrderAggregation(aggIndexes: number[], title: string, description: string): HigherOrderAggregation {
  return {
    id: "test:hoa:0",
    index: 0,
    title,
    description,
    aggregationIndexes: aggIndexes,
    visualArtifacts: [],
  };
}

function makeInput(timeSlices: TimeSlice[]): PostProcessingInput {
  return {
    workflowName: "test",
    workflow: {} as never,
    run: { id: "test", startedAt: "", force: false },
    file: fileRef("parent.mp4"),
    analysisResult: {} as never,
    timeSlices,
  };
}

/** Minimal valid payload satisfying sliceAnalysisSchema (audio_details omitted on purpose). */
const VALID_SLICE_JSON = JSON.stringify({
  summary: "Anchor reads news.",
  setting: "studio",
  scene_type: "national-news",
  timeline: [{ time: "00:00:01", event: "speaking" }],
  subjects: [{ type: "person", appearance: "blazer", actions: [{ time: "00:00:01", desc: "speaks" }] }],
  camera_motion: "static",
  audio: "unsicher",
  text_visible: [],
  uncertainties: [],
});

const VALID_DECISION_JSON = JSON.stringify({ same_contribution: true, reason: "same topic" });
const VALID_SUMMARY_JSON = JSON.stringify({
  title: "T",
  keywords: ["k"],
  short_description: "s",
  long_summary: "l",
});

// ── tests ─────────────────────────────────────────────────────────────────

describe("default.ts — schema-mode migration gate per prompt/schema pair", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => { });
    vi.spyOn(console, "error").mockImplementation(() => { });
    vi.spyOn(console, "log").mockImplementation(() => { });
  });

  // D1 — postProcessPerTimeSlice → DEFAULT_SLICE_ANALYSIS_PROMPT + sliceAnalysisSchema
  it("D1: postProcessPerTimeSlice uses sliceAnalysisSchema (MIGRATION GATE — degrades today)", async () => {
    const { api, calls } = createRecordingApi(VALID_SLICE_JSON);
    await postProcessPerTimeSlice(
      makeInput([sceneSlice("scene:0:0:0-10", 0, 10)]),
      { config: { modelName: "Qwen3.8-27B-FP8" } } as PostProcessingPluginDefinition<DefaultPostProcessingConfig>,
      api,
    );
    expect(calls).toHaveLength(1);
    assertMigrationGate(calls[0]);
  });

  // D2 — decideForAggregation (no transcripts) → DECISION_PROMPT + aggregationDecisionSchema
  // NOTE: Different sceneIndex values (0 and 1) are required so the sceneIndex-based
  // early-return doesn't skip the model call (unified multi-modal aggregation).
  it("D2: decideForAggregation (no transcripts) uses a clean decision schema", async () => {
    const { api, calls } = createRecordingApi(VALID_DECISION_JSON);
    const a = sceneSlice("scene:0:0:0-10", 0, 10, { summary: "A" }, 0);
    const b = sceneSlice("scene:1:0:10-20", 10, 20, { summary: "B" }, 1);
    await decideForAggregation(a, b, { config: { modelName: "Qwen3.8-27B-FP8" } } as PostProcessingPluginDefinition<DefaultPostProcessingConfig>, api);
    expect(calls).toHaveLength(1);
    assertMigrationGate(calls[0]);
  });

  // D3 — decideForAggregation (with transcripts) → DECISION_PROMPT_WITH_TRANSCRIPTS
  // NOTE: Different sceneIndex values (0 and 1) are required so the sceneIndex-based
  // early-return doesn't skip the model call (unified multi-modal aggregation).
  it("D3: decideForAggregation (with transcripts) fires the transcript prompt + clean schema", async () => {
    const { api, calls } = createRecordingApi(VALID_DECISION_JSON);
    const a = sceneSlice("scene:0:0:0-10", 0, 10, { summary: "A", transcript: "hello A" }, 0);
    const b = sceneSlice("scene:1:0:10-20", 10, 20, { summary: "B", transcript: "hello B" }, 1);
    await decideForAggregation(
      a,
      b,
      { config: { modelName: "Qwen3.8-27B-FP8", includeTypes: ["scene", "speech"] } } as PostProcessingPluginDefinition<DefaultPostProcessingConfig>,
      api,
    );
    expect(calls).toHaveLength(1);
    // Transcript prompt carries the Transkript placeholder substitution.
    expect(calls[0].prompt).toContain("Transkript");
    assertMigrationGate(calls[0]);
  });

  // D4 — postProcessPerAggregation text-only branch → AGGREGATION_ANALYSIS_PROMPT
  it("D4: postProcessPerAggregation (text-only) uses sliceAnalysisSchema (MIGRATION GATE)", async () => {
    const { api, calls } = createRecordingApi(VALID_SLICE_JSON);
    const slices = [sceneSlice("scene:0:0:0-10", 0, 10, { summary: "A" })];
    await postProcessPerAggregation(
      aggregation([0], 0, 10),
      slices,
      { config: { modelName: "Qwen3.8-27B-FP8", reanalyzeVideoForAggregation: false } } as PostProcessingPluginDefinition<DefaultPostProcessingConfig>,
      api,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].filePaths, "text-only branch sends no media files").toEqual([]);
    assertMigrationGate(calls[0]);
  });

  // D5 — postProcessPerAggregation video branch → AGGREGATION_ANALYSIS_VIDEO_PROMPT
  it("D5: postProcessPerAggregation (video) sends media files + sliceAnalysisSchema (GATE)", async () => {
    const { api, calls } = createRecordingApi(VALID_SLICE_JSON);
    const slices = [sceneSlice("scene:0:0:0-10", 0, 10, { summary: "A" })];
    await postProcessPerAggregation(
      aggregation([0], 0, 10),
      slices,
      { config: { modelName: "Qwen3.8-27B-FP8", reanalyzeVideoForAggregation: true } } as PostProcessingPluginDefinition<DefaultPostProcessingConfig>,
      api,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].filePaths.length, "video branch re-sends member slice files").toBeGreaterThan(0);
    assertMigrationGate(calls[0]);
  });

  // D6 — postProcessPerAggregation transcript branch → AGGREGATION_ANALYSIS_WITH_TRANSCRIPTS_PROMPT
  it("D6: postProcessPerAggregation (transcripts) fires transcript prompt + sliceSchema (GATE)", async () => {
    const { api, calls } = createRecordingApi(VALID_SLICE_JSON);
    const slices = [
      sceneSlice("scene:0:0:0-10", 0, 10, { summary: "A" }),
      speechSlice("speech:0:0:2-8", 2, 8, "spoken text"),
    ];
    await postProcessPerAggregation(
      aggregation([0], 0, 10),
      slices,
      { config: { modelName: "Qwen3.8-27B-FP8", includeTypes: ["scene", "speech"] } } as PostProcessingPluginDefinition<DefaultPostProcessingConfig>,
      api,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toContain("Transkripte");
    assertMigrationGate(calls[0]);
  });

  // D7 — summaryFromAggregations (with HOAs) → UNIFIED_SUMMARY_TEMPLATE + unifiedSummarySchema
  it("D7: summaryFromAggregations uses a clean unified-summary schema when HOAs are present", async () => {
    const { api, calls } = createRecordingApi(VALID_SUMMARY_JSON);
    const agg = aggregation([0], 0, 10);
    agg.analysis = { summary: "x" } as never;
    const hoas = [higherOrderAggregation([0], "News Segment", "A news segment covering the story.")];
    await summaryFromAggregations([agg], { config: { modelName: "Qwen3.8-27B-FP8" } } as PostProcessingPluginDefinition<DefaultPostProcessingConfig>, api, undefined, hoas);
    expect(calls).toHaveLength(1);
    assertMigrationGate(calls[0]);
  });

  // D8 — summaryFromTimeSlices (fallback) → WHOLE_SUMMARY_PROMPT + wholeSummarySchema
  it("D8: summaryFromTimeSlices uses a clean whole-summary schema", async () => {
    const { api, calls } = createRecordingApi(VALID_SUMMARY_JSON);
    await summaryFromTimeSlices(
      makeInput([sceneSlice("scene:0:0:0-10", 0, 10, { summary: "A" })]),
      { config: { modelName: "Qwen3.8-27B-FP8" } } as PostProcessingPluginDefinition<DefaultPostProcessingConfig>,
      api,
    );
    expect(calls).toHaveLength(1);
    assertMigrationGate(calls[0]);
  });
});
