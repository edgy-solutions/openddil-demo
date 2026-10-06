// =============================================================================
// mockElectric — a controllable stand-in for @electric-sql/react's useShape
// =============================================================================
// Every ElectricSQL-backed hook in this project (hooks/electric.ts's
// useTableShape, and Inventory.tsx's direct useShape call) funnels through
// this one function, so mocking it here — rather than mocking each of the
// dozen typed hooks individually — is enough to make the real leaf app
// tree render in jsdom with no backend behind it: Root is mounted for real,
// only the data hooks are mocked.
//
// Keyed by table name only (the `where` clause is ignored): good enough for
// these tests, which need a sentinel asset to be selectable, not faithful
// per-edge filtering.
import { useEffect, useState } from 'react';

interface MockShapeState {
  data: Record<string, unknown>[];
  isLoading: boolean;
  isError: boolean;
  error?: Error | false;
  lastSyncedAt?: number;
}

const DEFAULT_STATE: MockShapeState = {
  data: [],
  isLoading: false,
  isError: false,
  error: false,
  lastSyncedAt: Date.now(),
};

const tableState = new Map<string, MockShapeState>();
const listeners = new Set<() => void>();

function emit() {
  for (const l of Array.from(listeners)) l();
}

export function __setMockShape(table: string, state: Partial<MockShapeState>): void {
  tableState.set(table, { ...DEFAULT_STATE, ...tableState.get(table), ...state });
  emit();
}

export function __resetMockShapes(): void {
  tableState.clear();
  emit();
}

export function useShape(opts: { url: string; params: { table: string } }): MockShapeState {
  const [, setTick] = useState(0);
  useEffect(() => {
    const l = () => setTick((t) => t + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return tableState.get(opts.params.table) ?? DEFAULT_STATE;
}
