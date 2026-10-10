// PostureCard — the selected asset's posture and how long it has held.
// Posture (move / emplace cycle) is orthogonal to the 3-axis operational
// state shown by GroundDiagnosticsCard, so it gets its own compact card.
import SyncingNotice from './SyncingNotice';
import { postureClass, postureText, usePostureClock, type PostureStatus } from '../lib/posture';

export default function PostureCard({
  posture, isLoading = false,
}: {
  posture: { status: PostureStatus; since: string | null } | null;
  isLoading?: boolean;
}) {
  const nowMs = usePostureClock();
  return (
    <div className="panel shrink-0 p-3">
      <h2 className="text-sm text-slate-400 tracking-wider uppercase mb-2">Posture</h2>
      {isLoading ? (
        <SyncingNotice label="Syncing posture…" />
      ) : !posture ? (
        <div className="text-[11px] text-slate-500">No asset selected.</div>
      ) : (
        <div
          className={`inline-block text-[11px] font-bold px-2 py-0.5 rounded-sm border ${postureClass(posture.status)}`}
          data-testid="edge-posture"
        >
          {postureText(posture.status, posture.since, nowMs)}
        </div>
      )}
    </div>
  );
}
