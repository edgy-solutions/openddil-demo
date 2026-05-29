// =============================================================================
// operationalStatePills — pure proto-enum → pill mapping (Phase 5, ADR-0026)
// =============================================================================
// Extracted from GroundDiagnosticsCard.tsx so the enum-string → pill-color
// mapping is unit-testable without React rendering. The mapping IS the
// load-bearing contract here — earlier this code shipped with
// 'POWER_STATE_OPERATE' and 'HEALTH_STATE_OK' switch cases that DON'T
// EXIST in the proto, silently rendering every healthy sensor as the
// '—' fallback pill. Tests in __tests__/operationalStatePills.test.ts
// pin every enum name against the proto so that regression can't recur.
//
// Keep this file in sync with openddil-contracts proto/openddil/telemetry/
// v1/telemetry.proto — specifically the PowerState / FunctionalMode /
// HealthState enums on the OperationalState message. New enum values
// added there need entries here OR they fall through to the '—' fallback
// (acceptable but unhelpful — explicit cases beat implicit fallback).

/** Tailwind class strings for the colored pill badges. Kept as constants
 *  so the same color family applies across all three axes consistently. */
export const PILL_OK    = 'bg-emerald-500/20 text-emerald-400 border-emerald-500/50';
export const PILL_AMBER = 'bg-amber-500/20 text-amber-400 border-amber-500/50';
export const PILL_RED   = 'bg-rose-500/20 text-rose-400 border-rose-500/50';
export const PILL_CYAN  = 'bg-cyan-500/20 text-cyan-400 border-cyan-500/50';
export const PILL_SLATE = 'bg-slate-700/40 text-slate-400 border-slate-600';

export interface Pill {
  label: string;
  cls: string;
}

/** POWER_STATE_* enum names → Pill. Values match the proto's enum names
 *  EXACTLY (POWER_STATE_ON not POWER_STATE_OPERATE; that exact mismatch
 *  shipped at one point and silently broke the happy-path pill).
 *
 *  Semantics:
 *    OFF / SHUTTING_DOWN  -> red    "entity not running or going down"
 *    MAINTENANCE          -> amber  "planned offline state"
 *    STANDBY              -> slate  "initialized, no claim of activity"
 *    ON                   -> green  "powered up and running"
 *    UNSPECIFIED / null   -> '—'    "no claim from this producer" */
export function powerPill(value: string | null): Pill {
  switch (value) {
    case 'POWER_STATE_OFF':           return { label: 'OFF',          cls: PILL_RED };
    case 'POWER_STATE_SHUTTING_DOWN': return { label: 'SHUTTING DOWN',cls: PILL_RED };
    case 'POWER_STATE_MAINTENANCE':   return { label: 'MAINTENANCE',  cls: PILL_AMBER };
    case 'POWER_STATE_STANDBY':       return { label: 'STANDBY',      cls: PILL_SLATE };
    case 'POWER_STATE_ON':            return { label: 'ON',           cls: PILL_OK };
    default:                          return { label: '—',            cls: PILL_SLATE };
  }
}

/** FUNCTIONAL_MODE_* enum names → Pill. FunctionalMode is informational
 *  (per ADR-0026 it does NOT drive severity), so these colors are about
 *  signaling the operator posture, not about marking faults. */
export function modePill(value: string | null): Pill {
  switch (value) {
    case 'FUNCTIONAL_MODE_IDLE':          return { label: 'IDLE',          cls: PILL_SLATE };
    case 'FUNCTIONAL_MODE_ACTIVE':        return { label: 'ACTIVE',        cls: PILL_OK };
    case 'FUNCTIONAL_MODE_RECEIVE_ONLY':  return { label: 'RECEIVE ONLY',  cls: PILL_CYAN };
    case 'FUNCTIONAL_MODE_TRANSMIT_ONLY': return { label: 'TRANSMIT ONLY', cls: PILL_CYAN };
    case 'FUNCTIONAL_MODE_SCAN':          return { label: 'SCAN',          cls: PILL_OK };
    case 'FUNCTIONAL_MODE_TRACK':         return { label: 'TRACK',         cls: PILL_OK };
    default:                              return { label: '—',             cls: PILL_SLATE };
  }
}

/** HEALTH_STATE_* enum names → Pill. Maps directly to severity semantics:
 *  NOMINAL = OK; DEGRADED = amber; FAULT/FAILED = red. Match the proto
 *  enum names — HEALTH_STATE_NOMINAL (not HEALTH_STATE_OK). */
export function healthPill(value: string | null): Pill {
  switch (value) {
    case 'HEALTH_STATE_NOMINAL':  return { label: 'NOMINAL',  cls: PILL_OK };
    case 'HEALTH_STATE_DEGRADED': return { label: 'DEGRADED', cls: PILL_AMBER };
    case 'HEALTH_STATE_FAULT':    return { label: 'FAULT',    cls: PILL_RED };
    case 'HEALTH_STATE_FAILED':   return { label: 'FAILED',   cls: PILL_RED };
    default:                      return { label: '—',        cls: PILL_SLATE };
  }
}
