/**
 * Filtered "result view" for rendering and downloads.
 *
 * Reading an existing analysis result for display (dashboard "All Results"
 * tab, DOCX/MD/JSON downloads) should expose only a reduced view of the full
 * result JSON: `summary` and `higherOrderAggregations` entries pass,
 * everything else is dropped. This is NEVER applied before writing results —
 * stored data (debug.json, cache tables) stays complete. The filtered view
 * simply has "holes", so renderers skip what is not there.
 */

import type { AnalysisResult } from "../db/db.js";
import type { TokenUsageSummary } from "./token-usage-collector.js";
import type { NonFatalErrorSummary } from "./non-fatal-error-collector.js";

/** Keys that pass the result-view filter (at any depth). */
export const RESULT_VIEW_KEYS: readonly string[] = ["summary", "higherOrderAggregations"];

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Headings of the LLM-generated aggregate tables embedded in HOA descriptions
// (see VISUAL_ARTIFACT_ACCUMULATION_RULE in plugins/default.ts).
const AGGREGATED_TABLE_HEADING = /^#{1,6}\s*(visuelle artefakte|visual artifacts|erwartete menschliche wahrnehmung|human perception)/i;
const ATX_HEADING = /^(#{1,6})\s/;

/**
 * Remove the aggregated "# Visuelle Artefakte" / "# … Menschliche Wahrnehmung"
 * markdown table sections from an HOA description. A stripped section runs
 * from its heading until the next heading of the same or higher level (or
 * EOF). Prose is kept; stored data is never touched — view-time only.
 */
export const stripAggregatedTables = (markdown: string): string => {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let skipLevel = 0; // 0 = not stripping
  for (const line of lines) {
    const heading = ATX_HEADING.exec(line);
    if (skipLevel > 0) {
      if (heading && heading[1].length <= skipLevel) skipLevel = 0;
      else continue;
    }
    if (heading && AGGREGATED_TABLE_HEADING.test(line)) {
      skipLevel = heading[1].length;
      continue;
    }
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
};

/**
 * Generic deep-allowlist filter for JSON-like data.
 *
 * - object: a key is kept verbatim (whole subtree, no recursion) when it is in
 *   `allowedKeys`; otherwise the value is recursed into and the key is kept
 *   only when something survives below it (ancestor path).
 * - array: keeps surviving elements.
 * - primitives: survive only under an allowed key (kept verbatim).
 *
 * Returns `undefined` when nothing survives. Empty surviving objects/arrays
 * are dropped — except directly allowed keys, which are always kept verbatim.
 */
export const filterJsonKeys = (value: unknown, allowedKeys: readonly string[]): unknown => {
  if (Array.isArray(value)) {
    const kept = value
      .map((item) => filterJsonKeys(item, allowedKeys))
      .filter((item) => item !== undefined);
    return kept.length > 0 ? kept : undefined;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (allowedKeys.includes(key)) {
        out[key] = child;
        continue;
      }
      const filtered = filterJsonKeys(child, allowedKeys);
      if (filtered !== undefined) out[key] = filtered;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return undefined;
};

/**
 * Filtered view of an AnalysisResult with RESULT_VIEW_KEYS.
 *
 * Note: semantic aggregations carry a `summary` field, so they survive as
 * `{ summary }` fragments without id/timing — renderers must treat those
 * fragments as holes (not renderable as events). The returned object is
 * typed as AnalysisResult for consumer convenience but is partial ("holey").
 *
 * HOA descriptions (top-level and under each `postProcessing.*` entry) are
 * additionally mapped through `stripAggregatedTables`, so the visual-artifact
 * and human-perception tables never render in the UI or in filtered exports.
 * The input object is not mutated.
 */
export const toResultView = (result: AnalysisResult): AnalysisResult => {
  const view = (filterJsonKeys(result, RESULT_VIEW_KEYS) ?? {}) as Record<string, unknown>;
  if (Array.isArray(view.higherOrderAggregations)) {
    view.higherOrderAggregations = stripHoaDescriptions(view.higherOrderAggregations);
  }
  if (isPlainObject(view.postProcessing)) {
    for (const [plugin, pluginResult] of Object.entries(view.postProcessing)) {
      if (isPlainObject(pluginResult) && Array.isArray(pluginResult.higherOrderAggregations)) {
        view.postProcessing[plugin] = {
          ...pluginResult,
          higherOrderAggregations: stripHoaDescriptions(pluginResult.higherOrderAggregations),
        };
      }
    }
  }
  return view as unknown as AnalysisResult;
};

const stripHoaDescriptions = (hoas: unknown[]): unknown[] =>
  hoas.map((hoa) =>
    isPlainObject(hoa) && typeof hoa.description === "string"
      ? { ...hoa, description: stripAggregatedTables(hoa.description) }
      : hoa,
  );

/** Summary fields of the JSON download view, in output order. */
// REFACTOR(dry): this list manually mirrors the field set of
// `unifiedSummarySchema` (plugins/default.ts:1273) minus perception_matrix /
// qualityAttributes — when that schema gains a field, the JSON download
// silently omits it; derive the list from the schema keys or pin it with a
// sync test.
export const JSON_DOWNLOAD_SUMMARY_FIELDS = [
  "title",
  "abstract",
  "keywords",
  "tags",
  "categorization",
  "overallIntention",
  "short_description",
  "long_summary",
  "narrativeArc",
  "perceptionArc",
] as const;

/** Processing-time summary in milliseconds per stage (incl. the summed total +
 *  the real-time factor). */
export interface ProcessingTimeSummary {
  preProcessing: number;
  /** Everything that is neither preProcessing nor postProcessing. */
  processing: number;
  postProcessing: number;
  /** preProcessing + processing + postProcessing. */
  total: number;
  /** Real-time factor: total processing time / media duration. < 1 = faster than
   *  real-time, > 1 = slower. `undefined` when the media duration can't be derived. */
  rtf?: number;
}

/**
 * Derive the media duration (seconds) from the result's segments — the max
 * `endTime` across scenes (video) or speech segments (audio-only). Returns
 * 0 when no timed segments are present (so RTF stays undefined).
 */
const mediaDurationSec = (result: AnalysisResult): number => {
  const candidates: number[] = [];
  for (const s of result.scenes ?? []) {
    if (typeof s.endTime === "number") candidates.push(s.endTime);
  }
  // Audio-only results have no scenes; fall back to speech segment end times.
  const speech = (result as AnalysisResult & { speech?: Array<{ endTime?: number }> }).speech;
  if (!candidates.length && Array.isArray(speech)) {
    for (const s of speech) if (typeof s.endTime === "number") candidates.push(s.endTime);
  }
  return candidates.length ? Math.max(...candidates) : 0;
};

/**
 * Format a millisecond duration as zero-padded `MM:SS Min.` — used for every
 * processing-time render (md/docx/UI). WHY `mm:ss`: the previous `Math.round(ms/60000) Min.`
 * zeroed out any stage under 60s (e.g. a 20s stage → "0 Min."), which hid real work.
 */
export const formatMsAsMinSec = (ms: number): string => {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")} Min.`;
};

/**
 * Render a ProcessingTimeSummary as `mm:ss Min. [pre], mm:ss Min. [main],
 * mm:ss Min. [post], mm:ss Min. [total]`. The total is the sum of the three
 * stages. Shared by the export layer (md/docx) and the dashboard CSR.
 */
export const formatProcessingTime = (pt: ProcessingTimeSummary): string => {
  // [total] reads the structured `total` field so the display always matches the
  // JSON object (pre + main + post). RTF (< 1 = faster than real-time) appended
  // when present.
  const base = `${formatMsAsMinSec(pt.preProcessing)} [pre], ${formatMsAsMinSec(pt.processing)} [main], ${formatMsAsMinSec(pt.postProcessing)} [post], ${formatMsAsMinSec(pt.total)} [total]`;
  return pt.rtf !== undefined ? `${base}, ${pt.rtf.toFixed(2)}x [rtf]` : base;
};

// Top-level timing children that count as post-processing (see
// workflow-engine.ts: plugin:* stages, result aggregation).
// DEPRECATED alternative: `summary` matches nothing — no "summary" timing
// child is emitted (summary hooks run under `plugin:<name>` grandchildren).
const POST_PROCESSING_TIMING_LABEL = /^(plugin:.+|aggregation|summary)$/;

/**
 * Sum the top-level timing children of a result into pre/main/post stage
 * durations (milliseconds). Returns null when no timing data is present.
 */
export const summarizeProcessingTime = (result: AnalysisResult): ProcessingTimeSummary | null => {
  const children = result.timing?.children;
  if (!Array.isArray(children)) return null;
  let preProcessing = 0;
  let processing = 0;
  let postProcessing = 0;
  for (const child of children) {
    const ms = typeof child.durationMs === "number" ? child.durationMs : 0;
    if (child.label === "preProcessing") preProcessing += ms;
    else if (POST_PROCESSING_TIMING_LABEL.test(child.label)) postProcessing += ms;
    // Fall-through bucket: any unrecognized top-level label counts as main
    // processing, so `processing` is the residual that keeps the three sums
    // adding up to the total even when new stage labels appear.
    else processing += ms;
  }
  const total = preProcessing + processing + postProcessing;
  // Real-time factor: total processing / media duration (both in ms). Derived
  // from the result's segment end times; undefined when no timed segments exist.
  const mediaSec = mediaDurationSec(result);
  const rtf = mediaSec > 0 ? total / (mediaSec * 1000) : undefined;
  return { preProcessing, processing, postProcessing, total, ...(rtf !== undefined ? { rtf } : {}) };
};

/** Provenance metadata attached to the filtered JSON download. */
export interface JsonDownloadMeta {
  fileName: string;
  workflow?: string;
  exportTime: string;
  models: { asr?: string; vlm?: string };
  processingTime?: ProcessingTimeSummary;
  tokenUsage?: TokenUsageSummary;
  nonFatalErrors?: NonFatalErrorSummary;
}

/**
 * Dedicated transformer for the filtered JSON download: provenance metadata
 * (models, processingTime, fileName, workflow, exportTime — when supplied via
 * `meta`), the summary fields from `postProcessing.default.summary`, plus
 * `higherOrderAggregations` (from `postProcessing.default`, falling back to
 * the top-level array for older results) reduced to `{ title, summary }`
 * where `summary` is the table-stripped description.
 */
export const toJsonDownload = (result: AnalysisResult, meta?: JsonDownloadMeta): Record<string, unknown> => {
  const defaultPlugin: Record<string, unknown> = isPlainObject(result.postProcessing) && isPlainObject(result.postProcessing.default)
    ? result.postProcessing.default
    : {};
  const summary = isPlainObject(defaultPlugin.summary) ? defaultPlugin.summary : {};

  const out: Record<string, unknown> = {};
  if (meta) {
    out.models = { asr: meta.models.asr, vlm: meta.models.vlm };
    if (meta.processingTime) out.processingTime = meta.processingTime;
    if (meta.tokenUsage) out.tokenUsage = meta.tokenUsage;
    if (meta.nonFatalErrors) out.nonFatalErrors = meta.nonFatalErrors;
    out.fileName = meta.fileName;
    if (meta.workflow) out.workflow = meta.workflow;
    out.exportTime = meta.exportTime;
  }
  for (const field of JSON_DOWNLOAD_SUMMARY_FIELDS) {
    if (summary[field] !== undefined) out[field] = summary[field];
  }

  const hoas = (Array.isArray(defaultPlugin.higherOrderAggregations)
    ? defaultPlugin.higherOrderAggregations
    : result.higherOrderAggregations) ?? [];
  out.higherOrderAggregations = (hoas as unknown[]).map((hoa) => {
    const obj = isPlainObject(hoa) ? hoa : {};
    return {
      title: typeof obj.title === "string" ? obj.title : "",
      summary: typeof obj.description === "string" ? stripAggregatedTables(obj.description) : "",
    };
  });
  return out;
};
