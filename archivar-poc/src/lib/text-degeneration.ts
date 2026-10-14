/**
 * Cheap text-degeneration guard for model captions.
 *
 * One observed failure mode of sampling at higher temperature is a slide into
 * non-latin symbol soup (random CJK/emoji/box-drawing/math glyphs). Normal
 * German captions need only latin scripts, general punctuation and currency
 * signs — so a count of characters outside those ranges is a cheap,
 * deterministic degeneration signal that triggers one retry at lower
 * temperature (wired in WorkflowEngine.callModelForSegment).
 */

/** Code-point ranges considered typical for latin-language printable text. */
const TYPICAL_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x09, 0x0d], // tab, LF, CR
  [0x20, 0x7e], // printable ASCII
  [0xa0, 0x024f], // Latin-1 Supplement + Latin Extended-A/B (ä ö ü ß à â ç …)
  [0x1e00, 0x1eff], // Latin Extended Additional (ọ ẹ …)
  [0x2000, 0x206f], // General Punctuation (– — „ “ ” …)
  [0x20a0, 0x20bf], // Currency Symbols (€ £ ¥)
  [0x2100, 0x214f], // Letterlike Symbols (™)
];

function isTypical(codePoint: number): boolean {
  for (const [lo, hi] of TYPICAL_RANGES) {
    if (codePoint >= lo && codePoint <= hi) return true;
  }
  return false;
}

/** Count characters outside the typical latin-language printable ranges. */
export function countAtypicalSymbols(text: string): number {
  let count = 0;
  for (const ch of text) {
    if (!isTypical(ch.codePointAt(0)!)) count++;
  }
  return count;
}

/** Default threshold: "multiple" atypical symbols. */
export const DEFAULT_ATYPICAL_SYMBOL_THRESHOLD = 3;

/** True when the text contains at least `threshold` atypical symbols. */
export function hasAtypicalSymbols(
  text: string,
  threshold: number = DEFAULT_ATYPICAL_SYMBOL_THRESHOLD,
): boolean {
  return countAtypicalSymbols(text) >= threshold;
}
