/**
 * Verifies the debug.log console capture is SCOPED to the workflow's own async
 * context (AsyncLocalStorage), not global.
 *
 * Background: runWorkflow used to globally replace console.log/error/warn, which
 * teed every concurrent request's output into one workflow's debug.log. The fix
 * installs wrappers once that tee only while a `debugCapture` store is active for
 * the current async tree. These tests prove: output is captured INSIDE
 * `debugCapture.run`, and NOT captured before/after (i.e. concurrent, unrelated
 * contexts are isolated).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { debugCapture } from "../src/rpc/workflow-engine.js";

describe("scoped debug-log console capture (AsyncLocalStorage)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "archivar-cap-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Resolve once the writable stream has flushed + closed. */
  function closed(stream: ReturnType<typeof createWriteStream>): Promise<void> {
    return new Promise((resolve) => stream.once("close", () => resolve()));
  }

  it("tees console only inside debugCapture.run, not before or after", async () => {
    const logPath = join(dir, "debug.log");
    const stream = createWriteStream(logPath, { flags: "w" });

    // Before entering the store: top-level context → must NOT be teed.
    console.log("BEFORE_LINE");
    await debugCapture.run({ logStream: stream }, async () => {
      // Inside the workflow's async tree → must be teed.
      console.log("INSIDE_LINE");
    });
    // After run() returns: back to top-level context → must NOT be teed.
    console.log("AFTER_LINE");

    stream.end();
    await closed(stream);

    const content = await readFile(logPath, "utf8");
    expect(content).toContain("INSIDE_LINE");
    expect(content).not.toContain("BEFORE_LINE");
    expect(content).not.toContain("AFTER_LINE");
  });

  it("does not tee once the capture stream is cleared (cleanup parity)", async () => {
    const logPath = join(dir, "debug.log");
    const stream = createWriteStream(logPath, { flags: "w" });
    const capture = { logStream: stream as ReturnType<typeof createWriteStream> | null };

    await debugCapture.run(capture, async () => {
      console.log("WHILE_ACTIVE");
      // Simulate the runWorkflow cleanup: null the stream.
      capture.logStream = null;
      console.log("AFTER_CLEARED");
    });

    stream.end();
    await closed(stream);

    const content = await readFile(logPath, "utf8");
    expect(content).toContain("WHILE_ACTIVE");
    // After the stream is nulled, even within the store, nothing more is written.
    expect(content).not.toContain("AFTER_CLEARED");
  });
});
