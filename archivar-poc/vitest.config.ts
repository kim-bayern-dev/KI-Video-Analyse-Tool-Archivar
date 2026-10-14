import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 120_000, // RPC calls to MLLM can take a while
    // Loads .env.local before test modules so direct-import tests share the
    // server's env (endpoints, data-dir paths).
    setupFiles: ["test/setup-env.ts"],
    // Runs the real model health checks once per run
    // (node_modules/.cache/archivar-health.json); live tests gate on that
    // report via test/utils/live-models.ts.
    globalSetup: ["test/utils/global-health-setup.ts"],
  },
});
