/**
 * END-TO-END live test: native JSON-schema mode against a REAL LLM endpoint,
 * using the EXACT prompts + Yup schemas shipped in the plugins.
 *
 * WHY: this is the 1:1 migration reference. Every case uses the real plugin
 * prompt (with the same {{...}} placeholder substitution the plugin performs)
 * and the real plugin Yup schema, driven through PluginApi.mllm.callJson()
 * with jsonSchemaMode="auto". When the model returns schema-valid JSON for
 * every case, the plugin code can be lifted onto schema mode verbatim.
 *
 * Coverage (mirrors test/default-schema-mode.test.ts + question-answer):
 *   default.ts : DEFAULT_SLICE_ANALYSIS_PROMPT, DECISION_PROMPT,
 *                DECISION_PROMPT_WITH_TRANSCRIPTS, AGGREGATION_ANALYSIS_PROMPT,
 *                AGGREGATION_ANALYSIS_VIDEO_PROMPT,
 *                AGGREGATION_ANALYSIS_WITH_TRANSCRIPTS_PROMPT, WHOLE_SUMMARY_PROMPT
 *   question-answer.ts: generatePrompt()+createSchema() for boolean/oneOf/
 *                manyOf/singleClaim/categorization
 *
 * Env (all optional — LIVE BY DEFAULT):
 *   E2E_LLM_RUN=0                       opt-OUT gate (live unless set to 0/false)
 *   E2E_LLM_MODEL=<name>                model name (resolved via getModel);
 *                                       default: scene model of the configured
 *                                       default workflow
 *   E2E_LLM_ENDPOINT / E2E_LLM_API_KEY  overrides
 *
 * Run example:
 *   E2E_LLM_RUN=1 E2E_LLM_MODEL=Qwen3.8-27B-FP8 \
 *     pnpm exec vitest run test/e2e-plugin-schema-mode-live.test.ts
 */
import { describe, it, expect } from "vitest";
import { MllmApi } from "../src/rpc/mllm-api";
import { buildPluginRpcCompositeApiInstance } from "../src/rpc/post-processing/plugin-api";
import type { PluginRpcApiCompositeInstance } from "../src/lib/plugin-types";

// Exact plugin prompts + schemas
import {
  sliceAnalysisSchema,
  aggregationDecisionSchema,
  wholeSummarySchema,
  DEFAULT_SLICE_ANALYSIS_PROMPT,
  DECISION_PROMPT,
  DECISION_PROMPT_WITH_TRANSCRIPTS,
  AGGREGATION_ANALYSIS_PROMPT,
  AGGREGATION_ANALYSIS_VIDEO_PROMPT,
  AGGREGATION_ANALYSIS_WITH_TRANSCRIPTS_PROMPT,
  WHOLE_SUMMARY_PROMPT,
} from "../plugins/default";
import { generatePrompt, createSchema } from "../plugins/question-answer";
import { AnalysisScope, QuestionConfig, QuestionType } from "../src/lib/question-types";
import { skipIfModelUnhealthy, getDefaultSceneModelName } from "./utils/live-models.js";

// LIVE BY DEFAULT: this suite deliberately exercises every real plugin
// prompt against a real LLM. It runs unless explicitly disabled with
// E2E_LLM_RUN=0 (or "false"), so the prompts are always tested for real.
const RUN = process.env.E2E_LLM_RUN !== "0" && process.env.E2E_LLM_RUN !== "false";
const SINGLE_Q = 0x27; // '
const DOUBLE_Q = 0x22; // "

/** Minimal dotenv loader for .env.local (MODEL_CONFIG holds endpoints). No deps. */
function loadEnvLocal(): void {
  try {
    const fs = require("node:fs");
    const path = require("node:path");
    const raw = fs.readFileSync(path.resolve(__dirname, "..", ".env.local"), "utf8");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq < 0) continue;
      const key = t.slice(0, eq).trim();
      let val = t.slice(eq + 1).trim();
      // Strip one matching surrounding quote pair (single or double), if present.
      const head = val.charCodeAt(0);
      const tail = val.charCodeAt(val.length - 1);
      if ((head === SINGLE_Q && tail === SINGLE_Q) || (head === DOUBLE_Q && tail === DOUBLE_Q)) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch {
    // .env.local absent — fall back to env / explicit overrides.
  }
}

interface Target {
  model: string;
  /** Config name of the model (key into the health report). */
  configName: string;
  endpoint: string;
  apiKey?: string;
  /** Explicit jsonSchemaMode declared on the model in archivar.config.ts. */
  configMode?: string;
}

async function resolveTarget(modelNameOverride?: string): Promise<Target> {
  loadEnvLocal();
  const modelName = modelNameOverride ?? process.env.E2E_LLM_MODEL ?? await getDefaultSceneModelName();
  if (!modelName) {
    throw new Error("No E2E_LLM_MODEL set and the configured default workflow has no scene model.");
  }
  const { getModel } = await import("../src/lib/archivar-config");
  await import("../archivar.config.js");
  const cfg = getModel(modelName);
  const endpoint = process.env.E2E_LLM_ENDPOINT ?? cfg.resolvedEndpoint;
  if (!endpoint) {
    throw new Error(
      `No endpoint resolved for model "${modelName}". Set E2E_LLM_ENDPOINT or ensure MODEL_CONFIG in .env.local covers it.`,
    );
  }
  return {
    model: process.env.E2E_LLM_MODEL_OVERRIDE ?? cfg.resolvedModel,
    configName: modelName,
    endpoint,
    apiKey: process.env.E2E_LLM_API_KEY ?? cfg.resolvedApiKey,
    configMode: cfg.jsonSchemaMode as string | undefined,
  };
}

async function callWith(
  api: PluginRpcApiCompositeInstance,
  t: Target,
  prompt: string,
  schema: unknown,
  /** Override the schema mode (defaults to "auto" like the plugin fallback). */
  mode: "auto" | "response_format" | "structured_outputs" | "legacy_guided_json" | false = "auto",
) {
  return api.mllm.callJson({
    endpoint: t.endpoint,
    model: t.model,
    apiKey: t.apiKey,
    filePaths: [],
    mediaCategory: "video",
    prompt,
    schema,
    jsonSchemaMode: mode,
    maxRetries: 2,
  });
}

function makeApi(): PluginRpcApiCompositeInstance {
  return buildPluginRpcCompositeApiInstance(new MllmApi(), {} as never, {} as never, {} as never);
}

// ── realistic sample payloads mirroring what the plugin injects at runtime ──

const sampleSliceAnalysis = {
  summary: "Nachrichtensprecher im Studio.",
  setting: "Fernsehstudio",
  scene_type: "national-news",
  timeline: [{ time: "00:00:01", event: "Sprecher liest Nachrichten" }],
  subjects: [
    { type: "person", appearance: "Anzug/Kostuem", actions: [{ time: "00:00:01", desc: "spricht in die Kamera" }] },
  ],
  camera_motion: "static",
  audio: "Sprache",
  audio_details: "",
  text_visible: [],
  uncertainties: [],
};

const SLICE_1 = JSON.stringify(
  { ...sampleSliceAnalysis, summary: "Nachrichtensprecher im Studio." },
  null,
  2,
);
const SLICE_2 = JSON.stringify(
  {
    ...sampleSliceAnalysis,
    summary: "Fortsetzung desselben Nachrichtenbeitrags im Feld.",
    setting: "Aussenaufnahme",
    camera_motion: "handheld",
  },
  null,
  2,
);

const TRANSCRIPT_1 = "Guten Tag, ich begruesse Sie zu den Nachrichten.";
const TRANSCRIPT_2 = "Vor Ort berichtet unser Reporter ueber die Lage.";
const ANALYSES_TEXT = `Schnitt 1 (Index 0):\n${SLICE_1}\n\nSchnitt 2 (Index 1):\n${SLICE_2}`;
const TRANSCRIPTS_TEXT = `  00:00:00 - 00:00:20: ${TRANSCRIPT_1}\n  00:00:20 - 00:00:40: ${TRANSCRIPT_2}`;
const AGGREGATIONS_TEXT = `Aggregation 1 (00:00:00 - 00:01:00):\n${SLICE_1}`;

// ── tests ─────────────────────────────────────────────────────────────────

describe("e2e: EXACT plugin prompts + schemas via callJson(jsonSchemaMode=auto)", () => {
  it("DEFAULT_SLICE_ANALYSIS_PROMPT + sliceAnalysisSchema", async ({ skip }) => {
    if (!RUN) return skip();
    const t = await resolveTarget();
    const unhealthy = await skipIfModelUnhealthy(t.configName);
    if (unhealthy) return skip(unhealthy);
    const res = (await callWith(makeApi(), t, DEFAULT_SLICE_ANALYSIS_PROMPT, sliceAnalysisSchema)) as {
      summary: string;
      timeline: unknown[];
    };
    // eslint-disable-next-line no-console
    console.log("[e2e:slice] summary=", res.summary);
    expect(typeof res.summary).toBe("string");
    expect(Array.isArray(res.timeline)).toBe(true);
  });

  it("DECISION_PROMPT + aggregationDecisionSchema", async ({ skip }) => {
    if (!RUN) return skip();
    const t = await resolveTarget();
    const unhealthy = await skipIfModelUnhealthy(t.configName);
    if (unhealthy) return skip(unhealthy);
    const prompt = DECISION_PROMPT
      .replace(/{{SLICE1_SUMMARY}}/g, "Nachrichten aus dem Studio")
      .replace(/{{SLICE2_SUMMARY}}/g, "Fortsetzung der Nachrichten");
    const res = (await callWith(makeApi(), t, prompt, aggregationDecisionSchema)) as {
      same_contribution: boolean;
      reason: string;
    };
    // eslint-disable-next-line no-console
    console.log("[e2e:decision] same_contribution=", res.same_contribution);
    expect(typeof res.same_contribution).toBe("boolean");
    expect(typeof res.reason).toBe("string");
  });

  it("DECISION_PROMPT_WITH_TRANSCRIPTS + aggregationDecisionSchema", async ({ skip }) => {
    if (!RUN) return skip();
    const t = await resolveTarget();
    const unhealthy = await skipIfModelUnhealthy(t.configName);
    if (unhealthy) return skip(unhealthy);
    const prompt = DECISION_PROMPT_WITH_TRANSCRIPTS
      .replace(/{{SLICE1_SUMMARY}}/g, "Nachrichten Studio")
      .replace(/{{SLICE1_TRANSCRIPT}}/g, TRANSCRIPT_1)
      .replace(/{{SLICE2_SUMMARY}}/g, "Nachrichten Fortsetzung")
      .replace(/{{SLICE2_TRANSCRIPT}}/g, TRANSCRIPT_2);
    const res = (await callWith(makeApi(), t, prompt, aggregationDecisionSchema)) as {
      same_contribution: boolean;
    };
    expect(typeof res.same_contribution).toBe("boolean");
  });

  it("AGGREGATION_ANALYSIS_PROMPT + sliceAnalysisSchema (text-only branch)", async ({ skip }) => {
    if (!RUN) return skip();
    const t = await resolveTarget();
    const unhealthy = await skipIfModelUnhealthy(t.configName);
    if (unhealthy) return skip(unhealthy);
    const prompt = AGGREGATION_ANALYSIS_PROMPT.replace(/{{SLICE_ANALYSES}}/g, ANALYSES_TEXT);
    const res = (await callWith(makeApi(), t, prompt, sliceAnalysisSchema)) as { summary: string };
    // eslint-disable-next-line no-console
    console.log("[e2e:agg-text] summary=", res.summary);
    expect(typeof res.summary).toBe("string");
  });

  it("AGGREGATION_ANALYSIS_VIDEO_PROMPT + sliceAnalysisSchema (video branch)", async ({ skip }) => {
    if (!RUN) return skip();
    const t = await resolveTarget();
    const unhealthy = await skipIfModelUnhealthy(t.configName);
    if (unhealthy) return skip(unhealthy);
    const res = (await callWith(makeApi(), t, AGGREGATION_ANALYSIS_VIDEO_PROMPT, sliceAnalysisSchema)) as {
      summary: string;
    };
    expect(typeof res.summary).toBe("string");
  });

  it("AGGREGATION_ANALYSIS_WITH_TRANSCRIPTS_PROMPT + sliceAnalysisSchema", async ({ skip }) => {
    if (!RUN) return skip();
    const t = await resolveTarget();
    const unhealthy = await skipIfModelUnhealthy(t.configName);
    if (unhealthy) return skip(unhealthy);
    const prompt = AGGREGATION_ANALYSIS_WITH_TRANSCRIPTS_PROMPT.replace(/{{SLICE_ANALYSES}}/g, ANALYSES_TEXT)
      .replace(/{{TRANSCRIPTS}}/g, TRANSCRIPTS_TEXT);
    const res = (await callWith(makeApi(), t, prompt, sliceAnalysisSchema)) as { summary: string };
    expect(typeof res.summary).toBe("string");
  });

  it("WHOLE_SUMMARY_PROMPT + wholeSummarySchema", async ({ skip }) => {
    if (!RUN) return skip();
    const t = await resolveTarget();
    const unhealthy = await skipIfModelUnhealthy(t.configName);
    if (unhealthy) return skip(unhealthy);
    const prompt = WHOLE_SUMMARY_PROMPT.replace(/{{AGGREGATIONS}}/g, AGGREGATIONS_TEXT);
    const res = (await callWith(makeApi(), t, prompt, wholeSummarySchema)) as {
      title: string;
      keywords: unknown[];
    };
    // eslint-disable-next-line no-console
    console.log("[e2e:summary] title=", res.title);
    expect(typeof res.title).toBe("string");
    expect(Array.isArray(res.keywords)).toBe(true);
  });

  // ── question-answer: real generatePrompt() + createSchema() ──────────────

  const CONTEXT =
    "Ein Bericht ueber erneuerbare Energien in Deutschland, mit Fokus auf Wind- und Solarkraft.";

  it("QA boolean - generatePrompt + createSchema", async ({ skip }) => {
    if (!RUN) return skip();
    const t = await resolveTarget();
    const unhealthy = await skipIfModelUnhealthy(t.configName);
    if (unhealthy) return skip(unhealthy);
    const q: QuestionConfig = {
      prompt: "Geht es um erneuerbare Energien?",
      type: QuestionType.Boolean,
      analyze: AnalysisScope.WholeSummary,
      label: "q",
    };
    const res = (await callWith(makeApi(), t, generatePrompt(q, CONTEXT), createSchema(q))) as {
      answer: boolean;
    };
    expect(typeof res.answer).toBe("boolean");
  });

  it("QA oneOf - generatePrompt + createSchema", async ({ skip }) => {
    if (!RUN) return skip();
    const t = await resolveTarget();
    const unhealthy = await skipIfModelUnhealthy(t.configName);
    if (unhealthy) return skip(unhealthy);
    const q: QuestionConfig = {
      prompt: "Welches Thema?",
      type: QuestionType.OneOf,
      analyze: AnalysisScope.WholeSummary,
      label: "q",
      options: ["Wissenschaft", "Kunst", "Sport"],
    };
    const res = (await callWith(makeApi(), t, generatePrompt(q, CONTEXT), createSchema(q))) as {
      answer: string;
    };
    expect(q.options).toContain(res.answer);
  });

  it("QA manyOf - generatePrompt + createSchema", async ({ skip }) => {
    if (!RUN) return skip();
    const t = await resolveTarget();
    const unhealthy = await skipIfModelUnhealthy(t.configName);
    if (unhealthy) return skip(unhealthy);
    const q: QuestionConfig = {
      prompt: "Welche Themen?",
      type: QuestionType.ManyOf,
      analyze: AnalysisScope.WholeSummary,
      label: "q",
      options: ["Wissenschaft", "Kunst", "Sport"],
    };
    const res = (await callWith(makeApi(), t, generatePrompt(q, CONTEXT), createSchema(q))) as {
      answers: unknown[];
    };
    expect(Array.isArray(res.answers)).toBe(true);
  });

  it("QA singleClaim - generatePrompt + createSchema", async ({ skip }) => {
    if (!RUN) return skip();
    const t = await resolveTarget();
    const unhealthy = await skipIfModelUnhealthy(t.configName);
    if (unhealthy) return skip(unhealthy);
    const q: QuestionConfig = {
      prompt: "Fasse in einem Satz zusammen.",
      type: QuestionType.SingleClaim,
      analyze: AnalysisScope.WholeSummary,
      label: "q",
    };
    const res = (await callWith(makeApi(), t, generatePrompt(q, CONTEXT), createSchema(q))) as {
      answer: string;
    };
    expect(typeof res.answer).toBe("string");
  });

  it("QA categorization - generatePrompt + createSchema", async ({ skip }) => {
    if (!RUN) return skip();
    const t = await resolveTarget();
    const unhealthy = await skipIfModelUnhealthy(t.configName);
    if (unhealthy) return skip(unhealthy);
    const q: QuestionConfig = {
      prompt: "Kategorisiere den Inhalt.",
      type: QuestionType.Categorization,
      analyze: AnalysisScope.WholeSummary,
      label: "q",
    };
    const res = (await callWith(makeApi(), t, generatePrompt(q, CONTEXT), createSchema(q))) as {
      categories: unknown[];
    };
    expect(Array.isArray(res.categories)).toBe(true);
  });

  // ── config-driven: prove the explicit mode pinned in archivar.config.ts ──
  // forwards end-to-end and the model returns schema-valid JSON with it.
  it("uses the EXACT jsonSchemaMode pinned on the model config", async ({ skip }) => {
    if (!RUN) return skip();
    const t = await resolveTarget();
    const unhealthy = await skipIfModelUnhealthy(t.configName);
    if (unhealthy) return skip(unhealthy);
    // The model MUST declare a jsonSchemaMode in archivar.config.ts (explicit
    // declaration — either an exact transport like "response_format" where the
    // backend supports it, or "auto" where backend support is unverified).
    expect(t.configMode, "model must declare a jsonSchemaMode in archivar.config.ts").toBeTruthy();

    const res = (await callWith(
      makeApi(),
      t,
      DEFAULT_SLICE_ANALYSIS_PROMPT,
      sliceAnalysisSchema,
      // Forward the config's mode exactly as the plugin does
      // (modelConfig.jsonSchemaMode).
      t.configMode as "response_format",
    )) as { summary: string };
    // eslint-disable-next-line no-console
    console.log(`[e2e:config-mode] mode=${t.configMode} summary=${res.summary}`);
    expect(typeof res.summary).toBe("string");
  });
});

// ── per-family: prove the model-name registry resolves the right transport ──
// for each backend family and the model returns schema-valid JSON with it.
// Models without a healthy endpoint skip. Override the set via
// E2E_LLM_MODELS="modelA,modelB" (default: the two Qwen registry families).
describe.each(
  (process.env.E2E_LLM_MODELS ?? "Qwen3.8-27B-FP8,Qwen3.6-35B-A3B-GPTQ-Int4")
    .split(",")
    .map((m) => m.trim()),
)("e2e: registry transport for %s", (modelName) => {
  it("resolves its family transport and returns schema-valid JSON", async ({ skip }) => {
    if (!RUN) return skip();
    const unhealthy = await skipIfModelUnhealthy(modelName);
    if (unhealthy) return skip(unhealthy);
    const t = await resolveTarget(modelName);
    expect(t.configMode, `${modelName} must resolve a jsonSchemaMode`).toBeTruthy();
    // eslint-disable-next-line no-console
    console.log(`[e2e:family] ${modelName} → mode=${t.configMode}`);
    const res = (await callWith(
      makeApi(),
      t,
      DECISION_PROMPT.replace(/{{SLICE1_SUMMARY}}/g, "Nachrichten Studio")
        .replace(/{{SLICE2_SUMMARY}}/g, "Fortsetzung der Nachrichten"),
      aggregationDecisionSchema,
      t.configMode as "response_format",
    )) as { same_contribution: boolean };
    expect(typeof res.same_contribution).toBe("boolean");
  });
});
