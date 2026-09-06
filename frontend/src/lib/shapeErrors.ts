// =============================================================================
// shapeErrors — a failed feed is not an empty one, and the screen must say so
// =============================================================================
// THE DEFECT. Nine of fourteen served tables were answering 502 through the
// gateway — the alert feed, inventory, buffer status, telemetry windows, the
// asset registry, the audit log and all three regional rollups — because the
// releasability predicate names columns those tables do not have. Every
// affected panel rendered its ordinary empty copy: "awaiting first emission",
// "no events", "no items". A transport failure wearing the clothes of an
// absence, which is ADR-0035 class 2 and the same shape as "Syncing…" on a
// 401 one layer up.
//
// WHY THIS IS A REGISTRY AND NOT A PROP. The obvious fix is to thread an
// error state into each panel, and that fix is wrong in a specific way: it
// leaves the defect one panel away. A fourteenth panel added next month
// renders its own empty copy and nobody notices, exactly as the identity
// badge stayed in one sibling for a whole arc.
//
// So the reporting happens in the SHARED shape client, which every panel
// already goes through and none can opt out of, and the display happens once
// in the shared chrome. A panel that says nothing about its own error is
// still covered, because the screen it lives on says it.
//
// This is deliberately NOT a React context: `useTableShape` is called from
// deep inside hooks that no provider wraps, and a context would have to be
// threaded to exactly the places most likely to be missed.
export type ShapeErrorKind = 'unlabelable' | 'transport';

export interface ShapeError {
  table: string;
  kind: ShapeErrorKind;
}

const errors = new Map<string, ShapeErrorKind>();
const listeners = new Set<() => void>();

function emit() {
  // Copy first: a listener that re-renders may subscribe or unsubscribe.
  for (const l of Array.from(listeners)) l();
}

export function reportShapeError(table: string, kind: ShapeErrorKind): void {
  if (errors.get(table) === kind) return;
  errors.set(table, kind);
  emit();
}

export function clearShapeError(table: string): void {
  if (!errors.has(table)) return;
  errors.delete(table);
  emit();
}

export function subscribeShapeErrors(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Stable snapshot. useSyncExternalStore compares by reference, so a new
 *  array every call would loop forever; the cache is rebuilt only when the
 *  underlying map changes. */
let snapshot: ShapeError[] = [];
let snapshotDirty = true;
const markDirty = () => { snapshotDirty = true; };
listeners.add(markDirty);

export function getShapeErrors(): ShapeError[] {
  if (snapshotDirty) {
    snapshot = Array.from(errors, ([table, kind]) => ({ table, kind }))
      .sort((a, b) => a.table.localeCompare(b.table));
    snapshotDirty = false;
  }
  return snapshot;
}
