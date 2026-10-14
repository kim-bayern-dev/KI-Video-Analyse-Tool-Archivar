import { rpcRoute } from "defuss-rpc/server.js";
// Side-effect import: registers every RPC procedure (AuthApi, FileApi,
// AnalyseApi, CacheApi, ...) on the defuss-rpc dispatcher and loads env +
// archivar.config. Without it, rpcRoute below would have nothing bound.
// Procedure catalogue: src/rpc.ts.
import "../../rpc.js";

// export * from "defuss-rpc/api" which does this
export const prerender = false;
export const GET = rpcRoute;
export const POST = rpcRoute;
