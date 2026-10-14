/**
 * Unit tests for deriveSegmentSeed (workflow-engine.ts) — per-segment seed
 * decorrelation (bounded experiment 2026-09-04): misreads must fragment
 * across segments while runs stay deterministic per config.
 */
import { describe, it, expect } from "vitest";
import { deriveSegmentSeed } from "../src/rpc/workflow-engine.js";

describe("deriveSegmentSeed", () => {
  it("derives seed + segment index", () => {
    expect(deriveSegmentSeed(84, 0)).toBe(84);
    expect(deriveSegmentSeed(84, 7)).toBe(91);
  });

  it("is deterministic for the same inputs (run reproducibility)", () => {
    expect(deriveSegmentSeed(84, 7)).toBe(deriveSegmentSeed(84, 7));
  });

  it("falls back to the base seed when the index is unknown", () => {
    expect(deriveSegmentSeed(84, undefined)).toBe(84);
  });
});
