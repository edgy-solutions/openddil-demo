// =============================================================================
// sessionDom — shared, non-mock setup for the session-expiry DOM tests
// =============================================================================
// Mounting the REAL Root (the tests go through the real gate in Root, not
// a copy of it) needs a few repeated pieces of
// scaffolding that are plain functions, not vi.mock() registrations, so
// centralizing them carries none of the ESM-hoisting risk that keeps the
// vi.mock(...) calls themselves inlined per test file.
import { __setDeploymentForTest } from '../deployment';
import { __resetMockShapes, __setMockShape } from './mockElectric';
import { __resetSessionExpiryForTest } from '../lib/sessionExpiry';
import { clearShapeError } from '../lib/shapeErrors';

/** Rendered as the leaf identity-strip's callsign once the fleet
 *  shape resolves and the asset-selection effect picks it (the fleet's
 *  only entry). */
export const SENTINEL = 'SENTINEL-FLEET-7731';
const SENTINEL_ASSET_ID = 'dis:1:1:7731';
const SENTINEL_EDGE = 'edge-01';

/** A minimal telemetry_latest_state row. PLATFORM-classified (not a
 *  facility, sensor or munition-candidate variant — see lib/assetClass.ts)
 *  so it survives MaintainerApp's MUNITION filter and reaches the picker. */
export function sentinelFleetRow(): Record<string, unknown> {
  return {
    asset_id: SENTINEL_ASSET_ID,
    platform_variant: 'M1A2-SEPv3',
    callsign: SENTINEL,
    force_id: 'force-blue',
    last_sample_at: new Date().toISOString(),
    schema_revision: 1,
    edge_id: SENTINEL_EDGE,
    region_id: 'region-east',
    kinematics: null,
    originator_nation: null,
    releasable_to: [],
    power_state: null,
    functional_mode: null,
    health_state: null,
    actively_receiving: null,
    actively_transmitting: null,
  };
}

/** A second fleet member for the ?asset= round-trip test — needs at least
 *  two selectable assets to prove a selection CHANGE updates the URL. */
export function secondFleetRow(): Record<string, unknown> {
  return {
    ...sentinelFleetRow(),
    asset_id: 'dis:1:1:7732',
    callsign: 'SENTINEL-FLEET-7732',
  };
}

export function primeSentinelFleet(...rows: Record<string, unknown>[]): void {
  __setMockShape('telemetry_latest_state', {
    data: rows.length > 0 ? rows : [sentinelFleetRow()],
  });
}

/** Demo shell, leaf view, no tier configured — the mount path that
 *  reaches MaintainerApp through Root's real gate (Root.tsx -> DemoShell
 *  -> TierApp(SHELL_LEAF) -> MaintainerApp). */
export function goToDemoLeafPath(search = ''): void {
  __setDeploymentForTest(null);
  window.history.pushState({}, '', `/demo${search}`);
}

/** Between tests: clear the mock shape registry, the session-expiry flag,
 *  the shape-error registry, and restore the default (non-demo) tier
 *  deployment so one test's URL/tier state can't leak into the next. */
export function resetSessionDomState(): void {
  __resetMockShapes();
  __resetSessionExpiryForTest();
  clearShapeError('tactical_events');
  __setDeploymentForTest(undefined);
}
