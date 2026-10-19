// A land/sea mask from Natural Earth 10 m land (world-atlas TopoJSON), so the
// terrain shaders draw the real coast and polders below sea level stay land.
// world-atlas land counts lakes as land, so Natural Earth 10 m lakes are cut
// out of it; islands in a lake are holes in the lake polygon and stay land.
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

interface GeoGeometry { type: string; coordinates?: unknown; geometries?: GeoGeometry[]; geometry?: GeoGeometry; features?: GeoGeometry[] }

/** Every ring of every Polygon and MultiPolygon in a GeoJSON object (Feature, FeatureCollection, geometry) or a TopoJSON topology, as [lon, lat]. */
export function decodeRings(json: unknown): Ring[] {
  return decodeFeatures(json).flat();
}

/** As decodeRings, but one Ring[] per Feature (a bare geometry is one group), so a feature's rings can be filled together (evenodd: islands are inner rings).
 *  TopoJSON is one group per ring. */
export function decodeFeatures(json: unknown): Ring[][] {
  const j = json as Topology & GeoGeometry;
  if (j && j.transform && j.arcs) return decodeLand(j).map((r) => [r]);
  const groups: Ring[][] = [];
  let cur: Ring[] | null = null;
  const walk = (g: GeoGeometry | undefined) => {
    if (!g) return;
    if (g.type === 'FeatureCollection') g.features?.forEach(walk);
    else if (g.type === 'Feature') {
      const outer = cur;
      const mine: Ring[] = [];
      cur = mine;
      walk(g.geometry);
      if (mine.length) groups.push(mine);
      cur = outer;
    }
    else if (g.type === 'GeometryCollection') g.geometries?.forEach(walk);
    else if (g.type === 'Polygon' || g.type === 'MultiPolygon') {
      const all = g.type === 'Polygon' ? (g.coordinates as Ring[]) : (g.coordinates as Ring[][]).flat();
      if (cur) cur.push(...all); else if (all.length) groups.push(all);
    }
  };
  walk(j);
  return groups;
}

/** Packaged water polygons: features grouped for the evenodd fill, and the area the file covers, [w, s, e, n]. */
export interface Water { features: Ring[][]; bbox: [number, number, number, number] }

/** A water file's decoded features and coverage: the top-level `bbox` if it has a valid one, else the bounds of every ring. */
export function decodeWater(json: unknown): Water {
  const features = decodeFeatures(json);
  const given = (json as { bbox?: unknown } | null)?.bbox;
  if (Array.isArray(given) && given.length === 4 && given.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    return { features, bbox: given as Water['bbox'] };
  }
  const bbox: Water['bbox'] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const f of features) for (const r of f) for (const [lon, lat] of r) {
    bbox[0] = Math.min(bbox[0], lon); bbox[1] = Math.min(bbox[1], lat); bbox[2] = Math.max(bbox[2], lon); bbox[3] = Math.max(bbox[3], lat);
  }
  return { features, bbox };
}

/** True when the water file's coverage overlaps `b`. */
export function waterCovers(water: Water, b: Bounds): boolean {
  const [w, s, e, n] = water.bbox;
  return w <= b.east && e >= b.west && s <= b.north && n >= b.south;
}

// One fetch and decode per URL (shared by the HQ and regional layers); a failure is dropped so the next call retries.
function cached<T>(cache: Map<string, Promise<T>>, url: string, decode: (j: unknown) => T): Promise<T> {
  let p = cache.get(url);
  if (!p) {
    p = fetch(url).then((r) => { if (r.ok === false) throw new Error(`${r.status} ${url}`); return r.json(); }).then(decode);
    p.catch(() => cache.delete(url));
    cache.set(url, p);
  }
  return p;
}
const ringCache = new Map<string, Promise<Ring[]>>();
const waterCache = new Map<string, Promise<Water>>();
const rings = (url: string) => cached(ringCache, url, decodeRings);
const waterOf = (url: string) => cached(waterCache, url, decodeWater);

// Each ring's bbox, computed once.
type Box = { west: number; south: number; east: number; north: number };
const boxes = new WeakMap<Ring, Box>();
function boxOf(r: Ring): Box {
  let q = boxes.get(r);
  if (!q) {
    q = { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity };
    for (const [lon, lat] of r) { q.west = Math.min(q.west, lon); q.east = Math.max(q.east, lon); q.south = Math.min(q.south, lat); q.north = Math.max(q.north, lat); }
    boxes.set(r, q);
  }
  return q;
}

let lakesWarned = false;

function fillRings(ctx: CanvasRenderingContext2D, b: Bounds, w: number, h: number, rs: Ring[], color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  for (const r of rs) {
    const q = boxOf(r);
    if (q.east < b.west || q.west > b.east || q.north < b.south || q.south > b.north) continue;
    r.forEach(([lon, lat], i) => {
      const x = ((lon - b.west) / (b.east - b.west)) * w;
      const y = (1 - mercatorV(lat, b)) * h;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.closePath();
  }
  ctx.fill('evenodd');
}

/** Draws the mask over `b`, Web-Mercator in y, ~1.5 px blur: black sea, Natural Earth land white (skipped when null),
 *  then, inside the water file's coverage, white and the water features black (evenodd per feature), then lakes black
 *  everywhere. Rings outside `b` are skipped. Returns true when the water file was drawn (its coverage overlaps `b`). */
export function drawMask(
  ctx: CanvasRenderingContext2D, b: Bounds, w: number, h: number, land: Ring[] | null, lakes: Ring[], water: Water | null = null,
): boolean {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  ctx.filter = 'blur(1.5px)';
  if (land) fillRings(ctx, b, w, h, land, '#fff');
  let usedWater = false;
  if (water && waterCovers(water, b)) {
    usedWater = true;
    // Coverage rectangle in mask pixels, limited to `b`.
    const west = Math.max(water.bbox[0], b.west), east = Math.min(water.bbox[2], b.east);
    const south = Math.max(water.bbox[1], b.south), north = Math.min(water.bbox[3], b.north);
    const x0 = ((west - b.west) / (b.east - b.west)) * w, x1 = ((east - b.west) / (b.east - b.west)) * w;
    const y0 = (1 - mercatorV(north, b)) * h, y1 = (1 - mercatorV(south, b)) * h;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.clip();
    ctx.fillStyle = '#fff';
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    for (const f of water.features) fillRings(ctx, b, w, h, f, '#000');
    ctx.restore();
  }
  if (lakes.length) fillRings(ctx, b, w, h, lakes, '#000');
  return usedWater;
}

/** Loads the land, lakes and water files for a mask; each one that fails is null (lakes: empty). */
async function loadMaskInputs(urls: { landUrl: string; lakesUrl?: string; waterUrl?: string }) {
  const [land, lakes, water] = await Promise.all([
    urls.landUrl ? rings(urls.landUrl).catch(() => null) : null,
    urls.lakesUrl ? rings(urls.lakesUrl).catch(() => [] as Ring[]) : ([] as Ring[]),
    urls.waterUrl ? waterOf(urls.waterUrl).catch(() => null) : null,
  ]);
  return { land, lakes, water };
}

/** A `w` x `h` land/water mask canvas (white land) over `b` for the relief. Natural Earth land everywhere, the water file
 *  over its own coverage; either one alone is enough, and with neither there is no mask. `water` is true when the water file was drawn. */
export async function reliefMask(
  b: Bounds, w: number, h: number, urls: { landUrl: string; lakesUrl: string; waterUrl: string },
): Promise<{ canvas: HTMLCanvasElement; water: boolean } | null> {
  const { land, lakes, water } = await loadMaskInputs(urls);
  if (!land && !water) return null;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  return { canvas, water: drawMask(ctx, b, w, h, land, lakes, water) };
}

/** White = land, black = sea and lakes, over `b`, drawn as reliefMask does so the HQ sea colour and the relief agree.
 *  Null when neither the land nor the water file can be had: the shaders then treat everything as land.
 *  A missing lakes file is warned about and the land is drawn without it. */
export async function landMaskTexture(
  b: Bounds, url: string, px = 2048, lakesUrl?: string, waterUrl?: string,
): Promise<{ texture: THREE.CanvasTexture; water: boolean } | null> {
  try {
    const [land, water] = await Promise.all([
      url ? rings(url).catch((e) => { console.warn('land mask: land unavailable', e); return null; }) : null,
      waterUrl ? waterOf(waterUrl).catch(() => null) : null,
    ]);
    if (!land && !water) return null;
    let lakeRings: Ring[] = [];
    if (lakesUrl) {
      try { lakeRings = await rings(lakesUrl); } catch (e) {
        if (!lakesWarned) { lakesWarned = true; console.warn('lakes unavailable; drawing land only', e); }
      }
    }
    const w = px;
    const aspect = (latToTileY(b.south, 0) - latToTileY(b.north, 0)) / ((b.east - b.west) / 360);
    const h = Math.min(4096, Math.max(1, Math.round(px * aspect)));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const usedWater = drawMask(ctx, b, w, h, land, lakeRings, water);
    const t = new THREE.CanvasTexture(c);
    t.anisotropy = 4;
    return { texture: t, water: usedWater };
  } catch (e) {
    console.warn('land mask unavailable; drawing all land', e);
    return null;
  }
}
