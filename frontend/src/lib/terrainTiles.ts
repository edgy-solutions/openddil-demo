// Web-mercator tile maths and Terrarium decoding for the regional terrain.
import type { Bounds } from './terrainBounds';

/** Largest mosaic edge, px: the canvas and texture size limit. */
export const MAX_PX = 4096;

export function lonToTileX(lon: number, z: number): number {
  return ((lon + 180) / 360) * 2 ** z;
}
export function latToTileY(lat: number, z: number): number {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}
/** Terrarium PNG pixel to metres. */
export function decodeTerrarium(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

/** Highest zoom, up to `max`, whose cropped mosaic of `b` fits in MAX_PX square. */
export function fitZoom(b: Bounds, max: number): number {
  let z = max;
  while (z > 0) {
    const w = (lonToTileX(b.east, z) - lonToTileX(b.west, z)) * 256;
    const h = (latToTileY(b.south, z) - latToTileY(b.north, z)) * 256;
    if (w <= MAX_PX && h <= MAX_PX) break;
    z--;
  }
  return z;
}

/** Fill a `{z}/{x}/{y}` tile URL template. */
export function tileUrl(template: string, z: number, x: number, y: number): string {
  return template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
}

/** Where terrain tiles come from: URL templates and the credit line to show. */
export interface TerrainSource { elevationUrl: string; imageryUrl: string; attribution: string;
  /** Natural Earth land TopoJSON, for the HQ coast mask. */ landUrl: string }

export const DEFAULT_TERRAIN_SOURCE: TerrainSource = {
  elevationUrl: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
  imageryUrl: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  attribution: 'Imagery © Esri, Maxar, Earthstar Geographics · Elevation: Terrain Tiles (AWS / Mapzen)',
  landUrl: 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/land-10m.json',
};

/** The deployment's terrain block laid over the public defaults, field by field. */
export function resolveTerrainSource(cfg?: Partial<TerrainSource> | null): TerrainSource {
  return {
    elevationUrl: cfg?.elevationUrl || DEFAULT_TERRAIN_SOURCE.elevationUrl,
    imageryUrl: cfg?.imageryUrl || DEFAULT_TERRAIN_SOURCE.imageryUrl,
    attribution: cfg?.attribution || DEFAULT_TERRAIN_SOURCE.attribution,
    landUrl: cfg?.landUrl || DEFAULT_TERRAIN_SOURCE.landUrl,
  };
}

/** The elevation half of an attribution string (the part after the last "·"), for the holo style that shows no imagery. */
export function elevationCredit(attribution: string): string {
  const i = attribution.lastIndexOf('·');
  return i < 0 ? attribution : attribution.slice(i + 1).trim();
}
