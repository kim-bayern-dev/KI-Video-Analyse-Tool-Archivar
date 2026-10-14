/**
 * Model availability checker for live tests.
 *
 * Backed by the SHARED health report (test/utils/live-models.ts): the real
 * per-model inference probes run once per `vitest run` in globalSetup. This
 * module only resolves the model from the real archivar config and maps the
 * health result — no per-model pings anymore.
 *
 * Usage in test files:
 *
 * ```typescript
 * import { ensureModelAvailable, type ModelCheckResult } from "./utils/model-availability.js";
 *
 * let modelCheck: ModelCheckResult;
 * beforeAll(async () => { modelCheck = await ensureModelAvailable("Qwen3.6-35B-A3B-GPTQ-Int4"); });
 *
 * it("runs live aggregation with real model", async ({ skip }) => {
 *   if (!modelCheck.available) return skip(modelCheck.reason);
 *   // ... test using real model ...
 * });
 * ```
 */
import { load, getEnv } from "defuss-env";

// Load env and archivar config ONCE for the entire test process
load(getEnv("ENV_FILE", ".env.local"));
await import("../../archivar.config.js");

import { getModel } from "../../src/lib/archivar-config.js";
import { getHealthReport } from "./live-models.js";

export interface ModelCheckResult {
  available: boolean;
  reason: string;
  modelName: string;
  endpoint?: string;
  resolvedModel?: string;
}

/**
 * Check if a model is available, using the shared per-run health report.
 *
 * @param modelName The model name as defined in archivar.config.ts models[]
 */
export async function ensureModelAvailable(
  modelName: string,
  _timeoutMs = 10_000, // kept for signature compatibility; health probes have their own timeouts
): Promise<ModelCheckResult> {
  if (process.env.SKIP_LIVE_TESTS === "1") {
    return { available: false, reason: "SKIP_LIVE_TESTS=1 (live tests disabled)", modelName };
  }

  let endpoint: string | undefined;
  let resolvedModel: string | undefined;
  try {
    const model = getModel(modelName);
    endpoint = model.resolvedEndpoint;
    resolvedModel = model.resolvedModel;
  } catch (err) {
    return {
      available: false,
      reason: `Model "${modelName}" not in archivar config: ${err instanceof Error ? err.message : String(err)}`,
      modelName,
    };
  }

  const report = await getHealthReport();
  const check = report.checks[modelName];
  if (check?.ok) {
    return { available: true, reason: "Model is available and responding.", modelName, endpoint, resolvedModel };
  }
  return {
    available: false,
    reason: check
      ? `Model "${modelName}" unhealthy: ${check.error ?? `endpoint ${check.base_url} check failed`}`
      : `Model "${modelName}" is not in the health report (not configured in archivar.config.ts?)`,
    modelName,
    endpoint,
    resolvedModel,
  };
}

/**
 * Kept for API compatibility. The health report is per-run (globalSetup), so
 * there is no per-model cache to clear anymore — this is a no-op.
 */
export function clearModelAvailabilityCache(): void {
  // no-op: availability comes from the shared per-run health report
}
