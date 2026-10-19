// The HQ map terrain's loaders and bounds: the theater, the surround and the land mask.
// The layers that draw them are in theater.tsx.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type * as THREE from 'three';
import { makeProjection, type Projection } from '../../lib/geoProjection';
import { landMaskTexture } from '../../lib/landMask';
import { M, SCENE_SCALE_UNITS_PER_DEG } from '../../lib/sceneScale';
import { terrainBounds, type Bounds, type LatLon } from '../../lib/terrainBounds';
import { latToTileY, lonToTileX, type TerrainSource } from '../../lib/terrainTiles';
import { loadTerrain, useTerrain, type TerrainData } from './terrainData';
import type { TerrainStyle } from './prefs';

/** The HQ scene's units per degree of latitude. */
export const HQ_UNITS_PER_DEG = 400;
// The terrain code is built at regional scale (80 units/deg): its height sampler
// unprojects with that constant, and heights and the holo km grid use regional
// units. So build it on a regional-scale projection with the same centre, and
// scale the whole group by 400/80 to HQ units. That fixes horizontal, vertical
// and the km grid in one go.
export const HQ_SCALE = HQ_UNITS_PER_DEG / SCENE_SCALE_UNITS_PER_DEG;
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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a deliberate reset when the bounds go away; terrain otherwise arrives asynchronously
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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a deliberate reset when the bounds go away; the mask otherwise arrives asynchronously
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
