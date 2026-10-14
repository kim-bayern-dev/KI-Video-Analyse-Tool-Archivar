/**
 * GET /api/logs?file=string
 *
 * Fetches the debug log content.
 *
 * Response:
 * { status: "processing"; data: "..." }  // Processing state
 * { status: "done"; data: "..." }      // Done state
 * null  // Not found
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
    const file = url.searchParams.get("file");

    if (!file) {
      return new Response(JSON.stringify({ error: "missing required parameter: file" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Get status first to know if processing or done
    const statusResponse = await longFetch(`${server}/rpc`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: DSON.stringify({ className: "StatusApi", methodName: "getStatus", args: [file] }),
      signal: AbortSignal.timeout(30_000),
    });

    let currentStatus = "processing";
    if (statusResponse.ok) {
      const statusData = DSON.parse(await statusResponse.text());
      if (statusData && typeof statusData === "object" && "status" in statusData) {
        currentStatus = (statusData as { status: string }).status;
      }
    }

    // Read debug.log
    const debugPath = `${file}.archivar/debug.log`;
    const logResponse = await longFetch(`${server}/rpc`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: DSON.stringify({ className: "FileApi", methodName: "readFile", args: [debugPath] }),
      signal: AbortSignal.timeout(30_000),
    });

    // REFACTOR(kiss): both branches below return the identical `null`
    // response, so the status===500 check (and its "not found" comment) is
    // dead — ANY readFile failure is reported as "no logs yet" either way.
    if (!logResponse.ok) {
      // File not found is okay - no logs yet
      if (logResponse.status === 500) {
        // Check if it's a "not found" error from the RPC
        return new Response(JSON.stringify(null), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(null), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const logData = DSON.parse(await logResponse.text());

    return new Response(JSON.stringify({
      status: currentStatus,
      data: logData ?? "",
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error(`[api/logs] error:`, err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
