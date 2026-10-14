import type { TimeSlice } from "./plugin-types.js";

/**
 * Scene clips shorter than this cannot be captioned reliably (matches
 * MIN_DURATION_SEC in workflow-engine.ts) and are covered by keyframe captions.
 */
// REFACTOR(dry): third copy of the 1.0s minimum-duration threshold — see
// MIN_DURATION_SEC (src/rpc/workflow-engine.ts:110). If the caption-ability
// threshold ever changes, all copies must move together; hoist one shared
// constant into a lib module both server and CSR code can import.
const SCENE_CAPTION_MIN_DURATION_SEC = 1.0;

function hasCaption(caption: string | undefined): boolean {
  return typeof caption === "string" && caption.trim().length > 0;
}

/**
 * Completeness invariant over post-processing time slices (WS5):
 * - every scene slice >= 1s must have a non-empty caption
 * - every scene slice < 1s must have its own caption OR a keyframe slice with
 *   the same sceneIndex carrying a caption (keyframe fallback)
 * - every speech slice must have a non-empty caption (the transcript is stored
 *   in `caption` for speech slices — see buildPostProcessingInput)
 *
 * Slices of other types (noise, harmonic, keyframe, silence) are exempt.
 * sceneIndex -1 scene slices still count as scene slices.
 *
 * Returns human-readable violation strings; empty array means OK.
 * Pure function — never throws, callers decide how to surface the result.
 */
export function findCompletenessViolations(timeSlices: TimeSlice[]): string[] {
  const violations: string[] = [];

  const sceneIndexesWithKeyframeCaption = new Set<number>();
  for (const slice of timeSlices) {
    if (slice.type === "keyframe" && hasCaption(slice.caption)) {
      sceneIndexesWithKeyframeCaption.add(slice.sceneIndex);
    }
  }

  for (const slice of timeSlices) {
    if (slice.type === "scene") {
      if (hasCaption(slice.caption)) continue;
      const where = `${slice.from}–${slice.to}, scene ${slice.sceneIndex}`;
      if (slice.durationSeconds >= SCENE_CAPTION_MIN_DURATION_SEC) {
        violations.push(
          `scene slice ${slice.id} (${where}, ${slice.durationSeconds.toFixed(2)}s) has no caption`,
        );
      } else if (!sceneIndexesWithKeyframeCaption.has(slice.sceneIndex)) {
        violations.push(
          `scene slice ${slice.id} (${where}, ${slice.durationSeconds.toFixed(2)}s < ${SCENE_CAPTION_MIN_DURATION_SEC}s) ` +
          `has no caption and no keyframe caption fallback`,
        );
      }
    } else if (slice.type === "speech") {
      if (!hasCaption(slice.caption)) {
        violations.push(
          `speech slice ${slice.id} (${slice.from}–${slice.to}, scene ${slice.sceneIndex}) has no transcript`,
        );
      }
    }
  }

  return violations;
}
