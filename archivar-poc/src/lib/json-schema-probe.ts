/**
 * vLLM structured-output capability probe with a per-key cache.
 *
 * WHY: Not every endpoint/model supports every guided-JSON transport, and a
 * served model's chat template / reasoning parser affects support. Probing
 * once per (endpoint, model, thinkingEnabled) key avoids a round-trip per call
 * while respecting that capability is stable per deployment.
 *
 * Resolution semantics:
 *   - explicit mode ("response_format" | "structured_outputs" | "json_object" |
 *     "legacy_guided_json" | "none"): NO probe — the operator asserted the
 *     transport; on rejection the caller should fail fast
 *     (JsonSchemaUnsupportedError).
 *   - "auto": probe the transports in preference order and cache the first that
 *     returns a valid constrained JSON object. Falls back to "none".
 *
 * Cache key = `${endpoint}|${model}|${thinkingEnabled}`. A probe can be
 * disabled globally via ARCHIVAR_JSON_SCHEMA_PROBE=0 (explicit config still
 * honored).
 */

import { longFetch } from "./long-fetch.js";
import { recordTokenUsage } from "./token-usage-collector.js";
import type { TokenUsage } from "../rpc/mllm-api.js";

/**
 * The wire-level mechanism used to constrain a chat-completion to JSON.
 * - `response_format`: OpenAI-standard `response_format: { type: "json_schema" }`
 * - `structured_outputs`: vLLM extension (`structured_outputs: { json: schema }`)
 * - `json_object`: OpenAI `response_format: { type: "json_object" }` — valid JSON
 *   but WITHOUT schema enforcement (weaker guarantee, hence late in PROBE_ORDER)
 * - `legacy_guided_json`: pre-structured-outputs vLLM `guided_json` field
 * - `none`: no constraint attached; callers fall back to tolerant parsing
 *   (parseJsonLoose)
 */
export type JsonSchemaTransport =
  | "response_format"
  | "structured_outputs"
  | "json_object"
  | "legacy_guided_json"
  | "none";

/** Probe preference order for "auto" mode. */
const PROBE_ORDER: JsonSchemaTransport[] = [
  "response_format",
  "structured_outputs",
  "json_object",
  "legacy_guided_json",
];

// A confirmed-supported transport is stable per deployment → cache long. A
// "none" result is often a transient load artifact → retry sooner.
const CACHE_TTL_POSITIVE_MS = 60 * 60 * 1000; // 1 hour
const CACHE_TTL_NEGATIVE_MS = 2 * 60 * 1000; // 2 minutes

interface CacheEntry {
  transport: JsonSchemaTransport;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
// In-flight probes keyed by cache key, so concurrent callers share ONE probe
// instead of each firing its own (which caused false "none" under load).
const inFlight = new Map<string, Promise<JsonSchemaTransport>>();

/** Whether auto-probing is enabled (env: ARCHIVAR_JSON_SCHEMA_PROBE). Default on. */
function probingEnabled(): boolean {
  const flag = process.env.ARCHIVAR_JSON_SCHEMA_PROBE;
  return flag !== "0" && flag !== "false";
}

/** Build the cache key. Includes model + thinking because capability varies per served model. */
export function cacheKey(
  endpoint: string,
  model: string,
  thinkingEnabled: boolean,
): string {
  return `${endpoint}|${model}|${thinkingEnabled ? "think" : "nothink"}`;
}

/** Clear the capability cache + in-flight probes. Exposed for tests. */
export function clearTransportCache(): void {
  cache.clear();
  inFlight.clear();
}

/**
 * Probe a single transport against the endpoint and return whether it produced
 * a valid JSON object. Uses a trivially small request to minimize cost.
 *
 * IMPORTANT: the probe body must mirror the real call's chat_template_kwargs —
 * specifically `enable_thinking`. Reasoning-capable models (e.g. Qwen3.6) put
 * output into the `reasoning` field and leave `content` EMPTY when thinking is
 * on, which would otherwise look like "transport not supported" (false
 * negative). `thinkingEnabled` is threaded through so the probe is accurate.
 */
async function probeTransport(
  endpoint: string,
  model: string,
  transport: JsonSchemaTransport,
  apiKey?: string,
  thinkingEnabled?: boolean,
): Promise<boolean> {
  // Minimal schema the model can trivially satisfy; we only care whether the
  // server accepts the transport and returns constrained JSON in `content`.
  const schema = {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
    additionalProperties: false,
  };

  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: 'Reply with {"ok": true}.' }],
    max_tokens: 32,
    temperature: 0,
    chat_template_kwargs: {
      add_generation_prompt: true,
      enable_thinking: thinkingEnabled ?? false,
    },
  };

  if (transport === "response_format") {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "probe", strict: true, schema },
    };
  } else if (transport === "structured_outputs") {
    body.structured_outputs = { json: schema };
  } else if (transport === "json_object") {
    // json_object mode: constrain output to valid JSON without schema enforcement
    body.response_format = { type: "json_object" };
  } else {
    // legacy
    body.guided_json = schema;
  }

  const url = `${endpoint}/v1/chat/completions`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  // A single probe can be a false negative under server load (200 with empty
  // content because the model is busy / reasoning routing). Retry up to
  // PROBE_ATTEMPTS times before declaring a transport unsupported.
  const PROBE_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt++) {
    try {
      const res = await longFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        // Non-200 (typically 400) = the transport field is definitively
        // unsupported/unknown. No point retrying.
        return false;
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: TokenUsage;
      };
      // A probe response is a real billed call — attribute it to the current run.
      recordTokenUsage(data.usage);
      const content = data.choices?.[0]?.message?.content ?? "";
      // Accept any JSON object as evidence the transport constrained output.
      try {
        const parsed = JSON.parse(content.trim());
        if (typeof parsed === "object" && parsed !== null) return true;
      } catch {
        // empty/garbage content under load → ambiguous, retry.
      }
    } catch {
      // network/timeout → ambiguous, retry.
    }
  }
  return false;
}

/**
 * Resolve the transport to use. For "auto", probes once per cache key and
 * caches the result. Explicit transports are returned as-is (no probe).
 */
export async function resolveJsonSchemaTransport(
  endpoint: string,
  model: string,
  thinkingEnabled: boolean,
  /** Explicit mode from config; "auto" triggers probing. */
  requested: "auto" | JsonSchemaTransport,
  apiKey?: string,
): Promise<JsonSchemaTransport> {
  if (requested !== "auto") {
    return requested;
  }

  if (!probingEnabled()) {
    // Probing disabled: don't attach anything (operator must set explicit mode).
    return "none";
  }

  const key = cacheKey(endpoint, model, thinkingEnabled);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) {
    return hit.transport;
  }

  // In-flight dedup: if a probe for this key is already running, await it
  // instead of firing a competing one (competing probes caused false "none"
  // under concurrent load).
  const existing = inFlight.get(key);
  if (existing) return existing;

  const probePromise = (async (): Promise<JsonSchemaTransport> => {
    try {
      let resolved: JsonSchemaTransport = "none";
      for (const transport of PROBE_ORDER) {
        if (await probeTransport(endpoint, model, transport, apiKey, thinkingEnabled)) {
          resolved = transport;
          break;
        }
      }
      // Positive results are stable → long TTL; "none" is often transient → short.
      const ttl = resolved === "none" ? CACHE_TTL_NEGATIVE_MS : CACHE_TTL_POSITIVE_MS;
      cache.set(key, { transport: resolved, expiresAt: Date.now() + ttl });
      console.log(
        `[json-schema-probe] ${endpoint} model=${model} thinking=${thinkingEnabled} → ${resolved}`,
      );
      return resolved;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, probePromise);
  return probePromise;
}
