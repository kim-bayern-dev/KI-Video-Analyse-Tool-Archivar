# yup-json-schema

Dependency-free, isomorphic converter from a focused **Yup** schema subset to a
**JSON Schema (draft-07)** object suitable for vLLM / OpenAI structured-output
constrained decoding.

> Placed under `src/lib/` (rather than a separate `packages/` workspace)
> intentionally: Archivar is a single-package Astro app, and this converter is
> tightly coupled to Archivar's Yup schemas. Adding a pkgroll/workspaces build
> pipeline would add complexity without benefit (AGENTS.md prime directive).

## Why

Archivar's source of truth for response shapes is **Yup**, but native guided
decoding consumes **JSON Schema**. Rather than add a runtime dependency, this
module walks Yup's stable `schema.describe()` introspection tree and emits a
strict JSON Schema.

## Supported Yup subset

Exactly what the plugin schemas ([`plugins/default.ts`](../../../plugins/default.ts),
[`plugins/question-answer.ts`](../../../plugins/question-answer.ts)) use:

| Yup                                       | JSON Schema output                                   |
| ----------------------------------------- | ---------------------------------------------------- |
| `yup.object({...})`                       | `object` + `properties` + `required[]` + `additionalProperties:false` |
| `yup.object()` (shapeless, no `.shape()`) | open `object` (`additionalProperties: true`)-deliberate pass-through (e.g. `perception_matrix`) |
| `yup.string()`                            | `string`                                             |
| `yup.number()`                            | `number`                                             |
| `yup.boolean()`                           | `boolean`                                            |
| `yup.array().of(X)`                       | `array` + `items`                                    |
| `yup.string().oneOf([...])`               | `string` + `enum`                                    |
| `.required()` / `.defined()`              | adds the key to the parent `required[]`              |
| `mixed()` / anything else                 | throws `UnsupportedYupNodeError` (fail-fast)         |

## Invariants

- `additionalProperties: false` on every *shaped* object (vLLM strict mode
  requires it). Shapeless objects stay open (see above)-squeezing them to
  `properties: {}` + `additionalProperties: false` would make the grammar
  accept only `{}` and silently drop their content.
- Only Yup-`.required()` fields land in `required[]`; `.optional()` fields are
  emitted as typed properties whose absence never errors (keeps guided decoding
  usable for schemas like `sliceAnalysisSchema`'s optional `audio_details`).
- The `strict` convert option is DEPRECATED: accepted for API compatibility but
  has no effect (the same invariants are always emitted).

## Usage

```ts
import { yupToJsonSchema } from "./src/lib/yup-json-schema/index.js";
import * as yup from "yup";

const schema = yup.object({
  answer: yup.boolean().required(),
  reasoning: yup.string().required(),
}).stripUnknown();

const jsonSchema = yupToJsonSchema(schema);
// → { $schema: "...draft-07...", type: "object", properties: {...}, required: [...], additionalProperties: false }
```

Field-level enums (`scene_type`, `oneOf`/`manyOf` options) become JSON Schema
`enum`-**never** `structured_outputs.choice`, which constrains the entire
output and is wrong for nested fields.
