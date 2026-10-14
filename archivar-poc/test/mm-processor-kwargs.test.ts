import { describe, it, expect } from "vitest";
import { buildInferenceMmProcessorKwargs } from "../src/lib/archivar-config.js";
import { resolveMmProcessorKwargs } from "../src/rpc/mllm-api.js";

// ============================================================================
// buildInferenceMmProcessorKwargs — pure merge logic (archivar-config.ts)
// ============================================================================

describe("buildInferenceMmProcessorKwargs", () => {
  it("returns undefined when no config is provided", () => {
    expect(buildInferenceMmProcessorKwargs(undefined, undefined, undefined, "video")).toBeUndefined();
  });

  it("returns model kwargs as-is when no step or segmentScenes override", () => {
    const result = buildInferenceMmProcessorKwargs(
      { fps: 4, do_sample_frames: true },
      undefined,
      undefined,
      "video",
    );
    expect(result).toEqual({ fps: 4, do_sample_frames: true });
  });

  it("merges model < step (step wins)", () => {
    const result = buildInferenceMmProcessorKwargs(
      { fps: 4, do_sample_frames: true },
      { fps: 8 },
      undefined,
      "video",
    );
    expect(result).toEqual({ fps: 8, do_sample_frames: true });
  });

  it("injects fps from segmentScenes for video media type", () => {
    const result = buildInferenceMmProcessorKwargs(
      undefined,
      undefined,
      { enabled: true, fps: 2 },
      "video",
    );
    expect(result).toEqual({ fps: 2 });
  });

  it("injects do_sample_frames from segmentScenes for video media type", () => {
    const result = buildInferenceMmProcessorKwargs(
      undefined,
      undefined,
      { enabled: true, doSampleFrames: true },
      "video",
    );
    expect(result).toEqual({ do_sample_frames: true });
  });

  it("injects both fps and do_sample_frames from segmentScenes", () => {
    const result = buildInferenceMmProcessorKwargs(
      undefined,
      undefined,
      { enabled: true, fps: 4, doSampleFrames: true },
      "video",
    );
    expect(result).toEqual({ fps: 4, do_sample_frames: true });
  });

  it("does NOT inject segmentScenes fps for audio media type", () => {
    const result = buildInferenceMmProcessorKwargs(
      undefined,
      undefined,
      { enabled: true, fps: 4, doSampleFrames: true },
      "audio",
    );
    expect(result).toBeUndefined();
  });

  it("does NOT inject segmentScenes fps for image media type", () => {
    const result = buildInferenceMmProcessorKwargs(
      undefined,
      undefined,
      { enabled: true, fps: 4, doSampleFrames: true },
      "image",
    );
    expect(result).toBeUndefined();
  });

  it("segmentScenes overrides model/step for fps (highest precedence)", () => {
    const result = buildInferenceMmProcessorKwargs(
      { fps: 4 },
      { fps: 8 },
      { enabled: true, fps: 2 },
      "video",
    );
    expect(result).toEqual({ fps: 2 });
  });

  it("segmentScenes only injects keys it explicitly sets", () => {
    const result = buildInferenceMmProcessorKwargs(
      { fps: 4, do_sample_frames: true },
      undefined,
      { enabled: true, fps: 2 },
      "video",
    );
    // fps overridden by segmentScenes, do_sample_frames kept from model
    expect(result).toEqual({ fps: 2, do_sample_frames: true });
  });

  it("returns empty object keys only when all sources are empty", () => {
    // Empty object inputs → merged is empty → returns undefined
    const result = buildInferenceMmProcessorKwargs({}, {}, { enabled: true }, "video");
    expect(result).toBeUndefined();
  });
});

// ============================================================================
// resolveMmProcessorKwargs — vLLM defaults + override merge (mllm-api.ts)
// ============================================================================

describe("resolveMmProcessorKwargs", () => {
  it("returns audio defaults (return_audio: false) for audio with no override", () => {
    expect(resolveMmProcessorKwargs("audio")).toEqual({ return_audio: false });
  });

  it("returns video defaults with fps for video with no override", () => {
    const result = resolveMmProcessorKwargs("video");
    expect(result).toEqual({
      return_audio: false,
      use_audio_in_video: false,
      fps: 1,
    });
  });

  it("returns image defaults (return_audio: false) for image with no override", () => {
    expect(resolveMmProcessorKwargs("image")).toEqual({ return_audio: false });
  });

  it("overrides fps when provided for video", () => {
    const result = resolveMmProcessorKwargs("video", { fps: 4 });
    expect(result).toEqual({
      return_audio: false,
      use_audio_in_video: false,
      fps: 4,
    });
  });

  it("adds do_sample_frames when provided", () => {
    const result = resolveMmProcessorKwargs("video", { fps: 4, do_sample_frames: true });
    expect(result).toEqual({
      return_audio: false,
      use_audio_in_video: false,
      fps: 4,
      do_sample_frames: true,
    });
  });

  it("allows overriding return_audio", () => {
    const result = resolveMmProcessorKwargs("audio", { return_audio: true });
    expect(result).toEqual({ return_audio: true });
  });

  it("adds arbitrary new keys without removing defaults", () => {
    const result = resolveMmProcessorKwargs("video", { custom_key: 42 });
    expect(result).toEqual({
      return_audio: false,
      use_audio_in_video: false,
      fps: 1,
      custom_key: 42,
    });
  });

  it("empty override object preserves defaults exactly", () => {
    const result = resolveMmProcessorKwargs("video", {});
    expect(result).toEqual({
      return_audio: false,
      use_audio_in_video: false,
      fps: 1,
    });
  });
});
