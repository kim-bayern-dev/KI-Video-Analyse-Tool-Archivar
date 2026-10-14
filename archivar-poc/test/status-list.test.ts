/**
 * Unit test for StatusApi.listStatuses — uses a temp data dir with
 * hand-written <file>.archivar/status.json files (no server needed).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDir: string;
let listStatuses: (filter?: "processing" | "done" | "error") => Promise<Array<{ status: string; file: string; startedAt: string; error?: string }>>;

const writeStatus = (fileName: string, status: string, startedAt: string, extra: Record<string, unknown> = {}) => {
    const dir = join(tmpDir, `${fileName}.archivar`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "status.json"), JSON.stringify({ status, file: fileName, startedAt, ...extra }), "utf-8");
};

const readStatus = (fileName: string) =>
    JSON.parse(readFileSync(join(tmpDir, `${fileName}.archivar`, "status.json"), "utf-8"));

beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "status-list-test-"));
    // Live runs: fresh startedAt (acts as the initial heartbeat) — must stay "processing".
    const now = Date.now();
    writeStatus("a.mp4", "processing", new Date(now - 60_000).toISOString());
    writeStatus("b.mp4", "done", new Date(now - 3 * 60_000).toISOString());
    writeStatus("c.mp4", "processing", new Date(now - 2 * 60_000).toISOString());
    writeStatus("d.mp4", "error", new Date(now - 4 * 60_000).toISOString());
    // Dead run: heartbeat stopped > STALE_AFTER_MS ago — must transition to "error".
    writeStatus("e.mp4", "processing", new Date(now - 60 * 60_000).toISOString(), {
        heartbeatAt: new Date(now - 30 * 60_000).toISOString(),
    });
    // Legacy dead run (no heartbeatAt field at all, started long ago).
    writeStatus("f.mp4", "processing", new Date(now - 61 * 60_000).toISOString());

    // Point the data dir resolution at the temp dir before importing StatusApi
    process.env.RELATIVE_SAMPLE_DATA_PATH = tmpDir;
    const { StatusApi } = await import("../src/rpc/status-api");
    listStatuses = (filter) => new StatusApi().listStatuses(filter);
});

afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.RELATIVE_SAMPLE_DATA_PATH;
});

describe("StatusApi.listStatuses", () => {
    it("lists all statuses sorted by startedAt descending", async () => {
        const all = await listStatuses();
        expect(all.map((t) => t.file)).toEqual(["a.mp4", "c.mp4", "b.mp4", "d.mp4", "e.mp4", "f.mp4"]);
    });

    it("filters by status", async () => {
        const processing = await listStatuses("processing");
        expect(processing.map((t) => t.file)).toEqual(["a.mp4", "c.mp4"]);

        const done = await listStatuses("done");
        expect(done.map((t) => t.file)).toEqual(["b.mp4"]);

        const errors = await listStatuses("error");
        expect(errors.map((t) => t.file)).toEqual(["d.mp4", "e.mp4", "f.mp4"]);
    });

    it("transitions stale processing runs to error and persists the verdict", async () => {
        for (const fileName of ["e.mp4", "f.mp4"]) {
            const onDisk = readStatus(fileName);
            expect(onDisk.status).toBe("error");
            expect(onDisk.error).toMatch(/^stale: no heartbeat/);
            expect(onDisk.completedAt).toBeTruthy();
        }
    });

    it("keeps live processing runs untouched", async () => {
        for (const fileName of ["a.mp4", "c.mp4"]) {
            expect(readStatus(fileName).status).toBe("processing");
        }
    });
});
