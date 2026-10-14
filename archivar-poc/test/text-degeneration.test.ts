import { describe, it, expect } from "vitest";
import { countAtypicalSymbols, hasAtypicalSymbols, DEFAULT_ATYPICAL_SYMBOL_THRESHOLD } from "../src/lib/text-degeneration.js";

/**
 * Unit tests for the cheap caption-degeneration guard: characters outside the
 * typical latin-language printable ranges are the retry signal (one cooler
 * retry in WorkflowEngine.callModelForSegment).
 */
describe("countAtypicalSymbols / hasAtypicalSymbols", () => {
  it("accepts normal German caption text with typographic punctuation", () => {
    const text =
      "# Bildbeschreibung\nDie Szene zeigt eine ältere Frau im Sessel — gedämpftes Licht, „Das Erste“-Overlay, Preis 69,98 €, one™ Logo…\n" +
      "| rhetoric | calm, sadness | 0.85 |";
    expect(countAtypicalSymbols(text)).toBe(0);
    expect(hasAtypicalSymbols(text)).toBe(false);
  });

  it("accepts French/Spanish latin diacritics", () => {
    expect(countAtypicalSymbols("àâäçéèêëîïôöùûü ñ ¿ ¡ å ø")).toBe(0);
  });

  it("counts CJK ideographs as atypical", () => {
    const text = "Die Szene zeigt 漢字仮名交じり文 und sonst nichts.";
    expect(countAtypicalSymbols(text)).toBe(8);
    expect(hasAtypicalSymbols(text)).toBe(true);
  });

  it("counts emoji and symbol soup as atypical", () => {
    expect(hasAtypicalSymbols("🔥🔥🔥 caption")).toBe(true);
    expect(hasAtypicalSymbols("╭─╮ box │ drawing")).toBe(true);
  });

  it("respects the threshold: fewer than 3 atypical chars pass", () => {
    expect(hasAtypicalSymbols("Ein 漢字 hier")).toBe(false); // 2 < 3
    expect(hasAtypicalSymbols("Ein 漢字 hier", 2)).toBe(true); // explicit threshold
    expect(DEFAULT_ATYPICAL_SYMBOL_THRESHOLD).toBe(3);
  });

  it("treats empty and pure-ASCII text as clean", () => {
    expect(countAtypicalSymbols("")).toBe(0);
    expect(hasAtypicalSymbols("plain ASCII caption 123 !?")).toBe(false);
  });
});
