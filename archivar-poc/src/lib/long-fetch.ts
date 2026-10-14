/**
 * WHY this file exists:
 * Node's global `fetch` is backed by undici, whose default dispatcher enforces a hard
 * `headersTimeout` and `bodyTimeout` of 300_000ms (5 min). These internal limits are NOT
 * overridden by `AbortSignal.timeout(...)` and throw "Headers Timeout Error"
 * (`UND_ERR_HEADERS_TIMEOUT`), prematurely aborting legitimately long RPC (analyze
 * workflow) and MLLM (video captioning) calls that take many minutes.
 *
 * `longFetch` routes a request through an explicit undici Agent with those limits raised,
 * so the only remaining per-request ceiling is the explicit `AbortSignal.timeout` each
 * caller already passes. When undici is unavailable (e.g. a non-Node runtime or a test
 * shim), it transparently falls back to the global fetch — the explicit AbortSignal cap
 * still applies there.
 */

/** 12h — matches the explicit AbortSignal caps already used across the codebase. */
const LONG_TIMEOUT_MS = 43_200_000;
/** Sane ceiling for establishing the TCP/TLS connection. */
const CONNECT_TIMEOUT_MS = 60_000;

type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

/** Minimal structural shape of the parts of the undici module we use. */
interface UndiciModule {
  fetch: (input: string | URL, init?: Record<string, unknown>) => Promise<Response>;
  Agent: new (opts: Record<string, unknown>) => unknown;
}

let undiciPromise: Promise<UndiciModule | null> | null = null;
// undefined = not yet resolved; null = resolved-but-unavailable; object = the Agent.
let longAgent: unknown | null | undefined;

/** Lazily loads undici (Node-only). Returns null when unavailable so callers can fall back. */
function loadUndici(): Promise<UndiciModule | null> {
  // Only Node ships undici; skip gracefully in browsers/workers/test shims.
  if (typeof process === "undefined" || !process.versions?.node) {
    return Promise.resolve(null);
  }
  if (!undiciPromise) {
    undiciPromise = import("undici")
      .then((mod) => mod as unknown as UndiciModule)
      .catch((err) => {
        console.warn(
          "[long-fetch] undici unavailable, falling back to global fetch:",
          (err as Error).message,
        );
        return null;
      });
  }
  return undiciPromise;
}

/** Resolves (and caches) a long-lived undici Agent, or null if undici is unavailable. */
async function getLongAgent(): Promise<unknown | null> {
  if (longAgent !== undefined) return longAgent;
  const mod = await loadUndici();
  longAgent = mod
    ? new mod.Agent({
        headersTimeout: LONG_TIMEOUT_MS,
        bodyTimeout: LONG_TIMEOUT_MS,
        connectTimeout: CONNECT_TIMEOUT_MS,
      })
    : null;
  return longAgent;
}

/**
 * WHY: fetch wrapper for requests that may legitimately run for many minutes
 * (RPC analyze, MLLM captioning). It raises Node/undici's default 5-min
 * headers/body timeouts so only the caller's `AbortSignal.timeout` caps the request.
 *
 * @param input  Target URL.
 * @param init   Standard fetch init (e.g. method, headers, body, signal).
 * @returns      A Response, structurally compatible with the global `Response`.
 */
export async function longFetch(input: string | URL, init: FetchInit = {}): Promise<Response> {
  const mod = await loadUndici();
  if (mod) {
    const dispatcher = await getLongAgent();
    const res = await mod.fetch(input, { ...init, dispatcher });
    return res as Response;
  }
  return fetch(input, init);
}
