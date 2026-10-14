#!/usr/bin/env node

/**
 * Archivar CLI - thin client to the workflow engine.
 *
 * Runs `pnpm cli <command>` (tsx src/cli.ts). The canonical command/flag
 * reference is the `--help` output (see printHelp below) — keeping it in one
 * place avoids doc drift.
 */

import { writeFileSync, readFileSync } from "node:fs";
import { DSON } from "defuss-dson";
import { longFetch } from "./lib/long-fetch.js";
import { countFromErrorsJson } from "./lib/non-fatal-error-collector.js";

// Load archivar config (required for local mode)
import "../archivar.config.js";
import { OutputFormat, PostProcessingSelection } from "@lib/types.js";

const DEFAULT_SERVER = "http://localhost:8802";
const DEFAULT_API_KEY = process.env.API_KEY || "your-api-key";

// ============================================================================
// Argument parsing
// ============================================================================

function parseArgs(argv: string[]): {
  command: string;
  positional: string[];
  flags: Record<string, string>;
} {
  const args = argv.slice(2); // skip node + script path
  const command = args[0] || "help";
  const positional: string[] = [];
  const flags: Record<string, string> = {};

  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      const eqIdx = key.indexOf("=");
      if (eqIdx >= 0) {
        flags[key.slice(0, eqIdx)] = key.slice(eqIdx + 1);
      } else if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        flags[key] = args[++i];
      } else {
        flags[key] = "true";
      }
    } else {
      positional.push(args[i]);
    }
  }

  return { command, positional, flags };
}

// ============================================================================
// RPC client
// ============================================================================

async function rpcCall(server: string, className: string, methodName: string, args: unknown[], apiKey?: string): Promise<unknown> {
  const url = `${server}/rpc`;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) {
    headers["x-api-key"] = apiKey;
  }

  let response: Response;
  const rpcStart = Date.now();
  try {
    // Route via longFetch so Node/undici's built-in 5-min headersTimeout/bodyTimeout
    // don't abort long-running RPC (e.g. analyze workflow). The 12h AbortSignal stays the cap.
    response = await longFetch(url, {
      method: "POST",
      headers,
      body: DSON.stringify({ className, methodName, args }),
      signal: AbortSignal.timeout(43_200_000),
    });
  } catch (err) {
    const elapsedMs = Date.now() - rpcStart;
    const code = (err as { code?: string }).code ?? "n/a";
    const cause = err instanceof Error && err.cause ? ` (${(err.cause as Error).message ?? err.cause})` : "";
    console.error(
      `[rpcCall] ${className}.${methodName} FAILED after ${elapsedMs}ms ` +
      `name=${(err as Error).name} code=${code}${cause}`,
    );
    throw new Error(`Failed to connect to ${url}${cause}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`RPC call ${className}.${methodName} failed: ${response.status} ${response.statusText}\n${body}`);
  }

  const data = DSON.parse(await response.text());

  if (data && data.error) {
    throw new Error(`RPC error: ${data.error}`);
  }

  return data;
}

// ============================================================================
// Commands
// ============================================================================

async function cmdList(server: string, pattern: string, apiKey?: string): Promise<void> {
  // Use the lightweight summary listing — cmdList only reads fileName/mediaType/extension/outputHash,
  // so the full per-segment FileInfo payload (~70MB for a large data dir) is pure overhead here.
  const files = (await rpcCall(server, "FileApi", "listFilesSummary", [pattern], apiKey)) as Array<{
    fileName: string;
    mediaType: string;
    extension: string;
    outputHash?: string | null;
  }>;

  if (files.length === 0) {
    console.error("No files found.");
    return;
  }

  for (const f of files) {
    console.log(`${f.mediaType.padEnd(6)} ${f.fileName}${f.outputHash ? ` [${f.outputHash}]` : ""}`);
  }
  console.error(`\n${files.length} file(s) found.`);
}

interface SegmentInfo {
  fileName: string;
  mediaType: string;
  extension: string;
  index?: number;
  startTime?: number;
  endTime?: number;
  serverUrl?: string;
}

interface FileInfoWithSegments {
  fileName: string;
  mediaType: string;
  extension: string;
  outputHash?: string;
  scenes: SegmentInfo[];
  sceneKeyframes: SegmentInfo[];
  keyframes: SegmentInfo[];
  speech: SegmentInfo[];
  harmonic: SegmentInfo[];
  noise: SegmentInfo[];
  silence: SegmentInfo[];
}

const SEGMENT_TYPES = ["scenes", "sceneKeyframes", "keyframes", "speech", "harmonic", "noise", "silence"] as const;

function formatTime(seconds?: number): string {
  if (seconds === undefined || seconds === null) return "?";
  const m = Math.floor(seconds / 60);
  const s = (seconds % 60).toFixed(2).padStart(5, "0");
  return `${m}:${s}`;
}

async function cmdListSegments(
  server: string,
  filePattern: string,
  typeFilter: string | undefined,
  apiKey?: string,
): Promise<void> {
  const files = (await rpcCall(server, "FileApi", "listFiles", [filePattern], apiKey)) as FileInfoWithSegments[];

  if (files.length === 0) {
    console.error("No files found.");
    return;
  }

  const typesToShow = typeFilter
    ? SEGMENT_TYPES.filter((t) => t.toLowerCase().startsWith(typeFilter.toLowerCase()))
    : [...SEGMENT_TYPES];

  if (typeFilter && typesToShow.length === 0) {
    console.error(`Unknown segment type: ${typeFilter}`);
    console.error(`Valid types: ${SEGMENT_TYPES.join(", ")}`);
    process.exit(1);
  }

  let totalSegments = 0;

  for (const f of files) {
    console.log(`\n${f.mediaType.padEnd(6)} ${f.fileName}${f.outputHash ? ` [${f.outputHash}]` : ""}`);

    let fileHasSegments = false;
    for (const segType of typesToShow) {
      const segments = f[segType];
      if (!segments || segments.length === 0) continue;
      fileHasSegments = true;
      totalSegments += segments.length;

      console.log(`  ${segType} (${segments.length}):`);
      for (const seg of segments) {
        const timeRange = seg.startTime !== undefined && seg.endTime !== undefined
          ? `${formatTime(seg.startTime)} - ${formatTime(seg.endTime)}`
          : "";
        const idx = seg.index !== undefined ? `#${String(seg.index).padStart(3, "0")}` : "    ";
        console.log(`    ${idx}  ${timeRange.padEnd(16)} ${seg.fileName}`);
      }
    }

    if (!fileHasSegments) {
      console.log("  (no segments)");
    }
  }

  console.error(`\n${files.length} file(s), ${totalSegments} segment(s) found.`);
}

async function cmdWorkflows(server: string, apiKey?: string): Promise<void> {
  const result = (await rpcCall(server, "AnalyseApi", "listWorkflows", [], apiKey)) as {
    workflows: Array<{ name: string; description?: string }>;
    defaultWorkflow: string;
  };
  const workflows = result.workflows;

  if (workflows.length === 0) {
    console.error("No workflows configured.");
    return;
  }

  console.log(`  Default: ${result.defaultWorkflow}`);
  for (const w of workflows) {
    const marker = w.name === result.defaultWorkflow ? " *" : "  ";
    console.log(`  ${marker} ${w.name.padEnd(25)} ${w.description ?? ""}`);
  }
}

async function cmdWorkflowConfig(server: string, name: string, apiKey?: string): Promise<void> {
  const config = await rpcCall(server, "AnalyseApi", "getWorkflowConfig", [name], apiKey);
  console.log(JSON.stringify(config, null, 2));
}

async function cmdModels(server: string, apiKey?: string): Promise<void> {
  const models = (await rpcCall(server, "AnalyseApi", "listModels", [], apiKey)) as Array<{
    name: string;
    type: string;
  }>;

  if (models.length === 0) {
    console.error("No models configured.");
    return;
  }

  for (const m of models) {
    console.log(`  ${m.name.padEnd(25)} ${m.type}`);
  }
}

async function cmdAnalyzeSegment(
  server: string,
  filePath: string,
  mediaType: string,
  modelName: string,
  prompt: string,
  systemPrompt?: string,
  outputFile?: string,
  apiKey?: string,
): Promise<void> {
  console.error(`Analyzing segment: ${filePath}`);
  console.error(`Type: ${mediaType}, Model: ${modelName}`);

  const result = (await rpcCall(server, "AnalyseApi", "analyzeSegment", [
    filePath,
    mediaType,
    modelName,
    prompt,
    systemPrompt ?? undefined,
  ], apiKey)) as string;

  if (outputFile) {
    writeFileSync(outputFile, result, "utf-8");
    console.error(`Output written to: ${outputFile}`);
  } else {
    process.stdout.write(result);
    process.stdout.write("\n");
  }
}

async function cmdFileConfigGet(server: string, filePath: string, apiKey?: string): Promise<void> {
  const config = await rpcCall(server, "AnalyseApi", "getFileWorkflowConfig", [filePath], apiKey);
  if (!config) {
    console.error("No per-file workflow config found.");
    return;
  }
  console.log(JSON.stringify(config, null, 2));
}

async function cmdFileConfigSet(
  server: string,
  filePath: string,
  mediaType: string,
  modelName: string,
  prompt: string,
  apiKey?: string,
): Promise<void> {
  // Load existing config or create new. A new sidecar points at the server's
  // configured default workflow (fetched live — the literal that used to be
  // hardcoded here named a workflow that no longer exists).
  const existing = (await rpcCall(server, "AnalyseApi", "getFileWorkflowConfig", [filePath], apiKey)) as Record<string, unknown> | null;

  let config = existing;
  if (!config) {
    const { defaultWorkflow } = (await rpcCall(server, "AnalyseApi", "listWorkflows", [], apiKey)) as { defaultWorkflow: string };
    config = { workflow: defaultWorkflow, overrides: {} };
  }
  if (!config.overrides) config.overrides = {};

  (config.overrides as Record<string, unknown>)[mediaType] = {
    modelName,
    prompt,
  };

  await rpcCall(server, "AnalyseApi", "saveFileWorkflowConfig", [filePath, config], apiKey);
  console.log(`Updated per-file config for "${filePath}" (${mediaType} => ${modelName}).`);
}

async function cmdAnalyze(
  server: string,
  filePath: string,
  flags: Record<string, string>,
  apiKey?: string,
): Promise<void> {
  const workflowName = flags.workflow;
  const format = flags.format;
  const outputFile = flags.output;
  const force = flags.force !== undefined;
  const only = flags.only;

  console.error(`Analyzing: ${filePath}`);
  console.error(`Workflow: ${workflowName ?? "(default)"}`);
  console.error(`Format: ${format ?? "json"}`);
  if (only) console.error(`Only: ${only}`);
  if (force) console.error(`Force: true`);

  // -------------------------------------------------------------------
  // Build per-clip-type processing overrides
  // Precedence (lowest to highest):
  //   1. --config-file <path>  (JSON with per-type overrides)
  //   2. --<type>-model / --<type>-prompt  (prefixed flags)
  //   3. --model / --prompt / --type  (single-type shorthand, highest)
  // -------------------------------------------------------------------
  const MEDIA_TYPES = ["speech", "scene", "keyframe", "harmonic", "noise"] as const;
  const processingMap = new Map<string, Record<string, unknown>>();

  // Layer 1: --config-file
  if (flags["config-file"]) {
    try {
      const raw = readFileSync(flags["config-file"], "utf-8");
      const parsed = JSON.parse(raw) as Record<string, Record<string, unknown>>;
      for (const [mediaType, cfg] of Object.entries(parsed)) {
        processingMap.set(mediaType, { mediaType, enabled: true, ...cfg });
      }
      console.error(`Loaded config file: ${flags["config-file"]}`);
    } catch (err) {
      console.error(`Error reading config file: ${flags["config-file"]}`);
      process.exit(1);
    }
  }

  // Layer 2: --<type>-model / --<type>-prompt prefixed flags
  for (const mt of MEDIA_TYPES) {
    const mKey = `${mt}-model`;
    const pKey = `${mt}-prompt`;
    if (flags[mKey] || flags[pKey] !== undefined) {
      const existing = processingMap.get(mt) ?? { mediaType: mt, enabled: true };
      if (flags[mKey]) existing.modelName = flags[mKey];
      if (flags[pKey] !== undefined) existing.prompt = flags[pKey];
      processingMap.set(mt, existing);
    }
  }

  // Layer 3: --model / --prompt / --type shorthand (backward compat)
  if (flags.model || flags.prompt !== undefined) {
    const mediaType = flags.type ?? "speech";
    const existing = processingMap.get(mediaType) ?? { mediaType, enabled: true };
    if (flags.model) existing.modelName = flags.model;
    if (flags.prompt !== undefined) existing.prompt = flags.prompt;
    processingMap.set(mediaType, existing);
    console.error(`Override: ${mediaType} => model: ${flags.model ?? "(default)"}, prompt: ${flags.prompt ? "(custom)" : "(default)"}`);
  }

  let overrides: Record<string, unknown> | undefined;
  if (processingMap.size > 0) {
    overrides = { processing: Array.from(processingMap.values()) };
  }

  // Build post-processing overrides
  let postProcessingOverrides: Record<string, unknown> | undefined;
  const hasPostProcessingFlag = flags["post-processing"] !== undefined || flags["no-post-processing"] !== undefined;

  if (hasPostProcessingFlag) {
    postProcessingOverrides = {};

    // Plugin overrides
    if (flags["no-post-processing"] !== undefined) {
      (postProcessingOverrides as any).plugins = [];
    } else if (flags["post-processing"]) {
      const names = flags["post-processing"].split(",").map((s) => s.trim()).filter(Boolean);
      (postProcessingOverrides as any).plugins = names.map((name) => ({ name, enabled: true }));
    }
  }

  const args: unknown[] = [
    filePath,
    workflowName ?? undefined,
    format ?? "json",
    overrides ?? undefined,
    postProcessingOverrides ?? undefined,
    force,
    only ?? undefined,
    flags["web-hook-url"] ?? undefined,
  ];

  // Helper: tail debug.log from server while RPC call is in flight
  async function tailDebugLog(debugPath: string, stopSignal: { stopped: boolean }): Promise<void> {
    let offset = 0;
    const POLL_INTERVAL_MS = 2000;

    while (!stopSignal.stopped) {
      try {
        const content = (await rpcCall(server, "FileApi", "readFile", [debugPath], apiKey)) as string;
        if (content.length > offset) {
          const newContent = content.slice(offset);
          process.stderr.write(newContent);
          offset = content.length;
        }
      } catch {
        // File may not exist yet (workflow hasn't started) — retry silently
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }

  // Degraded-run gate: a workflow can COMPLETE yet carry recovered (non-fatal)
  // errors — isolated per-segment failures, endpoint outages, schema retries —
  // leaving the output incomplete although nothing crashed. Surface that as
  // exit code 2 (distinct from 1 = hard failure) so callers/CI read "exit 0"
  // as "output is complete", not "process survived". Fail-open when the error
  // artifact is unreadable (pre-feature behaviour).
  async function exitWhenDegraded(count: number | null): Promise<void> {
    if (!count) return; // null (unknown) or 0 (clean)
    console.error(`WARNING: analysis completed with ${count} non-fatal error(s) — the output may be INCOMPLETE.`);
    console.error(`Details: pnpm cli export --file "${filePath}" --format errors`);
    process.exit(2);
  }

  // --local runs the workflow engine directly in this process (shows all console output)
  // Without --local, uses RPC to server (console output goes to server terminal)
  if (flags.local) {
    console.error("Mode: local (direct execution)");
    const { WorkflowEngine } = await import("./rpc/workflow-engine.js");
    const engine = new WorkflowEngine();
    const result = await engine.runWorkflow(
      filePath,
      workflowName,
      format as OutputFormat ?? "json",
      overrides,
      postProcessingOverrides as PostProcessingSelection | undefined,
      force,
      only,
      flags["web-hook-url"],
    );
    if (outputFile) {
      writeFileSync(outputFile, result, "utf-8");
      console.error(`Output written to: ${outputFile}`);
    } else {
      process.stdout.write(result);
      process.stdout.write("\n");
    }
    // No FileApi in local mode: the formatted JSON result carries the summary.
    let localCount: number | null = null;
    try {
      const parsed = JSON.parse(result) as { nonFatalErrors?: { count?: unknown } };
      localCount = typeof parsed.nonFatalErrors?.count === "number" ? parsed.nonFatalErrors.count : null;
    } catch { /* non-JSON output — fail open */ }
    await exitWhenDegraded(localCount);
    return;
  }

  // Stream debug.log to stderr while the workflow runs on the server
  const debugPath = `${filePath}.archivar/debug.log`;
  const stopSignal = { stopped: false };
  const tailer = tailDebugLog(debugPath, stopSignal);
  const result = (await rpcCall(server, "AnalyseApi", "runWorkflow", args, apiKey)) as string;

  stopSignal.stopped = true;
  await tailer;

  if (outputFile) {
    writeFileSync(outputFile, result, "utf-8");
    console.error(`Output written to: ${outputFile}`);
  } else {
    process.stdout.write(result);
    process.stdout.write("\n");
  }

  // errors.json is written up-front and on every recorded error (all formats).
  let rpcCount: number | null = null;
  try {
    const content = (await rpcCall(server, "FileApi", "readFile", [`${filePath}.archivar/errors.json`], apiKey)) as string;
    rpcCount = countFromErrorsJson(content);
  } catch { /* artifact unreadable — fail open */ }
  await exitWhenDegraded(rpcCount);
}

async function cmdPostProcessing(server: string, workflowName: string | undefined, apiKey?: string): Promise<void> {
  const result = (await rpcCall(server, "AnalyseApi", "getPostProcessingDefaults", [workflowName ?? undefined], apiKey)) as {
    plugins: Array<{ name: string; description?: string; enabled: boolean }>;
  };

  console.log("Plugins:");
  if (result.plugins.length === 0) {
    console.log("  (none)");
  } else {
    for (const p of result.plugins) {
      const status = p.enabled ? "enabled" : "disabled";
      console.log(`  ${p.name.padEnd(30)} [${status}] ${p.description ?? ""}`);
    }
  }
}

/**
 * Fetch and print debug.log for a file (same as UI "Log" tab).
 */
async function cmdLogs(server: string, file: string, apiKey?: string): Promise<void> {
  const debugPath = `${file}.archivar/debug.log`;
  try {
    const content = (await rpcCall(server, "FileApi", "readFile", [debugPath], apiKey)) as string;
    if (!content) {
      console.log("(empty)");
    } else {
      console.log(content);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("not found") || msg.includes("File not found")) {
      console.error(`No analysis found for "${file}".`);
      console.error(`Run 'pnpm cli analyze --file "${file}"' first.`);
    } else {
      console.error(`Error: ${msg}`);
    }
    process.exit(1);
  }
}


/**
 * Export analysis results in one or more formats (docx, md, json, log).
 * Downloads via the generic /api/export route (backed by ExportApi on RPC level)
 * and writes the file(s) client-side.
 */
async function cmdExport(server: string, file: string, formatsFlag: string | undefined, output: string | undefined, force: boolean): Promise<void> {
  const VALID_FORMATS = ["docx", "md", "json", "raw", "log", "srt", "vct", "errors", "vlm-requests", "asr-requests"];
  const formats = (formatsFlag ?? "")
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);

  if (formats.length === 0) {
    console.error("Error: --format is required for export command.");
    console.error("Usage: archivar export --file <path> --format <docx|md|json|raw|log|srt|vct|errors|vlm-requests|asr-requests[,more...]> [--output <file>] [--force]");
    process.exit(1);
  }
  for (const format of formats) {
    if (!VALID_FORMATS.includes(format)) {
      console.error(`Error: unknown export format "${format}". Valid formats: ${VALID_FORMATS.join(", ")}`);
      process.exit(1);
    }
  }
  if (output && formats.length > 1) {
    console.error("Error: --output can only be used with a single format.");
    process.exit(1);
  }

  for (const format of formats) {
    // `view=filtered` routes docx/md/json through the SAME path the dashboard
    // "Download" uses (frontmatter + curated JSON + docx preamble) — Download is
    // the authoritative behavior. `raw`/`log` are verbatim artifacts and stay unfiltered.
    const useFiltered = format === "docx" || format === "md" || format === "json";
    const url = `${server}/api/export?file=${encodeURIComponent(file)}&format=${format}${useFiltered ? "&view=filtered" : ""}${force ? "&force=1" : ""}`;
    const response = await longFetch(url, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error(`Error exporting "${file}" as ${format}: ${response.status} ${body}`);
      process.exit(1);
    }
    const contentType = response.headers.get("Content-Type") ?? "unknown";
    const buffer = Buffer.from(await response.arrayBuffer());
    // Output extension per format (raw → .raw.json so it never collides with the curated json).
    const ext = format === "raw" ? "raw.json" : format === "vct" ? "vct.md" : format === "errors" ? "errors.json" : format === "vlm-requests" ? "vlm-requests.json" : format === "asr-requests" ? "asr-requests.json" : format;
    const outPath = output ?? `${file}.${ext}`;
    writeFileSync(outPath, buffer);
    console.log(`${format}: wrote ${outPath} (${buffer.length} bytes, ${contentType})`);
  }
}

/**
 * Validate archivar.config.ts on the server (loads config, checks model/workflow/plugin references).
 * Prints the config inventory and validation errors; exit 1 if invalid.
 */
async function cmdValidate(server: string, apiKey?: string): Promise<void> {
  const result = (await rpcCall(server, "HealthApi", "validateConfig", [], apiKey)) as {
    ok: boolean;
    errors: string[];
    defaultWorkflow?: string;
    workflows: Array<{ name: string; description?: string; stages: { preProcessing: boolean; processing: string[]; postProcessing: string[] } }>;
    models: Array<{ name: string; type?: string; endpoint?: string; model?: string; enabled: boolean }>;
  };

  console.log(`Workflows (${result.workflows.length}), default: ${result.defaultWorkflow ?? "(none)"}`);
  for (const wf of result.workflows) {
    console.log(`  ${wf.name}${wf.description ? ` — ${wf.description}` : ""}`);
    console.log(`    preProcessing: ${wf.stages.preProcessing ? "yes" : "no"}  processing: [${wf.stages.processing.join(", ")}]  postProcessing: [${wf.stages.postProcessing.join(", ")}]`);
  }
  console.log(`Models (${result.models.length})`);
  for (const model of result.models) {
    console.log(`  ${model.name}  type=${model.type ?? "?"}  endpoint=${model.endpoint ?? "-"}  model=${model.model ?? "-"}${model.enabled ? "" : "  (disabled)"}`);
  }

  if (!result.ok) {
    console.error(`\nConfig is INVALID (${result.errors.length} error(s)):`);
    for (const error of result.errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }
  console.log("\nConfig is valid.");
}

/**
 * Run real inference health checks for every enabled model (same checks as GET /health).
 * Exit 1 unless every model is ok (harness-friendly).
 */
async function cmdHealth(server: string, apiKey?: string): Promise<void> {
  const result = (await rpcCall(server, "HealthApi", "checkModels", [], apiKey)) as {
    status: "ok" | "degraded" | "error";
    checks: Record<string, { ok: boolean; skipped?: boolean; base_url: string; error?: string }>;
  };

  for (const [name, check] of Object.entries(result.checks)) {
    const label = check.skipped ? "SKIP" : check.ok ? "ok  " : "FAIL";
    console.log(`${label}  ${name.padEnd(30)}  ${check.base_url}${check.error ? `  (${check.error})` : ""}`);
  }
  console.log(`\nOverall status: ${result.status}`);
  if (result.status !== "ok") {
    process.exit(1);
  }
}

/**
 * List task statuses (one per analyzed file), newest first.
 * Defaults to tasks currently in processing; --status all|processing|done|error, --json for machine output.
 */
async function cmdStatus(server: string, statusFlag: string | undefined, json: boolean, apiKey?: string): Promise<void> {
  const filter = !statusFlag || statusFlag === "all" ? undefined : statusFlag;
  if (statusFlag && statusFlag !== "all" && !["processing", "done", "error"].includes(statusFlag)) {
    console.error(`Error: invalid --status "${statusFlag}" (valid: processing, done, error, all)`);
    process.exit(1);
  }

  const tasks = (await rpcCall(server, "StatusApi", "listStatuses", [filter], apiKey)) as Array<{
    status: string;
    file: string;
    workflow?: string;
    startedAt: string;
    completedAt?: string;
    error?: string;
  }>;

  if (json) {
    console.log(JSON.stringify(tasks, null, 2));
    return;
  }

  if (tasks.length === 0) {
    console.log(`No tasks${filter ? ` with status "${filter}"` : ""}.`);
    return;
  }

  const duration = (task: { startedAt: string; completedAt?: string }) => {
    const end = task.completedAt ? new Date(task.completedAt).getTime() : Date.now();
    const secs = Math.max(0, Math.round((end - new Date(task.startedAt).getTime()) / 1000));
    return `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, "0")}s`;
  };

  console.log(`${"FILE".padEnd(30)} ${"WORKFLOW".padEnd(20)} ${"STATUS".padEnd(11)} ${"STARTED".padEnd(25)} DURATION`);
  for (const task of tasks) {
    console.log(
      `${task.file.padEnd(30)} ${(task.workflow ?? "-").padEnd(20)} ${task.status.padEnd(11)} ${task.startedAt.padEnd(25)} ${duration(task)}${task.error ? `  error: ${task.error}` : ""}`,
    );
  }
}

function printHelp(): void {
  console.log(`
Archivar CLI

Usage:
  archivar list [pattern]                        List files (default: "*")
  archivar list-segments <file> [--type <type>]   List segments of a file
  archivar workflows                             List available workflows
  archivar workflow-config <name>                Show workflow configuration
  archivar models                                List available models
  archivar analyze --file <path> [options]       Run analysis
  archivar analyze-segment --file <path> [opts]  Analyze a single segment
  archivar post-processing [workflow]            Show post-processing config
  archivar file-config get <file>                Show per-file workflow config
  archivar file-config set <file> [opts]         Update per-file workflow config
  archivar logs --file <path>                    Show debug log of last analysis
  archivar export --file <path> --format <fmt>   Export analysis result (docx|md|json|raw|log|srt|vct|errors|vlm-requests|asr-requests[,more...])
                                                 (json = curated Download view; raw = verbatim debug.json; srt = ASR transcript subtitles; vct = vision caption transcript)
  archivar validate                              Validate archivar.config.ts (models, workflows, plugins)
  archivar health                                Check inference health of every enabled model
  archivar status [--status <s>] [--json]        List tasks (default: currently processing)
  archivar clear-cache <table>                   Clear a cache table
  archivar clear-cache --file <path>             Clear cache/outputs for a file (keeps source)
  archivar delete <file>                         Delete file and its cache/outputs
  archivar purge-orphans                         Remove cache entries with no matching out_* folder

Cache tables: scene, audio, keyframe, speech, aggregated, summary

Global options:
  --server <url>           Server URL (default: ${DEFAULT_SERVER})
  --api-key <key>          API key for authentication (default: from API_KEY env)

Options for analyze:
  --file <path>            File pattern to analyze (required)
  --workflow <name>        Workflow name (default: from server config)
  --format <json|md|toon>  Output format (default: json)
  --output <file>          Write output to file
  --force                  Force re-run: bypass all caches, re-run pre-processing,
                           purge existing entries for this file, then re-run everything
  --only <stage:name>      Run only a specific stage (preProcessing:segmentScenes,
                           processing:scene, postProcessing:default)
  --web-hook-url <url>    URL to call when analysis is complete (called once)
  --model <name>           Override model for a specific media type (use with --type)
  --prompt <text>          Override prompt for a specific media type (use with --type)
  --type <mediaType>       Media type to override (speech|scene|keyframe|harmonic|noise)

Per-clip-type overrides (take precedence over --model/--type):
  --speech-model <name>    Override model for speech clips
  --speech-prompt <text>   Override prompt for speech clips
  --scene-model <name>     Override model for video/scene clips
  --scene-prompt <text>    Override prompt for video/scene clips
  --keyframe-model <name>  Override model for keyframe clips
  --keyframe-prompt <text> Override prompt for keyframe clips
  --harmonic-model <name>  Override model for harmonic clips
  --harmonic-prompt <text> Override prompt for harmonic clips
  --noise-model <name>     Override model for noise clips
  --noise-prompt <text>    Override prompt for noise clips
  --config-file <path>     JSON file with per-type overrides (lowest precedence)

Post-processing options for analyze:
  --post-processing <a,b>  Comma-separated list of plugins to enable
  --no-post-processing     Disable all post-processing plugins

Exit codes for analyze:
  0 = completed cleanly (no non-fatal errors)
  1 = hard failure (run could not complete, e.g. pre-flight endpoint check failed)
  2 = completed but DEGRADED (non-fatal errors recorded; output may be incomplete —
      inspect: pnpm cli export --file <path> --format errors)

Options for analyze-segment:
  --file <path>            Segment file path (required)
  --type <mediaType>       Media type (required: speech|scene|keyframe|harmonic|noise)
  --model <name>           Model name (required)
  --prompt <text>          Prompt text (default: "")
  --system-prompt <text>   System prompt (optional)
  --output <file>          Write output to file

Options for file-config set:
  --type <mediaType>       Media type (required)
  --model <name>           Model name (required)
  --prompt <text>          Prompt text (default: "")

Options for export:
  --file <path>            File to export (required)
  --format <fmt[,more]>    Export formats: docx, md, json, raw, log, srt, vct, errors, vlm-requests, asr-requests (comma-separated)
  --output <file>          Output path (single format only; default: ./<file>.<fmt>)
  --force                  Regenerate export even if it exists on the server
  Note: 'export --format log|json' is the generalized equivalent of 'logs'/'raw'
  (which print to stdout instead of writing files).

Options for status:
  --status <processing|done|error|all>   Filter by task status (default: processing)
  --json                                 Print machine-readable JSON

Exit codes: 'validate' exits 1 on invalid config, 'health' exits 1 unless all
models are ok — both are safe to use in scripts/harnesses.

Examples:
  archivar list "*.mp4"
  archivar workflows
  archivar models
  archivar analyze --file "demo.mp4" --workflow default-analysis-gemma4-e4b --format md
  archivar analyze --file "demo.mp4" --type speech --model qwen-asr-0.6b
  archivar analyze --file "demo.mp4" --speech-model qwen-asr-0.6b --keyframe-model gemma4-e4b-qat-w4a16
  archivar analyze --file "demo.mp4" --speech-model qwen-asr-0.6b --keyframe-prompt "Describe in German"
  archivar analyze --file "demo.mp4" --config-file overrides.json
  archivar analyze-segment --file "segment.wav" --type speech --model qwen-asr-0.6b
  archivar analyze-segment --file "keyframe.jpg" --type keyframe --model gemma4-e4b-qat-w4a16 --prompt "Describe in German"
  archivar file-config get "demo.mp4"
  archivar file-config set "demo.mp4" --type speech --model qwen-asr-0.6b
  archivar list-segments "demo.mp4"
  archivar list-segments "demo.mp4" --type speech
  archivar post-processing default-analysis-gemma4-e4b
  archivar export --file "demo.mp4" --format docx
  archivar export --file "demo.mp4" --format md,json,log
  archivar validate
  archivar health
  archivar status
  archivar status --status all --json
  archivar clear-cache aggregated
  archivar clear-cache summary
  archivar delete "video.mp4"
`);
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const { command, positional, flags } = parseArgs(process.argv);
  const server = flags.server ?? DEFAULT_SERVER;
  const apiKey = flags["api-key"] ?? DEFAULT_API_KEY;

  try {
    switch (command) {
      case "list":
        await cmdList(server, positional[0] ?? "*", apiKey);
        break;

      case "list-segments": {
        const fileArg = positional[0] ?? flags.file;
        if (!fileArg) {
          console.error("Usage: archivar list-segments <file> [--type <segmentType>]");
          process.exit(1);
        }
        await cmdListSegments(server, fileArg, flags.type, apiKey);
        break;
      }

      case "workflows":
        await cmdWorkflows(server, apiKey);
        break;

      case "workflow-config":
        if (!positional[0]) {
          console.error("Usage: archivar workflow-config <name>");
          process.exit(1);
        }
        await cmdWorkflowConfig(server, positional[0], apiKey);
        break;

      case "analyze":
        if (!flags.file) {
          console.error("Error: --file is required for analyze command.");
          console.error("Usage: archivar analyze --file <path> [--workflow <name>] [--format <json|md|toon>]");
          process.exit(1);
        }
        await cmdAnalyze(server, flags.file, flags, apiKey);
        break;

      case "models":
        await cmdModels(server, apiKey);
        break;

      case "analyze-segment": {
        if (!flags.file || !flags.type || !flags.model) {
          console.error("Error: --file, --type, and --model are required for analyze-segment.");
          console.error("Usage: archivar analyze-segment --file <path> --type <mediaType> --model <name> [--prompt <text>]");
          process.exit(1);
        }
        await cmdAnalyzeSegment(
          server, flags.file, flags.type, flags.model,
          flags.prompt ?? "", flags["system-prompt"], flags.output, apiKey,
        );
        break;
      }

      case "file-config": {
        const subCommand = positional[0];
        const filePath = positional[1] ?? flags.file;
        if (!subCommand || !filePath) {
          console.error("Usage: archivar file-config <get|set> <file> [options]");
          process.exit(1);
        }
        if (subCommand === "get") {
          await cmdFileConfigGet(server, filePath, apiKey);
        } else if (subCommand === "set") {
          if (!flags.type || !flags.model) {
            console.error("Error: --type and --model are required for file-config set.");
            process.exit(1);
          }
          await cmdFileConfigSet(server, filePath, flags.type, flags.model, flags.prompt ?? "", apiKey);
        } else {
          console.error(`Unknown file-config sub-command: ${subCommand}`);
          process.exit(1);
        }
        break;
      }

      case "post-processing": {
        const wfName = positional[0] ?? flags.workflow;
        await cmdPostProcessing(server, wfName, apiKey);
        break;
      }

      case "clear-cache": {
        // DEPRECATED member: "summary" is an unused cache table (nothing writes
        // or reads it); kept in VALID_TABLES so existing scripts don't break.
        const VALID_TABLES = ["scene", "audio", "keyframe", "speech", "aggregated", "summary"];
        const table = positional[0];
        const file = flags.file;
        if (file) {
          // --file flag: clear cache + outputs for a specific file
          const result = (await rpcCall(server, "FileApi", "clearFileCache", [file], apiKey)) as {
            status: "cleared" | "error";
            removed?: number;
            error?: string;
            warnings?: string[];
          };
          if (result.status === "error") {
            console.error(`Error: ${result.error}`);
            process.exit(1);
          }
          console.log(`Cache cleared for "${file}" (${result.removed ?? 0} cache entries removed).`);
          for (const warning of result.warnings ?? []) {
            console.error(`WARNING — stale outputs remain: ${warning}`);
          }
        } else if (table && VALID_TABLES.includes(table)) {
          // Positional arg matching a table name: clear entire table
          await rpcCall(server, "CacheApi", "clear", [table], apiKey);
          console.log(`Cache table "${table}" cleared.`);
        } else {
          console.error(`Usage: archivar clear-cache <table> [--file <path>]`);
          console.error(`Valid tables: ${VALID_TABLES.join(", ")}`);
          process.exit(1);
        }
        break;
      }

      case "delete": {
        const file = positional[0];
        if (!file) {
          console.error("Usage: archivar delete <file>");
          process.exit(1);
        }
        const result = (await rpcCall(server, "FileApi", "deleteFile", [file], apiKey)) as {
          status: "deleted" | "error";
          removed?: number;
          error?: string;
        };
        if (result.status === "error") {
          console.error(`Error: ${result.error}`);
          process.exit(1);
        }
        console.log(`Deleted "${file}" (${result.removed ?? 0} cache entries removed).`);
        break;
      }

      case "purge-orphans": {
        // Maintenance command: remove cache entries whose outputHash no longer
        // corresponds to any existing out_* folder on disk.
        const result = (await rpcCall(server, "CacheApi", "purgeOrphans", [], apiKey)) as {
          tables: Record<string, number>;
          totalRemoved: number;
        };
        console.log("Purge results (orphaned entries removed):");
        for (const [table, count] of Object.entries(result.tables)) {
          console.log(`  ${table.padEnd(12)} ${count}`);
        }
        console.log(`Total: ${result.totalRemoved} orphaned entry/entries removed.`);
        break;
      }

      case "logs": {
        const logFile = flags.file;
        if (!logFile) {
          console.error("Error: --file is required for logs command.");
          console.error("Usage: archivar logs --file <path>");
          process.exit(1);
        }
        await cmdLogs(server, logFile, apiKey);
        break;
      }

      // `archivar raw` is deprecated — use `archivar export --file <path> --format raw`
      // (same verbatim debug.json output). Keep a thin pointer so existing scripts
      // get an actionable message instead of a silent no-op.
      case "raw": {
        console.error("'raw' is deprecated. Use: archivar export --file <path> --format raw");
        process.exit(1);
      }

      case "export": {
        if (!flags.file) {
          console.error("Error: --file is required for export command.");
          console.error("Usage: archivar export --file <path> --format <docx|md|json|raw|log|srt|vct|errors|vlm-requests|asr-requests[,more...]> [--output <file>] [--force]");
          process.exit(1);
        }
        await cmdExport(server, flags.file, flags.format, flags.output, flags.force === "true");
        break;
      }

      case "validate":
        await cmdValidate(server, apiKey);
        break;

      case "health":
        await cmdHealth(server, apiKey);
        break;

      case "status":
        await cmdStatus(server, flags.status ?? "processing", flags.json === "true", apiKey);
        break;

      case "help":
      case "--help":
      case "-h":
        printHelp();
        break;

      default:
        console.error(`Unknown command: ${command}`);
        printHelp();
        process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main();
