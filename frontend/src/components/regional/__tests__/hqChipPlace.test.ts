import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { HQ_CHIP_MARGIN_PX, placeHqChip, type HqChipState } from '../hqChipPlace';

// A top-down orthographic camera over a 800x600 pane: 1 world unit = 3 px, +x right, +z down the screen.
const size = { width: 800, height: 600 };
function camera() {
  const c = new THREE.OrthographicCamera(-400 / 3, 400 / 3, 300 / 3, -300 / 3, 0.1, 1000);
  c.position.set(0, 100, 0);
  c.up.set(0, 0, -1);
  c.lookAt(0, 0, 0);
  c.updateMatrixWorld(true);
  return c;
}
const el = () => ({ offsetWidth: 80, offsetHeight: 20, style: {} as Record<string, string> });
const v = (x: number, z: number) => new THREE.Vector3(x, 0, z);
const run = (end: THREE.Vector3, at = v(50, 0)) => {
  const st: HqChipState = { x: NaN, y: NaN, deg: NaN };
  const e = el();
  const a = { style: {} as Record<string, string> };
  placeHqChip(st, e as unknown as HTMLElement, a as unknown as HTMLElement, v(0, 0), at, end, camera(), size, new THREE.Vector3(), new THREE.Vector3());
  return { st, e, a };
};

describe('placeHqChip', () => {
  it('puts the chip on the far end when that is inside the pane', () => {
    const { st, e } = run(v(50, 0));
    expect(st.x).toBeCloseTo(550, 6);
    expect(st.y).toBeCloseTo(300, 6);
    expect(e.style.left).toBe(`${st.x}px`);
    expect(e.style.visibility).toBe('visible');
  });

  it('clamps to the pane edge along the screen direction when the far end is off screen', () => {
    const { st } = run(v(500, 0));
    expect(st.x).toBeCloseTo(800 - HQ_CHIP_MARGIN_PX - 40, 6);
    expect(st.y).toBeCloseTo(300, 6);
  });

  it('treats a far end inside the margin as off screen', () => {
    const { st } = run(v(131, 0));
    expect(st.x).toBeCloseTo(800 - HQ_CHIP_MARGIN_PX - 40, 6);
  });

  it('points the arrow along the node -> HQ direction either way', () => {
    expect(run(v(50, 0)).a.style.transform).toBe('rotate(0deg)');
    expect(run(v(0, 500), v(0, 50)).a.style.transform).toBe('rotate(90deg)');
  });
});
