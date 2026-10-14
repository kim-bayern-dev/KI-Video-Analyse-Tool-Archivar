# `src/db/`-Architectural Documentation

This directory houses the application's persistence and data-store layer. It defines the canonical schema for analysis results and provides a file-backed key/value storage engine that the defuss store uses as a persistence provider.

---

## `db.ts`
[`db.ts`](db.ts)

**Purpose:**
Defines the canonical data model (TypeScript interfaces) for all analysis artifacts produced by the archivar pipeline-speech segments, keyframes, audio segments, scenes, aggregated results, and summaries-and exposes a reactive in-memory store ([`createStore`](db.ts)) plus a file-backed persistence provider that implements defuss's [`PersistenceProviderImpl`](db.ts). It is the single source of truth for the shape of persisted data and the bridge between the runtime store and on-disk JSON cache files.

**Key Concerns:**

- **Cache management (two-tier):**
  - An in-memory [`Map`](db.ts) acts as the hot cache for each storage backend. On construction, the map is hydrated from disk via [`loadFromDisk`](db.ts); mutations update the in-memory map immediately but **disk persistence is debounced**-a 500ms debounce window (`FLUSH_DEBOUNCE_MS`) collapses rapid successive mutations (e.g. batch segment caching) into a single synchronous `writeFileSync` via [`saveToDisk`](db.ts). Process-exit handlers (`SIGINT`/`SIGTERM`/`beforeExit`) iterate a module-level registry of pending flush callbacks ([`pendingFlushes`](db.ts)) to guarantee the latest state is persisted before termination. In-memory reads (`get`/`getAll`) remain instant and unaffected.
  - The top-level reactive store [`dbStore`](db.ts) (created via defuss `createStore<DbSchema>`) holds six named tables: `scenes`, `keyframes`, `audios`, `speech`, `aggregated`, `summary`. DEPRECATED: no runtime code imports `dbStore`-actual cache access goes through the `FileStorageProvider` instances in [`src/rpc/cache-api.ts`](src/rpc/cache-api.ts). Kept exported for API stability; do not build on it.

- **Environment-driven path decisions:**
  - The on-disk storage root is resolved from environment variables read via `getEnv` (from `defuss-env`):
    - [`ABSOLUTE_DIR_PREFIX`](db.ts) + [`SAMPLE_DATA_SUBDIR`](db.ts)-absolute-path override for deployments (no default; when `ABSOLUTE_DIR_PREFIX` is unset, the convention below applies).
    - [`RELATIVE_SAMPLE_DATA_PATH`](db.ts)-default `../sample_data/archivar` (i.e. `../${SAMPLE_DATA_SUBDIR}`), resolved against the process CWD-the same convention file-api.ts uses.
  - [`dataDir`](db.ts) is computed at module load-the module therefore loads the env file itself first (`load(getEnv("ENV_FILE", ".env.local"))`, same pattern as rpc.ts / pages/health.ts), so the store cannot anchor to the built-in default directory when it is imported before rpc.ts. Each storage backend's JSON file is resolved relative to this directory via [`getStorageFile`](db.ts). Changing these env vars relocates the entire persistence layer. Note: directory creation is not handled here-consumers must ensure `dataDir` exists.

- **File-based persistence provider (`FileStorageProvider`):**
  - Implements the defuss [`PersistenceProviderImpl<T>`](db.ts) interface over an injectable [`GenericLocalStorage<string>`](db.ts) backend (defaulting to one produced by [`makeNewFileStorageBackend`](db.ts)).
  - Supports optional [`MiddlewareFn`](db.ts) hooks on both `get` and `set`, allowing callers to transform values before/after persistence (e.g. for validation, migration, or derived fields).
  - Values are JSON-serialized on write and JSON-parsed on read; [`getAll`](db.ts) iterates the underlying map and tolerates unparseable entries by skipping them.

- **Schema design (`DbSchema` / `TableName`):**
  - [`DbSchema`](db.ts) maps each table name to a `Record<string, T>` keyed by string ID. The exported [`TableName`](db.ts) union type enumerates the valid table names (`"scene" | "audio" | "keyframe" | "speech" | "aggregated" | "summary"`).
  - The top-level [`AnalysisResult`](db.ts) carries optional v3-plugin fields ([`semanticAggregations`](db.ts), [`postProcessing`](db.ts)) and a hierarchical [`TimingEntry`](db.ts) (imported from `../lib/workflow-types.js`), reflecting the multi-version analysis pipeline. Plugin-related types ([`SemanticAggregationV3`](db.ts), [`PluginRunResultV3`](db.ts)) are forward-declared inline here to avoid circular imports with `plugin-types.ts`.
  - DEPRECATED: the `summary` table is unused-nothing writes or reads it anymore. It stays in [`DbSchema`](db.ts)/[`TableName`](db.ts) so purge/clear paths still cover old `summary.db` files.

- **Other architectural notes:**
  - Synchronous I/O (`readFileSync`/`writeFileSync`) is used deliberately-this is a serverless-friendly, append-safe pattern but means writes block the event loop. At high write volumes this is a bottleneck.
  - There are **no LLM/3rd-party API protocol implementations** in this file; it is purely a data/persistence layer.
  - There are **no high-complexity algorithms** beyond straightforward JSON (de)serialization and Map/Object interop. The persistence strategy (write-through JSON files) is the principal complexity.
