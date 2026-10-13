import { describe, expect, it, vi } from 'vitest';

vi.mock('../electric', () => ({
  // Same body as electric.ts parseTextArray (the real module needs a window).
  parseTextArray: (v: unknown) => {
    if (v === null || v === undefined) return null;
    if (Array.isArray(v)) return v.map(String);
    if (typeof v === 'string') return v.replace(/^\{|\}$/g, '').split(',').filter(Boolean);
    return null;
  },
  num: (v: unknown, fallback = 0) => {
    if (v === null || v === undefined || v === '') return fallback;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : fallback;
  },
  sqlLiteral: (v: string) => `'${v.replace(/'/g, "''")}'`,
  useTableShape: () => ({ data: [], isLoading: false, isError: false }),
}));

import { mapPostureTransition } from '../usePostureTransitions';
import { mapEffectorResupply } from '../useEffectorResupply';
import { mapPartsAvailability } from '../usePartsAvailability';

describe('mapPostureTransition', () => {
  it('maps the CloudEvent data, object or JSON string', () => {
    const data = { from: 'emplaced', to: 'march_ordered', at: '2026-10-01T10:00:00Z', motion_since: null,
      motion: 'stationary', deploy_signal: 'f', speed_mps: '1.5', edge_id: 'e1', region_id: 'r1' };
    const a = mapPostureTransition({ id: 'x', subject: 'A1', type: 'openddil.posture.transition', data });
    expect(a).toMatchObject({ subject: 'A1', from: 'emplaced', to: 'march_ordered', motionSince: null,
      deploySignal: false, speedMps: 1.5, edgeId: 'e1' });
    const b = mapPostureTransition({ subject: 'A1', data: JSON.stringify({ ...data, deploy_signal: 't', speed_mps: null }) });
    expect(b.deploySignal).toBe(true);
    expect(b.speedMps).toBeNull();
  });
});

describe('mapEffectorResupply', () => {
  it('coerces string quantity and keeps ids', () => {
    expect(mapEffectorResupply({ event_urn: 'u', launcher_asset_id: 'L', supplier_asset_id: null,
      munition_type: '1.2.3.4.5.6.7', quantity: '3', received_at: '2026-10-01T10:00:00Z', edge_id: 'e', region_id: 'r' }))
      .toMatchObject({ eventUrn: 'u', launcherAssetId: 'L', supplierAssetId: null, quantity: 3, receivedAt: '2026-10-01T10:00:00Z',
        originatorNation: null, releasableTo: null });
  });

  it('carries the label columns; an empty release list stays [] and NULL stays null', () => {
    expect(mapEffectorResupply({ event_urn: 'u', launcher_asset_id: 'L', munition_type: 'm', quantity: 1,
      received_at: 't', originator_nation: 'ATL', releasable_to: '{}' }))
      .toMatchObject({ originatorNation: 'ATL', releasableTo: [] });
    expect(mapEffectorResupply({ event_urn: 'u', launcher_asset_id: 'L', munition_type: 'm', quantity: 1,
      received_at: 't', originator_nation: 'ATL', releasable_to: ['BDR'] }))
      .toMatchObject({ releasableTo: ['BDR'] });
  });
});

describe('mapPartsAvailability', () => {
  it('keeps NULL as null, not zero, and coerces string numbers', () => {
    const r = mapPartsAvailability({ site: 's', part_ref: 'p', on_hand: '0', lead_time_days: null,
      nearest_site_with_stock: null, nearest_on_hand: '4', source: 'x', observed_at: null, updated_at: 't' });
    expect(r.onHand).toBe(0);
    expect(r.leadTimeDays).toBeNull();
    expect(r.nearestOnHand).toBe(4);
    expect(r.nearestSiteWithStock).toBeNull();
  });
});
