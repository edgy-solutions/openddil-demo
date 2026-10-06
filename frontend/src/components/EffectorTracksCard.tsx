// =============================================================================
// EffectorTracksCard — per-launcher effector (munition) launches
// =============================================================================
// Renders effector_launch rows (useEffectorLaunches) as child tracks under
// the launcher in AssetDeepDive: one row per launch, newest first, with its
// terminal state. These rows are not assets -- read effector_launch only
// through useEffectorLaunches, and read that hook only here.
//
// Renders NOTHING when there are no rows for the selected asset, same gate
// MunitionsLoadoutCard uses for non-launchers: a launcher-only concern that
// always-rendered an empty-state used to read as "launcher state is broken"
// on every ordinary (non-launcher) selection, which is the common case.
//
// Never "miss" or "hit" as an outcome label -- DIS carries no such event,
// so an in-flight round with no Detonation is unresolved, not missed.
// Remaining-of-declared is out of scope here: declared load is not served
// to the browser (effector_declared_load / effector_launcher_counts are not
// published), so this card shows only what the launches themselves carry.
import { Crosshair } from 'lucide-react';
import type { EffectorLaunch } from '../hooks';

const OUTCOME_LABELS: Record<string, string> = {
  entity_impact: 'entity impact',
  ground_impact: 'ground impact',
  detonated: 'detonated',
  dud: 'dud',
  other: 'other',
  unresolved: 'unresolved (no termination seen)',
};

export function outcomeLabel(terminalState: string | null): string {
  if (terminalState === null) return 'in flight';
  return OUTCOME_LABELS[terminalState] ?? terminalState;
}

function formatTime(iso: string): string {
  if (!iso) return '--:--:--';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleTimeString('en-US', { hour12: false });
}

export interface EffectorCounts {
  expended: number;
  inFlight: number;
  unresolved: number;
}

/** expended = sum(quantity); inFlight = terminal_state null; unresolved =
 *  terminal_state 'unresolved'. */
export function effectorCounts(launches: EffectorLaunch[]): EffectorCounts {
  let expended = 0;
  let inFlight = 0;
  let unresolved = 0;
  for (const l of launches) {
    expended += l.quantity;
    if (l.terminalState === null) inFlight += 1;
    else if (l.terminalState === 'unresolved') unresolved += 1;
  }
  return { expended, inFlight, unresolved };
}

function LaunchRow({ launch }: { launch: EffectorLaunch }) {
  return (
    <div className="border-l-2 border-slate-600 pl-2 py-0.5 text-[11px]">
      <div className="flex justify-between items-center">
        <span className="text-slate-300">
          {launch.munitionType} &times; {launch.quantity}
        </span>
        <span className="text-slate-500">{formatTime(launch.launchedAt)}</span>
      </div>
      <div className="text-slate-500 flex items-center flex-wrap gap-x-1">
        <span>{launch.targetAssetId ?? 'no target'}</span>
        <span>&middot;</span>
        <span>{outcomeLabel(launch.terminalState)}</span>
        {launch.lateTerminal && (
          <span
            className="ml-1 text-[9px] font-bold px-1 py-px rounded-sm border border-amber-700/50 bg-amber-900/30 text-amber-400 uppercase cursor-help"
            title="result arrived after the timeout"
          >
            late
          </span>
        )}
      </div>
    </div>
  );
}

export default function EffectorTracksCard({
  launches,
}: {
  launches: EffectorLaunch[];
}) {
  // No empty-state panel: non-launchers are the common case, and an
  // always-rendered "no launches yet" copy would read as "launcher state
  // is broken" on every ordinary selection.
  if (launches.length === 0) return null;

  const counts = effectorCounts(launches);
  const sorted = [...launches].sort((a, b) =>
    a.launchedAt < b.launchedAt ? 1 : a.launchedAt > b.launchedAt ? -1 : 0,
  );

  return (
    <div className="panel shrink-0 p-3">
      <h2 className="text-sm text-slate-400 tracking-wider uppercase mb-3 flex items-center">
        <Crosshair className="w-4 h-4 mr-2" /> Effector Tracks
      </h2>
      <div className="flex justify-between text-xs text-slate-400 mb-2">
        <span>
          Expended <span className="text-slate-200">{counts.expended}</span>
        </span>
        <span>
          In flight <span className="text-slate-200">{counts.inFlight}</span>
        </span>
        <span>
          Unresolved <span className="text-slate-200">{counts.unresolved}</span>
        </span>
      </div>
      <div className="space-y-1">
        {sorted.map((l) => (
          <LaunchRow key={l.eventUrn} launch={l} />
        ))}
      </div>
    </div>
  );
}
