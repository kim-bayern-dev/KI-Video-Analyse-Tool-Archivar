/**
 * Tests for the consolidated JSON extractor (src/lib/parse-json.ts).
 *
 * Covers all fallback branches and the throwOnFail toggle that the three
 * delegating wrappers (MllmApi.extractAndParseJson, plugin-api parseJsonLoose,
 * summary parseJsonResponse) depend on.
 */
import { describe, it, expect } from "vitest";
import { parseJsonLoose } from "../src/lib/parse-json";

describe("parseJsonLoose", () => {
  it("parses a direct JSON object", () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
  });

  it("parses a direct JSON array", () => {
    expect(parseJsonLoose("[1,2,3]")).toEqual([1, 2, 3]);
  });

  it("extracts JSON from a ```json fenced block", () => {
    const content = 'prefix\n```json\n{"ok": true}\n```\nsuffix';
    expect(parseJsonLoose(content)).toEqual({ ok: true });
  });

  it("extracts JSON from an unlabeled fence (```)", () => {
    const content = 'text\n```\n{"ok": false}\n```';
    expect(parseJsonLoose(content)).toEqual({ ok: false });
  });

  it("parses JSON with only an opening ```json fence (no closing)", () => {
    // Models sometimes emit the opening fence without the closing one.
    expect(parseJsonLoose('```json\n{"ok": true}')).toEqual({ ok: true });
  });

  it("parses JSON with only an opening unlabeled fence (no closing)", () => {
    expect(parseJsonLoose('```\n{"ok": true}')).toEqual({ ok: true });
  });

  it("parses JSON surrounded by fences with no surrounding prose", () => {
    // Exactly ```json\n{...}\n``` with no prefix/suffix prose.
    expect(parseJsonLoose('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
  });

  it("parses fenced JSON array with opening fence only", () => {
    expect(parseJsonLoose('```json\n[1, 2, 3]')).toEqual([1, 2, 3]);
  });

  it("extracts a trailing object from prose", () => {
    const content = 'Here is your answer: {"answer": true}';
    expect(parseJsonLoose(content)).toEqual({ answer: true });
  });

  it("extracts a trailing array from prose", () => {
    const content = 'tags: ["a","b"]';
    expect(parseJsonLoose(content)).toEqual(["a", "b"]);
  });

  it("returns null for non-JSON content", () => {
    expect(parseJsonLoose("just prose, no JSON here")).toBeNull();
  });

  it("returns null for empty / non-string input", () => {
    expect(parseJsonLoose("")).toBeNull();
    expect(parseJsonLoose(null as unknown as string)).toBeNull();
  });

  describe("throwOnFail", () => {
    it("throws when content cannot be parsed", () => {
      expect(() => parseJsonLoose("no json", { throwOnFail: true })).toThrow();
    });

    it("throws for empty content", () => {
      expect(() => parseJsonLoose("", { throwOnFail: true })).toThrow();
    });

    it("does not throw when parseable", () => {
      expect(parseJsonLoose('{"x":1}', { throwOnFail: true })).toEqual({ x: 1 });
    });
  });

  describe("extractFirstBalancedJson (garbage-prefixed/suffixed content)", () => {
    it("extracts first valid JSON from garbage-suffixed content inside fences", () => {
      // Real model failure case: valid JSON followed by garbage
      const content = '```json\n{"id": "1", "type": "urn:ai:mtcars"}\n, {\\n_{}}]\\n```';
      expect(parseJsonLoose(content)).toEqual({ id: "1", type: "urn:ai:mtcars" });
    });

    it("extracts first valid JSON from multiple concatenated JSON objects", () => {
      const content = '{"first": 1}, {"second": 2}, {"third": 3}';
      expect(parseJsonLoose(content)).toEqual({ first: 1 });
    });

    it("extracts first valid array from garbage-suffixed content", () => {
      const content = '[1, 2, 3]\ngarbage\nmore garbage';
      expect(parseJsonLoose(content)).toEqual([1, 2, 3]);
    });

    it("handles strings containing braces inside the JSON", () => {
      const content = '{"text": "contains {curly} and [square]"}';
      expect(parseJsonLoose(content)).toEqual({ text: "contains {curly} and [square]" });
    });

    it("handles escaped quotes inside strings", () => {
      const content = '{"msg": "say \\"hello\\""}';
      expect(parseJsonLoose(content)).toEqual({ msg: 'say "hello"' });
    });

    it("extracts JSON from content with newlines and tabs", () => {
      const content = '\n\n{\n  "a": 1,\n  "b": "text"\n}\n\ngarbage';
      expect(parseJsonLoose(content)).toEqual({ a: 1, b: "text" });
    });

    it("returns null when no balanced JSON found", () => {
      expect(parseJsonLoose("no braces here")).toBeNull();
    });

    it("extracts array from content starting with garbage", () => {
      const content = 'garbage\n[1, 2, 3]\nmore garbage';
      expect(parseJsonLoose(content)).toEqual([1, 2, 3]);
    });
  });
});
