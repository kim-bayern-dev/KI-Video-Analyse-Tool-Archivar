/**
 * Tests for native JSON-schema mode threading through PluginApi.mllm.callJson.
 *
 * Uses a fake MllmApi (callWithPromptRaw) — no network. Covers:
 *  - Yup schema is converted and jsonSchema/jsonSchemaMode reach callWithPromptRaw
 *  - mixed() schema degrades to prompt-only under "auto"
 *  - mixed() schema fails fast under an explicit mode
 *  - TruncatedStructuredOutputError bumps max_tokens and retries within budget
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as yup from "yup";
import { buildPluginRpcCompositeApiInstance } from "../src/rpc/post-processing/plugin-api";
import type { PluginRpcApiCompositeInstance } from "../src/lib/plugin-types";
import type { MllmApi } from "../src/rpc/mllm-api";
import { UnsupportedYupNodeError, TruncatedStructuredOutputError } from "../src/lib/errors";
import { requestPhaseCapture } from "../src/lib/vlm-request-collector";

// Per-test controllable start-window map for the resolveStartMaxTokens mock.
let mockStartWindows: Record<string, number> | null = null;
// Per-test controllable bump ceiling for the resolveMaxInferenceContext mock.
let mockMaxInferenceContext = 65536;

// Mock getModel so importing plugins doesn't require archivar config/env.
vi.mock("../src/lib/archivar-config", () => ({
  getModel: () => ({
    resolvedEndpoint: "http://mock",
    resolvedModel: "mock-model",
    resolvedApiKey: undefined,
  }),
  resolveStartMaxTokens: (_model: string, type?: string) => mockStartWindows?.[type ?? ""] as number | undefined,
  resolveMaxInferenceContext: () => mockMaxInferenceContext,
  // Zero estimation keeps attempt-cap arithmetic visible in the ladder tests:
  // attemptCap = mockMaxInferenceContext − 0 − 1024 (CONTEXT_MARGIN_TOKENS).
  resolveEstimation: () => ({ tokensPerWord: 0, tokensPerFrame: 0 }),
  resolveStructuredExtras: () => ({}),
}));

beforeEach(() => {
  mockStartWindows = null;
  mockMaxInferenceContext = 65536;
});

const simpleSchema = yup.object({
  answer: yup.boolean().required(),
  reasoning: yup.string().required(),
}).stripUnknown();

const mixedSchema = yup.object({
  answer: yup.mixed().required(),
  reasoning: yup.string().required(),
}).stripUnknown();

function makeApi(callRawImpl: (...args: unknown[]) => Promise<string>): {
  api: PluginRpcApiCompositeInstance;
  callRaw: ReturnType<typeof vi.fn>;
} {
  // callWithPromptRaw now returns { content, usage? }; wrap the string impl.
  const callRaw = vi.fn(async (...args: unknown[]) => ({ content: await callRawImpl(...args) }));
  const fakeMllm = { callWithPromptRaw: callRaw } as unknown as MllmApi;
  const api = buildPluginRpcCompositeApiInstance(fakeMllm, {} as never, {} as never, {} as never);
  return { api, callRaw };
}

describe("PluginApi.mllm.callJson — native JSON-schema mode", () => {
  it("converts the Yup schema and passes jsonSchema + mode to callWithPromptRaw", async () => {
    const { api, callRaw } = makeApi(async () =>
      JSON.stringify({ answer: true, reasoning: "ok" }),
    );

    const res = await api.mllm.callJson({
      endpoint: "http://x", model: "m", filePaths: [], mediaCategory: "video",
      prompt: "P", schema: simpleSchema, jsonSchemaMode: "response_format",
    });

    expect(res).toEqual({ answer: true, reasoning: "ok" });
    expect(callRaw).toHaveBeenCalledTimes(1);
    // Positional args: jsonSchema is index 10, jsonSchemaMode index 11.
    const firstCall = callRaw.mock.calls[0] as unknown[];
    expect(firstCall[10]).toBeDefined(); // jsonSchema present
    expect(firstCall[11]).toBe("response_format");
  });

  it("does not attach jsonSchema when mode is explicitly false", async () => {
    const { api, callRaw } = makeApi(async () =>
      JSON.stringify({ answer: true, reasoning: "ok" }),
    );

    await api.mllm.callJson({
      endpoint: "http://x", model: "m", filePaths: [], mediaCategory: "video",
      prompt: "P", schema: simpleSchema, jsonSchemaMode: false,
    });

    const firstCall = callRaw.mock.calls[0] as unknown[];
    expect(firstCall[10]).toBeUndefined();
    expect(firstCall[11]).toBe(false);
  });

  it("defaults to auto mode when jsonSchemaMode is unset", async () => {
    const { api, callRaw } = makeApi(async () =>
      JSON.stringify({ answer: true, reasoning: "ok" }),
    );

    await api.mllm.callJson({
      endpoint: "http://x", model: "m", filePaths: [], mediaCategory: "video",
      prompt: "P", schema: simpleSchema,
    });

    const firstCall = callRaw.mock.calls[0] as unknown[];
    // Default-on: mode resolves to "auto" even when unset in args.
    expect(firstCall[11]).toBe("auto");
  });

  it("degrades to prompt-only for a mixed() schema under auto mode", async () => {
    const { api, callRaw } = makeApi(async () =>
      JSON.stringify({ answer: true, reasoning: "ok" }),
    );

    const res = await api.mllm.callJson({
      endpoint: "http://x", model: "m", filePaths: [], mediaCategory: "video",
      prompt: "P", schema: mixedSchema, jsonSchemaMode: "auto",
    });

    expect(res).toEqual({ answer: true, reasoning: "ok" });
    const firstCall = callRaw.mock.calls[0] as unknown[];
    // Degraded: no jsonSchema attached even though mode is auto.
    expect(firstCall[10]).toBeUndefined();
    expect(firstCall[11]).toBe("auto");
  });

  it("fails fast for a mixed() schema under an explicit mode", async () => {
    const { api, callRaw } = makeApi(async () => "unused");

    await expect(
      api.mllm.callJson({
        endpoint: "http://x", model: "m", filePaths: [], mediaCategory: "video",
        prompt: "P", schema: mixedSchema, jsonSchemaMode: "response_format",
      }),
    ).rejects.toBeInstanceOf(UnsupportedYupNodeError);

    // Must not have called the LLM at all.
    expect(callRaw).not.toHaveBeenCalled();
  });

  it("bumps max_tokens and retries on TruncatedStructuredOutputError", async () => {
    // First attempt truncates; second succeeds.
    let attempt = 0;
    const { api, callRaw } = makeApi(async (...args: unknown[]) => {
      attempt++;
      if (attempt === 1) {
        // hyperparams is positional arg index 6.
        const hp = args[6] as { max_tokens?: number } | undefined;
        throw new TruncatedStructuredOutputError(hp?.max_tokens);
      }
      return JSON.stringify({ answer: true, reasoning: "ok" });
    });

    const res = await api.mllm.callJson({
      endpoint: "http://x", model: "m", filePaths: [], mediaCategory: "video",
      prompt: "P", schema: simpleSchema, jsonSchemaMode: "response_format",
      maxRetries: 2,
      hyperparams: { max_tokens: 1000 },
    });

    expect(res).toEqual({ answer: true, reasoning: "ok" });
    expect(callRaw).toHaveBeenCalledTimes(2);
    // Second attempt doubled max_tokens.
    const secondHyperparams = (callRaw.mock.calls[1][6] as { max_tokens: number });
    expect(secondHyperparams.max_tokens).toBe(2000);
    // …and the structured cap (positional arg 12) is bumped alongside, otherwise
    // applyStructuredSampling's Math.min would re-cap the retry to the original
    // ceiling and silently neutralize the bump. Attempt 0 carries the per-attempt
    // budget cap (65536 − 0-est − 1024 margin = 64512); the bumped value stays below it.
    expect(callRaw.mock.calls[0][12]).toBe(64512);
    expect(callRaw.mock.calls[1][12]).toBe(2000);
  });

  it("compounds the bump across consecutive truncations (16k → 32k → capped 64512)", async () => {
    // All attempts truncate until the budget is exhausted.
    const { api, callRaw } = makeApi(async (...args: unknown[]) => {
      const hp = args[6] as { max_tokens?: number } | undefined;
      throw new TruncatedStructuredOutputError(hp?.max_tokens);
    });

    await expect(
      api.mllm.callJson({
        endpoint: "http://x", model: "m", filePaths: [], mediaCategory: "video",
        prompt: "P", schema: simpleSchema, jsonSchemaMode: "response_format",
        maxRetries: 2,
        hyperparams: { max_tokens: 16384 },
        structuredMaxTokens: 16384,
      }),
    ).rejects.toBeInstanceOf(TruncatedStructuredOutputError);

    expect(callRaw).toHaveBeenCalledTimes(3);
    expect((callRaw.mock.calls[0][6] as { max_tokens: number }).max_tokens).toBe(16384);
    expect((callRaw.mock.calls[1][6] as { max_tokens: number }).max_tokens).toBe(32768);
    // Third step: 65536 planned, capped at ceiling − margin (65536 − 1024).
    expect((callRaw.mock.calls[2][6] as { max_tokens: number }).max_tokens).toBe(64512);
    expect(callRaw.mock.calls[0][12]).toBe(16384);
    expect(callRaw.mock.calls[1][12]).toBe(32768);
    expect(callRaw.mock.calls[2][12]).toBe(64512);
  });

  it('json_object mode passes the mode and sets response_format to { type: "json_object" }', async () => {
    const { api, callRaw } = makeApi(async () =>
      JSON.stringify({ answer: true, reasoning: "ok" }),
    );

    await api.mllm.callJson({
      endpoint: "http://x", model: "m", filePaths: [], mediaCategory: "video",
      prompt: "P", schema: simpleSchema, jsonSchemaMode: "json_object",
    });

    expect(callRaw).toHaveBeenCalledTimes(1);
    const firstCall = callRaw.mock.calls[0] as unknown[];
    expect(firstCall[11]).toBe("json_object");
  });
});

describe("callJson — per-type start windows (contextWindows)", () => {
  it("uses the aggregation window when running in the aggregation phase", async () => {
    mockStartWindows = { aggregation: 32768, summary: 8192 };
    const { api, callRaw } = makeApi(async () => JSON.stringify({ answer: true, reasoning: "ok" }));

    await requestPhaseCapture.run("aggregation", () =>
      api.mllm.callJson({
        endpoint: "http://x", model: "m", filePaths: [], mediaCategory: "video",
        prompt: "P", schema: simpleSchema, jsonSchemaMode: "response_format",
        structuredMaxTokens: 16384,
      }),
    );

    // structuredMaxTokens positional arg 12: type window beats the plugin pin.
    expect(callRaw.mock.calls[0][12]).toBe(32768);
  });

  it("uses the summary window when running in the summary phase", async () => {
    mockStartWindows = { aggregation: 32768, summary: 8192 };
    const { api, callRaw } = makeApi(async () => JSON.stringify({ answer: true, reasoning: "ok" }));

    await requestPhaseCapture.run("summary", () =>
      api.mllm.callJson({
        endpoint: "http://x", model: "m", filePaths: [], mediaCategory: "video",
        prompt: "P", schema: simpleSchema, jsonSchemaMode: "response_format",
        structuredMaxTokens: 16384,
      }),
    );

    expect(callRaw.mock.calls[0][12]).toBe(8192);
  });

  it("falls back to the plugin-passed structuredMaxTokens when no window is configured", async () => {
    const { api, callRaw } = makeApi(async () => JSON.stringify({ answer: true, reasoning: "ok" }));

    await requestPhaseCapture.run("aggregation", () =>
      api.mllm.callJson({
        endpoint: "http://x", model: "m", filePaths: [], mediaCategory: "video",
        prompt: "P", schema: simpleSchema, jsonSchemaMode: "response_format",
        structuredMaxTokens: 16384,
      }),
    );

    expect(callRaw.mock.calls[0][12]).toBe(16384);
  });

  it("caps the truncation bump at ceiling − margin (32k → 64512 → 64512)", async () => {
    const { api, callRaw } = makeApi(async (...args: unknown[]) => {
      const hp = args[6] as { max_tokens?: number } | undefined;
      throw new TruncatedStructuredOutputError(hp?.max_tokens);
    });

    await expect(
      requestPhaseCapture.run("aggregation", () =>
        api.mllm.callJson({
          endpoint: "http://x", model: "m", filePaths: [], mediaCategory: "video",
          prompt: "P", schema: simpleSchema, jsonSchemaMode: "response_format",
          maxRetries: 2,
          hyperparams: { max_tokens: 32768 },
          structuredMaxTokens: 32768,
        }),
      ),
    ).rejects.toBeInstanceOf(TruncatedStructuredOutputError);

    // Per-attempt budget cap: 65536 (ceiling) − 0 (zero-est mock) − 1024 (margin) = 64512.
    expect(callRaw).toHaveBeenCalledTimes(3);
    expect((callRaw.mock.calls[0][6] as { max_tokens: number }).max_tokens).toBe(32768);
    expect((callRaw.mock.calls[1][6] as { max_tokens: number }).max_tokens).toBe(64512);
    expect((callRaw.mock.calls[2][6] as { max_tokens: number }).max_tokens).toBe(64512);
    expect(callRaw.mock.calls[0][12]).toBe(32768);
    expect(callRaw.mock.calls[1][12]).toBe(64512);
    expect(callRaw.mock.calls[2][12]).toBe(64512);
  });

  it("with maxInferenceContext 128k the ladder reaches it minus margin (32k → 64k → 130048)", async () => {
    mockMaxInferenceContext = 131072;
    const { api, callRaw } = makeApi(async (...args: unknown[]) => {
      const hp = args[6] as { max_tokens?: number } | undefined;
      throw new TruncatedStructuredOutputError(hp?.max_tokens);
    });

    await expect(
      requestPhaseCapture.run("aggregation", () =>
        api.mllm.callJson({
          endpoint: "http://x", model: "m", filePaths: [], mediaCategory: "video",
          prompt: "P", schema: simpleSchema, jsonSchemaMode: "response_format",
          maxRetries: 2,
          hyperparams: { max_tokens: 32768 },
          structuredMaxTokens: 32768,
        }),
      ),
    ).rejects.toBeInstanceOf(TruncatedStructuredOutputError);

    expect(callRaw).toHaveBeenCalledTimes(3);
    expect((callRaw.mock.calls[0][6] as { max_tokens: number }).max_tokens).toBe(32768);
    expect((callRaw.mock.calls[1][6] as { max_tokens: number }).max_tokens).toBe(65536);
    expect((callRaw.mock.calls[2][6] as { max_tokens: number }).max_tokens).toBe(130048);
    expect(callRaw.mock.calls[0][12]).toBe(32768);
    expect(callRaw.mock.calls[1][12]).toBe(65536);
    expect(callRaw.mock.calls[2][12]).toBe(130048);
  });
});


describe("PluginApi.mllm.callJson — atypical-symbols degeneration retry", () => {
  const SOUP = "漢字漢字漢字 漢字"; // 5 CJK chars ≥ threshold 3
  const CLEAN = JSON.stringify({ answer: true, reasoning: "ok" });

  it("retries once with the language note prepended when the response is symbol soup", async () => {
    const responses = [SOUP, CLEAN];
    const { api, callRaw } = makeApi(async () => responses.shift()!);

    const res = await api.mllm.callJson({
      endpoint: "http://x", model: "m", filePaths: [], mediaCategory: "video",
      prompt: "P", schema: simpleSchema, jsonSchemaMode: "response_format",
    });

    expect(res).toEqual({ answer: true, reasoning: "ok" });
    expect(callRaw).toHaveBeenCalledTimes(2);
    // prompt is positional arg index 4; attempt 0 untouched, retry prepends the note.
    expect(callRaw.mock.calls[0][4]).toBe("P");
    expect(callRaw.mock.calls[1][4]).toMatch(
      /^Last time the output wasn't in the primary language and contained non-standard Unicode chars\. This time, the response should not mix languages\.\n\nP/,
    );
  });

  it("retries only once: a still-atypical second response goes through the normal path", async () => {
    const soupJson = JSON.stringify({ answer: true, reasoning: "漢字漢字" });
    const responses = [soupJson, soupJson];
    const { api, callRaw } = makeApi(async () => responses.shift()!);

    const res = await api.mllm.callJson({
      endpoint: "http://x", model: "m", filePaths: [], mediaCategory: "video",
      prompt: "P", schema: simpleSchema, jsonSchemaMode: "response_format",
    });

    // Exactly one extra attempt; the second (still atypical) response is
    // parsed/validated normally and returned.
    expect(callRaw).toHaveBeenCalledTimes(2);
    expect((res as { reasoning: string }).reasoning).toContain("漢字");
  });

  it("does not burn schema-retry budget: parse failure afterwards still gets full retries", async () => {
    const responses = [SOUP, "not json at all", CLEAN];
    const { api, callRaw } = makeApi(async () => responses.shift()!);

    const res = await api.mllm.callJson({
      endpoint: "http://x", model: "m", filePaths: [], mediaCategory: "video",
      prompt: "P", schema: simpleSchema, jsonSchemaMode: "response_format",
      maxRetries: 2,
    });

    expect(res).toEqual({ answer: true, reasoning: "ok" });
    // 3 calls with maxRetries=2: the degeneration attempt is replayed, not counted.
    expect(callRaw).toHaveBeenCalledTimes(3);
    // The correction prompt after the parse failure also carries the prefix.
    expect(callRaw.mock.calls[2][4]).toMatch(/^Last time the output wasn't/);
  });

  it("clean responses never trigger the retry", async () => {
    const { api, callRaw } = makeApi(async () => CLEAN);

    await api.mllm.callJson({
      endpoint: "http://x", model: "m", filePaths: [], mediaCategory: "video",
      prompt: "P", schema: simpleSchema, jsonSchemaMode: "response_format",
    });

    expect(callRaw).toHaveBeenCalledTimes(1);
    expect(callRaw.mock.calls[0][4]).toBe("P");
  });

  it("strips model-imitated (x1) singleton markers from the response", async () => {
    const { api } = makeApi(async () =>
      JSON.stringify({ answer: true, reasoning: "Tabelle:\n| Logo | x | (x1)\nnormaler Text (x2)" }),
    );

    const res = await api.mllm.callJson<{ answer: boolean; reasoning: string }>({
      endpoint: "http://x", model: "m", filePaths: [], mediaCategory: "video",
      prompt: "P", schema: simpleSchema, jsonSchemaMode: "response_format",
    });

    expect(res.reasoning).toBe("Tabelle:\n| Logo | x |\nnormaler Text (x2)");
  });
});


describe("PluginApi.mllm.callJson — truncation ladder starts from the sent budget", () => {
  it("doubles from err.maxTokens (32k start window → 64k), not from the 16k default", async () => {
    // Regression: with hyperparams.max_tokens unset, the ladder used to restart
    // at STRUCTURED_OUTPUT_DEFAULTS.maxTokens (16k) — the first "bump" 16k→32k
    // was a no-op against a 32k start window and burned the retry.
    const { api, callRaw } = makeApi(async () => {
      throw new TruncatedStructuredOutputError(32768);
    });

    await expect(
      api.mllm.callJson({
        endpoint: "http://x", model: "m", filePaths: [], mediaCategory: "video",
        prompt: "P", schema: simpleSchema, jsonSchemaMode: "response_format",
        maxRetries: 1,
      }),
    ).rejects.toBeInstanceOf(TruncatedStructuredOutputError);

    expect(callRaw).toHaveBeenCalledTimes(2);
    // Ceiling 65536 (mockMaxInferenceContext default), attempt cap = 65536 − 1024.
    // Old code would have retried at 32768 (no-op); fixed code doubles the sent
    // 32768 → 65536, clamped to the 64512 attempt cap.
    expect((callRaw.mock.calls[1][6] as { max_tokens: number }).max_tokens).toBe(64512);
    expect(callRaw.mock.calls[1][12]).toBe(64512);
  });
});
