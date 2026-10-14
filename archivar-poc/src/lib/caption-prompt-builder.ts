/**
 * Audio-first, context-aware captioning prompt builder.
 *
 * Reads the external Markdown template (caption-prompt-template.md) and substitutes
 * placeholders for audio context and previous scene caption. This keeps the prompt
 * content in a file (per project convention) rather than inline in code.
 *
 * Supports dynamic section stripping when enableHumanPerceptionEvaluation or
 * enableVisualArtifactTracking are set to false (opt-out).
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = resolve(__dirname, "caption-prompt-template.md");

// Read template once at module load — fail fast if missing
let templateContent: string;
try {
  templateContent = readFileSync(TEMPLATE_PATH, "utf-8");
} catch (err) {
  throw new Error(
    `[caption-prompt-builder] Failed to load template from ${TEMPLATE_PATH}: ${err instanceof Error ? err.message : String(err)}`,
  );
}

/** Audio context for a scene's timeframe — gathered from Phase 1 results */
export interface AudioContext {
  /** Speech transcript overlapping this scene (may be empty string) */
  speechTranscript?: string;
  /** Noise/ambient sound captions overlapping this scene */
  noiseCaptions: string[];
  /** Harmonic/musical sound captions overlapping this scene */
  harmonicCaptions: string[];
}

/** Options for dynamic prompt section control */
// NOTE: section names below refer to the German headings actually used in
// caption-prompt-template.md ("# Bezug zur vorherigen Szene", "# Erwartete
// Menschliche Wahrnehmung", "# Visuelle Artefakte").
export interface PromptOptions {
  /** When false, strips the # Erwartete Menschliche Wahrnehmung (Human
   *  Perception Matrix) and # Bezug zur vorherigen Szene (Relationship)
   *  sections. Default: true (opt-out) */
  enableHumanPerception?: boolean;
  /** When false, strips the # Visuelle Artefakte section.
   *  Default: true (opt-out) */
  enableVisualArtifacts?: boolean;
}

/**
 * Build a context-aware captioning prompt by substituting placeholders in the
 * external template. When no audio context or previous caption is available,
 * sensible defaults are inserted.
 *
 * Dynamic sections are stripped based on options:
 * - enableHumanPerception=false → removes Relationship + Perception Matrix
 * - enableVisualArtifacts=false → removes Visuelle Artefakte section
 */
export function buildContextAwarePrompt(
  basePrompt: string,
  audioContext?: AudioContext,
  previousCaption?: string,
  options?: PromptOptions,
): string {
  const speechText = audioContext?.speechTranscript?.trim() || "(kein Sprachtranskript verfügbar)";
  const noiseText = audioContext?.noiseCaptions.length
    ? audioContext.noiseCaptions.map((n) => `- ${n}`).join("\n")
    : "(keine Umgebungsgeräusche klassifiziert)";
  const harmonicText = audioContext?.harmonicCaptions.length
    ? audioContext.harmonicCaptions.map((h) => `- ${h}`).join("\n")
    : "(keine harmonischen/musikalischen Klänge klassifiziert)";
  const prevText = previousCaption?.trim() || "(Dies ist die erste Szene — keine vorherige Szene vorhanden.)";

  let prompt = `${basePrompt}\n\n${templateContent}`
    .replace(/{{AUDIO_SPEECH}}/g, speechText)
    .replace(/{{AUDIO_NOISE}}/g, noiseText)
    .replace(/{{AUDIO_HARMONIC}}/g, harmonicText)
    .replace(/{{PREVIOUS_CAPTION}}/g, prevText);

  // Dynamic section stripping (opt-out)
  // REFACTOR(magic): these heading literals are hard-coupled to
  // caption-prompt-template.md and drift silently — a third spelling of the
  // same headings lives in AGGREGATED_TABLE_HEADING (src/lib/result-view.ts:22)
  // and a fourth in plugins/default.ts:626. A heading renamed in the template
  // breaks every strip/check without any compile error; consider exporting the
  // heading constants from one module (or asserting them against the loaded
  // template at startup).
  const enablePerception = options?.enableHumanPerception !== false;
  const enableArtifacts = options?.enableVisualArtifacts !== false;

  if (!enablePerception) {
    // REFACTOR(typo): "# Beziehung zur vorherigen Szene" never matches — the
    // template heading is "# Bezug zur vorherigen Szene"
    // (caption-prompt-template.md:24) — so this strip silently no-ops and the
    // Relationship section is sent even when enableHumanPerception=false.
    // The same "# Beziehung" misspelling appears in plugins/default.ts:626
    // (out of scope here, but the model-facing check there never matches the
    // template-instructed heading either).
    // Strip # Relationship With Previous Scene section
    prompt = prompt.replace(/# Beziehung zur vorherigen Szene[\s\S]*?(?=\n# |$)/, "");
    // Strip # Human Perception Matrix section
    prompt = prompt.replace(/# Erwartete Menschliche Wahrnehmung[\s\S]*?(?=\n# |$)/, "");
  }

  if (!enableArtifacts) {
    // Strip # Visuelle Artefakte section
    prompt = prompt.replace(/# Visuelle Artefakte[\s\S]*?(?=\n# |$)/, "");
  }

  return prompt.trim();
}

/**
 * Check whether a step should use context-aware captioning.
 * Uses opt-out semantics: returns true unless BOTH flags are explicitly false.
 * Default: true (opt-out — context-aware is the default behavior)
 */
export function needsContextAwarePrompt(
  includeAudioContext: boolean | undefined,
  includePreviousCaption: boolean | undefined,
): boolean {
  // Opt-out: enabled unless explicitly disabled
  return includeAudioContext !== false || includePreviousCaption !== false;
}
