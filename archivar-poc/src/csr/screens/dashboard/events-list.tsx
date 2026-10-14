import { createRef, t, type Ref, type Props, $ } from "defuss";
import { type RegionType } from "../../../cl/components/region-icon";
import type { FileInfo } from "../../../rpc/file-api";
import type { JsonValue } from "../../../lib/plugin-types.js";
import { SceneVisualization, type SceneVisualizationRef } from "./scene-visualization";
import { Button, Spinner } from "../../../cl";
import { renderMarkdown, renderInlineMarkdown } from "../../lib/markdown.js";

// REFACTOR(dry): regionEmoji is copy-pasted across 4 dashboard files and already diverging
// (scene is 🎨 here but 🎬 in timeline.tsx) — here, transcription-view.tsx:25, timeline.tsx:3,
// analyze-modal.tsx:14. Hoist one shared map (e.g. next to cl/components/region-icon).
const regionEmoji: Record<string, string> = {
  speech: "🎤",
  silence: "🔇",
  noise: "🔊",
  ambience: "🎵",
  harmonic: "〰️",
  scene: "🎨",
  sceneKeyframe: "🖼️",
  semanticAggregation: "∑",
};
import { getRpcClient } from "defuss-rpc/client.js";
import type { RpcApi } from "../../../rpc.js";

const rpc = await getRpcClient<RpcApi>();
const cacheApi = new rpc.CacheApi();

// REFACTOR(dry): identical getCacheId in transcription-view.tsx:47 and
// dashboard.tsx:35 — the key format is an implicit writer/reader contract
// (see the "-keyframe" vs "-kf" mismatch below); centralize it.
const getCacheId = (hash: string, index: number) => {
  return `${hash}-${index}`
}

// The Current Events table renders higher-order aggregation (H-*) rows only.
// Regular event types are filtered out here (their per-event download buttons
// disappear with them); add a type back to show its rows again. Data loading
// and the timeline are unaffected.
const VISIBLE_EVENT_TYPES: ReadonlySet<EventItem["type"]> = new Set();

type DetectionType = RegionType;

/**
 * One row of the Current Events table. Built by the dashboard screen from timeline regions
 * (createEventsFromRegions) and pushed in via EventsListRef.updateEvents. `timeMs` is the
 * seek/display anchor; `startMs`/`endMs` mark duration events and drive the "active at
 * current time" filter — point events without them fall back to a ±1s window around
 * `timeMs`. The v3 aggregation fields are only set on "semanticAggregation" (A-*) rows.
 */
export interface EventItem {
  id: string;
  timeMs: number;
  type: RegionType | "scene" | "sceneKeyframe" | "semanticAggregation";
  caption: string;
  startMs?: number;
  endMs?: number;
  fileInfo?: FileInfo;
  // v3 semantic aggregation fields
  aggregationId?: string;
  aggregationIndex?: number;
  aggregationSummary?: string | JsonValue;
}

/**
 * Higher-order aggregation - displayed in Current Events tab when time overlaps.
 * `aggregationIndexes` references the `aggregationIndex` of A-* events; the visible
 * timeframe is derived from the first/last referenced aggregation at render time.
 */
// REFACTOR(dry): a same-named interface with more fields lives in transcription-view.tsx:9
// and dashboard.tsx:793/796 feeds the same data to both — merge into one shared type.
export interface HigherOrderAggregation {
  id: string;
  index: number;
  aggregationIndexes: number[];
  title: string;
  description: string;
}

/**
 * Imperative API consumed by the dashboard screen via ref.state: updateEvents replaces the
 * dataset, filterEventsByTime re-filters on every media progress tick, updateCaption
 * delivers an async analysis result back into the caption panel (and re-enables the
 * analyze button).
 */
export interface EventsListRef {
  updateEvents: (events: EventItem[]) => void;
  updateHigherOrderAggregations: (hoas: HigherOrderAggregation[]) => void;
  filterEventsByTime: (currentTimeMs: number) => void;
  updateCaption: (caption: string, type: string, bbox_2d: { bbox_2d: [number, number, number, number], label: string, details: string }[]) => void;
}

export interface EventsListProps extends Props {
  ref?: Ref<HTMLDivElement, EventsListRef>;
  onCaptionRequested?: (fileInfo: FileInfo, detectionType: DetectionType) => void;
  onAnalyzeModalOpen?: (fileInfo: FileInfo, detectionType: DetectionType) => void;
  onTimeSeek?: (timeMs: number) => void;
}

/**
 * Current Events panel: time-filtered event table (H-* aggregation rows plus any
 * VISIBLE_EVENT_TYPES), a caption panel with the per-event (re-)analyze entry point, and
 * the intentionally hidden SceneVisualization (kept per product decision — do not remove).
 * Rendering is imperative: the dashboard pushes data through ref.state methods and the
 * table body is re-rendered on every call, including each media progress tick.
 */
export const EventsList = ({ ref = createRef<HTMLDivElement, EventsListRef>(), onCaptionRequested, onAnalyzeModalOpen, onTimeSeek }: EventsListProps) => {
  const tableBodyRef = createRef<HTMLTableSectionElement>();
  const captionPanelRef = createRef<HTMLDivElement>();
  const captionMdRef = createRef<HTMLDivElement>();
  const sceneVisualizationRef = createRef<HTMLDivElement, SceneVisualizationRef>();
  const analyzeButtonRef = createRef<HTMLButtonElement>();

  let allEvents: EventItem[] = [];
  let allAggregationEvents: EventItem[] = []; // Store aggregation events separately for HOA timeframe lookup
  let higherOrderAggregations: HigherOrderAggregation[] = [];
  let currentTimeMs = 0;
  let selectedEvent: EventItem | null = null;
  let selectedHoa: HigherOrderAggregation | null = null; // Track selected HOA
  let clickedEventId: string | null = null;
  // REFACTOR(kiss): never assigned true anywhere in this file — the spinner branch and the
  // disabled-button styles in updateCaptionPanel are unreachable. Wire it up (set true in
  // handleAnalyzeClick) or delete the state.
  let isAnalyzing = false;

  // REFACTOR(dry): formatTime duplicates transcription-view.tsx:85, and formatDuration
  // below is the same mm:ss formatting applied to a delta — extract one shared helper.
  const formatTime = (timeMs: number): string => {
    const totalSeconds = Math.floor(timeMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  };

  const isVideoOrAudioType = (type: RegionType | "scene" | "sceneKeyframe" | "semanticAggregation"): boolean => {
    // Semantic aggregation is not video/audio
    if (type === "semanticAggregation") return false;
    // Audio-related types
    const audioTypes: string[] = ["speech", "silence", "noise", "ambience", "harmonic"];
    // Video-related types
    const videoTypes: string[] = ["scene", "sceneKeyframe"];

    return audioTypes.includes(type) || videoTypes.includes(type);
  };

  const formatDuration = (startMs: number, endMs: number): string => {
    const durationMs = endMs - startMs;
    const totalSeconds = Math.floor(durationMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  };

  const getEventTypeDisplay = (type: RegionType | "scene" | "sceneKeyframe" | "semanticAggregation"): string => {
    switch (type) {
      case "speech":
        return t("events_list.type_speech");
      case "silence":
        return t("events_list.type_silence");
      case "noise":
        return t("events_list.type_noise");
      case "ambience":
        return t("events_list.type_ambience");
      case "harmonic":
        return t("events_list.type_harmonic");
      case "scene":
        return t("events_list.type_scene");
      case "sceneKeyframe":
        return t("events_list.type_scene_keyframe");
      case "semanticAggregation":
        return t("events_list.type_semantic_aggregation") || "Semantic Aggregation";
      default:
        return t("events_list.type_unknown");
    }
  };

  // REFACTOR(dry): never called in this file — only transcription-view.tsx uses its own copy
  // (transcription-view.tsx:106). Same for getEventTypeDisplay above (events-list.tsx:116 vs
  // transcription-view.tsx:92): keep one shared event-type presentation implementation.
  const getEventTypeColor = (type: RegionType | "scene" | "sceneKeyframe" | "semanticAggregation"): string => {
    switch (type) {
      case "speech":
        return "text-blue-600";
      case "silence":
        return "text-green-600";
      case "noise":
        return "text-yellow-600";
      case "ambience":
        return "text-purple-600";
      case "harmonic":
        return "text-red-600";
      case "scene":
        return "text-orange-600";
      case "sceneKeyframe":
        return "text-pink-600";
      case "semanticAggregation":
        return "text-indigo-600";
      default:
        return "text-gray-600";
    }
  };

  const isEventActive = (event: EventItem): boolean => {
    // Only activate events that have been clicked by the user
    // AND are at the current time
    if (clickedEventId !== event.id) {
      return false;
    }

    // The event is already filtered by time in renderEvents, so if it's here, it's at current time
    return true;
  };

  /**
   * Activates a row on click: lazily loads a cached caption when the event has none,
   * refreshes the caption panel and the (hidden) scene visualization, then re-renders the
   * table so the clicked row shows as active. Activation is transient during playback —
   * the next filterEventsByTime tick clears it via clearActivationState.
   */
  const handleEventClick = async (event: EventItem) => {
    selectedEvent = event;
    clickedEventId = event.id;

    // Check cache if caption is missing (skip semanticAggregation which already has summary data)
    // REFACTOR(dry): this per-type cache-read chain duplicates transcription-view.tsx:373
    // (loadCaptionsFromCache) and dashboard.tsx:355-540 — three copies of the same
    // type→(cache table, key suffix) mapping; extract one shared resolver.
    if (event.type !== "semanticAggregation" && (!event.caption || event.caption.trim() === "") && (event.fileInfo?.outputHash || event.fileInfo?.fileName)) {
      try {
        let caption = "";
        const hash = event.fileInfo.outputHash || event.fileInfo.fileName;
        const index = event.fileInfo.index || 0;

        if (event.type === "scene") {
          const id = getCacheId(hash, index);
          const cached = await cacheApi.get("scene", id, null) as { caption?: string } | null;
          if (cached?.caption) caption = cached.caption;
        } else if (event.type === "sceneKeyframe") {
          // REFACTOR(consistency): readers use the "-keyframe" key suffix, but the
          // removed legacy client-side writer stored keyframe captions under "-kf" —
          // captions written by it are never found here (same in transcription-view.tsx:397).
          const id = getCacheId(`${hash}-keyframe`, index);
          const cached = await cacheApi.get("keyframe", id, null) as { caption?: string } | null;
          if (cached?.caption) caption = cached.caption;
        } else if (event.type === "speech") {
          const id = getCacheId(`${hash}-speech`, index);
          const cached = await cacheApi.get("speech", id, null) as { caption?: string } | null;
          if (cached?.caption) caption = cached.caption;
        } else if (event.type === "harmonic" || event.type === "noise") {
          const suffix = event.type === "harmonic" ? "harmonic" : "noise";
          const id = getCacheId(`${hash}-${suffix}`, index);
          const cached = await cacheApi.get("audio", id, null) as { caption?: string } | null;
          if (cached?.caption) caption = cached.caption;
        }

        if (caption) {
          console.log("Loaded caption from cache:", caption);
          event.caption = caption;
          // Force update if needed? updateCaptionPanel uses selectedEvent which refers to this event object.
        }
      } catch (e) {
        console.error("Error reading cache:", e);
      }
    }

    updateCaptionPanel();

    // Update scene visualization if event has file info
    if (event.fileInfo) {
      // REFACTOR(kiss): both branches call updateScene with identical arguments — collapse
      // the if/else (the keyframe distinction no longer changes behavior).
      if (event.type === "sceneKeyframe") {
        // For scene keyframes, render as image
        sceneVisualizationRef.state!.updateScene(event.fileInfo, event.timeMs);
      } else {
        // For other events, use normal scene visualization
        sceneVisualizationRef.state!.updateScene(event.fileInfo, event.timeMs);
      }
    }

    // Re-render to show the clicked event as active
    const eventsVdom = renderEvents(allEvents);
    $(tableBodyRef).update(eventsVdom);
  };

  const handleAnalyzeClick = () => {
    if (selectedEvent?.fileInfo && onAnalyzeModalOpen && !isAnalyzing) {
      onAnalyzeModalOpen(selectedEvent.fileInfo, selectedEvent.type as DetectionType);
    }
  };

  const clearActivationState = () => {
    selectedEvent = null;
    clickedEventId = null;
    isAnalyzing = false;

    // Clear caption panel to initial empty state
    if (captionPanelRef.current) {
      $(captionPanelRef).update(
        <div className="flex flex-col h-full min-h-0 max-h-full">
          <div className="p-2 border-t-3 border-border flex-shrink-0">
            <h4 className="text-md font-semibold mb-2">{t("events_list.caption")}</h4>
          </div>
          <div className="flex-1 overflow-y-auto p-4 pt-0 min-h-0 max-h-full">
            <p className="text-gray-700 italic">{t("events_list.no_region_selected")}</p>
          </div>
        </div>
      );
    }

    // Clear scene visualization to initial state
    if (sceneVisualizationRef.current) {
      sceneVisualizationRef.state!.clearScene();
    }
  };

  /**
   * Re-renders the caption panel for selectedEvent. Markdown cannot be injected through the
   * VDOM, so after $(...).update() commits we set innerHTML inside requestAnimationFrame via
   * querySelector('.markdown-content') — a ref would still point at the pre-update node.
   */
  const updateCaptionPanel = () => {
    if (captionPanelRef.current) {
      const captionText = selectedEvent?.caption || '';
      const hasEmptyCaption = !captionText || captionText.trim() === '';
      console.log("[events-list] updateCaptionPanel:", {
        hasCaption: !!selectedEvent?.caption,
        captionLength: captionText.length,
        hasEmptyCaption,
        isAnalyzing,
        eventType: selectedEvent?.type,
      });

      const panelContent = (
        <div className="flex flex-col h-full min-h-0 max-h-full">
          <div className="p-2 border-t-3 border-border flex-shrink-0">
            <h3 className="text-md font-semibold h-6">{t("events_list.caption")}</h3>
          </div>
          <div className="flex-1 overflow-y-auto p-4 pt-0 min-h-0 max-h-full">
            <div className="mb-4">
              {hasEmptyCaption && !isAnalyzing ? (
                <p className="text-gray-700 italic">{t("events_list.no_caption_available")}</p>
              ) : isAnalyzing ? (
                <div className="flex items-center space-x-2">
                  <Spinner size={24} />
                  <p className="text-gray-700 italic">{t("events_list.analyzing")}</p>
                </div>
              ) : (
                <div className="markdown-content" />
              )}
            </div>
            {selectedEvent?.fileInfo && (
              <Button
                ref={analyzeButtonRef}
                type="primary"
                className={`cursor-pointer ${isAnalyzing ? 'opacity-50 cursor-not-allowed' : ''}`}
                onClick={handleAnalyzeClick}
                disabled={isAnalyzing}
              >
                {isAnalyzing ? t('events_list.analyzing') : (hasEmptyCaption ? t('events_list.analyze') : t('events_list.re_analyze'))}
              </Button>
            )}
          </div>
        </div>
      );

      $(captionPanelRef).update(panelContent);
      // Render caption text as markdown after VDOM commit
      requestAnimationFrame(() => {
        const mdEl = captionPanelRef.current?.querySelector('.markdown-content');
        console.log("[events-list] RAF querySelector:", {
          foundMd: !!mdEl,
          hasCaption: !!captionText,
          panelExists: !!captionPanelRef.current,
        });
        if (mdEl && captionText) {
          const html = renderMarkdown(captionText);
          console.log("[events-list] Setting innerHTML, length:", html.length);
          (mdEl as HTMLElement).innerHTML = html;
        }
      });
    } else {
      console.log("[events-list] updateCaptionPanel: captionPanelRef.current is null!");
    }
  };

  /** Aggregations (A-*) always sort before clips; times compare at whole-second precision so sub-second jitter doesn't reorder rows. */
  const sortEvents = (events: EventItem[]): EventItem[] => {
    return [...events].sort((a, b) => {
      // Aggregations always on top regardless of time
      if (a.type === "semanticAggregation" && b.type !== "semanticAggregation") return -1;
      if (a.type !== "semanticAggregation" && b.type === "semanticAggregation") return 1;

      // Sort by time first (rounded to seconds to avoid millisecond precision issues)
      const timeA = Math.floor(a.timeMs / 1000);
      const timeB = Math.floor(b.timeMs / 1000);
      if (timeA !== timeB) return timeA - timeB;

      return 0;
    });
  };

  // REFACTOR(complexity): ~150-line render closure — time filtering, HOA timeframe lookup,
  // two row templates and nested click handlers in one function; split into filterAtTime(),
  // renderEventRow() and renderHoaRow() helpers.
  const renderEvents = (events: EventItem[]) => {
    if (events.length === 0) {
      return (
        <tr>
          <td colSpan={4} className="text-center text-gray-500 py-4">
            {t("events_list.no_events_loaded")}
          </td>
        </tr>
      );
    }

    // Sort events with aggregations always on top
    const sorted = sortEvents(events);

    // Filter aggregation events for HOA timeframe lookup
    allAggregationEvents = sorted.filter(e => e.type === "semanticAggregation");

    // Always filter by current time, but only highlight as active if clicked
    const eventsAtCurrentTime = sorted.filter(event => {
      if (event.startMs !== undefined && event.endMs !== undefined) {
        // For events with duration, check if current time is within the range
        return currentTimeMs >= event.startMs && currentTimeMs <= event.endMs;
      } else {
        // For point-in-time events, check if current time is close
        // REFACTOR(magic): ±1000ms "point event is current" window — name it
        // (POINT_EVENT_TOLERANCE_MS); it defines how wide the now-active zone is.
        return Math.abs(currentTimeMs - event.timeMs) <= 1000;
      }
    }).filter(event => VISIBLE_EVENT_TYPES.has(event.type));

    // Filter HOAs that overlap with current time
    const hoasAtCurrentTime = higherOrderAggregations.filter(hoa => {
      // Find first and last aggregation by index
      const firstAgg = allAggregationEvents.find(e => e.aggregationIndex === hoa.aggregationIndexes[0]);
      const lastAgg = allAggregationEvents.find(e => e.aggregationIndex === hoa.aggregationIndexes[hoa.aggregationIndexes.length - 1]);
      if (!firstAgg || !lastAgg) return false;
      const startMs = firstAgg.startMs ?? firstAgg.timeMs;
      const endMs = lastAgg.endMs ?? lastAgg.timeMs;
      return currentTimeMs >= startMs && currentTimeMs <= endMs;
    });

    if (eventsAtCurrentTime.length === 0 && hoasAtCurrentTime.length === 0) {
      return (
        <tr>
          <td colSpan={4} className="text-center text-gray-500 py-4">
            {t("events_list.no_events_at_current_time")}
          </td>
        </tr>
      );
    }

    const handleDownloadClick = (serverUrl: string) => {
      window.open(serverUrl, "_blank");
    };

    const handleHoaClick = (hoa: HigherOrderAggregation) => {
      selectedHoa = hoa;
      selectedEvent = null;
      clickedEventId = null;
      // Show HOA description in caption panel
      if (captionPanelRef.current) {
        $(captionPanelRef).update(
          <div className="flex flex-col h-full min-h-0 max-h-full">
            <div className="p-2 border-t-3 border-border flex-shrink-0">
              <h3 className="text-md font-semibold h-6 text-green-800">{t("dashboard.higher_order_aggregations")}: <span dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(hoa.title) }} /></h3>
            </div>
            <div className="flex-1 overflow-y-auto p-4 pt-0 min-h-0 max-h-full">
              <div className="text-sm mt-2">
                <div className="markdown-content prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: renderMarkdown(hoa.description) }} />
              </div>
            </div>
          </div>
        );
      }
    };

    // Render regular events
    const eventRows = eventsAtCurrentTime.flatMap((event) => {
      const isAgg = event.type === "semanticAggregation";
      // REFACTOR(typo): "bg-grey-800" in the row className below is not a Tailwind class
      // (the palette is "gray") — the selected-row background silently never applies;
      // it's a class string, not a public API, so safe to fix.
      const eventRow = (
        <tr
          key={event.id}
          className={`cursor-pointer ${isEventActive(event) ? "uk-active" : ""} ${selectedEvent?.id === event.id ? "bg-grey-800" : ""} ${isAgg ? "bg-purple-50" : ""}`}
          onClick={() => handleEventClick(event)}
        >
          <td className={`font-mono text-sm font-bold ${isAgg ? "text-purple-600" : ""}`}>
            <span style={{ paddingLeft: isAgg ? undefined : "12px" }}>
              {isAgg ? `A-${event.aggregationIndex}` : `${event.id.split(/[-:]/).pop()}`}
            </span>
          </td>
          <td className="font-mono text-sm">
            <a
              href="javascript:void(0)"
              className="text-primary hover:underline cursor-pointer"
              onClick={(e: Event) => { e.stopPropagation(); onTimeSeek?.(event.timeMs); }}
            >
              {formatTime(event.timeMs)}
            </a>
            {(isVideoOrAudioType(event.type) || isAgg) && event.startMs !== undefined && event.endMs !== undefined && (
              <span className="text-gray-500 ml-2">
                ({formatDuration(event.startMs, event.endMs)})
              </span>
            )}
          </td>
          <td className="flex items-center space-x-2">
            <span>{regionEmoji[event.type] || '❓'}</span>
            <span className="text-sm">{getEventTypeDisplay(event.type)}</span>
          </td>
          <td>
            {!isAgg && event.fileInfo?.serverUrl && (
              <Button className="m-0 cursor-pointer" type="primary" size="sm" onClick={() => handleDownloadClick(event.fileInfo!.serverUrl!)} target="_blank">
                ⬇
              </Button>
            )}
          </td>
        </tr>
      );
      return [eventRow];
    });

    // Render HOA rows with green background
    const hoaRows = hoasAtCurrentTime.flatMap((hoa) => {
      const eventRow = (
        <tr
          key={`hoa-${hoa.id}`}
          className={`cursor-pointer bg-green-100 ${selectedHoa?.id === hoa.id ? "bg-green-200" : ""}`}
          onClick={() => handleHoaClick(hoa)}
        >
          <td className={`font-mono text-sm font-bold text-green-600`}>
            <span style={{ paddingLeft: "0px" }}>
              H-{hoa.index + 1}
            </span>
          </td>
          <td className="font-mono text-sm text-green-600">
            ∑
          </td>
          <td className="flex items-center space-x-2">
            <span className="text-green-600">📖</span>
            <span className="text-sm text-green-800" dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(hoa.title) }} />
          </td>
          <td>
          </td>
        </tr>
      );
      return [eventRow];
    });

    return [...hoaRows, ...eventRows];
  };

  ref.state = {
    ...ref.state,
    updateCaption: (caption: string, type: string, bbox_2d: { bbox_2d: [number, number, number, number], label: string, details: string }[]) => {
      isAnalyzing = false; // Re-enable the button
      if (captionPanelRef.current) {
        $(captionPanelRef).update(
          <div className="flex flex-col h-full min-h-0 max-h-full">
            <div className="p-2 border-t-3 border-border flex-shrink-0">
              <h4 className="text-md font-semibold mb-2">{t("events_list.caption")}</h4>
            </div>
            <div className="flex-1 overflow-y-auto p-4 pt-0 min-h-0 max-h-full">
              <div className="mb-4">
                <div ref={captionMdRef} className="markdown-content" />
              </div>
              {type && <div className="mb-4">
                <p className="whitespace-pre-wrap break-words">{t("events_list.type_label")}: {type}</p>
              </div>}
              {bbox_2d && <div className="mb-4">
                <p className="whitespace-pre-wrap break-words">{bbox_2d.map(obj => `${obj.label}: ${obj.details}`).join("\n")}</p>
              </div>}
            </div>
          </div>
        );
        // Render caption as markdown after VDOM commit (querySelector, not ref)
        requestAnimationFrame(() => {
          const mdEl = captionPanelRef.current?.querySelector('.markdown-content');
          if (mdEl && caption) {
            (mdEl as HTMLElement).innerHTML = renderMarkdown(caption);
          }
        });
      }
    },
    updateEvents: (events: EventItem[]) => {
      allEvents = events;
      // Clear activation state when events are updated
      clearActivationState();
      // Re-render with current time filter
      const eventsVdom = renderEvents(allEvents);
      $(tableBodyRef).update(eventsVdom);
    },
    filterEventsByTime: (timeMs: number) => {
      // Invoked on every media progress tick (25ms cadence while playing — see MediaCanvas)
      // and on timeline/row seeks. Keep it cheap: it re-renders the whole table body.
      // Note the side effect: clearActivationState wipes any click selection, so a row
      // only stays active while playback is paused.
      currentTimeMs = timeMs;
      // Clear activation state when the transport time changes
      clearActivationState();
      // Re-render with new time filter
      const eventsVdom = renderEvents(allEvents);
      $(tableBodyRef).update(eventsVdom);
    },
    updateHigherOrderAggregations: (hoas: HigherOrderAggregation[]) => {
      higherOrderAggregations = hoas;
      // Re-render with current time filter to show HOAs at current time
      const eventsVdom = renderEvents(allEvents);
      $(tableBodyRef).update(eventsVdom);
    }
  };

  // Initial render
  const initialEventsVdom = renderEvents(allEvents);

  return (
    <div className="flex flex-col h-full overflow-hidden max-h-full">
      <div className="overflow-x-auto -mt-2 h-40 flex-shrink-0">
        <table className="uk-table uk-table-divider uk-table-hover uk-table-sm w-full">
          <thead>
            <tr>
              <th className="text-left p-2">{t("events_list.col_id")}</th>
              <th className="text-left p-2">{t("events_list.col_time")}</th>
              <th className="text-left p-2">{t("events_list.col_event")}</th>
              <th className="text-left p-2">{t("events_list.col_download")}</th>
            </tr>
          </thead>
          <tbody ref={tableBodyRef}>
            {initialEventsVdom}
          </tbody>
        </table>
      </div>

      {/* Scene Visualization - directly below region listing, takes only needed space */}
      <div className="flex-shrink-0 mb-2 hidden">
        <SceneVisualization ref={sceneVisualizationRef} />
      </div>

      {/* Caption Panel - takes remaining space and scrolls internally */}
      <div ref={captionPanelRef} className="flex-1 flex flex-col min-h-0 overflow-hidden max-h-full">
        {/* Initial empty state */}
        <div className="flex flex-col h-full min-h-0 max-h-full">
          <div className="p-4 flex-shrink-0 border-t-2 border-primary/40">
            <h4 className="text-md font-semibold mb-2">{t("events_list.caption")}</h4>
          </div>
          <div className="flex-1 overflow-y-auto p-4 pt-0 min-h-0 max-h-full">
            <p className="text-gray-700 italic">{t("events_list.no_event_selected")}</p>
          </div>
        </div>
      </div>
    </div>
  );
};
