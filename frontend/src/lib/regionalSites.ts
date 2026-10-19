// Where the regional node and HQ sit on the regional map, and the pure
// geometry that decides how to draw the link between them.
import type { Deployment } from '../deployment';

export type Site = { lat: number; lon: number; label?: string };
export type Rect = { x0: number; z0: number; x1: number; z1: number };

const R_KM = 6371.0088;
const rad = (d: number) => (d * Math.PI) / 180;

/** The regional site comes from the `tiers` row whose id is `regionId`, when it
 *  has lat/lon. THIS IS THE ONLY READER of the provisional site fields on
 *  `TierEntry`; change the field names here and nowhere else. HQ's site is
 *  `Deployment.hq`. */
export function resolveSites(
  dep: Pick<Deployment, 'tiers' | 'hq'>,
  regionId: string | null,
): { regional: Site | null; hq: Site | null } {
  const row = regionId ? dep.tiers?.find((t) => t.id === regionId) : undefined;
  const regional: Site | null =
    row && row.lat !== undefined && row.lon !== undefined
      ? { lat: row.lat, lon: row.lon, ...(row.label ? { label: row.label } : {}) }
      : null;
  const hq: Site | null = dep.hq
    ? { lat: dep.hq.lat, lon: dep.hq.lon, ...(dep.hq.label ? { label: dep.hq.label } : {}) }
    : null;
  return { regional, hq };
}

type LL = { lat: number; lon: number };

/** Great-circle distance in km (haversine). */
export function distanceKm(a: LL, b: LL): number {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial great-circle bearing from a to b, degrees in [0, 360). */
export function bearingDeg(a: LL, b: LL): number {
  const dLon = rad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(dLon);
  const d = (Math.atan2(y, x) * 180) / Math.PI;
  return ((d % 360) + 360) % 360;
}

export function sameSite(a: LL, b: LL, tolKm = 0.5): boolean {
  return distanceKm(a, b) <= tolKm;
}

/** Bounding box of the points, padded by `pad` of its size on each side, each half-extent at least `minHalf`. */
export function framedRect(points: [number, number][], pad = 0.15, minHalf = 2): Rect {
  if (points.length === 0) return { x0: -minHalf, z0: -minHalf, x1: minHalf, z1: minHalf };
  const xs = points.map((p) => p[0]), zs = points.map((p) => p[1]);
  const lx = Math.min(...xs), hx = Math.max(...xs), lz = Math.min(...zs), hz = Math.max(...zs);
  const cx = (lx + hx) / 2, cz = (lz + hz) / 2;
  const hw = Math.max(((hx - lx) / 2) * (1 + 2 * pad), minHalf);
  const hh = Math.max(((hz - lz) / 2) * (1 + 2 * pad), minHalf);
  return { x0: cx - hw, z0: cz - hh, x1: cx + hw, z1: cz + hh };
}

export function insideRect(p: [number, number], r: Rect): boolean {
  return p[0] >= r.x0 && p[0] <= r.x1 && p[1] >= r.z0 && p[1] <= r.z1;
}

/** Where the segment from `from` (inside) toward `to` crosses the border of `r`; null when `to` is inside. */
export function rectExit(from: [number, number], to: [number, number], r: Rect): [number, number] | null {
  if (insideRect(to, r)) return null;
  const dx = to[0] - from[0], dz = to[1] - from[1];
  let t = Infinity;
  if (dx > 0) t = Math.min(t, (r.x1 - from[0]) / dx);
  else if (dx < 0) t = Math.min(t, (r.x0 - from[0]) / dx);
  if (dz > 0) t = Math.min(t, (r.z1 - from[1]) / dz);
  else if (dz < 0) t = Math.min(t, (r.z0 - from[1]) / dz);
  if (!Number.isFinite(t)) return null;
  t = Math.max(0, Math.min(1, t));
  return [from[0] + dx * t, from[1] + dz * t];
}

/** `< 10` one decimal, else an integer: "8.4 km", "312 km". */
export function formatKm(km: number): string {
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}

export type HqPlan =
  | { mode: 'abstract' }
  | { mode: 'colocated' }
  | { mode: 'onmap'; x: number; z: number }
  | { mode: 'offmap'; exit: [number, number]; km: number; bearing: number };

export type TopologyPlan =
  | { kind: 'fallback' }
  | { kind: 'sites'; regional: { x: number; z: number; label: string }; hq: HqPlan };

export function planTopology(i: {
  regionId: string;
  regional: Site | null;
  hq: Site | null;
  project: (lat: number, lon: number) => [number, number];
  rect: Rect;
}): TopologyPlan {
  if (!i.regional) return { kind: 'fallback' };
  const [rx, rz] = i.project(i.regional.lat, i.regional.lon);
  const regional = { x: rx, z: rz, label: i.regional.label ?? i.regionId.toUpperCase() };
  if (!i.hq) return { kind: 'sites', regional, hq: { mode: 'abstract' } };
  if (sameSite(i.regional, i.hq)) return { kind: 'sites', regional, hq: { mode: 'colocated' } };
  const [hx, hz] = i.project(i.hq.lat, i.hq.lon);
  const exit = rectExit([rx, rz], [hx, hz], i.rect);
  if (!exit) return { kind: 'sites', regional, hq: { mode: 'onmap', x: hx, z: hz } };
  return {
    kind: 'sites',
    regional,
    hq: { mode: 'offmap', exit, km: distanceKm(i.regional, i.hq), bearing: bearingDeg(i.regional, i.hq) },
  };
}
