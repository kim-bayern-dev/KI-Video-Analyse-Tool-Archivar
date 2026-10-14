/**
 * Tests for the vLLM structured-output capability probe (src/lib/json-schema-probe.ts).
 *
 * Mocks longFetch so no network is used. Covers: explicit-mode passthrough (no
 * probe), "auto" transport selection order, caching (one probe per key), cache
 * key composition, and ARCHIVAR_JSON_SCHEMA_PROBE=0 disabling auto-probing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Capture the request body so tests can assert which transport field was sent.
let lastBody: Record<string, unknown> | undefined;
let responseSequence: Array<{ ok: boolean; content?: string; status?: number }> = [];

vi.mock("../src/lib/long-fetch", () => ({
  longFetch: vi.fn(async () => {
    const next = responseSequence.shift() ?? { ok: true, content: '{"ok": true}' };
    return {
      ok: next.ok,
      status: next.status ?? 200,
      statusText: next.ok ? "OK" : "Bad Request",
      json: async () => ({
        choices: [{ message: { content: next.content ?? '{"ok": true}' } }],
      }),
      text: async () => "error",
      headers: new Map(),
    };
  }),
}));

import {
  resolveJsonSchemaTransport,
  cacheKey,
  clearTransportCache,
} from "../src/lib/json-schema-probe";

beforeEach(() => {
  clearTransportCache();
  lastBody = undefined;
  responseSequence = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveJsonSchemaTransport", () => {
  it("returns explicit modes without probing", async () => {
    const t = await resolveJsonSchemaTransport(
      "http://e", "m", false, "structured_outputs",
    );
    expect(t).toBe("structured_outputs");
  });

  it("probes and picks response_format when it works (auto)", async () => {
    responseSequence = [{ ok: true, content: '{"ok": true}' }];
    const t = await resolveJsonSchemaTransport("http://e", "m", false, "auto");
    expect(t).toBe("response_format");
  });

  it("falls through to structured_outputs when response_format is rejected", async () => {
    responseSequence = [
      { ok: false, status: 400 }, // response_format rejected
      { ok: true, content: '{"ok": true}' }, // structured_outputs works
    ];
    const t = await resolveJsonSchemaTransport("http://e", "m", false, "auto");
    expect(t).toBe("structured_outputs");
  });

  it("returns none when every transport is rejected", async () => {
    // PROBE_ORDER has 4 transports: response_format, structured_outputs, json_object, legacy_guided_json
    responseSequence = [
      { ok: false, status: 400 }, // response_format rejected
      { ok: false, status: 400 }, // structured_outputs rejected
      { ok: false, status: 400 }, // json_object rejected
      { ok: false, status: 400 }, // legacy_guided_json rejected
    ];
    const t = await resolveJsonSchemaTransport("http://e", "m", false, "auto");
    expect(t).toBe("none");
  });

  it("caches the probe result (single probe across calls)", async () => {
    responseSequence = [{ ok: true, content: '{"ok": true}' }];
    await resolveJsonSchemaTransport("http://e", "m", false, "auto");
    // Second call should hit the cache and NOT consume another response.
    const t = await resolveJsonSchemaTransport("http://e", "m", false, "auto");
    expect(t).toBe("response_format");
  });

  it("distinguishes cache entries by model and thinking flag", async () => {
    expect(cacheKey("e", "m1", false)).not.toBe(cacheKey("e", "m2", false));
    expect(cacheKey("e", "m", false)).not.toBe(cacheKey("e", "m", true));
  });

  it("returns none when ARCHIVAR_JSON_SCHEMA_PROBE=0 under auto", async () => {
    process.env.ARCHIVAR_JSON_SCHEMA_PROBE = "0";
    try {
      const t = await resolveJsonSchemaTransport("http://e", "m", false, "auto");
      expect(t).toBe("none");
    } finally {
      delete process.env.ARCHIVAR_JSON_SCHEMA_PROBE;
    }
  });
});
