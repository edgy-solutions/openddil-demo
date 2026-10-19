// Real 3D terrain for the regional scene: a Terrarium DEM heightfield, with
// optional satellite imagery draped on it, registered with the scene projection.
//
// Tile sources come from `deployment().terrain` (elevationUrl, imageryUrl,
// attribution), falling back to the public AWS Terrarium and Esri tiles. A DDIL
// deployment points these at tiles baked under `/deployment-overlay/`, so the map
// needs no internet.
import { useEffect, useMemo, useState } from 'react';
import '@react-three/fiber'; // JSX intrinsics for mesh
import * as THREE from 'three';
import type { Projection } from '../../lib/geoProjection';
import { M, SCENE_SCALE_UNITS_PER_DEG } from '../../lib/sceneScale';
import type { Bounds } from '../../lib/terrainBounds';
import {
  DEFAULT_TERRAIN_SOURCE, decodeTerrarium, fitZoom, latToTileY, lonToTileX, tileUrl, type TerrainSource,
} from '../../lib/terrainTiles';

export type { Bounds } from '../../lib/terrainBounds';
export type { TerrainSource } from '../../lib/terrainTiles';
export const ATTRIBUTION = DEFAULT_TERRAIN_SOURCE.attribution;

export type TerrainData = {
  bounds: Bounds;
  /** The projection the heights are registered with. */
  proj: Projection;
  /** True height in metres at a scene point (x, z), bilinear over the DEM; sea clamped to 0; outside bounds → 0. */
  heightM: (x: number, z: number) => number;
  /** As heightM, but unclamped: polders and sea floor keep their negative heights. */
  rawM: (x: number, z: number) => number;
  texture: THREE.Texture; // imagery cropped exactly to bounds, SRGBColorSpace, anisotropy 8
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

type Mosaic = { canvas: HTMLCanvasElement; x0: number; y0: number; z: number };

async function mosaic(b: Bounds, z: number, template: string, fill: string): Promise<Mosaic> {
  const x0 = Math.floor(lonToTileX(b.west, z));
  const x1 = Math.floor(lonToTileX(b.east, z));
  const y0 = Math.floor(latToTileY(b.north, z));
  const y1 = Math.floor(latToTileY(b.south, z));
  const canvas = document.createElement('canvas');
  canvas.width = (x1 - x0 + 1) * 256;
  canvas.height = (y1 - y0 + 1) * 256;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  const tasks: (() => Promise<void>)[] = [];
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      tasks.push(async () => {
        const img = await loadImage(tileUrl(template, z, tx, ty));
        if (img) ctx.drawImage(img, (tx - x0) * 256, (ty - y0) * 256);
      });
    }
  }
  await pool(tasks, MAX_INFLIGHT);
  return { canvas, x0, y0, z };
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
  b: Bounds, proj: Projection, source: TerrainSource = DEFAULT_TERRAIN_SOURCE,
  opts: { demZoom?: number; imgZoom?: number } = {},
): Promise<TerrainData> {
  // A large region drops to a coarser DEM zoom so the mosaic stays under 4096 px.
  const demZoom = opts.demZoom ?? fitZoom(b, 11);
  const imgZoom = opts.imgZoom ?? fitZoom(b, 14);
  const [dem, img] = await Promise.all([
    mosaic(b, demZoom, source.elevationUrl, ''),
    mosaic(b, imgZoom, source.imageryUrl, '#000'),
  ]);

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

  const texture = new THREE.CanvasTexture(crop(img, b));
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return { bounds: b, proj, heightM, rawM, texture };
}

/** Load terrain for `b` (null = none). Reloads when the box, the tile source or the projection centre changes. */
export function useTerrain(b: Bounds | null, source: TerrainSource, proj: Projection): TerrainData | null {
  const [data, setData] = useState<TerrainData | null>(null);
  const { elevationUrl, imageryUrl } = source;
  const { lat, lon } = proj.center;
  const south = b?.south, west = b?.west, north = b?.north, east = b?.east;
  useEffect(() => {
    if (south === undefined || west === undefined || north === undefined || east === undefined) {
      setData(null);
      return;
    }
    let live = true;
    loadTerrain({ south, west, north, east }, proj, { elevationUrl, imageryUrl, attribution: '', landUrl: '' })
      .then((d) => { if (live) setData(d); else d.texture.dispose(); })
      .catch((e) => console.error('terrain load failed', e));
    return () => { live = false; };
    // proj is keyed by its centre: only that and the fixed scale define it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [south, west, north, east, elevationUrl, imageryUrl, lat, lon]);
  useEffect(() => () => data?.texture.dispose(), [data]);
  return data;
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

export function TerrainMesh({ data, exag = 1, segments = 400 }: { data: TerrainData; exag?: number; segments?: number }) {
  const geometry = useMemo(() => drape(data.heightM, data.bounds, data.proj, segments, exag), [data, exag, segments]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    // Drawn only in the main view, not in the engagement inset.
    <mesh geometry={geometry} userData={{ insetHidden: true }}>
      <meshStandardMaterial map={data.texture} roughness={1} metalness={0} color="#a8b4c4" />
    </mesh>
  );
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

export type Patch = { bounds: Bounds; texture: THREE.Texture; zoom: number };
/** High-resolution imagery for a small area (up to z18+, ~0.4 m/px at 53°N), feathered at the edges. */
export async function loadPatch(b: Bounds, source: TerrainSource = DEFAULT_TERRAIN_SOURCE, maxZoom = 18): Promise<Patch> {
  const zoom = fitZoom(b, maxZoom);
  const c = crop(await mosaic(b, zoom, source.imageryUrl, '#000'), b);
  feather(c, 0.1);
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return { bounds: b, texture, zoom };
}

export type PatchSpec = { bounds: Bounds; maxZoom: number };
export function usePatches(list: PatchSpec[], source: TerrainSource): Patch[] {
  const [patches, setPatches] = useState<Patch[]>([]);
  const key = JSON.stringify(list);
  const { elevationUrl, imageryUrl } = source;
  useEffect(() => {
    let live = true;
    const specs: PatchSpec[] = JSON.parse(key);
    // Each patch appears as soon as it is ready.
    for (const { bounds, maxZoom } of specs) {
      loadPatch(bounds, { elevationUrl, imageryUrl, attribution: '', landUrl: '' }, maxZoom)
        .then((p) => { if (live) setPatches((ps) => [...ps, p]); else p.texture.dispose(); })
        .catch((e) => console.error('patch load failed', e));
    }
    return () => { live = false; setPatches([]); };
  }, [key, elevationUrl, imageryUrl]);
  return patches;
}

/** A patch draped on the same heightfield, drawn over the base imagery; sharper patches draw on top. */
export function PatchMesh({ data, patch, exag = 1 }: { data: TerrainData; patch: Patch; exag?: number }) {
  // Vehicle patches are ~200 m: 16 segments still follow the ~45 m DEM.
  const segs = patch.zoom >= 19 ? 16 : 96;
  const geometry = useMemo(() => drape(data.heightM, patch.bounds, data.proj, segs, exag), [data, patch, exag, segs]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => patch.texture.dispose(), [patch]);
  return (
    <mesh geometry={geometry} renderOrder={patch.zoom} userData={{ insetHidden: true }}>
      <meshStandardMaterial map={patch.texture} roughness={1} metalness={0} color="#a8b4c4"
        transparent depthWrite={false} polygonOffset polygonOffsetFactor={-2} polygonOffsetUnits={-2} />
    </mesh>
  );
}
