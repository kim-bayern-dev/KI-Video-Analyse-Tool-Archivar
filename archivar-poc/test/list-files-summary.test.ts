/**
 * Tests for [`FileApi.listFilesSummary`](src/rpc/file-api.ts) — the lightweight
 * listing used by the dashboard/CLI to avoid loading ~70MB of per-segment FileInfo.
 *
 * Verifies (against the real data dir): the summary returns the SAME files as
 * `listFiles` but only the selection fields (no segment arrays), and the payload
 * is dramatically smaller.
 */
import { describe, it, expect } from "vitest";
import { FileApi } from "../src/rpc/file-api";

// Both methods read the same env-resolved data dir, so their file sets must match.
const api = new FileApi();

describe("FileApi.listFilesSummary", () => {
  it("returns the same files as listFiles (by fileName), no duplicates/missing", async () => {
    const full = await api.listFiles("demo*.mp4");
    const summaries = await api.listFilesSummary("demo*.mp4");
    const fullNames = full.map((f) => f.fileName).sort();
    const summaryNames = summaries.map((s) => s.fileName).sort();
    expect(summaryNames).toEqual(fullNames);
  });

  it("carries only selection fields and NO segment arrays", async () => {
    const summaries = await api.listFilesSummary("demo*.mp4");
    expect(summaries.length).toBeGreaterThan(0);
    for (const s of summaries) {
      // Required selection fields present.
      expect(typeof s.fileName).toBe("string");
      expect(["video", "audio", "image", "kfs"]).toContain(s.mediaType);
      // No segment arrays leak into the summary (the whole point).
      expect((s as unknown as Record<string, unknown>).scenes).toBeUndefined();
      expect((s as unknown as Record<string, unknown>).speech).toBeUndefined();
      expect((s as unknown as Record<string, unknown>).keyframes).toBeUndefined();
    }
  });

  it("matches listFiles on the shared summary fields per file", async () => {
    const full = await api.listFiles("demo*.mp4");
    const summaries = await api.listFilesSummary("demo*.mp4");
    const byName = new Map(summaries.map((s) => [s.fileName, s]));
    for (const f of full) {
      const s = byName.get(f.fileName);
      expect(s, `summary for ${f.fileName}`).toBeDefined();
      expect(s!.mediaType).toBe(f.mediaType);
      expect(s!.extension).toBe(f.extension);
      expect(s!.outputHash ?? null).toBe(f.outputHash);
    }
  });

  it("payload is dramatically smaller than the full list", async ({ skip }) => {
    // Use the whole data dir (many analyzed files) to surface the size gap.
    const full = await api.listFiles("*");
    const summaries = await api.listFilesSummary("*");
    const fullBytes = Buffer.byteLength(JSON.stringify(full), "utf8");
    const summaryBytes = Buffer.byteLength(JSON.stringify(summaries), "utf8");
    // eslint-disable-next-line no-console
    console.log(`[listFilesSummary] full=${(fullBytes / 1024).toFixed(1)}KB summary=${(summaryBytes / 1024).toFixed(1)}KB (files=${summaries.length})`);
    // The ratio is only meaningful with many analyzed files (out_* segment
    // arrays) in the data dir — the production case that motivated the summary
    // endpoint was ~70MB of full listings; a small demo corpus cannot prove it.
    if (fullBytes < 1024 * 1024) {
      return skip("data dir holds too little analyzed output for a meaningful payload-ratio assertion");
    }
    // The summary must be at least an order of magnitude smaller (no segment arrays).
    expect(summaryBytes).toBeLessThan(fullBytes / 10);
    expect(summaryBytes).toBeLessThan(200 * 1024); // well under 200KB regardless
  });
});
