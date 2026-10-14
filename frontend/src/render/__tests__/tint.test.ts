import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { tint } from '../tint';
import { holoMaterial } from '../holoMaterial';

describe('tint', () => {
  it('recolours a material that owns a colour', () => {
    const m = new THREE.MeshBasicMaterial({ color: 0x000000 });
    expect(tint(m, 0xf59e0b)).toBe(true);
    expect(m.color.getHex()).toBe(0xf59e0b);
  });

  it('leaves the shared holographic shader alone instead of throwing', () => {
    const before = JSON.stringify(Object.keys(holoMaterial));
    expect(() => tint(holoMaterial, 0xf59e0b)).not.toThrow();
    expect(tint(holoMaterial, 0xf59e0b)).toBe(false);
    expect((holoMaterial as unknown as { color?: unknown }).color).toBeUndefined();
    expect(JSON.stringify(Object.keys(holoMaterial))).toBe(before);
  });

  it('ignores a missing or multi-material', () => {
    expect(tint(null, 0x10b981)).toBe(false);
    expect(tint([new THREE.MeshBasicMaterial()], 0x10b981)).toBe(false);
  });
});
