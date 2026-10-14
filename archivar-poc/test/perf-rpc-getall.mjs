// Quick perf probe: mimics the dashboard's aggregation loading via RPC.
// Run: node test/perf-rpc-getall.mjs
import { createRpcClient } from "defuss-rpc/client.js";

const baseUrl = process.env.SERVER_URL ?? "http://localhost:8802";

async function main() {
    const tClient0 = performance.now();
    const api = await createRpcClient({ baseUrl });
    console.log(`schema fetch: ${(performance.now() - tClient0).toFixed(0)}ms`);
    const cache = new api.CacheApi();

    for (const table of ["aggregated", "scene", "speech", "keyframe", "audio"]) {
        const t0 = performance.now();
        const result = await cache.getAll(table);
        const dt = performance.now() - t0;
        const bytes = JSON.stringify(result).length;
        console.log(`getAll("${table}"): ${dt.toFixed(0)}ms round-trip, ${Object.keys(result).length} entries, ~${(bytes / 1e6).toFixed(1)}MB parsed payload`);
    }

    // new targeted method — what the dashboard uses now
    for (const sub of ["0a1dfdc3", "wav"]) {
        const t0 = performance.now();
        const result = await cache.getByKeySubstring("aggregated", sub);
        const dt = performance.now() - t0;
        const bytes = JSON.stringify(result).length;
        console.log(`getByKeySubstring("aggregated", "${sub}"): ${dt.toFixed(0)}ms round-trip, ${Object.keys(result).length} entries, ~${(bytes / 1e6).toFixed(1)}MB parsed payload`);
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
