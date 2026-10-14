/**
 * Model-name → default JSON-schema transport registry.
 *
 * WHY: different model families are served by vLLM backends with different
 * structured-output transports. Gemma4 accepts the OpenAI-standard
 * `response_format`; Qwen3 backends reject `response_format` and instead use
 * `structured_outputs` (extra_body.structured_outputs.json). Rather than rely
 * on the `"auto"` probe (a network round-trip, can transiently fail) or
 * scatter `jsonSchemaMode` on every model entry, this registry maps a model
 * name to its known-good transport. Resolution precedence lives in
 * `getModel()`: explicit `ModelConfig.jsonSchemaMode` wins, then this
 * registry, then `"auto"` (probe).
 *
 * Pure, isomorphic, no I/O — fully unit-testable.
 */

// REFACTOR(dry): same string-literal union as `JsonSchemaTransport`
// (src/lib/json-schema-probe.ts:23) minus "none" — the two can drift (e.g. a
// new transport added to the probe but not to these defaults). Define one as
// `Exclude<JsonSchemaTransport, "none">` or share a common source.
export type JsonSchemaModeDefault =
  | "auto"
  | "response_format"
  | "structured_outputs"
  | "json_object"
  | "legacy_guided_json";

/**
 * Ordered list of [pattern, mode]. First case-insensitive substring match
 * wins. Patterns are intentionally coarse family prefixes so they cover all
 * variants (e.g. `qwen3` matches `Qwen3.8-27B-FP8`, `Qwen3.6-35B-...`).
 *
 * To add a family: append `{ pattern, mode }` here. Confirmed against the
 * deployed backends by test/e2e-plugin-schema-mode-live.test.ts.
 */
const DEFAULTS: ReadonlyArray<{ pattern: string; mode: JsonSchemaModeDefault }> = [
  // Gemma backends (gemma4 / gemma-4-...) accept the OpenAI-standard
  // response_format transport. Pattern is the family prefix so it matches
  // both the config name ("gemma4-...") and the repo id ("gemma-4-...").
  { pattern: "gemma", mode: "response_format" },
  // Qwen3 backends: use structured_outputs mode when the model supports it.
  // This provides grammar-constrained JSON output with schema enforcement.
  { pattern: "qwen3", mode: "structured_outputs" },
];

/**
 * Resolve the default JSON-schema transport for a model by its name.
 * Returns `"auto"` (probe) when no family pattern matches.
 */
export function defaultJsonSchemaModeForModel(modelName: string): JsonSchemaModeDefault {
  const name = (modelName ?? "").toLowerCase();
  for (const { pattern, mode } of DEFAULTS) {
    if (name.includes(pattern.toLowerCase())) return mode;
  }
  return "auto";
}
