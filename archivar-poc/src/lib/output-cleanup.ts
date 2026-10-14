/**
 * Robust removal of pre-processing output folders.
 *
 * Output folders are written by the segmentation tools' Docker containers as
 * root, so the dev-server user cannot delete them with plain fs calls
 * (EACCES on the root-owned subdirectories). Clear-cache/force paths that
 * ignore this silently leave STALE segments behind; the next run's file
 * discovery then globs stale + fresh files together (duplicated speech
 * segments, mixed generations).
 *
 * Strategy: try fs removal first (works when ownership allows), then fall
 * back to a throwaway Docker container (the deployment runs the tools in
 * Docker, so the docker group is the sanctioned privilege path). The image
 * only provides `rm` — any local image works; override with
 * ARCHIVAR_CLEANUP_IMAGE.
 */

import { rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename, dirname } from "node:path";

export interface DirRemovalResult {
  ok: boolean;
  via: "fs" | "docker" | "none";
  error?: string;
}

const CLEANUP_IMAGE = process.env.ARCHIVAR_CLEANUP_IMAGE ?? "segment-scenes:latest";
const DOCKER_TIMEOUT_MS = 120_000;

function dockerRm(absPath: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolveP) => {
    const parent = dirname(absPath);
    const target = basename(absPath);
    const child = spawn(
      "docker",
      // --entrypoint rm: tool images default to their python CLI entrypoint,
      // which would receive the rm args and fail.
      ["run", "--rm", "--entrypoint", "rm", "-v", `${parent}:/data`, CLEANUP_IMAGE, "-rf", "--", `/data/${target}`],
      { shell: false, stdio: ["ignore", "pipe", "pipe"] },
    );
    let err = "";
    child.stderr.on("data", (d) => { err += d.toString(); });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolveP({ ok: false, error: `docker rm timed out after ${DOCKER_TIMEOUT_MS}ms` });
    }, DOCKER_TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolveP({ ok: false, error: `docker failed to start: ${e.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveP(code === 0
        ? { ok: true }
        : { ok: false, error: `docker rm exited ${code}: ${err.trim().slice(0, 300)}` });
    });
  });
}

/**
 * Remove a directory tree, escalating to a Docker-based removal when fs
 * removal fails (root-owned tool outputs). Never throws.
 */
export async function removeDirectoryRobust(absPath: string): Promise<DirRemovalResult> {
  try {
    rmSync(absPath, { recursive: true, force: true });
    return { ok: true, via: "fs" };
  } catch (fsErr) {
    const fsMsg = fsErr instanceof Error ? fsErr.message : String(fsErr);
    const dockerResult = await dockerRm(absPath);
    if (dockerResult.ok) return { ok: true, via: "docker" };
    return {
      ok: false,
      via: "none",
      error: `fs removal failed (${fsMsg}); docker removal failed (${dockerResult.error}). ` +
        `Remove manually: sudo rm -rf ${absPath}`,
    };
  }
}
