// Real 3D terrain for the regional scene: a Terrarium DEM heightfield with a basemap
// draped on it, registered with the scene projection.
//
// The basemap is a provider (`deployment().terrain.basemap`, see lib/terrainTiles): the
// default `relief` is a hillshaded elevation tint with the coast from Natural Earth and
// optional packaged OSM water, built from the DEM alone; `imagery` and `licensed` drape
// packaged or deployment-supplied tiles. Tiles are packaged under
// `/deployment-overlay/` and nothing is fetched from the internet unless the
// deployment's config turns `network` on.
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import type { Projection } from '../../lib/geoProjection';
import { M, SCENE_SCALE_UNITS_PER_DEG } from '../../lib/sceneScale';
import type { Bounds } from '../../lib/terrainBounds';
import { reliefMask, maskSize } from '../../lib/landMask';
import { reliefCanvas, reliefTexture } from '../../lib/relief';
import {
  decodeTerrarium, fitZoom, latToTileY, lonToTileX, tileUrl, type TerrainSource,
} from '../../lib/terrainTiles';

export type { Bounds } from '../../lib/terrainBounds';
export type { TerrainSource } from '../../lib/terrainTiles';

export type TerrainData = {
  bounds: Bounds;
  /** The projection the heights are registered with. */
  proj: Projection;
  /** True height in metres at a scene point (x, z), bilinear over the DEM; sea clamped to 0; outside bounds → 0. */
  heightM: (x: number, z: number) => number;
  /** As heightM, but unclamped: polders and sea floor keep their negative heights. */
  rawM: (x: number, z: number) => number;
  texture: THREE.Texture; // basemap (relief or imagery) cropped exactly to bounds, SRGBColorSpace, anisotropy 8
  /** True when the OSM water file was used for the relief mask (for its credit). */
  water: boolean;
  /** True when a land or water mask was drawn into the relief (for the coastline credit). */
  masked: boolean;
  /** Land/sea mask over `bounds` (white = land, row 0 = north, Mercator in y), or null when no coastline data could be had. */
  mask: HTMLCanvasElement | null;
  /** Zoom of the base imagery (or relief) mosaic. */
  baseZoom: number;
};

const MAX_INFLIGHT = 8;

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null); // a bad tile stays blank
    img.src = url;
  });
}

// Run tasks with at most `limit` in flight.
async function pool(tasks: (() => Promise<void>)[], limit: number) {
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) await tasks[next++]();
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}

type Mosaic = { canvas: HTMLCanvasElement; x0: number; y0: number; z: number; loaded: number };

async function mosaic(b: Bounds, z: number, template: string, fill: string): Promise<Mosaic> {
  // A tile-aligned edge sits exactly on a tile boundary: nudge inward so it does not pull in the next tile.
  const EPS = 1e-6;
  const x0 = Math.floor(lonToTileX(b.west, z) + EPS);
  const y0 = Math.floor(latToTileY(b.north, z) + EPS);
  const x1 = Math.max(x0, Math.floor(lonToTileX(b.east, z) - EPS));
  const y1 = Math.max(y0, Math.floor(latToTileY(b.south, z) - EPS));
  const canvas = document.createElement('canvas');
  canvas.width = (x1 - x0 + 1) * 256;
  canvas.height = (y1 - y0 + 1) * 256;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  let loaded = 0;
  const tasks: (() => Promise<void>)[] = [];
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      tasks.push(async () => {
        const img = await loadImage(tileUrl(template, z, tx, ty));
        if (img) { ctx.drawImage(img, (tx - x0) * 256, (ty - y0) * 256); loaded++; }
      });
    }
  }
  await pool(tasks, MAX_INFLIGHT);
  return { canvas, x0, y0, z, loaded };
}

// Crop a mosaic to the exact bounds in mercator pixel space.
function crop(m: Mosaic, b: Bounds): HTMLCanvasElement {
  const px0 = (lonToTileX(b.west, m.z) - m.x0) * 256;
  const px1 = (lonToTileX(b.east, m.z) - m.x0) * 256;
  const py0 = (latToTileY(b.north, m.z) - m.y0) * 256;
  const py1 = (latToTileY(b.south, m.z) - m.y0) * 256;
  const w = Math.max(1, Math.round(px1 - px0));
  const h = Math.max(1, Math.round(py1 - py0));
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(m.canvas, px0, py0, px1 - px0, py1 - py0, 0, 0, w, h);
  return out;
}

export async function loadTerrain(
  b: Bounds, proj: Projection, source: TerrainSource,
  opts: { demZoom?: number; imgZoom?: number; reliefGain?: number } = {},
): Promise<TerrainData> {
  // A large region drops to a coarser DEM zoom so the mosaic stays under 4096 px.
  const demZoom = opts.demZoom ?? fitZoom(b, 11);
  const relief = source.basemap === 'relief';
  const baseZoom = Math.min(opts.imgZoom ?? fitZoom(b, 14), relief ? 13 : source.imageryMaxZoom);
  const demP = mosaic(b, demZoom, source.elevationUrl, '');
  // Relief is built from a DEM mosaic (the heightfield's own when the zoom matches); imagery has its own.
  const baseP = relief
    ? (baseZoom === demZoom ? demP : mosaic(b, baseZoom, source.elevationUrl, ''))
    : mosaic(b, baseZoom, source.imageryUrl, '#000');
  const [dem, base] = await Promise.all([demP, baseP]);
  if (dem.loaded === 0) throw new Error('no elevation tiles');

  // DEM grid, row 0 = north, native pixel spacing
  const demCrop = crop(dem, b);
  const W = demCrop.width;
  const H = demCrop.height;
  const px = demCrop.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, W, H).data;
  const grid = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    // transparent = blank tile → 0
    grid[i] = px[i * 4 + 3] === 0 ? 0 : decodeTerrarium(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);
  }
  const yN = latToTileY(b.north, demZoom);
  const ySpan = latToTileY(b.south, demZoom) - yN;
  const cosC = Math.cos((proj.center.lat * Math.PI) / 180);

  const rawM = (x: number, z: number): number => {
    const lat = proj.center.lat - z / SCENE_SCALE_UNITS_PER_DEG;
    const lon = proj.center.lon + x / (SCENE_SCALE_UNITS_PER_DEG * cosC);
    const fx = (lon - b.west) / (b.east - b.west);
    const fy = (latToTileY(lat, demZoom) - yN) / ySpan;
    if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return 0;
    const gx = fx * (W - 1);
    const gy = fy * (H - 1);
    const ix = Math.min(Math.floor(gx), Math.max(W - 2, 0));
    const iy = Math.min(Math.floor(gy), Math.max(H - 2, 0));
    const tx = gx - ix;
    const ty = gy - iy;
    const ix1 = Math.min(ix + 1, W - 1);
    const iy1 = Math.min(iy + 1, H - 1);
    return (
      grid[iy * W + ix] * (1 - tx) * (1 - ty) +
      grid[iy * W + ix1] * tx * (1 - ty) +
      grid[iy1 * W + ix] * (1 - tx) * ty +
      grid[iy1 * W + ix1] * tx * ty
    );
  };
  const heightM = (x: number, z: number): number => Math.max(rawM(x, z), 0);

  let texture: THREE.Texture;
  let water = false, masked = false;
  let mask: HTMLCanvasElement | null = null;
  if (relief) {
    const rc = crop(base, b);
    const m = await reliefMask(b, rc.width, rc.height, source);
    water = !!m?.water; masked = !!m; mask = m?.canvas ?? null;
    texture = reliefTexture(reliefCanvas(rc, b, baseZoom, m?.canvas ?? null, source.reliefPalette, opts.reliefGain ?? 1));
  } else {
    texture = new THREE.CanvasTexture(crop(base, b));
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    // The holo style takes land and sea from the coastline, not from height; the terrain loads without it.
    try {
      const [mw, mh] = maskSize(W, H);
      const m = await reliefMask(b, mw, mh, source);
      if (m) { water = m.water; masked = true; mask = m.canvas; }
    } catch { /* no coastline data */ }
  }
  return { bounds: b, proj, heightM, rawM, texture, water, masked, mask, baseZoom };
}

/** Load terrain for `b` (null = none). Reloads when the box, the tile source or the projection centre changes. */
export function useTerrain(
  b: Bounds | null, source: TerrainSource, proj: Projection, reliefGain = 1,
): { data: TerrainData | null; failed: boolean } {
  const [data, setData] = useState<TerrainData | null>(null);
  const [failed, setFailed] = useState(false);
  const { elevationUrl, imageryUrl, landUrl, lakesUrl, waterUrl, basemap, reliefPalette, imageryMaxZoom } = source;
  const { lat, lon } = proj.center;
  const south = b?.south, west = b?.west, north = b?.north, east = b?.east;
  useEffect(() => {
    if (south === undefined || west === undefined || north === undefined || east === undefined) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- a deliberate reset when the bounds go away; terrain otherwise arrives asynchronously
      setData(null);
      setFailed(false);
      return;
    }
    let live = true;
    setFailed(false);
    loadTerrain({ south, west, north, east }, proj, source, { reliefGain })
      .then((d) => { if (live) setData(d); else d.texture.dispose(); })
      .catch((e) => { console.warn('terrain unavailable', e); if (live) { setData(null); setFailed(true); } });
    return () => { live = false; };
    // proj is keyed by its centre, and source by the fields below: only those define them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [south, west, north, east, elevationUrl, imageryUrl, landUrl, lakesUrl, waterUrl, basemap, reliefPalette, imageryMaxZoom, reliefGain, lat, lon]);
  useEffect(() => () => data?.texture.dispose(), [data]);
  return { data, failed };
}

/** A grid draped on the heightfield over `b`, with mercator-correct UVs (v = 1 at north). */
export function drape(
  heightM: TerrainData['heightM'], b: Bounds, proj: Projection, segments: number, exag: number, rawM?: TerrainData['rawM'],
) {
  const { south, west, north, east } = b;
  const n = segments + 1;
  const pos = new Float32Array(n * n * 3);
  const uv = new Float32Array(n * n * 2);
  const raw = rawM ? new Float32Array(n * n) : null;
  const tyN = latToTileY(north, 0);
  const tySpan = latToTileY(south, 0) - tyN;
  for (let j = 0; j < n; j++) {
    const lat = north + ((south - north) * j) / segments;
    // v = 1 at north (CanvasTexture flipY, row 0 = north)
    const v = 1 - (latToTileY(lat, 0) - tyN) / tySpan;
    for (let i = 0; i < n; i++) {
      const lon = west + ((east - west) * i) / segments;
      const [x, z] = proj.project(lat, lon);
      const k = j * n + i;
      pos[k * 3] = x;
      pos[k * 3 + 1] = heightM(x, z) * M * exag;
      pos[k * 3 + 2] = z;
      uv[k * 2] = (lon - west) / (east - west);
      uv[k * 2 + 1] = v;
      if (raw) raw[k] = rawM!(x, z);
    }
  }
  const idx = new Uint32Array(segments * segments * 6);
  let t = 0;
  for (let j = 0; j < segments; j++) {
    for (let i = 0; i < segments; i++) {
      const a = j * n + i;
      const c = a + n;
      // counter-clockwise seen from above (+y)
      idx[t++] = a; idx[t++] = c; idx[t++] = a + 1;
      idx[t++] = a + 1; idx[t++] = c; idx[t++] = c + 1;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (raw) g.setAttribute('hraw', new THREE.BufferAttribute(raw, 1));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  return g;
}

// ---- sharp patches ----------------------------------------------------------
/** A square of `halfKm` around a point, as lat/lon bounds. */
export function boundsAround(lat: number, lon: number, halfKm: number): Bounds {
  const dLat = halfKm / 111;
  const dLon = halfKm / (111 * Math.cos((lat * Math.PI) / 180));
  return { south: lat - dLat, west: lon - dLon, north: lat + dLat, east: lon + dLon };
}

/** Fade a canvas's alpha to zero over `frac` of each edge, so a patch blends into the base imagery. */
function feather(c: HTMLCanvasElement, frac: number) {
  const ctx = c.getContext('2d')!;
  ctx.globalCompositeOperation = 'destination-in';
  for (const [w, h] of [[c.width, 0], [0, c.height]]) {
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(frac, 'rgba(0,0,0,1)');
    g.addColorStop(1 - frac, 'rgba(0,0,0,1)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, c.width, c.height);
  }
  ctx.globalCompositeOperation = 'source-over';
}

export type Patch = { bounds: Bounds; texture: THREE.Texture; zoom: number; /** The spec key it was loaded for (set by usePatches). */ key?: string };
/** High-resolution imagery for a small area (up to z18+, ~0.4 m/px at 53°N), feathered at the edges.
 *  `exactZoom` (tile-aligned bounds) replaces the fitted zoom. */
export async function loadPatch(b: Bounds, source: TerrainSource, maxZoom = 18, exactZoom?: number): Promise<Patch> {
  const zoom = exactZoom ?? fitZoom(b, Math.min(maxZoom, source.patchMaxZoom));
  const c = crop(await mosaic(b, zoom, source.patchImageryUrl, '#000'), b);
  feather(c, 0.1);
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return { bounds: b, texture, zoom };
}

/** `zoom`, when set, is the exact tile zoom (the bounds are tile-aligned); else the zoom is fitted up to `maxZoom`. */
export type PatchSpec = { bounds: Bounds; maxZoom: number; zoom?: number };
const patchSpecKey = (s: PatchSpec): string =>
  `${s.zoom ?? `f${s.maxZoom}`}:${s.bounds.south}:${s.bounds.west}:${s.bounds.north}:${s.bounds.east}`;

/** Patches for `list`, loaded incrementally: a spec already loaded or loading is not requested again, and
 *  patches that left the list stay on screen until every spec in the current list has finished (loaded or
 *  failed), so the old sharp imagery is not removed before the new is in. */
export function usePatches(list: PatchSpec[], source: TerrainSource): Patch[] {
  const [patches, setPatches] = useState<Patch[]>([]);
  const key = JSON.stringify(list);
  const { patchImageryUrl, patchMaxZoom } = source;
  const loaded = useRef(new Map<string, Patch>());
  const loading = useRef(new Set<string>());
  const failed = useRef(new Set<string>());
  const current = useRef(new Set<string>());
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    const done = loaded.current;
    const bad = failed.current;
    return () => {
      mounted.current = false;
      for (const p of done.values()) p.texture.dispose();
      done.clear();
      bad.clear();
    };
  }, []);

  useEffect(() => {
    if (!patchImageryUrl) {
      for (const p of loaded.current.values()) p.texture.dispose();
      loaded.current.clear();
      current.current = new Set();
      // eslint-disable-next-line react-hooks/set-state-in-effect -- a deliberate reset when the patch imagery goes away; patches then arrive asynchronously
      setPatches([]);
      return;
    }
    const specs: PatchSpec[] = JSON.parse(key);
    const keyed = specs.map((s) => [patchSpecKey(s), s] as const);
    current.current = new Set(keyed.map(([k]) => k));
    for (const k of failed.current) if (!current.current.has(k)) failed.current.delete(k);

    const settle = () => {
      if (!mounted.current) return;
      const pending = [...current.current].some((k) => !loaded.current.has(k) && !failed.current.has(k));
      if (!pending) {
        for (const [k, p] of loaded.current) {
          if (!current.current.has(k)) { p.texture.dispose(); loaded.current.delete(k); }
        }
      }
      setPatches([...loaded.current.values()]);
    };

    for (const [k, spec] of keyed) {
      if (loaded.current.has(k) || loading.current.has(k) || failed.current.has(k)) continue;
      loading.current.add(k);
      loadPatch(spec.bounds, source, spec.maxZoom, spec.zoom)
        .then((p) => {
          loading.current.delete(k);
          // Gone, or its spec left the list while it loaded: drop it.
          if (!mounted.current || !current.current.has(k)) { p.texture.dispose(); return; }
          loaded.current.set(k, { ...p, key: k });
          settle();
        })
        .catch((e) => {
          loading.current.delete(k);
          console.error('patch load failed', e);
          failed.current.add(k);
          settle();
        });
    }
    settle();
    // source is read by the two fields above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, patchImageryUrl, patchMaxZoom]);
  return patches;
}
