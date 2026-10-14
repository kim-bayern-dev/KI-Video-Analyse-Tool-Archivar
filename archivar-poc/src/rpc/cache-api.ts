import { FileStorageProvider, makeNewFileStorageBackend, type AnalysisResultAudioSegment, type AnalysisResultKeyframe, type AnalysisResultScene, type AnalysisResultSpeech, type SummaryResult, type TableName } from "../db/db";
import { buildAnalysisView, extractCaptionsByHash, type AnalysisView } from "../lib/analysis-view.js";
import { getEnv } from "defuss-env";
import { resolve } from "node:path";
import glob from "fast-glob";
import { basename } from "node:path";

// Module-level singletons: constructing a provider opens (and creates) its .db
// file, so all six backends come up eagerly at import time and are shared by
// every CacheApi instance in this process.
const storageBackend = {
    scene: new FileStorageProvider<AnalysisResultScene>(
        makeNewFileStorageBackend("scene.db")
    ),
    audio: new FileStorageProvider<AnalysisResultAudioSegment>(
        makeNewFileStorageBackend("audio.db")
    ),
    keyframe: new FileStorageProvider<AnalysisResultKeyframe>(
        makeNewFileStorageBackend("keyframe.db")
    ),
    speech: new FileStorageProvider<AnalysisResultSpeech>(
        makeNewFileStorageBackend("speech.db")
    ),
    aggregated: new FileStorageProvider<any>(
        makeNewFileStorageBackend("aggregated.db")
    ),
    // DEPRECATED: the "summary" table is unused — nothing writes or reads it
    // anymore; kept so purge/clear paths still cover old summary.db files.
    summary: new FileStorageProvider<SummaryResult>(
        makeNewFileStorageBackend("summary.db")
    )
}

/**
 * Key/value cache RPC facade over the per-table file-storage backends.
 * Entry keys embed the owning file's outputHash, which is what makes
 * substring-based invalidation (removeByPrefix, purgeOrphans) work.
 */
export class CacheApi {

    public async set<T>(tableName: TableName, key: string, value: T) {
        storageBackend[tableName].set(key, value as any);
    }

    public async get<T>(tableName: TableName, key: string, defaultValue: T): Promise<T> {
        return storageBackend[tableName].get(key, defaultValue as any) as T;
    }

    public async clear<T>(tableName: TableName) {
        return storageBackend[tableName].removeAll()
    }

    public async getAll<T>(tableName: TableName): Promise<Record<string, T>> {
        const t0 = performance.now();
        const result = storageBackend[tableName].getAll() as Record<string, T>;
        console.log(`[PERF] CacheApi.getAll("${tableName}") server-side: ${(performance.now() - t0).toFixed(0)}ms, ${Object.keys(result).length} entries`);
        return result;
    }

    // REFACTOR(dry): the getAll()-then-filter loop recurs in removeByPrefix and
    // purgeOrphans below — a shared filterKeys(predicate) helper would dedupe it,
    // and a provider-level key scan could avoid materializing multi-MB tables.
    /**
     * Returns only entries whose key contains `keySubstring`. Use this instead of
     * `getAll` when the caller needs a single file's entries: filtering server-side
     * keeps multi-MB tables (e.g. `aggregated`, ~70MB) off the wire.
     */
    public async getByKeySubstring<T>(tableName: TableName, keySubstring: string): Promise<Record<string, T>> {
        const all = storageBackend[tableName].getAll() as Record<string, T>;
        const result: Record<string, T> = {};
        for (const key of Object.keys(all)) {
            if (key.includes(keySubstring)) result[key] = all[key];
        }
        return result;
    }

    /**
     * Dashboard caption backfill: `cacheId → caption` for the four segment
     * tables (scene/keyframe/speech/audio), restricted to one file's hash.
     * Replaces client-side `getAll` bulk fetches (~8 MB → a few KB–hundred KB).
     */
    public async getCaptionsByHash(hash: string): Promise<Record<string, string>> {
        return extractCaptionsByHash([
            storageBackend.scene.getAll(),
            storageBackend.keyframe.getAll(),
            storageBackend.speech.getAll(),
            storageBackend.audio.getAll(),
        ], hash);
    }

    /**
     * Dashboard per-file view: the lean AnalysisView for one outputHash —
     * captions, aggregation/HOA regions, filtered summary view and provenance,
     * without the multi-MB per-segment metadata duplication of the full result.
     * The preferred-plugin key selection (question-answer first)
     * lives server-side here so the client issues exactly one call per file.
     */
    public async getAnalysisViewByHash(outputHash: string): Promise<AnalysisView> {
        const allAggregated = storageBackend.aggregated.getAll() as Record<string, unknown>;
        const matchingKeys = Object.keys(allAggregated).filter((k) => k.includes(outputHash));
        const key = matchingKeys.find((k) => k.includes("question-answer"))
            ?? matchingKeys[0]
            ?? null;
        return buildAnalysisView(key ? (allAggregated[key] as Parameters<typeof buildAnalysisView>[0]) : null, key);
    }

    /**
     * Remove every entry whose key CONTAINS the given substring (typically a
     * file's outputHash). Loads the full table first — same memory caveat as
     * getByKeySubstring (the aggregated table is ~70MB).
     */
    // REFACTOR(typo): named "removeByPrefix" but matches any substring via
    // key.includes() — renaming would break the RPC whitelist (src/rpc.ts:81)
    // and callers file-api.ts / workflow-engine.ts; keep name and callers in sync.
    public async removeByPrefix(tableName: TableName, hashSubstring: string): Promise<number> {
        const all = storageBackend[tableName].getAll();
        let removed = 0;
        for (const key of Object.keys(all)) {
            if (key.includes(hashSubstring)) {
                storageBackend[tableName].remove(key);
                removed++;
            }
        }
        return removed;
    }

    /**
     * Scans all cache tables and removes entries whose key does not reference any
     * currently-existing `out_*` folder hash. Returns a per-table breakdown of how
     * many orphaned entries were removed. Safe to run on a live system: it reads
     * each table fully, then removes only orphaned keys (read-then-remove).
     */
    public async purgeOrphans(): Promise<{ tables: Record<string, number>; totalRemoved: number }> {
        const knownHashes = await this._collectKnownOutputHashes();
        console.log(`[PURGE-ORPHANS] Found ${knownHashes.size} known output hash(es): ${[...knownHashes].join(", ") || "(none)"}`);

        const tables: Record<string, number> = {};
        let totalRemoved = 0;

        for (const table of Object.keys(storageBackend) as TableName[]) {
            const all = storageBackend[table].getAll();
            let removed = 0;
            for (const key of Object.keys(all)) {
                // An entry is orphaned when no known hash appears as a substring of its key
                const isOrphan = ![...knownHashes].some((hash) => key.includes(hash));
                if (isOrphan) {
                    storageBackend[table].remove(key);
                    removed++;
                }
            }
            tables[table] = removed;
            totalRemoved += removed;
        }

        console.log(`[PURGE-ORPHANS] Removed ${totalRemoved} orphaned entry/entries`);
        return { tables, totalRemoved };
    }

    /**
     * Collects the set of outputHash values derived from every existing `out_*`
     * folder in the data directory. Each folder is named `out_<name>_<ext>_<hash>`,
     * where the hash is the trailing `_`-delimited segment.
     */
    private async _collectKnownOutputHashes(): Promise<Set<string>> {
        const sampleDataSubDir = getEnv('SAMPLE_DATA_SUBDIR', 'sample_data/archivar') ?? 'sample_data/archivar';
        const relativeSampleDataPath = getEnv('RELATIVE_SAMPLE_DATA_PATH', `../${sampleDataSubDir}`) ?? `../${sampleDataSubDir}`;
        const dataDir = resolve(process.cwd(), relativeSampleDataPath);

        const folders = await glob.async('out_*', {
            absolute: true,
            onlyDirectories: true,
            deep: 1,
            cwd: dataDir,
        });

        const hashes = new Set<string>();
        for (const folder of folders) {
            const name = basename(folder);
            const parts = name.split('_');
            if (parts.length > 1) {
                hashes.add(parts[parts.length - 1]);
            }
        }
        return hashes;
    }
}