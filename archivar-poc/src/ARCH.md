# Architecture Reference-`src/` Root

This document describes the purpose and architectural significance of each TypeScript
file living directly in [`src/`](src/). These files form the application's CLI entry
point, HTTP middleware, RPC server bootstrap, and shared ambient type declarations.

---

## `cli.ts`

[`src/cli.ts`](src/cli.ts)

**Purpose:** The Archivar command-line interface-a thin client that either proxies
to a remote analysis server via RPC or, in `--local` mode, imports and runs the
[`WorkflowEngine`](src/rpc/workflow-engine.ts) directly in-process. It exposes
subcommands for listing files/segments, running analysis workflows, managing
per-file config, inspecting logs, and clearing caches.

**Key Concerns:**

- **RPC protocol (DSON over HTTP):** All remote invocations go through
  [`rpcCall()`](src/cli.ts), which serializes payloads with
  `defuss-dson` (DSON) and POSTs to the server's `/rpc` endpoint. This is the
  wire protocol shared with the web frontend and the server-side
  [`RpcApi`](src/rpc.ts).

- **Long-running request handling:** [`rpcCall()`](src/cli.ts) routes through
  [`longFetch`](src/lib/long-fetch.ts) with a 12-hour `AbortSignal` timeout.
  This is critical because analysis workflows (LLM inference, segment processing)
  routinely exceed Node/undici's built-in 5-minute headers/body timeouts.

- **Environment-driven path & server decisions:**
  - Default server URL is `http://localhost:8801` (overridable via `--server`).
  - API key defaults to `process.env.API_KEY` or a dev fallback.
  - The `--local` flag toggles between remote-RPC and direct in-process execution
    paths-a significant architectural fork.
  - Debug log / raw JSON paths are conventionally derived as
    `<file>.archivar/debug.log` and `<file>.archivar/debug.json`.

- **Multi-layered override resolution algorithm:** [`cmdAnalyze()`](src/cli.ts)
  resolves per-media-type processing overrides across three precedence layers
  (lowest → highest):
  1. `--config-file <path>` (JSON file with per-type overrides)
  2. `--<type>-model` / `--<type>-prompt` prefixed flags
  3. `--model` / `--prompt` / `--type` shorthand (backward-compat, highest)

  A separate post-processing override builder handles summary toggles and plugin
  enable/disable lists.

- **Cache management:** The `clear-cache` subcommand supports two modes:
  - Per-table clearing via `CacheApi.clear` (valid tables: `scene`, `audio`,
    `keyframe`, `speech`, `aggregated`, `summary`-`summary` is DEPRECATED:
    an unused table, kept so old entries can still be cleared).
  - Per-file clearing via `FileApi.clearFileCache` (removes cache entries +
    outputs for a specific file while keeping the source).
  The `delete` subcommand additionally removes the source file itself. The
  legacy `raw` subcommand is DEPRECATED-it exits with a pointer to
  `export --format raw`.

- **Debug log tailing:** [`cmdAnalyze()`](src/cli.ts) spawns a polling
  `tailDebugLog` coroutine that fetches the server-side `debug.log` every 2 s via
  `FileApi.readFile` and streams new bytes to stderr-providing live progress
  feedback during long remote workflows. For browser clients the same file is
  streamed by the async-generator RPC `FileApi.tailDebugLog` (NDJSON via
  defuss-rpc), consumed by the upload wizard's step 5.

- **Degraded-run exit gate (`analyze`):** after a workflow completes,
  [`cmdAnalyze()`](src/cli.ts) reads the run's error tally (RPC mode:
  `<file>.archivar/errors.json` via `FileApi.readFile`; `--local` mode: the
  `nonFatalErrors.count` field of the JSON result) and exits **2** when
  non-fatal errors were recorded-distinct from 1 (hard failure). Exit 0
  therefore means "output is complete", not merely "process survived"; eval
  scripts and CI can trust their OK/FAILED signal. Unreadable artifacts fail
  open (no exit-code change), never masking a successful run.

---

## `middleware.ts`

[`src/middleware.ts`](src/middleware.ts)

**Purpose:** Astro server middleware that applies CORS headers to every request
and short-circuits `OPTIONS` pre-flight requests with a `204 No Content` response.

**Key Concerns:**

- **Environment-driven origin validation:** The set of allowed CORS origin hosts
  is sourced from [`allowedHosts`](astro.config.ts) (exported by the Astro
  config). Only requests whose `Origin` hostname matches this allowlist receive
  permissive CORS headers; all others are silently denied. This makes CORS policy
  fully driven by the deployment configuration.

- **Dynamic header reflection:** [`applyCorsHeaders()`](src/middleware.ts)
  reflects the client's `Access-Control-Request-Headers` value back in
  `Access-Control-Allow-Headers`, falling back to a default of
  `Authorization, Content-Type` when not present. The `Vary` header is set
  accordingly to ensure correct cache behavior.

---

## `rpc.ts`

[`src/rpc.ts`](src/rpc.ts)

**Purpose:** Server-side RPC bootstrap. It loads environment configuration,
assembles the [`RpcApi`](src/rpc.ts) object mapping class names to their API
implementations, registers an ACL guard hook, and calls `createRpcServer` to
expose the API over HTTP.

**Key Concerns:**

- **Environment loading:** Uses `defuss-env`'s `load()` to read a `.env` file
  whose path is taken from the `ENV_FILE` env var (defaulting to `.env.local`). The
  `API_KEY` is also read from the environment and used for auth gating.

- **RPC API surface:** [`RpcApi`](src/rpc.ts) aggregates nine API classes:
  - [`AuthApi`](src/rpc/auth.ts)-login/logout
  - [`FileApi`](src/rpc/file-api.ts)-file listing, deletion, cache clearing,
    raw file reads
  - [`AnalyseApi`](src/rpc/analyse-api.ts)-workflow execution, config
    management, model listing, segment analysis
  - [`MllmApi`](src/rpc/mllm-api.ts)-multimedia LLM captioning (audio, video,
    image, sound)
  - [`CacheApi`](src/rpc/cache-api.ts)-cache get/set/clear/getAll/removeByPrefix
  - [`StatusApi`](src/rpc/status-api.ts)-per-file `status.json` lifecycle
  - [`WebhookApi`](src/rpc/webhook-api.ts)-completion webhook delivery
  - [`ExportApi`](src/rpc/export-api.ts)-export generation/listing
  - [`HealthApi`](src/rpc/health-api.ts)-config validation + model health

  A binary upload handler is auto-registered as a side-effect import of
  [`src/rpc/file-upload-api.ts`](src/rpc/file-upload-api.ts), replacing the legacy
  RPC-based chunked upload.

- **Access control (ACL guard):** The [`addHook`](src/rpc.ts) guard hook
  implements a three-tier auth policy:
  1. **Public bootstrap paths:** requests under `PUBLIC_RPC_PATH_SUFFIXES`
     (`/rpc/schema`) are always allowed-the client fetches the RPC schema
     before login, so gating it would make sign-in impossible.
  2. **API key bypass:** If `x-api-key` header matches the server's `API_KEY`,
     the call is allowed unconditionally.
  3. **Whitelist:** A static [`rpcCallWhitelist`](src/rpc.ts) of
     `className.methodName` pairs (e.g. `AuthApi.login`, `FileApi.listFiles`,
     `MllmApi.captionImage`, `CacheApi.*`) can be invoked without a bearer token.
     Any other call must carry an `Authorization` token, else it is blocked
     (`return false`).

- **Cache management:** `CacheApi` methods (`clear`, `get`, `set`, `getAll`,
  `removeByPrefix`) are all whitelisted for unauthenticated access-note this is
  a significant security consideration: cache reads/writes are public.

---

## `env.d.ts`

[`src/env.d.ts`](src/env.d.ts)

**Purpose:** Ambient TypeScript declaration file that augments the Astro runtime
with project-specific global types. It bridges the server-side `App.Locals` and
the client-side `window` object with a shared [`AppProps`](src/models/app.ts)
contract.

**Key Concerns:**

- **Global type augmentation:**
  - [`App.Locals.APP_PROPS`](src/env.d.ts)-makes application-level props
    available in Astro server middleware/handlers via `Astro.locals`.
  - [`window.$APP_PROPS`](src/env.d.ts)-exposes the same props to
    client-side CSR code, enabling hydration without an extra network round-trip.

- **Astro type references:** Pulls in `.astro/types.d.ts` and `astro/client` for
  framework-level typing.

---

## `vite-env.d.ts`

[`src/vite-env.d.ts`](src/vite-env.d.ts)

**Purpose:** Ambient TypeScript declaration file that registers JSX intrinsic
element types for UIkit (Franken UI) web components, so they can be used as typed
JSX tags (e.g. `<uk-modal>`, `<uk-dropdown>`) in `.tsx` files without TypeScript
errors.

**Key Concerns:**

- **JSX namespace augmentation:** Declares an extensive set of `uk-*` intrinsic
  elements within the global `JSX.IntrinsicElements` interface, each typed as
  `React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>`. This
  is a compile-time-only concern with no runtime impact.

- **No architectural runtime significance:** This file exists solely to satisfy
  the TypeScript compiler for UIkit custom-element usage. It does not influence
  bundling, caching, environment decisions, or API behavior.
