// @vitest-environment jsdom
// The maintainer drilldown subscribes per open node: grammar, release and path rules.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useState } from 'react';

type Opts = { params: Record<string, string>; signal: AbortSignal };
let calls: Opts[] = [];
vi.mock('@electric-sql/react', () => ({
  useShape: (opts: unknown) => {
    calls.push(opts as Opts);
    return { data: [], isLoading: false, isError: false, lastSyncedAt: 1, error: undefined };
  },
}));

import ElementLevelSubscription from '../../components/ElementLevelSubscription';
import { elementLevelRequest, levelsAfterDrill } from '../useElementLevel';

const A = 'dis:1:1:4773';
const T = 'TR-PRIMARYAPERTURE-3-5';
const B = `${T}/BOARD-0-1`;
const M = `${B}/MODULE-1-0`;
const LEAF = 3;
const COLS =
  'asset_id,element_path,parent_path,depth,layer_name,health,health_band,temp_c,load_pct,tx_active,rx_active,moved_by,value_changes,subtree_changes,subtree_changes_window,observed_at';

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  calls = [];
  fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const where = (prefix: string | null) => elementLevelRequest(A, prefix, LEAF)?.params.where;
const deletes = () =>
  fetchMock.mock.calls.filter(([, init]) => (init as RequestInit)?.method === 'DELETE');
const deletedWheres = () => deletes().map(([url]) => new URL(String(url)).searchParams.get('where'));

describe('where grammar and bound', () => {
  it('root and three drill levels produce exactly the grammar forms', () => {
    expect(where(null)).toBe(`asset_id = '${A}' AND depth <= 1`);
    expect(where(T)).toBe(`asset_id = '${A}' AND element_path LIKE '${T}/%' AND depth <= 2`);
    expect(where(B)).toBe(`asset_id = '${A}' AND element_path LIKE '${B}/%' AND depth <= 3`);
    expect(where(M)).toBe(`asset_id = '${A}' AND element_path LIKE '${M}/%' AND depth <= 3`);
  });

  it('carries explicit columns and compaction, and nothing else', () => {
    const p = elementLevelRequest(A, null, LEAF)!.params;
    expect(Object.keys(p).sort()).toEqual(['columns', 'experimental_compaction', 'table', 'where']);
    expect(p.columns).toBe(COLS);
    expect(p.table).toBe('asset_element_state');
  });

  it('refuses an asset or path outside the grammar', () => {
    expect(elementLevelRequest("a'b", null, LEAF)).toBeNull();
    expect(elementLevelRequest(A, "TR-1/BOARD'x", LEAF)).toBeNull();
    expect(elementLevelRequest(A, 'TR-1/BO%', LEAF)).toBeNull();
    expect(elementLevelRequest(A, 'TR-1//BOARD', LEAF)).toBeNull();
    expect(elementLevelRequest(null, null, LEAF)).toBeNull();
  });

  it('a bad path subscribes to nothing and sends nothing', () => {
    render(<ElementLevelSubscription assetId={A} prefix="TR-1/BO%" leafDepth={LEAF} onRows={() => {}} />);
    expect(calls).toHaveLength(0);
    cleanup();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('release', () => {
  it('unmount aborts the signal and issues exactly one DELETE for the same definition', () => {
    const { unmount } = render(
      <ElementLevelSubscription assetId={A} prefix={T} leafDepth={LEAF} onRows={() => {}} />,
    );
    const sig = calls[calls.length - 1].signal;
    expect(sig.aborted).toBe(false);
    unmount();
    expect(sig.aborted).toBe(true);
    expect(deletes()).toHaveLength(1);
    const [url, init] = deletes()[0];
    const u = new URL(String(url));
    expect(u.searchParams.get('table')).toBe('asset_element_state');
    expect(u.searchParams.get('where')).toBe(where(T));
    expect(u.searchParams.get('columns')).toBe(COLS);
    expect((init as RequestInit).credentials).toBe('include');
  });

  it('a failed DELETE is ignored', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error('net')));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { unmount } = render(
      <ElementLevelSubscription assetId={A} prefix={null} leafDepth={LEAF} onRows={() => {}} />,
    );
    unmount();
    await Promise.resolve();
    await Promise.resolve();
    expect(deletes()).toHaveLength(1);
    warn.mockRestore();
  });

  it('pagehide sends the DELETE with keepalive, once', () => {
    const { unmount } = render(
      <ElementLevelSubscription assetId={A} prefix={null} leafDepth={LEAF} onRows={() => {}} />,
    );
    window.dispatchEvent(new Event('pagehide'));
    expect(deletes()).toHaveLength(1);
    expect((deletes()[0][1] as RequestInit).keepalive).toBe(true);
    unmount();
    expect(deletes()).toHaveLength(1);
  });
});

// Mirrors how SensorArrayView mounts its levels: the root, then one per open path.
let setLevelsRef: (fn: (l: string[]) => string[]) => void = () => {};
let setAssetRef: (a: string) => void = () => {};
function Levels() {
  const [levels, setLevels] = useState<string[]>([]);
  const [asset, setAsset] = useState(A);
  setLevelsRef = setLevels;
  setAssetRef = setAsset;
  return (
    <>
      {[null, ...levels].map((p) => (
        <ElementLevelSubscription
          key={`${asset}|${p ?? ''}`}
          assetId={asset}
          prefix={p}
          leafDepth={LEAF}
          onRows={() => {}}
        />
      ))}
    </>
  );
}
const drill = (path: string) => act(() => setLevelsRef((l) => levelsAfterDrill(l, path)));

describe('open path', () => {
  it('levelsAfterDrill keeps ancestors and drops other branches', () => {
    expect(levelsAfterDrill([], 'A')).toEqual(['A']);
    expect(levelsAfterDrill(['A'], 'A/B')).toEqual(['A', 'A/B']);
    expect(levelsAfterDrill(['A', 'A/B'], 'A')).toEqual(['A', 'A/B']);
    expect(levelsAfterDrill(['A', 'A/B', 'A/B/C'], 'A/B')).toEqual(['A', 'A/B', 'A/B/C']);
    expect(levelsAfterDrill(['A', 'A/B'], 'A/C')).toEqual(['A', 'A/C']);
    expect(levelsAfterDrill(['A', 'A/B'], 'AB')).toEqual(['AB']);
  });

  it('drill A -> A/B, back to A, drill A/C: one DELETE, for the A/B level', () => {
    render(<Levels />);
    drill(T);
    drill(B);
    // Back up to T: no call, its levels stay open.
    expect(deletes()).toHaveLength(0);
    const C = `${T}/BOARD-0-2`;
    drill(C);
    expect(deletes()).toHaveLength(1);
    expect(deletedWheres()).toEqual([where(B)]);
    // Open levels now: root, T, C.
    const live = new Set(calls.filter((c) => !c.signal.aborted).map((c) => c.params.where));
    expect(live).toEqual(new Set([where(null), where(T), where(C)]));
  });

  it('leaving the asset DELETEs every open level', () => {
    render(<Levels />);
    drill(T);
    drill(B);
    expect(deletes()).toHaveLength(0);
    act(() => setAssetRef('dis:1:1:9999'));
    expect(deletes()).toHaveLength(3);
    expect(new Set(deletedWheres())).toEqual(new Set([where(null), where(T), where(B)]));
  });
});
