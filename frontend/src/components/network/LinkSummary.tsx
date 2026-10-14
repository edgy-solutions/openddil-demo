// Per-part coloured link count line. Renders the same text as summaryText()
// in lib/linkStatus.ts, one span per count so each carries its own colour:
// zero DOWN is green, any DOWN is red.
import type { LinkCounts } from '../../lib/linkStatus';

const Sep = () => <span className="text-slate-500"> · </span>;

export function LinkSummary({ counts }: { counts: LinkCounts }) {
  return (
    <>
      <span className="text-emerald-400">{counts.up} UP</span>
      <Sep />
      <span className="text-amber-400">{counts.idle} IDLE</span>
      <Sep />
      <span
        data-testid="link-summary-down"
        className={counts.down > 0 ? 'text-rose-400' : 'text-emerald-400'}
      >
        {counts.down} DOWN
      </span>
      {counts.unknown > 0 && (
        <>
          <Sep />
          <span className="text-slate-400">{counts.unknown} UNKNOWN</span>
        </>
      )}
    </>
  );
}
