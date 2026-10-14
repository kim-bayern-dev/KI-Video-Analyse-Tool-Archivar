import { createRef, t, $, type Ref, type Props, type VNode } from "defuss";
import { Button, Spinner } from "../../../cl";
import { Modal } from "../../../cl/components/modal";
import type { FileInfo } from "../../../rpc/file-api";
import type { RegionType } from "../../../cl/components/region-icon";
import { getRpcClient } from "defuss-rpc/client.js";
import type { RpcApi } from "../../../rpc.js";

type DetectionType = RegionType | "scene" | "sceneKeyframe";

const rpc = await getRpcClient<RpcApi>();
const analyseApi = new rpc.AnalyseApi();

// REFACTOR(dry): 4th copy of this emoji map (events-list.tsx:9, transcription-view.tsx:25,
// timeline.tsx:3 — note timeline already diverges on the scene emoji) — hoist one shared map.
const regionEmoji: Record<string, string> = {
  speech: "🎤",
  silence: "🔇",
  noise: "🔊",
  ambience: "🎵",
  harmonic: "〰️",
  scene: "🎨",
  sceneKeyframe: "🖼️",
};

/**
 * Map detection type to MediaSegmentType expected by the RPC API.
 * The API has no "ambience" segment type (src/lib/workflow-types.ts:103), so ambience
 * regions are routed through the harmonic pipeline.
 */
function toMediaSegmentType(detectionType: DetectionType): string {
  switch (detectionType) {
    case "scene": return "scene";
    case "sceneKeyframe": return "keyframe";
    case "speech": return "speech";
    case "harmonic": return "harmonic";
    case "noise": return "noise";
    case "silence": return "silence";
    case "ambience": return "harmonic";
    // REFACTOR(kiss): silently mapping unknown types to "speech" misroutes analysis —
    // fail fast (throw) or at least log instead.
    default: return "speech";
  }
}

/** Imperative open/close API — dashboard.tsx opens the modal from the events-list analyze button. */
export interface AnalyzeModalRef {
  open: (fileInfo: FileInfo, detectionType: DetectionType) => void;
  close: () => void;
}

export interface AnalyzeModalProps extends Props {
  ref?: Ref<HTMLDivElement, AnalyzeModalRef>;
  /**
   * Runs the actual analysis (dashboard.tsx onAnalyzeModalConfirm) and resolves when done;
   * the modal shows its progress footer until then and closes itself in a finally block.
   */
  onConfirm: (
    fileInfo: FileInfo,
    detectionType: DetectionType,
    modelName: string,
    prompt: string,
    systemPrompt?: string,
  ) => Promise<void>;
}

/**
 * Per-event (re-)analyze dialog: model + prompt (+ collapsible system prompt) prefilled
 * from server-side analysis defaults for the detection type. All state is closure-local;
 * body and footer are re-rendered imperatively, and closing is blocked while analysis runs.
 */
export const AnalyzeModal = ({
  ref = createRef<HTMLDivElement, AnalyzeModalRef>(),
  onConfirm,
}: AnalyzeModalProps) => {
  const modalRef = createRef();
  const contentRef = createRef<HTMLDivElement>();
  const footerRef = createRef<HTMLDivElement>();

  let isOpen = false;
  let isLoading = false;
  let isAnalyzing = false;
  let listenerRegistered = false;
  let currentFileInfo: FileInfo | null = null;
  let currentDetectionType: DetectionType | null = null;
  let selectedWorkflow = "";
  let availableWorkflows: Array<{ name: string; description?: string }> = [];
  let selectedModel = "";
  let promptValue = "";
  let systemPromptValue = "";
  let availableModels: Array<{ name: string; type: string; defaultPrompt?: string }> = [];
  let showAdvanced = false;

  /** Re-fetch model/prompt/systemPrompt defaults for the current workflow + media type */
  const refetchDefaults = async () => {
    if (!currentFileInfo || !currentDetectionType) return;
    const mediaType = toMediaSegmentType(currentDetectionType);

    console.log(`Refetching analysis defaults for workflow "${selectedWorkflow}" and media type "${mediaType}"...`);
    try {
      // REFACTOR(kiss): `as any` discards the MediaSegmentType union — toMediaSegmentType
      // could return MediaSegmentType (src/lib/workflow-types.ts:103) and drop the cast
      // (same cast again in openModal below).
      const defaults = await analyseApi.getAnalysisDefaults(
        currentFileInfo.relativePath || currentFileInfo.path,
        mediaType as any,
        selectedWorkflow || undefined,
      );
      console.log("Fetched analysis defaults:", defaults);

      selectedModel = defaults.modelName;
      promptValue = defaults.prompt;
      systemPromptValue = defaults.systemPrompt ?? "";
      availableModels = defaults.availableModels;
    } catch (err) {
      console.error("Failed to fetch analysis defaults:", err);
    }
    renderContent();
  };

  const renderContent = () => {
    if (!contentRef.current) return;

    if (isLoading) {
      $(contentRef).update(
        <div class="flex items-center justify-center p-8">
          <Spinner />
          <span class="ml-3 text-gray-600">{t("events_list.analyzing")}...</span>
        </div>
      );
      return;
    }

    const emoji = currentDetectionType ? (regionEmoji[currentDetectionType] ?? "🔍") : "🔍";
    const typeLabel = currentDetectionType
      ? t(`events_list.type_${currentDetectionType === "sceneKeyframe" ? "scene_keyframe" : currentDetectionType}`)
      : "";

    console.log(`Rendering AnalyzeModal content for file "${currentFileInfo?.path}" and detection type "${currentDetectionType}"...`);
    console.log(`TypeLabel:`, typeLabel);
    console.log(`Emoji:`, emoji);

    // REFACTOR(kiss): filtering availableModels during render mutates closure state as a
    // render side effect — move the ASR-only restriction to where defaults are assigned
    // (openModal/refetchDefaults) so render stays pure.
    if (currentDetectionType === "speech") {
      availableModels = availableModels.filter((m) => m.type === "asr-api" || m.type === "tool");
    }

    $(contentRef).update(
      <div class="flex flex-col gap-4">
        {/* Workflow selection — intentionally hidden (product decision, like the events-list
            SceneVisualization): the config default workflow is used, but the fetch and the
            select stay wired so the UI can be re-enabled. */}
        <div>
          <label class="uk-form-label font-semibold mb-1 block hidden">
            {t("events_list.analyze_workflow_label")}
          </label>
          <select
            class="uk-select w-full hidden"
            value={selectedWorkflow}
            onchange={(e: Event) => {
              selectedWorkflow = (e.target as HTMLSelectElement).value;
              refetchDefaults();
            }}
          >
            {availableWorkflows.map((w) => (
              <option value={w.name} selected={w.name === selectedWorkflow}>
                {w.name}{w.description ? ` - ${w.description}` : ""}
              </option>
            ))}
          </select>
        </div>

        {/* Model selection */}
        <div>
          <label class="uk-form-label font-semibold mb-1 block">
            {t("events_list.analyze_model_label")}
          </label>
          <select
            class="uk-select w-full"
            value={selectedModel}
            onchange={(e: Event) => {
              selectedModel = (e.target as HTMLSelectElement).value;
              // Prefill the newly selected model's default prompt when the
              // prompt field is empty (never override user input)
              if (!promptValue) {
                const model = availableModels.find((m) => m.name === selectedModel);
                if (model?.defaultPrompt) {
                  promptValue = model.defaultPrompt;
                }
              }
              renderContent();
            }}
          >
            {availableModels.map((m) => (
              <option value={m.name} selected={m.name === selectedModel}>
                {m.name} ({m.type})
              </option>
            ))}
          </select>
        </div>

        {/* Prompt */}
        <div>
          <label class="uk-form-label font-semibold mb-1 block">
            {t("events_list.analyze_prompt_label")}
          </label>
          {(() => {
            const selType = availableModels.find((m) => m.name === selectedModel)?.type;
            const isAsr = selType === "asr-api" || selType === "tool";
            return isAsr
              ? <p class="text-sm text-muted-foreground italic">
                {t("events_list.analyze_prompt_asr_hint")}
              </p>
              : <textarea
                class="uk-textarea w-full"
                rows={4}
                value={promptValue}
                oninput={(e: Event) => {
                  promptValue = (e.target as HTMLTextAreaElement).value;
                }}
              >{promptValue}</textarea>;
          })()}
        </div>

        {/* Advanced: System Prompt (collapsible) */}
        <div>
          <button
            class="cursor-pointer text-sm text-primary underline"
            type="button"
            onclick={() => {
              showAdvanced = !showAdvanced;
              renderContent();
            }}
          >
            {showAdvanced
              ? `▾ ${t("events_list.analyze_advanced_hide")}`
              : `▸ ${t("events_list.analyze_advanced_show")}`}
          </button>
          {showAdvanced && (
            <div class="mt-2">
              <label class="uk-form-label font-semibold mb-1 block">
                {t("events_list.analyze_system_prompt_label")}
              </label>
              <textarea
                class="uk-textarea w-full"
                rows={3}
                value={systemPromptValue}
                oninput={(e: Event) => {
                  systemPromptValue = (e.target as HTMLTextAreaElement).value;
                }}
              >{systemPromptValue}</textarea>
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderFooter = () => {
    if (!footerRef.current) return;

    if (isAnalyzing) {
      $(footerRef).update(
        <div class="flex flex-col items-center gap-2 w-full">
          <progress class="uk-progress w-full"></progress>
          <span class="text-sm text-gray-600">{t("events_list.analyzing")}...</span>
        </div>
      );
    } else {
      $(footerRef).update(
        <div class="flex justify-end gap-2">
          <Button type="ghost" onClick={closeModal}>
            {t("events_list.analyze_cancel")}
          </Button>
          <Button type="primary" onClick={handleConfirm}>
            {t("events_list.analyze")}
          </Button>
        </div>
      );
    }
  };

  const handleConfirm = async () => {
    if (!currentFileInfo || !currentDetectionType) return;

    isAnalyzing = true;
    renderFooter();

    try {
      await onConfirm(
        currentFileInfo,
        currentDetectionType,
        selectedModel,
        promptValue,
        systemPromptValue || undefined,
      );
    } finally {
      isAnalyzing = false;
      closeModal();
    }
  };

  const closeModal = () => {
    if (isAnalyzing) return;
    isOpen = false;
    const uk = (window as any).UIkit;
    if (uk && modalRef.current) uk.modal(modalRef.current).hide();
  };

  const openModal = async (fileInfo: FileInfo, detectionType: DetectionType) => {
    currentFileInfo = fileInfo;
    currentDetectionType = detectionType;
    isOpen = true;
    isLoading = true;
    showAdvanced = false;

    // Show the modal via UIkit API
    const uk = (window as any).UIkit;
    if (uk && modalRef.current) {
      uk.modal(modalRef.current).show();

      // Block UIkit-triggered close (ESC / background click) while analyzing.
      // Registered once only: the modal element persists across opens, so re-registering
      // on every open would stack duplicate handlers.
      if (!listenerRegistered) {
        listenerRegistered = true;
        uk.util.on(modalRef.current, 'beforehide', (e: Event) => {
          if (isAnalyzing) e.preventDefault();
        });
      }
    }

    renderContent();
    renderFooter();

    // Fetch workflows and defaults from server in parallel
    try {
      const mediaType = toMediaSegmentType(detectionType);
      const [workflowsResult, defaults] = await Promise.all([
        analyseApi.listWorkflows(),
        analyseApi.getAnalysisDefaults(
          fileInfo.relativePath || fileInfo.path,
          mediaType as any,
        ),
      ]);

      availableWorkflows = workflowsResult.workflows;
      // Prefer the config default, fallback to first workflow
      selectedWorkflow = (workflowsResult.defaultWorkflow || availableWorkflows[0]?.name) ?? "";
      selectedModel = defaults.modelName;
      promptValue = defaults.prompt;
      systemPromptValue = defaults.systemPrompt ?? "";
      availableModels = defaults.availableModels;
    } catch (err) {
      console.error("Failed to fetch analysis defaults:", err);
      availableWorkflows = [];
      selectedWorkflow = "";
      availableModels = [];
      selectedModel = "";
      promptValue = "";
      systemPromptValue = "";
    }

    isLoading = false;
    renderContent();
    renderFooter();
  };

  // Expose API via ref
  ref.state = {
    open: openModal,
    close: closeModal,
  };

  // REFACTOR(dry): unused locals — renderContent computes its own emoji/typeLabel at
  // lines 113-116; remove these.
  const emoji = "🔍";
  const typeLabel = t("events_list.analyze");

  return (
    <Modal
      ref={modalRef}
      closeOnBg
      closeOnEsc
      header={
        (<h3 class="uk-modal-title">
          {t("events_list.analyze_modal_title")}
        </h3>) as VNode
      }
      footer={
        (<div ref={footerRef}>
          <div class="flex justify-end gap-2">
            <Button type="ghost" onClick={closeModal}>
              {t("events_list.analyze_cancel")}
            </Button>
            <Button type="primary" onClick={handleConfirm}>
              {t("events_list.analyze")}
            </Button>
          </div>
        </div>) as VNode
      }
    >
      {(<div ref={contentRef}>
        {/* Content rendered dynamically via renderContent() */}
      </div>) as VNode}
    </Modal>
  );
};
