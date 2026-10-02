// =============================================================================
// applyBranding — the /branding/branding.json overlay
// =============================================================================
// The /branding/ nginx location is deliberately ungated (sign-in needs its
// brand before any session exists), which makes this function the ONLY gate
// between unauthenticated input and the running app's state. It may touch
// title and logo; it must never let fobs/map/tier/liveness ride through —
// that is topology, and topology must only ever arrive via the gated
// /deployment/ path. Most of these cases are negative for exactly that
// reason.
import { describe, it, expect } from 'vitest';
import { applyBranding, DEFAULT_LIVENESS } from '../../deployment';
import type { Deployment } from '../../deployment';

const BASE: Deployment = {
  title: 'OpenDDIL',
  logo: '/openddil.jpg',
  fobs: [{ edge_id: 'edge-01', region_id: 'region-east', lat: 1, lon: 2 }],
  map: { image: '/map.png', bounds: { lat_min: 0, lat_max: 1, lon_min: 0, lon_max: 1 } },
  liveness: DEFAULT_LIVENESS,
  tier: { id: 'edge-01', scope: null, has_children: false, parent: 'region-east' },
  releasedRecordsPanes: [],
};

describe('applyBranding', () => {
  it('overrides title and logo when both are given', () => {
    const out = applyBranding(BASE, { title: 'Customer Co', logo: '/branding/logo.png' });
    expect(out.title).toBe('Customer Co');
    expect(out.logo).toBe('/branding/logo.png');
  });

  it('ignores an empty or whitespace-only title', () => {
    const out = applyBranding(BASE, { title: '   ', logo: '/branding/logo.png' });
    expect(out.title).toBe(BASE.title);
    expect(out.logo).toBe('/branding/logo.png');
  });

  it('returns an unchanged copy for non-object input', () => {
    for (const bad of [null, 'a string', [1, 2, 3]]) {
      const out = applyBranding(BASE, bad);
      expect(out).toEqual(BASE);
      expect(out).not.toBe(BASE); // a copy, not the same reference
    }
  });

  it('never applies fobs, tier, map or liveness from the branding input', () => {
    const malicious = {
      title: 'Customer Co',
      fobs: [{ edge_id: 'evil', region_id: 'evil-region', lat: 99, lon: 99 }],
      tier: { id: 'hq', scope: null, has_children: true, parent: null },
      map: { image: '/evil.png', bounds: { lat_min: -1, lat_max: 1, lon_min: -1, lon_max: 1 } },
      liveness: { stale_after_s: 1, lost_after_s: 2, recovery_samples_n: 1, recovery_window_s: 1 },
    };
    const out = applyBranding(BASE, malicious);
    expect(out.fobs).toEqual(BASE.fobs);
    expect(out.tier).toEqual(BASE.tier);
    expect(out.map).toEqual(BASE.map);
    expect(out.liveness).toEqual(BASE.liveness);
  });

  it('keeps the original logo on a title-only (partial) input', () => {
    const out = applyBranding(BASE, { title: 'Customer Co' });
    expect(out.title).toBe('Customer Co');
    expect(out.logo).toBe(BASE.logo);
  });
});
