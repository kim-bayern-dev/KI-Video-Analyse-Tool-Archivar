/**
 * Tests for the Yup → JSON Schema converter (src/lib/yup-json-schema).
 *
 * Covers every supported Yup node, the strict invariants (additionalProperties,
 * optional-field rejection), and the fail-fast UnsupportedYupNodeError for
 * mixed()/missing innerType. Snapshots lock the contract for the real plugin
 * schemas (sliceAnalysisSchema, wholeSummarySchema).
 */
import { describe, it, expect } from "vitest";
import * as yup from "yup";
import { yupToJsonSchema } from "../src/lib/yup-json-schema/index";
import { UnsupportedYupNodeError } from "../src/lib/errors";

describe("yupToJsonSchema", () => {
  it("converts a simple required-string/number/boolean object", () => {
    const schema = yup.object({
      name: yup.string().required(),
      age: yup.number().required(),
      active: yup.boolean().required(),
    }).stripUnknown();

    const out = yupToJsonSchema(schema);
    expect(out.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(out.type).toBe("object");
    expect(out.additionalProperties).toBe(false);
    expect(out.properties).toEqual({
      name: { type: "string" },
      age: { type: "number" },
      active: { type: "boolean" },
    });
    expect(out.required).toEqual(["name", "age", "active"]);
  });

  it("maps string.oneOf to an enum (field-level enum, never choice)", () => {
    const schema = yup.object({
      scene_type: yup.string().oneOf(["intro", "outro"]).required(),
    }).stripUnknown();

    const out = yupToJsonSchema(schema);
    expect(out.properties?.scene_type).toEqual({
      type: "string",
      enum: ["intro", "outro"],
    });
  });

  it("converts array.of with nested objects", () => {
    const schema = yup.object({
      items: yup.array().of(
        yup.object({ id: yup.number().required() }).stripUnknown().required(),
      ).required(),
    }).stripUnknown();

    const out = yupToJsonSchema(schema);
    expect(out.properties?.items).toEqual({
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "number" } },
        required: ["id"],
        additionalProperties: false,
      },
    });
  });

  it("rejects mixed() with UnsupportedYupNodeError", () => {
    const schema = yup.object({ x: yup.mixed().required() }).stripUnknown();
    expect(() => yupToJsonSchema(schema)).toThrow(UnsupportedYupNodeError);
  });

  it("emits an optional field as a property but keeps it OUT of required[]", () => {
    const schema = yup.object({
      a: yup.string().required(),
      b: yup.string().optional(),
    }).stripUnknown();

    const out = yupToJsonSchema(schema);
    // Optional field is present as a property (so it's part of the schema and
    // accepted when provided) but NOT required — its absence never errors,
    // matching Yup semantics.
    expect(out.properties?.a).toEqual({ type: "string" });
    expect(out.properties?.b).toEqual({ type: "string" });
    expect(out.required).toEqual(["a"]);
  });

  it("allows optional fields when strict is false", () => {
    const schema = yup.object({
      a: yup.string().required(),
      b: yup.string().optional(),
    }).stripUnknown();

    const out = yupToJsonSchema(schema, { strict: false });
    // Only required field lands in required[]
    expect(out.required).toEqual(["a"]);
    expect(out.properties?.b).toEqual({ type: "string" });
  });

  it("rejects an array without innerType", () => {
    const schema = yup.object({
      tags: yup.array().required(),
    }).stripUnknown();

    expect(() => yupToJsonSchema(schema)).toThrow(UnsupportedYupNodeError);
  });

  it("emits an open object (additionalProperties:true) for shapeless yup.object()", () => {
    // Shapeless objects are deliberate verbatim pass-through fields
    // (perception_matrix, qualityAttributes in plugins/default.ts). The
    // strict invariant (properties:{} + additionalProperties:false) would
    // restrict the guided-decoding grammar to the EMPTY object only.
    const schema = yup.object({
      a: yup.string().required(),
      passthrough: yup.object().optional(),
      passthrough_required: yup.object().required(),
    }).stripUnknown();

    const out = yupToJsonSchema(schema);
    // The shaped root stays strict…
    expect(out.additionalProperties).toBe(false);
    // …while shapeless fields become open objects (no properties, AP:true)
    expect(out.properties!.passthrough).toEqual({ type: "object", additionalProperties: true });
    expect(out.properties!.passthrough_required).toEqual({ type: "object", additionalProperties: true });
    // Optional shapeless field is omittable, required one is in required[]
    expect(out.required).toEqual(["a", "passthrough_required"]);
  });

  it("matches snapshot for a sliceAnalysis-style schema", () => {
    const sliceAnalysisSchema = yup.object({
      summary: yup.string().required(),
      scene_type: yup.string().oneOf(["intro", "outro", "ad"]).required(),
      timeline: yup.array().of(
        yup.object({ time: yup.string().required(), event: yup.string().required() }).required(),
      ).required(),
      text_visible: yup.array().of(yup.string().required()).required(),
    }).stripUnknown();

    expect(yupToJsonSchema(sliceAnalysisSchema)).toMatchInlineSnapshot(`
      {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "additionalProperties": false,
        "properties": {
          "scene_type": {
            "enum": [
              "intro",
              "outro",
              "ad",
            ],
            "type": "string",
          },
          "summary": {
            "type": "string",
          },
          "text_visible": {
            "items": {
              "type": "string",
            },
            "type": "array",
          },
          "timeline": {
            "items": {
              "additionalProperties": false,
              "properties": {
                "event": {
                  "type": "string",
                },
                "time": {
                  "type": "string",
                },
              },
              "required": [
                "time",
                "event",
              ],
              "type": "object",
            },
            "type": "array",
          },
        },
        "required": [
          "summary",
          "scene_type",
          "timeline",
          "text_visible",
        ],
        "type": "object",
      }
    `);
  });
});
