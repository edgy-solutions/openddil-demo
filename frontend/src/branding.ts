// =============================================================================
// Runtime branding
// =============================================================================
// The demo defaults to OpenDDIL branding. A customer deployment can
// white-label it WITHOUT rebuilding this image: an overlay bundle mounts a
// ConfigMap of branding.json (+ a logo image) into the frontend pod, which
// the nginx `/branding/` location serves. loadBranding() fetches it once at
// startup; if it is absent or malformed, the OpenDDIL defaults stand.
// =============================================================================

export interface Branding {
  /** Nav-bar text and document.title. */
  title: string;
  /** Logo shown in the nav bar and used as the favicon. '' = none. */
  logo: string;
}

const DEFAULT: Branding = { title: 'OpenDDIL DEMO', logo: '' };

let active: Branding = DEFAULT;

/** Current branding. Meaningful only after loadBranding() has resolved. */
export function branding(): Branding {
  return active;
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
