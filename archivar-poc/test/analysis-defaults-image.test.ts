import { describe, it, expect, beforeAll } from "vitest";
import { setArchivarConfig } from "../src/lib/archivar-config.js";
import type { ArchivarConfig, MediaSegmentType } from "../src/lib/workflow-types.js";
import { AnalyseApi } from "../src/rpc/analyse-api.js";

/**
 * Media-type gating of getAllAnalysisDefaults: the upload wizard's step 3
 * filters by `compatible` and pre-checks `enabled`. Keyframe steps are
 * default-disabled in the shipped workflows (opt-in for video/audio), but
 * single-image input must arrive with the keyframe step enabled+compatible
 * (keyframe analysis IS image analysis); scene stays video-only, the audio
 * family audio/video-only.
 */

const makeConfig = (): ArchivarConfig => ({
  auth: { users: [] },
  models: [
    { name: "vlm", type: "api", defaultPrompt: "Describe." },
    { name: "asr", type: "asr-api" },
  ],
  workflows: [
    {
      // Mirrors the shipped default workflows: keyframe default-disabled.
      name: "test-wf",
      processing: [
        { mediaType: "scene", modelName: "vlm" },
        { mediaType: "keyframe", modelName: "vlm", enabled: false, enabledAsFallback: true },
        { mediaType: "speech", modelName: "asr" },
      ],
    },
    {
      // Explicit opt-in: a workflow whose keyframe step is enabled by the config author.
      name: "test-wf-kf-on",
      processing: [
        { mediaType: "scene", modelName: "vlm" },
        { mediaType: "keyframe", modelName: "vlm", enabled: true },
        { mediaType: "speech", modelName: "asr" },
      ],
    },
  ],
  defaults: { workflow: "test-wf" },
});

const byMediaType = (steps: Awaited<ReturnType<AnalyseApi["getAllAnalysisDefaults"]>>["steps"]) =>
  Object.fromEntries(steps.map((s) => [s.mediaType, s])) as Record<
    MediaSegmentType,
    (typeof steps)[number]
  >;

describe("AnalyseApi.getAllAnalysisDefaults media-type gating", () => {
  beforeAll(() => {
    setArchivarConfig(makeConfig());
  });
  const api = new AnalyseApi();

  it("enables keyframe for images even when default-disabled; scene and speech are incompatible", async () => {
    const { steps } = await api.getAllAnalysisDefaults("photo.png", "test-wf");
    const byType = byMediaType(steps);
    expect(byType.keyframe.enabled).toBe(true);
    expect(byType.keyframe.compatible).toBe(true);
    expect(byType.keyframe.availableModels.map((m) => m.name)).toContain("vlm");
    expect(byType.scene.compatible).toBe(false);
    expect(byType.scene.enabled).toBe(false);
    expect(byType.speech.compatible).toBe(false);
    expect(byType.speech.enabled).toBe(false);
  });

  it("keeps keyframe disabled and incompatible for audio", async () => {
    const { steps } = await api.getAllAnalysisDefaults("audio.mp3", "test-wf");
    const byType = byMediaType(steps);
    expect(byType.keyframe.compatible).toBe(false);
    expect(byType.keyframe.enabled).toBe(false);
    expect(byType.speech.enabled).toBe(true);
    expect(byType.speech.compatible).toBe(true);
  });

  it("keeps keyframe disabled by default for video (opt-in), scene and speech enabled", async () => {
    const { steps } = await api.getAllAnalysisDefaults("movie.mp4", "test-wf");
    const byType = byMediaType(steps);
    expect(byType.scene.enabled).toBe(true);
    expect(byType.scene.compatible).toBe(true);
    // Default off, but compatible: the wizard shows the tab unchecked so the
    // user can explicitly enable keyframe analysis.
    expect(byType.keyframe.enabled).toBe(false);
    expect(byType.keyframe.compatible).toBe(true);
    expect(byType.speech.enabled).toBe(true);
  });

  it("honours an explicitly enabled keyframe step for video", async () => {
    const { steps } = await api.getAllAnalysisDefaults("movie.mp4", "test-wf-kf-on");
    const byType = byMediaType(steps);
    expect(byType.keyframe.enabled).toBe(true);
    expect(byType.keyframe.compatible).toBe(true);
  });
});
