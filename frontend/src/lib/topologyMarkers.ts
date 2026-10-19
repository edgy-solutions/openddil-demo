// Regional topology markers (FOB hub, aggregator, HQ): constant on-screen size, and
// stack heights that follow the region's ground extent rather than a fixed world size.
import { worldPerPx } from './symbolScale';

/** On-screen radius, CSS px (assets are 16). */
export const FOB_PX = 22;
export const AGG_PX = 18;
export const HQ_PX = 18;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Group scale so a marker authored at `authoredRadius` spans `px` on screen at `dist`. No true-size floor. */
export function markerScale(authoredRadius: number, px: number, dist: number, heightPx: number, fovDeg: number): number {
  return (px * worldPerPx(dist, heightPx, fovDeg)) / authoredRadius;
}

/** Heights above the ground under the region centre; `extent` is the region's ground radius in world units. */
export function topologyHeights(extent: number): { aggregator: number; hq: number } {
  return { aggregator: clamp(0.2 * extent, 0.5, 8), hq: clamp(1.0 * extent, 2, 40) };
}

/** Max ground distance from `center` to any point, at least 2. */
export function regionExtent(center: [number, number], points: [number, number][]): number {
  let m = 2;
  for (const [x, z] of points) m = Math.max(m, Math.hypot(x - center[0], z - center[1]));
  return m;
}
