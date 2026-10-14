/**
 * Per-run aggregation of NON-FATAL errors for one analyze workflow.
 *
 * WHY: a workflow run recovers from many errors (JSON-schema/parse retries, context-window
 * overflow clamp-and-retry, transport rejection, endpoint timeouts, isolated per-segment
 * captioning/ASR failures, collected plugin-hook failures). None kill the run, but they're
 * useful diagnostics. We aggregate them into `result.nonFatalErrors = { count, trace }` so an
 * operator can see how "clean" a run was, mirroring the `tokenUsage` accumulator.
 *
 * Mechanism is identical to [`token-usage-collector.ts`](./token-usage-collector.ts): a per-run
 * `AsyncLocalStorage` store entered by `WorkflowEngine.runWorkflow`; leaf catch sites call
 * [`recordNonFatalError()`](#). No-op outside a run. Fatal errors (run-killing throws) are NOT
 * recorded here — only recovered/isolated ones.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { writeFileSync } from "node:fs";
import {
  JsonSchemaUnsupportedError,
  TruncatedStructuredOutputError,
  UnsupportedYupNodeError,
} from "./errors.js";

/** Coarse, "obvious-to-identify" reason for a non-fatal error. `unknown` is the catch-all. */
export type NonFatalReason = "schema" | "timeout" | "transport" | "context" | "unknown";

/** Original on-the-wire context of a failed backend call, for root-cause tracing. */
export interface WireContext {
  /** The exact JSON body that was sent. */
  requestBody?: string;
  status?: number;
  statusText?: string;
  responseHeaders?: Record<string, string>;
  /** The complete response body as received from the wire. */
  responseBody?: string;
}

/** One aggregated non-fatal error entry. */
export interface NonFatalErrorEntry {
  /** Sequential per-run id ("ERR-1", "ERR-2", …) — mapping key into errors.json. */
  id: string;
  reason: NonFatalReason;
  /** Resolved model name at the call site ("" when genuinely unknown). */
  model: string;
  /** Primary error message only (no stack/trace), capped. */
  details: string;
  /** Full stack trace when the recorded value was an Error. */
  stackTrace?: string;
  /** Original wire request/response when the error came from a backend call. */
  wire?: WireContext;
}

/** Per-run non-fatal error summary, attached to `AnalysisResult.nonFatalErrors`. */
export interface NonFatalErrorSummary {
  count: number;
  trace: NonFatalErrorEntry[];
}

/** Cap details so one verbose error can't dominate the trace. */
const DETAILS_MAX_LEN = 240;

/** First line of an error's message, capped; falls back to String(err). No stack. */
function primaryMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const firstLine = raw.split("\n", 1)[0]?.trim() || raw.trim();
  return firstLine.length > DETAILS_MAX_LEN
    ? `${firstLine.slice(0, DETAILS_MAX_LEN)}…`
    : firstLine;
}

/**
 * Map an error to a `NonFatalReason`. Only unambiguous signals are mapped; anything
 * unrecognized → "unknown" (per the spec: "only what is obvious to identify").
 * Order matters — check the most specific typed errors first.
 */
export function classifyNonFatalReason(err: unknown): NonFatalReason {
  if (err instanceof TruncatedStructuredOutputError) return "context";
  if (err instanceof JsonSchemaUnsupportedError) return "transport";
  if (err instanceof UnsupportedYupNodeError) return "schema";

  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  const name = (err as { name?: string } | null)?.name ?? "";

  // Context-length overflow (vLLM "maximum context length is C tokens"), mm
  // encoder-cache overflow or max_tokens truncation.
  if (/maximum context length|context length|encoder[ -]cache|max_tokens|truncat/i.test(msg)) return "context";
  // Structured-output transport rejection (body names the field).
  if (/response_format|structured_outputs|guided_json|transport/i.test(msg)) return "transport";
  // Schema/Yup validation or JSON-parse failure inside callJson. yup throws an
  // Error whose `name === "ValidationError"` with a field-path message.
  if (
    name === "ValidationError" ||
    /validation failed|could not be parsed as json|unsupported yup node|schema/i.test(msg)
  ) {
    return "schema";
  }
  // Network/timeout: AbortSignal.timeout, unreachable endpoints, connection resets.
  if (
    name === "TimeoutError" ||
    name === "AbortError" ||
    /timeout|timed out|econnrefused|enotfound|econnreset|fetch failed|not reachable|unreachable|socket hang up/i.test(
      msg,
    )
  ) {
    return "timeout";
  }
  return "unknown";
}

/**
 * Per-run accumulator. `add` derives the reason + details; safe with any thrown value.
 * When constructed with `errorsJsonPath`, every add rewrites
 * `<file>.archivar/errors.json` (`{ nonFatalErrors: [...] }`) so the artifact is
 * complete even when the run dies mid-flight. Persist failures are logged, never thrown.
 */
export class NonFatalErrorAccumulator {
  private trace: NonFatalErrorEntry[] = [];

  constructor(private readonly errorsJsonPath?: string) {}

  add(err: unknown, model: string, wire?: WireContext): void {
    const entry: NonFatalErrorEntry = {
      id: `ERR-${this.trace.length + 1}`,
      reason: classifyNonFatalReason(err),
      model: model || "",
      details: primaryMessage(err),
    };
    if (err instanceof Error && err.stack) entry.stackTrace = err.stack;
    // Explicit param wins; otherwise pick up a wire context attached to the
    // thrown error (mllm-api stamps `(err as any).wire` before throwing, so
    // downstream catch sites need no signature change).
    const w = wire ?? (err as { wire?: WireContext } | null)?.wire;
    if (w) entry.wire = w;
    this.trace.push(entry);
    this.persist();
  }

  private persist(): void {
    if (!this.errorsJsonPath) return;
    try {
      writeFileSync(this.errorsJsonPath, JSON.stringify({ nonFatalErrors: this.trace }, null, 2));
    } catch (e) {
      console.error(`[non-fatal-error-collector] Failed to write ${this.errorsJsonPath}:`, e);
    }
  }

  summarize(): NonFatalErrorSummary {
    return { count: this.trace.length, trace: this.trace };
  }
}

/** Per-run store. Entered once by `WorkflowEngine.runWorkflow`. */
export const nonFatalErrorCapture = new AsyncLocalStorage<NonFatalErrorAccumulator>();

/**
 * Parse the error count from an errors.json payload. Returns `null` when the
 * content is missing or malformed — "unknown" must not be confused with
 * "clean" (fail-open: callers skip the degraded-run check rather than lie).
 */
export function countFromErrorsJson(content: string): number | null {
  try {
    const parsed: unknown = JSON.parse(content);
    const trace = (parsed as { nonFatalErrors?: unknown } | null)?.nonFatalErrors;
    return Array.isArray(trace) ? trace.length : null;
  } catch {
    return null;
  }
}

/**
 * Leaf helper called at non-fatal catch sites (retries, isolations, plugin-hook failures).
 * **No-op when no run is active** — see module header.
 */
export function recordNonFatalError(err: unknown, model: string, wire?: WireContext): void {
  const acc = nonFatalErrorCapture.getStore();
  if (acc) acc.add(err, model, wire);
}

/**
 * Reason → count breakdown for compact rendering (Markdown/Word/UI). Returns entries in a
 * stable reason order, omitting zero counts. e.g. `[{reason:"schema",count:2},{reason:"timeout",count:1}]`.
 */
export function nonFatalReasonBreakdown(summary: NonFatalErrorSummary | undefined): Array<{ reason: NonFatalReason; count: number }> {
  if (!summary?.trace?.length) return [];
  const counts = new Map<NonFatalReason, number>();
  for (const e of summary.trace) counts.set(e.reason, (counts.get(e.reason) ?? 0) + 1);
  const order: NonFatalReason[] = ["schema", "context", "transport", "timeout", "unknown"];
  return order.filter((r) => counts.has(r)).map((r) => ({ reason: r, count: counts.get(r)! }));
}
