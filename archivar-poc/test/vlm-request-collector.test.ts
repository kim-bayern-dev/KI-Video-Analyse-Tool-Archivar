/**
 * Tests for the per-run VLM request collector
 * ([`src/lib/vlm-request-collector.ts`](../src/lib/vlm-request-collector.ts)):
 * per-request actuals, min/max aggregates, model/mixed/null, incremental
 * artifact writes, no-op outside a run.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  VlmRequestAccumulator,
  vlmRequestCapture,
  requestPhaseCapture,
  recordVlmRequest,
  emptyVlmRequestsFile,
  type VlmRequestsFile,
} from "../src/lib/vlm-request-collector";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vlm-req-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const entry = (id: string, model: string, inputTokens: number, outputTokens: number, maxTokens: number | null, timeElapsedSecs: number) => ({
  id, model, inputTokens, outputTokens, maxTokens,
  totalTokens: inputTokens + outputTokens,
  timeElapsedSecs,
});

describe("VlmRequestAccumulator", () => {
  it("records requests and computes min/max aggregates", () => {
    const acc = new VlmRequestAccumulator();
    acc.add(entry("LLM-1", "m", 100, 10, 16384, 1.5));
    acc.add(entry("LLM-2", "m", 5000, 900, 16384, 12.0));
    acc.add(entry("LLM-3", "m", 800, 50, null, 0.5));
    const s = acc.summarize();
    expect(s.model).toBe("m");
    expect(s.requests).toHaveLength(3);
    expect(s.minInputTokens).toBe(100);
    expect(s.maxInputTokens).toBe(5000);
    expect(s.minOutputTokens).toBe(10);
    expect(s.maxOutputTokens).toBe(900);
    expect(s.minTotalTokens).toBe(110);
    expect(s.maxTotalTokens).toBe(5900);
    expect(s.minTimeElapsedSecs).toBe(0.5);
    expect(s.maxTimeElapsedSecs).toBe(12.0);
    expect(s.requests[2].maxTokens).toBeNull();
  });

  it("reports model 'mixed' across models and null aggregates when empty", () => {
    const acc = new VlmRequestAccumulator();
    expect(acc.summarize().model).toBeNull();
    expect(acc.summarize().minInputTokens).toBeNull();
    acc.add(entry("LLM-1", "a", 1, 1, null, 1));
    acc.add(entry("LLM-2", "b", 2, 2, null, 2));
    expect(acc.summarize().model).toBe("mixed");
  });

  it("rewrites the artifact file on every add", () => {
    const p = join(dir, "vlm-requests.json");
    const acc = new VlmRequestAccumulator(p);
    acc.add(entry("LLM-1", "m", 10, 1, 100, 0.1));
    let onDisk = JSON.parse(readFileSync(p, "utf-8")) as VlmRequestsFile;
    expect(onDisk.requests).toHaveLength(1);
    acc.add(entry("LLM-2", "m", 20, 2, 100, 0.2));
    onDisk = JSON.parse(readFileSync(p, "utf-8")) as VlmRequestsFile;
    expect(onDisk.requests).toHaveLength(2);
    expect(onDisk.maxInputTokens).toBe(20);
  });

  it("emptyVlmRequestsFile is the initial artifact shape", () => {
    expect(emptyVlmRequestsFile()).toMatchObject({ model: null, requests: [], minInputTokens: null });
  });
});

describe("recordVlmRequest (ALS)", () => {
  it("is a no-op outside a run", () => {
    expect(() => recordVlmRequest(entry("LLM-1", "m", 1, 1, null, 1))).not.toThrow();
  });

  it("records into the active store", () => {
    const acc = new VlmRequestAccumulator();
    vlmRequestCapture.run(acc, () => {
      recordVlmRequest(entry("LLM-9", "m", 3, 4, 100, 0.3));
    });
    expect(acc.summarize().requests).toHaveLength(1);
    expect(acc.summarize().requests[0].id).toBe("LLM-9");
  });
});

describe("VlmRequestEntry.type (pipeline phase)", () => {
  it("defaults to the active requestPhaseCapture store", () => {
    const acc = new VlmRequestAccumulator();
    requestPhaseCapture.run("hoa", () => {
      acc.add(entry("LLM-1", "m", 1, 1, null, 1));
    });
    requestPhaseCapture.run("summary", () => {
      acc.add(entry("LLM-2", "m", 1, 1, null, 1));
    });
    expect(acc.summarize().requests.map((r) => r.type)).toEqual(["hoa", "summary"]);
  });

  it("defaults to 'caption' without an active phase", () => {
    const acc = new VlmRequestAccumulator();
    acc.add(entry("LLM-1", "m", 1, 1, null, 1));
    expect(acc.summarize().requests[0].type).toBe("caption");
  });

  it("keeps an explicitly provided type", () => {
    const acc = new VlmRequestAccumulator();
    requestPhaseCapture.run("aggregation", () => {
      acc.add({ ...entry("LLM-1", "m", 1, 1, null, 1), type: "hoa" });
    });
    expect(acc.summarize().requests[0].type).toBe("hoa");
  });
});
