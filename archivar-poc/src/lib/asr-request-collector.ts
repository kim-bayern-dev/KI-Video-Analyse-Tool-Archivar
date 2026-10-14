/**
 * Per-run ASR request tracking for one analyze workflow — the
 * **`asr-requests.json`** artifact. Mirrors `vlm-request-collector.ts`, but for
 * speech transcription: per request the sequential id (`ASR-N`), `type`
 * (always `"caption"` — ASR only captions speech), the resolved `model`, the
 * audio `lengthInMins` and wall-clock `timeElapsedSecs`, plus min/max
 * aggregates. Token usage is not tracked here (the multipart transcription
 * protocols carry none; chat-protocol ASR usage lands in vlm-requests.json).
 *
 * Same `AsyncLocalStorage` pattern as the other collectors — no-op outside a
 * run; constructed with a path by `runWorkflow`, every add rewrites
 * `<file>.archivar/asr-requests.json`. Persist failures are logged, never thrown.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { writeFileSync } from "node:fs";

/** One recorded ASR request. */
export interface AsrRequestEntry {
  /** Sequential per-run id ("ASR-1", "ASR-2", …). */
  id: string;
  /** Always "caption" — ASR only ever captions speech segments. */
  type: "caption";
  /** Resolved model string the request was sent to. */
  model: string;
  /** Audio length in minutes (null when the caller couldn't determine it). */
  lengthInMins: number | null;
  /** Wall-clock seconds of the HTTP call. */
  timeElapsedSecs: number;
}

/** asr-requests.json file shape. */
export interface AsrRequestsFile {
  /** The single model used, "mixed" when several, null when no requests. */
  model: string | null;
  requests: AsrRequestEntry[];
  /** Shortest/longest recorded audio length in minutes (null when unknown). */
  minLengthMin: number | null;
  maxLengthMin: number | null;
  minTimeElapsedSecs: number | null;
  maxTimeElapsedSecs: number | null;
}

function buildFile(requests: AsrRequestEntry[]): AsrRequestsFile {
  const models = new Set(requests.map((r) => r.model));
  const minmax = (pick: (r: AsrRequestEntry) => number | null): [number | null, number | null] => {
    const values = requests.map(pick).filter((v): v is number => v !== null);
    return values.length === 0 ? [null, null] : [Math.min(...values), Math.max(...values)];
  };
  const [minLen, maxLen] = minmax((r) => r.lengthInMins);
  const [minT, maxT] = minmax((r) => r.timeElapsedSecs);
  return {
    model: models.size === 0 ? null : models.size === 1 ? [...models][0] : "mixed",
    requests,
    minLengthMin: minLen,
    maxLengthMin: maxLen,
    minTimeElapsedSecs: minT,
    maxTimeElapsedSecs: maxT,
  };
}

/** Per-run accumulator; assigns sequential ASR-N ids. */
export class AsrRequestAccumulator {
  private requests: AsrRequestEntry[] = [];

  constructor(private readonly asrRequestsJsonPath?: string) {}

  add(entry: Omit<AsrRequestEntry, "id" | "type">): void {
    this.requests.push({ ...entry, id: `ASR-${this.requests.length + 1}`, type: "caption" });
    this.persist();
  }

  private persist(): void {
    if (!this.asrRequestsJsonPath) return;
    try {
      writeFileSync(this.asrRequestsJsonPath, JSON.stringify(buildFile(this.requests), null, 2));
    } catch (e) {
      console.error(`[asr-request-collector] Failed to write ${this.asrRequestsJsonPath}:`, e);
    }
  }

  summarize(): AsrRequestsFile {
    return buildFile(this.requests);
  }
}

/** Per-run store. Entered once by `WorkflowEngine.runWorkflow`. */
export const asrRequestCapture = new AsyncLocalStorage<AsrRequestAccumulator>();

/** Initial empty artifact content (written at run start, before any request). */
export function emptyAsrRequestsFile(): AsrRequestsFile {
  return buildFile([]);
}

/** Leaf helper called by ASR transport methods after a backend response. */
export function recordAsrRequest(entry: Omit<AsrRequestEntry, "id" | "type">): void {
  const acc = asrRequestCapture.getStore();
  if (acc) acc.add(entry);
}
