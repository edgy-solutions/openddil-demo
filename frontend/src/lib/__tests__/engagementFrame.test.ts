import { describe, expect, it } from 'vitest';
import { clearOfGround, engagementFocus, frameOf, gridStepKm, heightAboveLaunch, MIN_RADIUS } from '../engagementFrame';

describe('frameOf', () => {
  it('is null with nothing in flight', () => {
    expect(frameOf([], 0)).toBeNull();
    expect(frameOf([[NaN, 1, 2]], 0)).toBeNull();
  });

  it('keeps the flight and its ground footprint in frame', () => {
    const f = frameOf([[0, 0, 0], [10, 6, 0]], 0)!;
    expect(f.c.x).toBeCloseTo(5);
    expect(f.c.y).toBeCloseTo(3);
    expect(f.r).toBeCloseTo(Math.hypot(5, 3));
  });

  it('never frames tighter than the minimum radius', () => {
    expect(frameOf([[1, 0.1, 1]], 0)!.r).toBe(MIN_RADIUS);
  });
});

describe('gridStepKm', () => {
  const U = 80 / 111;
  it('picks about eight whole-km cells across the frame', () => {
    expect(gridStepKm(MIN_RADIUS, U)).toBe(0.5);
    expect(gridStepKm(4 * U, U)).toBe(1);
    expect(gridStepKm(20 * U, U)).toBe(5);
    expect(gridStepKm(5000, U)).toBe(100);
  });
});

describe('heightAboveLaunch', () => {
  it('measures from the launcher, not the ellipsoid', () => {
    expect(heightAboveLaunch(1700 + 3000, 1700, 2)).toBeCloseTo(6);
  });
  it('never goes below the ground plane', () => {
    expect(heightAboveLaunch(1600, 1700, 2)).toBe(0);
  });
  it('falls back to the ellipsoidal height with no launcher altitude', () => {
    expect(heightAboveLaunch(500, undefined, 2)).toBeCloseTo(1);
    expect(heightAboveLaunch(500, null, 2)).toBeCloseTo(1);
  });
});

describe('engagementFocus', () => {
  it('collects trails, launchers and targets', () => {
    expect(engagementFocus([
      { trail: [[0, 1, 0], [1, 2, 1]], launcher: [0, 0, 0], target: [9, 0, 9] },
      { trail: [[5, 5, 5]] },
    ])).toEqual([[0, 1, 0], [1, 2, 1], [0, 0, 0], [9, 0, 9], [5, 5, 5]]);
  });
});

describe('clearOfGround', () => {
  it('keeps a high point as is', () => {
    expect(clearOfGround(10, 2, 4)).toBe(10);
  });
  it('lifts a point below the ground to 50 m clearance', () => {
    expect(clearOfGround(1, 5, 4)).toBeCloseTo(5.2);
    expect(clearOfGround(5, 5, 10)).toBeCloseTo(5.5);
  });
});
