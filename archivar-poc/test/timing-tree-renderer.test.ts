import { describe, it, expect } from "vitest";
import { renderTimingTree } from "../src/lib/timing-tree-renderer.js";
import type { TimingEntry } from "../src/lib/workflow-types.js";

describe("renderTimingTree", () => {
  it("renders simple entry with correct indentation", () => {
    const entry: TimingEntry = {
      label: "workflow:test",
      durationMs: 182340.5,
      children: [],
    };
    const output = renderTimingTree(entry);
    expect(output).toContain("workflow:test");
    expect(output).toContain("3.0min"); // 182340.5ms = 3.0min
  });

  it("renders complex nested tree with proper branching", () => {
    const entry: TimingEntry = {
      label: "workflow:full-analysis",
      durationMs: 182340.5,
      children: [
        {
          label: "preProcessing",
          durationMs: 12400.2,
          children: [
            { label: "segmentTemporal", durationMs: 5200.1, children: [] },
            { label: "segmentScenes", durationMs: 7200.1, children: [] },
          ],
        },
        {
          label: "processing",
          durationMs: 150000.0,
          children: [
            {
              label: "step:scene",
              durationMs: 80000.0,
              children: [
                { label: "scene segment #0", durationMs: 12500.0, children: [] },
                { label: "scene segment #1", durationMs: 11800.0, children: [] },
              ],
            },
          ],
        },
      ],
    };
    const output = renderTimingTree(entry);
    expect(output).toContain("├── preProcessing");
    expect(output).toContain("├── segmentTemporal");
    expect(output).toContain("└── segmentScenes");
  });

  it("shows reference when showReference: true", () => {
    const entry: TimingEntry = {
      label: "workflow:test",
      durationMs: 100,
      reference: "file.mp4",
      children: [],
    };
    const output = renderTimingTree(entry, { showReference: true });
    expect(output).toContain("reference: file.mp4");
  });

  it("omits reference when showReference: false", () => {
    const entry: TimingEntry = {
      label: "workflow:test",
      durationMs: 100,
      reference: "file.mp4",
      children: [],
    };
    const output = renderTimingTree(entry, { showReference: false });
    expect(output).not.toContain("reference:");
  });

  it("formats duration correctly (ms/s/human)", () => {
    const entry: TimingEntry = {
      label: "test",
      durationMs: 5500,
      children: [],
    };
    expect(renderTimingTree(entry, { durationFormat: "ms" })).toContain("5500.0ms");
    expect(renderTimingTree(entry, { durationFormat: "s" })).toContain("5.50s");
    expect(renderTimingTree(entry, { durationFormat: "human" })).toContain("5.5s");
  });

  it("handles empty children array", () => {
    const entry: TimingEntry = {
      label: "empty",
      durationMs: 0,
      children: [],
    };
    const output = renderTimingTree(entry);
    expect(output).toBe("empty (0.0ms)");
  });

  it("respects maxDepth option", () => {
    const entry: TimingEntry = {
      label: "level0",
      durationMs: 1000,
      children: [
        {
          label: "level1",
          durationMs: 500,
          children: [
            {
              label: "level2",
              durationMs: 200,
              children: [
                {
                  label: "level3",
                  durationMs: 100,
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    };
    const output = renderTimingTree(entry, { maxDepth: 2 });
    expect(output).toContain("... (max depth reached)");
  });

  it("renders deep nested hierarchy correctly", () => {
    const entry: TimingEntry = {
      label: "root",
      durationMs: 10000,
      children: [
        {
          label: "child",
          durationMs: 5000,
          children: [
            {
              label: "grandchild",
              durationMs: 2000,
              reference: "scenes[0].caption",
              children: [],
            },
          ],
        },
      ],
    };
    const output = renderTimingTree(entry, { showReference: true });
    expect(output).toContain("grandchild");
    expect(output).toContain("reference: scenes[0].caption");
  });
});
