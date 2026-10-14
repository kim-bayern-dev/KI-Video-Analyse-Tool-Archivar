import { createRef, t, type Ref, type Props, $, type RenderInput } from "defuss";

export interface MediaMetadata {
  duration: number; // Duration in seconds
  videoWidth?: number; // For video elements
  videoHeight?: number; // For video elements
  audioTracks?: number; // Number of audio tracks
  videoTracks?: number; // Number of video tracks
}

/**
 * Imperative media control API exposed via ref.state. The dashboard currently uses only
 * seekToMs/changeSrc/changeType/changeKeyframes; the rest is provided for completeness.
 * Note seek vs seekToMs: seek() reports back through onSeek (user-initiated), seekToMs()
 * deliberately does not — that asymmetry is the recursion guard between player and timeline.
 */
export interface MediaCanvasRef {
  play: () => void;
  pause: () => void;
  seek: (time: number) => void;
  seekToMs: (timeMs: number) => void;
  volume: (volume: number) => void;
  mute: () => void;
  unmute: () => void;
  changeSrc: (src: string) => void;
  changeType: (type: "video" | "image" | "audio" | "kfs") => void;
  changeKeyframes: (keyframes: Array<{src: string; name: string}>) => void;
}

/**
 * type selects the rendered element: "video"/"audio" (native controls), "image", or "kfs"
 * (scene-keyframe list/viewer). onProgress fires on a 25ms poll while playing and drives
 * the dashboard's transport + events filtering — its cadence sets the dashboard refresh rate.
 */
export interface MediaCanvasProps extends Props {
  src?: string;
  type: "video" | "image" | "audio" | "kfs";
  onProgress?: (currentTimeMs: number) => void;
  onMetadata?: (metadata: MediaMetadata) => void;
  onSeek?: (timeMs: number) => void;
  ref?: Ref<HTMLDivElement, MediaCanvasRef>;
}

/**
 * Media display panel. The element is recreated on every source/type change via
 * $(contentRef).update(), so all media event listeners are re-attached after each update —
 * the previous element and its listeners are discarded by the VDOM update.
 */
export const MediaCanvas = ({ src, type, onProgress, onMetadata, onSeek, ref = createRef<HTMLDivElement, MediaCanvasRef>() }: MediaCanvasProps) => {

  // REFACTOR(consistency): typed as video/audio element but also bound to <img>/<div> for
  // image/kfs via `as unknown as Ref<...>` casts (lines ~122, ~136, ~172) — volume()/mute()/
  // play() would throw on those. Use separate refs or an honest union type.
  const mediaRef = createRef<HTMLVideoElement | HTMLAudioElement>();
  const contentRef = createRef<HTMLDivElement>();
  let progressInterval: NodeJS.Timeout | null = null;
  // Set by seek()/seekToMs() so the next progress poll doesn't echo an externally driven
  // position back through onProgress; cleared by the next interval tick. Caveat: while
  // paused no interval runs, so the flag persists until playback resumes.
  let isExternalSeek = false;
  let currentSrc: string | null = src || null; // Track current source internally
  let currentKeyframes: Array<{src: string; name: string}> = [];
  let selectedKeyframe: {src: string; name: string} | null = null;
  let selectedKeyframeIndex: number = -1;
  let isKfsModalOpen = false;

  const startProgressTracking = () => {
    if (progressInterval) {
      clearInterval(progressInterval);
    }

    progressInterval = setInterval(() => {
      if (mediaRef.current && onProgress && !isExternalSeek) {
        const currentTimeMs = mediaRef.current.currentTime * 1000; // Convert to milliseconds
        onProgress(currentTimeMs);
      }
      // Reset the flag after one interval
      if (isExternalSeek) {
        isExternalSeek = false;
      }
    }, 25); // REFACTOR(magic): 25ms poll cadence (~40 updates/s) — name it PROGRESS_POLL_MS.
            // Every tick drives the dashboard's transport move + full events-table re-filter,
            // so this number effectively sets the whole dashboard's refresh rate.
  };

  const stopProgressTracking = () => {
    if (progressInterval) {
      clearInterval(progressInterval);
      progressInterval = null;
    }
  };

  const extractMetadata = (): MediaMetadata | null => {
    if (!mediaRef.current) return null;

    const media = mediaRef.current;
    const metadata: MediaMetadata = {
      duration: media.duration || 0,
    };

    // Add video-specific metadata
    if (type === "video" && media instanceof HTMLVideoElement) {
      metadata.videoWidth = media.videoWidth;
      metadata.videoHeight = media.videoHeight;
      // Note: audioTracks and videoTracks are experimental and not widely supported
      // Using optional chaining and type assertion for safety
      metadata.audioTracks = (media as any).audioTracks?.length || 0;
      metadata.videoTracks = (media as any).videoTracks?.length || 0;
    }

    return metadata;
  };

  const handleMetadataLoaded = () => {
    const metadata = extractMetadata();
    if (metadata && onMetadata) {
      onMetadata(metadata);
    }
  };

  const updateMediaElement = async () => {
    if (!currentSrc) {
      const messageVdom = (
        <div className="text-gray-500 text-xl font-medium mt-16">
          {t("dashboard.please_select_file")}
        </div>
      );
      $(contentRef).update(messageVdom);
    } else {
      // Show media element based on type
      let mediaVdom: RenderInput;

      if (type === "video") {
        mediaVdom = (
          <video
            ref={mediaRef as Ref<HTMLVideoElement>}
            className="w-full h-auto max-h-96 object-contain"
            controls
          >
            <source src={currentSrc} />
            Your browser does not support the video tag.
          </video>
        );
      } else if (type === "image") {
        mediaVdom = (
          <img ref={mediaRef as unknown as Ref<HTMLImageElement>} src={currentSrc} className="w-full h-auto max-h-96 object-contain" />
        );
      } else if (type === "audio") {
        mediaVdom = (
          <audio
            ref={mediaRef as Ref<HTMLAudioElement>}
            src={currentSrc}
            className="w-full h-auto max-h-20"
            controls
          />
        );
      } else if (type === "kfs") {
        if (selectedKeyframe) {
          mediaVdom = (
            <div ref={mediaRef as unknown as Ref<HTMLDivElement>} className="w-full h-full overflow-y-auto">
              <button className="uk-btn uk-btn-default uk-btn-sm mb-2" onClick={() => { selectedKeyframe = null; selectedKeyframeIndex = -1; updateMediaElement(); }}>← {t("dashboard.back_to_list")}</button>
              {/* Modal overlay */}
              {isKfsModalOpen && (
                <div
                  className="fixed inset-0 bg-black bg-opacity-90 z-50 flex items-center justify-center p-4"
                  onClick={() => { isKfsModalOpen = false; updateMediaElement(); }}
                >
                  <div className="relative max-w-full max-h-full">
                    <button
                      className="cursor-pointer absolute -top-10 right-4 text-white hover:text-gray-300 text-2xl font-bold z-10 bg-black bg-opacity-50 rounded-full w-10 h-10 flex items-center justify-center"
                      onClick={(e) => { e.stopPropagation(); isKfsModalOpen = false; updateMediaElement(); }}
                    >
                      ×
                    </button>
                    <img
                      src={selectedKeyframe.src}
                      className="max-w-full max-h-full object-contain cursor-zoom-out"
                      onClick={(e) => { e.stopPropagation(); isKfsModalOpen = false; updateMediaElement(); }}
                    />
                  </div>
                </div>
              )}
              <img
                src={selectedKeyframe.src}
                className="w-full h-auto object-contain cursor-zoom-in hover:opacity-90 transition-opacity"
                onClick={() => { isKfsModalOpen = true; updateMediaElement(); }}
              />
              <div className="text-sm text-muted-foreground mt-1 px-1">
                <span className="inline-block font-mono text-xs px-1.5 py-0.5 bg-gray-200 text-gray-700 rounded font-bold mr-1.5 align-middle">{selectedKeyframeIndex + 1}</span>
                {selectedKeyframe.name}
              </div>
            </div>
          );
        } else {
          mediaVdom = (
            <div ref={mediaRef as unknown as Ref<HTMLDivElement>} className="w-full h-full overflow-y-auto p-2">
              <table className="uk-table uk-table-divider uk-table-hover uk-table-sm w-full">
                <tbody>
                  {currentKeyframes.map((kf, index) => (
                    <tr className="cursor-pointer" onClick={() => { selectedKeyframe = kf; selectedKeyframeIndex = index; updateMediaElement(); }}>
                      <td className="w-8 align-middle text-center"><span className="inline-block font-mono text-xs px-1.5 py-0.5 bg-gray-200 text-gray-700 rounded font-bold">{index + 1}</span></td>
                      <td className="w-24"><img src={kf.src} className="w-20 h-auto object-contain" /></td>
                      <td className="align-middle">{kf.name}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
      } else {
        mediaVdom = null;
      }

      // REFACTOR(kiss): stale "TODO: CHECK!!!" marker — the open question is whether
      // update(null) clears the panel for unknown media types; resolve and drop the marker.
      $(contentRef).update(mediaVdom);

      // Re-setup event listeners after update — the previous media element (and its
      // listeners) was discarded by $(contentRef).update() above.
      $(() => {
        console.log('Media element updated and event listeners attached', mediaRef);
        if (mediaRef.current) {
          mediaRef.current.addEventListener('loadedmetadata', handleMetadataLoaded);
          mediaRef.current.addEventListener('play', startProgressTracking);
          mediaRef.current.addEventListener('pause', stopProgressTracking);
          mediaRef.current.addEventListener('ended', stopProgressTracking);
          mediaRef.current.addEventListener('seeking', stopProgressTracking);
          mediaRef.current.addEventListener('seeked', () => {
            if (!mediaRef.current?.paused) {
              startProgressTracking();
            }
          });

          console.log('Media element updated and event listeners attached');
        }
      });
    }
  };

  ref.state = {
    ...ref.state,
    play: () => {
      mediaRef.current?.play();
      startProgressTracking();
    },
    pause: () => {
      mediaRef.current?.pause();
      stopProgressTracking();
    },
    seek: (time: number) => {
      if (mediaRef.current) {
        isExternalSeek = true; // Set flag to prevent recursion
        mediaRef.current.currentTime = time as number;
        // Notify parent component about the seek
        if (onSeek) {
          onSeek(time * 1000); // Convert to milliseconds
        }
      }
    },
    seekToMs: (timeMs: number) => {
      if (mediaRef.current) {
        isExternalSeek = true; // Set flag to prevent recursion
        mediaRef.current.currentTime = timeMs / 1000; // Convert milliseconds to seconds
        // Don't call onSeek here to avoid recursion - this is called from external sources
      }
    },
    volume: (volume: number) => {
      mediaRef.current.volume = volume as number;
    },
    mute: () => {
      mediaRef.current.muted = true;
    },
    unmute: () => {
      mediaRef.current.muted = false;
    },
    changeSrc: (newSrc: string) => {
      currentSrc = newSrc;
      selectedKeyframe = null;
      selectedKeyframeIndex = -1;
      isKfsModalOpen = false;

      console.log('changeSrc', newSrc);
      if (mediaRef.current) {
        mediaRef.current.src = newSrc;
      }
      // Re-renders with the CURRENT type — the dashboard calls changeSrc + changeType
      // back-to-back (dashboard.tsx:580-581), so this render is immediately superseded.
      updateMediaElement();
    },
    changeType: (newType: "video" | "image" | "audio" | "kfs") => {
      // Mutates the destructured prop: this component keeps imperative closure state
      // instead of prop-driven re-renders — the dashboard drives it entirely via ref.state.
      type = newType;
      updateMediaElement();
    },
    changeKeyframes: (keyframes: Array<{src: string; name: string}>) => {
      currentKeyframes = keyframes;
      if (type === 'kfs') {
        updateMediaElement();
      }
    }
  };

  // Initialize the component
  queueMicrotask(() => {
    updateMediaElement();
  });

  return (
    <div ref={ref} className="flex-1 space-x-2 flex items-center justify-center overflow-hidden h-full" style={{ maxHeight: 'calc(100vh - 200px)' }}>
      <div ref={contentRef} className="w-full flex justify-center h-full">
        {/* Content will be dynamically updated by updateMediaElement() */}
      </div>
    </div>
  )
};