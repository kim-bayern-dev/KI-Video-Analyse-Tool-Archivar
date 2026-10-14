/**
 * Typed errors for the native JSON-schema-mode feature.
 *
 * WHY: These let callers distinguish "backend rejected structured-output
 * transport" (operator/config issue, fail-fast path) and "output was
 * truncated at max_tokens" (retryable with a larger cap) from generic
 * MLLM errors, so the retry loop and probe can react precisely.
 */

/** The endpoint/model rejected the requested structured-output transport. */
export class JsonSchemaUnsupportedError extends Error {
  constructor(
    public endpoint: string,
    public transport: string,
    message: string,
  ) {
    super(message);
    this.name = "JsonSchemaUnsupportedError";
  }
}

/**
 * Constrained decoding produced valid-prefix JSON that was cut off at
 * max_tokens. Retrying with a higher max_tokens is the correct response;
 * running the loose parser on truncated output would yield broken objects.
 */
export class TruncatedStructuredOutputError extends Error {
  constructor(
    public maxTokens?: number,
    message?: string,
  ) {
    super(message ?? `Constrained JSON truncated at max_tokens=${maxTokens ?? "?"}`);
    this.name = "TruncatedStructuredOutputError";
  }
}

/**
 * Thrown by the Yup→JSON Schema converter when it encounters a Yup node it
 * does not support (e.g. `mixed()`, or an array without `.of()`). Fail-fast
 * by design so unsupported schemas are surfaced explicitly rather than
 * silently coerced.
 */
export class UnsupportedYupNodeError extends Error {
  constructor(
    public nodeType: string,
    message?: string,
  ) {
    super(message ?? `Unsupported Yup node: "${nodeType}"`);
    this.name = "UnsupportedYupNodeError";
  }
}
