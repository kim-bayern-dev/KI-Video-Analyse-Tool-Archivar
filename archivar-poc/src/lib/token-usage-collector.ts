/**
 * Per-run token-usage accumulation for one analyze workflow.
 *
 * WHY: the transport layer ([`src/rpc/mllm-api.ts`](../rpc/mllm-api.ts)) now surfaces
 * per-call `usage` ([`RawCallResult.usage`](../rpc/mllm-api.ts)), but a workflow run
 * makes many calls across TWO layers — `WorkflowEngine` (captioning/ASR) and the
 * post-processing plugins (`callJson`/`callRaw` → `callWithPromptRaw`) — that share no
 * explicit handle. Threading an accumulator through every signature is invasive
 * (`callWithPromptRaw` already has 14 params; plugins call through the composite API).
 *
 * So we mirror the proven debug-capture pattern
 * ([`workflow-engine.ts:172`](../rpc/workflow-engine.ts)): a per-run `AsyncLocalStorage`
 * store that leaf calls write to via [`recordTokenUsage()`](#). `runWorkflow` enters the
 * store once; everything in its async tree (plugin hooks, `callJson` retries, the schema
 * probe) is captured automatically. `recordTokenUsage` is a **no-op outside a run**
 * (health checks, ad-hoc calls, the CSR client action) — no false accounting.
 */
import { AsyncLocalStorage } from "node:async_hooks";
// type-only import: erased at compile time, so no runtime circular dependency with mllm-api.
import type { TokenUsage } from "../rpc/mllm-api.js";

/** Flat per-run token summary, attached to `AnalysisResult.tokenUsage`. */
export interface TokenUsageSummary {
  /** Σ prompt (input) tokens across all calls in the run. */
  input: number;
  /** Σ completion (output) tokens across all calls in the run. */
  output: number;
  /** Σ total_tokens across all calls (≈ input + output). */
  total: number;
}

/** Coerce a backend usage field to a finite number, treating anything else as 0. */
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Per-run accumulator. `add()` ignores `undefined` usage (e.g.
 * `/v1/audio/transcriptions`, which carries no token metadata) and guards against
 * non-numeric fields, so a malformed/partial backend response can't corrupt the totals.
 */
export class TokenUsageAccumulator {
  private input = 0;
  private output = 0;
  private total = 0;

  /** Add one call's usage. Safe to call with `undefined`/partial usage. */
  add(usage: TokenUsage | undefined): void {
    if (!usage) return;
    const p = num(usage.prompt_tokens);
    const c = num(usage.completion_tokens);
    const t = num(usage.total_tokens);
    this.input += p;
    this.output += c;
    // total_tokens is authoritative when present; fall back to input+output for
    // backends that omit it (keeps total ≈ input+output in every case).
    this.total += t > 0 ? t : p + c;
  }

  summarize(): TokenUsageSummary {
    return { input: this.input, output: this.output, total: this.total };
  }
}

/** Per-run store. Entered once by `WorkflowEngine.runWorkflow`. */
export const tokenUsageCapture = new AsyncLocalStorage<TokenUsageAccumulator>();

/**
 * Leaf helper called by every transport method (and the JSON-schema probe) after a
 * backend response. **No-op when no run is active** — see module header.
 */
export function recordTokenUsage(usage: TokenUsage | undefined): void {
  const acc = tokenUsageCapture.getStore();
  if (acc) acc.add(usage);
}
