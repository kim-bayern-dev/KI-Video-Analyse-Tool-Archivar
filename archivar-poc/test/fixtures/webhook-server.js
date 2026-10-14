/**
 * webhook-server.js — Mini webhook receiver for API E2E testing
 *
 * This server listens for POST /webhook, writes the payload to a file,
 * logs to a .log file, and exits after receiving or timing out.
 *
 * Usage:
 *   node webhook-server.js [--port <port>] [--output <path>] [--timeout <ms>]
 *
 * Environment variables also supported:
 *   PORT=9876 OUTPUT=./.curl-webhook-test.json TIMEOUT=600000 node webhook-server.js
 *
 * @module webhook-server
 */

import { createServer } from "node:http";
import { writeFileSync, appendFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
let port = 9876;
let outputPath = "./.curl-webhook-test.json";
let timeoutMs = 600000; // 10 minutes default

for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case "--port":
      port = parseInt(args[++i], 10);
      break;
    case "--output":
      outputPath = args[++i];
      break;
    case "--timeout":
      timeoutMs = parseInt(args[++i], 10);
      break;
    default:
      console.error(`Unknown argument: ${args[i]}`);
      process.exit(1);
  }
}

// Allow env vars to override
port = parseInt(process.env.PORT || String(port), 10);
outputPath = process.env.OUTPUT || outputPath;
timeoutMs = parseInt(process.env.TIMEOUT || String(timeoutMs), 10);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let received = false;
const logPath = outputPath + ".log";

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const server = createServer((req, res) => {
  if (req.url === "/webhook" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      console.log("[webhook] Received webhook!");
      console.log("[webhook] Body:", body);
      try {
        const parsed = JSON.parse(body);
        writeFileSync(outputPath, JSON.stringify(parsed, null, 2));
        appendFileSync(logPath, `[${new Date().toISOString()}] Received:\n${body}\n`);
        received = true;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        console.log("[webhook] Wrote payload to", outputPath);
        // Exit after a short delay to allow cleanup
        setTimeout(() => process.exit(0), 500);
      } catch (err) {
        console.error("[webhook] Parse error:", err);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(port, () => {
  console.log(`[webhook] Listening on http://localhost:${port}/webhook`);
});

// ---------------------------------------------------------------------------
// Auto-exit on timeout
// ---------------------------------------------------------------------------
setTimeout(() => {
  if (!received) {
    console.log(`[webhook] Timeout after ${timeoutMs / 1000}s — no webhook received`);
    appendFileSync(logPath, `[${new Date().toISOString()}] TIMEOUT: no webhook received\n`);
  }
  process.exit(received ? 0 : 1);
}, timeoutMs);
