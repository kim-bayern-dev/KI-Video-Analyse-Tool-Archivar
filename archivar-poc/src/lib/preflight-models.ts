/**
 * Pre-flight model-endpoint gate for `WorkflowEngine.runWorkflow`.
 *
 * WHY: a dead model endpoint used to be discovered only when the first LLM call
 * failed mid-run — after minutes of pre-processing. Worse, per-segment failures
 * are recovered as non-fatal, so a run with a dead endpoint completed "OK" with
 * an empty-shell result (observed: 299 silent `fetch failed` errors in one run).
 * This gate probes every endpoint the workflow will use ONCE at run start and
 * fails fast with an actionable error.
 *
 * The probe is deliberately TINY: `GET <origin>/v1/models` with a 5s timeout.
 * It asserts reachability + authorization only — any HTTP response (even 404,
 * some ASR servers lack the route) counts as reachable. It does no inference,
 * unlike the full health checks in `model-health.ts`.
 */
import { getArchivarConfig, getModel } from "./archivar-config.js";
import type { WorkflowDefinition } from "./workflow-types.js";

/** Probe timeout — a hung endpoint must fail the gate fast, not stall the run. */
const PROBE_TIMEOUT_MS = 5_000;

export interface PreflightFailure {
  modelName: string;
  resolvedModel: string;
  endpoint: string;
  reason: string;
}

/**
 * Collect the model names a workflow run will actually call: enabled
 * processing steps (including fallback steps) plus enabled post-processing
 * plugin `config.modelName`s. `onlyStage` narrows the set for partial runs:
 * "processing" → processing steps only, "postProcessing" → plugin models only,
 * "preProcessing" → none (no model calls in that stage).
 * `fileMediaType` mirrors the engine's resolveEnabledProcessingSteps rule:
 * default-disabled keyframe steps still run for single-image input, so their
 * models must be probed too.
 */
export function collectWorkflowModelNames(
  workflow: WorkflowDefinition,
  onlyStage?: string | null,
  fileMediaType?: string,
): string[] {
  if (onlyStage === "preProcessing") return [];
  const names = new Set<string>();
  if (onlyStage !== "postProcessing") {
    for (const step of workflow.processing ?? []) {
      if (step.enabled === false && !(step.mediaType === "keyframe" && fileMediaType === "image")) continue;
      if (step.modelName) names.add(step.modelName);
    }
  }
  if (onlyStage !== "processing") {
    for (const plugin of workflow.postProcessing ?? []) {
      if (plugin.enabled === false) continue;
      const modelName = (plugin.config as { modelName?: unknown } | undefined)?.modelName;
      if (typeof modelName === "string" && modelName) names.add(modelName);
    }
  }
  return [...names];
}

/** Tiny reachability probe: any HTTP response = reachable; 401/403 = auth failure. */
async function probeEndpoint(endpoint: string, apiKey: string | undefined): Promise<string | null> {
  const origin = new URL(endpoint).origin;
  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  try {
    const response = await fetch(`${origin}/v1/models`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
      return `HTTP ${response.status} (unauthorized — check API key)`;
    }
    return null; // any other HTTP status: the endpoint answers → reachable
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Probe every model endpoint the workflow will use, once, in parallel. Throws
 * an actionable error listing every unreachable/unauthorized endpoint. Local
 * "tool" models need no probe. Runs exactly once per workflow invocation —
 * callers MUST NOT invoke it per step/segment/batch.
 */
export async function preflightWorkflowModels(
  workflow: WorkflowDefinition,
  onlyStage?: string | null,
  fileMediaType?: string,
): Promise<void> {
  const names = collectWorkflowModelNames(workflow, onlyStage, fileMediaType);
  if (names.length === 0) return;

  const config = getArchivarConfig();
  const failures: PreflightFailure[] = [];
  let probed = 0;

  await Promise.all(names.map(async (name) => {
    const entry = (config.models ?? []).find((m) => m.name === name);
    if (entry?.type === "tool") return; // local tool: nothing to probe
    const resolved = getModel(name); // throws on unknown model — fatal config error, let it surface
    probed++;
    if (!resolved.resolvedEndpoint) {
      failures.push({ modelName: name, resolvedModel: resolved.resolvedModel, endpoint: "(none)", reason: "no endpoint configured" });
      return;
    }
    const reason = await probeEndpoint(resolved.resolvedEndpoint, resolved.resolvedApiKey);
    if (reason) {
      failures.push({
        modelName: name,
        resolvedModel: resolved.resolvedModel,
        endpoint: resolved.resolvedEndpoint,
        reason,
      });
    }
  }));

  if (failures.length > 0) {
    const lines = failures
      .map((f) => `  - ${f.modelName} (${f.resolvedModel}) @ ${f.endpoint}: ${f.reason}`)
      .join("\n");
    throw new Error(
      `Pre-flight model check failed — ${failures.length} of ${probed} model endpoint(s) unreachable:\n${lines}\n` +
      `Start the endpoint(s) or choose a different workflow/model, then retry.`,
    );
  }
  console.log(`[PRE-FLIGHT] ${probed} model endpoint(s) reachable`);
}
