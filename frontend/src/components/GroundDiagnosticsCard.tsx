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
// Pure enum-name → pill-color mappings live in lib/ so they can be
// unit-tested without React rendering. See operationalStatePills.test.ts.
import { powerPill, modePill, healthPill } from '../lib/operationalStatePills';

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
