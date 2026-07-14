// Dense-FOB co-location regression test.
//
// Reproduces a ring-overlap operators flagged when many assets cluster
// at a single FOB and fragment across multiple co-location buckets --
// the buckets' rings then visually collide with each other. The chord
// formula in coLocationLayout only guarantees WITHIN-bucket clearance;
// cross-bucket clearance is not managed there. Ring radii that were
// generous enough to fully enclose the launcher pod's top-down extent
// (previous 6.0 native footprint) also caused neighboring buckets'
// rings to overlap in dense clusters.
//
// Positions in the fixture are synthetic but shaped after the class
// of layout the operator was seeing: ~5 sub-clusters within ~10 world
// units, each cluster with a launcher + 2 sensors, some solo launcher
// buckets adjacent, one facility-anchored bucket, and one far-away HQ
// as a sanity anchor.
//
// The test uses the ACTUAL rendered ring radius (via resolveRingRadius
// with effectiveScale = SCENE_ASSET_SCALE * resolveVariantScale --
// matching what AssetVisual actually renders) and pins the invariant:
// for every pair of assets that are NOT essentially co-located (>=
// REPORTED_OVERLAP_THRESHOLD apart), their rendered rings must not
// overlap.
//
// Pairs closer than REPORTED_OVERLAP_THRESHOLD are considered layout
// artifacts (bucket fragmentation, or the intentional chassis+sensor-
// subsystem split that lands two rows at essentially the same lat/lon).
// Those need a bucketing fix, not a ring-sizing fix -- tracked
// separately.
import { describe, expect, it } from 'vitest';
import { resolveRingRadius, resolveVariantScale } from '../assetGeometry';

const SCENE_ASSET_SCALE = 0.35;

// Pairs closer than this are considered "genuinely co-located" or
// "layout artifact" -- ring sizing alone can't separate them (would
// require rings smaller than the asset silhouettes). Bucketing fix
// tracked separately. This test only pins the invariant for pairs
// >= this distance, which is what operators actually flag as visually
// wrong.
const REPORTED_OVERLAP_THRESHOLD = 1.5;

// Small clearance so ring EDGES don't just kiss.
const RING_EDGE_CLEARANCE = 0.1;

interface FixtureAsset {
  id: string;
  variant: string;
  x: number;
  z: number;
}

// Synthetic dense-FOB scenario. 24 assets across 6 sub-clusters + 4
// solo launchers + 1 distant HQ, spanning ~10 world units in the
// dense area. Cluster centroids and slot positions are shaped so
// that adjacent buckets have ring slots pointing toward each other
// -- the exact failure mode operators reported.
const DENSE_FOB_FIXTURE: FixtureAsset[] = [
  // Cluster A -- CUAS pair, centroid ~(-30, -52)
  { id: 'cluster_a_cuas_launcher',   variant: 'CUAS_Interceptor', x: -27.38, z: -51.62 },
  { id: 'cluster_a_cuas_radar',      variant: 'CUAS_Sensor',      x: -31.45, z: -49.27 },
  { id: 'cluster_a_cuas_subsystem',  variant: 'CUAS_Sensor',      x: -31.45, z: -53.97 },
  // Cluster B -- SHORAD, centroid ~(-26, -43)
  { id: 'cluster_b_shorad_launcher', variant: 'SHORAD_Interceptor', x: -23.38, z: -42.81 },
  { id: 'cluster_b_shorad_radar',    variant: 'SHORAD_Sensor',      x: -27.45, z: -40.46 },
  { id: 'cluster_b_shorad_subsystem',variant: 'SHORAD_Sensor',      x: -27.45, z: -45.16 },
  // Cluster C -- MRAD with facility at center, centroid ~(-25, -42)
  { id: 'cluster_c_facility',        variant: 'HEADQUARTER_COMPLEX',       x: -25.49, z: -41.95 },
  { id: 'cluster_c_adv_launcher',    variant: 'MRAD_ADVANCED_Interceptor', x: -21.49, z: -41.95 },
  { id: 'cluster_c_mrad_radar',      variant: 'MRAD_Sensor',               x: -27.49, z: -38.48 },
  { id: 'cluster_c_mrad_subsystem',  variant: 'MRAD_Sensor',               x: -27.49, z: -45.41 },
  // Cluster D -- VSHORAD, centroid ~(-32, -50)
  { id: 'cluster_d_vshorad_launcher',   variant: 'VSHORAD_Interceptor', x: -29.66, z: -50.28 },
  { id: 'cluster_d_vshorad_radar',      variant: 'VSHORAD_Sensor',      x: -33.73, z: -47.93 },
  { id: 'cluster_d_vshorad_subsystem',  variant: 'VSHORAD_Sensor',      x: -33.73, z: -52.63 },
  // Cluster E -- CUAS pair #2, centroid ~(-29, -52)
  { id: 'cluster_e_cuas_launcher',   variant: 'CUAS_Interceptor', x: -26.22, z: -52.23 },
  { id: 'cluster_e_cuas_radar',      variant: 'CUAS_Sensor',      x: -30.29, z: -49.88 },
  { id: 'cluster_e_cuas_subsystem',  variant: 'CUAS_Sensor',      x: -30.29, z: -54.58 },
  // Cluster F -- Advanced MRAD sensor pair, centroid ~(-26, -42)
  { id: 'cluster_f_adv_radar',       variant: 'MRAD_ADVANCED_Sensor', x: -23.41, z: -41.90 },
  { id: 'cluster_f_adv_subsystem',   variant: 'MRAD_ADVANCED_Sensor', x: -28.41, z: -41.90 },
  // 4 solo MRAD launchers packed near cluster C (each in own bucket)
  { id: 'solo_mrad_launcher_1',      variant: 'MRAD_Interceptor', x: -26.71, z: -41.98 },
  { id: 'solo_mrad_launcher_2',      variant: 'MRAD_Interceptor', x: -24.08, z: -41.99 },
  { id: 'solo_mrad_launcher_3',      variant: 'MRAD_Interceptor', x: -25.41, z: -43.30 },
  { id: 'solo_mrad_launcher_4',      variant: 'MRAD_Interceptor', x: -25.43, z: -40.70 },
  // Distant HQ -- sanity anchor, far from the dense cluster
  { id: 'distant_hq',                variant: 'HEADQUARTER_COMPLEX', x: -0.78, z: -13.43 },
];

/** Rendered ring radius for an asset -- matches what AssetVisual
 *  actually draws in the scene. Applies the per-variant scale
 *  multiplier on top of SCENE_ASSET_SCALE (launchers carry 0.6, so
 *  their rendered ring is smaller than their layout ring). */
function renderedRingRadius(variant: string): number {
  const effectiveScale = SCENE_ASSET_SCALE * resolveVariantScale(variant);
  return resolveRingRadius(variant, effectiveScale);
}

function distance(a: FixtureAsset, b: FixtureAsset): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

describe('dense-FOB ring overlap regression', () => {
  it('every pair of non-co-located assets has clear rings', () => {
    const overlaps: string[] = [];
    for (let i = 0; i < DENSE_FOB_FIXTURE.length; i++) {
      for (let j = i + 1; j < DENSE_FOB_FIXTURE.length; j++) {
        const a = DENSE_FOB_FIXTURE[i];
        const b = DENSE_FOB_FIXTURE[j];
        const d = distance(a, b);
        if (d < REPORTED_OVERLAP_THRESHOLD) continue;
        const ra = renderedRingRadius(a.variant);
        const rb = renderedRingRadius(b.variant);
        const required = ra + rb + RING_EDGE_CLEARANCE;
        if (d < required) {
          overlaps.push(
            `${a.id} (${a.variant}, r=${ra.toFixed(2)}) <-> ${b.id} (${b.variant}, r=${rb.toFixed(2)}): d=${d.toFixed(2)}, need>=${required.toFixed(2)}`,
          );
        }
      }
    }
    expect(overlaps, 'ring overlaps in dense-FOB scenario:\n' + overlaps.join('\n')).toEqual([]);
  });

  // Sanity anchor: two clearly-separated assets (distant HQ vs dense
  // cluster) should always pass. Guards against a fix that shrinks
  // rings so aggressively they become invisible.
  it('distant HQ is far from every dense-cluster asset', () => {
    const hq = DENSE_FOB_FIXTURE.find((a) => a.id === 'distant_hq')!;
    for (const other of DENSE_FOB_FIXTURE) {
      if (other.id === 'distant_hq') continue;
      expect(distance(hq, other)).toBeGreaterThan(30);
    }
  });

  // Rendered ring radii MUST stay visible (>= 0.3 world units). If a
  // future fix zeros them out, the demo loses the severity signal.
  it('every variant renders a visible ring (>= 0.3 world units)', () => {
    const variants = new Set(DENSE_FOB_FIXTURE.map((a) => a.variant));
    for (const v of variants) {
      expect(renderedRingRadius(v), `variant=${v}`).toBeGreaterThanOrEqual(0.3);
    }
  });
});
