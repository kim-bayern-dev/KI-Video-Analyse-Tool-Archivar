/**
 * Generalized Question-Answer Pipeline Plugin.
 *
 * A configurable plugin that asks the MLLM a set of questions about the
 * media content, based on the summary already produced by the `default`
 * plugin (or per-aggregation summaries). Each question has a type
 * (boolean, oneOf, manyOf, singleClaim, categorization), an analysis
 * scope, a result format (json or markdown table), and a rendering mode
 * (appendToSummary or none).
 *
 * Only `summaryFromAggregations` is implemented. All other v3 hooks are
 * omitted — the engine auto-creates aggregations and only calls the
 * summary hook, which processes all configured questions sequentially.
 *
 * Configuration example (archivar.config.ts → plugin.config):
 * ```typescript
 * {
 *   modelName: "Qwen3.8-27B-FP8",
 *   questions: [
 *     { prompt: "Is this about math?", type: QuestionType.Boolean, analyze: AnalysisScope.WholeSummary,
 *       label: "isAboutMath", rendering: Rendering.AppendToSummary, resultFormat: ResultFormat.MarkdownTable },
 *     { prompt: "Which topics?", type: QuestionType.ManyOf, options: ["Science","Art","Sports"],
 *       analyze: AnalysisScope.EveryAggregationSummaryThenConclude, label: "topics", rendering: Rendering.None },
 *   ],
 * }
 * ```
 */

import * as yup from "yup";
import type {
  PluginRpcApiCompositeInstance,
  PostProcessingInput,
  JsonValue,
  PostProcessingPluginDefinition,
  SemanticAggregations,
} from "../src/lib/types.js";
import {
  QuestionAnswerConfig,
  QuestionConfig,
  QuestionResult,
  ProcessedQuestion,
  QuestionType,
  AnalysisScope,
  ResultFormat,
  Rendering,
} from "../src/lib/question-types.js";
import { getModel } from "../src/lib/archivar-config.js";

const DEFAULT_MODEL = "Qwen3.8-27B-FP8";
const DEFAULT_RESULT_FORMAT = ResultFormat.Json;
const DEFAULT_RENDERING = Rendering.None;
const DEFAULT_PLUGIN_NAME = "default";

/**
 * Generates the MLLM prompt for a question based on its type and the
 * context text (summary or aggregation summary). Each type has a different
 * JSON response contract. Exported for tooling/e2e tests.
 */
export function generatePrompt(question: QuestionConfig, context: string): string {
  const base = `Du bist ein Analyse-Assistent. Beantworte die Frage ausschliesslich basierend auf dem folgenden Text.\n\nText:\n${context}\n\nFrage: ${question.prompt}`;

  switch (question.type) {
    case QuestionType.Boolean:
      return `${base}\n\nAntworte direkt mit gültigem JSON in ausschließlich folgendem Schema ohne JSON-Fences:\n{ "answer": true|false, "reasoning": "kurze Begruendung auf Deutsch" }`;

    case QuestionType.OneOf:
      return `${base}\n\nVerfuegbare Optionen: ${(question.options ?? []).join(", ")}\n\nWaehle genau eine Option. Antworte direkt mit gültigem JSON in ausschließlich folgendem Schema ohne JSON-Fences:\n{ "answer": "gewaehlte Option", "reasoning": "kurze Begruendung auf Deutsch" }`;

    case QuestionType.ManyOf:
      return `${base}\n\nVerfuegbare Optionen: ${(question.options ?? []).join(", ")}\n\nWaehle alle zutreffenden Optionen. Antworte direkt mit gültigem JSON in ausschließlich folgendem Schema ohne JSON-Fences:\n{ "answers": ["Option1", "Option2"], "reasoning": "kurze Begruendung auf Deutsch" }`;

    case QuestionType.SingleClaim:
      return `${base}\n\nBeantworte mit einem praezisen Satz. Antworte direkt mit gültigem JSON in ausschließlich folgendem Schema ohne JSON-Fences:\n{ "answer": "ein praeziser Satz", "reasoning": "kurze Begruendung auf Deutsch" }`;

    case QuestionType.Categorization:
      return `${base}\n\nKategorisiere den Inhalt frei in passende Kategorien. Antworte direkt mit gültigem JSON in ausschließlich folgendem Schema ohne JSON-Fences:\n{ "categories": ["Kategorie1", "Kategorie2"], "reasoning": "kurze Begruendung auf Deutsch" }`;

    default:
      return base;
  }
}

/**
 * Creates a Yup validation schema tailored to the question type.
 * Each type validates a different JSON structure from the MLLM.
 * Exported for tooling/e2e tests.
 */
export function createSchema(question: QuestionConfig): yup.Schema {
  const reasoning = yup.string().required();

  switch (question.type) {
    case QuestionType.Boolean:
      return yup.object({ answer: yup.boolean().required(), reasoning }).stripUnknown();

    case QuestionType.OneOf:
      return yup.object({
        answer: yup.string().oneOf(question.options ?? []).required(),
        reasoning,
      }).stripUnknown();

    case QuestionType.ManyOf:
      return yup.object({
        answers: yup.array().of(
          yup.string().oneOf(question.options ?? []).required(),
        ).required(),
        reasoning,
      }).stripUnknown();

    case QuestionType.SingleClaim:
      return yup.object({ answer: yup.string().required(), reasoning }).stripUnknown();

    case QuestionType.Categorization:
      return yup.object({
        categories: yup.array().of(yup.string().required()).required(),
        reasoning,
      }).stripUnknown();

    default:
      return yup.object({ answer: yup.mixed().required(), reasoning }).stripUnknown();
  }
}

/**
 * Formats a validated question result as a Markdown table.
 * Each question type produces a different table layout.
 */
function formatAsMarkdown(question: QuestionConfig, result: QuestionResult): string {
  const q = question.prompt;

  switch (question.type) {
    case QuestionType.Boolean: {
      const r = result as { answer: boolean; reasoning: string };
      return `| Frage | Antwort | Begruendung |\n|-------|---------|-------------|\n| ${q} | ${r.answer ? "Ja" : "Nein"} | ${r.reasoning} |`;
    }

    case QuestionType.OneOf: {
      const r = result as { answer: string; reasoning: string };
      return `| Frage | Antwort | Begruendung |\n|-------|---------|-------------|\n| ${q} | ${r.answer} | ${r.reasoning} |`;
    }

    case QuestionType.ManyOf: {
      const r = result as { answers: string[]; reasoning: string };
      return `| Frage | Antworten | Begruendung |\n|-------|-----------|-------------|\n| ${q} | ${r.answers.join(", ")} | ${r.reasoning} |`;
    }

    case QuestionType.SingleClaim: {
      const r = result as { answer: string; reasoning: string };
      return `| Frage | Antwort |\n|-------|---------|\n| ${q} | ${r.answer} |`;
    }

    case QuestionType.Categorization: {
      const r = result as { categories: string[]; reasoning: string };
      return `| Frage | Kategorien | Begruendung |\n|-------|------------|-------------|\n| ${q} | ${r.categories.join(", ")} | ${r.reasoning} |`;
    }

    default:
      return "";
  }
}

/**
 * Extracts the most descriptive text from a summary value, regardless of
 * whether it is a structured object (default plugin output) or a plain string.
 */
function extractSummaryText(summary: JsonValue | string | undefined): string {
  if (!summary) return "";
  if (typeof summary === "string") return summary;
  const obj = summary as Record<string, unknown>;
  return String(obj.long_summary ?? obj.short_description ?? obj.title ?? "");
}

/**
 * Formats a validated Q&A pair into a readable context string for
 * auto-regressive aggregation. Used when `enableAutoRegressiveAnswerAggregation`
 * is true - the formatted Q&A is accumulated and passed to subsequent questions.
 */
function formatQAForContext(question: QuestionConfig, result: QuestionResult): string {
  const r = result as unknown as Record<string, unknown>;
  let answerText: string;
  switch (question.type) {
    case QuestionType.Boolean: answerText = r.answer ? "Ja" : "Nein"; break;
    case QuestionType.OneOf: answerText = String(r.answer ?? ""); break;
    case QuestionType.ManyOf: answerText = Array.isArray(r.answers) ? (r.answers as string[]).join(", ") : ""; break;
    case QuestionType.SingleClaim: answerText = String(r.answer ?? ""); break;
    case QuestionType.Categorization: answerText = Array.isArray(r.categories) ? (r.categories as string[]).join(", ") : ""; break;
    default: answerText = JSON.stringify(result);
  }
  return `Frage: ${question.prompt}\nAntwort: ${answerText}\nBegruendung: ${String(r.reasoning ?? "")}`;
}

/**
 * Runs a single MLLM call for the given question against the provided
 * context text, validates the response, and returns the result.
 * Returns an error string instead of throwing.
 */
async function askQuestion(
  question: QuestionConfig,
  context: string,
  api: PluginRpcApiCompositeInstance,
  modelConfig: ReturnType<typeof getModel>,
): Promise<{ result: QuestionResult | null; error: string | null }> {
  if (!context) {
    return { result: null, error: "No context text available" };
  }

  const prompt = generatePrompt(question, context);
  const schema = createSchema(question);

  // Log the question context for debugging: label, system prompt, and full prompt
  console.log(`[question-answer] Asking: "${question.label}"`);
  console.log(`[question-answer] System prompt: ${question.systemPrompt ?? "(none)"}`);
  console.log(`[question-answer] Full prompt: ${prompt}`);

  try {
    // callJson handles parse + validate + validation-error retry automatically,
    // re-prompting the model with the exact schema violations on failure.
    const validated = await api.mllm.callJson<QuestionResult>({
      endpoint: modelConfig.resolvedEndpoint,
      model: modelConfig.resolvedModel,
      apiKey: modelConfig.resolvedApiKey,
      filePaths: [],
      mediaCategory: "video",
      prompt,
      schema,
      systemPrompt: question.systemPrompt,
      enableThinking: false,
      jsonSchemaMode: modelConfig.jsonSchemaMode,
      jsonSchemaName: modelConfig.jsonSchemaName,
      structuredMaxTokens: modelConfig.structuredOutput?.maxTokens,
      structuredTemperature: modelConfig.structuredOutput?.temperature,
      structuredFrequencyPenalty: modelConfig.structuredOutput?.frequencyPenalty,
      structuredRepetitionPenalty: modelConfig.structuredOutput?.repetitionPenalty,
      repetitionDetection: modelConfig.resolvedRepetitionDetection,
      hyperparams: modelConfig.hyperparams,
    });
    return { result: validated, error: null };
  } catch (err) {
    return { result: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Analyzes a question using the whole-video summary from the default plugin.
 * Single MLLM call.
 */
async function analyzeWholeSummary(
  question: QuestionConfig,
  summaryText: string,
  api: PluginRpcApiCompositeInstance,
  modelConfig: ReturnType<typeof getModel>,
): Promise<ProcessedQuestion> {
  const { result, error } = await askQuestion(question, summaryText, api, modelConfig);

  return {
    config: question,
    result: result ?? ({} as QuestionResult),
    error,
    markdown: result && !error
      ? (question.resultFormat ?? DEFAULT_RESULT_FORMAT) === ResultFormat.MarkdownTable
        ? formatAsMarkdown(question, result)
        : undefined
      : undefined,
  };
}

/**
 * Analyzes a question per aggregation, then synthesizes a final conclusion.
 * Makes N+1 MLLM calls (one per aggregation + one conclusion).
 */
async function analyzeEveryAggregationThenConclude(
  question: QuestionConfig,
  aggregations: SemanticAggregations,
  api: PluginRpcApiCompositeInstance,
  modelConfig: ReturnType<typeof getModel>,
): Promise<ProcessedQuestion> {
  const perAggregation: NonNullable<ProcessedQuestion["perAggregation"]> = [];

  // Phase 1: Ask the question for each aggregation that has a summary
  for (const agg of aggregations) {
    const aggText = typeof agg.summary === "string"
      ? agg.summary
      : agg.analysis
        ? extractSummaryText(agg.analysis as JsonValue)
        : "";

    if (!aggText) continue;

    const { result, error } = await askQuestion(question, aggText, api, modelConfig);
    if (result && !error) {
      perAggregation.push({
        aggregationId: agg.id,
        from: agg.from,
        to: agg.to,
        result,
      });
    }
  }

  // Phase 2: Synthesize conclusion from per-aggregation answers
  let finalResult: QuestionResult | null = null;
  let finalError: string | null = null;

  if (perAggregation.length === 0) {
    finalError = "No aggregations with summaries found";
  } else {
    // Build a context summarizing all per-aggregation answers
    const breakdown = perAggregation.map((p, i) => {
      const r = p.result as unknown as Record<string, unknown>;
      return `Segment ${i + 1} (${p.from}-${p.to}): ${JSON.stringify(r)}`;
    }).join("\n");

    const conclusionContext = `Zusammenfassung der segmentweisen Antworten:\n${breakdown}`;
    const { result, error } = await askQuestion(question, conclusionContext, api, modelConfig);
    finalResult = result;
    finalError = error;
  }

  return {
    config: question,
    result: finalResult ?? ({} as QuestionResult),
    perAggregation: perAggregation.length > 0 ? perAggregation : undefined,
    error: finalError,
    markdown: finalResult && !finalError
      ? (question.resultFormat ?? DEFAULT_RESULT_FORMAT) === ResultFormat.MarkdownTable
        ? formatAsMarkdown(question, finalResult)
        : undefined
      : undefined,
  };
}

/**
 * Processes all configured questions sequentially, formats results,
 * and returns the enhanced summary.
 *
 * For questions with `rendering: "appendToSummary"`, formatted markdown
 * (or JSON code blocks) is appended to the summary's `long_summary` text.
 * For `rendering: "none"`, results are stored only in the structured
 * `question_answer_results` field.
 */
export async function summaryFromAggregations(
  _aggregations: SemanticAggregations,
  pluginDefinition: PostProcessingPluginDefinition<QuestionAnswerConfig>,
  api: PluginRpcApiCompositeInstance,
  input?: PostProcessingInput,
): Promise<JsonValue> {
  // Parse config — questions are required
  const qaConfig = pluginDefinition.config as QuestionAnswerConfig;
  if (!qaConfig?.questions || !Array.isArray(qaConfig.questions) || qaConfig.questions.length === 0) {
    console.warn("[question-answer] No questions configured - skipping");
    return null;
  }

  // Read the default plugin's results
  const defaultResult = input?.analysisResult?.postProcessing?.[DEFAULT_PLUGIN_NAME];
  const defaultSummary = defaultResult?.summary as JsonValue | string | undefined;
  const defaultAggregations = defaultResult?.aggregations ?? [];

  if (!defaultSummary) {
    console.warn("[question-answer] No default plugin summary found - skipping");
    return null;
  }

  const summaryText = extractSummaryText(defaultSummary);
  if (!summaryText) {
    console.warn("[question-answer] Default summary has no text - skipping");
    return defaultSummary as JsonValue;
  }

  const modelName = String(qaConfig.modelName ?? qaConfig.modelName ?? DEFAULT_MODEL);
  const modelConfig = getModel(modelName);

  // Process each question sequentially
  const processed: ProcessedQuestion[] = [];
  const appendSections: string[] = [];

  // Auto-regressive context: accumulates Q&A pairs from questions with
  // enableAutoRegressiveAnswerAggregation=true. Each subsequent question
  // receives this context as additional information in its prompt.
  let regressiveContext = "";

  for (const question of qaConfig.questions) {
    // Combine summary text with accumulated Q&A context (if any)
    const contextText = regressiveContext
      ? `${summaryText}\n\n---\nBisherige Fragen und Antworten:\n${regressiveContext}`
      : summaryText;

    console.log(`[question-answer] Processing: ${question.label} (${question.type})${regressiveContext ? " [with context]" : ""}`);

    let pq: ProcessedQuestion;

    if (question.analyze === AnalysisScope.EveryAggregationSummaryThenConclude) {
      pq = await analyzeEveryAggregationThenConclude(question, defaultAggregations as SemanticAggregations, api, modelConfig);
    } else {
      pq = await analyzeWholeSummary(question, contextText, api, modelConfig);
    }

    if (pq.error) {
      console.error(`[question-answer] ${question.label} failed: ${pq.error}`);
    } else {
      console.log(`[question-answer] ${question.label} completed`);
    }

    processed.push(pq);

    // Accumulate Q&A into regressive context if flag is enabled
    if (question.enableAutoRegressiveAnswerAggregation && !pq.error) {
      const qaFormatted = formatQAForContext(question, pq.result);
      regressiveContext += (regressiveContext ? "\n\n" : "") + qaFormatted;
    }

    // Collect appendToSummary sections
    const rendering = question.rendering ?? DEFAULT_RENDERING;
    const resultFormat = question.resultFormat ?? DEFAULT_RESULT_FORMAT;

    if (rendering === Rendering.AppendToSummary && !pq.error) {
      if (resultFormat === ResultFormat.MarkdownTable && pq.markdown) {
        appendSections.push(pq.markdown);
      } else if (resultFormat === ResultFormat.Json) {
        // Wrap JSON result in fenced code block
        appendSections.push(`\`\`\`json\n${JSON.stringify({ [question.label]: pq.result }, null, 2)}\n\`\`\``);
      }
    }
  }

  // Build the structured results object
  const structuredResults: Record<string, unknown> = {};
  for (const pq of processed) {
    structuredResults[pq.config.label] = pq.error
      ? { _error: pq.error }
      : { result: pq.result, ...(pq.perAggregation ? { perAggregation: pq.perAggregation } : {}) };
  }

  // Return enhanced summary
  if (typeof defaultSummary === "string") {
    // String summary: append sections as text
    const appended = appendSections.length > 0
      ? `${defaultSummary}\n\n${appendSections.join("\n\n")}`
      : defaultSummary;
    return appended;
  }

  // Structured summary: add fields
  const summaryObj = { ...(defaultSummary as Record<string, unknown>) };

  // Append markdown/JSON sections to long_summary
  if (appendSections.length > 0) {
    const originalLong = String(summaryObj.long_summary ?? summaryObj.short_description ?? "");
    summaryObj.long_summary = `${originalLong}\n\n${appendSections.join("\n\n")}`;
  }

  // Always include structured results
  summaryObj.question_answer_results = structuredResults;

  return summaryObj as JsonValue;
}
