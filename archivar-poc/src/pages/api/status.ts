/**
 * GET /api/status?status=processing|done|error
 *
 * Lists task statuses (one per analyzed file's .archivar/status.json),
 * newest first. Optional `status` query param filters by status;
 * omit it (or pass "all") to list every known task.
 *
 * Response:
 * { tasks: StatusFile[] }
 */

import type { APIRoute } from "astro";
import { DSON } from "defuss-dson";
import { longFetch } from "../../lib/long-fetch.js";
import { getEnv } from "defuss-env";

export const prerender = false;

// REFACTOR(dry): duplicates the status union of StatusFile
// (src/rpc/status-api.ts:33) — export a shared const from there instead.
const VALID_STATUSES = ["processing", "done", "error"];

export const GET: APIRoute = async ({ request }) => {
  const server = getEnv("ANALYZE_API_SERVER", "http://localhost:8801");
  const apiKey = getEnv("API_KEY", "your-api-key");

  try {
    const url = new URL(request.url);
    const statusParam = url.searchParams.get("status");

    if (statusParam && statusParam !== "all" && !VALID_STATUSES.includes(statusParam)) {
      return new Response(JSON.stringify({ error: `invalid status filter (valid: ${VALID_STATUSES.join(", ")}, all)` }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const filter = statusParam && statusParam !== "all" ? statusParam : undefined;

    const response = await longFetch(`${server}/rpc`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: DSON.stringify({ className: "StatusApi", methodName: "listStatuses", args: [filter] }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      console.error(`[api/status] StatusApi RPC failed: ${response.status} ${errorText}`);
      return new Response(JSON.stringify({ error: `StatusApi RPC failed: ${response.statusText}` }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const tasks = DSON.parse(await response.text());

    return new Response(JSON.stringify({ tasks }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error(`[api/status] error:`, err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
