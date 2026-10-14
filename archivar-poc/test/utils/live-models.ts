/**
 * Shared availability gate for live tests.
 *
 * Reads the health report written by test/utils/global-health-setup.ts
 * (vitest globalSetup). If the cache is missing (e.g. running a single test
 * file without the project's vitest config), the health checks run inline.
 *
 * Skip policy: live tests run by default. The ONLY legitimate skip reasons are
 * - the required model is unhealthy (real inference probe failed), or
 * - the test is not applicable anymore.
 * SKIP_LIVE_TESTS=1 is the explicit global opt-out for fast local runs.
 */
import { load, getEnv } from "defuss-env";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelHealthCheck } from "../../src/lib/model-health.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HEALTH_CACHE_PATH = join(__dirname, "..", "..", "node_modules", ".cache", "archivar-health.json");

export interface HealthReport {
    at: string;
    status: "ok" | "degraded" | "error";
    checks: Record<string, ModelHealthCheck>;
}

let _reportPromise: Promise<HealthReport> | null = null;

const runInline = async (): Promise<HealthReport> => {
    load(getEnv("ENV_FILE", ".env.local"));
    await import("../../archivar.config.js");
    const { runModelHealthChecks } = await import("../../src/lib/model-health.js");
    const report = await runModelHealthChecks();
    return { at: new Date().toISOString(), ...report };
};

/** The shared health report for this test run (cached per process). */
export const getHealthReport = (): Promise<HealthReport> => {
    if (!_reportPromise) {
        _reportPromise = (async () => {
            if (process.env.SKIP_LIVE_TESTS === "1") {
                return { at: new Date().toISOString(), status: "error", checks: {} };
            }
            if (existsSync(HEALTH_CACHE_PATH)) {
                try {
                    return JSON.parse(readFileSync(HEALTH_CACHE_PATH, "utf-8")) as HealthReport;
                } catch {
                    // fall through to inline run
                }
            }
            return runInline();
        })();
    }
    return _reportPromise;
};

/** True when the named model's health check passed in this run. */
export const isModelHealthy = async (modelName: string): Promise<boolean> => {
    const report = await getHealthReport();
    return report.checks[modelName]?.ok === true;
};

/**
 * Config name of the scene (VLM) model used by the configured default
 * workflow — the model live tests should target when no E2E_LLM_MODEL
 * override is set. Falls back to undefined when the config has no default.
 */
export const getDefaultSceneModelName = async (): Promise<string | undefined> => {
    load(getEnv("ENV_FILE", ".env.local"));
    await import("../../archivar.config.js");
    const { getArchivarConfig, getWorkflow } = await import("../../src/lib/archivar-config.js");
    const wfName = getArchivarConfig().defaults?.workflow ?? "default-analysis";
    return getWorkflowModels(wfName).then((m) => m.scene);
};

/**
 * Returns null when the named model is healthy, otherwise a human-readable
 * skip reason. Use as: `const reason = await skipIfModelUnhealthy("model");
 * if (reason) return skip(reason);`
 */
export const skipIfModelUnhealthy = async (modelName: string): Promise<string | null> => {
    if (process.env.SKIP_LIVE_TESTS === "1") {
        return "SKIP_LIVE_TESTS=1 (live tests disabled)";
    }
    const report = await getHealthReport();
    const check = report.checks[modelName];
    if (check?.ok) return null;
    if (!check) return `Model "${modelName}" is not in the health report (not configured in archivar.config.ts?)`;
    return `Model "${modelName}" unhealthy: ${check.error ?? `endpoint ${check.base_url} check failed`}`;
};

/** True when the dev server responds on /health (3s timeout). */
export const isServerUp = async (baseUrl = "http://localhost:8802"): Promise<boolean> => {
    if (process.env.SKIP_LIVE_TESTS === "1") return false;
    try {
        const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3_000) });
        return response.status === 200 || response.status === 503;
    } catch {
        return false;
    }
};

/**
 * Model names a workflow uses for scene captioning (VLM) and speech
 * transcription (ASR), resolved from the real archivar config. Use this to
 * gate workflow-running suites on the CURRENT config instead of hard-coded
 * model names.
 */
export const getWorkflowModels = async (workflowName: string): Promise<{ scene?: string; speech?: string }> => {
    load(getEnv("ENV_FILE", ".env.local"));
    await import("../../archivar.config.js");
    const { getWorkflow } = await import("../../src/lib/archivar-config.js");
    const workflow = getWorkflow(workflowName);
    return {
        scene: workflow.processing?.find((s) => s.mediaType === "scene" && s.enabled !== false)?.modelName,
        speech: workflow.processing?.find((s) => s.mediaType === "speech" && s.enabled !== false)?.modelName,
    };
};
