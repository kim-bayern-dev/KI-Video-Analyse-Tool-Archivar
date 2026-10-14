/**
 * Pre-flight input-token estimation for context budgeting.
 *
 * The budget formula applied before every wire request (callWithPrompt and
 * callJson attempts):
 *
 *   inputEst  = words(prompt + systemPrompt) × tokensPerWord(model)
 *             + mediaTokens(mediaCategory, mmProcessorKwargs, tokensPerFrame(model))
 *   budgetCap = resolveMaxInferenceContext(model) − inputEst − CONTEXT_MARGIN_TOKENS
 *   max_tokens = min(plannedStep, budgetCap) — floored at MIN_OUTPUT_TOKENS
 *
 * Estimation deliberately OVERestimates (safe direction: a smaller budget is
 * recovered by the truncation ladder; an undersized estimate costs a 400).
 * Ratios are per-model config (`ModelConfig.estimation`) calibrated against
 * the live tokenizers (German production text: 1.79–1.80 tokens/word measured;
 * vision ≈340 tokens/frame at ~640×360 from vlm-requests). See
 * JSON_MODE_ARCH.md section 6.
 */

/** tokens/word default — measured 1.79–1.80, +11% safety (see module header). */
export const DEFAULT_TOKENS_PER_WORD = 2.0;
/** vision tokens per frame default (Qwen3VL at ~640×360; other models: tune). */
export const DEFAULT_TOKENS_PER_FRAME = 340;
/** safety margin subtracted from the model's window on top of the estimate. */
export const CONTEXT_MARGIN_TOKENS = 1024;
/** lower bound for the capped output budget (below it the reactive path runs). */
export const MIN_OUTPUT_TOKENS = 1024;
/** upper-bound clip length for fps-based frame estimation (maxLengthPerClipInSecs). */
const MAX_CLIP_SECS = 60;

export interface ModelEstimation {
  tokensPerWord: number;
  tokensPerFrame: number;
}

/** words × perWord — whitespace-split; punctuation attached to words is fine
 *  (the per-model ratio was measured the same way). */
export function estimateTextTokens(text: string, tokensPerWord: number): number {
  if (!text) return 0;
  return Math.ceil(text.split(/\s+/).filter(Boolean).length * tokensPerWord);
}

/**
 * Estimated vision tokens for one media input.
 * video: num_frames when set, else fps × MAX_CLIP_SECS (upper bound — short
 * clips are overestimated deliberately); image: one frame; audio: 0.
 */
export function estimateMediaTokens(
  mediaCategory: "audio" | "video" | "image",
  mmProcessorKwargs: Record<string, unknown> | undefined,
  tokensPerFrame: number,
): number {
  if (mediaCategory === "audio") return 0;
  if (mediaCategory === "image") return tokensPerFrame;
  const numFrames = mmProcessorKwargs?.num_frames as number | undefined;
  const fps = (mmProcessorKwargs?.fps as number | undefined) ?? 1;
  const frames = numFrames !== undefined ? numFrames : Math.max(1, Math.ceil(fps * MAX_CLIP_SECS));
  return Math.ceil(frames * tokensPerFrame);
}

/**
 * Compute the output-token budget cap for a request. Returns at least
 * MIN_OUTPUT_TOKENS — below that the prompt alone exceeds the window and the
 * reactive clamp path (frame/output halving) has to deal with it.
 */
export function budgetCapForModel(
  maxInferenceContext: number,
  estimation: ModelEstimation,
  prompt: string,
  systemPrompt: string | undefined,
  mediaCategory: "audio" | "video" | "image",
  mmProcessorKwargs: Record<string, unknown> | undefined,
): number {
  const inputEst =
    estimateTextTokens(systemPrompt ? `${systemPrompt} ${prompt}` : prompt, estimation.tokensPerWord) +
    estimateMediaTokens(mediaCategory, mmProcessorKwargs, estimation.tokensPerFrame);
  return Math.max(MIN_OUTPUT_TOKENS, maxInferenceContext - inputEst - CONTEXT_MARGIN_TOKENS);
}
