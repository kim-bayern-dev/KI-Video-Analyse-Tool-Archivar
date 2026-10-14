/**
 * Pure helpers for assigning a temporal segment (speech, keyframe, harmonic,
 * noise) to the scene it belongs to.
 *
 * Invariant: a wrong attribution is worse than none. Overlapping segments go to
 * the scene with the LARGEST overlap (not the first overlapping one); segments
 * with no overlap are only attributed to a nearest scene when the temporal gap
 * is small enough — beyond that they stay unassigned (sceneIndex -1) and the
 * model decides downstream (see decideForAggregation's temporal cap).
 */

export interface SceneTimeRange {
  startTime: number;
  endTime: number;
}

/**
 * The scene with the largest overlap duration with the segment.
 * Ties go to the earliest scene. Returns null when no scene overlaps.
 */
export function findBestOverlapSceneIndex(
  segmentStart: number,
  segmentEnd: number,
  scenes: SceneTimeRange[],
): { index: number; overlapSeconds: number } | null {
  let bestIndex = -1;
  let bestOverlap = 0;
  for (let i = 0; i < scenes.length; i++) {
    const overlap =
      Math.min(segmentEnd, scenes[i].endTime) - Math.max(segmentStart, scenes[i].startTime);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestIndex = i;
    }
  }
  if (bestIndex < 0) return null;
  return { index: bestIndex, overlapSeconds: bestOverlap };
}

/**
 * Temporal gap between the segment's time range and a scene's time range.
 * 0 when they overlap.
 */
function rangeGap(segmentStart: number, segmentEnd: number, scene: SceneTimeRange): number {
  if (segmentEnd < scene.startTime) return scene.startTime - segmentEnd;
  if (segmentStart > scene.endTime) return segmentStart - scene.endTime;
  return 0;
}

/**
 * Midpoint-distance nearest scene, capped by a maximum temporal gap.
 * Returns null when no scene exists or the gap to the nearest scene exceeds
 * `maxGapSec`. Segments entirely before the first scene or after the last
 * scene use the boundary distance as the gap.
 */
export function findNearestSceneIndexWithinGap(
  segmentStart: number,
  segmentEnd: number,
  scenes: SceneTimeRange[],
  maxGapSec: number,
): number | null {
  if (scenes.length === 0) return null;
  if (scenes.length === 1) {
    return rangeGap(segmentStart, segmentEnd, scenes[0]) <= maxGapSec ? 0 : null;
  }

  // Boundary cases: gap is the distance to the first/last scene's edge.
  if (segmentEnd <= scenes[0].startTime) {
    return scenes[0].startTime - segmentEnd <= maxGapSec ? 0 : null;
  }
  if (segmentStart >= scenes[scenes.length - 1].endTime) {
    return segmentStart - scenes[scenes.length - 1].endTime <= maxGapSec
      ? scenes.length - 1
      : null;
  }

  const segmentMid = (segmentStart + segmentEnd) / 2;
  let nearestIndex = 0;
  let minDistance = Infinity;
  for (let i = 0; i < scenes.length; i++) {
    const sceneMid = (scenes[i].startTime + scenes[i].endTime) / 2;
    const distance = Math.abs(segmentMid - sceneMid);
    if (distance < minDistance) {
      minDistance = distance;
      nearestIndex = i;
    }
  }
  return rangeGap(segmentStart, segmentEnd, scenes[nearestIndex]) <= maxGapSec
    ? nearestIndex
    : null;
}
