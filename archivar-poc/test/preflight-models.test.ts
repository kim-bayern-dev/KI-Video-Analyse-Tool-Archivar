/**
 * Tests for the pre-flight model-endpoint gate
 * ([`src/lib/preflight-models.ts`](../src/lib/preflight-models.ts)):
 * model collection per stage, tiny once-per-run probing, fail-fast behaviour.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WorkflowDefinition } from "../src/lib/workflow-types";

const MODEL_ENDPOINTS: Record<string, string> = {
  "vlm-a": "http://vlm-a:8000",
  "vlm-b": "http://vlm-b:8000/",
  "asr-a": "http://asr-a:9000/v1/audio/transcriptions",
  "local-tool": "",
};

vi.mock("../src/lib/archivar-config", () => ({
  getModel: (name: string) => ({
    resolvedEndpoint: MODEL_ENDPOINTS[name],
    resolvedModel: `resolved-${name}`,
    resolvedApiKey: name === "vlm-b" ? "secret" : undefined,
  }),
  getArchivarConfig: () => ({
    models: [
      { name: "vlm-a", type: "api" },
      { name: "vlm-b", type: "api" },
      { name: "asr-a", type: "asr-api" },
      { name: "local-tool", type: "tool", toolName: "some-tool" },
    ],
  }),
}));

import { collectWorkflowModelNames, preflightWorkflowModels } from "../src/lib/preflight-models";

function workflow(partial: Partial<WorkflowDefinition>): WorkflowDefinition {
  return { name: "wf", processing: [], postProcessing: [], ...partial } as WorkflowDefinition;
}

const FULL_WORKFLOW = workflow({
  processing: [
    { mediaType: "scene", modelName: "vlm-a", enabled: true },
    { mediaType: "speech", modelName: "asr-a", enabled: true },
    { mediaType: "keyframe", modelName: "vlm-b", enabledAsFallback: true },
    { mediaType: "noise", modelName: "vlm-disabled", enabled: false },
  ] as unknown as WorkflowDefinition["processing"],
  postProcessing: [
    { name: "default", enabled: true, config: { modelName: "vlm-b" } },
    { name: "off", enabled: false, config: { modelName: "vlm-disabled-plugin" } },
  ] as unknown as WorkflowDefinition["postProcessing"],
});

/** A fetch stub routing per URL: "dead" hosts reject, "unauthorized" hosts 401, else 200. */
function stubFetch() {
  const calls: string[] = [];
  const stub = vi.fn(async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("dead")) throw new Error("fetch failed");
    if (url.includes("unauthorized")) return new Response("no", { status: 401 });
    return new Response("{}", { status: 200 });
  });
  vi.stubGlobal("fetch", stub);
  return calls;
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("collectWorkflowModelNames", () => {
  it("collects enabled processing + plugin models, deduped", () => {
    const names = collectWorkflowModelNames(FULL_WORKFLOW);
    expect(names.sort()).toEqual(["asr-a", "vlm-a", "vlm-b"]);
  });

  it("narrows to the --only stage", () => {
    expect(collectWorkflowModelNames(FULL_WORKFLOW, "processing")).toEqual(["vlm-a", "asr-a", "vlm-b"]);
    expect(collectWorkflowModelNames(FULL_WORKFLOW, "postProcessing")).toEqual(["vlm-b"]);
    expect(collectWorkflowModelNames(FULL_WORKFLOW, "preProcessing")).toEqual([]);
  });

  it("includes a default-disabled keyframe step only for image input", () => {
    const wf = workflow({
      processing: [
        { mediaType: "scene", modelName: "vlm-a", enabled: true },
        { mediaType: "keyframe", modelName: "vlm-b", enabled: false, enabledAsFallback: true },
      ] as unknown as WorkflowDefinition["processing"],
    });
    // video: keyframe step is default-disabled → its model is not called
    expect(collectWorkflowModelNames(wf, null, "video")).toEqual(["vlm-a"]);
    // image: the keyframe step runs anyway (image IS its own keyframe)
    expect(collectWorkflowModelNames(wf, null, "image")).toEqual(["vlm-a", "vlm-b"]);
    // no media type (legacy callers): disabled stays disabled
    expect(collectWorkflowModelNames(wf)).toEqual(["vlm-a"]);
  });
});

describe("preflightWorkflowModels", () => {
  it("passes when every endpoint answers (any HTTP status), probing each once via origin", async () => {
    const calls = stubFetch();
    await expect(preflightWorkflowModels(FULL_WORKFLOW)).resolves.toBeUndefined();
    // tool model skipped; 3 probed endpoints, each exactly once, via origin (not the raw endpoint)
    expect(calls.sort()).toEqual(["http://asr-a:9000/v1/models", "http://vlm-a:8000/v1/models", "http://vlm-b:8000/v1/models"]);
  });

  it("fails fast with an actionable error when an endpoint is unreachable", async () => {
    const calls = stubFetch();
    const wf = workflow({
      processing: [
        { mediaType: "scene", modelName: "vlm-a", enabled: true },
        { mediaType: "speech", modelName: "dead-model", enabled: true },
      ] as unknown as WorkflowDefinition["processing"],
    });
    MODEL_ENDPOINTS["dead-model"] = "http://dead:8000";
    await expect(preflightWorkflowModels(wf)).rejects.toThrow(
      /Pre-flight model check failed — 1 of 2 model endpoint\(s\) unreachable[\s\S]*dead-model \(resolved-dead-model\) @ http:\/\/dead:8000: fetch failed/,
    );
    expect(calls).toContain("http://dead:8000/v1/models");
  });

  it("fails on 401/403 (unauthorized)", async () => {
    stubFetch();
    MODEL_ENDPOINTS["vlm-auth"] = "http://unauthorized:8000";
    const wf = workflow({
      processing: [{ mediaType: "scene", modelName: "vlm-auth", enabled: true }] as unknown as WorkflowDefinition["processing"],
    });
    await expect(preflightWorkflowModels(wf)).rejects.toThrow(/401/);
  });

  it("probes nothing for preProcessing-only runs", async () => {
    const calls = stubFetch();
    await expect(preflightWorkflowModels(FULL_WORKFLOW, "preProcessing")).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("reports an actionable failure (not a crash) when a model has no endpoint configured", async () => {
    const calls = stubFetch();
    const wf = workflow({
      processing: [{ mediaType: "scene", modelName: "local-tool", enabled: true }] as unknown as WorkflowDefinition["processing"],
      postProcessing: [{ name: "default", enabled: true, config: { modelName: "no-endpoint" } }] as unknown as WorkflowDefinition["postProcessing"],
    });
    MODEL_ENDPOINTS["no-endpoint"] = "";
    await expect(preflightWorkflowModels(wf)).rejects.toThrow(/no-endpoint[\s\S]*no endpoint configured/);
    expect(calls).toEqual([]); // local-tool skipped; no-endpoint never probed
  });
});
