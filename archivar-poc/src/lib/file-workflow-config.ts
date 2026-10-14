/**
 * Per-file workflow overrides stored as a sidecar JSON next to the upload
 * (`<uploadFilePath>.workflow.json`).
 *
 * The dashboard writes these via AnalyseApi.saveFileWorkflowConfig (per-file
 * model/prompt overrides and post-processing plugin on/off); the workflow
 * engine reads them at run start (loadFileWorkflowConfig + mergeWithWorkflow)
 * so one upload can deviate from the shared workflow definition without
 * forking it. Pre-processing and everything not listed in FileWorkflowConfig
 * always comes from the base workflow.
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { FileWorkflowConfig, WorkflowDefinition, MediaSegmentType } from "./workflow-types.js";
import { getWorkflow, getArchivarConfig, resolveDefaultWorkflowName } from "./archivar-config.js";

/**
 * Get the path to the per-file workflow config for an upload file.
 * Convention: <uploadFilePath>.workflow.json
 */
export function getFileWorkflowConfigPath(uploadFilePath: string): string {
  return `${uploadFilePath}.workflow.json`;
}

/**
 * Load a per-file workflow config. Returns null if none exists.
 */
// REFACTOR(consistency): a corrupt sidecar (JSON parse failure) is swallowed
// into `null`, making "broken override" indistinguishable from "no override"
// and silently running the base workflow — elsewhere this codebase fails fast
// on invalid state. At minimum console.warn the path + error so the operator
// learns their override was ignored.
export async function loadFileWorkflowConfig(uploadFilePath: string): Promise<FileWorkflowConfig | null> {
  const configPath = getFileWorkflowConfigPath(uploadFilePath);
  if (!existsSync(configPath)) {
    return null;
  }
  try {
    const raw = await readFile(configPath, "utf-8");
    return JSON.parse(raw) as FileWorkflowConfig;
  } catch {
    return null;
  }
}

/**
 * Save a per-file workflow config.
 */
export async function saveFileWorkflowConfig(uploadFilePath: string, config: FileWorkflowConfig): Promise<void> {
  const configPath = getFileWorkflowConfigPath(uploadFilePath);
  await writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
}

/**
 * Merge a base WorkflowConfig with per-file overrides.
 * Overrides only processing-step model/prompt/systemPrompt and the `enabled`
 * flag of already-configured post-processing plugins — pre-processing, plugin
 * order, and all other settings remain those of the base workflow. A plugin
 * override naming a plugin that is not in the base workflow is ignored (the
 * sidecar can toggle, never add).
 */
export function mergeWithWorkflow(base: WorkflowDefinition, fileConfig: FileWorkflowConfig): WorkflowDefinition {
  const merged: WorkflowDefinition = {
    ...base,
  };

  // Merge processing step overrides
  if (fileConfig.overrides) {
    merged.processing = base.processing.map((step) => {
      const override = fileConfig.overrides?.[step.mediaType as MediaSegmentType];
      if (!override) return step;
      return {
        ...step,
        modelName: override.modelName ?? step.modelName,
        prompt: override.prompt !== undefined ? override.prompt : step.prompt,
        systemPrompt: override.systemPrompt !== undefined ? override.systemPrompt : step.systemPrompt,
      };
    });
  }

  // Merge post-processing overrides
  if (fileConfig.postProcessing) {
    if (fileConfig.postProcessing.plugins) {
      const basePlugins = [...(base.postProcessing ?? [])];
      for (const pluginOverride of fileConfig.postProcessing.plugins) {
        const idx = basePlugins.findIndex((p) => p.name === pluginOverride.name);
        if (idx >= 0) {
          basePlugins[idx] = { ...basePlugins[idx], enabled: pluginOverride.enabled };
        }
      }
      merged.postProcessing = basePlugins;
    }
  }

  return merged;
}

/**
 * Get the effective workflow for a file: base workflow merged with any per-file overrides.
 */
export async function getEffectiveWorkflow(
  uploadFilePath: string,
  workflowName?: string,
): Promise<WorkflowDefinition> {
  const config = getArchivarConfig();
  const wfName = workflowName ?? resolveDefaultWorkflowName(config);
  const base = getWorkflow(wfName);

  const fileConfig = await loadFileWorkflowConfig(uploadFilePath);
  if (!fileConfig) return base;

  return mergeWithWorkflow(base, fileConfig);
}
