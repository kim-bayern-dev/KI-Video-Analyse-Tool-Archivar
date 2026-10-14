import { getEnv } from 'defuss-env';
import { getModel, getArchivarConfig, resolveWorkflowModels, getStructuredRepetitionDetection, resolveMaxInferenceContext, resolveEstimation, resolveStructuredExtras } from '../lib/archivar-config.js';
import { toSampleDataContainerPath } from '../lib/sample-data-path.js';
import { budgetCapForModel, MIN_OUTPUT_TOKENS } from '../lib/input-estimation.js';
import type { RepetitionDetectionConfig } from '../lib/workflow-types.js';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join as pathJoin, basename, extname } from 'node:path';
import sharp from 'sharp';
import { longFetch } from '../lib/long-fetch.js';
import { parseJsonLoose } from '../lib/parse-json.js';
import {
  JsonSchemaUnsupportedError,
  TruncatedStructuredOutputError,
} from '../lib/errors.js';
import {
  resolveJsonSchemaTransport,
  type JsonSchemaTransport,
} from '../lib/json-schema-probe.js';
import { buildEndpointUrl } from '../lib/asr-url.js';
import { recordTokenUsage } from '../lib/token-usage-collector.js';
import { recordNonFatalError } from '../lib/non-fatal-error-collector.js';
import type { WireContext } from '../lib/non-fatal-error-collector.js';
import { recordVlmRequest } from '../lib/vlm-request-collector.js';
import { recordAsrRequest } from '../lib/asr-request-collector.js';

// ---------------------------------------------------------------------------
// Per-LLM-call observability + fail-fast timeout.
//
// WHY: previously every LLM call used AbortSignal.timeout(43_200_000) (~12 h),
// so a single hung model endpoint stalled the whole pipeline for hours with no
// signal. These helpers (1) cap each call at a sane per-model timeout and
// (2) log each call's completion (HTTP status + duration) so a hung call is
// immediately visible in debug.log — a start log with no matching completion.
// ---------------------------------------------------------------------------

/** Sane default per-LLM-call timeout (20 min). Fits long video captions while
 *  failing fast on truly hung endpoints. Override per model via ModelConfig.requestTimeoutMs. */
const DEFAULT_LLM_REQUEST_TIMEOUT_MS = 1_200_000;

/**
 * Mild anti-repetition defaults for free-form captioning (video/image/audio).
 * WHY: with a large max_tokens a model can enter a repetition loop and generate
 * for many minutes (≈ the per-call timeout). These break loops without noticeably
 * distorting short descriptions. Overridable via hyperparams.repetition_penalty /
 * hyperparams.frequency_penalty. (Not applied to structured/guided-JSON calls,
 * where applyStructuredSampling zeroes penalties to avoid logit-processor conflicts.)
 */
const CAPTION_REPETITION_PENALTY = 1.05;
const CAPTION_FREQUENCY_PENALTY = 0.1;

/** Default sampling seed for reproducible VLM outputs. Overridable per model via
 *  `hyperparams.seed` in the archivar config (the value propagates to every VLM
 *  request). The magic literal `42` previously hardcoded in captionVideos/captionImage
 *  is centralized here. */
const DEFAULT_SEED = 42;

// REFACTOR(magic): max_tokens is a divergent magic literal per entry point — 8192 in captionAudios (:415), 120000 in captionVideos (:534) and captionImage (:642), 122000 in callWithPrompt/callWithPromptRaw (:989/:1185). These all express the same "large generation budget" concept; centralize as named constants next to the caption penalties above.

/**
 * Resolve the per-call timeout for a model: ModelConfig.requestTimeoutMs if set,
 * else the default. getModel() may throw for ad-hoc endpoints — fall back to default.
 */
function resolveRequestTimeoutMs(modelName?: string): number {
  if (modelName) {
    try {
      const cfg = getModel(modelName);
      if (cfg.requestTimeoutMs && cfg.requestTimeoutMs > 0) return cfg.requestTimeoutMs;
    } catch {
      /* model not registered (ad-hoc endpoint) — use default */
    }
  }
  return DEFAULT_LLM_REQUEST_TIMEOUT_MS;
}

/**
 * Parse vLLM's context-length-overflow 400 body ("maximum context length is C
 * tokens … requested O output tokens … prompt contains at least I input
 * tokens") into a max_tokens value that fits: C − I − safety margin. The
 * server says "at least" for input tokens, and for media-bearing calls it
 * undercounts (video/image tokens are only known after mm processing), so the
 * margin grows exponentially per attempt: 1k, 8k, 64k, … Returns null when the
 * body doesn't match or leaves no usable output budget.
 */
export function parseContextLengthClamp(errorBody: string, margin = 1024): number | null {
  const m = errorBody.match(/maximum context length is (\d+) tokens[\s\S]*?at least (\d+) input tokens/);
  if (!m) return null;
  const clamp = Number(m[1]) - Number(m[2]) - margin;
  return clamp >= 512 ? clamp : null;
}

/**
 * Parse vLLM's mm-encoder-cache 400 ("…with N embedding tokens, which exceeds
 * the pre-allocated encoder cache size C…") into a reduced num_frames budget:
 * floor(currentFrames * C/N * 0.9) — strictly decreasing (N > C), so the retry
 * chain terminates. The 0.9 margin absorbs per-frame token variance across the
 * newly sampled frames. Returns null when the body doesn't match or the budget
 * would drop below 4 frames (too few to be useful — fail instead).
 *
 * NOTE: the working knob is `num_frames` (Qwen arg name) — `video_num_frames`
 * is silently ignored by the vLLM mm processor (verified by live probing: the
 * reported token count stays constant across video_num_frames changes).
 */
export function parseEncoderCacheFrameClamp(errorBody: string, currentFrames: number): number | null {
  const m = errorBody.match(/(\d+) embedding tokens, which exceeds the pre-allocated encoder cache size (\d+)/);
  if (!m) return null;
  const clamp = Math.floor(currentFrames * (Number(m[2]) / Number(m[1])) * 0.9);
  return clamp >= 4 && clamp < currentFrames ? clamp : null;
}

/**
 * Progressively relax repetition_detection for retry attempts (exponential
 * backoff): pattern sizes double and min_count grows per attempt, so a
 * same-seed retry no longer triggers the detector on legitimate structure.
 * Attempt 0 returns the base unchanged.
 */
export function relaxRepetitionDetection(
  base: RepetitionDetectionConfig | undefined,
  attempt: number,
): RepetitionDetectionConfig | undefined {
  if (!base || attempt <= 0) return base;
  return {
    min_pattern_size: base.min_pattern_size * 2 ** attempt,
    max_pattern_size: base.max_pattern_size * 2 ** attempt,
    min_count: base.min_count + attempt,
  };
}

// REFACTOR(consistency): requestCounter is incremented twice per callWithPrompt/callWithPromptRaw call — once for the pre-call logs (:949, :1145) and once inside timedLlmFetch (:97) — so the pre-call lines carry [LLM-N] while the fetch start/completion lines carry [LLM-N+1], defeating the correlation the ID exists for (the comment at :1025 even documents the mismatch). Pass one reqId into timedLlmFetch instead. Also: exported mutable module state with no importer outside this file.
/** Monotonically increasing request ID for correlating the log lines of one call. */
export let requestCounter = 0;

/**
 * Fetch wrapper that adds a sane per-call timeout and logs the call's outcome.
 * On success: `[LLM-N] POST <url> model=<m> → HTTP <status> in <ms>ms`.
 * On timeout/error: an explicit TIMEOUT/ERROR line with the elapsed time, so a
 * hung endpoint is never silent. Routes through longFetch (raised undici limits).
 */
export async function timedLlmFetch(
  url: string,
  init: RequestInit,
  modelName?: string,
  media?: string,
  /** Underlying transport. Defaults to longFetch (raised undici limits); the ASR
   *  multipart upload passes the global fetch (longFetch's Agent drops form parts). */
  fetchFn: (u: string, i: RequestInit) => Promise<Response> = longFetch,
): Promise<Response> {
  const timeoutMs = resolveRequestTimeoutMs(modelName);
  const t0 = Date.now();
  const reqId = ++requestCounter;
  const tag = `[LLM-${reqId}] POST ${url} model=${modelName ?? "?"}${media ? ` media=${media}` : ""}`;
  // Log the START (with the per-call deadline) so an in-flight call is always
  // visible — a hung endpoint shows this line with no matching completion below,
  // instead of the log simply going silent for up to `timeoutMs`.
  console.log(`${tag} … start (timeout=${timeoutMs}ms)`);
  try {
    const res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    console.log(`${tag} → HTTP ${res.status} in ${Date.now() - t0}ms`);
    return res;
  } catch (err) {
    const name = (err as { name?: string })?.name;
    const aborted = name === "TimeoutError" || name === "AbortError";
    console.error(
      `${tag} → ${aborted ? `TIMEOUT after ${timeoutMs}ms` : "ERROR"} (in ${Date.now() - t0}ms): ${(err as Error)?.message ?? err}`,
    );
    throw err;
  }
}

/**
 * Archivar-internal message shape: media parts carry a bare URL string under a
 * typed key (`audio`/`image`/`video`). Converted to the OpenAI wire shape
 * (ChatMessage) by convertToOpenAIFormat just before sending — the two types
 * exist so callers build messages without knowing the `*_url: { url }` nesting
 * the chat-completions API expects.
 */
export interface InternalChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: Array<{
    type: 'text' | 'audio' | 'image' | 'video';
    text?: string;
    audio?: string;
    image?: string;
    video?: string;
  }>;
}

/** OpenAI chat-completions wire format (media parts as `*_url: { url }` objects). This is the only message shape that goes on the wire. */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | Array<{
    type: 'text' | 'image_url' | 'audio_url' | 'video_url';
    text?: string;
    image_url?: { url: string };
    audio_url?: { url: string };
    video_url?: { url: string };
  }>;
}

// https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html#extra-parameters_2
/**
 * Request body for POST /v1/chat/completions. Superset of the OpenAI schema with
 * vLLM extras. All vendor-specific fields (structured_outputs, guided_json,
 * mm_processor_kwargs, chat_template_kwargs) are TOP-LEVEL body keys — never
 * nested under extra_body — because Archivar POSTs raw JSON via longFetch rather
 * than going through the OpenAI SDK.
 */
export interface OpenAIChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  top_p: number;
  top_k?: number;
  max_tokens?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  /** vLLM repetition penalty (>1.0 discourages token repetition). Breaks loops. */
  repetition_penalty?: number;
  /** Sampling seed for reproducible outputs. */
  seed?: number;
  stream?: boolean;
  documents?: any;
  chat_template_kwargs?: any;
  mm_processor_kwargs?: any;
  /**
   * vLLM MediaIO loader kwargs (top-level body field). Frame sampling happens
   * in the MediaIO loader — the HF processor runs with do_sample_frames:false,
   * so mm_processor_kwargs.fps is inert on this server; the per-request fps
   * override must go here (merged over the engine's --media-io-kwargs).
   */
  media_io_kwargs?: { video?: { fps?: number } };
  /**
   * OpenAI-standard structured output. Top-level body field (NOT nested under
   * extra_body — Archivar POSTs raw JSON via longFetch).
   * vLLM honors this as the primary guided-JSON transport.
   */
  response_format?: JsonSchemaResponseFormat;
  /**
   * vLLM-native structured output (v0.12.0+). Top-level body field.
   * Replaces the removed guided_json/guided_choice/guided_regex family.
   */
  structured_outputs?: {
    json?: Record<string, unknown>;
    choice?: string[];
    regex?: string;
    /** Bounded inter-token whitespace pattern (vLLM 0.25+): compact JSON,
     *  prevents whitespace-run degeneration at grammar level. */
    whitespace_pattern?: string;
  };
  /**
   * vLLM v0.25+ repetition detection. Top-level body field. Attached only when
   * the caller resolved it (vLLM models, never ASR) — unknown to other backends.
   */
  repetition_detection?: RepetitionDetectionConfig;
  /**
   * Legacy vLLM guided_json (removed in v0.12.0). Top-level body field.
   * Only used as a probe target for old (<0.12.0) servers.
   */
  guided_json?: Record<string, unknown>;
}

/**
 * Native JSON-schema constrained-decoding transport selection.
 * - false/undefined → prompt-only JSON (current default, unchanged behavior)
 * - "auto" → probe endpoint+model once, pick a working transport
 * - "response_format" → OpenAI-standard response_format (no probe, fail fast)
 * - "structured_outputs" → vLLM-native structured_outputs.json (v0.12.0+)
 * - "json_object" → OpenAI json_object mode (valid JSON only, no schema enforcement)
 * - "legacy_guided_json" → old guided_json (pre-0.12.0 only)
 */
export type JsonSchemaMode =
  | false
  | "auto"
  | "response_format"
  | "structured_outputs"
  | "json_object"
  | "legacy_guided_json";

/** OpenAI-standard response_format payload for guided JSON. */
export type JsonSchemaResponseFormat =
  | { type: "json_schema"; json_schema: { name: string; schema: Record<string, unknown>; strict?: boolean } }
  | { type: "json_object" };

/**
 * Subset of the OpenAI chat-completions response that Archivar reads.
 * `reasoning` is non-standard: some ASR servers (e.g. Qwen3-ASR) return the
 * transcription in `message.reasoning` instead of `content` — see
 * transcribeQwen3Asr.
 */
export interface OpenAIChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
      reasoning?: string;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/** OpenAI-style token accounting returned by chat-completions backends. */
export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** Vendor pass-through fields (e.g. vLLM `prompt_tokens_details`). */
  [key: string]: unknown;
}

/** Structured transport result: the model text plus backend token `usage`
 *  when the protocol reports it (`undefined` for e.g. /v1/audio/transcriptions). */
export interface RawCallResult {
  /** The model's raw/normalized text output (what these methods returned before). */
  content: string;
  /** Backend token usage when available; `undefined` when the protocol omits it. */
  usage?: TokenUsage;
}

/**
 * Build the `mm_processor_kwargs` for a vLLM multimodal request.
 *
 * Starts from hardcoded media-type defaults (which preserve existing behavior
 * for callers that pass no override), then applies config-driven overrides on
 * top — overrides win for every key they set.
 *
 * Pure function — exported for unit testing.
 */
export function resolveMmProcessorKwargs(
  mediaCategory: "audio" | "video" | "image",
  override?: Record<string, unknown>,
): Record<string, unknown> {
  const kwargs: Record<string, unknown> = { return_audio: false };
  if (mediaCategory === "video") {
    kwargs.use_audio_in_video = false;
    // NOTE: no frame-count key here — `video_num_frames` is silently ignored by
    // vLLM's mm processor; frame limiting is done via the encoder-cache clamp
    // (`num_frames`, see parseEncoderCacheFrameClamp) or the engine's own
    // --media-io-kwargs server default.
    kwargs.fps = 1;
  }
  if (override) {
    Object.assign(kwargs, override);
  }
  return kwargs;
}

// Structured-output defaults now centralized in src/lib/structured-output-defaults.ts
// REFACTOR(kiss): resolveStructuredConfig is imported but never used in this file, and this is the only mid-file import (hoisted, so it works — but reads like a refactor leftover). Drop the unused symbol and move the import to the top import block.
import { STRUCTURED_OUTPUT_DEFAULTS, resolveStructuredConfig } from "../lib/structured-output-defaults";

/**
 * Transport layer to the OpenAI-compatible LLM/ASR backends (vLLM and friends).
 *
 * Two usage styles coexist:
 * - The caption entry points (captionAudios/captionVideos/captionImage/
 *   captionSound) are RPC-exposed to the frontend (src/rpc.ts:51-54) and pick
 *   their model from constructor env defaults or a hardcoded registry name.
 * - callWithPrompt/callWithPromptRaw are the generic, fully-resolved variants
 *   used server-side by WorkflowEngine (workflow-engine.ts:1735) and the v3
 *   plugin API's callRaw/callJson (post-processing/plugin-api.ts:150,245).
 *
 * Holds no per-call state — each method either takes a resolved
 * endpoint/model/apiKey or resolves them per call via the model registry
 * (getModel).
 */
export class MllmApi {
  private apiKey: string | undefined;

  constructor() {
    // `|| undefined` (not `??`): an empty-string env var must mean "no key",
    // otherwise an empty Bearer header is sent.
    this.apiKey = process.env.MLLM_API_KEY || undefined;
  }

  /**
   * Resolve a model NAME from the configured default workflow instead of a
   * hardcoded registry entry: "vlm" is the default workflow's scene-step model
   * (fallback: the first `type: "api"` model), "asr" its speech-step model
   * (fallback: the first `type: "asr-api"` model). Single source of truth for
   * the quick-caption methods below — a default that drifts out of the config
   * can no longer break them. Throws when nothing suitable is configured.
   */
  private resolveDefaultModelName(kind: "vlm" | "asr"): string {
    const config = getArchivarConfig();
    const wfName = config.defaults?.workflow ?? config.workflows?.[0]?.name;
    if (wfName) {
      const name = kind === "vlm" ? resolveWorkflowModels(wfName).vlm : resolveWorkflowModels(wfName).asr;
      if (name) return name;
    }
    const fallback = config.models?.find((m) =>
      kind === "vlm" ? (m.type ?? "api") === "api" : m.type === "asr-api");
    if (!fallback) {
      throw new Error(`No ${kind === "vlm" ? "api" : "asr-api"} model found in archivar config.`);
    }
    return fallback.name;
  }

  /**
   * Extract JSON from markdown code blocks and parse it.
   *
   * Delegates to the shared consolidated extractor (`parseJsonLoose`) so all
   * JSON-parsing paths in Archivar use identical fallback logic. Kept as a
   * thin wrapper to preserve this class's stable private API and throwing
   * semantics (caption methods expect a throw on failure).
   */
  private extractAndParseJson(content: string): any {
    return parseJsonLoose(content, { throwOnFail: true }) as any;
  }

  /**
   * Map the internal message shape to the OpenAI wire shape. Unknown content
   * types hit the default branch and are sent as `text` — silently, so a new
   * part type added to InternalChatMessage compiles but is silently degraded.
   */
  private convertToOpenAIFormat(messages: InternalChatMessage[]): ChatMessage[] {
    return messages.map(message => {
      const openAIContent = message.content.map(content => {
        switch (content.type) {
          case 'audio':
            return {
              type: 'audio_url' as const,
              audio_url: { url: content.audio! }
            };
          case 'image':
            return {
              type: 'image_url' as const,
              image_url: { url: content.image! }
            };
          case 'video':
            return {
              type: 'video_url' as const,
              video_url: { url: content.video! }
            };
          case 'text':
          default:
            return {
              type: 'text' as const,
              text: content.text || ''
            };
        }
      });

      return {
        role: message.role,
        content: openAIContent
      };
    });
  }

  // REFACTOR(consistency): two error-message formats for the same failure — "MLLM API request failed:" in captionVideos (:565) and captionImage (:693), vs "API request failed:" in callWithPrompt (:1062) and callWithPromptRaw (:1282). Pick one format so log grepping stays sane.
  // REFACTOR(dry): the request literal below duplicates the caption* request block — same documents/chat_template_kwargs/sampling skeleton as captionVideos (:526-545) and captionImage (:635-653) with slightly different values, and mm_processor_kwargs is inlined as `{ return_audio: false }` instead of resolveMmProcessorKwargs("audio") (:231).
  /**
   * Transcribe audio files into text (RPC-exposed, src/rpc.ts:51).
   * Model/endpoint/apiKey resolve per call from the configured default
   * workflow's speech-step (ASR) model (see resolveDefaultModelName). Throws on
   * parse failure (extractAndParseJson is strict here).
   * @param urls Array of audio file URLs
   * @returns Parsed `{ lang, transcription }` (the prompt instructs JSON)
   */
  public async captionAudios(urls: string[]): Promise<{ lang: string, transcription: string, usage?: TokenUsage }> {
    try {
      const modelName = this.resolveDefaultModelName("asr");
      console.log("[MllmApi] captionAudios: resolving model", modelName);
      const modelCfg = getModel(modelName);
      console.log("=== Caption Audios ===");
      console.log("Input URLs:", urls);

      if (!urls || urls.length === 0) {
        throw new Error("No audio URLs provided");
      }

      const messages: InternalChatMessage[] = [{
        role: 'user',
        content: [
          {
            type: 'text' as const,
            text: 'Transcribe the audio into text. Return JSON only. e.g.: { lang: "de", transcription: "..." }'
          },
          ...urls.map(url => ({
            type: 'audio' as const,
            audio: this.toValidRemoteUrl(url)
          }))
        ]
      }];

      console.log("Internal messages:", JSON.stringify(messages, null, 2));

      const openAIMessages = this.convertToOpenAIFormat(messages);
      console.log("OpenAI messages:", JSON.stringify(openAIMessages, null, 2));

      const request: OpenAIChatRequest = {
        model: modelCfg.resolvedModel,
        messages: openAIMessages,
        // Use moderate sampling to prevent repetition loops on quantized models.
        temperature: 0.7,
        top_p: 0.9,
        top_k: 20,
        max_tokens: 8192,
        presence_penalty: 0,
        frequency_penalty: 0,
        repetition_penalty: 1.05,
        seed: DEFAULT_SEED, // Reproducible outputs
        documents: [],
        chat_template_kwargs: {
          add_generation_prompt: true,
          tokenize: false,
          enable_thinking: false,
        },
        mm_processor_kwargs: { return_audio: false }
      };

      const url = `${modelCfg.resolvedEndpoint}/v1/chat/completions`;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (modelCfg.resolvedApiKey) {
        headers['Authorization'] = `Bearer ${modelCfg.resolvedApiKey}`;
      }
      const response = await timedLlmFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
      }, modelCfg.resolvedModel, "audio");

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        throw new Error(`MLLM API request failed: ${response.status} ${response.statusText}${errorBody ? `\nResponse body: ${errorBody}` : ''}`);
      }

      const responseData: OpenAIChatResponse = await response.json();
      const content = responseData.choices[0]?.message?.content || '';

      console.log("Audio caption result:", content);
      recordTokenUsage(responseData.usage ?? undefined);
      return { ...this.extractAndParseJson(content), usage: responseData.usage ?? undefined };
    } catch (error) {
      console.error("=== Caption Audios Error ===");
      console.error(`Error in captionAudios:\n${error instanceof Error ? error.message : String(error)}${error instanceof Error && error.stack ? `\n${error.stack}` : ""}`);
      throw new Error(`Failed to caption audio files: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Normalize a media reference for the LLM server. Local paths become file://
   * URLs so the vLLM container can read them from its own filesystem mount
   * (subject to its --allowed-local-media-path policy). Remote and inline
   * references pass through unchanged.
   */
  public toValidRemoteUrl(path: string): string {
    // Don't modify data URIs (base64 inline content) or http(s) URLs or file:// URLs
    if (path.startsWith('http') || path.startsWith('data:') || path.startsWith('file://')) {
      return path;
    }
    return `file://${path}`;
  }

  /**
   * Image URLs for LLM calls: local image files are re-encoded via sharp and
   * inlined as base64 data URLs. ffmpeg-extracted keyframes can carry HDR
   * color-metadata chunks (cICP/cHRM/gAMA) that make vLLM's image loader fail
   * with HTTP 500; sharp re-encoding strips them (sharp drops all metadata by
   * default). data: URLs also sidestep vLLM's --allowed-local-media-path policy.
   * http(s)/data: URLs pass through unchanged.
   */
  public async toValidImageUrl(url: string): Promise<string> {
    if (url.startsWith('http') || url.startsWith('data:')) {
      return url;
    }
    const localPath = url.startsWith('file://') ? url.slice('file://'.length) : url;
    const readablePath = existsSync(localPath) ? localPath : this.mapSampleDataPath(localPath);
    if (!existsSync(readablePath)) {
      // Not readable on this host — pass through; the LLM server may resolve
      // the path in its own container mount (previous file:// behavior).
      return this.toValidRemoteUrl(url);
    }
    const buffer = await sharp(readablePath).png().toBuffer();
    return `data:image/png;base64,${buffer.toString('base64')}`;
  }

  /** Map container-style /sample_data/... paths to the host data dir. */
  private mapSampleDataPath(localPath: string): string {
    const sampleDataSubDir = getEnv('SAMPLE_DATA_SUBDIR', 'sample_data/archivar');
    const relativeSampleDataPath = getEnv('RELATIVE_SAMPLE_DATA_PATH', `../${sampleDataSubDir}`);
    const dataDir = resolve(process.cwd(), relativeSampleDataPath);
    // "/sample_data/archivar/x.png" with SAMPLE_DATA_SUBDIR "sample_data/archivar" → "x.png"
    const rest = localPath.replace(/^\/sample_data\//, '');
    const subDirName = sampleDataSubDir.split('/').pop() ?? '';
    const rel = subDirName && rest.startsWith(`${subDirName}/`) ? rest.slice(subDirName.length + 1) : rest;
    return resolve(dataDir, rel);
  }

  /**
   * Describe video content in German (RPC-exposed via src/rpc.ts).
   * The model resolves per call from the configured default workflow's
   * scene-step (VLM) model — see resolveDefaultModelName.
   * Returns the raw caption string; no JSON is requested or parsed on this path.
   * @param urls Array of video file URLs
   * @returns Promise<string> Description of the video
   */
  public async captionVideos(
    urls: string[],
    /** Config-driven overrides merged on top of the video defaults */
    mmProcessorKwargsOverride?: Record<string, unknown>,
  ): Promise<RawCallResult> {
    try {
      const modelName = this.resolveDefaultModelName("vlm");
      console.log("[MllmApi] captionVideos: resolving model", modelName);
      const modelCfg = getModel(modelName);
      console.log("[MllmApi] captionVideos: resolved endpoint=", modelCfg.resolvedEndpoint);
      console.log("[MllmApi] captionVideos: resolved model=", modelCfg.resolvedModel);
      console.log("[MllmApi] captionVideos: resolved apiKey=", modelCfg.resolvedApiKey ? `"${modelCfg.resolvedApiKey}"` : "undefined/null");
      console.log("=== Caption Videos ===");
      console.log("Input URLs:", urls);

      if (!urls || urls.length === 0) {
        throw new Error("No video URLs provided");
      }

      const messages: InternalChatMessage[] = [{
        role: 'user',
        content: [
          {
            type: 'text' as const,
            text: 'Describe the video in German.'
          },
          ...urls.map(url => ({
            type: 'video' as const,
            video: this.toValidRemoteUrl(url)
          }))
        ]
      }];

      console.log("Internal messages:", JSON.stringify(messages, null, 2));

      const openAIMessages = this.convertToOpenAIFormat(messages);
      console.log("OpenAI messages:", JSON.stringify(openAIMessages, null, 2));

      const request: OpenAIChatRequest = {
        model: modelCfg.resolvedModel,
        messages: openAIMessages,
        // Use moderate sampling to prevent repetition loops on quantized models.
        temperature: 0.7,
        top_p: 1,
        seed: DEFAULT_SEED, // Reproducible outputs (overridable per model in config)
        top_k: 20,
        max_tokens: Math.min(120000, resolveMaxInferenceContext(modelCfg.resolvedModel) - 4096),
        presence_penalty: 0,
        frequency_penalty: 0.1,
        repetition_penalty: 1.05,
        documents: [],
        chat_template_kwargs: {
          add_generation_prompt: true,
          tokenize: false,
          enable_thinking: false,
        },
        mm_processor_kwargs: resolveMmProcessorKwargs("video", mmProcessorKwargsOverride)
      };

      const url = `${modelCfg.resolvedEndpoint}/v1/chat/completions`;
      console.log("[MllmApi] captionVideos: constructing url=", url);
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (modelCfg.resolvedApiKey) {
        headers['Authorization'] = `Bearer ${modelCfg.resolvedApiKey}`;
      }
      console.log("[MllmApi] captionVideos fetch url=", url);

      const response = await timedLlmFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
      }, modelCfg.resolvedModel, "video");
      console.log("[MllmApi] captionVideos: fetch returned status=", response.status, response.statusText);

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        console.error("[MllmApi] captionVideos: fetch failed! status=", response.status, "body=", errorBody);
        throw new Error(`MLLM API request failed: ${response.status} ${response.statusText}${errorBody ? `\nResponse body: ${errorBody}` : ''}`);
      }

      const responseData: OpenAIChatResponse = await response.json();
      const content = responseData.choices[0]?.message?.content || '';

      console.log("Video caption result:", content);
      recordTokenUsage(responseData.usage ?? undefined);
      return { content, usage: responseData.usage ?? undefined };
    } catch (error) {
      console.error("=== Caption Videos Error ===");
      console.error(`Error in captionVideos:\n${error instanceof Error ? error.message : String(error)}${error instanceof Error && error.stack ? `\n${error.stack}` : ""}`);
      throw new Error(`Failed to caption video files: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // REFACTOR(consistency): the return type promises `objects` (bbox_2d/label/details), but the active prompt and captionSchema below only ask for `desc` — the object-localization prompt survives only as a commented-out string at :604. Either restore object detection or drop `objects` from the contract. Note: captionImage is RPC-exposed (src/rpc.ts:53), so the type is client-visible.
  /**
   * Describe images (RPC-exposed, src/rpc.ts:53). The model resolves per call
   * from the configured default workflow's scene-step (VLM) model — see
   * resolveDefaultModelName. Local image files are inlined as base64
   * PNG data URLs (see toValidImageUrl) before the call.
   * @param urls Array of image file URLs
   * @param systemPrompt Overrides the built-in German description prompt
   * @returns Parsed JSON with the image description (see REFACTOR above re: objects)
   */
  public async captionImage(urls: string[], systemPrompt?: string): Promise<{ desc: string, objects: { bbox_2d: [number, number, number, number], label: string, details: string }[], usage?: TokenUsage }> {
    try {
      const modelName = this.resolveDefaultModelName("vlm");
      console.log("[MllmApi] captionImage: resolving model", modelName);
      const modelCfg = getModel(modelName);
      console.log("[MllmApi] captionImage: resolved endpoint=", modelCfg.resolvedEndpoint);
      console.log("[MllmApi] captionImage: resolved model=", modelCfg.resolvedModel);
      console.log("[MllmApi] captionImage: resolved apiKey=", modelCfg.resolvedApiKey ? `"${modelCfg.resolvedApiKey}"` : "undefined/null");
      console.log("=== Caption Image ===");
      console.log("Input URLs:", urls);

      if (!urls || urls.length === 0) {
        throw new Error("No image URLs provided");
      }

      const messages: InternalChatMessage[] = [{
        role: 'user',
        content: [
          {
            type: 'text' as const,
            text: systemPrompt || 'Describe the image in German. Return JSON only without code fences. Schema MUST be: { "desc": "Detailed description of the image" }'//'Describe the image in German. Locate and tag all objects. Return JSON only, e.g.: { desc: "...", objects: [{"bbox_2d": [228, 825, 388, 967], "label": "bird", "details": "heading left"}] }'
          },
          ...await Promise.all(urls.map(async (url) => ({
            type: 'image' as const,
            image: await this.toValidImageUrl(url)
          })))
        ]
      }];

      console.log("Internal messages:", JSON.stringify(messages, null, 2));

      const openAIMessages = this.convertToOpenAIFormat(messages);
      console.log("OpenAI messages:", JSON.stringify(openAIMessages, null, 2));

      // Define schema for structured output (forces valid JSON output)
      const captionSchema = {
        type: "object",
        properties: {
          desc: { type: "string", description: "Detailed description of the image" },
        },
        required: ["desc"]
      };

      // REFACTOR(consistency): hand-rolled transport selection that diverges from callWithPromptRaw (:1200-1214) — "auto" (the default) maps to null here WITHOUT probing, and "legacy_guided_json" is silently dropped, so this method only constrains output when the model config names an explicit transport. Route through resolveTransport/attachStructuredOutput (:793-841) instead.
      // Attach a grammar constraint only for the three explicit transports below;
      // unlike callWithPromptRaw, "auto" never probes here (falls through to null).
      const jsonSchemaMode = (modelCfg as any).jsonSchemaMode ?? "auto";
      const transport = jsonSchemaMode === "structured_outputs" ? "structured_outputs"
        : jsonSchemaMode === "json_object" ? "json_object"
          : jsonSchemaMode === "response_format" ? "response_format"
            : null;

      const request: OpenAIChatRequest = {
        model: modelCfg.resolvedModel,
        messages: openAIMessages,
        // Use moderate sampling to prevent repetition loops on quantized models.
        temperature: 0.2,
        top_p: 1,
        seed: DEFAULT_SEED, // Reproducible outputs (overridable per model in config)
        // Capped at the model's resolved ceiling so reduced-window deployments
        // (--max-model-len 65536) don't hard-400 on the legacy 120k default.
        max_tokens: Math.min(120000, resolveMaxInferenceContext(modelCfg.resolvedModel) - 4096),
        presence_penalty: 0,
        frequency_penalty: 0.1,
        repetition_penalty: 1.05,
        documents: [],
        chat_template_kwargs: {
          add_generation_prompt: true,
          tokenize: false,
          enable_thinking: false,
        },
        // REFACTOR(dry): inlined kwargs instead of resolveMmProcessorKwargs("image") (:231) — and use_audio_in_video is a video-only key, meaningless on an image call (copy-pasted from the video defaults).
        mm_processor_kwargs: { use_audio_in_video: false, return_audio: false }
      };

      // Attach structured output based on model's jsonSchemaMode
      if (transport === "structured_outputs") {
        request.structured_outputs = { json: captionSchema };
      } else if (transport === "response_format") {
        request.response_format = {
          type: "json_schema",
          json_schema: { name: "caption_response", strict: true, schema: captionSchema },
        };
      } else if (transport === "json_object") {
        request.response_format = { type: "json_object" };
      }
      // transport null ⇒ prompt-only JSON (no probe ran — see the REFACTOR above)

      console.log("MLLM request:", JSON.stringify(request, null, 2));

      const url = `${modelCfg.resolvedEndpoint}/v1/chat/completions`;
      console.log("[MllmApi] captionImage: constructing url=", url);
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (modelCfg.resolvedApiKey) {
        headers['Authorization'] = `Bearer ${modelCfg.resolvedApiKey}`;
        console.log("[MllmApi] captionImage: Authorization header set with Bearer token length=", modelCfg.resolvedApiKey.length);
      } else {
        console.warn("[MllmApi] captionImage: WARNING - No API key set! modelCfg.resolvedApiKey is falsy");
      }
      console.log("[MllmApi] captionImage fetch url=", url);
      console.log("[MllmApi] captionImage fetch headers=", JSON.stringify(headers));

      console.log("[MllmApi] captionImage: calling fetch...");
      const response = await timedLlmFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
      }, modelCfg.resolvedModel, "image");
      console.log("[MllmApi] captionImage: fetch returned status=", response.status, response.statusText);

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        console.error("[MllmApi] captionImage: fetch failed! status=", response.status, "body=", errorBody);
        throw new Error(`MLLM API request failed: ${response.status} ${response.statusText}${errorBody ? `\nResponse body: ${errorBody}` : ''}`);
      }

      console.log("[MllmApi] captionImage: parsing response JSON...");
      const responseData: OpenAIChatResponse = await response.json();
      const content = responseData.choices[0]?.message?.content || '';
      console.log("[MllmApi] captionImage: response content length=", content.length);

      console.log("Image caption result:", content);
      const parsed = this.extractAndParseJson(content);
      console.log("[MllmApi] captionImage: parsed result=", JSON.stringify(parsed, null, 2));
      recordTokenUsage(responseData.usage ?? undefined);
      return { ...parsed, usage: responseData.usage ?? undefined };
    } catch (error) {
      console.error("=== Caption Image Error ===");
      console.error(`Error in captionImage:\n${error instanceof Error ? error.message : String(error)}${error instanceof Error && error.stack ? `\n${error.stack}` : ""}`);
      throw new Error(`Failed to caption image files: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Transcribe speech/audio via the ASR upload path (RPC-exposed via src/rpc.ts).
   * Despite the name, the result is always `{ type: "SPEECH", desc: <transcription> }`
   * — non-speech sound classification is not implemented. data:/http(s) inputs
   * are materialized to temp files because the multipart ASR endpoints read from
   * disk; the temp dir is removed in the finally block below.
   * TODO: Rename: captionSound -> describeSound (breaks the RPC-exposed method name at src/rpc.ts)
   * Identify sounds and their context
   * @param urls Array of audio file URLs
   * @param modelName Optional model name; when omitted, the configured default
   *   workflow's speech-step (ASR) model is used (see resolveDefaultModelName).
   * @returns Promise<{ type: string, desc: string }> Parsed JSON response with sound type and description
   */
  public async captionSound(urls: string[], modelName?: string): Promise<{ type: string, desc: string, usage?: TokenUsage }> {
    try {
      const effectiveModelName = modelName ?? this.resolveDefaultModelName("asr");
      console.log("[MllmApi] captionSound: resolving model", effectiveModelName);
      const modelCfg = getModel(effectiveModelName);
      console.log("[MllmApi] captionSound: resolved endpoint=", modelCfg.resolvedEndpoint);
      console.log("=== Caption Sound ===");
      console.log("Input URLs:", urls);

      if (!urls || urls.length === 0) {
        throw new Error("No audio URLs provided");
      }

      // Convert data URIs to temp files for ASR multipart upload
      const tmpDir = mkdtempSync(pathJoin(tmpdir(), "archivar-audio-"));
      const tempFiles: string[] = [];

      try {
        for (const url of urls) {
          let buffer: Buffer;
          if (url.startsWith("data:")) {
            // Extract base64 data from data URI
            const match = url.match(/^data:([^;]+);base64,(.+)$/);
            if (!match) throw new Error(`Invalid data URI: ${url}...`);
            buffer = Buffer.from(match[2], "base64");
          } else if (url.startsWith("http")) {
            const res = await fetch(url);
            buffer = Buffer.from(await res.arrayBuffer());
          } else {
            // Assume local file path
            buffer = await readFile(url);
          }
          // REFACTOR(consistency): the extension is guessed from a MIME substring in the URL — local file paths never contain "audio/*", so e.g. an mp3 file is written out as .wav. transcribeViaAudioTranscriptions already has the proper extension-based MIME_BY_EXT map (:1544-1551); share it.
          const ext = url.includes("audio/wav") ? ".wav" : url.includes("audio/mp3") ? ".mp3" : ".wav";
          const tempFile = pathJoin(tmpDir, `audio-${tempFiles.length}${ext}`);
          writeFileSync(tempFile, buffer);
          tempFiles.push(tempFile);
        }

        const asrResult = await this.transcribeQwen3Asr(
          modelCfg.resolvedEndpoint,
          tempFiles,
          modelCfg.language,
          effectiveModelName,
          modelCfg.resolvedModel,
          modelCfg.resolvedApiKey,
        );
        console.log("[MllmApi] captionSound: transcription=", asrResult.content);

        const result = { type: "SPEECH", desc: asrResult.content, usage: asrResult.usage };
        console.log("[MllmApi] captionSound: parsed result=", JSON.stringify(result, null, 2));
        return result;
      } finally {
        // Clean up temp files
        for (const f of tempFiles) {
          try { unlinkSync(f); } catch { /* ignore */ }
        }
        try { rmdirSync(tmpDir); } catch { /* ignore */ }
      }
    } catch (error) {
      console.error("=== Caption Sound Error ===");
      console.error(`Error in captionSound:\n${error instanceof Error ? error.message : String(error)}${error instanceof Error && error.stack ? `\n${error.stack}` : ""}`);
      throw new Error(`Failed to caption sound files: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ==========================================================================
  // Generic model call (used by WorkflowEngine)
  // ==========================================================================

  /**
   * Resolve the concrete transport for a call given a config mode.
   * "auto" triggers a cached per-(endpoint,model,thinking) probe; explicit
   * modes are returned unchanged so the caller can fail fast on rejection.
   * Returns undefined when there is nothing to attach (mode off / probe=none).
   */
  private async resolveTransport(
    endpoint: string,
    model: string,
    enableThinking: boolean | undefined,
    mode: JsonSchemaMode,
    /** Per-call resolved API key (takes precedence over the constructor default). */
    apiKey?: string,
  ): Promise<JsonSchemaTransport | undefined> {
    if (mode === false) return undefined;
    const resolved = await resolveJsonSchemaTransport(
      endpoint,
      model,
      Boolean(enableThinking),
      mode === "auto" ? "auto" : mode,
      apiKey ?? this.apiKey,
    );
    return resolved === "none" ? undefined : resolved;
  }

  /**
   * Attach the resolved structured-output transport to the request body.
   * All transports are TOP-LEVEL body keys (never nested under extra_body),
   * matching vLLM/OpenAI raw HTTP semantics.
   */
  private attachStructuredOutput(
    request: OpenAIChatRequest,
    schema: Record<string, unknown>,
    transport: JsonSchemaTransport,
    /** Name for response_format.json_schema.name (ignored by other transports).
     *  Defaults to "archivar_response" when not provided by config. */
    jsonSchemaName?: string,
  ): void {
    if (transport === "response_format") {
      request.response_format = {
        type: "json_schema",
        json_schema: { name: jsonSchemaName ?? "archivar_response", strict: true, schema },
      };
    } else if (transport === "structured_outputs") {
      // whitespace_pattern "[ \t\r\n]?" (bounded, never * or +): vLLM emits
      // compact JSON — no whitespace between JSON tokens (string values keep
      // theirs). Closes the whitespace-run degeneration path at grammar level.
      request.structured_outputs = { json: schema, whitespace_pattern: "[ \t\r\n]?" };
    } else if (transport === "json_object") {
      // json_object mode: constrain output to valid JSON without schema enforcement.
      // The schema is still passed to the prompt for the model to follow, but the
      // API only guarantees well-formed JSON (not schema validation).
      request.response_format = { type: "json_object" };
    } else {
      // legacy_guided_json (removed in vLLM v0.12.0; only for old servers)
      request.guided_json = schema;
    }
  }

  /**
   * Sampling overrides applied ONLY when native structured output is attached.
   *
   * WHY: the request-builder defaults (temperature≈0, top_k=1, top_p=0.1) are
   * pure-greedy, which makes guided decoding degenerate under load. The forced
   * temperature (STRUCTURED_OUTPUT_DEFAULTS.temperature = 0.2 unless overridden)
   * stays LOW for schema fidelity — the grammar guarantees validity, so there is
   * nothing to gain from stochastic exploration. presence_penalty is zeroed
   * (logit processors can conflict with the guided-decoding logit processor);
   * frequency_penalty is kept at a mild 0.1 and the caller's repetition_penalty
   * passes through. max_tokens is capped (default 16384) so residual degeneration
   * fails fast via finish_reason "length" and triggers callJson's truncation
   * retry instead of generating up to the 122000 free-form default.
   */
  private applyStructuredSampling(
    request: OpenAIChatRequest,
    structuredMaxTokens: number = STRUCTURED_OUTPUT_DEFAULTS.maxTokens,
    structuredTemperature: number = STRUCTURED_OUTPUT_DEFAULTS.temperature,
    structuredFrequencyPenalty: number = STRUCTURED_OUTPUT_DEFAULTS.frequencyPenalty,
    structuredRepetitionPenalty: number = STRUCTURED_OUTPUT_DEFAULTS.repetitionPenalty,
    structuredPresencePenalty?: number,
    structuredTopP?: number,
    structuredTopK?: number,
  ): void {
    // temperature (forced): low for schema fidelity; the grammar still guarantees
    // validity. This OVERRIDES the model config's temperature for structured calls.
    request.temperature = structuredTemperature;
    // top_k / top_p stay at the callWithPromptRaw builder values unless the model
    // pins structuredOutput.topP/topK. The Qwen non-thinking profile (top_k=20,
    // top_p=0.8, presence_penalty=1.6, frequency/repetition penalties at 0/1.0)
    // measurably stabilizes structured output under concurrent load (35B load
    // ablation: baseline 4/8 bad under 8x load, profile 8/8 clean).
    if (structuredTopP !== undefined) request.top_p = structuredTopP;
    if (structuredTopK !== undefined) request.top_k = structuredTopK;
    // presence_penalty: 0 by default (logit processors can conflict with guided
    // decoding); models that pin structuredOutput.presencePenalty get it passed
    // through (Qwen's documented loop control for structured output).
    request.presence_penalty = structuredPresencePenalty ?? 0;
    // frequency_penalty: mild anti-loop default (0.1), per-model overridable via
    // structuredOutput.frequencyPenalty.
    request.frequency_penalty = structuredFrequencyPenalty;
    // repetition_penalty: anti-verbatim-loop for structured calls (keyword-list
    // degeneration), per-model overridable via structuredOutput.repetitionPenalty.
    // A plain logit multiplier — no guided-decoding conflict.
    request.repetition_penalty = structuredRepetitionPenalty;
    // Hard cap so any residual degeneration fails fast (truncation retry bumps it).
    request.max_tokens = Math.min(request.max_tokens ?? structuredMaxTokens, structuredMaxTokens);
  }

  /**
   * Sampling overrides applied for json_object mode.
   *
   * WHY: json_object has NO grammar constraint (unlike response_format/structured_outputs).
   * Without grammar constraint, ultra-restrictive sampling defaults (top_k=1, top_p=0.1,
   * temperature=0.01) cause repetition loops where the model cycles through statistically
   * probable tokens. Valid JSON syntax is produced but content is garbage.
   *
   * For json_object we use moderate sampling that prevents repetition without grammar:
   * - temperature=0.7: Creative enough to avoid repetition, deterministic enough for JSON
   * - top_p=0.9: Top 90% cumulative probability
   * - top_k=20: Reasonable token diversity
   * - repetition_penalty=1.05: Mild anti-repetition boost
   */
  private applyJsonObjectSampling(request: OpenAIChatRequest): void {
    request.temperature = 0.7;
    request.top_p = 0.9;
    request.top_k = 20;
    // Mild repetition penalty prevents loops without logit-processor conflict.
    request.repetition_penalty = request.repetition_penalty && request.repetition_penalty > 1.0
      ? request.repetition_penalty
      : 1.05;
    // Zero penalties that conflict with guided decoding (logit processors).
    request.presence_penalty = 0;
    request.frequency_penalty = 0.1;
    // NOTE: Do NOT cap max_tokens for json_object mode — the model needs room
    // to produce complete semantic JSON. The default 122000 from the request
    // builder is appropriate; capping to 8192 causes truncated output.
  }

  // REFACTOR(dry): callWithPrompt and callWithPromptRaw (:1120-1319) are ~150 lines of copy-paste — message build, request literal, transport attach, headers, fetch and error wrap are identical; they diverge only in response handling (normalize-to-caption here vs raw string + typed errors there) and two sampling defaults. Extract a shared buildRequest/executeRequest pair. The same fetch + !response.ok block exists a third and fourth time in captionVideos (:555-566) and captionImage (:683-694).
  /**
   * Call a model with a prompt and media URLs. Supports overriding endpoint/model/apiKey.
   * Used by WorkflowEngine for registry-driven model calls (workflow-engine.ts:1735).
   * The response is normalized to a plain caption string: if the content parses
   * as JSON, a known text field wins (transcription → desc → text, in that
   * order), otherwise the stringified JSON; non-JSON content is returned
   * verbatim. Callers that need the unmodified model output (or typed errors)
   * must use callWithPromptRaw instead.
   * @param endpoint Full API base URL (resolved, not env: prefixed)
   * @param model Model repo/ID string (resolved)
   * @param apiKey Optional API key (resolved)
   * @param urls Media file URLs/paths
   * @param prompt The text prompt
   * @param mediaCategory "audio" | "video" | "image"
   * @param hyperparams Optional hyperparameters override
   * @param systemPrompt Optional system prompt
   * @returns The model response content as a string
   */
  public async callWithPrompt(
    endpoint: string,
    model: string,
    apiKey: string | undefined,
    urls: string[],
    prompt: string,
    mediaCategory: "audio" | "video" | "image",
    hyperparams?: Record<string, unknown>,
    systemPrompt?: string,
    enableThinking?: boolean,
    /** Config-driven overrides merged on top of the media-type defaults */
    mmProcessorKwargsOverride?: Record<string, unknown>,
    /** JSON Schema for native guided decoding. Attached only when jsonSchemaMode is set. */
    jsonSchema?: Record<string, unknown>,
    /** Transport selection: "auto" (probe) | explicit mode | false/undefined (off). */
    jsonSchemaMode?: JsonSchemaMode,
    /** Structured-output overrides from ModelConfig.structuredOutput. */
    structuredMaxTokens?: number,
    structuredTemperature?: number,
    structuredFrequencyPenalty?: number,
    structuredRepetitionPenalty?: number,
    /** Name for response_format.json_schema.name (response_format transport only). */
    jsonSchemaName?: string,
    /** Resolved vLLM repetition_detection (undefined = omit from request). */
    repetitionDetection?: RepetitionDetectionConfig,
    /** Internal: nth mm-encoder-cache frame clamp retry. */
    encoderCacheAttempt?: number,
    /** Internal: nth context-overflow halving retry (see the 400 handler). */
    contextHalveAttempt?: number,
  ): Promise<RawCallResult> {
    // Generate request ID at the START so all logs can use it
    const reqId = ++requestCounter;
    const reqPrefix = `[LLM-${reqId}]`;

    try {
      const mediaType = mediaCategory === "image" ? "image" as const
        : mediaCategory === "video" ? "video" as const
          : "audio" as const;

      const messages: InternalChatMessage[] = [];

      // Add system prompt if provided
      if (systemPrompt) {
        messages.push({
          role: "system",
          content: [{ type: "text", text: systemPrompt }],
        });
      }

      messages.push({
        role: "user",
        content: [
          { type: "text", text: prompt },
          ...await Promise.all(urls.map(async (url) => ({
            type: mediaType,
            [mediaType]: mediaType === "image" ? await this.toValidImageUrl(url) : this.toValidRemoteUrl(url),
          }))),
        ],
      });

      const openAIMessages = this.convertToOpenAIFormat(messages);

      // Merge media-type defaults with config-driven overrides (overrides win)
      const mmProcessorKwargs = resolveMmProcessorKwargs(mediaCategory, mmProcessorKwargsOverride);

      const request: OpenAIChatRequest = {
        model,
        messages: openAIMessages,
        temperature: (hyperparams?.temperature as number) ?? 1e-2,
        top_p: (hyperparams?.top_p as number) ?? 0.1,
        top_k: (hyperparams?.top_k as number) ?? 1,
        // Free-form default when the caller sets no max_tokens: capped below the
        // model's resolved ceiling with 4k input headroom, so reduced-window
        // deployments (--max-model-len 65536) don't hard-400. Configured
        // hyperparams.max_tokens pass through untouched (bump ladder intact).
        max_tokens: (hyperparams?.max_tokens as number) ?? Math.min(122000, resolveMaxInferenceContext(model) - 4096),
        presence_penalty: (hyperparams?.presence_penalty as number) ?? 0,
        // Anti-repetition for free-form captioning: breaks loops that would
        // otherwise generate up to max_tokens (≈ the per-call timeout).
        frequency_penalty: (hyperparams?.frequency_penalty as number) ?? CAPTION_FREQUENCY_PENALTY,
        repetition_penalty: (hyperparams?.repetition_penalty as number) ?? CAPTION_REPETITION_PENALTY,
        seed: (hyperparams?.seed as number) ?? DEFAULT_SEED,
        documents: [],
        chat_template_kwargs: {
          add_generation_prompt: true,
          tokenize: false,
          enable_thinking: enableThinking ?? false,
        },
        mm_processor_kwargs: mmProcessorKwargs,
      };

      // Forward the configured video fps as a MediaIO override — the only
      // frame-sampling knob this server honors (see OpenAIChatRequest).
      if (mediaCategory === "video" && typeof mmProcessorKwargs?.fps === "number") {
        request.media_io_kwargs = { video: { fps: mmProcessorKwargs.fps as number } };
      }

      // Native JSON-schema guided decoding (see callWithPromptRaw for full
      // semantics; attached only when a schema + mode are provided).
      let transport: JsonSchemaTransport | undefined;
      if (jsonSchema && jsonSchemaMode !== false && jsonSchemaMode !== undefined) {
        transport = await this.resolveTransport(endpoint, model, enableThinking, jsonSchemaMode, apiKey);
        if (transport) {
          this.attachStructuredOutput(request, jsonSchema, transport, jsonSchemaName);
          // json_object has NO grammar constraint, so applyJsonObjectSampling instead
          // of applyStructuredSampling. This prevents repetition loops while still
          // producing valid JSON output.
          if (transport === "json_object") {
            this.applyJsonObjectSampling(request);
          } else {
            const structuredExtras = resolveStructuredExtras(model);
            this.applyStructuredSampling(request, structuredMaxTokens, structuredTemperature, structuredFrequencyPenalty, structuredRepetitionPenalty, structuredExtras.presencePenalty, structuredExtras.topP, structuredExtras.topK);
          }
        }
      }

      // repetition_detection: free-form calls get the caller-resolved defaults;
      // structured-output calls get the milder structured variant from the
      // config (large min_pattern_size). Small patterns false-positive on
      // legitimate JSON syntax repetition (table separators, array braces) and
      // truncate the document mid-JSON — deterministically, so same-seed
      // retries fail identically.
      if (repetitionDetection) {
        request.repetition_detection = transport
          ? getStructuredRepetitionDetection()
          : repetitionDetection;
      }

      // Pre-flight context budget: never ask for more than fits beside the
      // estimated input — cheap word/frame counting instead of an extra
      // tokenize round-trip (see input-estimation.ts). Applies to the initial
      // call and every caption-bump step. Media tokens only count when media
      // is actually attached (text-only calls pass no urls).
      request.max_tokens = Math.min(
        request.max_tokens ?? Number.MAX_SAFE_INTEGER,
        budgetCapForModel(
          resolveMaxInferenceContext(model),
          resolveEstimation(model),
          prompt,
          systemPrompt,
          urls.length > 0 ? mediaCategory : "audio",
          request.mm_processor_kwargs as Record<string, unknown> | undefined,
        ),
      );

      // endpoint is the per-call resolved base URL — always authoritative here
      const url = `${endpoint}/v1/chat/completions`;

      // Log request details BEFORE making the call so we can see what was sent
      // The actual [LLM-N] POST will come from timedLlmFetch after requestCounter is incremented
      console.log(`${reqPrefix} === callWithPrompt ===`);
      console.log(`${reqPrefix} URL: ${url}, Model: ${model}, Media: ${mediaCategory}, jsonSchemaMode=${jsonSchemaMode}`);
      // Log the effective sampling params so a repetition/stall is diagnosable
      // (e.g. a huge max_tokens lets a repetition loop run for many minutes).
      console.log(
        `${reqPrefix} params: max_tokens=${request.max_tokens} temperature=${request.temperature} top_p=${request.top_p} top_k=${request.top_k} presence_penalty=${request.presence_penalty} frequency_penalty=${request.frequency_penalty} repetition_penalty=${request.repetition_penalty} repetition_detection=${request.repetition_detection ? JSON.stringify(request.repetition_detection) : "off"} thinking=${enableThinking ?? false}`,
      );
      // Log the prompt text and URLs so we can diagnose garbage output
      console.log(`${reqPrefix} PROMPT: "${prompt}"`);
      console.log(`${reqPrefix} URLS: ${JSON.stringify(urls)}`);
      console.log(`${reqPrefix} systemPrompt: "${systemPrompt ?? "(none)"}"`);
      console.log(`${reqPrefix} openAIMessages: ${JSON.stringify(openAIMessages, null, 2)}`);
      console.log(`${reqPrefix} guided_json: ${request.guided_json ? JSON.stringify(request.guided_json) : "none"}`);
      console.log(`${reqPrefix} response_format: ${request.response_format ? JSON.stringify(request.response_format) : "none"}`);
      // Log the FULL request body that will be sent to the server
      console.log(`${reqPrefix} FULL REQUEST BODY: ${JSON.stringify(request, null, 2)}`);

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }

      const fetchStart = Date.now();
      const response = await timedLlmFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(request),
      }, model, mediaCategory);

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        // Log the raw server response immediately — the original HTTP body is
        // lost once we wrap it into a thrown Error (message gets buried).
        console.error(
          `[LLM] HTTP ${response.status} ${response.statusText} from ${url} (model=${model})\n` +
          `Response body: ${errorBody || "(empty)"}`,
        );
        // Original wire context for root-cause tracing (errors.json).
        const wire: WireContext = {
          requestBody: JSON.stringify(request),
          status: response.status,
          statusText: response.statusText,
          responseHeaders: Object.fromEntries(response.headers.entries()),
          responseBody: errorBody,
        };
        // MM encoder-cache overflow (video frames × per-frame tokens exceed the
        // server's pre-allocated encoder cache): retry with fewer frames (see
        // callWithPromptRaw for the full semantics).
        if (mediaCategory === "video" && (encoderCacheAttempt ?? 0) < 3) {
          const currentFrames = (mmProcessorKwargs?.num_frames as number) ?? 24;
          const frameClamp = parseEncoderCacheFrameClamp(errorBody, currentFrames);
          if (frameClamp !== null) {
            console.warn(
              `${reqPrefix} encoder-cache overflow — retrying with num_frames=${frameClamp} (dropping fps/do_sample_frames; was ${currentFrames})`,
            );
            recordNonFatalError(
              new Error(`mm encoder-cache overflow (HTTP ${response.status}), retrying with num_frames=${frameClamp}`),
              model,
              wire,
            );
            // fps/do_sample_frames removal: see callWithPromptRaw.
            return this.callWithPrompt(
              endpoint, model, apiKey, urls, prompt, mediaCategory,
              hyperparams, systemPrompt, enableThinking,
              { ...mmProcessorKwargsOverride, fps: undefined, do_sample_frames: undefined, num_frames: frameClamp },
              jsonSchema, jsonSchemaMode, structuredMaxTokens, structuredTemperature,
              structuredFrequencyPenalty, structuredRepetitionPenalty,
              jsonSchemaName, repetitionDetection,
              (encoderCacheAttempt ?? 0) + 1,
            );
          }
        }
        // Context overflow despite the pre-flight estimate (estimation miss):
        // bounded halving ladder. Video first halves the frame rate (input
        // kappen — output budget preserved), then the output budget is halved.
        // Text calls only halve the output budget; prompt content is never cut.
        const isContextOverflow =
          /maximum context length is \d+ tokens/.test(errorBody) ||
          /max_tokens=\d+ cannot be greater than max_model_len/.test(errorBody);
        if (isContextOverflow && (contextHalveAttempt ?? 0) < 4) {
          const attempt = contextHalveAttempt ?? 0;
          if (mediaCategory === "video" && attempt < 2) {
            const currentFps = (mmProcessorKwargs?.fps as number) ?? 1;
            const halvedFps = currentFps / 2;
            console.warn(`${reqPrefix} context overflow — halving input frames fps=${currentFps} → ${halvedFps}`);
            recordNonFatalError(
              new Error(`context overflow (HTTP ${response.status}), halving input frames fps=${currentFps} → ${halvedFps}`),
              model,
              wire,
            );
            return this.callWithPrompt(
              endpoint, model, apiKey, urls, prompt, mediaCategory,
              hyperparams, systemPrompt, enableThinking,
              { ...mmProcessorKwargsOverride, fps: halvedFps },
              jsonSchema, jsonSchemaMode, structuredMaxTokens, structuredTemperature,
              structuredFrequencyPenalty, structuredRepetitionPenalty,
              jsonSchemaName, repetitionDetection, encoderCacheAttempt,
              attempt + 1,
            );
          }
          const halvedMax = Math.max(MIN_OUTPUT_TOKENS, Math.floor((request.max_tokens ?? 122000) / 2));
          console.warn(`${reqPrefix} context overflow — halving max_tokens=${request.max_tokens} → ${halvedMax}`);
          recordNonFatalError(
            new Error(`context overflow (HTTP ${response.status}), halving max_tokens=${request.max_tokens} → ${halvedMax}`),
            model,
            wire,
          );
          return this.callWithPrompt(
            endpoint, model, apiKey, urls, prompt, mediaCategory,
            { ...hyperparams, max_tokens: halvedMax },
            systemPrompt, enableThinking, mmProcessorKwargsOverride,
            jsonSchema, jsonSchemaMode, structuredMaxTokens, structuredTemperature,
            structuredFrequencyPenalty, structuredRepetitionPenalty,
            jsonSchemaName, repetitionDetection, encoderCacheAttempt,
            attempt + 1,
          );
        }
        throw Object.assign(
          new Error(`API request failed: ${response.status} ${response.statusText}${errorBody ? `\n${errorBody}` : ""}`),
          { wire },
        );
      }

      const responseData: OpenAIChatResponse = await response.json();
      // Free-form captioning truncation bump: a caption cut by max_tokens is
      // retried with a doubled budget up to the model's resolved
      // maxInferenceContext instead of silently returning partial content. The
      // max_tokens check is the recursion guard — at the ceiling the partial
      // caption is returned (a partial result beats no segment result).
      // Structured calls (transport attached) are NOT bumped here — their typed
      // TruncatedStructuredOutputError path lives in callWithPromptRaw/callJson.
      const captionFinishReason = responseData.choices?.[0]?.finish_reason;
      const maxInferenceContext = resolveMaxInferenceContext(model);
      if (captionFinishReason === "length" && !transport && (request.max_tokens ?? 0) < maxInferenceContext) {
        const bumped = Math.min((request.max_tokens ?? 16384) * 2, maxInferenceContext);
        console.warn(`${reqPrefix} caption truncated at max_tokens=${request.max_tokens} — retrying with ${bumped}`);
        recordNonFatalError(
          new Error(`caption truncated (finish_reason "length") at max_tokens=${request.max_tokens}, retrying with ${bumped}`),
          model,
        );
        return this.callWithPrompt(
          endpoint, model, apiKey, urls, prompt, mediaCategory,
          { ...hyperparams, max_tokens: bumped },
          systemPrompt, enableThinking, mmProcessorKwargsOverride,
          jsonSchema, jsonSchemaMode, structuredMaxTokens, structuredTemperature,
          structuredFrequencyPenalty, structuredRepetitionPenalty,
          jsonSchemaName, repetitionDetection, encoderCacheAttempt, contextHalveAttempt,
        );
      }
      const content = responseData.choices?.[0]?.message?.content || "";
      // Surface backend token accounting (see RawCallResult).
      const usage = responseData.usage ?? undefined;
      recordTokenUsage(usage);
      recordVlmRequest({
        // requestCounter was incremented by timedLlmFetch → matches the
        // "[LLM-N] POST … → HTTP" completion line in the processing log
        id: `LLM-${requestCounter}`,
        model,
        inputTokens: usage?.prompt_tokens ?? 0,
        outputTokens: usage?.completion_tokens ?? 0,
        maxTokens: request.max_tokens ?? null,
        totalTokens: usage?.total_tokens ?? (usage ? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0) : 0),
        timeElapsedSecs: (Date.now() - fetchStart) / 1000,
      });
      const wrap = (s: string): RawCallResult => ({ content: s, usage });

      // Log the full raw LLM response for debugging (mirrors FULL REQUEST BODY logging)
      console.log(`${reqPrefix} FULL RESPONSE: ${content}`);

      // Only attempt JSON parsing if content looks like JSON (starts with { or [ or ```)
      const trimmed = content.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith("```")) {
        try {
          const parsed = this.extractAndParseJson(content);
          // For speech/ASR, return the transcription text; for others return desc or raw JSON
          if (typeof parsed === "object") {
            if (parsed.transcription) {
              console.log(`[LLM] caption (transcription)=${parsed.transcription}`);
              return wrap(parsed.transcription);
            }
            if (parsed.desc) {
              console.log(`[LLM] caption (desc)=${parsed.desc}`);
              return wrap(parsed.desc);
            }
            if (parsed.text) {
              console.log(`[LLM] caption (text)=${parsed.text}`);
              return wrap(parsed.text);
            }
            const jsonStr = JSON.stringify(parsed);
            console.log(`[LLM] caption (json)=${jsonStr}`);
            return wrap(jsonStr);
          }
          const str = String(parsed);
          console.log(`[LLM] caption (parsed)=${str}`);
          return wrap(str);
        } catch {
          console.log(`[LLM] caption (raw)=${content}`);
          return wrap(content);
        }
      }

      console.log(`[LLM] caption=${content}`);
      return wrap(content);
    } catch (error) {
      // Extract message + stack explicitly: console.error("label", errObj)
      // renders {} for Error instances (no enumerable own properties).
      const errMsg = error instanceof Error ? error.message : String(error);
      const errStack = error instanceof Error ? error.stack : "";
      console.error(`=== callWithPrompt Error ===\n${errMsg}${errStack ? `\n${errStack}` : ""}`);
      throw new Error(`callWithPrompt failed: ${errMsg}`);
    }
  }

  /**
   * Same contract as callWithPrompt() but returns the raw model response string
   * without any JSON parsing or content normalization.
   * This is the transport under the v3 plugin API: callRaw passes the string
   * through, callJson runs its Yup validate/correction retry loop on top
   * (post-processing/plugin-api.ts:150,245). Two typed errors are part of the
   * contract and are rethrown unwrapped so callJson can react precisely:
   * TruncatedStructuredOutputError (bump max_tokens, retry) and
   * JsonSchemaUnsupportedError (fail fast under explicit mode). Context-length
   * overflows are retried INTERNALLY by clamping max_tokens (see
   * parseContextLengthClamp) — transparent to callers.
   */
  public async callWithPromptRaw(
    endpoint: string,
    model: string,
    apiKey: string | undefined,
    urls: string[],
    prompt: string,
    mediaCategory: "audio" | "video" | "image",
    hyperparams?: Record<string, unknown>,
    systemPrompt?: string,
    enableThinking?: boolean,
    /** Config-driven overrides merged on top of the media-type defaults */
    mmProcessorKwargsOverride?: Record<string, unknown>,
    /** JSON Schema for native guided decoding. Attached only when jsonSchemaMode is set. */
    jsonSchema?: Record<string, unknown>,
    /** Transport selection: "auto" (probe) | explicit mode | false/undefined (off). */
    jsonSchemaMode?: JsonSchemaMode,
    /** Structured-output overrides from ModelConfig.structuredOutput. */
    structuredMaxTokens?: number,
    structuredTemperature?: number,
    structuredFrequencyPenalty?: number,
    structuredRepetitionPenalty?: number,
    /** Name for response_format.json_schema.name (response_format transport only). */
    jsonSchemaName?: string,
    /** Resolved vLLM repetition_detection (undefined = omit from request). */
    repetitionDetection?: RepetitionDetectionConfig,
    /** Internal: nth context-length clamp retry (drives the exponential margin). */
    contextClampAttempt?: number,
    /** Internal: nth mm-encoder-cache frame clamp retry. */
    encoderCacheAttempt?: number,
    /** Internal: nth caller-driven schema retry — relaxes repetition_detection. */
    repetitionRelaxAttempt?: number,
  ): Promise<RawCallResult> {
    // Generate request ID at the START so all logs can use it
    const reqId = ++requestCounter;
    const reqPrefix = `[LLM-${reqId}]`;

    try {
      const mediaType = mediaCategory === "image" ? "image" as const
        : mediaCategory === "video" ? "video" as const
          : "audio" as const;

      const messages: InternalChatMessage[] = [];

      // Add system prompt if provided
      if (systemPrompt) {
        messages.push({
          role: "system",
          content: [{ type: "text", text: systemPrompt }],
        });
      }

      messages.push({
        role: "user",
        content: [
          { type: "text", text: prompt },
          ...await Promise.all(urls.map(async (url) => ({
            type: mediaType,
            [mediaType]: mediaType === "image" ? await this.toValidImageUrl(url) : this.toValidRemoteUrl(url),
          }))),
        ],
      });

      const openAIMessages = this.convertToOpenAIFormat(messages);

      // Merge media-type defaults with config-driven overrides (overrides win)
      const mmProcessorKwargs = resolveMmProcessorKwargs(mediaCategory, mmProcessorKwargsOverride);

      const request: OpenAIChatRequest = {
        model,
        messages: openAIMessages,
        temperature: (hyperparams?.temperature as number) ?? 1e-2,
        top_p: (hyperparams?.top_p as number) ?? 0.1,
        top_k: (hyperparams?.top_k as number) ?? 1,
        // Free-form default when the caller sets no max_tokens: capped below the
        // model's resolved ceiling with 4k input headroom, so reduced-window
        // deployments (--max-model-len 65536) don't hard-400. Configured
        // hyperparams.max_tokens pass through untouched (bump ladder intact).
        max_tokens: (hyperparams?.max_tokens as number) ?? Math.min(122000, resolveMaxInferenceContext(model) - 4096),
        presence_penalty: (hyperparams?.presence_penalty as number) ?? 0,
        // REFACTOR(consistency): hardcoded 0.1/1.0 here vs the CAPTION_FREQUENCY_PENALTY/CAPTION_REPETITION_PENALTY constants (0.1/1.05) used by callWithPrompt (:993-994) for the same free-form-generation concept. Either share the constants or document why raw calls must start with no repetition penalty.
        frequency_penalty: (hyperparams?.frequency_penalty as number) ?? 0.1,
        repetition_penalty: (hyperparams?.repetition_penalty as number) ?? 1.0,
        seed: (hyperparams?.seed as number) ?? DEFAULT_SEED,
        documents: [],
        chat_template_kwargs: {
          add_generation_prompt: true,
          tokenize: false,
          enable_thinking: enableThinking ?? false,
        },
        mm_processor_kwargs: mmProcessorKwargs,
      };

      // Forward the configured video fps as a MediaIO override — the only
      // frame-sampling knob this server honors (see OpenAIChatRequest).
      if (mediaCategory === "video" && typeof mmProcessorKwargs?.fps === "number") {
        request.media_io_kwargs = { video: { fps: mmProcessorKwargs.fps as number } };
      }

      // Native JSON-schema guided decoding: resolve the transport (probe for
      // "auto", honor explicit mode) and attach it as a top-level body field.
      let transport: JsonSchemaTransport | undefined;
      if (jsonSchema && jsonSchemaMode !== false && jsonSchemaMode !== undefined) {
        transport = await this.resolveTransport(endpoint, model, enableThinking, jsonSchemaMode, apiKey);
        if (transport) {
          this.attachStructuredOutput(request, jsonSchema, transport, jsonSchemaName);
          // json_object has NO grammar constraint, so applyJsonObjectSampling instead
          // of applyStructuredSampling. This prevents repetition loops while still
          // producing valid JSON output.
          if (transport === "json_object") {
            this.applyJsonObjectSampling(request);
          } else {
            const structuredExtras = resolveStructuredExtras(model);
            this.applyStructuredSampling(request, structuredMaxTokens, structuredTemperature, structuredFrequencyPenalty, structuredRepetitionPenalty, structuredExtras.presencePenalty, structuredExtras.topP, structuredExtras.topK);
          }
        }
      }

      // repetition_detection: free-form calls get the caller-resolved defaults;
      // structured-output calls get the milder structured variant from the
      // config (large min_pattern_size). Small patterns false-positive on
      // legitimate JSON syntax repetition (table separators, array braces) and
      // truncate the document mid-JSON — deterministically, so same-seed
      // retries fail identically.
      if (repetitionDetection) {
        request.repetition_detection = relaxRepetitionDetection(
          transport ? getStructuredRepetitionDetection() : repetitionDetection,
          repetitionRelaxAttempt ?? 0,
        );
      }

      // endpoint is the per-call resolved base URL — always authoritative here
      const url = `${endpoint}/v1/chat/completions`;

      console.log(`${reqPrefix} === callWithPromptRaw ===`);
      console.log(`${reqPrefix} URL: ${url}, Model: ${model}, Media: ${mediaCategory}, JSON transport: ${transport ?? "off"}`);
      console.log(`${reqPrefix} FILES: ${urls.map(u => this.toValidRemoteUrl(u)).join(', ')}`);
      console.log(
        `${reqPrefix} params: max_tokens=${request.max_tokens} temperature=${request.temperature} top_p=${request.top_p} top_k=${request.top_k} presence_penalty=${request.presence_penalty} frequency_penalty=${request.frequency_penalty} repetition_penalty=${request.repetition_penalty} repetition_detection=${request.repetition_detection ? JSON.stringify(request.repetition_detection) : "off"} thinking=${enableThinking ?? false}`,
      );
      // Log the full request messages so we can see exactly what was sent
      console.log(`${reqPrefix} messages: ${JSON.stringify(request.messages, null, 2)}`);
      const reqAny = request as unknown as Record<string, unknown>;
      console.log(`${reqPrefix} guided_json: ${reqAny.guided_json ? JSON.stringify(reqAny.guided_json) : "none"}`);
      console.log(`${reqPrefix} response_format: ${reqAny.response_format ? JSON.stringify(reqAny.response_format) : "none"}`);
      // Log the FULL request body that will be sent to the server
      console.log(`${reqPrefix} FULL REQUEST BODY: ${JSON.stringify(request, null, 2)}`);

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }

      const fetchStart = Date.now();
      const response = await timedLlmFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(request),
      }, model, mediaCategory);

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        // Log the raw server response IMMEDIATELY so the actual rejection reason
        // (e.g. vLLM Pydantic validation error, unsupported field) is never lost
        // to downstream error wrapping. This is the only place we still have the
        // original HTTP body — everything below only sees a wrapped Error.
        console.error(
          `[LLM] HTTP ${response.status} ${response.statusText} from ${url} (model=${model})\n` +
          `Response body: ${errorBody || "(empty)"}`,
        );
        // Original wire context for root-cause tracing (errors.json).
        const wire: WireContext = {
          requestBody: JSON.stringify(request),
          status: response.status,
          statusText: response.statusText,
          responseHeaders: Object.fromEntries(response.headers.entries()),
          responseBody: errorBody,
        };
        // MM encoder-cache overflow (video frames × per-frame tokens exceed the
        // server's pre-allocated encoder cache): retry with fewer frames. The
        // server reports both numbers (actual N, limit C), so the frame budget
        // is computed exactly — strictly decreasing, no loop.
        if (mediaCategory === "video" && (encoderCacheAttempt ?? 0) < 3) {
          const currentFrames = (mmProcessorKwargs?.num_frames as number) ?? 24;
          const frameClamp = parseEncoderCacheFrameClamp(errorBody, currentFrames);
          if (frameClamp !== null) {
            console.warn(
              `${reqPrefix} encoder-cache overflow — retrying with num_frames=${frameClamp} (dropping fps/do_sample_frames; was ${currentFrames})`,
            );
            // Non-fatal: an internal clamp-and-retry (the run continues with fewer frames).
            recordNonFatalError(
              new Error(`mm encoder-cache overflow (HTTP ${response.status}), retrying with num_frames=${frameClamp}`),
              model,
              wire,
            );
            // fps and do_sample_frames are REMOVED (undefined keys are dropped by
            // JSON.stringify): a set fps takes precedence over num_frames, and
            // do_sample_frames:false disables sampling entirely (native decode of
            // all frames) — both would keep the token count at the overflow level.
            return this.callWithPromptRaw(
              endpoint, model, apiKey, urls, prompt, mediaCategory,
              hyperparams, systemPrompt, enableThinking,
              { ...mmProcessorKwargsOverride, fps: undefined, do_sample_frames: undefined, num_frames: frameClamp },
              jsonSchema, jsonSchemaMode, structuredMaxTokens, structuredTemperature,
              structuredFrequencyPenalty, structuredRepetitionPenalty,
              jsonSchemaName, repetitionDetection, contextClampAttempt,
              (encoderCacheAttempt ?? 0) + 1,
              repetitionRelaxAttempt,
            );
          }
        }
        // Context-length overflow: the server reports the exact budget, so
        // retry with max_tokens clamped to fit. Prompts grow with video length,
        // so a static default can always overflow. The reported input count is
        // a lower bound (media tokens are undercounted), hence an exponential
        // margin per attempt (1k, 8k, 64k, …) — strictly decreasing, so no loop.
        const clamp = parseContextLengthClamp(errorBody, 1024 * 8 ** (contextClampAttempt ?? 0));
        if (clamp !== null && clamp < (request.max_tokens ?? Infinity)) {
          console.warn(
            `${reqPrefix} context-length overflow — retrying with max_tokens=${clamp} (was ${request.max_tokens})`,
          );
          // Non-fatal: an internal clamp-and-retry (the run continues with a smaller budget).
          recordNonFatalError(
            new Error(`context-length overflow (HTTP ${response.status}), retrying with max_tokens=${clamp}`),
            model,
            wire,
          );
          return this.callWithPromptRaw(
            endpoint, model, apiKey, urls, prompt, mediaCategory,
            { ...hyperparams, max_tokens: clamp },
            systemPrompt, enableThinking, mmProcessorKwargsOverride, jsonSchema,
            jsonSchemaMode, structuredMaxTokens, structuredTemperature,
            structuredFrequencyPenalty, structuredRepetitionPenalty, jsonSchemaName,
            repetitionDetection,
            (contextClampAttempt ?? 0) + 1,
            encoderCacheAttempt,
            repetitionRelaxAttempt,
          );
        }
        // If the structured-output transport was rejected (typically HTTP 400
        // naming the field), surface a typed error. Under explicit mode the
        // caller fails fast; under "auto" the probe should have avoided this.
        if (transport && /response_format|structured_outputs|guided_json|structured/i.test(errorBody)) {
          throw Object.assign(
            new JsonSchemaUnsupportedError(
              endpoint,
              transport,
              `Backend rejected JSON-schema transport "${transport}" (HTTP ${response.status}): ${errorBody}`,
            ),
            { wire },
          );
        }
        throw Object.assign(
          new Error(`API request failed: ${response.status} ${response.statusText}${errorBody ? `\n${errorBody}` : ""}`),
          { wire },
        );
      }

      const responseData: OpenAIChatResponse = await response.json();

      // Constrained decoding can still truncate at max_tokens; never run the
      // loose parser on a truncated structured response — surface a retryable
      // error so callJson can bump max_tokens and retry.
      const finishReason = responseData.choices?.[0]?.finish_reason;
      if (transport && finishReason === "length") {
        throw new TruncatedStructuredOutputError(request.max_tokens);
      }

      const content = responseData.choices?.[0]?.message?.content || "";

      // Post-hoc whitespace-run detector (structured calls only): a huge blank
      // block (200+ consecutive whitespace chars — tab/space runs observed at
      // 500-2000+ under load) makes the JSON unparseable downstream anyway.
      // Treat it like truncation so callJson takes the bump-retry path instead
      // of the looser parse-failure correction. Markdown tables stay far below
      // the 200-char threshold (cell gaps are a few spaces, indentation ≤ ~32).
      if (transport && /\s{200,}/.test(content)) {
        console.warn(`${reqPrefix} whitespace-run detected in structured response (≥200 consecutive ws chars) — treating as truncation`);
        throw new TruncatedStructuredOutputError(request.max_tokens);
      }

      // Log the full raw LLM response for debugging (mirrors FULL REQUEST BODY logging)
      console.log(`${reqPrefix} FULL RESPONSE: ${content}`);

      // Return raw content without JSON parsing/normalization, plus backend token usage.
      const usageRaw = responseData.usage ?? undefined;
      recordTokenUsage(usageRaw);
      recordVlmRequest({
        // requestCounter was incremented by timedLlmFetch → matches the
        // "[LLM-N] POST … → HTTP" completion line in the processing log
        id: `LLM-${requestCounter}`,
        model,
        inputTokens: usageRaw?.prompt_tokens ?? 0,
        outputTokens: usageRaw?.completion_tokens ?? 0,
        maxTokens: request.max_tokens ?? null,
        totalTokens: usageRaw?.total_tokens ?? (usageRaw ? (usageRaw.prompt_tokens ?? 0) + (usageRaw.completion_tokens ?? 0) : 0),
        timeElapsedSecs: (Date.now() - fetchStart) / 1000,
      });
      return { content, usage: usageRaw };
    } catch (error) {
      // Extract message + stack explicitly: console.error("label", errObj)
      // renders {} for Error instances (no enumerable own properties), making
      // the actual failure invisible in structured/captured log output.
      const errMsg = error instanceof Error ? error.message : String(error);
      const errStack = error instanceof Error ? error.stack : "";
      console.error(`=== callWithPromptRaw Error ===\n${errMsg}${errStack ? `\n${errStack}` : ""}`);
      // Preserve typed errors so callers (callJson retry loop, probes) can
      // react precisely instead of seeing an opaque wrapped message.
      if (
        error instanceof JsonSchemaUnsupportedError ||
        error instanceof TruncatedStructuredOutputError
      ) {
        throw error;
      }
      // Keep any attached wire context across the wrap so recordNonFatalError
      // can still file it into errors.json.
      const wire = (error as { wire?: WireContext } | null)?.wire;
      throw Object.assign(new Error(`callWithPromptRaw failed: ${errMsg}`), wire ? { wire } : {});
    }
  }

  // ==========================================================================
  // ASR transcription. Three protocols, selected per model via
  // ModelConfig.asrProtocol:
  // - "openai-chat" (default): OpenAI-compatible POST /v1/chat/completions with audio_url
  // - "whisper-transcribe": legacy Whisper-style multipart POST /transcribe
  // - "openai-transcriptions": OpenAI Audio API multipart POST /v1/audio/transcriptions
  // ==========================================================================

  /**
   * Transcribe audio files via an ASR server. The API protocol is selected per
   * model via ModelConfig.asrProtocol (default: OpenAI-compatible chat API).
   * The default "openai-chat" branch below sends file:// audio_url parts and
   * reads the transcription from message.content — or the non-standard
   * message.reasoning, which is where Qwen3-ASR servers put it. Called by
   * WorkflowEngine's asr-api path (workflow-engine.ts:1690) and captionSound.
   * @param endpoint Base URL of the ASR server (e.g. "http://127.0.0.1:8932")
   * @param filePaths Absolute paths to audio files on disk (host paths)
   * @param language Optional language code (e.g. "de", "en"). Omit for auto-detect.
   * @param modelName Model identifier for protocol resolution/logging; when
   *   omitted, the configured default workflow's speech-step (ASR) model is
   *   used (see resolveDefaultModelName). Unknown names fall back to the
   *   "openai-chat" protocol (ad-hoc calls).
   * @param resolvedModel Actual model name for the API (e.g. "Qwen/Qwen3-ASR-0.6B")
   * @param apiKey Bearer token for authentication
   * @returns The transcribed text (multiple files joined with newlines)
   */
  public async transcribeQwen3Asr(
    endpoint: string,
    filePaths: string[],
    language?: string,
    modelName?: string,
    resolvedModel?: string,
    apiKey?: string,
    /** Audio length in seconds (segment duration) — recorded into asr-requests.json. */
    audioLengthSecs?: number,
  ): Promise<RawCallResult> {
    if (!filePaths || filePaths.length === 0) {
      throw new Error("transcribeQwen3Asr: no audio file paths provided");
    }
    modelName = modelName ?? this.resolveDefaultModelName("asr");

    // Protocol branch: ASR backends speak different APIs (ModelConfig.asrProtocol).
    let asrProtocol: "openai-chat" | "whisper-transcribe" | "openai-transcriptions" = "openai-chat";
    try {
      asrProtocol = getModel(modelName).asrProtocol ?? "openai-chat";
    } catch {
      // model not in config (ad-hoc call) → default to OpenAI-compatible
    }
    if (asrProtocol === "whisper-transcribe") {
      // No token metadata on the multipart protocols — only openai-chat reports usage.
      return { content: await this.transcribeViaTranscribeEndpoint(endpoint, filePaths, language, apiKey, resolvedModel ?? modelName, audioLengthSecs) };
    }
    if (asrProtocol === "openai-transcriptions") {
      return { content: await this.transcribeViaAudioTranscriptions(endpoint, filePaths, language, resolvedModel ?? modelName, apiKey, audioLengthSecs) };
    }

    try {
      console.log(`=== transcribeQwen3Asr ===`);
      console.log(`Endpoint: ${endpoint}, Files: ${filePaths.join(", ")}, Language: ${language ?? "auto"}`);
      console.log(`Model: ${resolvedModel ?? modelName}`);

      // Build OpenAI-compatible chat request with audio_url using file:// paths
      // The file:// prefix allows the ASR server to read local files directly.
      // Host paths under the sample_data tree are rewritten to the container's
      // /sample_data mount; anything else is passed through and will fail
      // server-side.
      const messages = filePaths.map(filePath => ({
        role: "user" as const,
        content: [{
          type: "audio_url" as const,
          audio_url: { url: `file://${toSampleDataContainerPath(filePath)}` }
        }]
      }));

      const requestBody = {
        model: resolvedModel ?? modelName,
        messages,
        ...(language && { language }),
      };

      const url = `${endpoint}/v1/chat/completions`;
      console.log(`POST ${url}`);

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }

      // Use standard timedLlmFetch with longFetch for proper timeout handling
      const fetchStart = Date.now();
      const response = await timedLlmFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
      }, modelName, "audio");

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        let detail = "";
        try {
          const parsed = JSON.parse(errorBody);
          if (parsed.detail !== undefined && parsed.detail !== null) {
            detail = typeof parsed.detail === "string"
              ? parsed.detail
              : JSON.stringify(parsed.detail);
          }
        } catch { /* not JSON */ }
        const reason = detail || `${response.status} ${response.statusText}`;
        throw new Error(`Qwen3-ASR service error: ${reason} (HTTP ${response.status})`);
      }

      const responseData: OpenAIChatResponse = await response.json();
      // ASR server returns transcription in reasoning field, not content
      // Response format: "language <lang_code><asr_text>transcription text"
      // Example: "language German<asr_text>Das ist ein Referenztext."
      const message = responseData.choices?.[0]?.message;
      const rawContent = message?.content || message?.reasoning || "";

      // Extract the actual transcription text after <asr_text> tag
      // The language prefix is preserved in the raw format for reference
      const asrTextMatch = rawContent.match(/<asr_text>([\s\S]*)/);
      const content = asrTextMatch && asrTextMatch[1] ? asrTextMatch[1].trim() : rawContent;

      console.log(`[ASR] transcription=${content}`);

      if (!content) {
        throw new Error("Qwen3-ASR returned empty transcription");
      }

      const asrUsage = responseData.usage ?? undefined;
      recordTokenUsage(asrUsage);
      recordAsrRequest({
        model: resolvedModel ?? modelName,
        lengthInMins: audioLengthSecs != null ? audioLengthSecs / 60 : null,
        timeElapsedSecs: (Date.now() - fetchStart) / 1000,
      });
      // ASR requests are recorded ONLY in asr-requests.json — never in
      // vlm-requests.json (VLM-only artifact; an ASR model in the mix turned
      // the file-level model field to "mixed" and skewed per-type stats).
      return { content, usage: asrUsage };
    } catch (error) {
      console.error("=== transcribeQwen3Asr Error ===");
      console.error(`Endpoint: ${endpoint}`);
      console.error(`Files: ${filePaths.join(", ")}`);
      console.error(`Language: ${language ?? "auto"}`);
      console.error(`Model: ${resolvedModel ?? modelName}`);
      console.error(`Error:`, error);
      if (error instanceof Error) {
        console.error(`Error message: ${error.message}`);
        console.error(`Error stack: ${error.stack || "no stack"}`);
      }
      throw new Error(`transcribeQwen3Asr failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Legacy Whisper-style ASR: multipart POST /transcribe with the audio files
   * as FormData parts (ModelConfig.asrProtocol = "whisper-transcribe").
   *
   * MUST use the global fetch, NOT longFetch: longFetch's undici Agent drops
   * the multipart `files` part.
   */
  private async transcribeViaTranscribeEndpoint(
    endpoint: string,
    filePaths: string[],
    language?: string,
    apiKey?: string,
    model?: string,
    audioLengthSecs?: number,
  ): Promise<string> {
    try {
      console.log(`=== transcribeViaTranscribeEndpoint ===`);
      console.log(`Endpoint: ${endpoint}, Files: ${filePaths.join(", ")}, Language: ${language ?? "auto"}`);

      const formData = new FormData();
      for (const filePath of filePaths) {
        const fileBuffer = await readFile(filePath);
        formData.append("files", new Blob([fileBuffer as unknown as BlobPart]), basename(filePath));
      }

      const url = new URL("/transcribe", endpoint);
      if (language) {
        url.searchParams.set("language", language);
      }
      console.log(`POST ${url.toString()}`);

      const headers: Record<string, string> = {};
      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }

      // REFACTOR(magic): AbortSignal.timeout(43_200_000) is the ~12h timeout the module header (top of file) says was eliminated because a hung endpoint stalls the whole pipeline for hours — also at :1582. Use resolveRequestTimeoutMs(modelName) or at least a named ASR-upload constant. (Global fetch is still required for multipart — see the docblock above — only the timeout should change.)
      const fetchStart = Date.now();
      const response = await fetch(url.toString(), {
        method: "POST",
        headers,
        body: formData,
        signal: AbortSignal.timeout(43_200_000),
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        throw new Error(`ASR /transcribe request failed: ${response.status} ${response.statusText}${errorBody ? `\n${errorBody}` : ""}`);
      }

      const results: Array<{ text: string; language?: string }> = await response.json();
      if (!results || results.length === 0) {
        throw new Error("ASR /transcribe returned empty results");
      }
      recordAsrRequest({
        model: model ?? "unknown",
        lengthInMins: audioLengthSecs != null ? audioLengthSecs / 60 : null,
        timeElapsedSecs: (Date.now() - fetchStart) / 1000,
      });
      console.log(`[ASR] transcription=${results[0].text}`);
      return results[0].text;
    } catch (error) {
      console.error("=== transcribeViaTranscribeEndpoint Error ===", error);
      throw new Error(`transcribeViaTranscribeEndpoint failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * OpenAI Audio API: multipart POST /v1/audio/transcriptions with one `file`
   * part per request (ModelConfig.asrProtocol = "openai-transcriptions").
   * Form fields: file, model, response_format="json", optional language.
   * Response: `{ "text": "..." }`. Multiple input files are transcribed one
   * request per file and joined with newlines (the API takes a single file).
   *
   * MUST use the global fetch, NOT longFetch: longFetch's undici Agent drops
   * the multipart `file` part.
   */
  private async transcribeViaAudioTranscriptions(
    endpoint: string,
    filePaths: string[],
    language: string | undefined,
    model: string,
    apiKey?: string,
    audioLengthSecs?: number,
  ): Promise<string> {
    const MIME_BY_EXT: Record<string, string> = {
      ".wav": "audio/wav",
      ".mp3": "audio/mpeg",
      ".m4a": "audio/mp4",
      ".ogg": "audio/ogg",
      ".flac": "audio/flac",
      ".webm": "audio/webm",
    };

    const transcriptions: string[] = [];
    for (const filePath of filePaths) {
      try {
        console.log(`=== transcribeViaAudioTranscriptions ===`);
        console.log(`Endpoint: ${endpoint}, File: ${filePath}, Language: ${language ?? "auto"}, Model: ${model}`);

        const fileBuffer = await readFile(filePath);
        const mimeType = MIME_BY_EXT[extname(filePath).toLowerCase()] ?? "application/octet-stream";

        const formData = new FormData();
        formData.append("file", new Blob([fileBuffer as unknown as BlobPart], { type: mimeType }), basename(filePath));
        formData.append("model", model);
        formData.append("response_format", "json");
        if (language) {
          formData.append("language", language);
        }

        const url = buildEndpointUrl(endpoint, "v1/audio/transcriptions");
        console.log(`POST ${url}`);

        const headers: Record<string, string> = {};
        if (apiKey) {
          headers["Authorization"] = `Bearer ${apiKey}`;
        }

        const fetchStart = Date.now();
        const response = await fetch(url, {
          method: "POST",
          headers,
          body: formData,
          // 12h timeout — same issue as the REFACTOR(magic) note in transcribeViaTranscribeEndpoint (:1507).
          signal: AbortSignal.timeout(43_200_000),
        });

        if (!response.ok) {
          const errorBody = await response.text().catch(() => "");
          throw new Error(`ASR /v1/audio/transcriptions request failed: ${response.status} ${response.statusText}${errorBody ? `\n${errorBody}` : ""}`);
        }

        const result: { text?: unknown } = await response.json();
        if (typeof result.text !== "string") {
          throw new Error(`ASR /v1/audio/transcriptions returned unexpected response (no "text" field): ${JSON.stringify(result).slice(0, 200)}`);
        }
        recordAsrRequest({
          model,
          lengthInMins: audioLengthSecs != null ? audioLengthSecs / 60 : null,
          timeElapsedSecs: (Date.now() - fetchStart) / 1000,
        });
        console.log(`[ASR] transcription=${result.text}`);
        transcriptions.push(result.text);
      } catch (error) {
        console.error("=== transcribeViaAudioTranscriptions Error ===", error);
        throw new Error(`transcribeViaAudioTranscriptions failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return transcriptions.join("\n");
  }
}
