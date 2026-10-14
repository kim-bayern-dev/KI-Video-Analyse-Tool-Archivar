import { DSON } from "defuss-dson";
import { getRpcClient } from "defuss-rpc/client.js";
import type { RpcApi } from "../../rpc.js";

/**
 * One progress frame of an upload. Consumed by the upload wizard
 * (screens/dashboard/upload-wizard.tsx) to drive its progress bar and status
 * text. `status` flows "uploading" → "confirmed" (server accepted) |
 * "rejected" (server refused) | "error" (transport/handler failure, see
 * errorCode).
 */
export interface UploadProgress {
  percent: number;
  bytesUploaded: number;
  totalBytes: number;
  status: "uploading" | "confirmed" | "rejected" | "error";
  errorCode?: string;
  uploadId?: string;
}

/**
 * Get the base URL for the /rpc/upload endpoint.
 * Uses the current window origin to support any deployment URL.
 * The fallback only applies outside the browser (tests/SSR) and matches the
 * Astro dev server port (astro.config.ts).
 */
function getBaseUrl(): string {
  if (typeof window !== "undefined") {
    return window.location.origin;
  }
  return "http://localhost:8801";
}

// Cached singleton: creating the RPC client performs an async schema fetch,
// so it is built once and reused across uploads instead of once per call.
let rpcClient: Awaited<ReturnType<typeof getRpcClient<RpcApi>>> | null = null;

async function getClient() {
  if (!rpcClient) {
    rpcClient = await getRpcClient<RpcApi>();
  }
  return rpcClient;
}

/**
 * Pre-flight check: does a file with this name already exist?
 * Uses the RPC FileApi.checkFileExists method.
 */
export async function checkFileExists(fileName: string): Promise<{ exists: boolean; safeName: string }> {
  const client = await getClient();
  const fileApi = new client.FileApi();
  return fileApi.checkFileExists(fileName);
}

/**
 * Slice size for the chunked upload protocol. Every chunk POST must finish
 * within a fronting proxy's typical ~60s upstream-silence cap (verified
 * 2026-08: 502 after exactly 60.3s when the server
 * responds only after the full body). 24 MiB beats the cap even on ~0.5MB/s
 * uplinks.
 */
const CHUNK_SIZE = 24 * 1024 * 1024;

/**
 * Parse an upload handler's NDJSON response. Frame encoding varies (handler
 * results are DSON, ack/throw paths are plain JSON), so each line is tried
 * as DSON first, then as JSON.
 */
function parseUploadResponse(responseText: string): { handlerError: string | null } {
  let handlerError: string | null = null;
  for (const line of responseText.split("\n").filter(Boolean)) {
    let frame: { type?: string; error?: { message: string } };
    try {
      frame = DSON.parse(line);
    } catch {
      try {
        frame = JSON.parse(line);
      } catch {
        continue; // undecodable line — ignore
      }
    }
    if (frame.type === "error") {
      handlerError = frame.error?.message || "handler_error";
    }
  }
  return { handlerError };
}

/** Best-effort server-side chunk cleanup (failed/cancelled uploads). */
async function discardChunksBestEffort(uploadId: string): Promise<void> {
  try {
    const client = await getClient();
    await new client.FileApi().discardChunkedUpload(uploadId);
  } catch {
    // best effort
  }
}

/**
 * Upload a file using the binary transport (/rpc/upload).
 *
 * Files are uploaded in CHUNK_SIZE slices, each an independent POST handled
 * by the "file-chunk" handler, followed by a finalizeChunkedUpload RPC that
 * assembles the file server-side in seconds. WHY chunked: the fronting
 * proxy kills any request whose upstream stays silent for ~60s — a
 * multi-hundred-MB single POST over a slow uplink never survives, no matter
 * the transport. (An earlier XHR-based transport additionally broke huge
 * uploads client-side; fetch streams the body straight from the File object,
 * nothing is buffered in memory.)
 *
 * Progress is REAL and server-side: defuss-rpc emits "progress" frames over
 * SSE at /rpc/upload/progress/<chunkUploadId> while it streams the body to
 * its temp file; frames are mapped onto the file's overall byte range. SSE
 * is best-effort — if a proxy buffers or blocks it, the upload still
 * completes, only the bar stands still. Confirmation is VERIFIED:
 * "confirmed" is only yielded after the finalize RPC returns the written
 * file's metadata — anything else yields "error".
 */
export async function* uploadFile(
  file: File,
): AsyncGenerator<UploadProgress> {
  const uploadId = crypto.randomUUID();
  const totalBytes = file.size;
  const baseUrl = getBaseUrl();

  // Client-side send start marker
  yield {
    percent: 0,
    bytesUploaded: 0,
    totalBytes,
    status: "uploading",
    uploadId,
  };

  const chunkCount = Math.max(1, Math.ceil(totalBytes / CHUNK_SIZE));

  for (let index = 0; index < chunkCount; index++) {
    const start = index * CHUNK_SIZE;
    const chunk = file.slice(start, Math.min(start + CHUNK_SIZE, totalBytes));
    const chunkUploadId = `${uploadId}-c${index}`;

    // Per-chunk SSE progress, mapped onto the file's overall byte range.
    const queue: UploadProgress[] = [];
    let eventSource: EventSource | null = null;
    if (typeof EventSource !== "undefined") {
      try {
        eventSource = new EventSource(`${baseUrl}/rpc/upload/progress/${chunkUploadId}`);
        eventSource.onmessage = (ev) => {
          try {
            const frame = JSON.parse(ev.data) as { type?: string; bytesReceived?: number };
            if (frame.type === "progress") {
              const bytesUploaded = Math.min(totalBytes, start + (frame.bytesReceived ?? 0));
              queue.push({
                percent: Math.round((bytesUploaded / totalBytes) * 100),
                bytesUploaded,
                totalBytes,
                status: "uploading",
                uploadId,
              });
            }
          } catch {
            // Ignore malformed SSE frames.
          }
        };
        eventSource.onerror = () => {
          // Keep the upload running if SSE fails.
        };
      } catch {
        // EventSource creation failed; continue without progress events.
      }
    }

    let fetchDone = false;
    let fetchResponse: Response | null = null;
    let fetchError: Error | null = null;
    const fetchPromise = fetch(`${baseUrl}/rpc/upload`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Upload-Handler": "file-chunk",
        "X-Upload-Id": chunkUploadId,
        "X-Original-Size": String(chunk.size),
        "X-Upload-Offset": "0",
        // Header values must be latin-1 (ByteString); names with e.g. an
        // en-dash (–) make the request fail before it is even sent.
        // URL-encoding keeps the name ASCII-safe; the server decodes it.
        "X-Original-Filename": encodeURIComponent(file.name),
      },
      body: chunk,
    })
      .then((r) => { fetchResponse = r as Response; })
      .catch((e) => { fetchError = e instanceof Error ? e : new Error(String(e)); })
      .finally(() => { fetchDone = true; });

    // Forward live progress frames while the chunk transfer runs
    while (!fetchDone) {
      while (queue.length > 0) {
        yield queue.shift()!;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    // Final drain: frames that arrived during the last moments
    while (queue.length > 0) {
      yield queue.shift()!;
    }
    eventSource?.close();
    await fetchPromise; // already settled; keeps the promise observed

    // (read via a function: TS flow analysis cannot see the promise callback
    // assignments and would narrow fetchError to null/never in straight-line code)
    const getFetchError = (): Error | null => fetchError;
    const transportError = getFetchError();
    let handlerError: string | null = transportError?.message ?? null;
    if (!handlerError && fetchResponse && !(fetchResponse as Response).ok) {
      handlerError = `http_${(fetchResponse as Response).status}`;
    }
    if (!handlerError && fetchResponse) {
      handlerError = parseUploadResponse(await (fetchResponse as Response).text()).handlerError;
    }

    if (handlerError) {
      console.error(`[upload ${uploadId}] chunk ${index} failed:`, handlerError);
      await discardChunksBestEffort(uploadId);
      yield {
        percent: 0,
        bytesUploaded: 0,
        totalBytes,
        status: "error",
        errorCode: handlerError,
        uploadId,
      };
      return;
    }
  }

  // All chunks stored — assemble server-side (disk speed, beats the proxy cap).
  try {
    const client = await getClient();
    const result = await new client.FileApi().finalizeChunkedUpload(
      uploadId,
      encodeURIComponent(file.name),
      chunkCount,
      totalBytes,
    );
    if (!result?.filename) {
      throw new Error("unexpected_response");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[upload ${uploadId}] finalize failed:`, message);
    await discardChunksBestEffort(uploadId);
    yield {
      percent: 0,
      bytesUploaded: 0,
      totalBytes,
      status: "error",
      errorCode: message,
      uploadId,
    };
    return;
  }

  // Verified: the server assembled the file and reported its metadata.
  yield {
    percent: 100,
    bytesUploaded: totalBytes,
    totalBytes,
    status: "confirmed",
    uploadId,
  };
}

/**
 * Upload a file and return only the final progress event.
 */
export async function uploadFileComplete(file: File): Promise<UploadProgress> {
  let lastProgress: UploadProgress | null = null;
  for await (const progress of uploadFile(file)) {
    lastProgress = progress;
  }
  if (!lastProgress) {
    throw new Error("Upload finished without progress");
  }
  return lastProgress;
}

/**
 * Cancel an upload. Discards the upload's server-side chunks (best effort).
 * The wizard's cancellation itself is client-side: it sets uploadAborted and
 * stops consuming uploadFile() — an in-flight chunk fetch is never aborted
 * (no AbortController), so one trailing chunk may still land before discard.
 */
export async function cancelUpload(uploadId: string): Promise<{ status: "cancelled" }> {
  await discardChunksBestEffort(uploadId);
  return { status: "cancelled" };
}

// ============================================================================
// Legacy RPC-based chunked upload (commented out, preserved for reference)
// REFACTOR(kiss): ~85 lines of commented-out code that would no longer even
// compile (md5 is not imported) — git history is the reference; delete the
// block.
// ============================================================================
/*
export async function* uploadFileLegacy(
  file: File,
  chunkSize = 65536 * 16, // 1 MiB
): AsyncGenerator<UploadProgress> {
  const client = await getClient();
  const api = new client.FileUploadApi();

  const totalBytes = file.size;

  // Start upload session
  const startResult = await api.startUpload(file.name, totalBytes);

  if ("error" in startResult) {
    yield {
      percent: 0,
      bytesUploaded: 0,
      totalBytes,
      status: "error",
      errorCode: startResult.error,
    };
    return;
  }

  const { uploadId } = startResult;
  let bytesUploaded = 0;

  // Send chunks
  while (bytesUploaded < totalBytes) {
    const start = bytesUploaded;
    const end = Math.min(start + chunkSize, totalBytes);
    const blob = file.slice(start, end);
    const arrayBuffer = await blob.arrayBuffer();
    const chunk = new Uint8Array(arrayBuffer);

    const chunkMd5 = md5(chunk);

    const result = await api.uploadChunk(uploadId, chunk, chunkMd5);

    if (result.status === "error") {
      yield {
        percent: Math.round((bytesUploaded / totalBytes) * 100),
        bytesUploaded,
        totalBytes,
        status: "error",
        errorCode: "chunk_failed",
        uploadId,
      };
      return;
    }

    bytesUploaded = result.bytesWritten;

    yield {
      percent: Math.round((bytesUploaded / totalBytes) * 100),
      bytesUploaded,
      totalBytes,
      status: "uploading",
      uploadId,
    };
  }

  // Finalize - server moves file to data dir
  const finalResult = await api.finalizeUpload(uploadId);

  if (finalResult.status === "confirmed") {
    yield {
      percent: 100,
      bytesUploaded: totalBytes,
      totalBytes,
      status: "confirmed",
      uploadId,
    };
  } else {
    yield {
      percent: 100,
      bytesUploaded: totalBytes,
      totalBytes,
      status: "rejected",
      errorCode: finalResult.error,
      uploadId,
    };
  }
}
*/
