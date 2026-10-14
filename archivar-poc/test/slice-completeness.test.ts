/**
 * WS5 — completeness invariant over post-processing time slices.
 *
 * Rules (see src/lib/slice-completeness.ts):
 *  - scene slice >= 1s without caption → violation
 *  - scene slice < 1s without own caption AND without a keyframe slice with the
 *    same sceneIndex carrying a caption → violation
 *  - speech slice without caption (transcript lives in caption) → violation
 *  - noise/harmonic/keyframe/silence slices are exempt
 *  - sceneIndex -1 scene slices still count
 */
import { describe, it, expect } from "vitest";
import type { FileRef, SliceType, TimeSlice } from "../src/lib/plugin-types.js";
import { findCompletenessViolations } from "../src/lib/slice-completeness.js";

function makeFileRef(name = "seg-0.mp4"): FileRef {
  return {
    fileName: name,
    extension: "mp4",
    mediaType: "video",
    outputHash: "hash-123",
    serverUrl: "",
    containerPath: `/data/${name}`,
    hostPath: `/data/${name}`,
    relativePath: name,
  };
}

function makeSlice(overrides: Partial<TimeSlice> & { type: SliceType }): TimeSlice {
  const from = overrides.fromSeconds ?? 0;
  const to = overrides.toSeconds ?? 10;
  return {
    id: overrides.id ?? `${overrides.type}:${overrides.sceneIndex ?? 0}:0:${from}-${to}`,
    index: 0,
    from: String(from),
    to: String(to),
    fromSeconds: from,
    toSeconds: to,
    durationSeconds: to - from,
    sceneIndex: 0,
    caption: "caption",
    sourceFile: makeFileRef(),
    parentFile: makeFileRef(),
    ...overrides,
  };
}

describe("findCompletenessViolations (WS5)", () => {
  it("flags a scene slice >= 1s without a caption", () => {
    const violations = findCompletenessViolations([
      makeSlice({ type: "scene", fromSeconds: 0, toSeconds: 5, caption: "" }),
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("scene slice");
    expect(violations[0]).toContain("has no caption");
  });

  it("is silent for a scene slice >= 1s with a caption", () => {
    expect(
      findCompletenessViolations([
        makeSlice({ type: "scene", fromSeconds: 0, toSeconds: 5, caption: "a scene caption" }),
      ]),
    ).toEqual([]);
  });

  it("flags a scene slice < 1s without own caption and without keyframe fallback", () => {
    const violations = findCompletenessViolations([
      makeSlice({ type: "scene", fromSeconds: 0, toSeconds: 0.5, caption: "" }),
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("keyframe caption fallback");
  });

  it("is silent for a scene slice < 1s with its own caption", () => {
    expect(
      findCompletenessViolations([
        makeSlice({ type: "scene", fromSeconds: 0, toSeconds: 0.5, caption: "short but captioned" }),
      ]),
    ).toEqual([]);
  });

  it("is silent for a scene slice < 1s covered by a keyframe caption with the same sceneIndex", () => {
    expect(
      findCompletenessViolations([
        makeSlice({ type: "scene", fromSeconds: 0, toSeconds: 0.5, caption: "", sceneIndex: 3 }),
        makeSlice({ type: "keyframe", fromSeconds: 0.1, toSeconds: 0.2, caption: "keyframe caption", sceneIndex: 3 }),
      ]),
    ).toEqual([]);
  });

  it("does not accept a keyframe caption from a DIFFERENT sceneIndex as fallback", () => {
    const violations = findCompletenessViolations([
      makeSlice({ type: "scene", fromSeconds: 0, toSeconds: 0.5, caption: "", sceneIndex: 3 }),
      makeSlice({ type: "keyframe", fromSeconds: 0.1, toSeconds: 0.2, caption: "keyframe caption", sceneIndex: 4 }),
    ]);
    expect(violations).toHaveLength(1);
  });

  it("flags a speech slice without a transcript (empty caption)", () => {
    const violations = findCompletenessViolations([
      makeSlice({ type: "speech", fromSeconds: 0, toSeconds: 3, caption: "   " }),
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("speech slice");
    expect(violations[0]).toContain("no transcript");
  });

  it("is silent for a speech slice with a transcript", () => {
    expect(
      findCompletenessViolations([
        makeSlice({ type: "speech", fromSeconds: 0, toSeconds: 3, caption: "Hallo und herzlich willkommen." }),
      ]),
    ).toEqual([]);
  });

  it("ignores noise, harmonic, keyframe and silence slices", () => {
    expect(
      findCompletenessViolations([
        makeSlice({ type: "noise", caption: "" }),
        makeSlice({ type: "harmonic", caption: "" }),
        makeSlice({ type: "keyframe", caption: "" }),
        makeSlice({ type: "silence", caption: "" }),
      ]),
    ).toEqual([]);
  });

  it("still checks scene slices with sceneIndex -1 (unassigned segments)", () => {
    const violations = findCompletenessViolations([
      makeSlice({ type: "scene", fromSeconds: 0, toSeconds: 4, caption: "", sceneIndex: -1 }),
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("scene -1");
  });

  it("collects multiple violations across slice types", () => {
    const violations = findCompletenessViolations([
      makeSlice({ type: "scene", fromSeconds: 0, toSeconds: 5, caption: "" }),
      makeSlice({ type: "speech", fromSeconds: 5, toSeconds: 8, caption: "" }),
      makeSlice({ type: "scene", fromSeconds: 8, toSeconds: 12, caption: "ok", sceneIndex: 1 }),
    ]);
    expect(violations).toHaveLength(2);
  });
});
