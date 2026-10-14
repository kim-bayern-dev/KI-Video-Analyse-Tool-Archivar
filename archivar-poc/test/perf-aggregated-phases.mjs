// Standalone breakdown of CacheApi.getAll("aggregated") cost.
// Run: node test/perf-aggregated-phases.mjs
import { readFileSync } from "node:fs";
import { DSON } from "defuss-dson";

const DB = "../sample_data/archivar/aggregated.db";

// 1. disk read + outer JSON.parse (happens once at server startup, not per request)
let t0 = performance.now();
const outer = JSON.parse(readFileSync(DB, "utf8"));
const keys = Object.keys(outer);
console.log(`startup load: ${(performance.now() - t0).toFixed(0)}ms, ${keys.length} entries`);

// 2. per-request: FileStorageProvider.getAll -> JSON.parse every value (double-encoded)
t0 = performance.now();
const result = {};
for (const [k, v] of Object.entries(outer)) result[k] = JSON.parse(v);
console.log(`server getAll (JSON.parse all values): ${(performance.now() - t0).toFixed(0)}ms`);

// 3. per-request: defuss-rpc DSON.stringify of the whole record
t0 = performance.now();
const wire = DSON.stringify(result);
console.log(`server DSON.stringify: ${(performance.now() - t0).toFixed(0)}ms, wire size ${(wire.length / 1e6).toFixed(1)}MB`);

// 4. client: DSON.parse
t0 = performance.now();
DSON.parse(wire);
console.log(`client DSON.parse: ${(performance.now() - t0).toFixed(0)}ms`);

// reference: what the dashboard actually needs — one entry matching a hash substring
const biggest = keys.reduce((a, b) => (outer[a].length > outer[b].length ? a : b));
console.log(`largest entry: ${(outer[biggest].length / 1e6).toFixed(1)}MB (${biggest.slice(0, 80)}...)`);
const sizes = keys.map((k) => outer[k].length).sort((a, b) => b - a);
console.log(`top-5 entry sizes MB: ${sizes.slice(0, 5).map((s) => (s / 1e6).toFixed(1)).join(", ")}`);
