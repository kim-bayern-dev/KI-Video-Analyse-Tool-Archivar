import { createRef, t, type Ref, type Props, $ } from "defuss";
import { type RegionType } from "../../../cl/components/region-icon";
import type { EventItem } from "./events-list";
import { getRpcClient } from "defuss-rpc/client.js";
import type { RpcApi } from "../../../rpc.js";
import { renderMarkdown, renderInlineMarkdown } from "../../lib/markdown.js";
import { formatProcessingTime } from "../../../lib/result-view.js";

/** Higher-order aggregation with visual artifacts and perception matrix */
// REFACTOR(dry): a same-named interface with fewer fields exists in events-list.tsx:52 and
// dashboard.tsx:793/796 passes the same data to both components — unify into one shared type.
export interface HigherOrderAggregation {
  id: string;
  index: number;
  title: string;
  description: string;
  aggregationIndexes: number[];
  visualArtifacts: Array<{
    artifact: string;
    exactCaption: string;
    confidence: number;
    temporalStability: number;
  }>;
  perceptionMatrix?: Record<string, unknown>;
  intentionClassification?: string;
}

// REFACTOR(dry): regionEmoji is copy-pasted across 4 dashboard files and already diverging
// (scene is 🎨 here but 🎬 in timeline.tsx) — events-list.tsx:9, here, timeline.tsx:3,
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



// The Current Events table renders higher-order aggregation (H-*) rows only.
// Regular event types are filtered out here (their per-event download buttons
// disappear with them); add a type back to show its rows again. Data loading
// and the timeline are unaffected.
const VISIBLE_EVENT_TYPES: ReadonlySet<EventItem["type"]> = new Set([]);

const rpc = await getRpcClient<RpcApi>();
const cacheApi = new rpc.CacheApi();

// REFACTOR(dry): identical getCacheId in events-list.tsx:25 and
// dashboard.tsx:35 — the key format is an implicit writer/reader contract
// (see the "-keyframe" vs "-kf" mismatch in events-list.tsx); centralize it.
const getCacheId = (hash: string, index: number) => {
  return `${hash}-${index}`
};

/** Whole-file summary (v3 result); every field is optional and the summary header renders whichever are present. */
export interface TranscriptionSummary {
  title?: string;
  short_description?: string;
  long_summary?: string;
  keywords?: string[];
  abstract?: string;
  tags?: string[];
  categorization?: string;
  overallIntention?: string;
  narrativeArc?: string;
  perceptionArc?: string;
}

/** Provenance footer data (rendered at the bottom of the All Results tab). */
export interface ResultProvenance {
  fileName: string;
  workflow?: string;
  asrModel?: string;
  vlmModel?: string;
  processingTimeMs?: { preProcessing: number; processing: number; postProcessing: number; total: number };
  tokenUsage?: { input: number; output: number; total: number };
  nonFatalErrors?: { count: number; trace: Array<{ reason: string; model: string; details: string }> };
}

/**
 * Imperative API driven by dashboard.tsx: updateEvents pushes the full result set (captions
 * backfilled from cache asynchronously), the set* methods fill the summary / HOA /
 * provenance sections. Each call re-renders the entire list container and re-injects markdown.
 */
export interface TranscriptionViewRef {
  updateEvents: (events: EventItem[]) => Promise<void>;
  setSummary: (summary: TranscriptionSummary | null) => void;
  setHigherOrderAggregations: (hoas: HigherOrderAggregation[]) => void;
  setProvenance: (meta: ResultProvenance | null) => void;
}

export interface TranscriptionViewProps extends Props {
  ref?: Ref<HTMLDivElement, TranscriptionViewRef>;
  onTimeSeek?: (timeMs: number) => void;
}

// REFACTOR(dry): identical mm:ss formatter in events-list.tsx:90 — extract one shared helper.
const formatTime = (timeMs: number): string => {
  const totalSeconds = Math.floor(timeMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
};

// REFACTOR(dry): label/color presentation pair duplicated from events-list.tsx:116/139 —
// one shared event-type presentation module would end the drift between the copies.
const getEventTypeDisplay = (type: RegionType | "scene" | "sceneKeyframe" | "semanticAggregation"): string => {
  switch (type) {
    case "speech": return t("events_list.type_speech");
    case "silence": return t("events_list.type_silence");
    case "noise": return t("events_list.type_noise");
    case "ambience": return t("events_list.type_ambience");
    case "harmonic": return t("events_list.type_harmonic");
    case "scene": return t("events_list.type_scene");
    case "sceneKeyframe": return t("events_list.type_scene_keyframe");
    case "semanticAggregation": return t("events_list.type_semantic_aggregation");
    default: return t("events_list.type_unknown");
  }
};

const getEventTypeColor = (type: RegionType | "scene" | "sceneKeyframe" | "semanticAggregation"): string => {
  switch (type) {
    case "speech": return "text-blue-600";
    case "silence": return "text-green-600";
    case "noise": return "text-yellow-600";
    case "ambience": return "text-purple-600";
    case "harmonic": return "text-red-600";
    case "scene": return "text-orange-600";
    case "sceneKeyframe": return "text-pink-600";
    case "semanticAggregation": return "text-purple-600";
    default: return "text-gray-600";
  }
};

const getOriginBadge = (type: RegionType | "scene" | "sceneKeyframe" | "semanticAggregation"): { label: string; bgClass: string } => {
  const audioTypes: string[] = ["speech", "silence", "noise", "ambience", "harmonic"];
  if (audioTypes.includes(type)) {
    return { label: t("dashboard.origin_audio"), bgClass: "bg-blue-100 text-blue-800" };
  }
  if (type === "sceneKeyframe") {
    return { label: t("dashboard.origin_image"), bgClass: "bg-green-100 text-green-800" };
  }
  if (type === "semanticAggregation") {
    return { label: t("dashboard.origin_aggregation") || "Aggregation", bgClass: "bg-purple-100 text-purple-800" };
  }
  return { label: t("dashboard.origin_video"), bgClass: "bg-orange-100 text-orange-800" };
};

/**
 * "All Results" tab: summary header, higher-order aggregations, the full event list and a
 * provenance footer. Plain re-render of the list container on every setter call; markdown
 * HTML is injected after each commit by applyMarkdown (the VDOM cannot emit raw HTML).
 * Event rows are currently all filtered out (see VISIBLE_EVENT_TYPES) — the sections
 * around them stay visible.
 */
export const TranscriptionView = ({ ref = createRef<HTMLDivElement, TranscriptionViewRef>(), onTimeSeek }: TranscriptionViewProps) => {
  const listRef = createRef<HTMLDivElement>();
  const transcriptionMdRef = createRef<HTMLDivElement>();
  let allEvents: EventItem[] = [];
  let currentSummary: TranscriptionSummary | null = null;
  let currentProvenance: ResultProvenance | null = null;
  let higherOrderAggregations: HigherOrderAggregation[] = [];

  // REFACTOR(complexity): ~160-line render closure with four section IIFEs — extract
  // renderSummary/renderHoas/renderEvents/renderProvenance (the orphaned renderEvents
  // below shows extraction was started but abandoned).
  const renderContent = () => {
    const summary = currentSummary;
    const events = allEvents;
    const hoas = higherOrderAggregations;

    // Sort chronologically by time (rounded to seconds), with aggregations before clips (branch before leaf)
    const sorted = [...events].sort((a, b) => {
      const timeA = Math.floor(a.timeMs / 1000);
      const timeB = Math.floor(b.timeMs / 1000);
      if (timeA !== timeB) return timeA - timeB;
      if (a.type === "semanticAggregation" && b.type !== "semanticAggregation") return -1;
      if (a.type !== "semanticAggregation" && b.type === "semanticAggregation") return 1;
      return 0;
    });

    const summaryEl = (() => {
      if (!summary) return null;
      const { title, short_description, long_summary, keywords, abstract, tags, categorization, overallIntention, narrativeArc, perceptionArc } = summary;
      const labeledLine = (label: string, value?: string) => value ? (
        <div className="text-sm mb-1"><span className="font-semibold">{label}: </span><span dangerouslySetInnerHTML={{ __html: renderMarkdown(value) }} /></div>
      ) : null;
      return (
        <div className="p-4 border-b border-border bg-cyan-50 border-b-2 border-border">
          {title && <h3 className="text-lg font-bold mb-2" dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(title) }} />}
          {keywords && keywords.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-2">
              {keywords.map((kw, i) => (
                <span key={i} className="text-xs px-2 py-0.5 bg-cyan-100 text-cyan-800 rounded">{kw}</span>
              ))}
            </div>
          )}
          {short_description && <h4 className="text-base font-semibold mb-2">{short_description}</h4>}
          {abstract && <p className="text-sm mb-2 whitespace-pre-wrap">{abstract}</p>}
          <span className="text-sm font-semibold mb-2 block">{t("dashboard.summary_long_summary")}:</span>
          {long_summary && <div ref={transcriptionMdRef} className="text-sm mb-2 markdown-content" />}
          {tags && tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-2">
              {tags.map((tag, i) => (
                <span key={i} className="text-xs px-2 py-0.5 bg-accent text-accent-foreground rounded">{tag}</span>
              ))}
            </div>
          )}
          {labeledLine(t("dashboard.summary_categorization"), categorization)}
          {labeledLine(t("dashboard.summary_overall_intention"), overallIntention)}
          {labeledLine(t("dashboard.summary_narrative_arc"), narrativeArc)}
          {labeledLine(t("dashboard.summary_perception_arc"), perceptionArc)}
        </div>
      );
    })();

    // Higher-order aggregations rendered between summary and events with green background
    const hoasEl = (() => {
      if (!hoas || hoas.length === 0) return null;
      return (
        <div className="flex flex-col gap-2 p-4 border-b border-border bg-green-50">
          <h4 className="text-sm font-semibold text-green-800">{t("dashboard.higher_order_aggregations") || "Higher-Order Aggregations"}</h4>
          {hoas.map((hoa) => (
            <div key={hoa.id} className="p-3 bg-white border border-green-200 rounded">
              <h5 className="font-medium text-sm mb-1">{hoa.index + 1}. <span dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(hoa.title) }} /></h5>
              <div className="text-xs text-gray-600 markdown-content prose prose-sm max-w-none">
                {/* HOA description is pre-rendered markdown, display as-is */}
                <div dangerouslySetInnerHTML={{ __html: renderMarkdown(hoa.description) }} />
              </div>
            </div>
          ))}
        </div>
      );
    })();

    const eventsEl = (() => {
      if (sorted.length === 0) {
        // The `hidden` class is deliberate: the events section is currently disabled
        // (VISIBLE_EVENT_TYPES is empty), so the empty state must not show either.
        return (
          <div className="p-4 text-center text-gray-500 italic hidden">
            {t("dashboard.transcription_empty")}
          </div>
        );
      }

      return sorted.filter(event => VISIBLE_EVENT_TYPES.has(event.type)).map((event, index) => {
        const origin = getOriginBadge(event.type);
        const hasCaption = event.caption && event.caption.trim() !== "";
        const isAgg = event.type === "semanticAggregation";

        return (
          <div key={event.id} className={`flex flex-col gap-1 pt-3 pb-3 border-b border-border ${!hasCaption ? "hidden" : ""} ${isAgg ? "px-3" : "pl-6 pr-3"}`}>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono text-xs px-2 py-0.5 bg-gray-200 text-gray-700 rounded font-bold">
                {index + 1}
              </span>
              <a
                href="javascript:void(0)"
                className="font-mono text-xs px-2 py-0.5 bg-gray-100 rounded text-primary hover:underline cursor-pointer"
                onClick={() => onTimeSeek?.(event.timeMs)}
              >
                {formatTime(event.timeMs)}
              </a>
              <span className={`text-xs px-2 py-0.5 rounded font-medium ${origin.bgClass}`}>
                {origin.label}
              </span>
              <span className={`flex items-center gap-1 text-xs ${getEventTypeColor(event.type)}`}>
                <span>{regionEmoji[event.type] || '❓'}</span>
                {getEventTypeDisplay(event.type)}
              </span>
              {event.startMs !== undefined && event.endMs !== undefined && (
                <span className="text-xs text-gray-400">
                  ({formatTime(event.endMs - event.startMs)})
                </span>
              )}
            </div>
            <div className="text-sm mt-1">
              {hasCaption ? (
                <div data-md-caption={event.id || `idx-${index}`} className="markdown-content" />
              ) : (
                <p className="italic text-gray-400">{t("events_list.no_caption_available")}</p>
              )}
            </div>
          </div>
        );
      });
    })();

    // Provenance footer: file/workflow/models/processing time at the bottom
    const provenanceEl = (() => {
      const meta = currentProvenance;
      if (!meta) return null;
      const row = (label: string, value?: string) => value ? (
        <div className="flex gap-2 text-xs text-gray-500 max-w-full break-words overflow-hidden">
          <span className="font-semibold w-36 flex-shrink-0">{label}:</span>
          <span className="break-words">{value}</span>
        </div>
      ) : null;
      const pt = meta.processingTimeMs;
      return (
        <div className="p-4 border-t-2 border-border flex flex-col gap-1 pb-24">
          {row(t("dashboard.provenance_file"), meta.fileName)}
          {row(t("dashboard.provenance_workflow"), meta.workflow)}
          {/* REFACTOR(magic): hardcoded "de-DE" locale in an i18n'd app (i18n/de.json,
              i18n/en.json) — derive it from the active language. Also note this stamps
              render time, not the actual export time. */}
          {row(t("dashboard.provenance_exported"), new Date().toLocaleString("de-DE"))}
          {row(t("dashboard.provenance_asr_model"), meta.asrModel)}
          {row(t("dashboard.provenance_vlm_model"), meta.vlmModel)}
          {pt && row(
            t("dashboard.provenance_processing_time"),
            formatProcessingTime(pt),
          )}
          {meta.tokenUsage && row(
            t("dashboard.provenance_token_usage"),
            `${meta.tokenUsage.input} [input], ${meta.tokenUsage.output} [output], ${meta.tokenUsage.total} [total]`,
          )}
          {meta.nonFatalErrors && meta.nonFatalErrors.count > 0 && row(
            t("dashboard.provenance_non_fatal_errors"),
            (() => {
              const counts: Record<string, number> = {};
              for (const e of meta.nonFatalErrors!.trace) counts[e.reason] = (counts[e.reason] ?? 0) + 1;
              const parts = ["schema", "context", "transport", "timeout", "unknown"]
                .filter((r) => counts[r])
                .map((r) => `${r}: ${counts[r]}`);
              return `${meta.nonFatalErrors!.count} (${parts.join(", ")})`;
            })(),
          )}
        </div>
      );
    })();

    return (
      <>
        {summaryEl}
        {hoasEl}
        {eventsEl}
        {provenanceEl}
      </>
    );
  };

  // REFACTOR(dry): never called — renderContent above builds its own event section
  // (transcription-view.tsx:211). This is a stale copy (plain-text captions, no markdown
  // injection); delete it.
  const renderEvents = (events: EventItem[]) => {
    // Sort chronologically by time (rounded to seconds), with aggregations before clips (branch before leaf)
    const sorted = [...events].sort((a, b) => {
      const timeA = Math.floor(a.timeMs / 1000);
      const timeB = Math.floor(b.timeMs / 1000);
      if (timeA !== timeB) return timeA - timeB;
      // Aggregations sort before clips at the same second (branch before leaf)
      if (a.type === "semanticAggregation" && b.type !== "semanticAggregation") return -1;
      if (a.type !== "semanticAggregation" && b.type === "semanticAggregation") return 1;
      return 0;
    });

    if (sorted.length === 0) {
      return (
        <div className="p-4 text-center text-gray-500 italic hidden">
          {t("dashboard.transcription_empty")}
        </div>
      );
    }

    return sorted.map((event, index) => {
      const origin = getOriginBadge(event.type);
      const hasCaption = event.caption && event.caption.trim() !== "";
      const isAgg = event.type === "semanticAggregation";

      return (
        <div key={event.id} className={`flex flex-col gap-1 pt-3 pb-3 border-b border-border ${!hasCaption ? "hidden" : ""} ${isAgg ? "px-3" : "pl-6 pr-3"}`}>
          <div className="flex items-center gap-2 flex-wrap">
            {/* Index badge */}
            <span className="font-mono text-xs px-2 py-0.5 bg-gray-200 text-gray-700 rounded font-bold">
              {index + 1}
            </span>

            {/* Time badge */}
            <a
              href="javascript:void(0)"
              className="font-mono text-xs px-2 py-0.5 bg-gray-100 rounded text-primary hover:underline cursor-pointer"
              onClick={() => onTimeSeek?.(event.timeMs)}
            >
              {formatTime(event.timeMs)}
            </a>

            {/* Origin badge (Audio/Video) */}
            <span className={`text-xs px-2 py-0.5 rounded font-medium ${origin.bgClass}`}>
              {origin.label}
            </span>

            {/* Type badge with icon */}
            <span className={`flex items-center gap-1 text-xs ${getEventTypeColor(event.type)}`}>
              <span>{regionEmoji[event.type] || '❓'}</span>
              {getEventTypeDisplay(event.type)}
            </span>

            {/* Duration */}
            {event.startMs !== undefined && event.endMs !== undefined && (
              <span className="text-xs text-gray-400">
                ({formatTime(event.endMs - event.startMs)})
              </span>
            )}
          </div>

          {/* Caption text */}
          <div className="text-sm mt-1">
            {hasCaption ? (
              <p className="whitespace-pre-wrap break-words">{event.caption}</p>
            ) : (
              <p className="italic text-gray-400">{t("events_list.no_caption_available")}</p>
            )}
          </div>
        </div>
      );
    });
  };

  /**
   * Backfills missing captions via ONE lean RPC: `getCaptionsByHash` returns
   * only the selected file's `cacheId → caption` map (all events belong to the
   * same file), replacing four full-table `getAll` fetches (~8 MB) with a
   * single hash-scoped payload.
   */
  // REFACTOR(consistency): same type→(cache table, key suffix) mapping as
  // events-list.tsx:178-201 but with the opposite access strategy (bulk getAll here vs
  // per-event get there) — extract one shared caption resolver.
  const loadCaptionsFromCache = async (events: EventItem[]): Promise<EventItem[]> => {
    try {
      const hash = events.find((e) => e.fileInfo?.outputHash || e.fileInfo?.fileName)?.fileInfo?.outputHash
        ?? events.find((e) => e.fileInfo?.fileName)?.fileInfo?.fileName;
      if (!hash) return events;
      const captions = await cacheApi.getCaptionsByHash(hash);

      return events.map(event => {
        // Skip if already has a caption
        if (event.caption && event.caption.trim() !== "") return event;

        const eventHash = event.fileInfo?.outputHash || event.fileInfo?.fileName;
        if (!eventHash) return event;

        const index = event.fileInfo?.index || 0;
        let caption = "";

        if (event.type === "scene") {
          caption = captions[getCacheId(eventHash, index)] ?? "";
        } else if (event.type === "sceneKeyframe") {
          caption = captions[getCacheId(`${eventHash}-keyframe`, index)] ?? "";
        } else if (event.type === "speech") {
          caption = captions[getCacheId(`${eventHash}-speech`, index)] ?? "";
        } else if (event.type === "harmonic" || event.type === "noise") {
          caption = captions[getCacheId(`${eventHash}-${event.type}`, index)] ?? "";
        }

        if (caption) {
          return { ...event, caption };
        }
        return event;
      });
    } catch (e) {
      console.error("Error loading captions from cache:", e);
      return events;
    }
  };

  /** Re-apply markdown HTML after any VDOM update (use querySelector, not ref) */
  // REFACTOR(kiss): '.markdown-content:not([data-md-caption])' implicitly means "the
  // summary" — give the summary container its own marker attribute instead of relying
  // on the absence of another.
  const applyMarkdown = () => {
    requestAnimationFrame(() => {
      // Render summary long_summary as markdown
      const summaryMd = listRef.current?.querySelector('.markdown-content:not([data-md-caption])');
      if (summaryMd && currentSummary?.long_summary) {
        (summaryMd as HTMLElement).innerHTML = renderMarkdown(currentSummary.long_summary);
      }
      // Render all event captions as markdown
      const captionEls = listRef.current?.querySelectorAll('[data-md-caption]');
      captionEls?.forEach((el) => {
        const eventId = el.getAttribute('data-md-caption');
        const event = allEvents.find((e) => e.id === eventId);
        if (event?.caption) {
          (el as HTMLElement).innerHTML = renderMarkdown(event.caption);
        }
      });
    });
  };

  ref.state = {
    ...ref.state,
    updateEvents: async (events: EventItem[]) => {
      // Two-phase render: paint immediately with whatever captions are already present,
      // then re-render once the cache backfill resolves — avoids blocking the list on
      // cache IO.
      allEvents = events;
      $(listRef).update(<>{renderContent()}</>);
      applyMarkdown();

      const enriched = await loadCaptionsFromCache(events);
      allEvents = enriched;
      $(listRef).update(<>{renderContent()}</>);
      applyMarkdown();
    },
    setSummary: (summary) => {
      currentSummary = summary;
      $(listRef).update(<>{renderContent()}</>);
      applyMarkdown();
    },
    setHigherOrderAggregations: (hoas: HigherOrderAggregation[]) => {
      higherOrderAggregations = hoas;
      $(listRef).update(<>{renderContent()}</>);
      applyMarkdown();
    },
    setProvenance: (meta: ResultProvenance | null) => {
      currentProvenance = meta;
      $(listRef).update(<>{renderContent()}</>);
      applyMarkdown();
    },
  };

  return (
    <div className="flex flex-col h-full overflow-hidden" ref={ref}>
      <div ref={listRef} className="flex-1 overflow-y-auto min-h-0">
        {renderContent()}
      </div>
    </div>
  );
};
