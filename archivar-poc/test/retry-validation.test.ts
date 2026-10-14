/**
 * Tests for the MLLM validation-error retry algorithm in PluginApi.mllm.callJson.
 *
 * Covers:
 *  - first valid response (no retry)
 *  - retry once and succeed, asserting the correction prompt surfaces the exact
 *    field-level validation error back to the model
 *  - exhaustion throws the last formatted validation error
 *  - media filePaths are re-sent on every attempt
 *  - unparseable JSON triggers a retry with a parse-failure hint
 *  - maxRetries: 0 disables retry
 *  - default plugin graceful fallback (the original "no scene aggregations" bug)
 */
import { describe, it, expect, vi } from "vitest";
import * as yup from "yup";
import { buildPluginRpcCompositeApiInstance } from "../src/rpc/post-processing/plugin-api";
import type { PluginRpcApiCompositeInstance } from "../src/lib/plugin-types";
import type { MllmApi } from "../src/rpc/mllm-api";

// Mock getModel so importing plugins/default.ts does not require archivar config/env.
vi.mock("../src/lib/archivar-config", () => ({
  getModel: () => ({
    resolvedEndpoint: "http://mock",
    resolvedModel: "mock-model",
    resolvedApiKey: undefined,
  }),
  resolveStartMaxTokens: () => undefined,
  resolveMaxInferenceContext: () => 65536,
  resolveEstimation: () => ({ tokensPerWord: 0, tokensPerFrame: 0 }),
  resolveStructuredExtras: () => ({}),
}));

// The exact scene_type enum that the 35B-GPTQ-Int4 model was violating ("unknown").
const SCENE_TYPE_ENUM = [
  "intro", "outro", "lead-in", "anchor-lead", "ad", "teaser",
  "interview", "regional-news", "national-news", "global-news",
  "opener", "closer", "social-spot", "spot", "trailer",
  "lead-out", "sponsor-ad",
];

const sliceSchema = yup.object({
  summary: yup.string().required(),
  scene_type: yup.string().oneOf(SCENE_TYPE_ENUM).required(),
}).stripUnknown();

/**
 * Builds a PluginApi wired to a controllable fake MLLM. callRawImpl is the
 * implementation of callWithPromptRaw; the returned mock lets tests assert
 * call counts and inspect prompt arguments.
 */
function makeApi(callRawImpl: (...args: unknown[]) => Promise<string>): {
  api: PluginRpcApiCompositeInstance;
  callRaw: ReturnType<typeof vi.fn>;
} {
  // callWithPromptRaw now returns { content, usage? }; wrap the string impl.
  const callRaw = vi.fn(async (...args: unknown[]) => ({ content: await callRawImpl(...args) }));
  const fakeMllm = { callWithPromptRaw: callRaw } as unknown as MllmApi;
  // Pass no-op mocks for cache/file/analysis so no real subsystem is constructed.
  const api = buildPluginRpcCompositeApiInstance(fakeMllm, {} as never, {} as never, {} as never);
  return { api, callRaw };
}

// callWithPromptRaw positional args: (endpoint, model, apiKey, urls, prompt, ...)
const PROMPT_ARG_INDEX = 4;
const URLS_ARG_INDEX = 3;

describe("PluginApi.mllm.callJson — validation retry", () => {
  it("returns the validated result on the first valid response (no retry)", async () => {
    const { api, callRaw } = makeApi(async () =>
      JSON.stringify({ summary: "ok", scene_type: "intro", extra: "should-be-stripped" }),
    );

    const res = await api.mllm.callJson({
      endpoint: "http://x", model: "m", filePaths: [], mediaCategory: "video",
      prompt: "P", schema: sliceSchema,
    });

    expect(res).toEqual({ summary: "ok", scene_type: "intro" });
    expect(callRaw).toHaveBeenCalledTimes(1);
  });

  it("retries once with the exact validation error and succeeds on the second attempt", async () => {
    // This mirrors the real failure: the model returned scene_type: "unknown".
    const responses = [
      JSON.stringify({ summary: "x", scene_type: "unknown" }),
      JSON.stringify({ summary: "fixed", scene_type: "interview" }),
    ];
    let i = 0;
    const { api, callRaw } = makeApi(async () => responses[i++]);

    const res = await api.mllm.callJson({
      endpoint: "http://x", model: "m", filePaths: [], mediaCategory: "video",
      prompt: "ORIGINAL_PROMPT", schema: sliceSchema,
    });

    expect(res).toEqual({ summary: "fixed", scene_type: "interview" });
    expect(callRaw).toHaveBeenCalledTimes(2);

    // The retry prompt must surface the offending field path and an allowed value.
    const retryPrompt = String(callRaw.mock.calls[1][PROMPT_ARG_INDEX]);
    expect(retryPrompt).toContain("ORIGINAL_PROMPT"); // original task is preserved
    expect(retryPrompt).toContain("scene_type");      // exact field path
    expect(retryPrompt).toContain("intro");           // an allowed enum value
  });

  it("returns a degraded best-effort result after retries are exhausted (default 2)", async () => {
    // Schema non-conformance never kills the run: after all retries, callJson
    // returns the model's best-effort parsed object as a degraded fallback
    // (the non-conformance is recorded as a non-fatal error, not a fatal throw).
    const { api, callRaw } = makeApi(async () =>
      JSON.stringify({ summary: "x", scene_type: "unknown" }),
    );

    const res = await api.mllm.callJson({
      endpoint: "http://x", model: "m", filePaths: [], mediaCategory: "video",
      prompt: "P", schema: sliceSchema,
    });

    // Degraded: the parsed object is returned as-is (scene_type is invalid but present).
    expect(res).toEqual({ summary: "x", scene_type: "unknown" });
    // 1 initial attempt + 2 retries = 3 total calls.
    expect(callRaw).toHaveBeenCalledTimes(3);
  });

  it("re-sends the same media filePaths on every retry attempt", async () => {
    const responses = [
      JSON.stringify({ summary: "x", scene_type: "unknown" }),
      JSON.stringify({ summary: "ok", scene_type: "ad" }),
    ];
    let i = 0;
    const { api, callRaw } = makeApi(async () => responses[i++]);

    await api.mllm.callJson({
      endpoint: "http://x", model: "m", filePaths: ["/data/scene.mp4"],
      mediaCategory: "video", prompt: "P", schema: sliceSchema,
    });

    expect(callRaw).toHaveBeenCalledTimes(2);
    expect(callRaw.mock.calls[0][URLS_ARG_INDEX]).toEqual(["/data/scene.mp4"]);
    expect(callRaw.mock.calls[1][URLS_ARG_INDEX]).toEqual(["/data/scene.mp4"]);
  });

  it("retries when the response cannot be parsed as JSON", async () => {
    const responses = ["this is definitely not json", JSON.stringify({ summary: "ok", scene_type: "ad" })];
    let i = 0;
    const { api, callRaw } = makeApi(async () => responses[i++]);

    const res = await api.mllm.callJson({
      endpoint: "http://x", model: "m", filePaths: [], mediaCategory: "video",
      prompt: "P", schema: sliceSchema,
    });

    expect(res).toEqual({ summary: "ok", scene_type: "ad" });
    expect(callRaw).toHaveBeenCalledTimes(2);
    // The correction prompt should hint that JSON is required.
    expect(String(callRaw.mock.calls[1][PROMPT_ARG_INDEX])).toContain("JSON");
  });

  it("does not retry when maxRetries is 0 (returns degraded result immediately)", async () => {
    // With maxRetries: 0, a non-conforming response is not retried at all;
    // callJson degrades to the best-effort parsed result instead of throwing.
    const { api, callRaw } = makeApi(async () =>
      JSON.stringify({ summary: "x", scene_type: "unknown" }),
    );

    const res = await api.mllm.callJson({
      endpoint: "http://x", model: "m", filePaths: [], mediaCategory: "video",
      prompt: "P", schema: sliceSchema, maxRetries: 0,
    });

    expect(res).toEqual({ summary: "x", scene_type: "unknown" });
    expect(callRaw).toHaveBeenCalledTimes(1);
  });

  it("respects a custom maxRetries value", async () => {
    const responses = [
      JSON.stringify({ summary: "x", scene_type: "unknown" }),
      JSON.stringify({ summary: "x", scene_type: "unknown" }),
      JSON.stringify({ summary: "x", scene_type: "unknown" }),
      JSON.stringify({ summary: "ok", scene_type: "teaser" }),
    ];
    let i = 0;
    const { api, callRaw } = makeApi(async () => responses[i++]);

    const res = await api.mllm.callJson({
      endpoint: "http://x", model: "m", filePaths: [], mediaCategory: "video",
      prompt: "P", schema: sliceSchema, maxRetries: 5,
    });

    expect(res).toEqual({ summary: "ok", scene_type: "teaser" });
    expect(callRaw).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
  });
});

describe("default plugin graceful fallback (the 'no scene aggregations' bug)", () => {
  it("postProcessPerAggregation returns an empty patch when callJson exhausts retries", async () => {
    // Import AFTER vi.mock is registered so getModel is stubbed.
    const { postProcessPerAggregation } = await import("../plugins/default");

    const api: PluginRpcApiCompositeInstance = {
      file: {} as PluginRpcApiCompositeInstance["file"],
      cache: {} as PluginRpcApiCompositeInstance["cache"],
      analysis: {} as PluginRpcApiCompositeInstance["analysis"],
      mllm: {
        callRaw: vi.fn(),
        callJson: vi.fn().mockRejectedValue(
          new Error("MLLM response validation failed: scene_type: must be one of the following values: intro, outro, ..."),
        ),
      },
      util: {
        parseJsonLoose: vi.fn(),
        formatTime: vi.fn(),
        limitConcurrency: vi.fn(),
        logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
      },
    };

    const aggregation = {
      id: "default:aggregation:0",
      pluginName: "default",
      index: 0,
      sliceIndexes: [0],
      sliceIds: ["scene:0:0:0-5"],
      from: "00:00:00",
      to: "00:00:05",
      fromSeconds: 0,
      toSeconds: 5,
    };
    const slices = [{
      type: "scene",
      plugin: { default: { summary: "some scene", scene_type: "interview" } },
    }];

    // includeTypes: ["scene"] → text-only branch → calls callJson → rejects → {}.
    const patch = await postProcessPerAggregation(
      aggregation as never,
      slices as never,
      { modelName: "mock-model", includeTypes: ["scene"] } as never,
      api,
    );

    // The aggregation survives (graceful fallback) instead of producing no analysis at all.
    expect(patch).toEqual({});
    expect(api.mllm.callJson).toHaveBeenCalledTimes(1);
  });
});
