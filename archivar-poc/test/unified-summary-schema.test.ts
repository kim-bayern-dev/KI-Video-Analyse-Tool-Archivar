/**
 * Regression test for the empty whole-video summary bug (2026-08):
 * unifiedSummarySchema previously declared every field optional, so the
 * structured-outputs grammar (required: []) permitted `{}` — and models took
 * the shortcut (Qwen3.8-27B-FP8 returned `{}` in 209 ms). The result was a
 * summary with no title/keywords/summary and zero reported errors. The core
 * text fields are now required: `{}` is unrepresentable in guided mode and
 * fails yup validation (triggering callJson's correction retries) otherwise.
 */
import { describe, it, expect } from "vitest";
import { unifiedSummarySchema } from "../plugins/default";

const FULL_SUMMARY = {
  title: "Titel",
  abstract: "Abstrakt",
  keywords: ["a", "b"],
  tags: ["Dokumentation"],
  categorization: "Reportage",
  short_description: "Kurz",
  long_summary: "Lang",
  overallIntention: "INFORMATIONAL",
  narrativeArc: "Bogen",
  perceptionArc: "Wahrnehmung",
};

describe("unifiedSummarySchema — required core fields", () => {
  it("rejects the empty object (the observed `{}` shortcut)", async () => {
    await expect(unifiedSummarySchema.validate({}, { abortEarly: false })).rejects.toThrow();
  });

  it.each(Object.keys(FULL_SUMMARY))("rejects a summary missing %s", async (field) => {
    const incomplete = { ...FULL_SUMMARY, [field]: undefined };
    await expect(unifiedSummarySchema.validate(incomplete, { abortEarly: false })).rejects.toThrow();
  });

  it("accepts a fully populated summary", async () => {
    const validated = await unifiedSummarySchema.validate(FULL_SUMMARY, { abortEarly: false });
    expect(validated).toMatchObject(FULL_SUMMARY);
  });
});
