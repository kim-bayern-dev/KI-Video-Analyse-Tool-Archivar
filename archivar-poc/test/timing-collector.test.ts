import { describe, it, expect, vi, afterEach } from "vitest";
import { TimingCollector, TimingHandle } from "../src/lib/timing-collector.js";

describe("TimingCollector", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should create collector with correct label", () => {
    const collector = new TimingCollector("workflow:test");
    const tree = collector.finalize();
    expect(tree.label).toBe("workflow:test");
    expect(tree.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("should create TimingEntry with reference field", () => {
    const collector = new TimingCollector("workflow:test", "file.mp4");
    const tree = collector.finalize();
    expect(tree.reference).toBe("file.mp4");
  });

  it("should capture positive duration", async () => {
    const collector = new TimingCollector("workflow:test");
    await new Promise((r) => setTimeout(r, 10));
    const tree = collector.finalize();
    expect(tree.durationMs).toBeGreaterThan(5); // at least ~10ms
  });

  it("should begin and end child scope", () => {
    const collector = new TimingCollector("workflow:test");
    const child = collector.beginChild("preProcessing");
    const entry = child.end();
    expect(entry.label).toBe("preProcessing");
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("should preserve reference in child", () => {
    const collector = new TimingCollector("workflow:test");
    const child = collector.beginChild("preProcessing", "out_file.json");
    const entry = child.end();
    expect(entry.reference).toBe("out_file.json");
  });

  it("should build nested hierarchy", () => {
    const collector = new TimingCollector("workflow:test");
    const stage = collector.beginChild("preProcessing");
    const sub = stage.beginGrandChild("segmentTemporal", "out_segment.json");
    sub.end();
    stage.end();
    const tree = collector.finalize();
    expect(tree.children?.length).toBe(1);
    expect(tree.children?.[0]?.children?.length).toBe(1);
    expect(tree.children?.[0]?.children?.[0]?.label).toBe("segmentTemporal");
  });

  it("should compute correct duration for each level", async () => {
    const collector = new TimingCollector("workflow:test");
    const stage = collector.beginChild("stage");
    await new Promise((r) => setTimeout(r, 5));
    const sub = stage.beginGrandChild("sub");
    await new Promise((r) => setTimeout(r, 5));
    sub.end();
    stage.end();
    const tree = collector.finalize();

    // sub duration >= 5ms
    expect(tree.children?.[0]?.children?.[0]?.durationMs).toBeGreaterThanOrEqual(4);
    // stage duration >= 10ms (sub + overhead)
    expect(tree.children?.[0]?.durationMs).toBeGreaterThanOrEqual(8);
  });

  it("should return same entry on double end() call", () => {
    const collector = new TimingCollector("workflow:test");
    const child = collector.beginChild("child");
    const entry1 = child.end();
    const entry2 = child.end();
    expect(entry1).toBe(entry2);
  });

  it("should log to console.log on end()", () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));

    const collector = new TimingCollector("workflow:test");
    const child = collector.beginChild("child");
    child.end();
    collector.finalize();

    expect(logs.some((l) => l.startsWith("[TIMER] child:"))).toBe(true);
    expect(logs.some((l) => l.startsWith("[TIMER] workflow:test:"))).toBe(true);
  });

  it("should handle multiple children", () => {
    const collector = new TimingCollector("workflow:test");
    const c1 = collector.beginChild("child1");
    const c2 = collector.beginChild("child2");
    c1.end();
    c2.end();
    const tree = collector.finalize();
    expect(tree.children?.length).toBe(2);
    expect(tree.children?.[0]?.label).toBe("child1");
    expect(tree.children?.[1]?.label).toBe("child2");
  });

  it("should support deeply nested hierarchy", () => {
    const collector = new TimingCollector("level0");
    const l1 = collector.beginChild("level1");
    const l2 = l1.beginGrandChild("level2");
    const l3 = l2.beginGrandChild("level3");
    const l4 = l3.beginGrandChild("level4");
    l4.end();
    l3.end();
    l2.end();
    l1.end();
    const tree = collector.finalize();

    expect(tree.children?.[0]?.children?.[0]?.children?.[0]?.children?.[0]?.label).toBe("level4");
  });

  describe("snapshot()", () => {
    it("returns an up-to-date durationMs WITHOUT logging the finalize line", () => {
      const logs: string[] = [];
      vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));

      const collector = new TimingCollector("workflow:test");
      const snap = collector.snapshot();
      expect(snap.durationMs).toBeGreaterThanOrEqual(0);
      // snapshot() must stay quiet (unlike finalize), so no [TIMER] root line yet.
      expect(logs.some((l) => l.startsWith("[TIMER] workflow:test:"))).toBe(false);
    });

    it("is non-destructive: an in-flight child can still be ended after snapshot", () => {
      const collector = new TimingCollector("workflow:test");
      const stage = collector.beginChild("processing");
      // snapshot mid-flight — must not close the open stage
      const mid = collector.snapshot();
      expect(mid.children?.length).toBe(1);

      stage.end();
      const final = collector.finalize();
      expect(final.children?.[0]?.label).toBe("processing");
      expect(final.children?.[0]?.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("can be called repeatedly and reflects progression of time", async () => {
      const collector = new TimingCollector("workflow:test");
      const first = collector.snapshot().durationMs;
      await new Promise((r) => setTimeout(r, 10));
      const second = collector.snapshot().durationMs;
      expect(second).toBeGreaterThanOrEqual(first);
    });
  });
});
