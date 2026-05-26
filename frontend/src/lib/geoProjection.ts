// =============================================================================
// Geographic projection for the 3D maps
// =============================================================================
// The HQ and Regional 3D scenes use abstract Three.js coordinates (units of
// "scene length," not metres or degrees). To place real assets and FOBs on
// the canvas we need a deterministic lat/lon -> (x, z) projection.
//
// At demo scale (single regional-sized bbox), a local tangent-plane (linear)
// projection is fine — distortion is well under 1% over a few hundred km.
// Proper Web Mercator / UTM is deferred until a deployment needs theater-
// scale geometry; this module is the swap-in point when that lands.
//
// The center comes from the deployment's FOB centroid so a regional overlay
// gets a regional-centered projection automatically — no per-component
// constants need re-tuning when the FOB list moves.
// =============================================================================
import type { Fob } from '../deployment';

export interface Projection {
  /** Project (lat, lon) -> (x, z) in scene units. */
  project: (lat: number, lon: number) => [number, number];
  /** Geographic center of the projection (also the (0, 0) scene point). */
  center: { lat: number; lon: number };
}

/**
 * Build a local tangent-plane projection centered on the FOB centroid.
 *
 * `scaleUnitsPerDegLat` picks how many scene units one degree of latitude
 * maps to. The Regional and HQ scenes have different coordinate scales —
 * each component picks its own value so its FOBs+assets fill the canvas.
 *
 * Empty fobs collapses to a (0,0)-centered identity-ish projection, which
 * is harmless on an OSS-default install with no overlay FOBs (the scene
 * just renders without anchors).
 */
export function makeProjection(
  fobs: Fob[],
  scaleUnitsPerDegLat: number,
): Projection {
  const center = fobs.length === 0
    ? { lat: 0, lon: 0 }
    : {
        lat: fobs.reduce((s, f) => s + f.lat, 0) / fobs.length,
        lon: fobs.reduce((s, f) => s + f.lon, 0) / fobs.length,
      };
  // Longitude degrees shrink with latitude — multiply by cos(centerLat)
  // so x and z stay isotropic at the projection center. (Without this,
  // a small bbox at 52°N would render as a north-south stretched rectangle.)
  const cosLat = Math.cos((center.lat * Math.PI) / 180);

  function project(lat: number, lon: number): [number, number] {
    // Three.js convention used by the existing scenes: +x is east, -z is
    // north (camera looks from +z toward origin). z is therefore
    // negated relative to latitude delta.
    const x = (lon - center.lon) * scaleUnitsPerDegLat * cosLat;
    const z = -(lat - center.lat) * scaleUnitsPerDegLat;
    return [x, z];
  }

  return { project, center };
}
