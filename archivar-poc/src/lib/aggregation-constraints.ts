/**
 * Aggregation minimum-size constraints.
 *
 * Pure, isomorphic, zero-dependency helpers used by the two grouping layers:
 *  - Level 1 (workflow-engine.ts): slice -> aggregation groups
 *  - Level 2 (default.ts): aggregation -> higher-order-aggregation groups
 *
 * The core idea: pairwise grouping (decideForAggregation etc.) can always
 * produce a boundary, which yields singleton / undersized groups. This module
 * applies a deterministic, model-free "balanced forward sweep" that merges
 * undersized groups into adjacent neighbors WITHOUT re-querying the model.
 */

/**
 * Enforce a minimum size per group by merging undersized groups into adjacent
 * neighbors via a balanced forward sweep.
 *
 * Why this exists: aggregations often become too small (one scene, or only a few
 * seconds). The pairwise model decision can always say "different", leaving
 * singletons. This pass merges them deterministically.
 *
 * Algorithm:
 *  - Append each group to the PREVIOUS group when that previous group is still
 *    `isUndersized`; otherwise start a new group.
 *  - A trailing undersized group is folded into its predecessor.
 *  - This produces BALANCED groups (10 singletons -> 5 pairs), never one
 *    growing blob, and CASCADES naturally for duration rules (it keeps merging
 *    a short group until it stops being undersized or runs out of neighbors).
 *  - A single group is always kept as-is regardless of its size (the global
 *    exception: 1 scene / 1 aggregation).
 *
 * The function never mutates its input; returned groups are fresh arrays.
 */
export function enforceMinGroupSize<T>(
  groups: T[][],
  isUndersized: (group: T[]) => boolean,
): T[][] {
  // A single group (or none) is always kept as-is — the global "only one" case.
  if (groups.length <= 1) {
    return groups.map((g) => [...g]);
  }

  const result: T[][] = [];
  for (const group of groups) {
    const last = result[result.length - 1];
    if (last !== undefined && isUndersized(last)) {
      // Previous accumulated group is still too small → absorb the current one.
      result[result.length - 1] = [...last, ...group];
    } else {
      result.push([...group]);
    }
  }

  // Fold a trailing undersized group into its predecessor so it isn't left as a
  // singleton (e.g. an odd count of singletons pairs up the last one).
  if (result.length > 1 && isUndersized(result[result.length - 1])) {
    const tail = result.pop() as T[];
    result[result.length - 1] = [...result[result.length - 1], ...tail];
  }

  return result;
}

/**
 * Count distinct non-negative scene indexes among a set of slices.
 *
 * Why `>= 0`: `sceneIndex === -1` marks audio-only/no-scene slices
 * (see plugin-types.ts TimeSlice.sceneIndex). Those are not real scenes and
 * must not inflate the scene count used for the minimum-size rule.
 */
export function countDistinctScenes<T extends { sceneIndex: number }>(
  slices: T[],
): number {
  const seen = new Set<number>();
  for (const s of slices) {
    if (s.sceneIndex >= 0) seen.add(s.sceneIndex);
  }
  return seen.size;
}

/**
 * Total duration span of a group of time-ranged slices: max(toSeconds) - min(fromSeconds).
 *
 * Slices within a post-processing group are contiguous and sorted, so this equals
 * last.toSeconds - first.fromSeconds — but we compute min/max defensively so the
 * helper stays correct even for unsorted or gappy input.
 */
export function groupDurationSeconds<
  T extends { fromSeconds: number; toSeconds: number },
>(slices: T[]): number {
  if (slices.length === 0) return 0;
  let minFrom = Infinity;
  let maxTo = -Infinity;
  for (const s of slices) {
    if (s.fromSeconds < minFrom) minFrom = s.fromSeconds;
    if (s.toSeconds > maxTo) maxTo = s.toSeconds;
  }
  // Clamp at 0 in case of malformed (inverted) ranges.
  return Math.max(0, maxTo - minFrom);
}
