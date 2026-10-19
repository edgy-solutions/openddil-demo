// The HQ map's terrain: the theater at full brightness and a muted, faded surround
// out to ~8 degrees, in the satellite or the holo style. Theater, surround and the
// land mask load independently and each draws as soon as it arrives.
import { useCallback, useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { makeProjection, type Projection } from '../../lib/geoProjection';
import { landMaskTexture } from '../../lib/landMask';
import { M, SCENE_SCALE_UNITS_PER_DEG } from '../../lib/sceneScale';
import { terrainBounds, type Bounds, type LatLon } from '../../lib/terrainBounds';
import { latToTileY, lonToTileX, type TerrainSource } from '../../lib/terrainTiles';
import { drape, loadTerrain, useTerrain, type TerrainData } from './terrain';
import { HOLO_DEFAULTS, HUES } from './holo';
import type { TerrainStyle } from './prefs';
import { HOLO_FRAG, HOLO_VERT, SAT_FRAG, SAT_VERT } from './theaterShaders';

/** The HQ scene's units per degree of latitude. */
export const HQ_UNITS_PER_DEG = 400;
// The terrain code is built at regional scale (80 units/deg): its height sampler
// unprojects with that constant, and heights and the holo km grid use regional
// units. So build it on a regional-scale projection with the same centre, and
// scale the whole group by 400/80 to HQ units. That fixes horizontal, vertical
// and the km grid in one go.
const HQ_SCALE = HQ_UNITS_PER_DEG / SCENE_SCALE_UNITS_PER_DEG;
const BG = 0x020617; // the HQ canvas background
const HOLO_KM = 10 * (HQ_UNITS_PER_DEG / 111); // holo grid: 10 km in HQ world units
const TILE_BUDGET = 120;

/** Theater rect in HQ world xz: minX, minZ, maxX, maxZ. */
export type Rect = [number, number, number, number];

const tiles = (b: Bounds, z: number) =>
  (Math.floor(lonToTileX(b.east, z)) - Math.floor(lonToTileX(b.west, z)) + 1) *
  (Math.floor(latToTileY(b.south, z)) - Math.floor(latToTileY(b.north, z)) + 1);

/** +-8 degrees of latitude around `c`, and the same ground distance in longitude. */
export function surroundBounds(c: { lat: number; lon: number }): Bounds {
  const dLon = 8 / Math.cos((c.lat * Math.PI) / 180);
  return { south: c.lat - 8, north: c.lat + 8, west: c.lon - dLon, east: c.lon + dLon };
}
/** z7 unless that is over the tile budget. */
export function surroundZoom(b: Bounds): number {
  let z = 7;
  while (z > 3 && tiles(b, z) > TILE_BUDGET) z--;
  return z;
}

export interface TheaterTerrainData {
  theater: TerrainData | null;
  surround: TerrainData | null;
  /** Land/sea masks over each layer's bounds; null until loaded (or if the land file is unavailable): all land. */
  mask: { theater: THREE.Texture | null; surround: THREE.Texture | null };
  /** True when the OSM water file was drawn into the theater or surround relief or either mask (for its credit). */
  water: boolean;
  rect: Rect | null;
  /** True when the theater layer failed to load (no elevation tiles): the caller falls back to the terrain-off scene. */
  failed: boolean;
  /** Ground height in HQ world units at world (x, z); 0 when off or before the theater arrives. */
  groundY: (x: number, z: number) => number;
}

function useSurround(b: Bounds | null, proj: Projection, source: TerrainSource): TerrainData | null {
  const [data, setData] = useState<TerrainData | null>(null);
  const { elevationUrl, imageryUrl, landUrl, lakesUrl, waterUrl, basemap, reliefPalette, imageryMaxZoom } = source;
  useEffect(() => {
    if (!b) { setData(null); return; }
    let live = true;
    const z = surroundZoom(b);
    loadTerrain(b, proj, source, { demZoom: z, imgZoom: z })
      .then((d) => { if (live) setData(d); else d.texture.dispose(); })
      .catch((e) => console.warn('surround terrain unavailable', e));
    return () => { live = false; };
    // source is read through the fields below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [b, proj, elevationUrl, imageryUrl, landUrl, lakesUrl, waterUrl, basemap, reliefPalette, imageryMaxZoom]);
  useEffect(() => () => data?.texture.dispose(), [data]);
  return data;
}

function useMask(b: Bounds | null, source: TerrainSource): { texture: THREE.Texture | null; water: boolean } {
  const [m, setM] = useState<{ texture: THREE.Texture; water: boolean } | null>(null);
  const { landUrl, lakesUrl, waterUrl } = source;
  useEffect(() => {
    if (!b) { setM(null); return; }
    let live = true;
    landMaskTexture(b, landUrl, undefined, lakesUrl, waterUrl).then((x) => { if (live) setM(x); else x?.texture.dispose(); });
    return () => { live = false; };
  }, [b, landUrl, lakesUrl, waterUrl]);
  useEffect(() => () => m?.texture.dispose(), [m]);
  return { texture: m?.texture ?? null, water: m?.water ?? false };
}

/** Loads the theater, the surround and the land mask around `points` (FOBs, plus the HQ if configured) while `on`. */
export function useTheaterTerrain({ points, projection, source, exag, on }: {
  points: LatLon[]; projection: Projection; source: TerrainSource;
  /** Only the render differs by style; the data is shared. */ style?: TerrainStyle;
  exag: number; on: boolean;
}): TheaterTerrainData {
  const bounds = useMemo(() => (on ? terrainBounds(points) : null), [on, points]);
  const { lat, lon } = projection.center;
  const regional = useMemo(() => makeProjection([], SCENE_SCALE_UNITS_PER_DEG, [{ lat, lon }]), [lat, lon]);
  const sBounds = useMemo(() => (bounds ? surroundBounds({ lat, lon }) : null), [bounds, lat, lon]);

  const { data: theater, failed } = useTerrain(bounds, source, regional);
  const surround = useSurround(sBounds, regional, source);
  const tMask = useMask(bounds, source);
  const sMask = useMask(sBounds, source);
  const mask = useMemo(() => ({ theater: tMask.texture, surround: sMask.texture }), [tMask.texture, sMask.texture]);
  const water = !!(theater?.water || surround?.water || tMask.water || sMask.water);

  const rect = useMemo<Rect | null>(() => {
    if (!bounds) return null;
    const [x0, z0] = regional.project(bounds.north, bounds.west);
    const [x1, z1] = regional.project(bounds.south, bounds.east);
    return [Math.min(x0, x1) * HQ_SCALE, Math.min(z0, z1) * HQ_SCALE, Math.max(x0, x1) * HQ_SCALE, Math.max(z0, z1) * HQ_SCALE];
  }, [bounds, regional]);

  const groundY = useCallback(
    (x: number, z: number) => (on && theater ? HQ_SCALE * theater.heightM(x / HQ_SCALE, z / HQ_SCALE) * M * exag : 0),
    [on, theater, exag],
  );
  return { theater, surround, mask, water, rect, failed, groundY };
}

// Stands in for a mask that is not (or never will be) there: everything is land.
let allLand: THREE.DataTexture | null = null;
function landFallback(): THREE.Texture {
  if (!allLand) {
    allLand = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    allLand.needsUpdate = true;
  }
  return allLand;
}

function SatLayer({ data, exag, rect, mask, surround = false }: {
  data: TerrainData; exag: number; rect: Rect; mask: THREE.Texture | null; surround?: boolean;
}) {
  const geometry = useMemo(() => drape(data.heightM, data.bounds, data.proj, surround ? 300 : 400, exag), [data, exag, surround]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  const material = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: SAT_VERT, fragmentShader: SAT_FRAG,
    polygonOffset: surround, polygonOffsetFactor: 1, polygonOffsetUnits: 1, // the surround sits behind the theater at the overlap
    uniforms: {
      uMap: { value: data.texture }, uTheater: { value: new THREE.Vector4(...rect) },
      uFadeColor: { value: new THREE.Color(BG) }, uSurround: { value: surround ? 1 : 0 }, uMask: { value: null },
    },
  }), [data, rect, surround]);
  useEffect(() => () => material.dispose(), [material]);
  material.uniforms.uMask.value = mask ?? landFallback();
  return <mesh geometry={geometry} material={material} userData={{ insetHidden: true }} />;
}

function blur(src: Float32Array, n: number, r: number): Float32Array {
  if (r <= 0) return src;
  const a = src.slice();
  const b = new Float32Array(a.length);
  const pass = (from: Float32Array, to: Float32Array, horiz: boolean) => {
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let k = -r; k <= r; k++) {
          const t = Math.min(n - 1, Math.max(0, i + k));
          sum += horiz ? from[j * n + t] : from[t * n + j];
        }
        to[horiz ? j * n + i : i * n + j] = sum / (2 * r + 1);
      }
    }
  };
  for (let it = 0; it < 2; it++) { pass(a, b, true); pass(b, a, false); }
  return a;
}

/** The holo style: the surround layer is the same shader with the theater rect cut out of it. */
function HoloLayer({ data, exag, rect, mask, surround = false }: {
  data: TerrainData; exag: number; rect: Rect; mask: THREE.Texture | null; surround?: boolean;
}) {
  const opts = HOLO_DEFAULTS;
  const segments = surround ? 400 : 500;
  const geometry = useMemo(() => drape(data.heightM, data.bounds, data.proj, segments, exag, data.rawM), [data, exag, segments]);
  useEffect(() => {
    const a = geometry.getAttribute('hraw') as THREE.BufferAttribute;
    (a.array as Float32Array).set(blur((a.array as Float32Array).slice(), segments + 1, Math.round(opts.smooth)));
    a.needsUpdate = true;
  }, [geometry, segments, opts.smooth]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  const material = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: HOLO_VERT, fragmentShader: HOLO_FRAG,
    polygonOffset: surround, polygonOffsetFactor: 1, polygonOffsetUnits: 1, // the surround sits behind the theater at the overlap
    uniforms: {
      uColor: { value: new THREE.Color(HUES[opts.hue]) }, uFadeColor: { value: new THREE.Color(BG) },
      uFloor: { value: opts.floor }, uStep: { value: opts.step }, uSeaStep: { value: opts.seaStep },
      uKm: { value: HOLO_KM }, uGlow: { value: 1 }, uSurround: { value: surround ? 1 : 0 }, uMute: { value: 1 },
      uTheater: { value: new THREE.Vector4(...rect) }, uMask: { value: null },
    },
  }), [opts, rect, surround]);
  useEffect(() => () => material.dispose(), [material]);
  material.uniforms.uMask.value = mask ?? landFallback();
  return <mesh geometry={geometry} material={material} userData={{ insetHidden: true }} />;
}

/** Inside the Canvas. Draws whatever of the theater and surround has loaded. */
export function TheaterTerrain({ data, style, exag }: { data: TheaterTerrainData; style: TerrainStyle; exag: number }) {
  const { theater, surround, mask, rect } = data;
  const Layer = style === 'holo' ? HoloLayer : SatLayer;
  if (!rect) return null;
  return (
    <group scale={HQ_SCALE}>
      {theater && <Layer data={theater} exag={exag} rect={rect} mask={mask.theater} />}
      {surround && <Layer data={surround} exag={exag} rect={rect} mask={mask.surround} surround />}
    </group>
  );
}
