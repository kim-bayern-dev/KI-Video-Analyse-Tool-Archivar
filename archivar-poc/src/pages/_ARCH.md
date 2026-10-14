# `src/pages/`-Architecture Reference

This directory contains the Astro **routing endpoints** for `archivar-poc`. Each file (or rest-spread route) maps to an HTTP route exposed by the Astro server. Together they form the server-side surface: the SPA shell, a health-check endpoint, the file-upload/check API, and the defuss-RPC gateway.

---

## `[...all].astro`
[`src/pages/[...all].astro`](src/pages/[...all].astro)

**Purpose:** Catch-all Astro page that renders the single-page application shell. It mounts the client-side [`Router`](src/csr/router.tsx) inside [`BaseLayout`](src/layouts/base.astro) and is the HTML entry point for every non-API, non-`health` route.

**Key Concerns:**
- **SSR vs prerender:** Explicitly disables prerendering ([`prerender`](src/pages/[...all].astro) = `false`) so the page is dynamically server-rendered on every request.
- **App props handoff:** Reads [`Astro.locals.APP_PROPS`](src/pages/[...all].astro) (currently always `null`) and injects it into the document via an inline `<script id="app-props">`, exposing it on `window.$APP_PROPS` for the client bundle. This is the SSR → CSR state-transfer seam.
- **Client-only mount:** [`Router`](src/csr/router.tsx) is mounted with `client:only="defuss"`, meaning it renders purely on the client; the Astro side only ships the fallback `<T key="Loading..." />` placeholder.

---

## `health.ts`
[`src/pages/health.ts`](src/pages/health.ts)

**Purpose:** Server-side `GET /health` endpoint. A thin delegate: runs the shared
[`runModelHealthChecks()`](src/lib/model-health.ts) (the single source of truth -
real per-model inference probes plus pre-processing tool checks) and appends the
configured model inventory from [`HealthApi.listModels()`](src/rpc/health-api.ts).
Returns `{ status, checks, models }` with aggregate `status` of `ok` /
`degraded` / `error` and HTTP `200` / `503` accordingly.

**Key Concerns:**
- **Environment loading:** loads the env file itself first
  (`load(getEnv("ENV_FILE", ".env.local"))`, same pattern as rpc.ts / db.ts) so
  the endpoint works regardless of import order.
- **Timeout / reliability, caching:** see [`src/lib/model-health.ts`](src/lib/model-health.ts)
  (per-probe timeouts; results are never cached-each request re-runs all checks live).

---

## `api/check-file-exists.ts`
[`src/pages/api/check-file-exists.ts`](src/pages/api/check-file-exists.ts)

**Purpose:** DEPRECATED: `POST /api/check-file-exists` endpoint with no caller
anywhere-the upload wizard checks existence via RPC (`FileApi.checkFileExists`),
not this REST endpoint. Accepts a JSON body `{ fileName }` and delegates to
[`checkFileExists`](src/rpc/file-upload-api.ts) to report whether a file is
already present, returning the result as JSON.

**Key Concerns:**
- **Thin delegation:** All filesystem logic lives in [`checkFileExists`](src/rpc/file-upload-api.ts); this file is purely an Astro API-route adapter (request parse → call → JSON response).
- **Error handling:** JSON parse failures and thrown errors are caught and surfaced as `400` / `500` JSON responses; never an unhandled throw.
- **Cache management:** None at this layer-any caching is the responsibility of [`checkFileExists`](src/rpc/file-upload-api.ts).
- **No environment-driven path decisions here**-those are encapsulated in [`checkFileExists`](src/rpc/file-upload-api.ts).

---

## `api/upload.ts`
[`src/pages/api/upload.ts`](src/pages/api/upload.ts)

**Purpose:** DEPRECATED: `POST /api/upload` endpoint with no caller anywhere -
the upload wizard uploads via `/rpc/upload` (chunked binary transport), not this
REST endpoint. Accepts a `multipart/form-data` upload (field `file`) and writes
the received bytes to the configured sample-data directory on disk, returning
`{ ok, fileName }`.

**Key Concerns:**
- **Environment-variable-driven path decisions:** The destination directory is fully env-driven:
  - [`SAMPLE_DATA_SUBDIR`](src/pages/api/upload.ts) (default `sample_data/archivar`)-the subdirectory name.
  - [`RELATIVE_SAMPLE_DATA_PATH`](src/pages/api/upload.ts) (default `../<SAMPLE_DATA_SUBDIR>`)-the path relative to `process.cwd()`.
  - The final directory is [`resolve`](src/pages/api/upload.ts)`(process.cwd(), relativeSampleDataPath)`.
- **Security / path-traversal defense (algorithmic):** Filenames are sanitized via [`basename`](src/pages/api/upload.ts) plus a strip of any character outside `[a-zA-Z0-9._-]`, and the resolved destination is verified to still start with `dataDir` ([`destPath.startsWith(dataDir)`](src/pages/api/upload.ts)) before writing. This is the only non-trivial logic in the file.
- **I/O:** Reads the entire upload into memory via `file.arrayBuffer()` → `Buffer.from(...)` then [`writeFile`](src/pages/api/upload.ts); there is no streaming, so very large uploads will consume proportional memory.
- **Cache management:** None-writes go straight to disk; no in-memory or metadata cache is touched.

---

## `api/analyze.ts`
[`src/pages/api/analyze.ts`](src/pages/api/analyze.ts)

**Purpose:** `POST /api/analyze` endpoint that triggers analysis workflow via HTTP POST. Accepts the same parameters as the CLI analyze command plus an optional `webHookUrl`.

**Request Body:**
```typescript
{
  file: string;              // Required: file path to analyze
  workflow?: string;          // Optional: workflow name
  force?: boolean;           // Optional: bypass cache
  webHookUrl?: string;       // Optional: URL to call when done
  format?: "json" | "md" | "toon";
  only?: string;
  overrides?: ...;
  postProcessingOverrides?: ...;
}
```

**Response:**
```typescript
{ ok: true; file: string; status: "processing" | "done" }
```

**Key Concerns:**
- **Thin delegation:** Calls `AnalyseApi.runWorkflow()` via RPC exactly like CLI.
- **Async execution:** Returns immediately with `status: "processing"` while workflow runs server-side.
- **webHookUrl support:** Passed through to the workflow engine which delivers the webhook on completion.
- **Status polling:** Use `GET /api/raw?file=...` to poll for completion status.

---

## `api/raw.ts`
[`src/pages/api/raw.ts`](src/pages/api/raw.ts)

**Purpose:** `GET /api/raw` endpoint that fetches the raw JSON status/output for a file.

**Query Parameters:**
- `file` (required): The file path to query

**Response:**
```typescript
// Processing state:
{ status: "processing"; file: "..." }

// Done state:
{ status: "done"; file: "..."; result: AnalysisResult }

// Error state:
{ status: "error"; file: "..."; error: "..." }

// Not found:
null
```

**Key Concerns:**
- **Status-first:** First checks `status.json` for current status.
- **debug.json on done:** When status is "done", reads `debug.json` for the full analysis result.
- **RPC delegation:** Uses `StatusApi.getStatus()` and `FileApi.readFile()` via RPC.

---

## `api/logs.ts`
[`src/pages/api/logs.ts`](src/pages/api/logs.ts)

**Purpose:** `GET /api/logs` endpoint that fetches the debug log content for a file.

**Query Parameters:**
- `file` (required): The file path to query

**Response:**
```typescript
// Processing or done state:
{ status: "processing" | "done"; data: string }  // log content

// Not found:
null
```

**Key Concerns:**
- **RPC delegation:** Uses `StatusApi.getStatus()` and `FileApi.readFile()` via RPC.
- **Reads debug.log:** Returns the content of `<file>.archivar/debug.log`.

---

## `api/list.ts`
[`src/pages/api/list.ts`](src/pages/api/list.ts)

**Purpose:** `GET /api/list` endpoint that lists all files in the data directory.

**Query Parameters:**
- `pattern` (optional): Glob pattern to match files (default: `*`)

**Response:**
```typescript
Array<FileInfo>
```

**Key Concerns:**
- **RPC delegation:** Uses `FileApi.listFiles()` via RPC.
- **Same as CLI list:** Matches the output of `archivar list` command.

---

## `api/clear-cache.ts`
[`src/pages/api/clear-cache.ts`](src/pages/api/clear-cache.ts)

**Purpose:** `DELETE /api/clear-cache` endpoint that clears cache and outputs for a file.

**Query Parameters:**
- `file` (required): The file path to clear

**Response:**
```typescript
// Success:
{ status: "cleared"; removed?: number }

// Not found:
null
```

**Key Concerns:**
- **RPC delegation:** Uses `FileApi.clearFileCache()` via RPC.
- **Same as CLI clear-cache:** Matches the behavior of `archivar clear-cache --file <path>`.

---

## `api/export.ts`
[`src/pages/api/export.ts`](src/pages/api/export.ts)

**Purpose:** `GET /api/export?file=…&format=…[&force=1][&view=filtered]` endpoint.
Generates (or reuses) an export file for an analysis result and streams it as an
attachment. Formats: `docx | md | json | raw | log | srt | vct | errors |
vlm-requests | asr-requests`-see [`EXPORT_FORMATS`](src/rpc/export.ts).

**Key Concerns:**
- **In-process, not proxied:** unlike its sibling routes (which proxy to
  `ANALYZE_API_SERVER` via longFetch+DSON), this route runs the export logic
  in-process and reads the result from the local filesystem-deliberate, to
  stream file bytes without a DSON round-trip, at the cost of coupling the web
  process to the analysis server's filesystem.
- **Filtered view:** with `view=filtered` (the dashboard's download links),
  docx/md/json are rendered from the reduced result view (see
  [`src/lib/result-view.ts`](src/lib/result-view.ts)); `raw`/`log`/`srt`/`vct`
  are verbatim artifacts and never filtered.
- **Path safety:** the `file` parameter is `basename()`-sanitized; the resolved
  export path must stay under the exports dir.

---

## `api/status.ts`
[`src/pages/api/status.ts`](src/pages/api/status.ts)

**Purpose:** `GET /api/status?status=processing|done|error` endpoint. Lists task
statuses (one per analyzed file's `<file>.archivar/status.json`), newest first;
omit `status` (or pass `all`) to list every known task.

**Response:**
```typescript
{ tasks: StatusFile[] }
```

**Key Concerns:**
- **RPC delegation:** Uses `StatusApi.listStatuses()` via RPC; backs the CLI
  `status` command and harness polling.
- **Stale transition:** readers treat a long-silent "processing" status as dead
  and persist a one-time transition to "error" (see
  [`src/rpc/status-api.ts`](src/rpc/status-api.ts)).

---

## `rpc/[...all].ts`
[`src/pages/rpc/[...all].ts`](src/pages/rpc/[...all].ts)

**Purpose:** Catch-all route that mounts the **defuss-RPC** gateway under `/rpc/*`. It wires both `GET` and `POST` to [`rpcRoute`](https://github.com/kyr0/defuss) (imported from `defuss-rpc/server.js`), so any `/rpc/...` path is handled by the defuss-RPC server dispatcher.

**Key Concerns:**
- **Side-effectful registration:** The module's second import-[`import "../../rpc.js"`](src/pages/rpc/[...all].ts)-is what actually registers all RPC procedures (analysis, auth, cache, file, file-upload, mllm, workflow-engine). Importing this route file for the first time triggers that registration as a side effect; without it, [`rpcRoute`](src/pages/rpc/[...all].ts) would have no procedures bound. See [`src/rpc.ts`](src/rpc.ts) and [`src/rpc/`](src/rpc/ARCH.md) for the procedure catalogue.
- **Prerender:** Disabled (`prerender = false`) so RPC requests are always handled dynamically.
- **No direct cache / env / algorithm logic**-all of that lives behind the registered procedures (e.g. [`cache-api`](src/rpc/cache-api.ts), [`file-upload-api`](src/rpc/file-upload-api.ts), [`mllm-api`](src/rpc/mllm-api.ts), [`workflow-engine`](src/rpc/workflow-engine.ts)). This file is intentionally a one-line gateway.
