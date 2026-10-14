/**
 * E2E test for the export feature (no mocks).
 *
 * Requires the app (container on localhost:8802 by default; dev server on
 * 8801 via SERVER_URL) and the default workflow's models healthy (the
 * beforeAll runs a real analysis of demo.mp4; cached runs are fast). Skips
 * only when the server is unreachable or the required models are unhealthy
 * (or SKIP_LIVE_TESTS=1).
 *
 * Verification is plausibility-only per feature decision: size, mime type and
 * format magic bytes — not content correctness of the exports.
 */

import { describe, expect, it, beforeAll } from "vitest";
import { DSON } from "defuss-dson";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { getWorkflowModels, isModelHealthy, isServerUp } from "./utils/live-models.js";

const SERVER = process.env.E2E_SERVER ?? process.env.SERVER_URL ?? "http://localhost:8802";
const API_KEY = process.env.API_KEY ?? "your-api-key";
const DATA_DIR = process.env.ARCHIVAR_DATA_DIR ?? "../sample_data/archivar";
const FILE = "demo.mp4";
const FORMATS = ["docx", "md", "json", "raw", "log", "srt", "vct"] as const;
type Format = (typeof FORMATS)[number];

const EXPECTED_MIME: Record<Format, string> = {
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    md: "text/markdown",
    json: "application/json",
    raw: "application/json",
    log: "text/plain",
    srt: "application/x-subrip",
    vct: "text/markdown",
};

const rpcCall = async (className: string, methodName: string, args: unknown[]): Promise<unknown> => {
    const response = await fetch(`${SERVER}/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
        body: DSON.stringify({ className, methodName, args }),
        signal: AbortSignal.timeout(600_000),
    });
    if (!response.ok) throw new Error(`RPC ${className}.${methodName} failed: ${response.status}`);
    return DSON.parse(await response.text());
};

// Gate: server reachable + the CURRENT default-analysis workflow models healthy
// (model names resolved from the real archivar config, not hard-coded)
const serverUp = await isServerUp(SERVER);
const workflowModels = await getWorkflowModels("default-analysis");
const workflowModelNames = [workflowModels.scene, workflowModels.speech].filter((name): name is string => !!name);
const modelsHealthy = (await Promise.all(workflowModelNames.map((name) => isModelHealthy(name)))).every(Boolean);
const suiteReady = serverUp && modelsHealthy;

describe.skipIf(!suiteReady)("e2e: export feature (live)", () => {
    beforeAll(async () => {
        // Ensure demo.mp4 has a completed analysis (blocking RPC; cached runs return fast)
        await rpcCall("AnalyseApi", "runWorkflow", [FILE, undefined, "json", undefined, undefined, false, undefined, undefined]);
    }, 300_000);

    it("ExportApi.export generates all 4 formats with plausible size and mime type", async () => {
        const result = (await rpcCall("ExportApi", "export", [FILE, [...FORMATS], true])) as Record<
            Format,
            { path: string; size: number; mimeType: string }
        >;

        for (const format of FORMATS) {
            const info = result[format];
            expect(info, `missing export info for ${format}`).toBeDefined();
            expect(info.mimeType).toBe(EXPECTED_MIME[format]);
            expect(info.path).toBe(`${FILE}.archivar/exports/result.${format === "log" ? "log" : format === "raw" ? "raw.json" : format === "vct" ? "vct.md" : format}`);
            // srt/vct may be tiny (a few caption lines); enforce non-empty rather
            // than a byte floor, and validate structure in the content block below.
            const minSize = format === "docx" ? 5_000 : format === "srt" || format === "vct" ? 1 : 500;
            expect(info.size, `${format} size too small`).toBeGreaterThan(minSize);

            // File exists on disk at the referenced path
            const absPath = resolve(DATA_DIR, info.path);
            expect(existsSync(absPath), `${absPath} missing on disk`).toBe(true);
            expect(statSync(absPath).size).toBe(info.size);
        }
    }, 120_000);

    it("GET /api/export streams each format with the right content type and magic", async () => {
        for (const format of FORMATS) {
            const response = await fetch(`${SERVER}/api/export?file=${encodeURIComponent(FILE)}&format=${format}`, {
                signal: AbortSignal.timeout(120_000),
            });
            expect(response.status, `${format} status`).toBe(200);
            expect(response.headers.get("Content-Type")).toContain(EXPECTED_MIME[format]);
            expect(response.headers.get("Content-Disposition")).toContain("attachment");

            const buffer = Buffer.from(await response.arrayBuffer());
            // srt/vct may be small (a few caption lines); enforce non-empty rather
            // than a byte floor — structure is validated in the format block below.
            const minSize = format === "srt" || format === "vct" ? 1 : 500;
            expect(buffer.length, `${format} response too small`).toBeGreaterThan(minSize);

            if (format === "docx") {
                // zip/docx magic: PK\x03\x04
                expect(buffer[0]).toBe(0x50);
                expect(buffer[1]).toBe(0x4b);
                expect(buffer[2]).toBe(0x03);
                expect(buffer[3]).toBe(0x04);
            } else if (format === "json") {
                // `json` is the curated Download view (toJsonDownload + provenance),
                // NOT the verbatim debug.json. It carries models/fileName/summary fields.
                const parsed = JSON.parse(buffer.toString("utf-8"));
                expect(parsed.fileName).toBeDefined();
                expect(parsed.models).toBeDefined();
                // Curated view is strictly smaller than the raw debug.json.
                const debugJsonSize = statSync(join(resolve(DATA_DIR), `${FILE}.archivar`, "debug.json")).size;
                expect(buffer.length).toBeLessThan(debugJsonSize);
            } else if (format === "raw") {
                // `raw` is the verbatim AnalysisResult (debug.json).
                const debugJsonPath = join(resolve(DATA_DIR), `${FILE}.archivar`, "debug.json");
                const debugJson = JSON.parse(readFileSync(debugJsonPath, "utf-8"));
                const parsed = JSON.parse(buffer.toString("utf-8"));
                expect(parsed.scenes ?? parsed.fileName).toBeDefined();
                expect(parsed).toEqual(debugJson);
            } else if (format === "md") {
                expect(buffer.toString("utf-8").trimStart().startsWith("#")).toBe(true);
            } else if (format === "log") {
                expect(buffer.toString("utf-8").length).toBeGreaterThan(0);
            } else if (format === "srt") {
                // SRT built from the per-clip ASR speech timings. When the source
                // has no speech the file is empty — only assert structure otherwise.
                const text = buffer.toString("utf-8");
                if (text.trim() !== "") {
                    expect(text.startsWith("1\n")).toBe(true);
                    expect(text).toMatch(/\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}/);
                }
            } else if (format === "vct") {
                // VCT = Vision Caption Transcript (SRT structure + Markdown scene
                // captions). When the source has no vision captions the file is
                // empty — only assert structure otherwise.
                const text = buffer.toString("utf-8");
                if (text.trim() !== "") {
                    expect(text.startsWith("1\n")).toBe(true);
                    expect(text).toMatch(/\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}/);
                }
            }
        }
    }, 300_000);

    it("POST /api/analyze with exports generates files referenced by the poll response", async () => {
        // Remove existing exports first: the engine must regenerate them eagerly
        // on the cache-hit completion path, otherwise the poll response has none.
        rmSync(join(resolve(DATA_DIR), `${FILE}.archivar`, "exports"), { recursive: true, force: true });

        const response = await fetch(`${SERVER}/api/analyze`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            // md + json are cheap; cache-hit path still triggers export generation
            body: JSON.stringify({ file: FILE, exports: ["md", "json"] }),
            signal: AbortSignal.timeout(600_000),
        });
        expect(response.status).toBe(200);

        // /api/analyze blocks until the workflow completes; the poll should be done
        const rawResponse = await fetch(`${SERVER}/api/raw?file=${encodeURIComponent(FILE)}`, {
            signal: AbortSignal.timeout(30_000),
        });
        expect(rawResponse.status).toBe(200);
        const raw = (await rawResponse.json()) as {
            status: string;
            exports?: Record<string, { path: string; size: number; mimeType: string }>;
        };
        expect(raw.status).toBe("done");
        expect(raw.exports?.md, "exports.md missing in poll response").toBeDefined();
        expect(raw.exports?.json, "exports.json missing in poll response").toBeDefined();

        for (const format of ["md", "json"] as const) {
            const absPath = resolve(DATA_DIR, raw.exports![format].path);
            expect(existsSync(absPath), `${absPath} missing on disk`).toBe(true);
        }
    }, 600_000);
});
