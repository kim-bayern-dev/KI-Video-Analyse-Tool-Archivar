/**
 * Tests for FileApi.tailDebugLog (src/rpc/file-api.ts): the async generator
 * that tails `<fileName>.archivar/debug.log` line by line while a workflow
 * runs. Drives the real generator against a temp data dir (env override),
 * with the log file created and appended WHILE the consumer is reading —
 * mirroring the workflow engine's truncate-at-start + append behaviour.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, appendFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { FileApi } from "../src/rpc/file-api.js";

let prevEnv: string | undefined;

// FileApi resolves the data dir per call from RELATIVE_SAMPLE_DATA_PATH
// (getEnv reads process.env dynamically), so each test points it at a fresh
// temp dir.
const useDataDir = (dir: string) => {
  if (prevEnv === undefined) prevEnv = process.env.RELATIVE_SAMPLE_DATA_PATH;
  process.env.RELATIVE_SAMPLE_DATA_PATH = dir;
};

afterAll(() => {
  if (prevEnv === undefined) delete process.env.RELATIVE_SAMPLE_DATA_PATH;
  else process.env.RELATIVE_SAMPLE_DATA_PATH = prevEnv;
});

describe("FileApi.tailDebugLog", () => {
  it("rejects path traversal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "archivar-tail-"));
    useDataDir(dir);
    try {
      const gen = new FileApi().tailDebugLog("../escape", 10);
      await expect(gen.next()).rejects.toThrow(/path escapes data directory/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("waits for the file, streams appended lines, ends after WORKFLOW COMPLETE (with trailing partial line)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "archivar-tail-"));
    useDataDir(dir);
    const fileName = "video.mp4";
    const archivarDir = join(dir, `${fileName}.archivar`);
    const logPath = join(archivarDir, "debug.log");

    const collected: string[] = [];
    const consumer = (async () => {
      for await (const line of new FileApi().tailDebugLog(fileName, 10)) {
        collected.push(line);
      }
    })();

    // The workflow creates the log (truncated) shortly after the run starts.
    await new Promise((r) => setTimeout(r, 100));
    await mkdir(archivarDir, { recursive: true });
    await writeFile(logPath, "[STEP 2/10] Running pre-processing...\n[PRE-PROCESSING] File: video.mp4\n");
    await new Promise((r) => setTimeout(r, 50));
    // A chunk that ends mid-line exercises the remainder buffer.
    await appendFile(logPath, "[PROCESSING] scene: 4 segments, mo");
    await new Promise((r) => setTimeout(r, 50));
    await appendFile(logPath, "del: Qwen\n=== WORKFLOW COMPLETE: wf ===\n[STEP 10/10] Formatting output...");

    await consumer;

    expect(collected).toEqual([
      "[STEP 2/10] Running pre-processing...",
      "[PRE-PROCESSING] File: video.mp4",
      "[PROCESSING] scene: 4 segments, model: Qwen",
      "=== WORKFLOW COMPLETE: wf ===",
      // trailing partial line (no newline) is flushed at the end
      "[STEP 10/10] Formatting output...",
    ]);
    await rm(dir, { recursive: true, force: true });
  }, 15000);
});
