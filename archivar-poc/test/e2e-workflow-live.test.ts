/**
 * END-TO-END test reproducing EXACTLY what `pnpm cli analyze ... default-analysis`
 * does in the v3 post-processing phase: run the real plugin `callJson` path
 * (Yup sliceAnalysisSchema → JSON Schema → vLLM constrained decoding) against a
 * REAL scene file produced by the segment-scenes pre-processor.
 *
 * WHY a separate test from e2e-json-schema-live: that one probes transports in
 * isolation. This one drives the actual code path the CLI/server drives
 * (PluginApi.mllm.callJson with the real plugin schema + prompt + media file),
 * so it catches integration issues (schema conversion, transport attachment,
 * truncation, validation) end-to-end. It imports source fresh (no dev-server
 * Vite cache), so it reflects the current code.
 *
 * Gate: skips only when the target model is unhealthy (shared health report)
 * or no scene fixture exists (or SKIP_LIVE_TESTS=1).
 *   E2E_LLM_MODEL=Qwen3.8-27B-FP8         model name (resolved via getModel)
 *   E2E_SCENE_FILE=/abs/path/scene.mp4    force a scene file (else: glob one)
 *
 * Run:
 *   set -a; . ./.env.local; set +a
 *   pnpm exec vitest run test/e2e-workflow-live.test.ts
 */
import { describe, it, expect } from "vitest";
import { glob } from "fast-glob";
import { buildPluginRpcCompositeApiInstance } from "../src/rpc/post-processing/plugin-api";
import { MllmApi } from "../src/rpc/mllm-api";
import type { PluginRpcApiCompositeInstance } from "../src/lib/plugin-types";
import { skipIfModelUnhealthy } from "./utils/live-models.js";

/**
 * Locate a real scene .mp4 produced by segment-scenes, or use E2E_SCENE_FILE.
 * Returns the IN-CONTAINER path the vLLM server expects (under
 * `--allowed-local-media-path /sample_data`), NOT the host path.
 */
async function resolveSceneFile(): Promise<string> {
  if (process.env.E2E_SCENE_FILE) return process.env.E2E_SCENE_FILE;
  // Host sample_data mount; vLLM sees the same tree rooted at /sample_data.
  const HOST_BASE = "../sample_data";
  const CONTAINER_BASE = "/sample_data";
  const hits = await glob(`${HOST_BASE}/archivar/out_*/scenes/*.mp4`);
  if (hits.length === 0) {
    throw new Error("No scene file found — set E2E_SCENE_FILE or run segment-scenes first");
  }
  // Map host path → in-container path so vLLM's allowed-local-media-path accepts it.
  return hits[0].replace(HOST_BASE, CONTAINER_BASE);
}

// Import the real plugin schema + prompt so this exercises the exact contract.
async function loadSliceContract() {
  const mod = await import("../plugins/default");
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    schema: (mod as any).sliceAnalysisSchema,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prompt: (mod as any).DEFAULT_SLICE_ANALYSIS_PROMPT,
  };
}

describe("e2e: real workflow plugin callJson path (default-analysis post-processing)", () => {
  // Multimodal VLM calls on a scene video are slow (probe + generation); allow up to 5 min.
  it("runs postProcessPerTimeSlice callJson on a real scene file with native JSON-schema mode", async ({ skip }) => {
    const { getModel } = await import("../src/lib/archivar-config");
    await import("../archivar.config.js"); // registers config
    const modelName = process.env.E2E_LLM_MODEL ?? "Qwen3.6-35B-A3B-GPTQ-Int4";
    const unhealthyReason = await skipIfModelUnhealthy(modelName);
    if (unhealthyReason) return skip(unhealthyReason);
    const modelConfig = getModel(modelName);
    const sceneFile = await resolveSceneFile();
    const { schema, prompt } = await loadSliceContract();

    console.log(`[e2e-wf] model=${modelName} endpoint=${modelConfig.resolvedEndpoint} scene=${sceneFile}`);

    const api: PluginRpcApiCompositeInstance = buildPluginRpcCompositeApiInstance(new MllmApi(), {} as never, {} as never, {} as never);

    // This is exactly what plugins/default.ts postProcessPerTimeSlice does:
    const result = await api.mllm.callJson({
      endpoint: modelConfig.resolvedEndpoint,
      model: modelConfig.resolvedModel,
      apiKey: modelConfig.resolvedApiKey,
      filePaths: [sceneFile],
      mediaCategory: "video",
      prompt,
      schema,
      enableThinking: false,
      jsonSchemaMode: "auto", // mirrors the default-on behavior
      maxRetries: 2,
    });

    console.log(`[e2e-wf] validated slice analysis (keys): ${Object.keys(result as object).join(", ")}`);
    // The sliceAnalysisSchema contract: required fields must be present and
    // valid. timeline/subjects/camera_motion are optional detail fields (the
    // model may omit them legitimately), so they are not asserted here.
    expect(result).toMatchObject({
      summary: expect.any(String),
      setting: expect.any(String),
      scene_type: expect.any(String),
    });
  }, 300_000); // 5 min — multimodal VLM calls on video are slow
});
