import { describe, it, expect } from "vitest";
import {
  resolveSegmentScenesConfig,
  resolveEffectiveSegmentScenesConfig,
  buildSegmentScenesCliArgs,
  buildInferenceMmProcessorKwargs,
  getVisualCaptionFrequency,
  getVisualCaptionQuality,
  getShortClipFpsRule,
  resolveSegmentFps,
  resolvePhysicalReencodeFps,
  setArchivarConfig,
  MIN_CAPTION_MAX_WIDTH_PX,
  MIN_CAPTION_MAX_HEIGHT_PX,
} from "../src/lib/archivar-config.js";
import type { ArchivarConfig } from "../src/lib/workflow-types.js";

describe("resolveSegmentScenesConfig", () => {
  it("returns disabled config for undefined input", () => {
    expect(resolveSegmentScenesConfig(undefined)).toEqual({ enabled: false });
  });

  it("returns disabled config for explicit false", () => {
    expect(resolveSegmentScenesConfig(false)).toEqual({ enabled: false });
  });

  it("normalizes the legacy boolean true shorthand", () => {
    expect(resolveSegmentScenesConfig(true)).toEqual({ enabled: true });
  });

  it("preserves an object config and defaults omitted `enabled` to true", () => {
    const cfg = { fps: 12, maxHeightPx: 720 };
    expect(resolveSegmentScenesConfig(cfg)).toEqual({ enabled: true, fps: 12, maxHeightPx: 720 });
  });

  it("respects an explicitly-disabled object config", () => {
    const cfg = { enabled: false, fps: 12 };
    expect(resolveSegmentScenesConfig(cfg)).toEqual({ enabled: false, fps: 12 });
  });
});

describe("buildSegmentScenesCliArgs", () => {
  it("returns no args when nothing is configured", () => {
    expect(buildSegmentScenesCliArgs({ enabled: true })).toEqual([]);
  });

  it("maps maxLengthPerClipInSecs to the --max-len flag (space-separated)", () => {
    const args = buildSegmentScenesCliArgs({ enabled: true, maxLengthPerClipInSecs: 30 });
    expect(args).toEqual(["--max-len", "30"]);
  });

  it("emits all four flags as space-separated argv tokens in a stable order", () => {
    // The segment-scenes run.sh rejects the equals form (`--fps=4`); it expects
    // `--flag value` as two separate argv tokens.
    const args = buildSegmentScenesCliArgs({
      enabled: true,
      fps: 4,
      maxLengthPerClipInSecs: 60,
      maxWidthPx: 512,
      maxHeightPx: 512,
    });
    expect(args).toEqual([
      "--fps", "4",
      "--max-len", "60",
      "--max-width-px", "512",
      "--max-height-px", "512",
    ]);
  });

  it("passes through explicitly-set numeric values including zero", () => {
    const args = buildSegmentScenesCliArgs({ enabled: true, fps: 0 });
    expect(args).toEqual(["--fps", "0"]);
  });
});

// ============================================================================
// resolveEffectiveSegmentScenesConfig — top-level visualCaption* multipliers
// ============================================================================

function makeConfig(extra: Partial<ArchivarConfig> = {}): ArchivarConfig {
  return { auth: { users: [] }, ...extra };
}

const BASE_SCENES = { enabled: true, fps: 1, maxWidthPx: 1600, maxHeightPx: 900 };

describe("getVisualCaptionFrequency / getVisualCaptionQuality", () => {
  it("default to 1 when the fields are unset", () => {
    setArchivarConfig(makeConfig());
    expect(getVisualCaptionFrequency()).toBe(1);
    expect(getVisualCaptionQuality()).toBe(1);
  });
});

describe("resolveEffectiveSegmentScenesConfig", () => {
  it("leaves base values untouched when no multipliers are configured", () => {
    setArchivarConfig(makeConfig());
    expect(resolveEffectiveSegmentScenesConfig(BASE_SCENES)).toEqual(BASE_SCENES);
  });

  it("halves fps with visualCaptionFrequency 0.5 — CLI args and inference kwargs agree", () => {
    setArchivarConfig(makeConfig({ visualCaptionFrequency: 0.5 }));
    const effective = resolveEffectiveSegmentScenesConfig(BASE_SCENES);
    expect(effective.fps).toBe(0.5);
    expect(buildSegmentScenesCliArgs(effective)).toEqual([
      "--fps", "0.5",
      "--max-width-px", "1600",
      "--max-height-px", "900",
    ]);
    // Inference side must sample at the same rate the pre-processor emits.
    expect(buildInferenceMmProcessorKwargs(undefined, undefined, effective, "video")).toEqual({ fps: 0.5 });
  });

  it("quarters fps with visualCaptionFrequency 0.25", () => {
    setArchivarConfig(makeConfig({ visualCaptionFrequency: 0.25 }));
    expect(resolveEffectiveSegmentScenesConfig(BASE_SCENES).fps).toBe(0.25);
  });

  it("halves resolution with visualCaptionQuality 0.5", () => {
    setArchivarConfig(makeConfig({ visualCaptionQuality: 0.5 }));
    const effective = resolveEffectiveSegmentScenesConfig(BASE_SCENES);
    expect(effective.maxWidthPx).toBe(800);
    expect(effective.maxHeightPx).toBe(450);
    expect(effective.fps).toBe(1); // untouched
  });

  it("quarters resolution with visualCaptionQuality 0.25 — clamped at the legibility floor", () => {
    setArchivarConfig(makeConfig({ visualCaptionQuality: 0.25 }));
    const effective = resolveEffectiveSegmentScenesConfig(BASE_SCENES);
    expect(effective.maxWidthPx).toBe(MIN_CAPTION_MAX_WIDTH_PX);
    expect(effective.maxHeightPx).toBe(MIN_CAPTION_MAX_HEIGHT_PX);
  });

  it("applies both multipliers independently", () => {
    setArchivarConfig(makeConfig({ visualCaptionFrequency: 0.5, visualCaptionQuality: 0.25 }));
    const effective = resolveEffectiveSegmentScenesConfig(BASE_SCENES);
    expect(effective).toEqual({ enabled: true, fps: 0.5, maxWidthPx: MIN_CAPTION_MAX_WIDTH_PX, maxHeightPx: MIN_CAPTION_MAX_HEIGHT_PX });
  });

  it("never lets caps drop below the legibility floor, even without multipliers", () => {
    setArchivarConfig(makeConfig());
    expect(resolveEffectiveSegmentScenesConfig({ enabled: true, maxWidthPx: 608, maxHeightPx: 342 }))
      .toEqual({ enabled: true, maxWidthPx: MIN_CAPTION_MAX_WIDTH_PX, maxHeightPx: MIN_CAPTION_MAX_HEIGHT_PX });
  });

  it("rounds fractional pixel results to integers", () => {
    setArchivarConfig(makeConfig({ visualCaptionQuality: 0.5 }));
    expect(resolveEffectiveSegmentScenesConfig({ enabled: true, maxWidthPx: 1601 }).maxWidthPx).toBe(801);
  });

  it("leaves unset base values unset — no flags are emitted", () => {
    setArchivarConfig(makeConfig({ visualCaptionFrequency: 0.5, visualCaptionQuality: 0.5 }));
    const effective = resolveEffectiveSegmentScenesConfig(true);
    expect(effective).toEqual({ enabled: true });
    expect(buildSegmentScenesCliArgs(effective)).toEqual([]);
  });
});

describe("visual caption scale validation", () => {
  it("rejects values outside {1, 0.5, 0.25} at setArchivarConfig", () => {
    const bad = makeConfig();
    (bad as { visualCaptionFrequency?: number }).visualCaptionFrequency = 0.75;
    expect(() => setArchivarConfig(bad)).toThrow("Invalid visualCaptionFrequency: 0.75");
  });

  it("rejects an invalid visualCaptionQuality", () => {
    const bad = makeConfig();
    (bad as { visualCaptionQuality?: number }).visualCaptionQuality = 0.3;
    expect(() => setArchivarConfig(bad)).toThrow("Invalid visualCaptionQuality: 0.3");
  });
});

describe("short-clip fps rule", () => {
  it("is inactive when unset — fps passes through unchanged", () => {
    setArchivarConfig(makeConfig());
    expect(getShortClipFpsRule()).toBeUndefined();
    expect(resolveSegmentFps(0.5, 2)).toBe(0.5);
    expect(resolvePhysicalReencodeFps(0.5)).toBe(0.5);
  });

  it("raises fps for clips shorter than the threshold", () => {
    setArchivarConfig(makeConfig({ shortClipMaxLengthSec: 5, shortClipMinFps: 1 }));
    expect(resolveSegmentFps(0.5, 2.5)).toBe(1);
    expect(resolveSegmentFps(0.25, 4.99)).toBe(1);
  });

  it("keeps the base fps for clips at or above the threshold", () => {
    setArchivarConfig(makeConfig({ shortClipMaxLengthSec: 5, shortClipMinFps: 1 }));
    expect(resolveSegmentFps(0.5, 5)).toBe(0.5);
    expect(resolveSegmentFps(0.5, 30)).toBe(0.5);
  });

  it("never lowers a base fps that already exceeds the minimum", () => {
    setArchivarConfig(makeConfig({ shortClipMaxLengthSec: 5, shortClipMinFps: 1 }));
    expect(resolveSegmentFps(2, 2.5)).toBe(2);
  });

  it("passes through when the clip duration is unknown", () => {
    setArchivarConfig(makeConfig({ shortClipMaxLengthSec: 5, shortClipMinFps: 1 }));
    expect(resolveSegmentFps(0.5, undefined)).toBe(0.5);
  });

  it("floors the physical re-encode fps at the minimum", () => {
    setArchivarConfig(makeConfig({ shortClipMaxLengthSec: 5, shortClipMinFps: 1 }));
    expect(resolvePhysicalReencodeFps(0.5)).toBe(1);
    expect(resolvePhysicalReencodeFps(2)).toBe(2);
  });

  it("applies per-clip in buildInferenceMmProcessorKwargs", () => {
    setArchivarConfig(makeConfig({ shortClipMaxLengthSec: 5, shortClipMinFps: 1 }));
    const scenes = { enabled: true, fps: 0.5 };
    expect(buildInferenceMmProcessorKwargs(undefined, undefined, scenes, "video", 2.5)).toEqual({ fps: 1 });
    expect(buildInferenceMmProcessorKwargs(undefined, undefined, scenes, "video", 30)).toEqual({ fps: 0.5 });
  });

  it("rejects a half-configured rule at setArchivarConfig", () => {
    expect(() => setArchivarConfig(makeConfig({ shortClipMaxLengthSec: 5 }))).toThrow("must be set together");
    expect(() => setArchivarConfig(makeConfig({ shortClipMinFps: 1 }))).toThrow("must be set together");
  });

  it("rejects non-positive values at setArchivarConfig", () => {
    expect(() => setArchivarConfig(makeConfig({ shortClipMaxLengthSec: 0, shortClipMinFps: 1 }))).toThrow("must be positive");
    expect(() => setArchivarConfig(makeConfig({ shortClipMaxLengthSec: 5, shortClipMinFps: -1 }))).toThrow("must be positive");
  });
});
