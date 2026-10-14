import { setArchivarConfig } from "./src/lib/archivar-config";
import type { ArchivarConfig } from "./src/lib/workflow-types";

const DEFAULT_IMG_VID_CAPTION_PROMPT = `Give one dense, literal visual caption: medium/style; setting; subjects, appearance and expressions; actions/interactions; salient objects/spatial relations; readable text; framing/camera, lighting/color; for video, chronological events, motion and cuts. State only supported details; qualify uncertainty; never guess identity, intent, cause, place or off-screen context if uncertainty is high. Resond in German.`;

const config: ArchivarConfig = {
  auth: {
    users: [ // change .env for AUTH_USERNAME and AUTH_PASSWORD; 
      {
        username: "env:AUTH_USERNAME",
        password: "env:AUTH_PASSWORD",
      },
    ],
  },

  defaults: { // S configuration is the default
    // uses gemma-4-E4B for scene captioning and Qwen3-ASR-0.6B for speech transcription (S configuration)
    workflow: "default-analysis-gemma4-e4b",
    outputFormat: "json",
  },

  // vLLM v0.25+ repetition detection: sent on every chat-completions request to
  // models with inferenceEngine "vllm" and type !== "asr-api" (ASR never gets it —
  // speakers legitimately repeat themselves).
  repetitionDetection: {
    min_pattern_size: 8,
    max_pattern_size: 64,
    // min_count 5: at 3 the detector fired on legitimate JSON structure
    // (table separators, array braces) and truncated structured outputs.
    min_count: 5,
  },

  // Milder variant for STRUCTURED-output calls (response_format/structured_outputs):
  // large min_pattern_size so JSON syntax repetition (table separators, array
  // braces — short patterns) never triggers, while prose/keyword-list loops
  // (long repeated units) are still caught. Small patterns at min_count 3–5
  // truncated structured outputs mid-JSON (deterministically, defying retries).
  repetitionDetectionStructured: {
    min_pattern_size: 64,
    max_pattern_size: 64,
    min_count: 4,
  },

  // Visual captioning cost knobs: multipliers on the per-workflow segmentScenes
  // base values (fps / maxWidthPx / maxHeightPx). 1 = 100% (no change),
  // 0.5 = half, 0.25 = quarter. visualCaptionFrequency 0.5 → 0.5 FPS (1 frame
  // every 2 s); visualCaptionQuality 0.5 → half resolution. Applied at config
  // resolution; reaches segment-scenes (--fps/--max-*-px), segment-temporal
  // (--preprocess-*) and the vLLM mm_processor_kwargs consistently.
  visualCaptionFrequency: 0.5, // only 1 frame every 2 seconds
  visualCaptionQuality: 1,

  // Short-clip rule: individual scene clips shorter than 5 s are always
  // processed with at least 1 fps (per-clip, also inside long videos) —
  // visualCaptionFrequency must not starve gesture/action detail on very
  // short clips. Also floors the physical segment-scenes re-encode fps.
  shortClipMaxLengthSec: 5,
  shortClipMinFps: 1,

  // Truncation-bump ceiling for max_tokens (structured callJson + free-form
  // captioning): on finish_reason "length" the budget doubles up to this value
  // (e.g. start 32k → 64k). 65535 ≈ the 64k window the current deployments
  // run with (--max-model-len 65536); the context-length clamp catches any
  // deployment with a smaller window (non-fatal). Per-model override:
  // models[].contextWindows.maxInferenceContext. Default when unset: 65536.
  contextWindows: {
    maxInferenceContext: 65535,//131072,
  },

  models: [
    { // L configuration ASR model
      name: "Whisper3-Large-Turbo-DE",
      type: "asr-api",
      inferenceEngine: "vllm",
      model: "Whisper3-Large-Turbo-DE",
      parallelism: 8,
      maxLengthInSec: 30,
      // OpenAI Audio API (multipart POST /v1/audio/transcriptions)
      asrProtocol: "openai-transcriptions",
    },
    { // M configuration ASR model
      name: "parakeet-primeline-de",
      type: "asr-api",
      inferenceEngine: "custom-openai-compatible",
      model: "Buttermilk03/parakeet-primeline-onnx",
      // 8 → 6: reproducible HTTP 500s on heavy 20s segments under
      // 8x concurrent load (Dornröschen case; parallelism=1 proved clean).
      parallelism: 6,
      maxLengthInSec: 20,
      // OpenAI Audio API (multipart POST /v1/audio/transcriptions)
      asrProtocol: "openai-transcriptions",
    },
    { // S configuration ASR model
      name: "qwen-asr-0.6b",
      type: "asr-api",
      inferenceEngine: "vllm",
      model: "Qwen3-ASR-0.6B",
      parallelism: 8,
      maxLengthInSec: 110,
    },

    // L configuration VLM
    {
      name: "Qwen3.8-27B-FP8",
      type: "api",
      inferenceEngine: "vllm",
      model: "Qwen3.8-27B-FP8",
      defaultPrompt: DEFAULT_IMG_VID_CAPTION_PROMPT,
      //defaultPrompt: "Describe in German. Return JSON.",
      // Creative captioning profile (callWithPrompt): low temperature for faithful
      // German descriptions, mild repetition_penalty to break loops without
      // distorting prose, and a tight max_tokens so a runaway can't grind for
      // minutes. top_k 20 matches Qwen3.8's own examples.
      hyperparams: {
        temperature: 1.0,
        top_p: 0.8,//0.95,
        top_k: 20,
        min_p: 0.0,
        presence_penalty: 1.0,
        frequency_penalty: 0.0,
        repetition_penalty: 1.0,
        max_tokens: 16384,
        // Reproducibility: sampling seed propagated to every VLM request
        // (default 42; override here per model for reproducible runs).
        // Per segment the engine derives seed + sceneIndex: this decorrelates
        // OCR misreads across scenes so the evidence filter can suppress them;
        // runs stay deterministic per config.
        seed: 84,
      },
      parallelism: 6,
      enableThinking: false,
      // structured_outputs mode: grammar-constrained JSON output with schema enforcement.
      // This is the preferred mode for Qwen3.8-27B-FP8 when it works correctly.
      jsonSchemaMode: "structured_outputs",
      // Debug timeout: 5 minutes instead of 20 to detect hangs faster
      requestTimeoutMs: 300_000,
      // Inference-side mm_processor_kwargs: fps=2 is Qwen3.8's recommended
      // default for dynamic scenes; lower to 1 only for long/static clips.
      mmProcessorKwargs: {
        fps: 1,
        do_sample_frames: false,
      },
      // Structured-output (JSON extraction) profile — intentionally distinct from
      // captioning above: low temperature for schema fidelity, tight max_tokens.
      // presence_penalty is zeroed at runtime by applyStructuredSampling (logit-
      // processor conflict with guided decoding); frequency/repetition penalties
      // are applied and per-model configurable here.
      structuredOutput: {
        maxTokens: 16384,
        // 0.75 (model card) → 0.5: long CoT summaries drifted into
        // narrative confabulation (invented names/years in title/keywords, A1).
        // Lowered mildly; loop control stays with repetition_penalty +
        // repetition_detection. Schema validity is grammar-enforced regardless.
        temperature: 0.5,
        maxRetries: 2, // max context window = 65536 tokens; 0. 16k -> 1. 32k -> 2. 64k
        // Structured-call anti-loop sampling (applied by applyStructuredSampling;
        // defaults live in src/lib/structured-output-defaults.ts).
        frequencyPenalty: 0.1,
        repetitionPenalty: 1.05,
      },
      // Per-request-type start windows (max_tokens of attempt 0) for structured
      // calls, derived from live vlm-requests.json measurements. Truncation doubles
      // up to the ceiling (see JSON_MODE_ARCH.md section 6). caption has no
      // key here — free-form captioning is capped by hyperparams.max_tokens.
      contextWindows: {
        aggregation: 32768,
        hoa: 16384,
        summary: 8192,
        // Deployment runs --max-model-len 65536 (KV-cache trade for parallelism 8)
        maxInferenceContext: 65535,
      },
      // Pre-flight input-estimation ratios (live measured, German production
      // text: 1.787 tokens/word; vision ~340 tokens/frame at 640x360).
      estimation: {
        tokensPerWord: 2.0,
        tokensPerFrame: 340,
      },
    },

    // M configuration VLM
    {
      name: "Qwen3.6-35B-A3B-GPTQ-Int4",
      type: "api",
      inferenceEngine: "vllm",
      model: "Qwen3.6-35B-A3B-GPTQ-Int4",
      //defaultPrompt: "Describe in German. Return JSON.",
      defaultPrompt: DEFAULT_IMG_VID_CAPTION_PROMPT,
      hyperparams: {
        temperature: 0.7,
        top_p: 0.95,
        top_k: 20,
        seed: 1337,
        presence_penalty: 1.0,
        frequency_penalty: 0.0,
        repetition_penalty: 1.0,
        max_tokens: 16384,
      },
      mmProcessorKwargs: {
        fps: 1,
        do_sample_frames: false,
      },
      parallelism: 6,
      enableThinking: false,
      // jsonSchemaMode resolved by the model-name registry (qwen3 → structured_outputs).
      // Structured-output sampling follows Qwen's documented non-thinking profile
      // (load ablation under 8x concurrent load: wire defaults 4/8 bad, this
      // profile 8/8 clean). Other models keep the established defaults.
      structuredOutput: {
        maxTokens: 16384,
        // 0.7 (model card) → 0.5: same narrative-confabulation
        // driver as the 27B (invented names/years in long CoT summaries, A1).
        // Loop control stays with presencePenalty 1.6 (Qwen's documented
        // structured-output loop control, load-ablated) — unchanged.
        temperature: 0.5,
        maxRetries: 2,
        frequencyPenalty: 0.0,
        repetitionPenalty: 1.0,
        presencePenalty: 1.6,
        topP: 0.8,
        topK: 20,
      },
      // Per-request-type start windows (see Qwen3.8-27B-FP8 comment above).
      contextWindows: {
        aggregation: 32768,
        hoa: 32768,
        summary: 8192,
        // Deployment runs --max-model-len 65536 (KV-cache trade for parallelism 8)
        maxInferenceContext: 65535,
      },
      estimation: {
        tokensPerWord: 2.0,
        tokensPerFrame: 340,
      },
    },

    // S configuration VLM
    {
      name: "gemma4-e4b-qat-w4a16",
      type: "api",
      inferenceEngine: "vllm",
      model: "gemma-4-E4B-it-qat-w4a16-ct", // muss 1:1 übereinstimmen mit .env.local
      defaultPrompt: DEFAULT_IMG_VID_CAPTION_PROMPT,
      //defaultPrompt: "Describe in German.",
      // jsonSchemaMode resolved by the model-name registry (gemma4 → response_format).
      hyperparams: {
        temperature: 1.0,
        top_p: 0.95,
        top_k: 64,
        seed: 31337,
        presence_penalty: 0.0,
        repetition_penalty: 1.0,
        max_tokens: 8192, // caption start window 8k
      },
      mmProcessorKwargs: {
        // diese Parameter betreffen vLLM und rufen dort NOCHMAL ein transcoding auf (ffmpeg)
        fps: 1,
        do_sample_frames: false,
      },
      parallelism: 4,
      enableThinking: false,
      structuredOutput: {
        maxTokens: 16384,
        temperature: 0.75,
        maxRetries: 2, // max context window = 65536 tokens; 0. 16k -> 1. 32k -> 2. 64k
        frequencyPenalty: 0.1,
        repetitionPenalty: 1.05,
        // Qwen non-thinking profile extras (load ablation): gemma4 degenerated
        // with whitespace runs under near-greedy sampling (top_p 0.1/top_k 1) —
        // 18 detector catches in one A1 file; profile targets the root cause.
        presencePenalty: 1.5,
        topP: 0.8,
        topK: 20,
      },
      // Per-request-type start windows (see Qwen3.8-27B-FP8 comment above).
      contextWindows: {
        aggregation: 32768,
        hoa: 16384,
        summary: 8192,
        // Deployment runs --max-model-len 65536
        maxInferenceContext: 65535,
      },
      // Pre-flight input-estimation ratios (measured: 1.794 tokens/word).
      estimation: {
        tokensPerWord: 2.0,
        tokensPerFrame: 340,
      },
    },
  ],

  workflows: [

    // ===== DEFAULT ANALYSIS =====

    // L configuration
    {
      name: "default-analysis",
      description: "Default workflow: scene captioning + speech transcription per clip followed by semantic aggregation of clips and video title, summary and keyword analysis over all clip aggregations",
      preProcessing: {
        segmentTemporal: true,
        // Object form: tune scene segmentation for the video model's
        // limits. Omitting a key falls back to the segment-scenes CLI default.
        segmentScenes: {
          enabled: true,
          fps: 1,
          doSampleFrames: false,
          maxLengthPerClipInSecs: 60,
          maxWidthPx: 608,
          maxHeightPx: 448,
        },
      },
      processing: [
        {
          mediaType: "scene",
          modelName: "Qwen3.8-27B-FP8", //"Qwen3.6-35B-A3B-GPTQ-Int4"
          prompt: "Describe the video in German.", // TODO: use DEFAULT_IMG_VID_CAPTION_PROMPT here!
          outputKey: "caption",
          enabled: true,
          enableThinking: false,
          // TODO: does not work here
          includeAudioContext: true,      // Inject audio transcripts into prompt
          includePreviousCaption: true,   // Inject previous scene caption for relationship labeling
        },
        {
          mediaType: "speech",
          modelName: "Whisper3-Large-Turbo-DE",
          prompt: "",
          outputKey: "transcription",
          enabled: true,
        },
        {
          // Default-disabled (opt-in via wizard checkbox or CLI override).
          // Runs unconditionally for single-image input (an image IS its own
          // keyframe); for videos, enabledAsFallback captions only keyframes
          // whose parent scene has no valid caption (e.g. scenes < 1s).
          mediaType: "keyframe",
          modelName: "Qwen3.8-27B-FP8",
          prompt: "Describe the image in German.",
          outputKey: "caption",
          enabled: false,
          enabledAsFallback: true,
          enableThinking: false,
        },
      ],
      postProcessing: [
        {
          name: "default",
          description: "Default plugin: semantic aggregation, per-slice analysis, whole-video summary",
          importPath: "./plugins/default.ts",
          enabled: true,
          config: {
            modelName: "Qwen3.8-27B-FP8",
            maxConcurrency: 8,
            includeTypes: ["scene", "speech"],
            reanalyzeVideoForAggregation: false,
          },
        },
      ],
      outputFormat: "json",
    },

    // M configuration
    {
      name: "default-analysis-35b",
      description: "Default workflow: scene captioning + speech transcription per clip followed by semantic aggregation of clips and video title, summary and keyword analysis over all clip aggregations",
      preProcessing: {
        segmentTemporal: true,
        // Object form: tune scene segmentation for the video model's
        // limits. Omitting a key falls back to the segment-scenes CLI default.
        segmentScenes: {
          enabled: true,
          fps: 1,
          doSampleFrames: false,
          maxLengthPerClipInSecs: 60,
          maxWidthPx: 608,
          maxHeightPx: 448,
        },
      },
      processing: [
        {
          mediaType: "scene",
          modelName: "Qwen3.6-35B-A3B-GPTQ-Int4", //"Qwen3.8-27B-FP8"
          prompt: "Describe the video in German.",
          outputKey: "caption",
          enabled: true,
          enableThinking: false,
          // TODO: does not work here
          includeAudioContext: true,      // Inject audio transcripts into prompt
          includePreviousCaption: true,   // Inject previous scene caption for relationship labeling
        },
        {
          mediaType: "speech",
          modelName: "parakeet-primeline-de",
          prompt: "",
          outputKey: "transcription",
          enabled: true,
        },
        {
          // Default-disabled (opt-in via wizard checkbox or CLI override).
          // Runs unconditionally for single-image input (an image IS its own
          // keyframe); for videos, enabledAsFallback captions only keyframes
          // whose parent scene has no valid caption (e.g. scenes < 1s).
          mediaType: "keyframe",
          modelName: "Qwen3.6-35B-A3B-GPTQ-Int4",
          prompt: "Describe the image in German.",
          outputKey: "caption",
          enabled: false,
          enabledAsFallback: true,
          enableThinking: false,
        },
      ],
      postProcessing: [
        {
          name: "default",
          description: "Default plugin: semantic aggregation, per-slice analysis, whole-video summary",
          importPath: "./plugins/default.ts",
          enabled: true,
          config: {
            modelName: "Qwen3.6-35B-A3B-GPTQ-Int4", //"Qwen3.8-27B-FP8",
            maxConcurrency: 8,
            includeTypes: ["scene", "speech"],
            reanalyzeVideoForAggregation: false,
          },
        },
      ],
      outputFormat: "json",
    },

    // S configuration
    {
      name: "default-analysis-gemma4-e4b",
      description: "Default workflow (gemma4-e4b variant): scene captioning + speech transcription per clip followed by semantic aggregation of clips and video title, summary and keyword analysis over all clip aggregations",
      preProcessing: {
        segmentTemporal: true,
        segmentScenes: {
          enabled: true,
          fps: 1,
          doSampleFrames: false,
          maxLengthPerClipInSecs: 60,
          maxWidthPx: 528,
          maxHeightPx: 288,
          seed: 31337,
        },
      },
      processing: [
        {
          mediaType: "scene",
          modelName: "gemma4-e4b-qat-w4a16",
          prompt: "Describe the video in German.",
          outputKey: "caption",
          enabled: true,
          enableThinking: false,
          includeAudioContext: true,      // Inject audio transcripts into prompt
          includePreviousCaption: true,   // Inject previous scene caption for relationship labeling
        },
        {
          mediaType: "speech",
          modelName: "qwen-asr-0.6b",
          prompt: "",
          outputKey: "transcription",
          enabled: true,
        },
        {
          // Default-disabled (opt-in via wizard checkbox or CLI override).
          // Runs unconditionally for single-image input (an image IS its own
          // keyframe); for videos, enabledAsFallback captions only keyframes
          // whose parent scene has no valid caption (e.g. scenes < 1s).
          mediaType: "keyframe",
          modelName: "gemma4-e4b-qat-w4a16",
          prompt: "Describe the image in German.",
          outputKey: "caption",
          enabled: false,
          enabledAsFallback: true,
          enableThinking: false,
        },
      ],
      postProcessing: [
        {
          name: "default",
          description: "Default plugin: semantic aggregation, per-slice analysis, whole-video summary",
          importPath: "./plugins/default.ts",
          enabled: true,
          config: {
            modelName: "gemma4-e4b-qat-w4a16",
            maxConcurrency: 4,
            includeTypes: ["scene", "speech"],
            reanalyzeVideoForAggregation: false,
          },
        },
      ],
      outputFormat: "json",
    },

  ],
} as ArchivarConfig;

setArchivarConfig(config);
