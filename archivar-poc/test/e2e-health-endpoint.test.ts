/**
 * E2E tests for the health endpoint — verifies MODEL_CONFIG endpoint resolution.
 *
 * Two modes:
 *   1. Unit mode: tests getModel() endpoint resolution with mocked env (always runs).
 *   2. Live mode: hits the live /health endpoint on localhost:8801.
 *      Skips only when the dev server is unreachable (or SKIP_LIVE_TESTS=1).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { isServerUp } from "./utils/live-models.js";

const port = process.env.E2E_HEALTH_PORT ?? (process.env.SERVER_URL ? new URL(process.env.SERVER_URL).port : undefined) ?? "8802";
const serverUp = await isServerUp(`http://localhost:${port}`);

describe.skipIf(!serverUp)("health endpoint — live /health", () => {
  let healthData: Record<string, unknown>;

  beforeAll(async () => {
    const res = await fetch(`http://localhost:${port}/health`);
    healthData = await res.json() as Record<string, unknown>;
    // /health runs a real inference probe per model (up to ~30s for ASR)
  }, 90_000);

  it("returns a status field (ok|degraded|error)", () => {
    expect(["ok", "degraded", "error"]).toContain(healthData.status);
  });

  it("every probed model has a non-empty base_url (not '')", () => {
    const checks = healthData.checks as Record<string, { ok: boolean; skipped?: boolean; base_url: string; type?: string }>;
    for (const [name, check] of Object.entries(checks)) {
      // Skip tool checks (they have no base_url in the LLM sense) and skipped
      // (unused) models — they are not probed.
      if (name.startsWith("pre:") || check.skipped) continue;
      expect(check.base_url, `${name} base_url must not be empty`).not.toBe("");
      expect(check.base_url.length, `${name} base_url must have a host`).toBeGreaterThan(10);
    }
  });

  it("includes the models inventory field with resolved endpoints", () => {
    const models = healthData.models as Array<{ name: string; endpoint?: string; enabled: boolean }>;
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      expect(model.name).toBeTruthy();
      if (model.endpoint !== undefined) {
        expect(model.endpoint, `${model.name} endpoint must not be an unresolved env: reference`).not.toMatch(/^env:/);
      }
    }
  });

  it("models used by the default workflow have reachable endpoints", async () => {
    await import("../archivar.config.js");
    const { getArchivarConfig, getWorkflow } = await import("../src/lib/archivar-config");
    const wfName = getArchivarConfig().defaults?.workflow ?? "default-analysis";
    const wf = getWorkflow(wfName);
    const usedModels = [...new Set((wf.processing ?? []).filter((s) => s.enabled !== false).map((s) => s.modelName))];
    expect(usedModels.length).toBeGreaterThan(0);
    const checks = healthData.checks as Record<string, { ok: boolean; reachable: boolean; base_url: string }>;
    for (const name of usedModels) {
      const model = checks[name];
      expect(model, `${name} must appear in the health report`).toBeTruthy();
      expect(model.base_url).toContain("http");
      expect(model.reachable, `${name} endpoint must be reachable`).toBe(true);
    }
  });
});

describe("getModel() — endpoint resolution from MODEL_CONFIG", () => {
  // These tests verify the resolution logic that the health check now uses.
  // They need both the config registered (import archivar.config) and
  // MODEL_CONFIG env set (loaded from .env.local or set here).
  beforeAll(async () => {
    // Register models from archivar.config.ts (test/ → one level up to project root).
    await import("../archivar.config.js");
    // Ensure MODEL_CONFIG is set.
    if (!process.env.MODEL_CONFIG) {
      process.env.MODEL_CONFIG = JSON.stringify([
        { name: "Qwen3.6-35B-A3B-GPTQ-Int4", endpoint: "http://test:9999", apiKey: "test-key", model: "Qwen3.6-35B-A3B-GPTQ-Int4" },
      ]);
    }
  });

  it("getModel() resolves endpoint from MODEL_CONFIG override (non-empty)", async () => {
    const { getModel } = await import("../src/lib/archivar-config");
    // Qwen3.6-35B-A3B-GPTQ-Int4 is always registered by archivar.config.ts.
    const resolved = getModel("Qwen3.6-35B-A3B-GPTQ-Int4");
    expect(resolved.resolvedEndpoint).toBeTruthy();
    expect(resolved.resolvedEndpoint).not.toBe("");
    expect(resolved.resolvedModel).toBeTruthy();
  });

  it("getModel() returns resolvedApiKey when MODEL_CONFIG provides one", async () => {
    const { getModel } = await import("../src/lib/archivar-config");
    const resolved = getModel("Qwen3.6-35B-A3B-GPTQ-Int4");
    const config = JSON.parse(process.env.MODEL_CONFIG!);
    const entry = config.find((c: { name: string }) => c.name === "Qwen3.6-35B-A3B-GPTQ-Int4");
    if (entry?.apiKey) {
      expect(resolved.resolvedApiKey).toBeTruthy();
      expect(resolved.resolvedApiKey!.length).toBeGreaterThan(0);
    }
  });
});
