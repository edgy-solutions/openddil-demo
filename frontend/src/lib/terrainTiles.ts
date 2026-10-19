// Web-mercator tile maths and Terrarium decoding for the regional terrain.
import type { DeploymentTerrain } from '../deployment';
import type { Bounds } from './terrainBounds';
// Hashed by Vite and emitted under /assets/ (immutable cache in nginx).
import landDefaultUrl from '../assets/terrain/land-10m.json?url';
import lakesDefaultUrl from '../assets/terrain/lakes-10m.json?url';

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

export type Basemap = 'relief' | 'imagery' | 'licensed';
export type ReliefPalette = 'sand' | 'slate';
export interface TerrainCredits { elevation?: string; imagery?: string; patchImagery?: string; land?: string; water?: string }

/** Where terrain tiles come from: the basemap provider, URL templates and the credit lines. */
export interface TerrainSource {
  /** Effective provider after the fallbacks in resolveTerrainSource. */
  basemap: Basemap;
  network: boolean;
  /** Terrarium PNG template. */ elevationUrl: string;
  /** Imagery/licensed base layer template; '' for relief. */ imageryUrl: string;
  /** Close-up patches template; '' = no patches. */ patchImageryUrl: string;
  /** Cap for the base imagery mosaic. */ imageryMaxZoom: number;
  /** Cap for patches. */ patchMaxZoom: number;
  /** Natural Earth land TopoJSON, for the coast mask. */ landUrl: string;
  /** Natural Earth lakes TopoJSON, cut out of the land mask. */ lakesUrl: string;
  /** OSM-derived sea polygons, '' = none. */ waterUrl: string;
  reliefPalette: ReliefPalette;
  /** '' = none. */ credits: Required<TerrainCredits>;
}

/** The packaged defaults: relief basemap, no network, everything under the deployment overlay. */
export const TERRAIN_DEFAULTS: TerrainSource = {
  basemap: 'relief',
  network: false,
  elevationUrl: '/deployment-overlay/terrain/dem/{z}/{x}/{y}.png',
  imageryUrl: '/deployment-overlay/terrain/imagery/{z}/{x}/{y}.jpg',
  patchImageryUrl: '',
  imageryMaxZoom: 14,
  patchMaxZoom: 19,
  landUrl: landDefaultUrl,
  lakesUrl: lakesDefaultUrl,
  waterUrl: '/deployment-overlay/terrain/water.json',
  reliefPalette: 'sand',
  credits: {
    elevation: '',
    imagery: '',
    patchImagery: '',
    land: 'Coastline: Natural Earth',
    water: '',
  },
};

/** Any scheme URL or protocol-relative URL. */
export function isRemoteUrl(u: string): boolean {
  return /^([a-z][a-z0-9+.-]*:)?\/\//i.test(u);
}

const URL_FIELDS = ['elevationUrl', 'imageryUrl', 'patchImageryUrl', 'landUrl', 'lakesUrl', 'waterUrl'] as const;
const warned = new Set<string>();

/** The deployment's terrain block laid over the packaged defaults, field by field.
 *  With `network` off a remote URL is refused (the default applies, warned once per field). */
export function resolveTerrainSource(cfg?: DeploymentTerrain | null): TerrainSource {
  const basemap = cfg?.basemap ?? TERRAIN_DEFAULTS.basemap;
  const network = cfg?.network === true;
  const out: TerrainSource = {
    ...TERRAIN_DEFAULTS,
    basemap,
    network,
    // Per-basemap defaults, for what the config does not set.
    imageryMaxZoom: cfg?.imageryMaxZoom ?? (basemap === 'licensed' ? 19 : 14),
    patchMaxZoom: cfg?.patchMaxZoom ?? TERRAIN_DEFAULTS.patchMaxZoom,
    reliefPalette: cfg?.reliefPalette ?? TERRAIN_DEFAULTS.reliefPalette,
    credits: { ...TERRAIN_DEFAULTS.credits },
  };
  for (const k of URL_FIELDS) {
    const v = cfg?.[k];
    if (v === undefined) continue;
    if (!network && isRemoteUrl(v)) {
      if (!warned.has(k)) { warned.add(k); console.warn(`terrain: ${k} is remote and network is off; using the packaged default`); }
      continue;
    }
    out[k] = v;
    // The packaged coastline's credit does not describe a different file.
    if (k === 'landUrl' || k === 'lakesUrl') out.credits.land = '';
  }
  // A licensed patch layer defaults to the effective base layer.
  if (basemap === 'licensed' && cfg?.patchImageryUrl === undefined) out.patchImageryUrl = out.imageryUrl;
  if (cfg?.credits) {
    for (const k of Object.keys(out.credits) as (keyof TerrainCredits)[]) {
      const v = cfg.credits[k];
      if (typeof v === 'string' && v) out.credits[k] = v;
    }
  }
  if (basemap === 'relief') { out.imageryUrl = ''; out.patchImageryUrl = ''; }
  return out;
}

/** The credit lines for what is on screen, in order, empty and repeated lines dropped. */
export function creditLines(
  src: TerrainSource, use: { style: 'holo' | 'sat'; landMask: boolean; water: boolean },
): string[] {
  const c = src.credits;
  // A source in use with no credit in the config is a config gap; say so once.
  const need = (key: 'elevation' | 'imagery' | 'land' | 'water') => {
    if (c[key] || warned.has(`credit:${key}`)) return;
    warned.add(`credit:${key}`);
    console.warn(`terrain: ${key} is in use with no credit in the deployment config`);
  };
  need('elevation');
  const lines = [c.elevation];
  if (use.style === 'sat' && src.basemap !== 'relief') {
    need('imagery');
    lines.push(c.imagery);
    if (c.patchImagery && src.patchImageryUrl) lines.push(c.patchImagery);
  }
  if (use.landMask) { need('land'); lines.push(c.land); }
  if (use.water) { need('water'); lines.push(c.water); }
  return lines.filter((l, i) => l && lines.indexOf(l) === i);
}
