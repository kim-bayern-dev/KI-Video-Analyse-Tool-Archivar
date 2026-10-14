// DEPRECATED: no caller anywhere. The upload wizard uploads via `/rpc/upload`
// (src/csr/lib/upload-client.ts), not this REST endpoint; no test or CLI usage
// either.
import type { APIRoute } from "astro";
import { writeFile } from "fs/promises";
import { resolve, basename } from "path";
import { getEnv } from "defuss-env";

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const formData = await request.formData();
  const file = formData.get("file");

  if (!file || !(file instanceof File)) {
    return new Response(JSON.stringify({ error: "No file provided" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const sampleDataSubDir = getEnv("SAMPLE_DATA_SUBDIR", "sample_data/archivar");
  const relativeSampleDataPath = getEnv("RELATIVE_SAMPLE_DATA_PATH", `../${sampleDataSubDir}`);
  const dataDir = resolve(process.cwd(), relativeSampleDataPath);

  // Sanitize filename to prevent path traversal
  const safeName = basename(file.name).replace(/[^a-zA-Z0-9._-]/g, "_");
  const destPath = resolve(dataDir, safeName);

  // Ensure the resolved path is still within dataDir
  if (!destPath.startsWith(dataDir)) {
    return new Response(JSON.stringify({ error: "Invalid file name" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(destPath, buffer);

  return new Response(JSON.stringify({ ok: true, fileName: safeName }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
