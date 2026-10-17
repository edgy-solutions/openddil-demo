// @vitest-environment jsdom
// useTableShape must hand back the same mapped array until Electric's own data
// changes. A fresh array per render re-fires every effect keyed on it, and
// useMunitionTrackFeed keeps state derived from it during render, which loops.
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

let shapeData: Record<string, unknown>[] = [{ id: 'dis:9:9:1' }];
vi.mock('@electric-sql/react', () => ({
  useShape: () => ({ data: shapeData, isLoading: false, isError: false, lastSyncedAt: 1, error: undefined }),
}));

import { useTableShape } from '../electric';
import { useMunitionTrackFeed } from '../useMunitionTracks';

const map = (r: Record<string, unknown>) => ({ id: String(r.id) });

describe('useTableShape data identity', () => {
  it('keeps the same array across renders of the same snapshot', () => {
    const h = renderHook(() => useTableShape('munition_track', map));
    const first = h.result.current.data;
    h.rerender();
    expect(h.result.current.data).toBe(first);
  });

  it('maps again when the snapshot changes', () => {
    const h = renderHook(() => useTableShape('munition_track', map));
    const first = h.result.current.data;
    shapeData = [{ id: 'dis:9:9:2' }];
    h.rerender();
    expect(h.result.current.data).not.toBe(first);
    expect(h.result.current.data).toEqual([{ id: 'dis:9:9:2' }]);
  });

  it('the munition feed renders over the real shape hook without looping', () => {
    shapeData = [{ munition_asset_id: 'dis:9:9:3', munition_type: '2.9.225.2.1.1.0', ecef_x: 1, ecef_y: 2, ecef_z: 3 }];
    const h = renderHook(() => useMunitionTrackFeed());
    h.rerender();
    expect(h.result.current.data).toHaveLength(1);
  });
});
