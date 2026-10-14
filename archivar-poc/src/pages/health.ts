// Load env first, then archivar config (registers models, workflows, etc.)
import { load, getEnv } from "defuss-env";
import "../../archivar.config.js";
import { runModelHealthChecks } from "../lib/model-health";
import { HealthApi } from "../rpc/health-api";

// Default to the project's actual env file (.env.local); ENV_FILE still overrides.
load(getEnv("ENV_FILE", ".env.local"));

export const prerender = false;

/**
 * GET /health — deep readiness probe: runs a live check against every
 * configured model/tool and appends the configured model inventory as an
 * extra field (the { status, checks } response schema is unchanged).
 * 200 when the aggregate status is "ok", 503 for degraded/error.
 */
export const GET = async () => {
  const { status, checks } = await runModelHealthChecks();

  // Configured model inventory (extra field; the { status, checks } schema is unchanged)
  const models = await new HealthApi().listModels();

  return new Response(
    JSON.stringify({ status, checks, models }, null, 2),
    {
      status: status === "ok" ? 200 : 503,
      headers: { "Content-Type": "application/json" },
    },
  );
};
