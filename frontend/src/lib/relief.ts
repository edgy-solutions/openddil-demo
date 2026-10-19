// The relief basemap: a hillshaded hypsometric tint from the Terrarium DEM, with sea from a
// land mask. No imagery, so no network. Ported from the basemap preview; pure apart from the canvas.
import * as THREE from 'three';
import type { Bounds } from './terrainBounds';
import { decodeTerrarium } from './terrainTiles';
import type { ReliefPalette } from './terrainTiles';

type Stop = [number, number, number, number]; // metres, r, g, b
interface Palette { ramp: Stop[]; sea: [[number, number, number], [number, number, number]] }

const PALETTES: Record<ReliefPalette, Palette> = {
  sand: {
    ramp: [[-8, 70, 92, 84], [-2, 80, 100, 86], [1, 92, 108, 88], [8, 116, 122, 92], [30, 152, 142, 106], [100, 172, 162, 122], [400, 192, 182, 152], [1200, 222, 216, 198]],
    sea: [[30, 54, 74], [14, 30, 48]],
  },
  slate: {
    ramp: [[-8, 30, 40, 44], [-2, 34, 44, 48], [1, 38, 48, 50], [8, 46, 56, 56], [30, 58, 68, 64], [100, 72, 82, 74], [400, 94, 102, 92], [1200, 130, 136, 124]],
    sea: [[12, 22, 34], [6, 12, 22]],
  },
};

const LUT_MIN = -100, LUT_SPAN = 2100, LUT_N = LUT_SPAN * 2; // every 0.5 m, -100 m to +2000 m
const luts = new Map<ReliefPalette, Float32Array>();

function tint(ramp: Stop[], h: number): [number, number, number] {
  if (h <= ramp[0][0]) return [ramp[0][1], ramp[0][2], ramp[0][3]];
  for (let i = 1; i < ramp.length; i++) {
    const [h1, r1, g1, b1] = ramp[i];
    if (h <= h1) {
      const [h0, r0, g0, b0] = ramp[i - 1];
      const t = (h - h0) / (h1 - h0);
      return [r0 + (r1 - r0) * t, g0 + (g1 - g0) * t, b0 + (b1 - b0) * t];
    }
  }
  const l = ramp[ramp.length - 1];
  return [l[1], l[2], l[3]];
}

function lut(p: ReliefPalette): Float32Array {
  let l = luts.get(p);
  if (!l) {
    l = new Float32Array(LUT_N * 3);
    for (let i = 0; i < LUT_N; i++) l.set(tint(PALETTES[p].ramp, LUT_MIN + i / 2), i * 3);
    luts.set(p, l);
  }
  return l;
}

/** RGBA pixels of the relief over a `w` x `h` heightfield (metres, row 0 = north) covering `b` at zoom `z`.
 *  `mask` is RGBA, red = land (255) / water (0); null = no sea. `gain` scales the final RGB. */
export function reliefPixels(
  heights: Float32Array, w: number, h: number, b: Bounds, z: number,
  mask: Uint8ClampedArray | Uint8Array | null, palette: ReliefPalette, gain = 1,
): Uint8ClampedArray {
  const L = lut(palette), [shallow, deep] = PALETTES[palette].sea;
  // NW sun at 45 degrees, vertical exaggeration x8.
  const lat = (b.north + b.south) / 2;
  const mpp = (156543.03 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;
  const ex = 8;
  const az = (315 * Math.PI) / 180, alt = (45 * Math.PI) / 180;
  const lx = Math.sin(az) * Math.cos(alt), ly = -Math.cos(az) * Math.cos(alt), lz = Math.sin(alt);
  const at = (i: number, j: number) => heights[Math.min(h - 1, Math.max(0, j)) * w + Math.min(w - 1, Math.max(0, i))];
  const out = new Uint8ClampedArray(w * h * 4);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const k = j * w + i, m = heights[k];
    const dx = ((at(i + 1, j) - at(i - 1, j)) * ex) / (2 * mpp), dy = ((at(i, j + 1) - at(i, j - 1)) * ex) / (2 * mpp);
    const shade = Math.max(0, (-dx * lx - dy * ly + lz) / Math.hypot(dx, dy, 1));
    const land = mask ? mask[k * 4] / 255 : 1;
    const li = Math.min(LUT_N - 1, Math.max(0, Math.round((m - LUT_MIN) * 2))) * 3, f = 0.35 + 0.85 * shade;
    const depth = Math.min(1, Math.max(0, -m / 40));
    for (let q = 0; q < 3; q++) {
      const sea = shallow[q] + (deep[q] - shallow[q]) * depth;
      out[k * 4 + q] = (L[li + q] * f * land + sea * (1 - land)) * gain; // Uint8ClampedArray clamps at 255
    }
    out[k * 4 + 3] = 255;
  }
  return out;
}

/** The relief as a canvas, from a Terrarium DEM crop over `b` at zoom `z` and a mask canvas of the same size (or null). */
export function reliefCanvas(
  dem: HTMLCanvasElement, b: Bounds, z: number, mask: HTMLCanvasElement | null, palette: ReliefPalette, gain = 1,
): HTMLCanvasElement {
  const w = dem.width, h = dem.height;
  const d = dem.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h).data;
  const heights = new Float32Array(w * h);
  // Transparent = blank tile: 0 m.
  for (let i = 0; i < w * h; i++) heights[i] = d[i * 4 + 3] === 0 ? 0 : decodeTerrarium(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
  const m = mask ? mask.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h).data : null;
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const ctx = out.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  img.data.set(reliefPixels(heights, w, h, b, z, m, palette, gain));
  ctx.putImageData(img, 0, 0);
  return out;
}

/** The relief canvas as a texture, set up as the imagery texture is. */
export function reliefTexture(c: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
