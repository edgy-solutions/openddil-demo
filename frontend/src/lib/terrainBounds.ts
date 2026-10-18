// The lat/lon box the regional terrain covers.
export interface LatLon { lat: number; lon: number }
export interface Bounds { south: number; west: number; north: number; east: number }

const KM_PER_DEG = 111;
const PAD_FRAC = 0.2;
const MIN_PAD_KM = 15;

/** The bbox of `points`, padded by 20% of its span on each side and by at least 15 km (the overview looks well past the assets); null when empty. */
export function terrainBounds(points: LatLon[]): Bounds | null {
  if (points.length === 0) return null;
  let south = Infinity, north = -Infinity, west = Infinity, east = -Infinity;
  for (const p of points) {
    south = Math.min(south, p.lat); north = Math.max(north, p.lat);
    west = Math.min(west, p.lon); east = Math.max(east, p.lon);
  }
  const cos = Math.max(0.05, Math.cos((((south + north) / 2) * Math.PI) / 180));
  const padLat = Math.max(PAD_FRAC * (north - south), MIN_PAD_KM / KM_PER_DEG);
  const padLon = Math.max(PAD_FRAC * (east - west), MIN_PAD_KM / (KM_PER_DEG * cos));
  return { south: south - padLat, west: west - padLon, north: north + padLat, east: east + padLon };
}

/** `b` grown outward onto a `step`-degree grid, so a box that creeps with moving assets stays one box. */
export function snapBounds(b: Bounds, step: number): Bounds {
  const dn = (v: number) => Math.floor(v / step + 1e-9) * step;
  const up = (v: number) => Math.ceil(v / step - 1e-9) * step;
  const r = (v: number) => Math.round(v * 1e6) / 1e6;
  return { south: r(dn(b.south)), west: r(dn(b.west)), north: r(up(b.north)), east: r(up(b.east)) };
}
