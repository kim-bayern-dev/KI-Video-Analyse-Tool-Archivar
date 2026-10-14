/**
 * Tests for the "openai-transcriptions" ASR protocol
 * (multipart POST /v1/audio/transcriptions, ModelConfig.asrProtocol).
 *
 * No mocks: a real local node:http server records requests and replies like
 * the OpenAI Audio API ({ "text": "..." }).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MllmApi } from "../src/rpc/mllm-api";
import { buildEndpointUrl } from "../src/lib/asr-url";

describe("buildEndpointUrl", () => {
    it("handles bare hosts, /v1 suffixes, full paths, and trailing slashes", () => {
        expect(buildEndpointUrl("http://host:8999", "v1/audio/transcriptions"))
            .toBe("http://host:8999/v1/audio/transcriptions");
        expect(buildEndpointUrl("http://host:8998/v1", "v1/audio/transcriptions"))
            .toBe("http://host:8998/v1/audio/transcriptions");
        expect(buildEndpointUrl("http://host:8999/v1/audio/transcriptions", "v1/audio/transcriptions"))
            .toBe("http://host:8999/v1/audio/transcriptions");
        expect(buildEndpointUrl("http://host:8999/", "v1/audio/transcriptions"))
            .toBe("http://host:8999/v1/audio/transcriptions");
    });
});

interface RecordedRequest {
    method?: string;
    url?: string;
    authorization?: string;
    body: string;
}

let server: Server;
let baseUrl: string;
let tmpDir: string;
let audioFile1: string;
let audioFile2: string;
const recorded: RecordedRequest[] = [];

const readBody = (req: IncomingMessage): Promise<Buffer> =>
    new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });

beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "asr-transcriptions-test-"));
    audioFile1 = join(tmpDir, "one.mp3");
    audioFile2 = join(tmpDir, "two.mp3");
    writeFileSync(audioFile1, Buffer.from("FAKE-MP3-DATA-1"));
    writeFileSync(audioFile2, Buffer.from("FAKE-MP3-DATA-2"));

    server = createServer(async (req, res) => {
        const body = await readBody(req);
        recorded.push({
            method: req.method,
            url: req.url,
            authorization: req.headers.authorization,
            body: body.toString("utf-8"),
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ text: `transcript-${recorded.length}` }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(tmpDir, { recursive: true, force: true });
});

describe("transcribeViaAudioTranscriptions (openai-transcriptions protocol)", () => {
    it("posts a single file as multipart with model/response_format/language and Bearer auth", async () => {
        recorded.length = 0;
        const api = new MllmApi();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const text = await (api as any).transcribeViaAudioTranscriptions(
            baseUrl,
            [audioFile1],
            "de",
            "Whisper3-Large-Turbo-DE",
            "test-key",
        );

        expect(text).toBe("transcript-1");
        expect(recorded).toHaveLength(1);
        const req = recorded[0];
        expect(req.method).toBe("POST");
        expect(req.url).toBe("/v1/audio/transcriptions");
        expect(req.authorization).toBe("Bearer test-key");
        expect(req.body).toContain('name="file"');
        expect(req.body).toContain("one.mp3");
        expect(req.body).toContain("FAKE-MP3-DATA-1");
        expect(req.body).toContain('name="model"');
        expect(req.body).toContain("Whisper3-Large-Turbo-DE");
        expect(req.body).toContain('name="response_format"');
        expect(req.body).toContain("json");
        expect(req.body).toContain('name="language"');
        expect(req.body).toContain("de");
    });

    it("sends one request per file and joins transcripts with newlines", async () => {
        recorded.length = 0;
        const api = new MllmApi();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const text = await (api as any).transcribeViaAudioTranscriptions(
            baseUrl,
            [audioFile1, audioFile2],
            undefined,
            "Whisper3-Large-Turbo-DE",
        );

        expect(recorded).toHaveLength(2);
        expect(text).toBe("transcript-1\ntranscript-2");
        // no language field when undefined
        expect(recorded[0].body).not.toContain('name="language"');
        // no auth header when no apiKey
        expect(recorded[0].authorization).toBeUndefined();
    });

    it("fails with an actionable error on non-200 responses", async () => {
        const errorServer = createServer((req, res) => {
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end("boom");
        });
        await new Promise<void>((resolve) => errorServer.listen(0, "127.0.0.1", resolve));
        const errorUrl = `http://127.0.0.1:${(errorServer.address() as AddressInfo).port}`;
        try {
            const api = new MllmApi();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await expect((api as any).transcribeViaAudioTranscriptions(errorUrl, [audioFile1], undefined, "m"))
                .rejects.toThrow("500");
        } finally {
            await new Promise<void>((resolve) => errorServer.close(() => resolve()));
        }
    });
});
