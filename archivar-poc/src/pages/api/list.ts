/**
 * GET /api/list
 *
 * Lists all files in the data directory.
 *
 * Response:
 * Array<FileInfo>
 */

import type { APIRoute } from "astro";
import { DSON } from "defuss-dson";
import { longFetch } from "../../lib/long-fetch.js";
import { getEnv } from "defuss-env";

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const server = getEnv("ANALYZE_API_SERVER", "http://localhost:8801");
  const apiKey = getEnv("API_KEY", "your-api-key");

  try {
    const url = new URL(request.url);
    const pattern = url.searchParams.get("pattern") ?? "*";
    // Default: lightweight summary (selection-only fields, tens of KB). Pass
    // ?full=1 for the complete per-segment FileInfo[] (~70MB for large dirs).
    const full = url.searchParams.get("full") === "1";
    const methodName = full ? "listFiles" : "listFilesSummary";

    // Call FileApi.<methodName> via RPC
    const response = await longFetch(`${server}/rpc`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: DSON.stringify({ className: "FileApi", methodName, args: [pattern] }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      console.error(`[api/list] RPC failed: ${response.status} ${errorText}`);
      return new Response(JSON.stringify({ error: `RPC failed: ${response.statusText}` }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const data = DSON.parse(await response.text());

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error(`[api/list] error:`, err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
