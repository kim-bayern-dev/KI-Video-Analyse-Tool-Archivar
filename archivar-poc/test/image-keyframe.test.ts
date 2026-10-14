import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { computeImageKeyframeHash, convertImageToKeyframePng } from "../src/lib/image-keyframe.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let tmp: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "image-keyframe-"));
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const makeSolid = (width: number, height: number, background = { r: 10, g: 120, b: 200 }) =>
  sharp({ create: { width, height, channels: 3, background } });

describe("convertImageToKeyframePng", () => {
  it("converts JPEG to PNG", async () => {
    const src = join(tmp, "in.jpg");
    await makeSolid(100, 80).jpeg().toFile(src);
    const dest = join(tmp, "nested", "scene_keyframes", "0_0_0.png"); // parent dirs are created
    const { width, height } = await convertImageToKeyframePng(src, dest);
    const meta = await sharp(dest).metadata();
    expect(meta.format).toBe("png");
    expect(width).toBe(100);
    expect(height).toBe(80);
  });

  it("resizes shrink-only into the max box, preserving aspect ratio", async () => {
    const src = join(tmp, "big.png");
    await makeSolid(2000, 1000).png().toFile(src);
    const { width, height } = await convertImageToKeyframePng(src, join(tmp, "big-out.png"), 608, 448);
    expect(width).toBe(608); // min(608/2000, 448/1000) = 0.304 → 608x304
    expect(height).toBe(304);
  });

  it("does not enlarge images smaller than the max box", async () => {
    const src = join(tmp, "small.png");
    await makeSolid(382, 377).png().toFile(src);
    const { width, height } = await convertImageToKeyframePng(src, join(tmp, "small-out.png"), 608, 448);
    expect(width).toBe(382);
    expect(height).toBe(377);
  });

  it("bakes EXIF orientation into pixels and strips metadata", async () => {
    const src = join(tmp, "oriented.jpg");
    await makeSolid(200, 100).jpeg().withMetadata({ orientation: 6 }).toFile(src);
    const dest = join(tmp, "oriented-out.png");
    const { width, height } = await convertImageToKeyframePng(src, dest);
    expect(width).toBe(100); // rotated 90°: dimensions swapped
    expect(height).toBe(200);
    const meta = await sharp(dest).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
  });

  it("re-encodes without resize when no max dimensions are given", async () => {
    const src = join(tmp, "unbounded.png");
    await makeSolid(2000, 1000).png().toFile(src);
    const { width, height } = await convertImageToKeyframePng(src, join(tmp, "unbounded-out.png"));
    expect(width).toBe(2000);
    expect(height).toBe(1000);
  });

  it("fails with an actionable error on non-image input", async () => {
    const src = join(tmp, "not-an-image.bin");
    writeFileSync(src, Buffer.from("definitely not an image"));
    await expect(convertImageToKeyframePng(src, join(tmp, "never.png"))).rejects.toThrow(
      /Failed to convert image to keyframe PNG/,
    );
  });
});

describe("computeImageKeyframeHash", () => {
  it("is stable per input and changes with content or dimensions", async () => {
    const a = join(tmp, "a.png");
    const b = join(tmp, "b.png");
    await makeSolid(10, 10, { r: 1, g: 1, b: 1 }).png().toFile(a);
    await makeSolid(10, 10, { r: 2, g: 2, b: 2 }).png().toFile(b);

    const h1 = await computeImageKeyframeHash(a, 608, 448);
    expect(h1).toMatch(/^[0-9a-f]{16}$/);
    expect(await computeImageKeyframeHash(a, 608, 448)).toBe(h1); // deterministic
    expect(await computeImageKeyframeHash(b, 608, 448)).not.toBe(h1); // content-sensitive
    expect(await computeImageKeyframeHash(a, 304, 224)).not.toBe(h1); // dimension-sensitive
  });
});
