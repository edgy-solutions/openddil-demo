// =============================================================================
// opStateBackfill — derive an INFERRED severity from operational_state
// =============================================================================
// Extracted from LogisticsStatusCard.tsx so the precedence policy is
// unit-testable without React rendering. Used when fusion-service
// hasn't emitted a logistics_status row yet but the per-asset
// operational_state shows the asset is non-nominal — the SPA surfaces
// the inferred row labelled "(inferred)" so the operator sees the
// signal that's already in the data without claiming a fusion verdict.
//
// Precedence policy (mirrors logistics-fusion-service
// _eval_operational_state per ADR-0026):
//   1. HEALTH_STATE_FAILED  → CRITICAL
//   2. HEALTH_STATE_FAULT   → CRITICAL
//   3. POWER_STATE_OFF      → CRITICAL
//   4. POWER_STATE_SHUTTING_DOWN → CRITICAL
//   5. HEALTH_STATE_DEGRADED  → DEGRADED
//   6. POWER_STATE_MAINTENANCE → DEGRADED
//   7. anything else        → null (no inferred row, asset is nominal-
//                                    or-undetermined)
//
// HealthState wins over PowerState within each severity tier — failed
// health is a more specific claim than powered off.

import type { OperationalState } from '../hooks';

export interface BackfillRow {
  label: string;
  cls: string;
  rationale: string;
}

const CSS_CRITICAL = 'bg-rose-500/20 text-rose-400 border-rose-500/50';
const CSS_DEGRADED = 'bg-amber-500/20 text-amber-400 border-amber-500/50';

export function opStateBackfill(op: OperationalState | null | undefined): BackfillRow | null {
  if (!op) return null;

  if (op.health_state === 'HEALTH_STATE_FAILED' ||
      op.health_state === 'HEALTH_STATE_FAULT') {
    return {
      label: 'CRITICAL (inferred)',
      cls: CSS_CRITICAL,
      rationale: `health_state = ${op.health_state.replace('HEALTH_STATE_', '')} — fusion hasn't produced a verdict yet`,
    };
  }
  if (op.power_state === 'POWER_STATE_OFF' ||
      op.power_state === 'POWER_STATE_SHUTTING_DOWN') {
    return {
      label: 'CRITICAL (inferred)',
      cls: CSS_CRITICAL,
      rationale: `power_state = ${op.power_state.replace('POWER_STATE_', '')} — fusion hasn't produced a verdict yet`,
    };
  }
  if (op.health_state === 'HEALTH_STATE_DEGRADED') {
    return {
      label: 'DEGRADED (inferred)',
      cls: CSS_DEGRADED,
      rationale: "health_state = DEGRADED — fusion hasn't produced a verdict yet",
    };
  }
  if (op.power_state === 'POWER_STATE_MAINTENANCE') {
    return {
      label: 'DEGRADED (inferred)',
      cls: CSS_DEGRADED,
      rationale: "power_state = MAINTENANCE — fusion hasn't produced a verdict yet",
    };
  }
  return null;
}
