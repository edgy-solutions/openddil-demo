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
 * just renders without anchors). When `fallbackPoints` is given and there
 * are no FOBs, the centre is the mean of those points instead, so live
 * assets still land on screen.
 */
export function makeProjection(
  fobs: Fob[],
  scaleUnitsPerDegLat: number,
  fallbackPoints?: { lat: number; lon: number }[],
): Projection {
  const pts = fobs.length === 0 && fallbackPoints && fallbackPoints.length > 0
    ? fallbackPoints
    : null;
  const center = pts
    ? {
        lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length,
        lon: pts.reduce((s, p) => s + p.lon, 0) / pts.length,
      }
    : fobs.length === 0
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

const WGS84_A = 6378137;
const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);

/**
 * Convert an ECEF position (metres) to geodetic lat/lon in degrees.
 * Height is discarded. Iterative; converges well below 1e-9 deg.
 * Returns null for non-finite input or a point within 1 km of the Earth's
 * centre, where the conversion is meaningless.
 */
export function ecefToWgs84(
  x: number,
  y: number,
  z: number,
): { lat: number; lon: number } | null {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  if (Math.hypot(x, y, z) < 1000) return null;
  const p = Math.hypot(x, y);
  const lon = Math.atan2(y, x);
  let lat = Math.atan2(z, p * (1 - WGS84_E2));
  for (let i = 0; i < 10; i++) {
    const s = Math.sin(lat);
    const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * s * s);
    const next = Math.atan2(z + WGS84_E2 * n * s, p);
    const done = Math.abs(next - lat) < 1e-14;
    lat = next;
    if (done) break;
  }
  return { lat: (lat * 180) / Math.PI, lon: (lon * 180) / Math.PI };
}
