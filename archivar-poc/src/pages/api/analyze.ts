/**
 * POST /api/analyze
 *
 * Triggers analysis workflow via HTTP POST.
 * Accepts the same parameters as the CLI analyze command plus webHookUrl.
 *
 * Request body:
 * {
 *   file: string;           // Required: file path to analyze
 *   workflow?: string;       // Optional: workflow name
 *   force?: boolean;         // Optional: bypass cache
 *   webHookUrl?: string;    // Optional: URL to call when done
 *   format?: OutputFormat;
 *   only?: string;
 *   overrides?: ...;
 *   postProcessingOverrides?: ...;
 *   exports?: Array<"docx"|"md"|"json"|"log"|"srt"|"vct">;  // Optional: export formats to generate on completion
 * }
 *
 * Response:
 * { ok: true; file: string; status: "processing" | "done" }
 */

import type { APIRoute } from "astro";
import { DSON } from "defuss-dson";
import { longFetch } from "../../lib/long-fetch.js";
import { getEnv } from "defuss-env";
import { OutputFormat } from "../../lib/workflow-types.js";

export const prerender = false;

interface AnalyzeRequest {
  file: string;
  workflow?: string;
  force?: boolean;
  webHookUrl?: string;
  format?: OutputFormat;
  only?: string;
  overrides?: Record<string, unknown>;
  postProcessingOverrides?: Record<string, unknown>;
  exports?: Array<"docx" | "md" | "json" | "log" | "srt" | "vct">;
}

export const POST: APIRoute = async ({ request }) => {
  // REFACTOR(dry): this env lookup + x-api-key header + DSON/longFetch RPC
  // envelope is copy-pasted across all six REST wrappers (api/analyze.ts,
  // api/list.ts, api/logs.ts, api/raw.ts, api/status.ts, api/clear-cache.ts)
  // — extract one shared callRpc(className, methodName, args) helper.
  const server = getEnv("ANALYZE_API_SERVER", "http://localhost:8801");
  const apiKey = getEnv("API_KEY", "your-api-key");

  try {
    const body = await request.json() as AnalyzeRequest;

    if (!body.file) {
      return new Response(JSON.stringify({ error: "missing required parameter: file" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Positional args for AnalyseApi.runWorkflow — order/arity MUST match its
    // signature (src/rpc/analyse-api.ts:138); a mismatch only fails at
    // runtime. REFACTOR(dry): the same positional array is built in
    // src/cli.ts:409 — a shared builder would keep the two from drifting.
    const args: unknown[] = [
      body.file,
      body.workflow ?? undefined,
      body.format ?? "json",
      body.overrides ?? undefined,
      body.postProcessingOverrides ?? undefined,
      body.force ?? false,
      body.only ?? undefined,
      body.webHookUrl ?? undefined,
      body.exports ?? undefined,
    ];

    // Call RPC via longFetch (same as CLI)
    const url = `${server}/rpc`;
    const response = await longFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: DSON.stringify({ className: "AnalyseApi", methodName: "runWorkflow", args }),
      // REFACTOR(magic): 43_200_000 duplicates LONG_TIMEOUT_MS in
      // src/lib/long-fetch.ts — import the named constant.
      signal: AbortSignal.timeout(43_200_000), // 12h timeout for long workflows
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      console.error(`[api/analyze] RPC failed: ${response.status} ${response.statusText} ${errorText}`);
      return new Response(JSON.stringify({ error: `RPC failed: ${response.statusText}` }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    // NOTE: this does NOT return immediately — the awaited RPC above only
    // resolves when runWorkflow finishes (or the 12h AbortSignal fires), so
    // by the time this response is sent the workflow has already completed
    // (failures take the error branches). Completion can also be polled via
    // GET /api/raw?file=...
    // REFACTOR(consistency): reports status:"processing" when the run has in
    // fact already finished — either make the call fire-and-forget (return
    // before awaiting, as the old comment claimed) or report the real
    // terminal status.
    return new Response(JSON.stringify({
      ok: true,
      file: body.file,
      status: "processing",
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error(`[api/analyze] error:`, err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
