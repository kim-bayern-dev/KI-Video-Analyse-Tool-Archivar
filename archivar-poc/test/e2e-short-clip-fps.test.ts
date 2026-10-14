/**
 * E2E test for the short-clip fps rule (no mocks).
 *
 * C4_67_meme_gesture_truncated.mp4's single scene is ~1.9 s long — shorter
 * than the configured shortClipMaxLengthSec (5 s in archivar.config.ts). With
 * visualCaptionFrequency 0.5 the base fps is 0.5, but the rule must raise
 * this clip to shortClipMinFps (1 fps) — per individual clip, not per file.
 *
 * Verifies both sides end-to-end against a forced fresh analysis:
 *  1. physical: the segment-scenes CLI args carry the floored re-encode fps
 *     (--fps 1, not 0.5), so the clip file actually contains the frames
 *  2. inference: the scene caption request carries
 *     media_io_kwargs.video.fps = 1 (the only frame-sampling knob the server
 *     honors — mm_processor_kwargs.fps is inert there)
 *
 * Requires the app (container on localhost:8802 by default; dev server on
 * 8801 via SERVER_URL) and the default-analysis workflow models healthy.
 * Skips otherwise (or SKIP_LIVE_TESTS=1).
 */

import { describe, expect, it, beforeAll } from "vitest";
import { DSON } from "defuss-dson";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getWorkflowModels, isModelHealthy, isServerUp } from "./utils/live-models.js";

const SERVER = process.env.E2E_SERVER ?? process.env.SERVER_URL ?? "http://localhost:8802";
const API_KEY = process.env.API_KEY ?? "your-api-key";
const DATA_DIR = process.env.ARCHIVAR_DATA_DIR ?? "../sample_data/archivar";
const FILE = "C4_67_meme_gesture_truncated.mp4";
const ARCHIVAR_DIR = join(resolve(DATA_DIR), `${FILE}.archivar`);

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

const serverUp = await isServerUp(SERVER);
const workflowModels = await getWorkflowModels("default-analysis");
const workflowModelNames = [workflowModels.scene, workflowModels.speech].filter((name): name is string => !!name);
const modelsHealthy = (await Promise.all(workflowModelNames.map((name) => isModelHealthy(name)))).every(Boolean);
const suiteReady = serverUp && modelsHealthy;

describe.skipIf(!suiteReady)("e2e: short-clip fps rule (live)", () => {
    beforeAll(async () => {
        // Forced fresh analysis: clears pre-processing outputs (physical clip
        // fps) and all per-segment caches (caption request) for this run.
        await rpcCall("AnalyseApi", "runWorkflow", [FILE, undefined, "json", undefined, undefined, true, undefined, undefined]);
    }, 600_000);

    it("scene clip is shorter than the threshold, so the rule applies", () => {
        const debugJson = JSON.parse(readFileSync(join(ARCHIVAR_DIR, "debug.json"), "utf-8"));
        const scene = debugJson.scenes[0];
        const durationSec = scene.endTime - scene.startTime;
        expect(durationSec, `scene duration ${durationSec}s must be < 5s for this test to be meaningful`).toBeLessThan(5);
    });

    it("physical side: segment-scenes ran with the floored re-encode fps (--fps 1)", () => {
        const log = readFileSync(join(ARCHIVAR_DIR, "debug.log"), "utf-8");
        expect(log).toMatch(/Running scene segmentation \(cliArgs: [^)]*--fps 1[ \)]/);
    });

    it("inference side: the scene caption request carries media_io_kwargs.video.fps = 1", () => {
        const log = readFileSync(join(ARCHIVAR_DIR, "debug.log"), "utf-8");
        expect(log).toMatch(/"media_io_kwargs":\s*\{\s*"video":\s*\{\s*"fps":\s*1\s*\}/);
    });
});
