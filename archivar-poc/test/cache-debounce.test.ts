import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Tests for the debounced write behavior in makeNewFileStorageBackend (db.ts).
 *
 * We mock node:fs so no real disk I/O occurs. The storage backend defers disk
 * writes via a 500ms debounce window; rapid mutations should collapse into a
 * single write, while explicit timer advancement flushes to disk.
 */

const writeCalls: string[] = [];

vi.mock("node:fs", () => ({
  readFileSync: () => "{}", // empty store on load
  writeFileSync: (file: string) => {
    writeCalls.push(file);
  },
}));

describe("debounced file storage backend", () => {
  let makeBackend: typeof import("../src/db/db").makeNewFileStorageBackend;

  beforeEach(async () => {
    vi.resetModules();
    writeCalls.length = 0;
    vi.useFakeTimers();
    // Re-import after resetting modules so the mocked fs is picked up cleanly.
    const mod = await import("../src/db/db");
    makeBackend = mod.makeNewFileStorageBackend;
  });

  it("collapses multiple rapid setItem calls into a single disk write", async () => {
    const store = makeBackend<string>("debounce-test.db");

    // 50 rapid mutations (simulating batch segment processing)
    for (let i = 0; i < 50; i++) {
      store.setItem(`key-${i}`, `value-${i}`);
    }

    // No write should have happened yet (debounced)
    expect(writeCalls.length).toBe(0);

    // Advance past the debounce window -> single flush
    await vi.advanceTimersByTimeAsync(600);
    expect(writeCalls.length).toBe(1);
  });

  it("returns the latest in-memory value immediately after setItem", () => {
    const store = makeBackend<string>("immediate-test.db");
    store.setItem("a", "first");
    store.setItem("a", "second");
    expect(store.getItem("a")).toBe("second");
  });

  it("persists a removal within the debounce window", async () => {
    const store = makeBackend<string>("remove-test.db");
    store.setItem("k", "v");
    store.removeItem("k");
    expect(store.getItem("k")).toBeNull();

    await vi.advanceTimersByTimeAsync(600);
    expect(writeCalls.length).toBe(1);
  });

  it("flushes once per debounce window across spaced mutations", async () => {
    const store = makeBackend<string>("spaced-test.db");

    store.setItem("a", "1");
    await vi.advanceTimersByTimeAsync(600); // flush #1
    store.setItem("b", "2");
    await vi.advanceTimersByTimeAsync(600); // flush #2

    expect(writeCalls.length).toBe(2);
  });
});
