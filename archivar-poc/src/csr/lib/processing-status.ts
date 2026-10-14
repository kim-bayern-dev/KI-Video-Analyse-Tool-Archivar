/**
 * Maps one streamed debug.log line to an i18n status key for the upload
 * wizard's step-5 status line. Patterns mirror the workflow engine's actual
 * log producers (verified against a real debug.log — see
 * src/rpc/workflow-engine.ts and the [STEP x/10]/[PROCESSING]/[POST-PROCESSING]
 * prefixes); if those formats change, matching silently stops and the status
 * line just freezes — the log view itself is unaffected.
 */
export interface ProcessingStatus {
  /** i18n key under upload_wizard.log_status_* */
  key: string;
  /** Interpolation params for t() ({{var}} placeholders). */
  params?: Record<string, string>;
}

interface StatusRule {
  pattern: RegExp;
  key: string;
  toParams?: (m: RegExpMatchArray) => Record<string, string>;
}

// Order = priority; first match wins.
const RULES: StatusRule[] = [
  {
    pattern: /^\[STEP \d+\/10\] Running pre-processing/,
    key: "upload_wizard.log_status_preprocessing_running",
  },
  {
    pattern: /Pre-processing done — scenes: (\d+), speech: (\d+)/,
    key: "upload_wizard.log_status_preprocessing_done",
    toParams: (m) => ({ scenes: m[1], speech: m[2] }),
  },
  {
    pattern: /^\[STEP \d+\/10\] Enabled steps: (.+)/,
    key: "upload_wizard.log_status_analysis_enabled",
    toParams: (m) => ({ steps: m[1].trim() }),
  },
  {
    pattern: /^\[PROCESSING\] (\w+): (\d+) segments, model: ([^,]+)/,
    key: "upload_wizard.log_status_analysis_step",
    toParams: (m) => ({ type: m[1], count: m[2], model: m[3].trim() }),
  },
  {
    pattern: /^\[PROCESSING\] All processing groups completed/,
    key: "upload_wizard.log_status_analysis_done",
  },
  {
    pattern: /^\[POST-PROCESSING\] Running plugin "([^"]+)"/,
    key: "upload_wizard.log_status_postprocessing_plugin",
    toParams: (m) => ({ plugin: m[1] }),
  },
  {
    pattern: /^=== WORKFLOW COMPLETE/,
    key: "upload_wizard.log_status_workflow_done",
  },
];

/** Returns the status for a log line, or null when the line is not a phase marker. */
export function matchProcessingLine(line: string): ProcessingStatus | null {
  for (const rule of RULES) {
    const m = line.match(rule.pattern);
    if (m) {
      return { key: rule.key, params: rule.toParams?.(m) };
    }
  }
  return null;
}

// ── Real progress model ────────────────────────────────────────────────────
// A second matcher maps log lines to progress EVENTS; applyProgressEvent
// folds them into a small state machine. The bar is determinate wherever the
// log discloses totals (segments after "Pre-processing done", slices after
// "Starting — N slices total") and creeps within its phase window elsewhere.
// Cached runs undercount per-segment [TIMER] lines, so the explicit
// completion markers snap their phase to full as a correction.

/** Progress bar windows per phase, in percent [lo, hi]. */
export const BAR_WINDOW = {
  pre: [5, 15],
  proc: [15, 70],
  post: [70, 95],
  final: [95, 99],
} as const;

export type ProgressPhase = keyof typeof BAR_WINDOW;

export interface ProcessingProgress {
  phase: ProgressPhase;
  segmentsTotal: number;
  segmentsDone: number;
  postPluginsTotal: number;
  postPluginIndex: number;
  slicesTotal: number;
  slicesDone: number;
}

export const createProcessingProgress = (): ProcessingProgress => ({
  phase: "pre",
  segmentsTotal: 0,
  segmentsDone: 0,
  postPluginsTotal: 1,
  postPluginIndex: 0,
  slicesTotal: 0,
  slicesDone: 0,
});

export type ProgressEvent =
  | { type: "phase"; phase: "proc" | "final" }
  | { type: "segments_total"; count: number }
  | { type: "segment_done" }
  | { type: "processing_done" }
  | { type: "post_plugins"; count: number }
  | { type: "post_start"; totalSlices: number }
  | { type: "slice_done" }
  | { type: "post_done" };

const PROGRESS_RULES: Array<{ pattern: RegExp; toEvent: (m: RegExpMatchArray) => ProgressEvent }> = [
  { pattern: /Pre-processing done — scenes: /, toEvent: () => ({ type: "phase", phase: "proc" }) },
  {
    pattern: /^\[PROCESSING\] \w+: (\d+) segments, model: /,
    toEvent: (m) => ({ type: "segments_total", count: Number(m[1]) }),
  },
  { pattern: /^\[TIMER\] \w+ segment #\d+:/, toEvent: () => ({ type: "segment_done" }) },
  {
    pattern: /^\[PROCESSING\] All processing groups completed|^\[STEP \d+\/10\] Processing steps complete/,
    toEvent: () => ({ type: "processing_done" }),
  },
  {
    pattern: /^\[STEP \d+\/10\] Plugins to run: (.+)$/,
    toEvent: (m) => ({ type: "post_plugins", count: m[1].split(",").length }),
  },
  {
    pattern: /:postProcessPerTimeSlice\] Starting — (\d+) slices total/,
    toEvent: (m) => ({ type: "post_start", totalSlices: Number(m[1]) }),
  },
  {
    pattern: /:postProcessPerTimeSlice\] \[\d+\/\d+\] Completed slice /,
    toEvent: () => ({ type: "slice_done" }),
  },
  {
    pattern: /:postProcessPerTimeSlice\] Completed all \d+ slices/,
    toEvent: () => ({ type: "post_done" }),
  },
  { pattern: /^\[STEP (?:9|10)\/10\] /, toEvent: () => ({ type: "phase", phase: "final" }) },
];

/** Returns the progress event for a log line, or null when it carries none. */
export function matchProgressLine(line: string): ProgressEvent | null {
  for (const rule of PROGRESS_RULES) {
    const m = line.match(rule.pattern);
    if (m) return rule.toEvent(m);
  }
  return null;
}

/** Folds one event into the progress state (mutating; phase moves forward only). */
export function applyProgressEvent(p: ProcessingProgress, ev: ProgressEvent): void {
  switch (ev.type) {
    case "phase":
      if (ev.phase === "proc" && p.phase === "pre") p.phase = "proc";
      if (ev.phase === "final") p.phase = "final";
      break;
    case "segments_total":
      p.segmentsTotal += ev.count;
      break;
    case "segment_done":
      p.segmentsDone++;
      break;
    case "processing_done":
      // Corrects undercounting from cache hits (cached segments log no [TIMER]).
      p.segmentsDone = p.segmentsTotal;
      if (p.phase === "proc") p.phase = "post";
      break;
    case "post_plugins":
      p.postPluginsTotal = Math.max(1, ev.count);
      break;
    case "post_start":
      if (p.phase !== "final") p.phase = "post";
      p.postPluginIndex++;
      p.slicesTotal = ev.totalSlices;
      p.slicesDone = 0;
      break;
    case "slice_done":
      p.slicesDone++;
      break;
    case "post_done":
      p.slicesDone = p.slicesTotal;
      break;
  }
}

/**
 * Bar value for determinate phases, or null when the phase has no disclosed
 * totals yet (then the caller creeps within the phase window instead).
 */
export function determinateBarValue(p: ProcessingProgress): number | null {
  if (p.phase === "proc" && p.segmentsTotal > 0) {
    const [lo, hi] = BAR_WINDOW.proc;
    return Math.min(hi, lo + (hi - lo) * (p.segmentsDone / p.segmentsTotal));
  }
  if (p.phase === "post") {
    const [lo, hi] = BAR_WINDOW.post;
    // Processing done but slice totals not seen yet: hold the window floor.
    if (p.slicesTotal === 0) return lo;
    const pluginsDone = p.postPluginIndex - 1 + p.slicesDone / p.slicesTotal;
    return Math.min(hi, lo + (hi - lo) * (pluginsDone / p.postPluginsTotal));
  }
  return null;
}

/** Creep window for phases without disclosed totals: a small slice above lo. */
export function creepBarValue(phase: ProgressPhase, current: number): number {
  const [lo, hi] = BAR_WINDOW[phase];
  const cap = phase === "pre" || phase === "final" ? hi : lo + 3;
  const next = current + 0.5;
  return next >= cap ? lo : next;
}
