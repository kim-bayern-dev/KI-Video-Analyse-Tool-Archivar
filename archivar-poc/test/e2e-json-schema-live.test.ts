/**
 * END-TO-END test: exercise the native JSON-schema transports against a REAL
 * LLM endpoint, chosen by the tester.
 *
 * WHY: unit tests mock longFetch, so they can't tell whether a *specific*
 * deployed vLLM actually honors `response_format` / `structured_outputs` /
 * `guided_json`. This test hits the live server, reports which transport (if
 * any) produces schema-conformant JSON, and verifies the full `callJson` path
 * (Yup → JSON Schema → constrained decoding → validated result).
 *
 * Choosing the LLM (env vars):
 *   E2E_LLM_MODEL=Qwen3.8-27B-FP8   model name (resolved via getModel by default)
 *   E2E_LLM_ENDPOINT=http://host:port override endpoint (defaults to getModel resolved)
 *   E2E_LLM_API_KEY=...            override apiKey
 *   E2E_LLM_TRANSPORTS=response_format,structured_outputs,guided_json  (default: all three)
 *
 * Gate: skips only when the target model is unhealthy (shared health report)
 * or SKIP_LIVE_TESTS=1.
 *
 * Run example:
 *   E2E_LLM_MODEL=Qwen3.8-27B-FP8 pnpm exec vitest run test/e2e-json-schema-live.test.ts
 */
import { describe, it, expect } from "vitest";
import { MllmApi } from "../src/rpc/mllm-api";
import { buildPluginRpcCompositeApiInstance } from "../src/rpc/post-processing/plugin-api";
import { resolveJsonSchemaTransport } from "../src/lib/json-schema-probe";
import { skipIfModelUnhealthy } from "./utils/live-models.js";
import * as yup from "yup";

const TARGET_MODEL_NAME = process.env.E2E_LLM_MODEL ?? "Qwen3.6-35B-A3B-GPTQ-Int4";

// Resolve the target LLM. getModel() needs the archivar config + env; importing
// archivar.config registers it. Falls back to explicit env overrides.
async function resolveTarget(): Promise<{
  model: string;
  endpoint: string;
  apiKey?: string;
}> {
  const modelName = process.env.E2E_LLM_MODEL ?? "Qwen3.6-35B-A3B-GPTQ-Int4";
  const { getModel } = await import("../src/lib/archivar-config");
  // archivar.config import triggers env load via defuss-env if present.
  await import("../archivar.config.js");
  const cfg = getModel(modelName);
  return {
    model: process.env.E2E_LLM_MODEL_OVERRIDE ?? cfg.resolvedModel,
    endpoint: process.env.E2E_LLM_ENDPOINT ?? cfg.resolvedEndpoint,
    apiKey: process.env.E2E_LLM_API_KEY ?? cfg.resolvedApiKey,
  };
}

const SCHEMA = {
  type: "object",
  properties: { ok: { type: "boolean" }, msg: { type: "string" } },
  required: ["ok", "msg"],
  additionalProperties: false,
} as const;

/** Directly POST one transport to the endpoint and return whether it constrained output. */
async function probeTransport(
  endpoint: string,
  model: string,
  apiKey: string | undefined,
  transport: "response_format" | "structured_outputs" | "legacy_guided_json",
): Promise<{ ok: boolean; status: number; body: string; content: string }> {
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: 'Reply only with {"ok": true, "msg": "hello"}.' }],
    max_tokens: 64,
    temperature: 0,
    // Mirror the real call: reasoning models emit empty `content` (output goes
    // to `reasoning`) unless thinking is explicitly disabled.
    chat_template_kwargs: { add_generation_prompt: true, enable_thinking: false },
  };
  if (transport === "response_format") {
    body.response_format = { type: "json_schema", json_schema: { name: "probe", strict: true, schema: SCHEMA } };
  } else if (transport === "structured_outputs") {
    body.structured_outputs = { json: SCHEMA };
  } else {
    body.guided_json = SCHEMA;
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  const res = await fetch(`${endpoint}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let content = "";
  try {
    const data = JSON.parse(text);
    content = data.choices?.[0]?.message?.content ?? "";
  } catch {
    content = "";
  }
  return { ok: res.ok, status: res.status, body: text.slice(0, 300), content };
}

describe("e2e: native JSON-schema transports against a real LLM", () => {
  const transports = (process.env.E2E_LLM_TRANSPORTS ?? "response_format,structured_outputs,legacy_guided_json").split(",");

  for (const t of transports) {
    const transport = t.trim() as "response_format" | "structured_outputs" | "legacy_guided_json";
    it(`transport "${transport}" — reports server support and constrained output`, async ({ skip }) => {
      const gateReason = await skipIfModelUnhealthy(TARGET_MODEL_NAME);
      if (gateReason) return skip(gateReason);
      const target = await resolveTarget();
      // eslint-disable-next-line no-console
      console.log(`[e2e] probing ${transport} → ${target.endpoint} model=${target.model}`);
      const result = await probeTransport(target.endpoint, target.model, target.apiKey, transport);
      // eslint-disable-next-line no-console
      console.log(`[e2e] "${transport}" status=${result.status} content=${result.content.slice(0, 120)}`);
      // Assert the request itself completed (status reported either way); we log the body for diagnosis.
      expect(typeof result.status).toBe("number");
      // If accepted, the content must be valid JSON matching the schema.
      if (result.ok && result.content) {
        const parsed = JSON.parse(result.content);
        expect(parsed).toMatchObject({ ok: expect.any(Boolean), msg: expect.any(String) });
      }
    });
  }

  it("resolveJsonSchemaTransport — auto-probes the live endpoint and reports a transport", async ({ skip }) => {
    const gateReason = await skipIfModelUnhealthy(TARGET_MODEL_NAME);
    if (gateReason) return skip(gateReason);
    const target = await resolveTarget();
    const transport = await resolveJsonSchemaTransport(target.endpoint, target.model, false, "auto", target.apiKey);
    // eslint-disable-next-line no-console
    console.log(`[e2e] resolveJsonSchemaTransport(auto) → ${transport}`);
    expect(["response_format", "structured_outputs", "legacy_guided_json", "none"]).toContain(transport);
  });

  it("callJson end-to-end — Yup schema → native/degraded → validated result", async ({ skip }) => {
    const gateReason = await skipIfModelUnhealthy(TARGET_MODEL_NAME);
    if (gateReason) return skip(gateReason);
    const target = await resolveTarget();
    const api = buildPluginRpcCompositeApiInstance(new MllmApi(), {} as never, {} as never, {} as never);
    const schema = yup.object({
      summary: yup.string().required(),
      ok: yup.boolean().required(),
    }).stripUnknown();

    const res = await api.mllm.callJson<{
      summary: string;
      ok: boolean;
    }>({
      endpoint: target.endpoint,
      model: target.model,
      apiKey: target.apiKey,
      filePaths: [],
      mediaCategory: "audio",
      prompt: 'Reply only with valid JSON: {"summary":"short","ok":true}',
      schema,
      jsonSchemaMode: "auto",
      maxRetries: 2,
    });
    // eslint-disable-next-line no-console
    console.log(`[e2e] callJson result=${JSON.stringify(res)}`);
    expect(typeof res.summary).toBe("string");
    expect(typeof res.ok).toBe("boolean");
  });
});
