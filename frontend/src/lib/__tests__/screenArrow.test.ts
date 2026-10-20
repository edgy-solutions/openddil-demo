import { describe, expect, it } from 'vitest';
import { screenArrowDeg } from '../screenArrow';

const o = { x: 0, y: 0 };

describe('screenArrowDeg', () => {
  it('is 0 for a target to the right', () => {
    expect(screenArrowDeg(o, { x: 1, y: 0 })).toBe(0);
  });
  it('is -90 for a target up the screen (CSS rotates clockwise)', () => {
    expect(screenArrowDeg(o, { x: 0, y: 1 })).toBeCloseTo(-90, 9);
  });
  it('is 90 for a target down the screen', () => {
    expect(screenArrowDeg(o, { x: 0, y: -1 })).toBeCloseTo(90, 9);
  });
  it('is 180 or -180 for a target to the left', () => {
    expect(Math.abs(screenArrowDeg(o, { x: -1, y: 0 }))).toBeCloseTo(180, 9);
  });
  it('measures from the origin point, not the screen centre', () => {
    expect(screenArrowDeg({ x: 2, y: 2 }, { x: 3, y: 3 })).toBeCloseTo(-45, 9);
  });
});
