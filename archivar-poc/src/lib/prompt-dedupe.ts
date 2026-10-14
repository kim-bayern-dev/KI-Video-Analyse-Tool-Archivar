/**
 * Deterministic prompt dedup (Stage 0 of the oversized-prompt strategy).
 * Slice analyses repeat artifact tables/captions heavily (measured: 73% exact
 * duplicate lines in a 49-slice aggregation prompt). Removes ONLY exact
 * duplicates while keeping structure intact:
 * - keeps `#` headers and `Schnitt N (Index i):` markers,
 * - dedupes table DATA rows globally; a table is kept (header + separator)
 *   only while at least one of its data rows survives — fully duplicated
 *   tables vanish entirely (no dangling empty tables),
 * - drops every later exact repetition of any other content line,
 * - collapses consecutive blank lines.
 * A deduplicated line keeps its first occurrence and carries its multiplicity
 * as a " (xN)" suffix — the frequency signal (e.g. temporal stability of
 * visual artifacts) survives dedup; for table data rows the suffix sits
 * after the closing pipe so no cell content is corrupted. When anything was
 * deduplicated, DEDUP_NOTE is prepended once as a legend. Idempotent.
 */

/**
 * Prepended (once) to dedupePromptText's output whenever at least one line
 * was deduplicated, so the model reads the " (xN)" multiplicity markers as
 * dedup metadata instead of content (e.g. as part of an artifact name).
 */
export const DEDUP_NOTE =
  "Hinweis: Mit (xN) markierte Zeilen kamen N-mal im Original vor und wurden dedupliziert.";

/**
 * Removes " (x1)" line-suffix markers. dedupePromptText only ever emits
 * " (xN)" for N ≥ 2 — a singleton marker carries no information — but models
 * imitate the convention and tag singletons in their output. Stripped at the
 * model-output ingress points and inside dedupePromptText, where a leftover
 * " (x1)" would otherwise break exact-duplicate matching.
 */
export function stripSingletonMarkers(text: string): string {
  return text.replace(/ \(x1\)$/gm, "");
}

/**
 * stripSingletonMarkers applied to every string in a parsed JSON value
 * (recursively into objects/arrays). Needed for compact-JSON model responses:
 * their string values carry escaped "\n" sequences on the wire, so a line-end
 * regex can only see the real line breaks after parsing.
 */
export function stripSingletonMarkersDeep<T>(value: T): T {
  if (typeof value === "string") return stripSingletonMarkers(value) as T;
  if (Array.isArray(value)) return value.map((v) => stripSingletonMarkersDeep(v)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, stripSingletonMarkersDeep(v)]),
    ) as T;
  }
  return value;
}

/** Deterministic exact-duplicate line removal with multiplicity markers. */
export function dedupePromptText(text: string): string {
  const lines = stripSingletonMarkers(text).split("\n");
  const isSeparator = (l: string) => /^\|[\s:|-]+\|$/.test(l.trim());
  // Counts per non-blank trimmed line: the surviving first occurrence carries
  // its multiplicity as " (xN)".
  const counts = new Map<string, number>();
  for (const line of lines) {
    const t = line.trim();
    if (t !== "") counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  let lastWasBlank = false;
  let deduped = false;
  const marked = (line: string, t: string): string => {
    const n = counts.get(t) ?? 1;
    if (n <= 1) return line;
    deduped = true;
    return `${line} (x${n})`;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    if (t === "") {
      if (!lastWasBlank) out.push(line);
      lastWasBlank = true;
      i++;
      continue;
    }
    lastWasBlank = false;
    // Table block: `| ... |` header row directly followed by a separator row.
    if (t.startsWith("|") && i + 1 < lines.length && isSeparator(lines[i + 1])) {
      const header = [line, lines[i + 1]];
      i += 2;
      const dataRows: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        const rt = lines[i].trim();
        if (!seen.has(rt)) {
          seen.add(rt);
          dataRows.push(marked(lines[i], rt));
        }
        i++;
      }
      if (dataRows.length > 0) out.push(...header, ...dataRows);
      continue;
    }
    // Structural lines are exempt from dedup. Beyond headers, `Schnitt N`
    // markers and table separators this includes lines made purely of JSON
    // structure characters (`{`, `}`, `[`, `]`, `,`): format examples inside
    // prompt templates legitimately repeat `  }` etc., and marking them with
    // "(xN)" has made models duplicate JSON objects verbatim (DGX Spark
    // incident, 2026-10: "MLLM response could not be parsed as JSON").
    const structural = t.startsWith("#")
      || /^Schnitt \d+ \(Index \d+\):/.test(t)
      || isSeparator(line)
      || /^[{}\[\],]+$/.test(t);
    if (structural) {
      out.push(line);
    } else if (!seen.has(t)) {
      seen.add(t);
      out.push(marked(line, t));
    } else {
      deduped = true;
    }
    i++;
  }
  const body = out.join("\n");
  return deduped ? `${DEDUP_NOTE}\n\n${body}` : body;
}
