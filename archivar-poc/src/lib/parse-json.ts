/**
 * Consolidated, tolerant JSON extractor for LLM responses.
 *
 * WHY: Archivar's decoding is unconstrained when no JSON-schema transport is
 * active, so the model can emit prose, markdown fences, or partial JSON. Three
 * near-identical extractors existed (MllmApi.extractAndParseJson, plugin-api
 * parseJsonLoose, and a summary-stage parser since removed) with subtly
 * divergent fallback behavior. This is the single source of truth; the
 * surviving wrappers delegate here to preserve their stable public APIs.
 *
 * Order of attempts (first success wins):
 *   1.  direct JSON.parse(trimmed)
 *   1b. parse with ``` / ```json fence prefix+suffix stripped (handles
 *       half-fenced output)
 *   2.  extract from a matched ``` fence pair embedded in prose
 *   3.  match trailing {...} (greedy to end)
 *   4.  match trailing [...] (greedy to end)
 *   5.  scan for the first balanced {...} / [...] substring (handles
 *       garbage-prefixed content the greedy trailing matches can't)
 *
 * Later attempts exist because earlier ones are stricter than real model
 * output; do not reorder without checking test/parse-json-consolidated.test.ts.
 *
 * Pure function, no I/O, isomorphic.
 */

export interface ParseJsonOptions {
  /** If true, throw on failure. If false (default), return null. */
  throwOnFail?: boolean;
}

/**
 * Extract the first balanced JSON object or array from a string.
 * Scans for the first `{` or `[`, then tracks depth (respecting string literals
 * and escape sequences) until depth returns to 0. Returns null if no balanced
 * JSON is found.
 */
function extractFirstBalancedJson(content: string): string | null {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === '{' || ch === '[') {
      if (start === -1) {
        start = i;
        depth = 1;
      } else {
        depth++;
      }
    } else if ((ch === '}' && depth > 0) || (ch === ']' && depth > 0)) {
      depth--;
      if (depth === 0) {
        return content.slice(start, i + 1);
      }
    }
  }

  return null;
}

/**
 * Parse JSON tolerantly from a model response string.
 * Returns the parsed value, or null when nothing parses (unless throwOnFail).
 */
export function parseJsonLoose(
  content: string,
  opts?: ParseJsonOptions,
): unknown {
  if (!content || typeof content !== "string") {
    if (opts?.throwOnFail) {
      throw new Error("parseJsonLoose: content is empty or not a string");
    }
    return null;
  }

  const trimmed = content.trim();

  // 1. Direct parse
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }

  // 1b. Strip markdown fence wrappers (```json … ``` or ``` … ```).
  // Handles BOTH fully-fenced and half-fenced (no closing ```) responses:
  // models sometimes emit only the opening ```json fence, or add a trailing
  // ``` without a matching opener. Stripping prefix/suffix independently is
  // strictly more tolerant than requiring a matching pair.
  const fenceStripped = trimmed
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();
  if (fenceStripped !== trimmed) {
    try {
      return JSON.parse(fenceStripped);
    } catch {
      // fall through
    }
  }

  // 2. Markdown code fence (```json ... ``` or ``` ... ```) — full regex match
  // for embedded fences surrounded by prose (e.g. "Here is the result:\n```json … ```")
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {
      // fall through
    }
  }

  // 3. Trailing object {...} (greedy to end)
  const braceMatch = trimmed.match(/\{[\s\S]*\}$/);
  if (braceMatch) {
    try {
      return JSON.parse(braceMatch[0]);
    } catch {
      // fall through
    }
  }

  // 4. Trailing array [...] (greedy to end)
  const bracketMatch = trimmed.match(/\[[\s\S]*\]$/);
  if (bracketMatch) {
    try {
      return JSON.parse(bracketMatch[0]);
    } catch {
      // fall through
    }
  }

  // 5. First balanced JSON object/array — scan for first { or [, track depth,
  // extract first balanced substring. Handles garbage-prefixed or garbage-suffixed
  // content like ```json\n{...garbage}\n...\n``` where the first {...} is valid.
  const firstJson = extractFirstBalancedJson(trimmed);
  if (firstJson !== null) {
    try {
      return JSON.parse(firstJson);
    } catch {
      // fall through
    }
  }

  // REFACTOR(consistency): both failure paths embed the full raw `trimmed`
  // content unbounded — LLM responses can be tens of KB, which floods logs and
  // error messages — truncate to the first few hundred chars for actionable
  // output (the throw message below and the console.error share the issue).
  if (opts?.throwOnFail) {
    throw new Error(
      `parseJsonLoose: could not parse JSON from content: ${trimmed}`,
    );
  }

  console.error(
    "[parseJsonLoose] Could not parse JSON from content:",
    trimmed,
  );
  return null;
}
