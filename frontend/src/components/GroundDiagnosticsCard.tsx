// =============================================================================
// GroundDiagnosticsCard — per-asset OperationalState (Phase 5, ADR-0026)
// =============================================================================
// Surfaces the 3-axis posture (power × functional mode × health) that the
// projector now persists on its own columns of telemetry_latest_state.
// Sits alongside CmStateCard in the Maintainer right column: CmStateCard
// shows config-management compliance; this shows operational posture; the
// two are orthogonal.
//
// Pill colors follow the proto enum semantics (NOT the derived severity):
//
//   POWER:
//     OFF / SHUTTING_DOWN  -> red    "entity not running or going down"
//     MAINTENANCE          -> amber  "planned offline state"
//     STANDBY              -> slate  "initialized, no claim of activity"
//     ON                   -> green  "powered up and running"  (proto: POWER_STATE_ON)
//
//   MODE:
//     IDLE                 -> slate  "ready but not engaged"
//     ACTIVE               -> green  "fully engaged"
//     RECEIVE_ONLY /
//       TRANSMIT_ONLY      -> cyan   "asymmetric activity (e.g. EW posture)"
//     SCAN / TRACK         -> green  "engaged sensor postures"
//
//   HEALTH:
//     NOMINAL              -> green  "no fault"   (proto: HEALTH_STATE_NOMINAL)
//     DEGRADED             -> amber  "non-critical anomaly"
//     FAULT / FAILED       -> red    "active fault / hard failure"
//
// Enum string values are the proto's full name (POWER_STATE_ON,
// HEALTH_STATE_NOMINAL, etc.) — that's what the JSON proto decoder
// emits and what the projector writes to the column. Earlier this
// file mistakenly checked POWER_STATE_OPERATE / HEALTH_STATE_OK which
// don't exist in the proto; the resulting fall-through rendered
// healthy sensors as "—" (UNSPECIFIED) pills.
//
// UNSPECIFIED on any axis (or NULL from postgres for producers that don't
// emit operational_state) renders as a "—" placeholder, NOT a slate pill
// — a UNSPECIFIED value is "I cannot make a claim", visually distinct
// from STANDBY which is "I claim I'm ready but inactive".
import { Activity } from 'lucide-react';
import type { OperationalState } from '../hooks';
import { SyncingNotice } from './SyncingNotice';

/** Pill class table — drives the colored badge for one enum value.
 *  Per-axis lookup so each axis can map the same suffix to different
 *  semantics (e.g. "ACTIVE" only exists on functional_mode). */
const PILL_OK       = 'bg-emerald-500/20 text-emerald-400 border-emerald-500/50';
const PILL_AMBER    = 'bg-amber-500/20 text-amber-400 border-amber-500/50';
const PILL_RED      = 'bg-rose-500/20 text-rose-400 border-rose-500/50';
const PILL_CYAN     = 'bg-cyan-500/20 text-cyan-400 border-cyan-500/50';
const PILL_SLATE    = 'bg-slate-700/40 text-slate-400 border-slate-600';

function powerPill(value: string | null): { label: string; cls: string } {
  switch (value) {
    case 'POWER_STATE_OFF':           return { label: 'OFF',          cls: PILL_RED };
    case 'POWER_STATE_SHUTTING_DOWN': return { label: 'SHUTTING DOWN',cls: PILL_RED };
    case 'POWER_STATE_MAINTENANCE':   return { label: 'MAINTENANCE',  cls: PILL_AMBER };
    case 'POWER_STATE_STANDBY':       return { label: 'STANDBY',      cls: PILL_SLATE };
    case 'POWER_STATE_ON':            return { label: 'ON',           cls: PILL_OK };
    default:                          return { label: '—',            cls: PILL_SLATE };
  }
}

function modePill(value: string | null): { label: string; cls: string } {
  switch (value) {
    case 'FUNCTIONAL_MODE_IDLE':           return { label: 'IDLE',         cls: PILL_SLATE };
    case 'FUNCTIONAL_MODE_ACTIVE':         return { label: 'ACTIVE',       cls: PILL_OK };
    case 'FUNCTIONAL_MODE_RECEIVE_ONLY':   return { label: 'RECEIVE ONLY', cls: PILL_CYAN };
    case 'FUNCTIONAL_MODE_TRANSMIT_ONLY':  return { label: 'TRANSMIT ONLY',cls: PILL_CYAN };
    case 'FUNCTIONAL_MODE_SCAN':           return { label: 'SCAN',         cls: PILL_OK };
    case 'FUNCTIONAL_MODE_TRACK':          return { label: 'TRACK',        cls: PILL_OK };
    default:                               return { label: '—',            cls: PILL_SLATE };
  }
}

function healthPill(value: string | null): { label: string; cls: string } {
  switch (value) {
    case 'HEALTH_STATE_NOMINAL':  return { label: 'NOMINAL',  cls: PILL_OK };
    case 'HEALTH_STATE_DEGRADED': return { label: 'DEGRADED', cls: PILL_AMBER };
    case 'HEALTH_STATE_FAULT':    return { label: 'FAULT',    cls: PILL_RED };
    case 'HEALTH_STATE_FAILED':   return { label: 'FAILED',   cls: PILL_RED };
    default:                      return { label: '—',        cls: PILL_SLATE };
  }
}

function Pill({ label, cls }: { label: string; cls: string }) {
  return (
    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-sm border ${cls}`}>
      {label}
    </span>
  );
}

function ActivityCue({
  active, label,
}: { active: boolean | null; label: string }) {
  // null = producer didn't emit the flag; render as muted/dim.
  // false = explicit "not receiving / not transmitting"; render as dim
  // but with a visible "no" dot. true = lit cyan.
  if (active === null) {
    return (
      <div className="flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-full bg-slate-700"></span>
        <span className="text-slate-500 text-[10px]">{label}: —</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1.5">
      <span className={`w-2 h-2 rounded-full ${active ? 'bg-cyan-400' : 'bg-slate-600'}`}></span>
      <span className={`text-[10px] ${active ? 'text-cyan-300' : 'text-slate-500'}`}>
        {label}: {active ? 'YES' : 'no'}
      </span>
    </div>
  );
}

export default function GroundDiagnosticsCard({
  opState, isLoading = false,
}: {
  opState: OperationalState | null;
  isLoading?: boolean;
}) {
  const allNull =
    !opState ||
    (opState.power_state == null &&
     opState.functional_mode == null &&
     opState.health_state == null &&
     opState.actively_receiving == null &&
     opState.actively_transmitting == null);

  return (
    <div className="panel shrink-0 p-3">
      <h2 className="text-sm text-slate-400 tracking-wider uppercase mb-3 flex items-center">
        <Activity className="w-4 h-4 mr-2" /> Ground Diagnostics
      </h2>

      {/* Three states: syncing, no-data, data. Same pattern as CmStateCard. */}
      {isLoading && <SyncingNotice label="Syncing operational state…" />}

      {!isLoading && allNull && (
        <div className="text-[11px] text-slate-500">
          No operational_state from this producer. Legacy DIS, capability-only,
          or pre-ADR-0026 senders leave this empty — severity (if any) comes
          from logistics fusion below.
        </div>
      )}

      {!isLoading && !allNull && opState && (
        <>
          <div className="grid grid-cols-3 gap-2 mb-3">
            <div className="flex flex-col items-start">
              <span className="text-[9px] text-slate-500 mb-1 tracking-wider">POWER</span>
              <Pill {...powerPill(opState.power_state)} />
            </div>
            <div className="flex flex-col items-start">
              <span className="text-[9px] text-slate-500 mb-1 tracking-wider">MODE</span>
              <Pill {...modePill(opState.functional_mode)} />
            </div>
            <div className="flex flex-col items-start">
              <span className="text-[9px] text-slate-500 mb-1 tracking-wider">HEALTH</span>
              <Pill {...healthPill(opState.health_state)} />
            </div>
          </div>

          <div className="flex gap-4 pt-2 border-t border-slate-700">
            <ActivityCue active={opState.actively_receiving}    label="RX" />
            <ActivityCue active={opState.actively_transmitting} label="TX" />
          </div>
        </>
      )}
    </div>
  );
}
