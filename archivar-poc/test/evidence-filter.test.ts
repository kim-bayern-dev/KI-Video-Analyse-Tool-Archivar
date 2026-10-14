/**
 * Unit tests for filterUnifiedSummaryAgainstEvidence (plugins/default.ts).
 *
 * Deterministic guard against unevidenced named entities / years in
 * title/keywords/short_description (A1 case 2026-09-04: "Chaos Lumination
 * Camp 2015" in title while long summaries were fine). A keyword survives via
 * an artifact-table mention or ≥2 prose sightings; a year only via an
 * artifact-table mention.
 */
import { describe, it, expect } from "vitest";
import { filterUnifiedSummaryAgainstEvidence } from "../plugins/default.js";

const HOA_TEXT = `
HOA 1 prose mentions Chaos Computer Club once here.

# Visuelle Artefakte
| Artefakt | Bildbeschreibung | Confidence | Temporale Stabilität |
| --- | --- | --- | --- |
| Chaos Computer Club Logo | Weißes Logo | 95% | 3 |
| Camp 2023 Overlay | Titelsequenz | 98% | 2 |

# Erwartete Menschliche Wahrnehmung
| Kategorie | Schlüsselwörter | Confidence |

HOA 2 prose mentions Chaos Computer Club a second time. Hacking appears. Hacking again.
`;

describe("filterUnifiedSummaryAgainstEvidence", () => {
  it("keeps keywords evidenced via artifact table", () => {
    const result = filterUnifiedSummaryAgainstEvidence(
      { title: "Dokumentation", keywords: ["Chaos Computer Club Logo"] },
      HOA_TEXT,
    );
    expect(result.keywords).toEqual(["Chaos Computer Club Logo"]);
    expect(result.evidenceFilter).toBeUndefined();
  });

  it("keeps keywords with at least two prose sightings", () => {
    const result = filterUnifiedSummaryAgainstEvidence(
      { title: "Dokumentation", keywords: ["Hacking"] },
      HOA_TEXT,
    );
    expect(result.keywords).toEqual(["Hacking"]);
  });

  it("removes keywords with only a single prose sighting (variant-misread guard)", () => {
    const result = filterUnifiedSummaryAgainstEvidence(
      { title: "Dokumentation", keywords: ["Cairo Luminoration Camp", "Hacking"] },
      HOA_TEXT,
    );
    expect(result.keywords).toEqual(["Hacking"]);
    expect(result.evidenceFilter).toEqual({
      removedKeywords: ["Cairo Luminoration Camp"],
      removedYears: [],
    });
  });

  it("keeps years that appear in an artifact table", () => {
    const result = filterUnifiedSummaryAgainstEvidence(
      { title: "Camp 2023 Rückblick", short_description: "Das Camp 2023 im Rückblick." },
      HOA_TEXT,
    );
    expect(result.title).toBe("Camp 2023 Rückblick");
    expect(result.short_description).toBe("Das Camp 2023 im Rückblick.");
  });

  it("strips unevidenced years from title and short_description", () => {
    const result = filterUnifiedSummaryAgainstEvidence(
      { title: "Chaos Camp 2025", short_description: "Bericht aus dem Jahr 2015.", keywords: ["Hacking"] },
      HOA_TEXT,
    );
    expect(result.title).toBe("Chaos Camp");
    expect(result.short_description).toBe("Bericht aus dem Jahr.");
    expect(result.evidenceFilter).toEqual({
      removedKeywords: [],
      removedYears: ["2025", "2015"],
    });
  });

  it("does not touch long free-text fields", () => {
    const longSummary = "1996 begann alles mit dem Cairo Luminoration Camp.";
    const result = filterUnifiedSummaryAgainstEvidence(
      { title: "Dokumentation", long_summary: longSummary },
      HOA_TEXT,
    );
    expect(result.long_summary).toBe(longSummary);
  });

  it("treats single-sighting table rows (Temporale Stabilität < 2) as weak evidence", () => {
    const hoaWithWeakRow = `
# Visuelle Artefakte
| Artefakt | Bildbeschreibung | Confidence | Temporale Stabilität |
| --- | --- | --- | --- |
| Camp 2025 Overlay | Einmalig | 90% | 1 |
`;
    const result = filterUnifiedSummaryAgainstEvidence(
      { title: "Camp 2025 Special", keywords: ["Camp 2025 Overlay"] },
      hoaWithWeakRow,
    );
    expect(result.title).toBe("Camp Special");
    expect(result.keywords).toEqual([]);
    expect(result.evidenceFilter).toEqual({
      removedKeywords: ["Camp 2025 Overlay"],
      removedYears: ["2025"],
    });
  });
});
