import { describe, it, expect } from "vitest";
import { resolveEnabledProcessingSteps } from "../src/rpc/workflow-engine.js";
import type { ProcessingStep, WorkflowDefinition } from "../src/lib/workflow-types.js";

/**
 * Engine-side step gating (workflow-engine.ts STEP 5): keyframe steps are
 * default-disabled in the shipped workflows — they run for video/audio only
 * when explicitly enabled, but ALWAYS run for single-image input (an image is
 * its own keyframe; without the step an image run would analyze nothing).
 */

const workflow = (processing: ProcessingStep[]): WorkflowDefinition =>
  ({ name: "wf", processing }) as WorkflowDefinition;

const DEFAULT_DISABLED_KF = {
  mediaType: "keyframe",
  modelName: "vlm",
  enabled: false,
  enabledAsFallback: true,
} as ProcessingStep;

const SCENE = { mediaType: "scene", modelName: "vlm", enabled: true } as ProcessingStep;
const SPEECH = { mediaType: "speech", modelName: "asr", enabled: true } as ProcessingStep;

const mediaTypes = (steps: ProcessingStep[]) => steps.map((s) => s.mediaType);

describe("resolveEnabledProcessingSteps", () => {
  it("drops a default-disabled keyframe step for video, keeps scene+speech", () => {
    const steps = resolveEnabledProcessingSteps(workflow([SCENE, SPEECH, DEFAULT_DISABLED_KF]), "video");
    expect(mediaTypes(steps)).toEqual(["scene", "speech"]);
  });

  it("drops a default-disabled keyframe step for audio", () => {
    const steps = resolveEnabledProcessingSteps(workflow([SPEECH, DEFAULT_DISABLED_KF]), "audio");
    expect(mediaTypes(steps)).toEqual(["speech"]);
  });

  it("keeps a default-disabled keyframe step for single-image input", () => {
    const steps = resolveEnabledProcessingSteps(workflow([SCENE, SPEECH, DEFAULT_DISABLED_KF]), "image");
    expect(mediaTypes(steps)).toContain("keyframe");
  });

  it("keeps an explicitly enabled keyframe step for video (opt-in)", () => {
    const kfOn = { ...DEFAULT_DISABLED_KF, enabled: true };
    const steps = resolveEnabledProcessingSteps(workflow([SCENE, kfOn]), "video");
    expect(mediaTypes(steps)).toEqual(["scene", "keyframe"]);
  });

  it("still drops other disabled steps for image input", () => {
    const sceneOff = { ...SCENE, enabled: false };
    const steps = resolveEnabledProcessingSteps(workflow([sceneOff, DEFAULT_DISABLED_KF]), "image");
    expect(mediaTypes(steps)).toEqual(["keyframe"]);
  });
});
