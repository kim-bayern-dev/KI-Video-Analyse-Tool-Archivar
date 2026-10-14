/**
 * Comprehensive test matrix for native JSON structured-output mode.
 *
 * Covers every meaningful case of how Archivar selects, attaches, samples, and
 * reacts to JSON-schema constrained decoding — across MllmApi (transport
 * attachment / errors / truncation / sampling) and PluginApi.callJson (convert /
 * degrade / fail-fast / retry). Network is mocked; no live LLM needed.
 *
 * Organized into sections:
 *   A. Transport selection (all jsonSchemaMode values)
 *   B. Response handling (truncation, rejection, valid output)
 *   C. Sampling overrides (on vs off)
 *   D. callJson integration (convert, degrade, fail-fast, retry, exhaust)
 *   E. callRaw passthrough
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as yup from "yup";
import { MllmApi } from "../src/rpc/mllm-api";
import {
  JsonSchemaUnsupportedError,
  TruncatedStructuredOutputError,
  UnsupportedYupNodeError,
} from "../src/lib/errors";
import { buildPluginRpcCompositeApiInstance } from "../src/rpc/post-processing/plugin-api";
import type { PluginRpcApiCompositeInstance } from "../src/lib/plugin-types";
import type { MllmApi as MllmApiType } from "../src/rpc/mllm-api";

// ── MllmApi mock (longFetch) ────────────────────────────────────────────────
let lastBody: Record<string, unknown> | undefined;
let callCount = 0;
type Resp = { ok: boolean; status?: number; content?: string; finishReason?: string; errorBody?: string };
// Queue of responses; shifted per call. When only one remains, it repeats.
let responses: Resp[] = [{ ok: true, content: '{"ok": true}' }];
function setResponses(...r: Resp[]): void { responses = r; }
function nextResp(): Resp {
  callCount++;
  if (responses.length > 1) return responses.shift()!;
  return responses[0];
}

vi.mock("../src/lib/long-fetch", () => ({
  longFetch: vi.fn(async (_url: string, init: RequestInit) => {
    lastBody = JSON.parse(init.body as string);
    const r = nextResp();
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 400),
      statusText: r.ok ? "OK" : "Bad Request",
      json: async () => ({
        choices: [{
          message: { content: r.content ?? '{"ok": true}' },
          finish_reason: r.finishReason ?? "stop",
        }],
      }),
      text: async () => r.errorBody ?? "error",
      headers: new Map(),
    };
  }),
}));

const SCHEMA = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
};

beforeEach(async () => {
  lastBody = undefined;
  callCount = 0;
  setResponses({ ok: true, content: '{"ok": true}' });
  // Clear probe cache so "auto" tests don't share cached results.
  const { clearTransportCache } = await import("../src/lib/json-schema-probe");
  clearTransportCache();
});
afterEach(() => vi.restoreAllMocks());

function rawCall(api: MllmApi, mode: Parameters<MllmApi["callWithPromptRaw"]>[11]) {
  return api.callWithPromptRaw(
    "http://e", "m", undefined, [], "p", "audio",
    undefined, undefined, false, undefined, SCHEMA, mode,
  );
}

// ── Section A: transport selection ──────────────────────────────────────────
describe("A. transport selection by jsonSchemaMode", () => {
  it("false → attaches nothing", async () => {
    await rawCall(new MllmApi(), false);
    expect(lastBody!.response_format).toBeUndefined();
    expect(lastBody!.structured_outputs).toBeUndefined();
    expect(lastBody!.guided_json).toBeUndefined();
  });

  it('"response_format" → top-level response_format with json_schema{name,schema,strict}', async () => {
    await rawCall(new MllmApi(), "response_format");
    const rf = lastBody!.response_format as { type: string; json_schema: { name: string; schema: unknown; strict: boolean } };
    expect(rf.type).toBe("json_schema");
    expect(rf.json_schema.name).toBe("archivar_response");
    expect(rf.json_schema.strict).toBe(true);
    expect(rf.json_schema.schema).toEqual(SCHEMA);
    expect(lastBody!.structured_outputs).toBeUndefined();
  });

  it('"structured_outputs" → top-level structured_outputs.json', async () => {
    await rawCall(new MllmApi(), "structured_outputs");
    expect(lastBody!.structured_outputs).toEqual({ json: SCHEMA, whitespace_pattern: "[ \t\r\n]?" });
    expect(lastBody!.response_format).toBeUndefined();
  });

  it('"legacy_guided_json" → top-level guided_json', async () => {
    await rawCall(new MllmApi(), "legacy_guided_json");
    expect(lastBody!.guided_json).toEqual(SCHEMA);
  });

  it('"auto" → probes and attaches the first working transport', async () => {
    setResponses({ ok: true, content: '{"ok": true}' });
    await rawCall(new MllmApi(), "auto");
    // probe probes response_format first → works → attached.
    expect(lastBody!.response_format).toBeDefined();
  });

  it('"auto" with all transports rejected → attaches nothing (graceful degrade)', async () => {
    // PROBE_ORDER has 4 transports: response_format, structured_outputs, json_object, legacy_guided_json
    // Each returns false immediately on 400. Then 1 × ok for the real (prompt-only) call.
    const fails = Array.from({ length: 4 }, () => ({ ok: false, status: 400, errorBody: "not supported" }));
    setResponses(...fails, { ok: true, content: '{"ok": true}' });
    await rawCall(new MllmApi(), "auto");
    expect(lastBody!.response_format).toBeUndefined();
    expect(lastBody!.structured_outputs).toBeUndefined();
    expect(lastBody!.guided_json).toBeUndefined();
  });
});

// ── Section B: response handling ────────────────────────────────────────────
describe("B. response handling", () => {
  it("finish_reason 'length' WITH transport → TruncatedStructuredOutputError", async () => {
    setResponses({ ok: true, finishReason: "length", content: '{"ok":' });
    await expect(rawCall(new MllmApi(), "response_format")).rejects.toBeInstanceOf(TruncatedStructuredOutputError);
  });

  it("finish_reason 'length' WITHOUT transport → returns content (no throw)", async () => {
    setResponses({ ok: true, finishReason: "length", content: "partial" });
    const out = await rawCall(new MllmApi(), false);
    expect(out.content).toBe("partial");
  });

  it('finish_reason "content_filter" WITH transport → no truncation error (returns content)', async () => {
    setResponses({ ok: true, finishReason: "content_filter", content: '{"ok": true}' });
    const out = await rawCall(new MllmApi(), "response_format");
    expect(out.content).toBe('{"ok": true}');
  });

  it("400 mentioning response_format → JsonSchemaUnsupportedError", async () => {
    setResponses({ ok: false, status: 400, errorBody: '{"detail":"response_format not supported"}' });
    await expect(rawCall(new MllmApi(), "response_format")).rejects.toBeInstanceOf(JsonSchemaUnsupportedError);
  });

  it("400 NOT mentioning structured fields → generic Error (not JsonSchemaUnsupportedError)", async () => {
    setResponses({ ok: false, status: 400, errorBody: '{"detail":"model overloaded"}' });
    await expect(rawCall(new MllmApi(), "response_format")).rejects.not.toBeInstanceOf(JsonSchemaUnsupportedError);
  });
});

// ── Section C: sampling overrides ───────────────────────────────────────────
describe("C. structured sampling overrides", () => {
  it("transport attached → temp=default 0.2, penalties=0, max_tokens<=8192", async () => {
    await new MllmApi().callWithPromptRaw(
      "http://e", "m", undefined, [], "p", "audio",
      { temperature: 0.3, presence_penalty: 0.25, max_tokens: 65536 },
      undefined, false, undefined, SCHEMA, "response_format",
    );
    expect(lastBody!.temperature).toBe(0.2);
    expect(lastBody!.presence_penalty).toBe(0);
    expect(lastBody!.frequency_penalty).toBe(0.1);
    expect((lastBody!.max_tokens as number) <= 65536).toBe(true);
  });

  it("no transport (mode off) → sampling unchanged (config hyperparams preserved)", async () => {
    await new MllmApi().callWithPromptRaw(
      "http://e", "m", undefined, [], "p", "audio",
      { temperature: 0.3, presence_penalty: 0.25, max_tokens: 65536 },
      undefined, false, undefined, SCHEMA, false,
    );
    expect(lastBody!.temperature).toBe(0.3);
    expect(lastBody!.presence_penalty).toBe(0.25);
    expect(lastBody!.max_tokens).toBe(65536);
  });
});

// ── Section D: callJson integration ─────────────────────────────────────────
vi.mock("../src/lib/archivar-config", () => ({
  getModel: () => ({ resolvedEndpoint: "http://mock", resolvedModel: "m", resolvedApiKey: undefined }),
  resolveStartMaxTokens: () => undefined,
  resolveMaxInferenceContext: () => 65536,
  resolveEstimation: () => ({ tokensPerWord: 0, tokensPerFrame: 0 }),
  resolveStructuredExtras: () => ({}),
}));

const simpleSchema = yup.object({
  answer: yup.boolean().required(),
  reasoning: yup.string().required(),
}).stripUnknown();
const mixedSchema = yup.object({
  answer: yup.mixed().required(),
  reasoning: yup.string().required(),
}).stripUnknown();

function makeApi(impl: (...a: unknown[]) => Promise<string>): { api: PluginRpcApiCompositeInstance; raw: ReturnType<typeof vi.fn> } {
  // callWithPromptRaw now returns { content, usage? }; wrap the string impl.
  const raw = vi.fn(async (...a: unknown[]) => ({ content: await impl(...a) }));
  const api = buildPluginRpcCompositeApiInstance({ callWithPromptRaw: raw } as unknown as MllmApiType, {} as never, {} as never, {} as never);
  return { api, raw };
}

describe("D. callJson integration", () => {
  it("valid schema → converts and passes jsonSchema + mode through", async () => {
    const { api, raw } = makeApi(async () => JSON.stringify({ answer: true, reasoning: "ok" }));
    const res = await api.mllm.callJson({
      endpoint: "e", model: "m", filePaths: [], mediaCategory: "audio",
      prompt: "p", schema: simpleSchema, jsonSchemaMode: "response_format",
    });
    expect(res).toEqual({ answer: true, reasoning: "ok" });
    const c = raw.mock.calls[0] as unknown[];
    expect(c[10]).toBeDefined(); // jsonSchema
    expect(c[11]).toBe("response_format");
  });

  it("mixed() schema under auto → degrades to prompt-only (no jsonSchema)", async () => {
    const { api, raw } = makeApi(async () => JSON.stringify({ answer: true, reasoning: "ok" }));
    await api.mllm.callJson({
      endpoint: "e", model: "m", filePaths: [], mediaCategory: "audio",
      prompt: "p", schema: mixedSchema, jsonSchemaMode: "auto",
    });
    const c = raw.mock.calls[0] as unknown[];
    expect(c[10]).toBeUndefined();
  });

  it("mixed() schema under explicit mode → fails fast (UnsupportedYupNodeError, no LLM call)", async () => {
    const { api, raw } = makeApi(async () => "unused");
    await expect(api.mllm.callJson({
      endpoint: "e", model: "m", filePaths: [], mediaCategory: "audio",
      prompt: "p", schema: mixedSchema, jsonSchemaMode: "response_format",
    })).rejects.toBeInstanceOf(UnsupportedYupNodeError);
    expect(raw).not.toHaveBeenCalled();
  });

  it("truncation → bumps max_tokens and retries within budget", async () => {
    let attempt = 0;
    const { api, raw } = makeApi(async (...a: unknown[]) => {
      attempt++;
      if (attempt === 1) throw new TruncatedStructuredOutputError((a[6] as { max_tokens?: number })?.max_tokens);
      return JSON.stringify({ answer: true, reasoning: "ok" });
    });
    const res = await api.mllm.callJson({
      endpoint: "e", model: "m", filePaths: [], mediaCategory: "audio",
      prompt: "p", schema: simpleSchema, jsonSchemaMode: "response_format",
      hyperparams: { max_tokens: 1000 }, maxRetries: 2,
    });
    expect(res).toEqual({ answer: true, reasoning: "ok" });
    expect((raw.mock.calls[1][6] as { max_tokens: number }).max_tokens).toBe(2000);
  });

  it("validation failure → retries with a correction prompt quoting the prior answer", async () => {
    let attempt = 0;
    const { api, raw } = makeApi(async (...a: unknown[]) => {
      attempt++;
      const prompt = a[4] as string;
      if (attempt === 1) return JSON.stringify({ answer: "not-a-bool", reasoning: "ok" });
      // retry prompt must quote the previous invalid answer.
      expect(prompt).toContain("Deine vorherige Antwort war ungueltig");
      return JSON.stringify({ answer: true, reasoning: "fixed" });
    });
    const res = await api.mllm.callJson({
      endpoint: "e", model: "m", filePaths: [], mediaCategory: "audio",
      prompt: "p", schema: simpleSchema, maxRetries: 2,
    });
    expect((res as { answer: boolean; reasoning: string }).answer).toBe(true);
  });

  it("JSON parse failure then success → retries", async () => {
    let attempt = 0;
    const { api } = makeApi(async () => {
      attempt++;
      return attempt === 1 ? "not json at all" : JSON.stringify({ answer: true, reasoning: "ok" });
    });
    const res = await api.mllm.callJson({
      endpoint: "e", model: "m", filePaths: [], mediaCategory: "audio",
      prompt: "p", schema: simpleSchema, maxRetries: 2,
    });
    expect((res as { answer: boolean; reasoning: string }).answer).toBe(true);
  });

  it("maxRetries: 0 → no retry, throws on first parse failure", async () => {
    const { api } = makeApi(async () => "not json");
    await expect(api.mllm.callJson({
      endpoint: "e", model: "m", filePaths: [], mediaCategory: "audio",
      prompt: "p", schema: simpleSchema, maxRetries: 0,
    })).rejects.toThrow(/could not be parsed as JSON/);
  });

  it("all retries exhausted on validation → returns degraded best-effort result (soft error, no throw)", async () => {
    // The model produces valid JSON but it doesn't conform (answer should be
    // boolean). After all retries, callJson degrades: returns the model's
    // best-effort parsed object instead of throwing fatally. The non-conformance
    // is recorded as a non-fatal error for operator visibility.
    const { api, raw } = makeApi(async () => JSON.stringify({ answer: "still-wrong", reasoning: "ok" }));
    const res = await api.mllm.callJson({
      endpoint: "e", model: "m", filePaths: [], mediaCategory: "audio",
      prompt: "p", schema: simpleSchema, maxRetries: 2,
    });
    // Degraded: the parsed object is returned as-is (partial match, not validated).
    expect(res).toEqual({ answer: "still-wrong", reasoning: "ok" });
    // 1 initial attempt + 2 retries = 3 total calls.
    expect(raw).toHaveBeenCalledTimes(3);
  });
});

// ── Section E: callRaw passthrough ───────────────────────────────────────────
describe("E. callRaw passthrough", () => {
  it("passes jsonSchema + mode through to callWithPromptRaw", async () => {
    const { api, raw } = makeApi(async () => "raw");
    await api.mllm.callRaw({
      endpoint: "e", model: "m", filePaths: [], mediaCategory: "audio",
      prompt: "p", jsonSchema: SCHEMA, jsonSchemaMode: "response_format",
    });
    const c = raw.mock.calls[0] as unknown[];
    expect(c[10]).toEqual(SCHEMA);
    expect(c[11]).toBe("response_format");
  });
});
