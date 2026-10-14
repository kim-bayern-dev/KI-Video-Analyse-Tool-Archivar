// ============================================================================
// Umbrella Type Exports
// ============================================================================
// All consumers should import from this file to keep import paths stable.

export * from "./workflow-types.js";
export * from "./plugin-types.js";
// Both modules export an identical `SliceType` alias, which `export *` excludes
// as ambiguous (TS2308). Pin the re-export explicitly (type-only, emits nothing).
export type { SliceType } from "./plugin-types.js";
