// Pin the inferred-severity precedence policy for LogisticsStatusCard's
// backfill row. Same enum-name regression risk as ringColor — if
// someone "tidies" HEALTH_STATE_FAILED to HEALTH_STATE_FAILURE the
// backfill silently stops firing for the worst class of asset state.
//
// Policy precedence:
//   HEALTH_FAILED > HEALTH_FAULT > POWER_OFF > POWER_SHUTTING_DOWN >
//   HEALTH_DEGRADED > POWER_MAINTENANCE > null (no inferred row)
import { describe, expect, it } from 'vitest';
import { opStateBackfill } from '../opStateBackfill';
import type { OperationalState } from '../../hooks';

function opState(overrides: Partial<OperationalState> = {}): OperationalState {
  return {
    power_state: null,
    functional_mode: null,
    health_state: null,
    actively_receiving: null,
    actively_transmitting: null,
    ...overrides,
  };
}

describe('opStateBackfill — CRITICAL tier (HealthState beats PowerState)', () => {
  it('HEALTH_STATE_FAILED -> CRITICAL (inferred)', () => {
    const r = opStateBackfill(opState({ health_state: 'HEALTH_STATE_FAILED' }));
    expect(r?.label).toBe('CRITICAL (inferred)');
    expect(r?.cls).toContain('rose');
    expect(r?.rationale).toContain('health_state = FAILED');
  });
  it('HEALTH_STATE_FAULT -> CRITICAL (inferred)', () => {
    const r = opStateBackfill(opState({ health_state: 'HEALTH_STATE_FAULT' }));
    expect(r?.label).toBe('CRITICAL (inferred)');
    expect(r?.rationale).toContain('health_state = FAULT');
  });
  it('POWER_STATE_OFF -> CRITICAL (inferred)', () => {
    const r = opStateBackfill(opState({ power_state: 'POWER_STATE_OFF' }));
    expect(r?.label).toBe('CRITICAL (inferred)');
    expect(r?.cls).toContain('rose');
    expect(r?.rationale).toContain('power_state = OFF');
  });
  it('POWER_STATE_SHUTTING_DOWN -> CRITICAL (inferred)', () => {
    const r = opStateBackfill(opState({ power_state: 'POWER_STATE_SHUTTING_DOWN' }));
    expect(r?.label).toBe('CRITICAL (inferred)');
    expect(r?.rationale).toContain('power_state = SHUTTING_DOWN');
  });
});

describe('opStateBackfill — DEGRADED tier', () => {
  it('HEALTH_STATE_DEGRADED -> DEGRADED (inferred)', () => {
    const r = opStateBackfill(opState({ health_state: 'HEALTH_STATE_DEGRADED' }));
    expect(r?.label).toBe('DEGRADED (inferred)');
    expect(r?.cls).toContain('amber');
    expect(r?.rationale).toContain('DEGRADED');
  });
  it('POWER_STATE_MAINTENANCE -> DEGRADED (inferred)', () => {
    const r = opStateBackfill(opState({ power_state: 'POWER_STATE_MAINTENANCE' }));
    expect(r?.label).toBe('DEGRADED (inferred)');
    expect(r?.cls).toContain('amber');
    expect(r?.rationale).toContain('MAINTENANCE');
  });
});

describe('opStateBackfill — precedence when multiple axes fire', () => {
  // CRITICAL must always beat DEGRADED. HealthState beats PowerState
  // within each tier. These pin the if/else order in opStateBackfill —
  // a refactor that reorders the branches silently changes which
  // axis surfaces as the rationale.
  it('HEALTH_FAILED beats POWER_OFF (both CRITICAL, health wins)', () => {
    const r = opStateBackfill(opState({
      health_state: 'HEALTH_STATE_FAILED',
      power_state:  'POWER_STATE_OFF',
    }));
    expect(r?.rationale).toContain('health_state = FAILED');
    expect(r?.rationale).not.toContain('power_state');
  });
  it('HEALTH_FAULT beats POWER_OFF', () => {
    const r = opStateBackfill(opState({
      health_state: 'HEALTH_STATE_FAULT',
      power_state:  'POWER_STATE_OFF',
    }));
    expect(r?.rationale).toContain('health_state = FAULT');
  });
  it('POWER_OFF beats HEALTH_DEGRADED (CRITICAL beats DEGRADED tier)', () => {
    const r = opStateBackfill(opState({
      power_state:  'POWER_STATE_OFF',
      health_state: 'HEALTH_STATE_DEGRADED',
    }));
    expect(r?.label).toBe('CRITICAL (inferred)');
    expect(r?.rationale).toContain('power_state = OFF');
  });
  it('HEALTH_DEGRADED beats POWER_MAINTENANCE (both DEGRADED, health wins)', () => {
    const r = opStateBackfill(opState({
      health_state: 'HEALTH_STATE_DEGRADED',
      power_state:  'POWER_STATE_MAINTENANCE',
    }));
    expect(r?.rationale).toContain('health_state = DEGRADED');
  });
});

describe('opStateBackfill — null and nominal paths produce no row', () => {
  it('null op_state -> null', () => {
    expect(opStateBackfill(null)).toBeNull();
  });
  it('undefined op_state -> null', () => {
    expect(opStateBackfill(undefined)).toBeNull();
  });
  it('all-null axes -> null (nothing to infer)', () => {
    expect(opStateBackfill(opState())).toBeNull();
  });
  it('healthy POWER_STATE_ON + HEALTH_STATE_NOMINAL -> null (no inferred row)', () => {
    expect(opStateBackfill(opState({
      power_state:  'POWER_STATE_ON',
      health_state: 'HEALTH_STATE_NOMINAL',
    }))).toBeNull();
  });
  it('POWER_STATE_STANDBY -> null (informational, not a fault)', () => {
    expect(opStateBackfill(opState({ power_state: 'POWER_STATE_STANDBY' }))).toBeNull();
  });
  it('FunctionalMode alone -> null (FunctionalMode is informational only)', () => {
    expect(opStateBackfill(opState({
      functional_mode: 'FUNCTIONAL_MODE_ACTIVE',
    }))).toBeNull();
  });
});

describe('opStateBackfill — wrong enum names fall through to null', () => {
  // Same regression class as the operationalStatePills enum-name bug.
  // If someone reintroduces 'HEALTH_STATE_OK' (proto says NOMINAL) or
  // 'POWER_STATE_OPERATE' (proto says ON), they should NOT match any
  // backfill case — and the operator stops seeing inferred rows for
  // those legitimately-healthy-looking assets.
  it('HEALTH_STATE_OK (wrong proto name) -> null', () => {
    expect(opStateBackfill(opState({ health_state: 'HEALTH_STATE_OK' }))).toBeNull();
  });
  it('POWER_STATE_OPERATE (wrong proto name) -> null', () => {
    expect(opStateBackfill(opState({ power_state: 'POWER_STATE_OPERATE' }))).toBeNull();
  });
});
