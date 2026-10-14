/**
 * Tests for the mm-encoder-cache frame clamp:
 *  - parseEncoderCacheFrameClamp parses vLLM's 400 body into a reduced
 *    video_num_frames budget (strictly decreasing, sane lower bound)
 *  - callWithPromptRaw retries with reduced video_num_frames on the 400 and
 *    gives up after 3 attempts
 *  - classifyNonFatalReason maps the overflow to "context"
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Capture every request body across calls (no network).
const bodies: Array<Record<string, unknown>> = [];
let failuresBeforeSuccess = 0;

const ENCODER_CACHE_400 =
  '{"error":{"message":"The decoder prompt contains a(n) video item with 8750 embedding tokens, which exceeds the pre-allocated encoder cache size 8192. Please reduce the input size or increase the encoder cache size by setting --limit-mm-per-prompt at startup.","type":"BadRequestError","param":null,"code":400}}';

vi.mock("../src/lib/long-fetch", () => ({
  longFetch: vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string));
    const fail = bodies.length <= failuresBeforeSuccess;
    return {
      ok: !fail,
      status: fail ? 400 : 200,
      statusText: fail ? "Bad Request" : "OK",
      json: async () => ({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      }),
      text: async () => ENCODER_CACHE_400,
      headers: new Map(),
    };
  }),
}));

import {
  MllmApi,
  parseEncoderCacheFrameClamp,
} from "../src/rpc/mllm-api";
import { classifyNonFatalReason } from "../src/lib/non-fatal-error-collector";

beforeEach(() => {
  bodies.length = 0;
  failuresBeforeSuccess = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseEncoderCacheFrameClamp", () => {
  it("parses the real vLLM error into a reduced frame budget", () => {
    // floor(24 * 8192/8750 * 0.9) = 20
    expect(parseEncoderCacheFrameClamp(ENCODER_CACHE_400, 24)).toBe(20);
  });

  it("is strictly decreasing across attempts", () => {
    const first = parseEncoderCacheFrameClamp(ENCODER_CACHE_400, 24)!;
    const second = parseEncoderCacheFrameClamp(ENCODER_CACHE_400, first)!;
    expect(second).toBeLessThan(first);
  });

  it("returns null for unrelated error bodies", () => {
    expect(parseEncoderCacheFrameClamp('{"error":"something else"}', 24)).toBeNull();
    expect(parseEncoderCacheFrameClamp("", 24)).toBeNull();
  });

  it("returns null when the budget would drop below 4 frames", () => {
    expect(parseEncoderCacheFrameClamp(ENCODER_CACHE_400, 4)).toBeNull();
  });
});

describe("MllmApi.callWithPromptRaw — encoder-cache retry", () => {
  function callRaw() {
    return new MllmApi().callWithPromptRaw(
      "http://e", "m", undefined, ["clip.mp4"], "prompt", "video",
      undefined, undefined, false, undefined,
    );
  }

  it("retries with reduced num_frames (dropping fps/do_sample_frames) and succeeds", async () => {
    failuresBeforeSuccess = 1;
    const result = await callRaw();
    expect(result.content).toBe("ok");
    expect(bodies).toHaveLength(2);
    // The retry must use `num_frames` (Qwen arg name — `video_num_frames` is
    // silently ignored) and must DROP fps/do_sample_frames: a set fps takes
    // precedence over num_frames, and do_sample_frames:false disables sampling.
    const first = bodies[0].mm_processor_kwargs as Record<string, unknown>;
    const second = bodies[1].mm_processor_kwargs as Record<string, unknown>;
    expect(first.fps).toBe(1); // resolveMmProcessorKwargs video default
    expect(second.num_frames).toBe(20);
    expect("fps" in second).toBe(false);
    expect("do_sample_frames" in second).toBe(false);
  });

  it("gives up after 3 retries and throws", async () => {
    failuresBeforeSuccess = Number.MAX_SAFE_INTEGER;
    await expect(callRaw()).rejects.toThrow(/API request failed: 400/);
    // initial + 3 retries, frame budget decreasing each time
    expect(bodies).toHaveLength(4);
    const frames = bodies.map(
      (b, i) => ((b.mm_processor_kwargs as Record<string, unknown>).num_frames as number | undefined) ?? (i === 0 ? 24 : undefined),
    );
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i]!).toBeLessThan(frames[i - 1]!);
    }
  });

  it("does not retry for non-video media", async () => {
    failuresBeforeSuccess = 1;
    await expect(
      new MllmApi().callWithPromptRaw(
        "http://e", "m", undefined, ["a.wav"], "prompt", "audio",
        undefined, undefined, false, undefined,
      ),
    ).rejects.toThrow(/API request failed: 400/);
    expect(bodies).toHaveLength(1);
  });
});

describe("classifyNonFatalReason", () => {
  it("maps the encoder-cache overflow to context", () => {
    expect(
      classifyNonFatalReason(new Error(`API request failed: 400 Bad Request\n${ENCODER_CACHE_400}`)),
    ).toBe("context");
  });
});
