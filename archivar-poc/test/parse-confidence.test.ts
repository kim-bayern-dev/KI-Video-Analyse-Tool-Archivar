import { describe, it, expect } from "vitest";
import { parseConfidence } from "../plugins/default.js";

describe("parseConfidence", () => {
  it("normalizes percentage strings to 0..1", () => {
    expect(parseConfidence("95%")).toBe(0.95);
    expect(parseConfidence("95")).toBe(0.95);
    expect(parseConfidence("100%")).toBe(1);
  });

  it("passes ratios through", () => {
    expect(parseConfidence("0.95")).toBe(0.95);
    expect(parseConfidence(0.85)).toBe(0.85);
    expect(parseConfidence(1)).toBe(1);
    expect(parseConfidence("1.0")).toBe(1);
  });

  it("clamps and repairs model sloppiness", () => {
    expect(parseConfidence(25)).toBe(0.25); // das alte „25 statt 0.25"-Problem
    expect(parseConfidence("110%")).toBe(1); // >100% wird gedeckelt
    expect(parseConfidence(1.5)).toBe(0.015); // Zahl > 1 als Prozent
  });

  it("falls back to 0.5 on unparseable input", () => {
    expect(parseConfidence("hoch")).toBe(0.5);
    expect(parseConfidence(undefined)).toBe(0.5);
    expect(parseConfidence(null)).toBe(0.5);
  });
});
