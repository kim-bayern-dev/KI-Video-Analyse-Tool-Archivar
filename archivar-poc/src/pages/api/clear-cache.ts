/**
 * DELETE /api/clear-cache?file=string
 *
 * Clears cache and outputs for a file.
 *
 * Response:
 * { status: "cleared"; removed?: number }  // Success
 * null  // Not found
 */

import type { APIRoute } from "astro";
import { DSON } from "defuss-dson";
import { longFetch } from "../../lib/long-fetch.js";
import { getEnv } from "defuss-env";

export const prerender = false;

export const DELETE: APIRoute = async ({ request }) => {
  const server = getEnv("ANALYZE_API_SERVER", "http://localhost:8801");
  const apiKey = getEnv("API_KEY", "your-api-key");

  try {
    const url = new URL(request.url);
    const file = url.searchParams.get("file");

    if (!file) {
      return new Response(JSON.stringify({ error: "missing required parameter: file" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Call FileApi.clearFileCache via RPC
    const response = await longFetch(`${server}/rpc`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: DSON.stringify({ className: "FileApi", methodName: "clearFileCache", args: [file] }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      console.error(`[api/clear-cache] RPC failed: ${response.status} ${errorText}`);
      return new Response(JSON.stringify({ error: `RPC failed: ${response.statusText}` }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const data = DSON.parse(await response.text()) as { status: string; error?: string; removed?: number };

    // REFACTOR(consistency): string-sniffing the RPC error message to detect
    // "not found" couples this route to FileApi.clearFileCache's wording
    // (src/rpc/file-api.ts:309); api/export.ts:62 does the same with other
    // phrases. Prefer a structured error code in the RPC payload.
    if (data.status === "error" && data.error?.includes("not found")) {
      return new Response(JSON.stringify(null), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (data.status === "error") {
      return new Response(JSON.stringify({ error: data.error }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({
      status: "cleared",
      removed: data.removed ?? 0,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error(`[api/clear-cache] error:`, err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
