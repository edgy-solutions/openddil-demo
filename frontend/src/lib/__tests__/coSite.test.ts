import { describe, expect, it } from 'vitest';
import { groupByPosition } from '../coSite';

describe('groupByPosition', () => {
  it('returns no groups for no items', () => {
    expect(groupByPosition([], 1)).toEqual([]);
  });

  it('keeps items that are apart in separate groups', () => {
    const g = groupByPosition(
      [
        { key: 'a', pos: [0, 0] as [number, number] },
        { key: 'b', pos: [10, 0] as [number, number] },
        { key: 'c', pos: [0, 10] as [number, number] },
      ],
      1,
    );
    expect(g.map((x) => x.keys)).toEqual([['a'], ['b'], ['c']]);
  });

  it('groups two items that are together', () => {
    const g = groupByPosition(
      [
        { key: 'a', pos: [0, 0] as [number, number] },
        { key: 'b', pos: [0.5, 0.5] as [number, number] },
      ],
      1,
    );
    expect(g).toHaveLength(1);
    expect(g[0].keys).toEqual(['a', 'b']);
  });

  it('chains a-b-c into one group even when a-c exceeds eps', () => {
    const g = groupByPosition(
      [
        { key: 'a', pos: [0, 0] as [number, number] },
        { key: 'b', pos: [0.8, 0] as [number, number] },
        { key: 'c', pos: [1.6, 0] as [number, number] },
      ],
      1,
    );
    expect(g).toHaveLength(1);
    expect(g[0].keys).toEqual(['a', 'b', 'c']);
  });

  it('orders groups by first item, keeps input order and uses the first pos', () => {
    const g = groupByPosition(
      [
        { key: 'x', pos: [50, 50] as [number, number] },
        { key: 'a', pos: [0, 0] as [number, number] },
        { key: 'y', pos: [50.2, 50] as [number, number] },
        { key: 'b', pos: [0.1, 0] as [number, number] },
      ],
      1,
    );
    expect(g.map((x) => x.keys)).toEqual([['x', 'y'], ['a', 'b']]);
    expect(g[0].pos).toEqual([50, 50]);
    expect(g[1].pos).toEqual([0, 0]);
  });
});
