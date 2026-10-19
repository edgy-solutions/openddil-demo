import { describe, expect, it } from 'vitest';
import { markerScale, regionExtent, topologyHeights } from '../topologyMarkers';

describe('markerScale', () => {
  const base = markerScale(4, 20, 100, 800, 50);
  it('grows with distance and px', () => {
    expect(markerScale(4, 20, 200, 800, 50)).toBeCloseTo(base * 2);
    expect(markerScale(4, 40, 100, 800, 50)).toBeCloseTo(base * 2);
  });
  it('shrinks with authored radius', () => {
    expect(markerScale(8, 20, 100, 800, 50)).toBeCloseTo(base / 2);
  });
});

describe('topologyHeights', () => {
  it('clamps small, scales mid, caps large', () => {
    expect(topologyHeights(1)).toEqual({ aggregator: 0.5, hq: 2 });
    expect(topologyHeights(10)).toEqual({ aggregator: 2, hq: 10 });
    expect(topologyHeights(40)).toEqual({ aggregator: 8, hq: 40 });
    expect(topologyHeights(400)).toEqual({ aggregator: 8, hq: 40 });
  });
});

describe('regionExtent', () => {
  it('is at least 2 with no points', () => {
    expect(regionExtent([5, 5], [])).toBe(2);
  });
  it('is the farthest point distance', () => {
    expect(regionExtent([0, 0], [[3, 4], [1, 1], [-2, 0]])).toBe(5);
    expect(regionExtent([0, 0], [[0.5, 0.5]])).toBe(2);
  });
});
