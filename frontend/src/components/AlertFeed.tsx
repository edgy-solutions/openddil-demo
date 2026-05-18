// =============================================================================
// AlertFeed — recent tactical events (CloudEvents)
// =============================================================================
// Phase 4b rewrite. Was fed by a polled /api/alerts endpoint that never
// existed plus locally-synthesised {id,msg,type,time} alerts. Now renders
// real CloudEvents from the tactical_events shape (useTacticalEvents):
// type, subject, severity, time.
import { AlertTriangle } from 'lucide-react';
import type { TacticalEvent } from '../hooks';
import { SyncingNotice } from './SyncingNotice';

// Map a CloudEvent's best-effort severity string to a feed colour.
function severityColors(severity: string | null): string {
  const s = (severity ?? '').toUpperCase();
  if (s.includes('CRITICAL') || s.includes('NOT_MISSION_CAPABLE') || s.includes('NON_OPERATIONAL')) {
    return 'border-rose-500 bg-rose-500/10 text-rose-400';
  }
  if (s.includes('DEGRADED') || s.includes('MAJOR') || s.includes('MINOR')) {
    return 'border-amber-500 bg-amber-500/10 text-amber-400';
  }
  return 'border-slate-500 bg-slate-800/50 text-slate-300';
}

// CloudEvent `type` is a reverse-DNS string; show the last segment.
function shortType(type: string): string {
  const parts = type.split('.');
  return parts.slice(-2).join('.') || type;
}

function formatTime(iso: string): string {
  if (!iso) return '--:--:--';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleTimeString('en-US', { hour12: false });
}

/**
 * Sizing: shrink-0 + max-h on the outer panel, overflow-y-auto on the
 * inner events list. Empty state collapses to header + empty-state
 * text. The previous flex-grow + min-height combination reserved
 * ~250px of dark blank space in the maintainer view's right column
 * (which is a flex-col with overflow-y-auto where flex-grow doesn't
 * fill — collapses to min-content or worse) and pushed Inventory
 * below the viewport. Populated state grows up to the max, then
 * scrolls internally.
 *
 * Word the rationale without literal Tailwind class names — the
 * content scanner picks tokens like `min-h-bracket-150px-close` out
 * of comments and bakes them into the bundle as unused utilities.
 */
export default function AlertFeed({ events, isLoading = false }: { events: TacticalEvent[]; isLoading?: boolean }) {
  return (
    <div className="panel shrink-0 flex flex-col max-h-[400px] p-3">
      <h2 className="text-sm text-slate-400 tracking-wider uppercase mb-2 flex items-center shrink-0">
        <AlertTriangle className="w-4 h-4 mr-2" /> Tactical Event Feed
      </h2>
      <div className="overflow-y-auto space-y-2 text-xs font-mono pr-2">
        {/* syncing -> genuinely empty -> events; syncing never falls
            through to the empty copy (cold-start race). */}
        {isLoading && <SyncingNotice label="Syncing events…" />}
        {!isLoading && events.length === 0 && (
          <div className="text-slate-500 border border-slate-700 bg-slate-800/50 p-2">
            No tactical events. Awaiting CM / logistics transitions.
          </div>
        )}
        {!isLoading && events.map((e) => (
          <div key={e.id} className={`p-2 border-l-2 text-xs mb-2 transition-all ${severityColors(e.severity)}`}>
            <div className="flex justify-between">
              <span className="font-bold">{shortType(e.type)}</span>
              <span className="opacity-50">[{formatTime(e.time)}]</span>
            </div>
            <div className="opacity-80 mt-0.5">
              {e.subject}
              {e.severity ? <span className="ml-2 opacity-70">— {e.severity}</span> : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
