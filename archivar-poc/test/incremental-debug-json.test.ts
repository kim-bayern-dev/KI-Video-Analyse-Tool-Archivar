/**
 * E2E tests for the incremental debug.json writer (`writeDebugJson`).
 *
 * No mocks: exercises the real `node:fs` against an OS temp directory, then
 * reads the file back from disk. This is the actual contract the workflow
 * milestones rely on:
 *  - no-op when no debug directory is configured
 *  - writes the full result as pretty JSON to `<debugDir>/debug.json`
 *  - never throws on write failure (debug output must not break the workflow)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { writeDebugJson } from "../src/rpc/workflow-engine.js";
import type { AnalysisResult } from "../src/db/db.js";

const RESULT: AnalysisResult = {
  serverUrl: "http://e",
  fileName: "clip.mp4",
  extension: "mp4",
  outputHash: "abc123",
  mediaType: "video",
  scenes: [],
};

describe("writeDebugJson (e2e, real filesystem)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "archivar-debug-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("is a no-op when debugDir is null (no write, no throw)", async () => {
    expect(() => writeDebugJson(null, RESULT, "after-aggregation")).not.toThrow();
  });

  it("writes the result as pretty JSON to <debugDir>/debug.json", async () => {
    writeDebugJson(dir, RESULT, "final");
    const raw = await readFile(join(dir, "debug.json"), "utf8");
    const parsed = JSON.parse(raw) as AnalysisResult;
    expect(parsed.fileName).toBe("clip.mp4");
    expect(parsed.outputHash).toBe("abc123");
    // Pretty-printed (2-space) — not a minified single line.
    expect(raw.includes("\n")).toBe(true);
  });

  it("overwrites on each call so the latest milestone wins", async () => {
    const first: AnalysisResult = { ...RESULT, outputHash: "first" };
    const second: AnalysisResult = { ...RESULT, outputHash: "second" };
    writeDebugJson(dir, first, "after-aggregation");
    writeDebugJson(dir, second, "after-plugin:default");
    const parsed = JSON.parse(await readFile(join(dir, "debug.json"), "utf8")) as AnalysisResult;
    expect(parsed.outputHash).toBe("second");
  });

  it("never throws when the write fails (logs and swallows)", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // debugDir's parent does not exist on disk → writeFileSync throws ENOENT,
    // which writeDebugJson must catch (debug output must never break the run).
    const unwritable = join(dir, "no-such-subdir", "deeper");
    expect(() => writeDebugJson(unwritable, RESULT, "error")).not.toThrow();
    expect(errSpy).toHaveBeenCalled();
  });
});
