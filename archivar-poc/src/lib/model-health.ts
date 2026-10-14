/**
 * Model health checks - shared between the /health endpoint and HealthApi (RPC).
 *
 * Runs a minimal REAL inference call per configured model:
 * - "api" models: a tiny chat-completion (optionally with test media attached)
 * - "asr-api" models: a real transcription request in the model's configured
 *   protocol (asrProtocol: openai-chat chat/completions with audio_url,
 *   whisper-transcribe multipart /transcribe, or openai-transcriptions
 *   multipart /v1/audio/transcriptions)
 * - "tool" models: tool directory/script existence
 * Also checks the pre-processing tools (segment-temporal, segment-scenes).
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { getEnv } from "defuss-env";
import { getArchivarConfig, getModel } from "./archivar-config";
import { buildEndpointUrl } from "./asr-url";
import { toSampleDataContainerPath } from "./sample-data-path";
import type { ArchivarConfig } from "./workflow-types";

// Test data files
// VLMs run in Docker -> container path /sample_data/archivar/test_data/
// ASR is probed with the absolute host path (converted to the container's
// /sample_data mount before the request).
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");
const TEST_DATA_DIR_VLM = "/sample_data/archivar/test_data";
const TEST_DATA_DIR_HOST = join(PROJECT_ROOT, "..", "sample_data", "archivar", "test_data");

const TEST_FILES_VLM = {
  video: join(TEST_DATA_DIR_VLM, "test.mp4"),
  audio: join(TEST_DATA_DIR_VLM, "test.mp3"),
  keyframe: join(TEST_DATA_DIR_VLM, "test_kf.png"),
  image: join(TEST_DATA_DIR_VLM, "test_kf.png"),
};

const TEST_FILES_HOST = {
  video: join(TEST_DATA_DIR_HOST, "test.mp4"),
  audio: join(TEST_DATA_DIR_HOST, "test.mp3"),
  keyframe: join(TEST_DATA_DIR_HOST, "test_kf.png"),
  image: join(TEST_DATA_DIR_HOST, "test_kf.png"),
};

/**
 * Result of probing one model. The flags form a ladder — each is only
 * meaningful when the previous holds: reachable (endpoint answered) →
 * authorized (no 401/403) → model_present (backend did not report an unknown
 * model) → ok (a real inference response came back). Consumed by GET /health
 * and HealthApi.checkModels (CLI `health`).
 */
export interface ModelHealthCheck {
  ok: boolean;
  /** True when the model is not referenced by any workflow — reported, but
   *  never probed and ignored by the aggregate status. */
  skipped?: boolean;
  reachable: boolean;
  authorized: boolean;
  model_present: boolean;
  base_url: string;
  required_model: string;
  status_code?: number;
  error?: string;
}

/** Aggregate probe result: "ok" = all used models healthy, "degraded" = at
 *  least one check ok but not all, "error" = nothing healthy. */
export interface HealthResponse {
  status: "ok" | "degraded" | "error";
  checks: Record<string, ModelHealthCheck>;
}

/**
 * Test an "api" type model by making a minimal chat completion request.
 * A real (tiny) inference call — not a TCP ping — so one probe proves
 * reachability, auth, model presence, and the decode path at once. When the
 * model's media modality is known, a test asset is attached so the
 * multimodal ingest path is exercised too.
 */
async function checkApiModel(
  endpoint: string,
  model: string,
  apiKey?: string,
  mediaType?: "video" | "audio" | "image",
): Promise<ModelHealthCheck> {
  const result: ModelHealthCheck = {
    ok: false,
    reachable: false,
    authorized: false,
    model_present: false,
    base_url: endpoint,
    required_model: model,
  };

  // REFACTOR(consistency): endpoint URLs are built 3 different ways in this
  // file — raw template concat (here and the openai-chat ASR branch below),
  // `new URL("/transcribe", endpoint)`, and buildEndpointUrl() (src/lib/asr-url.ts,
  // which exists to tolerate endpoints with/without a /v1 suffix). Route all
  // through buildEndpointUrl.
  const url = `${endpoint}/v1/chat/completions`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  // Build a minimal request body
  const messages: Array<{ role: string; content: Array<Record<string, unknown>> }> = [
    {
      role: "user",
      content: [{ type: "text", text: "Say hello in one word." }],
    },
  ];

  // If media type specified, include test file. When the asset is missing the
  // probe silently degrades to text-only: still proves reachability/auth, but
  // no longer exercises the multimodal ingest path.
  const testFile = TEST_FILES_VLM[mediaType as keyof typeof TEST_FILES_VLM];
  if (mediaType && testFile && existsSync(testFile)) {
    const mediaUrl = `file://${testFile}`;
    if (mediaType === "video") {
      messages[0].content.push({ type: "video_url", video_url: { url: mediaUrl } });
    } else if (mediaType === "audio") {
      messages[0].content.push({ type: "audio_url", audio_url: { url: mediaUrl } });
    } else if (mediaType === "image") {
      messages[0].content.push({ type: "image_url", image_url: { url: mediaUrl } });
    }
  }

  const body = {
    model,
    messages,
    temperature: 0.1,
    top_p: 0.9,
    max_tokens: 16,
  };

  // REFACTOR(dry): this whole response-interpretation block (status ladder,
  // 401/403 auth, 404/400 body-sniff, choices check) is repeated near-verbatim
  // in the openai-chat branch of checkAsrApiModel below — extract a shared
  // interpretChatProbeResponse() helper.
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      // 10s cap: a hung endpoint must degrade the aggregate, not stall /health.
      signal: AbortSignal.timeout(10_000),
    });

    result.status_code = response.status;
    result.reachable = true;

    if (response.status === 401 || response.status === 403) {
      result.authorized = false;
      result.error = "Unauthorized";
      return result;
    }

    result.authorized = true;

    // Status alone can't distinguish "unknown model" from other 400/404s, and
    // backends phrase model-missing errors inconsistently — sniff the body.
    if (response.status === 404 || response.status === 400) {
      const errorText = await response.text().catch(() => "");
      if (errorText.toLowerCase().includes("model") || errorText.toLowerCase().includes("not found")) {
        result.model_present = false;
        result.error = `Model not found: ${errorText.slice(0, 200)}`;
        return result;
      }
    }

    if (response.ok) {
      const data = await response.json().catch(() => ({}));
      if (data.choices && data.choices.length > 0) {
        result.ok = true;
        result.model_present = true;
      } else {
        result.error = "Unexpected response structure";
      }
    } else {
      const errorText = await response.text().catch(() => "");
      result.error = `HTTP ${response.status}: ${errorText.slice(0, 200)}`;
    }
  } catch (err) {
    result.reachable = false;
    result.error = err instanceof Error ? err.message : String(err);
  }

  return result;
}

/**
 * Test an "asr-api" type model with a real transcription request, mirroring the
 * runtime path (MllmApi.transcribeQwen3Asr). Three protocols (ModelConfig.asrProtocol):
 * - "openai-chat" (default): OpenAI-compatible POST /v1/chat/completions with an
 *   audio_url file:// reference and Bearer auth
 * - "whisper-transcribe": legacy Whisper-style multipart POST /transcribe
 * - "openai-transcriptions": OpenAI Audio API multipart POST /v1/audio/transcriptions
 */
async function checkAsrApiModel(
  endpoint: string,
  model: string,
  apiKey?: string,
  language?: string,
  asrProtocol?: "openai-chat" | "whisper-transcribe" | "openai-transcriptions",
): Promise<ModelHealthCheck> {
  const result: ModelHealthCheck = {
    ok: false,
    reachable: false,
    authorized: false,
    model_present: false,
    base_url: endpoint,
    required_model: model,
  };

  const audioPath = TEST_FILES_HOST.audio;
  if (!existsSync(audioPath)) {
    result.error = `Test audio file not found at ${audioPath}`;
    console.error("[HEALTH] ASR test file not found:", audioPath, "existsSync:", existsSync(audioPath));
    return result;
  }

  try {
    if (asrProtocol === "whisper-transcribe" || asrProtocol === "openai-transcriptions") {
      // Multipart protocols (global fetch — longFetch would drop the form parts)
      const fileBuffer = await readFile(audioPath);

      let url: string;
      const formData = new FormData();
      if (asrProtocol === "whisper-transcribe") {
        const transcribeUrl = new URL("/transcribe", endpoint);
        if (language) {
          transcribeUrl.searchParams.set("language", language);
        }
        url = transcribeUrl.toString();
        formData.append("files", new Blob([fileBuffer as unknown as BlobPart]), basename(audioPath));
      } else {
        url = buildEndpointUrl(endpoint, "v1/audio/transcriptions");
        formData.append("file", new Blob([fileBuffer as unknown as BlobPart], { type: "audio/mpeg" }), basename(audioPath));
        formData.append("model", model);
        formData.append("response_format", "json");
        if (language) {
          formData.append("language", language);
        }
      }

      const headers: Record<string, string> = {};
      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: formData,
        // 30s (not 10s): transcribing the test clip is slower than a 16-token
        // chat reply — 10s would false-fail healthy ASR backends.
        signal: AbortSignal.timeout(30_000),
      });

      result.status_code = response.status;
      result.reachable = true;
      result.authorized = response.status !== 401 && response.status !== 403;

      if (response.ok) {
        const data = await response.json().catch(() => null);
        // whisper-transcribe returns an array of {text}; openai-transcriptions returns {text}
        const isValid = asrProtocol === "whisper-transcribe"
          ? Array.isArray(data) && data.length > 0
          : data !== null && typeof (data as { text?: unknown }).text === "string";
        if (isValid) {
          result.ok = true;
          result.model_present = true;
        } else {
          result.error = "Empty or unexpected ASR response";
        }
      } else {
        const errorText = await response.text().catch(() => "");
        result.error = `HTTP ${response.status}: ${errorText.slice(0, 200)}`;
      }
      return result;
    }

    // OpenAI-compatible /v1/chat/completions with audio_url file:// reference.
    // ASR server reads the file itself — convert the host path to the
    // container's /sample_data mount path (same conversion as transcribeQwen3Asr)
    const sampleDataPath = toSampleDataContainerPath(audioPath);
    const body = {
      model,
      messages: [
        {
          role: "user",
          content: [{ type: "audio_url", audio_url: { url: `file://${sampleDataPath}` } }],
        },
      ],
      ...(language && { language }),
    };

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const response = await fetch(`${endpoint}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    result.status_code = response.status;
    result.reachable = true;

    if (response.status === 401 || response.status === 403) {
      result.authorized = false;
      result.error = "Unauthorized";
      return result;
    }
    result.authorized = true;

    // Status alone can't distinguish "unknown model" from other 400/404s, and
    // backends phrase model-missing errors inconsistently — sniff the body.
    if (response.status === 404 || response.status === 400) {
      const errorText = await response.text().catch(() => "");
      if (errorText.toLowerCase().includes("model") || errorText.toLowerCase().includes("not found")) {
        result.model_present = false;
        result.error = `Model not found: ${errorText.slice(0, 200)}`;
        return result;
      }
    }

    if (response.ok) {
      const data = await response.json().catch(() => ({}));
      if (data.choices && data.choices.length > 0) {
        result.ok = true;
        result.model_present = true;
      } else {
        result.error = "Unexpected response structure";
      }
    } else {
      const errorText = await response.text().catch(() => "");
      result.error = `HTTP ${response.status}: ${errorText.slice(0, 200)}`;
    }
  } catch (err) {
    result.reachable = false;
    result.error = err instanceof Error ? err.message : String(err);
  }

  return result;
}

/**
 * Test a "tool" type model by checking if the tool script exists.
 * Existence only — external tools have no cheap no-op invocation, so a
 * present start.sh is the strongest signal available without side effects.
 */
async function checkToolModel(
  toolName: string,
  model: string,
): Promise<ModelHealthCheck> {
  const result: ModelHealthCheck = {
    ok: false,
    reachable: false,
    authorized: true,
    model_present: false,
    base_url: "local",
    required_model: model,
  };

  // Check if the tool directory/script exists (tools are sibling to archivar-poc;
  // in the container ABSOLUTE_TOOLS_PATH points at the identically-mounted host path)
  const toolsDir = join(getEnv('ABSOLUTE_TOOLS_PATH', '') || join(PROJECT_ROOT, '..'), toolName);
  const toolScript = join(toolsDir, "start.sh");

  // REFACTOR(consistency): accepts a bare tool directory as healthy
  // (existsSync(toolsDir), no start.sh required), while the pre-processing
  // tool check in runModelHealthChecks strictly requires run.sh — and model
  // tools use start.sh vs. their run.sh. Unify into one shared existence check.
  if (existsSync(toolScript) || existsSync(toolsDir)) {
    result.reachable = true;
    result.model_present = true;
    result.ok = true;
  } else {
    result.error = `Tool "${toolName}" not found at ${toolsDir}`;
  }

  return result;
}

/** Check a single model (extracted for parallel execution). */
// REFACTOR(dry): the inline parameter type re-declares a subset of ModelConfig
// (src/lib/workflow-types.ts:23) with string[] instead of MediaSegmentType[] —
// callers pass config.models entries, so ModelConfig can be used directly.
async function checkOneModel(
  model: { name: string; type?: string; toolName?: string; model?: string; language?: string; compatibleMediaTypes?: string[]; asrProtocol?: "openai-chat" | "whisper-transcribe" | "openai-transcriptions" },
): Promise<{ name: string; check: ModelHealthCheck }> {
  if (model.type === "tool" && model.toolName) {
    return { name: model.name, check: await checkToolModel(model.toolName, model.model ?? model.name) };
  } else if (model.type === "asr-api") {
    const resolved = getModel(model.name);
    return { name: model.name, check: await checkAsrApiModel(resolved.resolvedEndpoint, resolved.resolvedModel, resolved.resolvedApiKey, model.language, model.asrProtocol) };
  } else if (model.type === "api") {
    const resolved = getModel(model.name);
    let mediaType: "video" | "audio" | "image" | undefined;
    if (model.compatibleMediaTypes) {
      if (model.compatibleMediaTypes.includes("scene")) mediaType = "video";
      else if (model.compatibleMediaTypes.includes("speech")) mediaType = "audio";
      else if (model.compatibleMediaTypes.includes("keyframe")) mediaType = "image";
    } else {
      // No compatibleMediaTypes declared → probe as video: the default VLM
      // case, and the heaviest ingest path to exercise.
      mediaType = "video";
    }
    return { name: model.name, check: await checkApiModel(resolved.resolvedEndpoint, resolved.resolvedModel, resolved.resolvedApiKey, mediaType) };
  } else {
    const resolved = getModel(model.name);
    return {
      name: model.name,
      check: {
        ok: false, reachable: false, authorized: false, model_present: false,
        base_url: resolved.resolvedEndpoint || "unknown",
        required_model: resolved.resolvedModel,
        error: `Unknown model type: ${model.type ?? "undefined"}`,
      },
    };
  }
}

/**
 * Model names actually referenced by any workflow: `processing[].modelName`
 * plus post-processing plugin `config.modelName`. A health FAIL only counts
 * for used models — unused ones are reported as SKIP and never degrade the
 * aggregate status.
 */
export function computeUsedModelNames(config: ArchivarConfig): Set<string> {
  const used = new Set<string>();
  for (const workflow of config.workflows ?? []) {
    for (const step of workflow.processing ?? []) {
      if (step.modelName) used.add(step.modelName);
    }
    for (const plugin of workflow.postProcessing ?? []) {
      const pluginModel = (plugin.config as { modelName?: unknown } | undefined)?.modelName;
      if (typeof pluginModel === "string" && pluginModel) used.add(pluginModel);
    }
  }
  return used;
}

/**
 * Run health checks for all enabled models (in parallel) plus the
 * pre-processing tools. Single source of truth for /health and HealthApi.
 * Models not referenced by any workflow are not probed — they are reported
 * as skipped (unused) and ignored by the aggregate status.
 */
export async function runModelHealthChecks(): Promise<HealthResponse> {
  const config = getArchivarConfig();
  const checks: Record<string, ModelHealthCheck> = {};
  let allOk = true;

  const usedModelNames = computeUsedModelNames(config);

  // Run all model checks in parallel (was sequential — hung on unreachable models).
  const activeModels = (config.models ?? []).filter((m) => m.enabled !== false);
  const results = await Promise.allSettled(activeModels.map(async (m) => {
    if (!usedModelNames.has(m.name)) {
      let baseUrl = "";
      try {
        baseUrl = getModel(m.name).resolvedEndpoint;
      } catch { /* keep empty */ }
      return {
        name: m.name,
        check: {
          ok: false,
          skipped: true,
          reachable: false,
          authorized: true,
          model_present: false,
          base_url: baseUrl,
          required_model: m.model ?? m.name,
          error: "unused (not referenced by any workflow)",
        } satisfies ModelHealthCheck,
      };
    }
    return checkOneModel(m);
  }));
  for (const result of results) {
    if (result.status === "fulfilled") {
      checks[result.value.name] = result.value.check;
      if (!result.value.check.ok && !result.value.check.skipped) allOk = false;
    }
  }

  // Check pre-processing tools (segment-temporal, segment-scenes)
  const PRE_PROCESSING_TOOLS = ["segment-temporal", "segment-scenes"];
  for (const toolName of PRE_PROCESSING_TOOLS) {
    const toolDir = join(getEnv('ABSOLUTE_TOOLS_PATH', '') || join(PROJECT_ROOT, '..'), toolName);
    const toolScript = join(toolDir, "run.sh");
    const check: ModelHealthCheck = {
      ok: false,
      reachable: false,
      authorized: true,
      model_present: false,
      base_url: "local",
      required_model: toolName,
    };

    if (existsSync(toolScript)) {
      check.reachable = true;
      check.model_present = true;
      check.ok = true;
    } else {
      check.error = `Pre-processing tool "${toolName}" not found at ${toolDir}`;
    }

    checks[`pre:${toolName}`] = check;
    if (!check.ok) allOk = false;
  }

  const status: HealthResponse["status"] = allOk ? "ok" : Object.values(checks).some((c) => c.ok) ? "degraded" : "error";
  return { status, checks };
}
