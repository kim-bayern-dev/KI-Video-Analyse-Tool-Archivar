/**
 * Yup → JSON Schema converter public surface.
 *
 * See `convert.ts` for the supported Yup subset and strict invariants, and
 * `README.md` in this folder for design notes.
 */

export { yupToJsonSchema } from "./convert.js";
export type { ConvertOptions } from "./convert.js";
export type { JsonSchemaRoot, JsonSchemaProperty } from "./types.js";
export { UnsupportedYupNodeError } from "../errors.js";
