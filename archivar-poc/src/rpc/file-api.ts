import { stat, readFile, open } from 'fs/promises';
import { existsSync, rmSync } from 'fs';
import { join, resolve, basename } from 'path';
import glob from 'fast-glob';
import { getEnv } from 'defuss-env';
import { CacheApi } from './cache-api.js';
import { removeDirectoryRobust } from '../lib/output-cleanup.js';
import { OutputFormat } from '../lib/types.js';
import { assembleChunkedUpload, discardChunkedUpload, type BinaryUploadResult } from './file-upload-api.js';

/**
 * A media file (or kfs_* keyframe-set folder) plus the derived artifacts found
 * in its out_<name>_<ext>_<hash> output folder, grouped by segment kind
 * (keyframes/scenes/speech/...). Path fields deliberately use different bases:
 * hostAbsolutePath (host-side, for Docker volume mapping), absolutePath
 * (container-side), relativePath/path (relative to the data directory).
 */
export interface FileInfo {
  hostAbsolutePath: string;
  absolutePath: string;
  relativePath: string;
  path: string;
  mediaType: "video" | "audio" | "image" | "kfs";
  fileName: string;
  extension: string;
  outputFolderName: string | null;
  outputHash: string | null;
  keyframes: Array<FileInfo>;
  sceneKeyframes: Array<FileInfo>;
  scenes: Array<FileInfo>;
  silence: Array<FileInfo>;
  harmonic: Array<FileInfo>;
  noise: Array<FileInfo>;
  speech: Array<FileInfo>;
  startTime?: number;
  endTime?: number;
  index?: number;
  serverUrl?: string;
  outputFiles?: Array<FileInfo>;
  // DEPRECATED: action/allowedActions/actionOutputFormat only feed the
  // permanently hidden Actions panel in csr dashboard.tsx.
  action?: string;
  allowedActions?: string[];
  actionOutputFormat?: OutputFormat;
  status?: "New" | "..." | "Done" | "Failed";
}

/**
 * Lightweight file-list entry: only what's needed to *list/select* a file in the
 * dashboard/CLI — no segment arrays (keyframes/scenes/speech/…). The full
 * [`FileInfo`](#) (with segments for the timeline) is fetched on demand for the
 * single selected file via [`listFiles(fileName)`](#).
 *
 * WHY: the full list of 126 analyzed files carried ~70MB (each segment × ~5 path
 * strings); the list UI only renders `fileName` + media type.
 */
export interface FileSummary {
  fileName: string;
  mediaType: FileInfo["mediaType"];
  extension: string;
  outputHash: string | null;
  outputFolderName: string | null;
  serverUrl?: string;
  status?: "New" | "..." | "Done" | "Failed";
}

import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from "../lib/media-extensions.js";

// Re-exported here for the existing callers of file-api; the lists themselves
// live in the isomorphic src/lib/media-extensions.ts (client-safe).
export { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS };

/**
 * Classify a file extension into a media bucket. Unknown extensions fall back
 * to "image" (fail-open): unclassifiable files are treated as still images
 * rather than rejected.
 */
export const getFileTypeFromExtension = (extension: string): "video" | "audio" | "image" => {
  const ext = extension.toLowerCase().replace(/^\./, "");
  if (VIDEO_EXTENSIONS.includes(ext)) {
    return 'video';
  } else if (AUDIO_EXTENSIONS.includes(ext)) {
    return 'audio';
  } else {
    return 'image'; // Default fallback
  }
};

/**
 * RPC facade over the media data directory: lists files enriched with their
 * derived outputs, deletes files, and clears per-file caches/output folders.
 * Whitelisted methods are exposed via src/rpc.ts.
 */
export class FileApi {

  /**
   * Lists media files in the data directory (env-resolved, default
   * sample_data/archivar) and enriches each with its derived output files.
   * @param pattern Glob pattern to match files (default: "*" for all files)
   * @returns Promise<FileInfo[]> Array of file information objects
   */
  // REFACTOR(complexity): ~230 lines with three intertwined FileInfo construction
  // paths (media file, per-output file, kfs folder) plus an N+1 glob+stat per
  // media file — split into buildMediaEntry/buildOutputFileInfo/buildKfsEntry
  // helpers, and consider one glob for all out_* content grouped in memory.
  public async listFiles(pattern: string = '*'): Promise<FileInfo[]> {

    // REFACTOR(dry): this SAMPLE_DATA_SUBDIR/RELATIVE_SAMPLE_DATA_PATH preamble is
    // copy-pasted into 6 methods of this file and recurs across the rpc layer
    // (analyse-api.ts, file-upload-api.ts, status-api.ts, cache-api.ts, db.ts) —
    // extract one shared resolveDataDir() helper.
    const sampleDataSubDir = getEnv('SAMPLE_DATA_SUBDIR', 'sample_data/archivar') ?? 'sample_data/archivar';
    const relativeSampleDataPath = getEnv('RELATIVE_SAMPLE_DATA_PATH', `../${sampleDataSubDir}`) ?? `../${sampleDataSubDir}`;
    const dataDir = resolve(process.cwd(), relativeSampleDataPath);
    const searchPattern = resolve(dataDir, pattern);
    // REFACTOR(magic): 'http://127.0.0.1:8080' is a host-specific default baked
    // into source — require SAMPLE_DATA_SERVER or use a neutral fallback.
    const serverUrl = getEnv('SAMPLE_DATA_SERVER', 'http://127.0.0.1:8080') ?? 'http://127.0.0.1:8080';
    const absoluteSampleDataPath = getEnv('ABSOLUTE_SAMPLE_DATA_PATH', `/${sampleDataSubDir}`) ?? `/${sampleDataSubDir}`;
    const relativeDirPrefix = getEnv('RELATIVE_DIR_PREFIX', '') ?? '';
    // hostAbsolutePath is the glob's absolute result directly — no prefix
    // reconstruction; absolutePath stays the container-visible path.

    // relevant for the server url only
    const serverSampleDataBasePath = getEnv('SAMPLE_DATA_BASE_PATH', sampleDataSubDir) ?? sampleDataSubDir;

    try {
      // Use fast-glob to find files matching the pattern
      // REFACTOR(magic): deep: 10 is an unexplained traversal cap (repeated in the
      // per-file output glob below) — name the constant or derive it from the
      // known out_* layout (~3 levels).
      const files = await glob.async(searchPattern, {
        absolute: true,   // Return absolute paths
        deep: 10,
        cwd: dataDir,     // Search within the data directory
        onlyFiles: false,
      });

      const fileInfos: FileInfo[] = [];

      for (const filePath of files) {
        const stats = await stat(filePath);

        // Double-check it's a file (fast-glob should handle this, but just to be safe)
        if (stats.isFile()) {
          const fileName = filePath.split('/').pop() || '';
          const lastDotIndex = fileName.lastIndexOf('.');
          const extension = lastDotIndex > 0 ? fileName.substring(lastDotIndex) : '';

          // Output folders follow the out_<name>_<ext>_<hash>/ convention next to
          // the source file; this per-file glob links a media file to everything
          // the pipeline derived from it (and runs once per media file — N+1).
          // Extract filename without extension for folder matching
          const fileNameWithoutExt = fileName.substring(0, lastDotIndex);
          const extensionWithoutDot = extension.substring(1); // Remove the leading dot
          const baseGlobPattern = `out_${fileNameWithoutExt}_${extensionWithoutDot}_*/**/*`;
          console.log(`Looking for files with pattern: ${baseGlobPattern}`);

          let outputFolderName = null;
          let outputHash = null;

          // Get all files matching the pattern
          const matchingFiles = await glob.async(resolve(dataDir, baseGlobPattern), {
            absolute: true,
            deep: 10,
            cwd: dataDir
          });

          const outputFiles: Array<FileInfo> = [];

          // sub-files of the output folder of media (video, audio etc.)
          for (const filePath of matchingFiles) {
            const stats = await stat(filePath);
            if (stats.isFile()) {
              const fileName = filePath.split('/').pop() || '';
              const relativePath = filePath.replace(dataDir, '').substring(1); // Remove leading slash

              // Extract output folder name and hash from the first file
              // Folder format: out_<name_with_underscores>_<ext>_<hash>
              // The hash is always the last segment when split by '_'
              if (!outputFolderName) {
                const pathParts = relativePath.split('/');
                outputFolderName = pathParts[0];
                const parts = outputFolderName?.split('_') || [];
                outputHash = parts.length > 1 ? parts[parts.length - 1] : '';
              }
              const extension = fileName.substring(fileName.lastIndexOf('.'));

              // REFACTOR(dry): this FileInfo literal is built three times in listFiles
              // (here, the kfs image loop and the kfs folder entry below) with only
              // small variations — a makeFileInfo(base) helper would shrink this method.
              const fileInfo: FileInfo = {
                hostAbsolutePath: filePath,
                absolutePath: join(absoluteSampleDataPath, relativePath),
                relativePath: join(relativeDirPrefix, relativeSampleDataPath, relativePath),
                mediaType: getFileTypeFromExtension(extension),
                path: relativePath,
                fileName: fileName,
                extension,
                outputFolderName,
                outputHash,
                keyframes: [],
                sceneKeyframes: [],
                scenes: [],
                silence: [],
                harmonic: [],
                noise: [],
                speech: [],
                serverUrl: `${serverUrl}/${serverSampleDataBasePath}/${relativePath}`
              };

              // Segment files are named <index>_<startSec>_<endSec>_... by the
              // segmentation tools; parse the timing back out of the file name.
              const fileNameParts = fileName.split('_');
              if (fileNameParts.length >= 3) {
                fileInfo.index = Number.parseInt(fileNameParts[0]);
                fileInfo.startTime = Number.parseFloat(fileNameParts[1]);
                fileInfo.endTime = Number.parseFloat(fileNameParts[2]);
              }

              outputFiles.push(fileInfo);
            }
          }

          const keyframes = outputFiles.filter((file) => file.path.includes('/keyframes/'));
          const sceneKeyframes = outputFiles.filter((file) => file.path.includes('/scene_keyframes/'));
          const scenes = outputFiles.filter((file) => file.path.includes('/scenes/'));

          const silence = outputFiles.filter((file) => file.path.includes(`${outputFolderName}/`) && file.path.includes('_silence_'));
          const harmonic = outputFiles.filter((file) => file.path.includes(`${outputFolderName}/`) && file.path.includes('_harmonic_'));
          const noise = outputFiles.filter((file) => file.path.includes(`${outputFolderName}/`) && file.path.includes('_noise_'));
          const speech = outputFiles.filter((file) => file.path.includes(`${outputFolderName}/`) && file.path.includes('_speech_'));

          // main media file
          const mediaType = getFileTypeFromExtension(fileName.substring(fileName.lastIndexOf('.')));
          const isImage = mediaType === 'image';

          const fileInfoEntry = {
            outputFiles,
            hostAbsolutePath: filePath,
            absolutePath: join(absoluteSampleDataPath, filePath.replace(dataDir, '')),
            relativePath: join(relativeDirPrefix, relativeSampleDataPath, filePath.replace(dataDir, '')),
            // REFACTOR(consistency): this `path` keeps the leading "/" while output
            // files strip it via substring(1) above — consumers see both shapes.
            path: filePath.replace(dataDir, ''),
            serverUrl: `${serverUrl}/${serverSampleDataBasePath}/${fileName}`,
            fileName: fileName,
            extension: extension,
            outputHash,
            mediaType,
            outputFolderName,
            keyframes,
            sceneKeyframes,
            scenes,
            silence,
            harmonic,
            noise,
            speech,
            // DEPRECATED: feeds the hidden Actions panel only.
            action: 'full-analysis',
            actionOutputFormat: 'json',
            allowedActions: ['full-analysis']
          } as FileInfo;

          // Unification fallback: an unprocessed single image is a keyframe set
          // with one entry (itself). Once pre-processing produced real
          // scene_keyframes (the converted+resized PNG artifact), the discovered
          // segments win — they are what the VLM actually ingests.
          if (isImage && keyframes.length === 0 && sceneKeyframes.length === 0) {
            const selfKeyframe = {
              ...fileInfoEntry,
              keyframes: [],
              sceneKeyframes: [],
              scenes: [],
              silence: [],
              harmonic: [],
              noise: [],
              speech: [],
            } as FileInfo;
            fileInfoEntry.keyframes = [selfKeyframe];
            fileInfoEntry.sceneKeyframes = [selfKeyframe];
          }

          fileInfos.push(fileInfoEntry);
        } else if (stats.isDirectory()) {
          const folderName = filePath.split('/').pop() || '';
          // Keyframe-set folders follow the kfs_<name> convention: a plain folder
          // of images treated as one analyzable unit.
          if (folderName.startsWith('kfs_')) {
            const nameWithoutPrefix = folderName.replace('kfs_', '');

            // Get all image files within the kfs folder
            const imageFiles = await glob.async('**/*.{jpg,jpeg,png,gif,bmp,webp}', {
              absolute: true,
              cwd: filePath
            });

            const keyframes: FileInfo[] = [];
            for (const imagePath of imageFiles) {
              const imageFileName = imagePath.split('/').pop() || '';
              const imageExtension = imageFileName.substring(imageFileName.lastIndexOf('.'));
              const relativePath = imagePath.replace(dataDir, '').substring(1);

              keyframes.push({
                hostAbsolutePath: imagePath,
                absolutePath: join(absoluteSampleDataPath, relativePath),
                relativePath: join(relativeDirPrefix, relativeSampleDataPath, relativePath),
                path: relativePath,
                mediaType: getFileTypeFromExtension(imageExtension),
                fileName: imageFileName,
                extension: imageExtension,
                outputFolderName: null,
                outputHash: null,
                keyframes: [],
                sceneKeyframes: [],
                scenes: [],
                silence: [],
                harmonic: [],
                noise: [],
                speech: [],
                serverUrl: `${serverUrl}/${serverSampleDataBasePath}/${relativePath}`
              });
            }

            const relativePath = filePath.replace(dataDir, '').substring(1);

            fileInfos.push({
              hostAbsolutePath: filePath,
              absolutePath: join(absoluteSampleDataPath, relativePath),
              relativePath: join(relativeDirPrefix, relativeSampleDataPath, relativePath),
              path: relativePath,
              mediaType: 'kfs',
              fileName: nameWithoutPrefix,
              extension: '',
              outputFolderName: null,
              outputHash: null,
              keyframes: keyframes,
              sceneKeyframes: [],
              // DEPRECATED: feeds the hidden Actions panel only.
              action: 'full-analysis',
              allowedActions: ['full-analysis'],
              actionOutputFormat: 'json',
              status: 'New',
              scenes: [],
              silence: [],
              harmonic: [],
              noise: [],
              speech: [],
              serverUrl: `${serverUrl}/${serverSampleDataBasePath}/${folderName}`,
            });
          }
        }
      }

      return fileInfos;
    } catch (error) {
      // REFACTOR(typo): "public/data directory" is stale — the data dir is
      // env-resolved (default sample_data/archivar); rewording changes an error
      // string, so update it together with any consumer matching on it.
      console.error(`Error listing files with pattern "${pattern}" in public/data directory:`, error);
      throw new Error(`Failed to list files with pattern "${pattern}" in public/data directory: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Lightweight listing: same file discovery as [`listFiles`](#), but returns only
   * the selection fields ([`FileSummary`](#)) — NO per-segment `FileInfo` and NO
   * `out_*` content glob. `outputHash`/`outputFolderName` come from one shallow
   * `out_<name>_<ext>_*` directory glob (via the shared `_extractOutputHash`).
   *
   * WHY: the full `listFiles` payload is ~70MB for a data dir with many analyzed
   * files (every segment × ~5 path strings); listing/selection only needs
   * `fileName` + media type + `outputHash`. Fetch the full single-file `FileInfo`
   * via `listFiles(fileName)` on selection.
   * @param pattern Glob pattern (default "*").
   */
  public async listFilesSummary(pattern: string = '*'): Promise<FileSummary[]> {
    const sampleDataSubDir = getEnv('SAMPLE_DATA_SUBDIR', 'sample_data/archivar') ?? 'sample_data/archivar';
    const relativeSampleDataPath = getEnv('RELATIVE_SAMPLE_DATA_PATH', `../${sampleDataSubDir}`) ?? `../${sampleDataSubDir}`;
    const dataDir = resolve(process.cwd(), relativeSampleDataPath);
    const searchPattern = resolve(dataDir, pattern);
    const serverUrl = getEnv('SAMPLE_DATA_SERVER', 'http://127.0.0.1:8080') ?? 'http://127.0.0.1:8080';
    const serverSampleDataBasePath = getEnv('SAMPLE_DATA_BASE_PATH', sampleDataSubDir) ?? sampleDataSubDir;

    try {
      const files = await glob.async(searchPattern, {
        absolute: true, deep: 10, cwd: dataDir, onlyFiles: false,
      });

      const summaries: FileSummary[] = [];
      for (const filePath of files) {
        const stats = await stat(filePath);
        const fileName = filePath.split('/').pop() || '';
        if (stats.isFile()) {
          const lastDotIndex = fileName.lastIndexOf('.');
          const extension = lastDotIndex > 0 ? fileName.substring(lastDotIndex) : '';
          const mediaType = getFileTypeFromExtension(fileName.substring(fileName.lastIndexOf('.')));
          // outputHash/outputFolderName via the shared shallow-glob helper (no segment scan).
          const outputHash = await this._extractOutputHash(dataDir, fileName, filePath);
          const outputFolderName = outputHash
            ? `out_${fileName.substring(0, lastDotIndex)}_${extension.substring(1)}_${outputHash}`
            : null;
          summaries.push({
            fileName, mediaType, extension, outputHash, outputFolderName,
            serverUrl: `${serverUrl}/${serverSampleDataBasePath}/${fileName}`,
          });
        } else if (stats.isDirectory()) {
          const folderName = filePath.split('/').pop() || '';
          // Keyframe-set folders (kfs_*) are selectable units too.
          if (folderName.startsWith('kfs_')) {
            summaries.push({
              fileName: folderName.replace('kfs_', ''),
              mediaType: 'kfs',
              extension: '',
              outputHash: null,
              outputFolderName: null,
              status: 'New',
            });
          }
        }
      }
      return summaries;
    } catch (error) {
      console.error(`Error listing file summaries with pattern "${pattern}":`, error);
      throw new Error(`Failed to list file summaries with pattern "${pattern}": ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Clear all cache entries and output folders for a file, without deleting the source file.
   */
  public async clearFileCache(filePath: string): Promise<{ status: "cleared" | "error"; removed?: number; error?: string; warnings?: string[] }> {
    const sampleDataSubDir = getEnv('SAMPLE_DATA_SUBDIR', 'sample_data/archivar') ?? 'sample_data/archivar';
    const relativeSampleDataPath = getEnv('RELATIVE_SAMPLE_DATA_PATH', `../${sampleDataSubDir}`) ?? `../${sampleDataSubDir}`;
    const dataDir = resolve(process.cwd(), relativeSampleDataPath);

    // Resolve and validate the target path stays within dataDir
    const safeName = basename(filePath);
    const fullPath = resolve(dataDir, safeName);
    if (!fullPath.startsWith(dataDir)) {
      return { status: "error", error: "Invalid file path" };
    }

    if (!existsSync(fullPath)) {
      return { status: "error", error: `File not found: ${safeName}` };
    }

    try {
      return await this._clearCacheAndOutputs(dataDir, safeName, fullPath);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`Error clearing cache for "${safeName}":`, error);
      return { status: "error", error: msg };
    }
  }

  /**
   * Delete a file, all its output folders, and all related cache entries.
   */
  public async deleteFile(filePath: string): Promise<{ status: "deleted" | "error"; removed?: number; error?: string }> {
    const sampleDataSubDir = getEnv('SAMPLE_DATA_SUBDIR', 'sample_data/archivar') ?? 'sample_data/archivar';
    const relativeSampleDataPath = getEnv('RELATIVE_SAMPLE_DATA_PATH', `../${sampleDataSubDir}`) ?? `../${sampleDataSubDir}`;
    const dataDir = resolve(process.cwd(), relativeSampleDataPath);

    // Resolve and validate the target path stays within dataDir
    const safeName = basename(filePath);
    const fullPath = resolve(dataDir, safeName);
    if (!fullPath.startsWith(dataDir)) {
      return { status: "error", error: "Invalid file path" };
    }

    if (!existsSync(fullPath)) {
      return { status: "error", error: `File not found: ${safeName}` };
    }

    try {
      const result = await this._clearCacheAndOutputs(dataDir, safeName, fullPath);
      // Delete source file/folder after cache is cleared
      rmSync(fullPath, { recursive: true, force: true });
      console.log(`Deleted source: ${safeName}`);
      return { status: "deleted", removed: result.removed };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`Warning deleting source "${safeName}" (continuing): ${msg}`);
      // Best effort: report "deleted" even when cleanup only partially succeeded
      // (the removed count is unavailable on this path).
      // REFACTOR(consistency): clearFileCache surfaces the same _clearCacheAndOutputs
      // failure as {status:"error"} while deleteFile swallows it into "deleted" —
      // divergent error semantics for the same underlying operation.
      return { status: "deleted" };
    }
  }

  /**
   * Shared logic: clear cache entries and output folders for a given file.
   * Strategy: extract outputHash from existing output folder names, then clear
   * cache entries matching that hash. Only target entries belonging to this file.
   */
  private async _clearCacheAndOutputs(dataDir: string, safeName: string, fullPath: string): Promise<{ status: "cleared"; removed: number; warnings?: string[] }> {
    const cacheApi = new CacheApi();
    let totalRemoved = 0;

    // DEPRECATED member: 'summary' is an unused cache table (nothing writes or
    // reads it); kept in the purge list so old summary.db entries are cleaned.
    const TABLE_NAMES = ['scene', 'audio', 'keyframe', 'speech', 'aggregated', 'summary'] as const;

    // First, scan output folders to extract outputHash (works even if listFiles returns null)
    const outputHash = await this._extractOutputHash(dataDir, safeName, fullPath);

    if (outputHash) {
      // Clear cache entries matching this output hash across all tables
      for (const table of TABLE_NAMES) {
        totalRemoved += await cacheApi.removeByPrefix(table, outputHash);
      }
      console.log(`Cleared cache for hash ${outputHash}: ${totalRemoved} removed`);
    } else {
      console.warn(`No outputHash found for "${safeName}" — no cache entries cleared`);
    }

    // Remove output folders
    const outputFailures = await this._removeOutputFolders(dataDir, safeName);
    for (const failure of outputFailures) {
      console.error(`[clearFileCache] STALE OUTPUTS REMAIN: ${failure}`);
    }

    // Remove debug artifact directory (<safeName>.archivar) — created next to the
    // media file during workflow runs (debug.log, debug.json).
    const debugDir = resolve(dataDir, `${safeName}.archivar`);
    if (existsSync(debugDir)) {
      try {
        rmSync(debugDir, { recursive: true, force: true });
        console.log(`Deleted debug artifacts: ${safeName}.archivar`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.warn(`Warning: failed to remove debug artifacts "${safeName}.archivar": ${msg}`);
      }
    }

    // Remove per-file workflow config (<safeName>.workflow.json)
    const workflowConfigPath = resolve(dataDir, `${safeName}.workflow.json`);
    if (existsSync(workflowConfigPath)) {
      try {
        rmSync(workflowConfigPath, { force: true });
        console.log(`Deleted workflow config: ${safeName}.workflow.json`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.warn(`Warning: failed to remove workflow config "${safeName}.workflow.json": ${msg}`);
      }
    }

    return { status: "cleared", removed: totalRemoved, warnings: outputFailures.length > 0 ? outputFailures : undefined };
  }

  /**
   * Extract outputHash by scanning output folder names for a given file.
   */
  private async _extractOutputHash(dataDir: string, safeName: string, fullPath: string): Promise<string | null> {
    const fileStats = await stat(fullPath);
    const outputGlob = fileStats.isDirectory()
      ? `out_${safeName}_*`
      : (() => {
        const lastDot = safeName.lastIndexOf('.');
        const nameWithoutExt = lastDot > 0 ? safeName.substring(0, lastDot) : safeName;
        const ext = lastDot > 0 ? safeName.substring(lastDot + 1) : '';
        return `out_${nameWithoutExt}_${ext}_*`;
      })();

    const outputFolders = await glob.async(resolve(dataDir, outputGlob), {
      absolute: true, onlyDirectories: true, deep: 1, cwd: dataDir,
    });

    if (outputFolders.length === 0) return null;

    // Extract hash from first matching folder: out_name_ext_HASH
    const folderName = basename(outputFolders[0]);
    const parts = folderName.split('_');
    return parts.length > 1 ? parts[parts.length - 1] : null;
  }

  /**
   * Remove output folders for a file. Returns failure messages (empty = all
   * removed). Tool outputs are root-owned (Docker), so plain fs removal can
   * fail — removeDirectoryRobust escalates to a throwaway Docker container.
   */
  private async _removeOutputFolders(dataDir: string, safeName: string): Promise<string[]> {
    // REFACTOR(dry): the out_<name>_<ext>_* glob construction below is copy-pasted
    // from _extractOutputHash above — extract a buildOutputGlob(safeName) helper.
    const fileStats = await stat(resolve(dataDir, safeName));
    const outputGlob = fileStats.isDirectory()
      ? `out_${safeName}_*`
      : (() => {
        const lastDot = safeName.lastIndexOf('.');
        const nameWithoutExt = lastDot > 0 ? safeName.substring(0, lastDot) : safeName;
        const ext = lastDot > 0 ? safeName.substring(lastDot + 1) : '';
        return `out_${nameWithoutExt}_${ext}_*`;
      })();

    const outputFolders = await glob.async(resolve(dataDir, outputGlob), {
      absolute: true, onlyDirectories: true, deep: 1, cwd: dataDir,
    });

    const failures: string[] = [];
    for (const folder of outputFolders) {
      const result = await removeDirectoryRobust(folder);
      if (result.ok) {
        console.log(`Deleted output folder: ${basename(folder)} (via ${result.via})`);
      } else {
        console.error(`FAILED to remove output folder "${basename(folder)}": ${result.error}`);
        failures.push(`${basename(folder)}: ${result.error}`);
      }
    }
    return failures;
  }

  /**
   * Remove only the output folders for a file (no cache tables, no debug
   * artifacts). Used by the workflow engine's --force path: pre-processing
   * re-runs must not mix stale segments with fresh ones during discovery.
   * Returns failure messages (empty = success); callers should fail fast.
   */
  public async removeFileOutputs(filePath: string): Promise<{ failures: string[] }> {
    const sampleDataSubDir = getEnv('SAMPLE_DATA_SUBDIR', 'sample_data/archivar') ?? 'sample_data/archivar';
    const relativeSampleDataPath = getEnv('RELATIVE_SAMPLE_DATA_PATH', `../${sampleDataSubDir}`) ?? `../${sampleDataSubDir}`;
    const dataDir = resolve(process.cwd(), relativeSampleDataPath);

    const safeName = basename(filePath);
    const fullPath = resolve(dataDir, safeName);
    if (!fullPath.startsWith(dataDir)) {
      return { failures: [`Invalid file path: ${filePath}`] };
    }
    if (!existsSync(fullPath)) {
      return { failures: [`File not found: ${safeName}`] };
    }
    const failures = await this._removeOutputFolders(dataDir, safeName);
    return { failures };
  }

  /**
   * Read a file's contents as text. Path is resolved relative to the data directory.
   * Used for fetching debug.json and debug.log from the frontend.
   */
  public async readFile(relativePath: string): Promise<string> {
    const sampleDataSubDir = getEnv('SAMPLE_DATA_SUBDIR', 'sample_data/archivar') ?? 'sample_data/archivar';
    const relativeSampleDataPath = getEnv('RELATIVE_SAMPLE_DATA_PATH', `../${sampleDataSubDir}`) ?? `../${sampleDataSubDir}`;
    const dataDir = resolve(process.cwd(), relativeSampleDataPath);

    // Resolve and validate the target path stays within dataDir
    const fullPath = resolve(dataDir, relativePath);
    if (!fullPath.startsWith(dataDir)) {
      throw new Error("Invalid file path: path escapes data directory");
    }

    if (!existsSync(fullPath)) {
      throw new Error(`File not found: ${relativePath}`);
    }

    return readFile(fullPath, 'utf-8');
  }

  /**
   * Stream `<fileName>.archivar/debug.log` line by line as it grows (tail -f
   * style) while a workflow runs. The workflow engine truncates/creates the
   * file at run start (workflow-engine.ts runWorkflow), so offset 0 yields
   * exactly the current run; a missing file simply means the run has not
   * created it yet, so we wait for it.
   *
   * Consumed by the upload wizard via defuss-rpc's generator streaming
   * (`for await` on the client). Ends ~1s after the "=== WORKFLOW COMPLETE"
   * marker line (to drain the trailing debug.json/STEP-10 lines), or on the
   * safety caps (5 min without growth / 2 h total) so a crashed client cannot
   * leak the poll loop. A client-side `break` cancels the stream promptly.
   */
  public async *tailDebugLog(
    fileName: string,
    pollMs = 500,
  ): AsyncGenerator<string, void> {
    const sampleDataSubDir = getEnv('SAMPLE_DATA_SUBDIR', 'sample_data/archivar') ?? 'sample_data/archivar';
    const relativeSampleDataPath = getEnv('RELATIVE_SAMPLE_DATA_PATH', `../${sampleDataSubDir}`) ?? `../${sampleDataSubDir}`;
    const dataDir = resolve(process.cwd(), relativeSampleDataPath);

    const fullPath = resolve(dataDir, `${fileName}.archivar/debug.log`);
    if (!fullPath.startsWith(dataDir)) {
      throw new Error("Invalid file path: path escapes data directory");
    }

    const WAIT_FOR_FILE_MS = 60_000;
    const MAX_IDLE_MS = 5 * 60_000;
    const MAX_TOTAL_MS = 2 * 60 * 60_000;
    const startedAt = Date.now();
    let lastGrowthAt = Date.now();

    // Wait for the workflow to (re)create the log.
    while (!existsSync(fullPath)) {
      if (Date.now() - startedAt > WAIT_FOR_FILE_MS) return;
      await new Promise((r) => setTimeout(r, pollMs));
    }

    let offset = 0;
    let remainder = "";
    let completeAt: number | null = null;

    // Read only the bytes appended since the last poll; offset resets if the
    // file was truncated by a new run.
    const readAppended = async (): Promise<string> => {
      const fh = await open(fullPath, "r");
      try {
        const { size } = await fh.stat();
        if (size < offset) offset = 0;
        if (size === offset) return "";
        const length = size - offset;
        const buffer = Buffer.alloc(length);
        await fh.read(buffer, 0, length, offset);
        offset = size;
        return buffer.toString("utf-8");
      } finally {
        await fh.close();
      }
    };

    while (true) {
      const appended = await readAppended();
      if (appended) {
        lastGrowthAt = Date.now();
        remainder += appended;
        const lines = remainder.split("\n");
        remainder = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("=== WORKFLOW COMPLETE") && completeAt === null) {
            completeAt = Date.now();
          }
          yield line;
        }
      }
      if (completeAt !== null && Date.now() - completeAt > 1000) break;
      if (Date.now() - lastGrowthAt > MAX_IDLE_MS) break;
      if (Date.now() - startedAt > MAX_TOTAL_MS) break;
      await new Promise((r) => setTimeout(r, pollMs));
    }

    // Flush a trailing partial line (the writer may not end with "\n").
    if (remainder.trim()) yield remainder;
  }

  /**
   * Pre-flight check: does a file with this name already exist in the data directory?
   */
  public async checkFileExists(fileName: string): Promise<{ exists: boolean; safeName: string }> {
    const safeName = sanitizeFileName(fileName);
    const sampleDataSubDir = getEnv('SAMPLE_DATA_SUBDIR', 'sample_data/archivar') ?? 'sample_data/archivar';
    const relativeSampleDataPath = getEnv('RELATIVE_SAMPLE_DATA_PATH', `../${sampleDataSubDir}`) ?? `../${sampleDataSubDir}`;
    const dataDir = resolve(process.cwd(), relativeSampleDataPath);
    const destPath = resolve(dataDir, safeName);
    if (!destPath.startsWith(dataDir)) {
      return { exists: true, safeName };
    }
    return { exists: existsSync(destPath), safeName };
  }

  /**
   * Finalize a chunked upload: concatenate .chunks/<uploadId>/ into the
   * destination file. Server-side assembly (disk speed) so the response
   * beats the fronting proxy's ~60s upstream-silence cap.
   */
  public async finalizeChunkedUpload(
    uploadId: string,
    fileName: string,
    chunkCount: number,
    expectedSize: number,
  ): Promise<BinaryUploadResult> {
    return assembleChunkedUpload(uploadId, fileName, chunkCount, expectedSize);
  }

  /** Discard all stored chunks of an upload (cancel / failure cleanup). */
  public async discardChunkedUpload(uploadId: string): Promise<{ status: "discarded" }> {
    return discardChunkedUpload(uploadId);
  }
}

/** Strips directory components and replaces unsafe characters. */
function sanitizeFileName(fileName: string): string {
  return basename(fileName).replace(/[^a-zA-Z0-9._-]/g, "_");
}
