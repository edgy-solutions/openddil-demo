// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { usePatches, type PatchSpec } from '../terrain';
import { resolveTerrainSource } from '../../../lib/terrainTiles';
import { tileBoxBounds } from '../../../lib/viewTiles';

describe('usePatches', () => {
  it('loads nothing and returns [] for the relief basemap (no patch URL)', () => {
    const img = vi.spyOn(globalThis, 'Image');
    const { result } = renderHook(() => usePatches(
      [{ bounds: { south: 52, west: 4, north: 52.01, east: 4.01 }, maxZoom: 19 }], resolveTerrainSource(undefined)));
    expect(result.current).toEqual([]);
    expect(img).not.toHaveBeenCalled();
  });

  describe('incremental loading', () => {
    // Fake tile images that load only when the test says so.
    let requested: string[];
    let waiting: Map<string, () => void>;
    beforeEach(() => {
      requested = [];
      waiting = new Map();
      class FakeImage {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(url: string) {
          requested.push(url);
          waiting.set(url, () => this.onload?.());
        }
      }
      vi.stubGlobal('Image', FakeImage);
      const ctx = {
        drawImage: () => {}, fillRect: () => {}, fillStyle: '', globalCompositeOperation: '',
        createLinearGradient: () => ({ addColorStop: () => {} }),
      };
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);
    });
    afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

    const source = { ...resolveTerrainSource(undefined), patchImageryUrl: '/t/{z}/{x}/{y}.png' };
    // One z5 tile per spec, at made-up tile coordinates.
    const spec = (x: number): PatchSpec => {
      const bounds = tileBoxBounds({ z: 5, x0: x, x1: x, y0: 12, y1: 12 });
      return { bounds, maxZoom: 5, zoom: 5 };
    };
    const url = (x: number) => `/t/5/${x}/12.png`;
    const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const resolve = async (...xs: number[]) => {
      for (const x of xs) waiting.get(url(x))!();
      await settle();
    };

    it('does not reload a shared spec, and keeps old patches until the new ones are in', async () => {
      const { result, rerender } = renderHook(({ list }) => usePatches(list, source), {
        initialProps: { list: [spec(10), spec(11)] },
      });
      expect(requested.sort()).toEqual([url(10), url(11)]);
      await resolve(10, 11);
      expect(result.current).toHaveLength(2);
      const first = result.current.find((p) => p.bounds.west === spec(11).bounds.west)!;

      requested.length = 0;
      rerender({ list: [spec(11), spec(12)] });
      expect(requested).toEqual([url(12)]); // 11 is not requested again
      await settle();
      expect(result.current).toHaveLength(2); // 10 stays while 12 loads
      expect(result.current).toContain(first);

      await resolve(12);
      expect(result.current).toHaveLength(2); // 10 gone, 12 in
      expect(result.current).toContain(first);
      expect(result.current.some((p) => p.bounds.west === spec(10).bounds.west)).toBe(false);
      expect(result.current.some((p) => p.bounds.west === spec(12).bounds.west)).toBe(true);
    });

    it('drops a request whose spec left the list before it finished', async () => {
      const { result, rerender } = renderHook(({ list }) => usePatches(list, source), {
        initialProps: { list: [spec(10)] },
      });
      rerender({ list: [spec(11)] });
      await resolve(10);
      expect(result.current).toHaveLength(0); // 10 arrived late and was dropped
      await resolve(11);
      expect(result.current).toHaveLength(1);
      expect(result.current[0].bounds.west).toBe(spec(11).bounds.west);
    });
  });
});
