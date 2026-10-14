/**
 * Unit tests for the export builders (markdown + docx) in src/rpc/export.ts.
 * No mocks needed: builders are pure functions over the AllResultsModel.
 */

import { describe, expect, it } from "vitest";
import {
    buildAllResultsDocx,
    buildAllResultsMarkdown,
    sortAllResultsEvents,
    visibleEvents,
    type AllResultsModel,
} from "../src/rpc/export";

const model: AllResultsModel = {
    summary: {
        title: "Demo Analysis",
        short_description: "A short description",
        long_summary: "This is **bold** and *italic*.\n\n- point one\n- point two\n\n| A | B |\n|---|---|\n| 1 | 2 |",
        keywords: ["demo", "test"],
    },
    higherOrderAggregations: [
        { index: 0, title: "Intro section", description: "Covers the *intro* part." },
    ],
    events: sortAllResultsEvents([
        { timeMs: 10_000, startMs: 10_000, endMs: 30_000, type: "scene", caption: "A scene caption." },
        { timeMs: 10_000, startMs: 10_000, endMs: 20_000, type: "semanticAggregation", caption: "An aggregation summary." },
        { timeMs: 5_000, startMs: 5_000, endMs: 7_000, type: "speech", caption: "" }, // hidden in UI
        { timeMs: 5_000, startMs: 5_000, endMs: 6_000, type: "sceneKeyframe", caption: "A keyframe caption." },
    ]),
    metadata: {
        fileName: "demo.mp4",
        workflow: "default-analysis",
        vlmModel: "Qwen3.8-27B-FP8",
        asrModel: "qwen-asr-1.7b",
    },
};

describe("sortAllResultsEvents", () => {
    it("sorts by rounded seconds, aggregations before clips at equal seconds", () => {
        const sorted = model.events;
        // stable within equal seconds (input order), aggregations jump before clips
        expect(sorted.map((e) => e.type)).toEqual(["speech", "sceneKeyframe", "semanticAggregation", "scene"]);
    });
});

describe("visibleEvents", () => {
    it("drops events without captions (mirrors the hidden CSS class in the UI)", () => {
        expect(visibleEvents(model.events).map((e) => e.type)).toEqual(["sceneKeyframe", "semanticAggregation", "scene"]);
    });
});

describe("buildAllResultsMarkdown", () => {
    const md = buildAllResultsMarkdown(model);

    it("renders the summary block", () => {
        expect(md).toContain("# Demo Analysis");
        expect(md).toContain("`demo` `test`");
        expect(md).toContain("## A short description");
        expect(md).toContain("## Chronological Summary");
        expect(md.indexOf("## Chronological Summary")).toBeLessThan(md.indexOf("This is **bold** and *italic*."));
    });

    it("renders higher-order aggregations", () => {
        expect(md).toContain("## Higher-Order Aggregations");
        expect(md).toContain("### 1. Intro section");
        expect(md).toContain("Covers the *intro* part.");
    });

    it("renders only visible events in UI order with mm:ss times and duration", () => {
        expect(md).toContain("## Events");
        expect(md).toContain("### 2. [00:05] Image — 🖼️ Scene Keyframe (00:01)");
        expect(md).toContain("### 3. [00:10] Semantic Analysis — ∑ Aggregation (00:10)");
        expect(md).toContain("### 4. [00:10] Video — 🎨 Scene (00:20)");
        expect(md).not.toContain("Speech");
        // aggregation header must appear before the scene header (branch before leaf)
        expect(md.indexOf("Semantic Analysis")).toBeLessThan(md.indexOf("Video — 🎨 Scene"));
    });
});

describe("buildAllResultsDocx", () => {
    it("produces a valid docx (zip) buffer of plausible size", async () => {
        const buffer = await buildAllResultsDocx(model, "demo.mp4");
        expect(Buffer.isBuffer(buffer)).toBe(true);
        // docx files are zip archives: PK\x03\x04 magic bytes
        expect(buffer[0]).toBe(0x50); // P
        expect(buffer[1]).toBe(0x4b); // K
        expect(buffer[2]).toBe(0x03);
        expect(buffer[3]).toBe(0x04);
        expect(buffer.length).toBeGreaterThan(1000);
    });
});
