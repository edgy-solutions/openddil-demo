// The regional map's terrain controls, remembered per browser.
import { HOLO_DEFAULTS, type HoloOpts } from './holo';

export type TerrainStyle = 'holo' | 'sat';
export const EXAGGERATIONS = [1, 5, 20] as const;
export type Exaggeration = (typeof EXAGGERATIONS)[number];

export interface TerrainPrefs {
  on: boolean;
  style: TerrainStyle;
  exag: Exaggeration;
  holo: HoloOpts;
}

export const TERRAIN_PREFS_KEY = 'openddil.regional.terrain';

export const DEFAULT_TERRAIN_PREFS: TerrainPrefs = { on: true, style: 'holo', exag: 1, holo: HOLO_DEFAULTS };

/** Stored prefs laid over the defaults; anything missing or of the wrong type falls back. Never throws. */
export function loadTerrainPrefs(): TerrainPrefs {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(TERRAIN_PREFS_KEY);
    if (!raw) return DEFAULT_TERRAIN_PREFS;
    const j = JSON.parse(raw) as Partial<Record<keyof TerrainPrefs, unknown>> | null;
    if (!j || typeof j !== 'object') return DEFAULT_TERRAIN_PREFS;
    const holo: Record<string, unknown> = { ...HOLO_DEFAULTS };
    if (j.holo && typeof j.holo === 'object') {
      for (const [k, v] of Object.entries(j.holo as Record<string, unknown>)) {
        if (k in HOLO_DEFAULTS && typeof v === typeof (HOLO_DEFAULTS as Record<string, unknown>)[k]) holo[k] = v;
      }
    }
    return {
      on: typeof j.on === 'boolean' ? j.on : DEFAULT_TERRAIN_PREFS.on,
      style: j.style === 'sat' || j.style === 'holo' ? j.style : DEFAULT_TERRAIN_PREFS.style,
      exag: (EXAGGERATIONS as readonly unknown[]).includes(j.exag) ? (j.exag as Exaggeration) : DEFAULT_TERRAIN_PREFS.exag,
      holo: holo as unknown as HoloOpts,
    };
  } catch {
    return DEFAULT_TERRAIN_PREFS;
  }
}

export function saveTerrainPrefs(p: TerrainPrefs): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(TERRAIN_PREFS_KEY, JSON.stringify(p));
  } catch {
    // Storage blocked or full: the controls still work, they just don't persist.
  }
}
