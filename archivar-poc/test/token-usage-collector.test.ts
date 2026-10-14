/**
 * Tests for the per-run token-usage accumulator + AsyncLocalStorage capture
 * ([`src/lib/token-usage-collector.ts`](../src/lib/token-usage-collector.ts)).
 *
 * Covers: accumulation math (input/output/total), undefined/partial-usage safety,
 * the `total_tokens` fallback to input+output, `recordTokenUsage` being a no-op
 * outside a run, and accumulation inside a `tokenUsageCapture` scope. A live,
 * health-gated test proves the mllm-api transport layer actually feeds the
 * accumulator end-to-end.
 */
import { describe, it, expect } from "vitest";
import {
  TokenUsageAccumulator,
  tokenUsageCapture,
  recordTokenUsage,
} from "../src/lib/token-usage-collector";
import type { TokenUsage } from "../src/rpc/mllm-api";
import { MllmApi } from "../src/rpc/mllm-api";
import { skipIfModelUnhealthy } from "./utils/live-models.js";

const VLM_MODEL = process.env.E2E_VLM_MODEL ?? "Qwen3.8-27B-FP8";

/** Minimal dotenv loader for .env.local (MODEL_CONFIG holds endpoints). No deps. */
function loadEnvLocal(): void {
  try {
    const fs = require("node:fs");
    const path = require("node:path");
    const raw = fs.readFileSync(path.resolve(__dirname, "..", ".env.local"), "utf8");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq < 0) continue;
      const key = t.slice(0, eq).trim();
      let val = t.slice(eq + 1).trim();
      const head = val.charCodeAt(0);
      const tail = val.charCodeAt(val.length - 1);
      const SQ = 0x27;
      const DQ = 0x22;
      if ((head === SQ && tail === SQ) || (head === DQ && tail === DQ)) val = val.slice(1, -1);
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch {
    /* .env.local absent */
  }
}

async function resolveTarget(modelName: string) {
  loadEnvLocal();
  const { getModel } = await import("../src/lib/archivar-config");
  await import("../archivar.config.js");
  const cfg = getModel(modelName);
  return {
    model: cfg.resolvedModel,
    endpoint: process.env.E2E_LLM_ENDPOINT ?? cfg.resolvedEndpoint,
    apiKey: process.env.E2E_LLM_API_KEY ?? cfg.resolvedApiKey,
  };
}

describe("TokenUsageAccumulator", () => {
  it("sums prompt/completion/total across calls", () => {
    const acc = new TokenUsageAccumulator();
    acc.add({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } as TokenUsage);
    acc.add({ prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 } as TokenUsage);
    expect(acc.summarize()).toEqual({ input: 30, output: 7, total: 37 });
  });

  it("ignores undefined usage (e.g. /v1/audio/transcriptions)", () => {
    const acc = new TokenUsageAccumulator();
    acc.add(undefined);
    acc.add({ prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } as TokenUsage);
    expect(acc.summarize()).toEqual({ input: 4, output: 1, total: 5 });
  });

  it("guards against non-numeric / partial fields without corrupting totals", () => {
    const acc = new TokenUsageAccumulator();
    acc.add({ prompt_tokens: "x", completion_tokens: NaN, total_tokens: undefined } as unknown as TokenUsage);
    expect(acc.summarize()).toEqual({ input: 0, output: 0, total: 0 });
  });

  it("falls back to input+output when total_tokens is missing/zero", () => {
    const acc = new TokenUsageAccumulator();
    acc.add({ prompt_tokens: 7, completion_tokens: 3 } as TokenUsage);
    expect(acc.summarize()).toEqual({ input: 7, output: 3, total: 10 });
  });
});

describe("recordTokenUsage + AsyncLocalStorage", () => {
  it("is a no-op outside a tokenUsageCapture scope", () => {
    // No active store → must not throw and must not accumulate anywhere.
    expect(() => recordTokenUsage({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } as TokenUsage)).not.toThrow();
  });

  it("accumulates within a tokenUsageCapture scope (and not outside it)", () => {
    const acc = new TokenUsageAccumulator();
    const summary = tokenUsageCapture.run(acc, () => {
      recordTokenUsage({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } as TokenUsage);
      recordTokenUsage(undefined);
      return acc.summarize();
    });
    expect(summary).toEqual({ input: 100, output: 50, total: 150 });
    // After the scope exits, recordTokenUsage is a no-op again.
    expect(() => recordTokenUsage({ prompt_tokens: 9, completion_tokens: 9, total_tokens: 9 } as TokenUsage)).not.toThrow();
    expect(acc.summarize()).toEqual({ input: 100, output: 50, total: 150 });
  });

  it("live: MllmApi.callWithPromptRaw feeds the accumulator within a run scope", async ({ skip }) => {
    const gate = await skipIfModelUnhealthy(VLM_MODEL);
    if (gate) return skip(gate);
    const t = await resolveTarget(VLM_MODEL);
    const api = new MllmApi();
    const acc = new TokenUsageAccumulator();

    const result = await tokenUsageCapture.run(acc, () =>
      api.callWithPromptRaw(
        t.endpoint,
        t.model,
        t.apiKey,
        [], // text-only chat-completion still returns `usage`
        "Sage in genau einem Wort: Hallo.",
        "image",
        // Explicit cap: the 122000 free-form default exceeds reduced-window
        // deployments (--max-model-len 65536) with a hard 400.
        { max_tokens: 1024 },
      ),
    );

    // The call surfaced usage AND the per-run accumulator captured it.
    expect(typeof result.content).toBe("string");
    expect(result.usage, "callWithPromptRaw MUST surface usage").toBeTypeOf("object");
    const summary = acc.summarize();
    expect(summary.input).toBeGreaterThan(0);
    expect(summary.output).toBeGreaterThan(0);
    // total must equal the call's total_tokens (single call in this scope).
    expect(summary.total).toBe(result.usage!.total_tokens);
    // eslint-disable-next-line no-console
    console.log("[e2e:token-usage] accumulated:", summary);
  });
});
