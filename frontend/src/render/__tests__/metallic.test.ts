import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { metallicParams, METALLIC_MIN_METALNESS } from '../metallic';

const hsl = (hex: number) => {
  const o = { h: 0, s: 0, l: 0 };
  new THREE.Color(hex).getHSL(o, THREE.SRGBColorSpace);
  return o;
};

describe('metallicParams', () => {
  it('lifts very dark colours into a visible steel range', () => {
    const out = metallicParams({ color: 0x0f172a, metalness: 0.7, roughness: 0.3 });
    expect(hsl(out.color).l).toBeGreaterThan(0.3);
    expect(hsl(out.color).l).toBeGreaterThan(hsl(0x0f172a).l + 0.2);
  });

  it('keeps the lightness ordering so parts stay distinguishable', () => {
    const hull = hsl(metallicParams({ color: 0x0f172a }).color).l;
    const skirt = hsl(metallicParams({ color: 0x1e293b }).color).l;
    const barrel = hsl(metallicParams({ color: 0x475569 }).color).l;
    expect(hull).toBeLessThan(skirt);
    expect(skirt).toBeLessThan(barrel);
  });

  it('leaves light colours nearly alone and keeps hue', () => {
    const out = metallicParams({ color: 0x94a3b8 });
    expect(Math.abs(hsl(out.color).l - hsl(0x94a3b8).l)).toBeLessThan(0.05);
    const dark = metallicParams({ color: 0x1e293b });
    expect(Math.abs(hsl(dark.color).h - hsl(0x1e293b).h)).toBeLessThan(0.03);
  });

  it('clamps roughness and keeps metalness >= 0.6', () => {
    expect(metallicParams({ color: 0x1e293b, metalness: 0.9, roughness: 0.1 }).roughness).toBe(0.25);
    expect(metallicParams({ color: 0x1e293b, metalness: 0.9, roughness: 0.95 }).roughness).toBe(0.6);
    expect(metallicParams({ color: 0x1e293b, metalness: 0.2, roughness: 0.4 }).metalness).toBe(METALLIC_MIN_METALNESS);
    expect(metallicParams({ color: 0x1e293b }).metalness).toBeGreaterThanOrEqual(0.6);
  });

  it('adds clearcoat and env intensity, and passes other props through', () => {
    const out = metallicParams({ color: 0x1e293b, side: 2, opacity: 0.5 }) as Record<string, unknown>;
    expect(out.clearcoat).toBeCloseTo(0.3);
    expect(out.envMapIntensity).toBe(1);
    expect(out.side).toBe(2);
    expect(out.opacity).toBe(0.5);
  });
});
