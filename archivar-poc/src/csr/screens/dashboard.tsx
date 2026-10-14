import { createRef, $, t, Router, Reactive, createStore } from "defuss";
import type { RpcApi } from "../../rpc.js";
import { getRpcClient } from "defuss-rpc/client.js";
import { authStore } from "../stores/auth-store.js";
import { Button, Spinner } from "../../cl/index.js";
import { MediaCanvas, type MediaCanvasRef, type MediaMetadata } from "./dashboard/media-canvas.js";
import { FileList, type FileListRef } from "./dashboard/file-list.js";
import { Timeline, type TimelineRef, type TimelineAudioRegion, type TimelineSceneRegion } from "./dashboard/timeline.js";
import { EventsList, type EventsListRef, type EventItem } from "./dashboard/events-list.js";
import { TranscriptionView, type TranscriptionViewRef, type ResultProvenance, type HigherOrderAggregation } from "./dashboard/transcription-view.js";
import { SummaryView, type SummaryViewRef } from "./dashboard/summary-view.js";
import { UploadWizard, type UploadWizardRef } from "./dashboard/upload-wizard.js";
import { ConfirmDialog, type ConfirmDialogRef } from "./dashboard/confirm-dialog.js";
import { AnalyzeModal, type AnalyzeModalRef } from "./dashboard/analyze-modal.js";
import type { FileInfo, FileSummary } from "../../rpc/file-api.js";
import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from "../../lib/media-extensions.js";
import type { RegionType } from "../../cl/components/region-icon.js";
import { SidebarHeader } from "@components/sidebar-header.js";

/**
 * What the dashboard can caption/analyze for a single region: the audio region
 * types from region-icon, plus the video pseudo-types "scene"/"sceneKeyframe".
 */
type DetectionType = RegionType | "scene" | "sceneKeyframe";

// One shared RPC client for the whole screen; the top-level await resolves it
// once at module load and every helper below reuses it.
const rpc = await getRpcClient<RpcApi>();
const fileApi = new rpc.FileApi();
const analyseApi = new rpc.AnalyseApi();
const mllmApi = new rpc.MllmApi();
const cacheApi = new rpc.CacheApi();
const statusApi = new rpc.StatusApi();

/**
 * Per-segment cache id `<hash>-<index>`; callers fold the media-type bucket
 * into the hash part (e.g. `${outputHash}-speech`) to address segment tables.
 * Must stay in sync with the server-side cache-key formula.
 */
// REFACTOR(dry): same helper exists server-side in src/rpc/workflow-engine.ts:77, and the type-prefixed variants are re-derived in src/rpc/export.ts:413-417 — a shared key builder would prevent client/server key drift.
const getCacheId = (hash: string, index: number) => {
  return `${hash}-${index}`
}

/**
 * Lists input files via RPC. The server reports container-absolute paths; the
 * dashboard rewrites the Docker volume prefix into the relative form the rest
 * of the client works with.
 */
export const listFiles = async (globPattern: string) => {
  return (await fileApi.listFiles(globPattern)).map((file) => ({
    ...file,
    // REFACTOR(magic): deployment-specific Docker prefix — name it (e.g. DOCKER_PROJECTS_PREFIX) or, better, have the server return relative paths so the client needs no rewrite.
    path: file.absolutePath.replace("/var/lib/docker/projects/", "../"),
  }))
};

/**
 * Lightweight summary listing (selection-only fields, no per-segment payload).
 * WHY: the full list of many analyzed files is ~70MB; the sidebar only needs
 * fileName + media type. The full single-file FileInfo (with segments) is fetched
 * on demand in onFileChange when a file is selected.
 */
export const listFilesSummary = async (globPattern: string) => {
  return await fileApi.listFilesSummary(globPattern);
};

/** Captions one video via the MLLM (dashboard quick-caption + analyze flows). */
export const captionVideos = async (filePath: string) => {
  return await mllmApi.captionVideos([filePath]);
};

/** Speech-to-text for one audio clip via the configured ASR model (not MLLM captioning, despite the name). */
export const captionAudios = async (filePath: string) => {
  return await mllmApi.captionSound([filePath]);
};

/** Captions one image/keyframe (desc + detected objects). */
export const captionImage = async (filePath: string, systemPrompt?: string) => {
  return await mllmApi.captionImage([filePath], systemPrompt);
};

/** Classifies/describes non-speech audio (noise, harmonic, ambience) with the given model. */
// When modelName is omitted, the server resolves the configured default
// workflow's speech-step (ASR) model — one source of truth
// (MllmApi.resolveDefaultModelName).
export const captionSound = async (filePath: string, modelName?: string) => {
  return await mllmApi.captionSound([filePath], modelName);
};

/**
 * Lists everything the dashboard can display: media files plus kfs_* folders
 * (pre-extracted keyframe image sets, convention handled in src/rpc/file-api.ts:220).
 */
export const browseInputFiles = async () => {
  // Summary listing (tens of KB) — the sidebar only renders fileName + media type.
  // The full per-segment FileInfo is fetched on demand for the one selected file.
  // The extension sets are exactly what the pre-processing services can decode.
  const videos = await listFilesSummary(`*.{${VIDEO_EXTENSIONS.join(",")}}`);
  const audios = await listFilesSummary(`*.{${AUDIO_EXTENSIONS.join(",")}}`);
  const images = await listFilesSummary(`*.{${IMAGE_EXTENSIONS.join(",")}}`);
  const kfs = await listFilesSummary("kfs_*");
  return [...videos, ...audios, ...images, ...kfs];
};

// DEAD CODE — removed: the legacy client-side Actions panel (ActionsRef +
// handlers) was permanently hidden (`display: 'none'`); the analysis UI is the
// upload wizard / analyze modal. (src/csr/actions/* removed with it.)

/**
 * Semi-transparent blocking overlay with spinner + "Loading…" label, rendered
 * over a region (file list, timeline, right-hand tabs) while its data loads.
 * Parent container needs `relative` positioning.
 */
const LoadingOverlay = () => (
  <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-white/70">
    <Spinner />
    <span className="text-sm">{t("common.loading")}</span>
  </div>
);

/**
 * Main authenticated screen: orchestrates file list, media canvas, timeline,
 * events/transcription/summary views, upload wizard and dialogs.
 *
 * defuss imperative pattern used throughout: each child receives a createRef
 * and publishes an API object on `ref.state` (assigned inside the child), which
 * this screen then calls directly (e.g. `timelineRef.state!.updateTransport`).
 * `$()` is defuss's jQuery-like DOM wrapper, used here for class/display
 * toggling on tab and column elements. Cross-component updates are explicit
 * imperative calls from this screen; only the debug/export outputs use
 * reactive stores (createStore + Reactive).
 */
export function DashboardScreen() {
  console.log("DashboardScreen init");

  const mediaCanvasRef = createRef<HTMLDivElement, MediaCanvasRef>();
  const fileListRef = createRef<HTMLDivElement, FileListRef>();
  const uploadWizardRef = createRef<HTMLDivElement, UploadWizardRef>();
  const confirmDialogRef = createRef<HTMLDivElement, ConfirmDialogRef>();
  const analyzeModalRef = createRef<HTMLDivElement, AnalyzeModalRef>();
  const timelineRef = createRef<HTMLDivElement, TimelineRef>();
  const fileSelectedRef = createRef<HTMLElement, FileInfo>();

  // Playback sync fan-out: one media tick drives the timeline cursor and the
  // event filter together so the two views never drift apart.
  const onMediaProgress = (currentTimeMs: number) => {
    timelineRef.state!.updateTransport(currentTimeMs);
    eventsListRef.state!.filterEventsByTime(currentTimeMs);
  };

  /**
   * Flattens timeline regions into EventsList items, sorted by start time.
   * The originalFileInfo/mainFileInfo payloads are kept on the events so the
   * list can later caption or seek into the exact source segment.
   */
  const createEventsFromRegions = (audioRegions: (TimelineAudioRegion & { originalFileInfo: FileInfo })[], sceneRegions: (TimelineSceneRegion & { originalFileInfo: FileInfo; mainFileInfo: FileInfo })[]): EventItem[] => {
    const events: EventItem[] = [];
    // REFACTOR(kiss): event ids are unique by construction (`audio-<type>-<i>`, `scene-<i>`, `sceneKeyframe-<i>` are all index-scoped), so this Set can never filter anything — drop it.
    const seenEvents = new Set<string>();

    // Convert audio regions to events - only create one event per region
    audioRegions.forEach((region, index) => {
      const eventId = `audio-${region.type}-${index}`;
      if (!seenEvents.has(eventId)) {
        events.push({
          id: eventId,
          timeMs: region.startMs,
          type: region.type,
          caption: ``, // TODO: add caption
          startMs: region.startMs,
          endMs: region.endMs,
          fileInfo: region.originalFileInfo
        });
        seenEvents.add(eventId);
      }
    });

    // Convert scene regions to events - only create one event per region
    sceneRegions.forEach((region, index) => {
      const eventId = `scene-${index}`;
      if (!seenEvents.has(eventId)) {
        events.push({
          id: eventId,
          timeMs: region.startMs,
          type: "scene",
          caption: '', // TODO: add caption
          startMs: region.startMs,
          endMs: region.endMs,
          fileInfo: region.originalFileInfo
        });
        seenEvents.add(eventId);
      }
    });

    // Convert scene keyframes to events (only once, not per scene region):
    // keyframes belong to the file, and every scene region carries the same
    // mainFileInfo, so [0] is representative.
    if (sceneRegions.length > 0 && sceneRegions[0].mainFileInfo.sceneKeyframes) {
      sceneRegions[0].mainFileInfo.sceneKeyframes.forEach((keyframe, keyframeIndex) => {
        const eventId = `sceneKeyframe-${keyframeIndex}`;
        if (!seenEvents.has(eventId)) {
          events.push({
            id: eventId,
            timeMs: keyframe.startTime ? keyframe.startTime * 1000 : 0,
            type: "sceneKeyframe",
            caption: '', // TODO: add caption
            startMs: keyframe.startTime ? keyframe.startTime * 1000 : 0,
            endMs: keyframe.endTime ? keyframe.endTime * 1000 : 0,
            fileInfo: keyframe
          });
          seenEvents.add(eventId);
        }
      });
    }

    // Sort events by time
    return events.sort((a, b) => a.timeMs - b.timeMs);
  };

  const onMediaMetadata = (metadata: MediaMetadata) => {
    console.log("Media metadata loaded:", metadata);

    // Update timeline timeframe based on media duration
    if (metadata.duration > 0) {
      const timeframeSeconds = Math.ceil(metadata.duration);
      timelineRef.state!.updateTimeframe(timeframeSeconds);
      console.log(`Timeline updated to ${timeframeSeconds} seconds based on media duration`);
    }
  };

  // REFACTOR(dry): onTimelineClick and onTimeSeek (dashboard.tsx:310) have identical bodies apart from the log line — collapse into one seek handler shared by timeline clicks and events-list time badges.
  const onTimelineClick = (timeMs: number) => {
    console.log("Timeline clicked at:", timeMs, "ms");

    // Update transport position
    timelineRef.state!.updateTransport(timeMs);

    // Filter events to show what's happening at this time
    eventsListRef.state!.filterEventsByTime(timeMs);

    // Seek media to the clicked position
    mediaCanvasRef.state!.seekToMs(timeMs);
  };

  const onTimeSeek = (timeMs: number) => {
    console.log("Time seek requested:", timeMs, "ms");
    timelineRef.state!.updateTransport(timeMs);
    eventsListRef.state!.filterEventsByTime(timeMs);
    mediaCanvasRef.state!.seekToMs(timeMs);
  };

  /**
   * Quick-caption path from the events list (no model/prompt choice, unlike
   * the analyze modal): captions one region with server defaults, persists the
   * result into the matching cache table so later runs reuse it, then pushes
   * it into the events list UI.
   */
  const onCaptionRequested = async (fileInfo: FileInfo, detectionType: DetectionType) => {
    console.log("Caption requested for file:", fileInfo.fileName, "detection type:", detectionType, fileInfo);
    // TODO: Implement caption analysis logic

    let caption = "";
    let bbox_2d: { bbox_2d: [number, number, number, number], label: string, details: string }[] = [];
    let type = "";
    switch (fileInfo.mediaType) {
      case "video":
        caption = (await captionVideos(fileInfo.absolutePath)).content;
        break;
      case "audio":
        console.log("Caption requested for audio file:", fileInfo.hostAbsolutePath, "detection type:", detectionType);

        if (detectionType === "speech") {
          // Transcribe via the configured ASR model (captionSound is the
          // ASR transcription route despite its name)
          const asrResult = await captionSound(fileInfo.hostAbsolutePath);
          console.log("ASR result:", asrResult);
          caption = asrResult.desc;
        } else {
          // Use captionSound for other audio types (noise, silence, harmonic, ambience)
          // Default to qwen-asr-0.6b for faster transcription
          const soundResult = await captionSound(fileInfo.absolutePath, "qwen-asr-0.6b");
          caption = soundResult.desc;
          type = soundResult.type;
        }
        break;
      case "image":
        const imageResult = await captionImage(fileInfo.absolutePath);
        caption = imageResult.desc;
        bbox_2d = imageResult.objects;
        break;
    }

    console.log("Caption:", caption);

    // Cache the result
    if (caption) {
      // REFACTOR(kiss): `cacheId` is never read — each branch below recomputes its own id; same dead local in onAnalyzeModalConfirm (dashboard.tsx:498).
      const cacheId = getCacheId(`${fileInfo.outputHash}`, fileInfo.index || 0);

      // REFACTOR(dry): the four-branch cache write below is copy-pasted in onAnalyzeModalConfirm (dashboard.tsx:500-548) — extract one writeCaptionToCache(detectionType, fileInfo, caption) helper.
      try {
        if (detectionType === "scene") {
          // Identify if we need to cache partial scene
          // In full-analysis we cache the whole AnalysisResultScene. 
          // Here we only have caption. Fetch existing or create minimal?
          // Actually cacheApi.set("scene"...) expects AnalysisResultScene.
          // Getting it first is safer.
          const simpleCacheId = getCacheId(fileInfo.outputHash!, fileInfo.index || 0);
          const existing = await cacheApi.get("scene", simpleCacheId, {} as any);
          existing.caption = caption;
          existing.index = fileInfo.index || 0;
          existing.outputHash = fileInfo.outputHash;
          // Populate other mandatory fields if missing? 
          // Assuming existing might be empty if we never ran full analysis.
          // This might be risky if we overwrite a full object with a partial one.
          // But full-analysis writes the WHOLE thing.
          // If we manually analyze, we probably just want to update the caption.
          // If existing is empty, we must be careful.
          if (!existing.outputHash) {
            existing.serverUrl = fileInfo.serverUrl || "";
            existing.fileName = fileInfo.fileName;
            existing.extension = fileInfo.extension;
            existing.mediaType = fileInfo.mediaType;
            existing.startTime = fileInfo.startTime || 0;
            existing.endTime = fileInfo.endTime || 0;
            existing.keyframes = [];
            existing.speech = [];
            existing.harmonic = [];
            existing.noise = [];
          }
          await cacheApi.set("scene", simpleCacheId, existing);
          console.log("Cached scene caption");

        } else if (detectionType === "sceneKeyframe") {
          const kfCacheId = getCacheId(`${fileInfo.outputHash || fileInfo.fileName}-keyframe`, fileInfo.index || 0);
          // keyframe table expects AnalysisResultKeyframe
          const existing = await cacheApi.get("keyframe", kfCacheId, {} as any);
          existing.caption = caption;
          existing.index = fileInfo.index || 0;
          existing.outputHash = fileInfo.outputHash;
          existing.startTime = fileInfo.startTime || 0;
          existing.endTime = fileInfo.endTime || 0;
          await cacheApi.set("keyframe", kfCacheId, existing);

        } else if (detectionType === "speech") {
          const sCacheId = getCacheId(`${fileInfo.outputHash}-speech`, fileInfo.index || 0);
          const existing = await cacheApi.get("speech", sCacheId, {} as any);
          existing.caption = caption;
          existing.index = fileInfo.index || 0;
          existing.outputHash = fileInfo.outputHash;
          existing.startTime = fileInfo.startTime || 0;
          existing.endTime = fileInfo.endTime || 0;

          await cacheApi.set("speech", sCacheId, existing);

        } else if (["harmonic", "noise"].includes(detectionType)) {
          // Audio table
          const suffix = detectionType === "harmonic" ? "harmonic" : "noise";
          const aCacheId = getCacheId(`${fileInfo.outputHash}-${suffix}`, fileInfo.index || 0);
          const existing = await cacheApi.get("audio", aCacheId, {} as any);
          existing.caption = caption;
          existing.index = fileInfo.index || 0;
          existing.outputHash = fileInfo.outputHash;
          existing.startTime = fileInfo.startTime || 0;
          existing.endTime = fileInfo.endTime || 0;
          await cacheApi.set("audio", aCacheId, existing);
        }
      } catch (e) {
        console.error("Failed to cache caption", e);
      }
    }

    eventsListRef.state!.updateCaption(caption, type, bbox_2d);
  };

  const onAnalyzeModalOpen = (fileInfo: FileInfo, detectionType: DetectionType) => {
    analyzeModalRef.state?.open(fileInfo, detectionType);
  };

  /**
   * Modal-driven analysis path: runs analyseApi.analyzeSegment with the chosen
   * model/prompt, normalizes the model's answer into caption/bbox/type, caches
   * non-error results, and updates the events list.
   */
  const onAnalyzeModalConfirm = async (
    fileInfo: FileInfo,
    detectionType: DetectionType,
    modelName: string,
    prompt: string,
    systemPrompt?: string,
  ) => {
    console.log("Analyze modal confirmed:", { modelName, prompt, detectionType });

    // Map detection type to media segment type for the RPC
    // REFACTOR(consistency): "ambience" is analyzed as "harmonic" (no ambience segment type server-side) but the cache branches below key on detectionType — ambience/silence captions are never persisted, same gap as in onCaptionRequested (dashboard.tsx:412). Key the cache write off the mapped mediaType instead.
    const mediaTypeMap: Record<string, string> = {
      scene: "scene",
      sceneKeyframe: "keyframe",
      speech: "speech",
      harmonic: "harmonic",
      noise: "noise",
      silence: "silence",
      ambience: "harmonic",
    };
    const mediaType = mediaTypeMap[detectionType] ?? "speech";

    // Determine the file path to send - use hostAbsolutePath for audio (ASR), absolutePath for others
    const isAudioType = ["speech", "harmonic", "noise", "silence", "ambience"].includes(detectionType);
    const filePath = isAudioType
      ? (fileInfo.hostAbsolutePath || fileInfo.absolutePath)
      : fileInfo.absolutePath;

    let caption = "";
    let bbox_2d: any[] = [];
    let type = "";

    try {
      // Call the analyzeSegment RPC
      caption = await analyseApi.analyzeSegment(
        filePath,
        mediaType as any,
        modelName,
        prompt,
        systemPrompt,
      );

      // Models answer in different JSON shapes depending on type/prompt
      // ({desc,objects} for images, {transcription}/{text} for ASR) —
      // normalize into caption/bbox_2d/type; non-JSON answers stay as-is.
      if (caption) {
        try {
          const parsed = JSON.parse(caption);
          if (parsed.desc) { caption = parsed.desc; bbox_2d = parsed.objects ?? []; }
          if (parsed.transcription) { caption = parsed.transcription; }
          if (parsed.text) { caption = parsed.text; }
          if (parsed.type) { type = parsed.type; }
        } catch {
          // Not JSON - use raw caption string
        }
      }
    } catch (err) {
      console.error("Analysis failed:", err);
      caption = `Error: ${err instanceof Error ? err.message : String(err)}`;
    }

    const isError = caption.startsWith("Error:");

    // Cache the result (reuse existing caching logic) - skip caching errors
    if (caption && !isError) {
      const cacheId = getCacheId(`${fileInfo.outputHash}`, fileInfo.index || 0);

      try {
        if (detectionType === "scene") {
          const simpleCacheId = getCacheId(fileInfo.outputHash!, fileInfo.index || 0);
          const existing = await cacheApi.get("scene", simpleCacheId, {} as any);
          existing.caption = caption;
          existing.index = fileInfo.index || 0;
          existing.outputHash = fileInfo.outputHash;
          if (!existing.outputHash) {
            existing.serverUrl = fileInfo.serverUrl || "";
            existing.fileName = fileInfo.fileName;
            existing.extension = fileInfo.extension;
            existing.mediaType = fileInfo.mediaType;
            existing.startTime = fileInfo.startTime || 0;
            existing.endTime = fileInfo.endTime || 0;
            existing.keyframes = [];
            existing.speech = [];
            existing.harmonic = [];
            existing.noise = [];
          }
          await cacheApi.set("scene", simpleCacheId, existing);
        } else if (detectionType === "sceneKeyframe") {
          const kfCacheId = getCacheId(`${fileInfo.outputHash || fileInfo.fileName}-keyframe`, fileInfo.index || 0);
          const existing = await cacheApi.get("keyframe", kfCacheId, {} as any);
          existing.caption = caption;
          existing.index = fileInfo.index || 0;
          existing.outputHash = fileInfo.outputHash;
          existing.startTime = fileInfo.startTime || 0;
          existing.endTime = fileInfo.endTime || 0;
          await cacheApi.set("keyframe", kfCacheId, existing);
        } else if (detectionType === "speech") {
          const sCacheId = getCacheId(`${fileInfo.outputHash}-speech`, fileInfo.index || 0);
          const existing = await cacheApi.get("speech", sCacheId, {} as any);
          existing.caption = caption;
          existing.index = fileInfo.index || 0;
          existing.outputHash = fileInfo.outputHash;
          existing.startTime = fileInfo.startTime || 0;
          existing.endTime = fileInfo.endTime || 0;
          await cacheApi.set("speech", sCacheId, existing);
        } else if (["harmonic", "noise"].includes(detectionType)) {
          const suffix = detectionType === "harmonic" ? "harmonic" : "noise";
          const aCacheId = getCacheId(`${fileInfo.outputHash}-${suffix}`, fileInfo.index || 0);
          const existing = await cacheApi.get("audio", aCacheId, {} as any);
          existing.caption = caption;
          existing.index = fileInfo.index || 0;
          existing.outputHash = fileInfo.outputHash;
          existing.startTime = fileInfo.startTime || 0;
          existing.endTime = fileInfo.endTime || 0;
          await cacheApi.set("audio", aCacheId, existing);
        }
      } catch (e) {
        console.error("Failed to cache caption", e);
      }
    }

    eventsListRef.state!.updateCaption(caption, type, bbox_2d);
  };

  /**
   * Hot path: file selection → media swap → region building → cached-analysis
   * load → population of timeline, events list, transcription and summary
   * views. Ordering constraints: the transport resets to 0 before regions
   * load, and the aggregated-cache read happens after region events are built
   * so aggregation events can be appended into the same `events` array before
   * the single updateEvents() call at the end.
   */
  // REFACTOR(complexity): ~320 lines with 5+ distinct phases — split into buildTimelineRegions(fileInfo), loadCachedAnalysis(fileInfo, events) and populateEventCaptions(cached, events) helpers.
  const onFileChange = async (entry: FileInfo | FileSummary) => {
    // Blocking overlays on the timeline and the right-hand tabs for the whole load.
    fileChangeLoadingStore.set(true);
    try {
      await loadFileData(entry);
    } finally {
      fileChangeLoadingStore.set(false);
    }
  };

  const loadFileData = async (entry: FileInfo | FileSummary) => {
    // The sidebar carries only a summary (the full list is ~70MB otherwise); fetch
    // the single selected file's full FileInfo (with segments) on demand so the
    // timeline/cache logic below has the data it needs.
    let fileInfo: FileInfo = entry as FileInfo;
    try {
      const full = await listFiles(entry.fileName);
      if (Array.isArray(full) && full.length > 0) fileInfo = full[0] as FileInfo;
    } catch (e) {
      console.warn("[Dashboard] Lazy full-fileInfo fetch failed; using summary:", e);
    }
    console.log("File selected:", fileInfo.fileName);
    console.log("File action (default):", fileInfo.action);
    //console.log("File actions available:", fileInfo.action);

    // set file selected
    fileSelectedRef.updateState(fileInfo);
    exportFileNameStore.set(fileInfo.fileName);

    // Determine file type
    const newFileType = fileInfo.mediaType;
    console.log("File type detected:", newFileType);

    // Update media canvas with new source
    mediaCanvasRef.state!.changeSrc(fileInfo.serverUrl!);
    mediaCanvasRef.state!.changeType(fileInfo.mediaType);
    mediaCanvasRef.state!.changeKeyframes(
      (fileInfo.mediaType === 'image' || fileInfo.mediaType === 'kfs')
        ? fileInfo.keyframes.map(kf => ({ src: kf.serverUrl || '', name: kf.fileName }))
        : []
    );

    // Reset transport to start when file changes
    timelineRef.state!.updateTransport(0);

    // Note: Timeline timeframe will be updated automatically when media metadata loads
    // via the onMediaMetadata callback, so we don't need to set it here from FileInfo

    // Merge all audio regions from FileInfo with their original FileInfo
    const audioRegions: (TimelineAudioRegion & { originalFileInfo: FileInfo })[] = [];

    // REFACTOR(dry): the speech/silence/noise/harmonic loops below (dashboard.tsx:598, :611, :624, :637) are the same push-if-timed code four times — table-drive over [[fileInfo.speech, "speech"], ...] pairs.
    // Process speech regions
    fileInfo.speech.forEach(file => {
      if (file.startTime !== undefined && file.endTime !== undefined) {
        audioRegions.push({
          index: file.index || 0,
          startMs: file.startTime * 1000, // Convert to milliseconds
          endMs: file.endTime * 1000,
          type: "speech",
          originalFileInfo: file
        });
      }
    });

    // Process silence regions
    fileInfo.silence.forEach(file => {
      if (file.startTime !== undefined && file.endTime !== undefined) {
        audioRegions.push({
          index: file.index || 0,
          startMs: file.startTime * 1000,
          endMs: file.endTime * 1000,
          type: "silence",
          originalFileInfo: file
        });
      }
    });

    // Process noise regions
    fileInfo.noise.forEach(file => {
      if (file.startTime !== undefined && file.endTime !== undefined) {
        audioRegions.push({
          index: file.index || 0,
          startMs: file.startTime * 1000,
          endMs: file.endTime * 1000,
          type: "noise",
          originalFileInfo: file
        });
      }
    });

    // Process harmonic regions
    fileInfo.harmonic.forEach(file => {
      if (file.startTime !== undefined && file.endTime !== undefined) {
        audioRegions.push({
          index: file.index || 0,
          startMs: file.startTime * 1000,
          endMs: file.endTime * 1000,
          type: "harmonic",
          originalFileInfo: file
        });
      }
    });

    // Deduplicate audio regions - remove regions with same start and end time
    const deduplicatedAudioRegions = audioRegions.filter((region, index, array) => {
      return array.findIndex(r =>
        r.startMs === region.startMs &&
        r.endMs === region.endMs &&
        r.type === region.type
      ) === index;
    });

    // Sort audio regions by start time
    deduplicatedAudioRegions.sort((a, b) => a.startMs - b.startMs);

    // Process scene regions
    const sceneRegions: (TimelineSceneRegion & { originalFileInfo: FileInfo; mainFileInfo: FileInfo })[] = fileInfo.scenes.map(file => ({
      index: file.index || 0,
      startMs: (file.startTime || 0) * 1000,
      endMs: (file.endTime || 0) * 1000,
      originalFileInfo: file, // Individual scene file for the scene event
      mainFileInfo: fileInfo  // Main file info for accessing sceneKeyframes
    }));

    // Deduplicate scene regions - remove regions with same start and end time
    const deduplicatedSceneRegions = sceneRegions.filter((region, index, array) => {
      return array.findIndex(r =>
        r.startMs === region.startMs &&
        r.endMs === region.endMs
      ) === index;
    });

    // Sort scene regions by start time
    deduplicatedSceneRegions.sort((a, b) => a.startMs - b.startMs);

    // Update timeline with the processed data (strip originalFileInfo and mainFileInfo for timeline)
    timelineRef.state!.updateAudioRegions(deduplicatedAudioRegions.map(({ originalFileInfo, ...region }) => region));
    timelineRef.state!.updateSceneRegions(deduplicatedSceneRegions.map(({ originalFileInfo, mainFileInfo, ...region }) => region));

    // Create events from regions and update events list
    const events = createEventsFromRegions(deduplicatedAudioRegions, deduplicatedSceneRegions);

    // For images and kfs folders, create keyframe events directly from fileInfo.keyframes
    if ((fileInfo.mediaType === 'image' || fileInfo.mediaType === 'kfs') && fileInfo.keyframes.length > 0) {
      fileInfo.keyframes.forEach((kf, i) => {
        events.push({
          id: `sceneKeyframe-${i}`,
          timeMs: 0,
          type: "sceneKeyframe",
          caption: '',
          startMs: 0,
          endMs: 0,
          fileInfo: kf,
        });
      });
    }

    // Keep reference for transcription view
    allEventsRef = events;

    // Load semantic aggregations from the cached aggregated result (v3 plugin results).
    // Load semantic aggregations from the cached aggregated result (v3 plugin results).
    // One lean server-shaped payload per file (CacheApi.getAnalysisViewByHash):
    // captions, aggregation/HOA regions, the filtered summary view and
    // provenance — the multi-MB full AnalysisResult stays server-side. The
    // preferred-plugin cache key (question-answer first) is
    // chosen server-side as well.
    let v3Summary: any = null;
    let resultProvenance: ResultProvenance | null = null;
    if (fileInfo.outputHash) {
      try {
        const view = await cacheApi.getAnalysisViewByHash(fileInfo.outputHash);
        console.log("[Dashboard] Selected cache key:", view.key);
        // Filtered view (summary + higherOrderAggregations only) drives the
        // "All Results" / summary rendering. The lean scenes/aggregations on the
        // same payload drive timeline regions and event captions.
        const resultView = view.resultView;

        if (view.semanticAggregations.length > 0) {
          // Convert semantic aggregations to timeline regions
          const aggRegions = view.semanticAggregations.map((agg) => ({
            index: agg.index || 0,
            startMs: (agg.fromSeconds || 0) * 1000,
            endMs: (agg.toSeconds || 0) * 1000,
            aggregationId: agg.id,
            pluginName: agg.pluginName,
            summary: agg.summary,
          }));
          timelineRef.state!.updateAggregationRegions(aggRegions);

          // Update higher-order aggregation regions in timeline (green indicators)
          if (view.higherOrderAggregations.length > 0) {
            const hoaRegions = view.higherOrderAggregations.map((hoa) => ({
              id: hoa.id,
              index: hoa.index || 0,
              aggregationIndexes: hoa.aggregationIndexes || [],
              title: hoa.title,
            }));
            timelineRef.state!.updateHigherOrderAggregationRegions(hoaRegions);
          } else {
            timelineRef.state!.updateHigherOrderAggregationRegions([]);
          }

          // Add aggregation events to the events list
          aggRegions.forEach((agg: any, i: number) => {
            events.push({
              id: `agg-${agg.aggregationId || i}`,
              timeMs: agg.startMs,
              type: "semanticAggregation",
              caption: agg.summary || `Aggregation ${i + 1}`,
              startMs: agg.startMs,
              endMs: agg.endMs,
              aggregationId: agg.aggregationId,
              aggregationIndex: agg.index,
              aggregationSummary: agg.summary,
            });
          });
        } else {
          // No aggregations - hide the purple timeline indicators
          timelineRef.state!.updateAggregationRegions([]);
        }

        // Load v3 plugin summary — prefer enhanced summary from later plugins
        // (plugins run sequentially by order; the last one has appended content
        // like markdown tables from the question-answer pipeline)
        const postProcessing = resultView?.postProcessing ?? {};
        v3Summary = postProcessing.default?.summary;
        for (const key of Object.keys(postProcessing)) {
          if (key !== "default" && postProcessing[key]?.summary) {
            v3Summary = postProcessing[key].summary;
          }
        }
        summaryViewRef.state?.loadV3Summary(v3Summary ?? null);

        // Show Summary tab if v3 summary exists
        summaryTabVisibleRef.updateState(!!v3Summary);

        // Set summary for All Results tab
        transcriptionViewRef.state?.setSummary(v3Summary ?? null);

        // Set higher-order aggregations for All Results tab
        transcriptionViewRef.state?.setHigherOrderAggregations(resultView?.higherOrderAggregations as HigherOrderAggregation[] ?? []);

        // Set higher-order aggregations for Current Events tab
        eventsListRef.state!.updateHigherOrderAggregations(resultView?.higherOrderAggregations ?? []);

        // Populate scene and speech captions from cachedResult into events
        // This ensures captions that exist in the aggregated result are displayed in the UI
        // Match key: segment index, else exact start/end times (both stem from the same detection run).
        if (view.scenes.length > 0) {
          for (const event of events) {
            // Capture fileInfo to avoid TypeScript narrowing issues in callbacks
            const fileInfo = event.fileInfo;
            if (event.type === "scene" && fileInfo) {
              // Find matching scene in the view by index or startTime/endTime
              const scene = view.scenes.find(
                (s) => s.index === fileInfo.index ||
                  (s.startTime === fileInfo.startTime && s.endTime === fileInfo.endTime)
              );
              if (scene?.caption) {
                event.caption = scene.caption;
              }
            } else if (event.type === "speech" && fileInfo) {
              // Find matching speech in view scenes
              for (const scene of view.scenes) {
                const speech = scene.speech.find(
                  (sp) => sp.index === fileInfo.index ||
                    (sp.startTime === fileInfo.startTime && sp.endTime === fileInfo.endTime)
                );
                if (speech?.caption) {
                  event.caption = speech.caption;
                  break;
                }
              }
            } else if ((event.type === "harmonic" || event.type === "noise") && fileInfo) {
              // Find matching audio segment in view scenes
              for (const scene of view.scenes) {
                const segment = scene[event.type].find(
                  (seg) => seg.index === fileInfo.index ||
                    (seg.startTime === fileInfo.startTime && seg.endTime === fileInfo.endTime)
                );
                if (segment?.caption) {
                  event.caption = segment.caption;
                  break;
                }
              }
            }
          }
          console.log("[Dashboard] Populated captions from cachedResult into events");
        }

        // Provenance footer (bottom of All Results): workflow + models from
        // status.json, processing time/token usage from the view payload.
        try {
          const status = await statusApi.getStatus(fileInfo.fileName);
          resultProvenance = {
            fileName: fileInfo.fileName,
            workflow: status?.workflow,
            asrModel: status?.models?.asr,
            vlmModel: status?.models?.vlm,
            processingTimeMs: view.processingTime ?? undefined,
            tokenUsage: view.tokenUsage,
            nonFatalErrors: view.nonFatalErrors as ResultProvenance["nonFatalErrors"],
          };
        } catch { /* no status.json — provenance footer stays hidden */ }
      } catch (e) {
        console.log("[Dashboard] No semantic aggregations found in cache", e);
      }
    }

    eventsListRef.state!.updateEvents(events);
    // All Results renders the filtered view (summary + HOAs only): scenes,
    // speech and aggregation events are not part of it, so no events are shown.
    transcriptionViewRef.state?.updateEvents([]);
    transcriptionViewRef.state?.setProvenance(resultProvenance);

    // Show events at the beginning (time 0)
    eventsListRef.state!.filterEventsByTime(0);

    console.log("Timeline updated with:", {
      originalAudioRegions: audioRegions.length,
      deduplicatedAudioRegions: deduplicatedAudioRegions.length,
      originalSceneRegions: sceneRegions.length,
      deduplicatedSceneRegions: deduplicatedSceneRegions.length,
      events: events.length,
      timeframe: fileInfo.startTime !== undefined && fileInfo.endTime !== undefined
        ? `${fileInfo.startTime}s - ${fileInfo.endTime}s`
        : "unknown"
    });
  };

  // DEAD CODE — removed: the CaptionGPT chat tab was permanently hidden and
  // never functional (static mockup, no server endpoint) — refs, the tab
  // handler, touch-points and the mockup block went with it.
  const currentEventsTabRef = createRef<HTMLLIElement>();
  const allResultsTabRef = createRef<HTMLLIElement>();
  const summaryTabRef = createRef<HTMLLIElement>();
  const logTabRef = createRef<HTMLLIElement>();
  const rawOutputTabRef = createRef<HTMLLIElement>();
  const eventsDisplayRef = createRef<HTMLDivElement>();
  const transcriptionDisplayRef = createRef<HTMLDivElement>();
  const summaryDisplayRef = createRef<HTMLDivElement>();
  const logDisplayRef = createRef<HTMLDivElement>();
  const rawOutputDisplayRef = createRef<HTMLDivElement>();

  // Reactive stores for debug output content, so the <pre>/<code> elements
  // re-render whenever the loaded content changes (instead of imperative DOM mutation).
  const logContentStore = createStore<string>("");
  const rawOutputContentStore = createStore<string>("");
  // Currently selected file name, drives the All Results export download links
  const exportFileNameStore = createStore<string>("");
  // Loading-overlay stores: the file list loads on mount/refresh/delete/upload
  // (starts true because the initial fetch begins immediately); the per-file
  // load on row click covers the timeline and the right-hand tabs.
  const fileListLoadingStore = createStore<boolean>(true);
  const fileChangeLoadingStore = createStore<boolean>(false);
  const eventsListRef = createRef<HTMLDivElement, EventsListRef>();
  const transcriptionViewRef = createRef<HTMLDivElement, TranscriptionViewRef>();
  const summaryViewRef = createRef<HTMLDivElement, SummaryViewRef>();

  // REFACTOR(consistency): createRef's first arg is a refUpdateFn subscriber, not a default-state factory — `() => false` is a no-op, and unlike the createStore+Reactive outputs above (log/raw/export), nothing re-renders the Summary <li> style (dashboard.tsx:1235) when updateState fires. Use a store + Reactive or toggle the style imperatively.
  // Track whether Summary tab should be visible (true when v3 plugin summary exists)
  const summaryTabVisibleRef = createRef<HTMLDivElement, boolean>(() => false);

  // Keep a reference to all events for the transcription view
  let allEventsRef: EventItem[] = [];

  // Column visibility state
  const leftColumnRef = createRef<HTMLDivElement>();
  const rightColumnRef = createRef<HTMLDivElement>();
  const middleColumnRef = createRef<HTMLDivElement>();
  const leftResizerRef = createRef<HTMLDivElement>();
  const rightResizerRef = createRef<HTMLDivElement>();

  let leftColumnVisible = true;
  let rightColumnVisible = true;


  // Defer past the initial mount: child refs only receive their `state` during
  // mount, so an immediate setFiles() call would race the assignment.
  queueMicrotask(async () => {
    try {
      const inputFiles = await browseInputFiles();
      console.log("inputFiles", inputFiles);
      // Update the file list with the loaded files
      fileListRef.state!.setFiles(inputFiles);
    } finally {
      fileListLoadingStore.set(false);
    }
  })

  /*
  const onAnalyzeFile = async (file: FileInfo) => {
    console.log("Analyzing file", file, file.action);

    actions.analyze(file, file.action);

    // onRunAction?.(file)
    // const result = await asrAudio(['../sample_data/out_example1_mp4_fe13ea90/048_243.800_247.200_speech_fe13ea90.mp3']);
    // console.log("result", result);
  };
  */

  // REFACTOR(dry): five near-identical tab handlers (dashboard.tsx:963, :980, :1000, :1017, :1049) — each clears all tabs, activates one and shows one display; table-drive over [{tabRef, displayRef, displayMode}] and keep only the per-tab extras (All Results refreshes events, Log/Raw lazily fetch).
  const onCurrentEventsTabClick = () => {
    console.log("Current Events Tab clicked");
    $(currentEventsTabRef).addClass("uk-active");
    $(allResultsTabRef).removeClass("uk-active");
    $(summaryTabRef).removeClass("uk-active");
    $(logTabRef).removeClass("uk-active");
    $(rawOutputTabRef).removeClass("uk-active");

    $(eventsDisplayRef).css("display", "flex");
    $(transcriptionDisplayRef).css("display", "none");
    $(summaryDisplayRef).css("display", "none");
    $(logDisplayRef).css("display", "none");
    $(rawOutputDisplayRef).css("display", "none");
  };

  const onAllResultsTabClick = () => {
    console.log("All Results Tab clicked");
    $(currentEventsTabRef).removeClass("uk-active");
    $(allResultsTabRef).addClass("uk-active");
    $(summaryTabRef).removeClass("uk-active");
    $(logTabRef).removeClass("uk-active");
    $(rawOutputTabRef).removeClass("uk-active");

    $(eventsDisplayRef).css("display", "none");
    $(transcriptionDisplayRef).css("display", "flex");
    $(summaryDisplayRef).css("display", "none");
    $(logDisplayRef).css("display", "none");
    $(rawOutputDisplayRef).css("display", "none");

    // Update transcription view with all current events
    transcriptionViewRef.state?.updateEvents(allEventsRef);
  };

  const onSummaryTabClick = () => {
    console.log("Summary Tab clicked");
    $(currentEventsTabRef).removeClass("uk-active");
    $(allResultsTabRef).removeClass("uk-active");
    $(summaryTabRef).addClass("uk-active");
    $(logTabRef).removeClass("uk-active");
    $(rawOutputTabRef).removeClass("uk-active");

    $(eventsDisplayRef).css("display", "none");
    $(transcriptionDisplayRef).css("display", "none");
    $(summaryDisplayRef).css("display", "flex");
    $(logDisplayRef).css("display", "none");
    $(rawOutputDisplayRef).css("display", "none");
  };

  /** Load and display debug.log content when Log tab is clicked. The tab is
   * currently hidden (display:none on its <li>, dashboard.tsx:1233); the
   * handler is kept for when it is re-enabled. */
  const onLogTabClick = async () => {
    console.log("Log Tab clicked");
    $(currentEventsTabRef).removeClass("uk-active");
    $(allResultsTabRef).removeClass("uk-active");
    $(summaryTabRef).removeClass("uk-active");
    $(logTabRef).addClass("uk-active");
    $(rawOutputTabRef).removeClass("uk-active");

    $(eventsDisplayRef).css("display", "none");
    $(transcriptionDisplayRef).css("display", "none");
    $(summaryDisplayRef).css("display", "none");
    $(logDisplayRef).css("display", "block");
    $(rawOutputDisplayRef).css("display", "none");

    // Load debug.log content and publish it to the reactive store; the <pre>
    // element in the JSX re-renders automatically from `logContentStore`.
    const fileInfo = fileListRef.state!.getSelectedFile();
    if (!fileInfo) return;
    const debugPath = `${fileInfo.fileName}.archivar/debug.log`;
    try {
      const content = await fileApi.readFile(debugPath);
      // Filter out noisy lines: CORS middleware, debug.log references, FileAPI
      // REFACTOR(magic): these prefixes mirror server log producers ("CORS Middleware processed request:" from src/middleware.ts:81, plus FileAPI/debug.log self-references) — if server formats change the filter silently leaks noise; a shared NOISY_LOG_PREFIXES list would couple less.
      const filtered = content.split('\n').filter(line => !line.startsWith("CORS Middleware processed request:") && !line.includes("debug.log") && !line.includes("FileAPI")).join('\n');
      logContentStore.set(filtered);
    } catch (err) {
      logContentStore.set(`(Error loading debug.log) ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** Load and display debug.json content with syntax highlighting when Raw
   * Output tab is clicked. The tab is currently hidden (display:none on its
   * <li>, dashboard.tsx:1234); the handler is kept for when it is re-enabled. */
  const onRawOutputTabClick = async () => {
    console.log("Raw Output Tab clicked");
    $(currentEventsTabRef).removeClass("uk-active");
    $(allResultsTabRef).removeClass("uk-active");
    $(summaryTabRef).removeClass("uk-active");
    $(logTabRef).removeClass("uk-active");
    $(rawOutputTabRef).addClass("uk-active");

    $(eventsDisplayRef).css("display", "none");
    $(transcriptionDisplayRef).css("display", "none");
    $(summaryDisplayRef).css("display", "none");
    $(logDisplayRef).css("display", "none");
    $(rawOutputDisplayRef).css("display", "block");

    // Load debug.json content with syntax highlighting and publish it to the
    // reactive store; the <code> element re-renders from `rawOutputContentStore`.
    const fileInfo = fileListRef.state!.getSelectedFile();
    if (!fileInfo) return;
    const debugPath = `${fileInfo.fileName}.archivar/debug.json`;
    try {
      const content = await fileApi.readFile(debugPath);
      const json = JSON.parse(content);
      rawOutputContentStore.set(JSON.stringify(json, null, 2));

      // Apply highlight.js if available, after the reactive re-render lands
      if ((window as any).hljs) {
        requestAnimationFrame(() => {
          const codeEl = $(rawOutputDisplayRef).find("code")[0];
          if (codeEl) (window as any).hljs.highlightElement(codeEl);
        });
      }
    } catch (err) {
      rawOutputContentStore.set(`(Error loading debug.json) ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const updateMiddleColumnSize = () => {
    // REFACTOR(magic): "1/2", "3/5", "11/12" are not valid CSS flex-basis values (it expects a length/percentage) — style.setProperty silently ignores them, so only the "100%" case actually takes effect; use percentages or toggle the Tailwind basis-* classes instead (the middle column starts as basis-1/2, dashboard.tsx:1205).
    let flexBasis = "1/2"; // Default when both columns are visible (1/2 = 50%)

    if (!leftColumnVisible && !rightColumnVisible) {
      flexBasis = "100%"; // Both columns hidden
    } else if (!leftColumnVisible) {
      flexBasis = "3/5"; // Left column hidden, right visible (3/5 = 60%)
    } else if (!rightColumnVisible) {
      flexBasis = "11/12"; // Right column hidden, left visible (11/12 = 91.67%)
    }

    $(middleColumnRef).css("flex-basis", flexBasis);
  };

  const onLeftResizerDoubleClick = () => {
    console.log("Left resizer double-clicked");
    leftColumnVisible = !leftColumnVisible;
    if (leftColumnVisible) {
      $(leftColumnRef).css("display", "block");
    } else {
      $(leftColumnRef).css("display", "none");
    }
    updateMiddleColumnSize();
    // Keep resizer visible so user can double-click to restore
  };

  const onRightResizerDoubleClick = () => {
    console.log("Right resizer double-clicked");
    rightColumnVisible = !rightColumnVisible;
    if (rightColumnVisible) {
      $(rightColumnRef).css("display", "block");
    } else {
      $(rightColumnRef).css("display", "none");
    }
    updateMiddleColumnSize();
    // Keep resizer visible so user can double-click to restore
  };

  // Set initial display states - Current Events should be shown by default
  queueMicrotask(() => {
    $(eventsDisplayRef).css("display", "flex");
    $(transcriptionDisplayRef).css("display", "none");
    $(summaryDisplayRef).css("display", "none");
    updateMiddleColumnSize();
  });

  return (
    <div className="flex flex-col h-screen">
      <div className="flex flex-1 overflow-hidden">
        {/* Left Column - Sidebar */}
        <div className="basis-1/12 flex flex-col overflow-hidden" style={{ minWidth: '320px' }} ref={leftColumnRef}>
          <SidebarHeader />
          <div className="flex-1 flex flex-col overflow-hidden p-1 ml-2">
            {/* File List */}
            <div className="flex-1 overflow-hidden overflow-y-auto min-h-0 relative">
              <Reactive
                store={fileListLoadingStore}
                render={() => fileListLoadingStore.value ? <LoadingOverlay /> : <span style="display:none"></span>}
              />
              <FileList ref={fileListRef} onFileChange={onFileChange} onUploadClick={() => uploadWizardRef.state?.open((fileListRef.state?.getSelectedFile() as FileInfo | null) ?? undefined)} onRefreshClick={async () => {
                fileListLoadingStore.set(true);
                try {
                  const inputFiles = await browseInputFiles();
                  fileListRef.state!.setFiles(inputFiles);
                } finally {
                  fileListLoadingStore.set(false);
                }
              }} onFileDelete={async (fileInfo) => {
                const confirmed = await confirmDialogRef.state?.confirm(t("dashboard.delete_confirm", { fileName: fileInfo.fileName }));
                if (!confirmed) return;
                try {
                  // Remember the row position so we can select the previous
                  // file after deletion (or the new first when deleting the
                  // first row) — otherwise the right-hand side keeps showing
                  // the deleted file's data.
                  const deletedIndex = (fileListRef.state?.getFiles() ?? []).findIndex((f) => f.fileName === fileInfo.fileName);
                  const result = await fileApi.deleteFile(fileInfo.fileName);
                  if (result.status === "error") {
                    await confirmDialogRef.state?.confirm(t("dashboard.delete_error") + ": " + result.error);
                    return;
                  }
                  fileListLoadingStore.set(true);
                  try {
                    const inputFiles = await browseInputFiles();
                    fileListRef.state!.setFiles(inputFiles);
                    const nextFile = inputFiles[deletedIndex - 1] ?? inputFiles[0] ?? null;
                    // setSelectedFile with a file is a full activation
                    // (identical to a row click): highlights, notifies
                    // onFileChange → right-hand side loads the new file.
                    fileListRef.state!.setSelectedFile(nextFile);
                  } finally {
                    fileListLoadingStore.set(false);
                  }
                } catch (err) {
                  await confirmDialogRef.state?.confirm(t("dashboard.delete_error") + ": " + (err instanceof Error ? err.message : String(err)));
                }
              }} />
            </div>

            {/* User Account Menu */}
            <div className="mt-auto border-t-2 border-border pt-1">
              <button className="uk-btn uk-btn-default uk-btn-sm w-full flex items-center gap-2 justify-center" type="button">
                <div className="size-4">
                  <uk-icon icon="user"></uk-icon>
                </div>
                {authStore.value.user?.email || authStore.value.user?.name || t("dashboard.user_fallback")}
              </button>
              <div
                className="uk-drop uk-dropdown min-w-40"
                data-uk-dropdown="mode: click; pos: top-left"
              >
                <ul className="uk-nav uk-dropdown-nav">
                  <li className="uk-nav-header">{t("navigation.account")}</li>
                  <li>
                    <a href="#" className="flex items-center gap-1" onClick={() => Router.navigate("/logout")}>
                      <div className="size-4">
                        <uk-icon icon="log-out"></uk-icon>
                      </div>
                      {t("navigation.logout")}
                    </a>
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </div>

        {/* Left Resize Handle */}
        <div
          className="resize-handle-right w-2 bg-primary/20 hover:bg-primary/30 cursor-col-resize flex-shrink-0"
          ref={leftResizerRef}
          onDblClick={onLeftResizerDoubleClick}
        ></div>

        {/* Middle Column - Video Player and Timeline */}
        <div className="basis-1/2 flex flex-col w-full h-full overflow-hidden" ref={middleColumnRef}>
          <div className="flex-1 flex flex-col space-y-3 overflow-x-auto overflow-y-hidden p-2">
            {/* Timeline */}
            <div className="relative">
              <Reactive
                store={fileChangeLoadingStore}
                render={() => fileChangeLoadingStore.value ? <LoadingOverlay /> : <span style="display:none"></span>}
              />
              <Timeline ref={timelineRef} onTimelineClick={onTimelineClick} />
            </div>

            <MediaCanvas
              ref={mediaCanvasRef}
              type="video"
              onProgress={onMediaProgress}
              onMetadata={onMediaMetadata}
            />
          </div>
        </div>

        {/* Right Resize Handle */}
        <div
          className="resize-handle-right w-2 bg-primary/20 hover:bg-primary/30 cursor-col-resize flex-shrink-0"
          ref={rightResizerRef}
          onDblClick={onRightResizerDoubleClick}
        ></div>

        {/* Right Column - Details/Tabs */}
        <div className="basis-2/5 flex flex-col h-full overflow-hidden relative" ref={rightColumnRef}>
          <Reactive
            store={fileChangeLoadingStore}
            render={() => fileChangeLoadingStore.value ? <LoadingOverlay /> : <span style="display:none"></span>}
          />

          {/* Tab Navigation */}
          <ul className="uk-tab  p-2 pb-0 border-b-2 border-border hidden">
            <li style="display:none" ref={currentEventsTabRef} className="uk-active"><a href="javascript:void(0)" onClick={onCurrentEventsTabClick}>Current Events</a></li>
            <li ref={allResultsTabRef}><a href="javascript:void(0)" onClick={onAllResultsTabClick}>All Results</a></li>
            <li style="display:none" ref={logTabRef}><a href="javascript:void(0)" onClick={onLogTabClick}>Log</a></li>
            <li style="display:none" ref={rawOutputTabRef}><a href="javascript:void(0)" onClick={onRawOutputTabClick}>Raw Output</a></li>
            <li style={summaryTabVisibleRef.state ? undefined : "display:none"} ref={summaryTabRef}><a href="javascript:void(0)" onClick={onSummaryTabClick}>{t("dashboard.summary_tab")}</a></li>
          </ul>

          {/* Tab Content */}
          <div className="uk-switcher flex-1 mt-0 overflow-hidden min-h-0">
            {/* Current Events Tab */}
            <div className="flex flex-col h-full hidden" ref={eventsDisplayRef}>
              <EventsList ref={eventsListRef} onCaptionRequested={onCaptionRequested} onAnalyzeModalOpen={onAnalyzeModalOpen} onTimeSeek={onTimeSeek} />
            </div>


            {/* All Results Tab */}
            <div className="flex flex-col h-full overflow-hidden min-h-0 mb-24" ref={transcriptionDisplayRef}>
              {/* Full-width opaque bottom toolbar: AI disclosure note + download button */}
              <div className="flex justify-between items-center absolute left-0 right-0 bottom-0 bg-white border-t border-border px-4 py-2 z-999">
                <span className="text-xs text-gray-500 text-left max-w-2xl self-center">
                  <strong>{t("dashboard.ai_disclosure_label")}</strong> {t("dashboard.ai_disclosure")}
                </span>
                <Reactive
                  store={exportFileNameStore}
                  render={() => exportFileNameStore.value ? (
                    <div className="bg-white">
                      <button className="uk-btn uk-btn-default uk-btn-xs flex items-center cursor-pointer bg-white" type="button">
                        {t("dashboard.download")}
                      </button>
                      <div className="uk-drop uk-dropdown min-w-48" data-uk-dropdown="mode: click; pos: bottom-right">
                        {/* `view=filtered` makes downloads match the on-screen "All Results" view (summary + higher-order aggregations only); the log export is unfiltered. */}
                        <ul className="uk-nav uk-dropdown-nav">
                          <li><a href={`/api/export?file=${encodeURIComponent(exportFileNameStore.value)}&format=docx&view=filtered`} download>{t("dashboard.export_format_word")}</a></li>
                          <li><a href={`/api/export?file=${encodeURIComponent(exportFileNameStore.value)}&format=md&view=filtered`} download>{t("dashboard.export_format_markdown")}</a></li>
                          <li><a href={`/api/export?file=${encodeURIComponent(exportFileNameStore.value)}&format=json&view=filtered`} download>{t("dashboard.export_format_json")}</a></li>
                          <li><a href={`/api/export?file=${encodeURIComponent(exportFileNameStore.value)}&format=srt`} download>{t("dashboard.export_format_srt")}</a></li>
                          <li><a href={`/api/export?file=${encodeURIComponent(exportFileNameStore.value)}&format=vct`} download>{t("dashboard.export_format_vct")}</a></li>
                          <li><a href={`/api/export?file=${encodeURIComponent(exportFileNameStore.value)}&format=log`} download>{t("dashboard.export_format_log")}</a></li>
                        </ul>
                      </div>
                    </div>
                    // defuss jsx() throws "Invalid JSX input" on null — render a hidden element instead
                  ) : <span style="display:none"></span>}
                />
              </div>
              <TranscriptionView ref={transcriptionViewRef} onTimeSeek={onTimeSeek} />
            </div>

            {/* Summary Tab */}
            <div className="flex flex-col h-full" ref={summaryDisplayRef}>
              <SummaryView ref={summaryViewRef} />
            </div>

            {/* Log Tab - displays debug.log */}
            <div className="flex flex-col h-full overflow-y-auto min-h-0" ref={logDisplayRef} style={{ display: "none" }}>
              <div className="flex-1 min-h-0" style={{ overflowY: "scroll" }}>
                <Reactive
                  store={logContentStore}
                  render={() => (
                    <pre className="p-2 text-xs font-mono bg-gray-900 text-green-400 rounded" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{logContentStore.value}</pre>
                  )}
                />
              </div>
            </div>

            {/* Raw Output Tab - displays debug.json with syntax highlighting */}
            <div className="flex flex-col h-full overflow-y-auto min-h-0" ref={rawOutputDisplayRef} style={{ display: "none" }}>
              <div className="flex-1 overflow-y-auto min-h-0">
                <Reactive
                  store={rawOutputContentStore}
                  render={() => (
                    <pre className="p-2 bg-gray-900 rounded"><code className="language-json" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", overflow: "auto" }}>{rawOutputContentStore.value}</code></pre>
                  )}
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Upload Wizard */}
      <UploadWizard ref={uploadWizardRef} onUploadComplete={async (fileName) => {
        fileListLoadingStore.set(true);
        try {
          const inputFiles = await browseInputFiles();
          fileListRef.state!.setFiles(inputFiles);
          // Activate the just-processed file (same as a manual row click) and
          // scroll it into view in the sidebar.
          const uploaded = inputFiles.find((f) => f.fileName === fileName);
          if (uploaded) fileListRef.state!.setSelectedFile(uploaded);
        } finally {
          fileListLoadingStore.set(false);
        }
      }} />

      {/* Confirm Dialog */}
      <ConfirmDialog ref={confirmDialogRef} confirmLabel={t("common.delete")} cancelLabel={t("common.cancel")} />

      {/* Analyze Modal */}
      <AnalyzeModal ref={analyzeModalRef} onConfirm={onAnalyzeModalConfirm} />
    </div>
  );
}
