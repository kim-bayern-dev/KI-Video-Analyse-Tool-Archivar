/**
 * E2E tests for the public API routes.
 *
 * Tests all endpoints:
 *   POST /api/analyze
 *   GET /api/raw
 *   GET /api/logs
 *   GET /api/list
 *   DELETE /api/clear-cache
 *
 * Gate: the app must be up (container on localhost:8802 by default; override
 * via E2E_API_PORT or SERVER_URL, e.g. 8801 for the dev server);
 * the suite skips only when the server is unreachable (or SKIP_LIVE_TESTS=1).
 */

import { describe, it, expect } from "vitest";
import { getWorkflowModels, isModelHealthy, isServerUp } from "./utils/live-models.js";

const PORT = process.env.E2E_API_PORT ?? (process.env.SERVER_URL ? new URL(process.env.SERVER_URL).port : undefined) ?? "8802";
const BASE_URL = `http://localhost:${PORT}`;

// Gate: server reachable + the CURRENT default-analysis workflow models healthy
// (model names resolved from the real archivar config, not hard-coded)
const serverUp = await isServerUp(BASE_URL);
const workflowModels = await getWorkflowModels("default-analysis");
const workflowModelNames = [workflowModels.scene, workflowModels.speech].filter((name): name is string => !!name);
const modelsHealthy = (await Promise.all(workflowModelNames.map((name) => isModelHealthy(name)))).every(Boolean);
const suiteReady = serverUp && modelsHealthy;

describe.skipIf(!suiteReady)(`public API routes — live /api/* (server ${serverUp ? "up" : "down"}, models ${modelsHealthy ? "healthy" : "unhealthy"})`, () => {
  // demo.mp4 lives in the data dir and is analyzed in ~25s (cached: much faster)
  const TEST_FILE = "demo.mp4";
  const TEST_WORKFLOW = "default-analysis";

  describe("GET /api/list", () => {
    it("returns a list of files", async () => {
      const res = await fetch(`${BASE_URL}/api/list`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(Array.isArray(data)).toBe(true);
    });

    it("accepts a pattern parameter", async () => {
      const res = await fetch(`${BASE_URL}/api/list?pattern=*.mp4`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(Array.isArray(data)).toBe(true);
    });
  });

  describe("GET /api/raw", () => {
    it("returns 400 if file param is missing", async () => {
      const res = await fetch(`${BASE_URL}/api/raw`);
      expect(res.status).toBe(400);
    });

    it("returns null for a file that has no status.json", async () => {
      const res = await fetch(`${BASE_URL}/api/raw?file=nonexistent_file_xyz.mp4`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data).toBeNull();
    });

    it("returns processing status for a file being analyzed", async () => {
      // Start analysis in background
      const analyzeRes = await fetch(`${BASE_URL}/api/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: TEST_FILE, workflow: TEST_WORKFLOW }),
      });
      expect(analyzeRes.ok).toBe(true);

      // Poll for status
      const statusRes = await fetch(`${BASE_URL}/api/raw?file=${TEST_FILE}`);
      expect(statusRes.ok).toBe(true);
      const statusData = await statusRes.json();
      expect(statusData).toHaveProperty("status");
      expect(["processing", "done"]).toContain(statusData.status);
    });
  });

  describe("GET /api/logs", () => {
    it("returns 400 if file param is missing", async () => {
      const res = await fetch(`${BASE_URL}/api/logs`);
      expect(res.status).toBe(400);
    });

    it("returns null or logs for a file", async () => {
      const res = await fetch(`${BASE_URL}/api/logs?file=${TEST_FILE}`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      // Either null (not started) or { status, data }
      if (data !== null) {
        expect(data).toHaveProperty("status");
        expect(data).toHaveProperty("data");
      }
    });
  });

  describe("POST /api/analyze", () => {
    it("returns 400 if file is missing", async () => {
      const res = await fetch(`${BASE_URL}/api/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("accepts a valid analyze request", async () => {
      const res = await fetch(`${BASE_URL}/api/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file: TEST_FILE,
          workflow: TEST_WORKFLOW,
          format: "json",
        }),
      });
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data).toHaveProperty("ok", true);
      expect(data).toHaveProperty("file", TEST_FILE);
      expect(data).toHaveProperty("status", "processing");
    });

    it("accepts webHookUrl parameter", async () => {
      const res = await fetch(`${BASE_URL}/api/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file: TEST_FILE,
          workflow: TEST_WORKFLOW,
          webHookUrl: "http://localhost:9999/webhook",
        }),
      });
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data).toHaveProperty("ok", true);
      expect(data).toHaveProperty("status", "processing");
    });
  });

  describe("DELETE /api/clear-cache", () => {
    it("returns 400 if file param is missing", async () => {
      const res = await fetch(`${BASE_URL}/api/clear-cache`, { method: "DELETE" });
      expect(res.status).toBe(400);
    });

    it("returns null for a file not found", async () => {
      const res = await fetch(`${BASE_URL}/api/clear-cache?file=nonexistent_file_xyz.mp4`, {
        method: "DELETE",
      });
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data).toBeNull();
    });

    it("clears cache for an existing file", async () => {
      // Use a scratch copy, NOT demo.mp4 — clearing demo.mp4's outputs would
      // race other suites (e2e-export) that rely on its analysis.
      const scratch = "e2e-scratch-demo.mp4";
      const { copyFileSync, existsSync } = await import("node:fs");
      const { resolve, dirname } = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      const dataDir = process.env.ARCHIVAR_DATA_DIR ?? "../sample_data/archivar";
      const src = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "sample_data", "test", "demo.mp4");
      const dest = resolve(dataDir, scratch);
      if (!existsSync(dest)) copyFileSync(src, dest);

      const res = await fetch(`${BASE_URL}/api/clear-cache?file=${scratch}`, {
        method: "DELETE",
      });
      expect(res.ok).toBe(true);
      const data = await res.json();
      // Either null (not found) or { status: "cleared", ... }
      if (data !== null) {
        expect(data).toHaveProperty("status");
      }
    });
  });
});

// StatusApi is covered by test/status-list.test.ts (real temp data dir, no mocks).
// WebhookApi is covered by test/webhook-api.test.ts (real local HTTP receiver).

