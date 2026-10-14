/**
 * END-TO-END live test: proves the FULL response body shape returned by the
 * VLM backend and the two ASR backends, with focus on whether token metadata
 * (`usage`) is present.
 *
 * WHY: [`OpenAIChatResponse`](src/rpc/mllm-api.ts:225) declares a `usage`
 * block, but every consumer in [`MllmApi`](src/rpc/mllm-api.ts:290) reads only
 * `choices[0].message.content` and discards the rest. A codebase-wide search
 * for `.usage | prompt_tokens` returns exactly one hit — the type declaration.
 * This test grounds that claim against REAL backends: it captures and logs the
 * entire JSON body each protocol returns and asserts the token-metadata
 * contract per protocol, so we can reason about which calls could surface real
 * token counts (instead of the heuristic estimates in [`token-estimate.ts`](src/lib/token-estimate.ts)).
 *
 * Protocols under test:
 *   1. VLM           — `POST /v1/chat/completions`        → returns `usage`
 *   2. ASR openai-chat (`/v1/chat/completions` + audio_url) → returns `usage`
 *   3. ASR openai-transcriptions (`/v1/audio/transcriptions`) → NO `usage`
 *   4. Archivar layer  — [`callWithPromptRaw`](src/rpc/mllm-api.ts:1214) discards
 *      `usage` and returns only the content string (documents the gap).
 *
 * Env (all optional — LIVE BY DEFAULT, gated on the shared per-model health
 * report via [`skipIfModelUnhealthy`](test/utils/live-models.ts:69)):
 *   E2E_VLM_MODEL                 default Qwen3.8-27B-FP8 (chat-completions VLM)
 *   E2E_ASR_CHAT_MODEL            default qwen-asr-0.6b    (openai-chat protocol)
 *   E2E_ASR_TRANSCRIPTIONS_MODEL  default parakeet-primeline-de (openai-transcriptions)
 *   E2E_LLM_ENDPOINT / E2E_LLM_API_KEY  overrides applied to every target
 *   E2E_TEST_DATA_HOST            host test-data dir (default
 *                                 ../sample_data/archivar/test_data)
 *   E2E_TEST_DATA_CONTAINER       container test-data dir used for file:// refs
 *                                 (default /sample_data/archivar/test_data)
 *   SKIP_LIVE_TESTS=1             global opt-out for fast local runs
 *
 * Run:
 *   pnpm exec vitest run test/e2e-response-format-live.test.ts
 */
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { MllmApi } from "../src/rpc/mllm-api";
import { buildEndpointUrl } from "../src/lib/asr-url";
import { skipIfModelUnhealthy } from "./utils/live-models.js";

// Default targets mirror the live models referenced by the default workflows.
const VLM_MODEL = process.env.E2E_VLM_MODEL ?? "Qwen3.8-27B-FP8";
const ASR_CHAT_MODEL = process.env.E2E_ASR_CHAT_MODEL ?? "qwen-asr-0.6b";
const ASR_TRANSCRIPTIONS_MODEL = process.env.E2E_ASR_TRANSCRIPTIONS_MODEL ?? "parakeet-primeline-de";

// Test-data dirs mirror the constants in [`model-health.ts`](src/lib/model-health.ts:31):
// VLMs run in the container and read file:// refs off the /sample_data mount;
// the multipart ASR protocol reads a host file off disk.
const TEST_DATA_HOST = process.env.E2E_TEST_DATA_HOST ?? "../sample_data/archivar/test_data";
const TEST_DATA_CONTAINER = process.env.E2E_TEST_DATA_CONTAINER ?? "/sample_data/archivar/test_data";
const ASR_AUDIO_NAME = "test.mp3";

/** Minimal dotenv loader for .env.local (MODEL_CONFIG holds endpoints). No deps. */
function loadEnvLocal(): void {
  try {
    const fs = require("node:fs");
    const path = require("node:path");
    const raw = fs.readFileSync(path.resolve(__dirname, "..", ".env.local"), "utf8");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq < 0) continue;
      const key = t.slice(0, eq).trim();
      let val = t.slice(eq + 1).trim();
      const head = val.charCodeAt(0);
      const tail = val.charCodeAt(val.length - 1);
      const SINGLE_Q = 0x27;
      const DOUBLE_Q = 0x22;
      if ((head === SINGLE_Q && tail === SINGLE_Q) || (head === DOUBLE_Q && tail === DOUBLE_Q)) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch {
    // .env.local absent — fall back to env / explicit overrides.
  }
}

interface Target {
  model: string;
  endpoint: string;
  apiKey?: string;
}

/** Resolve a model name to its endpoint/model/apiKey via the real registry. */
async function resolveTarget(modelName: string): Promise<Target> {
  loadEnvLocal();
  const { getModel } = await import("../src/lib/archivar-config");
  await import("../archivar.config.js");
  const cfg = getModel(modelName);
  const endpoint = process.env.E2E_LLM_ENDPOINT ?? cfg.resolvedEndpoint;
  if (!endpoint) {
    throw new Error(
      `No endpoint resolved for model "${modelName}". Set E2E_LLM_ENDPOINT or cover it via MODEL_CONFIG in .env.local.`,
    );
  }
  return {
    model: cfg.resolvedModel,
    endpoint,
    apiKey: process.env.E2E_LLM_API_KEY ?? cfg.resolvedApiKey,
  };
}

/** Host path to the ASR test clip (read from disk for the multipart upload). */
function transcriptionsAudioFile(): string | null {
  const p = join(TEST_DATA_HOST, ASR_AUDIO_NAME);
  return existsSync(p) ? p : null;
}

/**
 * Container file:// reference the openai-chat ASR server reads itself. The
 * chat-protocol ASR reads the file in its own mount, so availability is gated
 * on the host copy (the same file is mounted into the container).
 */
function asrChatAudioRef(): string | null {
  return existsSync(join(TEST_DATA_HOST, ASR_AUDIO_NAME))
    ? join(TEST_DATA_CONTAINER, ASR_AUDIO_NAME)
    : null;
}

/** Raw POST to /v1/chat/completions; returns the parsed body (or null) + status. */
async function chatProbe(
  target: Target,
  body: Record<string, unknown>,
  timeoutMs = 60_000,
): Promise<{ status: number; ok: boolean; json: Record<string, unknown> | null; text: string }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (target.apiKey) headers["Authorization"] = `Bearer ${target.apiKey}`;
  const res = await fetch(`${target.endpoint}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    /* non-JSON body — leave json null, surface via text */
  }
  return { status: res.status, ok: res.ok, json, text };
}

describe("e2e: response body shape + token metadata across VLM & ASR backends", () => {
  it("VLM chat-completions returns token metadata (`usage`) in the full body", async ({ skip }) => {
    const gate = await skipIfModelUnhealthy(VLM_MODEL);
    if (gate) return skip(gate);
    const t = await resolveTarget(VLM_MODEL);

    // Text-only probe: the cheapest request that still exercises the full
    // chat-completions decode path and proves the body carries `usage`. Media
    // is intentionally omitted — `usage` is returned regardless of modality.
    const { status, json } = await chatProbe(t, {
      model: t.model,
      messages: [{ role: "user", content: [{ type: "text", text: "Sage in genau einem Wort: Hallo." }] }],
      temperature: 0,
      max_tokens: 16,
      // Disable thinking so output lands in `content` (reasoning models emit empty content otherwise).
      chat_template_kwargs: { add_generation_prompt: true, enable_thinking: false },
    });

    // eslint-disable-next-line no-console
    console.log("[e2e:vlm] FULL BODY:", JSON.stringify(json, null, 2));

    expect(status).toBe(200);
    const choices = json?.choices as Array<{ message?: { content?: unknown } }> | undefined;
    expect(typeof choices?.[0]?.message?.content).toBe("string");

    // Token-metadata contract for chat-completions: the three core counts are numbers.
    const usage = json?.usage as Record<string, unknown> | undefined;
    expect(usage, "VLM chat-completions MUST return a `usage` block").toBeTypeOf("object");
    expect(usage!.prompt_tokens).toBeTypeOf("number");
    expect(usage!.completion_tokens).toBeTypeOf("number");
    expect(usage!.total_tokens).toBeTypeOf("number");
  });

  it("ASR openai-chat (/v1/chat/completions + audio_url) returns token metadata", async ({ skip }) => {
    const gate = await skipIfModelUnhealthy(ASR_CHAT_MODEL);
    if (gate) return skip(gate);
    const audioRef = asrChatAudioRef();
    if (!audioRef) return skip(`ASR test audio not found at ${join(TEST_DATA_HOST, ASR_AUDIO_NAME)}`);
    const t = await resolveTarget(ASR_CHAT_MODEL);

    const { status, json } = await chatProbe(t, {
      model: t.model,
      messages: [
        {
          role: "user",
          content: [{ type: "audio_url", audio_url: { url: `file://${audioRef}` } }],
        },
      ],
      language: "de",
    });

    // eslint-disable-next-line no-console
    console.log("[e2e:asr-chat] FULL BODY:", JSON.stringify(json, null, 2));

    expect(status).toBe(200);
    // Qwen3-ASR places the transcript in `message.reasoning`, not `content`.
    const message = (json?.choices as Array<{ message?: { content?: string; reasoning?: string } }> | undefined)?.[0]?.message;
    const content = message?.content ?? message?.reasoning ?? "";
    expect(typeof content).toBe("string");
    expect(content.length).toBeGreaterThan(0);

    // Same contract as the VLM: openai-chat is still /v1/chat/completions, so usage is present.
    const usage = json?.usage as Record<string, unknown> | undefined;
    expect(usage, "openai-chat ASR MUST return a `usage` block").toBeTypeOf("object");
    expect(usage!.prompt_tokens).toBeTypeOf("number");
    expect(usage!.completion_tokens).toBeTypeOf("number");
  });

  it("ASR openai-transcriptions (/v1/audio/transcriptions) does NOT return token metadata", async ({ skip }) => {
    const gate = await skipIfModelUnhealthy(ASR_TRANSCRIPTIONS_MODEL);
    if (gate) return skip(gate);
    const audioFile = transcriptionsAudioFile();
    if (!audioFile) return skip(`ASR test audio not found at ${join(TEST_DATA_HOST, ASR_AUDIO_NAME)}`);
    const t = await resolveTarget(ASR_TRANSCRIPTIONS_MODEL);

    // Multipart upload — MUST use the global fetch (longFetch's undici Agent drops
    // form parts), mirroring the runtime
    // path in [`transcribeViaAudioTranscriptions`](src/rpc/mllm-api.ts:1638).
    const formData = new FormData();
    const buf = await readFile(audioFile);
    formData.append("file", new Blob([buf as unknown as BlobPart], { type: "audio/mpeg" }), basename(audioFile));
    formData.append("model", t.model);
    formData.append("response_format", "json");
    formData.append("language", "de");
    const headers: Record<string, string> = {};
    if (t.apiKey) headers["Authorization"] = `Bearer ${t.apiKey}`;

    const url = buildEndpointUrl(t.endpoint, "v1/audio/transcriptions");
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: formData,
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    let json: Record<string, unknown> | null = null;
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    } catch {
      /* non-JSON */
    }

    // eslint-disable-next-line no-console
    console.log("[e2e:asr-transcriptions] FULL BODY:", JSON.stringify(json, null, 2));

    expect(res.status).toBe(200);
    expect(typeof json?.text).toBe("string");
    // Documented contract: the transcriptions endpoint returns ONLY { text }.
    // It carries NO token metadata — so real token accounting is unavailable
    // for this ASR protocol regardless of any Archivar-side change.
    expect(json?.usage, "openai-transcriptions returns no `usage` field").toBeUndefined();
  });

  it("Archivar layer: MllmApi.callWithPromptRaw returns { content, usage } (token metadata surfaced)", async ({ skip }) => {
    const gate = await skipIfModelUnhealthy(VLM_MODEL);
    if (gate) return skip(gate);
    const t = await resolveTarget(VLM_MODEL);

    // Text-only chat-completion (empty urls) — chat-completions backends return
    // `usage`, and the transport method now surfaces it alongside the content
    // (previously discarded). This is the regression guard for that contract.
    const api = new MllmApi();
    const result = await api.callWithPromptRaw(
      t.endpoint,
      t.model,
      t.apiKey,
      [], // no media — a text-only chat-completion still returns `usage` upstream
      "Sage in genau einem Wort: Hallo.",
      "image",
    );

    expect(typeof result.content).toBe("string");
    expect(result.content.length).toBeGreaterThan(0);
    // Token metadata is now surfaced through the public transport API.
    expect(result.usage, "callWithPromptRaw MUST surface usage").toBeTypeOf("object");
    expect(result.usage!.prompt_tokens).toBeTypeOf("number");
    expect(result.usage!.completion_tokens).toBeTypeOf("number");
    expect(result.usage!.total_tokens).toBeTypeOf("number");
  });
});
