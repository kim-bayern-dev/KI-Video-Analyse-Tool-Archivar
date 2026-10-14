import { describe, it, expect } from "vitest";
import { remapProcessedCaptions } from "../src/lib/caption-index.js";

/**
 * Regression tests for the keyframe caption misalignment found in the
 * enabledAsFallback path: processBatch keys captions by position in the
 * SKIPPED-FILTERED sublist, while aggregateResults reads captions.get(i) over
 * the FULL filtered list. Without the remap, captions shift left onto the
 * wrong segments (observed: keyframe 000 carried keyframe 003's caption).
 */
describe("remapProcessedCaptions", () => {
  const seg = (name: string) => ({ fileName: name });

  it("returns the same map when nothing was filtered out", () => {
    const filtered = [seg("a"), seg("b")];
    const captions = new Map<number, string>([[0, "cap-a"], [1, "cap-b"]]);
    expect(remapProcessedCaptions(captions, filtered, filtered)).toBe(captions);
  });

  it("shifts captions onto the correct segments when a prefix was skipped", () => {
    // The exact production case: keyframes 000-002 skipped by enabledAsFallback,
    // sublist [003, 004, 005] captioned at positions 0..2.
    const filtered = [seg("000"), seg("001"), seg("002"), seg("003"), seg("004"), seg("005")];
    const processed = filtered.slice(3);
    const captions = new Map<number, string>([[0, "cap-003"], [1, "cap-004"], [2, "cap-005"]]);
    const remapped = remapProcessedCaptions(captions, processed, filtered);
    expect([...remapped.entries()]).toEqual([[3, "cap-003"], [4, "cap-004"], [5, "cap-005"]]);
  });

  it("handles holes in the middle", () => {
    const filtered = [seg("a"), seg("b"), seg("c"), seg("d")];
    const processed = [filtered[0], filtered[2], filtered[3]];
    const captions = new Map<number, string>([[0, "cap-a"], [1, "cap-c"], [2, "cap-d"]]);
    const remapped = remapProcessedCaptions(captions, processed, filtered);
    expect([...remapped.entries()]).toEqual([[0, "cap-a"], [2, "cap-c"], [3, "cap-d"]]);
  });

  it("drops processed items that are not part of the filtered list", () => {
    const filtered = [seg("a"), seg("b")];
    const processed = [filtered[0], seg("stray")];
    const captions = new Map<number, string>([[0, "cap-a"], [1, "cap-stray"]]);
    const remapped = remapProcessedCaptions(captions, processed, filtered);
    expect([...remapped.entries()]).toEqual([[0, "cap-a"]]);
  });

  it("skips positions without a caption (failed segments)", () => {
    const filtered = [seg("a"), seg("b"), seg("c")];
    const processed = [filtered[1], filtered[2]];
    const captions = new Map<number, string>([[1, "cap-c"]]); // position 0 failed
    const remapped = remapProcessedCaptions(captions, processed, filtered);
    expect([...remapped.entries()]).toEqual([[2, "cap-c"]]);
  });
});
