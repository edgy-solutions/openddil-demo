import { describe, expect, it } from 'vitest';
import { reliefPixels } from '../relief';

const b = { west: 4, east: 5, south: 52, north: 53 };
const N = 5;
const pix = (a: Uint8ClampedArray, i: number) => Array.from(a.slice(i * 4, i * 4 + 3));
const flat = (m: number) => new Float32Array(N * N).fill(m);
const mid = Math.floor(N / 2) * N + Math.floor(N / 2);
const mask = (land: number) => new Uint8ClampedArray(N * N * 4).map((_, i) => (i % 4 === 3 ? 255 : land));
// The sand palette at 0 m: two thirds of the way from the -2 m stop to the 1 m stop.
const sand0 = [80 + (92 - 80) * (2 / 3), 100 + (108 - 100) * (2 / 3), 86 + (88 - 86) * (2 / 3)];

describe('reliefPixels', () => {
  it('colours flat 0 m land with the 0 m ramp colour times the flat shade factor', () => {
    const f = 0.35 + 0.85 * Math.sin(Math.PI / 4);
    const got = pix(reliefPixels(flat(0), N, N, b, 10, mask(255), 'sand'), mid);
    sand0.forEach((v, q) => expect(Math.abs(got[q] - v * f)).toBeLessThanOrEqual(1));
  });
  it('is opaque and needs no mask', () => {
    const a = reliefPixels(flat(0), N, N, b, 10, null, 'slate');
    expect(a[mid * 4 + 3]).toBe(255);
    expect(pix(a, mid)[0]).toBeGreaterThan(0);
  });
  it('colours a water pixel with the shallow sea colour at 0 m, unshaded', () => {
    expect(pix(reliefPixels(flat(0), N, N, b, 10, mask(0), 'sand'), mid)).toEqual([30, 54, 74]);
  });
  it('grades the sea to its deep colour by 40 m depth', () => {
    expect(pix(reliefPixels(flat(-40), N, N, b, 10, mask(0), 'sand'), mid)).toEqual([14, 30, 48]);
  });
  it('lights a slope facing NW more than one facing SE', () => {
    // Row 0 is north. Ground rising to the SE faces NW; rising to the NW faces SE.
    const slope = (sign: number) => {
      const h = new Float32Array(N * N);
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) h[j * N + i] = sign * (i + j) * 2 + 50;
      return h;
    };
    const nw = pix(reliefPixels(slope(1), N, N, b, 14, mask(255), 'sand'), mid)[0];
    const se = pix(reliefPixels(slope(-1), N, N, b, 14, mask(255), 'sand'), mid)[0];
    expect(nw).toBeGreaterThan(se);
  });
  it('multiplies by the gain and clamps at 255', () => {
    const base = pix(reliefPixels(flat(0), N, N, b, 10, null, 'slate'), mid);
    const lit = pix(reliefPixels(flat(0), N, N, b, 10, null, 'slate', 1.6), mid);
    expect(lit[0]).toBeGreaterThan(base[0]);
    expect(pix(reliefPixels(flat(1000), N, N, b, 10, null, 'sand', 100), mid)).toEqual([255, 255, 255]);
  });
});
