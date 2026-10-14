/**
 * Central defaults for native JSON-schema structured output.
 *
 * These are the SINGLE source of truth — no other file should hard-code these
 * numbers. Override per-model via `ModelConfig.structuredOutput` in
 * `archivar.config.ts`.
 */

/**
 * Hard ceiling for the truncation-bump ladder (16k → 32k → 64k). Attempt 0
 * starts at the per-type start window (ModelConfig.contextWindows) or the
 * structuredOutput/default cap; each truncation doubles — never past this.
 * Server-side feasibility below the ceiling is handled separately by the
 * context-length clamp in mllm-api (exact fit for the actual input size).
 */
export const STRUCTURED_MAX_TOKENS_CEILING = 65536;

/** Default structured-output sampling configuration. */
export const STRUCTURED_OUTPUT_DEFAULTS = {
  /** Hard max_tokens cap for structured calls (degeneration fails fast).
   *  16384 matches what all current models pin via structuredOutput.maxTokens —
   *  the default now guarantees the same ceiling for models without an override. */
  maxTokens: 16384,
  /** Sampling temperature forced for structured calls. Low for schema fidelity
   *  (less drift / fewer retries than stochastic 1.0); the grammar still
   *  guarantees validity. Override per model via structuredOutput.temperature. */
  temperature: 0.2,
  /** Default retry count for validation/truncation failures (3 total attempts). */
  maxRetries: 2,
  /** Anti-repetition for structured calls: penalizes verbatim token loops
   *  (e.g. keyword-list degeneration). Plain logit multiplier — no guided-
   *  decoding conflict. Override per model via structuredOutput.repetitionPenalty. */
  repetitionPenalty: 1.05,
  /** Mild anti-repetition for structured calls (no observed grammar conflict).
   *  Override per model via structuredOutput.frequencyPenalty. */
  frequencyPenalty: 0.1,
} as const;

/** Per-model structured-output override shape (on ModelConfig). */
export interface StructuredOutputConfig {
  /** Override the max_tokens cap for structured calls. */
  maxTokens?: number;
  /** Override the forced temperature for structured calls (default 0.2). */
  temperature?: number;
  /** Override the retry count for callJson validation/truncation failures. */
  maxRetries?: number;
  /** Override repetition_penalty for structured calls (default 1.05). */
  repetitionPenalty?: number;
  /** Override frequency_penalty for structured calls (default 0.1). */
  frequencyPenalty?: number;
  /** presence_penalty for structured calls. Default 0 (logit processors can
   *  conflict with guided decoding). Qwen's recommended loop control for
   *  structured output is 1.5 — set per model after ablation. */
  presencePenalty?: number;
  /** top_p for structured calls; unset keeps the request-builder value. */
  topP?: number;
  /** top_k for structured calls; unset keeps the request-builder value. */
  topK?: number;
}

/** Resolve effective structured-output config from defaults + optional override. */
export function resolveStructuredConfig(
  override?: StructuredOutputConfig,
): { maxTokens: number; temperature: number; maxRetries: number; repetitionPenalty: number; frequencyPenalty: number } {
  return {
    maxTokens: override?.maxTokens ?? STRUCTURED_OUTPUT_DEFAULTS.maxTokens,
    temperature: override?.temperature ?? STRUCTURED_OUTPUT_DEFAULTS.temperature,
    maxRetries: override?.maxRetries ?? STRUCTURED_OUTPUT_DEFAULTS.maxRetries,
    repetitionPenalty: override?.repetitionPenalty ?? STRUCTURED_OUTPUT_DEFAULTS.repetitionPenalty,
    frequencyPenalty: override?.frequencyPenalty ?? STRUCTURED_OUTPUT_DEFAULTS.frequencyPenalty,
  };
}
