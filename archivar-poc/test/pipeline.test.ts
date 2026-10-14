import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DSON } from "defuss-dson";
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PostProcessingPluginRunResult } from "../src/lib/types.js";
import { buildClientPluginRpcCompositeApiInstance } from "../src/rpc/post-processing/plugin-api.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const SERVER = process.env.SERVER_URL ?? "http://localhost:8802";
const API_KEY = process.env.API_KEY ?? "your-api-key";
// Same env convention the server uses (RELATIVE_SAMPLE_DATA_PATH); the vitest
// setup file loads .env.local into process.env before this module loads.
const DATA_DIR = process.env.ARCHIVAR_DATA_DIR ?? process.env.RELATIVE_SAMPLE_DATA_PATH ?? "../sample_data/test";
const TEST_FILE = "demo.mp4";
const SOURCE_FILE = resolve(__dirname, "../../sample_data/test/demo.mp4");
const DEST_FILE = resolve(DATA_DIR, TEST_FILE);

/**
 * RPC call helper using DSON encoding.
 * Used internally by the client composite instance for operations like cache clear.
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
    signal: AbortSignal.timeout(600_000), // 10 min timeout for full pipeline
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`RPC ${className}.${methodName} failed: ${res.status} ${res.statusText}\n${text}`);
  }
  const text = await res.text();
  return DSON.parse(text);
}

/**
 * End-to-end integration test for the full configured default workflow pipeline.
 * Runs the complete workflow (pre-processing, processing, post-processing) on a real video file
 * and validates the output structure.
 */
describe("Full Pipeline Integration", () => {
  let copiedByThisRun = false;

  beforeAll(async () => {
    // Skip if SKIP_INTEGRATION_TESTS is set (integration test requiring running server + files)
    if (process.env.SKIP_INTEGRATION_TESTS === "1") return;
    // Copy test fixture to data dir so the server can find it — only when it
    // is not already there (demo.mp4 is part of the archivar corpus; removing
    // the shared file afterwards would break other suites and the app).
    if (existsSync(SOURCE_FILE) && !existsSync(DEST_FILE)) {
      copyFileSync(SOURCE_FILE, DEST_FILE);
      copiedByThisRun = true;
      console.log(`[pipeline] Copied ${SOURCE_FILE} → ${DEST_FILE}`);
    }
  });

  afterAll(() => {
    // Clean up only a copy made by THIS run (never the shared corpus file)
    if (copiedByThisRun && existsSync(DEST_FILE)) {
      rmSync(DEST_FILE);
      console.log(`[pipeline] Cleaned up ${DEST_FILE}`);
    }
  });

  it("runs the default workflow end-to-end on demo.mp4", { timeout: 600_000 }, async ({ skip }) => {
    // Skip integration test unless SKIP_INTEGRATION_TESTS is not set
    if (process.env.SKIP_INTEGRATION_TESTS === "1") return skip();

    // Run the configured default workflow and gate on the health of the
    // models it actually uses (skip when they are unreachable here).
    await import("../archivar.config.js");
    const { getArchivarConfig } = await import("../src/lib/archivar-config.js");
    const workflowName = getArchivarConfig().defaults?.workflow ?? "default-analysis";
    const { getWorkflowModels, skipIfModelUnhealthy } = await import("./utils/live-models.js");
    const used = await getWorkflowModels(workflowName);
    for (const modelName of [used.scene, used.speech]) {
      if (!modelName) continue;
      const reason = await skipIfModelUnhealthy(modelName);
      if (reason) return skip(reason);
    }

    // 1. Clear caches to force fresh processing
    await rpcCall("CacheApi", "clear", ["scene"]);
    console.log("[pipeline] Scene cache cleared");

    // 2. Run full workflow via RPC. Uses a small video from the data dir.
    const result = await rpcCall("AnalyseApi", "runWorkflow", [
      "demo.mp4",        // filePath (must exist in the data dir)
      workflowName,           // configured default workflow
      "json",                 // format
    ]);

    console.log("[pipeline] runWorkflow result type:", typeof result);

    // 3. Verify result structure
    // runWorkflow returns a formatted string (JSON/md/toon). Parse it for "json" format.
    expect(result).toBeDefined();
    expect(typeof result).toBe("string");

    const res = typeof result === "string" ? JSON.parse(result) : result;
    expect(typeof res).toBe("object");
    expect(Array.isArray(res)).toBe(false);

    // Should have scenes (from scene segmentation + captioning)
    if (res.scenes) {
      const scenes = res.scenes as Array<{ caption?: string }>;
      console.log(`[pipeline] Scenes: ${scenes.length}`);
      expect(scenes.length).toBeGreaterThan(0);

      // At least one scene should have a caption
      const captioned = scenes.filter((s) => s.caption && typeof s.caption === "string" && s.caption.trim().length > 0);
      console.log(`[pipeline] Captioned scenes: ${captioned.length}`);
      expect(captioned.length).toBeGreaterThan(0);
    }

    // Should have plugin results from default plugin
    if (res.pluginResults) {
      const pluginResults = res.pluginResults as Array<PostProcessingPluginRunResult>;
      console.log(`[pipeline] Plugin results: ${pluginResults.length}`);
      expect(pluginResults.length).toBeGreaterThan(0);

      const defaultPlugin = pluginResults.find(
        (p: any) => p.pluginName === "default"
      );
      if (defaultPlugin) {
        console.log(`[pipeline] Default plugin version: ${defaultPlugin}`);

        if (defaultPlugin.aggregations) {
          console.log(`[pipeline] Aggregations: ${defaultPlugin.aggregations.length}`);
          expect(defaultPlugin.aggregations.length).toBeGreaterThan(0);
        }

        if (defaultPlugin.errors) {
          console.log(`[pipeline] Plugin errors: ${defaultPlugin.errors.length}`);
          console.log(JSON.stringify(defaultPlugin.errors, null, 2));
        }
      }
    }

    // Should have summary if enabled
    if (res.summary) {
      console.log("[pipeline] Summary present");
      expect(res.summary).not.toBeNull();
    }

    // 4. Construct a client-side Rpc composite instance for file operations
    const clientApi = buildClientPluginRpcCompositeApiInstance(rpcCall, SERVER, API_KEY);

    // 5. Verify demo.mp4 appears in FileApi.listFiles after pipeline run
    const files = await clientApi.file.listFiles("*");
    expect(Array.isArray(files)).toBe(true);
    const fileNames = files.map((f) => f.fileName);
    console.log(`[pipeline] Files listed: ${fileNames.length}`);
    expect(fileNames).toContain("demo.mp4");

    // 6. Verify debug files were created (debug.json and debug.log)
    const debugJson = await clientApi.file.readFile("demo.mp4.archivar/debug.json");
    expect(typeof debugJson).toBe("string");
    expect(debugJson.length).toBeGreaterThan(0);
    const parsedDebug = JSON.parse(debugJson);
    expect(parsedDebug.fileName).toBe("demo.mp4");
    expect(Array.isArray(parsedDebug.scenes)).toBe(true);
    console.log("[pipeline] debug.json verified");

    const debugLog = await clientApi.file.readFile("demo.mp4.archivar/debug.log");
    expect(typeof debugLog).toBe("string");
    expect(debugLog.length).toBeGreaterThan(0);
    // Log should contain step markers from workflow engine
    expect(debugLog).toContain("[STEP");
    console.log("[pipeline] debug.log verified");
  });
});
