/**
 * Unit test for parseContextLengthClamp — the vLLM context-length-overflow
 * 400 body parser used by callWithPromptRaw's clamp-and-retry.
 */

import { describe, expect, it } from "vitest";
import { parseContextLengthClamp } from "../src/rpc/mllm-api";

const VLLM_BODY = JSON.stringify({
    error: {
        message:
            "This model's maximum context length is 131072 tokens. However, you requested 122000 output tokens and your prompt contains at least 9073 input tokens, for a total of at least 131073 tokens. Please reduce the length of the input prompt or the number of requested output tokens. (parameter=input_tokens, value=9073)",
        type: "BadRequestError",
        param: "input_tokens",
        code: 400,
    },
});

describe("parseContextLengthClamp", () => {
    it("clamps max_tokens to context − input − margin", () => {
        // 131072 − 9073 − 1024 = 120975
        expect(parseContextLengthClamp(VLLM_BODY)).toBe(120975);
    });

    it("applies a larger margin on later attempts (media tokens are undercounted)", () => {
        // 131072 − 9073 − 8192 = 113807
        expect(parseContextLengthClamp(VLLM_BODY, 8192)).toBe(113807);
    });

    it("returns null for unrelated error bodies", () => {
        expect(parseContextLengthClamp("")).toBeNull();
        expect(parseContextLengthClamp('{"error":{"message":"model not found"}}')).toBeNull();
    });

    it("returns null when no usable output budget remains", () => {
        const body = "maximum context length is 8192 tokens. However, you requested 100 output tokens and your prompt contains at least 8000 input tokens";
        // 8192 − 8000 − 1024 < 512 → unusable
        expect(parseContextLengthClamp(body)).toBeNull();
    });
});
