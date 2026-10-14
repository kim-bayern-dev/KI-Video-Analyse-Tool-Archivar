/**
 * Shared, process-level cache for post-processing plugin modules.
 *
 * WHY: plugin modules were loaded via ad-hoc dynamic `import()` at three call
 * sites — including MID-WORKFLOW (post-processing step, after the long
 * processing stage). Under the Astro dev server every dynamic import routes
 * through the Vite module runner; when a file edit invalidates the module
 * graph mid-run, the runner is closed and the import throws
 * "Vite module runner has been closed", killing the run's post-processing
 * phase (observed repeatedly in practice).
 *
 * The cache removes the mid-run import entirely: modules are loaded ONCE per
 * process (eagerly at workflow start via [`preloadPluginModules()`]) and the
 * same promise is reused afterwards. A dev-server reload re-instantiates this
 * module too, so the cache never serves stale plugin code across reloads.
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { PostProcessingPluginModule } from "../../lib/plugin-types.js";
import type { PostProcessingPluginDefinition } from "../../lib/workflow-types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Repo root from src/rpc/post-processing/ (one level deeper than
// workflow-engine.ts, which uses "../.." from src/rpc/).
const PROJECT_ROOT = resolve(__dirname, "../../..");

const moduleCache = new Map<string, Promise<PostProcessingPluginModule>>();

/**
 * Load a plugin module by its configured importPath, cached per resolved path.
 * The returned promise is shared, so concurrent runs import once.
 */
export function loadPluginModule(importPath: string): Promise<PostProcessingPluginModule> {
  const resolved = resolve(PROJECT_ROOT, importPath);
  let cached = moduleCache.get(resolved);
  if (!cached) {
    cached = import(/* @vite-ignore */ resolved) as Promise<PostProcessingPluginModule>;
    // A failed import must not poison the cache — the next call retries.
    cached.catch(() => moduleCache.delete(resolved));
    moduleCache.set(resolved, cached);
  }
  return cached;
}

/**
 * Eagerly load all enabled plugins' modules (at workflow start, BEFORE the
 * long processing stage). Failures are logged and skipped — the post-processing
 * step surfaces them through its own error handling.
 */
export async function preloadPluginModules(defs: PostProcessingPluginDefinition[] | undefined): Promise<void> {
  for (const def of defs ?? []) {
    if (def.enabled === false || !def.importPath) continue;
    try {
      await loadPluginModule(def.importPath);
    } catch (err) {
      console.warn(`[plugin-module-loader] Preload failed for ${def.importPath}:`, err instanceof Error ? err.message : err);
    }
  }
}
