/**
 * Unit tests for the aggregation minimum-size constraint helpers.
 *
 * These cover the pure, model-free "balanced forward sweep" merge algorithm and
 * the two weight functions (distinct scenes, group duration) used by both
 * grouping layers (slice -> aggregation in workflow-engine, aggregation -> HOA
 * in the default plugin).
 */
import { describe, it, expect } from "vitest";
import {
  enforceMinGroupSize,
  countDistinctScenes,
  groupDurationSeconds,
} from "../src/lib/aggregation-constraints.js";

// ── enforceMinGroupSize ────────────────────────────────────────────────────

describe("enforceMinGroupSize", () => {
  it("returns copies of empty / single-group input unchanged", () => {
    expect(enforceMinGroupSize([], () => true)).toEqual([]);
    const single = [["a"]];
    const out = enforceMinGroupSize(single, () => true);
    expect(out).toEqual([["a"]]);
    // even when the single group IS undersized, it is kept as-is
    expect(enforceMinGroupSize([["a"]], () => true)).toEqual([["a"]]);
  });

  it("merges nothing when the predicate is never true", () => {
    const groups = [["a"], ["b"], ["c"]];
    const out = enforceMinGroupSize(groups, () => false);
    expect(out.map((g) => g.length)).toEqual([1, 1, 1]);
    expect(out).toEqual([["a"], ["b"], ["c"]]);
  });

  it("collapses everything into one group when the predicate is always true", () => {
    const out = enforceMinGroupSize([["a"], ["b"], ["c"]], () => true);
    expect(out).toEqual([["a", "b", "c"]]);
  });

  it("balances 10 singletons into 5 pairs (count < 2 predicate)", () => {
    const groups = Array.from({ length: 10 }, (_, i) => [i]);
    const out = enforceMinGroupSize(groups, (g) => g.length < 2);
    expect(out).toHaveLength(5);
    expect(out.every((g) => g.length === 2)).toBe(true);
    expect(out.flat()).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("folds an odd trailing singleton into its predecessor (3 singletons -> 1 group)", () => {
    const out = enforceMinGroupSize([[0], [1], [2]], (g) => g.length < 2);
    expect(out).toEqual([[0, 1, 2]]);
  });

  it("folds a trailing undersized group into its predecessor [3,1]", () => {
    // weights: g0=3 (ok), g1=1 (too small)
    const out = enforceMinGroupSize([["a", "b", "c"], ["d"]], (g) => g.length < 2);
    expect(out).toEqual([["a", "b", "c", "d"]]);
  });

  it("pulls a large neighbour into a leading singleton [1,3]", () => {
    // g0=1 (too small) absorbs g1 -> weight 4
    const out = enforceMinGroupSize([["a"], ["b", "c", "d"]], (g) => g.length < 2);
    expect(out).toEqual([["a", "b", "c", "d"]]);
  });

  it("balances [1,3,1,3] into [4,4]", () => {
    const out = enforceMinGroupSize(
      [["a"], ["b", "c", "d"], ["e"], ["f", "g", "h"]],
      (g) => g.length < 2,
    );
    expect(out.map((g) => g.length)).toEqual([4, 4]);
    expect(out[0]).toEqual(["a", "b", "c", "d"]);
    expect(out[1]).toEqual(["e", "f", "g", "h"]);
  });

  it("cascades on a duration predicate: 3s pieces merge until >= 10s", () => {
    // Each "slice" is 3s wide. minLen = 10 -> need >= 4 pieces (12s) per group.
    const slices = Array.from({ length: 10 }, (_, i) => ({
      fromSeconds: i * 3,
      toSeconds: i * 3 + 3,
    }));
    const groups = slices.map((s) => [s]);
    const out = enforceMinGroupSize(groups, (g) => groupDurationSeconds(g) < 10);
    // 10 pieces of 3s: first group absorbs until >=10s (4 pieces = 12s),
    // second group absorbs the rest. The trailing short group folds back.
    expect(out.every((g) => groupDurationSeconds(g) >= 10)).toBe(true);
    // All slices preserved, no overlaps lost
    expect(out.flat()).toEqual(slices);
  });

  it("keeps an already-valid leading group separate from a short trailing pair", () => {
    // g0 = 30s (valid), g1 = 3s (short), g2 = 3s (short) -> g1+g2 = 6s still short -> folds into g0
    const g0 = [{ fromSeconds: 0, toSeconds: 30 }];
    const g1 = [{ fromSeconds: 30, toSeconds: 33 }];
    const g2 = [{ fromSeconds: 33, toSeconds: 36 }];
    const out = enforceMinGroupSize([g0, g1, g2], (g) => groupDurationSeconds(g) < 10);
    expect(out).toHaveLength(1);
    expect(groupDurationSeconds(out[0])).toBe(36);
  });

  it("does NOT mutate the input groups", () => {
    const input = [[0], [1], [2]];
    const snapshot = input.map((g) => [...g]);
    enforceMinGroupSize(input, (g) => g.length < 2);
    expect(input).toEqual(snapshot);
  });
});

// ── countDistinctScenes ────────────────────────────────────────────────────

describe("countDistinctScenes", () => {
  it("counts distinct non-negative scene indexes", () => {
    expect(
      countDistinctScenes([
        { sceneIndex: 0 },
        { sceneIndex: 0 },
        { sceneIndex: 1 },
        { sceneIndex: 2 },
      ]),
    ).toBe(3);
  });

  it("ignores audio-only slices (sceneIndex === -1)", () => {
    expect(
      countDistinctScenes([
        { sceneIndex: -1 },
        { sceneIndex: -1 },
        { sceneIndex: 0 },
      ]),
    ).toBe(1);
  });

  it("returns 0 when there are only audio-only slices", () => {
    expect(countDistinctScenes([{ sceneIndex: -1 }, { sceneIndex: -1 }])).toBe(0);
  });

  it("returns 0 for an empty array", () => {
    expect(countDistinctScenes([])).toBe(0);
  });
});

// ── groupDurationSeconds ───────────────────────────────────────────────────

describe("groupDurationSeconds", () => {
  it("computes the span as max(to) - min(from)", () => {
    expect(
      groupDurationSeconds([
        { fromSeconds: 5, toSeconds: 10 },
        { fromSeconds: 10, toSeconds: 20 },
      ]),
    ).toBe(15);
  });

  it("returns 0 for an empty group", () => {
    expect(groupDurationSeconds([])).toBe(0);
  });

  it("handles a single slice", () => {
    expect(groupDurationSeconds([{ fromSeconds: 3, toSeconds: 9 }])).toBe(6);
  });

  it("clamps inverted ranges to 0", () => {
    expect(groupDurationSeconds([{ fromSeconds: 10, toSeconds: 2 }])).toBe(0);
  });
});
