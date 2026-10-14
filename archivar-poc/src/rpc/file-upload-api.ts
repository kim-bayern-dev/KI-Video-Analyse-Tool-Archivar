import { createHash } from "node:crypto";
import { join, resolve, basename } from "node:path";
import { writeFile, readFile, mkdir, rm, unlink } from "node:fs/promises";
import { existsSync, createWriteStream } from "node:fs";
import { getEnv } from "defuss-env";
import { addUploadHandler } from "defuss-rpc/server.js";

/** Result returned by the binary upload handler. */
export interface BinaryUploadResult {
  size: number;
  sha256: string;
  uploadId: string;
  filename: string;
  originalName: string;
}

/**
 * Resolves the data directory where uploaded files are stored.
 * Uses the same env-var convention as FileApi.listFiles().
 */
function getDataDir(): string {
  const sampleDataSubDir = getEnv("SAMPLE_DATA_SUBDIR", "sample_data/archivar") ?? "sample_data/archivar";
  const relativeSampleDataPath = getEnv("RELATIVE_SAMPLE_DATA_PATH", `../${sampleDataSubDir}`) ?? `../${sampleDataSubDir}`;
  return resolve(process.cwd(), relativeSampleDataPath);
}

// REFACTOR(dry): identical sanitizeFileName exists in file-api.ts:584 —
// move one copy to a shared module (e.g. src/lib/).
/**
 * Strips directory components and replaces unsafe characters to prevent
 * path traversal attacks. Only allows: a-z, A-Z, 0-9, dots, hyphens, underscores.
 */
function sanitizeFileName(fileName: string): string {
  return basename(fileName).replace(/[^a-zA-Z0-9._-]/g, "_");
}

// REFACTOR(dry): duplicates FileApi.checkFileExists (file-api.ts:570) — both
// are live (this one via pages/api/check-file-exists.ts:6, FileApi's via the RPC
// whitelist src/rpc.ts:77); converge on one implementation.
/**
 * Pre-flight check: does a file with this name already exist?
 * Called by the client immediately after file selection.
 */
export async function checkFileExists(fileName: string): Promise<{ exists: boolean; safeName: string }> {
  const safeName = sanitizeFileName(fileName);
  const dataDir = getDataDir();
  const destPath = resolve(dataDir, safeName);

  // Path traversal guard - reject filenames that resolve outside the data dir
  if (!destPath.startsWith(dataDir)) {
    return { exists: true, safeName };
  }

  return { exists: existsSync(destPath), safeName };
}

/**
 * Register the "file-upload" binary upload handler.
 *
 * defuss-rpc streams chunks to a temp file and invokes this handler
 * only when bytesReceived >= originalSize (all chunks received).
 * The handler receives the full file data as a Uint8Array.
 *
 * This handler:
 * 1. Validates the destination path
 * 2. Writes the final file from data to the destination
 * 3. Computes SHA-256 and verifies integrity
 * 4. Returns metadata as BinaryUploadResult
 *
 * Registration is a module-level side effect — src/rpc.ts imports this module
 * precisely so this handler exists at server startup.
 */
addUploadHandler<BinaryUploadResult>("file-upload", async (data, meta) => {
  console.log(
    `[file-upload] Upload complete from defuss-rpc: ${data.byteLength} bytes, ` +
    `sha256=${meta.sha256}, uploadId=${meta.uploadId}, filename=${meta.originalFilename}`,
  );

  const dataDir = getDataDir();
  // Client sends the name URL-encoded (header values must be latin-1).
  // decodeURIComponent on a plain ASCII name is identity; the catch keeps
  // legacy raw names containing a literal "%" working.
  const rawName = meta.originalFilename || `${meta.uploadId}.bin`;
  let originalFilename = rawName;
  try {
    originalFilename = decodeURIComponent(rawName);
  } catch { /* legacy raw name */ }
  const safeName = sanitizeFileName(originalFilename);
  const destPath = resolve(dataDir, safeName);

  // Path traversal guard
  if (!destPath.startsWith(dataDir)) {
    throw new Error("invalid_filename: path escapes data directory");
  }

  // Check if file already exists (should not, as client checks first)
  if (existsSync(destPath)) {
    throw new Error("file_exists: destination file already exists");
  }

  // Ensure data directory exists
  await mkdir(dataDir, { recursive: true });

  // Write uploaded file to destination
  await writeFile(destPath, Buffer.from(data));

  // Compute server-side SHA-256
  const serverHash = createHash("sha256").update(Buffer.from(data)).digest("hex");

  // Verify against client-provided hash (if available)
  if (meta.sha256 && serverHash !== meta.sha256) {
    console.error(
      `[file-upload] Hash mismatch for "${safeName}": ` +
      `expected ${meta.sha256}, got ${serverHash}`,
    );
    // Clean up on hash mismatch
    try {
      await unlink(destPath);
    } catch { }
    throw new Error("hash_mismatch: uploaded file hash does not match expected");
  }

  console.log(`[file-upload] Saved: "${safeName}" -> ${destPath}`);

  return {
    size: data.byteLength,
    sha256: serverHash,
    uploadId: meta.uploadId,
    filename: safeName,
    originalName: originalFilename,
  };
});

// ============================================================================
// Chunked upload (proxy-timeout-proof)
// ============================================================================
//
// A fronting proxy kills any request whose upstream
// stays silent for ~60s (measured: 502 after ~60s), so a
// multi-hundred-MB single POST over a slow uplink never survives. The client
// therefore uploads in slices — each an independent /rpc/upload POST with
// uploadId `<uploadId>-c<index>` handled here — and finishes with an
// assembleChunkedUpload() RPC that concatenates chunk files server-side
// (seconds, well under the proxy cap). defuss-rpc's own resume mode is
// unusable for this: it invokes the handler per chunk and deletes the temp
// file after each response.
//
// Chunks live in `<dataDir>/.chunks/<uploadId>/` — the dot-prefixed
// directory is ignored by FileApi.listFiles (only kfs_* dirs are special),
// so in-flight uploads never appear in the dashboard.

const CHUNK_ID_PATTERN = /^(.+)-c(\d+)$/;

function getChunksDir(uploadId: string): string {
  // uploadId was sanitized by defuss-rpc (sanitizeUploadId) — [a-zA-Z0-9._-]
  return join(getDataDir(), ".chunks", uploadId);
}

/**
 * Register the "file-chunk" binary upload handler: stores one chunk of a
 * chunked upload. The chunk index rides in the uploadId (`<uploadId>-c<index>`)
 * because defuss-rpc only forwards a fixed header set to handlers.
 */
addUploadHandler<{ chunkIndex: number; size: number; uploadId: string }>("file-chunk", async (data, meta) => {
  const match = CHUNK_ID_PATTERN.exec(meta.uploadId);
  if (!match) {
    throw new Error(`invalid_chunk_id: expected <uploadId>-c<index>, got "${meta.uploadId}"`);
  }
  const uploadId = match[1];
  const chunkIndex = Number.parseInt(match[2], 10);

  // Integrity: defuss-rpc hashed the received bytes; compare with our copy.
  const serverHash = createHash("sha256").update(Buffer.from(data)).digest("hex");
  if (meta.sha256 && serverHash !== meta.sha256) {
    throw new Error("hash_mismatch: chunk hash does not match received bytes");
  }

  const chunksDir = getChunksDir(uploadId);
  await mkdir(chunksDir, { recursive: true });
  const chunkPath = join(chunksDir, `${String(chunkIndex).padStart(5, "0")}.part`);
  await writeFile(chunkPath, Buffer.from(data));
  console.log(`[file-chunk] Stored chunk ${chunkIndex} of upload ${uploadId}: ${data.byteLength} bytes`);
  return { chunkIndex, size: data.byteLength, uploadId };
});

/**
 * Concatenate all chunks of an upload into the destination file and remove
 * the chunk directory. Streams chunk files in index order (no full-file
 * Buffer). A partial destination is removed again when assembly fails.
 */
export async function assembleChunkedUpload(
  uploadId: string,
  fileName: string,
  chunkCount: number,
  expectedSize: number,
): Promise<BinaryUploadResult> {
  const dataDir = getDataDir();
  let originalFilename = fileName;
  try {
    originalFilename = decodeURIComponent(fileName);
  } catch { /* legacy raw name */ }
  const safeName = sanitizeFileName(originalFilename);
  const destPath = resolve(dataDir, safeName);

  if (!destPath.startsWith(dataDir)) {
    throw new Error("invalid_filename: path escapes data directory");
  }
  if (existsSync(destPath)) {
    throw new Error("file_exists: destination file already exists");
  }

  const chunksDir = getChunksDir(uploadId);
  const sha256 = createHash("sha256");
  let total = 0;
  await mkdir(dataDir, { recursive: true });
  const destStream = createWriteStream(destPath);
  try {
    for (let i = 0; i < chunkCount; i++) {
      const chunkPath = join(chunksDir, `${String(i).padStart(5, "0")}.part`);
      if (!existsSync(chunkPath)) {
        throw new Error(`missing_chunk: chunk ${i} of ${chunkCount} was not uploaded`);
      }
      const chunk = await readFile(chunkPath);
      sha256.update(chunk);
      total += chunk.byteLength;
      if (!destStream.write(chunk)) {
        await new Promise<void>((resolveDrain) => destStream.once("drain", resolveDrain));
      }
    }
    if (total !== expectedSize) {
      throw new Error(`size_mismatch: assembled ${total} bytes, expected ${expectedSize}`);
    }
  } catch (err) {
    destStream.destroy();
    await unlink(destPath).catch(() => { /* best effort */ });
    throw err;
  }
  await new Promise<void>((resolveEnd) => destStream.end(resolveEnd));
  await rm(chunksDir, { recursive: true, force: true });

  console.log(`[file-chunk] Assembled "${safeName}" -> ${destPath} (${expectedSize} bytes, ${chunkCount} chunks)`);
  return {
    size: expectedSize,
    sha256: sha256.digest("hex"),
    uploadId,
    filename: safeName,
    originalName: originalFilename,
  };
}

/** Remove all stored chunks of an upload (cancel / failure cleanup). */
export async function discardChunkedUpload(uploadId: string): Promise<{ status: "discarded" }> {
  await rm(getChunksDir(uploadId), { recursive: true, force: true });
  return { status: "discarded" };
}

// REFACTOR(kiss): ~60 lines of commented-out legacy upload code below — version
// control is the archive; delete the block instead of carrying it.
// ============================================================================
// Legacy RPC-based chunked upload (commented out, preserved for reference)
// ============================================================================
/*
import { randomUUID } from "node:crypto";
import { open, close, rename, unlink, access, constants } from "node:fs/promises";
import { writeFileSync, renameSync, unlinkSync } from "node:fs";

interface BinaryUploadSession {
  uploadId: string;
  fileName: string;
  safeName: string;
  totalSize: number;
  totalChunks: number;
  tempFile: string;
  fd: number;
  bytesWritten: number;
  chunksReceived: number;
  chunkOffsets: Set<number>;
  finalized: boolean;
  destPath: string;
}

const binaryUploads = new Map<string, BinaryUploadSession>();

export class FileUploadApi {
  async checkFileExists(fileName: string): Promise<{ exists: boolean; safeName: string }> {
    const safeName = sanitizeFileName(fileName);
    const dataDir = getDataDir();
    const destPath = resolve(dataDir, safeName);
    if (!destPath.startsWith(dataDir)) {
      return { exists: true, safeName };
    }
    return { exists: existsSync(destPath), safeName };
  }

  async startUpload(fileName: string, totalSize: number): Promise<{ uploadId: string; safeName: string } | { error: string }> {
    const safeName = sanitizeFileName(fileName);
    const dataDir = getDataDir();
    const destPath = resolve(dataDir, safeName);
    if (!destPath.startsWith(dataDir)) {
      return { error: "invalid_filename" };
    }
    if (existsSync(destPath)) {
      return { error: "file_exists" };
    }
    const uploadId = randomUUID();
    const tempFile = join(dataDir, `__temp_${uploadId}_${safeName}`);
    writeFileSync(tempFile, Buffer.alloc(0));
    return { uploadId, safeName };
  }

  async uploadChunk(uploadId: string, data: Uint8Array, chunkMd5: string): Promise<{ status: "ok" | "error"; bytesWritten: number }> {
    return { status: "ok", bytesWritten: 0 };
  }

  async finalizeUpload(uploadId: string): Promise<{ status: "confirmed"; safeName: string } | { status: "rejected"; error: string }> {
    return { status: "confirmed", safeName: "" };
  }

  async cancelUpload(uploadId: string): Promise<{ status: "cancelled" }> {
    return { status: "cancelled" };
  }
}
*/
