/**
 * Integration tests for wire-context capture and per-request usage recording
 * in MllmApi.callWithPromptRaw (errors.json / vlm-requests.json data sources):
 *  - HTTP 400 → recordNonFatalError receives the full wire context
 *    (request body, status, headers, response body)
 *  - HTTP 200 → recordVlmRequest receives actual usage + maxTokens + elapsed
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let lastBody: Record<string, unknown> | undefined;
let nextResponse: { ok: boolean; status?: number; content?: string; usage?: Record<string, number> } = { ok: true };

vi.mock("../src/lib/long-fetch", () => ({
  longFetch: vi.fn(async (_url: string, init: RequestInit) => {
    lastBody = JSON.parse(init.body as string);
    return {
      ok: nextResponse.ok,
      status: nextResponse.status ?? (nextResponse.ok ? 200 : 400),
      statusText: nextResponse.ok ? "OK" : "Bad Request",
      json: async () => ({
        choices: [{ message: { content: nextResponse.content ?? "ok" }, finish_reason: "stop" }],
        usage: nextResponse.usage,
      }),
      text: async () => '{"error":{"message":"boom"}}',
      headers: new Map([["content-type", "application/json"], ["x-request-id", "req-1"]]),
    };
  }),
}));

import { MllmApi } from "../src/rpc/mllm-api";
import {
  NonFatalErrorAccumulator,
  nonFatalErrorCapture,
} from "../src/lib/non-fatal-error-collector";
import {
  VlmRequestAccumulator,
  vlmRequestCapture,
} from "../src/lib/vlm-request-collector";

beforeEach(() => {
  lastBody = undefined;
  nextResponse = { ok: true };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("wire context capture (errors.json source)", () => {
  it("attaches the full wire context to the thrown error on HTTP 400", async () => {
    nextResponse = { ok: false, status: 400 };
    const acc = new NonFatalErrorAccumulator();
    await nonFatalErrorCapture.run(acc, async () => {
      await expect(
        new MllmApi().callWithPromptRaw("http://e", "m", undefined, [], "prompt", "audio"),
      ).rejects.toThrow(/400/);
      // Simulate the downstream catch site (workflow-engine / plugin-api):
      try {
        await new MllmApi().callWithPromptRaw("http://e", "m", undefined, [], "prompt", "audio");
      } catch (err) {
        const { recordNonFatalError } = await import("../src/lib/non-fatal-error-collector.js");
        recordNonFatalError(err, "m");
      }
    });
    expect(acc.summarize().count).toBe(1);
    const wire = acc.summarize().trace[0].wire;
    expect(wire).toBeDefined();
    expect(wire!.status).toBe(400);
    expect(wire!.responseBody).toContain("boom");
    expect(wire!.responseHeaders).toMatchObject({ "x-request-id": "req-1" });
    expect(JSON.parse(wire!.requestBody!)).toMatchObject({ model: "m" });
  });
});

describe("per-request usage recording (vlm-requests.json source)", () => {
  it("records actual usage, maxTokens and elapsed on success", async () => {
    nextResponse = { ok: true, usage: { prompt_tokens: 1234, completion_tokens: 56, total_tokens: 1290 } };
    const acc = new VlmRequestAccumulator();
    await vlmRequestCapture.run(acc, async () => {
      await new MllmApi().callWithPromptRaw(
        "http://e", "m", undefined, [], "prompt", "audio",
        { max_tokens: 4096 },
      );
    });
    const s = acc.summarize();
    expect(s.requests).toHaveLength(1);
    const r = s.requests[0];
    expect(r.id).toMatch(/^LLM-\d+$/);
    expect(r.model).toBe("m");
    expect(r.inputTokens).toBe(1234);
    expect(r.outputTokens).toBe(56);
    expect(r.totalTokens).toBe(1290);
    expect(r.maxTokens).toBe(4096);
    expect(r.timeElapsedSecs).toBeGreaterThanOrEqual(0);
    expect(s.maxInputTokens).toBe(1234);
    expect(s.minTotalTokens).toBe(1290);
  });

  it("records nothing outside a run (no store)", async () => {
    nextResponse = { ok: true, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    // No vlmRequestCapture scope: must not throw and must not record anywhere.
    await new MllmApi().callWithPromptRaw("http://e", "m", undefined, [], "prompt", "audio");
  });
});
