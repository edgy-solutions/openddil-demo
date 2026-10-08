import { describe, it, expect } from 'vitest';
import { launchesByMunition, launchFor, dedupFirings, type DedupCandidate } from '../munitionAsset';
import { isDeclaredSensor, SENSOR_SUBSYSTEM } from '../assetSubsystem';

// The same join the fleet hooks call: launcher and event come from the launch
// row, never from the munition's asset_id.
function attribute(assetId: string, variant: string, launches: ReturnType<typeof launchesByMunition>): DedupCandidate {
  return { asset_id: assetId, platform_variant: variant, ...launchFor(assetId, launches) };
}

describe('launchesByMunition', () => {
  it('skips rows with no munition_asset_id', () => {
    const m = launchesByMunition([
      { munition_asset_id: null, launcher_asset_id: 'L1', event_urn: 'u1' },
      { munition_asset_id: 'm1', launcher_asset_id: 'L1', event_urn: 'u2' },
    ]);
    expect([...m.keys()]).toEqual(['m1']);
  });

  it('a munition id embedding "-<launcher>" with no launch row has no launcher', () => {
    const m = launchesByMunition([]);
    const c = attribute('prop:T_10-L1', 'X_Interceptor', m);
    expect(c.parent_launcher_id).toBeNull();
    expect(c.firing_event_urn).toBeNull();
  });

  it('a munition with a launch row gets that row launcher and event_urn', () => {
    const m = launchesByMunition([
      { munition_asset_id: 'opaque-1', launcher_asset_id: 'L9', event_urn: 'urn:fire:1' },
    ]);
    const c = attribute('opaque-1', 'X_Interceptor', m);
    expect(c.parent_launcher_id).toBe('L9');
    expect(c.firing_event_urn).toBe('urn:fire:1');
  });
});

describe('dedupFirings', () => {
  it('collapses rows only when they share a launcher and launch event', () => {
    const rows: DedupCandidate[] = [
      { asset_id: 'a-seeker', platform_variant: 'ML', parent_launcher_id: 'L1', firing_event_urn: 'u1' },
      { asset_id: 'a', platform_variant: 'X_Interceptor', parent_launcher_id: 'L1', firing_event_urn: 'u1' },
    ];
    const out = dedupFirings(rows);
    expect(out).toHaveLength(1);
    expect(out[0].asset_id).toBe('a');
  });

  it('keeps distinct munition ids with distinct launch rows, and unlaunched rows as themselves', () => {
    const m = launchesByMunition([
      { munition_asset_id: 'm1', launcher_asset_id: 'L1', event_urn: 'u1' },
      { munition_asset_id: 'm2', launcher_asset_id: 'L1', event_urn: 'u2' },
    ]);
    const rows = [
      attribute('m1', 'X_Interceptor', m),
      attribute('m2', 'X_Interceptor', m),
      attribute('m3', 'ML', m),
    ];
    expect(dedupFirings(rows)).toHaveLength(3);
  });
});

describe('isDeclaredSensor', () => {
  it('is true only for the declared sensor subsystem', () => {
    expect(isDeclaredSensor(SENSOR_SUBSYSTEM)).toBe(true);
    expect(isDeclaredSensor(null)).toBe(false);
    expect(isDeclaredSensor(undefined)).toBe(false);
  });

  it('does not treat a _Sensor-suffixed id with null subsystem as a sensor', () => {
    const row = { asset_id: 'prop:site_MRAD_Sensor', subsystem: null };
    expect(isDeclaredSensor(row.subsystem)).toBe(false);
  });
});
