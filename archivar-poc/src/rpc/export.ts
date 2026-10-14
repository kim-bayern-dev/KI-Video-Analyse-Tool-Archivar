/**
 * Export module - generates downloadable exports of an analysis result.
 *
 * Formats:
 * - docx / md: replicate the "All Results" tab of the CSR UI 1:1 (same data,
 *   same ordering, same visible content; styling mapped to the document format).
 * - json: verbatim copy of <file>.archivar/debug.json (the "Raw Output" tab).
 * - log: verbatim copy of <file>.archivar/debug.log (the "Log" tab, unfiltered).
 *
 * With filtered=true (UI downloads, `GET /api/export?...&view=filtered`) the
 * docx/md formats are generated from the reduced result view and json from
 * the dedicated download transformer (summary fields + `{title, summary}`
 * HOAs, see src/lib/result-view.ts); filtered exports are cached as
 * `result.filtered.<ext>`. Stored data and the default (unfiltered) behavior
 * used by the CLI and /api/analyze are unchanged.
 *
 * Exports are written to <file>.archivar/exports/ and reused unless force=true.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { getEnv } from "defuss-env";
import { lexer, type Token, type Tokens } from "marked";
import {
    AlignmentType,
    BorderStyle,
    Document,
    HeadingLevel,
    Packer,
    PageOrientation,
    Paragraph,
    Table,
    TableCell,
    TableLayoutType,
    TableRow,
    TextRun,
    WidthType,
} from "docx";
import { CacheApi } from "./cache-api.js";
import { resolveWorkflowModels } from "../lib/archivar-config.js";
import { toResultView, toJsonDownload, summarizeProcessingTime, formatProcessingTime, type ProcessingTimeSummary } from "../lib/result-view.js";
import { toSrt, type TranscriptSegment } from "../lib/srt.js";
import type { TokenUsageSummary } from "../lib/token-usage-collector.js";
import type { NonFatalErrorSummary } from "../lib/non-fatal-error-collector.js";
import { nonFatalReasonBreakdown } from "../lib/non-fatal-error-collector.js";
import type { AnalysisResult } from "../db/db";

// `raw` = the verbatim debug.json (the full AnalysisResult). The `json` format is
// the curated Download view (toJsonDownload); `raw` is the explicit raw option.
// `srt` = SubRip subtitles built from the per-clip ASR speech timings (not the
// scene/segment boundaries), so it is a verbatim artifact and never filtered.
// `vct` = Vision Caption Transcript — same SRT structure but with the Markdown
// scene/keyframe captions as content; verbatim artifact, never filtered.
export type ExportFormat = "docx" | "md" | "json" | "raw" | "log" | "srt" | "vct" | "errors" | "vlm-requests" | "asr-requests";

export const EXPORT_FORMATS: ExportFormat[] = ["docx", "md", "json", "raw", "log", "srt", "vct", "errors", "vlm-requests", "asr-requests"];

export const EXPORT_MIME: Record<ExportFormat, string> = {
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    md: "text/markdown",
    json: "application/json",
    raw: "application/json",
    log: "text/plain",
    srt: "application/x-subrip",
    vct: "text/markdown",
    errors: "application/json",
    "vlm-requests": "application/json",
    "asr-requests": "application/json",
};

/** On-disk basenames double as cache keys: renaming one orphans existing exports. */
export const EXPORT_FILENAMES: Record<ExportFormat, string> = {
    docx: "result.docx",
    md: "result.md",
    json: "result.json",
    raw: "result.raw.json",
    log: "result.log",
    srt: "result.srt",
    vct: "result.vct.md",
    errors: "errors.json",
    "vlm-requests": "vlm-requests.json",
    "asr-requests": "asr-requests.json",
};

/**
 * Bump when the filtered-view generator changes (table stripping, JSON
 * transformer, metadata additions, …): the version is part of the filtered
 * export filename, so stale cached filtered exports self-invalidate.
 */
export const FILTERED_EXPORT_VERSION = 2;

export interface ExportedFileInfo {
    /** Path relative to the data dir, e.g. "demo.mp4.archivar/exports/result.docx" */
    path: string;
    size: number;
    mimeType: string;
}

export type ExportMap = Partial<Record<ExportFormat, ExportedFileInfo>>;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

// REFACTOR(dry): this env-resolution block is copy-pasted into ~10 modules
// (file-api.ts:62, cache-api.ts:115, status-api.ts:84, analyse-api.ts:417,
// workflow-engine.ts:1233, db/db.ts:8, pages/api/upload.ts:22) — hoist one
// shared getDataDir() into src/lib and import it everywhere.
const getDataDir = (): string => {
    const sampleDataSubDir = getEnv("SAMPLE_DATA_SUBDIR", "sample_data/archivar");
    const relativeSampleDataPath = getEnv("RELATIVE_SAMPLE_DATA_PATH", `../${sampleDataSubDir}`);
    return resolve(process.cwd(), relativeSampleDataPath);
};

export const getArchivarDir = (fileName: string): string =>
    resolve(getDataDir(), `${basename(fileName)}.archivar`);

export const getExportsDir = (fileName: string): string =>
    resolve(getArchivarDir(fileName), "exports");

/** Absolute path of an export file, guarded against path escapes. */
export const resolveExportPath = (fileName: string, format: ExportFormat, filtered = false): string => {
    const dataDir = getDataDir();
    // Filtered exports get their own versioned cache files so they never
    // collide with the unfiltered exports written by the CLI / /api/analyze
    // and stale filtered exports self-invalidate on generator changes.
    // `raw`, `log`, `srt` and `vct` are never filtered (they're verbatim artifacts
    // built from source data, not the curated summary view); only docx/md/json
    // get the filtered-view versioned cache filename.
    const name = filtered && format !== "log" && format !== "raw" && format !== "srt" && format !== "vct"
        ? EXPORT_FILENAMES[format].replace("result.", `result.filtered-v${FILTERED_EXPORT_VERSION}.`)
        : EXPORT_FILENAMES[format];
    const outPath = resolve(getExportsDir(fileName), name);
    // REFACTOR(kiss): bare startsWith is prefix-confusable — a sibling dir whose
    // name extends the data dir ("/data" vs "/data-evil/...") would pass. Compare
    // against dataDir + path.sep or use path.relative instead. (Low exposure:
    // fileName is already basename()-sanitized in getArchivarDir.)
    if (!outPath.startsWith(dataDir)) {
        throw new Error(`Invalid export path for file: ${fileName}`);
    }
    return outPath;
};

// ---------------------------------------------------------------------------
// "All Results" model (mirrors the CSR dashboard data assembly)
// ---------------------------------------------------------------------------

/**
 * Event taxonomy mirroring the CSR dashboard's detection types
 * (csr/screens/dashboard/transcription-view.tsx).
 */
// REFACTOR(kiss): "silence" and "ambience" are declared for UI parity but never
// emitted — AnalysisResultScene stores only harmonic/noise audio segments
// (src/db/db.ts:82-83) and the UI derives silence client-side (dashboard.tsx:617).
// Their EVENT_TYPE_LABEL/_EMOJI/getOriginLabel branches below are unreachable;
// drop them or keep the union in sync with the UI type on purpose.
export type ExportEventType =
    | "speech"
    | "silence"
    | "noise"
    | "ambience"
    | "harmonic"
    | "scene"
    | "sceneKeyframe"
    | "semanticAggregation";

/**
 * One renderable row of the "All Results" view. Times are milliseconds
 * (source data is seconds, converted at build time). `caption` may be "" —
 * such events are dropped by visibleEvents() at render time, mirroring the UI.
 */
export interface AllResultsEvent {
    timeMs: number;
    startMs?: number;
    endMs?: number;
    type: ExportEventType;
    caption: string;
    /** Segment index used for cache-table caption lookups (`${hash}[-suffix]-${segmentIndex}`). */
    segmentIndex?: number;
}

/**
 * Whole-video summary fields emitted by post-processing plugins
 * (result.postProcessing.*.summary). Every field is optional because each
 * plugin decides which of them it produces.
 */
export interface AllResultsSummary {
    title?: string;
    short_description?: string;
    long_summary?: string;
    keywords?: string[];
    abstract?: string;
    tags?: string[];
    categorization?: string;
    overallIntention?: string;
    narrativeArc?: string;
    perceptionArc?: string;
}

export interface AllResultsHoa {
    index: number;
    title: string;
    description: string;
}

export interface AllResultsModel {
    summary: AllResultsSummary | null;
    higherOrderAggregations: AllResultsHoa[];
    /** Chronologically sorted with the UI rule: aggregations before clips at equal seconds. */
    events: AllResultsEvent[];
    /** Processing provenance for the export preamble. */
    metadata: AllResultsMetadata;
}

export interface AllResultsMetadata {
    fileName: string;
    workflow?: string;
    /** Scene captioning model (VLM) from the workflow definition. */
    vlmModel?: string;
    /** Speech transcription model (ASR) from the workflow definition. */
    asrModel?: string;
    /** Filtered view only: stage durations summed from result.timing. */
    processingTimeMs?: ProcessingTimeSummary;
    /** Aggregated token usage (input/output/total) for the whole run. */
    tokenUsage?: TokenUsageSummary;
    /** Aggregated non-fatal errors for the whole run (retries + isolated failures). */
    nonFatalErrors?: NonFatalErrorSummary;
    /** Filtered view only: export timestamp (de-DE), shared by frontmatter/preamble. */
    exportedAt?: string;
    /** True when the model was built from the filtered result view. */
    filteredView?: boolean;
}

/** English labels mirroring i18n/en.json (events_list.type_* / dashboard.origin_*). */
const EVENT_TYPE_LABEL: Record<ExportEventType, string> = {
    speech: "Speech",
    silence: "Silence",
    noise: "Noise",
    ambience: "Ambience",
    harmonic: "Harmonic",
    scene: "Scene",
    sceneKeyframe: "Scene Keyframe",
    semanticAggregation: "Aggregation",
};

const EVENT_TYPE_EMOJI: Record<ExportEventType, string> = {
    speech: "🎤",
    silence: "🔇",
    noise: "🔊",
    ambience: "🎵",
    harmonic: "〰️",
    scene: "🎨",
    sceneKeyframe: "🖼️",
    semanticAggregation: "∑",
};

const getOriginLabel = (type: ExportEventType): string => {
    if (["speech", "silence", "noise", "ambience", "harmonic"].includes(type)) return "Audio";
    if (type === "sceneKeyframe") return "Image";
    if (type === "semanticAggregation") return "Semantic Analysis";
    return "Video";
};

const formatTime = (timeMs: number): string => {
    const totalSeconds = Math.floor(timeMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
};

/** UI ordering rule (transcription-view.tsx): by rounded seconds, aggregations first on ties. */
export const sortAllResultsEvents = (events: AllResultsEvent[]): AllResultsEvent[] =>
    [...events].sort((a, b) => {
        const timeA = Math.floor(a.timeMs / 1000);
        const timeB = Math.floor(b.timeMs / 1000);
        if (timeA !== timeB) return timeA - timeB;
        if (a.type === "semanticAggregation" && b.type !== "semanticAggregation") return -1;
        if (a.type !== "semanticAggregation" && b.type === "semanticAggregation") return 1;
        return 0;
    });

/** The UI hides events without captions; exports show exactly the visible ones. */
export const visibleEvents = (events: AllResultsEvent[]): AllResultsEvent[] =>
    events.filter((event) => event.caption.trim() !== "");

/**
 * Select the aggregated cache entry for an outputHash, mirroring the dashboard:
 * prefer entries from post-processing workflows (question-answer)
 * because those carry the plugin-produced summaries/HOAs the export exists for;
 * any other matching entry (e.g. a plain engine run) is the fallback.
 */
const selectAggregatedEntry = (allAggregated: Record<string, AnalysisResult>, outputHash: string): { key: string; result: AnalysisResult } | null => {
    const matchingKeys = Object.keys(allAggregated).filter((key) => key.includes(outputHash));
    const key = matchingKeys.find((k) => k.includes("question-answer")) ?? matchingKeys[0];
    return key ? { key, result: allAggregated[key] } : null;
};

/** Summary selection mirroring dashboard.tsx: default plugin first, later plugins override. */
const selectSummary = (result: AnalysisResult): AllResultsSummary | null => {
    const postProcessing = (result.postProcessing ?? {}) as Record<string, { summary?: AllResultsSummary }>;
    let summary = postProcessing.default?.summary ?? null;
    // "Later wins" relies on object insertion order = plugin execution order;
    // the last plugin that produced a summary determines the exported one.
    for (const key of Object.keys(postProcessing)) {
        if (key !== "default" && postProcessing[key]?.summary) {
            summary = postProcessing[key].summary!;
        }
    }
    return summary;
};

/**
 * Assemble processing provenance for the export preamble. Workflow name comes
 * from status.json (fallback: parsed from the aggregated cache key, validated
 * against the config); VLM/ASR models come from the workflow definition.
 */
const loadMetadata = (
    fileName: string,
    archivarDir: string,
    aggregatedCacheKey: string | null,
    outputHash: string | null,
): AllResultsMetadata => {
    const metadata: AllResultsMetadata = { fileName };

    // Workflow name + models: status.json first (models are recorded at
    // workflow start so they survive workflow renames in the config)
    let workflow: string | undefined;
    let statusModels: { asr?: string; vlm?: string } | undefined;
    try {
        const statusPath = resolve(archivarDir, "status.json");
        if (existsSync(statusPath)) {
            const status = JSON.parse(readFileSync(statusPath, "utf-8")) as { workflow?: string; models?: { asr?: string; vlm?: string } };
            workflow = status.workflow;
            statusModels = status.models;
        }
    } catch { /* fall through to cache-key parsing */ }

    // Fallback: parse from the aggregated cache key ("<workflow>-<outputHash>[-versions]")
    if (!workflow && aggregatedCacheKey && outputHash) {
        const candidate = aggregatedCacheKey.split(`-${outputHash}`)[0];
        if (candidate) workflow = candidate;
    }

    if (workflow) {
        metadata.workflow = workflow;
        metadata.vlmModel = statusModels?.vlm;
        metadata.asrModel = statusModels?.asr;
        if (!metadata.vlmModel || !metadata.asrModel) {
            // Fallback: resolve from the current config's workflow definition
            const resolved = resolveWorkflowModels(workflow);
            metadata.vlmModel ??= resolved.vlm;
            metadata.asrModel ??= resolved.asr;
        }
    }

    return metadata;
};

/**
 * Build the canonical "All Results" model server-side from the same data the
 * UI uses: the `aggregated` cache entry (falling back to debug.json), with
 * caption fallbacks from the scene/keyframe/speech/audio cache tables.
 *
 * Note: silence regions are not part of AnalysisResult and never have captions
 * (the UI hides caption-less events), so they are not part of the model.
 *
 * With filtered=true the selected result is first reduced to the result view
 * (summary + higherOrderAggregations only, see src/lib/result-view.ts); the
 * model then contains no scene/speech/aggregation events.
 */
export const loadAllResultsModel = async (fileName: string, filtered = false): Promise<AllResultsModel> => {
    const archivarDir = getArchivarDir(fileName);
    const debugPath = resolve(archivarDir, "debug.json");
    if (!existsSync(debugPath)) {
        throw new Error(`No analysis result found for "${fileName}" (missing ${debugPath})`);
    }
    const debugResult = JSON.parse(readFileSync(debugPath, "utf-8")) as AnalysisResult;

    const cacheApi = new CacheApi();
    let result: AnalysisResult | null = null;
    let aggregatedCacheKey: string | null = null;
    // Prefer the aggregated cache entry over debug.json: post-processing plugins
    // merge their summaries/HOAs/aggregations into it, while debug.json stays
    // the raw engine snapshot.
    if (debugResult.outputHash) {
        const allAggregated = await cacheApi.getAll<AnalysisResult>("aggregated");
        const entry = selectAggregatedEntry(allAggregated, debugResult.outputHash);
        result = entry?.result ?? null;
        aggregatedCacheKey = entry?.key ?? null;
    }
    result = result ?? debugResult;
    if (filtered) result = toResultView(result);

    const metadata = loadMetadata(fileName, archivarDir, aggregatedCacheKey, result.outputHash ?? debugResult.outputHash);
    if (filtered) {
        metadata.filteredView = true;
        metadata.exportedAt = new Date().toLocaleString("de-DE");
        // timing does not survive the filtered view — read it from debug.json
        metadata.processingTimeMs = summarizeProcessingTime(debugResult) ?? undefined;
        metadata.tokenUsage = debugResult.tokenUsage ?? undefined;
        metadata.nonFatalErrors = debugResult.nonFatalErrors ?? undefined;
    }

    const events: AllResultsEvent[] = [];
    // Keyframe cache IDs (`${hash}-keyframe-${n}`) are numbered across the whole
    // file, not per scene — hence the counter lives outside the scene loop.
    let flatKeyframeIndex = 0;

    for (const scene of result.scenes ?? []) {
        events.push({
            timeMs: (scene.startTime || 0) * 1000,
            startMs: (scene.startTime || 0) * 1000,
            endMs: (scene.endTime || 0) * 1000,
            type: "scene",
            caption: scene.caption ?? "",
            segmentIndex: scene.index ?? 0,
        });
        for (const speech of scene.speech ?? []) {
            events.push({
                timeMs: (speech.startTime || 0) * 1000,
                startMs: (speech.startTime || 0) * 1000,
                endMs: (speech.endTime || 0) * 1000,
                type: "speech",
                caption: speech.caption ?? "",
                segmentIndex: speech.index ?? 0,
            });
        }
        // harmonic/noise are the only audio segment arrays AnalysisResultScene
        // carries (src/db/db.ts:82-83); silence/ambience never reach the model.
        for (const type of ["harmonic", "noise"] as const) {
            for (const segment of scene[type] ?? []) {
                events.push({
                    timeMs: (segment.startTime || 0) * 1000,
                    startMs: (segment.startTime || 0) * 1000,
                    endMs: (segment.endTime || 0) * 1000,
                    type,
                    caption: segment.caption ?? "",
                    segmentIndex: segment.index ?? 0,
                });
            }
        }
        for (const keyframe of scene.keyframes ?? []) {
            events.push({
                timeMs: (keyframe.startTime || 0) * 1000,
                startMs: (keyframe.startTime || 0) * 1000,
                endMs: (keyframe.endTime || 0) * 1000,
                type: "sceneKeyframe",
                caption: keyframe.caption ?? "",
                segmentIndex: flatKeyframeIndex,
            });
            flatKeyframeIndex += 1;
        }
    }

    for (const [i, agg] of (result.semanticAggregations ?? []).entries()) {
        // Filtered view: aggregations survive as { summary } fragments without
        // timing — they are holes, not renderable events; skip them.
        if (typeof agg.fromSeconds !== "number" || typeof agg.toSeconds !== "number") continue;
        // agg.summary is JsonValue | string (plugin-types.ts:175): a plain string
        // from simple plugins, a structured { summary } object from richer ones.
        const caption = typeof agg.summary === "string"
            ? agg.summary
            : ((agg.summary as { summary?: string } | undefined)?.summary || `Aggregation ${i + 1}`);
        events.push({
            timeMs: (agg.fromSeconds || 0) * 1000,
            startMs: (agg.fromSeconds || 0) * 1000,
            endMs: (agg.toSeconds || 0) * 1000,
            type: "semanticAggregation",
            caption,
        });
    }

    // Caption fallback from cache tables (mirrors loadCaptionsFromCache in the UI).
    // The some() guard avoids four full cache-table scans when nothing is missing.
    const hash = result.outputHash ?? debugResult.outputHash;
    if (hash && events.some((event) => event.caption.trim() === "")) {
        const [allScenes, allKeyframes, allSpeech, allAudio] = await Promise.all([
            cacheApi.getAll<{ caption?: string }>("scene"),
            cacheApi.getAll<{ caption?: string }>("keyframe"),
            cacheApi.getAll<{ caption?: string }>("speech"),
            cacheApi.getAll<{ caption?: string }>("audio"),
        ]);
        const cacheIdFor = (event: AllResultsEvent): string | null => {
            const index = event.segmentIndex ?? 0;
            switch (event.type) {
                case "scene": return `${hash}-${index}`;
                case "sceneKeyframe": return `${hash}-keyframe-${index}`;
                case "speech": return `${hash}-speech-${index}`;
                case "harmonic": return `${hash}-harmonic-${index}`;
                case "noise": return `${hash}-noise-${index}`;
                default: return null;
            }
        };
        for (const event of events) {
            if (event.caption.trim() !== "") continue;
            const id = cacheIdFor(event);
            if (!id) continue;
            // harmonic/noise share the single "audio" cache table (there are no
            // per-type tables, src/db/db.ts:389) — the -harmonic-/-noise- key
            // suffixes from cacheIdFor do the discriminating.
            const table = event.type === "scene" ? allScenes
                : event.type === "sceneKeyframe" ? allKeyframes
                : event.type === "speech" ? allSpeech
                : allAudio;
            const caption = table[id]?.caption ?? "";
            if (caption) event.caption = caption;
        }
    }

    return {
        summary: selectSummary(result),
        higherOrderAggregations: (result.higherOrderAggregations ?? []).map((hoa) => ({
            index: hoa.index,
            title: hoa.title,
            description: hoa.description,
        })),
        events: sortAllResultsEvents(events),
        metadata,
    };
};

// ---------------------------------------------------------------------------
// Markdown export
// ---------------------------------------------------------------------------

/**
 * Single header-line format shared by the md (### heading) and docx (bold
 * paragraph) builders so both formats render identical event headers.
 */
const eventHeaderLine = (event: AllResultsEvent, displayIndex: number): string => {
    const duration = event.startMs !== undefined && event.endMs !== undefined
        ? ` (${formatTime(event.endMs - event.startMs)})`
        : "";
    return `${displayIndex}. [${formatTime(event.timeMs)}] ${getOriginLabel(event.type)} — ${EVENT_TYPE_EMOJI[event.type]} ${EVENT_TYPE_LABEL[event.type]}${duration}`;
};

/**
 * Render the model as markdown. Section order (title → keywords → description →
 * abstract → chronological summary → HOAs → events) replicates the CSR
 * "All Results" tab top-to-bottom and must stay 1:1 with buildAllResultsDocx.
 */
// REFACTOR(dry): the filtered-view frontmatter rows duplicate
// buildMetadataPreamble's metaRows (same fields, divergent labels/order, e.g.
// "VLM Model" here vs "VLM model (scene captioning)" there) — share one
// provenance-row builder so the md and docx preambles can't drift apart.
export const buildAllResultsMarkdown = (model: AllResultsModel): string => {
    const parts: string[] = [];

    // Filtered view: provenance frontmatter on top (mirrors the docx preamble).
    if (model.metadata.filteredView) {
        const meta = model.metadata;
        const rows: Array<[string, string | undefined]> = [
            ["File", meta.fileName],
            ["Workflow", meta.workflow],
            ["Exported", meta.exportedAt],
            ["ASR Model", meta.asrModel],
            ["VLM Model", meta.vlmModel],
            ["Processing time", meta.processingTimeMs ? formatProcessingTime(meta.processingTimeMs) : undefined],
            ["Token usage", meta.tokenUsage ? formatTokenUsage(meta.tokenUsage) : undefined],
            ["Non-fatal errors", meta.nonFatalErrors?.count ? formatNonFatalErrors(meta.nonFatalErrors) : undefined],
            ["Tags", model.summary?.tags?.length ? model.summary.tags.join(", ") : undefined],
            ["Categorization", model.summary?.categorization],
            ["Overall Intention", model.summary?.overallIntention],
        ];
        const lines = rows
            .filter((row): row is [string, string] => !!row[1])
            .map(([label, value]) => `${label}: ${value}`);
        parts.push(`---\n${lines.join("\n")}\n---`);
    }

    if (model.summary) {
        const { title, short_description, long_summary, keywords, abstract, tags, categorization, overallIntention, narrativeArc, perceptionArc } = model.summary;
        if (title) parts.push(`# ${title}`);
        if (keywords && keywords.length > 0) {
            parts.push(keywords.map((kw) => `\`${kw}\``).join(" "));
        }
        if (short_description) parts.push(`## ${short_description}`);
        if (abstract) parts.push(abstract);
        if (long_summary) parts.push(`## Chronological Summary`, long_summary);
        // Filtered view: Tags/Categorization/Overall Intention live in the frontmatter
        if (!model.metadata.filteredView) {
            if (tags && tags.length > 0) parts.push(`**Tags:** ${tags.join(", ")}`);
            if (categorization) parts.push(`**Categorization:** ${categorization}`);
            if (overallIntention) parts.push(`**Overall Intention:** ${overallIntention}`);
        }
        if (narrativeArc) parts.push(`**Narrative Arc:** ${narrativeArc}`);
        if (perceptionArc) parts.push(`**Perception Arc:** ${perceptionArc}`);
    }

    if (model.higherOrderAggregations.length > 0) {
        parts.push("## Higher-Order Aggregations");
        for (const hoa of model.higherOrderAggregations) {
            parts.push(`### ${hoa.index + 1}. ${hoa.title}`);
            parts.push(hoa.description);
        }
    }

    const events = visibleEvents(model.events);
    if (events.length > 0) {
        parts.push("## Events");
        // Display index mirrors the UI: position in the full sorted list (including hidden events).
        // REFACTOR(dry): this indexOf lookup is duplicated in buildAllResultsDocx
        // and costs O(n) per event (O(n²) per export) — compute display indices
        // once next to visibleEvents() and share them between both builders.
        events.forEach((event) => {
            const displayIndex = model.events.indexOf(event) + 1;
            parts.push(`### ${eventHeaderLine(event, displayIndex)}`);
            parts.push(event.caption);
        });
    }

    return `${parts.filter((part) => part.trim() !== "").join("\n\n")}\n`;
};

// ---------------------------------------------------------------------------
// DOCX export
// ---------------------------------------------------------------------------

const FONT_FAMILY = "Arial";
const BODY_SIZE = 22; // 11pt
/** Page setup (A4 portrait, 20 mm margins) in DXA/twips. */
const PAGE_WIDTH_DXA = 11906;
const PAGE_HEIGHT_DXA = 16838;
const PAGE_MARGIN_DXA = 1134;
/** Content width in DXA/twips, derived from the page setup. */
const CONTENT_WIDTH_DXA = PAGE_WIDTH_DXA - 2 * PAGE_MARGIN_DXA;

// REFACTOR(magic): the remaining docx style literals are scattered unnamed
// through the builders — spacing twips 240/120/160/300/80 in markdownToDocx,
// heading half-points 32/26/23 in docxHeading, gray "595959" in
// buildMetadataPreamble, border colors "D1D5DB"/"E5E7EB" in the table mapping —
// collect them into a DOCX_STYLE block next to these page constants so the
// document style is edited in one place.

/** Split a total DXA width evenly; the last column absorbs rounding so widths sum exactly. */
const splitWidthEvenly = (totalDxa: number, columnCount: number): number[] => {
    const base = Math.floor(totalDxa / columnCount);
    return Array.from({ length: columnCount }, (_, index) =>
        index === columnCount - 1 ? totalDxa - base * (columnCount - 1) : base
    );
};

type InlineToken = Tokens.Text | Tokens.Strong | Tokens.Em | Tokens.Codespan | Tokens.Link | Tokens.Br | Tokens.Del | Tokens.Escape | Tokens.Image | Tokens.Generic;

/** Convert marked inline tokens to docx TextRuns. */
const inlineRuns = (tokens: Token[] | undefined, opts: { bold?: boolean; italics?: boolean } = {}): TextRun[] => {
    const runs: TextRun[] = [];
    for (const token of tokens ?? []) {
        switch (token.type) {
            case "strong":
                runs.push(...inlineRuns((token as Tokens.Strong).tokens, { ...opts, bold: true }));
                break;
            case "em":
                runs.push(...inlineRuns((token as Tokens.Em).tokens, { ...opts, italics: true }));
                break;
            case "del":
                runs.push(...inlineRuns((token as Tokens.Del).tokens, opts));
                break;
            case "codespan":
                runs.push(new TextRun({ text: (token as Tokens.Codespan).text, font: "Consolas", size: BODY_SIZE }));
                break;
            case "link":
                runs.push(...inlineRuns((token as Tokens.Link).tokens, opts));
                break;
            case "br":
                runs.push(new TextRun({ break: 1 }));
                break;
            case "image":
                runs.push(new TextRun({ text: (token as Tokens.Image).text, ...opts, font: FONT_FAMILY, size: BODY_SIZE }));
                break;
            case "escape":
            case "text":
            case "html":
            default: {
                // Unlisted inline token types degrade to plain text rather than
                // being dropped — captions stay readable even on lexer surprises.
                const textToken = token as Tokens.Text;
                // A "text" token may itself carry inline tokens (e.g. inside paragraphs).
                if (textToken.tokens && textToken.tokens.length > 0) {
                    runs.push(...inlineRuns(textToken.tokens, opts));
                } else if ("text" in textToken && textToken.text) {
                    runs.push(new TextRun({ text: textToken.text, ...opts, font: FONT_FAMILY, size: BODY_SIZE }));
                }
                break;
            }
        }
    }
    return runs;
};

const HEADING_LEVELS = [
    HeadingLevel.HEADING_1,
    HeadingLevel.HEADING_2,
    HeadingLevel.HEADING_3,
    HeadingLevel.HEADING_4,
    HeadingLevel.HEADING_5,
    HeadingLevel.HEADING_6,
] as const;

/** Convert a markdown string to docx block elements (paragraphs and tables). */
const markdownToDocx = (markdown: string): (Paragraph | Table)[] => {
    const elements: (Paragraph | Table)[] = [];

    for (const token of lexer(markdown)) {
        switch (token.type) {
            case "heading": {
                const heading = token as Tokens.Heading;
                elements.push(new Paragraph({
                    heading: HEADING_LEVELS[Math.min(heading.depth, 6) - 1],
                    children: inlineRuns(heading.tokens, { bold: true }),
                    spacing: { before: 240, after: 120 },
                }));
                break;
            }
            case "paragraph": {
                elements.push(new Paragraph({
                    children: inlineRuns((token as Tokens.Paragraph).tokens),
                    spacing: { after: 160, line: 300 },
                }));
                break;
            }
            case "list": {
                const list = token as Tokens.List;
                // Ordered markers and nesting depth are flattened to plain level-0
                // bullets — the exported markdown is model-generated (summaries,
                // captions) and effectively flat, so the lossy mapping is deliberate.
                for (const item of list.items) {
                    elements.push(new Paragraph({
                        bullet: { level: 0 },
                        children: inlineRuns(item.tokens),
                        spacing: { after: 80, line: 300 },
                    }));
                }
                break;
            }
            case "table": {
                const table = token as Tokens.Table;
                const columnCount = Math.max(table.header.length, 1);

                // These are DXA/twip values, not percentages.
                const columnWidths = splitWidthEvenly(CONTENT_WIDTH_DXA, columnCount);

                const rows = [table.header, ...table.rows].map((cells, rowIndex) =>
                    new TableRow({
                        children: cells.map((cell, columnIndex) =>
                            new TableCell({
                                width: {
                                    size: columnWidths[columnIndex] ?? columnWidths[columnWidths.length - 1],
                                    type: WidthType.DXA,
                                },
                                margins: { top: 80, bottom: 80, left: 120, right: 120 },
                                children: [new Paragraph({ children: inlineRuns(cell.tokens, rowIndex === 0 ? { bold: true } : {}) })],
                            })
                        ),
                    })
                );
                elements.push(new Table({
                    // DXA is most interoperable. Percentage 100 also works
                    // in Word, provided grid/cell widths remain DXA.
                    width: { size: CONTENT_WIDTH_DXA, type: WidthType.DXA },
                    layout: TableLayoutType.FIXED,
                    columnWidths,
                    rows,
                    borders: {
                        top: { style: BorderStyle.SINGLE, size: 1, color: "D1D5DB" },
                        bottom: { style: BorderStyle.SINGLE, size: 1, color: "D1D5DB" },
                        left: { style: BorderStyle.SINGLE, size: 1, color: "D1D5DB" },
                        right: { style: BorderStyle.SINGLE, size: 1, color: "D1D5DB" },
                        insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: "E5E7EB" },
                        insideVertical: { style: BorderStyle.SINGLE, size: 1, color: "E5E7EB" },
                    },
                }));
                break;
            }
            case "blockquote": {
                elements.push(new Paragraph({
                    children: inlineRuns((token as Tokens.Blockquote).tokens, { italics: true }),
                    spacing: { after: 160, line: 300 },
                    indent: { left: 360 },
                }));
                break;
            }
            case "code": {
                elements.push(new Paragraph({
                    children: [new TextRun({ text: (token as Tokens.Code).text, font: "Consolas", size: BODY_SIZE })],
                    spacing: { after: 160 },
                }));
                break;
            }
            case "space":
            case "hr":
            default:
                // hr/space and any unmapped block token render as nothing —
                // deliberate minimal mapping, not an oversight.
                break;
        }
    }

    return elements;
};

const docxHeading = (text: string, level: (typeof HEADING_LEVELS)[number]) =>
    new Paragraph({
        heading: level,
        children: [new TextRun({ text, bold: true, font: FONT_FAMILY, size: level === HeadingLevel.HEADING_1 ? 32 : level === HeadingLevel.HEADING_2 ? 26 : 23 })],
        spacing: { before: 280, after: 140 },
    });

/** Bold "Label: value" body line (Keywords, Tags, Categorization, …). */
const labeledParagraph = (label: string, value: string) =>
    new Paragraph({
        children: [
            new TextRun({ text: `${label}: `, bold: true, font: FONT_FAMILY, size: BODY_SIZE }),
            new TextRun({ text: value, font: FONT_FAMILY, size: BODY_SIZE }),
        ],
        spacing: { after: 160 },
    });

/** "1234 [input], 5678 [output], 6912 [total]" */
const formatTokenUsage = (tu: TokenUsageSummary): string =>
    `${tu.input} [input], ${tu.output} [output], ${tu.total} [total]`;

/** "3 (schema: 2, timeout: 1)" — count + reason breakdown; just the count if no trace. */
const formatNonFatalErrors = (nfe: NonFatalErrorSummary): string => {
    const parts = nonFatalReasonBreakdown(nfe).map(({ reason, count }) => `${reason}: ${count}`);
    return parts.length ? `${nfe.count} (${parts.join(", ")})` : String(nfe.count);
};

/** Preamble: processing provenance (which models produced this analysis). */
const buildMetadataPreamble = (meta: AllResultsMetadata): Paragraph[] => {
    const metaRows: Array<[string, string | undefined]> = [
        ["File", meta.fileName],
        ["Workflow", meta.workflow],
        ["VLM model (scene captioning)", meta.vlmModel],
        ["ASR model (speech transcription)", meta.asrModel],
        ["Processing time", meta.processingTimeMs ? formatProcessingTime(meta.processingTimeMs) : undefined],
        ["Token usage", meta.tokenUsage ? formatTokenUsage(meta.tokenUsage) : undefined],
        ["Non-fatal errors", meta.nonFatalErrors?.count ? formatNonFatalErrors(meta.nonFatalErrors) : undefined],
        ["Exported", meta.exportedAt ?? new Date().toLocaleString("de-DE")],
    ];
    const present = metaRows.filter((row): row is [string, string] => !!row[1]);
    if (present.length === 0) return [];
    return [
        ...present.map(([label, value]) =>
            new Paragraph({
                children: [
                    new TextRun({ text: `${label}: `, bold: true, font: FONT_FAMILY, size: 18, color: "595959" }),
                    new TextRun({ text: value, font: FONT_FAMILY, size: 18, color: "595959" }),
                ],
                spacing: { after: 40 },
            })
        ),
        new Paragraph({ children: [new TextRun({ text: "" })], spacing: { after: 120 } }),
    ];
};

/**
 * Render the model as a .docx buffer. Section order and content must stay 1:1
 * with buildAllResultsMarkdown (the file-header "replicate the UI" invariant).
 * Async only because Packer.toBuffer is.
 */
export const buildAllResultsDocx = async (model: AllResultsModel, title?: string): Promise<Buffer> => {
    const children: (Paragraph | Table)[] = [];

    if (model.summary) {
        const { title: summaryTitle, short_description, long_summary, keywords, abstract, tags, categorization, overallIntention, narrativeArc, perceptionArc } = model.summary;
        if (summaryTitle) children.push(docxHeading(summaryTitle, HeadingLevel.HEADING_1));
        children.push(...buildMetadataPreamble(model.metadata));
        if (keywords && keywords.length > 0) {
            children.push(labeledParagraph("Keywords", keywords.join(", ")));
        }
        if (short_description) children.push(docxHeading(short_description, HeadingLevel.HEADING_2));
        if (abstract) children.push(...markdownToDocx(abstract));
        if (long_summary) children.push(docxHeading("Chronological Summary", HeadingLevel.HEADING_2), ...markdownToDocx(long_summary));
        if (tags && tags.length > 0) children.push(labeledParagraph("Tags", tags.join(", ")));
        if (categorization) children.push(labeledParagraph("Categorization", categorization));
        if (overallIntention) children.push(labeledParagraph("Overall Intention", overallIntention));
        if (narrativeArc) children.push(labeledParagraph("Narrative Arc", narrativeArc));
        if (perceptionArc) children.push(labeledParagraph("Perception Arc", perceptionArc));
    } else if (title) {
        children.push(docxHeading(title, HeadingLevel.HEADING_1));
        children.push(...buildMetadataPreamble(model.metadata));
    }

    if (model.higherOrderAggregations.length > 0) {
        children.push(docxHeading("Higher-Order Aggregations", HeadingLevel.HEADING_2));
        for (const hoa of model.higherOrderAggregations) {
            children.push(docxHeading(`${hoa.index + 1}. ${hoa.title}`, HeadingLevel.HEADING_3));
            children.push(...markdownToDocx(hoa.description));
        }
    }

    const events = visibleEvents(model.events);
    if (events.length > 0) {
        children.push(docxHeading("Events", HeadingLevel.HEADING_2));
        events.forEach((event) => {
            const displayIndex = model.events.indexOf(event) + 1;
            children.push(new Paragraph({
                children: [new TextRun({ text: eventHeaderLine(event, displayIndex), bold: true, font: FONT_FAMILY, size: BODY_SIZE })],
                spacing: { before: 200, after: 100 },
                alignment: AlignmentType.LEFT,
            }));
            children.push(...markdownToDocx(event.caption));
        });
    }

    const doc = new Document({
        creator: "archivar",
        title: title ?? "Analysis export",
        sections: [
            {
                properties: {
                    page: {
                        size: {
                            width: PAGE_WIDTH_DXA,
                            height: PAGE_HEIGHT_DXA,
                            orientation: PageOrientation.PORTRAIT,
                        },
                        margin: {
                            top: PAGE_MARGIN_DXA,
                            right: PAGE_MARGIN_DXA,
                            bottom: PAGE_MARGIN_DXA,
                            left: PAGE_MARGIN_DXA,
                        },
                    },
                },
                children,
            },
        ],
    });

    return Packer.toBuffer(doc);
};

// ---------------------------------------------------------------------------
// Export file generation / listing
// ---------------------------------------------------------------------------

/** List exports that already exist on disk for a file. */
export const listExports = (fileName: string): ExportMap => {
    const dataDir = getDataDir();
    const exports: ExportMap = {};
    for (const format of EXPORT_FORMATS) {
        const outPath = resolveExportPath(fileName, format);
        if (existsSync(outPath)) {
            exports[format] = {
                path: outPath.slice(dataDir.length + 1),
                size: statSync(outPath).size,
                mimeType: EXPORT_MIME[format],
            };
        }
    }
    return exports;
};

/**
 * Map model speech events to transcript segments, preserving the EXACT per-clip
 * ASR timings (event.startMs/endMs, sourced from AnalysisResultSpeech) — NOT the
 * coarser scene/segment boundaries. Pure (no I/O) so it can be unit-tested
 * against hand-built events; loadTranscriptSegments is the thin wrapper that
 * loads the model then calls this.
 */
export const speechEventsToSegments = (events: readonly AllResultsEvent[]): TranscriptSegment[] =>
    events
        .filter((event) => event.type === "speech")
        .map((event) => ({
            from: event.startMs ?? event.timeMs,
            to: event.endMs ?? event.startMs ?? event.timeMs,
            text: event.caption,
        }));

/**
 * Load the ASR speech clips of an analysis as transcript segments for SRT
 * serialization. Thin I/O wrapper: loads the unfiltered model (the filtered
 * view strips speech events) and delegates to the pure speechEventsToSegments.
 * Inherits the caption cache-fallback the dashboard uses, so subtitle text
 * matches the on-screen transcript. Covered end-to-end by e2e-export.test.ts.
 */
export const loadTranscriptSegments = async (fileName: string): Promise<TranscriptSegment[]> => {
    const model = await loadAllResultsModel(fileName, false);
    return speechEventsToSegments(model.events);
};

/**
 * Map model vision events (scene + sceneKeyframe) to transcript segments for
 * VCT (Vision Caption Transcript) serialization. Pure (no I/O) so it can be
 * unit-tested; loadVisionCaptionSegments is the thin wrapper.
 *
 * The caption carries the rich Markdown produced by the VLM (image descriptions,
 * scene analysis with tables) — reusing the same events + caption cache-fallback
 * the dashboard renders. NO aggregations are included (this is verbatim vision
 * captions only).
 */
export const visionCaptionEventsToSegments = (events: readonly AllResultsEvent[]): TranscriptSegment[] =>
    events
        .filter((event) => event.type === "scene" || event.type === "sceneKeyframe")
        .map((event) => ({
            from: event.startMs ?? event.timeMs,
            to: event.endMs ?? event.startMs ?? event.timeMs,
            text: event.caption,
        }));

/**
 * Load the vision captions (scene + keyframe) of an analysis as transcript
 * segments for VCT serialization. Thin I/O wrapper: loads the unfiltered model
 * and delegates to the pure visionCaptionEventsToSegments. Covered end-to-end
 * by e2e-export.test.ts.
 */
export const loadVisionCaptionSegments = async (fileName: string): Promise<TranscriptSegment[]> => {
    const model = await loadAllResultsModel(fileName, false);
    return visionCaptionEventsToSegments(model.events);
};

/**
 * Generate (or reuse) the export file for one format.
 * Returns path (relative to the data dir), size and mime type.
 *
 * filtered=true renders docx/md/json from the reduced result view (summary +
 * higherOrderAggregations only); the log format is unaffected.
 */
export const exportFile = async (fileName: string, format: ExportFormat, force = false, filtered = false): Promise<ExportedFileInfo> => {
    const archivarDir = getArchivarDir(fileName);
    if (!existsSync(archivarDir)) {
        throw new Error(`No analysis found for "${fileName}" (missing ${archivarDir})`);
    }

    const outPath = resolveExportPath(fileName, format, filtered);
    const dataDir = getDataDir();

    if (force || !existsSync(outPath)) {
        mkdirSync(getExportsDir(fileName), { recursive: true });
        switch (format) {
            case "json": {
                // `json` is the curated Download view (toJsonDownload + provenance),
                // matching the dashboard "Download → JSON". The verbatim debug.json
                // is the `raw` format below.
                const debugJsonPath = resolve(archivarDir, "debug.json");
                if (!existsSync(debugJsonPath)) throw new Error(`Missing debug.json for "${fileName}"`);
                const parsed = JSON.parse(readFileSync(debugJsonPath, "utf-8")) as AnalysisResult;
                const metadata = loadMetadata(fileName, archivarDir, null, parsed.outputHash);
                writeFileSync(outPath, `${JSON.stringify(toJsonDownload(parsed, {
                    fileName,
                    workflow: metadata.workflow,
                    exportTime: new Date().toLocaleString("de-DE"),
                    models: { asr: metadata.asrModel, vlm: metadata.vlmModel },
                    processingTime: summarizeProcessingTime(parsed) ?? undefined,
                    tokenUsage: parsed.tokenUsage ?? undefined,
                    nonFatalErrors: parsed.nonFatalErrors ?? undefined,
                }), null, 2)}\n`, "utf-8");
                break;
            }
            case "raw": {
                // Verbatim AnalysisResult (debug.json) — the full machine-readable result.
                const debugJsonPath = resolve(archivarDir, "debug.json");
                if (!existsSync(debugJsonPath)) throw new Error(`Missing debug.json for "${fileName}"`);
                copyFileSync(debugJsonPath, outPath);
                break;
            }
            case "log": {
                const debugLogPath = resolve(archivarDir, "debug.log");
                if (!existsSync(debugLogPath)) throw new Error(`Missing debug.log for "${fileName}"`);
                copyFileSync(debugLogPath, outPath);
                break;
            }
            case "errors": {
                // Verbatim per-run error artifact (ids ERR-N + wire context).
                const errorsPath = resolve(archivarDir, "errors.json");
                if (!existsSync(errorsPath)) throw new Error(`Missing errors.json for "${fileName}"`);
                copyFileSync(errorsPath, outPath);
                break;
            }
            case "vlm-requests": {
                // Verbatim per-run per-request usage artifact (actual backend usage).
                const vlmRequestsPath = resolve(archivarDir, "vlm-requests.json");
                if (!existsSync(vlmRequestsPath)) throw new Error(`Missing vlm-requests.json for "${fileName}"`);
                copyFileSync(vlmRequestsPath, outPath);
                break;
            }
            case "asr-requests": {
                // Verbatim per-run ASR request artifact (ids ASR-N, length + elapsed).
                const asrRequestsPath = resolve(archivarDir, "asr-requests.json");
                if (!existsSync(asrRequestsPath)) throw new Error(`Missing asr-requests.json for "${fileName}"`);
                copyFileSync(asrRequestsPath, outPath);
                break;
            }
            // REFACTOR(dry): the md and docx cases each call loadAllResultsModel,
            // so a combined md+docx export builds the same model twice (two full
            // cache-table scans included) — build once per export run and pass
            // the model to both builders.
            case "md": {
                const model = await loadAllResultsModel(fileName, filtered);
                writeFileSync(outPath, buildAllResultsMarkdown(model), "utf-8");
                break;
            }
            case "docx": {
                const model = await loadAllResultsModel(fileName, filtered);
                writeFileSync(outPath, await buildAllResultsDocx(model, fileName));
                break;
            }
            case "srt": {
                // Build SubRip subtitles from the EXACT per-clip ASR timings
                // (scene.speech startTime/endTime), reusing the same speech
                // events + caption cache-fallback the dashboard renders.
                writeFileSync(outPath, toSrt(await loadTranscriptSegments(fileName)), "utf-8");
                break;
            }
            case "vct": {
                // Vision Caption Transcript: same SRT structure (index +
                // timeframe + text) but with the Markdown scene/keyframe
                // captions as content. NO aggregations — verbatim vision
                // captions only, reusing the same caption cache-fallback.
                writeFileSync(outPath, toSrt(await loadVisionCaptionSegments(fileName)), "utf-8");
                break;
            }
        }
    }

    return {
        path: outPath.slice(dataDir.length + 1),
        size: statSync(outPath).size,
        mimeType: EXPORT_MIME[format],
    };
};
