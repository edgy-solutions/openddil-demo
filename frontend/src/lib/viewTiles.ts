// Web-Mercator tile boxes that follow the camera, for the regional sharp-imagery patches.
import type { Bounds } from './terrainBounds';
import { latToTileY, lonToTileX, tileXToLon, tileYToLat } from './terrainTiles';

/** Ground resolution of a 256 px tile at zoom 0 on the equator, metres per pixel. */
const EQUATOR_M_PER_PX = 156543.03;

/** The tile zoom whose resolution at `lat` is closest to `metresPerPx`, clamped to [minZ, maxZ]. */
export function viewZoom(metresPerPx: number, lat: number, minZ: number, maxZ: number): number {
  const z = Math.round(Math.log2((EQUATOR_M_PER_PX * Math.cos((lat * Math.PI) / 180)) / metresPerPx));
  return Math.min(maxZ, Math.max(minZ, z));
}

/** Inclusive tile ranges at zoom `z`. */
export type TileBox = { z: number; x0: number; y0: number; x1: number; y1: number };

/** The k x k tiles centred on the tile containing (lat, lon); for even k the extra column and row go east and south. Clamped to the world. */
export function tileBox(lat: number, lon: number, z: number, k: number): TileBox {
  const n = 2 ** z;
  const cx = Math.floor(lonToTileX(lon, z));
  const cy = Math.floor(latToTileY(lat, z));
  const before = Math.floor((k - 1) / 2);
  const clamp = (v: number) => Math.min(n - 1, Math.max(0, v));
  return { z, x0: clamp(cx - before), y0: clamp(cy - before), x1: clamp(cx - before + k - 1), y1: clamp(cy - before + k - 1) };
}

/** Boxes at zFine, zFine - 2, ... while z >= zMin, at most `levels`, finest first. */
export function viewRings(lat: number, lon: number, zFine: number, zMin: number, k = 6, levels = 3): TileBox[] {
  const out: TileBox[] = [];
  for (let z = zFine, i = 0; z >= zMin && i < levels; z -= 2, i++) out.push(tileBox(lat, lon, z, k));
  return out;
}

/** The lat/lon bounds of a tile box (tile edges). */
export function tileBoxBounds(b: TileBox): Bounds {
  return {
    north: tileYToLat(b.y0, b.z),
    south: tileYToLat(b.y1 + 1, b.z),
    west: tileXToLon(b.x0, b.z),
    east: tileXToLon(b.x1 + 1, b.z),
  };
}

export function boxKey(b: TileBox): string {
  return `${b.z}/${b.x0}-${b.x1}/${b.y0}-${b.y1}`;
}
