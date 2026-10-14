import type { TimingEntry } from "./workflow-types.js";

export interface TreeRendererOptions {
  /** Show reference if available */
  showReference?: boolean;
  /** Maximum indentation depth (prevents overly deep trees) */
  maxDepth?: number;
  /** Format duration (ms, s, or human-readable like "12.5s") */
  durationFormat?: "ms" | "s" | "human";
}

/** Format duration based on options */
function formatDuration(ms: number, format: "ms" | "s" | "human"): string {
  switch (format) {
    case "ms":
      return `${ms.toFixed(1)}ms`;
    case "s":
      return `${(ms / 1000).toFixed(2)}s`;
    case "human":
    default:
      if (ms < 1000) return `${ms.toFixed(1)}ms`;
      if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
      return `${(ms / 60000).toFixed(1)}min`;
  }
}

/**
 * Renders a TimingEntry tree as ASCII art for debug.log output.
 *
 * Example output:
 * ```
 * workflow:full-analysis (182.3s)
 * ├── preProcessing (12.4s)
 * │   ├── segmentTemporal (5.2s)
 * │   │   └── reference: out_video1_segment-temporal_segments.json
 * │   └── segmentScenes (7.2s)
 * ```
 */
export function renderTimingTree(
  entry: TimingEntry,
  options?: TreeRendererOptions,
): string {
  const opts = {
    showReference: true,
    maxDepth: 10,
    durationFormat: "human" as "ms" | "s" | "human",
    ...options,
  };

  const lines: string[] = [];

  /**
   * Render entry with accumulated prefix.
   * `prefix` contains the vertical connector chars (│/ ) from all ancestors.
   */
  function render(entry: TimingEntry, prefix: string, isLast: boolean, depth: number): void {
    if (depth > opts.maxDepth) {
      lines.push(`${prefix}... (max depth reached)`);
      return;
    }

    // Connector: ├── for non-last, └── for last (skip for root)
    const connector = depth === 0 ? "" : (isLast ? "└── " : "├── ");
    const duration = formatDuration(entry.durationMs, opts.durationFormat);
    lines.push(`${prefix}${connector}${entry.label} (${duration})`);

    // Render reference if available
    if (entry.reference && opts.showReference) {
      lines.push(`${prefix}${connector}  reference: ${entry.reference}`);
    }

    // Continuation for children: │   for non-last, "    " for last
    const continuation = depth === 0 ? "" : (isLast ? "    " : "│   ");
    const childPrefix = prefix + continuation;

    // Render children
    if (entry.children && entry.children.length > 0) {
      const childCount = entry.children.length;
      entry.children.forEach((child, i) => {
        const childIsLast = i === childCount - 1;
        render(child, childPrefix, childIsLast, depth + 1);
      });
    }
  }

  render(entry, "", true /* root is effectively "last" */, 0);
  return lines.join("\n");
}
