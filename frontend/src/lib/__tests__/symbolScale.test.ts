import { describe, expect, it } from 'vitest';
import { PX_R, R_TRUE, TRUE_R_M, symbolScale, worldPerPx } from '../symbolScale';
import { resolveRingRadius } from '../assetGeometry';
import { M } from '../sceneScale';

describe('symbolScale', () => {
  it('worldPerPx: a 90 degree view at distance d spans 2d over the height', () => {
    expect(worldPerPx(10, 500, 90)).toBeCloseTo(20 / 500, 9);
  });
  it('exports the true size from metres', () => {
    expect(TRUE_R_M).toBe(6);
    expect(PX_R).toBe(16);
    expect(R_TRUE).toBeCloseTo(6 * M, 12);
  });
  it('far away the ring is PX_R pixels wide', () => {
    const k = symbolScale('MRAD2_launcher', 100, 800, 40);
    expect(k * resolveRingRadius('MRAD2_launcher', 1)).toBeCloseTo(PX_R * worldPerPx(100, 800, 40), 9);
  });
  it('close in it never shrinks below true size', () => {
    const k = symbolScale('MRAD2_launcher', 0.001, 800, 40);
    expect(k * resolveRingRadius('MRAD2_launcher', 1)).toBeCloseTo(R_TRUE, 12);
  });
  it('grows with distance', () => {
    expect(symbolScale(null, 200, 800, 40)).toBeGreaterThan(symbolScale(null, 100, 800, 40));
  });
});
