/**
 * HealthApi - RPC facade for config validation and model health checks.
 *
 * - validateConfig(): structural validation of the loaded archivar config
 *   (workflows, model references, plugin import paths) + config inventory.
 * - checkModels(): runs the real per-model inference health checks shared
 *   with the /health endpoint (src/lib/model-health.ts).
 */

import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getArchivarConfig, getModel } from "../lib/archivar-config.js";
import { runModelHealthChecks, type ModelHealthCheck } from "../lib/model-health.js";
import type { ArchivarConfig, ModelConfig, WorkflowDefinition } from "../lib/workflow-types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..", "..");

export interface ModelInventoryItem {
    name: string;
    type?: string;
    endpoint?: string;
    model?: string;
    enabled: boolean;
    parallelism?: number;
}

export interface WorkflowInventoryItem {
    name: string;
    description?: string;
    stages: {
        preProcessing: boolean;
        processing: string[];
        postProcessing: string[];
    };
}

export interface ConfigValidation {
    ok: boolean;
    errors: string[];
    defaultWorkflow?: string;
    workflows: WorkflowInventoryItem[];
    models: ModelInventoryItem[];
}

export interface ModelHealthResult {
    status: "ok" | "degraded" | "error";
    checks: Record<string, ModelHealthCheck>;
    models: ModelInventoryItem[];
}

const toModelInventory = (m: ModelConfig): ModelInventoryItem => {
    // Resolve endpoint/model the same way runtime does (env:VAR + MODEL_CONFIG overrides)
    let endpoint = m.endpoint;
    let model = m.model;
    try {
        const resolved = getModel(m.name);
        endpoint = resolved.resolvedEndpoint || endpoint;
        model = resolved.resolvedModel || model;
    } catch {
        // keep raw values; resolution errors surface as validation errors
    }
    return {
        name: m.name,
        type: m.type,
        endpoint,
        model,
        enabled: m.enabled !== false,
        parallelism: m.parallelism,
    };
};

const toWorkflowInventory = (w: WorkflowDefinition): WorkflowInventoryItem => ({
    name: w.name,
    description: w.description,
    stages: {
        preProcessing: !!w.preProcessing,
        processing: (w.processing ?? []).map((step) => `${step.mediaType}:${step.modelName}`),
        postProcessing: (w.postProcessing ?? []).filter((p) => p.enabled !== false).map((p) => p.name),
    },
});

export class HealthApi {
    /** Configured model inventory with runtime-resolved endpoints/model names. */
    public async listModels(): Promise<ModelInventoryItem[]> {
        return (getArchivarConfig().models ?? []).map(toModelInventory);
    }

    /**
     * Validate the loaded archivar config and return its inventory.
     * Throws if the config cannot be loaded at all.
     */
    public async validateConfig(): Promise<ConfigValidation> {
        const config: ArchivarConfig = getArchivarConfig();
        const errors: string[] = [];

        const models = config.models ?? [];
        const workflows = config.workflows ?? [];
        const modelNames = new Set(models.map((m) => m.name));

        // Model entries: required fields per type (endpoint is resolved like runtime:
        // static config, env:VAR references and MODEL_CONFIG overrides all count)
        for (const model of models) {
            if (!model.name) errors.push("Model entry without a name");
            if (!model.type) errors.push(`Model "${model.name}": missing type (api|asr-api|tool)`);
            if (model.type === "api" || model.type === "asr-api") {
                let resolvedEndpoint = "";
                try {
                    resolvedEndpoint = getModel(model.name).resolvedEndpoint;
                } catch (err) {
                    errors.push(`Model "${model.name}": resolution failed: ${err instanceof Error ? err.message : String(err)}`);
                }
                if (!resolvedEndpoint) {
                    errors.push(`Model "${model.name}": type "${model.type}" requires an endpoint (static config, env:VAR, or MODEL_CONFIG)`);
                }
            }
            if (model.type === "tool" && !model.toolName) {
                errors.push(`Model "${model.name}": type "tool" requires a toolName`);
            }
        }

        // Default workflow resolves
        const defaultWorkflow = config.defaults?.workflow;
        if (defaultWorkflow && !workflows.some((w) => w.name === defaultWorkflow)) {
            errors.push(`Default workflow "${defaultWorkflow}" is not defined`);
        }

        // Workflow references: models exist, plugin import paths resolve
        for (const workflow of workflows) {
            if (!workflow.name) {
                errors.push("Workflow entry without a name");
                continue;
            }
            for (const step of workflow.processing ?? []) {
                if (!modelNames.has(step.modelName)) {
                    errors.push(`Workflow "${workflow.name}": processing step "${step.mediaType}" references unknown model "${step.modelName}"`);
                }
            }
            for (const plugin of workflow.postProcessing ?? []) {
                if (plugin.enabled === false) continue;
                if (plugin.importPath) {
                    const pluginPath = resolve(PROJECT_ROOT, plugin.importPath);
                    // importPath may name a TS source file or its compiled .js
                    // output — probe both spellings plus the extensionless path.
                    const candidates = [pluginPath, `${pluginPath}.ts`, `${pluginPath}.js`, pluginPath.replace(/\.js$/, ".ts")];
                    if (!candidates.some((candidate) => existsSync(candidate))) {
                        errors.push(`Workflow "${workflow.name}": plugin "${plugin.name}" importPath "${plugin.importPath}" does not resolve`);
                    }
                }
            }
        }

        return {
            ok: errors.length === 0,
            errors,
            defaultWorkflow,
            workflows: workflows.map(toWorkflowInventory),
            models: models.map(toModelInventory),
        };
    }

    /**
     * Run real inference health checks for every enabled model.
     * Same data as GET /health (shared implementation).
     */
    public async checkModels(): Promise<ModelHealthResult> {
        const { status, checks } = await runModelHealthChecks();
        const models = await this.listModels();
        return { status, checks, models };
    }
}
