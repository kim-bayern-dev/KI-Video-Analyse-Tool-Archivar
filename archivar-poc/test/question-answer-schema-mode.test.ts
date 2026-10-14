/**
 * Focused schema-mode tests for every question-type prompt/schema pair in
 * plugins/question-answer.ts.
 *
 * WHY: The Q&A plugin should fully use native JSON-schema guided decoding for
 * every question type. Each `question.type` produces its own prompt branch
 * (generatePrompt) and Yup schema branch (createSchema). This file covers all
 * five types (boolean, oneOf, manyOf, singleClaim, categorization) plus the
 * shared migration gate:
 *   (1) the plugin forwards a non-disabled `jsonSchemaMode` (not false/undefined),
 *   (2) the schema captured at the call converts cleanly under STRICT mode,
 *   (3) the type-specific JSON instruction fired in the prompt.
 *
 * All five schemas use only supported Yup nodes (object/string/boolean/array/
 * string.oneOf), so all five are expected to be GREEN today — proving the Q&A
 * plugin is already migration-ready and only the default plugin's
 * sliceAnalysisSchema gates the cutover.
 *
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  PluginRpcApiCompositeInstance,
  PostProcessingInput,
  SemanticAggregations,
} from "../src/lib/plugin-types";
import type { QuestionAnswerConfig, QuestionConfig } from "../src/lib/question-types";
import { QuestionType, AnalysisScope } from "../src/lib/question-types";
import { yupToJsonSchema } from "../src/lib/yup-json-schema/index";
import { UnsupportedYupNodeError } from "../src/lib/errors";

// Mock getModel so the plugin resolves a model without real archivar config.
// jsonSchemaMode: "auto" mirrors the real default-on behaviour.
vi.mock("../src/lib/archivar-config.js", () => ({
  getModel: () => ({
    resolvedEndpoint: "http://mock",
    resolvedModel: "mock-model",
    resolvedApiKey: "mock-key",
    jsonSchemaMode: "auto",
  }),
}));

import { summaryFromAggregations } from "../plugins/question-answer";
import { PostProcessingPluginDefinition } from "../src/lib/types.js";

interface CapturedCall {
  schema: unknown;
  jsonSchemaMode: unknown;
  prompt: string;
}

/**
 * Recording mock PluginApi: callJson records schema/mode/prompt and validates
 * the queued raw response against the schema so the hook completes normally.
 */
function createRecordingApi(rawResponse: string | string[]): {
  api: PluginRpcApiCompositeInstance;
  calls: CapturedCall[];
} {
  const queue = Array.isArray(rawResponse) ? [...rawResponse] : [rawResponse];
  const calls: CapturedCall[] = [];
  const parseJsonLoose = (c: string) => {
    try {
      return JSON.parse(c);
    } catch {
      return null;
    }
  };
  const callJson = vi.fn(async (args: {
    schema: { validate: (v: unknown, o: unknown) => Promise<unknown> };
    jsonSchemaMode?: unknown;
    prompt: string;
  }) => {
    calls.push({
      schema: args.schema,
      jsonSchemaMode: args.jsonSchemaMode,
      prompt: args.prompt,
    });
    const raw = queue.length > 1 ? (queue.shift() as string) : (queue[0] ?? "");
    const parsed = parseJsonLoose(raw);
    if (parsed === null) {
      throw new Error("MLLM response could not be parsed as JSON");
    }
    return args.schema.validate(parsed, { abortEarly: false, stripUnknown: true });
  });

  return {
    calls,
    api: {
      file: { getMediaInfo: vi.fn(), listFiles: vi.fn(), readFile: vi.fn() },
      cache: { get: vi.fn(), set: vi.fn() },
      analysis: { getAnalysisResults: vi.fn(), analyzeSegment: vi.fn() },
      mllm: { callRaw: vi.fn(), callJson },
      util: {
        parseJsonLoose,
        formatTime: vi.fn(),
        limitConcurrency: vi.fn(),
        logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
      },
    } as unknown as PluginRpcApiCompositeInstance,
  };
}

function convertsCleanly(schema: unknown): boolean {
  try {
    yupToJsonSchema(schema as Parameters<typeof yupToJsonSchema>[0], { strict: true });
    return true;
  } catch (err) {
    if (err instanceof UnsupportedYupNodeError) return false;
    throw err;
  }
}

function createInput(defaultSummary: unknown): PostProcessingInput {
  return {
    workflowName: "test",
    workflow: {} as never,
    run: { id: "test", startedAt: "", force: false },
    file: {} as never,
    analysisResult: {
      serverUrl: "",
      fileName: "test.mp4",
      extension: ".mp4",
      outputHash: "h",
      mediaType: "video",
      scenes: [],
      postProcessing: {
        default: {
          pluginName: "default",
          startedAt: "",
          completedAt: "",
          timeSlices: [],
          aggregations: [] as SemanticAggregations,
          summary: defaultSummary,
          errors: [],
        },
      },
    } as never,
    timeSlices: [],
  };
}

const STRUCTURED_SUMMARY = {
  title: "Test Video",
  keywords: ["test"],
  short_description: "Short desc",
  long_summary: "A long summary about math and science.",
};

/** Runs one wholeSummary question and returns the single captured call. */
async function runQuestion(question: Partial<QuestionConfig> & { type: QuestionConfig["type"] }, raw: string) {
  const { api, calls } = createRecordingApi(raw);
  const pluginDefinition = {
    config: {
      modelName: "Qwen3.8-27B-FP8",
      questions: [
        {
          prompt: "Frage?",
          type: question.type,
          analyze: AnalysisScope.WholeSummary,
          label: "q",
          options: question.options,
        } as QuestionConfig,
      ],
    }
  } as PostProcessingPluginDefinition<QuestionAnswerConfig>;
  await summaryFromAggregations([], pluginDefinition, api, createInput(STRUCTURED_SUMMARY));
  expect(calls.length, "wholeSummary scope makes exactly one callJson call").toBe(1);
  return calls[0];
}

/** Shared migration-gate assertion for one captured Q&A call. */
function assertGate(call: CapturedCall, promptMarker: RegExp) {
  expect(call.jsonSchemaMode, "jsonSchemaMode must not be disabled").not.toBe(false);
  expect(call.jsonSchemaMode, "jsonSchemaMode must not be disabled").not.toBeUndefined();
  expect(call.prompt).toMatch(promptMarker);
  expect(convertsCleanly(call.schema), "schema must convert cleanly under strict mode").toBe(true);
}

// ── tests ─────────────────────────────────────────────────────────────────

describe("question-answer.ts — schema-mode gate per question type", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => { });
    vi.spyOn(console, "error").mockImplementation(() => { });
    vi.spyOn(console, "log").mockImplementation(() => { });
  });

  it("Q1: boolean question uses a clean schema + boolean prompt", async () => {
    const call = await runQuestion({ type: QuestionType.Boolean }, JSON.stringify({ answer: true, reasoning: "r" }));
    assertGate(call, /"answer":\s*true\|false/i);
  });

  it("Q2: oneOf question uses a clean enum schema + single-option prompt", async () => {
    const call = await runQuestion(
      { type: QuestionType.OneOf, options: ["A", "B"] },
      JSON.stringify({ answer: "A", reasoning: "r" }),
    );
    assertGate(call, /Waehle genau eine Option/i);
  });

  it("Q3: manyOf question uses a clean array-enum schema + multi-option prompt", async () => {
    const call = await runQuestion(
      { type: QuestionType.ManyOf, options: ["A", "B"] },
      JSON.stringify({ answers: ["A"], reasoning: "r" }),
    );
    assertGate(call, /Waehle alle zutreffenden Optionen/i);
  });

  it("Q4: singleClaim question uses a clean string schema + single-sentence prompt", async () => {
    const call = await runQuestion(
      { type: QuestionType.SingleClaim },
      JSON.stringify({ answer: "a sentence", reasoning: "r" }),
    );
    assertGate(call, /praezisen Satz/i);
  });

  it("Q5: categorization question uses a clean string-array schema + categorize prompt", async () => {
    const call = await runQuestion(
      { type: QuestionType.Categorization },
      JSON.stringify({ categories: ["x"], reasoning: "r" }),
    );
    assertGate(call, /Kategorisiere den Inhalt/i);
  });
});
