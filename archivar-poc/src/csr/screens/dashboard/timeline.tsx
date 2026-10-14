import { createRef, type Ref, type Props, $ } from "defuss";

// REFACTOR(dry): 4th copy of this map (events-list.tsx:9, transcription-view.tsx:25,
// analyze-modal.tsx:14) — and already divergent: scene is 🎬 here, 🎨 elsewhere.
// Hoist one shared map.
const regionEmoji: Record<string, string> = {
  speech: "🎤",
  silence: "🔇",
  noise: "🔊",
  ambience: "🎵",
  harmonic: "〰️",
  scene: "🎬",
  sceneKeyframe: "🖼️",
};

export interface TimelineRegion {
  index: number;
  startMs: number;
  endMs: number;
}

export interface TimelineAudioRegion extends TimelineRegion {
  type: "noise" | "ambience" | "harmonic" | "speech" | "silence";
}

export interface TimelineSceneRegion extends TimelineRegion {
}

/** Semantic aggregation region for v3 plugin results */
export interface TimelineAggregationRegion extends TimelineRegion {
  aggregationId: string;
  pluginName: string;
  summary?: string;
}

/** Higher-order aggregation region - timeframe calculated from aggregationIndexes */
export interface TimelineHigherOrderAggregationRegion {
  id: string;
  index: number;
  aggregationIndexes: number[];
  title: string;
}

/**
 * Imperative transport/region API driven by dashboard.tsx: updateTransport runs on every
 * media progress tick (25ms cadence while playing), updateTimeframe once per media load
 * (from metadata duration), the update*Regions setters push analysis results. All geometry
 * is absolute positioning at pixelsPerSecond scale inside one horizontally scrolled strip.
 */
export interface TimelineRef {
  updateTransport: (ms: number) => void;
  updateTimeframe: (seconds: number) => void;
  updateAudioRegions: (audioRegions: TimelineAudioRegion[]) => void;
  updateSceneRegions: (sceneRegions: TimelineSceneRegion[]) => void;
  updateAggregationRegions: (aggregationRegions: TimelineAggregationRegion[]) => void;
  updateHigherOrderAggregationRegions: (hoaRegions: TimelineHigherOrderAggregationRegion[]) => void;
  scrollToTransport: () => void;
}

export interface TimelineProps extends Props {
  onTimelineClick?: (timeMs: number) => void;
  ref?: Ref<HTMLDivElement, TimelineRef>;
}

/**
 * Region-based timeline: stacked bands (minute ticks, second ticks, audio regions, scene
 * regions, aggregations, HOAs) as absolutely-positioned divs inside a scrollable strip,
 * plus the red transport line. Starts display:none — there is no scale to render against
 * until the first updateTimeframe call delivers the media duration.
 */
export const Timeline = ({ onTimelineClick, ref = createRef<HTMLDivElement, TimelineRef>() }: TimelineProps) => {

  const timelineContainerRef = createRef<HTMLDivElement>();
  const scrollContainerRef = createRef<HTMLDivElement>();
  const transportRef = createRef<HTMLDivElement>();
  const minutesMarkersRef = createRef<HTMLDivElement>();
  const timeMarkersRef = createRef<HTMLDivElement>();
  const audioRegionsRef = createRef<HTMLDivElement>();
  const sceneRegionsRef = createRef<HTMLDivElement>();
  const aggregationRegionsRef = createRef<HTMLDivElement>();
  const higherOrderAggregationRegionsRef = createRef<HTMLDivElement>();
  const timelineRef = createRef<HTMLDivElement>();

  let currentSeconds = 0; // Default timeframe — 0 keeps the timeline hidden until updateTimeframe
  // REFACTOR(magic): 20px/s is the global zoom scale shared by every renderer and the
  // click-to-time conversion — name it (PIXELS_PER_SECOND) or make it configurable.
  let pixelsPerSecond = 20; // Default pixel width per second
  let currentAudioRegions: TimelineAudioRegion[] = [];
  let currentSceneRegions: TimelineSceneRegion[] = [];
  let currentAggregationRegions: TimelineAggregationRegion[] = [];
  let currentHigherOrderAggregationRegions: TimelineHigherOrderAggregationRegion[] = [];

  const handleTimelineClick = (event: MouseEvent) => {
    if (!timelineContainerRef.current || !onTimelineClick) return;

    // The inner container grows with the content and scrolls along with it, so its rect
    // already includes the scroll offset — no manual scrollLeft compensation needed here.
    const rect = timelineContainerRef.current.getBoundingClientRect();
    const clickX = event.clientX - rect.left;

    // Calculate time in milliseconds based on click position
    const timeMs = (clickX / pixelsPerSecond) * 1000;

    // Ensure time is within bounds
    const clampedTimeMs = Math.max(0, Math.min(timeMs, currentSeconds * 1000));

    onTimelineClick(clampedTimeMs);
  };

  const getRegionColor = (type: string) => {
    switch (type) {
      case "speech": return "bg-blue-200";
      case "silence": return "bg-green-200";
      case "noise": return "bg-yellow-200";
      case "ambience": return "bg-purple-200";
      case "harmonic": return "bg-red-200";
      default: return "bg-gray-200";
    }
  };

  const renderMinutesMarkers = (totalSeconds: number) => {
    const totalMinutes = Math.ceil(totalSeconds / 60);
    const markers = Array.from({ length: totalMinutes }, (_, i) => {
      const minuteStartSecond = i * 60;
      const leftPx = minuteStartSecond * pixelsPerSecond;

      return (
        <div
          key={`minute-${i}`}
          className="absolute top-0 h-full border-l border-amber-600"
          style={{ left: `${leftPx}px` }}
        >
          <span className="absolute bottom-0 pl-1 left-1/2 transform -translate-x-1/2 text-xs font-bold text-amber-700 pl-5">
            {i.toString().padStart(2, '0')}
          </span>
        </div>
      );
    });

    return (
      <div className="absolute top-0 left-0 w-full h-1/6" style={{ width: `${totalSeconds * pixelsPerSecond}px` }}>
        {markers}
      </div>
    );
  };

  const renderTimeMarkers = (totalSeconds: number) => {
    // One marker node per second: fine for short clips, but long media scales linearly
    // (a 2h video = ~7200 absolutely-positioned divs in this row alone).
    const markers = Array.from({ length: totalSeconds }, (_, i) => {
      const seconds = i % 60;
      const leftPx = i * pixelsPerSecond;

      return (
        <div
          key={`time-${i}`}
          className="absolute top-0 h-full border-l border-amber-900"
          style={{ left: `${leftPx}px` }}
        >
          <span className="absolute bottom-0 pl-1 left-1/2 transform -translate-x-1/2 text-xs text-gray-500 pl-5">
            {seconds.toString().padStart(2, '0')}
          </span>
        </div>
      );
    });

    return (
      <div className="absolute top-1/6 left-0 w-full h-1/6 border-b border-amber-500" style={{ width: `${totalSeconds * pixelsPerSecond}px` }}>
        {markers}
      </div>
    );
  };

  const renderAudioRegions = (audioRegions: TimelineAudioRegion[]) => {
    const regions = audioRegions.map((region, index) => {
      const leftPx = (region.startMs / 1000) * pixelsPerSecond;
      const widthPx = ((region.endMs - region.startMs) / 1000) * pixelsPerSecond;

      return (
        <div
          key={`audio-${index}`}
          className={`absolute top-0 h-full ${getRegionColor(region.type)} opacity-70 flex items-center justify-center`}
          style={{ left: `${leftPx}px`, width: `${widthPx}px` }}
          title={region.type}
        >
          <span style={{ fontSize: '10px', lineHeight: '1' }}>{regionEmoji[region.type] || '❓'}</span>
        </div>
      );
    });

    return (
      <div className="absolute top-1/3 left-0 w-full h-1/3 border-gray-200" style={{ width: `${currentSeconds * pixelsPerSecond}px` }}>
        {regions}
      </div>
    );
  };

  const renderSceneRegions = (sceneRegions: TimelineSceneRegion[]) => {
    const regions = sceneRegions.map((region, index) => {
      const leftPx = (region.startMs / 1000) * pixelsPerSecond;
      const widthPx = ((region.endMs - region.startMs) / 1000) * pixelsPerSecond;

      return (
        <div
          key={`scene-${index}`}
          className="absolute top-0 h-full bg-orange-300 opacity-70 border-l-2 border-orange-600 flex items-center justify-center"
          style={{ left: `${leftPx}px`, width: `${widthPx}px` }}
          title={`Scene Change ${region.index}`}
        >
          <span style={{ fontSize: '10px', lineHeight: '1' }}>{regionEmoji.scene}</span>
        </div>
      );
    });

    return (
      <div className="absolute bottom-0 left-0 w-full top-2/3 h-1/3" style={{ width: `${currentSeconds * pixelsPerSecond}px` }}>
        {regions}
      </div>
    );
  };

  /** Render semantic aggregation bars (v3 plugin results) */
  // REFACTOR(consistency): audio/scene bands position via fractional classes (top-1/3,
  // top-2/3) but aggregation/HOA bars use inline px offsets (top: '20px'/'4px', fixed
  // heights) — two layout conventions for the same stacked-band system; unify.
  const renderAggregationRegions = (aggregationRegions: TimelineAggregationRegion[]) => {
    const regions = aggregationRegions.map((region, index) => {
      const leftPx = (region.startMs / 1000) * pixelsPerSecond;
      const widthPx = ((region.endMs - region.startMs) / 1000) * pixelsPerSecond;

      return (
        <div
          key={`agg-${region.aggregationId || index}`}
          className="absolute top-0 h-full bg-purple-300 opacity-60 border-l-2 border-purple-600 flex items-center justify-center"
          style={{
            top: '20px',
            height: '24px', left: `${leftPx}px`, width: `${widthPx}px`
          }}
          title={`Aggregation ${region.index + 1}: ${region.summary || region.aggregationId}`}
        >
          <span style={{ fontSize: '10px', lineHeight: '1' }}></span>
        </div>
      );
    });

    return (
      <div className="absolute top-0 left-0 w-full h-1/4" style={{ width: `${currentSeconds * pixelsPerSecond}px` }}>
        {regions}
      </div>
    );
  };

  /**
   * Render higher-order aggregation bars on top of regular aggregations.
   * Geometry is derived from currentAggregationRegions at render time, so aggregation
   * regions must be pushed (updateAggregationRegions) before HOAs can be placed — the
   * updateAggregationRegions setter therefore re-renders HOAs as a side effect.
   */
  const renderHigherOrderAggregationRegions = (hoaRegions: TimelineHigherOrderAggregationRegion[]) => {
    const regions = hoaRegions.map((hoa) => {
      // Calculate timeframe from aggregationIndexes
      const firstIdx = hoa.aggregationIndexes[0];
      const lastIdx = hoa.aggregationIndexes[hoa.aggregationIndexes.length - 1];
      const firstAgg = currentAggregationRegions.find(r => r.index === firstIdx);
      const lastAgg = currentAggregationRegions.find(r => r.index === lastIdx);

      if (!firstAgg || !lastAgg) return null;

      const leftPx = (firstAgg.startMs / 1000) * pixelsPerSecond;
      const rightPx = (lastAgg.endMs / 1000) * pixelsPerSecond;
      const widthPx = rightPx - leftPx;

      return (
        <div
          key={`hoa-${hoa.id}`}
          className="absolute top-0 h-4 bg-green-300 opacity-40 border-t-2 border-green-600 flex items-center justify-center"
          style={{
            top: '4px',
            height: '16px', left: `${leftPx}px`, width: `${widthPx}px`
          }}
          title={`HOA ${hoa.index + 1}: ${hoa.title}`}
        >
          <span style={{ fontSize: '8px', lineHeight: '1' }}>{hoa.index + 1}</span>
        </div>
      );
    });

    return (
      <div className="absolute top-0 left-0 w-full" style={{ width: `${currentSeconds * pixelsPerSecond}px`, height: '24px' }}>
        {regions}
      </div>
    );
  };

  ref.state = {
    ...ref.state,
    updateTransport: (ms: number) => {
      const leftPx = (ms / 1000) * pixelsPerSecond;
      $(transportRef).css("left", `${leftPx}px`);

      // Scroll to keep transport at 300px from left
      // REFACTOR(dry): this 300px follow-offset is duplicated in scrollToTransport below —
      // name it once (TRANSPORT_SCROLL_OFFSET_PX).
      if (scrollContainerRef.current) {
        const scrollLeft = Math.max(0, leftPx - 300);
        scrollContainerRef.current.scrollLeft = scrollLeft;
      }
    },
    scrollToTransport: () => {
      // Method to manually scroll to current transport position
      if (scrollContainerRef.current && transportRef.current) {
        const computedStyle = window.getComputedStyle(transportRef.current);
        const transportLeft = parseInt(computedStyle.left) || 0;
        const scrollLeft = Math.max(0, transportLeft - 300);
        scrollContainerRef.current.scrollLeft = scrollLeft;
      }
    },
    updateTimeframe: (seconds: number) => {
      currentSeconds = seconds;
      const timelineWidth = seconds * pixelsPerSecond;

      $(timelineRef).css("display", `flex`);

      // Update container width
      $(timelineContainerRef).css("width", `${timelineWidth}px`);

      // Re-render minutes markers
      const minutesMarkersVdom = renderMinutesMarkers(seconds);
      $(minutesMarkersRef).update(minutesMarkersVdom);

      // Re-render time markers
      const timeMarkersVdom = renderTimeMarkers(seconds);
      $(timeMarkersRef).update(timeMarkersVdom);

      // Re-render audio regions with new timeframe
      const audioRegionsVdom = renderAudioRegions(currentAudioRegions);
      $(audioRegionsRef).update(audioRegionsVdom);

      // Re-render scene regions with new timeframe
      const sceneRegionsVdom = renderSceneRegions(currentSceneRegions);
      $(sceneRegionsRef).update(sceneRegionsVdom);

      // Re-render aggregation regions with new timeframe
      const aggRegionsVdom = renderAggregationRegions(currentAggregationRegions);
      $(aggregationRegionsRef).update(aggRegionsVdom);
    },
    updateAudioRegions: (audioRegions: TimelineAudioRegion[]) => {
      currentAudioRegions = audioRegions;
      const audioRegionsVdom = renderAudioRegions(audioRegions);
      $(audioRegionsRef).update(audioRegionsVdom);
    },
    updateSceneRegions: (sceneRegions: TimelineSceneRegion[]) => {
      currentSceneRegions = sceneRegions;
      const sceneRegionsVdom = renderSceneRegions(sceneRegions);
      $(sceneRegionsRef).update(sceneRegionsVdom);
    },
    updateAggregationRegions: (aggregationRegions: TimelineAggregationRegion[]) => {
      currentAggregationRegions = aggregationRegions;
      const aggRegionsVdom = renderAggregationRegions(aggregationRegions);
      $(aggregationRegionsRef).update(aggRegionsVdom);
      // Toggle visibility: hide when empty, show when present
      $(aggregationRegionsRef).css("display", aggregationRegions.length === 0 ? "none" : "block");
      // Re-render HOA regions if present (they depend on aggregation regions for timeframe calculation)
      if (currentHigherOrderAggregationRegions.length > 0) {
        const hoaRegionsVdom = renderHigherOrderAggregationRegions(currentHigherOrderAggregationRegions);
        $(higherOrderAggregationRegionsRef).update(hoaRegionsVdom);
      }
    },
    updateHigherOrderAggregationRegions: (hoaRegions: TimelineHigherOrderAggregationRegion[]) => {
      currentHigherOrderAggregationRegions = hoaRegions;
      const hoaRegionsVdom = renderHigherOrderAggregationRegions(hoaRegions);
      $(higherOrderAggregationRegionsRef).update(hoaRegionsVdom);
      // Toggle visibility: hide when empty, show when present
      $(higherOrderAggregationRegionsRef).css("display", hoaRegions.length === 0 ? "none" : "block");
    }
  };

  return (
    <div ref={timelineRef} className="min-h-31 h-31 overflow-y-hidden rounded border-2 border-primary/40 bg-gray-50" style={{ display: "none" }}>
      <div
        ref={scrollContainerRef}
        className="h-36 overflow-x-auto overflow-y-hidden scrollbar-thin scrollbar-thumb-gray-700 scrollbar-track-gray-900"
      >
        <div
          className="relative h-32 min-w-max cursor-pointer"
          ref={timelineContainerRef}
          style={{ width: `${currentSeconds * pixelsPerSecond}px` }}
          onClick={handleTimelineClick}
        >
          {/* Transport indicator - red vertical line */}
          <div
            ref={transportRef}
            className="absolute top-0 w-0.5 h-full bg-red-500 z-10 pointer-events-none"
            style={{ left: "0px" }}
          />

          {/* Minutes Markers Row */}
          {/* REFACTOR(kiss): "bg bg-red-700" looks like leftover debug styling on an
              unsized wrapper (contents are absolutely positioned) — confirm and remove. */}
          <div ref={minutesMarkersRef} class={"bg bg-red-700"}>
            {renderMinutesMarkers(currentSeconds)}
          </div>

          {/* Time Markers Row */}
          <div ref={timeMarkersRef}>
            {renderTimeMarkers(currentSeconds)}
          </div>

          {/* Audio Region Markers Row */}
          <div ref={audioRegionsRef}>
            {renderAudioRegions(currentAudioRegions)}
          </div>

          {/* Scene Change Region Markers Row */}
          <div ref={sceneRegionsRef}>
            {renderSceneRegions(currentSceneRegions)}
          </div>

          {/* Semantic Aggregation Region Markers Row */}
          <div ref={aggregationRegionsRef}>
            {renderAggregationRegions(currentAggregationRegions)}
          </div>

          {/* Higher-Order Aggregation Region Markers Row - on top */}
          <div ref={higherOrderAggregationRegionsRef}>
            {renderHigherOrderAggregationRegions(currentHigherOrderAggregationRegions)}
          </div>
        </div>
      </div>
    </div>
  );
};
