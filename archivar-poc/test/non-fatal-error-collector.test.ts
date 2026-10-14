/**
 * Tests for the per-run non-fatal-error accumulator + classifier + AsyncLocalStorage
 * capture ([`src/lib/non-fatal-error-collector.ts`](../src/lib/non-fatal-error-collector.ts)),
 * plus an integration check that `callJson` retries are recorded.
 */
import { describe, it, expect, vi } from "vitest";
import * as yup from "yup";
import {
  NonFatalErrorAccumulator,
  nonFatalErrorCapture,
  recordNonFatalError,
  classifyNonFatalReason,
  nonFatalReasonBreakdown,
  countFromErrorsJson,
} from "../src/lib/non-fatal-error-collector";
import {
  JsonSchemaUnsupportedError,
  TruncatedStructuredOutputError,
  UnsupportedYupNodeError,
} from "../src/lib/errors";
import { buildPluginRpcCompositeApiInstance } from "../src/rpc/post-processing/plugin-api";
import type { PluginRpcApiCompositeInstance } from "../src/lib/plugin-types";
import type { MllmApi } from "../src/rpc/mllm-api";

// Mock getModel so importing the plugin API doesn't require archivar config/env.
vi.mock("../src/lib/archivar-config", () => ({
  getModel: () => ({ resolvedEndpoint: "http://mock", resolvedModel: "mock-model", resolvedApiKey: undefined }),
  resolveStartMaxTokens: () => undefined,
  resolveMaxInferenceContext: () => 65536,
  resolveEstimation: () => ({ tokensPerWord: 0, tokensPerFrame: 0 }),
  resolveStructuredExtras: () => ({}),
}));

describe("classifyNonFatalReason", () => {
  it("maps the typed errors", () => {
    expect(classifyNonFatalReason(new TruncatedStructuredOutputError(64))).toBe("context");
    expect(classifyNonFatalReason(new JsonSchemaUnsupportedError("e", "response_format", "nope"))).toBe("transport");
    expect(classifyNonFatalReason(new UnsupportedYupNodeError("mixed"))).toBe("schema");
  });

  it("maps obvious message patterns", () => {
    expect(classifyNonFatalReason(new Error("maximum context length is 8192 tokens"))).toBe("context");
    expect(classifyNonFatalReason(new Error("response_format not supported by model"))).toBe("transport");
    expect(classifyNonFatalReason(new Error("MLLM response could not be parsed as JSON"))).toBe("schema");
    expect(classifyNonFatalReason(new Error("MLLM response validation failed: scene_type ..."))).toBe("schema");
    expect(classifyNonFatalErrorName()).toBe("schema"); // yup ValidationError by name
  });

  it("maps timeouts / unreachable endpoints", () => {
    const timeoutErr = new Error("fetch failed");
    timeoutErr.name = "TimeoutError";
    expect(classifyNonFatalReason(timeoutErr)).toBe("timeout");
    expect(classifyNonFatalReason(new Error("connect ECONNREFUSED 127.0.0.1:8920"))).toBe("timeout");
    expect(classifyNonFatalReason(new Error("endpoint not reachable"))).toBe("timeout");
  });

  it("falls back to unknown for anything else", () => {
    expect(classifyNonFatalReason(new Error("something unusual happened"))).toBe("unknown");
    expect(classifyNonFatalReason("a bare string")).toBe("unknown");
    expect(classifyNonFatalReason(undefined)).toBe("unknown");
  });
});

/** yup throws an Error whose `name === "ValidationError"` — classify by name (message is a field path). */
function classifyNonFatalErrorName(): string {
  const e = new Error("scene_type must be one of: intro, outro");
  e.name = "ValidationError";
  return classifyNonFatalReason(e);
}

describe("NonFatalErrorAccumulator + primaryMessage", () => {
  it("derives reason + capped primary message (no stack)", () => {
    const acc = new NonFatalErrorAccumulator();
    const err = new Error("validation failed: scene_type");
    err.stack = "Error: validation failed\n    at foo\n    at bar";
    acc.add(err, "Qwen3.8-27B-FP8");
    const s = acc.summarize();
    expect(s.count).toBe(1);
    expect(s.trace[0]).toEqual({
      id: "ERR-1",
      reason: "schema",
      model: "Qwen3.8-27B-FP8",
      details: "validation failed: scene_type",
      stackTrace: "Error: validation failed\n    at foo\n    at bar",
    });
  });

  it("caps long details (240 + ellipsis) and uses '' for missing model", () => {
    const acc = new NonFatalErrorAccumulator();
    acc.add(new Error("x".repeat(500)), "");
    const details = acc.summarize().trace[0].details;
    // DETAILS_MAX_LEN (240) + 1 ellipsis char.
    expect(details.length).toBeLessThanOrEqual(241);
    expect(details.endsWith("…")).toBe(true);
    expect(acc.summarize().trace[0].model).toBe("");
  });

  it("summarize count === trace.length, even with zero entries", () => {
    expect(new NonFatalErrorAccumulator().summarize()).toEqual({ count: 0, trace: [] });
  });
});

describe("recordNonFatalError + AsyncLocalStorage", () => {
  it("is a no-op outside a scope", () => {
    expect(() => recordNonFatalError(new Error("x"), "m")).not.toThrow();
  });

  it("accumulates within a scope and stops after", () => {
    const acc = new NonFatalErrorAccumulator();
    const summary = nonFatalErrorCapture.run(acc, () => {
      recordNonFatalError(new Error("validation failed"), "m1");
      recordNonFatalError(new TruncatedStructuredOutputError(8), "m2");
      return acc.summarize();
    });
    expect(summary.count).toBe(2);
    expect(summary.trace.map((e) => e.reason)).toEqual(["schema", "context"]);
    // After the scope exits, recording is a no-op again.
    recordNonFatalError(new Error("late"), "m3");
    expect(acc.summarize().count).toBe(2);
  });
});

describe("nonFatalReasonBreakdown", () => {
  it("returns reason counts in stable order, omitting zeros", () => {
    const acc = new NonFatalErrorAccumulator();
    acc.add(new Error("validation failed"), "m");
    acc.add(new Error("validation failed"), "m");
    acc.add(new Error("connect ECONNREFUSED"), "m");
    expect(nonFatalReasonBreakdown(acc.summarize())).toEqual([
      { reason: "schema", count: 2 },
      { reason: "timeout", count: 1 },
    ]);
  });
  it("returns [] for empty/undefined", () => {
    expect(nonFatalReasonBreakdown(undefined)).toEqual([]);
    expect(nonFatalReasonBreakdown({ count: 0, trace: [] })).toEqual([]);
  });
});

describe("callJson retry recording (integration)", () => {
  const SCENE_TYPE_ENUM = ["intro", "outro", "interview"];
  const sliceSchema = yup.object({
    summary: yup.string().required(),
    scene_type: yup.string().oneOf(SCENE_TYPE_ENUM).required(),
  }).stripUnknown();

  function makeApi(impl: (...a: unknown[]) => Promise<unknown>): {
    api: PluginRpcApiCompositeInstance;
    raw: ReturnType<typeof vi.fn>;
  } {
    const raw = vi.fn(async (...a: unknown[]) => ({ content: await impl(...a) }));
    const fakeMllm = { callWithPromptRaw: raw } as unknown as MllmApi;
    const api = buildPluginRpcCompositeApiInstance(fakeMllm, {} as never, {} as never, {} as never);
    return { api, raw };
  }

  it("records one non-fatal schema error per retry, then succeeds", async () => {
    const responses = [
      JSON.stringify({ summary: "x", scene_type: "unknown" }), // invalid → retry (recorded)
      JSON.stringify({ summary: "ok", scene_type: "interview" }), // valid
    ];
    let i = 0;
    const { api } = makeApi(async () => responses[i++]);

    const acc = new NonFatalErrorAccumulator();
    const res = await nonFatalErrorCapture.run(acc, () =>
      api.mllm.callJson({
        endpoint: "http://x", model: "Qwen3.8-27B-FP8", filePaths: [], mediaCategory: "video",
        prompt: "P", schema: sliceSchema,
      }),
    );

    expect(res).toEqual({ summary: "ok", scene_type: "interview" });
    const s = acc.summarize();
    expect(s.count).toBe(1);
    expect(s.trace[0].reason).toBe("schema");
    expect(s.trace[0].model).toBe("Qwen3.8-27B-FP8");
  });

  it("records a final non-fatal schema error on exhaustion and returns degraded result (no throw)", async () => {
    // Every response is non-conforming (scene_type "unknown" is not in the enum).
    // callJson must NOT throw fatally; instead it records one schema error per
    // retry AND a final exhaustion error, then returns the best-effort parsed
    // object so the slice still gets the model's answer.
    const { api, raw } = makeApi(async () =>
      JSON.stringify({ summary: "degraded but present", scene_type: "unknown" }),
    );

    const acc = new NonFatalErrorAccumulator();
    const res = await nonFatalErrorCapture.run(acc, () =>
      api.mllm.callJson({
        endpoint: "http://x", model: "Qwen3.8-27B-FP8", filePaths: [], mediaCategory: "video",
        prompt: "P", schema: sliceSchema, maxRetries: 2,
      }),
    );

    // Degraded: the parsed object is returned as-is (not validated).
    expect(res).toEqual({ summary: "degraded but present", scene_type: "unknown" });
    // 1 initial + 2 retries = 3 calls.
    expect(raw).toHaveBeenCalledTimes(3);

    // Non-fatal trace: 2 per-retry errors + 1 final exhaustion error = 3.
    const s = acc.summarize();
    expect(s.count).toBe(3);
    expect(s.trace.every((e) => e.reason === "schema")).toBe(true);
    expect(s.trace.every((e) => e.model === "Qwen3.8-27B-FP8")).toBe(true);
    // The final entry records the exhaustion explicitly.
    expect(s.trace[2].details).toMatch(/exhausted/i);
  });
});


describe("errors.json artifact (ids, wire context, incremental persist)", () => {
  it("assigns sequential ERR-N ids and captures stackTrace", () => {
    const acc = new NonFatalErrorAccumulator();
    acc.add(new Error("first"), "m");
    acc.add(new Error("second"), "m");
    const ids = acc.summarize().trace.map((e) => e.id);
    expect(ids).toEqual(["ERR-1", "ERR-2"]);
    expect(acc.summarize().trace[0].stackTrace).toContain("Error: first");
  });

  it("captures an explicit wire context", () => {
    const acc = new NonFatalErrorAccumulator();
    const wire = {
      requestBody: '{"model":"m"}',
      status: 400,
      statusText: "Bad Request",
      responseHeaders: { "content-type": "application/json" },
      responseBody: '{"error":"nope"}',
    };
    acc.add(new Error("HTTP 400"), "m", wire);
    expect(acc.summarize().trace[0].wire).toEqual(wire);
  });

  it("picks up a wire context attached to the thrown error", () => {
    const acc = new NonFatalErrorAccumulator();
    const err = Object.assign(new Error("wrapped"), { wire: { status: 500, responseBody: "boom" } });
    acc.add(err, "m");
    expect(acc.summarize().trace[0].wire).toEqual({ status: 500, responseBody: "boom" });
  });

  it("rewrites errors.json on every add", async () => {
    const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "errjson-"));
    try {
      const p = join(dir, "errors.json");
      const acc = new NonFatalErrorAccumulator(p);
      acc.add(new Error("one"), "m");
      let onDisk = JSON.parse(readFileSync(p, "utf-8"));
      expect(onDisk.nonFatalErrors).toHaveLength(1);
      expect(onDisk.nonFatalErrors[0].id).toBe("ERR-1");
      acc.add(new Error("two"), "m");
      onDisk = JSON.parse(readFileSync(p, "utf-8"));
      expect(onDisk.nonFatalErrors).toHaveLength(2);
      expect(onDisk.nonFatalErrors[1].id).toBe("ERR-2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("countFromErrorsJson", () => {
  it("returns the trace length for a valid payload", () => {
    expect(countFromErrorsJson(JSON.stringify({ nonFatalErrors: [{ id: "ERR-1" }, { id: "ERR-2" }] }))).toBe(2);
    expect(countFromErrorsJson(JSON.stringify({ nonFatalErrors: [] }))).toBe(0);
  });

  it("returns null for malformed or unexpected content (unknown ≠ clean)", () => {
    expect(countFromErrorsJson("not json")).toBeNull();
    expect(countFromErrorsJson("")).toBeNull();
    expect(countFromErrorsJson(JSON.stringify({}))).toBeNull();
    expect(countFromErrorsJson(JSON.stringify({ nonFatalErrors: 5 }))).toBeNull();
  });
});
