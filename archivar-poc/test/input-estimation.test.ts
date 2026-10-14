import { describe, it, expect } from "vitest";
import {
  estimateTextTokens,
  estimateMediaTokens,
  budgetCapForModel,
  MIN_OUTPUT_TOKENS,
  CONTEXT_MARGIN_TOKENS,
} from "../src/lib/input-estimation.js";

const EST = { tokensPerWord: 2.0, tokensPerFrame: 340 };

describe("estimateTextTokens", () => {
  it("counts whitespace-separated words times the model ratio", () => {
    expect(estimateTextTokens("eins zwei drei", 2.0)).toBe(6);
    expect(estimateTextTokens("eins zwei drei", 1.5)).toBe(5); // ceil
  });

  it("handles empty and whitespace-only input", () => {
    expect(estimateTextTokens("", 2.0)).toBe(0);
    expect(estimateTextTokens("   ", 2.0)).toBe(0);
  });
});

describe("estimateMediaTokens", () => {
  it("audio is free", () => {
    expect(estimateMediaTokens("audio", undefined, 340)).toBe(0);
  });

  it("image costs one frame", () => {
    expect(estimateMediaTokens("image", undefined, 340)).toBe(340);
  });

  it("video prefers an explicit num_frames", () => {
    expect(estimateMediaTokens("video", { num_frames: 8, fps: 1 }, 340)).toBe(2720);
  });

  it("video falls back to fps × 60s upper bound", () => {
    expect(estimateMediaTokens("video", { fps: 1 }, 340)).toBe(20400);
    expect(estimateMediaTokens("video", { fps: 0.5 }, 340)).toBe(10200);
    expect(estimateMediaTokens("video", undefined, 340)).toBe(20400); // fps default 1
  });
});

describe("budgetCapForModel", () => {
  it("subtracts text+media estimate and margin from the window", () => {
    // window 65535, 10 words × 2 = 20 text, video fps 1 → 20400 media
    const cap = budgetCapForModel(65535, EST, "eins zwei drei vier fünf sechs sieben acht neun zehn", undefined, "video", { fps: 1 });
    expect(cap).toBe(65535 - 20 - 20400 - CONTEXT_MARGIN_TOKENS);
  });

  it("includes the system prompt in the text estimate", () => {
    const withSys = budgetCapForModel(65535, EST, "wort", "zwei wörter", "audio", undefined);
    const withoutSys = budgetCapForModel(65535, EST, "wort", undefined, "audio", undefined);
    expect(withoutSys - withSys).toBe(Math.ceil(3 * 2.0) - Math.ceil(1 * 2.0));
  });

  it("floors at MIN_OUTPUT_TOKENS when the prompt alone exceeds the window", () => {
    const hugePrompt = "wort ".repeat(40000);
    expect(budgetCapForModel(65535, EST, hugePrompt, undefined, "audio", undefined)).toBe(MIN_OUTPUT_TOKENS);
  });
});
