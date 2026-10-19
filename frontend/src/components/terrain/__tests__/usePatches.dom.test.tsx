// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePatches } from '../terrain';
import { resolveTerrainSource } from '../../../lib/terrainTiles';

describe('usePatches', () => {
  it('loads nothing and returns [] for the relief basemap (no patch URL)', () => {
    const img = vi.spyOn(globalThis, 'Image');
    const { result } = renderHook(() => usePatches(
      [{ bounds: { south: 52, west: 4, north: 52.01, east: 4.01 }, maxZoom: 19 }], resolveTerrainSource(undefined)));
    expect(result.current).toEqual([]);
    expect(img).not.toHaveBeenCalled();
  });
});
