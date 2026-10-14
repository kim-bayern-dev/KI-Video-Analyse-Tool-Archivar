import { describe, it, expect } from "vitest";
import {
  resolveStartMaxTokens,
  resolveMaxInferenceContext,
  setArchivarConfig,
} from "../src/lib/archivar-config.js";
import type { ArchivarConfig } from "../src/lib/workflow-types.js";

function makeConfig(extra: Partial<ArchivarConfig> = {}): ArchivarConfig {
  return { auth: { users: [] }, ...extra };
}

const MODELS: ArchivarConfig["models"] = [
  {
    name: "Qwen3.8-27B-FP8",
    type: "api",
    model: "Qwen3.8-27B-FP8",
    contextWindows: { aggregation: 32768, hoa: 16384, summary: 8192 },
  },
  {
    // registry name differs from the resolved model string (gemma-style)
    name: "gemma4-e4b-qat-w4a16",
    type: "api",
    model: "gemma-4-E4B-it-qat-w4a16-ct",
    contextWindows: { aggregation: 32768, hoa: 16384, summary: 8192 },
  },
  { name: "no-windows", type: "api", model: "no-windows" },
];

describe("resolveStartMaxTokens", () => {
  it("resolves the per-type start window by registry name", () => {
    setArchivarConfig(makeConfig({ models: MODELS }));
    expect(resolveStartMaxTokens("Qwen3.8-27B-FP8", "aggregation")).toBe(32768);
    expect(resolveStartMaxTokens("Qwen3.8-27B-FP8", "hoa")).toBe(16384);
    expect(resolveStartMaxTokens("Qwen3.8-27B-FP8", "summary")).toBe(8192);
  });

  it("also finds the model by its resolved model string", () => {
    setArchivarConfig(makeConfig({ models: MODELS }));
    expect(resolveStartMaxTokens("gemma-4-E4B-it-qat-w4a16-ct", "aggregation")).toBe(32768);
  });

  it("returns undefined for caption and undefined type (caption uses hyperparams.max_tokens)", () => {
    setArchivarConfig(makeConfig({ models: MODELS }));
    expect(resolveStartMaxTokens("Qwen3.8-27B-FP8", "caption")).toBeUndefined();
    expect(resolveStartMaxTokens("Qwen3.8-27B-FP8", undefined)).toBeUndefined();
  });

  it("returns undefined for unknown models and models without contextWindows", () => {
    setArchivarConfig(makeConfig({ models: MODELS }));
    expect(resolveStartMaxTokens("does-not-exist", "aggregation")).toBeUndefined();
    expect(resolveStartMaxTokens("no-windows", "aggregation")).toBeUndefined();
  });

  it("returns undefined when no config is installed", () => {
    // module singleton without models set
    setArchivarConfig(makeConfig());
    expect(resolveStartMaxTokens("Qwen3.8-27B-FP8", "aggregation")).toBeUndefined();
  });
});

describe("resolveMaxInferenceContext", () => {
  it("defaults to 65536 without any configuration", () => {
    setArchivarConfig(makeConfig({ models: MODELS }));
    expect(resolveMaxInferenceContext("Qwen3.8-27B-FP8")).toBe(65536);
    expect(resolveMaxInferenceContext("unknown-model")).toBe(65536);
  });

  it("uses the top-level contextWindows.maxInferenceContext", () => {
    setArchivarConfig(makeConfig({ models: MODELS, contextWindows: { maxInferenceContext: 131072 } }));
    expect(resolveMaxInferenceContext("Qwen3.8-27B-FP8")).toBe(131072);
  });

  it("prefers the per-model override over the top-level value", () => {
    setArchivarConfig(makeConfig({
      contextWindows: { maxInferenceContext: 131072 },
      models: [
        { name: "m1", type: "api", model: "m1", contextWindows: { maxInferenceContext: 98304 } },
        { name: "m2", type: "api", model: "m2" },
      ],
    }));
    expect(resolveMaxInferenceContext("m1")).toBe(98304);
    expect(resolveMaxInferenceContext("m2")).toBe(131072);
  });
});

describe("maxInferenceContext validation", () => {
  it("accepts values beyond 64k (128k is the whole point)", () => {
    expect(() =>
      setArchivarConfig(makeConfig({ contextWindows: { maxInferenceContext: 131072 } })),
    ).not.toThrow();
  });

  it("rejects non-positive and non-integer values (top-level and per-model)", () => {
    expect(() =>
      setArchivarConfig(makeConfig({ contextWindows: { maxInferenceContext: 0 } })),
    ).toThrow(/Invalid contextWindows\.maxInferenceContext/);
    expect(() =>
      setArchivarConfig(makeConfig({
        models: [{ name: "m", type: "api", model: "m", contextWindows: { maxInferenceContext: -1 } }],
      })),
    ).toThrow(/Invalid contextWindows\.maxInferenceContext for model "m"/);
  });
});

describe("contextWindows validation", () => {
  it("accepts valid windows", () => {
    expect(() => setArchivarConfig(makeConfig({ models: MODELS }))).not.toThrow();
  });

  it("rejects non-positive, non-integer and over-ceiling values", () => {
    for (const bad of [0, -1, 8192.5, 65537, 131072]) {
      const cfg = makeConfig({
        models: [{ name: "m", type: "api", model: "m", contextWindows: { aggregation: bad } }],
      });
      expect(() => setArchivarConfig(cfg), `value ${bad} must throw`).toThrow(/Invalid contextWindows\.aggregation/);
    }
  });

  it("rejects invalid windows on any key (hoa/summary)", () => {
    const cfg = makeConfig({
      models: [{ name: "m", type: "api", model: "m", contextWindows: { summary: 0 } }],
    });
    expect(() => setArchivarConfig(cfg)).toThrow(/Invalid contextWindows\.summary/);
  });
});
