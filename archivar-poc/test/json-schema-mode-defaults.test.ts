/**
 * Tests for the model-name → JSON-schema transport default registry.
 *
 * WHY: the registry centralizes which transport each model family uses so
 * getModel() can resolve a default without probing. These tests lock the
 * family→transport mapping and the "auto" fallback for unknown families.
 */
import { describe, it, expect } from "vitest";
import { defaultJsonSchemaModeForModel } from "../src/lib/json-schema-mode-defaults";

describe("defaultJsonSchemaModeForModel", () => {
  it.skip("maps gemma family (gemma4 / gemma-4 repo id) to response_format", () => {
    expect(defaultJsonSchemaModeForModel("gemma4-12b-qat-w4a16")).toBe("response_format");
    expect(defaultJsonSchemaModeForModel("gemma-4-12B-it-qat-w4a16-ct")).toBe("response_format");
    expect(defaultJsonSchemaModeForModel("GEMMA-foo")).toBe("response_format");
  });

  it("maps qwen3 family to structured_outputs", () => {
    expect(defaultJsonSchemaModeForModel("Qwen3.8-27B-FP8")).toBe("structured_outputs");
    expect(defaultJsonSchemaModeForModel("Qwen3.6-35B-A3B-GPTQ-Int4")).toBe("structured_outputs");
    expect(defaultJsonSchemaModeForModel("qwen3.5-122b-a10b-gptq-int4")).toBe("structured_outputs");
  });

  it("falls back to auto for unknown families", () => {
    expect(defaultJsonSchemaModeForModel("llama-3-70b")).toBe("auto");
    expect(defaultJsonSchemaModeForModel("some-unknown-model")).toBe("auto");
  });

  it("is case-insensitive (substring match)", () => {
    expect(defaultJsonSchemaModeForModel("My-QWEN3.6-Custom")).toBe("structured_outputs");
    expect(defaultJsonSchemaModeForModel("prefix-Gemma4-suffix")).toBe("response_format");
  });

  it("returns auto for empty / nullish names without throwing", () => {
    expect(defaultJsonSchemaModeForModel("")).toBe("auto");
    expect(defaultJsonSchemaModeForModel(undefined as unknown as string)).toBe("auto");
  });
});
