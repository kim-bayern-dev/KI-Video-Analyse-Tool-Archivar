import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  PluginRpcApiCompositeInstance,
  SemanticAggregation,
  PostProcessingInput,
  SemanticAggregations,
} from "../src/lib/plugin-types";
import type { QuestionAnswerConfig } from "../src/lib/question-types";

/** Mock getModel so tests don't depend on the real archivar config */
vi.mock("../src/lib/archivar-config.js", () => ({
  getModel: () => ({
    resolvedEndpoint: "http://mock",
    resolvedModel: "mock-model",
    resolvedApiKey: "mock-key",
  }),
}));

import { summaryFromAggregations } from "../plugins/question-answer";
import { PostProcessingPluginDefinition } from "../src/lib/workflow-types.js";

// ── helpers ───────────────────────────────────────────────────────────────

/**
 * Builds a mock PluginApi whose callJson faithfully mirrors the real contract:
 * it parses the (queued) raw response and validates it against the schema the
 * plugin passes in. Retry is not simulated here (covered by retry-validation
 * tests). Accepts a single response or a queue consumed left-to-right.
 */
function createMockApi(rawResponse: string | string[]): { api: PluginRpcApiCompositeInstance; callJsonSpy: ReturnType<typeof vi.fn> } {
  const queue = Array.isArray(rawResponse) ? [...rawResponse] : [rawResponse];
  const parseJsonLoose = (c: string) => { try { return JSON.parse(c); } catch { return null; } };
  const callJsonSpy = vi.fn(async (args: { schema: { validate: (v: unknown, o: unknown) => Promise<unknown> } }) => {
    // Multi-response queue is consumed in order; a single response repeats for every call.
    const raw = queue.length > 1 ? (queue.shift() as string) : (queue[0] ?? "");
    const parsed = parseJsonLoose(raw);
    if (parsed === null) {
      throw new Error("MLLM response could not be parsed as JSON");
    }
    return args.schema.validate(parsed, { abortEarly: false, stripUnknown: true });
  });
  return {
    api: {
      file: { getMediaInfo: vi.fn(), listFiles: vi.fn(), readFile: vi.fn() },
      cache: { get: vi.fn(), set: vi.fn() },
      analysis: { getAnalysisResults: vi.fn(), analyzeSegment: vi.fn() },
      mllm: { callRaw: vi.fn(), callJson: callJsonSpy },
      util: {
        parseJsonLoose,
        formatTime: vi.fn(),
        limitConcurrency: vi.fn(),
        logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
      },
    } as PluginRpcApiCompositeInstance,
    callJsonSpy,
  };
}

function createAggregations(): SemanticAggregations {
  return [{
    id: "test:agg:0", pluginName: "test", index: 0,
    sliceIndexes: [0], sliceIds: ["s0"],
    from: "0", to: "10", fromSeconds: 0, toSeconds: 10,
  }];
}

function createInput(
  defaultSummary: unknown,
  defaultAggregations: SemanticAggregations = [],
): PostProcessingInput {
  return {
    workflowName: "test",
    workflow: {} as any,
    run: { id: "test", startedAt: "", force: false },
    file: {} as any,
    analysisResult: {
      serverUrl: "", fileName: "test.mp4", extension: ".mp4",
      outputHash: "h", mediaType: "video", scenes: [],
      postProcessing: {
        default: {
          pluginName: "default", startedAt: "", completedAt: "",
          timeSlices: [], aggregations: defaultAggregations,
          summary: defaultSummary, errors: [],
        },
      },
    } as any,
    timeSlices: [],
  };
}

const STRUCTURED_SUMMARY = {
  title: "Test Video",
  keywords: ["test"],
  short_description: "Short desc",
  long_summary: "A long summary about math and science.",
};

// ── tests ─────────────────────────────────────────────────────────────────

describe("question-answer plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => { });
    vi.spyOn(console, "error").mockImplementation(() => { });
    vi.spyOn(console, "log").mockImplementation(() => { });
  });

  it("returns null when no questions configured", async () => {
    const { api } = createMockApi("{}");
    const result = await summaryFromAggregations(createAggregations(), {} as PostProcessingPluginDefinition<QuestionAnswerConfig>, api, createInput(STRUCTURED_SUMMARY));
    expect(result).toBeNull();
  });

  it("returns null when no default summary exists", async () => {
    const { api } = createMockApi("{}");
    const config = { questions: [{ prompt: "test?", type: "boolean", analyze: "wholeSummary", label: "t" }] } as any;
    const result = await summaryFromAggregations(createAggregations(), config, api, createInput(undefined));
    expect(result).toBeNull();
  });

  // ── Question types ──────────────────────────────────────────────────────

  describe("boolean question", () => {
    it("validates and stores boolean result", async () => {
      const { api } = createMockApi('{"answer": true, "reasoning": "yes"}');
      const pluginDefinition = {
        config: {
          modelName: "m", questions: [{
            prompt: "Is this about math?", type: "boolean",
            analyze: "wholeSummary", label: "isMath", rendering: "none",
          }],
        }
      } as PostProcessingPluginDefinition<QuestionAnswerConfig>;

      const result = await summaryFromAggregations(createAggregations(), pluginDefinition, api, createInput(STRUCTURED_SUMMARY));
      const obj = result as Record<string, any>;
      expect(obj.question_answer_results.isMath.result.answer).toBe(true);
    });
  });

  describe("oneOf question", () => {
    it("validates answer against options", async () => {
      const { api } = createMockApi('{"answer": "ja", "reasoning": "klar"}');
      const pluginDefinition = {
        config: {
          modelName: "m", questions: [{
            prompt: "Mathematik?", type: "oneOf", options: ["ja", "nein", "unsicher"],
            analyze: "wholeSummary", label: "isMath", rendering: "none",
          }],
        }
      } as PostProcessingPluginDefinition<QuestionAnswerConfig>;

      const result = await summaryFromAggregations(createAggregations(), pluginDefinition, api, createInput(STRUCTURED_SUMMARY));
      const obj = result as Record<string, any>;
      expect(obj.question_answer_results.isMath.result.answer).toBe("ja");
    });
  });

  describe("manyOf question", () => {
    it("validates multiple answers against options", async () => {
      const { api } = createMockApi('{"answers": ["Wissenschaft", "Bildung"], "reasoning": "beides"}');
      const pluginDefinition = {
        config: {
          modelName: "m", questions: [{
            prompt: "Topics?", type: "manyOf", options: ["Politik", "Wirtschaft", "Sport", "Kultur", "Wissenschaft", "Bildung"],
            analyze: "wholeSummary", label: "topics", rendering: "none",
          }],
        }
      } as PostProcessingPluginDefinition<QuestionAnswerConfig>;

      const result = await summaryFromAggregations(createAggregations(), pluginDefinition, api, createInput(STRUCTURED_SUMMARY));
      const obj = result as Record<string, any>;
      expect(obj.question_answer_results.topics.result.answers).toEqual(["Wissenschaft", "Bildung"]);
    });
  });

  describe("singleClaim question", () => {
    it("stores free-text answer", async () => {
      const { api } = createMockApi('{"answer": "Ein Testvideo ueber Mathematik.", "reasoning": "klar"}');
      const pluginDefinition = {
        config: {
          modelName: "m", questions: [{
            prompt: "Zusammenfassung", type: "singleClaim",
            analyze: "wholeSummary", label: "claim", rendering: "none",
          }],
        }
      } as PostProcessingPluginDefinition<QuestionAnswerConfig>;

      const result = await summaryFromAggregations(createAggregations(), pluginDefinition, api, createInput(STRUCTURED_SUMMARY));
      const obj = result as Record<string, any>;
      expect(obj.question_answer_results.claim.result.answer).toContain("Mathematik");
    });
  });

  describe("categorization question", () => {
    it("stores free-form categories", async () => {
      const { api } = createMockApi('{"categories": ["Bildung", "Forschung"], "reasoning": "paßt"}');
      const pluginDefinition = {
        config: {
          modelName: "m", questions: [{
            prompt: "Kategorien?", type: "categorization",
            analyze: "wholeSummary", label: "cats", rendering: "none",
          }],
        }
      } as PostProcessingPluginDefinition<QuestionAnswerConfig>;

      const result = await summaryFromAggregations(createAggregations(), pluginDefinition, api, createInput(STRUCTURED_SUMMARY));
      const obj = result as Record<string, any>;
      expect(obj.question_answer_results.cats.result.categories).toEqual(["Bildung", "Forschung"]);
    });
  });

  describe("rendering: appendToSummary with markdownTable", () => {
    it("appends markdown table to long_summary", async () => {
      const { api } = createMockApi('{"answer": true, "reasoning": "ja"}');
      const pluginDefinition = {
        config: {
          modelName: "m", questions: [{
            prompt: "Math?", type: "boolean",
            analyze: "wholeSummary", label: "isMath",
            rendering: "appendToSummary", resultFormat: "markdownTable",
          }],
        }
      } as PostProcessingPluginDefinition<QuestionAnswerConfig>;

      const result = await summaryFromAggregations(createAggregations(), pluginDefinition, api, createInput(STRUCTURED_SUMMARY));
      const obj = result as Record<string, any>;
      expect(obj.long_summary).toContain("| Frage | Antwort |");
      expect(obj.long_summary).toContain("Ja");
    });
  });

  describe("rendering: appendToSummary with json", () => {
    it("appends JSON code block to long_summary", async () => {
      const { api } = createMockApi('{"answer": true, "reasoning": "ja"}');
      const pluginDefinition = {
        config: {
          modelName: "m", questions: [{
            prompt: "Math?", type: "boolean",
            analyze: "wholeSummary", label: "isMath",
            rendering: "appendToSummary", resultFormat: "json",
          }],
        }
      } as PostProcessingPluginDefinition<QuestionAnswerConfig>;

      const result = await summaryFromAggregations(createAggregations(), pluginDefinition, api, createInput(STRUCTURED_SUMMARY));
      const obj = result as Record<string, any>;
      expect(obj.long_summary).toContain("```json");
      expect(obj.long_summary).toContain('"isMath"');
    });
  });

  describe("rendering: none", () => {
    it("stores result only in question_answer_results, NOT in summary", async () => {
      const { api } = createMockApi('{"answer": true, "reasoning": "ja"}');
      const pluginDefinition = {
        config: {
          modelName: "m", questions: [{
            prompt: "Math?", type: "boolean",
            analyze: "wholeSummary", label: "isMath", rendering: "none",
          }],
        }
      } as PostProcessingPluginDefinition<QuestionAnswerConfig>;

      const result = await summaryFromAggregations(createAggregations(), pluginDefinition, api, createInput(STRUCTURED_SUMMARY));
      const obj = result as Record<string, any>;
      // Result is in structured field
      expect(obj.question_answer_results.isMath.result.answer).toBe(true);
      // long_summary unchanged (no appended content)
      expect(obj.long_summary).toBe(STRUCTURED_SUMMARY.long_summary);
    });
  });

  // ── Analysis scopes ─────────────────────────────────────────────────────

  describe("analyze: wholeSummary", () => {
    it("makes a single MLLM call with the summary text", async () => {
      const { api, callJsonSpy } = createMockApi('{"answer": true, "reasoning": "ja"}');
      const pluginDefinition = {
        config: {
          modelName: "m", questions: [{
            prompt: "Math?", type: "boolean",
            analyze: "wholeSummary", label: "isMath", rendering: "none",
          }],
        }
      } as PostProcessingPluginDefinition<QuestionAnswerConfig>;

      await summaryFromAggregations(createAggregations(), pluginDefinition, api, createInput(STRUCTURED_SUMMARY));
      expect(callJsonSpy).toHaveBeenCalledTimes(1);
      expect(callJsonSpy.mock.calls[0][0].prompt).toContain("A long summary about math and science.");
    });
  });

  describe("analyze: everyAggregationSummaryThenConclude", () => {
    it("makes N+1 calls: one per aggregation + one conclusion", async () => {
      const aggs: SemanticAggregations = [
        { id: "a:0", pluginName: "default", index: 0, sliceIndexes: [0], sliceIds: ["s0"], from: "0", to: "10", fromSeconds: 0, toSeconds: 10, summary: "First segment about algebra" },
        { id: "a:1", pluginName: "default", index: 1, sliceIndexes: [1], sliceIds: ["s1"], from: "10", to: "20", fromSeconds: 10, toSeconds: 20, summary: "Second segment about calculus" },
      ];
      const { api, callJsonSpy } = createMockApi('{"answer": true, "reasoning": "ja"}');
      const pluginDefinition = {
        config: {
          modelName: "m", questions: [{
            prompt: "Math?", type: "boolean",
            analyze: "everyAggregationSummaryThenConclude", label: "isMath", rendering: "none",
          }],
        }
      } as PostProcessingPluginDefinition<QuestionAnswerConfig>;

      await summaryFromAggregations(createAggregations(), pluginDefinition, api, createInput(STRUCTURED_SUMMARY, aggs));
      // 2 per-aggregation calls + 1 conclusion = 3
      expect(callJsonSpy).toHaveBeenCalledTimes(3);
      // Verify per-aggregation context
      expect(callJsonSpy.mock.calls[0][0].prompt).toContain("First segment about algebra");
      expect(callJsonSpy.mock.calls[1][0].prompt).toContain("Second segment about calculus");
    });

    it("stores perAggregation breakdown in results", async () => {
      const aggs: SemanticAggregations = [
        { id: "a:0", pluginName: "default", index: 0, sliceIndexes: [0], sliceIds: ["s0"], from: "0", to: "5", fromSeconds: 0, toSeconds: 5, summary: "Seg A" },
      ];
      const { api } = createMockApi('{"answer": true, "reasoning": "ja"}');
      const pluginDefinition: PostProcessingPluginDefinition<QuestionAnswerConfig> = {
        config: {
          modelName: "m", questions: [{
            prompt: "Math?", type: "boolean",
            analyze: "everyAggregationSummaryThenConclude", label: "isMath", rendering: "none",
          }],
        }
      } as PostProcessingPluginDefinition<QuestionAnswerConfig>;

      const result = await summaryFromAggregations(createAggregations(), pluginDefinition, api, createInput(STRUCTURED_SUMMARY, aggs));
      const obj = result as Record<string, any>;
      expect(obj.question_answer_results.isMath.perAggregation).toBeDefined();
      expect(obj.question_answer_results.isMath.perAggregation.length).toBe(1);
    });
  });

  // ── Multiple questions ──────────────────────────────────────────────────

  describe("multiple questions processed sequentially", () => {
    it("processes all questions and collects results", async () => {
      const { api, callJsonSpy } = createMockApi([
        '{"answer": true, "reasoning": "math"}',
        '{"answers": ["Wissenschaft"], "reasoning": "science"}',
      ]);

      const pluginDefinition: PostProcessingPluginDefinition<QuestionAnswerConfig> = {
        config: {
          modelName: "m", questions: [
            { prompt: "Math?", type: "boolean", analyze: "wholeSummary", label: "isMath", rendering: "none" },
            { prompt: "Topics?", type: "manyOf", options: ["Wissenschaft", "Sport"], analyze: "wholeSummary", label: "topics", rendering: "none" },
          ],
        }
      } as PostProcessingPluginDefinition<QuestionAnswerConfig>;

      const result = await summaryFromAggregations(createAggregations(), pluginDefinition, api, createInput(STRUCTURED_SUMMARY));
      const obj = result as Record<string, any>;

      expect(callJsonSpy).toHaveBeenCalledTimes(2);
      expect(obj.question_answer_results.isMath.result.answer).toBe(true);
      expect(obj.question_answer_results.topics.result.answers).toEqual(["Wissenschaft"]);
    });
  });

  // ── Graceful degradation ────────────────────────────────────────────────

  describe("graceful degradation", () => {
    it("records error when MLLM returns invalid response for a question", async () => {
      const { api } = createMockApi("not valid json");
      const pluginDefinition: PostProcessingPluginDefinition<QuestionAnswerConfig> = {
        config: {
          modelName: "m", questions: [{
            prompt: "Math?", type: "boolean",
            analyze: "wholeSummary", label: "isMath", rendering: "none",
          }],
        }
      } as PostProcessingPluginDefinition<QuestionAnswerConfig>;

      const result = await summaryFromAggregations(createAggregations(), pluginDefinition, api, createInput(STRUCTURED_SUMMARY));
      const obj = result as Record<string, any>;
      expect(obj.question_answer_results.isMath._error).toBeDefined();
    });

    it("continues processing other questions when one fails", async () => {
      const { api } = createMockApi([
        "invalid",  // First fails
        '{"answer": true, "reasoning": "ok"}',  // Second succeeds
      ]);

      const pluginDefinition: PostProcessingPluginDefinition<QuestionAnswerConfig> = {
        config: {
          modelName: "m", questions: [
            { prompt: "Q1?", type: "boolean", analyze: "wholeSummary", label: "q1", rendering: "none" },
            { prompt: "Q2?", type: "boolean", analyze: "wholeSummary", label: "q2", rendering: "none" },
          ],
        }
      } as PostProcessingPluginDefinition<QuestionAnswerConfig>;

      const result = await summaryFromAggregations(createAggregations(), pluginDefinition, api, createInput(STRUCTURED_SUMMARY));
      const obj = result as Record<string, any>;
      expect(obj.question_answer_results.q1._error).toBeDefined();
      expect(obj.question_answer_results.q2.result.answer).toBe(true);
    });

    it("returns original summary unchanged when summary has no text", async () => {
      const { api } = createMockApi('{"answer": true, "reasoning": "ja"}');
      const pluginDefinition: PostProcessingPluginDefinition<QuestionAnswerConfig> = {
        config: {
          modelName: "m", questions: [{
            prompt: "Math?", type: "boolean",
            analyze: "wholeSummary", label: "isMath", rendering: "none",
          }],
        }
      } as PostProcessingPluginDefinition<QuestionAnswerConfig>;
      const emptySummary = { title: "", short_description: "", long_summary: "" };

      const result = await summaryFromAggregations(createAggregations(), pluginDefinition, api, createInput(emptySummary));
      expect(result).toEqual(emptySummary);
    });
  });

  // ── String summary support ─────────────────────────────────────────────

  describe("string summary", () => {
    it("appends markdown to string summary", async () => {
      const { api } = createMockApi('{"answer": true, "reasoning": "ja"}');
      const pluginDefinition: PostProcessingPluginDefinition<QuestionAnswerConfig> = {
        config: {
          modelName: "m", questions: [{
            prompt: "Math?", type: "boolean",
            analyze: "wholeSummary", label: "isMath",
            rendering: "appendToSummary", resultFormat: "markdownTable",
          }],
        }
      } as PostProcessingPluginDefinition<QuestionAnswerConfig>;

      const result = await summaryFromAggregations(createAggregations(), pluginDefinition, api, createInput("Plain text summary"));
      expect(result).toBe("Plain text summary\n\n| Frage | Antwort | Begruendung |\n|-------|---------|-------------|\n| Math? | Ja | ja |");
    });
  });

  // ── System prompt override ─────────────────────────────────────────────

  describe("systemPrompt override", () => {
    it("when systemPrompt is undefined, callJson receives undefined for systemPrompt", async () => {
      const { api, callJsonSpy } = createMockApi('{"answer": true, "reasoning": "ja"}');
      const pluginDefinition: PostProcessingPluginDefinition<QuestionAnswerConfig> = {
        config: {
          modelName: "m", questions: [{
            prompt: "Math?", type: "boolean",
            analyze: "wholeSummary", label: "isMath", rendering: "none",
            // systemPrompt intentionally omitted (undefined)
          }],
        }
      } as PostProcessingPluginDefinition<QuestionAnswerConfig>;

      await summaryFromAggregations(createAggregations(), pluginDefinition, api, createInput(STRUCTURED_SUMMARY));
      expect(callJsonSpy).toHaveBeenCalledTimes(1);
      // When systemPrompt is undefined, it should be passed as undefined to callJson
      expect(callJsonSpy.mock.calls[0][0].systemPrompt).toBeUndefined();
    });

    it("when systemPrompt is set, it is passed to callJson", async () => {
      const { api, callJsonSpy } = createMockApi('{"answer": true, "reasoning": "ja"}');
      const customSystemPrompt = "Today is 2026-07-06. You are an analyst.";
      const pluginDefinition: PostProcessingPluginDefinition<QuestionAnswerConfig> = {
        config: {
          modelName: "m", questions: [{
            prompt: "Math?", type: "boolean",
            analyze: "wholeSummary", label: "isMath", rendering: "none",
            systemPrompt: customSystemPrompt,
          }],
        }
      } as PostProcessingPluginDefinition<QuestionAnswerConfig>;

      await summaryFromAggregations(createAggregations(), pluginDefinition, api, createInput(STRUCTURED_SUMMARY));
      expect(callJsonSpy).toHaveBeenCalledTimes(1);
      expect(callJsonSpy.mock.calls[0][0].systemPrompt).toBe(customSystemPrompt);
    });

    it("systemPrompt is passed to callJson for everyAggregationSummaryThenConclude", async () => {
      const aggs: SemanticAggregations = [
        { id: "a:0", pluginName: "default", index: 0, sliceIndexes: [0], sliceIds: ["s0"], from: "0", to: "10", fromSeconds: 0, toSeconds: 10, summary: "First segment" },
      ];
      const { api, callJsonSpy } = createMockApi('{"answer": true, "reasoning": "ja"}');
      const customSystemPrompt = "Custom system prompt for aggregation analysis.";
      const pluginDefinition = {
        config: {
          modelName: "m", questions: [{
            prompt: "Math?", type: "boolean",
            analyze: "everyAggregationSummaryThenConclude", label: "isMath", rendering: "none",
            systemPrompt: customSystemPrompt,
          }],
        }
      } as PostProcessingPluginDefinition<QuestionAnswerConfig>;

      await summaryFromAggregations(createAggregations(), pluginDefinition, api, createInput(STRUCTURED_SUMMARY, aggs));
      // 1 per-aggregation call + 1 conclusion = 2 calls
      expect(callJsonSpy).toHaveBeenCalledTimes(2);
      // All calls should receive the custom systemPrompt
      for (const call of callJsonSpy.mock.calls) {
        expect(call[0].systemPrompt).toBe(customSystemPrompt);
      }
    });

    it("different questions can have different systemPrompts", async () => {
      const { api, callJsonSpy } = createMockApi([
        '{"answer": true, "reasoning": "ja"}',
        '{"answer": "ja", "reasoning": "klar"}',
      ]);
      const systemPrompt1 = "System prompt for question 1.";
      const systemPrompt2 = "System prompt for question 2.";
      const pluginDefinition: PostProcessingPluginDefinition<QuestionAnswerConfig> = {
        config: {
          modelName: "m", questions: [
            {
              prompt: "Math?", type: "boolean",
              analyze: "wholeSummary", label: "isMath", rendering: "none",
              systemPrompt: systemPrompt1,
            },
            {
              prompt: "Wissenschaft?", type: "oneOf", options: ["ja", "nein"],
              analyze: "wholeSummary", label: "isWissenschaft", rendering: "none",
              systemPrompt: systemPrompt2,
            },
          ],
        }
      } as PostProcessingPluginDefinition<QuestionAnswerConfig>;

      await summaryFromAggregations(createAggregations(), pluginDefinition, api, createInput(STRUCTURED_SUMMARY));
      expect(callJsonSpy).toHaveBeenCalledTimes(2);
      expect(callJsonSpy.mock.calls[0][0].systemPrompt).toBe(systemPrompt1);
      expect(callJsonSpy.mock.calls[1][0].systemPrompt).toBe(systemPrompt2);
    });
  });
});
