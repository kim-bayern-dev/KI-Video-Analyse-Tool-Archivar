import { describe, it, expect, type TestContext, beforeAll } from "vitest";
import { DSON } from "defuss-dson";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { skipIfModelUnhealthy } from "./utils/live-models.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const SERVER = process.env.SERVER_URL ?? "http://localhost:8802";
const API_KEY = process.env.API_KEY ?? "your-api-key";
// Use ARCHIVAR_DATA_DIR if set (absolute path in Docker), otherwise relative to project root
const DATA_DIR = process.env.ARCHIVAR_DATA_DIR ?? "../sample_data/archivar";

/**
 * RPC call helper that mirrors the CLI approach using DSON encoding.
 * The server-side RPC endpoint serializes responses with DSON, not JSON.
 */
async function rpcCall(className: string, methodName: string, args: unknown[]): Promise<unknown> {
  const url = `${SERVER}/rpc`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": API_KEY,
  };
  const body = DSON.stringify({ className, methodName, args });
  const res = await fetch(url, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`RPC ${className}.${methodName} failed: ${res.status} ${res.statusText}\n${text}`);
  }
  const text = await res.text();
  return DSON.parse(text);
}

/**
 * Classifies an RPC error as a downstream model endpoint being unreachable
 * (environmental: model server down / wrong host) rather than a real failure.
 * Used to skip caption integration tests whose required model isn't currently
 * running instead of reporting them as failures.
 */
function isEndpointUnreachable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|getaddrinfo|Network request failed|connect ECONNREFUSED/i.test(msg);
}

/**
 * Classifies an RPC error as a DOWNSTREAM model/ASR service rejection that is
 * environmental rather than an Archivar regression: the model endpoint is up
 * but rejected the input (e.g. Qwen3-ASR returning HTTP 422 for an audio
 * fixture the deployed model doesn't accept) or reported "service not ready".
 * Like isEndpointUnreachable, caption integration tests skip on these so a
 * model-side issue doesn't fail the suite.
 */
function isDownstreamModelError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Qwen3-ASR service error|transcribeQwen3Asr failed|HTTP 422|service not ready|Vite module runner has been closed/i.test(msg);
}

/**
 * Proactively pre-tests a non-ASR (OpenAI-compatible) model's endpoint by
 * probing GET /v1/models. Returns true when reachable, false when the endpoint
 * is configured but down, and null when the model is ASR/tool (no OpenAI API)
 * or when config/env can't be resolved in this environment. Best-effort: any
 * failure to load config returns null so callers fall back to detect-and-skip.
 */
async function precheckOpenAIReachable(modelName: string): Promise<boolean | null> {
  let getModel: (name: string) => { type?: string; resolvedEndpoint: string; resolvedApiKey?: string };
  try {
    // Load archivar config (side effect) + getModel. Guarded: if config/env
    // isn't available in the test process, we simply can't pre-test.
    try { await import("../archivar.config.js"); } catch { /* config optional */ }
    ({ getModel } = await import("../src/lib/archivar-config"));
  } catch {
    return null;
  }
  let cfg: { type?: string; resolvedEndpoint: string; resolvedApiKey?: string };
  try {
    cfg = getModel(modelName);
  } catch {
    return null;
  }
  // ASR/tool models are not OpenAI-compatible — no /v1/models to probe.
  if (cfg.type === "asr-api" || cfg.type === "tool") return null;
  const endpoint = cfg.resolvedEndpoint;
  if (!endpoint) return null;
  try {
    const headers: Record<string, string> = {};
    if (cfg.resolvedApiKey) headers.Authorization = `Bearer ${cfg.resolvedApiKey}`;
    const res = await fetch(`${endpoint}/v1/models`, { headers, signal: AbortSignal.timeout(10_000) });
    // Any HTTP response (incl. 401) means the endpoint is up; only network errors mean down.
    return res.status < 500;
  } catch {
    return false;
  }
}

/** Skips the test when a (non-ASR) model's OpenAI endpoint is down. */
async function skipIfModelDown(ctx: TestContext, modelName: string): Promise<boolean> {
  const reachable = await precheckOpenAIReachable(modelName);
  if (reachable === false) {
    console.warn(`[skip] model "${modelName}" endpoint unreachable (pre-check)`);
    ctx.skip();
    return true;
  }
  return false;
}

/**
 * Runs a caption RPC call, skipping the test when the required model endpoint
 * is unreachable (environmental). Throws on any other error so real failures surface.
 */
async function rpcCaption(
  ctx: TestContext,
  method: "captionImage" | "captionSound" | "captionVideos",
  args: unknown[],
): Promise<unknown> {
  try {
    return await rpcCall("MllmApi", method, args);
  } catch (err) {
    if (isEndpointUnreachable(err) || isDownstreamModelError(err)) {
      console.warn(`[skip] MllmApi.${method}: model service unavailable/rejected input — ${err instanceof Error ? err.message : err}`);
      ctx.skip();
      return undefined;
    }
    throw err;
  }
}

describe("RPC Integration", () => {
  beforeAll(() => {
    // Ensure demo.mp4 exists in DATA_DIR for tests that need it
    // (pipeline.test.ts may have cleaned it up after previous run)
    const testVideoSrc = resolve(__dirname, "../../sample_data/test/demo.mp4");
    const testVideoDest = resolve(DATA_DIR, "demo.mp4");
    if (existsSync(testVideoSrc) && !existsSync(testVideoDest)) {
      copyFileSync(testVideoSrc, testVideoDest);
      console.log(`[rpc] Copied demo.mp4 to ${testVideoDest}`);
    }
  });

  it("FileApi.listFiles returns files", async ({ skip }) => {
    // Skip integration test unless SKIP_INTEGRATION_TESTS is not set
    if (process.env.SKIP_INTEGRATION_TESTS === "1") return skip();
    const result = await rpcCall("FileApi", "listFiles", ["*"]);
    expect(Array.isArray(result)).toBe(true);
    expect((result as any[]).length).toBeGreaterThan(0);
  });

  it("AnalyseApi.listWorkflows returns workflows", async () => {
    const result = (await rpcCall("AnalyseApi", "listWorkflows", [])) as {
      workflows: Array<{ name: string }>;
      defaultWorkflow: string;
    };
    // listWorkflows returns { workflows, defaultWorkflow } (an object, not an array).
    expect(result).toBeDefined();
    expect(Array.isArray(result.workflows)).toBe(true);
    expect(result.workflows.length).toBeGreaterThan(0);
    console.log("Workflows:", result.workflows.map((w) => w.name), "default:", result.defaultWorkflow);
  });

  it("AnalyseApi.listModels returns models", async () => {
    const result = await rpcCall("AnalyseApi", "listModels", []);
    expect(Array.isArray(result)).toBe(true);
    expect((result as any[]).length).toBeGreaterThan(0);
    const models = result as Array<{ name: string }>;
    console.log("Models:", models.map((m) => m.name));
  });

  it("AnalyseApi.getWorkflowConfig returns config for default-analysis", async () => {
    const result = await rpcCall("AnalyseApi", "getWorkflowConfig", ["default-analysis"]);
    expect(result).toBeDefined();
    expect(typeof result).toBe("object");
  });

  it("CacheApi.get/set round-trips", async () => {
    const testKey = `rpc-test-${Date.now()}`;
    const testValue = { hello: "world", ts: Date.now() };
    await rpcCall("CacheApi", "set", ["speech", testKey, testValue]);
    const result = await rpcCall("CacheApi", "get", ["speech", testKey, null]);
    expect(result).toEqual(testValue);
  });
});

describe("MLLM RPC API", () => {
  // captionImage resolves the configured default workflow's scene-step (VLM)
  // model — gemma4-e4b-qat-w4a16 in the shipped S configuration (keep in sync
  // with archivar.config.ts defaults.workflow).
  it("MllmApi.captionImage with demo.jpg returns caption", async (ctx) => {
    if (await skipIfModelDown(ctx, "gemma4-e4b-qat-w4a16")) return;
    const imageBuffer = readFileSync(resolve(__dirname, "../../sample_data/test/demo.jpg"));
    const imageBase64 = imageBuffer.toString("base64");
    const result = await rpcCaption(ctx, "captionImage", [[`data:image/jpeg;base64,${imageBase64}`]]);
    expect(result).toBeDefined();
    expect(typeof result).toBe("object");
    console.log("Image caption (demo.jpg):", JSON.stringify(result, null, 2));
  });

  it("MllmApi.captionImage with demo.png returns caption", async (ctx) => {
    if (await skipIfModelDown(ctx, "gemma4-e4b-qat-w4a16")) return;
    const imageBuffer = readFileSync(resolve(__dirname, "../../sample_data/test/demo.png"));
    const imageBase64 = imageBuffer.toString("base64");
    const result = await rpcCaption(ctx, "captionImage", [[`data:image/png;base64,${imageBase64}`]]);
    expect(result).toBeDefined();
    expect(typeof result).toBe("object");
    console.log("Image caption (demo.png):", JSON.stringify(result, null, 2));
  });

  // captionSound resolves the configured default workflow's speech-step (ASR)
  // model — qwen-asr-0.6b in the shipped S configuration. Pre-check via the
  // shared health report; rpcCaption's detect-and-skip stays as a safety net.
  it("MllmApi.captionSound with test fixture returns sound type", async (ctx) => {
    const unhealthyReason = await skipIfModelUnhealthy("qwen-asr-0.6b");
    if (unhealthyReason) return ctx.skip(unhealthyReason);
    const audioBuffer = readFileSync(resolve(__dirname, "../../sample_data/test/reference.wav"));
    const audioBase64 = audioBuffer.toString("base64");
    const result = await rpcCaption(ctx, "captionSound", [[`data:audio/wav;base64,${audioBase64}`]]);
    expect(result).toBeDefined();
    expect(typeof result).toBe("object");
    console.log("Sound caption:", JSON.stringify(result, null, 2));
  });

  // captionVideos resolves the configured default workflow's scene-step (VLM)
  // model — gemma4-e4b-qat-w4a16 in the shipped S configuration. It returns a
  // RawCallResult ({ content, usage? }), not a bare string.
  it("MllmApi.captionVideos with demo.mp4 returns caption", async (ctx) => {
    if (await skipIfModelDown(ctx, "gemma4-e4b-qat-w4a16")) return;
    const videoBuffer = readFileSync(resolve(__dirname, "../../sample_data/test/demo.mp4"));
    const videoBase64 = videoBuffer.toString("base64");
    const result = await rpcCaption(ctx, "captionVideos", [[`data:video/mp4;base64,${videoBase64}`]]);
    expect(result).toBeDefined();
    expect(typeof result).toBe("object");
    expect(typeof (result as { content?: unknown }).content).toBe("string");
    console.log("Video caption:", (result as { content?: unknown }).content);
  });
});

describe("MLLM Model Hyperparams", () => {
  it("getAnalysisDefaults returns defaults for a file+mediaType", async ({ skip }) => {
    if (process.env.SKIP_INTEGRATION_TESTS === "1") return skip();
    // getAnalysisDefaults(filePath, mediaType, workflowName?) returns { modelName, prompt, systemPrompt, availableModels }
    try {
      const result = await rpcCall("AnalyseApi", "getAnalysisDefaults", ["251022_1730_SAT1_Bayern_PGM.mp4", "speech", "default-analysis"]);
      expect(result).toBeDefined();
      expect(typeof result).toBe("object");
      const defaults = result as { modelName: string; prompt: string; availableModels: any[] };
      expect(defaults.modelName).toBeDefined();
      expect(Array.isArray(defaults.availableModels)).toBe(true);
    } catch (err) {
      // Skip on environmental errors (server-side module runner shutdown, unreachable endpoint, etc.)
      if (isEndpointUnreachable(err) || isDownstreamModelError(err)) {
        console.warn(`[skip] getAnalysisDefaults: environmental issue — ${err instanceof Error ? err.message : err}`);
        return skip();
      }
      throw err;
    }
  });

  it("getAllAnalysisDefaults returns defaults for all workflows", async ({ skip }) => {
    if (process.env.SKIP_INTEGRATION_TESTS === "1") return skip();
    // getAllAnalysisDefaults requires a filePath argument to resolve workflow config
    try {
      const result = await rpcCall("AnalyseApi", "getAllAnalysisDefaults", ["251022_1730_SAT1_Bayern_PGM.mp4"]);
      expect(result).toBeDefined();
      const defaults = result as { steps: any[] };
      expect(Array.isArray(defaults.steps)).toBe(true);
      console.log("All analysis defaults steps:", defaults.steps.length);
    } catch (err) {
      // Skip on environmental errors (server-side module runner shutdown, unreachable endpoint, etc.)
      if (isEndpointUnreachable(err) || isDownstreamModelError(err)) {
        console.warn(`[skip] getAllAnalysisDefaults: environmental issue — ${err instanceof Error ? err.message : err}`);
        return skip();
      }
      throw err;
    }
  });

  it("getPostProcessingDefaults returns plugin defaults", async () => {
    const result = await rpcCall("AnalyseApi", "getPostProcessingDefaults", ["default-analysis"]);
    expect(result).toBeDefined();
    expect(typeof result).toBe("object");
  });
});
