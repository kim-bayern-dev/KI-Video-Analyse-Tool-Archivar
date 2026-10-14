import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDirectoryRobust } from "../src/lib/output-cleanup.js";

/**
 * Tests for removeDirectoryRobust — the stale-output cleanup used by
 * clear-cache and the --force path. The fs-removal path is exercised
 * hermetically; the docker escalation path is verified manually on the dev
 * host (requires the docker group) and intentionally not run in unit tests.
 */
describe("removeDirectoryRobust", () => {
  const roots: string[] = [];

  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  const makeTree = (): { root: string; dir: string } => {
    const root = mkdtempSync(join(tmpdir(), "output-cleanup-"));
    roots.push(root);
    const dir = join(root, "out_test_mp4_deadbeef");
    mkdirSync(join(dir, "scenes"), { recursive: true });
    writeFileSync(join(dir, "scenes", "000_0.1_0.4.mp4"), "x");
    writeFileSync(join(dir, "002_1.6_3.3_speech_deadbeef.mp3"), "y");
    return { root, dir };
  };

  it("removes a writable directory tree via fs", async () => {
    const { dir } = makeTree();
    const result = await removeDirectoryRobust(dir);
    expect(result).toEqual({ ok: true, via: "fs" });
    expect(existsSync(dir)).toBe(false);
  });

  it("succeeds via fs for a nonexistent path (idempotent cleanup)", async () => {
    const root = mkdtempSync(join(tmpdir(), "output-cleanup-"));
    roots.push(root);
    const result = await removeDirectoryRobust(join(root, "does-not-exist"));
    expect(result.ok).toBe(true);
    expect(result.via).toBe("fs");
  });
});
