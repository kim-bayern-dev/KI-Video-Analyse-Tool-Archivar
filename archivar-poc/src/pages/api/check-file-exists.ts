// DEPRECATED: no caller anywhere. The upload wizard checks existence via RPC
// (`FileApi.checkFileExists`, src/csr/lib/upload-client.ts), not this REST
// endpoint; no test or CLI usage either.
import type { APIRoute } from "astro";
import { checkFileExists } from "../../../src/rpc/file-upload-api.js";

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  console.log(`[api] check-file-exists request from ${request.headers.get("origin") || "unknown"}`);
  try {
    const ct = request.headers.get("content-type") || "";
    console.log(`[api] content-type: ${ct}`);
    const body = await request.json().catch((e) => {
      console.error(`[api] JSON parse error:`, e);
      return null;
    });
    console.log(`[api] body:`, body);
    const fileName = body?.fileName;
    if (!fileName) {
      console.error(`[api] missing fileName in request body`);
      return new Response(JSON.stringify({ error: "missing fileName" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const result = await checkFileExists(fileName);
    console.log(`[api] result:`, result);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error(`[api] check-file-exists error:`, err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
