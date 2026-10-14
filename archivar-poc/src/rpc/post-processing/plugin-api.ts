/**
 * Plugin RPC composite API - builds the PluginRpcApiCompositeInstance facade
 * (contract: src/lib/plugin-types.ts:334) that the workflow engine hands to v3
 * post-processing plugin hooks (workflow-engine.ts:965).
 *
 * Two factories:
 * - buildPluginRpcCompositeApiInstance: server-side, wired to the real APIs.
 * - buildClientPluginRpcCompositeApiInstance: client-side, for tests/tools;
 *   only file.* is actually wired to RPC, the rest are stubs (see below).
 */

import { MllmApi } from "../mllm-api";
import { CacheApi } from "../cache-api";
import { FileApi } from "../file-api";
import { AnalyseApi } from "../analyse-api";
import type { PluginRpcApiCompositeInstance, FileInfo, MediaSegmentType, TableName } from "../../lib/types";
import type * as yup from "yup";
import { parseJsonLoose as parseJsonLooseShared } from "../../lib/parse-json.js";
import { yupToJsonSchema } from "../../lib/yup-json-schema/index.js";
import { UnsupportedYupNodeError, TruncatedStructuredOutputError } from "../../lib/errors.js";
import { hasAtypicalSymbols } from "../../lib/text-degeneration.js";
import { stripSingletonMarkersDeep } from "../../lib/prompt-dedupe.js";
import type { JsonSchemaMode, RawCallResult } from "../mllm-api.js";
import type { RepetitionDetectionConfig } from "../../lib/workflow-types.js";
import { STRUCTURED_OUTPUT_DEFAULTS } from "../../lib/structured-output-defaults.js";
import { resolveStartMaxTokens, resolveMaxInferenceContext, resolveEstimation } from "../../lib/archivar-config.js";
import { requestPhaseCapture } from "../../lib/vlm-request-collector.js";
import { budgetCapForModel, MIN_OUTPUT_TOKENS } from "../../lib/input-estimation.js";

/** vLLM context-overflow 400 formats (0.25): output-alone-over-window and
 *  input+output-over-window variants. */
const CONTEXT_OVERFLOW_RE = /maximum context length is \d+ tokens|max_tokens=\d+ cannot be greater than max_model_len/;
import { recordNonFatalError } from "../../lib/non-fatal-error-collector.js";

/** Central default for structured-output retries (from structured-output-defaults.ts). */
const DEFAULT_MAX_RETRIES = STRUCTURED_OUTPUT_DEFAULTS.maxRetries;

/**
 * Formats a yup ValidationError into concise, field-level bullet points the model
 * can act on. Exists so retry correction prompts give the model exact, actionable
 * feedback (path + message) instead of a single opaque error string.
 */
function formatYupError(err: unknown): string {
  const e = err as { inner?: Array<{ path?: string | null; message?: string }>; errors?: string[]; message?: string };
  const inner = e?.inner;
  if (Array.isArray(inner) && inner.length > 0) {
    return inner
      .map((i) => `- ${i.path ? `${i.path}: ` : ""}${i.message ?? "invalid"}`)
      .join("\n");
  }
  if (Array.isArray(e?.errors) && e.errors.length > 0) {
    return e.errors.map((m) => `- ${m}`).join("\n");
  }
  return `- ${e?.message ?? "Validation failed"}`;
}

/**
 * Builds the augmented prompt fed to the model on a retry: quotes the model's
 * previous (invalid) answer, lists the exact validation errors, and asks for a
 * corrected, schema-valid JSON answer. Kept in German to match existing prompts.
 */
function buildCorrectionPrompt(originalPrompt: string, previousRaw: string, errorText: string): string {
  return `${originalPrompt}

Deine vorherige Antwort war ungueltig und wurde abgelehnt.

Vorherige Antwort:
${previousRaw.trim() || "(leer)"}

Validierungsfehler:
${errorText}

Bitte korrigiere DEINE Antwort so, dass sie das geforderte Schema erfuellt, und gib NUR gueltiges JSON zurueck.`;
}

/**
 * Prepended to the prompt for the ONE degeneration retry: a response that
 * slid into non-latin symbol soup (see hasAtypicalSymbols) gets a single
 * extra attempt with this language note — outside the schema-retry budget.
 */
const ATYPICAL_SYMBOLS_RETRY_PREFIX =
  "Last time the output wasn't in the primary language and contained non-standard Unicode chars. " +
  "This time, the response should not mix languages.\n\n";

/**
 * Creates a PluginApi instance that v3 plugins can use to interact with the system.
 * Wires up file operations, cache, analysis, and MLLM calls.
 *
 * Called by the workflow engine once per plugin run (workflow-engine.ts:965);
 * the default parameters deliberately create fresh API instances per call so
 * plugins share no state beyond the on-disk caches.
 */
export function buildPluginRpcCompositeApiInstance(
  mllmApi: MllmApi = new MllmApi(),
  cacheApi: CacheApi = new CacheApi(),
  fileApi: FileApi = new FileApi(),
  analyseApi: AnalyseApi = new AnalyseApi(),
): PluginRpcApiCompositeInstance {
  return {
    file: {
      /** Get media information for a file path */
      async getMediaInfo(filePath: string): Promise<FileInfo | null> {
        try {
          const files = await fileApi.listFiles(filePath);
          return files[0] ?? null;
        } catch (error) {
          console.error(`[PluginApi] Failed to get media info for ${filePath}:`, error);
          return null;
        }
      },

      /** List files matching a glob pattern */
      async listFiles(pattern?: string): Promise<FileInfo[]> {
        return fileApi.listFiles(pattern ?? "*");
      },

      /** Read file content as string */
      async readFile(relativePath: string): Promise<string> {
        return fileApi.readFile(relativePath);
      },
    },

    cache: {
      /** Get value from cache table */
      async get<T>(table: TableName, key: string, defaultValue: T): Promise<T> {
        return cacheApi.get<T>(table, key, defaultValue);
      },

      /** Set value in cache table */
      async set<T>(table: TableName, key: string, value: T): Promise<void> {
        return cacheApi.set(table, key, value);
      },
    },

    analysis: {
      /** Get analysis defaults for a file and media type */
      async getAnalysisResults(filePath: string, analysisType?: MediaSegmentType): Promise<unknown> {
        if (!analysisType) {
          return analyseApi.getAllAnalysisDefaults(filePath);
        }
        return analyseApi.getAnalysisDefaults(filePath, analysisType);
      },

      /** Analyze a segment with specified model and prompt */
      async analyzeSegment(args: {
        filePath: string;
        mediaType: MediaSegmentType;
        modelName: string;
        prompt: string;
        systemPrompt?: string;
        enableThinking?: boolean;
      }): Promise<string> {
        return analyseApi.analyzeSegment(
          args.filePath,
          args.mediaType,
          args.modelName,
          args.prompt,
          args.systemPrompt,
        );
      },
    },

    mllm: {
      // REFACTOR(dry): the callRaw/callJson arg shapes are declared three times —
      // the interface (src/lib/plugin-types.ts:371 and :400) plus both factories
      // in this file (server here, client below) — extract named
      // CallRawArgs/CallJsonArgs types into plugin-types.ts; the impls could then
      // drop their annotations (contextual typing from the return type).
      /** Call MLLM and receive raw string response (no JSON normalization) */
      async callRaw(args: {
        endpoint: string;
        model: string;
        apiKey?: string;
        filePaths: string[];
        mediaCategory: "audio" | "video" | "image";
        prompt: string;
        systemPrompt?: string;
        hyperparams?: Record<string, unknown>;
        enableThinking?: boolean;
        mmProcessorKwargs?: Record<string, unknown>;
        /** Optional JSON Schema + mode to enable native guided decoding. */
        jsonSchema?: Record<string, unknown>;
        jsonSchemaMode?: JsonSchemaMode;
        /** Structured-output overrides from ModelConfig.structuredOutput. */
        structuredMaxTokens?: number;
        structuredTemperature?: number;
        structuredFrequencyPenalty?: number;
        structuredRepetitionPenalty?: number;
        /** Name for response_format.json_schema.name (response_format transport only). */
        jsonSchemaName?: string;
        /** Resolved vLLM repetition_detection (from model config; omitted when undefined). */
        repetitionDetection?: RepetitionDetectionConfig;
      }): Promise<RawCallResult> {
        return mllmApi.callWithPromptRaw(
          args.endpoint,
          args.model,
          args.apiKey,
          args.filePaths,
          args.prompt,
          args.mediaCategory,
          args.hyperparams,
          args.systemPrompt,
          args.enableThinking,
          args.mmProcessorKwargs,
          args.jsonSchema,
          args.jsonSchemaMode,
          args.structuredMaxTokens,
          args.structuredTemperature,
          args.structuredFrequencyPenalty,
          args.structuredRepetitionPenalty,
          args.jsonSchemaName,
          args.repetitionDetection,
        );
      },

      /**
       * Call MLLM, parse JSON, validate against yup schema.
       *
       * Native JSON-schema mode: when `jsonSchemaMode` is set, the Yup schema is
       * converted to JSON Schema (once, before the retry loop) and attached to the
       * request so vLLM constrains decoding. On an unsupported Yup node (e.g.
       * `mixed()`), under "auto" it degrades to prompt-only (warns); under an
       * explicit mode it fails fast.
       *
       * The Yup validation + retry loop is RETAINED as a safety net — native mode
       * makes retries rare but not impossible (server misconfig, backend swap).
       * Truncated structured output (finish_reason "length") bumps max_tokens and
       * retries within the same budget instead of running the loose parser.
       */
      async callJson<T>(args: {
        endpoint: string;
        model: string;
        apiKey?: string;
        filePaths: string[];
        mediaCategory: "audio" | "video" | "image";
        prompt: string;
        systemPrompt?: string;
        schema: yup.Schema<T>;
        hyperparams?: Record<string, unknown>;
        enableThinking?: boolean;
        maxRetries?: number;
        mmProcessorKwargs?: Record<string, unknown>;
        /** Native guided-decoding mode. "auto" probes; explicit modes fail fast; off = prompt-only. */
        jsonSchemaMode?: JsonSchemaMode;
        structuredMaxTokens?: number;
        structuredTemperature?: number;
        structuredFrequencyPenalty?: number;
        structuredRepetitionPenalty?: number;
        /** Name for response_format.json_schema.name (response_format transport only). */
        jsonSchemaName?: string;
        /** Resolved vLLM repetition_detection (from model config; omitted when undefined). */
        repetitionDetection?: RepetitionDetectionConfig;
      }): Promise<T> {
        const maxRetries = args.maxRetries ?? DEFAULT_MAX_RETRIES;
        // Default ON: an unset jsonSchemaMode resolves to "auto", which probes
        // the backend and degrades gracefully to prompt-only if no structured-
        // output transport is available. Pass `false` to explicitly disable.
        const mode: JsonSchemaMode = args.jsonSchemaMode ?? "auto";

        // Convert Yup → JSON Schema once. Unsupported nodes degrade (auto) or
        // fail fast (explicit). This never affects the Yup safety net below.
        let jsonSchema: Record<string, unknown> | undefined;
        if (mode !== false) {
          try {
            jsonSchema = yupToJsonSchema(
              args.schema as unknown as Parameters<typeof yupToJsonSchema>[0],
              { strict: true },
            ) as unknown as Record<string, unknown>;
          } catch (err) {
            if (err instanceof UnsupportedYupNodeError) {
              if (mode === "auto") {
                console.warn(`[callJson] schema uses unsupported node (${err.nodeType}); degrading to prompt-only mode`);
              } else {
                throw err; // explicit mode → fail fast
              }
            } else {
              throw err;
            }
          }
        }

        let previousRaw = "";
        let lastErrorText = "";
        // One-shot degeneration retry: non-latin symbol soup triggers a single
        // extra attempt with ATYPICAL_SYMBOLS_RETRY_PREFIX prepended, outside
        // the schema-retry budget (the attempt number is replayed).
        let degenerationRetried = false;
        let languagePrefix = "";
        // max_tokens may be bumped on truncation; copy so the original args are untouched.
        let effectiveHyperparams = args.hyperparams;
        // The structured cap must be bumped alongside max_tokens: applyStructuredSampling
        // re-caps every attempt via Math.min(max_tokens, structuredMaxTokens), so an
        // unbumped cap would silently neutralize the truncation retry's budget.
        // Start window: per-request-type ModelConfig.contextWindows resolved from the
        // active requestPhaseCapture stage (aggregation/hoa/summary). The typeof
        // guard keeps test mocks of archivar-config (which omit the export) on the
        // plugin-passed fallback — production always has the full module.
        let effectiveStructuredMaxTokens =
          (typeof resolveStartMaxTokens === "function"
            ? resolveStartMaxTokens(args.model, requestPhaseCapture.getStore())
            : undefined) ?? args.structuredMaxTokens;
        // Bounded context-overflow halving counter (reactive fallback, see catch).
        let contextHalvings = 0;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          // Attempt 0 uses the original prompt; retries use a correction prompt that
          // surfaces the prior bad answer and the exact validation errors.
          const prompt = attempt === 0
            ? languagePrefix + args.prompt
            : buildCorrectionPrompt(languagePrefix + args.prompt, previousRaw, lastErrorText);

          // Pre-flight context budget for THIS attempt (correction prompts grow,
          // so re-estimate): never ask for more than fits beside the estimated
          // input — cheap word/frame counting instead of an extra tokenize call.
          // Media tokens only count when media is actually attached.
          const attemptCap = budgetCapForModel(
            resolveMaxInferenceContext(args.model),
            resolveEstimation(args.model),
            prompt,
            args.systemPrompt,
            args.filePaths.length > 0 ? args.mediaCategory : "audio",
            args.mmProcessorKwargs as Record<string, unknown> | undefined,
          );
          const attemptHyperparams = {
            ...effectiveHyperparams,
            max_tokens: Math.min((effectiveHyperparams?.max_tokens as number) ?? attemptCap, attemptCap),
          };
          const attemptStructuredMaxTokens = Math.min(effectiveStructuredMaxTokens ?? attemptCap, attemptCap);

          let raw: string;
          try {
            raw = (await mllmApi.callWithPromptRaw(
              args.endpoint,
              args.model,
              args.apiKey,
              args.filePaths,
              prompt,
              args.mediaCategory,
              attemptHyperparams,
              args.systemPrompt,
              args.enableThinking,
              args.mmProcessorKwargs,
              jsonSchema,
              mode,
              attemptStructuredMaxTokens,
              args.structuredTemperature,
              args.structuredFrequencyPenalty,
              args.structuredRepetitionPenalty,
              args.jsonSchemaName,
              args.repetitionDetection,
              // contextClampAttempt / encoderCacheAttempt: internal, start unset
              undefined,
              undefined,
              // nth schema retry: relax repetition_detection progressively so a
              // same-seed retry escapes detector truncation (see
              // relaxRepetitionDetection in mllm-api).
              attempt,
            )).content;
          } catch (err) {
            // Truncated structured output: double max_tokens and retry within the
            // shared retry budget, capped at the model's resolved ceiling
            // (contextWindows.maxInferenceContext per model/top-level, default 64k;
            // server-side feasibility below it is the context clamp's concern).
            // The doubling compounds across truncation retries and MUST start
            // from the budget that was actually sent (the error carries it) —
            // reading effectiveHyperparams.max_tokens instead restarts at the
            // 16k default whenever hyperparams omit max_tokens, making the
            // first bump a no-op against a 32k start window (burned retry).
            if (err instanceof TruncatedStructuredOutputError && attempt < maxRetries) {
              const baseMax = err.maxTokens
                ?? (effectiveHyperparams?.max_tokens as number)
                ?? effectiveStructuredMaxTokens
                ?? STRUCTURED_OUTPUT_DEFAULTS.maxTokens;
              const bumped = Math.min(baseMax * 2, resolveMaxInferenceContext(args.model));
              effectiveHyperparams = { ...effectiveHyperparams, max_tokens: bumped };
              effectiveStructuredMaxTokens = bumped;
              console.warn(`[callJson] retry ${attempt + 1}/${maxRetries}: truncated at max_tokens=${baseMax}; retrying with ${bumped}`);
              recordNonFatalError(err, args.model);
              continue;
            }
            // Context overflow despite the per-attempt estimate: halve the output
            // budget and retry (bounded) — prompt content is never cut.
            if (err instanceof Error && CONTEXT_OVERFLOW_RE.test(err.message) && contextHalvings < 2) {
              contextHalvings++;
              const halvedHyper = Math.max(MIN_OUTPUT_TOKENS, Math.floor(((effectiveHyperparams?.max_tokens as number) ?? STRUCTURED_OUTPUT_DEFAULTS.maxTokens) / 2));
              const halvedStructured = Math.max(MIN_OUTPUT_TOKENS, Math.floor((effectiveStructuredMaxTokens ?? halvedHyper) / 2));
              effectiveHyperparams = { ...effectiveHyperparams, max_tokens: halvedHyper };
              effectiveStructuredMaxTokens = halvedStructured;
              console.warn(`[callJson] retry ${attempt + 1}/${maxRetries}: context overflow — halving budgets to ${halvedHyper}/${halvedStructured}`);
              recordNonFatalError(err, args.model);
              continue;
            }
            throw err;
          }

          // Degeneration guard (one-shot): a response that slid into non-latin
          // symbol soup gets ONE extra attempt with the language note prepended.
          // The attempt number is replayed so this never burns schema-retry
          // budget; a still-atypical second response passes through to the
          // normal parse/validation path.
          if (!degenerationRetried && hasAtypicalSymbols(raw)) {
            degenerationRetried = true;
            languagePrefix = ATYPICAL_SYMBOLS_RETRY_PREFIX;
            console.warn(`[callJson] atypical (non-latin) symbols in response — retrying once with language note prepended`);
            attempt--;
            continue;
          }

          // Strip model-imitated " (x1)" singleton markers (dedupePromptText
          // only emits x≥2) from the parsed result — deep, because compact
          // JSON hides value line breaks behind escaped "\n" on the wire.
          const parsed = stripSingletonMarkersDeep(parseJsonLoose(raw));
          if (!parsed) {
            previousRaw = raw;
            lastErrorText = "- Die Antwort konnte nicht als JSON gelesen werden. Gib NUR gueltiges JSON zurueck.";
            if (attempt < maxRetries) {
              console.warn(`[callJson] retry ${attempt + 1}/${maxRetries}: JSON parse failed`);
              recordNonFatalError(
                new Error("MLLM response could not be parsed as JSON"),
                args.model,
                { responseBody: raw.slice(0, 4000) },
              );
              continue;
            }
            // No parseable JSON at all after all retries — there is genuinely no
            // structured data to degrade to. Record the final failure as a soft
            // error (operator visibility) before throwing so the run's
            // nonFatalErrors still reflects it. The last raw response is attached
            // as wire.responseBody so errors.json alone suffices for diagnosis.
            recordNonFatalError(
              new Error("MLLM response could not be parsed as JSON (retries exhausted)"),
              args.model,
              { responseBody: raw.slice(0, 4000) },
            );
            throw new Error("MLLM response could not be parsed as JSON");
          }

          try {
            const validated = await args.schema.validate(parsed, { abortEarly: false, stripUnknown: true });
            return validated as T;
          } catch (error) {
            previousRaw = raw;
            lastErrorText = formatYupError(error);
            // For json_object mode, allow ONE correction retry. The model produces valid
            // JSON but may not match the schema exactly. With reasonable sampling params
            // (temp=0.7, top_p=0.9, top_k=20), a single correction prompt showing the
            // validation error often fixes minor mismatches. Skip further retries to avoid
            // garbage feedback loops.
            if (mode === "json_object") {
              if (attempt === 0) {
                console.warn(`[callJson] json_object mode: schema validation failed, retrying once with correction prompt\n${lastErrorText}`);
                recordNonFatalError(error, args.model, { responseBody: raw.slice(0, 4000) });
                continue; // retry once
              }
              // Exhausted json_object correction: DEGRADE to the best-effort parsed
              // result instead of throwing fatally. The model produced valid JSON
              // that doesn't fully match the schema — the partial match is still its
              // best answer for this slice. The non-conformance is recorded as a soft
              // error (nonFatalErrors) so the operator sees it; the run stays alive.
              console.warn(`[callJson] json_object mode: schema validation failed after correction; returning degraded result\n${lastErrorText}`);
              recordNonFatalError(
                new Error(`Schema validation exhausted (json_object mode): ${lastErrorText.replace(/\n/g, ", ")}`),
                args.model,
                { responseBody: raw.slice(0, 4000) },
              );
              return parsed as unknown as T;
            }
            if (attempt < maxRetries) {
              console.warn(`[callJson] retry ${attempt + 1}/${maxRetries}: validation failed\n${lastErrorText}`);
              recordNonFatalError(error, args.model, { responseBody: raw.slice(0, 4000) });
              continue;
            }
            // Exhausted all retries: DEGRADE to the best-effort parsed result
            // instead of throwing fatally. The model produced JSON that doesn't
            // fully conform; the partial match is still its best answer for this
            // slice. Recording the non-conformance as a soft error keeps the run
            // alive and visible in nonFatalErrors — callers that need strict
            // conformance can re-validate the returned object.
            console.warn(`[callJson] schema validation failed after ${maxRetries + 1} attempts; returning degraded result\n${lastErrorText}`);
            recordNonFatalError(
              new Error(`Schema validation exhausted: ${lastErrorText.replace(/\n/g, ", ")}`),
              args.model,
              { responseBody: raw.slice(0, 4000) },
            );
            return parsed as unknown as T;
          }
        }

        // Unreachable (loop always returns or throws); keeps the type checker happy.
        throw new Error(`MLLM response validation failed: ${lastErrorText}`);
      },
    },

    util: {
      /** Parse JSON loosely (handles markdown code blocks, etc.) */
      parseJsonLoose(content: string): unknown {
        return parseJsonLoose(content);
      },

      /** Format seconds to HH:MM:SS string */
      formatTime(seconds: number): string {
        const hrs = Math.floor(seconds / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);
        return `${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
      },

      /** Run async operations with concurrency limit */
      async limitConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
        const results: R[] = new Array(items.length);
        let currentIndex = 0;

        async function worker(): Promise<void> {
          while (currentIndex < items.length) {
            const index = currentIndex++;
            results[index] = await fn(items[index], index);
          }
        }

        const workers = [];
        for (let i = 0; i < Math.min(limit, items.length); i++) {
          workers.push(worker());
        }

        await Promise.all(workers);
        return results;
      },

      /** Logger instance */
      logger: {
        log: console.log.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console),
      },
    },
  };
}

/**
 * Parses JSON loosely, handling markdown code blocks and other common formats.
 * Used by v3 plugins to parse MLLM responses.
 *
 * Delegates to the shared consolidated extractor (`src/lib/parse-json.ts`) so
 * all JSON-parsing paths in Archivar use identical fallback logic. Re-exported
 * here to preserve the existing public plugin-api surface.
 */
export function parseJsonLoose(content: string): unknown {
  return parseJsonLooseShared(content);
}

/**
 * Client-side factory that creates a PluginRpcApiCompositeInstance which makes
 * real RPC calls to a running Archivar server (via HTTP/RPC endpoint).
 *
 * This allows tests and client-side code to interact with the server's APIs
 * through the same interface that plugins use on the server side.
 *
 * Only file.* is wired to real RPC calls; cache/analysis/mllm are stubs (see
 * the REFACTOR tag there) and util.* is reimplemented locally.
 *
 * @param rpcCall - A function that takes (className, methodName, args) and returns a Promise with the RPC result
 * @param serverUrl - The base URL of the Archivar server (e.g., "http://localhost:8801")
 * @param apiKey - The API key for authentication
 */
export function buildClientPluginRpcCompositeApiInstance(
  rpcCall: (className: string, methodName: string, args: unknown[]) => Promise<unknown>,
  serverUrl?: string,
  apiKey?: string,
): PluginRpcApiCompositeInstance {
  // Default timeout for RPC calls (10 minutes for long-running operations like full pipeline)
  const DEFAULT_TIMEOUT = 600_000;

  /**
   * Internal RPC call wrapper that adds auth headers and timeout handling.
   */
  async function clientRpcCall(className: string, methodName: string, args: unknown[]): Promise<unknown> {
    const url = `${serverUrl ?? "http://localhost:8801"}/rpc`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      // REFACTOR(dry): the dev-key literal is copy-pasted across the codebase
      // (src/cli.ts:29, src/pages/api/analyze.ts:46 and the other api routes) —
      // one shared DEFAULT_API_KEY constant would do.
      "x-api-key": apiKey ?? "your-api-key",
    };
    const body = JSON.stringify({ className, methodName, args });
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`RPC ${className}.${methodName} failed: ${res.status} ${res.statusText}\n${text}`);
    }
    const text = await res.text();
    // Try to parse as JSON first, fall back to raw string
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  return {
    file: {
      /** Get media information for a file path */
      // REFACTOR(consistency): this method calls clientRpcCall directly, silently
      // ignoring an injected rpcCall transport that listFiles/readFile below
      // honor — route all three through the same function.
      async getMediaInfo(filePath: string): Promise<FileInfo | null> {
        try {
          const files = await clientRpcCall("FileApi", "listFiles", [filePath]) as FileInfo[];
          return files[0] ?? null;
        } catch (error) {
          console.error(`[ClientPluginApi] Failed to get media info for ${filePath}:`, error);
          return null;
        }
      },

      /** List files matching a glob pattern */
      // REFACTOR(kiss): (rpcCall === clientRpcCall ? clientRpcCall : rpcCall)
      // always evaluates to rpcCall — call it directly (same at readFile below).
      async listFiles(pattern?: string): Promise<FileInfo[]> {
        return (await (rpcCall === clientRpcCall ? clientRpcCall : rpcCall)("FileApi", "listFiles", [pattern ?? "*"])) as FileInfo[];
      },

      /** Read file content as string */
      async readFile(relativePath: string): Promise<string> {
        return (await (rpcCall === clientRpcCall ? clientRpcCall : rpcCall)("FileApi", "readFile", [relativePath])) as string;
      },
    },

    cache: {
      // REFACTOR(consistency): cache/analysis/mllm in this client factory are
      // silent stubs returning defaults (null, "", {} as T) behind the same
      // interface the server factory fully implements — callers cannot
      // distinguish "no data" from "not wired". Throw, or narrow the client
      // factory's return type to what it actually supports.
      /** Get value from cache table */
      async get<T>(_table: string, _key: string, defaultValue: T): Promise<T> {
        // Cache operations via RPC not directly exposed - return default
        return defaultValue;
      },

      /** Set value in cache table */
      async set<T>(_table: string, _key: string, _value: T): Promise<void> {
        // Cache operations via RPC not directly exposed - no-op
      },
    },

    analysis: {
      /** Get analysis results for a file */
      async getAnalysisResults(_filePath: string, _analysisType?: MediaSegmentType): Promise<unknown> {
        // Analysis operations via RPC not directly exposed
        return null;
      },

      /** Analyze a segment with specified model and prompt */
      async analyzeSegment(_args: {
        filePath: string;
        mediaType: MediaSegmentType;
        modelName: string;
        prompt: string;
        systemPrompt?: string;
        enableThinking?: boolean;
      }): Promise<string> {
        // Analysis operations via RPC not directly exposed
        return "";
      },
    },

    mllm: {
      /** Call MLLM and receive the raw model response + backend token `usage`.
       *  Client stub: MLLM operations are not directly RPC-exposed on the client. */
      async callRaw(_args: {
        endpoint: string;
        model: string;
        apiKey?: string;
        filePaths: string[];
        mediaCategory: "audio" | "video" | "image";
        prompt: string;
        systemPrompt?: string;
        hyperparams?: Record<string, unknown>;
        enableThinking?: boolean;
        mmProcessorKwargs?: Record<string, unknown>;
        jsonSchema?: Record<string, unknown>;
        jsonSchemaMode?: JsonSchemaMode;
        structuredMaxTokens?: number;
        structuredTemperature?: number;
        structuredFrequencyPenalty?: number;
        structuredRepetitionPenalty?: number;
        jsonSchemaName?: string;
        repetitionDetection?: RepetitionDetectionConfig;
      }): Promise<RawCallResult> {
        // MLLM operations via RPC not directly exposed
        return { content: "" };
      },

      /** Call MLLM and parse JSON response */
      async callJson<T>(_args: {
        endpoint: string;
        model: string;
        apiKey?: string;
        filePaths: string[];
        mediaCategory: "audio" | "video" | "image";
        prompt: string;
        systemPrompt?: string;
        schema: unknown;
        hyperparams?: Record<string, unknown>;
        enableThinking?: boolean;
        maxRetries?: number;
        mmProcessorKwargs?: Record<string, unknown>;
        jsonSchemaMode?: JsonSchemaMode;
        structuredMaxTokens?: number;
        structuredTemperature?: number;
        structuredFrequencyPenalty?: number;
        structuredRepetitionPenalty?: number;
        jsonSchemaName?: string;
        repetitionDetection?: RepetitionDetectionConfig;
      }): Promise<T> {
        // MLLM operations via RPC not directly exposed
        return {} as T;
      },
    },

    util: {
      // REFACTOR(dry): parseJsonLoose/formatTime/limitConcurrency here are local
      // re-implementations of the server factory's util above, and
      // workflow-engine.ts:248 carries a third limitConcurrency copy — hoist one
      // shared helper module for all three.
      /** Strict JSON.parse only (null on failure) — unlike the server factory. */
      // REFACTOR(consistency): the interface promises loose parsing
      // (src/lib/plugin-types.ts:426) and the server factory delegates to
      // src/lib/parse-json.ts, but this client version handles no code fences —
      // delegate to the shared parser here too.
      parseJsonLoose(content: string): unknown {
        try {
          return JSON.parse(content);
        } catch {
          return null;
        }
      },

      /** Format seconds to HH:MM:SS string */
      formatTime(seconds: number): string {
        const hrs = Math.floor(seconds / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);
        return `${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
      },

      /** Run async operations with concurrency limit */
      async limitConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
        const results: R[] = new Array(items.length);
        let currentIndex = 0;

        async function worker(): Promise<void> {
          while (currentIndex < items.length) {
            const index = currentIndex++;
            results[index] = await fn(items[index], index);
          }
        }

        const workers = [];
        for (let i = 0; i < Math.min(limit, items.length); i++) {
          workers.push(worker());
        }

        await Promise.all(workers);
        return results;
      },

      /** Logger instance */
      logger: {
        log: console.log.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console),
      },
    },
  };
}
