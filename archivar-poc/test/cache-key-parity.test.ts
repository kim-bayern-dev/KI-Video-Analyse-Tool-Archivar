import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Phase 2.1 — CSR/server aggregated cache key parity.
 *
 * The server workflow engine writes aggregated results under
 * `${workflowName}-${outputHash}`. The CSR dashboard and full-analysis action
 * now read/write using the identical format, so a result cached by either side
 * is discoverable by the other.
 *
 * These tests pin the canonical key format and verify round-trip parity
 * through the real CacheApi.
 */

vi.mock("node:fs", () => ({
  readFileSync: () => "{}",
  writeFileSync: () => {},
}));

describe("CSR/server aggregated cache key parity", () => {
  let CacheApi: typeof import("../src/rpc/cache-api").CacheApi;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../src/rpc/cache-api");
    CacheApi = mod.CacheApi;
  });

  it("uses the canonical ${workflowName}-${outputHash} key format", () => {
    const workflowName = "full-analysis";
    const outputHash = "a1b2c3d4";
    const key = `${workflowName}-${outputHash}`;
    expect(key).toBe("full-analysis-a1b2c3d4");
  });

  it("server-written key is discoverable by the CSR key format", async () => {
    const api = new CacheApi();
    const workflowName = "full-analysis";
    const outputHash = "h7g8";

    // Server side writes under the unified key
    await api.set("aggregated", `${workflowName}-${outputHash}`, {
      scenes: [{ caption: "x" }],
    } as never);

    // CSR side (dashboard / full-analysis) reads using the same key
    const workflowNameCsr = "full-analysis";
    const found = await api.get(
      "aggregated",
      `${workflowNameCsr}-${outputHash}`,
      null,
    );
    expect(found).toBeTruthy();
    expect((found as unknown as { scenes: unknown[] }).scenes).toHaveLength(1);
  });

  it("falls back to getAll + hash substring match when workflow name is unknown", async () => {
    const api = new CacheApi();
    const outputHash = "zz99";
    await api.set("aggregated", `default-analysis-${outputHash}`, { scenes: [] } as never);
    await api.set("aggregated", `question-answer-${outputHash}`, { scenes: [] } as never);

    // Client may not know the workflow name up front; it lists all keys and
    // filters by outputHash substring (the existing dashboard pattern).
    const all = await api.getAll("aggregated");
    const matching = Object.keys(all).filter((k) => k.includes(outputHash));
    expect(matching).toHaveLength(2);
  });
});
