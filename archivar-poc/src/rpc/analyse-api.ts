import { spawn } from 'child_process';
import { getEnv } from 'defuss-env';
import { resolve, join } from 'path';
import { WorkflowEngine } from './workflow-engine.js';
import { MllmApi } from './mllm-api.js';
import { StatusApi } from './status-api.js';
import type { WorkflowDefinition, MediaSegmentType, FileWorkflowConfig, PostProcessingSelection, OutputFormat, PostProcessingPluginDefinition } from '../lib/workflow-types.js';
import { getModel, getArchivarConfig, resolveWorkflowModels, resolveDefaultWorkflowName } from '../lib/archivar-config.js';
import {
  loadFileWorkflowConfig,
  saveFileWorkflowConfig as saveFileWfConfig,
  getEffectiveWorkflow,
} from '../lib/file-workflow-config.js';
import { getFileTypeFromExtension } from './file-api.js';
import type { ExportFormat } from './export.js';

/**
 * Outcome of a tool-script execution. `parsedResult` is best-effort: external
 * tools print human-readable banners before their JSON payload, so the JSON is
 * scraped from stdout and may be absent even on success.
 */
export interface ScriptResult {
  stdout: string;
  stderr: string;
  parsedResult?: any;
}

/**
 * Public analysis RPC surface (whitelisted methods exposed via src/rpc.ts).
 * Bridges high-level operations — run a workflow, inspect workflow/model
 * defaults, analyze a single segment — down to shell-tool scripts and the
 * model backends in MllmApi.
 */
export class AnalyseApi {
  /**
   * Generalized script execution function
   * @param toolName Name of the tool directory (e.g., 'segment-scenes', 'segment-temporal')
   * @param filePaths Array of relative file paths to analyze (relative to data directory)
   * @param cliArgs Optional array of CLI arguments (e.g., ['--foo=bar', '--verbose'])
   * @returns Promise<ScriptResult> Object containing stdout, stderr, and parsed JSON result
   */
  public async executeScript(toolName: string, filePaths: string[], cliArgs: string[] = []): Promise<ScriptResult> {
    // Tools root: ABSOLUTE_TOOLS_PATH (absolute, injected by start.sh for the
    // container — the sibling projects are mounted at their identical host
    // path) wins; otherwise resolve RELATIVE_TOOLS_PATH against the cwd (dev:
    // the checkout's parent dir, where the sibling tools live).
    const toolsRoot = getEnv('ABSOLUTE_TOOLS_PATH', '') ||
      resolve(process.cwd(), getEnv('RELATIVE_TOOLS_PATH', `..`));
    const toolDir = join(toolsRoot, toolName);            // …/segment-scenes
    const scriptPath = join(toolDir, 'run.sh');                // …/segment-scenes/run.sh

    try {
      // Validate input
      if (!Array.isArray(filePaths) || filePaths.length === 0) {
        throw new Error('filePaths must be a non-empty array of relative paths');
      }

      const args = [...filePaths, ...cliArgs];

      console.log(`Running ${toolName}: ${scriptPath} ${args.join(' ')}`);

      const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolveP, rejectP) => {
        const child = spawn(scriptPath, args, {
          cwd: toolDir,                       // run.sh's directory; no accidental extra arg
          env: { ...process.env },
          shell: false,                       // keep execve semantics
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let out = '', err = '';
        // Stream stderr to console in real-time, strip null bytes to prevent binary corruption
        child.stderr.on('data', d => {
          const text = d.toString().replace(/\0/g, '');
          process.stderr.write(text);
          err += text;
        });
        // Stream stdout to console in real-time, strip null bytes to prevent binary corruption
        child.stdout.on('data', d => {
          const text = d.toString().replace(/\0/g, '');
          process.stdout.write(text);
          out += text;
        });
        child.on('error', rejectP);
        child.on('close', (code) => {
          if (code === 0) resolveP({ stdout: out, stderr: err });
          else rejectP(new Error(`exit ${code}\n${err || out}`));
        });
      });

      // Tools print banners before their JSON payload. The greedy match spans
      // the first "{" through the last "}" at end of output — robust against
      // brace-free banners, brittle if banner text itself contains braces.
      let parsed: any | undefined;
      const m = stdout.match(/\{[\s\S]*\}\s*$/);
      if (m) {
        try { parsed = JSON.parse(m[0]); } catch {/* ignore parse errors */ }
      }

      return { stdout, stderr, parsedResult: parsed };
    } catch (error) {
      console.error(`Error executing script:`, error);
      throw error;
    }
  }

  /**
   * Runs scene segmentation analysis on a single file
   * @param filePath Relative file path to analyze (relative to data directory)
   * @param cliArgs Optional array of CLI arguments (e.g., ['--threshold=0.5', '--verbose'])
   * @returns Promise<ScriptResult> Object containing stdout, stderr, and parsed JSON result
   */
  public async segmentScenes(filePath: string, cliArgs: string[] = []): Promise<ScriptResult> {
    return this.executeScript('segment-scenes', [filePath], cliArgs);
  }

  /**
   * Runs temporal segmentation analysis on a single file
   * @param filePath Relative file path to analyze (relative to data directory)
   * @param cliArgs Optional array of CLI arguments (e.g., ['--duration=30', '--verbose'])
   * @returns Promise<ScriptResult> Object containing stdout, stderr, and parsed JSON result
   */
  public async segmentTemporal(filePath: string, cliArgs: string[] = []): Promise<ScriptResult> {
    return this.executeScript('segment-temporal', [filePath], cliArgs);
  }

  // ==========================================================================
  // Workflow Engine Methods
  // ==========================================================================

  // Engine is created lazily: only workflow methods need it, and constructing one
  // pulls in FileApi/MllmApi/CacheApi/StatusApi — script/defaults queries never pay that.
  private _engine?: WorkflowEngine;

  private getEngine(): WorkflowEngine {
    if (!this._engine) {
      this._engine = new WorkflowEngine();
    }
    return this._engine;
  }

  /**
   * Run a named workflow on a file.
   * @param webHookUrl Optional URL to call when workflow completes.
   * @param exportFormats Optional export formats to generate on completion
   *   (written to <file>.archivar/exports/ and referenced by webhook/poll responses).
   */
  public async runWorkflow(
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
    // Immediately write status.json with "processing" status before async execution starts.
    // This allows immediate polling for status after this call returns.
    // The resolved VLM/ASR model names are recorded so exports can show them
    // even if the workflow is later renamed/removed from the config.
    const statusApi = new StatusApi();
    // The default-workflow fallback is centralized in archivar-config
    // (resolveDefaultWorkflowName): config.defaults.workflow, else the first
    // configured workflow.
    const effectiveWorkflowName = workflowName ?? resolveDefaultWorkflowName(getArchivarConfig());
    // Record the EFFECTIVE workflow name (not the raw, possibly-undefined param):
    // loadMetadata/getStatus resolve VLM/ASR models only when a workflow is present,
    // so recording undefined here left exports + the dashboard with empty models.
    statusApi.startProcessing(filePath, effectiveWorkflowName, webHookUrl, resolveWorkflowModels(effectiveWorkflowName));

    try {
      return await this.getEngine().runWorkflow(filePath, workflowName, outputFormat, overrides, postProcessingOverrides, force, only, webHookUrl, exportFormats);
    } catch (err) {
      // The engine marks errors only inside its processing/post-processing
      // stages; failures elsewhere (e.g. pre-processing) would otherwise
      // leave status.json stuck at "processing" forever.
      statusApi.markError(filePath, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  /**
   * List all available workflows along with the default workflow name.
   */
  public async listWorkflows(): Promise<{ workflows: Array<{ name: string; description?: string }>; defaultWorkflow: string }> {
    return this.getEngine().listWorkflows();
  }

  /**
   * Get full workflow config by name.
   */
  public async getWorkflowConfig(name: string): Promise<WorkflowDefinition> {
    return this.getEngine().getWorkflowConfig(name);
  }

  // ==========================================================================
  // Per-File Workflow Config
  // ==========================================================================

  /**
   * Load the per-file workflow config (*.workflow.json).
   */
  public async getFileWorkflowConfig(filePath: string): Promise<FileWorkflowConfig | null> {
    const absPath = this.resolveDataPath(filePath);
    return loadFileWorkflowConfig(absPath);
  }

  /**
   * Save (create/update) the per-file workflow config.
   */
  public async saveFileWorkflowConfig(filePath: string, config: FileWorkflowConfig): Promise<void> {
    const absPath = this.resolveDataPath(filePath);
    await saveFileWfConfig(absPath, config);
  }

  /**
   * Get the effective workflow for a file (base workflow merged with per-file overrides).
   */
  public async getEffectiveWorkflowConfig(filePath: string, workflowName?: string): Promise<WorkflowDefinition> {
    const absPath = this.resolveDataPath(filePath);
    return getEffectiveWorkflow(absPath, workflowName);
  }

  // ==========================================================================
  // Post-Processing Defaults
  // ==========================================================================

  /**
   * Get post-processing configuration defaults for a workflow.
   * Returns available plugins with descriptions.
   */
  public async getPostProcessingDefaults(
    workflowName: string,
  ): Promise<{
    plugins: Array<PostProcessingPluginDefinition>;
  }> {
    const workflow = this.getEngine().getWorkflowConfig(workflowName);

    return {
      plugins: (workflow.postProcessing ?? []).map((p) => ({
        name: p.name,
        description: p.description,
        enabled: p.enabled !== false,
        config: p.config,
        importPath: p.importPath,
        order: p.order,
      })),
    };
  }

  // ==========================================================================
  // Analysis Defaults & Single-Segment Analysis
  // ==========================================================================

  /**
   * Get the effective model + prompt defaults for a specific media segment type and file.
   * Also returns the list of compatible models for selection.
   */
  public async getAnalysisDefaults(
    filePath: string,
    mediaType: MediaSegmentType,
    workflowName?: string,
  ): Promise<{
    modelName: string;
    prompt: string;
    systemPrompt?: string;
    availableModels: Array<{ name: string; type: string; defaultPrompt?: string }>;
  }> {
    const absPath = this.resolveDataPath(filePath);
    const effective = await getEffectiveWorkflow(absPath, workflowName);

    // Find the processing step matching this media type. Matched regardless of
    // `enabled`: this endpoint feeds the per-event (re-)analyze modal — an
    // explicit user action — so default-disabled steps (e.g. keyframe, which is
    // opt-in for video/audio) must still serve their configured model/prompt.
    const step = effective.processing.find((s) => s.mediaType === mediaType);

    // Determine compatible models for this media type (config-driven)
    const availableModels = this.getCompatibleModels(mediaType);

    const modelName = step?.modelName ?? availableModels[0]?.name ?? "";

    // Prompt resolution: step config => model's defaultPrompt => ""
    let prompt = step?.prompt ?? "";
    if (!prompt && modelName) {
      try {
        const model = getModel(modelName);
        if (model.defaultPrompt !== undefined) {
          prompt = model.defaultPrompt;
        }
      } catch {
        // model not found - use empty
      }
    }

    return {
      modelName,
      prompt,
      systemPrompt: step?.systemPrompt,
      availableModels,
    };
  }

  /**
   * Get defaults for ALL processing steps at once (used by wizard tab bar).
   * Returns per-clip-type model/prompt/enabled state plus compatible models.
   * Prompt resolution: step.prompt => model.defaultPrompt => ""
   */
  public async getAllAnalysisDefaults(
    filePath: string,
    workflowName?: string,
  ): Promise<{
    steps: Array<{
      mediaType: MediaSegmentType;
      modelName: string;
      prompt: string;
      systemPrompt?: string;
      enabled: boolean;
      compatible: boolean;
      availableModels: Array<{ name: string; type: string; defaultPrompt?: string }>;
    }>;
  }> {
    const absPath = this.resolveDataPath(filePath);
    const effective = await getEffectiveWorkflow(absPath, workflowName);

    // Determine file media category to filter inapplicable steps
    const ext = filePath.substring(filePath.lastIndexOf('.'));
    const fileMedia = getFileTypeFromExtension(ext);

    const steps = effective.processing.map((step) => {
      const availableModels = this.getCompatibleModels(step.mediaType);

      // REFACTOR(dry): same prompt-resolution chain (step.prompt => model.defaultPrompt
      // => "") as getAnalysisDefaults above — extract a resolveStepPrompt(step) helper.
      // Resolve prompt: step config => model's defaultPrompt => ""
      let resolvedPrompt = step.prompt ?? "";
      if (!resolvedPrompt) {
        try {
          const model = getModel(step.modelName);
          if (model.defaultPrompt !== undefined) {
            resolvedPrompt = model.defaultPrompt;
          }
        } catch {
          // model not found - use empty
        }
      }

      // Auto-disable steps incompatible with the file's media type.
      // Keyframe analysis IS image analysis (single-image input is analyzed as
      // one keyframe), so keyframe applies to video+image; scene is video-only;
      // the audio family needs audio or video.
      let enabled = step.enabled !== false;
      if (step.mediaType === "keyframe" && fileMedia === "image") {
        // Keyframe steps are default-disabled in the shipped workflows (opt-in
        // for video/audio), but for single-image input keyframe analysis is the
        // ONLY analysis path — default it ON here. The engine mirrors this rule
        // (resolveEnabledProcessingSteps in workflow-engine.ts).
        enabled = true;
      } else if (enabled) {
        const needsVideo = step.mediaType === "scene";
        const needsVideoOrImage = step.mediaType === "keyframe";
        const needsAudioOrVideo = step.mediaType === "speech" || step.mediaType === "harmonic" || step.mediaType === "noise";
        if (needsVideo && fileMedia !== "video") enabled = false;
        if (needsVideoOrImage && fileMedia === "audio") enabled = false;
        if (needsAudioOrVideo && fileMedia === "image") enabled = false;
      }

      // UI-only compatibility flag (the upload wizard hides incompatible
      // modality tabs/panes entirely). Keyframe analysis IS image analysis,
      // so keyframe covers video+image; scene is video-only; the audio family
      // covers video+audio. Deliberately independent of the `enabled` logic
      // above, which keeps its historical semantics.
      let compatible: boolean;
      if (step.mediaType === "scene") compatible = fileMedia === "video";
      else if (step.mediaType === "keyframe") compatible = fileMedia === "video" || fileMedia === "image";
      else compatible = fileMedia === "video" || fileMedia === "audio"; // speech | harmonic | noise | silence

      return {
        mediaType: step.mediaType,
        modelName: step.modelName,
        prompt: resolvedPrompt,
        systemPrompt: step.systemPrompt,
        enabled,
        compatible,
        availableModels,
      };
    });

    return { steps };
  }

  /**
   * Analyze a single segment (audio/video/image) with a specific model and prompt.
   * Does NOT run pre-processing - segments must already exist.
   */
  public async analyzeSegment(
    filePath: string,
    mediaType: MediaSegmentType,
    modelName: string,
    prompt: string,
    systemPrompt?: string,
  ): Promise<string> {
    const model = getModel(modelName);

    // Tool-type models: delegate to shell scripts via configured toolName
    if (model.type === "tool" && model.toolName) {
      const scriptResult = await this.executeScript(model.toolName, [filePath]);
      const parsed = scriptResult.parsedResult;
      if (parsed?.text) return parsed.text;
      if (parsed?.transcription) return parsed.transcription;
      return scriptResult.stdout.trim();
    }

    // ASR-API models: Qwen3-ASR via /v1/chat/completions with audio_url
    if (model.type === "asr-api") {
      const mllmApi = new MllmApi();
      return (await mllmApi.transcribeQwen3Asr(
        model.resolvedEndpoint,
        [filePath],
        model.language,
        modelName,
        model.resolvedModel,
        model.resolvedApiKey,
      )).content;
    }

    // API-type models: OpenAI-compatible endpoint
    const mllmApi = new MllmApi();
    const mediaCategory = this.getMediaCategory(mediaType);
    const hyperparams = { ...model.hyperparams };

    return (await mllmApi.callWithPrompt(
      model.resolvedEndpoint,
      model.resolvedModel,
      model.resolvedApiKey,
      [filePath],
      prompt,
      mediaCategory,
      hyperparams,
      systemPrompt,
      model.enableThinking,
      model.mmProcessorKwargs,
      // jsonSchema/jsonSchemaMode/structured*/jsonSchemaName: unused here (prompt-only calls)
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      model.resolvedRepetitionDetection,
    )).content;
  }

  /**
   * List all configured models (name + type, no secrets).
   */
  public async listModels(): Promise<Array<{ name: string; type: string }>> {
    const config = getArchivarConfig();
    return (config.models ?? []).map((m) => ({ name: m.name, type: m.type ?? "api" }));
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  /**
   * Resolve a client-supplied relative path against the data directory.
   */
  // REFACTOR(consistency): no basename()/startsWith containment here, unlike
  // FileApi (clearFileCache/deleteFile/readFile) and file-upload-api.ts — an
  // absolute or "../" path escapes the data dir for the RPC-exposed config and
  // defaults methods above.
  private resolveDataPath(filePath: string): string {
    const sampleDataSubDir = getEnv('SAMPLE_DATA_SUBDIR', 'sample_data/archivar');
    const relativeSampleDataPath = getEnv('RELATIVE_SAMPLE_DATA_PATH', `../${sampleDataSubDir}`);
    const dataDir = resolve(process.cwd(), relativeSampleDataPath);
    return resolve(dataDir, filePath);
  }

  private getCompatibleModelTypes(mediaType: MediaSegmentType): string[] {
    switch (mediaType) {
      case "speech":
      case "harmonic":
      case "noise":
      case "silence":
        return ["asr-api", "tool", "api"];
      case "scene":
        return ["api"];
      case "keyframe":
        return ["api"];
      default:
        return ["api"];
    }
  }

  /**
   * Get all models compatible with a given media type.
   * Uses ModelConfig.compatibleMediaTypes when set, falls back to type-based inference.
   */
  public getCompatibleModels(mediaType: MediaSegmentType): Array<{ name: string; type: string; defaultPrompt?: string }> {
    const config = getArchivarConfig();
    const fallbackTypes = this.getCompatibleModelTypes(mediaType);
    return (config.models ?? [])
      .filter((m) => {
        if (m.compatibleMediaTypes && m.compatibleMediaTypes.length > 0) {
          return m.compatibleMediaTypes.includes(mediaType);
        }
        return fallbackTypes.includes(m.type ?? "api");
      })
      .map((m) => ({ name: m.name, type: m.type ?? "api", defaultPrompt: m.defaultPrompt }));
  }

  private getMediaCategory(mediaType: MediaSegmentType): "audio" | "video" | "image" {
    switch (mediaType) {
      case "scene":
        return "video";
      case "keyframe":
        return "image";
      default:
        return "audio";
    }
  }
}
