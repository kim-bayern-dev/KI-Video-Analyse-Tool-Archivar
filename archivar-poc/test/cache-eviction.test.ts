import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Tests for cache/outputs eviction (Phase 3.1).
 *
 * Verifies that clearFileCache removes the `.archivar` debug directory and the
 * `.workflow.json` per-file config in addition to out_* folders and cache
 * entries, and that deleteFile removes the source too.
 *
 * A real temp directory is used as the data dir so genuine filesystem
 * operations are exercised end-to-end.
 */

describe("eviction: debug artifacts + workflow config", () => {
  let dataDir: string;
  let FileApiCtor: typeof import("../src/rpc/file-api").FileApi;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "archivar-evict-"));
    // Point the data dir resolution at our temp dir by using an absolute path
    // for RELATIVE_SAMPLE_DATA_PATH (resolve(cwd, <abs>) === <abs>).
    process.env.RELATIVE_SAMPLE_DATA_PATH = dataDir;
    process.env.SAMPLE_DATA_SUBDIR = "";

    vi.resetModules();
    const mod = await import("../src/rpc/file-api");
    FileApiCtor = mod.FileApi;
  });

  afterEach(() => {
    delete process.env.RELATIVE_SAMPLE_DATA_PATH;
    delete process.env.SAMPLE_DATA_SUBDIR;
    if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
  });

  it("clearFileCache removes out_ folder, .archivar debug dir, and .workflow.json", async () => {
    const fileName = "video.mp4";
    const fileAbs = resolve(dataDir, fileName);

    // Source file
    writeFileSync(fileAbs, "fake");
    // Output folder (provides the outputHash used for cache purge)
    const hash = "deadbeef";
    const outDir = join(dataDir, `out_video_mp4_${hash}`);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "segments.txt"), "x");
    // Debug artifact directory
    const debugDir = join(dataDir, `${fileName}.archivar`);
    mkdirSync(debugDir, { recursive: true });
    writeFileSync(join(debugDir, "debug.log"), "logs");
    writeFileSync(join(debugDir, "debug.json"), "{}");
    // Per-file workflow config
    const wfConfig = join(dataDir, `${fileName}.workflow.json`);
    writeFileSync(wfConfig, "{}");

    const api = new FileApiCtor();
    const result = await api.clearFileCache(fileName);

    expect(result.status).toBe("cleared");
    expect(typeof result.removed).toBe("number");
    // Source file preserved
    expect(existsSync(fileAbs)).toBe(true);
    // Output folder removed
    expect(existsSync(outDir)).toBe(false);
    // Debug artifacts removed
    expect(existsSync(debugDir)).toBe(false);
    // Workflow config removed
    expect(existsSync(wfConfig)).toBe(false);
  });

  it("clearFileCache does not error when artifacts never existed", async () => {
    const fileName = "bare.mp4";
    writeFileSync(resolve(dataDir, fileName), "fake");
    const outDir = join(dataDir, `out_bare_mp4_abc123`);
    mkdirSync(outDir, { recursive: true });

    const api = new FileApiCtor();
    const result = await api.clearFileCache(fileName);

    expect(result.status).toBe("cleared");
  });

  it("deleteFile removes source file along with artifacts", async () => {
    const fileName = "del.mp4";
    const fileAbs = resolve(dataDir, fileName);
    writeFileSync(fileAbs, "fake");
    mkdirSync(join(dataDir, `out_del_mp4_ff00ff`), { recursive: true });
    mkdirSync(join(dataDir, `${fileName}.archivar`), { recursive: true });
    writeFileSync(join(dataDir, `${fileName}.workflow.json`), "{}");

    const api = new FileApiCtor();
    const result = await api.deleteFile(fileName);

    expect(result.status).toBe("deleted");
    expect(existsSync(fileAbs)).toBe(false);
    expect(existsSync(join(dataDir, `${fileName}.archivar`))).toBe(false);
    expect(existsSync(join(dataDir, `${fileName}.workflow.json`))).toBe(false);
  });
});
