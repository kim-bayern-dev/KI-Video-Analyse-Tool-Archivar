/**
 * Default post-processing plugin.
 *
 * Implements the full lifecycle:
 * 1. postProcessPerTimeSlice — analyze each scene slice with a VLM; speech slices stored as-is
 * 2. decideForAggregation — group adjacent slices by semantic similarity (with transcript context)
 * 3. postProcessPerAggregation — unify per-slice analysis into one aggregation analysis (with transcripts)
 * 4. summaryForAggregation — optional per-aggregation summary
 * 5. enrichAggregationTransitions — reliable boundary transitions between adjacent
 *    aggregations (text-only pair calls, after analyses are final)
 * 6. summaryFromAggregations / summaryFromTimeSlices — whole-video summary
 *
 * Transcript-aware aggregation is enabled via config.includeTypes: ["scene", "speech"]
 * When "speech" is present, speech transcripts are injected into aggregation prompts.
 */

import * as yup from "yup";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  PluginRpcApiCompositeInstance,
  PluginDefinition,
  PostProcessingInput,
  TimeSlice,
  SemanticAggregation,
  SemanticAggregationPatch,
  SemanticProfileWithRelationships,
  JsonValue,
  PostProcessingPluginDefinition,
  SemanticAggregations,
  HigherOrderAggregation,
  HigherOrderAggregations,
  VisualArtifact,
  PerceptionMatrix,
} from "../src/lib/types.js";
import { getModel, resolveMaxInferenceContext, resolveEstimation } from "../src/lib/archivar-config.js";
import { budgetCapForModel, MIN_OUTPUT_TOKENS } from "../src/lib/input-estimation.js";
import { enforceMinGroupSize } from "../src/lib/aggregation-constraints.js";
import { dedupePromptText, DEDUP_NOTE } from "../src/lib/prompt-dedupe.js";
import { estimateTokens } from "../src/lib/token-estimate.js";

// defaults
const DEFAULT_VLM_MODEL = "Qwen3.8-27B-FP8";
const DEFAULT_MAX_CONCURRENCY = 2;
// Bump when prompts/logic change; folded into the aggregated cache key.
// "4": optional detail fields in sliceAnalysisSchema, prompt dedup with (xN)
// markers, percentage-string confidence spec, truncation-ladder fix.
// FROZEN at "4" — do not bump, do not remove. Cache
// invalidation after prompt/logic changes is done explicitly via clear-cache;
// automatic version-based invalidation is unwanted (a bump orphans every
// existing aggregated entry). The value is part of existing cache keys, and a
// missing export would count as "1" — changing the key either way.
export const POST_PROCESSING_CACHE_VERSION = "4";
const DEFAULT_POST_PROCESSING_INCLUDE_TYPES = ["scene", "speech"];
// Minimum duration (seconds) for VLM analysis. Scenes shorter than this cannot
// provide enough frames for reliable visual analysis. Matches the filter used
// during captioning (workflow-engine.ts MIN_DURATION_SEC).
const MIN_SCENE_DURATION_SEC = 1.0;

/**
 * The 13 relationship labels used to classify how a scene/aggregation relates
 * to the previous one. Mirrors the labels defined in caption-prompt-template.md
 * so aggregation analysis and captioning share a single vocabulary.
 *
 * Exported for reuse by the higher-order aggregation boundary detection.
 */
export const RELATIONSHIP_LABELS = [
  "DIRECT_CONTINUATION",
  "ELABORATION",
  "EXAMPLE_OF_PREVIOUS",
  "CONSEQUENCE_OR_RESULT",
  "CONTRAST_OR_COUNTERPOINT",
  "REACTION_TO_PREVIOUS",
  "SAME_TOPIC_NEW_ASPECT",
  "MONTAGE_RELATED",
  "TRANSITION_BRIDGE",
  "TONAL_SHIFT_SAME_TOPIC",
  "NEW_TOPIC_SOFT_DRIFT",
  "NEW_TOPIC_HARD_DRIFT",
  "NO_RELATION",
] as const;

/**
 * Yup schema fragment for a single visual artifact row. Shared by the
 * per-slice analysis, the aggregation analysis, and the higher-order
 * aggregation analysis so the structure stays consistent across all layers.
 *
 * The child fields are intentionally NOT marked .required(): in yup 1.x an
 * optional object schema still validates its .required() children against an
 * implicit value, which both breaks validation and materialises spurious `{}`
 * defaults for absent fields. Lenient children keep validation passing and the
 * output clean (absent stays absent) while still constraining types/ranges.
 */
export const visualArtifactSchema = yup.object({
  artifact: yup.string(),
  exact_caption: yup.string(),
  // Confidence as plain string, no format validation. Prompts demand a
  // percentage string ("95%") everywhere; older/looser models may still emit
  // 0..1 floats — both pass. Normalized to 0..1 by parseConfidence() where
  // a number is needed (merge/max); otherwise passed through verbatim.
  confidence: yup.string(),
  // Number of times this artifact has been observed across scenes/aggregations.
  // The model accumulates this when it merges a "# Visuelle Artefakte" table from
  // the constituent scenes; we never regex-parse the caption for it.
  temporal_stability: yup.number().min(0),
}).stripUnknown();

/** Schema for per-slice VLM analysis output (exported for tooling/e2e tests). */
export const sliceAnalysisSchema = yup.object({
  summary: yup.string().required(),
  setting: yup.string().required(),
  scene_type: yup.string().oneOf([
    "intro", "outro", "lead-in", "anchor-lead", "ad", "teaser",
    "interview", "regional-news", "national-news", "global-news",
    "opener", "closer", "social-spot", "spot", "trailer",
    "lead-out", "sponsor-ad",
  ]).required(),
  // timeline/subjects/camera_motion are optional detail fields: aggregation
  // calls merge pre-captioned text (no media), so the model legitimately may
  // not know them. yup .required() also rejects empty strings — weaker models
  // emit "" when unsure, which previously exhausted the validation retries.
  // Children stay lenient for the same yup 1.x reason as visualArtifactSchema.
  timeline: yup.array().of(yup.object({
    time: yup.string(),
    event: yup.string(),
  })),
  subjects: yup.array().of(yup.object({
    type: yup.string(),
    appearance: yup.string(),
    actions: yup.array().of(yup.object({
      time: yup.string(),
      desc: yup.string(),
    })),
  })),
  camera_motion: yup.string(),
  text_visible: yup.array().of(yup.string().required()).required(),
  uncertainties: yup.array().of(yup.string().required()).required(),
  // Optional: how this slice relates to the previous one. Only meaningful for
  // cross-scene comparisons; absent for the first slice in a run.
  relationship_to_previous: yup.string().oneOf([...RELATIONSHIP_LABELS]).optional(),
  // Optional: perception matrix (rhetoric/framing/emotion) for long-horizon
  // intention detection. Shapeless object so yup neither strips nor materialises
  // spurious `{}` entries — whatever the model emits passes through verbatim.
  perception_matrix: yup.object().optional(),
  // Optional: significant visual artifacts (logos, text overlays, dates).
  // Populated when enableVisualArtifactTracking is on. temporal_stability is
  // seeded per-scene and accumulated during aggregation.
  visual_artifacts: yup.array().of(visualArtifactSchema).optional(),
}).stripUnknown();

/** Schema for aggregation decision (exported for tooling/e2e tests). */
export const aggregationDecisionSchema = yup.object({
  same_contribution: yup.boolean().required(),
  reason: yup.string().required(),
}).stripUnknown();

/** Schema for whole-video summary (exported for tooling/e2e tests). */
export const wholeSummarySchema = yup.object({
  title: yup.string().required(),
  keywords: yup.array().of(yup.string().required()).required(),
  short_description: yup.string().required(),
  long_summary: yup.string().required(),
}).stripUnknown();

/** Prompt for per-slice VLM analysis (exported for tooling/e2e tests). */
export const DEFAULT_SLICE_ANALYSIS_PROMPT = `Du bist eine visuelle Analyse-Engine. Analysiere nur das, was im Video sichtbar ist. Vermute keine verborgenen Ursachen, Identitäten, Emotionen, Standorte, Marken, Alter oder Absichten, es sei denn sie sind eindeutig sichtbar. Falls unsicher, sage "unsicher". Beschreibe die Szene auf Deutsch.

Gib direkt gültiges JSON in folgendem Format ohne JSON-Fences zurück. Gib kompaktes JSON ohne Whitespace-Blöcke zurück:
{
  "summary": "ein-saetzige Gesamtbeschreibung",
  "setting": "wo und wann das Video spielt",
  "scene_type": "intro|outro|lead-in|anchor-lead|ad|teaser|interview|regional-news|national-news|global-news|opener|closer|social-spot|spot|trailer|lead-out|sponsor-ad",
  "timeline": [{ "time": "00:34:20", "event": "was sichtbar passiert" }],
  "subjects": [{ "type": "person|object|animal|brand", "appearance": "sichtbare Attribute", "actions": [{ "time": "00:34:20", "desc": "sichtbare Aktionen" }] }],
  "camera_motion": "static|panning|zooming|handheld|etc",
  "text_visible": ["genauer sichtbarer Text, falls vorhanden"],
  "strong_uncertainties": ["zweideutige Punkte"]
}`;

/**
 * Shared rule appended to every content-generating post-processing prompt.
 * Technical errors — whether present as strings in the input or merely
 * suspected by the model from content discontinuity — are not editorial
 * content and must never influence titles, keywords, tags, summaries or
 * assessments. (Motivation: a 35B run titled a video "Fehlerhafte
 * Segmentierung" after inferring a pipeline segmentation error from hard
 * topic cuts that were actually present in the truncated source material.)
 */
const EDITORIAL_CONTENT_RULE = [
  "",
  "## Redaktioneller Fokus — technische Fehler ignorieren",
  "Rein technische Fehlermeldungen, Pipeline- oder Verarbeitungshinweise sowie Vermutungen über technische Verarbeitungsfehler (z. B. Segmentierungs-, Transkodierungs-, Aggregations- oder API-Fehler) sind KEIN redaktioneller Inhalt. Sie dürfen weder in Titel, Keywords, Tags, Zusammenfassungen, Beschreibungen noch in Bewertungen oder Begründungen vorkommen oder diese in irgendeiner Weise beeinflussen. Auch wenn das Material thematisch sprunghaft oder unzusammenhängend wirkt: beschreibe ausschließlich den tatsächlichen redaktionellen Inhalt (Themen, Personen, Orte, Ereignisse) und vermute NIEMALS technische Ursachen oder Fehler der Verarbeitung.",
].join("\n");

/** Compact variant of EDITORIAL_CONTENT_RULE for true/false decision prompts. */
const EDITORIAL_CONTENT_RULE_DECISION =
  "Technische Fehlermeldungen oder Verarbeitungshinweise in den Eingaben sind kein Inhalt — ignoriere sie bei der Entscheidung vollständig.";

/**
 * Shared fact-fidelity rule for aggregation/merge/summary prompts: quotes,
 * dates, times, names and numbers may only bubble up when they appear
 * verbatim in the inputs — never invented, completed or corrected by the
 * model. (Motivation: caption-level hallucinations propagate upward through
 * aggregation → HoA → summary if each stage is allowed to introduce new
 * "facts".)
 */
const FACT_GROUNDING_RULE = [
  "",
  "## Fakten-Treue — nur Belegtes weiterreichen",
  "Zitate, Datumsangaben, Uhrzeiten, Eigennamen und Zahlen dürfen in deiner Ausgabe NUR vorkommen, wenn sie wörtlich in den Eingaben enthalten sind. Reiche nur solche Angaben weiter, die für den Beitrag wichtig erscheinen. Erfinde, ergänze oder korrigiere NIEMALS solche Angaben — im Zweifel weglassen.",
].join("\n");

/** Prompt for aggregation decision (exported for tooling/e2e tests). */
export const DECISION_PROMPT = `Du vergleichst zwei Video-Schnitte. Entscheide strikt, ob sie zum selben Beitrag (derselben Story/demselben Thema) gehoeren.

KRITERIEN fuer "true" (selber Beitrag):
- Gleiches Thema, gleiche Story, gleiche Reportage
- Fortsetzung desselben Interviews oder Berichts
- Gleiche Personen, Orte, Ereignisse, die in direktem Zusammenhang stehen
- Visuell und inhaltlich sehr aehnlich, so dass sie wahrscheinlich vom selben Beitrag stammen

KRITERIEN fuer "false" (unterschiedliche Beitrage):
- Nur gleiches Studio, gleicher Moderator, gleicher Sendungsstil oder gleiche Location reicht NICHT aus
- Werbung/Sponsorenblock
- Unterschiedliche Themen oder Berichte
- Starke Unsicherheit? -> false

Schnitt 1: {{SLICE1_SUMMARY}}
Schnitt 2: {{SLICE2_SUMMARY}}

Gib direkt gültiges JSON in folgendem Format ohne JSON-Fences zurück. Gib kompaktes JSON ohne Whitespace-Blöcke zurück:
{
  "same_contribution": true|false,
  "reason": "kurze Begründung"
}

` + EDITORIAL_CONTENT_RULE_DECISION;

/** Prompt for aggregation decision with transcript context (exported for tooling/e2e tests). */
export const DECISION_PROMPT_WITH_TRANSCRIPTS = `Du vergleichst zwei Video-Schnitte UND deren Speech-Transkripte. Entscheide strikt, ob sie zum selben Beitrag (derselben Story/demselben Thema) gehoeren. Verwende die Transkripte als hauptsächliche Informationsquelle.

KRITERIEN fuer "true" (selber Beitrag):
- Gleiches Thema, gleiche Story, gleiche Reportage
- Fortsetzung desselben Interviews oder Berichts
- Gleiche Personen, Orte, Ereignisse, die in direktem Zusammenhang stehen
- Transkripte gehoeren zumselben Sprecher oder beziehen sich auf dasselbe Thema
- Visuell und inhaltlich sehr aehnlich, so dass sie wahrscheinlich vom selben Beitrag stammen

KRITERIEN fuer "false" (unterschiedliche Beitrage):
- Nur gleiches Studio, gleicher Moderator, gleicher Sendungsstil oder gleiche Location reicht NICHT aus
- Werbung/Sponsorenblock
- Unterschiedliche Themen oder Berichte in den Transkripten
- Starke Unsicherheit? -> false

Schnitt 1: {{SLICE1_SUMMARY}}
Transkript Schnitt 1: {{SLICE1_TRANSCRIPT}}
Schnitt 2: {{SLICE2_SUMMARY}}
Transkript Schnitt 2: {{SLICE2_TRANSCRIPT}}

Gib direkt gültiges JSON in folgendem Format ohne JSON-Fences zurück. Gib kompaktes JSON ohne Whitespace-Blöcke zurück:
{
  "same_contribution": true|false,
  "reason": "kurze Begründung"
}

` + EDITORIAL_CONTENT_RULE_DECISION;

/**
 * Shared rule appended to every aggregation-analysis prompt. Instead of
 * regex-parsing the constituent scenes' "# Visuelle Artefakte" Markdown tables
 * (which is brittle because LLM Markdown structure varies), we instruct the
 * model to read those tables and (a) emit an already-accumulated
 * visual_artifacts[] array with temporal_stability = sum of appearances, and
 * (b) embed aggregated Markdown tables INSIDE the `summary` string so the
 * downstream HOA + unified-summary stages can see the aggregated perception
 * and artifact tables without re-reading the per-scene captions. Keeping the
 * tables in `summary` (not as separate fields) avoids context-window bloat
 * while preserving the structured detail.
 */
const VISUAL_ARTIFACT_ACCUMULATION_RULE = [
  "",
  "## Aggregierte Markdown-Tabellen im summary-Feld",
  "Betreffend des `summary`-Feldes: Gib ERST eine einzeilige übergeordnete Beschreibung des gesamten Beitrags. Füge DANACH — innerhalb desselben `summary`-Strings — zwei Markdown-Tabellen ein:",
  "1. Einen aggregierten `# Visuelle Artefakte`-Abschnitt: zaehle fuer jedes Artefakt aus den konstituierenden Schnitten, wie oft es vorkommt (temporal_stability = Anzahl Vorkommen), und gib eine Markdown-Tabelle mit den Spalten | Artefakt | Bildbeschreibung | Confidence | Temporale Stabilität | aus.\n\n",
  "2. Einen aggregierten `# Erwartete Menschliche Wahrnehmung`-Abschnitt: eine Markdown-Tabelle mit den Spalten | Kategorie | Schlüsselwörter | Confidence | fuer Rhetorik, Framing, Emotion, aggregiert ueber alle Schnitte.",
  "WICHTIG zum Format: Confidence ist UEBERALL (Markdown-Tabellen UND JSON-Felder) ein Prozent-String (z.B. \"95%\"), niemals eine Dezimalzahl wie 0.95 oder 1.0 — auch dann, wenn die konstituierenden Schnitte Dezimalzahlen verwenden.",
  "Diese Markdown-Tabellen MUSS im `summary`-String enthalten sein (mit \\n als Zeilenumbruch), damit nachfolgende Stufen (Higher-Order Aggregation, zusammenfassende Zusammenfassung) die aggregierten Tabellen sehen, OHNE dass die einzelnen Szenen-Beschreibungen erneut eingebettet werden muessen.",
  "",
  "## Visuelle Artefakte als JSON-Feld (zusätzlich)",
  "Wenn die konstituierenden Schnitte einen \"# Visuelle Artefakte\" Markdown-Abschnitt enthalten, zaehle fuer jedes einzelne Artefakt, wie oft es ueber alle Schnitte hinweg vorkommt. Gib das Ergebnis ZUSAETZLICH als akkumuliertes Feld aus:",
  '  "visual_artifacts": [',
  '    { "artifact": "Name", "exact_caption": "Exakter sichtbarer Text", "confidence": "95%", "temporal_stability": <Anzahl Vorkommen ueber alle Schnitte> }',
  "  ]",
  "Wenn keine Visuelle Artefakte vorhanden sind, gib ein leeres Array [] aus.",
  "",
  "## Weitere optionale Ausgabefelder",
  '"relationship_to_previous": "Eines der Labels: ' + RELATIONSHIP_LABELS.join("|") + ' — oder weglassen fuer den ersten Beitrag."',
  '"perception_matrix": { "rhetoric": { "keyword": "...", "confidence": "85%" }, "framing": { ... }, "emotion": { ... } }',
].join("\n");

/** Prompt for aggregation analysis: unify per-slice analyses into one (exported). */
export const AGGREGATION_ANALYSIS_PROMPT = `Du bist eine visuelle Analyse-Engine. Hier sind die Analysen mehrerer benachbarter Video-Schnitte, die zum selben Beitrag gehoeren. Erstelle eine einheitliche Analyse fuer den gesamten Beitrag.

Analysen der einzelnen Schnitte:
{{SLICE_ANALYSES}}

Erstelle eine einheitliche Analyse im gleichen Format.

Gib direkt gültiges JSON in folgendem Format ohne JSON-Fences zurück. Gib kompaktes JSON ohne Whitespace-Blöcke zurück:
{
  "summary": "ein-saetzige Gesamtbeschreibung des gesamten Beitrags",
  "setting": "wo und wann das Video spielt",
  "scene_type": "intro|outro|lead-in|anchor-lead|ad|teaser|interview|regional-news|national-news|global-news|opener|closer|social-spot|spot|trailer|lead-out|sponsor-ad",
  "timeline": [{ "time": "00:34:20", "event": "was sichtbar passiert" }],
  "subjects": [{ "type": "person|object|animal|brand", "appearance": "sichtbare Attribute", "actions": [{ "time": "00:34:20", "desc": "sichtbare Aktionen" }] }],
  "camera_motion": "static|panning|zooming|handheld|etc",
  "text_visible": ["genauer sichtbarer Text, falls vorhanden"],
  "strong_uncertainties": ["zweideutige Punkte"]
}` + VISUAL_ARTIFACT_ACCUMULATION_RULE + EDITORIAL_CONTENT_RULE + FACT_GROUNDING_RULE;

/** Prompt for video-based aggregation analysis — reanalyzeVideoForAggregation (exported). */
export const AGGREGATION_ANALYSIS_VIDEO_PROMPT = `Du bist eine visuelle Analyse-Engine. Analysiere die folgenden Video-Schnitte, die zum selben Beitrag gehoeren, und erstelle eine einheitliche Analyse.

Erstelle eine einheitliche Analyse.

Gib direkt gültiges JSON in ausschließlich folgendem Schema ohne JSON-Fences zurück. Gib kompaktes JSON ohne Whitespace-Blöcke zurück:
{
  "summary": "ein-saetzige Gesamtbeschreibung des gesamten Beitrags",
  "setting": "wo und wann das Video spielt",
  "scene_type": "intro|outro|lead-in|anchor-lead|ad|teaser|interview|regional-news|national-news|global-news|opener|closer|social-spot|spot|trailer|lead-out|sponsor-ad",
  "timeline": [{ "time": "00:34:20", "event": "was sichtbar passiert" }],
  "subjects": [{ "type": "person|object|animal|brand", "appearance": "sichtbare Attribute", "actions": [{ "time": "00:34:20", "desc": "sichtbare Aktionen" }] }],
  "camera_motion": "static|panning|zooming|handheld|etc",
  "text_visible": ["genauer sichtbarer Text, falls vorhanden"],
  "strong_uncertainties": ["zweideutige Punkte"]
}` + VISUAL_ARTIFACT_ACCUMULATION_RULE + EDITORIAL_CONTENT_RULE + FACT_GROUNDING_RULE;

/** Prompt for aggregation analysis WITH speech transcripts (exported). */
export const AGGREGATION_ANALYSIS_WITH_TRANSCRIPTS_PROMPT = `Du bist eine multimediale Analyse-Engine. Hier sind die visuellen Analysen mehrerer Video-Schnitte UND die Speech-Transkripte aus demselben Zeitbereich. Erstelle eine einheitliche Analyse fuer den gesamten Beitrag. Verwende die Transkripte fuer Audio-Inhalte statt "unsicher" zu melden.

Visuelle Analysen der Video-Schnitte:
{{SLICE_ANALYSES}}

Speech-Transkripte aus diesem Zeitbereich:
{{TRANSCRIPTS}}

Gib direkt gültiges JSON in folgendem Format ohne JSON-Fences zurück. Gib kompaktes JSON ohne Whitespace-Blöcke zurück:
{
  "summary": "ein-saetzige Gesamtbeschreibung des gesamten Beitrags",
  "setting": "wo und wann das Video spielt",
  "scene_type": "intro|outro|lead-in|anchor-lead|ad|teaser|interview|regional-news|national-news|global-news|opener|closer|social-spot|spot|trailer|lead-out|sponsor-ad",
  "timeline": [{ "time": "00:34:20", "event": "was sichtbar passiert" }],
  "subjects": [{ "type": "person|object|animal|brand", "appearance": "sichtbare Attribute", "actions": [{ "time": "00:34:20", "desc": "sichtbare Aktionen" }] }],
  "camera_motion": "static|panning|zooming|handheld|etc",
  "text_visible": ["genauer sichtbarer Text, falls vorhanden"],
  "strong_uncertainties": ["zweideutige Punkte - vermeide audio-bezogene Unsicherheiten wenn Transkript verfügbar"]
}` + VISUAL_ARTIFACT_ACCUMULATION_RULE + EDITORIAL_CONTENT_RULE + FACT_GROUNDING_RULE;

/** Prompt for aggregation analysis WITH speech transcripts AND keyframe captions (exported).
 * Used when both speech transcripts and keyframe captions are available. */
export const AGGREGATION_ANALYSIS_WITH_ALL_MEDIA_PROMPT = `Du bist eine multimediale Analyse-Engine. Hier sind die visuellen Analysen mehrerer Video-Schnitte, die Speech-Transkripte UND Keyframe-Bildbeschreibungen (jeweils das erste Keyframe des entsprechenden Video-Clips) aus demselben Zeitbereich. Erstelle eine einheitliche Analyse fuer den gesamten Beitrag. Verwende die Transkripte fuer Audio-Inhalte und Keyframe-Beschreibungen fuer visuelle Details statt "unsicher" zu melden.

Visuelle Analysen der Video-Schnitte:
{{SLICE_ANALYSES}}

Speech-Transkripte aus diesem Zeitbereich:
{{TRANSCRIPTS}}

Keyframe-Bildbeschreibungen aus diesem Zeitbereich:
{{KEYFRAMES}}

Gib direkt gültiges JSON in folgendem Format ohne JSON-Fences zurück. Gib kompaktes JSON ohne Whitespace-Blöcke zurück:
{
  "summary": "ein-saetzige Gesamtbeschreibung des gesamten Beitrags",
  "setting": "wo und wann das Video spielt",
  "scene_type": "intro|outro|lead-in|anchor-lead|ad|teaser|interview|regional-news|national-news|global-news|opener|closer|social-spot|spot|trailer|lead-out|sponsor-ad",
  "timeline": [{ "time": "00:34:20", "event": "was sichtbar passiert" }],
  "subjects": [{ "type": "person|object|animal|brand", "appearance": "sichtbare Attribute", "actions": [{ "time": "00:34:20", "desc": "sichtbare Aktionen" }] }],
  "camera_motion": "static|panning|zooming|handheld|etc",
  "text_visible": ["genauer sichtbarer Text, falls vorhanden"],
  "strong_uncertainties": ["zweideutige Punkte - vermeide audio-bezogene Unsicherheiten wenn Transkript verfügbar"]
}` + VISUAL_ARTIFACT_ACCUMULATION_RULE + EDITORIAL_CONTENT_RULE + FACT_GROUNDING_RULE;

/** Prompt for whole-video summary from aggregations (exported). */
export const WHOLE_SUMMARY_PROMPT = `Du bist eine Zusammenfassungs-Engine. Hier sind die Analysen mehrerer semantischer Aggregationen (Beitraege) aus einem Video. Erstelle eine uebersichtliche Zusammenfassung fuer das gesamte Video.

Aggregationen:
{{AGGREGATIONS}}

Gib direkt gültiges JSON in folgendem Format ohne JSON-Fences zurück. Gib kompaktes JSON ohne Whitespace-Blöcke zurück:
{
  "title": "Überschrift für das gesamte Video",
  "keywords": ["Stichwort1", "Stichwort2", ...],
  "short_description": "Kurze Beschreibung (1-2 Saetze), falls moeglich mit Nennung von Ort, Datum",
  "long_summary": "Ausfuehrliche Zusammenfassung aller Beitraege, falls möglich mit Verweisen auf die einzelnen Beitraege (z.B. 'Beitrag 1 handelt von...'), Ort, Datum, Uhrzeit, beteiligte Personen, etc."
}` + EDITORIAL_CONTENT_RULE + FACT_GROUNDING_RULE;

// DEPRECATED: unused leftover of the dropped
// progressive whole-summary update design; referenced nowhere (the live fallback
// uses WHOLE_SUMMARY_PROMPT/wholeSummarySchema below).
/** Prompt for progressive summary update — updates an existing summary with new aggregations (exported). */
export const WHOLE_SUMMARY_UPDATE_PROMPT = `Du bist eine Zusammenfassungs-Engine. Du hast bereits eine Zwischen-zusammenfassung erstellt. Erweitere diese Zusammenfassung mit den neuen Aggregationen.

Bisherige Zusammenfassung:
{{PREVIOUS_SUMMARY}}

Neue Aggregationen (Beitraege {{START_INDEX}} bis {{END_INDEX}}):
{{NEW_AGGREGATIONS}}

Aktualisiere die Zusammenfassung so, dass:
1. Der Titel aktualisiert wird, falls die neuen Beitraege das Thema wesentlich aendern
2. Neue Keywords hinzugefuegt werden (nur wirklich relevante)
3. Die short_description aktualisiert wird, falls noetig
4. Die long_summary erweitert wird - neue Beitraege am Ende anhaengen mit Bezug auf ihre Zeitbereiche

Gib direkt gültiges JSON in folgendem Format ohne JSON-Fences zurück. Gib kompaktes JSON ohne Whitespace-Blöcke zurück:
{
  "title": "Aktualisierte Überschrift für das gesamte Video",
  "keywords": ["Stichwort1", "Stichwort2", ...],
  "short_description": "Aktualisierte kurze Beschreibung",
  "long_summary": "Erweiterte Zusammenfassung mit neuen Beitraegen"
}`;

/** Schema for semantic profile with relationships extraction (exported for tooling/e2e tests). */
export const semanticProfileWithRelationshipsSchema = yup.object({
  profile: yup.object({
    topics: yup.array().of(yup.string().required()).required(),
    setting: yup.string().required(),
    speakers: yup.array().of(yup.string().required()).required(),
    mood: yup.string().required(),
    visualStyle: yup.string().required(),
    audioCharacter: yup.string().required(),
    primaryIntention: yup.string().oneOf(['inform', 'entertain', 'promote', 'educate', 'mixed']).required(),
    confidence: yup.string().required(),
  }).required(),
  relatedAggregationIds: yup.array().of(yup.string().required()).required(),
  reason: yup.string().required(),
}).stripUnknown();

/**
 * Prompt for semantic profile extraction with context — extracts profile AND relationships
 * in a single call by injecting all previous profiles as context.
 *
 * This is the optimized O(n) approach: each aggregation gets ONE call that includes
 * all previous profiles for stable vocabulary and holistic relationship detection.
 */
export const SEMANTIC_PROFILE_WITH_CONTEXT_PROMPT = `Du extrahierst ein multidimensionales semantisches Profil UND bestimmst Beziehungen zu vorherigen Aggregationen.

Bisherige Profile (zur Referenz für konsistente Terminologie):
{{PREVIOUS_PROFILES}}

Aktuelle Aggregation (#{{CURRENT_AGG_ID}}):
{{CURRENT_AGGREGATION}}

Aufgabe:
1. Extrahiere das semantische Profil für die aktuelle Aggregation
2. Bestimme, zu welchen vorherigen Aggregationen diese semantisch gehört
   - Eine Aggregation gehört zu einer anderen, wenn sie dasselbe übergeordnete Thema,
     denselben Sprecher, oder dieselbe Intention teilt
   - Auch wenn Szenen dazwischen lagen (z.B. Werbung), kann eine spätere
     Aggregation thematisch zu einer früheren gehören
   - Vergleiche mit ALLEN vorherigen Profilen für umfassende Beziehungen

Gib direkt gültiges JSON in folgendem Format ohne JSON-Fences zurück. Gib kompaktes JSON ohne Whitespace-Blöcke zurück:
{
  "profile": {
    "topics": ["topic1", "topic2"],
    "setting": "studio|outdoor|office|etc",
    "speakers": ["sprecher1", "sprecher2"],
    "mood": "serious|light|dramatic|etc",
    "visualStyle": "news-broadcast|documentary|entertainment|etc",
    "audioCharacter": "speech-with-music|ambient-only|silence|etc",
    "primaryIntention": "inform|entertain|promote|educate|mixed",
    "confidence": "85%"
  },
  "relatedAggregationIds": ["aggregation:0", "aggregation:3"],
  "reason": "Kurze Begründung für die Beziehungen"
}` + EDITORIAL_CONTENT_RULE + FACT_GROUNDING_RULE;

export interface DefaultPostProcessingConfig extends PluginDefinition {
  /** Which slice types to analyze. Default: ["scene"] */
  includeTypes?: string[];
  /** Whether to re-analyze video files for aggregation. Default: false. */
  reanalyzeVideoForAggregation?: boolean;
  /** Whether to extract semantic profiles and detect long-range semantic relationships.
   *  When enabled, each aggregation gets a multi-dimensional profile (topics, setting,
   *  speakers, mood, etc.) and relationships to other aggregations are computed
   *  auto-regressively. Default: true */
  extractSemanticProfiles?: boolean;
  /** When enabled, keyframe captions are only included in aggregation analysis when
   *  the parent video clip has no/empty/invalid caption or is shorter than 1 second.
   *  This reduces redundant processing when video captions are sufficient.
   *  Default: false (always include keyframe captions when available) */
  enabledAsFallback?: boolean;

  /** When true, aggregation analysis includes the Human Perception Matrix
   *  (rhetoric/framing/emotion). Set to false to skip perception evaluation.
   *  Default: true (opt-out) */
  enableHumanPerceptionEvaluation?: boolean;

  /** When true, visual artifacts (logos, text overlays, dates) are tracked and
   *  accumulated across scenes → aggregations → higher-order aggregations.
   *  Default: true (opt-out) */
  enableVisualArtifactTracking?: boolean;

  /** Map-reduce chunk size in slices for oversized aggregation prompts.
   *  When the deduplicated prompt still exceeds the model's context budget,
   *  slices are analyzed in chunks of this size (map calls in parallel,
   *  bounded by maxConcurrency) and merged with one reduce call.
   *  Default: 8. 0 disables map-reduce (always a single capped call). */
  mapReduceSlicesPerChunk?: number;

  /** When true, higher-order aggregation groups regular aggregations into
   *  semantic macro-sections (e.g., "News Flash" vs "Teaser Ad") before the
   *  final summary. This enables long-horizon compositional understanding.
   *  Default: true (opt-out) */
  enableHigherOrderAggregation?: boolean;

  /** When true, the final summary is generated with Chain-of-Thought reasoning
   *  instructions and enableThinking=true. The model reasons step-by-step about
   *  video composition, recurring visual artifacts, and overall intention before
   *  producing the final output. Default: true (opt-out).
   *  Note: this flag is read by the summary engine (summary.ts), but is mirrored
   *  here so plugin configs can override it consistently. */
  enableChainOfThoughtSummary?: boolean;

  /** Minimum number of distinct scenes an aggregation must cover. Only enforced
   *  when the whole video has >= 3 distinct scenes — exactly 2 distinct scenes
   *  are NOT force-merged by this rule (preserves a genuine boundary between two
   *  scenes). Singleton aggregations are merged into an adjacent neighbor.
   *  Set to 1 to disable. Default: 2 */
  minScenesPerAggregation?: number;

  /** Minimum duration in seconds for an aggregation. Aggregations shorter than
   *  this are ALWAYS merged into a neighbor, regardless of scene count. This
   *  prevents tiny aggregations even when the scene-count rule is skipped.
   *  Set to 0 to disable. Default: 10 */
  minAggregationLengthInSec?: number;

  /** When true, after all aggregation analyses a transition pass computes for each
   *  adjacent aggregation pair a reliable relationship_to_previous label plus a
   *  transition_description (one small text-only model call per pair, bounded
   *  concurrency). HOA boundary decisions consume these via aggregationToText.
   *  Default: true (opt-out) */
  enrichTransitions?: boolean;

  /** Minimum number of aggregations a higher-order aggregation must contain when
   *  there is more than one aggregation in total. Set to 1 to disable.
   *  Default: 2 */
  minAggregationsPerHigherOrder?: number;

  /** Token budget for the unified whole-video summary input (estimated with
   *  ~1.3 tokens/word). When the concatenated HOA descriptions exceed this,
   *  summaryFromAggregations switches to sliding-window chronological
   *  summarization instead of a single call. Default: 96000. */
  maxUnifiedSummaryInputTokens?: number;

  /** Window size (in HOAs) for sliding-window chronological summarization.
   *  Must be >= 2; invalid values fall back to the default. Default: 4 */
  chronologicalSummaryWindowSize?: number;

  /** Overlap (in HOAs) between consecutive chronological-summary windows.
   *  Must be >= 1 and < chronologicalSummaryWindowSize; invalid values fall
   *  back to the default. Default: 1 */
  chronologicalSummaryWindowOverlap?: number;
}

/**
 * Collects speech transcripts that overlap with the given aggregation's timeframe.
 * Returns chronologically sorted array of {from, to, transcript} objects.
 * A speech slice overlaps if: speech.toSeconds >= aggregation.fromSeconds AND speech.fromSeconds <= aggregation.toSeconds
 */
export function collectSpeechTranscriptsForAggregation(
  aggregation: SemanticAggregation,
  timeSlices: TimeSlice[],
): Array<{ from: string; to: string; transcript: string }> {
  return timeSlices
    .filter((s) => {
      if (s.type !== "speech") return false;
      // Timeframe overlap check: speech slice overlaps with aggregation span
      return s.toSeconds >= aggregation.fromSeconds && s.fromSeconds <= aggregation.toSeconds;
    })
    .sort((a, b) => a.fromSeconds - b.fromSeconds)
    .map((s) => ({
      from: s.from,
      to: s.to,
      transcript: s.caption,
    }));
}

/**
 * Checks if a scene slice has a valid caption for fallback determination.
 * A valid caption is: not empty, not null/undefined, length >= 10, and not an error marker.
 */
function sceneHasValidCaption(sceneSlice: TimeSlice): boolean {
  const caption = sceneSlice?.caption;
  if (!caption || typeof caption !== "string") return false;
  const trimmed = caption.trim();
  if (trimmed.length < 10) return false;
  // Check for error indicators
  if (trimmed.startsWith("[ERROR") || trimmed.startsWith("[FEHLER")) return false;
  return true;
}

/**
 * Collects keyframe captions that overlap with the given aggregation's timeframe.
 * Returns chronologically sorted array of {from, to, caption, isFallback} objects.
 * A keyframe slice overlaps if: keyframe.toSeconds >= aggregation.fromSeconds AND keyframe.fromSeconds <= aggregation.toSeconds
 *
 * When enabledAsFallback is true, keyframes are only included if the corresponding scene
 * (video clip) has no valid caption. This avoids redundant keyframe processing when the
 * video caption already provides sufficient context.
 */
export function collectKeyframeCaptionsForAggregation(
  aggregation: SemanticAggregation,
  timeSlices: TimeSlice[],
  options?: {
    /** When true, only include keyframes whose parent scene has no valid caption */
    enabledAsFallback?: boolean;
  },
): Array<{ from: string; to: string; caption: string; isFallback: boolean }> {
  // Get all scene slices that overlap with this aggregation's timeframe
  const sceneSlices = options?.enabledAsFallback
    ? timeSlices.filter((s) => {
      if (s.type !== "scene") return false;
      return s.toSeconds >= aggregation.fromSeconds && s.fromSeconds <= aggregation.toSeconds;
    })
    : [];

  // Helper to check if a keyframe should be skipped due to valid scene caption
  const shouldSkipKeyframe = (keyframe: TimeSlice): boolean => {
    if (!options?.enabledAsFallback) return false;
    // Find scene slices that overlap with this keyframe's timeframe
    const overlappingScene = sceneSlices.find(
      (scene) =>
        scene.sceneIndex === keyframe.sceneIndex &&
        keyframe.toSeconds >= scene.fromSeconds &&
        keyframe.fromSeconds <= scene.toSeconds,
    );
    if (!overlappingScene) return false;
    return sceneHasValidCaption(overlappingScene);
  };

  return timeSlices
    .filter((s) => {
      if (s.type !== "keyframe") return false;
      // Timeframe overlap check: keyframe slice overlaps with aggregation span
      if (s.toSeconds < aggregation.fromSeconds || s.fromSeconds > aggregation.toSeconds) return false;
      // Fallback check: skip if scene has valid caption
      if (shouldSkipKeyframe(s)) return false;
      return true;
    })
    .sort((a, b) => a.fromSeconds - b.fromSeconds)
    .map((s) => {
      // Determine if this keyframe was included as a fallback (scene had invalid caption)
      // If enabledAsFallback is true, isFallback is true only when we had a valid scene to compare
      // and the keyframe was included because that scene had an invalid caption
      const hadOverlappingScene = sceneSlices.some(
        (scene) =>
          scene.sceneIndex === s.sceneIndex &&
          s.toSeconds >= scene.fromSeconds &&
          s.fromSeconds <= scene.toSeconds,
      );
      const isFallback = Boolean(options?.enabledAsFallback && hadOverlappingScene && !shouldSkipKeyframe(s));
      return {
        from: s.from,
        to: s.to,
        caption: s.caption,
        isFallback,
      };
    });
}


/**
 * Analyze each scene slice with a VLM, producing structured JSON.
 * Speech slices (when includeTypes contains "speech") are stored with their caption
 * as plugin data — no VLM call needed since the transcript is already available.
 * Non-scene/non-speech slices are preserved but skipped.
 */
/**
 * Check if a caption contains rich Markdown signals (relationship labels, perception matrix).
 * Used to decide whether to skip video re-analysis and use the pre-generated caption instead.
 */
function hasRichCaptionSignals(caption: string | undefined): boolean {
  if (!caption || caption.trim().length < 10) return false;
  return caption.includes("# Beziehung") || caption.includes("# Visuelle Artefakte") || caption.includes("# Bildbeschreibung");
}

/**
 * Wrap a raw caption string as plugin data for downstream hooks.
 * When the caption contains rich Markdown (relationship labels, perception matrix),
 * we preserve it as-is in the `raw_caption` field so aggregation hooks can use it.
 */
function captionToPluginData(caption: string, source: string): JsonValue {
  return {
    summary: caption.slice(0, 200) + (caption.length > 200 ? "..." : ""),
    raw_caption: caption,
    caption_source: source,
    setting: "caption-first — using pre-generated caption",
    scene_type: "pre-captioned",
    timeline: [],
    subjects: [],
    camera_motion: "unsicher",
    audio: "unsicher",
    text_visible: [],
    uncertainties: [],
  } as JsonValue;
}

export async function postProcessPerTimeSlice(
  input: PostProcessingInput,
  pluginDefinition: PostProcessingPluginDefinition<DefaultPostProcessingConfig>,
  api: PluginRpcApiCompositeInstance,
): Promise<{ timeSlices: TimeSlice[] }> {
  const modelName = String(pluginDefinition.config?.modelName ?? DEFAULT_VLM_MODEL);
  const modelConfig = getModel(modelName);
  const slices = [...input.timeSlices];
  const includeTypes = pluginDefinition.config?.includeTypes ?? DEFAULT_POST_PROCESSING_INCLUDE_TYPES;
  const targetSlices = slices.filter((s) => includeTypes.includes(s.type));
  // When false (default), skip video re-analysis and use the pre-generated caption instead.
  // Only set true when you want the VLM to re-analyze the video from scratch.
  const reanalyzeVideo = pluginDefinition.config?.reanalyzeVideoForAggregation ?? false;

  // Debug: log slice counts by type
  const sliceCountsByType = targetSlices.reduce((acc, s) => {
    acc[s.type] = (acc[s.type] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  console.log(`[default:postProcessPerTimeSlice] Starting — ${targetSlices.length} slices total, by type: ${JSON.stringify(sliceCountsByType)}, reanalyzeVideo=${reanalyzeVideo}, concurrency: ${pluginDefinition.config?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY}`);
  const processingStartTime = Date.now();

  await api.util.limitConcurrency(
    targetSlices,
    Number(pluginDefinition.config?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY),
    async (slice, index) => {
      const sliceStartTime = Date.now();
      console.log(`[default:postProcessPerTimeSlice] [${index}/${targetSlices.length}] Starting slice ${slice.id} (type=${slice.type}, duration=${slice.durationSeconds?.toFixed(2) ?? (slice.toSeconds - slice.fromSeconds).toFixed(2)}s)`);
      try {
        if (slice.type === "speech") {
          // Transcript already available from ASR step — no VLM call needed.
          slice.plugin ??= {};
          slice.plugin["default"] = {
            summary: slice.caption,
            type: "speech_transcript",
            transcript: slice.caption,
          } as JsonValue;
          return;
        }

        // CAPTION-FIRST: When reanalyzeVideo is false (default) and the slice has a valid
        // caption from the processing phase, use it directly instead of re-analyzing the video.
        // This preserves rich Markdown captions (relationship labels, perception matrix)
        // and saves expensive VLM calls.
        if (!reanalyzeVideo && (slice.type === "scene" || slice.type === "keyframe")) {
          const hasCaption = slice.caption && slice.caption.trim().length >= 10;
          if (hasCaption) {
            console.log(`[default:postProcessPerTimeSlice] [${index}/${targetSlices.length}] Using pre-generated caption for ${slice.id} (reanalyzeVideo=false)${hasRichCaptionSignals(slice.caption) ? " — rich Markdown detected" : ""}`);
            slice.plugin ??= {};
            slice.plugin["default"] = captionToPluginData(slice.caption!, "processing-phase");
            const elapsed = Date.now() - sliceStartTime;
            console.log(`[default:postProcessPerTimeSlice] [${index}/${targetSlices.length}] Completed slice ${slice.id} via caption in ${elapsed}ms`);
            return;
          }
        }

        // Scene/Keyframe slices: send to VLM for visual analysis.
        // Short scenes (< MIN_SCENE_DURATION_SEC) cannot provide enough frames for
        // reliable VLM analysis. Use the scene's keyframe (single image) instead.
        if (slice.type === "scene" || slice.type === "keyframe") {
          if ((slice.durationSeconds ?? (slice.toSeconds - slice.fromSeconds)) < MIN_SCENE_DURATION_SEC) {
            // Find the keyframe for this scene from the input timeSlices
            const sceneKeyframe = input.timeSlices.find(
              (s) => s.type === "keyframe" && s.sceneIndex === slice.sceneIndex,
            );
            if (sceneKeyframe) {
              console.log(`[default:postProcessPerTimeSlice] Short scene ${slice.id} (${(slice.durationSeconds ?? (slice.toSeconds - slice.fromSeconds)).toFixed(2)}s < ${MIN_SCENE_DURATION_SEC}s) — using keyframe ${sceneKeyframe.id} for VLM analysis`);
              const validated = await api.mllm.callJson<JsonValue>({
                endpoint: modelConfig.resolvedEndpoint,
                model: modelConfig.resolvedModel,
                apiKey: modelConfig.resolvedApiKey,
                filePaths: [sceneKeyframe.sourceFile.containerPath],
                mediaCategory: "image",
                prompt: DEFAULT_SLICE_ANALYSIS_PROMPT,
                schema: sliceAnalysisSchema,
                enableThinking: false,
                jsonSchemaMode: modelConfig.jsonSchemaMode,
                jsonSchemaName: modelConfig.jsonSchemaName,
                structuredMaxTokens: modelConfig.structuredOutput?.maxTokens,
                structuredTemperature: modelConfig.structuredOutput?.temperature,
                structuredFrequencyPenalty: modelConfig.structuredOutput?.frequencyPenalty,
                structuredRepetitionPenalty: modelConfig.structuredOutput?.repetitionPenalty,
                repetitionDetection: modelConfig.resolvedRepetitionDetection,
                hyperparams: pluginDefinition.config?.hyperparams,
              });
              slice.plugin ??= {};
              slice.plugin["default"] = validated;
              const elapsed = Date.now() - sliceStartTime;
              console.log(`[default:postProcessPerTimeSlice] [${index}/${targetSlices.length}] Completed slice ${slice.id} (type=${slice.type}) via keyframe in ${elapsed}ms`);
              return;
            } else {
              console.log(`[default:postProcessPerTimeSlice] Skipping VLM for short scene ${slice.id} (${(slice.durationSeconds ?? (slice.toSeconds - slice.fromSeconds)).toFixed(2)}s < ${MIN_SCENE_DURATION_SEC}s) — no keyframe available, using existing caption as fallback`);
              slice.plugin ??= {};
              slice.plugin["default"] = {
                summary: slice.caption ?? "",
                setting: "kurzer Clip — keine detaillierte Analyse verfügbar",
                scene_type: "spot",
                timeline: [],
                subjects: [],
                camera_motion: "unsicher",
                audio: "unsicher",
                text_visible: [],
                uncertainties: ["Szene zu kurz für visuelle Analyse"],
              } as JsonValue;
              return;
            }
          }
        }

        // callJson handles parse + validate + validation-error retry automatically.
        console.log(`[default:postProcessPerTimeSlice] [${index}/${targetSlices.length}] Making API call for slice ${slice.id} (type=${slice.type}, model=${modelConfig.resolvedModel}, mediaCategory=${slice.type === "keyframe" ? "image" : "video"}, jsonSchemaMode=${modelConfig.jsonSchemaMode})`);
        const validated = await api.mllm.callJson<JsonValue>({
          endpoint: modelConfig.resolvedEndpoint,
          model: modelConfig.resolvedModel,
          apiKey: modelConfig.resolvedApiKey,
          filePaths: [slice.sourceFile.containerPath],
          mediaCategory: slice.type === "keyframe" ? "image" : "video",
          prompt: DEFAULT_SLICE_ANALYSIS_PROMPT,
          schema: sliceAnalysisSchema,
          enableThinking: false,
          jsonSchemaMode: modelConfig.jsonSchemaMode,
          jsonSchemaName: modelConfig.jsonSchemaName,
          structuredMaxTokens: modelConfig.structuredOutput?.maxTokens,
          structuredTemperature: modelConfig.structuredOutput?.temperature,
          structuredFrequencyPenalty: modelConfig.structuredOutput?.frequencyPenalty,
          structuredRepetitionPenalty: modelConfig.structuredOutput?.repetitionPenalty,
          repetitionDetection: modelConfig.resolvedRepetitionDetection,
          hyperparams: pluginDefinition.config?.hyperparams,
        });
        slice.plugin ??= {};
        slice.plugin["default"] = validated;
        const elapsed = Date.now() - sliceStartTime;
        console.log(`[default:postProcessPerTimeSlice] [${index}/${targetSlices.length}] Completed slice ${slice.id} (type=${slice.type}) in ${elapsed}ms`);
      } catch (err) {
        const elapsed = Date.now() - sliceStartTime;
        console.error(`[default:postProcessPerTimeSlice] [${index}/${targetSlices.length}] Failed for slice ${slice.id} (type=${slice.type}) after ${elapsed}ms:`, err);
        // Record error on slice for downstream hooks and result propagation
        slice.plugin ??= {};
        slice.plugin["default"] = { _error: err instanceof Error ? err.message : String(err) } as JsonValue;
      }
    },
  );

  const totalElapsed = Date.now() - processingStartTime;
  console.log(`[default:postProcessPerTimeSlice] Completed all ${targetSlices.length} slices in ${totalElapsed}ms`);

  return { timeSlices: slices };
}

/**
 * Get the effective caption for a slice when making aggregation decisions.
 * When a scene has an empty/invalid caption but has keyframes with valid captions,
 * use the keyframe caption as the effective caption. This ensures scenes and their
 * keyframes are correctly merged into a single aggregation when the scene caption is empty.
 */
function getEffectiveCaptionForAggregation(
  slice: TimeSlice,
  allTimeSlices: TimeSlice[],
): string {
  const pluginData = slice.plugin?.["default"] as Record<string, unknown> | undefined;

  // PREFER rich caption: When the caption contains relationship/perception signals
  // (from audio-first context-aware captioning), use the full raw caption.
  // This gives the decision model access to the relationship classification and
  // perception matrix for better cross-scene aggregation decisions.
  const rawCaption = (pluginData?.raw_caption as string | undefined) ?? slice.caption ?? "";
  if (rawCaption && hasRichCaptionSignals(rawCaption)) {
    return rawCaption;
  }

  // Fall back to structured summary from plugin data
  const sliceSummary = pluginData?.summary;
  if (sliceSummary) return String(sliceSummary);

  // Fall back to plain caption if valid
  if (rawCaption && sceneHasValidCaption(slice)) return rawCaption;

  // Scene has empty/invalid caption - check if any keyframe in this scene has a valid caption
  if (slice.type === "scene") {
    const sceneKeyframes = allTimeSlices.filter(
      (s) =>
        s.type === "keyframe" &&
        s.sceneIndex === slice.sceneIndex &&
        s.toSeconds >= slice.fromSeconds &&
        s.fromSeconds <= slice.toSeconds,
    );
    for (const kf of sceneKeyframes) {
      if (kf.caption && kf.caption.trim().length >= 10) {
        return kf.caption;
      }
    }
  }

  return rawCaption;
}

/**
 * Maximum gap (seconds) between a slice and its parent scene's time range for the
 * sceneIndex auto-merge to apply. Slices farther away than this (e.g. a 0.5s scene
 * hoarding 14 minutes of mis-attributed speech) fall through to the model decision
 * instead of being force-merged into one 14-minute aggregation with no model call.
 */
const SCENE_MERGE_TIME_TOLERANCE_SEC = 5;

/**
 * Look up the time range [from, to] of the scene-type slice for a given sceneIndex.
 *
 * Why this exists: the sceneIndex auto-merge must only fuse slices that genuinely
 * sit inside their parent scene's timeframe. Speech/keyframe slices that were
 * mis-attributed to a distant scene must NOT auto-merge. Returns undefined when no
 * scene slice has that sceneIndex (e.g. audio-only sceneIndex -1), in which case
 * the auto-merge is skipped and the model decides.
 */
function findSceneTimeRange(
  sceneIndex: number,
  timeSlices: TimeSlice[],
): { from: number; to: number } | undefined {
  for (const s of timeSlices) {
    if (s.type === "scene" && s.sceneIndex === sceneIndex) {
      return { from: s.fromSeconds, to: s.toSeconds };
    }
  }
  return undefined;
}

/**
 * True when a slice's timeframe overlaps (or touches within `toleranceSec`) the
 * given scene range — i.e. the slice genuinely sits inside that scene.
 */
function sliceIsWithinScene(
  slice: TimeSlice,
  range: { from: number; to: number },
  toleranceSec: number,
): boolean {
  return (
    slice.toSeconds >= range.from - toleranceSec &&
    slice.fromSeconds <= range.to + toleranceSec
  );
}

/**
 * Decide whether two adjacent slices belong to the same semantic contribution.
 * Uses the validated per-slice JSON to ask the model for a decision.
 * If speech transcripts are available (via plugin data), they are included in the prompt.
 *
 * KEYFRAME-AS-PRIMARY LOGIC: When a scene slice has an empty/invalid caption but
 * its keyframes have valid captions, we use the keyframe caption for comparison.
 * This ensures scenes and keyframes with complementary information get merged
 * into a single aggregation, rather than creating separate aggregations.
 */
export async function decideForAggregation(
  sliceA: TimeSlice,
  sliceB: TimeSlice,
  pluginDefinition: PostProcessingPluginDefinition<DefaultPostProcessingConfig>,
  api: PluginRpcApiCompositeInstance,
  input?: PostProcessingInput,
): Promise<boolean> {
  const allTimeSlices = input?.timeSlices ?? [];

  // Unified multi-modal aggregation: slices of the SAME scene are auto-merged —
  // but ONLY when both slices actually sit inside that scene's timeframe (plus a
  // small tolerance). This keeps the multi-modal slices of one scene (scene + its
  // keyframes + its in-range speech) together without a model call, while
  // preventing a scene from absorbing far-flung slices that were mis-attributed to
  // it (e.g. a 0.5s scene hoarding 14 minutes of speech), which would otherwise
  // fuse into a 14-minute aggregation with no decision at all.
  if (sliceA.sceneIndex === sliceB.sceneIndex && sliceA.sceneIndex !== undefined) {
    const sceneRange = findSceneTimeRange(sliceA.sceneIndex, allTimeSlices);
    if (
      sceneRange &&
      sliceIsWithinScene(sliceA, sceneRange, SCENE_MERGE_TIME_TOLERANCE_SEC) &&
      sliceIsWithinScene(sliceB, sceneRange, SCENE_MERGE_TIME_TOLERANCE_SEC)
    ) {
      return true;
    }
    // Temporally far from the scene -> fall through to the model decision below.
  }

  const modelName = String(pluginDefinition.config?.modelName ?? DEFAULT_VLM_MODEL);
  const modelConfig = getModel(modelName);

  // Use effective captions (keyframe caption as fallback for empty scene captions)
  // This ensures scenes with empty captions still get compared meaningfully
  // for cross-scene aggregation decisions.
  const summaryA = getEffectiveCaptionForAggregation(sliceA, allTimeSlices);
  const summaryB = getEffectiveCaptionForAggregation(sliceB, allTimeSlices);

  // Check if speech transcripts are available for either slice
  const hasTranscripts = pluginDefinition.config?.includeTypes?.includes("speech") ?? false;
  const transcriptA = hasTranscripts
    ? (sliceA.plugin?.["default"] as Record<string, unknown> | undefined)?.transcript ?? ""
    : "";
  const transcriptB = hasTranscripts
    ? (sliceB.plugin?.["default"] as Record<string, unknown> | undefined)?.transcript ?? ""
    : "";

  // Use transcript-aware prompt when transcripts are available
  const promptTemplate = (hasTranscripts && transcriptA && transcriptB)
    ? DECISION_PROMPT_WITH_TRANSCRIPTS
    : DECISION_PROMPT;

  let prompt: string;
  if (hasTranscripts && transcriptA && transcriptB) {
    prompt = promptTemplate
      .replace(/{{SLICE1_SUMMARY}}/g, String(summaryA))
      .replace(/{{SLICE1_TRANSCRIPT}}/g, String(transcriptA))
      .replace(/{{SLICE2_SUMMARY}}/g, String(summaryB))
      .replace(/{{SLICE2_TRANSCRIPT}}/g, String(transcriptB));
  } else {
    prompt = promptTemplate
      .replace(/{{SLICE1_SUMMARY}}/g, String(summaryA))
      .replace(/{{SLICE2_SUMMARY}}/g, String(summaryB));
  }

  try {
    const validated = await api.mllm.callJson<{ same_contribution: boolean }>({
      endpoint: modelConfig.resolvedEndpoint,
      model: modelConfig.resolvedModel,
      apiKey: modelConfig.resolvedApiKey,
      filePaths: [],
      mediaCategory: "video",
      prompt,
      schema: aggregationDecisionSchema,
      enableThinking: false,
      jsonSchemaMode: modelConfig.jsonSchemaMode,
      jsonSchemaName: modelConfig.jsonSchemaName,
      structuredMaxTokens: modelConfig.structuredOutput?.maxTokens,
      structuredTemperature: modelConfig.structuredOutput?.temperature,
      structuredFrequencyPenalty: modelConfig.structuredOutput?.frequencyPenalty,
      structuredRepetitionPenalty: modelConfig.structuredOutput?.repetitionPenalty,
      repetitionDetection: modelConfig.resolvedRepetitionDetection,
      hyperparams: pluginDefinition.config?.hyperparams,
    });
    return Boolean(validated.same_contribution);
  } catch {
    // Default to false on error (incl. exhausted retries) to avoid false merges
    return false;
  }
}

// dedupePromptText/DEDUP_NOTE live in src/lib (shared with WorkflowEngine's
// per-slice caption path); re-exported to keep the plugin import surface stable.
export { dedupePromptText, DEDUP_NOTE };

/** Split a list into chunks of at most `perChunk` items (order preserved). */
function chunkArray<T>(items: T[], perChunk: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += perChunk) chunks.push(items.slice(i, i + perChunk));
  return chunks;
}

/**
 * Reduce prompt for the map-reduce merge of partial aggregation analyses.
 * The partials are compact JSON objects in the same schema; the merge must
 * keep all content while union-deduplicating. {{PARTIALS}} is replaced with
 * the numbered partial JSON documents.
 */
export const MERGE_PARTIAL_ANALYSES_PROMPT = `Du führst Teilanalysen ein- und desselben Beitrags (Teil 1..N) zu EINER vollständigen Analyse zusammen.

Regeln:
- NICHTS weglassen: alle Inhalte, Zeitstempel, Fakten, Zahlen, Namen und Details aus allen Teilen müssen erhalten bleiben.
- Exakte Dopplungen (identische Artefakte, wortgleiche Beobachtungen) genau einmal aufführen; bei Konflikten gilt die konkretere/vollständigere Formulierung.
- timeline chronologisch; subjects zusammenführen; text_visible und uncertainties als Vereinigung; bei perception_matrix gewinnt der Eintrag mit der höheren Confidence.

Teilanalysen:
{{PARTIALS}}

Gib direkt gültiges JSON im gleichen Format wie die Teilanalysen ohne JSON-Fences zurück. Gib kompaktes JSON ohne Whitespace-Blöcke zurück:` + EDITORIAL_CONTENT_RULE + FACT_GROUNDING_RULE;

/**
 * Process each semantic aggregation: unify per-slice analyses into one aggregation analysis.
 * If config.includeTypes contains "speech", speech transcripts are injected into the prompt.
 * If config.reanalyzeVideoForAggregation is true, pass video files to VLM.
 *
 * KEYFRAME-AS-PRIMARY LOGIC: When scene captions are empty/invalid but keyframes have valid
 * captions, the keyframe captions are used as the PRIMARY visual description instead of
 * being relegated to supplementary "[ERSTES KEYFRAME]" sections. This ensures aggregation
 * produces meaningful results even when scene analysis fails to produce captions.
 */
export async function postProcessPerAggregation(
  aggregation: SemanticAggregation,
  timeSlices: TimeSlice[],
  pluginDefinition: PostProcessingPluginDefinition<DefaultPostProcessingConfig>,
  api: PluginRpcApiCompositeInstance,
): Promise<SemanticAggregationPatch> {

  const modelName = String(pluginDefinition.config?.modelName ?? DEFAULT_VLM_MODEL);
  const modelConfig = getModel(modelName);
  const useVideo = pluginDefinition.config?.reanalyzeVideoForAggregation ?? false;
  const hasTranscripts = (pluginDefinition.config?.includeTypes?.includes("speech") ?? false);

  // Collect keyframe captions overlapping this aggregation's timeframe FIRST
  // Keyframes are used as PRIMARY caption when scene caption is empty
  const enabledAsFallback = pluginDefinition.config?.enabledAsFallback ?? false;
  const keyframes = collectKeyframeCaptionsForAggregation(aggregation, timeSlices, { enabledAsFallback });

  // Build a map of sceneIndex -> keyframe caption for quick lookup
  // This is used when scene caption is empty to use keyframe caption as primary
  const sceneKeyframeCaptionMap = new Map<number, string>();
  for (const kf of keyframes) {
    const keyframeSlice = timeSlices.find(
      (s) => s.type === "keyframe" && s.from === kf.from && s.to === kf.to,
    );
    if (keyframeSlice && !sceneKeyframeCaptionMap.has(keyframeSlice.sceneIndex)) {
      sceneKeyframeCaptionMap.set(keyframeSlice.sceneIndex, kf.caption);
    }
  }

  // Build text summary of per-slice analyses using timeSlices.
  // Includes BOTH the raw caption (rich Markdown with relationship/perception signals)
  // AND the structured analysis JSON — giving the model maximum context for aggregation.
  // Factored per-slice builder so the map-reduce path can rebuild per chunk.
  const sliceText = (idx: number, i: number): string => {
    const slice = timeSlices[idx];
    const analysis = slice?.plugin?.["default"] as Record<string, unknown> | undefined;
    if (analysis?._error) {
      return `Schnitt ${i + 1} (Index ${idx}): [ERROR: ${analysis._error}]`;
    }

    // Extract raw_caption from plugin data (set by caption-first flow) or use slice.caption
    const rawCaption = (analysis?.raw_caption as string | undefined) ?? slice?.caption ?? "";

    // KEYFRAME-AS-PRIMARY: If scene has no valid analysis/caption but has keyframe caption, use it
    const hasValidAnalysis = analysis && Object.keys(analysis).length > 0 && !analysis?._error;
    if (!hasValidAnalysis && slice.type === "scene") {
      const keyframeCaption = sceneKeyframeCaptionMap.get(slice.sceneIndex);
      if (keyframeCaption) {
        return `Schnitt ${i + 1} (Index ${idx}):\n${JSON.stringify({ caption: keyframeCaption, source: "keyframe" }, null, 2)}`;
      }
    }

    // Build combined text: raw caption (rich signals) + structured analysis JSON
    // Both together give the aggregation model the best understanding of each scene
    const parts: string[] = [`Schnitt ${i + 1} (Index ${idx}):`];
    if (rawCaption && rawCaption.trim().length >= 10) {
      parts.push(`## Bildbeschreibung (Raw)\n${rawCaption}`);
    }
    if (hasValidAnalysis) {
      parts.push(`## Structured Analysis\n${JSON.stringify(analysis, null, 2)}`);
    }
    return parts.join("\n");
  };

  const buildAnalysesText = (idxs: number[]): string =>
    idxs.map((idx, i) => sliceText(idx, i)).join("\n\n");

  const analysesText = buildAnalysesText(aggregation.sliceIndexes);

  // Collect speech transcripts overlapping this aggregation's timeframe
  const transcripts = hasTranscripts
    ? collectSpeechTranscriptsForAggregation(aggregation, timeSlices)
    : [];

  const transcriptsText = transcripts.length > 0
    ? transcripts.map((t, i) => `  ${t.from} - ${t.to}: ${t.transcript}`).join("\n")
    : "";

  // Format keyframes with "FIRST keyframe of the clip" label
  // When keyframe was used as primary (KEYFRAME-AS-PRIMARY), still include for additional context
  const keyframesText = keyframes.length > 0
    ? keyframes.map((k, i) => `  [ERSTES KEYFRAME DES CLIPS] ${k.from} - ${k.to}: ${k.caption}`).join("\n")
    : "";

  // Shared call args for all three branches; callJson handles parse + validate
  // and retries on validation failure (re-sending media files each attempt).
  const baseCallArgs = {
    endpoint: modelConfig.resolvedEndpoint,
    model: modelConfig.resolvedModel,
    apiKey: modelConfig.resolvedApiKey,
    schema: sliceAnalysisSchema,
    enableThinking: false,
    jsonSchemaMode: modelConfig.jsonSchemaMode,
    jsonSchemaName: modelConfig.jsonSchemaName,
    structuredMaxTokens: modelConfig.structuredOutput?.maxTokens,
    structuredTemperature: modelConfig.structuredOutput?.temperature,
    structuredFrequencyPenalty: modelConfig.structuredOutput?.frequencyPenalty,
    structuredRepetitionPenalty: modelConfig.structuredOutput?.repetitionPenalty,
    repetitionDetection: modelConfig.resolvedRepetitionDetection,
    hyperparams: pluginDefinition.config?.hyperparams,
  };

  try {
    let validated: JsonValue;

    /**
     * Oversized-prompt strategy (Stage 0 dedup → Stage 1 map-reduce):
     * the prompt is always built on deduplicated slice text; only when the
     * estimated context budget still floors out (D1 case: 49 slices ≈ 22k
     * words) are slices analyzed in chunks (map, parallel via maxConcurrency)
     * and merged with one reduce call.
     */
    const perChunk = pluginDefinition.config?.mapReduceSlicesPerChunk ?? 8;
    const mapConcurrency = pluginDefinition.config?.maxConcurrency ?? 4;

    const transcriptsFor = (idxs: number[]): string => {
      if (transcripts.length === 0 || idxs.length === 0) return "";
      const from = Math.min(...idxs.map((i) => timeSlices[i]?.fromSeconds ?? Infinity));
      const to = Math.max(...idxs.map((i) => timeSlices[i]?.toSeconds ?? -Infinity));
      // Same overlap rule as collectSpeechTranscriptsForAggregation, narrowed to
      // this chunk's timeframe. Filters timeSlices (not the pre-collected
      // transcripts) because the numeric fromSeconds/toSeconds live there.
      return timeSlices
        .filter((s) => s.type === "speech" && s.toSeconds >= from && s.fromSeconds <= to)
        .sort((a, b) => a.fromSeconds - b.fromSeconds)
        .map((s) => `  ${s.from} - ${s.to}: ${s.caption}`)
        .join("\n");
    };

    const runAnalysis = (makePrompt: (analyses: string, transcripts: string) => string): Promise<JsonValue> => {
      const singleCall = (idxs: number[], transcripts: string) =>
        api.mllm.callJson<JsonValue>({
          ...baseCallArgs,
          filePaths: [],
          mediaCategory: "video",
          prompt: makePrompt(dedupePromptText(buildAnalysesText(idxs)), transcripts),
        });

      const fullPrompt = makePrompt(dedupePromptText(analysesText), transcriptsText);
      const oversized =
        perChunk > 0 &&
        aggregation.sliceIndexes.length > perChunk &&
        budgetCapForModel(
          resolveMaxInferenceContext(modelConfig.resolvedModel),
          resolveEstimation(modelConfig.resolvedModel),
          fullPrompt,
          undefined,
          "audio",
          undefined,
        ) <= MIN_OUTPUT_TOKENS;

      if (!oversized) {
        return api.mllm.callJson<JsonValue>({
          ...baseCallArgs,
          filePaths: [],
          mediaCategory: "video",
          prompt: fullPrompt,
        });
      }

      // Map: chunk analyses in parallel (bounded by config.maxConcurrency)
      console.log(`[default] map-reduce: ${aggregation.sliceIndexes.length} slices in ${Math.ceil(aggregation.sliceIndexes.length / perChunk)} chunks à ${perChunk} (oversized prompt)`);
      return (async () => {
        const chunks = chunkArray(aggregation.sliceIndexes, perChunk);
        const partials = await api.util.limitConcurrency(chunks, mapConcurrency, (chunkIdxs) =>
          singleCall(chunkIdxs, transcriptsFor(chunkIdxs)),
        );
        // Reduce: one merge call over all partial analyses
        const mergePrompt = MERGE_PARTIAL_ANALYSES_PROMPT.replace(
          "{{PARTIALS}}",
          partials.map((p, i) => `Teil ${i + 1}:\n${JSON.stringify(p, null, 2)}`).join("\n\n"),
        );
        return api.mllm.callJson<JsonValue>({
          ...baseCallArgs,
          filePaths: [],
          mediaCategory: "video",
          prompt: mergePrompt,
        });
      })();
    };

    if (hasTranscripts && transcriptsText && keyframesText) {
      // Both transcripts AND keyframes available — use the comprehensive prompt
      validated = await runAnalysis((a) =>
        AGGREGATION_ANALYSIS_WITH_ALL_MEDIA_PROMPT
          .replace(/{{SLICE_ANALYSES}}/g, a)
          .replace(/{{TRANSCRIPTS}}/g, transcriptsText)
          .replace(/{{KEYFRAMES}}/g, keyframesText),
      );
    } else if (hasTranscripts && transcriptsText) {
      // Use transcript-aware prompt — always text-based (transcripts provide audio context)
      validated = await runAnalysis((a, t) =>
        AGGREGATION_ANALYSIS_WITH_TRANSCRIPTS_PROMPT
          .replace(/{{SLICE_ANALYSES}}/g, a)
          .replace(/{{TRANSCRIPTS}}/g, t),
      );
    } else if (keyframesText) {
      // Only keyframes available (no speech) — use keyframe captions for visual context
      validated = await runAnalysis((a) =>
        AGGREGATION_ANALYSIS_WITH_ALL_MEDIA_PROMPT
          .replace(/{{SLICE_ANALYSES}}/g, a)
          .replace(/{{TRANSCRIPTS}}/g, "(keine Speech-Transkripte verfügbar)")
          .replace(/{{KEYFRAMES}}/g, keyframesText),
      );
    } else if (useVideo) {
      // Collect video file paths from slices in this aggregation
      const filePaths: string[] = [];
      for (const idx of aggregation.sliceIndexes) {
        const slice = timeSlices[idx];
        if (slice?.sourceFile?.containerPath) {
          filePaths.push(slice.sourceFile.containerPath);
        }
      }

      validated = await api.mllm.callJson<JsonValue>({
        ...baseCallArgs,
        filePaths,
        mediaCategory: "video",
        prompt: AGGREGATION_ANALYSIS_VIDEO_PROMPT,
      });
    } else {
      // Text-only: use per-slice analyses (no media files sent)
      validated = await runAnalysis((a) =>
        AGGREGATION_ANALYSIS_PROMPT.replace(/{{SLICE_ANALYSES}}/g, a),
      );
    }

    // The model performs visual-artifact accumulation itself: the aggregation
    // prompt (see VISUAL_ARTIFACT_ACCUMULATION_RULE) instructs it to read the
    // constituent scenes' "# Visuelle Artefakte" markdown tables and emit the
    // aggregated counts + a "# Visuelle Artefakte" / "# Human Perception Matrix"
    // markdown table INSIDE the `summary` field. We deliberately do NOT append the
    // per-scene captions to the summary here — that would explode the context
    // window for downstream HOA/summary stages. The model sees the scene captions
    // via the prompt's analysesText; the summary carries only the high-level line
    // plus the aggregated markdown tables the model produced.
    return { analysis: validated };
  } catch (err) {
    // Exhausted retries (or transport error) — keep graceful fallback so one bad
    // aggregation never aborts the whole run.
    // Extract message + stack explicitly: console.error("label", errObj)
    // renders {} for Error instances (no enumerable own properties), which
    // makes the actual root-cause invisible in captured log output.
    const errMsg = err instanceof Error ? err.message : String(err);
    const errStack = err instanceof Error ? err.stack : "";
    console.error(
      `[default:postProcessPerAggregation] Analysis failed (after retries) for ${aggregation.id}:\n${errMsg}` +
      `${errStack ? `\n${errStack}` : ""}`,
    );
    return {};
  }
}

/**
 * Optional per-aggregation summary. Uses the aggregation analysis summary if present.
 * No extra VLM call required by default.
 */
export async function summaryForAggregation(
  aggregation: SemanticAggregation,
  _pluginDefinition: PostProcessingPluginDefinition<DefaultPostProcessingConfig>,
  _api: PluginRpcApiCompositeInstance,
): Promise<string> {
  // Use the analysis summary if available
  const analysis = aggregation.analysis as Record<string, unknown> | undefined;
  if (analysis?.summary) {
    return String(analysis.summary);
  }
  return "";
}

// Load the unified summary template once at module load (per convention: external
// prompt templates only).
const UNIFIED_SUMMARY_TEMPLATE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../src/lib/unified-summary-prompt.md");
let UNIFIED_SUMMARY_TEMPLATE = "";
try {
  UNIFIED_SUMMARY_TEMPLATE = readFileSync(UNIFIED_SUMMARY_TEMPLATE_PATH, "utf-8");
} catch (err) {
  console.warn(
    `[default:summaryFromAggregations] Could not load unified summary template from ${UNIFIED_SUMMARY_TEMPLATE_PATH}: ` +
    `${err instanceof Error ? err.message : String(err)}`,
  );
}

// Load the chronological sliding-window summary template once at module load.
const CHRONOLOGICAL_SUMMARY_TEMPLATE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../src/lib/chronological-summary-prompt.md");
let CHRONOLOGICAL_SUMMARY_TEMPLATE = "";
try {
  CHRONOLOGICAL_SUMMARY_TEMPLATE = readFileSync(CHRONOLOGICAL_SUMMARY_TEMPLATE_PATH, "utf-8");
} catch (err) {
  console.warn(
    `[default:summaryFromAggregations] Could not load chronological summary template from ${CHRONOLOGICAL_SUMMARY_TEMPLATE_PATH}: ` +
    `${err instanceof Error ? err.message : String(err)}`,
  );
}

// Sized for a 131k-token context: minus ~10k prompt template/instructions and
// a generous output reserve for the unified summary JSON.
const DEFAULT_MAX_UNIFIED_SUMMARY_INPUT_TOKENS = 96000;
const DEFAULT_CHRONOLOGICAL_SUMMARY_WINDOW_SIZE = 4;
const DEFAULT_CHRONOLOGICAL_SUMMARY_WINDOW_OVERLAP = 1;
let loggedInvalidChronologicalSummaryConfig = false;

/**
 * Sanitize the chronological-summary config knobs. Invalid values fall back to
 * the defaults (window size >= 2, 1 <= overlap < window size); the fallback is
 * logged once per process.
 */
function sanitizeChronologicalSummaryConfig(config: DefaultPostProcessingConfig | undefined): {
  maxInputTokens: number;
  windowSize: number;
  overlap: number;
} {
  let maxInputTokens = config?.maxUnifiedSummaryInputTokens ?? DEFAULT_MAX_UNIFIED_SUMMARY_INPUT_TOKENS;
  let windowSize = config?.chronologicalSummaryWindowSize ?? DEFAULT_CHRONOLOGICAL_SUMMARY_WINDOW_SIZE;
  let overlap = config?.chronologicalSummaryWindowOverlap ?? DEFAULT_CHRONOLOGICAL_SUMMARY_WINDOW_OVERLAP;
  const problems: string[] = [];
  if (!Number.isFinite(maxInputTokens) || maxInputTokens <= 0) {
    problems.push(`maxUnifiedSummaryInputTokens=${String(config?.maxUnifiedSummaryInputTokens)}`);
    maxInputTokens = DEFAULT_MAX_UNIFIED_SUMMARY_INPUT_TOKENS;
  }
  if (!Number.isInteger(windowSize) || windowSize < 2) {
    problems.push(`chronologicalSummaryWindowSize=${String(config?.chronologicalSummaryWindowSize)}`);
    windowSize = DEFAULT_CHRONOLOGICAL_SUMMARY_WINDOW_SIZE;
  }
  if (!Number.isInteger(overlap) || overlap < 1 || overlap >= windowSize) {
    problems.push(`chronologicalSummaryWindowOverlap=${String(config?.chronologicalSummaryWindowOverlap)}`);
    overlap = DEFAULT_CHRONOLOGICAL_SUMMARY_WINDOW_OVERLAP;
  }
  if (problems.length > 0 && !loggedInvalidChronologicalSummaryConfig) {
    loggedInvalidChronologicalSummaryConfig = true;
    console.warn(
      `[default:summaryFromAggregations] Invalid chronological summary config (${problems.join(", ")}) — falling back to defaults ` +
      `(maxInputTokens=${DEFAULT_MAX_UNIFIED_SUMMARY_INPUT_TOKENS}, windowSize=${DEFAULT_CHRONOLOGICAL_SUMMARY_WINDOW_SIZE}, overlap=${DEFAULT_CHRONOLOGICAL_SUMMARY_WINDOW_OVERLAP})`,
    );
  }
  return { maxInputTokens, windowSize, overlap };
}

/**
 * Rich schema for the unified summary (matches SummaryResult shape). The core
 * text fields are REQUIRED: with an all-optional schema the structured-outputs
 * grammar (required: []) permits the empty object, and models take that shortcut
 * (observed: Qwen3.8-27B-FP8 returned `{}` in ~200 ms, producing a video
 * summary with no title/keywords/summary and zero reported errors). Required
 * fields make `{}` impossible in guided mode and fail yup validation (triggering
 * callJson's correction retries) in prompt-only modes. Only the two nested
 * objects stay lenient so absent fields stay absent.
 */
export const unifiedSummarySchema = yup.object({
  title: yup.string().required(),
  abstract: yup.string().required(),
  keywords: yup.array().of(yup.string().required()).required(),
  tags: yup.array().of(yup.string().required()).required(),
  categorization: yup.string().required(),
  short_description: yup.string().required(),
  long_summary: yup.string().required(),
  overallIntention: yup.string().required(),
  narrativeArc: yup.string().required(),
  perceptionArc: yup.string().required(),
  perception_matrix: yup.object().optional(),
  qualityAttributes: yup.object(),
}).stripUnknown();

/**
 * Schema for one chronological sliding-window summary call: exactly one
 * paragraph per NEW HOA in the window plus only genuinely new keywords.
 */
export const chronologicalWindowSchema = yup.object({
  new_paragraphs: yup.array().of(yup.string().trim().min(1)).min(1).required(),
  new_keywords: yup.array().of(yup.string()),
}).stripUnknown();

/**
 * Deterministic case-insensitive keyword union: trims, compares lowercased,
 * keeps first-seen casing and order. Model output is a proposal — dedup is ours.
 */
function mergeKeywordsCaseInsensitive(existing: string[], incoming: unknown): string[] {
  const out = [...existing];
  const seen = new Set(out.map((k) => k.trim().toLowerCase()));
  if (!Array.isArray(incoming)) return out;
  for (const raw of incoming) {
    if (typeof raw !== "string") continue;
    const keyword = raw.trim();
    if (!keyword) continue;
    const key = keyword.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(keyword);
  }
  return out;
}

/**
 * Deterministic evidence filter for the unified summary (A1 case:
 * invented names/years in title/keywords/short_description — e.g. "Chaos
 * Lumination Camp 2015", "Camp 2025" — while long summaries were fine).
 *
 * The filter does not trust the model's evidence judgement; it re-checks:
 * - A keyword survives when its normalized form appears in a STABLE
 *   `# Visuelle Artefakte` table row (Temporale Stabilität ≥ 2, matching the
 *   prompt's sighting rule) OR at least twice anywhere in the HOA
 *   descriptions (variant misreads fragment and appear only once).
 * - A 4-digit year in title/short_description survives only when it appears
 *   in such a stable artifact table row.
 *
 * Removed items are recorded on result.evidenceFilter for review (visible,
 * never silent). The long free-text fields (abstract/long_summary) are NOT
 * filtered — compositional prose, policed by the prompt's fact rule.
 */
interface EvidenceFilterReport {
  removedKeywords: string[];
  removedYears: string[];
}

function normalizeEvidenceText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9äöüß]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Text of artifact table rows whose Temporale Stabilität is >= minStability.
 * Rows without a parseable stability column (header, separator, caption-level
 * 3-column tables) never qualify — they are single sightings by definition.
 */
function extractStableArtifactText(hoaText: string, minStability = 2): string {
  const rows: string[] = [];
  const sectionRe = /# Visuelle Artefakte([\s\S]*?)(?=\n# |$)/g;
  let section: RegExpExecArray | null;
  while ((section = sectionRe.exec(hoaText)) !== null) {
    for (const line of section[1].split("\n")) {
      const cells = line.split("|").map((c) => c.trim()).filter((c) => c.length > 0);
      if (cells.length < 4) continue;
      const stability = Number.parseInt(cells[cells.length - 1], 10);
      if (!Number.isFinite(stability)) continue;
      if (stability >= minStability) rows.push(cells.join(" "));
    }
  }
  return rows.join("\n");
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

export function filterUnifiedSummaryAgainstEvidence(
  summary: Record<string, unknown>,
  hoaText: string,
): Record<string, unknown> {
  const weakPool = normalizeEvidenceText(hoaText);
  const strongPool = normalizeEvidenceText(extractStableArtifactText(hoaText));
  const report: EvidenceFilterReport = { removedKeywords: [], removedYears: [] };

  if (Array.isArray(summary.keywords)) {
    summary.keywords = (summary.keywords as unknown[]).filter((raw) => {
      if (typeof raw !== "string") return false;
      const needle = normalizeEvidenceText(raw);
      if (needle.length < 4) return true;
      const evidenced = strongPool.includes(needle) || countOccurrences(weakPool, needle) >= 2;
      if (!evidenced) report.removedKeywords.push(raw);
      return evidenced;
    });
  }

  for (const field of ["title", "short_description"] as const) {
    const value = summary[field];
    if (typeof value !== "string") continue;
    const filtered = value.replace(/\b(19|20)\d{2}\b/g, (year) => {
      if (strongPool.includes(year)) return year;
      report.removedYears.push(year);
      return "";
    }).replace(/\s{2,}/g, " ").replace(/\s+([,.:;])/g, "$1").trim();
    summary[field] = filtered;
  }

  if (report.removedKeywords.length > 0 || report.removedYears.length > 0) {
    console.warn(
      `[default:filterUnifiedSummaryAgainstEvidence] removed unevidenced content: ` +
      `keywords=[${report.removedKeywords.join(", ")}] years=[${report.removedYears.join(", ")}]`,
    );
    summary.evidenceFilter = report;
  }
  return summary;
}

/**
 * Sliding-window chronological summarization (used when the concatenated HOA
 * descriptions exceed maxUnifiedSummaryInputTokens). Windows of `windowSize`
 * HOAs advance by `windowSize - overlap`, so each window after the first shares
 * its leading HOA(s) with the previous window (context only — not re-summarized).
 * Windows run SEQUENTIALLY because each carries the accumulated keywords and the
 * last paragraph forward. A failed window degrades to its raw HOA descriptions
 * (new ones only). The accumulated paragraphs + keywords then feed the regular
 * unified-summary prompt, and the final keywords are the deterministic union of
 * the collected window keywords and the model's own keywords.
 */
async function summarizeViaChronologicalWindows(
  hoaDescriptions: string[],
  windowSize: number,
  overlap: number,
  pluginDefinition: PostProcessingPluginDefinition<DefaultPostProcessingConfig>,
  api: PluginRpcApiCompositeInstance,
  modelConfig: ReturnType<typeof getModel>,
): Promise<JsonValue> {
  const stride = windowSize - overlap;
  const windows: Array<{ start: number; end: number }> = [];
  for (let start = 0; start < hoaDescriptions.length; start += stride) {
    const end = Math.min(start + windowSize, hoaDescriptions.length);
    windows.push({ start, end });
    if (end >= hoaDescriptions.length) break;
  }

  const paragraphs: string[] = [];
  let collectedKeywords: string[] = [];

  for (let w = 0; w < windows.length; w++) {
    const { start, end } = windows[w];
    // The first window summarizes all its HOAs; later windows treat the leading
    // `overlap` HOAs as context only and summarize the rest.
    const expectedNewCount = end - start - (w === 0 ? 0 : overlap);
    console.log(
      `[default:summaryFromAggregations] Chronological window ${w + 1}/${windows.length}: HOAs ${start + 1}–${end}`,
    );

    const windowHoaText = hoaDescriptions
      .slice(start, end)
      .map((desc, i) => `HOA ${start + i + 1}:\n${desc}`)
      .join("\n\n");
    const prompt = CHRONOLOGICAL_SUMMARY_TEMPLATE
      .replace(/{{WINDOW_HOA_DESCRIPTIONS}}/g, dedupePromptText(windowHoaText))
      .replace(/{{PREVIOUS_KEYWORDS}}/g, collectedKeywords.length > 0 ? collectedKeywords.join(", ") : "(keine — erstes Fenster)")
      .replace(/{{PREVIOUS_PARAGRAPH}}/g, paragraphs.length > 0 ? paragraphs[paragraphs.length - 1] : "(keine — erstes Fenster)")
      .replace(/{{NEW_HOA_COUNT}}/g, String(expectedNewCount));

    try {
      const windowResult = await api.mllm.callJson<{ new_paragraphs?: string[]; new_keywords?: string[] }>({
        endpoint: modelConfig.resolvedEndpoint,
        model: modelConfig.resolvedModel,
        apiKey: modelConfig.resolvedApiKey,
        filePaths: [],
        mediaCategory: "video",
        prompt,
        schema: chronologicalWindowSchema,
        enableThinking: false,
        jsonSchemaMode: modelConfig.jsonSchemaMode,
        jsonSchemaName: modelConfig.jsonSchemaName,
        structuredMaxTokens: modelConfig.structuredOutput?.maxTokens,
        structuredTemperature: modelConfig.structuredOutput?.temperature,
        structuredFrequencyPenalty: modelConfig.structuredOutput?.frequencyPenalty,
        structuredRepetitionPenalty: modelConfig.structuredOutput?.repetitionPenalty,
        repetitionDetection: modelConfig.resolvedRepetitionDetection,
        hyperparams: pluginDefinition.config?.hyperparams,
      });

      let newParagraphs = (windowResult.new_paragraphs ?? []).filter((p) => typeof p === "string" && p.trim().length > 0);
      if (newParagraphs.length > expectedNewCount) {
        // Extras can only be re-summaries of the overlap context — drop from the FRONT.
        console.warn(
          `[default:summaryFromAggregations] Window ${w + 1} returned ${newParagraphs.length} paragraphs, expected ${expectedNewCount} — dropping ${newParagraphs.length - expectedNewCount} from the front`,
        );
        newParagraphs = newParagraphs.slice(newParagraphs.length - expectedNewCount);
      } else if (newParagraphs.length < expectedNewCount) {
        console.warn(
          `[default:summaryFromAggregations] Window ${w + 1} returned ${newParagraphs.length} paragraphs, expected ${expectedNewCount} — accepting as-is`,
        );
      }
      paragraphs.push(...newParagraphs);
      collectedKeywords = mergeKeywordsCaseInsensitive(collectedKeywords, windowResult.new_keywords);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[default:summaryFromAggregations] Chronological window ${w + 1}/${windows.length} failed — using raw HOA descriptions instead: ${errMsg}`,
      );
      paragraphs.push(...hoaDescriptions.slice(start + (w === 0 ? 0 : overlap), end));
    }
  }

  const chronologicalSummary = paragraphs.map((p, i) => `${i + 1}. ${p}`).join("\n\n");
  const keywordLine = collectedKeywords.length > 0
    ? `\n\nBisher gesammelte Keywords: ${collectedKeywords.join(", ")}`
    : "";
  const finalPrompt = UNIFIED_SUMMARY_TEMPLATE.replace(/{{HOA_DESCRIPTIONS}}/g, dedupePromptText(`${chronologicalSummary}${keywordLine}`));

  const validated = await api.mllm.callJson<JsonValue>({
    endpoint: modelConfig.resolvedEndpoint,
    model: modelConfig.resolvedModel,
    apiKey: modelConfig.resolvedApiKey,
    filePaths: [],
    mediaCategory: "video",
    prompt: finalPrompt,
    schema: unifiedSummarySchema,
    enableThinking: false,
    jsonSchemaMode: modelConfig.jsonSchemaMode,
    jsonSchemaName: modelConfig.jsonSchemaName,
    structuredMaxTokens: modelConfig.structuredOutput?.maxTokens,
    structuredTemperature: modelConfig.structuredOutput?.temperature,
    structuredFrequencyPenalty: modelConfig.structuredOutput?.frequencyPenalty,
    structuredRepetitionPenalty: modelConfig.structuredOutput?.repetitionPenalty,
    repetitionDetection: modelConfig.resolvedRepetitionDetection,
    hyperparams: pluginDefinition.config?.hyperparams,
  });

  const result = (validated ?? {}) as Record<string, unknown>;
  result.keywords = mergeKeywordsCaseInsensitive(collectedKeywords, result.keywords);
  return filterUnifiedSummaryAgainstEvidence(result, hoaDescriptions.join("\n\n")) as JsonValue;
}

/**
 * Generate a whole-video summary. When higherOrderAggregations are available,
 * uses the unified-summary-prompt.md template to consume the HOA descriptions
 * (with their final markdown tables) and produce the rich SummaryResult shape
 * via CoT (title decided LAST). HOAs always exist when there is ≥1 aggregation
 * (1 aggregation → 1 HOA), so this unified path is the canonical one.
 * summaryFromTimeSlices handles the zero-aggregation edge case.
 */
export async function summaryFromAggregations(
  aggregations: SemanticAggregations,
  pluginDefinition: PostProcessingPluginDefinition<DefaultPostProcessingConfig>,
  api: PluginRpcApiCompositeInstance,
  _input?: PostProcessingInput,
  higherOrderAggregations?: HigherOrderAggregations,
): Promise<JsonValue> {
  if (aggregations.length === 0 && (!higherOrderAggregations || higherOrderAggregations.length === 0)) return null;

  const modelName = String(pluginDefinition.config?.modelName ?? DEFAULT_VLM_MODEL);
  const modelConfig = getModel(modelName);

  // ── PRIORITY 1: Unified summary from higher-order aggregations ──────────
  // When HOAs exist, consume ONLY their descriptions (which carry the final markdown
  // tables: # Visuelle Artefakte and # Human Perception Matrix). The description
  // field contains prose analysis + embedded tables. Title/intention reasoning is
  // derived by the summary model from these descriptions.
  if (higherOrderAggregations && higherOrderAggregations.length > 0 && UNIFIED_SUMMARY_TEMPLATE) {
    const hoaDescriptions = higherOrderAggregations.map(
      (hoa) => hoa.description || `Higher-Order Aggregation ${hoa.index + 1}: ${hoa.title}`,
    );
    const hoaText = hoaDescriptions.join("\n\n");

    const { maxInputTokens, windowSize, overlap } = sanitizeChronologicalSummaryConfig(pluginDefinition.config);
    const estimatedTokens = estimateTokens(hoaText);

    if (estimatedTokens > maxInputTokens) {
      console.log(
        `[default:summaryFromAggregations] Unified input ~${estimatedTokens} tokens exceeds budget ${maxInputTokens} — ` +
        `using chronological sliding-window summarization (windowSize=${windowSize}, overlap=${overlap})`,
      );
      if (!CHRONOLOGICAL_SUMMARY_TEMPLATE) {
        console.error("[default:summaryFromAggregations] Chronological summary template missing — falling back to aggregation-based");
      } else {
        try {
          return await summarizeViaChronologicalWindows(hoaDescriptions, windowSize, overlap, pluginDefinition, api, modelConfig);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error(`[default:summaryFromAggregations] Chronological windowed summary failed, falling back to aggregation-based: ${errMsg}`);
          // Fall through to the old path below
        }
      }
    } else {
      const prompt = UNIFIED_SUMMARY_TEMPLATE.replace(/{{HOA_DESCRIPTIONS}}/g, dedupePromptText(hoaText));

      console.log(`[default:summaryFromAggregations] Unified mode: ${higherOrderAggregations.length} HOAs, CoT title-last`);
      try {
        const validated = await api.mllm.callJson<JsonValue>({
          endpoint: modelConfig.resolvedEndpoint,
          model: modelConfig.resolvedModel,
          apiKey: modelConfig.resolvedApiKey,
          filePaths: [],
          mediaCategory: "video",
          prompt,
          schema: unifiedSummarySchema,
          // enableThinking stays false by default — CoT is expressed via the prompt
          enableThinking: false,
          jsonSchemaMode: modelConfig.jsonSchemaMode,
          jsonSchemaName: modelConfig.jsonSchemaName,
          structuredMaxTokens: modelConfig.structuredOutput?.maxTokens,
          structuredTemperature: modelConfig.structuredOutput?.temperature,
          structuredFrequencyPenalty: modelConfig.structuredOutput?.frequencyPenalty,
          structuredRepetitionPenalty: modelConfig.structuredOutput?.repetitionPenalty,
          repetitionDetection: modelConfig.resolvedRepetitionDetection,
          hyperparams: pluginDefinition.config?.hyperparams,
        });
        return filterUnifiedSummaryAgainstEvidence((validated ?? {}) as Record<string, unknown>, hoaText) as JsonValue;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[default:summaryFromAggregations] Unified summary failed, falling back to aggregation-based: ${errMsg}`);
        // Fall through to the old path below
      }
    }
  }

  // HOAs always exist when there is ≥1 aggregation (1 aggregation → 1 HOA).
  // When HOAs are absent (0 aggregations), the unified path above was skipped and
  // summaryFromTimeSlices handles the fallback. No progressive wholeSummarySchema
  // path is needed anymore.
  console.warn("[default:summaryFromAggregations] No HOAs available — returning null (summaryFromTimeSlices should handle this)");
  return null;
}

/**
 * Fallback when no aggregations were created: summarize from time slices directly.
 */
export async function summaryFromTimeSlices(
  input: PostProcessingInput,
  pluginDefinition: PostProcessingPluginDefinition<DefaultPostProcessingConfig>,
  api: PluginRpcApiCompositeInstance,
): Promise<JsonValue> {
  const modelName = String(pluginDefinition.config?.modelName ?? DEFAULT_VLM_MODEL);
  const modelConfig = getModel(modelName);
  const slices = input.timeSlices;

  if (slices.length === 0) return null;

  const sliceText = slices.map((s, i) => {
    const analysis = s.plugin?.["default"] as Record<string, unknown> | undefined;
    return `Schnitt ${i + 1} (${s.from} - ${s.to}):\n${JSON.stringify(analysis, null, 2)}`;
  }).join("\n\n");

  const prompt = WHOLE_SUMMARY_PROMPT.replace(/{{AGGREGATIONS}}/g, dedupePromptText(sliceText));

  try {
    const validated = await api.mllm.callJson<JsonValue>({
      endpoint: modelConfig.resolvedEndpoint,
      model: modelConfig.resolvedModel,
      apiKey: modelConfig.resolvedApiKey,
      filePaths: [],
      mediaCategory: "video",
      prompt,
      schema: wholeSummarySchema,
      enableThinking: false,
      jsonSchemaMode: modelConfig.jsonSchemaMode,
      jsonSchemaName: modelConfig.jsonSchemaName,
      structuredMaxTokens: modelConfig.structuredOutput?.maxTokens,
      structuredTemperature: modelConfig.structuredOutput?.temperature,
      structuredFrequencyPenalty: modelConfig.structuredOutput?.frequencyPenalty,
      structuredRepetitionPenalty: modelConfig.structuredOutput?.repetitionPenalty,
      repetitionDetection: modelConfig.resolvedRepetitionDetection,
      hyperparams: pluginDefinition.config?.hyperparams,
    });
    return validated;
  } catch (err) {
    console.error("[default:summaryFromTimeSlices] Failed (after retries):", err);
    return null;
  }
}

/**
 * Extract semantic profiles and detect long-range semantic relationships between aggregations.
 *
 * Uses the optimized O(n) approach: each aggregation gets ONE call that includes
 * all previous profiles as context. This provides:
 * - Stable semantic vocabulary (LLM sees previous profiles)
 * - Holistic relationship detection (considers all previous at once)
 * - O(n) calls instead of O(n²)
 *
 * After this function runs, each aggregation will have:
 * - semanticProfile: multi-dimensional profile (topics, setting, speakers, mood, etc.)
 * - belongsToSemantically: array of aggregation IDs this one relates to
 */
export async function extractSemanticProfiles(
  aggregations: SemanticAggregation[],
  pluginDefinition: PostProcessingPluginDefinition<DefaultPostProcessingConfig>,
  api: PluginRpcApiCompositeInstance,
): Promise<void> {
  const enabled = pluginDefinition.config?.extractSemanticProfiles ?? true;
  if (!enabled) {
    console.log("[default:extractSemanticProfiles] Disabled by config, skipping");
    return;
  }

  if (aggregations.length === 0) {
    console.log("[default:extractSemanticProfiles] No aggregations to process");
    return;
  }

  const modelName = String(pluginDefinition.config?.modelName ?? DEFAULT_VLM_MODEL);
  const modelConfig = getModel(modelName);

  // Build previous profiles context incrementally
  let previousProfilesText = "";

  for (let i = 0; i < aggregations.length; i++) {
    const current = aggregations[i];

    // Skip if no analysis to extract profile from
    if (!current.analysis) {
      console.log(`[default:extractSemanticProfiles] Aggregation ${current.id} has no analysis, skipping`);
      continue;
    }

    // Build prompt with all previous profiles as context
    const prompt = SEMANTIC_PROFILE_WITH_CONTEXT_PROMPT
      .replace(/{{PREVIOUS_PROFILES}}/g, previousProfilesText || "(none - this is the first aggregation)")
      .replace(/{{CURRENT_AGG_ID}}/g, current.id)
      .replace(/{{CURRENT_AGGREGATION}}/g, JSON.stringify(current.analysis, null, 2));

    try {
      const result = await api.mllm.callJson<SemanticProfileWithRelationships>({
        endpoint: modelConfig.resolvedEndpoint,
        model: modelConfig.resolvedModel,
        apiKey: modelConfig.resolvedApiKey,
        filePaths: [],
        mediaCategory: "video",
        prompt,
        schema: semanticProfileWithRelationshipsSchema,
        enableThinking: false,
        jsonSchemaMode: modelConfig.jsonSchemaMode,
        jsonSchemaName: modelConfig.jsonSchemaName,
        structuredMaxTokens: modelConfig.structuredOutput?.maxTokens,
        structuredTemperature: modelConfig.structuredOutput?.temperature,
        structuredFrequencyPenalty: modelConfig.structuredOutput?.frequencyPenalty,
        structuredRepetitionPenalty: modelConfig.structuredOutput?.repetitionPenalty,
        repetitionDetection: modelConfig.resolvedRepetitionDetection,
        hyperparams: pluginDefinition.config?.hyperparams,
      });

      // Store results in aggregation
      current.semanticProfile = result.profile;
      current.belongsToSemantically = result.relatedAggregationIds;

      console.log(`[default:extractSemanticProfiles] ${current.id}: ${result.profile.topics.length} topics, ${result.relatedAggregationIds.length} semantic links`);

      // Append current profile to context for next iteration
      previousProfilesText += `\n\n#${current.id}: ${JSON.stringify(result.profile, null, 2)}`;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[default:extractSemanticProfiles] Failed for ${current.id}:`, errMsg);
      // Continue with next aggregation on error (graceful degradation)
    }
  }

  console.log(`[default:extractSemanticProfiles] Complete: ${aggregations.length} aggregations processed`);
}

// ============================================================================
// Phase 4.5: Aggregation transition enrichment
// ============================================================================

/** Schema for the per-pair transition analysis (exported for tooling/tests). */
export const transitionSchema = yup.object({
  relationship_to_previous: yup.string().oneOf([...RELATIONSHIP_LABELS]).required(),
  transition_description: yup.string().required(),
}).stripUnknown();

/** Prompt for describing how an aggregation connects to its predecessor. */
export const TRANSITION_PROMPT = `Du analysierst zwei aufeinanderfolgende Beitraege (semantische Aggregationen) aus einem Video. Bestimme, wie Beitrag B an Beitrag A anschliesst.

AUFGABE:
1. Waehle genau eines der Beziehungs-Labels, das das Verhaeltnis von B zu A am besten beschreibt.
2. Beschreibe in 1-2 Saetzen den Uebergang: Wie schliesst Beitrag B an Beitrag A an (Fortsetzung, Vertiefung, Kontrast, Themenwechsel etc.)?

Beitrag A (vorheriger): {{AGG_PREV}}
Beitrag B (aktueller): {{AGG_CURR}}

Gib direkt gueltiges JSON in folgendem Format ohne JSON-Fences zurueck:
{
  "relationship_to_previous": "Eines der Labels: ` + RELATIONSHIP_LABELS.join("|") + `",
  "transition_description": "1-2 Saetze: wie schliesst Beitrag B an Beitrag A an"
}

` + EDITORIAL_CONTENT_RULE_DECISION;

/**
 * Enrich boundary transitions between adjacent aggregations.
 *
 * Runs after all aggregation analyses and profile extraction are finished
 * (analyses final and immutable), so each adjacent pair (agg[i-1], agg[i]) can
 * be judged independently under bounded concurrency — this structurally solves
 * the "parallel caption batches lose the boundary" problem of the slice-level
 * relationship_to_previous. For each pair one small TEXT-ONLY model call
 * returns a reliable relationship label plus a transition description, written
 * into agg[i].analysis (overwriting the unreliable slice-derived label).
 *
 * Graceful degradation: a failed pair call logs and leaves that aggregation's
 * existing values untouched; never throws.
 * Opt-out via config.enrichTransitions = false (default: true).
 */
export async function enrichAggregationTransitions(
  aggregations: SemanticAggregations,
  pluginDefinition: PostProcessingPluginDefinition<DefaultPostProcessingConfig>,
  api: PluginRpcApiCompositeInstance,
): Promise<void> {
  const enabled = pluginDefinition.config?.enrichTransitions !== false;
  if (!enabled) {
    console.log("[default:enrichAggregationTransitions] Disabled by config, skipping");
    return;
  }
  if (aggregations.length < 2) {
    console.log("[default:enrichAggregationTransitions] Fewer than 2 aggregations, nothing to enrich");
    return;
  }

  const modelName = String(pluginDefinition.config?.modelName ?? DEFAULT_VLM_MODEL);
  const modelConfig = getModel(modelName);

  const pairs = aggregations.slice(1).map((curr, i) => ({ prev: aggregations[i], curr }));
  console.log(`[default:enrichAggregationTransitions] Enriching ${pairs.length} adjacent pairs`);

  await api.util.limitConcurrency(
    pairs,
    Number(pluginDefinition.config?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY),
    async ({ prev, curr }) => {
      try {
        const prompt = TRANSITION_PROMPT
          .replace(/{{AGG_PREV}}/g, aggregationToText(prev))
          .replace(/{{AGG_CURR}}/g, aggregationToText(curr));
        const validated = await api.mllm.callJson<{
          relationship_to_previous: string;
          transition_description: string;
        }>({
          endpoint: modelConfig.resolvedEndpoint,
          model: modelConfig.resolvedModel,
          apiKey: modelConfig.resolvedApiKey,
          filePaths: [],
          mediaCategory: "video",
          prompt,
          schema: transitionSchema,
          enableThinking: false,
          jsonSchemaMode: modelConfig.jsonSchemaMode,
          jsonSchemaName: modelConfig.jsonSchemaName,
          structuredMaxTokens: modelConfig.structuredOutput?.maxTokens,
          structuredTemperature: modelConfig.structuredOutput?.temperature,
          structuredFrequencyPenalty: modelConfig.structuredOutput?.frequencyPenalty,
          structuredRepetitionPenalty: modelConfig.structuredOutput?.repetitionPenalty,
          repetitionDetection: modelConfig.resolvedRepetitionDetection,
          hyperparams: pluginDefinition.config?.hyperparams,
        });
        const analysis = { ...((curr.analysis ?? {}) as Record<string, unknown>) };
        analysis.relationship_to_previous = validated.relationship_to_previous;
        analysis.transition_description = validated.transition_description;
        curr.analysis = analysis as JsonValue;
      } catch (err) {
        // Leave this aggregation's existing values untouched.
        console.error(
          `[default:enrichAggregationTransitions] Pair ${prev.index} -> ${curr.index} failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    },
  );
}

// ============================================================================
// Phase 5: Higher-Order Aggregation
// ============================================================================

// Resolve and load the external HOA prompt template once at module load.
// Kept external (per project convention: never inline prompt templates).
const _hoaModuleDir = dirname(fileURLToPath(import.meta.url));
const HOA_TEMPLATE_PATH = resolve(_hoaModuleDir, "../src/lib/higher-order-aggregation-prompt.md");
let HOA_PROMPT_TEMPLATE = "";
try {
  HOA_PROMPT_TEMPLATE = readFileSync(HOA_TEMPLATE_PATH, "utf-8");
} catch (err) {
  console.warn(
    `[default:higher-order] Could not load HOA template from ${HOA_TEMPLATE_PATH}: ` +
    `${err instanceof Error ? err.message : String(err)}`,
  );
}

/** Intention classification labels shared by HOA analysis and the summary engine. */
export const INTENTION_LABELS = [
  "INFORMATIONAL",
  "PROMOTIONAL",
  "NARRATIVE",
  "ARGUMENTATIVE",
  "CEREMONIAL",
  "INSTRUCTIONAL",
  "AMBIGUOUS",
] as const;

/** Schema for a single higher-order aggregation analysis (exported for tooling/tests). */
export const higherOrderAggregationSchema = yup.object({
  title: yup.string().required(),
  description: yup.string().required(),
  compositional_structure: yup.string().optional(),
  intention_classification: yup.string().oneOf([...INTENTION_LABELS]).required(),
  // Shapeless so the model's perception_matrix passes through verbatim (no
  // materialised `{}` entries); structure is documented in the prompt template.
  perception_matrix: yup.object().optional(),
  visual_artifacts: yup.array().of(visualArtifactSchema).optional(),
}).stripUnknown();

/** Prompt for deciding whether two adjacent aggregations belong to the same HOA. */
export const HOA_DECISION_PROMPT = `Du vergleichst zwei semantische Aggregationen (Beitraege) aus einem Video. Entscheide, ob sie zum selben UEBERGEORDNETEN Abschnitt (Higher-Order Aggregation) gehoeren — z.B. derselben Nachrichtensendung, demselben Themenblock, derselben Reportage oder demselben Werbeblock.

KRITERIEN fuer "true" (selber uebergeordneter Abschnitt):
- Gleicher uebergeordneter Rahmen (z.B. beide Teile derselben Nachrichtensendung)
- Dasselbe durchgehende Thema oder derselbe Story-Arc ueber mehrere Beitraege hinweg
- Gleiche Sendungsstruktur (z.B. Nachrichten-Opener + Hauptbeitraege + Closer)
- Visuell/inhaltlich erkennbar als zusammenhaengender Block

KRITERIEN fuer "false" (unterschiedliche uebergeordnete Abschnitte):
- Eindeutiger Themenwechsel/Genrewechsel (z.B. Nachrichten -> Werbung)
- Voellig anderer Rahmen (z.B. Nachrichtensendung -> eigenstaendiger Trailer)
- Ein Block ist Werbung/Sponsoring, der andere redaktioneller Inhalt
- Starke Unsicherheit? -> false

Aggregation A: {{AGG1}}
Aggregation B: {{AGG2}}

Gib direkt gueltiges JSON in folgendem Format ohne JSON-Fences zurueck:
{
  "same_contribution": true|false,
  "reason": "kurze Begruendung"
}`;

/**
 * Build a compact textual summary of an aggregation's analysis. Used both for
 * HOA boundary decisions and for the constituent-aggregation display passed to
 * the HOA model. Includes the analysis summary, relationship label, transition
 * description, perception matrix and accumulated visual artifacts so the model
 * can reason about the composition and recurring artifacts across the
 * macro-section.
 */
export function aggregationToText(agg: SemanticAggregation): string {
  const analysis = (agg.analysis ?? {}) as Record<string, unknown>;
  const parts: string[] = [`Aggregation ${agg.index + 1} (${agg.from} - ${agg.to}):`];
  if (analysis?.summary) parts.push(`Zusammenfassung: ${analysis.summary}`);
  if (analysis?.relationship_to_previous) {
    parts.push(`Beziehung zur vorherigen: ${analysis.relationship_to_previous}`);
  }
  if (analysis?.transition_description) {
    parts.push(`Übergang von vorheriger: ${analysis.transition_description}`);
  }
  if (analysis?.perception_matrix) {
    const pm = analysis.perception_matrix as Record<string, Record<string, unknown> | undefined>;
    const pmStr = Object.entries(pm)
      .filter(([, v]) => v)
      .map(([cat, v]) => `${cat}=${v?.keyword ?? "?"}(${v?.confidence ?? "?"})`)
      .join(", ");
    if (pmStr) parts.push(`Wahrnehmung: ${pmStr}`);
  }
  if (Array.isArray(analysis?.visual_artifacts) && analysis.visual_artifacts.length > 0) {
    const arts = (analysis.visual_artifacts as Array<Record<string, unknown>>)
      .map((a) => `${a?.artifact}="${a?.exact_caption}" (stability=${a?.temporal_stability})`)
      .join("; ");
    parts.push(`Visuelle Artefakte: ${arts}`);
  }
  const rawCaption = analysis?.raw_caption as string | undefined;
  if (rawCaption && rawCaption.trim().length >= 10) parts.push(rawCaption);
  return parts.join("\n");
}

/**
 * Normalize a model-emitted confidence to 0..1. Models naturally emit
 * percentages: "95%" and "95" mean 0.95; "0.95" and 0.85 are ratios; anything
 * > 1 is treated as a percentage. Unparseable input falls back to 0.5.
 * Exported for tooling/e2e tests.
 */
export function parseConfidence(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.min(1, Math.max(0, value > 1 ? value / 100 : value));
  }
  const m = /(\d{1,3}(?:\.\d+)?)/.exec(String(value ?? ""));
  if (!m) return 0.5;
  const n = Number(m[1]);
  return Math.min(1, Math.max(0, n > 1 ? n / 100 : n));
}

/** Coerce a loosely-typed model artifact object into a typed VisualArtifact. */
function toVisualArtifact(a: Record<string, unknown>): VisualArtifact {
  return {
    artifact: String(a?.artifact ?? ""),
    exactCaption: String(a?.exact_caption ?? ""),
    confidence: parseConfidence(a?.confidence),
    temporalStability: Number(a?.temporal_stability ?? 1),
  };
}

/** Coerce a loosely-typed perception matrix into the typed PerceptionMatrix. */
function normalizePerceptionMatrix(
  pm: Record<string, Record<string, unknown> | undefined>,
): PerceptionMatrix {
  const norm = (e: Record<string, unknown> | undefined) =>
    e ? { keyword: String(e.keyword ?? "unclear"), confidence: parseConfidence(e.confidence) } : undefined;
  return {
    rhetoric: pm.rhetoric ? norm(pm.rhetoric) : undefined,
    framing: pm.framing ? norm(pm.framing) : undefined,
    emotion: pm.emotion ? norm(pm.emotion) : undefined,
  };
}

/**
 * Merge the accumulated visual_artifacts tables from several aggregations into
 * a single HOA-level table. This is the aggregation → HOA accumulation step:
 * each unique artifact's temporal_stability values are summed across the
 * constituent aggregations, and the highest confidence wins.
 */
function mergeAggregationArtifacts(aggregations: SemanticAggregation[]): VisualArtifact[] {
  const byKey = new Map<string, VisualArtifact>();
  for (const agg of aggregations) {
    const analysis = (agg.analysis ?? {}) as Record<string, unknown>;
    if (!Array.isArray(analysis?.visual_artifacts)) continue;
    for (const a of analysis.visual_artifacts as Array<Record<string, unknown>>) {
      const artifact = String(a?.artifact ?? "");
      if (!artifact) continue;
      const exactCaption = String(a?.exact_caption ?? "");
      const confidence = parseConfidence(a?.confidence);
      const stability = Number(a?.temporal_stability ?? 1);
      const key = `${artifact.trim().toLowerCase()}::${exactCaption.trim().toLowerCase()}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.temporalStability += stability;
        if (confidence > existing.confidence) existing.confidence = confidence;
      } else {
        byKey.set(key, { artifact, exactCaption, confidence, temporalStability: stability });
      }
    }
  }
  return Array.from(byKey.values()).sort((a, b) => b.temporalStability - a.temporalStability);
}

/**
 * Decide whether two adjacent aggregations belong to the same higher-order
 * macro-section. Mirrors decideForAggregation's pattern but compares whole
 * aggregation analyses instead of slices, using the HOA decision prompt.
 * Defaults to false on any error to avoid false merges.
 */
async function decideForHigherOrderAggregation(
  aggA: SemanticAggregation,
  aggB: SemanticAggregation,
  pluginDefinition: PostProcessingPluginDefinition<DefaultPostProcessingConfig>,
  api: PluginRpcApiCompositeInstance,
): Promise<boolean> {
  const modelName = String(pluginDefinition.config?.modelName ?? DEFAULT_VLM_MODEL);
  const modelConfig = getModel(modelName);
  const prompt = HOA_DECISION_PROMPT
    .replace(/{{AGG1}}/g, aggregationToText(aggA))
    .replace(/{{AGG2}}/g, aggregationToText(aggB));
  try {
    const validated = await api.mllm.callJson<{ same_contribution: boolean }>({
      endpoint: modelConfig.resolvedEndpoint,
      model: modelConfig.resolvedModel,
      apiKey: modelConfig.resolvedApiKey,
      filePaths: [],
      mediaCategory: "video",
      prompt,
      schema: aggregationDecisionSchema,
      enableThinking: false,
      jsonSchemaMode: modelConfig.jsonSchemaMode,
      jsonSchemaName: modelConfig.jsonSchemaName,
      structuredMaxTokens: modelConfig.structuredOutput?.maxTokens,
      structuredTemperature: modelConfig.structuredOutput?.temperature,
      structuredFrequencyPenalty: modelConfig.structuredOutput?.frequencyPenalty,
      structuredRepetitionPenalty: modelConfig.structuredOutput?.repetitionPenalty,
      repetitionDetection: modelConfig.resolvedRepetitionDetection,
      hyperparams: pluginDefinition.config?.hyperparams,
    });
    return Boolean(validated.same_contribution);
  } catch {
    // Default to false on error to avoid merging unrelated sections
    return false;
  }
}

/**
 * Group semantic aggregations into higher-order aggregations (macro-sections).
 *
 * For each HOA it:
 *  1. Detects semantic boundaries between adjacent aggregations (same pattern
 *     as decideForAggregation, but operating on aggregations).
 *  2. For each group, calls the model with enableThinking: false to produce a
 *     title, description, merged artifact table, perception matrix and an
 *     intention classification.
 *  3. Pre-merges the constituent aggregations' visual artifacts so the merged
 *     table is always present even when the model omits visual_artifacts.
 *
 * Opt-out via config.enableHigherOrderAggregation = false (default: true).
 * Gracefully degrades: a failed HOA call still produces a HOA entry with the
 * pre-merged artifacts and no model-derived title/description.
 */
export async function postProcessHigherOrderAggregations(
  aggregations: SemanticAggregations,
  pluginDefinition: PostProcessingPluginDefinition<DefaultPostProcessingConfig>,
  api: PluginRpcApiCompositeInstance,
): Promise<HigherOrderAggregations> {
  const enabled = pluginDefinition.config?.enableHigherOrderAggregation !== false;
  if (!enabled) {
    console.log("[default:postProcessHigherOrderAggregations] Disabled by config, skipping");
    return [];
  }
  if (aggregations.length === 0) {
    console.log("[default:postProcessHigherOrderAggregations] No aggregations to process");
    return [];
  }

  const modelName = String(pluginDefinition.config?.modelName ?? DEFAULT_VLM_MODEL);
  const modelConfig = getModel(modelName);

  // 1. Detect semantic boundaries between aggregations -> group into HOAs
  const groups: number[][] = [];
  let currentGroup: number[] = [0];
  for (let i = 1; i < aggregations.length; i++) {
    const belongs = await decideForHigherOrderAggregation(
      aggregations[i - 1], aggregations[i], pluginDefinition, api,
    );
    if (belongs) {
      currentGroup.push(i);
    } else {
      groups.push(currentGroup);
      currentGroup = [i];
    }
  }
  if (currentGroup.length > 0) groups.push(currentGroup);

  // Enforce minimum aggregations per HOA so a macro-section is never a lone
  // singleton when there is more than one aggregation. Disabled when the video
  // produced only a single aggregation (then a 1-agg HOA is the global fallback)
  // or when minAggregationsPerHigherOrder <= 1 (opt-out).
  const minAggsPerHoa = Number(pluginDefinition.config?.minAggregationsPerHigherOrder ?? 2);
  if (minAggsPerHoa > 1 && groups.length > 1) {
    const enforced = enforceMinGroupSize(
      groups,
      (grp: number[]) => grp.length < minAggsPerHoa,
    );
    groups.splice(0, groups.length, ...enforced);
  }

  console.log(
    `[default:postProcessHigherOrderAggregations] Grouped ${aggregations.length} aggregations into ${groups.length} higher-order aggregations`,
  );

  const hoas: HigherOrderAggregation[] = [];
  for (let h = 0; h < groups.length; h++) {
    const groupIndexes = groups[h];
    const constituentAggs = groupIndexes.map((gi) => aggregations[gi]);

    // Pre-merge accumulated artifacts (aggregation -> HOA accumulation step)
    const preMergedArtifacts = mergeAggregationArtifacts(constituentAggs);

    try {
      if (!HOA_PROMPT_TEMPLATE) {
        throw new Error(`HOA prompt template not loaded from ${HOA_TEMPLATE_PATH}`);
      }

      const constituentsText = constituentAggs.map((a) => aggregationToText(a)).join("\n\n");
      const prompt = HOA_PROMPT_TEMPLATE.replace(/{{CONSTITUENT_AGGREGATIONS}}/g, dedupePromptText(constituentsText));

      const validated = await api.mllm.callJson<JsonValue>({
        endpoint: modelConfig.resolvedEndpoint,
        model: modelConfig.resolvedModel,
        apiKey: modelConfig.resolvedApiKey,
        filePaths: [],
        mediaCategory: "video",
        prompt,
        schema: higherOrderAggregationSchema,
        // enableThinking stays false by default. Compositional/CoT reasoning is
        // expressed via the prompt's explicit step-by-step instructions, not via
        // the model's native thinking mode.
        enableThinking: false,
        jsonSchemaMode: modelConfig.jsonSchemaMode,
        jsonSchemaName: modelConfig.jsonSchemaName,
        structuredMaxTokens: modelConfig.structuredOutput?.maxTokens,
        structuredTemperature: modelConfig.structuredOutput?.temperature,
        structuredFrequencyPenalty: modelConfig.structuredOutput?.frequencyPenalty,
        structuredRepetitionPenalty: modelConfig.structuredOutput?.repetitionPenalty,
        repetitionDetection: modelConfig.resolvedRepetitionDetection,
        hyperparams: pluginDefinition.config?.hyperparams,
      });

      const v = (validated ?? {}) as Record<string, unknown>;
      // Prefer the model's artifacts; fall back to the pre-merged table
      const modelArtifactsRaw = Array.isArray(v?.visual_artifacts) ? v.visual_artifacts : null;
      const artifacts: VisualArtifact[] = modelArtifactsRaw
        ? (modelArtifactsRaw as Array<Record<string, unknown>>).map(toVisualArtifact)
        : preMergedArtifacts;

      const pm = v?.perception_matrix as Record<string, Record<string, unknown> | undefined> | undefined;

      hoas.push({
        id: `default:higherOrderAggregation:${h}`,
        index: h,
        title: String(v?.title ?? `Higher-Order Aggregation ${h + 1}`),
        description: String(v?.description ?? ""),
        aggregationIndexes: groupIndexes,
        visualArtifacts: artifacts,
        perceptionMatrix: pm ? normalizePerceptionMatrix(pm) : undefined,
        intentionClassification: v?.intention_classification
          ? String(v.intention_classification)
          : undefined,
      });
      console.log(
        `[default:postProcessHigherOrderAggregations] HOA ${h}: "${v?.title ?? "?"}" ` +
        `(${groupIndexes.length} aggregations, ${artifacts.length} artifacts)`,
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[default:postProcessHigherOrderAggregations] Failed for HOA ${h}: ${errMsg}`);
      // Graceful fallback: still emit a HOA with pre-merged artifacts and no model analysis
      hoas.push({
        id: `default:higherOrderAggregation:${h}`,
        index: h,
        title: `Higher-Order Aggregation ${h + 1}`,
        description: "",
        aggregationIndexes: groupIndexes,
        visualArtifacts: preMergedArtifacts,
      });
    }
  }

  return hoas;
}
