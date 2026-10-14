/**
 * Per-run, per-request VLM usage tracking for one analyze workflow.
 *
 * WHY: understanding what a model's context window should be requires ACTUAL
 * per-request numbers — the backend-reported `usage` (input/output/total
 * tokens), the `max_tokens` request parameter as sent, and wall-clock elapsed
 * per request (mapping to the processing log via the `LLM-N` request id).
 * `token-usage-collector.ts` only sums totals; this module keeps each request.
 *
 * Mechanism mirrors the other per-run collectors (AsyncLocalStorage store
 * entered by `WorkflowEngine.runWorkflow`; leaf call sites record via
 * [`recordVlmRequest()`](#)). **No-op outside a run.** When constructed with a
 * path, every add rewrites `<file>.archivar/vlm-requests.json` so the artifact
 * survives a mid-run crash. Persist failures are logged, never thrown.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { writeFileSync } from "node:fs";

/** Pipeline stage a recorded request belongs to (ASR is always "caption"). */
export type VlmRequestType = "caption" | "aggregation" | "hoa" | "summary";

/** One recorded VLM request (actuals as reported by the backend — no estimates). */
export interface VlmRequestEntry {
  /** Request id matching the processing log, e.g. "LLM-345". */
  id: string;
  /** Pipeline stage — defaults from the active requestPhaseCapture store. */
  type?: VlmRequestType;
  /** Resolved model string the request was sent to. */
  model: string;
  /** usage.prompt_tokens as reported by the backend. */
  inputTokens: number;
  /** usage.completion_tokens as reported by the backend. */
  outputTokens: number;
  /** The max_tokens request parameter as sent (null when not set). */
  maxTokens: number | null;
  /** usage.total_tokens as reported (falls back to input+output when absent). */
  totalTokens: number;
  /** Wall-clock seconds of the HTTP call. */
  timeElapsedSecs: number;
}

/** vlm-requests.json file shape: per-request actuals + min/max aggregates. */
export interface VlmRequestsFile {
  /** The single model used, "mixed" when several, null when no requests. */
  model: string | null;
  requests: VlmRequestEntry[];
  minInputTokens: number | null;
  maxInputTokens: number | null;
  minOutputTokens: number | null;
  maxOutputTokens: number | null;
  minTotalTokens: number | null;
  maxTotalTokens: number | null;
  minTimeElapsedSecs: number | null;
  maxTimeElapsedSecs: number | null;
}

function buildFile(requests: VlmRequestEntry[]): VlmRequestsFile {
  const models = new Set(requests.map((r) => r.model));
  const minmax = (pick: (r: VlmRequestEntry) => number): [number | null, number | null] =>
    requests.length === 0
      ? [null, null]
      : [
          Math.min(...requests.map(pick)),
          Math.max(...requests.map(pick)),
        ];
  const [minIn, maxIn] = minmax((r) => r.inputTokens);
  const [minOut, maxOut] = minmax((r) => r.outputTokens);
  const [minTot, maxTot] = minmax((r) => r.totalTokens);
  const [minT, maxT] = minmax((r) => r.timeElapsedSecs);
  return {
    model: models.size === 0 ? null : models.size === 1 ? [...models][0] : "mixed",
    requests,
    minInputTokens: minIn,
    maxInputTokens: maxIn,
    minOutputTokens: minOut,
    maxOutputTokens: maxOut,
    minTotalTokens: minTot,
    maxTotalTokens: maxTot,
    minTimeElapsedSecs: minT,
    maxTimeElapsedSecs: maxT,
  };
}

/**
 * Per-run accumulator. When constructed with `vlmRequestsJsonPath`, every add
 * rewrites the artifact (complete file each time — small even for long runs).
 */
export class VlmRequestAccumulator {
  private requests: VlmRequestEntry[] = [];

  constructor(private readonly vlmRequestsJsonPath?: string) {}

  add(entry: VlmRequestEntry): void {
    // Type defaults from the active pipeline-phase store (set by the workflow
    // engine around processing/hook invocations); "caption" as the final default.
    this.requests.push({ ...entry, type: entry.type ?? requestPhaseCapture.getStore() ?? "caption" });
    this.persist();
  }

  private persist(): void {
    if (!this.vlmRequestsJsonPath) return;
    try {
      writeFileSync(this.vlmRequestsJsonPath, JSON.stringify(buildFile(this.requests), null, 2));
    } catch (e) {
      console.error(`[vlm-request-collector] Failed to write ${this.vlmRequestsJsonPath}:`, e);
    }
  }

  /** Current aggregate snapshot (same shape as the persisted file). */
  summarize(): VlmRequestsFile {
    return buildFile(this.requests);
  }
}

/** Per-run store. Entered once by `WorkflowEngine.runWorkflow`. */
export const vlmRequestCapture = new AsyncLocalStorage<VlmRequestAccumulator>();

/**
 * Current pipeline phase ("caption" during processing, hook-mapped stage during
 * post-processing). Entered by the workflow engine around each stage/hook so
 * leaf calls can classify their requests without signature changes.
 */
export const requestPhaseCapture = new AsyncLocalStorage<VlmRequestType>();

/** Initial empty artifact content (written at run start, before any request). */
export function emptyVlmRequestsFile(): VlmRequestsFile {
  return buildFile([]);
}

/**
 * Leaf helper called by transport methods after a backend response.
 * **No-op when no run is active** — see module header.
 */
export function recordVlmRequest(entry: VlmRequestEntry): void {
  const acc = vlmRequestCapture.getStore();
  if (acc) acc.add(entry);
}
