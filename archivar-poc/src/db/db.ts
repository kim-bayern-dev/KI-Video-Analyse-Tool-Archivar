import { createStore, type MiddlewareFn, type PersistenceProviderImpl } from "defuss";
import { load, getEnv } from "defuss-env";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path"
import type { TimingEntry } from "../lib/workflow-types.js";
import type { TokenUsageSummary } from "../lib/token-usage-collector.js";
import type { NonFatalErrorSummary } from "../lib/non-fatal-error-collector.js";
import { SemanticAggregations } from "@lib/types.js";

// Load env first (same pattern as rpc.ts / pages/health.ts): the storage root
// is resolved at module load below, so without this the store would silently
// anchor to the built-in default directory whenever this module is imported
// before rpc.ts/health.ts inject .env.local. override=false: never clobber
// values a caller set deliberately (tests point the data dir at temp dirs).
load(getEnv("ENV_FILE", ".env.local"), true, false);

// Storage root for every cache-table file. Resolved once at module load.
// ABSOLUTE_DIR_PREFIX is an optional escape hatch: when set, the root anchors
// at <prefix>/<SAMPLE_DATA_SUBDIR>. Normally unset — the default derivation
// covers both runtimes without machine-specific absolute paths: in the
// container (cwd=/app) it lands on the fixed /sample_data/archivar mount
// point, in dev it resolves RELATIVE_SAMPLE_DATA_PATH against the checkout
// (same convention as file-api.ts).
const sampleDataSubDir = getEnv('SAMPLE_DATA_SUBDIR', 'sample_data/archivar');
const absoluteDirPrefix = getEnv('ABSOLUTE_DIR_PREFIX', '')
const dataDir = absoluteDirPrefix
    ? join(absoluteDirPrefix, sampleDataSubDir)
    : resolve(process.cwd(), getEnv('RELATIVE_SAMPLE_DATA_PATH', `../${sampleDataSubDir}`) ?? `../${sampleDataSubDir}`)

const getStorageFile = (fileName: string) => join(dataDir, fileName)

// Sync write is deliberate (serverless-friendly, no flush coordination at call
// sites); the debounce in makeNewFileStorageBackend keeps it off the hot path.
// A failed write is logged and swallowed — the in-memory map stays
// authoritative and the next scheduled flush retries.
const saveToDisk = (fileName: string, cache: any) => {
    try {
        writeFileSync(getStorageFile(fileName), JSON.stringify(Object.fromEntries(cache)), "utf8")
    } catch (e) {
        console.error("Cannot persist cache!", e)
    }
}

const loadFromDisk = (fileName: string): Record<string, any> => {
    try {
        const data = readFileSync(getStorageFile(fileName), "utf8");
        console.log("loadFromDisk", fileName, data.length, "chars")
        return JSON.parse(data);
    } catch (e) {
        // A missing file is the normal first-run case. A CORRUPT file also
        // lands here: the cache then silently starts empty and the next flush
        // overwrites the unreadable file with that empty state.
        console.error("Cannot read cache!", e)
        return {}
    }
}

/** Individual speech segment with ASR caption */
export interface AnalysisResultSpeech {
    caption: string;
    fileName: string;
    extension: string;
    outputHash: string | null;
    index: number;
    startTime: number;
    endTime: number;
    serverUrl: string;
}

/** Individual keyframe with image caption */
export interface AnalysisResultKeyframe {
    caption: string;
    fileName: string;
    extension: string;
    outputHash: string | null;
    serverUrl: string;
    index: number;
    startTime: number;
    endTime: number;
}

/** Individual audio segment (harmonic or noise) with sound caption */
export interface AnalysisResultAudioSegment {
    serverUrl: string;
    index: number;
    startTime: number;
    endTime: number;
    outputHash: string | null;
    fileName: string;
    extension: string;
    caption: string;
}

/** Scene with aggregated analysis data */
export interface AnalysisResultScene {
    index: number;
    startTime: number;
    endTime: number;
    serverUrl: string;
    fileName: string;
    extension: string;
    outputHash: string | null;
    mediaType: string;
    caption: string;
    speech: AnalysisResultSpeech[];
    keyframes: AnalysisResultKeyframe[];
    harmonic: AnalysisResultAudioSegment[];
    noise: AnalysisResultAudioSegment[];
}


// The AnalysisResult* segment/scene interfaces above are defined ONLY here
// (no duplicate definitions elsewhere in src/). The one
// real type duplicate in this file is HigherOrderAggregation, below.

/**
 * Top-level analysis result for one media file — the canonical "done" payload.
 * Written by WorkflowEngine.runWorkflow to `<file>.archivar/debug.json` and to
 * the `aggregated` cache table; read back by GET /api/raw and by the export
 * renderers (src/rpc/export.ts).
 */
export interface AnalysisResult {
    serverUrl: string;
    fileName: string;
    extension: string;
    outputHash: string | null;
    mediaType: string;
    scenes: AnalysisResultScene[];
    /** Semantic aggregations created by v3 plugins */
    semanticAggregations?: SemanticAggregations;
    /** Higher-order aggregations grouping semanticAggregations into macro-sections */
    higherOrderAggregations?: HigherOrderAggregations;
    /** Plugin run results keyed by plugin name */
    postProcessing?: Record<string, PluginRunResult>;
    /** Completeness-invariant violations found in the post-processing time
     *  slices (missing scene captions / keyframe fallbacks / speech transcripts).
     *  Surfaced in debug.json; never fails the run. */
    postProcessingWarnings?: string[];
    /** Processing timing data (hierarchical) */
    timing?: TimingEntry;
    /** Aggregated token usage for the whole run (input/output/total). */
    tokenUsage?: TokenUsageSummary;
    /** Aggregated non-fatal errors for the whole run (retries + isolated failures). */
    nonFatalErrors?: NonFatalErrorSummary;
}

// REFACTOR(dry): local copy of the canonical HigherOrderAggregation in
// src/lib/plugin-types.ts:233 — duplicated here to avoid a circular import,
// but the two shapes can now drift silently; consider a shared minimal
// types module both sides import.
/** Forward-declared HigherOrderAggregation type (canonical: src/lib/plugin-types.ts:233) */
interface HigherOrderAggregation {
    id: string;
    index: number;
    title: string;
    description: string;
    aggregationIndexes: number[];
    visualArtifacts: Array<{
        artifact: string;
        exactCaption: string;
        confidence: number;
        temporalStability: number;
    }>;
    perceptionMatrix?: unknown;
    intentionClassification?: string;
}
type HigherOrderAggregations = Array<HigherOrderAggregation>;

/** Per-plugin outcome of one post-processing run, persisted under AnalysisResult.postProcessing. */
interface PluginRunResult {
    pluginName: string;
    startedAt: string;
    completedAt: string;
    timeSlices: unknown[];
    aggregations: SemanticAggregations;
    summary?: unknown;
    errors: Array<{
        hook: string;
        message: string;
        sliceId?: string;
        aggregationId?: string;
    }>;
}

/** Quality attributes for material assessment */
export interface SummaryQualityAttributes {
    quality?: string;
    age?: string;
    colorization?: string;
    geoRegion?: string;
    languageSpoken?: string;
    materialAge?: string;
}

/** Perception entry for rhetoric/framing/emotion categories */
export interface PerceptionEntry {
    keyword: string;
    confidence: number;
}

/** Whole-video perception matrix aggregated from scene/aggregation-level signals */
export interface PerceptionMatrix {
    rhetoric?: PerceptionEntry;
    framing?: PerceptionEntry;
    emotion?: PerceptionEntry;
}

/** Result of generic summary post-processing (stored in separate "summary" cache table) */
export interface SummaryResult {
    title: string;
    abstract: string;
    keywords: string[];
    tags: string[];
    categorization: string;
    qualityAttributes: SummaryQualityAttributes;
    // v3 summary fields
    short_description?: string;
    long_summary?: string;
    // Long-horizon semantic understanding fields
    /** Overall video intention classification (INFORMATIONAL, PROMOTIONAL, etc.) */
    overallIntention?: string;
    /** Narrative arc description (e.g. "calm intro → tension → teaser reveal") */
    narrativeArc?: string;
    /** Perception arc description (e.g. "neutral → alarming → aspirational") */
    perceptionArc?: string;
    /** Aggregated whole-video perception matrix */
    perceptionMatrix?: PerceptionMatrix;
}

/**
 * Shape of the defuss store: one Record per cache table, keyed by cache key
 * (segment tables by outputHash-derived key, `aggregated` by aggregatedCacheKey).
 * NOTE: the plural keys here ("scenes") are store-table names, while the
 * singular TableName literals ("scene", db.ts end of file) and the singular
 * file names in src/rpc/cache-api.ts name the same logical tables.
 */
// REFACTOR(consistency): plural table keys here vs the singular TableName
// union (end of this file) and singular file names in src/rpc/cache-api.ts
// for the same tables — pick one vocabulary.
export interface DbSchema {
    scenes: Record<string, AnalysisResultScene>,
    audios: Record<string, AnalysisResultAudioSegment>
    speech: Record<string, AnalysisResultSpeech>,
    keyframes: Record<string, AnalysisResultKeyframe>,
    aggregated: Record<string, AnalysisResult>,
    // DEPRECATED: write-only cache table (never read) — kept for schema compatibility.
    summary: Record<string, SummaryResult>,
}

// DEPRECATED: no runtime code imports dbStore (repo-wide grep; only docs
// mention it) — actual cache access goes through the FileStorageProvider
// instances in src/rpc/cache-api.ts. Kept exported for API stability; do not
// build on it.
export const dbStore = createStore<DbSchema>({
    scenes: {},
    keyframes: {},
    audios: {},
    speech: {},
    aggregated: {},
    // DEPRECATED: write-only cache table (never read) — kept for schema compatibility.
    summary: {},
});


/**
 * The web storage API with a generic twist. Method docs are adapted from the
 * Web Storage spec, but the implementation here is a server-side file-backed
 * store: no storage events are dispatched and no quota is enforced.
 */
export interface GenericLocalStorage<T> {
    /** Removes all key/value pairs, if there are any. */
    clear(): void;

    /** Returns the current value associated with the given key, or null if the given key does not exist. */
    getItem(key: string): T | null;

    /** Removes the key/value pair with the given key, if a key/value pair with the given key exists. */
    removeItem(key: string): void;

    /** Sets the value of the pair identified by key to value, creating a new key/value pair if none existed for key previously. */
    setItem(key: string, value: T): void;

    /**
     * Returns a Map of all key/value pairs in the storage. This is an extension to the standard Web Storage API to allow retrieval of all entries at once.
     */
    getAll?(): Map<string, T>;
}

// DEPRECATED: exported but never referenced anywhere in the repo — leftover
// hook point; do not build on it.
export type MemoryProviderOptions = {};

/** Debounce window (ms) before mutated cache state is persisted to disk. */
const FLUSH_DEBOUNCE_MS = 500;

/**
 * Registry of pending flush callbacks. Process-exit handlers iterate this set
 * once to guarantee every debounced backend persists its latest state before
 * the process terminates. Registered only once (module-level singleton).
 */
const pendingFlushes = new Set<() => void>();
let exitHandlersRegistered = false;

/** Register SIGINT/SIGTERM/beforeExit handlers exactly once. */
function ensureExitHandlers(): void {
    if (exitHandlersRegistered) return;
    exitHandlersRegistered = true;

    const flushAll = () => {
        for (const flush of pendingFlushes) {
            try { flush(); } catch (e) { console.error("Flush on exit failed!", e); }
        }
        pendingFlushes.clear();
    };

    process.on('SIGINT', () => { flushAll(); process.exit(0); });
    process.on('SIGTERM', () => { flushAll(); process.exit(0); });
    process.on('beforeExit', flushAll);
}

/**
 * Factory for one file-backed storage backend (one JSON file per cache table).
 * src/rpc/cache-api.ts pins one backend per table file (scene.db, audio.db,
 * keyframe.db, speech.db, aggregated.db, summary.db).
 *
 * Write-behind caching: reads are served from an in-memory Map hydrated from
 * disk at construction; mutations only mark the map dirty and schedule a
 * debounced flush (FLUSH_DEBOUNCE_MS), so burst writes (e.g. per-segment
 * caching during analysis) collapse into a single writeFileSync. Process-exit
 * handlers flush whatever is still pending (see ensureExitHandlers).
 */
export const makeNewFileStorageBackend = <
    T = string,
>(fileName: string): GenericLocalStorage<T> => {
    let cache = new Map<string, T>();
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let dirty = false;

    // loadFromDisk already swallows all read/parse errors (returns {}), so
    // this try/catch is only a second line of defense.
    try {
        cache = new Map(Object.entries(loadFromDisk(fileName)))
    } catch (e) { }

    ensureExitHandlers();

    /** Persist the in-memory map to disk immediately, clearing any pending timer. */
    const flushNow = (): void => {
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        if (dirty) {
            saveToDisk(fileName, cache);
            dirty = false;
        }
        pendingFlushes.delete(flushNow);
    };

    /** Mark the backend dirty and schedule a deferred disk write. */
    const scheduleFlush = (): void => {
        dirty = true;
        if (flushTimer) clearTimeout(flushTimer);
        pendingFlushes.add(flushNow);
        flushTimer = setTimeout(flushNow, FLUSH_DEBOUNCE_MS);
    };

    return {
        clear: (): void => {
            cache.clear();
            scheduleFlush();
        },

        getItem: (key: string): T | null => {
            return cache.get(String(key)) ?? null;
        },

        removeItem: (key: string): void => {
            cache.delete(String(key));
            scheduleFlush();
        },

        setItem: (key: string, value: T): void => {
            cache.set(String(key), value);
            scheduleFlush();
        },

        getAll: (): Map<string, T> => {
            return new Map(cache);
        },
    };
};

/**
 * A simple, serverless and high-performance key/value storage engine.
 * Adapts a GenericLocalStorage backend to defuss's PersistenceProviderImpl:
 * values cross the boundary as JSON strings (stringify on set, parse on get),
 * so T must stay JSON-serializable. This is the persistence layer CacheApi
 * (src/rpc/cache-api.ts) sits on; the optional MiddlewareFn hooks let callers
 * transform values on the way in/out (validation, migration, derived fields).
 */
export class FileStorageProvider<T> implements PersistenceProviderImpl<T> {
    protected storage: GenericLocalStorage<string>;

    constructor(storage?: GenericLocalStorage<string>) {
        this.storage = storage || makeNewFileStorageBackend<string>("default_storage.json");
    }

    get(key: string, defaultValue: T, middlewareFn?: MiddlewareFn<T>): T {
        const rawValue = this.storage.getItem(key);

        if (rawValue === null) return defaultValue;

        let value: T = JSON.parse(rawValue);

        if (middlewareFn) {
            value = middlewareFn(key, value);
        }
        return value;
    }

    set(key: string, value: T, middlewareFn?: MiddlewareFn<T>): void {
        if (middlewareFn) {
            value = middlewareFn(key, value);
        }
        this.storage.setItem(key, JSON.stringify(value));
    }

    remove(key: string): void {
        this.storage.removeItem(key);
    }

    removeAll(): void {
        this.storage.clear();
    }

    getAll(): Record<string, T> {
        if (this.storage && typeof (this.storage as any).getAll === 'function') {
            const allRaw = (this.storage as any).getAll() as Map<string, string>;
            const result: Record<string, T> = {};
            for (const [key, rawValue] of allRaw.entries()) {
                try {
                    result[key] = JSON.parse(rawValue);
                } catch {
                    // skip unparseable entries
                }
            }
            return result;
        }
        return {};
    }

    get backendApi(): GenericLocalStorage<string> {
        return this.storage;
    }
}

// DEPRECATED member: "summary" is an unused cache table — nothing writes or
// reads it anymore; kept in the union so purge/clear paths still cover old
// summary.db files.
export type TableName = "scene" | "audio" | "keyframe" | "speech" | "aggregated" | "summary"

