/**
 * Tests for native JSON-schema transport attachment in MllmApi.callWithPromptRaw.
 *
 * Mocks longFetch so no network is used and asserts:
 *  - response_format / structured_outputs / guided_json are attached as
 *    TOP-LEVEL body keys (never nested under extra_body) for each transport
 *  - explicit mode with backend 400-rejection throws JsonSchemaUnsupportedError
 *  - finish_reason "length" throws TruncatedStructuredOutputError
 *  - nothing is attached when jsonSchemaMode is off
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Capture every request body across calls (lastBody kept for existing tests).
let lastBody: Record<string, unknown> | undefined;
let bodies: Record<string, unknown>[] = [];
let nextResponse: {
  ok: boolean;
  status?: number;
  content?: string;
  finishReason?: string;
  errorBody?: string;
} = { ok: true, content: '{"ok": true}' };
// Optional per-call response sequence (falls back to nextResponse when drained).
let responseQueue: Array<typeof nextResponse> = [];

vi.mock("../src/lib/long-fetch", () => ({
  longFetch: vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    lastBody = body;
    bodies.push(body);
    const r = responseQueue.length > 0 ? responseQueue.shift()! : nextResponse;
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 400),
      statusText: r.ok ? "OK" : "Bad Request",
      json: async () => ({
        choices: [
          {
            message: { content: r.content ?? '{"ok": true}' },
            finish_reason: r.finishReason ?? "stop",
          },
        ],
      }),
      text: async () => r.errorBody ?? '{"detail":"response_format not supported"}',
      headers: new Map(),
    };
  }),
}));

import { MllmApi } from "../src/rpc/mllm-api";
import {
  JsonSchemaUnsupportedError,
  TruncatedStructuredOutputError,
} from "../src/lib/errors";
import { setArchivarConfig } from "../src/lib/archivar-config";

beforeEach(() => {
  lastBody = undefined;
  bodies = [];
  responseQueue = [];
  nextResponse = { ok: true, content: '{"ok": true}' };
});

afterEach(() => {
  vi.restoreAllMocks();
});

const SCHEMA = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };

function call(api: MllmApi, mode: Parameters<MllmApi["callWithPromptRaw"]>[11]) {
  return api.callWithPromptRaw(
    "http://e", "m", undefined, [], "prompt", "audio",
    undefined, undefined, false, undefined, SCHEMA, mode,
  );
}

describe("MllmApi.callWithPromptRaw — native JSON-schema transport", () => {
  it("attaches response_format as a top-level body field", async () => {
    const api = new MllmApi();
    await call(api, "response_format");
    expect(lastBody!.response_format).toBeDefined();
    expect((lastBody!.response_format as { type: string }).type).toBe("json_schema");
    // Critical: NOT nested under extra_body.
    expect((lastBody as Record<string, unknown>).extra_body).toBeUndefined();
  });

  it("attaches structured_outputs as a top-level body field", async () => {
    const api = new MllmApi();
    await call(api, "structured_outputs");
    expect(lastBody!.structured_outputs).toEqual({ json: SCHEMA, whitespace_pattern: "[ \t\r\n]?" });
  });

  it("attaches guided_json as a top-level body field (legacy)", async () => {
    const api = new MllmApi();
    await call(api, "legacy_guided_json");
    expect(lastBody!.guided_json).toEqual(SCHEMA);
  });

  it("attaches nothing when jsonSchemaMode is off", async () => {
    const api = new MllmApi();
    await call(api, false);
    expect(lastBody!.response_format).toBeUndefined();
    expect(lastBody!.structured_outputs).toBeUndefined();
    expect(lastBody!.guided_json).toBeUndefined();
  });

  it("throws JsonSchemaUnsupportedError when the backend 400-rejects the transport", async () => {
    nextResponse = { ok: false, status: 400 };
    const api = new MllmApi();
    await expect(call(api, "response_format")).rejects.toBeInstanceOf(
      JsonSchemaUnsupportedError,
    );
  });

  it("throws TruncatedStructuredOutputError on finish_reason 'length'", async () => {
    nextResponse = { ok: true, finishReason: "length", content: '{"ok":' };
    const api = new MllmApi();
    await expect(call(api, "response_format")).rejects.toBeInstanceOf(
      TruncatedStructuredOutputError,
    );
  });

  it("does not throw truncation when structured output is off", async () => {
    // finish_reason length without a transport attached should just return content.
    nextResponse = { ok: true, finishReason: "length", content: '{"ok": true}' };
    const api = new MllmApi();
    const out = await call(api, false);
    expect(out.content).toBe('{"ok": true}');
  });
});


describe("MllmApi.callWithPromptRaw — structured sampling overrides", () => {
  it("applies per-model structured penalties and zeroes presence_penalty", async () => {
    const api = new MllmApi();
    await api.callWithPromptRaw(
      "http://e", "m", undefined, [], "prompt", "audio",
      // hyperparams carry values that structured sampling must OVERRIDE
      { temperature: 1.3, presence_penalty: 1.5, frequency_penalty: 0.9, repetition_penalty: 1.0 },
      undefined, false, undefined,
      { type: "object", properties: { ok: { type: "boolean" } } }, "response_format",
      // structuredMaxTokens, structuredTemperature, structuredFrequencyPenalty, structuredRepetitionPenalty
      4096, 0.75, 0.2, 1.1,
    );
    expect(lastBody!.response_format).toBeDefined();
    expect(lastBody!.temperature).toBe(0.75);
    expect(lastBody!.max_tokens).toBe(4096);
    expect(lastBody!.presence_penalty).toBe(0);
    expect(lastBody!.frequency_penalty).toBe(0.2);
    expect(lastBody!.repetition_penalty).toBe(1.1);
  });

  it("falls back to the centralized structured defaults when unset", async () => {
    const api = new MllmApi();
    await call(api, "response_format");
    expect(lastBody!.presence_penalty).toBe(0);
    expect(lastBody!.frequency_penalty).toBe(0.1);
    expect(lastBody!.repetition_penalty).toBe(1.05);
  });
});

describe("MllmApi.callWithPrompt — caption truncation bump (free-form)", () => {
  const captionArgs = (maxTokens: number): Parameters<MllmApi["callWithPrompt"]> => [
    "http://e", "m", undefined, [], "prompt", "video",
    { max_tokens: maxTokens },
  ];

  it("doubles max_tokens on finish_reason length and retries (100 → 200)", async () => {
    setArchivarConfig({ auth: { users: [] }, contextWindows: { maxInferenceContext: 256 } });
    responseQueue = [
      { ok: true, content: "Teilkap", finishReason: "length" },
      { ok: true, content: "Eine vollständige Caption.", finishReason: "stop" },
    ];

    const out = await new MllmApi().callWithPrompt(...captionArgs(100));

    expect(out.content).toBe("Eine vollständige Caption.");
    expect(bodies).toHaveLength(2);
    expect(bodies[0].max_tokens).toBe(100);
    expect(bodies[1].max_tokens).toBe(200);
  });

  it("caps the bump at the resolved maxInferenceContext (128 → 256, then partial content)", async () => {
    setArchivarConfig({ auth: { users: [] }, contextWindows: { maxInferenceContext: 256 } });
    responseQueue = [
      { ok: true, content: "Teil 1", finishReason: "length" },
      { ok: true, content: "Teil 2 (an der Decke)", finishReason: "length" },
    ];

    const out = await new MllmApi().callWithPrompt(...captionArgs(128));

    expect(bodies).toHaveLength(2);
    expect(bodies[0].max_tokens).toBe(128);
    expect(bodies[1].max_tokens).toBe(256);
    // At the ceiling the partial caption is returned — no third attempt.
    expect(out.content).toBe("Teil 2 (an der Decke)");
  });

  it("does not retry when already at the ceiling on attempt 0", async () => {
    setArchivarConfig({ auth: { users: [] }, contextWindows: { maxInferenceContext: 256 } });
    responseQueue = [{ ok: true, content: "Teilkap", finishReason: "length" }];

    const out = await new MllmApi().callWithPrompt(...captionArgs(256));

    expect(bodies).toHaveLength(1);
    expect(out.content).toBe("Teilkap");
  });
});

describe("MllmApi.callWithPrompt — reactive context-overflow halving (400 fallback)", () => {
  const OVERFLOW_BODY = '{"error":{"message":"This model\'s maximum context length is 65536 tokens. However, you requested 65536 output tokens and your prompt contains 101 characters.","type":"BadRequestError","code":400}}';

  const captionArgs = (maxTokens: number, media: "audio" | "video" = "audio"): Parameters<MllmApi["callWithPrompt"]> => [
    "http://e", "m", undefined, [], "prompt", media,
    { max_tokens: maxTokens },
  ];

  it("text call: halves max_tokens on overflow and retries (4096 → 2048 → 1024)", async () => {
    setArchivarConfig({ auth: { users: [] }, contextWindows: { maxInferenceContext: 65535 } });
    responseQueue = [
      { ok: false, errorBody: OVERFLOW_BODY },
      { ok: false, errorBody: OVERFLOW_BODY },
      { ok: true, content: "passt jetzt", finishReason: "stop" },
    ];

    const out = await new MllmApi().callWithPrompt(...captionArgs(4096));

    expect(out.content).toBe("passt jetzt");
    expect(bodies.map((b) => b.max_tokens)).toEqual([4096, 2048, 1024]);
  });

  it("video call: halves input frames first (fps 1 → 0.5 → 0.25), output budget kept", async () => {
    setArchivarConfig({ auth: { users: [] }, contextWindows: { maxInferenceContext: 65535 } });
    responseQueue = [
      { ok: false, errorBody: OVERFLOW_BODY },
      { ok: false, errorBody: OVERFLOW_BODY },
      { ok: true, content: "ok", finishReason: "stop" },
    ];

    const out = await new MllmApi().callWithPrompt(
      "http://e", "m", undefined, ["file:///v.mp4"], "prompt", "video",
      { max_tokens: 100 }, undefined, false, { fps: 1 },
    );

    expect(out.content).toBe("ok");
    const fpsValues = bodies.map((b) => (b.mm_processor_kwargs as Record<string, unknown>).fps);
    expect(fpsValues).toEqual([1, 0.5, 0.25]);
    expect(bodies.map((b) => b.max_tokens)).toEqual([100, 100, 100]);
  });

  it("gives up after the bounded halving ladder (4 attempts) and throws", async () => {
    setArchivarConfig({ auth: { users: [] }, contextWindows: { maxInferenceContext: 65535 } });
    responseQueue = Array.from({ length: 6 }, () => ({ ok: false as const, errorBody: OVERFLOW_BODY }));

    await expect(new MllmApi().callWithPrompt(...captionArgs(100))).rejects.toThrow(/API request failed/);
    expect(bodies).toHaveLength(5); // initial + 4 halvings, then fail
  });
});

describe("applyStructuredSampling — per-model extras (Qwen non-thinking profile)", () => {
  it("passes presencePenalty/topP/topK through when the model pins them", async () => {
    setArchivarConfig({
      auth: { users: [] },
      models: [{
        name: "m", type: "api", model: "m",
        structuredOutput: { temperature: 0.7, presencePenalty: 1.5, topP: 0.8, topK: 20, frequencyPenalty: 0.0, repetitionPenalty: 1.0 },
      }],
    });
    nextResponse = { ok: true, content: '{"ok": true}' };
    await new MllmApi().callWithPromptRaw(
      "http://e", "m", undefined, [], "prompt", "audio",
      undefined, undefined, false, undefined,
      { type: "object", properties: { ok: { type: "boolean" } } }, "response_format",
      // wie Plugins: structuredOutput-Werte des Modells durchgereicht
      16384, 0.7, 0.0, 1.0,
    );
    expect(lastBody!.temperature).toBe(0.7);
    expect(lastBody!.presence_penalty).toBe(1.5);
    expect(lastBody!.top_p).toBe(0.8);
    expect(lastBody!.top_k).toBe(20);
    expect(lastBody!.frequency_penalty).toBe(0.0);
    expect(lastBody!.repetition_penalty).toBe(1.0);
  });

  it("keeps established defaults when the model pins nothing", async () => {
    setArchivarConfig({ auth: { users: [] }, models: [{ name: "m", type: "api", model: "m" }] });
    nextResponse = { ok: true, content: '{"ok": true}' };
    await new MllmApi().callWithPromptRaw(
      "http://e", "m", undefined, [], "prompt", "audio",
      { temperature: 0.9, top_p: 0.5, top_k: 7, presence_penalty: 0.3, max_tokens: 4096 }, undefined, false, undefined,
      { type: "object", properties: { ok: { type: "boolean" } } }, "response_format",
    );
    // temperature forced to structured default, presence zeroed, top_p/top_k from hyperparams
    expect(lastBody!.temperature).toBe(0.2);
    expect(lastBody!.presence_penalty).toBe(0);
    expect(lastBody!.top_p).toBe(0.5);
    expect(lastBody!.top_k).toBe(7);
  });
});

describe("attachStructuredOutput — whitespace_pattern (compact JSON)", () => {
  it("attaches bounded whitespace_pattern to the structured_outputs transport", async () => {
    setArchivarConfig({ auth: { users: [] }, models: [{ name: "m", type: "api", model: "m" }] });
    nextResponse = { ok: true, content: '{"ok": true}' };
    await new MllmApi().callWithPromptRaw(
      "http://e", "m", undefined, [], "prompt", "audio",
      undefined, undefined, false, undefined,
      { type: "object", properties: { ok: { type: "boolean" } } }, "structured_outputs",
    );
    const so = lastBody!.structured_outputs as Record<string, unknown>;
    expect(so.whitespace_pattern).toBe("[ \t\r\n]?");
    // never unbounded — a * or + pattern would re-open the whitespace-run path
    expect(so.whitespace_pattern).not.toContain("*");
    expect(so.whitespace_pattern).not.toContain("+");
  });
});

describe("pre-flight budget cap — media estimate only when media is attached", () => {
  it("text-only call (urls=[]) with mediaCategory video gets NO media tokens added", async () => {
    setArchivarConfig({ auth: { users: [] }, contextWindows: { maxInferenceContext: 65535 } });
    nextResponse = { ok: true, content: "ok" };
    const bigPrompt = "wort ".repeat(25000); // 25k Wörter × 2.0 = 50000 Text-Tokens
    await new MllmApi().callWithPrompt(
      "http://e", "m", undefined, [], bigPrompt, "video",
      { max_tokens: 16384 },
    );
    // cap = 65535 − 50000 − 1024 = 14511 (KEIN Floor 1024 und KEINE +20400 Media-Schätzung)
    expect(lastBody!.max_tokens).toBe(14511);
  });

  it("video call with attached media gets the frame estimate applied", async () => {
    setArchivarConfig({ auth: { users: [] }, contextWindows: { maxInferenceContext: 65535 } });
    nextResponse = { ok: true, content: "ok" };
    await new MllmApi().callWithPrompt(
      "http://e", "m", undefined, ["file:///v.mp4"], "prompt", "video",
      { max_tokens: 60000 },
    );
    // cap = 65535 − 2 − 20400 − 1024 = 44109
    expect(lastBody!.max_tokens).toBe(44109);
  });
});

describe("post-hoc whitespace-run detector (structured calls)", () => {
  it("throws TruncatedStructuredOutputError on a 200+ char whitespace run", async () => {
    setArchivarConfig({ auth: { users: [] }, models: [{ name: "m", type: "api", model: "m" }] });
    nextResponse = { ok: true, content: '{"a": 1, "perception_matrix": {' + "\t".repeat(500), finishReason: "stop" };
    await expect(
      new MllmApi().callWithPromptRaw(
        "http://e", "m", undefined, [], "prompt", "audio",
        undefined, undefined, false, undefined,
        { type: "object", properties: { ok: { type: "boolean" } } }, "structured_outputs",
      ),
    ).rejects.toBeInstanceOf(TruncatedStructuredOutputError);
  });

  it("does NOT fire on legitimate markdown tables and normal JSON", async () => {
    setArchivarConfig({ auth: { users: [] }, models: [{ name: "m", type: "api", model: "m" }] });
    nextResponse = {
      ok: true,
      content: '{"summary": "| Artefakt | Beschreibung | Conf |\n| --- | --- | --- |\n| Logo | weiß oben rechts | 1.0 |", "ok": true}',
      finishReason: "stop",
    };
    const out = await new MllmApi().callWithPromptRaw(
      "http://e", "m", undefined, [], "prompt", "audio",
      undefined, undefined, false, undefined,
      { type: "object", properties: { ok: { type: "boolean" } } }, "structured_outputs",
    );
    expect(out.content).toContain("Artefakt");
  });
});
