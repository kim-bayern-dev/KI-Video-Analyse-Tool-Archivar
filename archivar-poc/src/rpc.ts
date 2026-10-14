import { createRpcServer, addHook } from "defuss-rpc/server.js";
import { AuthApi } from "./rpc/auth.js";
import { FileApi } from "./rpc/file-api.js";
import { AnalyseApi } from "./rpc/analyse-api.js";
import { MllmApi } from "./rpc/mllm-api.js";
import { load, getEnv } from "defuss-env";
import { CacheApi } from "./rpc/cache-api.js";
import { StatusApi } from "./rpc/status-api.js";
import { WebhookApi } from "./rpc/webhook-api.js";
import { ExportApi } from "./rpc/export-api.js";
import { HealthApi } from "./rpc/health-api.js";
// Binary upload handler is auto-registered via addUploadHandler in file-upload-api.ts
import "./rpc/file-upload-api.js";
// Legacy RPC-based upload (commented out — replaced by binary transport)
// import { FileUploadApi } from "./rpc/file-upload-api.js";

// Load archivar config (registers users etc.)
import "../archivar.config.js";

// Default to the project's actual env file (.env.local); ENV_FILE still overrides.
load(getEnv('ENV_FILE', '.env.local'));

const API_KEY = getEnv('API_KEY', '');

// server-side RPC API definition
export const RpcApi = {
  AuthApi,
  FileApi,
  // FileUploadApi, // Legacy — replaced by binary transport (addUploadHandler)
  AnalyseApi,
  MllmApi,
  CacheApi,
  StatusApi,
  WebhookApi,
  ExportApi,
  HealthApi,
};

interface WhitelistRpcCall {
  className: string;
  methodName: string;
}

const rpcCallWhitelist: WhitelistRpcCall[] = [
  { className: "AuthApi", methodName: "login" },
  { className: "AuthApi", methodName: "logout" },
  { className: "FileApi", methodName: "listFiles" },
  { className: "FileApi", methodName: "listFilesSummary" },
  { className: "AnalyseApi", methodName: "segmentScenes" },
  { className: "AnalyseApi", methodName: "segmentTemporal" },
  { className: "MllmApi", methodName: "captionAudios" },
  { className: "MllmApi", methodName: "captionVideos" },
  { className: "MllmApi", methodName: "captionImage" },
  { className: "MllmApi", methodName: "captionSound" },
  { className: "CacheApi", methodName: "clear" },
  { className: "CacheApi", methodName: "get" },
  { className: "CacheApi", methodName: "set" },
  { className: "CacheApi", methodName: "getAll" },
  { className: "CacheApi", methodName: "getByKeySubstring" },
  { className: "CacheApi", methodName: "getCaptionsByHash" },
  { className: "CacheApi", methodName: "getAnalysisViewByHash" },
  { className: "AnalyseApi", methodName: "runWorkflow" },
  { className: "AnalyseApi", methodName: "listWorkflows" },
  { className: "AnalyseApi", methodName: "getWorkflowConfig" },
  { className: "AnalyseApi", methodName: "getFileWorkflowConfig" },
  { className: "AnalyseApi", methodName: "saveFileWorkflowConfig" },
  { className: "AnalyseApi", methodName: "getEffectiveWorkflowConfig" },
  { className: "AnalyseApi", methodName: "getAnalysisDefaults" },
  { className: "AnalyseApi", methodName: "getAllAnalysisDefaults" },
  { className: "AnalyseApi", methodName: "analyzeSegment" },
  { className: "AnalyseApi", methodName: "listModels" },
  { className: "AnalyseApi", methodName: "getPostProcessingDefaults" },
  // Legacy upload whitelist — replaced by binary transport (addUploadHandler)
  // { className: "FileUploadApi", methodName: "checkFileExists" },
  // { className: "FileUploadApi", methodName: "startUpload" },
  // { className: "FileUploadApi", methodName: "uploadChunk" },
  // { className: "FileUploadApi", methodName: "finalizeUpload" },
  // { className: "FileUploadApi", methodName: "cancelUpload" },
  { className: "FileApi", methodName: "checkFileExists" },
  { className: "FileApi", methodName: "finalizeChunkedUpload" },
  { className: "FileApi", methodName: "discardChunkedUpload" },
  { className: "FileApi", methodName: "deleteFile" },
  { className: "FileApi", methodName: "clearFileCache" },
  { className: "FileApi", methodName: "readFile" },
  { className: "FileApi", methodName: "tailDebugLog" },
  { className: "CacheApi", methodName: "removeByPrefix" },
  { className: "__upload__", methodName: "file-upload" },
  { className: "__upload__", methodName: "file-chunk" },
  // StatusApi
  { className: "StatusApi", methodName: "getStatus" },
  { className: "StatusApi", methodName: "listStatuses" },
  { className: "StatusApi", methodName: "setStatus" },
  { className: "StatusApi", methodName: "startProcessing" },
  { className: "StatusApi", methodName: "markDone" },
  { className: "StatusApi", methodName: "markError" },
  { className: "StatusApi", methodName: "clearStatus" },
  // WebhookApi
  { className: "WebhookApi", methodName: "getWebhook" },
  { className: "WebhookApi", methodName: "setWebhook" },
  { className: "WebhookApi", methodName: "deliverWebhook" },
  // ExportApi
  { className: "ExportApi", methodName: "export" },
  { className: "ExportApi", methodName: "list" },
  // HealthApi
  { className: "HealthApi", methodName: "validateConfig" },
  { className: "HealthApi", methodName: "checkModels" },
];

// Paths that must remain reachable without authentication. The RPC schema is
// fetched by the client to bootstrap the typed RPC client BEFORE login, and the
// AuthApi.login/logout calls are the login flow itself. Gating any of these
// creates a catch-22 where no user can ever sign in.
const PUBLIC_RPC_PATH_SUFFIXES = ["/rpc/schema"];

function isPublicRpcRequest(request: Request): boolean {
  try {
    const pathname = new URL(request.url).pathname.replace(/\/+$/, "");
    return PUBLIC_RPC_PATH_SUFFIXES.some((suffix) => pathname.endsWith(suffix));
  } catch {
    return false;
  }
}

// ACL hook to guard RPC calls
addHook({
  phase: "guard",
  fn: (
    className: string,
    methodName: string,
    args: unknown[],
    request: Request,
  ) => {
    // The schema (and other PUBLIC_RPC_PATH_SUFFIXES) must always be served
    // without auth so unauthenticated clients can bootstrap login.
    if (isPublicRpcRequest(request)) {
      return true;
    }

    console.log("RPC Call:", { className, methodName, args });
    const token = request.headers.get("Authorization");
    const apiKey = request.headers.get("x-api-key");

    // API key auth: if a valid API key is provided, allow the call
    if (API_KEY && apiKey === API_KEY) {
      return true;
    }

    // check for whitelisted RPC calls and call through, else return false
    if (
      !rpcCallWhitelist.find(
        (rpcCall) =>
          rpcCall.className === className && rpcCall.methodName === methodName,
      )
    ) {
      // Auth required for non-whitelisted calls
      if (!token) {
        console.log("Blocking RPC Call:", { className, methodName, args });
        return false; // block the call
      }
    }
    return true; // allow the call
  },
});

createRpcServer(RpcApi); // expose the RPC API

// client-side RPC API type
export type RpcApi = typeof RpcApi;
