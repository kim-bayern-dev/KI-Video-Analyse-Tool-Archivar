/**
 * Tests for the per-run ASR request collector
 * ([`src/lib/asr-request-collector.ts`](../src/lib/asr-request-collector.ts)):
 * sequential ASR-N ids, type always "caption", model, lengthInMins,
 * min/max aggregates, incremental writes, no-op outside a run.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AsrRequestAccumulator,
  asrRequestCapture,
  recordAsrRequest,
  emptyAsrRequestsFile,
  type AsrRequestsFile,
} from "../src/lib/asr-request-collector";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "asr-req-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("AsrRequestAccumulator", () => {
  it("assigns sequential ASR-N ids and forces type caption", () => {
    const acc = new AsrRequestAccumulator();
    acc.add({ model: "parakeet", lengthInMins: 0.5, timeElapsedSecs: 2.1 });
    acc.add({ model: "parakeet", lengthInMins: 1.2, timeElapsedSecs: 3.7 });
    const s = acc.summarize();
    expect(s.requests.map((r) => r.id)).toEqual(["ASR-1", "ASR-2"]);
    expect(s.requests.every((r) => r.type === "caption")).toBe(true);
    expect(s.model).toBe("parakeet");
    expect(s.minLengthMin).toBe(0.5);
    expect(s.maxLengthMin).toBe(1.2);
    expect(s.minTimeElapsedSecs).toBe(2.1);
    expect(s.maxTimeElapsedSecs).toBe(3.7);
  });

  it("handles null lengthInMins in aggregates and 'mixed' models", () => {
    const acc = new AsrRequestAccumulator();
    acc.add({ model: "a", lengthInMins: null, timeElapsedSecs: 1 });
    acc.add({ model: "b", lengthInMins: 2, timeElapsedSecs: 4 });
    const s = acc.summarize();
    expect(s.model).toBe("mixed");
    expect(s.minLengthMin).toBe(2);
    expect(s.maxLengthMin).toBe(2);
  });

  it("empty file shape has null aggregates", () => {
    expect(emptyAsrRequestsFile()).toMatchObject({
      model: null, requests: [], minLengthMin: null, maxTimeElapsedSecs: null,
    });
  });

  it("rewrites the artifact on every add", () => {
    const p = join(dir, "asr-requests.json");
    const acc = new AsrRequestAccumulator(p);
    acc.add({ model: "m", lengthInMins: 0.3, timeElapsedSecs: 1.1 });
    let onDisk = JSON.parse(readFileSync(p, "utf-8")) as AsrRequestsFile;
    expect(onDisk.requests).toHaveLength(1);
    acc.add({ model: "m", lengthInMins: 0.4, timeElapsedSecs: 2.2 });
    onDisk = JSON.parse(readFileSync(p, "utf-8")) as AsrRequestsFile;
    expect(onDisk.requests).toHaveLength(2);
    expect(onDisk.requests[1].id).toBe("ASR-2");
  });
});

describe("recordAsrRequest (ALS)", () => {
  it("is a no-op outside a run", () => {
    expect(() => recordAsrRequest({ model: "m", lengthInMins: 1, timeElapsedSecs: 1 })).not.toThrow();
  });

  it("records into the active store", () => {
    const acc = new AsrRequestAccumulator();
    asrRequestCapture.run(acc, () => {
      recordAsrRequest({ model: "m", lengthInMins: 1.5, timeElapsedSecs: 5 });
    });
    expect(acc.summarize().requests).toHaveLength(1);
    expect(acc.summarize().requests[0].model).toBe("m");
  });
});
