/**
 * GET /api/raw?file=string
 *
 * Fetches the raw JSON status/output.
 *
 * Response:
 * { status: "processing"; file: "..." }  // Processing state
 * { status: "done"; file: "..."; result: {...} }  // Done state
 * { status: "error"; file: "..."; error: "..." }  // Error state
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

    // First, get status via StatusApi.getStatus
    const statusResponse = await longFetch(`${server}/rpc`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: DSON.stringify({ className: "StatusApi", methodName: "getStatus", args: [file] }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!statusResponse.ok) {
      const errorText = await statusResponse.text().catch(() => "");
      console.error(`[api/raw] StatusApi RPC failed: ${statusResponse.status} ${errorText}`);
      return new Response(JSON.stringify({ error: `StatusApi RPC failed: ${statusResponse.statusText}` }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const statusData = DSON.parse(await statusResponse.text());

    // REFACTOR(kiss): `statusData === null` is already covered by
    // `!statusData` — the second disjunct is dead.
    if (!statusData || statusData === null) {
      // No status file exists
      return new Response(JSON.stringify(null), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const status = statusData as { status: string; error?: string };

    if (status.status === "processing") {
      return new Response(JSON.stringify({
        status: "processing",
        file,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (status.status === "error") {
      return new Response(JSON.stringify({
        status: "error",
        file,
        error: status.error ?? "Unknown error",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (status.status === "done") {
      // List export files (if any were generated for this file).
      // Best-effort: any failure (RPC down, parse error) just omits the
      // `exports` field — the `result` payload below is the critical part.
      const listExports = async (): Promise<unknown> => {
        try {
          const exportsResponse = await longFetch(`${server}/rpc`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": apiKey,
            },
            body: DSON.stringify({ className: "ExportApi", methodName: "list", args: [file] }),
            signal: AbortSignal.timeout(30_000),
          });
          if (!exportsResponse.ok) return null;
          const exports = DSON.parse(await exportsResponse.text());
          return exports && Object.keys(exports).length > 0 ? exports : null;
        } catch {
          return null;
        }
      };
      const exports = await listExports();

      // Read debug.json for the result
      const debugPath = `${file}.archivar/debug.json`;
      const debugResponse = await longFetch(`${server}/rpc`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        },
        body: DSON.stringify({ className: "FileApi", methodName: "readFile", args: [debugPath] }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!debugResponse.ok) {
        // debug.json not found is okay - return without result
        return new Response(JSON.stringify({
          status: "done",
          file,
          result: null,
          ...(exports ? { exports } : {}),
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      const debugData = DSON.parse(await debugResponse.text());

      return new Response(JSON.stringify({
        status: "done",
        file,
        result: debugData,
        ...(exports ? { exports } : {}),
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Unknown status
    return new Response(JSON.stringify({
      status: "unknown",
      file,
      rawStatus: status,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error(`[api/raw] error:`, err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
