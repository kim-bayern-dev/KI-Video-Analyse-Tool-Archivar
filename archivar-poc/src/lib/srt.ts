/**
 * Pure SRT (SubRip) subtitle serializer.
 *
 * Exists so the whole ASR transcript of an analysis can be exported/downloaded
 * as a standard `.srt` file using the EXACT per-clip ASR timings (the speech
 * clip's own start/end), not the coarser segment/scene boundaries.
 *
 * Deliberately dependency-free and I/O-free: it operates on plain millisecond
 * segments and returns a string, making it trivially unit-testable and usable
 * in any runtime (Node, browser, workers). The export pipeline
 * (src/rpc/export.ts) feeds it the speech events; this module never touches
 * files, caches, or config.
 */

/** One subtitle entry. Timestamps are in milliseconds. */
export interface TranscriptSegment {
  /** Start time in milliseconds (inclusive). */
  from: number;
  /** End time in milliseconds (inclusive). */
  to: number;
  /** Spoken text for this clip. Newlines are normalized to "\n". */
  text: string;
}

/**
 * Format milliseconds as an SRT timestamp `HH:MM:SS,mmm`.
 * Rejects non-finite or negative values loudly so bad source data (e.g. an
 * ASR clip missing its end time) fails at the boundary instead of producing
 * a malformed subtitle line a player silently ignores.
 */
function formatSrtTimestamp(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new RangeError(`Invalid timestamp: ${milliseconds}`);
  }

  const totalMs = Math.round(milliseconds);
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1_000);
  const ms = totalMs % 1_000;

  return [
    hours.toString().padStart(2, "0"),
    minutes.toString().padStart(2, "0"),
    seconds.toString().padStart(2, "0"),
  ].join(":") + `,${ms.toString().padStart(3, "0")}`;
}

/**
 * Serialize transcript segments into SRT subtitle text.
 *
 * Segments are emitted in the order given — callers MUST pre-sort by `from`
 * ascending (the export path feeds already chronologically-sorted speech
 * events). Index numbers are 1-based and contiguous regardless of input order.
 * Throws when any segment's `to` precedes its `from` (an inverted clip is a
 * data bug worth surfacing rather than rendering a backwards subtitle).
 */
export function toSrt(segments: readonly TranscriptSegment[]): string {
  return segments
    .map((segment, index) => {
      if (segment.to < segment.from) {
        throw new RangeError(
          `Segment ${index + 1}: "to" must be >= "from"`,
        );
      }

      const text = segment.text
        .replace(/\r\n?/g, "\n")
        .trim();

      return [
        index + 1,
        `${formatSrtTimestamp(segment.from)} --> ${formatSrtTimestamp(segment.to)}`,
        text,
      ].join("\n");
    })
    .join("\n\n")
    .concat("\n");
}
