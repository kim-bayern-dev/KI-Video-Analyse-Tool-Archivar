/**
 * Rough token estimate: ~1.3 tokens per word for European languages.
 * Used by plugins/default.ts to gate higher-order-aggregation input size —
 * a budgeting heuristic where an approximate count is good enough, so no
 * tokenizer dependency is justified (project rule: minimal deps).
 */
export function estimateTokens(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.ceil(words * 1.3);
}
