/**
 * WS4 — aggregated cache key self-invalidation.
 *
 * The `aggregated` cache key is `${workflowName}-${outputHash}-${versions}`,
 * where `versions` joins each configured (enabled) post-processing plugin's
 * exported POST_PROCESSING_CACHE_VERSION (missing export → "1"). Bumping a
 * plugin's version after a prompt/logic change changes the key, so stale
 * cached entries simply never match again (no migration needed).
 *
 * These tests drive the real `resolveAggregatedCacheKey` helper from
 * workflow-engine.ts with tiny fixture plugin modules.
 */
import { describe, it, expect } from "vitest";
import { resolveAggregatedCacheKey } from "../src/rpc/workflow-engine.js";
import { findAggregatedCacheKey } from "../src/lib/aggregated-cache-key.js";
import type { PostProcessingPluginDefinition } from "../src/lib/workflow-types.js";

function pluginDef(importPath: string, enabled = true): PostProcessingPluginDefinition {
  return { name: importPath, importPath, enabled } as never;
}

describe("resolveAggregatedCacheKey (WS4)", () => {
  it("appends each plugin's POST_PROCESSING_CACHE_VERSION to the key", async () => {
    const key = await resolveAggregatedCacheKey("wf", "hash123", [
      pluginDef("./test/fixtures/fake-plugin-versioned.ts"),
    ]);
    expect(key).toBe("wf-hash123-7");
  });

  it("missing export falls back to \"1\"", async () => {
    const key = await resolveAggregatedCacheKey("wf", "hash123", [
      pluginDef("./test/fixtures/fake-plugin-unversioned.ts"),
    ]);
    expect(key).toBe("wf-hash123-1");
  });

  it("a version bump produces a different key (self-invalidation)", async () => {
    const before = await resolveAggregatedCacheKey("wf", "hash123", [
      pluginDef("./test/fixtures/fake-plugin-versioned.ts"),
    ]);
    const after = await resolveAggregatedCacheKey("wf", "hash123", [
      pluginDef("./test/fixtures/fake-plugin-versioned-bumped.ts"),
    ]);
    expect(before).not.toBe(after);
    expect(after).toBe("wf-hash123-8");
  });

  it("joins versions of multiple plugins; disabled plugins are skipped", async () => {
    const key = await resolveAggregatedCacheKey("wf", "hash123", [
      pluginDef("./test/fixtures/fake-plugin-versioned.ts"),
      pluginDef("./test/fixtures/fake-plugin-unversioned.ts"),
      pluginDef("./test/fixtures/fake-plugin-versioned-bumped.ts", /* enabled */ false),
    ]);
    expect(key).toBe("wf-hash123-7+1");
  });

  it("no post-processing plugins → version segment defaults to \"1\"", async () => {
    expect(await resolveAggregatedCacheKey("wf", "hash123", undefined)).toBe("wf-hash123-1");
    expect(await resolveAggregatedCacheKey("wf", "hash123", [])).toBe("wf-hash123-1");
  });

  it("an unloadable plugin module degrades to \"1\" instead of throwing", async () => {
    const key = await resolveAggregatedCacheKey("wf", "hash123", [
      pluginDef("./test/fixtures/does-not-exist.ts"),
    ]);
    expect(key).toBe("wf-hash123-1");
  });
});

/**
 * WS4 follow-up — CSR/dashboard reads cannot reconstruct the version segment,
 * so they match by the `${workflowName}-${outputHash}` prefix.
 */
describe("findAggregatedCacheKey (WS4 CSR follow-up)", () => {
  it("matches a versioned engine key by prefix", () => {
    expect(findAggregatedCacheKey(["wf-hash123-2", "other-hash123-2"], "wf", "hash123")).toBe("wf-hash123-2");
  });

  it("matches a legacy exact key", () => {
    expect(findAggregatedCacheKey(["wf-hash123"], "wf", "hash123")).toBe("wf-hash123");
  });

  it("prefers the versioned key over a legacy exact key", () => {
    expect(findAggregatedCacheKey(["wf-hash123", "wf-hash123-2"], "wf", "hash123")).toBe("wf-hash123-2");
  });

  it("does not match other workflows or other hashes", () => {
    expect(findAggregatedCacheKey(["wf2-hash123-2", "wf-hash456-2"], "wf", "hash123")).toBeUndefined();
    expect(findAggregatedCacheKey([], "wf", "hash123")).toBeUndefined();
  });

  it("does not treat a workflow-name prefix collision as a match", () => {
    // "wf-extra-hash123-2" belongs to workflow "wf-extra", not "wf"
    expect(findAggregatedCacheKey(["wf-extra-hash123-2"], "wf", "hash123")).toBeUndefined();
  });
});
