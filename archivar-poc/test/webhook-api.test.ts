/**
 * WebhookApi tests — real local HTTP receiver, real temp data dir, no mocks.
 *
 * Verifies deliverWebhook end-to-end: reads <file>.archivar/webhook.json +
 * debug.json from the (temp) data dir, POSTs the payload, and deletes the
 * webhook file after successful delivery. Also covers the `exports` field
 * (included only when export files exist on disk).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDir: string;
let receiver: Server;
let receiverUrl: string;
let receivedBody: string | null = null;
const FILE = "hook-test.mp4";

const archivarDir = () => join(tmpDir, `${FILE}.archivar`);

beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "webhook-api-test-"));
    process.env.RELATIVE_SAMPLE_DATA_PATH = tmpDir;

    receiver = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
            receivedBody = Buffer.concat(chunks).toString("utf-8");
            res.writeHead(200).end("ok");
        });
    });
    await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
    receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
});

afterAll(async () => {
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.RELATIVE_SAMPLE_DATA_PATH;
});

const setupArchivarDir = (withExports: boolean) => {
    mkdirSync(archivarDir(), { recursive: true });
    writeFileSync(join(archivarDir(), "debug.json"), JSON.stringify({ fileName: FILE, scenes: [] }), "utf-8");
    if (withExports) {
        mkdirSync(join(archivarDir(), "exports"), { recursive: true });
        writeFileSync(join(archivarDir(), "exports", "result.md"), "# Summary\n\ncontent\n", "utf-8");
    }
};

describe("WebhookApi.deliverWebhook", () => {
    it("delivers the debug.json result and deletes webhook.json on success", async () => {
        const { WebhookApi } = await import("../src/rpc/webhook-api");
        const api = new WebhookApi();
        setupArchivarDir(false);
        api.setWebhook(FILE, receiverUrl);

        receivedBody = null;
        const delivered = await api.deliverWebhook(FILE);

        expect(delivered).toBe(true);
        expect(receivedBody).not.toBeNull();
        const payload = JSON.parse(receivedBody!);
        expect(payload.file).toBe(FILE);
        expect(payload.status).toBe("done");
        expect(payload.result.fileName).toBe(FILE);
        expect(payload.exports).toBeUndefined();
        // webhook.json deleted after successful delivery
        expect(existsSync(join(archivarDir(), "webhook.json"))).toBe(false);
    });

    it("includes the exports map when export files exist on disk", async () => {
        const { WebhookApi } = await import("../src/rpc/webhook-api");
        const api = new WebhookApi();
        setupArchivarDir(true);
        api.setWebhook(FILE, receiverUrl);

        receivedBody = null;
        const delivered = await api.deliverWebhook(FILE);

        expect(delivered).toBe(true);
        const payload = JSON.parse(receivedBody!);
        expect(payload.exports?.md?.mimeType).toBe("text/markdown");
        expect(payload.exports?.md?.path).toBe(`${FILE}.archivar/exports/result.md`);
        expect(payload.exports?.md?.size).toBeGreaterThan(0);
    });

    it("returns true without sending when no webhook is configured", async () => {
        const { WebhookApi } = await import("../src/rpc/webhook-api");
        const api = new WebhookApi();
        setupArchivarDir(false);
        // no setWebhook call → no webhook.json
        receivedBody = null;
        const delivered = await api.deliverWebhook(FILE);
        expect(delivered).toBe(true);
        expect(receivedBody).toBeNull();
    });
});
