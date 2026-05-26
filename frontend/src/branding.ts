// =============================================================================
// Runtime branding
// =============================================================================
// The demo defaults to OpenDDIL branding. A customer deployment can
// white-label it WITHOUT rebuilding this image: an overlay bundle mounts a
// ConfigMap of branding.json (+ a logo image) into the frontend pod, which
// the nginx `/branding/` location serves. loadBranding() fetches it once at
// startup; if it is absent or malformed, the OpenDDIL defaults stand.
// =============================================================================

/** Forward Operating Base — an OpenDDIL edge's geographic anchor.
 *  The HQ and Regional 3D maps use these as markers and as the projection
 *  center; positionless assets (e.g. strike-only launchers) are placed at
 *  their assigned FOB's coordinates rather than dropped. */
export interface Fob {
  /** Edge identifier this FOB anchors (e.g. "edge-01"). */
  edge_id: string;
  /** Region the FOB rolls up into (e.g. "region-east"). */
  region_id: string;
  /** Geographic anchor (decimal degrees, WGS84). */
  lat: number;
  lon: number;
  /** Human-readable label for the map marker. */
  label?: string;
}

export interface Branding {
  /** Nav-bar text and document.title. */
  title: string;
  /** Logo shown in the nav bar and used as the favicon. '' = none. */
  logo: string;
  /** Optional FOB list — populated by a deployment overlay. The 3D maps
   *  use this to place edge markers and to home positionless assets.
   *  Empty in the OSS default; the maps render an empty theater. */
  fobs: Fob[];
}

const DEFAULT: Branding = { title: 'OpenDDIL DEMO', logo: '', fobs: [] };

let active: Branding = DEFAULT;

/** Current branding. Meaningful only after loadBranding() has resolved. */
export function branding(): Branding {
  return active;
}

function isValidFob(x: unknown): x is Fob {
  if (!x || typeof x !== 'object') return false;
  const f = x as Record<string, unknown>;
  return (
    typeof f.edge_id === 'string' && f.edge_id.length > 0 &&
    typeof f.region_id === 'string' && f.region_id.length > 0 &&
    typeof f.lat === 'number' && Number.isFinite(f.lat) &&
    typeof f.lon === 'number' && Number.isFinite(f.lon)
  );
}

/**
 * Fetch optional overlay branding, then apply document.title and the
 * favicon. Call once before the first render. Any failure (no overlay,
 * 404, bad JSON) leaves the OpenDDIL defaults in place — it never throws.
 */
export async function loadBranding(): Promise<void> {
  try {
    const res = await fetch('/branding/branding.json', { cache: 'no-store' });
    if (res.ok) {
      const j = (await res.json()) as Partial<Branding>;
      active = {
        title: j.title?.trim() || DEFAULT.title,
        logo: j.logo?.trim() || DEFAULT.logo,
        fobs: Array.isArray(j.fobs) ? j.fobs.filter(isValidFob) : DEFAULT.fobs,
      };
    }
  } catch {
    // No overlay branding reachable — keep the OpenDDIL defaults.
  }
  document.title = active.title;
  if (active.logo) {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (link) link.href = active.logo;
  }
}
