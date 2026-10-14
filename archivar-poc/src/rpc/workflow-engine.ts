import { getModel, getWorkflow, getArchivarConfig, resolveDefaultWorkflowName, resolveEffectiveSegmentScenesConfig, buildSegmentScenesCliArgs, resolveSegmentTemporalConfig, buildSegmentTemporalCliArgs, buildInferenceMmProcessorKwargs, resolvePhysicalReencodeFps } from "../lib/archivar-config.js";
import { loadFileWorkflowConfig, mergeWithWorkflow } from "../lib/file-workflow-config.js";
import { enforceMinGroupSize, countDistinctScenes, groupDurationSeconds } from "../lib/aggregation-constraints.js";
import { findBestOverlapSceneIndex, findNearestSceneIndexWithinGap } from "../lib/scene-assignment.js";
import { findCompletenessViolations } from "../lib/slice-completeness.js";
import { remapProcessedCaptions } from "../lib/caption-index.js";
import { hasAtypicalSymbols } from "../lib/text-degeneration.js";
import { dedupePromptText, stripSingletonMarkers } from "../lib/prompt-dedupe.js";
import { preflightWorkflowModels } from "../lib/preflight-models.js";
import { computeImageKeyframeHash, convertImageToKeyframePng } from "../lib/image-keyframe.js";
import { mkdirSync, writeFileSync, createWriteStream, existsSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import type { ProcessingStep, WorkflowDefinition, MediaSegmentType, ModelHyperparams, PostProcessingSelection, SegmentScenesConfig, PostProcessingPluginDefinition, OutputFormat } from "../lib/workflow-types.js";
import type { FileInfo } from "./file-api.js";
import type {
  AnalysisResult,
  AnalysisResultScene,
  AnalysisResultSpeech,
  AnalysisResultKeyframe,
  AnalysisResultAudioSegment,
} from "../db/db.js";
import type {
  FileRef,
  PostProcessingPluginRunResult,
  PluginRpcApiCompositeInstance,
  PostProcessingPluginModule,
  JsonValue,
  TimeSlices,
  PostProcessingInput,
  SemanticAggregations,
  HigherOrderAggregations,
} from "../lib/plugin-types.js";
import { FileApi } from "./file-api.js";
import { AnalyseApi } from "./analyse-api.js";
import { MllmApi } from "./mllm-api.js";
import { CacheApi } from "./cache-api.js";
import { StatusApi } from "./status-api.js";
import { WebhookApi } from "./webhook-api.js";
import { exportFile, type ExportFormat } from "./export.js";
import { encode } from "@byjohann/toon";
import { buildPluginRpcCompositeApiInstance } from "./post-processing/plugin-api.js";
import { loadPluginModule, preloadPluginModules } from "./post-processing/plugin-module-loader.js";
import { TimingCollector, TimingHandle } from "../lib/timing-collector.js";
import { renderTimingTree } from "../lib/timing-tree-renderer.js";
import { TokenUsageAccumulator, tokenUsageCapture } from "../lib/token-usage-collector.js";
import { NonFatalErrorAccumulator, nonFatalErrorCapture, recordNonFatalError } from "../lib/non-fatal-error-collector.js";
import { VlmRequestAccumulator, vlmRequestCapture, emptyVlmRequestsFile, requestPhaseCapture } from "../lib/vlm-request-collector.js";
import { AsrRequestAccumulator, asrRequestCapture, emptyAsrRequestsFile } from "../lib/asr-request-collector.js";
import { buildContextAwarePrompt, needsContextAwarePrompt } from "../lib/caption-prompt-builder.js";
import type { AudioContext as SceneAudioContext } from "../lib/caption-prompt-builder.js";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getEnv } from "defuss-env";
import glob from "fast-glob";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "../..");

// ============================================================================
// Helpers (extracted from the removed client-side full-analysis.ts)
// ============================================================================

function hasTimeOverlap(
  segmentStart: number,
  segmentEnd: number,
  sceneStart: number,
  sceneEnd: number,
): boolean {
  return segmentStart < sceneEnd && segmentEnd > sceneStart;
}

/**
 * Per-segment seed derivation: base seed + segment index. Deterministic per
 * config (reproducible runs, deterministic same-seed retries per segment),
 * but decorrelated across segments — see the bounded experiment note in
 * callModelForSegmentInner. Exported for unit testing.
 */
export function deriveSegmentSeed(baseSeed: number, segmentIndex?: number): number {
  return baseSeed + (segmentIndex ?? 0);
}

/**
 * Checks if a scene caption is valid for fallback determination.
 * A valid caption is: not empty, length >= 10, and not an error marker.
 */
function sceneCaptionIsValid(caption: string | undefined | null): boolean {
  if (!caption || typeof caption !== "string") return false;
  const trimmed = caption.trim();
  if (trimmed.length < 10) return false;
  if (trimmed.startsWith("[ERROR") || trimmed.startsWith("[FEHLER")) return false;
  return true;
}

const getCacheId = (hash: string | null, index: number) => `${hash}-${index}`;

/**
 * Builds the `aggregated` cache key: `${workflowName}-${outputHash}-${versions}`
 * where `versions` joins each configured (enabled) post-processing plugin's
 * exported POST_PROCESSING_CACHE_VERSION (missing export → "1"). Plugin modules
 * are imported to read the export; the module loader caches imports, so the
 * later plugin lifecycle import is free. Policy: versions are frozen (never
 * bumped) — explicit clear-cache is the invalidation path; the version join
 * remains only for backward-compatible key stability.
 */
export async function resolveAggregatedCacheKey(
  workflowName: string,
  outputHash: string | null,
  pluginDefs?: PostProcessingPluginDefinition[],
): Promise<string> {
  const versions: string[] = [];
  for (const def of pluginDefs ?? []) {
    if (def.enabled === false) continue;
    let version = "1";
    try {
      const mod = await loadPluginModule(def.importPath);
      version = String((mod as PostProcessingPluginModule & { POST_PROCESSING_CACHE_VERSION?: string }).POST_PROCESSING_CACHE_VERSION ?? "1");
    } catch (err) {
      console.warn(`[CACHE] Could not read POST_PROCESSING_CACHE_VERSION from ${def.importPath}, assuming "1":`, err instanceof Error ? err.message : err);
    }
    versions.push(version);
  }
  return `${workflowName}-${outputHash}-${versions.length > 0 ? versions.join("+") : "1"}`;
}

/**
 * Processing steps that actually run for the given input media type.
 * Keyframe steps are default-disabled in the shipped workflows (opt-in for
 * video/audio via wizard checkbox or CLI override), but single-image input IS
 * its own keyframe: without the keyframe step an image run would analyze
 * nothing, so for image media keyframe steps always run.
 */
export function resolveEnabledProcessingSteps(
  workflow: WorkflowDefinition,
  fileMediaType: string,
): ProcessingStep[] {
  return workflow.processing.filter(
    (s) => s.enabled !== false || (s.mediaType === "keyframe" && fileMediaType === "image"),
  );
}

// Scenes/audio segments shorter than this are dropped from captioning —
// sub-second material cannot be captioned reliably. Keyframes are exempt
// (single frames have no meaningful duration).
const MIN_DURATION_SEC = 1.0;
// Max temporal gap for assigning a non-overlapping segment to its nearest
// scene. Invariant: a wrong attribution is worse than none — segments beyond
// this gap stay unassigned and surface as sceneIndex -1 slices, where
// decideForAggregation's temporal cap lets the model decide.
const MAX_SCENE_ASSIGNMENT_GAP_SEC = 5.0;
const VALID_AUDIO_EXTENSIONS = [".mp3", ".wav", ".m4a", ".ogg", ".flac"];
const VALID_KEYFRAME_EXTENSIONS = [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"];

function getDuration(item: { startTime?: number; endTime?: number }) {
  return (item.endTime ?? 0) - (item.startTime ?? 0);
}

/**
 * Write the current AnalysisResult to `<debugDir>/debug.json`.
 *
 * Exists for incremental milestone writes during long workflows: called after
 * aggregation, after each post-processing plugin, on the error path, and at the
 * final write. Lets observers read partial results before the (slow) tail of a
 * run completes, and ensures a timeout/crash leaves THIS run's last milestone
 * on disk instead of a stale file from the previous run.
 *
 * A no-op when no debug directory is configured; failures are logged but never
 * thrown (debug output must never break the workflow).
 */
export function writeDebugJson(
  debugDir: string | null,
  result: AnalysisResult,
  label: string,
): void {
  if (!debugDir) return;
  try {
    const debugJsonPath = join(debugDir, "debug.json");
    writeFileSync(debugJsonPath, JSON.stringify(result, null, 2));
    console.log(`[DEBUG] Wrote ${debugJsonPath} (${label})`);
  } catch (err) {
    console.error(`[DEBUG] Failed to write debug.json (${label}):`, err);
  }
}

// ---------------------------------------------------------------------------
// Scoped debug-log console capture (AsyncLocalStorage).
//
// WHY: runWorkflow previously GLOBALLY replaced console.log/error/warn for the
// whole process, teeing EVERY concurrent request's logs (dashboard debug.log
// polling, CORS middleware, RPC handler, model enumeration) into one workflow's
// debug.log — a feedback loop that buried real progress under hundreds of
// "readFile debug.log" / "CORS Middleware" lines. Instead, the wrappers below are
// installed ONCE and tee only while an AsyncLocalStorage store is active for the
// current async execution tree. Each runWorkflow enters such a store, so only
// THAT workflow's own async work (LLM calls, plugins) is captured; concurrent
// requests have no store and pass through untouched.
// ---------------------------------------------------------------------------

/** Active debug capture for the current workflow's async tree. */
interface DebugCapture {
  logStream: ReturnType<typeof createWriteStream> | null;
}

export const debugCapture = new AsyncLocalStorage<DebugCapture>();

/**
 * Install (idempotently) console wrappers that tee into the active capture store.
 * Called once at module load; safe to leave installed permanently because the
 * wrappers no-op the tee whenever no store is active.
 */
function installScopedConsoleCapture(): void {
  const marker = "__archivarScopedCapture" as keyof Console;
  const cons = console as unknown as Record<string, unknown>;
  if (cons[marker]) return;
  cons[marker] = true;
  const tee = (orig: (...args: unknown[]) => void) =>
    (...args: unknown[]) => {
      const cap = debugCapture.getStore();
      if (cap?.logStream) {
        const msg = args
          .map((a) => {
            // Errors carry non-enumerable message/stack — JSON.stringify({}) them.
            if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack ?? ""}`;
            return typeof a === "object" ? JSON.stringify(a) : String(a);
          })
          .join(" ");
        cap.logStream.write(msg + "\n");
      }
      orig(...args);
    };
  console.log = tee(console.log) as typeof console.log;
  console.error = tee(console.error) as typeof console.error;
  console.warn = tee(console.warn) as typeof console.warn;
}
installScopedConsoleCapture();

// ============================================================================
// Batch Processing
// ============================================================================

/**
 * Processes items in sequential batches of `batchSize`, concurrently within a
 * batch. Per-item failures are isolated: a failed item is logged and stored as
 * `null` in the result map (downstream `|| ""` reads turn it into an empty
 * caption), so one bad model call never sinks the whole step.
 *
 * `previousResult` is the finished result of index-1, which exists only across
 * a batch boundary — same-batch predecessors run concurrently and stay
 * invisible. Context-aware captioning relies on this hand-over (and forces
 * batch size 1 when a full previous-caption chain is required).
 */
async function processBatch<T, R>(
  items: T[],
  processor: (item: T, index: number, previousResult: R | undefined) => Promise<R>,
  label: string,
  batchSize: number = 8,
): Promise<Map<number, R>> {
  const results = new Map<number, R>();

  for (let batchStart = 0; batchStart < items.length; batchStart += batchSize) {
    const batchEnd = Math.min(batchStart + batchSize, items.length);
    const batch = items.slice(batchStart, batchEnd);

    console.log(`[BATCH] ${label}: processing ${batchStart + 1}-${batchEnd} of ${items.length}`);

    // Batches run sequentially and results from earlier batches are already
    // complete, so `previousResult` hands the last finished caption across the
    // batch boundary. Same-batch predecessors run concurrently and are NOT
    // visible here (within-batch parallelism loses context by design).
    const batchPromises = batch.map((item, batchIdx) => {
      const globalIdx = batchStart + batchIdx;
      return processor(item, globalIdx, results.get(globalIdx - 1))
        .then((result) => ({ index: globalIdx, result, error: null }))
        .catch((err) => ({ index: globalIdx, result: null as R, error: err }));
    });

    const batchResults = await Promise.all(batchPromises);

    for (const { index, result, error } of batchResults) {
      if (error) {
        console.error(`[BATCH] ${label} item ${index} failed:`, error);
      }
      results.set(index, result);
    }
  }
  return results;
}

/**
 * Run async operations with a concurrency limit (index-preserving worker pool).
 * Mirrors the plugin-side api.util.limitConcurrency for engine-internal use
 * (the per-aggregation post-processing loop).
 */
async function limitConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let currentIndex = 0;

  async function worker(): Promise<void> {
    while (currentIndex < items.length) {
      const index = currentIndex++;
      results[index] = await fn(items[index], index);
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) {
    workers.push(worker());
  }

  await Promise.all(workers);
  return results;
}

// ============================================================================
// Markdown Rendering (extracted from the removed client-side full-analysis.ts)
// ============================================================================

/**
 * Renders the AnalysisResult as a Markdown report for the `md` output format.
 * Sole remaining copy after the CSR original was removed with src/csr/actions/.
 */
export function renderAsMarkdown(result: AnalysisResult): string {
  let md = "";

  md += `# Analysis: ${result.fileName}\n\n`;
  md += `- **Media Type**: ${result.mediaType}\n`;
  md += `- **Output Hash**: ${result.outputHash || "N/A"}\n\n`;
  md += `## Scenes (${result.scenes.length})\n\n`;

  for (const scene of result.scenes) {
    md += `### Scene ${scene.index}: ${scene.startTime.toFixed(2)}s - ${scene.endTime.toFixed(2)}s\n\n`;

    if (scene.caption) {
      md += `**Caption**: ${scene.caption}\n\n`;
    }

    if (scene.speech.length > 0) {
      md += `#### Speech (${scene.speech.length})\n\n`;
      for (const sp of scene.speech) {
        md += `- **[${sp.index}]** ${sp.startTime.toFixed(2)}s - ${sp.endTime.toFixed(2)}s\n`;
        md += `"${sp.caption.trim() || "N/A"}"\n`;
      }
    }

    if (scene.harmonic.length > 0) {
      md += `#### Harmonic (${scene.harmonic.length})\n\n`;
      for (const h of scene.harmonic) {
        md += `- **[${h.index}]** ${h.startTime.toFixed(2)}s - ${h.endTime.toFixed(2)}s\n`;
        md += `"${h.caption.trim() || "N/A"}"\n`;
      }
    }

    if (scene.noise.length > 0) {
      md += `#### Noise (${scene.noise.length})\n\n`;
      for (const n of scene.noise) {
        md += `- **[${n.index}]** ${n.startTime.toFixed(2)}s - ${n.endTime.toFixed(2)}s\n`;
        md += `"${n.caption.trim() || "N/A"}"\n`;
      }
    }

    if (scene.keyframes.length > 0) {
      md += `#### Keyframes (${scene.keyframes.length})\n\n`;
      for (const kf of scene.keyframes) {
        md += `- **[${kf.index}]** ${kf.startTime.toFixed(2)}s - ${kf.endTime.toFixed(2)}s\n`;
        md += `"${kf.caption.trim() || "N/A"}"\n`;
      }
    }

    const hasContent =
      scene.caption || scene.keyframes.length > 0 || scene.speech.length > 0 || scene.harmonic.length > 0 || scene.noise.length > 0;
    if (!hasContent) {
      md += `N/A\n\n`;
    }

    md += `---\n\n`;
  }

  return md;
}

// ============================================================================
// Post-Processing Input Builder
// ============================================================================

// REFACTOR(dry): this HH:MM:SS formatting is copy-pasted in
// src/rpc/post-processing/plugin-api.ts:327 and
// src/rpc/post-processing/plugin-api.ts:541 — one shared time-formatting
// helper in src/lib would serve all three.
function formatTimeSlice(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Builds a FileRef from a FileInfo object.
 */
function buildFileRef(fileInfo: FileInfo): FileRef {
  return {
    fileName: fileInfo.fileName,
    extension: fileInfo.extension,
    mediaType: fileInfo.mediaType,
    outputHash: fileInfo.outputHash,
    serverUrl: fileInfo.serverUrl,
    containerPath: fileInfo.absolutePath,
    hostPath: fileInfo.hostAbsolutePath,
    relativePath: fileInfo.relativePath,
  };
}

/** A segment that could not be attributed to any scene during aggregation. */
export interface UnassignedSegment {
  mediaType: MediaSegmentType;
  caption: string;
  fileName: string;
  extension: string;
  outputHash: string | null;
  serverUrl: string;
  index: number;
  startTime: number;
  endTime: number;
}

/**
 * Builds PostProcessingInput from the analysis result and file info.
 * Provides rich context including file references, workflow config, and run metadata.
 *
 * `unassignedSegments` (from aggregateResults) are emitted as audio-only slices
 * with sceneIndex -1 so they reach post-processing instead of disappearing.
 */
export function buildPostProcessingInput(
  result: AnalysisResult,
  fileInfo: FileInfo,
  workflow: WorkflowDefinition,
  workflowName: string,
  force: boolean,
  only?: string,
  unassignedSegments: UnassignedSegment[] = [],
): PostProcessingInput {
  const slices: TimeSlices = [];
  let index = 0;

  const parentFile = buildFileRef(fileInfo);

  // Build filename→FileInfo lookup maps so we can resolve absolute paths
  // (matching the pattern used in callModelForSegment: hostAbsolutePath || absolutePath)
  const sceneLookup = new Map<string, FileInfo>();
  for (const s of fileInfo.scenes) sceneLookup.set(s.fileName, s);
  const speechLookup = new Map<string, FileInfo>();
  for (const s of fileInfo.speech) speechLookup.set(s.fileName, s);
  const keyframeLookup = new Map<string, FileInfo>();
  // sceneKeyframes is authoritative: aggregateResults assigns these into
  // scenes, while fileInfo.keyframes (generic kf folder) is empty for videos —
  // a lookup miss here would degrade containerPath to a bare fileName.
  for (const s of fileInfo.keyframes ?? []) keyframeLookup.set(s.fileName, s);
  for (const s of fileInfo.sceneKeyframes ?? []) keyframeLookup.set(s.fileName, s);
  const harmonicLookup = new Map<string, FileInfo>();
  for (const s of fileInfo.harmonic) harmonicLookup.set(s.fileName, s);
  const noiseLookup = new Map<string, FileInfo>();
  for (const s of fileInfo.noise) noiseLookup.set(s.fileName, s);

  // REFACTOR(dry): the five per-type blocks in this loop (scene, speech,
  // keyframe, harmonic, noise) plus the unassigned-segment block at the end of
  // this function repeat the same FileRef + slice construction — differing
  // only in lookup map, mediaType label and host-vs-container path order — and
  // each logs one line per slice per plugin run. A makeSlice(type, segment,
  // lookup) helper would collapse all six and the log spam.
  for (const scene of result.scenes) {
    // Scene slice - resolve container path from FileInfo
    // CRITICAL: Use absolutePath (container-visible) for video, NOT hostAbsolutePath.
    // callModelForSegment uses: segment.hostAbsolutePath || segment.absolutePath (audio)
    //                         segment.absolutePath for video/image
    const sceneFileInfo = sceneLookup.get(scene.fileName);
    const sceneContainerPath = sceneFileInfo?.absolutePath || sceneFileInfo?.hostAbsolutePath || scene.fileName;
    console.log(`[workflow-engine] scene ${scene.fileName}: containerPath=${sceneContainerPath}`);
    const sceneFile: FileRef = {
      fileName: scene.fileName,
      extension: scene.extension,
      mediaType: "video",
      outputHash: scene.outputHash,
      serverUrl: scene.serverUrl,
      containerPath: sceneContainerPath,
      hostPath: sceneFileInfo?.hostAbsolutePath,
      relativePath: sceneFileInfo?.relativePath,
    };

    slices.push({
      id: `scene:${scene.index}:${index}:${scene.startTime}-${scene.endTime}`,
      index: index++,
      sourceIndex: scene.index,
      from: formatTimeSlice(scene.startTime),
      to: formatTimeSlice(scene.endTime),
      fromSeconds: scene.startTime,
      toSeconds: scene.endTime,
      durationSeconds: scene.endTime - scene.startTime,
      type: "scene",
      sceneIndex: scene.index,
      caption: scene.caption,
      captionJson: scene.caption ? (() => { try { return JSON.parse(scene.caption); } catch { return undefined; } })() : undefined,
      sourceFile: sceneFile,
      parentFile,
    });

    // Speech segments - audio uses hostAbsolutePath (for local tooling/ASR)
    for (const sp of scene.speech) {
      const speechFileInfo = speechLookup.get(sp.fileName);
      const speechContainerPath = speechFileInfo?.hostAbsolutePath || speechFileInfo?.absolutePath || sp.fileName;
      console.log(`[workflow-engine:buildPostProcessingInput] speech ${sp.fileName}: containerPath=${speechContainerPath}`);
      const speechFile: FileRef = {
        fileName: sp.fileName,
        extension: sp.extension,
        mediaType: "audio",
        outputHash: sp.outputHash,
        serverUrl: sp.serverUrl,
        containerPath: speechContainerPath,
        hostPath: speechFileInfo?.hostAbsolutePath,
        relativePath: speechFileInfo?.relativePath,
      };

      slices.push({
        id: `speech:${scene.index}:${index}:${sp.startTime}-${sp.endTime}`,
        index: index++,
        sourceIndex: sp.index,
        from: formatTimeSlice(sp.startTime),
        to: formatTimeSlice(sp.endTime),
        fromSeconds: sp.startTime,
        toSeconds: sp.endTime,
        durationSeconds: sp.endTime - sp.startTime,
        type: "speech",
        sceneIndex: scene.index,
        caption: sp.caption,
        sourceFile: speechFile,
        parentFile,
      });
    }

    // Keyframes - image uses absolutePath (container-visible)
    for (const kf of scene.keyframes) {
      const kfFileInfo = keyframeLookup.get(kf.fileName);
      const kfContainerPath = kfFileInfo?.absolutePath || kfFileInfo?.hostAbsolutePath || kf.fileName;
      console.log(`[workflow-engine:buildPostProcessingInput] keyframe ${kf.fileName}: containerPath=${kfContainerPath}`);
      const kfFile: FileRef = {
        fileName: kf.fileName,
        extension: kf.extension,
        mediaType: "image",
        outputHash: kf.outputHash,
        serverUrl: kf.serverUrl,
        containerPath: kfContainerPath,
        hostPath: kfFileInfo?.hostAbsolutePath,
        relativePath: kfFileInfo?.relativePath,
      };

      slices.push({
        id: `keyframe:${scene.index}:${index}:${kf.startTime}-${kf.endTime}`,
        index: index++,
        sourceIndex: kf.index,
        from: formatTimeSlice(kf.startTime),
        to: formatTimeSlice(kf.endTime),
        fromSeconds: kf.startTime,
        toSeconds: kf.endTime,
        durationSeconds: kf.endTime - kf.startTime,
        type: "keyframe",
        sceneIndex: scene.index,
        caption: kf.caption,
        sourceFile: kfFile,
        parentFile,
      });
    }

    // Harmonic segments - audio uses hostAbsolutePath
    for (const h of scene.harmonic) {
      const harmFileInfo = harmonicLookup.get(h.fileName);
      const harmContainerPath = harmFileInfo?.hostAbsolutePath || harmFileInfo?.absolutePath || h.fileName;
      console.log(`[workflow-engine:buildPostProcessingInput] harmonic ${h.fileName}: containerPath=${harmContainerPath}`);
      const harmFile: FileRef = {
        fileName: h.fileName,
        extension: h.extension,
        mediaType: "audio",
        outputHash: h.outputHash,
        serverUrl: h.serverUrl,
        containerPath: harmContainerPath,
        hostPath: harmFileInfo?.hostAbsolutePath,
        relativePath: harmFileInfo?.relativePath,
      };

      slices.push({
        id: `harmonic:${scene.index}:${index}:${h.startTime}-${h.endTime}`,
        index: index++,
        sourceIndex: h.index,
        from: formatTimeSlice(h.startTime),
        to: formatTimeSlice(h.endTime),
        fromSeconds: h.startTime,
        toSeconds: h.endTime,
        durationSeconds: h.endTime - h.startTime,
        type: "harmonic",
        sceneIndex: scene.index,
        caption: h.caption,
        sourceFile: harmFile,
        parentFile,
      });
    }

    // Noise segments - audio uses hostAbsolutePath
    for (const n of scene.noise) {
      const noiseFileInfo = noiseLookup.get(n.fileName);
      const noiseContainerPath = noiseFileInfo?.hostAbsolutePath || noiseFileInfo?.absolutePath || n.fileName;
      console.log(`[workflow-engine:buildPostProcessingInput] noise ${n.fileName}: containerPath=${noiseContainerPath}`);
      const noiseFile: FileRef = {
        fileName: n.fileName,
        extension: n.extension,
        mediaType: "audio",
        outputHash: n.outputHash,
        serverUrl: n.serverUrl,
        containerPath: noiseContainerPath,
        hostPath: noiseFileInfo?.hostAbsolutePath,
        relativePath: noiseFileInfo?.relativePath,
      };

      slices.push({
        id: `noise:${scene.index}:${index}:${n.startTime}-${n.endTime}`,
        index: index++,
        sourceIndex: n.index,
        from: formatTimeSlice(n.startTime),
        to: formatTimeSlice(n.endTime),
        fromSeconds: n.startTime,
        toSeconds: n.endTime,
        durationSeconds: n.endTime - n.startTime,
        type: "noise",
        sceneIndex: scene.index,
        caption: n.caption,
        sourceFile: noiseFile,
        parentFile,
      });
    }
  }

  // Segments that fit no scene (gap > MAX_SCENE_ASSIGNMENT_GAP_SEC) are kept
  // out of scene arrays but must still reach post-processing: emit them as
  // audio-only slices with sceneIndex -1, the marker decideForAggregation's
  // temporal cap already handles via the model.
  const unassignedLookups: Partial<Record<MediaSegmentType, Map<string, FileInfo>>> = {
    speech: speechLookup,
    keyframe: keyframeLookup,
    harmonic: harmonicLookup,
    noise: noiseLookup,
  };
  for (const seg of unassignedSegments) {
    const segFileInfo = unassignedLookups[seg.mediaType]?.get(seg.fileName);
    // Audio uses hostAbsolutePath (local tooling/ASR); image uses absolutePath (container-visible).
    const segContainerPath =
      seg.mediaType === "keyframe"
        ? segFileInfo?.absolutePath || segFileInfo?.hostAbsolutePath || seg.fileName
        : segFileInfo?.hostAbsolutePath || segFileInfo?.absolutePath || seg.fileName;
    const segFile: FileRef = {
      fileName: seg.fileName,
      extension: seg.extension,
      mediaType: seg.mediaType === "keyframe" ? "image" : "audio",
      outputHash: seg.outputHash,
      serverUrl: seg.serverUrl,
      containerPath: segContainerPath,
      hostPath: segFileInfo?.hostAbsolutePath,
      relativePath: segFileInfo?.relativePath,
    };
    slices.push({
      id: `${seg.mediaType}:-1:${index}:${seg.startTime}-${seg.endTime}`,
      index: index++,
      sourceIndex: seg.index,
      from: formatTimeSlice(seg.startTime),
      to: formatTimeSlice(seg.endTime),
      fromSeconds: seg.startTime,
      toSeconds: seg.endTime,
      durationSeconds: seg.endTime - seg.startTime,
      type: seg.mediaType,
      sceneIndex: -1,
      caption: seg.caption,
      sourceFile: segFile,
      parentFile,
    });
  }

  // Sort chronologically
  slices.sort((a, b) => a.fromSeconds - b.fromSeconds);

  return {
    workflowName,
    workflow,
    run: {
      id: `${workflowName}-${fileInfo.outputHash}-${Date.now()}`,
      startedAt: new Date().toISOString(),
      force,
      only,
    },
    file: parentFile,
    analysisResult: result,
    timeSlices: slices,
  };
}

// ============================================================================
// Workflow Engine
// ============================================================================

// REFACTOR(complexity): god class — 2500+ lines owning five distinct concerns:
// pre-processing runner, per-segment inference orchestration, scene
// aggregation, post-processing plugin lifecycle, and run side-effects
// (debug/status/webhook/export). Split along those axes (PreProcessingRunner,
// SegmentCaptionRunner, PostProcessingOrchestrator) leaving runWorkflow() a
// thin sequenced caller; the module-level helpers above (markdown rendering,
// PostProcessingInput builder) belong in their own modules.
/**
 * The pipeline orchestrator: runs a named workflow end-to-end on one media
 * file — pre-processing tools, per-segment model inference (batched, cached),
 * aggregation into scenes, the v3 post-processing plugin lifecycle,
 * summary/aggregated caching, requested exports, and the run's side effects
 * (status.json, debug.log/debug.json, timing tree, webhook).
 *
 * Invoked via AnalyseApi.runWorkflow (POST /api/analyze, CLI). Durable state
 * lives in the six cache tables and the <file>.archivar/ directory, not in
 * this class, so concurrent runs on separate files do not interfere.
 */
export class WorkflowEngine {
  private fileApi = new FileApi();
  private analyseApi = new AnalyseApi();
  private mllmApi = new MllmApi();
  private cacheApi = new CacheApi();
  private statusApi = new StatusApi();
  private webhookApi = new WebhookApi();

  /**
   * Generate the export formats requested via /api/analyze (`exports`).
   * Awaits the debug.log stream flush so the "log" export copies a complete
   * file. Export failures never fail the workflow — they are logged only.
   */
  private async generateRequestedExports(
    fileName: string,
    formats: ExportFormat[] | undefined,
    logStream: ReturnType<typeof createWriteStream> | null,
  ): Promise<void> {
    if (!formats?.length) return;
    if (logStream) {
      await new Promise<void>((resolvePromise) => logStream.end(resolvePromise));
    }
    for (const format of formats) {
      try {
        const info = await exportFile(fileName, format, true);
        console.log(`[EXPORT] Generated ${format} export: ${info.path} (${info.size} bytes)`);
      } catch (err) {
        console.error(`[EXPORT] Failed to generate ${format} export for ${fileName}:`, err);
      }
    }
  }

  /**
   * Run a named workflow on a file — the pipeline core, logged as the numbered
   * [STEP n/10] stages: resolve config (base workflow → per-file
   * *.workflow.json → ad-hoc overrides, last wins) → pre-processing tools →
   * aggregated-cache check (a hit short-circuits the entire pipeline) →
   * per-segment model inference → scene aggregation → post-processing plugins
   * → cache writes → formatted output.
   *
   * Called by AnalyseApi.runWorkflow (POST /api/analyze and the CLI).
   * Side effects: status.json lifecycle (processing → done/error), debug.log +
   * incrementally-written debug.json under <file>.archivar/, requested exports,
   * webhook delivery. `force` purges the file's cache entries + output folders
   * and bypasses every cache; `only` ("stage:name") restricts execution to a
   * single stage.
   *
   * @param webHookUrl Optional URL to call when workflow completes.
   * @param exportFormats Optional export formats to generate on completion
   *   (written to <file>.archivar/exports/ and referenced by webhook/poll responses).
   */
  async runWorkflow(
    filePath: string,
    workflowName?: string,
    outputFormat?: OutputFormat,
    overrides?: Partial<WorkflowDefinition>,
    postProcessingOverrides?: PostProcessingSelection,
    force?: boolean,
    only?: string,
    webHookUrl?: string,
    exportFormats?: ExportFormat[],
  ): Promise<string> {
    const config = getArchivarConfig();
    const wfName = workflowName ?? resolveDefaultWorkflowName(config);
    let workflow = getWorkflow(wfName);

    // Apply ad-hoc overrides if provided (highest priority - applied after file-level overrides below)
    const pendingOverrides = overrides;

    const format = outputFormat ?? workflow.outputFormat ?? config.defaults?.outputFormat ?? "json";

    // Parse --only filter: "stage:name"
    let onlyStage: string | null = null;
    let onlyName: string | null = null;
    if (only) {
      const [stage, name] = only.split(":");
      onlyStage = stage;
      onlyName = name;
    }

    // 0. Discover file info early to setup debug output
    const files = await this.fileApi.listFiles(filePath);
    if (files.length === 0) {
      throw new Error(`No files found matching pattern: ${filePath}`);
    }
    // First match wins: filePath may be a glob, but one workflow invocation
    // processes exactly one file.
    const fileInfo = files[0];

    // Setup debug output directory + log capture. Capture is SCOPED via
    // AsyncLocalStorage (see installScopedConsoleCapture): the console wrappers
    // tee only THIS workflow's async tree into debug.log, so concurrent requests
    // (dashboard polling, CORS/RPC logs, model enumeration) no longer pollute it.
    let debugDir: string | null = null;
    let debugLogStream: ReturnType<typeof createWriteStream> | null = null;
    const debugCaptureState: DebugCapture = { logStream: null };

    try {
      debugDir = join(dirname(fileInfo.hostAbsolutePath), `${fileInfo.fileName}.archivar`);
      if (!existsSync(debugDir)) mkdirSync(debugDir, { recursive: true });
      const debugLogPath = join(debugDir, "debug.log");
      debugLogStream = createWriteStream(debugLogPath, { flags: "w" });
      debugCaptureState.logStream = debugLogStream;
    } catch (err) {
      console.error(`[DEBUG] Failed to setup debug.log:`, err);
    }
    // Per-run token-usage accumulator, scoped to this workflow's async tree
    // (same mechanism as debug capture): every transport call + plugin
    // callJson/callRaw + the JSON-schema probe records here. No-op outside a run.
    const tokenAcc = new TokenUsageAccumulator();
    tokenUsageCapture.enterWith(tokenAcc);
    // Per-run non-fatal-error accumulator (same ALS mechanism): retries, isolated
    // per-segment failures, and plugin-hook failures record here. No-op outside a run.
    // errors.json is created up-front and rewritten on every recorded error, so a
    // crashing run leaves a complete error artifact (ids ERR-N for mapping).
    const errorsJsonPath = debugDir ? join(debugDir, "errors.json") : undefined;
    const nonFatalAcc = new NonFatalErrorAccumulator(errorsJsonPath);
    if (errorsJsonPath) writeFileSync(errorsJsonPath, JSON.stringify({ nonFatalErrors: [] }, null, 2));
    nonFatalErrorCapture.enterWith(nonFatalAcc);
    // Per-run per-request VLM usage tracking (actual backend usage + max_tokens
    // + elapsed per request id) — same ALS pattern, same up-front artifact.
    const vlmRequestsJsonPath = debugDir ? join(debugDir, "vlm-requests.json") : undefined;
    const vlmReqAcc = new VlmRequestAccumulator(vlmRequestsJsonPath);
    if (vlmRequestsJsonPath) writeFileSync(vlmRequestsJsonPath, JSON.stringify(emptyVlmRequestsFile(), null, 2));
    vlmRequestCapture.enterWith(vlmReqAcc);
    // Per-run ASR request tracking (ids ASR-N, length + elapsed per request).
    const asrRequestsJsonPath = debugDir ? join(debugDir, "asr-requests.json") : undefined;
    const asrReqAcc = new AsrRequestAccumulator(asrRequestsJsonPath);
    if (asrRequestsJsonPath) writeFileSync(asrRequestsJsonPath, JSON.stringify(emptyAsrRequestsFile(), null, 2));
    asrRequestCapture.enterWith(asrReqAcc);
    // Enter the capture store for the remainder of this workflow's async execution.
    debugCapture.enterWith(debugCaptureState);

    console.log(`[STEP 1/10] Found file: ${fileInfo.fileName} (${fileInfo.mediaType})`);

    // 1b. Apply per-file workflow overrides (*.workflow.json) if present
    const fileWorkflowConfig = await loadFileWorkflowConfig(fileInfo.absolutePath);
    if (fileWorkflowConfig) {
      console.log(`[WORKFLOW] Found per-file config for: ${fileInfo.absolutePath}`);
      workflow = mergeWithWorkflow(workflow, fileWorkflowConfig);
    }

    // 1c. Apply ad-hoc overrides (highest priority)
    if (pendingOverrides) {
      workflow = { ...workflow, ...pendingOverrides, name: workflow.name };
    }

    // 1d. Eagerly load plugin modules BEFORE the long processing stage: after
    // this point no dynamic import() runs mid-workflow, so a dev-server module
    // runner restart cannot kill the post-processing phase.
    await preloadPluginModules(workflow.postProcessing);

    // 1e. Pre-flight: probe every model endpoint this run will call, ONCE, before
    // spending minutes on pre-processing. A dead endpoint fails fast here instead
    // of surfacing as hundreds of recovered per-segment errors and an empty-shell
    // "OK" result (the gemma4 incident). fileInfo.mediaType lets the gate
    // see default-disabled keyframe steps for image input (they run anyway —
    // see resolveEnabledProcessingSteps).
    await preflightWorkflowModels(workflow, onlyStage, fileInfo.mediaType);

    // Create timing collector for this workflow
    const collector = new TimingCollector(`workflow:${workflow.name}`, fileInfo.fileName);

    // 2. Run pre-processing if needed (skip if --only targets another stage)
    if (workflow.preProcessing && onlyStage !== "processing" && onlyStage !== "postProcessing") {
      // --force: remove stale pre-processing outputs BEFORE re-running tools.
      // Tool outputs are written by Docker as root; if they cannot be removed,
      // the re-run's file discovery would glob stale + fresh segments together
      // (duplicated speech, mixed generations) — fail fast instead.
      if (force) {
        const { failures } = await this.fileApi.removeFileOutputs(filePath);
        if (failures.length > 0) {
          throw new Error(
            `--force cannot proceed: stale output folders could not be removed:\n - ${failures.join("\n - ")}`,
          );
        }
      }
      console.log("[STEP 2/10] Running pre-processing...");
      const preStage = collector.beginChild("preProcessing");
      await this.runPreProcessing(fileInfo, workflow, onlyStage === "preProcessing" ? onlyName ?? undefined : undefined, preStage, !!force);
      preStage.end();
      // Re-discover file info after pre-processing generated output files
      console.log("[STEP 2/10] Re-discovering file info after pre-processing...");
      const updatedFiles = await this.fileApi.listFiles(filePath);
      if (updatedFiles.length > 0) {
        // In-place refresh (not reassignment) so every later stage holding
        // this fileInfo reference sees the segments pre-processing produced.
        Object.assign(fileInfo, updatedFiles[0]);
      }
      console.log(`[STEP 2/10] Pre-processing done — scenes: ${fileInfo.scenes.length}, speech: ${fileInfo.speech.length}, harmonic: ${fileInfo.harmonic.length}, noise: ${fileInfo.noise.length}`);
    } else {
      console.log("[STEP 2/10] Skipping pre-processing");
    }

    // 3. Check aggregated cache (unless --force)
    // Key folds in each post-processing plugin's POST_PROCESSING_CACHE_VERSION —
    // frozen by policy (never bumped), kept for backward-compatible key stability.
    const aggregatedCacheKey = await resolveAggregatedCacheKey(wfName, fileInfo.outputHash, workflow.postProcessing);
    if (!force) {
      const cachedResult = await this.cacheApi.get("aggregated", aggregatedCacheKey, null);
      if (cachedResult) {
        console.log(`[CACHE] Hit for aggregated result ${aggregatedCacheKey}`);
        // Write debug files even on cache hit
        writeDebugJson(debugDir, cachedResult, "cache-hit");
        // Cleanup: close debug.log stream and disable capture for this context.
        debugCaptureState.logStream = null;
        if (debugLogStream) debugLogStream.end();
        // Generate requested export formats (awaited, so webhook/poll can reference the files)
        await this.generateRequestedExports(fileInfo.fileName, exportFormats, debugLogStream);
        // Mark workflow as completed in status file (even on cache hit)
        this.statusApi.markDone(fileInfo.fileName);
        // Deliver webhook if configured (fire and forget)
        if (webHookUrl) {
          this.webhookApi.deliverWebhook(fileInfo.fileName).catch((err) => {
            console.error(`[WorkflowEngine] Webhook delivery failed for ${fileInfo.fileName}:`, err);
          });
        }
        return this.formatOutput(cachedResult, format);
      }
    } else {
      console.log(`[FORCE] Skipping cache check for ${wfName}-${fileInfo.outputHash}`);
      // 3b. Purge existing caches for this file when forcing — ensures no stale
      // entries remain if the hash is reused. --force means "start fresh."
      if (fileInfo.outputHash) {
        console.log(`[FORCE] Purging existing cache entries for hash ${fileInfo.outputHash}`);
        // DEPRECATED member: "summary" is an unused cache table (nothing writes
        // or reads it); kept in the purge list so old entries are cleaned.
        const TABLES = ["scene", "audio", "keyframe", "speech", "aggregated", "summary"] as const;
        let purged = 0;
        for (const table of TABLES) {
          purged += await this.cacheApi.removeByPrefix(table, fileInfo.outputHash);
        }
        console.log(`[FORCE] Purged ${purged} stale cache entries`);
      }
    }

    // 4. Build result structure
    console.log("[STEP 4/10] Building result structure...");
    const result: AnalysisResult = {
      serverUrl: fileInfo.serverUrl || "",
      fileName: fileInfo.fileName,
      extension: fileInfo.extension,
      outputHash: fileInfo.outputHash,
      mediaType: fileInfo.mediaType,
      scenes: [],
    };

    // Build scene shells
    let resultScenes: AnalysisResultScene[] = fileInfo.scenes.map((scene, idx) => ({
      index: scene.index ?? idx,
      startTime: scene.startTime ?? 0,
      endTime: scene.endTime ?? 0,
      serverUrl: scene.serverUrl || "",
      fileName: scene.fileName,
      extension: scene.extension,
      outputHash: scene.outputHash,
      mediaType: scene.mediaType,
      caption: "",
      speech: [],
      keyframes: [],
      harmonic: [],
      noise: [],
    }));

    // For audio-only workflows (no scenes but temporal segments exist),
    // create a single virtual scene spanning the entire file so segments
    // can be aggregated.
    if (resultScenes.length === 0) {
      const allSegments = [...fileInfo.speech, ...fileInfo.harmonic, ...fileInfo.noise, ...fileInfo.silence];
      if (allSegments.length > 0) {
        const maxEnd = Math.max(...allSegments.map((s) => s.endTime ?? 0));
        resultScenes = [{
          index: 0,
          startTime: 0,
          endTime: maxEnd,
          serverUrl: fileInfo.serverUrl || "",
          fileName: fileInfo.fileName,
          extension: fileInfo.extension,
          outputHash: fileInfo.outputHash,
          mediaType: fileInfo.mediaType,
          caption: "",
          speech: [],
          keyframes: [],
          harmonic: [],
          noise: [],
        }];
        console.log(`[WORKFLOW] No scenes found - created virtual scene (0–${maxEnd}s) for audio-only aggregation`);
      }
    }

    // 5. Run processing steps (skip if --only targets another stage)
    // Wrapped so a throw during the long LLM calls still flushes a partial
    // debug.json (the most recent milestone) before rethrowing to the caller.
    try {
      let captions: Map<MediaSegmentType, Map<number, string>> = new Map();
      if (onlyStage !== "preProcessing" && onlyStage !== "postProcessing") {
        console.log("[STEP 5/10] Running processing steps...");
        let enabledSteps = resolveEnabledProcessingSteps(workflow, fileInfo.mediaType);
        if (onlyStage === "processing" && onlyName) {
          enabledSteps = enabledSteps.filter((s) => s.mediaType === onlyName);
          console.log(`[ONLY] Filtered to: ${onlyName}`);
        }
        console.log(`[STEP 5/10] Enabled steps: ${enabledSteps.map(s => s.mediaType).join(", ")}`);
        const processStage = collector.beginChild("processing");
        captions = await this.runProcessingSteps(enabledSteps, fileInfo, workflow, processStage, !!force);
        processStage.end();
        console.log("[STEP 5/10] Processing steps complete");
      } else {
        console.log("[STEP 5/10] Skipping processing steps");
      }

      // 6. Aggregate results into scenes
      console.log("[STEP 6/10] Aggregating results into scenes...");
      const aggStage = collector.beginChild("aggregation");
      const unassignedSegments = this.aggregateResults(captions, fileInfo, resultScenes);
      result.scenes = resultScenes;
      aggStage.end();
      console.log(`[STEP 6/10] Aggregation done — ${resultScenes.length} scenes`);

      // 7. Cache scene results
      console.log("[STEP 7/10] Caching scene results...");
      for (const scene of resultScenes) {
        // Key shape `${outputHash}-${index}` (no mediaType segment) is
        // deliberate: export.ts reads exactly this shape from the scene table
        // for its caption fallback (src/rpc/export.ts:413), unlike the
        // per-segment caption keys `${outputHash}-${mediaType}-${index}`
        // written during processing.
        const cacheId = getCacheId(scene.outputHash, scene.index);
        await this.cacheApi.set("scene", cacheId, scene);
      }

      // Incremental debug.json write: scenes (with captions) are now populated.
      // Observers can read partial results before the slow post-processing runs.
      result.timing = collector.snapshot();
      writeDebugJson(debugDir, result, "after-aggregation");

      // 8. Run post-processing plugins (sorted by order, ascending) (skip if --only targets another stage)
      if (onlyStage !== "preProcessing" && onlyStage !== "processing") {
        console.log("[STEP 8/10] Running post-processing plugins...");
        if (workflow.postProcessing) {
          const sortedPlugins = [...workflow.postProcessing].sort(
            (a, b) => (a.order ?? 0) - (b.order ?? 0)
          );
          const filteredPlugins = onlyStage === "postProcessing" && onlyName
            ? sortedPlugins.filter(p => p.name === onlyName)
            : sortedPlugins;
          console.log(`[STEP 8/10] Plugins to run: ${filteredPlugins.map(p => p.name).join(", ")}`);

          // WS5: the completeness invariant over time slices is checked once
          // (buildPostProcessingInput yields identical slices for every plugin).
          let completenessChecked = false;

          for (const plugin of filteredPlugins) {
            // Check runtime overrides for plugin enable/disable
            const pluginOverride = postProcessingOverrides?.plugins?.find((p) => p.name === plugin.name);
            const isEnabled = pluginOverride ? pluginOverride.enabled : plugin.enabled !== false;
            if (!isEnabled) {
              console.log(`[POST-PROCESSING] Plugin "${plugin.name}" disabled by override`);
              continue;
            }
            console.log(`[POST-PROCESSING] Running plugin "${plugin.name}"...`);
            const pluginStage = collector.beginChild(`plugin:${plugin.name}`);
            try {

              // Merge override onto base plugin definition.
              // The override (PostProcessingSelection) only carries enabled/config,
              // but the base plugin has importPath/description/order that MUST be preserved.
              // Without this merge, importPath becomes undefined → path.resolve() crashes.
              const baseConfig = (plugin.config ?? {}) as Record<string, unknown>;
              const overrideConfig = (pluginOverride?.config ?? {}) as Record<string, unknown>;
              const pluginDefinition: PostProcessingPluginDefinition = {
                ...plugin,
                ...(pluginOverride ?? {}),
                config: { ...baseConfig, ...overrideConfig },
              };
              console.log(`[POST-PROCESSING] Plugin "${plugin.name}" importPath="${pluginDefinition.importPath}"`);
              // Cached plugin loader (plugin-module-loader.ts): modules are
              // loaded once per process and preloaded at workflow start, so NO
              // dynamic import happens here mid-run — a dev-server module-runner
              // restart ("Vite module runner has been closed") can no longer
              // kill the post-processing phase.
              const mod: PostProcessingPluginModule = await loadPluginModule(pluginDefinition.importPath);

              console.log(`[POST-PROCESSING] Plugin "${plugin.name}" - running plugin lifecycle`);
              // REFACTOR(kiss): the input is rebuilt on every plugin iteration
              // even though the slices derive from result.scenes, which no
              // plugin mutates (the WS5 completeness check above already relies
              // on identical slices per plugin) — and each rebuild logs one
              // line per slice. Build once before the loop.
              const input = buildPostProcessingInput(result, fileInfo, workflow, wfName, !!force, only, unassignedSegments);
              const api: PluginRpcApiCompositeInstance = buildPluginRpcCompositeApiInstance(this.mllmApi, this.cacheApi, this.fileApi, this.analyseApi);

              // WS5 completeness invariant: every scene clip >= 1s has a caption,
              // shorter clips have a keyframe-caption fallback, every speech slice
              // has a transcript. Violations are logged and recorded into
              // debug.json (result.postProcessingWarnings) — never fail the run.
              if (!completenessChecked) {
                completenessChecked = true;
                const violations = findCompletenessViolations(input.timeSlices);
                if (violations.length > 0) {
                  console.warn(
                    `[POST-PROCESSING] Completeness check found ${violations.length} violation(s):\n` +
                    violations.slice(0, 5).map((v) => `  - ${v}`).join("\n") +
                    (violations.length > 5 ? `\n  … and ${violations.length - 5} more` : ""),
                  );
                  result.postProcessingWarnings = violations;
                }
              }

              const pluginRunResult = await this.runPostProcessingPlugins(input, pluginDefinition, api, plugin.name, mod, pluginStage);
              // Persist plugin results
              result.postProcessing ??= {};
              result.postProcessing[plugin.name] = pluginRunResult;
              // Only replace semanticAggregations if this plugin produced meaningful
              // aggregations (with analysis/summary). Plugins like question-answer that
              // only implement summaryFromAggregations auto-create empty aggregations
              // (one per time slice) which must NOT overwrite prior plugin results.
              const hasMeaningfulAggregations = pluginRunResult.aggregations.some(
                (a) => a.analysis !== undefined || a.summary !== undefined,
              );
              if (hasMeaningfulAggregations) {
                result.semanticAggregations = pluginRunResult.aggregations;
                // Propagate higher-order aggregations so the summary engine can
                // use them as the highest-priority text source.
                if (pluginRunResult.higherOrderAggregations && pluginRunResult.higherOrderAggregations.length > 0) {
                  result.higherOrderAggregations = pluginRunResult.higherOrderAggregations;
                }
              } else if (pluginRunResult.aggregations.length > 0) {
                // Aggregations were built but postProcessPerAggregation failed for all
                // of them (e.g. model errors). Warn so it's not a silent failure.
                console.warn(
                  `[POST-PROCESSING] Plugin "${plugin.name}" produced ${pluginRunResult.aggregations.length} aggregations but NONE have analysis/summary — aggregations NOT propagated. Check plugin errors:`,
                  pluginRunResult.errors.length > 0 ? JSON.stringify(pluginRunResult.errors) : "(no errors recorded)",
                );
              }
              console.log(`[POST-PROCESSING] Plugin "${plugin.name}" completed`);
            } catch (err) {
              // A crashed plugin must not fail the run: partial results from
              // the remaining plugins are still cached (Step 9) and exported.
              // Extract message/stack explicitly — console.error("label", err)
              // renders {} for Error objects (no enumerable own properties).
              const errMsg = err instanceof Error ? err.message : String(err);
              const errStack = err instanceof Error ? err.stack : "";
              console.error(
                `[POST-PROCESSING] Plugin "${plugin.name}" failed:\n${errMsg}${errStack ? `\n${errStack}` : ""}`,
              );
              recordNonFatalError(err, (plugin.config as { modelName?: string } | undefined)?.modelName ?? plugin.name);
            }
            pluginStage.end();
            // Incremental write so each completed plugin's partial result survives
            // a later crash/timeout in a subsequent plugin.
            result.timing = collector.snapshot();
            writeDebugJson(debugDir, result, `after-plugin:${plugin.name}`);
          }
        } else {
          console.log("[STEP 8/10] No post-processing plugins configured");
        }
      } else {
        console.log("[STEP 8/10] Skipping post-processing plugins");
      }

      // Finalize timing + token usage BEFORE caching. The aggregated cache
      // snapshots the value at set-time, so attaching them after the cache write
      // (as they previously were) left the cached result — which the dashboard
      // reads — without timing/tokenUsage.
      result.timing = collector.finalize();
      result.tokenUsage = tokenAcc.summarize();
      result.nonFatalErrors = nonFatalAcc.summarize();

      // 9. Cache aggregated result
      console.log("[STEP 9/10] Caching aggregated result...");
      if (fileInfo.outputHash) {
        await this.cacheApi.set("aggregated", aggregatedCacheKey, result);
        console.log(`[STEP 9/10] Cached aggregated result for ${aggregatedCacheKey}`);
      }
    } catch (err) {
      // Flush the partial result accumulated so far, so debug.json reflects THIS
      // run rather than the stale previous run on timeout/crash, then rethrow.
      // (??=: don't overwrite if timing/tokenUsage were already finalized above
      //  before the erroring cache write.)
      result.timing ??= collector.snapshot();
      result.tokenUsage ??= tokenAcc.summarize();
      result.nonFatalErrors ??= nonFatalAcc.summarize();
      writeDebugJson(debugDir, result, "error");

      // Mark workflow as errored in status file
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.statusApi.markError(fileInfo.fileName, errorMsg);

      throw err;
    }

    // (timing + tokenUsage were finalized above, before the aggregated cache write.)
    // Render ASCII timing tree to debug.log
    if (result.timing) {
      const treeAscii = renderTimingTree(result.timing, { showReference: true, durationFormat: "human" });
      console.log("\n" + "=".repeat(60));
      console.log("TIMING TREE:");
      console.log("=".repeat(60));
      console.log(treeAscii);
      console.log("=".repeat(60) + "\n");
    }

    console.log(`\n=== WORKFLOW COMPLETE: ${workflow.name} ===`);

    // Write debug.json to output directory (final, includes the timing tree).
    writeDebugJson(debugDir, result, "final");

    // 10. Format output
    console.log("[STEP 10/10] Formatting output...");

    // Cleanup: close debug.log stream and disable capture for this context.
    debugCaptureState.logStream = null;
    if (debugLogStream) {
      debugLogStream.end();
    }

    // Generate requested export formats (awaited, so webhook/poll can reference the files)
    await this.generateRequestedExports(fileInfo.fileName, exportFormats, debugLogStream);

    // Mark workflow as completed in status file
    this.statusApi.markDone(fileInfo.fileName);

    // Deliver webhook if configured
    if (webHookUrl) {
      // Fire and forget - webhook delivery should not block the response
      this.webhookApi.deliverWebhook(fileInfo.fileName).catch((err) => {
        console.error(`[WorkflowEngine] Webhook delivery failed for ${fileInfo.fileName}:`, err);
      });
    }

    return this.formatOutput(result, format);
  }

  /**
   * List all available workflows along with the default workflow name from config.
   */
  listWorkflows(): { workflows: Array<{ name: string; description?: string }>; defaultWorkflow: string } {
    const config = getArchivarConfig();
    return {
      workflows: (config.workflows ?? []).map((w) => ({
        name: w.name,
        description: w.description,
      })),
      defaultWorkflow: resolveDefaultWorkflowName(config),
    };
  }

  /**
   * Get full workflow config by name.
   */
  getWorkflowConfig(name: string): WorkflowDefinition {
    return getWorkflow(name);
  }

  // ==========================================================================
  // Internal methods
  // ==========================================================================

  /**
   * Runs the configured pre-processing tools in dependency order — temporal
   * segmentation (speech/harmonic/noise/silence) and scene segmentation
   * (scenes + keyframes) run IN PARALLEL when both apply (independent tools
   * with disjoint outputs) — each only where applicable to the media
   * type (scenes: video only; temporal: audio+video).
   *
   * Skip-if-present caching: when any `out_*` folder exists and --force is not
   * set, every tool is skipped; --force re-runs all (stale folders were already
   * removed by runWorkflow before this runs). The speech model's
   * maxLengthInSec is forwarded to temporal segmentation so ASR never receives
   * audio the backend's encoder rejects.
   */
  private async runPreProcessing(fileInfo: FileInfo, workflow: WorkflowDefinition, onlyName?: string, preStageHandle?: TimingHandle, force: boolean = false): Promise<void> {
    const pre = workflow.preProcessing;
    if (!pre) return;

    const relPath = fileInfo.relativePath || fileInfo.path;
    const media = fileInfo.mediaType; // "video" | "audio" | "image" | "kfs"
    console.log(`[PRE-PROCESSING] File: ${relPath} (mediaType: ${media})`);

    // Check whether pre-processing outputs already exist for this file. When
    // present and --force is not set, pre-processing is skipped entirely.
    const hasOutputs = await this._hasPreProcessingOutputs(fileInfo);

    // Temporal and scene segmentation are independent: neither tool consumes
    // the other's outputs, and they write disjoint file sets into the shared
    // out_<name>_<ext>_<hash>/ folder (verified against both tool sources).
    // They therefore run in PARALLEL when both apply — each is built below as
    // a job with the same gates/logging as the sequential version had.
    //
    // Temporal segmentation (produces speech/harmonic/noise/silence segments)
    // Applicable to: audio, video (not images)
    let temporalJob: (() => Promise<void>) | null = null;
    if (pre.segmentTemporal && (!onlyName || onlyName === "segmentTemporal")) {
      if (media === "audio" || media === "video") {
        if (hasOutputs && !force) {
          console.log("[PRE-PROCESSING] Skipping temporal segmentation — outputs already exist");
        } else {
          console.log("[PRE-PROCESSING] Running temporal segmentation...");
          const temporalHandle = preStageHandle?.beginGrandChild("segmentTemporal", fileInfo.fileName);
          // Resolve temporal config (boolean | SegmentTemporalConfig).
          const temporalCfg = resolveSegmentTemporalConfig(pre.segmentTemporal);
          const temporalCliArgs = buildSegmentTemporalCliArgs(temporalCfg);
          // Inherit the segmentScenes resolution/fps so both tools produce
          // segments at the same dimensions the VLM will ingest — no config
          // duplication needed. segmentTemporal's own config overrides win.
          const scenesCfg = resolveEffectiveSegmentScenesConfig(pre.segmentScenes);
          if (temporalCfg.fps === undefined && scenesCfg.fps !== undefined) {
            temporalCliArgs.push("--preprocess-fps", String(scenesCfg.fps));
          }
          if (temporalCfg.maxWidthPx === undefined && scenesCfg.maxWidthPx !== undefined) {
            temporalCliArgs.push("--preprocess-width", String(scenesCfg.maxWidthPx));
          }
          if (temporalCfg.maxHeightPx === undefined && scenesCfg.maxHeightPx !== undefined) {
            temporalCliArgs.push("--preprocess-height", String(scenesCfg.maxHeightPx));
          }
          // Speech model maxLengthInSec so ASR doesn't reject over-long segments.
          if (temporalCfg.maxLenSpeechSec === undefined) {
            const speechStep = workflow.processing?.find((s) => s.mediaType === "speech" && s.enabled !== false);
            if (speechStep) {
              try {
                const speechMaxLen = getModel(speechStep.modelName).maxLengthInSec;
                if (typeof speechMaxLen === "number" && speechMaxLen > 0) {
                  temporalCliArgs.push("--max-len-speech", String(speechMaxLen));
                  console.log(`[PRE-PROCESSING] segmentTemporal --max-len-speech ${speechMaxLen} (from model ${speechStep.modelName})`);
                }
              } catch (err) {
                console.warn(`[PRE-PROCESSING] Could not resolve speech model ${speechStep.modelName} for maxLengthInSec — using tool defaults:`, err instanceof Error ? err.message : err);
              }
            }
          }
          console.log(`[PRE-PROCESSING] segmentTemporal cliArgs: ${temporalCliArgs.length ? temporalCliArgs.join(" ") : "defaults"}`);
          temporalJob = async () => {
            await this.analyseApi.segmentTemporal(relPath, temporalCliArgs);
            temporalHandle?.end();
          };
        }
      } else {
        console.log(`[PRE-PROCESSING] Skipping temporal segmentation (not applicable to ${media})`);
      }
    }

    // Scene segmentation (produces scenes + keyframes)
    // Applicable to: video only (not audio or images)
    const segmentScenesCfg = resolveEffectiveSegmentScenesConfig(pre.segmentScenes);
    let scenesJob: (() => Promise<void>) | null = null;
    if (segmentScenesCfg.enabled && (!onlyName || onlyName === "segmentScenes")) {
      if (media === "video") {
        if (hasOutputs && !force) {
          console.log("[PRE-PROCESSING] Skipping scene segmentation — outputs already exist");
        } else {
          // Floor the physical re-encode fps at shortClipMinFps (no-op when the
          // short-clip rule is off) so short clips actually contain the frames
          // the inference-side rule samples for.
          const cliArgs = buildSegmentScenesCliArgs(
            segmentScenesCfg.fps !== undefined
              ? { ...segmentScenesCfg, fps: resolvePhysicalReencodeFps(segmentScenesCfg.fps) }
              : segmentScenesCfg,
          );
          console.log(`[PRE-PROCESSING] Running scene segmentation (cliArgs: ${cliArgs.length ? cliArgs.join(" ") : "defaults"})...`);
          const scenesHandle = preStageHandle?.beginGrandChild("segmentScenes", fileInfo.fileName);
          scenesJob = async () => {
            await this.analyseApi.segmentScenes(relPath, cliArgs);
            scenesHandle?.end();
          };
        }
      } else {
        console.log(`[PRE-PROCESSING] Skipping scene segmentation (not applicable to ${media})`);
      }
    }

    // Single-image input: an image IS its own keyframe — no segmentation tool
    // ever runs for images. Synthesize the scene_keyframes artifact the
    // processing stage consumes: PNG conversion + shrink-only resize to the
    // effective pixel limits (the image analog of segment-scenes output).
    // Runs whenever a keyframe step will consume it, independent of
    // segmentScenesCfg.enabled — that config only donates the pixel limits.
    if (media === "image" && (!onlyName || onlyName === "segmentScenes")) {
      // Any configured keyframe step counts here, even a default-disabled one:
      // for image media keyframe steps always run (resolveEnabledProcessingSteps).
      const hasKeyframeStep = workflow.processing?.some(
        (s) => s.mediaType === "keyframe",
      );
      if (!hasKeyframeStep) {
        console.log("[PRE-PROCESSING] Skipping image keyframe conversion (no keyframe processing step configured)");
      } else if (hasOutputs && !force) {
        console.log("[PRE-PROCESSING] Skipping image keyframe conversion — outputs already exist");
      } else {
        const { maxWidthPx, maxHeightPx } = segmentScenesCfg;
        console.log(`[PRE-PROCESSING] Converting image to keyframe PNG (max ${maxWidthPx ?? "?"}x${maxHeightPx ?? "?"})...`);
        const imageHandle = preStageHandle?.beginGrandChild("imageKeyframe", fileInfo.fileName);
        // hostAbsolutePath is env-dependent; fall back to the cwd-relative
        // data dir path (same defensive pattern as MllmApi.toValidImageUrl).
        const srcAbsPath = existsSync(fileInfo.hostAbsolutePath)
          ? fileInfo.hostAbsolutePath
          : resolve(process.cwd(), fileInfo.relativePath);
        const hash = await computeImageKeyframeHash(srcAbsPath, maxWidthPx, maxHeightPx);
        const lastDot = fileInfo.fileName.lastIndexOf(".");
        const nameWithoutExt = lastDot > 0 ? fileInfo.fileName.substring(0, lastDot) : fileInfo.fileName;
        const ext = lastDot > 0 ? fileInfo.fileName.substring(lastDot + 1) : "";
        const destAbsPath = join(
          dirname(srcAbsPath),
          `out_${nameWithoutExt}_${ext}_${hash}`,
          "scene_keyframes",
          "0_0_0.png",
        );
        const { width, height } = await convertImageToKeyframePng(srcAbsPath, destAbsPath, maxWidthPx, maxHeightPx);
        console.log(`[PRE-PROCESSING] Image keyframe written: ${destAbsPath} (${width}x${height})`);
        imageHandle?.end();
      }
    }

    // Execute: parallel when both tools apply. allSettled lets both finish —
    // partial outputs survive a single failure — then the first rejection is
    // rethrown so the run fails exactly as the sequential version did. A
    // single job (audio file, --only, skip) keeps sequential behavior.
    const segmentationJobs = [temporalJob, scenesJob].filter((job): job is () => Promise<void> => job !== null);
    if (segmentationJobs.length === 1) {
      await segmentationJobs[0]();
    } else if (segmentationJobs.length > 1) {
      console.log(`[PRE-PROCESSING] Running ${segmentationJobs.length} segmentation tools in parallel...`);
      const settled = await Promise.allSettled(segmentationJobs.map((job) => job()));
      const failure = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failure) throw failure.reason;
    }
  }

  // REFACTOR(dry): the SAMPLE_DATA_SUBDIR/RELATIVE_SAMPLE_DATA_PATH dataDir
  // resolution below is copy-pasted across the RPC layer (e.g.
  // src/rpc/file-api.ts:62, src/rpc/cache-api.ts:115, src/rpc/status-api.ts:84),
  // and the `out_<name>_<ext>_*` glob is re-constructed in
  // src/rpc/file-api.ts:424 and src/rpc/file-api.ts:452 — the output-folder
  // naming convention that cache coherence depends on has no single builder.
  /**
   * Checks whether pre-processing outputs already exist for a given file.
   * Returns true when at least one `out_*` folder (matching the file name) is
   * present in the data directory. Used to skip redundant pre-processing runs.
   */
  private async _hasPreProcessingOutputs(fileInfo: FileInfo): Promise<boolean> {
    const sampleDataSubDir = getEnv('SAMPLE_DATA_SUBDIR', 'sample_data/archivar') ?? 'sample_data/archivar';
    const relativeSampleDataPath = getEnv('RELATIVE_SAMPLE_DATA_PATH', `../${sampleDataSubDir}`) ?? `../${sampleDataSubDir}`;
    const dataDir = resolve(process.cwd(), relativeSampleDataPath);

    const lastDot = fileInfo.fileName.lastIndexOf('.');
    const nameWithoutExt = lastDot > 0 ? fileInfo.fileName.substring(0, lastDot) : fileInfo.fileName;
    const ext = lastDot > 0 ? fileInfo.fileName.substring(lastDot + 1) : '';
    const globPattern = `out_${nameWithoutExt}_${ext}_*`;

    const folders = await glob.async(globPattern, {
      absolute: true,
      onlyDirectories: true,
      deep: 1,
      cwd: dataDir,
    });
    return folders.length > 0;
  }

  // REFACTOR(complexity): ~280-line method, 4-5 nesting levels (step loop →
  // batch processor callback → fallback filter / reference mapping / context
  // lookup). Extract the per-segment processor body (cache check → reference
  // mapping → context-aware lookup → model call → speech re-analysis → cache
  // write) into a processSegment() method; the keyframe-fallback pre-filter is
  // a second natural extraction.
  /**
   * Runs all enabled processing steps and returns captions as
   * mediaType → (filtered-index → caption) — the basis aggregateResults reads.
   * Two execution modes: parallel (speech steps concurrent with visual/audio
   * steps) or, when any scene/keyframe step requests context-aware captioning,
   * phased audio-first (audio steps → scenes, optionally batch=1 for the
   * previous-caption chain → keyframes) so visual captions can see transcripts
   * and the previous scene's caption.
   */
  private async runProcessingSteps(
    steps: ProcessingStep[],
    fileInfo: FileInfo,
    workflow?: WorkflowDefinition,
    processStageHandle?: TimingHandle,
    force: boolean = false,
  ): Promise<Map<MediaSegmentType, Map<number, string>>> {
    const allCaptions = new Map<MediaSegmentType, Map<number, string>>();

    // Group steps by whether they can run in parallel
    // Speech steps run separately from visual/audio steps (like the client-side code)
    const speechSteps = steps.filter((s) => s.mediaType === "speech");
    const otherSteps = steps.filter((s) => s.mediaType !== "speech");

    // Look up speech step config for re-analysis
    const speechStep = speechSteps[0];

    // Resolve segment-scenes config once for the whole processing loop
    const segmentScenesCfg = workflow?.preProcessing
      ? resolveEffectiveSegmentScenesConfig(workflow.preProcessing.segmentScenes)
      : undefined;

    // Variables for context-aware captioning (set during phased execution)
    let audioContextMapForRun: Map<number, SceneAudioContext> | undefined;
    let lastSceneCaptions: string[] | undefined;

    const runGroup = async (groupSteps: ProcessingStep[]) => {
      for (const step of groupSteps) {
        const segments = this.getSegmentsForType(step.mediaType, fileInfo);
        const filtered = this.filterSegments(segments, step.mediaType);
        const model = getModel(step.modelName);
        // REFACTOR(magic): the default parallelism 4 is a bare literal here and
        // in the Phase 2 loop below, while processBatch's own batchSize default
        // is 8 — three sites, two disagreeing values for the same concept.
        // Introduce a named DEFAULT_MODEL_PARALLELISM and use it at all three.
        const batchSize = model.parallelism ?? 4;

        console.log(`[PROCESSING] ${step.mediaType}: ${filtered.length} segments, model: ${model.name}, batch: ${batchSize}, segments.length=${segments.length}`);

        // For keyframe steps with enabledAsFallback, skip keyframes whose parent scene has valid caption
        let segmentsToProcess = filtered;
        // For keyframes, enabledAsFallback defaults to true - skip keyframes when parent scene has valid caption
        if (step.mediaType === "keyframe" && step.enabledAsFallback !== false) {
          const sceneCaptions = allCaptions.get("scene");
          if (sceneCaptions) {
            const skippedKeyframes: string[] = [];
            // Scene captions are keyed by FILTERED scene index (sub-1s scenes are
            // dropped from scene captioning). Resolve the parent scene's filtered
            // index by time-range equality — using the raw fileInfo.scenes position
            // would misread captions whenever short scenes precede the parent.
            const filteredScenesForFallback = this.filterSegments(fileInfo.scenes, "scene");
            segmentsToProcess = filtered.filter((segment) => {
              const segmentStart = segment.startTime ?? 0;
              const segmentEnd = segment.endTime ?? 0;
              for (let j = 0; j < fileInfo.scenes.length; j++) {
                const scene = fileInfo.scenes[j];
                if (hasTimeOverlap(segmentStart, segmentEnd, scene.startTime ?? 0, scene.endTime ?? 0)) {
                  const filteredSceneIdx = filteredScenesForFallback.findIndex(
                    (fs) => (fs.startTime ?? 0) === (scene.startTime ?? 0) && (fs.endTime ?? 0) === (scene.endTime ?? 0),
                  );
                  const sceneCaption = filteredSceneIdx >= 0 ? sceneCaptions.get(filteredSceneIdx) : undefined;
                  if (sceneCaption && sceneCaptionIsValid(sceneCaption)) {
                    skippedKeyframes.push(segment.fileName);
                    return false; // Skip this keyframe - scene has valid caption
                  }
                  break;
                }
              }
              return true;
            });
            if (skippedKeyframes.length > 0) {
              console.log(`[FALLBACK] Skipping ${skippedKeyframes.length} keyframes with valid scene captions: ${skippedKeyframes.slice(0, 3).join(", ")}${skippedKeyframes.length > 3 ? "..." : ""}`);
            }
          }
        }

        // Step-level timing
        const stepHandle = processStageHandle?.beginGrandChild(`step:${step.mediaType}`);

        const captions = await processBatch<FileInfo, string>(
          segmentsToProcess,
          async (segment, i, previousSegmentCaption) => {
            const cacheTable = this.getCacheTable(step.mediaType);
            const cacheId = getCacheId(`${segment.outputHash}-${step.mediaType}`, segment.index ?? i);

            // Check cache (unless --force, which bypasses all per-segment caches)
            if (!force) {
              const cached = await this.cacheApi.get<{ caption?: string } | null>(cacheTable, cacheId, null);
              if (cached?.caption) {
                console.log(`[CACHE] Hit for ${step.mediaType} ${cacheId}`);
                return cached.caption;
              }
            } else {
              console.log(`[FORCE] Bypassing cache for ${step.mediaType} ${cacheId}`);
            }

            // REFACTOR(dry): the scene/speech/harmonic/noise/keyframe branches
            // below repeat the same hasTimeOverlap scene-lookup loop, differing
            // only in target array name and index source — and the speech
            // branch re-fetches getSegmentsForType once per segment. One
            // resolveCaptionReference(segment, mediaType, scenes) helper would
            // serve all three.
            // Calculate reference mapping for this segment
            let reference: string | undefined;
            if (step.mediaType === "scene") {
              // Find which scene this segment belongs to in fileInfo.scenes
              const sceneIndex = segments.indexOf(segment);
              if (sceneIndex >= 0) {
                reference = `scenes[${sceneIndex}].caption`;
              }
            } else if (["speech", "harmonic", "noise"].includes(step.mediaType)) {
              // Find which scene this segment belongs to based on time overlap
              const segmentStart = segment.startTime ?? 0;
              const segmentEnd = segment.endTime ?? 0;
              for (let j = 0; j < fileInfo.scenes.length; j++) {
                const scene = fileInfo.scenes[j];
                if (hasTimeOverlap(segmentStart, segmentEnd, scene.startTime ?? 0, scene.endTime ?? 0)) {
                  // Find index within scene's segment array
                  const sceneSegments = this.getSegmentsForType(step.mediaType, fileInfo);
                  const segmentInSceneIndex = sceneSegments.indexOf(segment);
                  reference = `scenes[${j}].${step.mediaType}[${segmentInSceneIndex}].caption`;
                  break;
                }
              }
            } else if (step.mediaType === "keyframe") {
              // Find which scene this keyframe belongs to
              const segmentStart = segment.startTime ?? 0;
              const segmentEnd = segment.endTime ?? 0;
              for (let j = 0; j < fileInfo.scenes.length; j++) {
                const scene = fileInfo.scenes[j];
                if (hasTimeOverlap(segmentStart, segmentEnd, scene.startTime ?? 0, scene.endTime ?? 0)) {
                  // Find index within scene's keyframes array
                  const segmentInSceneIndex = segments.indexOf(segment);
                  reference = `scenes[${j}].keyframes[${segmentInSceneIndex}].caption`;
                  break;
                }
              }
            }

            // Segment-level timing with reference mapping
            const segHandle = stepHandle?.beginGrandChild(
              `${step.mediaType} segment #${segment.index ?? i}`,
              reference
            );

            // For context-aware captioning, look up audio context and previous caption
            const useContextAware = needsContextAwarePrompt(step.includeAudioContext, step.includePreviousCaption);
            let audioCtx: SceneAudioContext | undefined;
            let prevCaption: string | undefined;
            if (useContextAware && (step.mediaType === "scene" || step.mediaType === "keyframe")) {
              const filteredScenes = this.filterSegments(fileInfo.scenes, "scene");
              const sceneIdx = segments.indexOf(segment);
              // For keyframes, find the sceneIndex by time overlap
              const lookupIdx = step.mediaType === "scene"
                ? sceneIdx
                : (() => {
                  const segStart = segment.startTime ?? 0;
                  const segEnd = segment.endTime ?? 0;
                  for (let j = 0; j < filteredScenes.length; j++) {
                    if (hasTimeOverlap(segStart, segEnd, filteredScenes[j].startTime ?? 0, filteredScenes[j].endTime ?? 0)) {
                      return j;
                    }
                  }
                  return -1;
                })();
              if (lookupIdx >= 0) {
                audioCtx = audioContextMapForRun?.get(lookupIdx);
              }
              // Previous caption: for scenes, prefer the last finished caption of
              // the previous batch (handed over by processBatch) — within-batch
              // predecessors run concurrently and stay invisible. lastSceneCaptions
              // covers keyframes (Phase 3 runs after the scene step completed) and
              // any follow-up scene step.
              if (step.includePreviousCaption && lookupIdx > 0) {
                prevCaption = (step.mediaType === "scene" ? previousSegmentCaption : undefined)
                  ?? lastSceneCaptions?.[lookupIdx - 1];
              }
            }

            let result = await this.callModelForSegment(step, segment, model, segmentScenesCfg, audioCtx, prevCaption);

            segHandle?.end();

            // Speech re-analysis: if noise/harmonic model detects speech, re-analyze with speech model
            if (["noise", "harmonic"].includes(step.mediaType) && speechStep) {
              try {
                // REFACTOR(dry): hand-rolled markdown-fence stripping here
                // duplicates the canonical loose-JSON handling consolidated in
                // parseJsonLoose (src/lib/parse-json.ts:79) — use it instead of
                // maintaining a third regex variant.
                const parsed = typeof result === "string"
                  ? JSON.parse(result.replace(/```(?:json)?\s*/g, '').replace(/```$/g, ''))
                  : result;
                if (parsed?.audio_type === "speech") {
                  console.log(`[SPEECH-REANALYSIS] ${step.mediaType} segment #${i} detected as speech — re-analyzing with ${speechStep.modelName}`);
                  const speechModel = getModel(speechStep.modelName);
                  result = await this.callModelForSegment(speechStep, segment, speechModel, segmentScenesCfg);
                  // Cache under speech table as well
                  const speechCacheId = getCacheId(`${segment.outputHash}-speech`, segment.index ?? i);
                  await this.cacheApi.set("speech", speechCacheId, {
                    caption: result,
                    fileName: segment.fileName,
                    extension: segment.extension,
                    outputHash: segment.outputHash,
                    index: segment.index ?? i,
                    startTime: segment.startTime ?? 0,
                    endTime: segment.endTime ?? 0,
                    serverUrl: segment.serverUrl || "",
                  });
                }
              } catch {
                // Not valid JSON or audio_type not set — use original result
              }
            }

            // Cache result
            const cacheEntry = {
              caption: result,
              fileName: segment.fileName,
              extension: segment.extension,
              outputHash: segment.outputHash,
              index: segment.index ?? i,
              startTime: segment.startTime ?? 0,
              endTime: segment.endTime ?? 0,
              serverUrl: segment.serverUrl || "",
            };
            await this.cacheApi.set(cacheTable, cacheId, cacheEntry);

            return result;
          },
          step.mediaType,
          batchSize,
        );

        stepHandle?.end();
        // Remap onto the full filtered index basis: when the enabledAsFallback
        // pre-filter skipped keyframes, processBatch's positions are shifted —
        // aggregateResults reads captions.get(i) over ALL filtered segments.
        allCaptions.set(step.mediaType, remapProcessedCaptions(captions, segmentsToProcess, filtered));
        // Track scene captions for previous-caption injection in sequential mode
        if (step.mediaType === "scene" && captions) {
          const sceneSegments = this.filterSegments(fileInfo.scenes, "scene");
          lastSceneCaptions = sceneSegments.map((_, idx) => captions.get(idx) ?? "");
        }
      }
    };

    // Check if any scene/keyframe step needs context-aware captioning
    const needsPhased = steps.some((s) =>
      (s.mediaType === "scene" || s.mediaType === "keyframe") &&
      needsContextAwarePrompt(s.includeAudioContext, s.includePreviousCaption),
    );

    if (needsPhased) {
      // ── PHASED EXECUTION (audio-first, context-aware) ──
      // Phase 1: Run all audio steps (speech, harmonic, noise) to completion
      const audioSteps = otherSteps.filter((s) => ["harmonic", "noise"].includes(s.mediaType));
      console.log(`[PROCESSING] Phase 1 (audio): speech=${speechSteps.length}, harmonic+noise=${audioSteps.length}`);
      await Promise.all([runGroup(audioSteps), runGroup(speechSteps)]);

      // Build audio context map from Phase 1 results
      audioContextMapForRun = this.buildAudioContextMap(allCaptions, fileInfo);

      // Phase 2: Run scene steps (sequential if includePreviousCaption, for context chain)
      const sceneSteps = otherSteps.filter((s) => s.mediaType === "scene");
      if (sceneSteps.length > 0) {
        const needsSeq = sceneSteps.some((s) => s.includePreviousCaption);
        console.log(`[PROCESSING] Phase 2 (scenes): ${sceneSteps.length} steps, sequential=${needsSeq}`);
        // When sequential processing is needed, temporarily reduce batch size
        // by processing steps one at a time with batch=1
        // REFACTOR(kiss): sequential execution is forced by mutating the
        // shared model config (model.parallelism = 1, restored after runGroup)
        // — a hidden side effect with no try/finally: if runGroup throws,
        // parallelism stays 1 for every later workflow in this process. Pass
        // an explicit batchSize override into runGroup/processBatch instead.
        for (const step of sceneSteps) {
          const model = getModel(step.modelName);
          const origBatchSize = model.parallelism ?? 4;
          if (needsSeq) model.parallelism = 1;
          await runGroup([step]);
          model.parallelism = origBatchSize;
        }
      }

      // Phase 3: Run keyframe steps (same context-aware treatment)
      const keyframeSteps = otherSteps.filter((s) => s.mediaType === "keyframe");
      if (keyframeSteps.length > 0) {
        console.log(`[PROCESSING] Phase 3 (keyframes): ${keyframeSteps.length} steps`);
        await runGroup(keyframeSteps);
      }
    } else {
      // ── ORIGINAL PARALLEL EXECUTION (backward compatible) ──
      console.log(`[PROCESSING] Starting parallel execution: otherSteps count=${otherSteps.length}, speechSteps count=${speechSteps.length}`);
      await Promise.all([runGroup(otherSteps), runGroup(speechSteps)]);
    }

    console.log(`[PROCESSING] All processing groups completed`);

    return allCaptions;
  }

  private getSegmentsForType(mediaType: MediaSegmentType, fileInfo: FileInfo): FileInfo[] {
    switch (mediaType) {
      case "scene":
        return fileInfo.scenes;
      case "keyframe":
        // sceneKeyframes is authoritative (the list aggregateResults assigns
        // into scenes); fileInfo.keyframes (generic kf folder) is empty for
        // videos, so using it here would silently caption nothing.
        return fileInfo.sceneKeyframes;
      case "speech":
        return fileInfo.speech;
      case "harmonic":
        return fileInfo.harmonic;
      case "noise":
        return fileInfo.noise;
      case "silence":
        return fileInfo.silence;
      default:
        return [];
    }
  }

  /**
   * Drops segments that should not be captioned: keyframes by image extension,
   * audio types by audio extension + MIN_DURATION_SEC, scenes by
   * MIN_DURATION_SEC.
   *
   * INVARIANT the pipeline depends on: caption maps are keyed by the FILTERED
   * index (position in this filter's output), never the raw fileInfo position.
   * aggregateResults, the keyframe-fallback skip and the audio-context map all
   * resolve parents/siblings on this basis.
   */
  private filterSegments(segments: FileInfo[], mediaType: MediaSegmentType): FileInfo[] {
    return segments.filter((s, i) => {
      const ext = s.extension?.toLowerCase();
      const duration = getDuration(s);

      if (mediaType === "keyframe") {
        if (!VALID_KEYFRAME_EXTENSIONS.includes(ext)) {
          console.log(`[FILTER] ${mediaType} ${i}: invalid extension ${ext}`);
          return false;
        }
        return true;
      }

      // Audio-based types need valid audio extension + minimum duration
      if (["speech", "harmonic", "noise"].includes(mediaType)) {
        if (!VALID_AUDIO_EXTENSIONS.includes(ext)) {
          console.log(`[FILTER] ${mediaType} ${i}: invalid extension ${ext}`);
          return false;
        }
        if (duration < MIN_DURATION_SEC) {
          console.log(`[FILTER] ${mediaType} ${i}: duration ${duration.toFixed(2)}s < ${MIN_DURATION_SEC}s`);
          return false;
        }
        return true;
      }

      // Scenes need minimum duration
      if (mediaType === "scene") {
        if (duration < MIN_DURATION_SEC) {
          console.log(`[FILTER] scene ${i}: duration ${duration.toFixed(2)}s < ${MIN_DURATION_SEC}s`);
          return false;
        }
        return true;
      }

      return true;
    });
  }

  // REFACTOR(dry): three parallel switches route on MediaSegmentType —
  // getSegmentsForType, getCacheTable (here) and getMediaCategory (all in this
  // file) — so adding a segment type means editing three places and silently
  // falling into a `default: audio` branch when one is missed. A single
  // per-type descriptor table ({ segments, cacheTable, mediaCategory }) would
  // also fix getCacheTable's return type listing "aggregated", which no branch
  // ever returns.
  private getCacheTable(mediaType: MediaSegmentType): "scene" | "audio" | "keyframe" | "speech" | "aggregated" {
    switch (mediaType) {
      case "scene":
        return "scene";
      case "keyframe":
        return "keyframe";
      case "speech":
        return "speech";
      case "harmonic":
      case "noise":
      case "silence":
        return "audio";
      default:
        return "audio";
    }
  }

  /**
   * Build a map of sceneIndex → AudioContext after audio processing (Phase 1) completes.
   * Uses time-overlap matching to assign speech transcripts, noise, and harmonic captions
   * to their corresponding scenes. This map is consumed by Phase 2 (scene/keyframe captioning)
   * when includeAudioContext is enabled.
   */
  private buildAudioContextMap(
    allCaptions: Map<MediaSegmentType, Map<number, string>>,
    fileInfo: FileInfo,
  ): Map<number, SceneAudioContext> {
    const contextMap = new Map<number, SceneAudioContext>();
    const scenes = this.filterSegments(fileInfo.scenes, "scene");

    // Helper: find all captions for a given mediaType that overlap with a scene
    const findOverlapping = (
      mediaType: MediaSegmentType,
      segments: FileInfo[],
      sceneStart: number,
      sceneEnd: number,
    ): string[] => {
      const captions = allCaptions.get(mediaType);
      if (!captions) return [];
      const filtered = this.filterSegments(segments, mediaType);
      const results: string[] = [];
      for (let i = 0; i < filtered.length; i++) {
        const seg = filtered[i];
        const segStart = seg.startTime ?? 0;
        const segEnd = seg.endTime ?? 0;
        if (hasTimeOverlap(segStart, segEnd, sceneStart, sceneEnd)) {
          const cap = captions.get(i);
          if (cap && cap.trim()) results.push(cap);
        }
      }
      return results;
    };

    for (let sceneIdx = 0; sceneIdx < scenes.length; sceneIdx++) {
      const scene = scenes[sceneIdx];
      const sceneStart = scene.startTime ?? 0;
      const sceneEnd = scene.endTime ?? 0;

      const speechCaptions = findOverlapping("speech", fileInfo.speech, sceneStart, sceneEnd);
      const noiseCaptions = findOverlapping("noise", fileInfo.noise, sceneStart, sceneEnd);
      const harmonicCaptions = findOverlapping("harmonic", fileInfo.harmonic, sceneStart, sceneEnd);

      contextMap.set(sceneIdx, {
        speechTranscript: speechCaptions.join(" ") || undefined,
        noiseCaptions,
        harmonicCaptions,
      });
    }

    console.log(`[AUDIO-CONTEXT] Built context map for ${contextMap.size} scenes`);
    return contextMap;
  }

  /**
   * Dispatches one segment to its model backend, branching on model.type:
   * `tool` → AnalyseApi.executeScript (local shell script), `asr-api` →
   * MllmApi.transcribeQwen3Asr, default `api` → MllmApi.callWithPrompt.
   *
   * Host-vs-container path duality is load-bearing: speech/audio reach local
   * ASR tooling via `hostAbsolutePath`, video/image reach the containerized
   * LLM server via `absolutePath`. API-type captions pass a degeneration
   * guard (atypical-symbol soup → one cooler-temperature retry).
   *
   * Called once per segment from the runProcessingSteps batch processor; a
   * throw marks that single segment failed (isolated by processBatch), never
   * the whole step.
   */
  private async callModelForSegment(
    step: ProcessingStep,
    segment: FileInfo,
    model: ReturnType<typeof getModel>,
    segmentScenesCfg?: SegmentScenesConfig,
    audioContext?: SceneAudioContext,
    previousCaption?: string,
  ): Promise<string> {
    // Wrap the segment call so a per-segment failure (VLM/ASR captioning error,
    // timeout, …) is recorded as a non-fatal error — with the resolved model name —
    // before processBatch isolates it (a failed segment never fails the whole run).
    try {
      return await requestPhaseCapture.run("caption", () =>
        this.callModelForSegmentInner(step, segment, model, segmentScenesCfg, audioContext, previousCaption),
      );
    } catch (err) {
      recordNonFatalError(err, model.resolvedModel);
      throw err;
    }
  }

  private async callModelForSegmentInner(
    step: ProcessingStep,
    segment: FileInfo,
    model: ReturnType<typeof getModel>,
    segmentScenesCfg?: SegmentScenesConfig,
    audioContext?: SceneAudioContext,
    previousCaption?: string,
  ): Promise<string> {
    const mediaType = step.mediaType;

    // Tool-type models: delegate to AnalyseApi shell scripts via configured toolName
    if (model.type === "tool" && model.toolName) {
      const filePath = segment.hostAbsolutePath || segment.absolutePath;
      console.log(`[TOOL] ${model.toolName}: ${filePath}`);
      const scriptResult = await this.analyseApi.executeScript(model.toolName, [filePath]);
      // Extract transcription from parsed result
      const parsed = scriptResult.parsedResult;
      if (parsed?.text) return parsed.text;
      if (parsed?.transcription) return parsed.transcription;
      return scriptResult.stdout.trim();
    }

    // ASR-API models: Qwen3-ASR via /v1/chat/completions with audio_url
    if (model.type === "asr-api") {
      const filePath = segment.hostAbsolutePath || segment.absolutePath;
      console.log(`[ASR-API] ${model.name}: ${filePath}`);
      const asrResult = await this.mllmApi.transcribeQwen3Asr(
        model.resolvedEndpoint,
        [filePath],
        model.language,
        model.name,
        model.resolvedModel,
        model.resolvedApiKey,
        // Segment duration → asr-requests.json lengthInMins
        segment.startTime != null && segment.endTime != null
          ? segment.endTime - segment.startTime
          : undefined,
      );
      const transcription = asrResult.content;
      console.log(`[ASR-API] transcription=${transcription.substring(0, 200)}${transcription.length > 200 ? "..." : ""}`);
      return transcription;
    }

    // API-type models: call via OpenAI-compatible endpoint
    // When audio context or previous caption is provided, use the context-aware
    // prompt template instead of the simple step.prompt. This enables the model
    // to produce rich Markdown captions with relationship labels and perception matrix.
    const basePrompt = step.prompt ?? "";
    const useContextAware = needsContextAwarePrompt(step.includeAudioContext, step.includePreviousCaption);
    // Dedup repeated lines (e.g. overlapping audio-context transcripts) before
    // sending; multiplicity survives as " (xN)" markers with a legend line.
    const prompt = dedupePromptText(useContextAware
      ? buildContextAwarePrompt(basePrompt, audioContext, previousCaption, {
        enableHumanPerception: step.enableHumanPerceptionEvaluation !== false,
        enableVisualArtifacts: step.enableVisualArtifactTracking !== false,
      })
      : basePrompt);
    const systemPrompt = step.systemPrompt;
    const hyperparams: ModelHyperparams = {
      ...model.hyperparams,
      ...step.hyperparams,
    };
    // Seed decorrelation per segment (bounded experiment): one
    // fixed seed makes OCR misreads reproducible across scenes — the same
    // overlay gets misread identically everywhere and then passes the
    // evidence filter's stability checks (A1 class-B case: "CHaos … 2013").
    // Deriving the seed from the segment index fragments consistent misreads
    // while runs stay deterministic per config.
    if (typeof hyperparams.seed === "number") {
      hyperparams.seed = deriveSegmentSeed(hyperparams.seed, segment.index);
    }
    // Resolve enableThinking: step override > model default > false
    const enableThinking = step.enableThinking ?? model.enableThinking ?? false;

    // Path resolution: audio/speech uses hostAbsolutePath (local tooling), video/image uses absolutePath (container)
    const filePath = mediaType === "speech" ? segment.hostAbsolutePath : segment.absolutePath;
    console.log(`[PROCESS] ${mediaType} ${segment.fileName}: path=${filePath} (hostAbs=${segment.hostAbsolutePath}) (abs=${segment.absolutePath})`);
    const mediaCategory = this.getMediaCategory(mediaType);

    // Merge mm_processor_kwargs: model defaults < step overrides < segmentScenes fps/do_sample_frames
    const mmProcessorKwargs = buildInferenceMmProcessorKwargs(
      model.mmProcessorKwargs,
      step.mmProcessorKwargs,
      segmentScenesCfg,
      mediaCategory,
      segment.startTime != null && segment.endTime != null
        ? segment.endTime - segment.startTime
        : undefined,
    );

    const result = await this.mllmApi.callWithPrompt(
      model.resolvedEndpoint,
      model.resolvedModel,
      model.resolvedApiKey,
      [filePath],
      prompt,
      mediaCategory,
      hyperparams,
      systemPrompt,
      enableThinking,
      mmProcessorKwargs,
      // jsonSchema/jsonSchemaMode/structured*/jsonSchemaName: unused here (prompt-only calls)
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      model.resolvedRepetitionDetection,
    );
    const caption = result.content;

    // Cheap degeneration guard: atypical (non-latin) symbol soup is a known
    // failure mode at higher temperatures — retry once a bit cooler.
    if (hasAtypicalSymbols(caption)) {
      const coolerTemp = Math.max(0, (hyperparams.temperature ?? 0.7) - 0.2);
      console.warn(
        `[PROCESS] ${mediaType} ${segment.fileName}: atypical symbols in caption — ` +
        `retrying once with temperature ${hyperparams.temperature ?? 0.7} → ${coolerTemp}`,
      );
      return stripSingletonMarkers((await this.mllmApi.callWithPrompt(
        model.resolvedEndpoint,
        model.resolvedModel,
        model.resolvedApiKey,
        [filePath],
        prompt,
        mediaCategory,
        { ...hyperparams, temperature: coolerTemp },
        systemPrompt,
        enableThinking,
        mmProcessorKwargs,
        // jsonSchema/jsonSchemaMode/structured*/jsonSchemaName: unused here (prompt-only calls)
        undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        model.resolvedRepetitionDetection,
      )).content);
    }

    // Strip model-imitated " (x1)" singleton markers (dedupePromptText only
    // emits x≥2) before the caption is cached and fed into downstream prompts.
    return stripSingletonMarkers(caption);
  }

  private getMediaCategory(mediaType: MediaSegmentType): "audio" | "video" | "image" {
    switch (mediaType) {
      case "scene":
        return "video";
      case "keyframe":
        return "image";
      case "speech":
      case "harmonic":
      case "noise":
      case "silence":
        return "audio";
      default:
        return "audio";
    }
  }

  /**
   * Assigns captions and per-type segments (keyframe/harmonic/noise/speech) to
   * scenes. Each segment goes to the scene with the LARGEST temporal overlap;
   * non-overlapping segments fall back to the nearest scene only within
   * MAX_SCENE_ASSIGNMENT_GAP_SEC. Segments still unmatched are returned as
   * unassigned (wrong attribution is worse than none — they surface downstream
   * as sceneIndex -1 slices where the model decides).
   */
  private aggregateResults(
    captions: Map<MediaSegmentType, Map<number, string>>,
    fileInfo: FileInfo,
    resultScenes: AnalysisResultScene[],
  ): UnassignedSegment[] {
    // Assign scene captions
    const sceneCaptions = captions.get("scene");
    const filteredScenes = this.filterSegments(fileInfo.scenes, "scene");
    if (sceneCaptions) {
      for (let i = 0; i < filteredScenes.length; i++) {
        // Exact float-equality match is safe here: resultScenes was built from
        // the same fileInfo.scenes records, so start/end times are the same
        // values, not independently recomputed ones.
        const scene = filteredScenes[i];
        const matchIdx = resultScenes.findIndex(
          (rs) => rs.startTime === (scene.startTime ?? 0) && rs.endTime === (scene.endTime ?? 0),
        );
        if (matchIdx >= 0 && sceneCaptions.has(i)) {
          resultScenes[matchIdx].caption = sceneCaptions.get(i) || "";
        }
      }
    }

    // Assign segment types to scenes
    const segmentTypes: Array<{
      mediaType: MediaSegmentType;
      segments: FileInfo[];
      targetArray: keyof Pick<AnalysisResultScene, "keyframes" | "harmonic" | "noise" | "speech">;
    }> = [
        { mediaType: "keyframe", segments: fileInfo.sceneKeyframes, targetArray: "keyframes" },
        { mediaType: "harmonic", segments: fileInfo.harmonic, targetArray: "harmonic" },
        { mediaType: "noise", segments: fileInfo.noise, targetArray: "noise" },
        { mediaType: "speech", segments: fileInfo.speech, targetArray: "speech" },
      ];

    const unassigned: UnassignedSegment[] = [];
    const sceneRanges = resultScenes.map((s) => ({ startTime: s.startTime, endTime: s.endTime }));

    for (const { mediaType, segments, targetArray } of segmentTypes) {
      const segCaptions = captions.get(mediaType);
      if (!segCaptions) continue;

      const filtered = this.filterSegments(segments, mediaType);

      for (let i = 0; i < filtered.length; i++) {
        const segment = filtered[i];
        const caption = segCaptions.get(i) || "";
        const segmentStart = segment.startTime ?? 0;
        const segmentEnd = segment.endTime ?? 0;

        const best = findBestOverlapSceneIndex(segmentStart, segmentEnd, sceneRanges);
        const targetIdx =
          best?.index ??
          findNearestSceneIndexWithinGap(segmentStart, segmentEnd, sceneRanges, MAX_SCENE_ASSIGNMENT_GAP_SEC);

        if (targetIdx === null) {
          unassigned.push({
            mediaType,
            caption,
            fileName: segment.fileName,
            extension: segment.extension,
            outputHash: segment.outputHash,
            serverUrl: segment.serverUrl || "",
            index: segment.index ?? i,
            startTime: segment.startTime ?? 0,
            endTime: segment.endTime ?? 0,
          });
          continue;
        }

        (resultScenes[targetIdx][targetArray] as Array<AnalysisResultSpeech | AnalysisResultKeyframe | AnalysisResultAudioSegment>).push({
          caption,
          fileName: segment.fileName,
          extension: segment.extension,
          outputHash: segment.outputHash,
          serverUrl: segment.serverUrl || "",
          index: segment.index ?? i,
          startTime: segment.startTime ?? 0,
          endTime: segment.endTime ?? 0,
        });
      }
    }
    if (unassigned.length > 0) {
      console.log(
        `[AGGREGATE] ${unassigned.length} segment(s) fit no scene within ${MAX_SCENE_ASSIGNMENT_GAP_SEC}s — leaving unassigned (sceneIndex -1 slices): ` +
        unassigned.map((u) => `${u.mediaType} ${u.startTime}-${u.endTime}s`).join(", "),
      );
    }
    return unassigned;
  }

  /**
   * Runs one plugin's v3 hook chain against the built PostProcessingInput:
   *   1. postProcessPerTimeSlice — analyze/replace each time slice
   *   2. decideForAggregation — greedy adjacent-slice grouping (absent → one
   *      aggregation per slice), then deterministic minimum-size enforcement
   *      (minScenesPerAggregation / minAggregationLengthInSec plugin config)
   *   3. postProcessPerAggregation + summaryForAggregation — per aggregation,
   *      under bounded concurrency (plugin config.maxConcurrency, default 2)
   *   3.5 extractSemanticProfiles — sequential (auto-regressive, needs order)
   *   3.6 enrichAggregationTransitions — restores boundary context that
   *      parallel captioning cannot compute (optional hook)
   *   3.7 postProcessHigherOrderAggregations — group into macro-sections
   *   4. summaryFromAggregations, or summaryFromTimeSlices when no aggregations
   *
   * Hook errors are collected into the returned `errors` array and the chain
   * continues — a plugin must degrade, not fail the workflow. Called once per
   * enabled plugin from the Step 8 loop in runWorkflow.
   */
  private async runPostProcessingPlugins(
    input: PostProcessingInput,
    pluginDefinition: PostProcessingPluginDefinition,
    api: PluginRpcApiCompositeInstance,
    pluginName: string,
    mod: PostProcessingPluginModule,
    pluginHandle?: TimingHandle,
  ): Promise<PostProcessingPluginRunResult> {
    const startedAt = new Date().toISOString();
    const errors: PostProcessingPluginRunResult['errors'] = [];
    let timeSlices = [...input.timeSlices];

    // 1. Run postProcessPerTimeSlice
    if (mod.postProcessPerTimeSlice) {
      const hookHandle = pluginHandle?.beginGrandChild("hook:postProcessPerTimeSlice");
      try {
        const result = await requestPhaseCapture.run("aggregation", () => mod.postProcessPerTimeSlice!(input, pluginDefinition, api));
        if (result?.timeSlices) {
          timeSlices = result.timeSlices;
        }
      } catch (err) {
        errors.push({
          hook: "postProcessPerTimeSlice",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      hookHandle?.end();
    }

    // 2. Run decideForAggregation to build semantic groups
    const groups: number[][] = [];
    if (mod.decideForAggregation && timeSlices.length > 0) {
      const decideHandle = pluginHandle?.beginGrandChild("hook:decideForAggregation");
      let currentGroup: number[] = [0];
      for (let i = 1; i < timeSlices.length; i++) {
        try {
          const belongs = await requestPhaseCapture.run("aggregation", () => mod.decideForAggregation!(timeSlices[i - 1], timeSlices[i], pluginDefinition, api, input));
          if (belongs) {
            currentGroup.push(i);
          } else {
            groups.push(currentGroup);
            currentGroup = [i];
          }
        } catch (err) {
          errors.push({
            hook: "decideForAggregation",
            message: err instanceof Error ? err.message : String(err),
            sliceId: timeSlices[i]?.id,
          });
          // Default to separate aggregation on error
          groups.push(currentGroup);
          currentGroup = [i];
        }
      }
      if (currentGroup.length > 0) {
        groups.push(currentGroup);
      }
      decideHandle?.end();
    } else {
      // No decideForAggregation - each slice becomes its own aggregation
      for (let i = 0; i < timeSlices.length; i++) {
        groups.push([i]);
      }
    }

    // ── Minimum-size enforcement (Level 1): avoid singleton / too-short aggregations ──
    // An aggregation is "too small" if it covers fewer than minScenesPerAggregation
    // distinct scenes (only when the whole video has >= 3 scenes — exactly 2 scenes
    // are never force-merged by the count rule) OR if it is shorter than
    // minAggregationLengthInSec (always enforced). Undersized groups merge into a
    // neighbor deterministically; a single group is always kept as-is.
    const aggSizeCfg = (pluginDefinition.config ?? {}) as {
      minScenesPerAggregation?: number;
      minAggregationLengthInSec?: number;
    };
    const minScenesPerAgg = Number(aggSizeCfg.minScenesPerAggregation ?? 2);
    const minAggregationLenSec = Number(aggSizeCfg.minAggregationLengthInSec ?? 10);
    const totalScenes = countDistinctScenes(timeSlices);
    // Only enforce the scene-count rule when there are >= 3 distinct scenes so that
    // two genuinely-different scenes are not force-collapsed into one aggregation.
    const enforceSceneCount = minScenesPerAgg > 1 && totalScenes >= 3;
    if (groups.length > 1 && (enforceSceneCount || minAggregationLenSec > 0)) {
      const enforcedGroups = enforceMinGroupSize(groups, (grp: number[]) => {
        const grpSlices = grp.map((i) => timeSlices[i]);
        const tooFewScenes =
          enforceSceneCount && countDistinctScenes(grpSlices) < minScenesPerAgg;
        const tooShort =
          minAggregationLenSec > 0 &&
          groupDurationSeconds(grpSlices) < minAggregationLenSec;
        return tooFewScenes || tooShort;
      });
      groups.splice(0, groups.length, ...enforcedGroups);
    }

    // 3. Build SemanticAggregations objects (index order preserved by construction)
    const aggregations: SemanticAggregations = groups.map((groupIndices, g) => {
      const groupSlices = groupIndices.map(i => timeSlices[i]);
      const firstSlice = groupSlices[0];
      const lastSlice = groupSlices[groupSlices.length - 1];
      return {
        id: `${pluginName}:aggregation:${g}`,
        pluginName,
        index: g,
        sliceIndexes: groupIndices,
        sliceIds: groupSlices.map(s => s.id),
        from: firstSlice.from,
        to: lastSlice.to,
        fromSeconds: firstSlice.fromSeconds,
        toSeconds: lastSlice.toSeconds,
      };
    });

    // Run postProcessPerAggregation + summaryForAggregation under bounded
    // concurrency. Each task mutates only its own aggregation object, so
    // parallelism is safe and result order is preserved by index. Boundary
    // context that per-slice parallelism loses is restored afterwards by
    // enrichAggregationTransitions; extractSemanticProfiles stays sequential
    // (auto-regressive, needs order).
    const aggConcurrencyCfg = Number((pluginDefinition.config as { maxConcurrency?: unknown } | undefined)?.maxConcurrency);
    const maxAggConcurrency = Number.isFinite(aggConcurrencyCfg) && aggConcurrencyCfg > 0 ? aggConcurrencyCfg : 2;
    await limitConcurrency(aggregations, maxAggConcurrency, async (aggregation, g) => {
      // Run postProcessPerAggregation
      if (mod.postProcessPerAggregation) {
        const aggHookHandle = pluginHandle?.beginGrandChild(`hook:postProcessPerAggregation#${g}`, `postProcessing.${pluginName}.aggregations[${g}]`);
        try {
          const patch = await requestPhaseCapture.run("aggregation", () => mod.postProcessPerAggregation!(aggregation, timeSlices, pluginDefinition, api, input));
          if (patch) {
            if (patch.analysis) aggregation.analysis = patch.analysis;
            if (patch.summary) aggregation.summary = patch.summary;
            if (patch.replacementSlices) aggregation.replacementSlices = patch.replacementSlices;
          }
        } catch (err) {
          errors.push({
            hook: "postProcessPerAggregation",
            message: err instanceof Error ? err.message : String(err),
            aggregationId: aggregation.id,
          });
        }
        aggHookHandle?.end();
      }

      // Run summaryForAggregation (optional)
      if (mod.summaryForAggregation) {
        const summaryHookHandle = pluginHandle?.beginGrandChild(`hook:summaryForAggregation#${g}`, `postProcessing.${pluginName}.aggregations[${g}].summary`);
        try {
          const summary = await requestPhaseCapture.run("aggregation", () => mod.summaryForAggregation!(aggregation, pluginDefinition, api, input));
          if (summary) {
            aggregation.summary = summary;
          }
        } catch (err) {
          errors.push({
            hook: "summaryForAggregation",
            message: err instanceof Error ? err.message : String(err),
            aggregationId: aggregation.id,
          });
        }
        summaryHookHandle?.end();
      }
    });

    // 3.5. Extract semantic profiles and long-range relationships
    if (mod.extractSemanticProfiles) {
      const semanticHandle = pluginHandle?.beginGrandChild("hook:extractSemanticProfiles", `postProcessing.${pluginName}.semanticProfiles`);
      try {
        await requestPhaseCapture.run("aggregation", () => mod.extractSemanticProfiles!(aggregations, pluginDefinition, api));
      } catch (err) {
        errors.push({
          hook: "extractSemanticProfiles",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      semanticHandle?.end();
    }

    // 3.6. Enrich boundary transitions between adjacent aggregations from the
    // final analyses (reliable replacement for the slice-derived
    // relationship_to_previous, which parallel captioning cannot compute
    // reliably). Consumed by HOA boundary decisions and HOA prompts below.
    if (mod.enrichAggregationTransitions) {
      const transitionsHandle = pluginHandle?.beginGrandChild("hook:enrichAggregationTransitions", `postProcessing.${pluginName}.transitions`);
      try {
        await requestPhaseCapture.run("aggregation", () => mod.enrichAggregationTransitions!(aggregations, pluginDefinition, api, input));
      } catch (err) {
        errors.push({
          hook: "enrichAggregationTransitions",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      transitionsHandle?.end();
    }

    // 3.7. Higher-order aggregation: group aggregations into macro-sections
    let higherOrderAggregations: HigherOrderAggregations | undefined;
    if (mod.postProcessHigherOrderAggregations) {
      const hoaHandle = pluginHandle?.beginGrandChild("hook:postProcessHigherOrderAggregations", `postProcessing.${pluginName}.higherOrderAggregations`);
      try {
        const hoas = await requestPhaseCapture.run("hoa", () => mod.postProcessHigherOrderAggregations!(aggregations, pluginDefinition, api));
        higherOrderAggregations = hoas;
      } catch (err) {
        errors.push({
          hook: "postProcessHigherOrderAggregations",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      hoaHandle?.end();
    }

    // 4. Generate whole-video summary
    let summary: JsonValue | string | undefined;
    if (aggregations.length > 0 && mod.summaryFromAggregations) {
      const summaryHandle = pluginHandle?.beginGrandChild("hook:summaryFromAggregations", `postProcessing.${pluginName}.summary`);
      try {
        const result = await requestPhaseCapture.run("summary", () => mod.summaryFromAggregations!(aggregations, pluginDefinition, api, input, higherOrderAggregations));
        if (result !== undefined && result !== void 0) {
          summary = result;
        }
      } catch (err) {
        errors.push({
          hook: "summaryFromAggregations",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      summaryHandle?.end();
    } else if (aggregations.length === 0 && mod.summaryFromTimeSlices) {
      const summaryHandle = pluginHandle?.beginGrandChild("hook:summaryFromTimeSlices", `postProcessing.${pluginName}.summary`);
      try {
        const result = await requestPhaseCapture.run("summary", () => mod.summaryFromTimeSlices!(input, pluginDefinition, api));
        if (result !== undefined && result !== void 0) {
          summary = result;
        }
      } catch (err) {
        errors.push({
          hook: "summaryFromTimeSlices",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      summaryHandle?.end();
    }

    // Record each collected hook error as a non-fatal error (callJson *retries* are
    // recorded separately in plugin-api; these are the final per-hook failures).
    const pluginModelName = (pluginDefinition.config as { modelName?: string } | undefined)?.modelName ?? pluginName;
    for (const e of errors) recordNonFatalError(new Error(e.message), pluginModelName);

    return {
      pluginName,
      startedAt,
      completedAt: new Date().toISOString(),
      timeSlices,
      aggregations,
      summary,
      higherOrderAggregations,
      errors,
    };
  }

  // Called on [STEP 10/10] Formatting output...
  private formatOutput(result: AnalysisResult, format: OutputFormat): string {
    const start = Date.now();
    let output: string;

    switch (format) {
      case "toon":
        output = encode(result);
        break;
      case "md":
        output = renderAsMarkdown(result);
        break;
      case "json":
      default:
        output = JSON.stringify(result, null, 2);
        break;
    }

    const elapsed = Date.now() - start;
    console.log(`[STEP 10/10] Formatting done: ${format} in ${elapsed}ms, output size: ${output.length} bytes`);
    return output;
  }
}
