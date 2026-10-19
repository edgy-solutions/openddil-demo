// @vitest-environment jsdom
// buildRenderables: friendly assets bucket by edge; opposing and neutral tracks never join an edge bucket.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../hooks', () => ({}));
import { buildRenderables } from '../RegionalSustainmentPosture';
import type { FleetAsset } from '../../../hooks';
import type { Projection } from '../../../lib/geoProjection';

const proj: Projection = { project: (lat, lon) => [lon * 10, lat * 10], center: { lat: 0, lon: 0 } };
const asset = (id: string, lat: number, lon: number, force: string | null, edge: string | null) => ({
  asset_id: id, platform_variant: null, subsystem: null, callsign: null, force_id: force,
  last_sample_at: null, reporting_status: null, reporting_status_at: null, schema_revision: 1,
  edge_id: edge, region_id: null, position: { lat, lon }, operational_state: {},
}) as unknown as FleetAsset;

describe('buildRenderables bucketing', () => {
  it('keeps opposing and neutral tracks out of the edge bucket', () => {
    const fleet = [
      asset('f1', 10, 20, 'FORCE_FRIENDLY', 'edge-a'),
      asset('f2', 10.5, 20.5, 'FORCE_FRIENDLY', 'edge-a'),
      asset('o1', 10, 20, 'FORCE_OPPOSING', 'edge-a'),
      asset('n1', 10, 20, 'FORCE_NEUTRAL', 'edge-a'),
    ];
    const { clusters } = buildRenderables(fleet, [], [], proj, new Map(), () => 0);
    const edge = clusters.find((c) => c.key === 'edge:edge-a');
    expect(edge?.members.map((m) => m.asset_id).sort()).toEqual(['f1', 'f2']);
    const others = clusters.filter((c) => c.key !== 'edge:edge-a').flatMap((c) => c.members.map((m) => m.asset_id));
    expect(others.sort()).toEqual(['n1', 'o1']);
  });
});
