import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Tests for the --force cache-bypass and purge logic.
 *
 * The workflow engine's force path purges all entries matching a file's
 * outputHash via CacheApi.removeByPrefix() before re-running. These tests
 * exercise that helper directly (the engine delegates to it) plus the
 * purgeOrphans maintenance path.
 */

const writeCalls: string[] = [];

vi.mock("node:fs", () => ({
  readFileSync: () => "{}",
  writeFileSync: (file: string) => {
    writeCalls.push(file);
  },
}));

// Controlled list of "existing" out_* folders returned by fast-glob.
let globFolders: string[] = [];
vi.mock("fast-glob", () => ({
  default: {
    async: () => globFolders,
  },
}));

describe("--force cache purge (removeByPrefix)", () => {
  let CacheApi: typeof import("../src/rpc/cache-api").CacheApi;

  beforeEach(async () => {
    vi.resetModules();
    writeCalls.length = 0;
    globFolders = [];
    const mod = await import("../src/rpc/cache-api");
    CacheApi = mod.CacheApi;
  });

  it("removes only entries whose key contains the hash substring", async () => {
    const api = new CacheApi();
    const HASH = "a1b2c3d4";

    await api.set("scene", `${HASH}-0`, { caption: "scene0" } as never);
    await api.set("scene", `${HASH}-1`, { caption: "scene1" } as never);
    await api.set("scene", "deadbeef-0", { caption: "other" } as never);
    await api.set("aggregated", `full-analysis-${HASH}`, { scenes: [] } as never);

    const removed = await api.removeByPrefix("scene", HASH);

    expect(removed).toBe(2);
    expect(await api.get("scene", `${HASH}-0`, null)).toBeNull();
    expect(await api.get("scene", "deadbeef-0", null as never)).toEqual({ caption: "other" });
    // aggregated table untouched by a scene-scoped purge
    expect(await api.get("aggregated", `full-analysis-${HASH}`, null)).toBeTruthy();
  });

  it("reports zero removed when nothing matches", async () => {
    const api = new CacheApi();
    await api.set("audio", "nope-0", { caption: "x" } as never);
    const removed = await api.removeByPrefix("speech", "missinghash");
    expect(removed).toBe(0);
  });

  it("purgeOrphans removes entries referencing no existing out_* folder", async () => {
    globFolders = [
      "/data/out_Demo2_mp4_a1b2c3d4",
      "/data/out_Demo_mp4_99bb88cc",
    ];

    const api = new CacheApi();
    // Live entries (hashes present on disk)
    await api.set("scene", "a1b2c3d4-0", { caption: "live" } as never);
    await api.set("aggregated", "full-analysis-99bb88cc", { scenes: [] } as never);
    // Orphaned entries (hashes with no out_* folder)
    await api.set("scene", "orphanhash-0", { caption: "orphan" } as never);
    await api.set("speech", "orphanhash-speech-3", { caption: "orphan" } as never);

    const result = await api.purgeOrphans();

    expect(result.totalRemoved).toBe(2);
    expect(await api.get("scene", "a1b2c3d4-0", null)).toBeTruthy();
    expect(await api.get("scene", "orphanhash-0", null)).toBeNull();
  });

  it("purgeOrphans preserves everything when all hashes exist", async () => {
    globFolders = ["/data/out_X_mp4_h1"];
    const api = new CacheApi();
    await api.set("scene", "h1-0", { caption: "keep" } as never);

    const result = await api.purgeOrphans();
    expect(result.totalRemoved).toBe(0);
    expect(await api.get("scene", "h1-0", null)).toBeTruthy();
  });
});
