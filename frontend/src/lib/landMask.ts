// A land/sea mask from Natural Earth 10 m land (world-atlas TopoJSON), so the
// terrain shaders draw the real coast and polders below sea level stay land.
import * as THREE from 'three';
import type { Bounds } from './terrainBounds';
import { latToTileY } from './terrainTiles';

export type Ring = [number, number][]; // [lon, lat]

export interface Topology {
  transform: { scale: [number, number]; translate: [number, number] };
  arcs: [number, number][][];
  objects: Record<string, TopoGeometry>;
}
interface TopoGeometry { type: string; arcs?: unknown; geometries?: TopoGeometry[] }

/** Every ring (outer and holes) of every Polygon and MultiPolygon in `topo`, as [lon, lat]. */
export function decodeLand(topo: Topology): Ring[] {
  const { scale, translate } = topo.transform;
  // Arcs are quantised deltas: accumulate, then apply the transform.
  const arcs: Ring[] = topo.arcs.map((a) => {
    let x = 0, y = 0;
    return a.map(([dx, dy]) => {
      x += dx; y += dy;
      return [x * scale[0] + translate[0], y * scale[1] + translate[1]] as [number, number];
    });
  });
  // A negative index is the arc `~i` run backwards.
  const arc = (i: number): Ring => (i >= 0 ? arcs[i] : arcs[~i].slice().reverse());
  const ring = (idx: number[]): Ring => {
    const out: Ring = [];
    // Consecutive arcs share their end point: drop the repeat.
    idx.forEach((i, k) => { const a = arc(i); for (let j = k === 0 ? 0 : 1; j < a.length; j++) out.push(a[j]); });
    return out;
  };
  const rings: Ring[] = [];
  const walk = (g: TopoGeometry) => {
    if (g.type === 'GeometryCollection') g.geometries?.forEach(walk);
    else if (g.type === 'Polygon') (g.arcs as number[][]).forEach((r) => rings.push(ring(r)));
    else if (g.type === 'MultiPolygon') (g.arcs as number[][][]).forEach((p) => p.forEach((r) => rings.push(ring(r))));
  };
  Object.values(topo.objects).forEach(walk);
  return rings;
}

/** Web-Mercator v of `lat` over `b`: 1 at the north edge, 0 at the south (the terrain's UV convention). */
export function mercatorV(lat: number, b: Bounds): number {
  const yN = latToTileY(b.north, 0);
  return 1 - (latToTileY(lat, 0) - yN) / (latToTileY(b.south, 0) - yN);
}

// One fetch and decode per URL; a failure is dropped so the next call retries.
const cache = new Map<string, Promise<Ring[]>>();
function land(url: string): Promise<Ring[]> {
  let p = cache.get(url);
  if (!p) {
    p = fetch(url).then((r) => r.json() as Promise<Topology>).then(decodeLand);
    p.catch(() => cache.delete(url));
    cache.set(url, p);
  }
  return p;
}

/** White = land, black = sea, over `b`, Web-Mercator in y, ~1.5 px blur. Null when the land file can't be had: the shaders then treat everything as land. */
export async function landMaskTexture(b: Bounds, url: string, px = 2048): Promise<THREE.CanvasTexture | null> {
  try {
    const rings = await land(url);
    const w = px;
    const aspect = (latToTileY(b.south, 0) - latToTileY(b.north, 0)) / ((b.east - b.west) / 360);
    const h = Math.min(4096, Math.max(1, Math.round(px * aspect)));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    ctx.filter = 'blur(1.5px)';
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    for (const r of rings) {
      let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
      for (const [lon, lat] of r) { west = Math.min(west, lon); east = Math.max(east, lon); south = Math.min(south, lat); north = Math.max(north, lat); }
      if (east < b.west || west > b.east || north < b.south || south > b.north) continue;
      r.forEach(([lon, lat], i) => {
        const x = ((lon - b.west) / (b.east - b.west)) * w;
        const y = (1 - mercatorV(lat, b)) * h;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.closePath();
    }
    ctx.fill('evenodd');
    const t = new THREE.CanvasTexture(c);
    t.anisotropy = 4;
    return t;
  } catch (e) {
    console.warn('land mask unavailable; drawing all land', e);
    return null;
  }
}
