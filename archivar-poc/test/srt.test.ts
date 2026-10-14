/**
 * Unit tests for the pure SRT serializer (src/lib/srt.ts).
 * No mocks, no I/O — verifies timestamp formatting, the canonical example
 * output, and the guard rails (invalid/inverted segments).
 */

import { describe, expect, it } from "vitest";
import { toSrt, type TranscriptSegment } from "../src/lib/srt";

describe("toSrt", () => {
  it("reproduces the canonical SRT example exactly", () => {
    const segments: TranscriptSegment[] = [
      { from: 1250, to: 4820, text: "This is the first transcription segment." },
      { from: 5000, to: 7350, text: "This is the second segment." },
    ];

    const expected =
      "1\n" +
      "00:00:01,250 --> 00:00:04,820\n" +
      "This is the first transcription segment.\n\n" +
      "2\n" +
      "00:00:05,000 --> 00:00:07,350\n" +
      "This is the second segment.\n";

    expect(toSrt(segments)).toBe(expected);
  });

  it("formats hours, minutes, seconds and milliseconds with zero-padding", () => {
    const srt = toSrt([{ from: 0, to: 1, text: "start" }]);
    expect(srt).toContain("00:00:00,000 --> 00:00:00,001");
    expect(srt).toContain("1\nstart\n");
  });

  it("handles durations >= 1 hour", () => {
    // 1h 02m 03s 004ms
    const oneHourTwoMin = 3_723_004;
    const srt = toSrt([{ from: oneHourTwoMin, to: oneHourTwoMin + 500, text: "x" }]);
    expect(srt).toContain("01:02:03,004 --> 01:02:03,504");
  });

  it("normalizes CRLF and CR to single LF and trims surrounding whitespace", () => {
    const srt = toSrt([{ from: 0, to: 100, text: "  hello\r\nworld\rhere  " }]);
    expect(srt).toContain("hello\nworld\nhere");
  });

  it("numbers segments 1-based and contiguously regardless of source order", () => {
    // Deliberately unsorted input: numbering must still be contiguous 1..n in
    // array order (callers are responsible for chronological sorting).
    const srt = toSrt([
      { from: 5000, to: 6000, text: "b" },
      { from: 1000, to: 2000, text: "a" },
    ]);
    const blocks = srt.split("\n\n");
    expect(blocks[0].startsWith("1\n")).toBe(true);
    expect(blocks[1].startsWith("2\n")).toBe(true);
  });

  it("emits a trailing newline only for empty input", () => {
    expect(toSrt([])).toBe("\n");
  });

  it("rejects a segment whose end precedes its start", () => {
    expect(() => toSrt([{ from: 5000, to: 4000, text: "inverted" }])).toThrow(RangeError);
    expect(() => toSrt([{ from: 5000, to: 4000, text: "inverted" }])).toThrow(/Segment 1/);
  });

  it("accepts a zero-length segment (to === from)", () => {
    expect(() => toSrt([{ from: 1000, to: 1000, text: "instant" }])).not.toThrow();
  });

  it("rejects negative timestamps", () => {
    expect(() => toSrt([{ from: -1, to: 100, text: "neg" }])).toThrow(RangeError);
  });

  it("rejects non-finite timestamps", () => {
    expect(() => toSrt([{ from: Number.NaN, to: 100, text: "nan" }])).toThrow(RangeError);
    expect(() => toSrt([{ from: 0, to: Number.POSITIVE_INFINITY, text: "inf" }])).toThrow(RangeError);
  });
});
