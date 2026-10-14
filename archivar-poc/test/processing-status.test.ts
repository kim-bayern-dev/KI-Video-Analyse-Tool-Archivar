/**
 * Unit tests for matchProcessingLine (src/csr/lib/processing-status.ts):
 * the RegExp table that maps streamed debug.log lines to step-5 status keys.
 * Sample lines are taken verbatim from a real workflow debug.log
 * (C1_Klimaneutrale_Produkte_kurzerklaert_truncated_35b.mp4.archivar).
 */
import { describe, it, expect } from "vitest";
import {
  matchProcessingLine,
  matchProgressLine,
  applyProgressEvent,
  determinateBarValue,
  creepBarValue,
  createProcessingProgress,
  BAR_WINDOW,
} from "../src/csr/lib/processing-status.js";

describe("matchProcessingLine", () => {
  it("matches the pre-processing start marker", () => {
    expect(matchProcessingLine("[STEP 2/10] Running pre-processing...")).toEqual({
      key: "upload_wizard.log_status_preprocessing_running",
      params: undefined,
    });
  });

  it("matches the pre-processing done marker with scene/speech counts", () => {
    expect(
      matchProcessingLine("[STEP 2/10] Pre-processing done — scenes: 4, speech: 0, harmonic: 1, noise: 0"),
    ).toEqual({
      key: "upload_wizard.log_status_preprocessing_done",
      params: { scenes: "4", speech: "0" },
    });
  });

  it("matches the enabled-steps marker", () => {
    expect(matchProcessingLine("[STEP 5/10] Enabled steps: scene, speech")).toEqual({
      key: "upload_wizard.log_status_analysis_enabled",
      params: { steps: "scene, speech" },
    });
  });

  it("matches a processing step line with type/count/model", () => {
    expect(
      matchProcessingLine("[PROCESSING] scene: 4 segments, model: Qwen3.6-35B-A3B-GPTQ-Int4, batch: 6, segments.length=4"),
    ).toEqual({
      key: "upload_wizard.log_status_analysis_step",
      params: { type: "scene", count: "4", model: "Qwen3.6-35B-A3B-GPTQ-Int4" },
    });
    expect(
      matchProcessingLine("[PROCESSING] speech: 0 segments, model: parakeet-primeline-de, batch: 8, segments.length=0"),
    ).toEqual({
      key: "upload_wizard.log_status_analysis_step",
      params: { type: "speech", count: "0", model: "parakeet-primeline-de" },
    });
  });

  it("matches the processing completion marker", () => {
    expect(matchProcessingLine("[PROCESSING] All processing groups completed")).toEqual({
      key: "upload_wizard.log_status_analysis_done",
      params: undefined,
    });
  });

  it("matches the post-processing plugin line", () => {
    expect(matchProcessingLine('[POST-PROCESSING] Running plugin "default"...')).toEqual({
      key: "upload_wizard.log_status_postprocessing_plugin",
      params: { plugin: "default" },
    });
  });

  it("matches the workflow completion marker", () => {
    expect(matchProcessingLine("=== WORKFLOW COMPLETE: default-analysis-35b ===")).toEqual({
      key: "upload_wizard.log_status_workflow_done",
      params: undefined,
    });
  });

  it("returns null for ordinary log lines", () => {
    expect(matchProcessingLine("[TIMER] segmentScenes: 2839.8ms")).toBeNull();
    expect(matchProcessingLine("[BATCH] scene: processing 1-4 of 4")).toBeNull();
    expect(matchProcessingLine("[STEP 6/10] Aggregating results into scenes...")).toBeNull();
    expect(matchProcessingLine("")).toBeNull();
  });
});

/**
 * Real-progress model: matchProgressLine maps log lines to events,
 * applyProgressEvent folds them into state, determinateBarValue/creepBarValue
 * render the bar. Sequences below mirror real debug.log runs.
 */
describe("matchProgressLine", () => {
  it("maps the phase/total/done markers", () => {
    expect(matchProgressLine("[STEP 2/10] Pre-processing done — scenes: 4, speech: 1, harmonic: 0, noise: 0"))
      .toEqual({ type: "phase", phase: "proc" });
    expect(matchProgressLine("[PROCESSING] scene: 4 segments, model: Qwen3.6-35B-A3B-GPTQ-Int4, batch: 6, segments.length=4"))
      .toEqual({ type: "segments_total", count: 4 });
    expect(matchProgressLine("[TIMER] scene segment #3: 2819.4ms"))
      .toEqual({ type: "segment_done" });
    expect(matchProgressLine("[TIMER] speech segment #12: 113.7ms"))
      .toEqual({ type: "segment_done" });
    expect(matchProgressLine("[PROCESSING] All processing groups completed"))
      .toEqual({ type: "processing_done" });
    expect(matchProgressLine("[STEP 8/10] Plugins to run: default, question-answer"))
      .toEqual({ type: "post_plugins", count: 2 });
    expect(matchProgressLine('[default:postProcessPerTimeSlice] Starting — 4 slices total, by type: {"scene":4}, reanalyzeVideo=false, concurrency: 8'))
      .toEqual({ type: "post_start", totalSlices: 4 });
    expect(matchProgressLine("[default:postProcessPerTimeSlice] [2/4] Completed slice scene:2:2:32.6-46.525 via caption in 0ms"))
      .toEqual({ type: "slice_done" });
    expect(matchProgressLine("[default:postProcessPerTimeSlice] Completed all 4 slices in 1ms"))
      .toEqual({ type: "post_done" });
    expect(matchProgressLine("[STEP 9/10] Caching aggregated result..."))
      .toEqual({ type: "phase", phase: "final" });
    expect(matchProgressLine("[STEP 10/10] Formatting output..."))
      .toEqual({ type: "phase", phase: "final" });
  });

  it("returns null for non-progress lines", () => {
    expect(matchProgressLine("[TIMER] preProcessing: 18954.3ms")).toBeNull();
    expect(matchProgressLine("[TIMER] step:scene: 3524.6ms")).toBeNull();
    expect(matchProgressLine("[TIMER] aggregation: 0.5ms")).toBeNull();
    expect(matchProgressLine("[TIMER] hook:postProcessPerTimeSlice: 1.4ms")).toBeNull();
    expect(matchProgressLine("[BATCH] scene: processing 1-4 of 4")).toBeNull();
    expect(matchProgressLine("[default:postProcessPerTimeSlice] [0/4] Starting slice scene:0:0:0.1-8.15 (type=scene, duration=8.05s)")).toBeNull();
    expect(matchProgressLine("")).toBeNull();
  });
});

describe("progress state machine", () => {
  it("drives a full run: pre → proc (real ratio) → post (real ratio) → final", () => {
    const p = createProcessingProgress();
    const feed = (line: string) => {
      const ev = matchProgressLine(line);
      if (ev) applyProgressEvent(p, ev);
    };

    // pre: no totals → not determinate, creep window [5,15]
    expect(determinateBarValue(p)).toBeNull();
    feed("[STEP 2/10] Running pre-processing...");
    expect(p.phase).toBe("pre");

    // preprocessing done → proc; totals arrive per [PROCESSING] type line
    feed("[STEP 2/10] Pre-processing done — scenes: 2, speech: 2, harmonic: 0, noise: 0");
    expect(p.phase).toBe("proc");
    expect(determinateBarValue(p)).toBeNull(); // no totals yet
    feed("[PROCESSING] scene: 2 segments, model: M, batch: 6, segments.length=2");
    feed("[PROCESSING] speech: 2 segments, model: W, batch: 8, segments.length=2");

    feed("[TIMER] speech segment #0: 100.0ms");
    // 1/4 segments → 15 + 55 * 0.25 = 28.75
    expect(determinateBarValue(p)).toBeCloseTo(28.75);
    feed("[TIMER] scene segment #0: 100.0ms");
    feed("[TIMER] scene segment #1: 100.0ms");
    expect(determinateBarValue(p)).toBeCloseTo(56.25);

    // cached 4th segment logs no [TIMER] — completion marker snaps to full
    feed("[PROCESSING] All processing groups completed");
    expect(determinateBarValue(p)).toBe(BAR_WINDOW.proc[1]);
    expect(p.phase).toBe("post");

    // post: 1 plugin, 4 slices
    feed("[STEP 8/10] Plugins to run: default");
    feed("[default:postProcessPerTimeSlice] Starting — 4 slices total, by type: {\"scene\":4}, reanalyzeVideo=false, concurrency: 8");
    feed("[default:postProcessPerTimeSlice] [0/4] Completed slice scene:0 via caption in 0ms");
    // 70 + 25 * (0 + 1/4) / 1 = 76.25
    expect(determinateBarValue(p)).toBeCloseTo(76.25);
    feed("[default:postProcessPerTimeSlice] Completed all 4 slices in 1ms");
    expect(determinateBarValue(p)).toBe(BAR_WINDOW.post[1]);

    // final: no totals → back to creep
    feed("[STEP 9/10] Caching aggregated result...");
    expect(p.phase).toBe("final");
    expect(determinateBarValue(p)).toBeNull();
  });

  it("spreads multiple post-processing plugins across the post window", () => {
    const p = createProcessingProgress();
    p.phase = "post";
    applyProgressEvent(p, { type: "post_plugins", count: 2 });
    applyProgressEvent(p, { type: "post_start", totalSlices: 2 });
    applyProgressEvent(p, { type: "post_done" });
    // plugin 1 of 2 done → 70 + 25 * (1/2) = 82.5
    expect(determinateBarValue(p)).toBeCloseTo(82.5);
    applyProgressEvent(p, { type: "post_start", totalSlices: 2 });
    applyProgressEvent(p, { type: "slice_done" });
    // plugin 2 half done → 70 + 25 * (1.5/2) = 88.75
    expect(determinateBarValue(p)).toBeCloseTo(88.75);
  });

  it("clamps over-counted segments/slices at the window top", () => {
    const p = createProcessingProgress();
    p.phase = "proc";
    p.segmentsTotal = 1;
    p.segmentsDone = 5;
    expect(determinateBarValue(p)).toBe(BAR_WINDOW.proc[1]);
  });
});

describe("creepBarValue", () => {
  it("creeps upward and wraps at the window cap", () => {
    expect(creepBarValue("pre", 5)).toBe(5.5);
    expect(creepBarValue("pre", 14.8)).toBe(5); // wraps at hi=15
    expect(creepBarValue("final", 98.8)).toBe(95); // wraps at hi=99
    // determinate phases without totals creep only 3 points above lo
    expect(creepBarValue("proc", 17.8)).toBe(15);
    expect(creepBarValue("post", 72.8)).toBe(70);
  });
});
