// @vitest-environment jsdom
// fromNow: start at the live head (changes_only + offset=now); no snapshot.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const requestSnapshot = vi.fn(() => Promise.resolve({ metadata: {}, data: [] }));
let captured: Array<{ params: Record<string, string>; offset?: string; log?: string }> = [];
vi.mock('@electric-sql/react', () => ({
  useShape: (opts: unknown) => {
    captured.push(opts as (typeof captured)[number]);
    return {
      data: [], isLoading: false, isError: false, lastSyncedAt: 1, error: undefined,
      shape: { requestSnapshot },
    };
  },
}));

import { useTableShape } from '../electric';
import { useAssetElementTelemetry } from '../useAssetElementTelemetry';

const map = (r: Record<string, unknown>) => r;

beforeEach(() => {
  captured = [];
  requestSnapshot.mockClear();
});

describe('useTableShape fromNow', () => {
  it('absent: no log/offset keys, no snapshot', () => {
    const h = renderHook(() => useTableShape('t', map, { where: "a = 'x'" }));
    h.rerender();
    const o = captured[0];
    expect(o).not.toHaveProperty('offset');
    expect(o.params).not.toHaveProperty('log');
    expect(o).not.toHaveProperty('log');
    expect(requestSnapshot).not.toHaveBeenCalled();
  });

  it('true: changes_only + now at top level, never a snapshot, across a where change', () => {
    let where = "a = 'dis:9:9:9001'";
    const h = renderHook(() => useTableShape('t', map, { where, fromNow: true }));
    expect(captured[0].log).toBe('changes_only');
    expect(captured[0].params).not.toHaveProperty('log');
    expect(captured[0].offset).toBe('now');
    h.rerender();
    where = "a = 'dis:9:9:9002'";
    h.rerender();
    expect(captured.length).toBeGreaterThan(1);
    expect(requestSnapshot).not.toHaveBeenCalled();
  });
});

describe('useAssetElementTelemetry', () => {
  it('subscribes fromNow', () => {
    renderHook(() => useAssetElementTelemetry('dis:9:9:9001'));
    expect(captured[0].log).toBe('changes_only');
    expect(captured[0].params).not.toHaveProperty('log');
    expect(captured[0].offset).toBe('now');
    expect(captured[0].params.where).toContain('dis:9:9:9001');
  });
});
