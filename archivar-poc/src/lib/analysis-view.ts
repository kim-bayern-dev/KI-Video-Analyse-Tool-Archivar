/**
 * Lean per-file payloads for dashboard RPC methods (`CacheApi.getCaptionsByHash`
 * / `CacheApi.getAnalysisViewByHash`).
 *
 * WHY: the dashboard used to pull whole cache tables (`getAll("scene")` ≈ 6 MB,
 * `getAll("speech")` ≈ 2 MB) and the file's full AnalysisResult (~1–3 MB) over
 * the wire, while the UI renders only captions, aggregation regions, the
 * filtered summary view and the provenance footer. These pure shapers cut the
 * payloads to exactly that, server-side. Nothing here mutates stored data.
 */

import type { AnalysisResult } from "../db/db.js";
import {
  toResultView,
  summarizeProcessingTime,
  type ProcessingTimeSummary,
} from "./result-view.js";
import type { TokenUsageSummary } from "./token-usage-collector.js";
import type { NonFatalErrorSummary } from "./non-fatal-error-collector.js";

/** Anything carrying an optional caption (cache-table entries). */
interface Captioned {
  caption?: unknown;
}

/**
 * Keep `cacheId → caption` for every key containing `hash` with a non-empty
 * string caption. Matches the substring semantics of
 * `CacheApi.getByKeySubstring`; key scheme `${outputHash}[-suffix]-${index}`
 * (see `getCacheId`, src/rpc/workflow-engine.ts:84).
 */
export function extractCaptionsByHash(
  tables: Array<Record<string, Captioned>>,
  hash: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const table of tables) {
    for (const [key, entry] of Object.entries(table)) {
      if (!key.includes(hash)) continue;
      const caption = entry?.caption;
      if (typeof caption === "string" && caption.trim() !== "") out[key] = caption;
    }
  }
  return out;
}

/** Minimal per-segment shape the dashboard consumes (captions + timing). */
export interface AnalysisViewSegment {
  index: number;
  startTime: number;
  endTime: number;
  caption?: string;
}

/** Minimal per-scene shape (nested segment captions used for event backfill). */
export interface AnalysisViewScene extends AnalysisViewSegment {
  speech: AnalysisViewSegment[];
  harmonic: AnalysisViewSegment[];
  noise: AnalysisViewSegment[];
}

/** Aggregation fields the timeline + events list consume. */
export interface AnalysisViewAggregation {
  id: string;
  index: number;
  fromSeconds: number;
  toSeconds: number;
  pluginName: string;
  summary: string;
}

/** HOA fields the timeline consumes (green indicators). */
export interface AnalysisViewHoa {
  id: string;
  index: number;
  aggregationIndexes: number[];
  title: string;
}

/** Lean per-file analysis view — the dashboard's whole per-click payload. */
export interface AnalysisView {
  /** Chosen aggregated cache key; null when no cached result exists. */
  key: string | null;
  scenes: AnalysisViewScene[];
  semanticAggregations: AnalysisViewAggregation[];
  higherOrderAggregations: AnalysisViewHoa[];
  /** Filtered summary/HOA view for the Summary and All Results tabs. */
  resultView: AnalysisResult | null;
  processingTime: ProcessingTimeSummary | null;
  tokenUsage?: TokenUsageSummary;
  nonFatalErrors?: NonFatalErrorSummary;
}

const toSegment = (seg: unknown): AnalysisViewSegment | null => {
  if (typeof seg !== "object" || seg === null) return null;
  const s = seg as Record<string, unknown>;
  if (typeof s.index !== "number") return null;
  const out: AnalysisViewSegment = {
    index: s.index,
    startTime: typeof s.startTime === "number" ? s.startTime : 0,
    endTime: typeof s.endTime === "number" ? s.endTime : 0,
  };
  if (typeof s.caption === "string" && s.caption) out.caption = s.caption;
  return out;
};

const toSegments = (list: unknown): AnalysisViewSegment[] =>
  (Array.isArray(list) ? list : [])
    .map(toSegment)
    .filter((s): s is AnalysisViewSegment => s !== null);

/** Aggregation summaries are `JsonValue | string` — flatten like the dashboard does. */
const flattenSummary = (summary: unknown): string => {
  if (typeof summary === "string") return summary;
  if (typeof summary === "object" && summary !== null) {
    const inner = (summary as Record<string, unknown>).summary;
    if (typeof inner === "string") return inner;
  }
  return "";
};

/**
 * Reduce a full AnalysisResult to the lean dashboard view. Strips every
 * per-segment URL/fileName/outputHash duplicate (the bulk of the multi-MB
 * full result). `resultView` is the filtered summary/HOA view from
 * `toResultView()` (HOA descriptions already table-stripped).
 */
export function buildAnalysisView(result: AnalysisResult | null, key: string | null): AnalysisView {
  if (!result) {
    return {
      key: null,
      scenes: [],
      semanticAggregations: [],
      higherOrderAggregations: [],
      resultView: null,
      processingTime: null,
    };
  }

  const scenes: AnalysisViewScene[] = (result.scenes ?? []).map((scene) => ({
    index: scene.index,
    startTime: scene.startTime,
    endTime: scene.endTime,
    ...(scene.caption ? { caption: scene.caption } : {}),
    speech: toSegments(scene.speech),
    harmonic: toSegments(scene.harmonic),
    noise: toSegments(scene.noise),
  }));

  const semanticAggregations: AnalysisViewAggregation[] = (result.semanticAggregations ?? []).map((agg) => ({
    id: agg.id,
    index: agg.index,
    fromSeconds: agg.fromSeconds,
    toSeconds: agg.toSeconds,
    pluginName: agg.pluginName,
    summary: flattenSummary(agg.summary),
  }));

  const higherOrderAggregations: AnalysisViewHoa[] = (result.higherOrderAggregations ?? []).map((hoa) => ({
    id: hoa.id,
    index: hoa.index,
    aggregationIndexes: hoa.aggregationIndexes ?? [],
    title: hoa.title ?? `HOA ${hoa.index + 1}`,
  }));

  return {
    key,
    scenes,
    semanticAggregations,
    higherOrderAggregations,
    resultView: toResultView(result),
    processingTime: summarizeProcessingTime(result),
    ...(result.tokenUsage ? { tokenUsage: result.tokenUsage } : {}),
    ...(result.nonFatalErrors ? { nonFatalErrors: result.nonFatalErrors } : {}),
  };
}
