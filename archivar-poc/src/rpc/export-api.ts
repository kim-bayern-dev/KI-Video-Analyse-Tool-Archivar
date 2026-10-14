/**
 * ExportApi - RPC facade for analysis result exports.
 *
 * Generates export files (docx/md/json/log) into <file>.archivar/exports/
 * and returns their references. Used by the CLI, the /api/export download
 * route, and the workflow engine (eager exports requested via /api/analyze).
 */

import {
    exportFile,
    listExports,
    EXPORT_FORMATS,
    type ExportFormat,
    type ExportMap,
    type ExportedFileInfo,
} from "./export.js";

export class ExportApi {
    /**
     * Generate (or reuse, unless force) the requested export formats for a file.
     * Returns a map of format -> { path, size, mimeType } (path relative to the data dir).
     *
     * Formats are generated sequentially and the first failure throws, so callers
     * never see partial results — though formats already written to disk stay.
     */
    public async export(fileName: string, formats: ExportFormat[], force = false): Promise<ExportMap> {
        if (!Array.isArray(formats) || formats.length === 0) {
            throw new Error("formats must be a non-empty array of: " + EXPORT_FORMATS.join(", "));
        }
        for (const format of formats) {
            if (!EXPORT_FORMATS.includes(format)) {
                throw new Error(`Unknown export format: ${format}. Valid formats: ${EXPORT_FORMATS.join(", ")}`);
            }
        }

        const result: ExportMap = {};
        for (const format of formats) {
            result[format] = await exportFile(fileName, format, force);
        }
        return result;
    }

    /** List exports that already exist on disk for a file (without generating). */
    public async list(fileName: string): Promise<Partial<Record<ExportFormat, ExportedFileInfo>>> {
        return listExports(fileName);
    }
}
