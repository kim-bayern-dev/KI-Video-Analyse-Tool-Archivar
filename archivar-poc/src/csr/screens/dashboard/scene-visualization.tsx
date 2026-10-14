import { createRef, t, type Ref, type Props, $ } from "defuss";
import type { FileInfo } from "../../../rpc/file-api";

export interface SceneVisualizationRef {
  updateScene: (fileInfo: FileInfo, timeMs: number) => void;
  clearScene: () => void;
}

export interface SceneVisualizationProps extends Props {
  ref?: Ref<HTMLDivElement, SceneVisualizationRef>;
}

export const SceneVisualization = ({ ref = createRef<HTMLDivElement, SceneVisualizationRef>() }: SceneVisualizationProps) => {
  const sceneContainerRef = createRef<HTMLDivElement>();
  
  let currentFileInfo: FileInfo | null = null;
  let currentTimeMs = 0;
  let isModalOpen = false;
  let modalImageUrl = '';

  const openImageModal = (imageUrl: string) => {
    modalImageUrl = imageUrl;
    isModalOpen = true;
    if (sceneContainerRef.current) {
      const sceneContent = renderSceneContent();
      $(sceneContainerRef).update(sceneContent);
    }
  };

  const closeImageModal = () => {
    isModalOpen = false;
    modalImageUrl = '';
    if (sceneContainerRef.current) {
      const sceneContent = renderSceneContent();
      $(sceneContainerRef).update(sceneContent);
    }
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && isModalOpen) {
      closeImageModal();
    }
  };

  const renderSceneContent = () => {
    if (!currentFileInfo) {
      return (
        <div className="text-center text-gray-500 py-8">
          <div className="text-4xl mb-2">🎬</div>
          <p className="text-sm">{t("events_list.no_region_selected")}</p>
        </div>
      );
    }

    const fileType = (currentFileInfo.mediaType);
    const serverUrl = currentFileInfo.serverUrl;

    return (
      <div className="">
        {/* Image Modal */}
        {isModalOpen && (
          <div 
            className="fixed inset-0 bg-black bg-opacity-90 z-50 flex items-center justify-center p-4"
            onClick={closeImageModal}
          >
            <div className="relative max-w-full max-h-full">
              <button
                className="cursor-pointer absolute -top-10 right-4 text-white hover:text-gray-300 text-2xl font-bold z-10 bg-black bg-opacity-50 rounded-full w-10 h-10 flex items-center justify-center"
                onClick={(e) => { e.stopPropagation(); closeImageModal(); }}
              >
                ×
              </button>
              <img
                src={modalImageUrl}
                className="max-w-full max-h-full object-contain cursor-zoom-out"
                onClick={(e) => { e.stopPropagation(); closeImageModal(); }}
              />
            </div>
          </div>
        )}

        {/* Scene Content Preview */}
        <div className="bg-gray-950 border-2 border-primary/40  p-4 mt-2">
          <div className=" rounded flex items-center justify-center h-40">
            {fileType === 'video' ? (
              <video controls src={serverUrl} className="uk-video uk-video-muted uk-video-transparent w-full h-full object-contain h-50" />
            ) : fileType === 'image' ? (
              <img 
                src={serverUrl} 
                className="uk-image w-full h-full object-contain cursor-zoom-in hover:opacity-90 transition-opacity" 
                onClick={() => openImageModal(serverUrl!)}
              />
            ) : (
              <audio controls src={serverUrl} className="uk-audio w-full h-12" />
            )}
          </div>
        </div>
      </div>
    );
  };

  ref.state = {
    ...ref.state,
    updateScene: (fileInfo: FileInfo, timeMs: number) => {
      currentFileInfo = fileInfo;
      currentTimeMs = timeMs;
      
      if (sceneContainerRef.current) {
        const sceneContent = renderSceneContent();
        $(sceneContainerRef).update(sceneContent);
      }
    },
    clearScene: () => {
      currentFileInfo = null;
      currentTimeMs = 0;
      
      if (sceneContainerRef.current) {
        const sceneContent = renderSceneContent();
        $(sceneContainerRef).update(sceneContent);
      }
    }
  };

  // Add keyboard event listener for escape key
  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', handleKeyDown);
  }

  // Initial render
  const initialSceneContent = renderSceneContent();

  return (
    <div ref={ref} className="flex-shrink-0 h-50">
      <div ref={sceneContainerRef} className="overflow-y-auto">
        {initialSceneContent}
      </div>
    </div>
  );
};
