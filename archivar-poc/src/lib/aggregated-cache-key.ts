/**
 * Reader-side matcher for the `aggregated` cache table.
 *
 * The workflow engine writes aggregated results under
 * `${workflowName}-${outputHash}-${pluginVersions}` (WS4, see
 * resolveAggregatedCacheKey in workflow-engine.ts). Readers without access to
 * the plugin definitions (CSR dashboard, client-side full-analysis) cannot
 * reconstruct the version segment, so they match by the
 * `${workflowName}-${outputHash}` prefix instead.
 *
 * Versioned keys (engine-written, fresh) are preferred over legacy exact keys
 * `${workflowName}-${outputHash}` (written by the CSR full-analysis path or by
 * pre-WS4 engines).
 */
export function findAggregatedCacheKey(
  keys: string[],
  workflowName: string,
  outputHash: string,
): string | undefined {
  const legacyKey = `${workflowName}-${outputHash}`;
  // First-match-wins: when several versioned keys share the prefix (stale
  // entries written under older pluginVersions and never cleaned up), which
  // one a reader gets depends on `keys` enumeration order. Readers accept this
  // because any versioned entry satisfies the shape; pruning stale keys is the
  // writer's (workflow-engine's) responsibility, not the reader's.
  return keys.find((k) => k.startsWith(`${legacyKey}-`)) ?? keys.find((k) => k === legacyKey);
}
