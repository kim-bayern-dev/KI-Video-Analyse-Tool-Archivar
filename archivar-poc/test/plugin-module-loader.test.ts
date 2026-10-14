/**
 * Tests for the shared plugin module loader
 * ([`src/rpc/post-processing/plugin-module-loader.ts`](../src/rpc/post-processing/plugin-module-loader.ts)):
 * per-process caching (one import per path, shared promise) and no
 * cache-poisoning on failed imports.
 */
import { describe, it, expect } from "vitest";
import {
  loadPluginModule,
  preloadPluginModules,
} from "../src/rpc/post-processing/plugin-module-loader";

describe("loadPluginModule", () => {
  it("returns the same module instance for repeated loads of the same path", async () => {
    const a = await loadPluginModule("./test/fixtures/fake-plugin.ts");
    const b = await loadPluginModule("./test/fixtures/fake-plugin.ts");
    expect(a).toBe(b);
    expect((a as { POST_PROCESSING_CACHE_VERSION?: string }).POST_PROCESSING_CACHE_VERSION).toBe("test-1");
  });

  it("does not poison the cache on failed imports (retry succeeds)", async () => {
    await expect(loadPluginModule("./test/fixtures/does-not-exist.ts")).rejects.toThrow();
    // A subsequent load of a VALID path must be unaffected.
    const mod = await loadPluginModule("./test/fixtures/fake-plugin.ts");
    expect(mod).toBeDefined();
  });
});

describe("preloadPluginModules", () => {
  it("loads enabled plugins and skips disabled ones without throwing", async () => {
    await expect(preloadPluginModules([
      { name: "fake", importPath: "./test/fixtures/fake-plugin.ts", enabled: true },
      { name: "off", importPath: "./test/fixtures/does-not-exist.ts", enabled: false },
      { name: "broken-but-tolerated", importPath: "./test/fixtures/does-not-exist.ts" },
    ] as never)).resolves.toBeUndefined();
  });

  it("tolerates undefined/empty definitions", async () => {
    await expect(preloadPluginModules(undefined)).resolves.toBeUndefined();
    await expect(preloadPluginModules([])).resolves.toBeUndefined();
  });
});
