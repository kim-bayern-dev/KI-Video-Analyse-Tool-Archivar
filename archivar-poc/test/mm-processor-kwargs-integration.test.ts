import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Integration test: verifies that config-driven mm_processor_kwargs (fps,
 * do_sample_frames) propagate all the way into the actual HTTP request body
 * sent to vLLM's /v1/chat/completions endpoint.
 *
 * The mock replaces longFetch so no real network call is made; we then
 * inspect the JSON body for the expected mm_processor_kwargs.
 */

// We must mock longFetch before importing the module under test.
const mockLongFetch = vi.fn();

// Capture the parsed request body from the last call.
let lastRequestBody: Record<string, unknown> | null = null;

vi.mock("../src/lib/long-fetch.js", () => ({
  longFetch: (...args: unknown[]) => {
    return mockLongFetch(...args);
  },
}));

const { MllmApi } = await import("../src/rpc/mllm-api.js");

function makeOkResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Map([["content-type", "application/json"]]) as unknown as Headers,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

beforeEach(() => {
  lastRequestBody = null;
  mockLongFetch.mockReset();
  mockLongFetch.mockImplementation(async (_url: string, init: RequestInit) => {
    lastRequestBody = JSON.parse(init.body as string);
    return makeOkResponse({
      id: "test",
      object: "chat.completion",
      created: 0,
      model: "test-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "test response" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("callWithPrompt — mm_processor_kwargs propagation", () => {
  it("sends hardcoded video defaults when no override is provided", async () => {
    const api = new MllmApi();
    await api.callWithPrompt(
      "http://test:8901",
      "test-model",
      undefined,
      ["/tmp/test.mp4"],
      "describe",
      "video",
    );

    expect(lastRequestBody).not.toBeNull();
    const mm = (lastRequestBody as Record<string, unknown>).mm_processor_kwargs;
    expect(mm).toEqual({
      return_audio: false,
      use_audio_in_video: false,
      fps: 1,
    });
  });

  it("overrides fps when override is provided for video", async () => {
    const api = new MllmApi();
    await api.callWithPrompt(
      "http://test:8901",
      "test-model",
      undefined,
      ["/tmp/test.mp4"],
      "describe",
      "video",
      undefined,
      undefined,
      false,
      { fps: 4, do_sample_frames: true },
    );

    expect(lastRequestBody).not.toBeNull();
    const mm = (lastRequestBody as Record<string, unknown>).mm_processor_kwargs;
    expect(mm).toEqual({
      return_audio: false,
      use_audio_in_video: false,
      fps: 4,
      do_sample_frames: true,
    });
  });

  it("sends only return_audio:false for audio when no override", async () => {
    const api = new MllmApi();
    await api.callWithPrompt(
      "http://test:8901",
      "test-model",
      undefined,
      ["/tmp/test.wav"],
      "transcribe",
      "audio",
    );

    expect(lastRequestBody).not.toBeNull();
    const mm = (lastRequestBody as Record<string, unknown>).mm_processor_kwargs;
    expect(mm).toEqual({ return_audio: false });
  });

  it("preserves override keys for audio media type", async () => {
    const api = new MllmApi();
    await api.callWithPrompt(
      "http://test:8901",
      "test-model",
      undefined,
      ["/tmp/test.wav"],
      "transcribe",
      "audio",
      undefined,
      undefined,
      false,
      { return_audio: true },
    );

    expect(lastRequestBody).not.toBeNull();
    const mm = (lastRequestBody as Record<string, unknown>).mm_processor_kwargs;
    expect(mm).toEqual({ return_audio: true });
  });
});

describe("callWithPromptRaw — mm_processor_kwargs propagation", () => {
  it("sends override kwargs for video", async () => {
    const api = new MllmApi();
    await api.callWithPromptRaw(
      "http://test:8901",
      "test-model",
      undefined,
      ["/tmp/test.mp4"],
      "describe",
      "video",
      undefined,
      undefined,
      false,
      { fps: 2 },
    );

    expect(lastRequestBody).not.toBeNull();
    const mm = (lastRequestBody as Record<string, unknown>).mm_processor_kwargs;
    expect(mm).toEqual({
      return_audio: false,
      use_audio_in_video: false,
      fps: 2,
    });
  });
});

describe("callWithPromptRaw — seed propagation", () => {
  it("defaults seed to 42 when no hyperparams.seed is provided", async () => {
    const api = new MllmApi();
    await api.callWithPromptRaw(
      "http://test:8901", "test-model", undefined, ["/tmp/x.mp4"],
      "describe", "video",
    );
    expect(lastRequestBody).not.toBeNull();
    expect((lastRequestBody as Record<string, unknown>).seed).toBe(42);
  });

  it("honors a config-driven hyperparams.seed override", async () => {
    const api = new MllmApi();
    await api.callWithPromptRaw(
      "http://test:8901", "test-model", undefined, ["/tmp/x.mp4"],
      "describe", "video",
      { seed: 7 },
    );
    expect((lastRequestBody as Record<string, unknown>).seed).toBe(7);
  });
});
