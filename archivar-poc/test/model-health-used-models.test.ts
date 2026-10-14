/**
 * Unit test for computeUsedModelNames (hermetic, no server, no LLM):
 * a health FAIL only counts for models referenced by a workflow —
 * unused models must be reported as SKIP.
 */

import { describe, expect, it } from "vitest";
import { computeUsedModelNames } from "../src/lib/model-health";
import type { ArchivarConfig } from "../src/lib/workflow-types";

const config = {
    auth: { users: [] },
    models: [
        { name: "used-vlm", type: "api" },
        { name: "used-asr", type: "asr-api" },
        { name: "used-by-plugin", type: "api" },
        { name: "unused-model", type: "api" },
    ],
    workflows: [
        {
            name: "wf-a",
            processing: [
                { mediaType: "scene", modelName: "used-vlm" },
                { mediaType: "speech", modelName: "used-asr" },
            ],
            postProcessing: [
                { name: "default", importPath: "./plugins/default.ts", config: { modelName: "used-by-plugin" } },
                { name: "no-model", importPath: "./plugins/other.ts", config: {} },
            ],
        },
    ],
} as unknown as ArchivarConfig;

describe("computeUsedModelNames", () => {
    it("collects models from processing steps and plugin configs", () => {
        const used = computeUsedModelNames(config);
        expect(used.has("used-vlm")).toBe(true);
        expect(used.has("used-asr")).toBe(true);
        expect(used.has("used-by-plugin")).toBe(true);
    });

    it("does not include unreferenced models", () => {
        const used = computeUsedModelNames(config);
        expect(used.has("unused-model")).toBe(false);
    });

    it("tolerates empty/missing workflow parts", () => {
        expect(computeUsedModelNames({ auth: { users: [] }, models: [] } as unknown as ArchivarConfig).size).toBe(0);
        expect(computeUsedModelNames({
            auth: { users: [] },
            workflows: [{ name: "bare", processing: [] }],
        } as unknown as ArchivarConfig).size).toBe(0);
    });
});
