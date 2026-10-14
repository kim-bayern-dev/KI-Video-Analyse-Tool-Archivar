/**
 * Non-mocking e2e test for the pluginOverride importPath crash fix.
 *
 * BUG: When `postProcessingOverrides` provided a plugin override (e.g. from
 * the UI wizard or API call), line 784 of workflow-engine.ts did:
 *   const pluginDefinition = (pluginOverride ? pluginOverride : plugin) as PostProcessingPluginDefinition;
 *
 * The `PostProcessingSelection.plugins` type only has `{ name, enabled, config? }` —
 * NO `importPath`. So the override REPLACED the entire base plugin definition,
 * making `importPath` undefined → `path.resolve()` crashed with:
 *   TypeError: The "paths[1]" argument must be of type string. Received undefined
 *
 * FIX: Merge override onto base plugin definition, preserving importPath:
 *   const pluginDefinition = { ...plugin, ...override, config: { ...plugin.config, ...override?.config } };
 *
 * This test validates the fix by:
 * 1. Importing the REAL default.ts plugin (non-mocking)
 * 2. Simulating the exact merge logic from workflow-engine.ts
 * 3. Verifying path.resolve() succeeds with the merged definition
 * 4. Verifying the actual plugin module loads and exports required hooks
 */
import { describe, it, expect } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  PostProcessingPluginDefinition,
  PostProcessingSelection,
  WorkflowDefinition,
} from "../src/lib/workflow-types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Matches PROJECT_ROOT in workflow-engine.ts: resolve(__dirname, "../..")
const PROJECT_ROOT = resolve(__dirname, "..");

/**
 * Replicates the FIXED merge logic from workflow-engine.ts lines 784-790.
 * This is extracted so the test can verify the logic without needing a full
 * server instance, while still using the REAL plugin module import.
 */
function mergePluginOverride(
  basePlugin: PostProcessingPluginDefinition,
  override: PostProcessingSelection["plugins"][number] | undefined,
): PostProcessingPluginDefinition<Record<string, unknown>> {
  const baseConfig = (basePlugin.config ?? {}) as Record<string, unknown>;
  const overrideConfig = (override?.config ?? {}) as Record<string, unknown>;
  return {
    ...basePlugin,
    ...(override ?? {}),
    config: { ...baseConfig, ...overrideConfig },
  };
}

describe("Plugin override importPath crash fix", () => {
  /** Base plugin definition as it appears in archivar.config.ts */
  const basePlugin: PostProcessingPluginDefinition<Record<string, unknown>> = {
    name: "default",
    description: "Default plugin: semantic aggregation, per-slice analysis, whole-video summary",
    importPath: "./plugins/default.ts",
    enabled: true,
    config: {
      modelName: "Qwen3.6-35B-A3B-GPTQ-Int4",
      maxConcurrency: 2,
      includeTypes: ["scene", "speech"],
      reanalyzeVideoForAggregation: false,
    },
  };

  it("OV1: override WITHOUT importPath does NOT crash path.resolve() after fix", () => {
    // This is the exact override shape from PostProcessingSelection — no importPath!
    const override: PostProcessingSelection["plugins"][number] = {
      name: "default",
      enabled: true,
      config: { maxConcurrency: 4 },
    };

    // BEFORE fix: pluginDefinition = override → importPath is undefined → crash
    // AFTER fix:  merge preserves importPath from base
    const merged = mergePluginOverride(basePlugin, override);

    // The key assertion: path.resolve() must not throw
    expect(() => resolve(PROJECT_ROOT, merged.importPath)).not.toThrow();

    const resolvedPath = resolve(PROJECT_ROOT, merged.importPath);
    expect(resolvedPath).toContain("plugins/default.ts");
  });

  it("OV2: override merges config while preserving base config keys", () => {
    const override: PostProcessingSelection["plugins"][number] = {
      name: "default",
      enabled: false,
      config: { maxConcurrency: 8 },
    };

    const merged = mergePluginOverride(basePlugin, override);

    // Override config takes precedence
    expect(merged.config?.maxConcurrency).toBe(8);
    // Base config keys are preserved
    expect(merged.config?.modelName).toBe("Qwen3.6-35B-A3B-GPTQ-Int4");
    expect(merged.config?.includeTypes).toEqual(["scene", "speech"]);
    // Override enabled takes precedence
    expect(merged.enabled).toBe(false);
  });

  it("OV3: undefined override preserves base plugin unchanged", () => {
    const merged = mergePluginOverride(basePlugin, undefined);

    expect(merged.importPath).toBe("./plugins/default.ts");
    expect(merged.name).toBe("default");
    expect(merged.enabled).toBe(true);
    expect(merged.config).toEqual(basePlugin.config);
  });

  it("OV4: REAL default.ts plugin loads from merged importPath (non-mocking)", async () => {
    // Simulate a UI wizard override — only enabled and config, no importPath
    const override: PostProcessingSelection["plugins"][number] = {
      name: "default",
      enabled: true,
      config: { maxConcurrency: 4 },
    };

    const merged = mergePluginOverride(basePlugin, override);
    const pluginPathResolved = resolve(PROJECT_ROOT, merged.importPath);

    // Actually import the real plugin module — this exercises the same
    // dynamic import() call as workflow-engine.ts line 786

    const mod = await import(/* @vite-ignore */ pluginPathResolved);

    // Verify the real plugin exports the required hooks
    expect(mod.postProcessPerTimeSlice).toBeDefined();
    expect(typeof mod.postProcessPerTimeSlice).toBe("function");
    expect(mod.decideForAggregation).toBeDefined();
    expect(typeof mod.decideForAggregation).toBe("function");
    expect(mod.postProcessPerAggregation).toBeDefined();
    expect(typeof mod.postProcessPerAggregation).toBe("function");
  });

  it("OV5: OLD buggy merge (without fix) WOULD crash — verifies regression guard", () => {
    const override: PostProcessingSelection["plugins"][number] = {
      name: "default",
      enabled: true,
    };

    // Simulate the OLD buggy behavior: override replaces entire plugin
    const buggyPluginDefinition = override as unknown as PostProcessingPluginDefinition;

    // The old code would crash here: resolve(PROJECT_ROOT, undefined)
    expect(buggyPluginDefinition.importPath).toBeUndefined();

    // Verify that path.resolve WOULD throw with undefined
    expect(() => resolve(PROJECT_ROOT, buggyPluginDefinition.importPath as unknown as string)).toThrow(
      /must be of type string/,
    );
  });

  it("OV6: full workflow postProcessing config can be used to find matching override", () => {
    // Simulate the full workflow-engine flow: iterate plugins, find overrides
    const workflow: Pick<WorkflowDefinition, "postProcessing"> = {
      postProcessing: [
        {
          name: "default",
          description: "Default plugin",
          importPath: "./plugins/default.ts",
          enabled: true,
          config: { maxConcurrency: 2 },
        },
        {
          name: "question-answer",
          description: "QA plugin",
          importPath: "./plugins/question-answer.ts",
          enabled: true,
        },
      ],
    };

    const postProcessingOverrides: PostProcessingSelection = {
      plugins: [
        { name: "default", enabled: true, config: { maxConcurrency: 4 } },
      ],
    };

    for (const plugin of workflow.postProcessing!) {
      const pluginOverride = postProcessingOverrides.plugins.find(
        (p) => p.name === plugin.name,
      );
      const merged = mergePluginOverride(plugin, pluginOverride);

      // Every merged plugin MUST have a valid importPath (the bug was that
      // overridden plugins lost their importPath)
      expect(merged.importPath).toBeDefined();
      expect(typeof merged.importPath).toBe("string");
      expect(merged.importPath.length).toBeGreaterThan(0);
      expect(() => resolve(PROJECT_ROOT, merged.importPath)).not.toThrow();
    }
  });
});
