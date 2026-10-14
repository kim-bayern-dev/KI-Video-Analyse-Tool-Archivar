import type { TimingEntry } from "./workflow-types.js";

// Use performance.now() if available (Node.js v8+, browsers), fallback to Date.now()
const nowFn = typeof performance !== "undefined" && performance.now
  ? () => performance.now()
  : () => Date.now();

/**
 * A timing handle that tracks the start time of a child scope.
 * Call end() to finalize and emit the timing measurement.
 */
export class TimingHandle {
  private _collector: TimingCollector;
  private _entry: TimingEntry;
  private _t0: number;
  private _ended = false;

  constructor(collector: TimingCollector, label: string, reference?: string) {
    this._collector = collector;
    this._entry = {
      label,
      durationMs: 0,
      children: [],
      ...(reference ? { reference } : {}),
    };
    this._t0 = nowFn();
    collector._addPending(this);
  }

  /**
   * Finalizes this child scope:
   * 1. Computes durationMs via now() - t0
   * 2. Emits console.log("[TIMER] <label>: <durationMs.toFixed(1)}ms") for backward compatibility
   *    with existing debug.log parsing (replaces existing console.time/console.timeEnd calls)
   * 3. Returns the TimingEntry for tree building
   */
  end(): TimingEntry {
    if (this._ended) return this._entry;
    this._ended = true;
    this._entry.durationMs = Math.round((nowFn() - this._t0) * 1000) / 1000;
    console.log(`[TIMER] ${this._entry.label}: ${this._entry.durationMs.toFixed(1)}ms`);
    this._collector._finalizeChild(this);
    return this._entry;
  }

  /** Start a nested (grandchild) scope under this handle. */
  // REFACTOR(consistency): the name implies exactly depth-2 nesting, but this
  // is the generic "begin child of this handle" — workflow-engine.ts:1381
  // calls it on a grandchild handle to create depth-3 segment scopes. Renaming
  // to `beginChild` (mirroring TimingCollector) touches ~15 call sites in
  // src/rpc/workflow-engine.ts, so do it in one dedicated pass.
  beginGrandChild(label: string, reference?: string): TimingHandle {
    const child = new TimingHandle(this._collector, label, reference);
    this._entry.children ??= [];
    this._entry.children.push(child._entry);
    return child;
  }

  /** Public read access to the entry; TimingCollector attaches it to the tree. */
  get entry(): TimingEntry {
    return this._entry;
  }
}

/**
 * Collects hierarchical timing measurements.
 *
 * Usage:
 *   const collector = new TimingCollector("workflow:full-analysis");
 *   const stage = collector.beginChild("preProcessing");
 *   // ... do work ...
 *   const entry = stage.end(); // logs & returns TimingEntry
 *   const tree = collector.finalize(); // returns root TimingEntry
 */
export class TimingCollector {
  private root: TimingEntry;
  private _t0: number;
  private _pending = new Set<TimingHandle>();

  constructor(label: string, reference?: string) {
    this.root = {
      label,
      durationMs: 0,
      children: [],
      ...(reference ? { reference } : {}),
    };
    this._t0 = nowFn();
  }

  /** Start a child scope. Returns a handle to end it. */
  beginChild(label: string, reference?: string): TimingHandle {
    const child = new TimingHandle(this, label, reference);
    this.root.children ??= [];
    this.root.children.push(child.entry);
    return child;
  }

  /**
   * Finalize: computes root.durationMs and returns the complete tree.
   *
   * Note: this does NOT close anything — in-flight handles can still be ended
   * afterwards and will keep mutating the returned tree (children are attached
   * by reference at begin time). The only differences from snapshot() are the
   * root-level [TIMER] log line and the semantic "this is the final write"
   * intent (workflow-engine.ts uses snapshot() for incremental debug.json
   * writes and finalize() for the last one).
   */
  finalize(): TimingEntry {
    this.root.durationMs = Math.round((nowFn() - this._t0) * 1000) / 1000;
    console.log(`[TIMER] ${this.root.label}: ${this.root.durationMs.toFixed(1)}ms`);
    return this.root;
  }

  /**
   * Non-destructive snapshot of the timing tree so far.
   *
   * Exists for incremental debug.json writes: returns the current root with an
   * up-to-date durationMs WITHOUT finalizing (in-flight stages stay open and can
   * still be ended later). Unlike finalize(), this is safe to call repeatedly
   * mid-workflow.
   */
  snapshot(): TimingEntry {
    this.root.durationMs = Math.round((nowFn() - this._t0) * 1000) / 1000;
    return this.root;
  }

  // REFACTOR(kiss): `_pending` is written here and deleted in _finalizeChild
  // but never read anywhere — dead bookkeeping (the _finalizeChild comment
  // already admits "no-op for now"). Either drop the set + both underscore
  // methods, or make it earn its keep (e.g. warn on finalize() with handles
  // still pending, which would catch forgotten end() calls).
  // Internal: track pending handles for ordering
  _addPending(handle: TimingHandle): void {
    this._pending.add(handle);
  }

  // Internal: remove handle when finalized (no-op for now, kept for future use)
  _finalizeChild(_handle: TimingHandle): void {
    this._pending.delete(_handle);
  }
}
