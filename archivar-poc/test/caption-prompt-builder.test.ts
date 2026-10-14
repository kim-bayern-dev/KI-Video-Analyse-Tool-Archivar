/**
 * Unit tests for the context-aware captioning prompt builder.
 *
 * Verifies that buildContextAwarePrompt correctly substitutes placeholders from
 * the external template file (caption-prompt-template.md) with audio context
 * and previous scene caption data.
 */
import { describe, it, expect } from "vitest";
import { buildContextAwarePrompt, needsContextAwarePrompt, type AudioContext } from "../src/lib/caption-prompt-builder.js";

describe("caption-prompt-builder — context-aware prompt generation", () => {
  it("CP1: full context — speech, noise, harmonic, and previous caption all substituted", () => {
    const audioCtx: AudioContext = {
      speechTranscript: "Willkommen zur Nachrichten.",
      noiseCaptions: ["Straßenlärm", "Sirene in der Ferne"],
      harmonicCaptions: ["Klaviermelodie"],
    };

    const prompt = buildContextAwarePrompt(
      "Beschreibe das Video detailliert auf Deutsch.",
      audioCtx,
      "# Bildbeschreibung\nVorherige Szene zeigt eine Innenstadt bei Tag.",
    );

    expect(prompt).toContain("Willkommen zur Nachrichten.");
    expect(prompt).toContain("Straßenlärm");
    expect(prompt).toContain("Sirene in der Ferne");
    expect(prompt).toContain("Klaviermelodie");
    expect(prompt).toContain("Vorherige Szene zeigt eine Innenstadt bei Tag.");
    // Should contain the Markdown output format instructions
    expect(prompt).toContain("# Bildbeschreibung");
    expect(prompt).toContain("## Beschreibung der vorherigen Szene");
    expect(prompt).toContain("# Erwartete Menschliche Wahrnehmung");
    // Should contain all 13 relationship labels
    expect(prompt).toContain("DIRECT_CONTINUATION");
    expect(prompt).toContain("NO_RELATION");
    expect(prompt).toContain("MONTAGE_RELATED");
  });

  it("CP2: no audio context — defaults are inserted", () => {
    const prompt = buildContextAwarePrompt(
      "Beschreibe das Video.",
      undefined,
      undefined,
    );

    expect(prompt).toContain("kein Sprachtranskript");
    expect(prompt).toContain("keine Umgebungsgeräusche");
    expect(prompt).toContain("keine harmonischen");
    expect(prompt).toContain("Dies ist die erste Szene");
  });

  it("CP3: empty audio context — defaults are inserted", () => {
    const audioCtx: AudioContext = {
      speechTranscript: "",
      noiseCaptions: [],
      harmonicCaptions: [],
    };

    const prompt = buildContextAwarePrompt("Describe.", audioCtx);

    expect(prompt).toContain("kein Sprachtranskript");
    expect(prompt).toContain("keine Umgebungsgeräusche");
    expect(prompt).toContain("keine harmonischen");
  });

  it("CP4: previous caption only (no audio)", () => {
    const prompt = buildContextAwarePrompt(
      "Describe.",
      undefined,
      "# Bildbeschreibung\nA man walks into a building.",
    );

    expect(prompt).toContain("A man walks into a building.");
    expect(prompt).not.toContain("Dies ist die erste Szene");
  });

  it("CP5: multiple noise captions are listed with bullet points", () => {
    const audioCtx: AudioContext = {
      speechTranscript: undefined,
      noiseCaptions: ["Traffic", "Wind", "Distant voices"],
      harmonicCaptions: [],
    };

    const prompt = buildContextAwarePrompt("Describe.", audioCtx);

    expect(prompt).toContain("- Traffic");
    expect(prompt).toContain("- Wind");
    expect(prompt).toContain("- Distant voices");
  });

  it("CP6: needsContextAwarePrompt returns true when either flag is set", () => {
    expect(needsContextAwarePrompt(true, false)).toBe(true);
    expect(needsContextAwarePrompt(false, true)).toBe(true);
    expect(needsContextAwarePrompt(true, true)).toBe(true);
  });

  it("CP7: needsContextAwarePrompt uses opt-out semantics (default true)", () => {
    // Explicitly false → disabled
    expect(needsContextAwarePrompt(false, false)).toBe(false);
    // undefined → enabled by default (opt-out)
    expect(needsContextAwarePrompt(undefined, undefined)).toBe(true);
    // Mixed: one false, one undefined → still enabled
    expect(needsContextAwarePrompt(false, undefined)).toBe(true);
    expect(needsContextAwarePrompt(undefined, false)).toBe(true);
  });

  it("CP8: base prompt is prepended to the template content", () => {
    const prompt = buildContextAwarePrompt("MEINE_SPEZIAL_ANWEISUNG");
    // Base prompt (step instruction) is prepended before the structured template
    expect(prompt.startsWith("MEINE_SPEZIAL_ANWEISUNG")).toBe(true);
  });
});
