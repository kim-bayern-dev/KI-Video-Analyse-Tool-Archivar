/**
 * E2E tests for auto-regressive semantic linking in plugins/default.ts.
 *
 * WHY: Semantic linking enables long-range relationships between aggregations
 * by extracting multi-dimensional profiles and detecting cross-aggregation
 * relationships. This test suite verifies:
 *   (1) Semantic profiles are extracted correctly
 *   (2) Relationships to previous aggregations are detected
 *   (3) First aggregation has no relationships
 *   (4) Context accumulates correctly across iterations
 *   (5) Disabled mode skips processing
 *   (6) Graceful handling of missing analyses
 *
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  PluginRpcApiCompositeInstance,
  SemanticAggregation,
} from "../src/lib/plugin-types";
import {
  extractSemanticProfiles,
  semanticProfileWithRelationshipsSchema,
  SEMANTIC_PROFILE_WITH_CONTEXT_PROMPT,
  DefaultPostProcessingConfig,
} from "../plugins/default";
import { PostProcessingPluginDefinition } from "../src/lib/types.js";

// Mock getModel so importing/running the plugin needs no archivar config/env.
vi.mock("../src/lib/archivar-config.js", () => ({
  getModel: () => ({
    resolvedEndpoint: "http://mock",
    resolvedModel: "mock-model",
    resolvedApiKey: "mock-key",
    jsonSchemaMode: "auto",
  }),
}));

// ── helpers ─────────────────────────────────────────────────────────────

/** A single captured callJson invocation. */
interface CapturedCall {
  schema: unknown;
  jsonSchemaMode: unknown;
  prompt: string;
  filePaths: string[];
  mediaCategory: string;
}

/** Creates a mock API that records calls and returns configured responses. */
function createRecordingApi(rawResponses: string[]): {
  api: PluginRpcApiCompositeInstance;
  calls: CapturedCall[];
} {
  const queue = [...rawResponses];
  const calls: CapturedCall[] = [];

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
    const raw = queue.shift() ?? "{}";
    try {
      const parsed = JSON.parse(raw);
      return args.schema.validate(parsed, { abortEarly: false, stripUnknown: true });
    } catch {
      throw new Error(`MLLM response could not be parsed as JSON: ${raw}`);
    }
  });

  return {
    calls,
    api: {
      file: { getMediaInfo: vi.fn(), listFiles: vi.fn(), readFile: vi.fn() },
      cache: { get: vi.fn(), set: vi.fn() },
      analysis: { getAnalysisResults: vi.fn(), analyzeSegment: vi.fn() },
      mllm: { callRaw: vi.fn(), callJson },
      util: {
        parseJsonLoose: (c: string) => JSON.parse(c),
        formatTime: vi.fn(),
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

/** Minimal valid semantic profile with relationships response */
function validSemanticProfile(topics: string[], relatedIds: string[] = []): string {
  return JSON.stringify({
    profile: {
      topics,
      setting: "studio",
      speakers: ["anchor"],
      mood: "serious",
      visualStyle: "news-broadcast",
      audioCharacter: "speech-with-music",
      primaryIntention: "inform",
      confidence: 0.85,
    },
    relatedAggregationIds: relatedIds,
    reason: "Test reason",
  });
}

function makeAggregation(index: number, analysis?: SemanticAggregation["analysis"]): SemanticAggregation {
  return {
    id: `default:aggregation:${index}`,
    pluginName: "default",
    index,
    sliceIndexes: [index],
    sliceIds: [`s${index}`],
    from: String(index * 10),
    to: String((index + 1) * 10),
    fromSeconds: index * 10,
    toSeconds: (index + 1) * 10,
    analysis: analysis ?? { summary: `Analysis for aggregation ${index}` },
  };
}

// ── tests ─────────────────────────────────────────────────────────────────

describe("semantic linking — E2E tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => { });
    vi.spyOn(console, "error").mockImplementation(() => { });
    vi.spyOn(console, "log").mockImplementation(() => { });
  });

  // SL1: Disabled config skips processing
  it("SL1: extractSemanticProfiles is skipped when config.extractSemanticProfiles is false", async () => {
    const { api, calls } = createRecordingApi([]);

    const aggregations = [makeAggregation(0)];
    await extractSemanticProfiles(
      aggregations,
      { config: { extractSemanticProfiles: false } } as PostProcessingPluginDefinition<DefaultPostProcessingConfig>,
      api,
    );

    expect(calls).toHaveLength(0);
  });

  // SL2: Empty aggregations returns without calls
  it("SL2: empty aggregations returns without making calls", async () => {
    const { api, calls } = createRecordingApi([]);

    await extractSemanticProfiles(
      [],
      { config: {} } as PostProcessingPluginDefinition<DefaultPostProcessingConfig>,
      api,
    );

    expect(calls).toHaveLength(0);
  });

  // SL3: Single aggregation with no previous profiles → no relationships
  it("SL3: first aggregation has empty relatedAggregationIds", async () => {
    const responses = [validSemanticProfile(["politics"], [])];
    const { api, calls } = createRecordingApi(responses);

    const aggregations = [makeAggregation(0)];
    await extractSemanticProfiles(
      aggregations,
      { config: {} } as PostProcessingPluginDefinition<DefaultPostProcessingConfig>,
      api,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toContain("(none - this is the first aggregation)");
    expect(aggregations[0].semanticProfile?.topics).toEqual(["politics"]);
    expect(aggregations[0].belongsToSemantically).toEqual([]);
  });

  // SL4: Second aggregation references first
  it("SL4: second aggregation references first in relatedAggregationIds", async () => {
    const responses = [
      validSemanticProfile(["politics"], []),
      validSemanticProfile(["economy"], ["default:aggregation:0"]),
    ];
    const { api, calls } = createRecordingApi(responses);

    const aggregations = [makeAggregation(0), makeAggregation(1)];
    await extractSemanticProfiles(
      aggregations,
      { config: {} } as PostProcessingPluginDefinition<DefaultPostProcessingConfig>,
      api,
    );

    expect(calls).toHaveLength(2);
    // Second call should include first profile as context
    expect(calls[1].prompt).toContain("default:aggregation:0");
    expect(aggregations[1].belongsToSemantically).toContain("default:aggregation:0");
  });

  // SL5: Third aggregation references first and/or second
  it("SL5: third aggregation can reference multiple previous aggregations", async () => {
    const responses = [
      validSemanticProfile(["politics"], []),
      validSemanticProfile(["economy"], ["default:aggregation:0"]),
      validSemanticProfile(["politics", "economy"], ["default:aggregation:0", "default:aggregation:1"]),
    ];
    const { api, calls } = createRecordingApi(responses);

    const aggregations = [makeAggregation(0), makeAggregation(1), makeAggregation(2)];
    await extractSemanticProfiles(
      aggregations,
      { config: {} } as PostProcessingPluginDefinition<DefaultPostProcessingConfig>,
      api,
    );

    expect(calls).toHaveLength(3);
    expect(aggregations[2].belongsToSemantically).toContain("default:aggregation:0");
    expect(aggregations[2].belongsToSemantically).toContain("default:aggregation:1");
  });

  // SL6: Aggregation without analysis is skipped
  it("SL6: aggregation without analysis is skipped", async () => {
    const responses = [validSemanticProfile(["technology"], [])];
    const { api, calls } = createRecordingApi(responses);

    const aggregations: SemanticAggregation[] = [
      makeAggregation(0),
      { ...makeAggregation(1), analysis: undefined } as SemanticAggregation,
      makeAggregation(2),
    ];
    await extractSemanticProfiles(
      aggregations,
      { config: {} } as PostProcessingPluginDefinition<DefaultPostProcessingConfig>,
      api,
    );

    // Only 2 calls (first and third aggregations have analyses)
    expect(calls).toHaveLength(2);
  });

  // SL7: Context accumulates correctly (profiles are appended)
  it("SL7: third call prompt includes profiles from first two aggregations", async () => {
    const responses = [
      validSemanticProfile(["politics"], []),
      validSemanticProfile(["economy"], ["default:aggregation:0"]),
      validSemanticProfile(["politics", "economy"], []),
    ];
    const { api, calls } = createRecordingApi(responses);

    const aggregations = [makeAggregation(0), makeAggregation(1), makeAggregation(2)];
    await extractSemanticProfiles(
      aggregations,
      { config: {} } as PostProcessingPluginDefinition<DefaultPostProcessingConfig>,
      api,
    );

    // Third prompt should include both previous profiles
    expect(calls[2].prompt).toContain("default:aggregation:0");
    expect(calls[2].prompt).toContain("default:aggregation:1");
  });

  // SL8: Schema validates correctly
  it("SL8: semanticProfileWithRelationshipsSchema validates correctly", async () => {
    const valid = {
      profile: {
        topics: ["test"],
        setting: "studio",
        speakers: ["anchor"],
        mood: "serious",
        visualStyle: "news",
        audioCharacter: "speech",
        primaryIntention: "inform",
        confidence: 0.9,
      },
      relatedAggregationIds: ["agg:1", "agg:2"],
      reason: "Same topic",
    };

    const { api, calls } = createRecordingApi([JSON.stringify(valid)]);

    const aggregations = [makeAggregation(0)];
    await extractSemanticProfiles(
      aggregations,
      { config: {} } as PostProcessingPluginDefinition<DefaultPostProcessingConfig>,
      api,
    );

    expect(aggregations[0].semanticProfile?.topics).toEqual(["test"]);
    expect(aggregations[0].belongsToSemantically).toEqual(["agg:1", "agg:2"]);
  });

  // SL9: Graceful degradation on error
  it("SL9: continues processing on error for single aggregation", async () => {
    const responses = [
      validSemanticProfile(["politics"], []),
      "invalid json {{{",
      validSemanticProfile(["economy"], []),
    ];
    const { api, calls } = createRecordingApi(responses);

    const aggregations = [makeAggregation(0), makeAggregation(1), makeAggregation(2)];
    await extractSemanticProfiles(
      aggregations,
      { config: {} } as PostProcessingPluginDefinition<DefaultPostProcessingConfig>,
      api,
    );

    // All 3 calls attempted despite second failing
    expect(calls).toHaveLength(3);
    // First and third should have valid profiles
    expect(aggregations[0].semanticProfile?.topics).toEqual(["politics"]);
    expect(aggregations[2].semanticProfile?.topics).toEqual(["economy"]);
  });

  // SL10: Prompt replaces current aggregation ID placeholder
  it("SL10: prompt replaces CURRENT_AGG_ID placeholder with actual ID", async () => {
    const responses = [validSemanticProfile(["test"], [])];
    const { api, calls } = createRecordingApi(responses);

    const aggregations = [makeAggregation(5)];
    await extractSemanticProfiles(
      aggregations,
      { config: {} } as PostProcessingPluginDefinition<DefaultPostProcessingConfig>,
      api,
    );

    // Placeholder should be replaced with actual ID
    expect(calls[0].prompt).toContain("#default:aggregation:5");
    expect(calls[0].prompt).not.toContain("{{CURRENT_AGG_ID}}");
  });
});
