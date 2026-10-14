/**
 * Tests for vLLM repetition_detection (v0.25+) wiring:
 *  - resolveRepetitionDetection gates on inferenceEngine === "vllm" and type !== "asr-api"
 *  - getModel() exposes the resolved value as resolvedRepetitionDetection
 *  - callWithPromptRaw attaches repetition_detection as a TOP-LEVEL body field
 *    only when the caller passes it
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Capture the most recent request body across calls (no network).
let lastBody: Record<string, unknown> | undefined;

vi.mock("../src/lib/long-fetch", () => ({
  longFetch: vi.fn(async (_url: string, init: RequestInit) => {
    lastBody = JSON.parse(init.body as string);
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      }),
      text: async () => "",
      headers: new Map(),
    };
  }),
}));

import {
  setArchivarConfig,
  getModel,
  resolveRepetitionDetection,
} from "../src/lib/archivar-config";
import type { ArchivarConfig } from "../src/lib/workflow-types";
import { MllmApi, relaxRepetitionDetection } from "../src/rpc/mllm-api";

const REPETITION_DETECTION = { min_pattern_size: 8, max_pattern_size: 64, min_count: 3 };
const STRUCTURED_REPETITION_DETECTION = { min_pattern_size: 32, max_pattern_size: 64, min_count: 3 };

function makeConfig(withRepetitionDetection = true): ArchivarConfig {
  return {
    auth: { users: [] },
    ...(withRepetitionDetection
      ? { repetitionDetection: REPETITION_DETECTION, repetitionDetectionStructured: STRUCTURED_REPETITION_DETECTION }
      : {}),
    models: [
      { name: "vlm", type: "api", inferenceEngine: "vllm", model: "some-vlm" },
      { name: "vlm-sglang", type: "api", inferenceEngine: "sglang", model: "some-vlm" },
      { name: "vlm-no-engine", type: "api", model: "some-vlm" },
      { name: "asr-vllm", type: "asr-api", inferenceEngine: "vllm", model: "some-asr" },
    ],
  };
}

beforeEach(() => {
  lastBody = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveRepetitionDetection — gating", () => {
  it("returns the config defaults for vllm chat models", () => {
    setArchivarConfig(makeConfig());
    expect(resolveRepetitionDetection({ name: "x", type: "api", inferenceEngine: "vllm" }))
      .toEqual(REPETITION_DETECTION);
  });

  it("returns undefined for ASR models even when served by vllm (speakers repeat themselves)", () => {
    setArchivarConfig(makeConfig());
    expect(resolveRepetitionDetection({ name: "x", type: "asr-api", inferenceEngine: "vllm" }))
      .toBeUndefined();
  });

  it("returns undefined for non-vllm engines", () => {
    setArchivarConfig(makeConfig());
    expect(resolveRepetitionDetection({ name: "x", type: "api", inferenceEngine: "sglang" }))
      .toBeUndefined();
  });

  it("returns undefined when inferenceEngine is unset", () => {
    setArchivarConfig(makeConfig());
    expect(resolveRepetitionDetection({ name: "x", type: "api" })).toBeUndefined();
  });

  it("returns undefined when the config has no repetitionDetection defaults", () => {
    setArchivarConfig(makeConfig(false));
    expect(resolveRepetitionDetection({ name: "x", type: "api", inferenceEngine: "vllm" }))
      .toBeUndefined();
  });

  it("getModel() attaches resolvedRepetitionDetection per gating rules", () => {
    setArchivarConfig(makeConfig());
    expect(getModel("vlm").resolvedRepetitionDetection).toEqual(REPETITION_DETECTION);
    expect(getModel("vlm-sglang").resolvedRepetitionDetection).toBeUndefined();
    expect(getModel("vlm-no-engine").resolvedRepetitionDetection).toBeUndefined();
    expect(getModel("asr-vllm").resolvedRepetitionDetection).toBeUndefined();
  });
});

describe("MllmApi.callWithPromptRaw — repetition_detection attachment", () => {
  function callRaw(repetitionDetection?: typeof REPETITION_DETECTION) {
    return new MllmApi().callWithPromptRaw(
      "http://e", "m", undefined, [], "prompt", "audio",
      undefined, undefined, false, undefined,
      undefined, undefined, undefined, undefined, undefined,
      undefined, undefined,
      repetitionDetection,
    );
  }

  it("attaches repetition_detection as a top-level body field when provided", async () => {
    await callRaw(REPETITION_DETECTION);
    expect(lastBody!.repetition_detection).toEqual(REPETITION_DETECTION);
  });

  it("omits repetition_detection when not provided", async () => {
    await callRaw(undefined);
    expect(lastBody!.repetition_detection).toBeUndefined();
  });

  it("attaches the milder structured variant when a structured-output transport is active", async () => {
    setArchivarConfig(makeConfig());
    await new MllmApi().callWithPromptRaw(
      "http://e", "m", undefined, [], "prompt", "audio",
      undefined, undefined, false, undefined,
      { type: "object", properties: { ok: { type: "boolean" } } }, "response_format",
      undefined, undefined, undefined, undefined, undefined,
      REPETITION_DETECTION,
    );
    // Schema transport attached; repetition_detection must be the STRUCTURED
    // variant (large min_pattern_size) — small patterns truncate structured
    // JSON mid-document (deterministically, so same-seed retries fail alike).
    expect(lastBody!.response_format).toBeDefined();
    expect(lastBody!.repetition_detection).toEqual(STRUCTURED_REPETITION_DETECTION);
  });

  it("omits repetition_detection on structured calls when no structured variant is configured", async () => {
    setArchivarConfig(makeConfig(false));
    await new MllmApi().callWithPromptRaw(
      "http://e", "m", undefined, [], "prompt", "audio",
      undefined, undefined, false, undefined,
      { type: "object", properties: { ok: { type: "boolean" } } }, "response_format",
      undefined, undefined, undefined, undefined, undefined,
      REPETITION_DETECTION,
    );
    expect(lastBody!.response_format).toBeDefined();
    expect(lastBody!.repetition_detection).toBeUndefined();
  });

  it("attaches repetition_detection when schema mode is explicitly off", async () => {
    await new MllmApi().callWithPromptRaw(
      "http://e", "m", undefined, [], "prompt", "audio",
      undefined, undefined, false, undefined,
      { type: "object", properties: { ok: { type: "boolean" } } }, false,
      undefined, undefined, undefined, undefined, undefined,
      REPETITION_DETECTION,
    );
    expect(lastBody!.response_format).toBeUndefined();
    expect(lastBody!.repetition_detection).toEqual(REPETITION_DETECTION);
  });
});

describe("relaxRepetitionDetection", () => {
  it("returns the base unchanged on attempt 0", () => {
    expect(relaxRepetitionDetection(STRUCTURED_REPETITION_DETECTION, 0))
      .toEqual(STRUCTURED_REPETITION_DETECTION);
  });

  it("doubles pattern sizes and increments min_count per attempt", () => {
    expect(relaxRepetitionDetection(STRUCTURED_REPETITION_DETECTION, 1)).toEqual({
      min_pattern_size: 64, max_pattern_size: 128, min_count: 4,
    });
    expect(relaxRepetitionDetection(STRUCTURED_REPETITION_DETECTION, 2)).toEqual({
      min_pattern_size: 128, max_pattern_size: 256, min_count: 5,
    });
  });

  it("passes undefined through", () => {
    expect(relaxRepetitionDetection(undefined, 2)).toBeUndefined();
  });

  it("callWithPromptRaw sends the relaxed structured variant on retry attempts", async () => {
    setArchivarConfig(makeConfig());
    await new MllmApi().callWithPromptRaw(
      "http://e", "m", undefined, [], "prompt", "audio",
      undefined, undefined, false, undefined,
      { type: "object", properties: { ok: { type: "boolean" } } }, "response_format",
      undefined, undefined, undefined, undefined, undefined,
      REPETITION_DETECTION, undefined, undefined, 1,
    );
    expect(lastBody!.repetition_detection).toEqual({
      min_pattern_size: 64, max_pattern_size: 128, min_count: 4,
    });
  });
});
