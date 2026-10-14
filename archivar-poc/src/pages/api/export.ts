/**
 * GET /api/export?file=string&format=docx|md|json|raw|log|srt|vct&force=1&view=filtered
 *
 * Generates (or reuses) an export file for an analysis result and streams it
 * as a download. Exports live in <file>.archivar/exports/ on disk.
 *
 * With view=filtered (used by the dashboard download links) docx/md/json are
 * rendered from the reduced result view (summary + higherOrderAggregations
 * only, see src/lib/result-view.ts). Default behavior is unchanged.
 *
 * Response: the file content with the format's Content-Type and
 * Content-Disposition: attachment.
 */

import type { APIRoute } from "astro";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { exportFile, resolveExportPath, EXPORT_FORMATS, type ExportFormat } from "../../rpc/export.js";

// Unlike its sibling routes (which proxy to ANALYZE_API_SERVER via
// longFetch+DSON), this route runs the export logic IN-PROCESS and reads the
// result from the local filesystem — deliberate, to stream file bytes without
// a DSON round-trip, at the cost of coupling the web process to the analysis
// server's filesystem.
// REFACTOR(consistency): diverges from the thin-RPC-proxy pattern of the
// other /api/* routes documented in src/pages/_ARCH.md; breaks as soon as
// web and analysis processes no longer share a filesystem.
export const prerender = false;

const CONTENT_DISPOSITION_EXT: Record<ExportFormat, string> = {
    docx: "docx",
    md: "md",
    json: "json",
    raw: "raw.json",
    log: "log",
    srt: "srt",
    vct: "vct.md",
    errors: "errors.json",
    "vlm-requests": "vlm-requests.json",
    "asr-requests": "asr-requests.json",
};

export const GET: APIRoute = async ({ request }) => {
    const url = new URL(request.url);
    const file = url.searchParams.get("file");
    const format = url.searchParams.get("format") as ExportFormat | null;
    const force = url.searchParams.get("force") === "1" || url.searchParams.get("force") === "true";
    const filtered = url.searchParams.get("view") === "filtered";

    if (!file) {
        return new Response(JSON.stringify({ error: "missing required parameter: file" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
        });
    }
    if (!format || !EXPORT_FORMATS.includes(format)) {
        return new Response(JSON.stringify({ error: `missing or invalid parameter: format (valid: ${EXPORT_FORMATS.join(", ")})` }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
        });
    }

    try {
        const info = await exportFile(file, format, force, filtered);
        const content = readFileSync(resolveExportPath(file, format, filtered));
        return new Response(content, {
            status: 200,
            headers: {
                "Content-Type": info.mimeType,
                "Content-Length": String(content.length),
                "Content-Disposition": `attachment; filename="${basename(file)}.${CONTENT_DISPOSITION_EXT[format]}"`,
            },
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const status = message.includes("No analysis") || message.includes("Missing debug") ? 404 : 500;
        return new Response(JSON.stringify({ error: message }), {
            status,
            headers: { "Content-Type": "application/json" },
        });
    }
};
