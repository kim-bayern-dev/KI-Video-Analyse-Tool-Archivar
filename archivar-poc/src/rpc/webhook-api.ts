/**
 * WebhookApi - Webhook delivery management.
 *
 * Handles delivery of webhooks when workflows complete.
 * Webhook is called exactly once with the workflow result.
 *
 * The webhook URL is stored in .archivar/webhook.json before workflow starts,
 * and deleted after successful delivery.
 */

import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";
import { getEnv } from "defuss-env";
import { listExports, type ExportMap } from "./export.js";

const WEBHOOK_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1_000;

/**
 * POST body delivered to the caller's webhook URL on workflow completion.
 * `result` is the workflow's debug.json verbatim, or an `{ error }` placeholder
 * when debug.json is missing/unreadable — delivery is attempted regardless, so
 * receivers must handle both shapes.
 */
export interface WebhookPayload {
  file: string;
  status: "done";
  result: Record<string, unknown>;
  /** References to export files on disk (path relative to the data dir), if any were generated. */
  exports?: ExportMap;
}

/** On-disk shape of <file>.archivar/webhook.json, written before the workflow starts. */
interface WebhookFile {
  url: string;
  delivered: boolean;
}

export class WebhookApi {
  /**
   * Get the .archivar directory path for a given file.
   */
  private getArchivarDir(filePath: string): string {
    const sampleDataSubDir = getEnv("SAMPLE_DATA_SUBDIR", "sample_data/archivar");
    const relativeSampleDataPath = getEnv("RELATIVE_SAMPLE_DATA_PATH", `../${sampleDataSubDir}`);
    const dataDir = resolve(process.cwd(), relativeSampleDataPath);
    const safeName = basename(filePath);
    const fullPath = resolve(dataDir, safeName);
    return resolve(dirname(fullPath), `${safeName}.archivar`);
  }

  /**
   * Get the webhook file path for a given file.
   */
  private getWebhookPath(filePath: string): string {
    return resolve(this.getArchivarDir(filePath), "webhook.json");
  }

  /**
   * Get the debug.json path for a given file.
   */
  private getDebugJsonPath(filePath: string): string {
    return resolve(this.getArchivarDir(filePath), "debug.json");
  }

  /**
   * Set webhook URL for a file.
   */
  public setWebhook(filePath: string, url: string): void {
    const webhookPath = this.getWebhookPath(filePath);
    const archivarDir = dirname(webhookPath);

    // Ensure .archivar directory exists
    if (!existsSync(archivarDir)) {
      mkdirSync(archivarDir, { recursive: true });
    }

    const webhookFile: WebhookFile = { url, delivered: false };
    writeFileSync(webhookPath, JSON.stringify(webhookFile, null, 2), "utf-8");
  }

  /**
   * Get webhook URL for a file.
   */
  public getWebhook(filePath: string): string | null {
    const webhookPath = this.getWebhookPath(filePath);

    if (!existsSync(webhookPath)) {
      return null;
    }

    try {
      const content = readFileSync(webhookPath, "utf-8");
      const webhook = JSON.parse(content) as WebhookFile;
      return webhook.url;
    } catch (err) {
      console.error(`[WebhookApi] Failed to read webhook file: ${webhookPath}`, err);
      return null;
    }
  }

  /**
   * Check if webhook was already delivered for a file.
   */
  public isDelivered(filePath: string): boolean {
    const webhookPath = this.getWebhookPath(filePath);

    if (!existsSync(webhookPath)) {
      return false; // No webhook file = not delivered yet (file may have been deleted after delivery)
    }

    try {
      const content = readFileSync(webhookPath, "utf-8");
      const webhook = JSON.parse(content) as WebhookFile;
      return webhook.delivered;
    } catch {
      return false;
    }
  }

  /**
   * Mark webhook as delivered (but don't delete the file - let the caller decide).
   */
  public markDelivered(filePath: string): void {
    const webhookPath = this.getWebhookPath(filePath);

    if (!existsSync(webhookPath)) {
      return;
    }

    try {
      const content = readFileSync(webhookPath, "utf-8");
      const webhook = JSON.parse(content) as WebhookFile;
      webhook.delivered = true;
      writeFileSync(webhookPath, JSON.stringify(webhook, null, 2), "utf-8");
    } catch (err) {
      console.error(`[WebhookApi] Failed to mark webhook delivered: ${webhookPath}`, err);
    }
  }

  /**
   * Delete webhook file for a file.
   */
  public deleteWebhook(filePath: string): void {
    const webhookPath = this.getWebhookPath(filePath);

    if (existsSync(webhookPath)) {
      try {
        rmSync(webhookPath, { force: true });
      } catch (err) {
        console.error(`[WebhookApi] Failed to delete webhook file: ${webhookPath}`, err);
      }
    }
  }

  /**
   * Deliver webhook for a completed workflow.
   * Reads debug.json and sends it to the webhook URL.
   *
   * @param filePath - The file that was analyzed
   * @returns true if webhook was delivered successfully, false otherwise
   */
  public async deliverWebhook(filePath: string): Promise<boolean> {
    // Check if already delivered
    if (this.isDelivered(filePath)) {
      console.log(`[WebhookApi] Webhook already delivered for ${filePath}`);
      return true;
    }

    // Get webhook URL
    const webhookUrl = this.getWebhook(filePath);
    if (!webhookUrl) {
      console.log(`[WebhookApi] No webhook URL found for ${filePath}`);
      return true; // No webhook to deliver
    }

    // Read debug.json for the result
    const debugJsonPath = this.getDebugJsonPath(filePath);
    let result: Record<string, unknown>;

    if (existsSync(debugJsonPath)) {
      try {
        const content = readFileSync(debugJsonPath, "utf-8");
        result = JSON.parse(content);
      } catch (err) {
        console.error(`[WebhookApi] Failed to read debug.json: ${debugJsonPath}`, err);
        result = { error: "Failed to read analysis result" };
      }
    } else {
      result = { error: "No analysis result found" };
    }

    // Build payload (include export file references if any exports exist on disk)
    const exports = listExports(filePath);
    const payload: WebhookPayload = {
      file: filePath,
      status: "done",
      result,
      ...(Object.keys(exports).length > 0 ? { exports } : {}),
    };

    // Deliver with retries
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        console.log(`[WebhookApi] Delivering webhook to ${webhookUrl} (attempt ${attempt}/${MAX_RETRIES})`);

        const response = await fetch(webhookUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
        });

        if (response.ok) {
          console.log(`[WebhookApi] Webhook delivered successfully to ${webhookUrl}`);
          // REFACTOR(kiss): markDelivered immediately before deleteWebhook persists
          // a flag nothing will read — after deletion, exactly-once is enforced by
          // file absence (getWebhook returns null and deliverWebhook short-circuits
          // above). Keep one mechanism, not both.
          this.markDelivered(filePath);
          this.deleteWebhook(filePath);
          return true;
        } else {
          console.error(`[WebhookApi] Webhook delivery failed: ${response.status} ${response.statusText}`);
          // REFACTOR(kiss): any non-ok status (including 4xx) falls through to the
          // same backoff-retry as transport errors — a 400/404 can never succeed on
          // retry; only retry 5xx and network failures.
          lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
      } catch (err) {
        console.error(`[WebhookApi] Webhook delivery error (attempt ${attempt}):`, err);
        lastError = err instanceof Error ? err : new Error(String(err));
      }

      // Exponential backoff before retry
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        console.log(`[WebhookApi] Retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    // All retries failed
    console.error(`[WebhookApi] Webhook delivery failed after ${MAX_RETRIES} attempts:`, lastError);
    return false;
  }
}
