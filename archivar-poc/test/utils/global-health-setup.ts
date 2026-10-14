/**
 * Vitest globalSetup: runs the real model health checks ONCE per `vitest run`
 * and caches the report to node_modules/.cache/archivar-health.json. Test files
 * read the cache via test/utils/live-models.ts — live tests skip only when
 * their model is unhealthy (or the test is not applicable), never because of
 * an env flag.
 */
import { load, getEnv } from "defuss-env";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// node_modules/.cache is outside Vite's watched tree — writing the cache here
// cannot invalidate the dev server's module runner mid-request.
export const HEALTH_CACHE_PATH = join(__dirname, "..", "..", "node_modules", ".cache", "archivar-health.json");

export default async function setup(): Promise<void> {
    load(getEnv("ENV_FILE", ".env.local"));
    await import("../../archivar.config.js");
    const { runModelHealthChecks } = await import("../../src/lib/model-health.js");

    const report = await runModelHealthChecks();
    const okCount = Object.values(report.checks).filter((c) => c.ok).length;
    const total = Object.keys(report.checks).length;
    console.log(`[global-health-setup] model health: ${okCount}/${total} ok (status: ${report.status})`);

    mkdirSync(dirname(HEALTH_CACHE_PATH), { recursive: true });
    writeFileSync(HEALTH_CACHE_PATH, JSON.stringify({ at: new Date().toISOString(), ...report }, null, 2), "utf-8");
}
