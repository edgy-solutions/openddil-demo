import { describe, expect, it } from 'vitest';
import { AGG_PX, FOB_PX, HQ_PX, HUB_TOP, markerScale, regionExtent, stackLift, topologyHeights } from '../topologyMarkers';

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

describe('stackLift', () => {
  it('lifts a marker clear of the hub top, through screen pixels', () => {
    const hubTopPx = (HUB_TOP * FOB_PX * 1.25) / 4.7;
    expect(stackLift(4.5, AGG_PX)).toBeCloseTo((hubTopPx * 4.5) / AGG_PX + 0.5);
    expect(stackLift(5.5, HQ_PX)).toBeCloseTo((hubTopPx * 5.5) / HQ_PX + 0.5);
  });
  it('grows with the hub size and shrinks with the marker size on screen', () => {
    expect(stackLift(4.5, 18, 44)).toBeGreaterThan(stackLift(4.5, 18, 22));
    expect(stackLift(4.5, 36, 22)).toBeLessThan(stackLift(4.5, 18, 22));
  });
});
