/**
 * Minimal JSON Schema (draft-07) fragment types returned by the converter.
 * Kept intentionally loose (Record-based) to avoid pulling in a JSON-Schema
 * type library — we only emit the subset vLLM strict mode consumes.
 */

export interface JsonSchemaProperty {
  type?: string | string[];
  enum?: unknown[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
  description?: string;
}

export type JsonSchemaRoot = JsonSchemaProperty & { $schema?: string };
