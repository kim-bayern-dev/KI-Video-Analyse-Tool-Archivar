/**
 * Caption index-basis remap for the processing stage.
 *
 * `processBatch` keys its result map by position in the *processed* list. When
 * a pre-filter removed segments (e.g. keyframes skipped by `enabledAsFallback`
 * because their parent scene already has a valid caption), those positions no
 * longer match the full filtered list that `aggregateResults` reads with
 * `captions.get(i)` — every caption after a removed segment would land on the
 * wrong segment. This remaps onto the full-list index basis.
 *
 * Identity (same map returned) when nothing was filtered out. Object identity
 * is used for matching: pre-filters must preserve element references (Array
 *.prototype.filter does).
 */
export function remapProcessedCaptions<T>(
  captions: Map<number, string>,
  processed: T[],
  filtered: T[],
): Map<number, string> {
  if (processed.length === filtered.length && processed.every((p, i) => filtered[i] === p)) return captions;
  const remapped = new Map<number, string>();
  // O(n·m) via indexOf, acceptable here: per-step segment lists are small
  // (tens of items), and the identity fast-path above already covers the
  // common case where the pre-filter removed nothing.
  for (let k = 0; k < processed.length; k++) {
    const filteredIdx = filtered.indexOf(processed[k]);
    if (filteredIdx < 0) continue;
    const caption = captions.get(k);
    if (caption !== undefined) remapped.set(filteredIdx, caption);
  }
  return remapped;
}
