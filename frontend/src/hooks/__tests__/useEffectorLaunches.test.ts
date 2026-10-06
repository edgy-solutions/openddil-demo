// mapEffectorLaunch -- row-mapping unit test, same shape as the hook's own
// reasoning comments (Electric's string-numeric / 't'/'f' boolean coercion).
//
// electric.ts touches `window` at module scope, not available under this
// project's Node (non-jsdom) vitest environment -- mocked here for that
// reason alone, same precedent as Header.test.tsx mocking '../../hooks'.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../electric', () => ({
  num: (v: unknown, fallback = 0) => {
    if (v === null || v === undefined || v === '') return fallback;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : fallback;
  },
  sqlLiteral: (v: string) => `'${v.replace(/'/g, "''")}'`,
  useTableShape: () => ({ data: [], isLoading: false, isError: false }),
}));

import { mapEffectorLaunch } from '../useEffectorLaunches';

describe('mapEffectorLaunch', () => {
  it('maps a full in-flight row (Electric string-numeric + null terminal fields)', () => {
    const row = {
      event_urn: 'dis-event:1:1:42',
      launcher_asset_id: 'dis:1:1:4773',
      munition_type: '2.1.1.2.3.1.0',
      quantity: '1',
      target_asset_id: null,
      launched_at: '2026-10-06T12:00:00Z',
      terminal_state: null,
      detonation_result: null,
      terminated_at: null,
      late_terminal: 'f',
      edge_id: 'edge-01',
      region_id: 'region-east',
      originator_nation: 'USA',
      releasable_to: ['USA', 'GBR'],
    };

    expect(mapEffectorLaunch(row)).toEqual({
      eventUrn: 'dis-event:1:1:42',
      munitionType: '2.1.1.2.3.1.0',
      quantity: 1,
      targetAssetId: null,
      launchedAt: '2026-10-06T12:00:00Z',
      terminalState: null,
      detonationResult: null,
      terminatedAt: null,
      lateTerminal: false,
    });
  });

  it('maps a resolved, late row', () => {
    const row = {
      event_urn: 'dis-event:1:1:43',
      munition_type: '2.1.1.2.3.1.0',
      quantity: '2',
      target_asset_id: 'dis:1:1:9001',
      launched_at: '2026-10-06T12:00:00Z',
      terminal_state: 'entity_impact',
      detonation_result: '1',
      terminated_at: '2026-10-06T12:05:00Z',
      late_terminal: true,
    };

    const mapped = mapEffectorLaunch(row);
    expect(mapped.quantity).toBe(2);
    expect(mapped.targetAssetId).toBe('dis:1:1:9001');
    expect(mapped.terminalState).toBe('entity_impact');
    expect(mapped.detonationResult).toBe(1);
    expect(mapped.terminatedAt).toBe('2026-10-06T12:05:00Z');
    expect(mapped.lateTerminal).toBe(true);
  });
});
