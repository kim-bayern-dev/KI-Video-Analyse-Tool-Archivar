/**
 * StatusApi - Per-file workflow status management.
 *
 * Manages .archivar/status.json files that track workflow state for each file.
 * This enables polling-based status checking from CLI, API routes, and UI.
 *
 * Status file structure:
 * {
 *   status: "processing" | "done" | "error",
 *   file: string,
 *   workflow?: string,
 *   startedAt: string,        // ISO timestamp
 *   heartbeatAt?: string,     // ISO timestamp, refreshed while the workflow is alive
 *   completedAt?: string,    // ISO timestamp when done
 *   error?: string,          // Error message if status === "error"
 *   webHookUrl?: string,     // URL to call when done
 *   webHookDelivered?: boolean
 * }
 *
 * Liveness: a running workflow refreshes `heartbeatAt` via a module-level
 * interval (HEARTBEAT_INTERVAL_MS). Readers treat a "processing" status whose
 * last heartbeat is older than STALE_AFTER_MS as dead (killed, crashed, or the
 * server was restarted) and transition it to "error" once, persistently.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";
import { getEnv } from "defuss-env";
import glob from "fast-glob";
import { resolveWorkflowModels } from "../lib/archivar-config.js";

/**
 * Persisted shape of <file>.archivar/status.json. Readers must tolerate
 * absent optional fields — files written by older versions may lack them.
 */
export interface StatusFile {
  status: "processing" | "done" | "error";
  file: string;
  workflow?: string;
  /** Resolved VLM/ASR model names, recorded at workflow start for exports. */
  models?: { asr?: string; vlm?: string };
  startedAt: string;
  heartbeatAt?: string;
  completedAt?: string;
  error?: string;
  webHookUrl?: string;
  webHookDelivered?: boolean;
}

/** How often a live workflow's status.json heartbeat is refreshed. */
export const HEARTBEAT_INTERVAL_MS = 15_000;
/** A "processing" status with no heartbeat for this long is considered dead. */
export const STALE_AFTER_MS = 180_000;

// Module-level heartbeat registry: one shared interval refreshes heartbeatAt
// for every status file with an in-flight workflow in THIS process. If the
// process dies (ctrl+c, kill, crash), heartbeats stop and readers flag the
// status as stale after STALE_AFTER_MS.
const heartbeatRegistry = new Map<string, StatusApi>();
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function registerHeartbeat(statusPath: string, api: StatusApi): void {
  heartbeatRegistry.set(statusPath, api);
  if (!heartbeatTimer) {
    heartbeatTimer = setInterval(() => {
      for (const [path, api] of heartbeatRegistry) {
        api.touchHeartbeat(path);
      }
    }, HEARTBEAT_INTERVAL_MS);
    // Never keep the process alive just for heartbeats.
    heartbeatTimer.unref?.();
  }
}

function unregisterHeartbeat(statusPath: string): void {
  heartbeatRegistry.delete(statusPath);
  if (heartbeatRegistry.size === 0 && heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

export class StatusApi {
  /**
   * Get the .archivar directory path for a given file.
   */
  // REFACTOR(dry): this .archivar-dir resolution is implemented three times —
  // here, webhook-api.ts:44 and export.ts:93 — extract one shared helper.
  private getArchivarDir(filePath: string): string {
    const sampleDataSubDir = getEnv("SAMPLE_DATA_SUBDIR", "sample_data/archivar");
    const relativeSampleDataPath = getEnv("RELATIVE_SAMPLE_DATA_PATH", `../${sampleDataSubDir}`);
    const dataDir = resolve(process.cwd(), relativeSampleDataPath);

    // Resolve file path safely using basename to prevent path traversal
    const safeName = basename(filePath);
    const fullPath = resolve(dataDir, safeName);
    const parentDir = dirname(fullPath);
    return resolve(parentDir, `${safeName}.archivar`);
  }

  /**
   * Get the status file path for a given file.
   */
  private getStatusPath(filePath: string): string {
    return resolve(this.getArchivarDir(filePath), "status.json");
  }

  /**
   * Transition a "processing" status to "error" when its heartbeat is older
   * than STALE_AFTER_MS (the workflow process died or was cancelled).
   * Persisted so the transition happens exactly once.
   */
  private applyStaleTransition(filePath: string, status: StatusFile): StatusFile {
    if (status.status !== "processing") return status;
    const lastBeat = Date.parse(status.heartbeatAt ?? status.startedAt ?? "");
    if (Number.isNaN(lastBeat)) return status;
    const ageMs = Date.now() - lastBeat;
    if (ageMs <= STALE_AFTER_MS) return status;
    const stale: StatusFile = {
      ...status,
      status: "error",
      completedAt: new Date().toISOString(),
      error: `stale: no heartbeat for ${Math.round(ageMs / 60_000)}m — workflow process died or was cancelled`,
    };
    try {
      this.setStatus(filePath, stale);
    } catch {
      // Keep the in-memory verdict even if the persist failed.
    }
    return stale;
  }

  /**
   * Get status for a file. Returns null if no status file exists.
   * VLM/ASR model names are enriched at read time from the workflow
   * definition when the run predates model recording (never persisted).
   */
  public getStatus(filePath: string): StatusFile | null {
    const statusPath = this.getStatusPath(filePath);

    if (!existsSync(statusPath)) {
      return null;
    }

    try {
      const content = readFileSync(statusPath, "utf-8");
      const status = this.applyStaleTransition(filePath, JSON.parse(content) as StatusFile);
      if (status.workflow && (!status.models?.vlm || !status.models?.asr)) {
        const resolved = resolveWorkflowModels(status.workflow);
        status.models = {
          vlm: status.models?.vlm ?? resolved.vlm,
          asr: status.models?.asr ?? resolved.asr,
        };
      }
      return status;
    } catch (err) {
      console.error(`[StatusApi] Failed to read status file: ${statusPath}`, err);
      return null;
    }
  }

  /**
   * Set status for a file. Creates .archivar directory and status.json if needed.
   */
  public setStatus(filePath: string, status: StatusFile): void {
    const statusPath = this.getStatusPath(filePath);
    const archivarDir = dirname(statusPath);

    // Ensure .archivar directory exists
    if (!existsSync(archivarDir)) {
      mkdirSync(archivarDir, { recursive: true });
    }

    try {
      writeFileSync(statusPath, JSON.stringify(status, null, 2), "utf-8");
    } catch (err) {
      console.error(`[StatusApi] Failed to write status file: ${statusPath}`, err);
      throw err;
    }
  }

  /**
   * Create initial "processing" status for a file when analyze is called.
   * Called immediately when runWorkflow is invoked, before async execution starts.
   */
  public startProcessing(filePath: string, workflow?: string, webHookUrl?: string, models?: { asr?: string; vlm?: string }): StatusFile {
    const now = new Date().toISOString();
    const status: StatusFile = {
      status: "processing",
      file: filePath,
      workflow,
      models,
      startedAt: now,
      heartbeatAt: now,
      webHookUrl,
      webHookDelivered: false,
    };
    this.setStatus(filePath, status);
    registerHeartbeat(this.getStatusPath(filePath), this);

    // REFACTOR(dry): webhook bookkeeping is stored twice — in status.json
    // (webHookUrl/webHookDelivered above) and in webhook.json below; the delivery
    // logic (WebhookApi) reads only webhook.json, and markWebhookDelivered has no
    // callers, so the status.json copies are write-only. Keep one store.
    // Also create webhook.json if a webhook URL is provided
    if (webHookUrl) {
      const webhookPath = resolve(this.getArchivarDir(filePath), "webhook.json");
      const webhookDir = dirname(webhookPath);
      if (!existsSync(webhookDir)) {
        mkdirSync(webhookDir, { recursive: true });
      }
      writeFileSync(webhookPath, JSON.stringify({ url: webHookUrl, delivered: false }, null, 2), "utf-8");
    }

    return status;
  }

  /**
   * Refresh heartbeatAt for a live workflow. No-op when the status file is
   * gone or no longer "processing" (never resurrects a finished/failed run).
   * Called by the module-level heartbeat interval.
   */
  public touchHeartbeat(statusPath: string): void {
    try {
      const status = JSON.parse(readFileSync(statusPath, "utf-8")) as StatusFile;
      if (status.status !== "processing") return;
      writeFileSync(
        statusPath,
        JSON.stringify({ ...status, heartbeatAt: new Date().toISOString() }, null, 2),
        "utf-8",
      );
    } catch {
      // Status file missing or unparseable — nothing to beat.
    }
  }

  /**
   * Mark workflow as completed successfully.
   */
  public markDone(filePath: string): void {
    unregisterHeartbeat(this.getStatusPath(filePath));
    const current = this.getStatus(filePath);
    if (!current) {
      console.warn(`[StatusApi] No status file found for ${filePath}, cannot mark done`);
      return;
    }
    const updated: StatusFile = {
      ...current,
      status: "done",
      completedAt: new Date().toISOString(),
    };
    this.setStatus(filePath, updated);
  }

  /**
   * Mark workflow as failed with an error message.
   */
  public markError(filePath: string, error: string): void {
    unregisterHeartbeat(this.getStatusPath(filePath));
    const current = this.getStatus(filePath);
    if (!current) {
      console.warn(`[StatusApi] No status file found for ${filePath}, cannot mark error`);
      return;
    }
    const updated: StatusFile = {
      ...current,
      status: "error",
      completedAt: new Date().toISOString(),
      error,
    };
    this.setStatus(filePath, updated);
  }

  /**
   * List all known task statuses (one per `<file>.archivar/status.json`),
   * optionally filtered by status. Sorted by startedAt descending (newest first).
   */
  public async listStatuses(statusFilter?: StatusFile["status"]): Promise<StatusFile[]> {
    const sampleDataSubDir = getEnv("SAMPLE_DATA_SUBDIR", "sample_data/archivar");
    const relativeSampleDataPath = getEnv("RELATIVE_SAMPLE_DATA_PATH", `../${sampleDataSubDir}`);
    const dataDir = resolve(process.cwd(), relativeSampleDataPath);

    const statusPaths = await glob.async("*.archivar/status.json", {
      cwd: dataDir,
      absolute: true,
      deep: 2,
    });

    const statuses: StatusFile[] = [];
    for (const statusPath of statusPaths) {
      try {
        const status = JSON.parse(readFileSync(statusPath, "utf-8")) as StatusFile;
        const effective = this.applyStaleTransition(status.file, status);
        if (!statusFilter || effective.status === statusFilter) {
          statuses.push(effective);
        }
      } catch {
        // skip unparseable status files
      }
    }

    return statuses.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
  }

  /**
   * Mark webhook as delivered (so it won't be called again).
   */
  public markWebhookDelivered(filePath: string): void {
    const current = this.getStatus(filePath);
    if (!current) {
      return;
    }
    const updated: StatusFile = {
      ...current,
      webHookDelivered: true,
    };
    this.setStatus(filePath, updated);
  }

  /**
   * Clear (delete) status for a file.
   */
  public clearStatus(filePath: string): void {
    unregisterHeartbeat(this.getStatusPath(filePath));
    const statusPath = this.getStatusPath(filePath);

    if (existsSync(statusPath)) {
      try {
        rmSync(statusPath, { force: true });
      } catch (err) {
        console.error(`[StatusApi] Failed to delete status file: ${statusPath}`, err);
      }
    }
  }
}
