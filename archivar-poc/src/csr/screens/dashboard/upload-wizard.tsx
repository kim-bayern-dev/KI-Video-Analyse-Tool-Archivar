import { createRef, t, type Ref, type Props, type VNode } from "defuss";
import { render } from "defuss/client"
import { Modal } from "../../../cl/components/modal.js";
import { Progress } from "../../../cl/components/progress.js";
import { Spinner } from "../../../cl/components/spinner.js";
import { checkFileExists, uploadFile, cancelUpload, type UploadProgress } from "../../lib/upload-client.js";
import { matchProcessingLine, matchProgressLine, applyProgressEvent, determinateBarValue, creepBarValue, createProcessingProgress, BAR_WINDOW } from "../../lib/processing-status.js";
import { getRpcClient } from "defuss-rpc/client.js";
import type { RpcApi } from "../../../rpc.js";
import type { FileInfo } from "../../../rpc/file-api.js";

const rpc = await getRpcClient<RpcApi>();
const analyseApi = new rpc.AnalyseApi();
/** Used for clearFileCache() — resolves the outputHash server-side by filename. */
const fileApi = new rpc.FileApi();

/** Upload dialog only: prompt/expert UI is hidden (code kept; flip to true to restore). */
const SHOW_PROMPT_CONTROLS = false;

/** Map well-known workflow names to emoji icons */
const workflowIcons: Record<string, string> = {
  "default-analysis": "📝",
  //"semantic": "🧠",
};
const defaultWorkflowIcon = "⚙️";

/**
 * Imperative handle exposed to the parent via `ref.state` (defuss pattern):
 * DashboardScreen calls `uploadWizardRef.state.open(...)` from the file list's
 * upload button, passing the currently selected file so the wizard can skip
 * the upload for files already on the server.
 */
export interface UploadWizardRef {
  open: (preSelectedFile?: FileInfo) => void;
  close: () => void;
}

/** `onUploadComplete` lets the dashboard refresh its file list after processing finishes and select/scroll to the processed file. */
export interface UploadWizardProps extends Props {
  ref?: Ref<HTMLDivElement, UploadWizardRef>;
  onUploadComplete?: (fileName: string) => void;
}

/**
 * Five-step modal wizard: upload/pre-select file → workflow → per-clip-type
 * analysis config → post-processing plugins → processing.
 *
 * All state lives in closure variables (no stores): every mutation ends in
 * renderCurrentStep(), which clears wizardBodyRef and re-renders the current
 * step's JSX from scratch. The fixed footer buttons sit outside that
 * re-render, so updateButtons() patches them imperatively.
 */
// REFACTOR(complexity): ~1000 lines with 20+ closure state vars and five step renderers in one component — split each renderStepN into its own module and group the per-step state with it.
export const UploadWizard = ({ ref = createRef<HTMLDivElement, UploadWizardRef>(), onUploadComplete }: UploadWizardProps) => {

  const modalRef = createRef();
  const wizardBodyRef = createRef<HTMLDivElement>();
  const backBtnRef = createRef<HTMLButtonElement>();
  const nextBtnRef = createRef<HTMLButtonElement>();
  const closeBtnRef = createRef<HTMLButtonElement>();
  const stepIndicatorRef = createRef<HTMLDivElement>();

  // Step 1: Upload state
  let currentStep = 0;
  let selectedFile: File | null = null;
  let uploadProgress = 0;
  let uploadStatus: UploadProgress["status"] | "idle" = "idle";
  let uploadErrorCode: string | undefined;
  let activeUploadId: string | null = null;
  let fileExistsError = false;
  // Cooperative cancel flag: the binary upload fetch cannot be aborted
  // mid-flight, so progress frames are simply ignored after a cancel.
  let uploadAborted = false;
  // True only when the file was uploaded in THIS wizard session. Existing
  // files (on disk from before) keep it false — they show the re-process
  // text in step 1 and get an obligatory cache clear before processing.
  let uploadedThisSession = false;
  let preSelectedFileInfo: FileInfo | null = null;
  let isPreSelectedFile = false; // Track if file was pre-selected (not from actual upload)
  // On-disk name after server-side upload sanitization (unsafe chars → "_"),
  // learned from checkFileExists' safeName or the pre-selected file. RPCs must
  // use this name; selectedFile.name keeps the original for display only.
  let serverFileName: string | null = null;

  // Step 2: Workflow selection state
  let selectedWorkflow = "";
  let availableWorkflows: Array<{ name: string; description?: string }> = [];
  let isLoadingWorkflows = false;

  // Step 3: Details configuration state (per-clip-type)
  interface ClipTypeConfig {
    mediaType: string;
    modelName: string;
    prompt: string;
    systemPrompt: string;
    enabled: boolean;
    availableModels: Array<{ name: string; type: string; defaultPrompt?: string }>;
  }
  let clipTypeConfigs: ClipTypeConfig[] = [];
  let activeTabIndex = 0;
  let showAdvanced = false;
  let isLoadingDefaults = false;
  // Set when getAllAnalysisDefaults rejects — renderStep3 shows an error
  // instead of the eternal "Lädt..." an empty config list would produce.
  let defaultsError: string | null = null;

  // Step 4: Post-processing configuration state
  let pluginStates: Array<{ name: string; description?: string; enabled: boolean; config?: Record<string, unknown> }> = [];
  let isLoadingPostProcessing = false;

  // Step 5: Processing state. One native-indeterminate progress bar plus a
  // status line and a live log view, all updated IMPERATIVELY from the
  // streamed debug.log — renderCurrentStep() must not run during streaming,
  // it would wipe the appended log lines (innerHTML = '').
  let processingDone = false;
  let processingError: string | null = null;
  let isProcessingActive = false;
  // Cooperative stop for the log-consumption loop once runWorkflow settles.
  let logStopRequested = false;
  const progressBarRef = createRef<HTMLProgressElement>();
  const statusTextRef = createRef<HTMLParagraphElement>();
  const logScrollRef = createRef<HTMLDivElement>();
  const logPreRef = createRef<HTMLPreElement>();
  const processingErrorRef = createRef<HTMLDivElement>();
  const waitIndicatorRef = createRef<HTMLSpanElement>();
  // Guards against stacking duplicate beforehide listeners across openModal() calls.
  let beforeHideListenerRegistered = false;

  const steps = [
    { label: t("upload_wizard.step1_label"), number: 1 },
    { label: t("upload_wizard.step2_label"), number: 2 },
    { label: t("upload_wizard.step3_label"), number: 3 },
    { label: t("upload_wizard.step4_label"), number: 4 },
    { label: t("upload_wizard.step5_label"), number: 5 },
  ];

  /** On-disk name for all server RPCs (uploads are sanitized server-side). */
  const onDiskFileName = (): string => serverFileName ?? selectedFile?.name ?? "";

  const canAdvance = (step: number): boolean => {
    // An existing file is auto-marked "confirmed" in onFileSelected(), so
    // "confirmed" covers both freshly-uploaded and pre-existing files.
    // Advancing while the upload is still in flight let runWorkflow hit a
    // file that did not exist server-side yet (race, proven 2026-08).
    if (step === 0) return selectedFile !== null && uploadStatus === "confirmed";
    if (step === 1) return selectedWorkflow !== "";
    if (step === 2) {
      if (isLoadingDefaults) return false;
      const enabledConfigs = clipTypeConfigs.filter((c) => c.enabled);
      if (enabledConfigs.length === 0) return false;
      // All enabled types with a prompt-supporting model must have non-empty prompts
      return enabledConfigs.every((c) => {
        const model = c.availableModels.find((m) => m.name === c.modelName);
        const supportsPrompt = model?.defaultPrompt != null;
        return !supportsPrompt || c.prompt.trim() !== "";
      });
    }
    if (step === 3) return !isLoadingPostProcessing; // post-processing config — always valid (user can skip)
    if (step === 4) return processingDone;
    return false;
  };

  // The footer lives outside wizardBodyRef, so it survives renderCurrentStep()
  // and must be patched imperatively after every step change.
  const updateButtons = () => {
    if (!backBtnRef.current || !nextBtnRef.current) return;

    // Back button
    backBtnRef.current.textContent = currentStep === 0 ? t("common.cancel") : t("common.back");
    // Hide back button during processing
    backBtnRef.current.style.visibility = currentStep === 4 && isProcessingActive ? "hidden" : "visible";

    // "Bitte warten…" wait indicator: visible exactly while processing runs
    if (waitIndicatorRef.current) {
      waitIndicatorRef.current.style.display = isProcessingActive ? "inline-flex" : "none";
    }

    // Next button
    if (currentStep === 4) {
      nextBtnRef.current.textContent = t("common.finish");
      nextBtnRef.current.disabled = !processingDone;
    } else if (currentStep === 3) {
      nextBtnRef.current.textContent = t("upload_wizard.process_btn");
      nextBtnRef.current.disabled = isLoadingPostProcessing;
    } else if (currentStep === 0) {
      if (uploadStatus === "confirmed") {
        nextBtnRef.current.textContent = t("common.next");
        nextBtnRef.current.disabled = false;
      } else {
        nextBtnRef.current.textContent = t("upload_wizard.upload_btn");
        nextBtnRef.current.disabled = !selectedFile || fileExistsError || uploadStatus === "uploading";
      }
    } else {
      nextBtnRef.current.textContent = t("common.next");
      nextBtnRef.current.disabled = !canAdvance(currentStep);
    }

    // X close button (lives in the static header, so patch it here like the
    // footer buttons): disabled while processing runs.
    if (closeBtnRef.current) {
      closeBtnRef.current.disabled = isProcessingActive;
      closeBtnRef.current.classList.toggle("opacity-50", isProcessingActive);
      closeBtnRef.current.classList.toggle("cursor-not-allowed", isProcessingActive);
    }
  };

  const renderStepChildren = () => {
    return steps.map((step, i) => {
      const isActive = i === currentStep;
      const isCompleted = i < currentStep;
      // While processing runs, all pills are inert: no navigating back.
      // The last step (processing) is never click-navigable: entering it via
      // a pill click would show the processing screen WITHOUT starting the
      // run (startProcessing is only invoked by the "Verarbeiten" button).
      const isProcessingStep = i === steps.length - 1;
      const isAccessible = !isProcessingActive && !isProcessingStep && (i === 0 || canAdvance(i - 1));

      return (
        <>
          <div
            className={`flex items-center gap-2 cursor-pointer px-3 py-2  transition-colors ${isActive ? "bg-primary/10 text-primary font-semibold" :
              isCompleted ? "text-primary" :
                "text-muted-foreground"
              } ${isAccessible ? "hover:bg-primary/5" : "opacity-50 cursor-not-allowed"}`}
            onClick={() => {
              if (isAccessible) {
                currentStep = i;
                renderCurrentStep();
              }
            }}
          >
            <span className={`flex items-center justify-center w-7 h-7 rounded-full text-sm border-2 ${isActive ? "border-primary bg-primary text-white" :
              isCompleted ? "border-primary bg-primary text-white" :
                "border-muted-foreground"
              }`}>
              {isCompleted ? "✓" : step.number}
            </span>
            <span className="text-sm whitespace-nowrap">{step.label}</span>
          </div>
          {i < steps.length - 1 && (
            <div className={`w-8 h-0.5 mx-1 ${i < currentStep ? "bg-primary" : "bg-muted-foreground/30"}`}></div>
          )}
        </>
      );
    });
  };

  const updateStepIndicator = () => {
    if (!stepIndicatorRef.current) return;
    stepIndicatorRef.current.innerHTML = '';
    render(<>{renderStepChildren()}</>, stepIndicatorRef.current);
  };

  const onFileSelected = async (file: File) => {
    selectedFile = file;
    fileExistsError = false;
    isPreSelectedFile = false; // Real file selected, not pre-selected
    // Reset the upload state: every (re-)selection re-validates against the
    // DISK via checkFileExists below. Without this reset a previously
    // confirmed file keeps uploadStatus="confirmed" even when the file was
    // deleted from disk in the meantime — the wizard would proceed without
    // ever re-uploading it.
    uploadStatus = "idle";
    uploadProgress = 0;
    uploadErrorCode = undefined;
    // Paint the picked file immediately; the async pre-flight check below
    // repaints once the exists/confirmed state is known.
    renderCurrentStep();

    try {
      const result = await checkFileExists(file.name);
      serverFileName = result.safeName; // on-disk name (sanitized server-side)
      if (result.exists) {
        // The file is already on the server: don't block the flow. Keep the
        // informational "file exists" message, but treat the file as a
        // confirmed existing file so the user can proceed to the next step,
        // clear its cache, or pick a different file. Mirrors openModal()'s
        // handling of a pre-selected unprocessed file.
        fileExistsError = true;
        uploadStatus = "confirmed";
        uploadProgress = 100;
      }
    } catch {
      // Network error - allow proceeding; startUpload will catch it server-side
    }
    renderCurrentStep();
  };

  const onFileDrop = (e: DragEvent) => {
    e.preventDefault();
    const dt = e.dataTransfer;
    if (dt?.files?.length) {
      onFileSelected(dt.files[0]);
    }
  };

  const onFileDragOver = (e: DragEvent) => {
    e.preventDefault();
  };

  const onFileSelect = (e: Event) => {
    const input = e.target as HTMLInputElement;
    if (input.files?.length) {
      onFileSelected(input.files[0]);
    }
  };

  const renderStep1 = () => {
    const fileInputRef = createRef<HTMLInputElement>();
    const uploadStarted = uploadStatus === "uploading" || uploadStatus === "confirmed";
    // REFACTOR(dry): the selected-file box below evaluates the same error-state ternary twice (border + background) — compute one hasError boolean first.
    return (
      <div className="flex flex-col items-center gap-4">
        {selectedFile ? (
          <div className={`w-full border-2 border-dashed ${fileExistsError ? "border-red-400" : uploadStatus === "error" || uploadStatus === "rejected" ? "border-red-400" : "border-primary/40"}  p-10 text-center ${fileExistsError ? "bg-red-50" : uploadStatus === "error" || uploadStatus === "rejected" ? "bg-red-50" : "bg-primary/5"}`}>
            <div className="text-4xl mb-3">{uploadStatus === "confirmed" ? "✅" : uploadStatus === "error" || uploadStatus === "rejected" ? "❌" : "📄"}</div>
            <p className="text-lg font-medium">{selectedFile.name}</p>
            {!isPreSelectedFile && selectedFile.size && (
              <p className="text-sm text-muted-foreground mt-1">
                {(selectedFile.size / (1024 * 1024)).toFixed(2)} MB
              </p>
            )}
            {fileExistsError && (
              <p className="text-sm text-red-600 mt-3 font-medium">
                {t("upload_wizard.file_exists_error")}
              </p>
            )}
            {(uploadStatus === "error" || uploadStatus === "rejected") && (
              <p className="text-sm text-red-600 mt-3 font-medium">
                {t("upload_wizard.upload_error")}
                {uploadErrorCode?.startsWith("file_exists") && " " + t("upload_wizard.file_exists_error")}
              </p>
            )}
            {uploadStarted && uploadStatus !== "error" && uploadStatus !== "rejected" && (
              <div className="w-full mt-4">
                <div className="flex justify-between text-sm mb-1">
                  <span className="text-muted-foreground">{uploadStatus === "confirmed" ? (uploadedThisSession ? t("upload_wizard.upload_complete") : t("upload_wizard.file_exists_reprocess")) : t("upload_wizard.uploading_status")}</span>
                  <span className="font-medium">{uploadProgress}%</span>
                </div>
                <Progress value={uploadProgress} max={100} />
              </div>
            )}
            <div className="flex gap-2 mt-4 justify-center">
              <button
                className="uk-btn uk-btn-danger uk-btn-sm"
                onClick={async () => {
                  if (!selectedFile) return;
                  const confirmed = window.confirm(
                    t("upload_wizard.clear_cache_confirm", { fileName: selectedFile.name })
                  );
                  if (!confirmed) return;

                  try {
                    // Delegate to FileApi.clearFileCache() which resolves the
                    // outputHash from the filename server-side and also removes
                    // output folders + debug artifacts. Works for both
                    // drag/dropped files and pre-selected ones.
                    const result = await fileApi.clearFileCache(onDiskFileName());
                    if (result.status === "error") {
                      alert(t("upload_wizard.clear_cache_error"));
                      return;
                    }
                    alert(t("upload_wizard.clear_cache_success"));
                  } catch (err) {
                    console.error("Failed to clear cache:", err);
                    alert(t("upload_wizard.clear_cache_error"));
                  }
                }}
              >
                {t("upload_wizard.clear_cache_btn")}
              </button>

              <button
                className="uk-btn uk-btn-default uk-btn-sm"
                onClick={() => {
                  selectedFile = null;
                  serverFileName = null;
                  fileExistsError = false;
                  isPreSelectedFile = false;
                  uploadStatus = "idle";
                  uploadProgress = 0;
                  uploadErrorCode = undefined;
                  renderCurrentStep();
                }}
              >
                {t("upload_wizard.choose_different")}
              </button>
            </div>
          </div>
        ) : (
          <div
            className="w-full border-2 border-dashed border-muted-foreground/40  p-10 text-center cursor-pointer hover:border-primary/60 hover:bg-primary/5 transition-colors"
            onDrop={onFileDrop}
            onDragOver={onFileDragOver}
            onClick={() => fileInputRef.current?.click()}
          >
            <div className="text-5xl mb-4">📤</div>
            <p className="text-lg font-medium">{t("upload_wizard.drag_drop_message")}</p>
            <p className="text-sm text-muted-foreground mt-2">{t("upload_wizard.click_browse")}</p>
            <p className="text-xs text-muted-foreground mt-1">{t("upload_wizard.supported_formats")}</p>
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              accept="video/*,audio/*,image/*"
              onChange={onFileSelect}
            />
          </div>
        )}
        {/* Show "Or choose $filename" button for pre-selected files (both processed and unprocessed) */}
        {!selectedFile && preSelectedFileInfo && (
          <button
            className="uk-btn uk-btn-primary mt-2"
            onClick={() => {
              // REFACTOR(dry): name-only File shim duplicated in openModal (upload-wizard.tsx:1002) — extract a makePreSelectedFile(fileInfo) helper; only `.name` is ever read (size is guarded at upload-wizard.tsx:243).
              selectedFile = { name: preSelectedFileInfo!.fileName } as File;
              serverFileName = preSelectedFileInfo!.fileName; // already the on-disk name
              uploadStatus = "confirmed";
              uploadProgress = 100;
              renderCurrentStep();
            }}
          >
            {t("upload_wizard.choose_existing", { fileName: preSelectedFileInfo.fileName })}
          </button>
        )}
      </div>
    );
  };

  /**
   * Drives the binary upload: a single fetch POST whose progress arrives via
   * server-side SSE events (/rpc/upload/progress/<id> — fetch() cannot report
   * client-side send progress, see upload-client.ts). Every yielded frame
   * repaints the step; uploadAborted just stops applying further frames.
   */
  const startRealUpload = async () => {
    if (!selectedFile || uploadStatus === "uploading") return;

    uploadAborted = false;
    uploadStatus = "uploading";
    uploadProgress = 0;
    uploadErrorCode = undefined;
    renderCurrentStep();

    try {
      for await (const progress of uploadFile(selectedFile)) {
        if (uploadAborted) return;

        activeUploadId = progress.uploadId ?? null;
        uploadProgress = progress.percent;
        uploadStatus = progress.status;
        uploadErrorCode = progress.errorCode;
        if (progress.status === "confirmed") uploadedThisSession = true;

        renderCurrentStep();
      }
    } catch (err) {
      if (uploadAborted) return;
      uploadStatus = "error";
      uploadErrorCode = "network_error";
      renderCurrentStep();
    }
  };

  const renderStep2 = () => {
    if (isLoadingWorkflows) {
      return (
        <div className="flex items-center justify-center p-8">
          <Spinner />
          <span className="ml-3 text-muted-foreground">{t("upload_wizard.workflow_loading")}</span>
        </div>
      );
    }

    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground mb-2">{t("upload_wizard.workflow_select_label")}</p>
        {availableWorkflows.map((wf) => {
          const isSelected = selectedWorkflow === wf.name;
          const icon = workflowIcons[wf.name] ?? defaultWorkflowIcon;
          return (
            <div
              key={wf.name}
              className={`flex items-start gap-4 p-4 border-2 cursor-pointer transition-colors ${isSelected
                ? "border-primary bg-primary/5"
                : "border-border hover:border-primary/40"
                }`}
              onClick={() => {
                selectedWorkflow = wf.name;
                renderCurrentStep();
              }}
            >
              <span className="text-2xl">{icon}</span>
              <div>
                <p className={`font-medium ${isSelected ? "text-primary" : ""}`}>{wf.name}</p>
                {wf.description && (
                  <p className="text-sm text-muted-foreground mt-0.5">{wf.description}</p>
                )}
              </div>
              {isSelected && <span className="ml-auto text-primary text-xl">✓</span>}
            </div>
          );
        })}
      </div>
    );
  };

  const fetchDefaults = async () => {
    if (!selectedFile || !selectedWorkflow) return;
    isLoadingDefaults = true;
    defaultsError = null;
    renderCurrentStep();
    try {
      const result = await analyseApi.getAllAnalysisDefaults(
        onDiskFileName(),
        selectedWorkflow,
      );
      // Incompatible modalities (per server `compatible` flag) are dropped, not
      // just disabled: their tabs/panes are never rendered. The processing
      // payload replaces workflow.processing wholesale server-side, so omitted
      // steps don't run — equivalent to enabled:false.
      clipTypeConfigs = result.steps.filter((step: any) => step.compatible !== false).map((step: any) => ({
        mediaType: step.mediaType,
        modelName: step.modelName,
        prompt: step.prompt ?? "",
        systemPrompt: step.systemPrompt ?? "",
        enabled: step.enabled,
        availableModels: step.availableModels,
      }));
      activeTabIndex = 0;
    } catch (err) {
      console.error("Failed to fetch analysis defaults:", err);
      defaultsError = err instanceof Error ? err.message : String(err);
    }
    isLoadingDefaults = false;
    renderCurrentStep();
  };

  /** Map mediaType to display label via i18n */
  const tabLabel = (mediaType: string): string => {
    const key = `upload_wizard.tab_${mediaType}`;
    const label = t(key);
    return label !== key ? label : mediaType;
  };

  const renderStep3 = () => {
    if (isLoadingDefaults) {
      return (
        <div className="flex items-center justify-center p-8">
          <Spinner />
          <span className="ml-3 text-muted-foreground">{t("common.loading")}</span>
        </div>
      );
    }

    if (defaultsError) {
      return <div className="p-4 text-red-600">{t("upload_wizard.defaults_load_error")}</div>;
    }

    // Loaded but nothing to configure: the selected workflow has no analysis
    // step compatible with this file type (e.g. no keyframe step for an
    // image). Previously this fell through to the eternal "Lädt...".
    if (clipTypeConfigs.length === 0) {
      return <div className="p-4 text-muted-foreground">{t("upload_wizard.no_compatible_steps")}</div>;
    }

    const cfg = clipTypeConfigs[activeTabIndex];
    const selectedModelInfo = cfg.availableModels.find((m) => m.name === cfg.modelName);
    const supportsPrompt = selectedModelInfo?.defaultPrompt != null;

    // REFACTOR(kiss): mutating cfg.availableModels during render — move the speech-model filtering into fetchDefaults() so renders stay pure.
    if (cfg.mediaType === "speech") {
      cfg.availableModels = cfg.availableModels.filter((m) => m.type === "asr-api" || m.type === "tool");
    }

    return (
      <div className="flex flex-col gap-4">
        {/* Tab bar */}
        <div className="flex border-b border-border overflow-x-auto">
          {clipTypeConfigs.map((c, i) => (
            <button
              type="button"
              className={`px-4 py-2 text-sm whitespace-nowrap transition-colors border-b-2 mr-2 ${i === activeTabIndex
                ? "border-primary text-primary font-semibold"
                : "border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/40"
                } ${!c.enabled ? "opacity-50" : ""}`}
              onClick={() => {
                activeTabIndex = i;
                renderCurrentStep();
              }}
            >
              {tabLabel(c.mediaType)}
            </button>
          ))}
        </div>

        {/* Enable/disable toggle */}
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            className="uk-checkbox"
            checked={cfg.enabled}
            onChange={() => {
              cfg.enabled = !cfg.enabled;
              renderCurrentStep();
            }}
          />
          <label className="text-sm font-medium">{t("upload_wizard.clip_type_enabled")}</label>
        </div>

        {cfg.enabled && (
          <>
            {/* Model selection */}
            <div>
              <label className="uk-form-label font-semibold mb-1 block">
                {t("upload_wizard.model_label")}
              </label>
              <select
                className="uk-select w-full"
                value={cfg.modelName}
                onChange={(e: Event) => {
                  const newModelName = (e.target as HTMLSelectElement).value;
                  const oldModel = cfg.availableModels.find((m) => m.name === cfg.modelName);
                  const newModel = cfg.availableModels.find((m) => m.name === newModelName);

                  // Auto-fill prompt when switching to a prompt-supporting model
                  // and the current prompt is empty or still the old model's default
                  if (newModel?.defaultPrompt && (!cfg.prompt.trim() || cfg.prompt === oldModel?.defaultPrompt)) {
                    cfg.prompt = newModel.defaultPrompt;
                  }

                  cfg.modelName = newModelName;
                  renderCurrentStep();
                  updateButtons();
                }}
              >
                {cfg.availableModels.map((m) => (
                  <option value={m.name} selected={m.name === cfg.modelName}>
                    {m.name} ({m.type})
                  </option>
                ))}
              </select>
            </div>

            {/* Prompt UI + expert toggle are hidden in the upload dialog (code kept; flip SHOW_PROMPT_CONTROLS to restore). */}
            {SHOW_PROMPT_CONTROLS && (<>
              {/* Prompt — only shown when model supports prompts */}
              {supportsPrompt ? (
                <div>
                  <label className="uk-form-label font-semibold mb-1 block">
                    {t("upload_wizard.prompt_label")}
                  </label>
                  <textarea
                    className="uk-textarea w-full"
                    rows={4}
                    value={cfg.prompt}
                    onInput={(e: Event) => {
                      cfg.prompt = (e.target as HTMLTextAreaElement).value;
                      updateButtons();
                    }}
                  >{cfg.prompt}</textarea>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground italic">
                  {t("upload_wizard.no_prompt_needed")}
                </p>
              )}

              {/* Advanced: System Prompt (collapsible) — only for prompt-supporting models */}
              {supportsPrompt && (
                <div>
                  <button
                    className="cursor-pointer text-sm text-primary underline"
                    type="button"
                    onClick={() => {
                      showAdvanced = !showAdvanced;
                      renderCurrentStep();
                    }}
                  >
                    {showAdvanced
                      ? `▾ ${t("upload_wizard.advanced_hide")}`
                      : `▸ ${t("upload_wizard.advanced_show")}`}
                  </button>
                  {showAdvanced && (
                    <div className="mt-2">
                      <label className="uk-form-label font-semibold mb-1 block">
                        {t("upload_wizard.system_prompt_label")}
                      </label>
                      <textarea
                        className="uk-textarea w-full"
                        rows={3}
                        value={cfg.systemPrompt}
                        onInput={(e: Event) => {
                          cfg.systemPrompt = (e.target as HTMLTextAreaElement).value;
                        }}
                      >{cfg.systemPrompt}</textarea>
                    </div>
                  )}
                </div>
              )}
            </>)}
          </>
        )}
      </div>
    );
  };

  const fetchPostProcessingDefaults = async () => {
    if (!selectedWorkflow) return;
    isLoadingPostProcessing = true;
    renderCurrentStep();
    try {
      const result = await analyseApi.getPostProcessingDefaults(selectedWorkflow);
      // Plugin states — post-processing is always on in the upload dialog:
      // the checkboxes render checked + readonly.
      pluginStates = result.plugins.map((p: any) => ({
        name: p.name,
        description: p.description,
        enabled: true,
        config: p.config,
      }));
    } catch (err) {
      console.error("Failed to fetch post-processing defaults:", err);
    }
    isLoadingPostProcessing = false;
    renderCurrentStep();
  };

  const renderStep4 = () => {
    if (isLoadingPostProcessing) {
      return (
        <div className="flex items-center justify-center p-8">
          <Spinner />
          <span className="ml-3 text-muted-foreground">{t("upload_wizard.postprocessing_loading")}</span>
        </div>
      );
    }

    return (
      <div className="flex flex-col gap-6">
        {/* Plugins section */}
        <div>
          <h3 className="text-base font-semibold mb-3">{t("upload_wizard.plugins_header")}</h3>
          {pluginStates.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">{t("upload_wizard.no_plugins_available")}</p>
          ) : (
            <div className="flex flex-col gap-2">
              {pluginStates.map((plugin) => (
                <div className="flex items-start gap-3 border border-border  p-3">
                  {/* Readonly: always enabled (see fetchPostProcessingDefaults) */}
                  <input
                    type="checkbox"
                    className="uk-checkbox mt-0.5"
                    checked={plugin.enabled}
                    disabled
                  />
                  <div>
                    <p className="font-medium">{plugin.name}</p>
                    {plugin.description && (
                      <p className="text-sm text-muted-foreground mt-0.5">{plugin.description}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  };

  /**
   * Kicks off the server workflow around the single blocking runWorkflow()
   * call. While it runs, FileApi.tailDebugLog streams the workflow's
   * debug.log line by line: each line is appended to the log view (with
   * auto-scroll) and pattern-matched to update the status text. The step-5
   * DOM is rendered once below and then only patched imperatively — a
   * renderCurrentStep() mid-run would wipe the appended log (innerHTML = '').
   */
  const startProcessing = async () => {
    isProcessingActive = true;
    processingDone = false;
    processingError = null;
    logStopRequested = false;
    currentStep = 4;
    renderCurrentStep();

    // Re-processing an existing file (not uploaded in this session) ALWAYS
    // clears its cache first — otherwise the run would silently hit stale
    // cached results. Must happen before the log stream starts: the clear
    // also removes <file>.archivar, so tailDebugLog then waits for the fresh
    // run's debug.log. Failures abort processing (a stale cache would be
    // worse than no run).
    if (!uploadedThisSession) {
      try {
        const clearResult = await fileApi.clearFileCache(onDiskFileName());
        if (clearResult.status === "error") {
          throw new Error(clearResult.error ?? t("upload_wizard.clear_cache_error"));
        }
      } catch (err) {
        processingError = err instanceof Error ? err.message : t("upload_wizard.clear_cache_error");
        isProcessingActive = false;
        if (processingErrorRef.current) {
          render(
            <div className="w-full border-2 border-dashed border-red-400 p-4 text-center bg-red-50">
              <div className="text-2xl mb-2">❌</div>
              <p className="text-base font-medium text-red-600">{t("upload_wizard.clear_cache_error")}</p>
              <p className="text-sm text-red-500 mt-1">{processingError}</p>
            </div>,
            processingErrorRef.current,
          );
        }
        updateButtons();
        return;
      }
    }

    // Real progress model (see processing-status.ts): log events disclose
    // totals (segments after "Pre-processing done", slices per post-processing
    // plugin) and drive the bar deterministically within phase windows;
    // phases without known totals creep within their window. Cleared on
    // settle, where the bar is pinned to 100.
    const progress = createProcessingProgress();
    if (progressBarRef.current) progressBarRef.current.value = BAR_WINDOW.pre[0];
    const progressTimer = setInterval(() => {
      const bar = progressBarRef.current;
      if (!bar) return;
      if (determinateBarValue(progress) !== null) return; // event-driven
      bar.value = creepBarValue(progress.phase, bar.value);
    }, 250);

    // Runs concurrently with the blocking workflow call. A dead stream must
    // never break processing, so errors are swallowed: the authoritative
    // outcome comes from runWorkflow itself. Intentionally not awaited — on
    // success the stream self-terminates ~1s after WORKFLOW COMPLETE and
    // drains the final lines; on error logStopRequested cuts it short.
    const consumeLog = async () => {
      try {
        for await (const line of fileApi.tailDebugLog(onDiskFileName())) {
          if (logStopRequested) break;
          if (logPreRef.current) {
            logPreRef.current.textContent += line + "\n";
            // Bound DOM growth: past ~100KB, keep the last ~50KB at a line boundary.
            if (logPreRef.current.textContent.length > 100_000) {
              const text = logPreRef.current.textContent;
              logPreRef.current.textContent = text.slice(text.indexOf("\n", text.length - 50_000) + 1);
            }
          }
          if (logScrollRef.current) {
            logScrollRef.current.scrollTop = logScrollRef.current.scrollHeight;
          }
          const match = matchProcessingLine(line);
          if (match && statusTextRef.current) {
            statusTextRef.current.textContent = "⏳ " + t(match.key, match.params);
          }
          const event = matchProgressLine(line);
          if (event) {
            const wasFinal = progress.phase === "final";
            applyProgressEvent(progress, event);
            if (progress.phase === "final" && !wasFinal) {
              // Unknown tail (aggregated cache write, output formatting) —
              // show the spinner with a "finalizing" note.
              if (statusTextRef.current) {
                statusTextRef.current.textContent = "⏳ " + t("upload_wizard.log_status_finalizing");
              }
            }
            const value = determinateBarValue(progress);
            if (value !== null && progressBarRef.current) {
              progressBarRef.current.value = value;
            }
          }
        }
      } catch (err) {
        console.warn("debug.log stream ended early:", err);
      }
    };
    consumeLog();

    // Build post-processing overrides from UI state: only name+enabled travel
    // to the server; plugin configs stay at their server-side defaults.
    const postProcessingOverrides = {
      plugins: pluginStates.map((p) => ({
        name: p.name,
        enabled: p.enabled,
      })),
    };

    try {
      // Output format is fixed to json here; the user picks docx/md/etc. later at export time.
      await analyseApi.runWorkflow(
        onDiskFileName(),
        selectedWorkflow,
        "json" as any,
        {
          processing: clipTypeConfigs.map((c) => ({
            mediaType: c.mediaType as any,
            modelName: c.modelName,
            prompt: c.prompt,
            systemPrompt: c.systemPrompt || undefined,
            enabled: c.enabled,
          })),
        },
        postProcessingOverrides,
      );

      // Success: stop the log stream FIRST so late-arriving STEP 9/10 lines
      // cannot overwrite the final state (they would re-show the spinner and
      // replace 🎉 with "⏳ Verarbeitung abschließen…"). Then pin bar to 100.
      logStopRequested = true;
      clearInterval(progressTimer);
      processingDone = true;
      isProcessingActive = false;
      if (progressBarRef.current) progressBarRef.current.value = 100;
      if (statusTextRef.current) {
        statusTextRef.current.textContent = "🎉 " + t("upload_wizard.log_status_workflow_done");
      }
      onUploadComplete?.(onDiskFileName());
    } catch (err) {
      clearInterval(progressTimer);
      // Cut the log stream short — without the COMPLETE marker it would idle
      // until the server-side safety cap.
      logStopRequested = true;
      processingError = err instanceof Error ? err.message : t("upload_wizard.processing_error");
      isProcessingActive = false;
      // Error banner mounts ABOVE the log: exactly on failure the streamed
      // log tail is the most valuable debugging artifact, so it must survive.
      if (processingErrorRef.current) {
        render(
          <div className="w-full border-2 border-dashed border-red-400 p-4 text-center bg-red-50">
            <div className="text-2xl mb-2">❌</div>
            <p className="text-base font-medium text-red-600">{t("upload_wizard.processing_error")}</p>
            <p className="text-sm text-red-500 mt-1">{processingError}</p>
          </div>,
          processingErrorRef.current,
        );
      }
    }

    // Footer (Finish button, close button) reacts to the settled state.
    updateButtons();
  };

  const renderStep5 = () => {
    return (
      <div className="flex flex-col gap-3 py-4">
        {/* Error banner mount point — filled imperatively on failure so the
            log view below is never wiped. */}
        <div ref={processingErrorRef} />
        {/* Real progress (processing-status.ts): log events disclose segment/
            slice totals and drive the bar; phases without totals creep within
            their window; pinned to 100 on success. */}
        <Progress max={100} ref={progressBarRef} />
        <div className="flex items-center gap-2">
          {/* Shown only in the final, non-determinate phase (aggregation cache
              write / output formatting) once STEP 9/10 lines arrive. */}

          <p ref={statusTextRef} className="text-lg text-muted-foreground m-0">
            ⏳ {t("upload_wizard.log_status_start")}
          </p>
        </div>
        {/* Live workflow log (debug.log), terminal styling like the
            dashboard's hidden Log tab: fixed height (~13 lines), newest
            lines appended at the bottom, auto-scroll on every line. */}
        <div ref={logScrollRef} className="overflow-y-auto rounded" style={{ height: "12em" }}>
          <pre
            ref={logPreRef}
            className="p-2 text-xs font-mono bg-gray-900 text-green-400 min-h-full"
            style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}
          ></pre>
        </div>
      </div>
    );
  };

  const renderCurrentStep = () => {
    if (!wizardBodyRef.current) return;

    let stepContent: VNode;
    if (currentStep === 0) stepContent = renderStep1() as VNode;
    else if (currentStep === 1) stepContent = renderStep2() as VNode;
    else if (currentStep === 2) stepContent = renderStep3() as VNode;
    else if (currentStep === 3) stepContent = renderStep4() as VNode;
    else stepContent = renderStep5() as VNode;

    wizardBodyRef.current.innerHTML = '';
    render(stepContent, wizardBodyRef.current);

    updateStepIndicator();
    updateButtons();
  };

  // Cancel is cooperative: timers/frames stop client-side and cancelUpload
  // discards the server-side chunks, but an in-flight chunk fetch cannot be
  // aborted — one trailing chunk may still land before the discard runs.
  const tryCancel = async (): Promise<boolean> => {
    // Closing is disabled while processing runs (no abort offer).
    if (isProcessingActive) {
      return false;
    }
    if (activeUploadId && uploadStatus === "uploading") {
      const confirmed = window.confirm(t("upload_wizard.cancel_confirm"));
      if (!confirmed) return false;
      uploadAborted = true;
      try {
        await cancelUpload(activeUploadId);
      } catch {
        // best-effort cleanup
      }
      activeUploadId = null;
    }
    return true;
  };

  const onBack = async () => {
    if (currentStep === 0) {
      if (await tryCancel()) closeModal();
    } else if (currentStep === 4) {
      // Cannot go back during processing
      if (isProcessingActive) return;
      currentStep--;
      renderCurrentStep();
    } else {
      currentStep--;
      renderCurrentStep();
    }
  };

  const fetchWorkflows = async () => {
    if (availableWorkflows.length > 0) return; // already fetched
    isLoadingWorkflows = true;
    renderCurrentStep();
    try {
      const result = await analyseApi.listWorkflows();
      availableWorkflows = result.workflows;
      if (availableWorkflows.length > 0 && !selectedWorkflow) {
        // Prefer the config default, fallback to first workflow
        selectedWorkflow = result.defaultWorkflow || availableWorkflows[0].name;
      }
    } catch (err) {
      console.error("Failed to fetch workflows:", err);
      availableWorkflows = [];
    }
    isLoadingWorkflows = false;
    renderCurrentStep();
  };

  // REFACTOR(magic): steps are addressed as bare indices 0-4 across canAdvance/updateButtons/onNext/onBack/renderCurrentStep — a STEP = { UPLOAD: 0, WORKFLOW: 1, ... } constant would keep the transitions readable.
  const onNext = async () => {
    if (currentStep === 0 && uploadStatus !== "confirmed" && uploadStatus !== "uploading") {
      // First click on step 0 (or retry after error/rejected): start upload
      if (selectedFile && !fileExistsError) {
        startRealUpload();
      }
      return;
    }
    if (currentStep === 0 && canAdvance(0)) {
      currentStep = 1;
      fetchWorkflows();
      return;
    }
    if (currentStep === 1 && canAdvance(1)) {
      currentStep = 2;
      fetchDefaults();
      return;
    }
    if (currentStep === 2 && canAdvance(2)) {
      currentStep = 3;
      fetchPostProcessingDefaults();
      return;
    }
    if (currentStep === 3) {
      // "Verarbeiten" button - start processing
      startProcessing();
      return;
    }
    if (currentStep === 4) {
      if (processingDone) {
        closeModal();
      }
      return;
    }
  };

  const closeModal = async () => {
    if (!(await tryCancel())) return;
    // The UIkit modal is driven via the window global, not through defuss refs.
    if (modalRef.current) {
      const uk = (window as any).UIkit;
      if (uk) {
        uk.modal(modalRef.current).hide();
      }
    }
  };

  /**
   * Resets every closure variable (the wizard mounts once with the dashboard
   * and is reused across openings) and shows the modal. A pre-selected file
   * that has no output folder yet (not processed) is auto-marked confirmed so
   * step 1 can be skipped with one click.
   */
  const openModal = (preSelectedFile?: FileInfo) => {
    // Reset wizard state
    currentStep = 0;
    selectedFile = null;
    uploadProgress = 0;
    uploadStatus = "idle";
    uploadErrorCode = undefined;
    activeUploadId = null;
    fileExistsError = false;
    uploadAborted = false;
    uploadedThisSession = false;
    isPreSelectedFile = false;
    preSelectedFileInfo = preSelectedFile ?? null;
    serverFileName = null;

    // If pre-selected file is provided and not processed, auto-select it
    if (preSelectedFileInfo && !preSelectedFileInfo.outputFolderName) {
      selectedFile = { name: preSelectedFileInfo.fileName } as File;
      serverFileName = preSelectedFileInfo.fileName; // already the on-disk name
      uploadStatus = "confirmed";
      uploadProgress = 100;
      isPreSelectedFile = true;
    }

    // Reset workflow state
    selectedWorkflow = "";
    availableWorkflows = [];
    isLoadingWorkflows = false;

    // Reset config state
    clipTypeConfigs = [];
    activeTabIndex = 0;
    showAdvanced = false;
    isLoadingDefaults = false;

    // Reset post-processing config state
    pluginStates = [];
    isLoadingPostProcessing = false;

    // Reset processing state
    processingDone = false;
    processingError = null;
    isProcessingActive = false;
    logStopRequested = false;

    if (modalRef.current) {
      const uk = (window as any).UIkit;
      if (uk) {
        uk.modal(modalRef.current).show();

        // Block UIkit-triggered close (ESC) while processing runs. Registered
        // once only: the modal element persists across opens (same pattern as
        // analyze-modal.tsx).
        if (!beforeHideListenerRegistered) {
          beforeHideListenerRegistered = true;
          uk.util.on(modalRef.current, 'beforehide', (e: Event) => {
            if (isProcessingActive) e.preventDefault();
          });
        }
      }
      renderCurrentStep();
    }
  };

  ref.state = {
    ...ref.state,
    open: openModal,
    close: closeModal,
  };

  const header = (
    <>
      <h2 className="uk-modal-title text-lg font-semibold">{t("upload_wizard.modal_title")}</h2>
      {/* Always-visible corner close. Deliberately no data-uk-close: UIkit
          would hide the modal directly, bypassing tryCancel's upload guard.
          Disabled while processing runs (patched in updateButtons). */}
      <button
        ref={closeBtnRef}
        type="button"
        aria-label={t("common.close")}
        className="uk-modal-close absolute right-4 top-4 cursor-pointer text-xl leading-none w-6"
        onClick={() => { if (!isProcessingActive) closeModal(); }}
      >✕</button>
    </>
  ) as VNode;

  const footer = (
    <div className="flex justify-between">
      {/* Visible only while processing runs (toggled in updateButtons):
          spinner + "Bitte warten…" in place of the Back button. */}
      <span ref={waitIndicatorRef} className="items-center gap-2 text-lg text-muted-foreground" style={{ display: "none" }}>
        <Spinner size={24} />
        {t("upload_wizard.please_wait")}
      </span>
      <button ref={backBtnRef} className="uk-btn uk-btn-default" onClick={onBack}>{t("common.cancel")}</button>
      <button ref={nextBtnRef} className="uk-btn uk-btn-primary" onClick={onNext} disabled>{t("common.next")}</button>
    </div>
  ) as VNode;

  return (
    <Modal ref={modalRef} closeOnBg={false} closeOnEsc header={header} footer={footer}>
      {(
        <>
          <div ref={stepIndicatorRef} className="flex items-center justify-center gap-0 mb-6 ml-8 mr-8">
            {renderStepChildren()}
          </div>
          <div ref={wizardBodyRef}>
            {renderStep1()}
          </div>
        </>
      ) as VNode}
    </Modal>
  );
};
