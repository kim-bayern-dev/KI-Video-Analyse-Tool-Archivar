/**
 * Yup → JSON Schema converter for the Yup subset Archivar actually uses.
 *
 * WHY: Native vLLM structured-output mode consumes a JSON Schema, but
 * Archivar's source of truth is Yup. Rather than add a runtime dependency
 * (project rule: minimal deps), this focused converter walks Yup's stable
 * `describe()` introspection tree and emits a draft-07 schema with the
 * invariants vLLM strict mode requires.
 *
 * Supported Yup nodes (exactly what the plugin schemas use):
 *   object, string, number, boolean, array(.of), string.oneOf (enum).
 *
 * Strict invariants (always emitted):
 *   - additionalProperties:false on every object
 *   - `mixed()` and any unsupported node → UnsupportedYupNodeError (fail-fast)
 *
 * Optional-field policy: Yup `.optional()` fields are emitted as properties
 * with their normal type but are NOT added to `required[]`, and their absence
 * never errors. This keeps native guided decoding enabled for schemas like
 * sliceAnalysisSchema, which legitimately marks `audio_details` optional
 * because most VLMs cannot analyze audio. Only Yup-`.required()` fields land
 * in `required[]`.
 *
 * Pure, isomorphic, no I/O.
 */

import type { Schema } from "yup";
import type { JsonSchemaProperty, JsonSchemaRoot } from "./types.js";
import { UnsupportedYupNodeError } from "../errors.js";

export interface ConvertOptions {
  // REFACTOR(kiss): `strict` is a dead option — it is threaded through
  // convertNode/convertArray/convertObject but never actually read:
  // additionalProperties:false is emitted unconditionally (convertObject
  // below) and optional fields are never rejected. The documented behaviors
  // ("reject optional fields", non-strict mode without additionalProperties)
  // do not exist, so output is byte-identical either way. Remove the option,
  // or implement it if a non-strict consumer ever appears.
  /** Accepted for API compatibility but currently has no effect (see REFACTOR note). */
  strict?: boolean;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- Yup's describe() is loosely typed */

interface YupDesc {
  type: string;
  /** Yup 1.x describes required-ness as `optional: false` (not via flags.presence). */
  optional?: boolean;
  fields?: Record<string, YupDesc>;
  innerType?: YupDesc;
  oneOf?: readonly unknown[];
  meta?: Record<string, unknown>;
}

/** Convert a Yup schema into a JSON Schema (draft-07) object. Throws on unsupported nodes. */
export function yupToJsonSchema(schema: Schema, opts?: ConvertOptions): JsonSchemaRoot {
  const strict = opts?.strict ?? true;
  const root = convertNode(schema.describe() as YupDesc, strict);
  return { $schema: "http://json-schema.org/draft-07/schema#", ...root };
}

/** Recursive walker over a single Yup description node. */
function convertNode(desc: YupDesc, strict: boolean): JsonSchemaProperty {
  switch (desc.type) {
    case "string":
      return convertString(desc);
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "array":
      return convertArray(desc, strict);
    case "object":
      return convertObject(desc, strict);
    default:
      // mixed() and anything else Archivar doesn't use → fail fast so an
      // unsupported schema is surfaced explicitly, never silently coerced.
      throw new UnsupportedYupNodeError(desc.type || "unknown");
  }
}

function convertString(desc: YupDesc): JsonSchemaProperty {
  const prop: JsonSchemaProperty = { type: "string" };
  // string.oneOf([...]) → JSON Schema enum. This is how field-level enums
  // (e.g. scene_type) travel; NEVER use structured_outputs.choice for these.
  if (desc.oneOf && desc.oneOf.length > 0) {
    prop.enum = [...desc.oneOf];
  }
  return prop;
}

function convertArray(desc: YupDesc, strict: boolean): JsonSchemaProperty {
  if (!desc.innerType) {
    // Array without .of(): we don't know the item shape. Fail fast rather
    // than emit an untyped array under strict mode.
    throw new UnsupportedYupNodeError("array (missing innerType)");
  }
  return { type: "array", items: convertNode(desc.innerType, strict) };
}

function convertObject(desc: YupDesc, strict: boolean): JsonSchemaProperty {
  const fields = desc.fields ?? {};

  // Shapeless object (yup.object() without .shape(), e.g. the deliberate
  // pass-through fields `perception_matrix` / `qualityAttributes` in
  // plugins/default.ts): the model's content is intentionally unconstrained.
  // Emitting the strict invariant (`properties: {}` + additionalProperties:
  // false) would make the guided-decoding grammar accept ONLY the empty
  // object — silently squeezing the field's content to `{}`. An open object
  // is the correct schema for "any object passes through verbatim".
  if (Object.keys(fields).length === 0) {
    return { type: "object", additionalProperties: true };
  }

  const properties: Record<string, JsonSchemaProperty> = {};
  const required: string[] = [];

  for (const [key, fieldDesc] of Object.entries(fields)) {
    properties[key] = convertNode(fieldDesc, strict);

    // Yup marks required fields with `optional: false`; optional fields with
    // `optional: true`. Every field becomes a `properties` entry; only
    // Yup-`.required()` fields land in `required[]`. Optional fields are
    // therefore emitted but omittable — their absence never errors.
    const isRequired = fieldDesc.optional !== true;
    if (isRequired) {
      required.push(key);
    }
  }

  return {
    type: "object",
    properties,
    required,
    // vLLM strict mode mandates this; harmless elsewhere.
    additionalProperties: false,
  };
}
