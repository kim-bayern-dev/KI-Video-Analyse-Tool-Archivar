import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import sharp from "sharp";

/**
 * Single-image input support: an image file is analyzed as exactly one
 * keyframe. These helpers produce the on-disk keyframe artifact
 * (out_<name>_<ext>_<hash>/scene_keyframes/0_0_0.png) that the regular
 * keyframe pipeline then consumes — the image analog of what the external
 * segment-scenes tool produces for videos.
 */

/**
 * Content-based output-folder hash for image inputs (16 hex chars of sha256
 * over file bytes + effective pixel limits). Images get no hash from the
 * external segmentation tools (they never run for images); without one, every
 * image shares outputHash=null and their per-segment/aggregated cache keys
 * collide across different files.
 */
export async function computeImageKeyframeHash(
  absPath: string,
  maxWidthPx?: number,
  maxHeightPx?: number,
): Promise<string> {
  const content = await readFile(absPath);
  return createHash("sha256")
    .update(content)
    .update(`:${maxWidthPx ?? ""}x${maxHeightPx ?? ""}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Convert any sharp-readable image to the pipeline's keyframe PNG.
 * Equivalent to `convert <src> -auto-orient -resize '<W>x<H>>' -strip PNG32:<dest>`:
 * - .rotate() bakes EXIF orientation into the pixels (-auto-orient)
 * - fit "inside" + withoutEnlargement = shrink-only 'WxH>' (no resize when no max given)
 * - sharp drops all metadata by default (-strip) and keeps alpha (PNG32)
 *
 * Always re-encodes, even for PNG inputs: the VLM's pixel budget applies
 * regardless of source format.
 *
 * @returns Output pixel dimensions (after orientation + resize).
 */
export async function convertImageToKeyframePng(
  srcAbsPath: string,
  destAbsPath: string,
  maxWidthPx?: number,
  maxHeightPx?: number,
): Promise<{ width: number; height: number }> {
  mkdirSync(dirname(destAbsPath), { recursive: true });
  let pipeline = sharp(srcAbsPath).rotate();
  if (maxWidthPx !== undefined || maxHeightPx !== undefined) {
    pipeline = pipeline.resize({
      width: maxWidthPx,
      height: maxHeightPx,
      fit: "inside",
      withoutEnlargement: true,
    });
  }
  try {
    const info = await pipeline.png().toFile(destAbsPath);
    return { width: info.width, height: info.height };
  } catch (err) {
    throw new Error(
      `Failed to convert image to keyframe PNG: ${srcAbsPath} — ${err instanceof Error ? err.message : err}`,
    );
  }
}
