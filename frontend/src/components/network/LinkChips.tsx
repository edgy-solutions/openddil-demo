// Link-count chips for the HQ HUD card: one chip per state, count in the
// state colour, zero-count chips dimmed. The accessible summary is the same
// text summaryText() produces, carried on the row's aria-label.
import type { LinkCounts } from '../../lib/linkStatus';

type ChipKey = 'up' | 'idle' | 'down' | 'unknown';

const CHIPS: Array<{ key: ChipKey; word: string; dot: string; num: string }> = [
  { key: 'up',      word: 'UP',      dot: 'bg-emerald-500 text-emerald-500', num: 'text-emerald-400' },
  { key: 'idle',    word: 'IDLE',    dot: 'bg-amber-500 text-amber-500',     num: 'text-amber-400' },
  { key: 'down',    word: 'DOWN',    dot: 'bg-rose-500 text-rose-500',       num: 'text-rose-400' },
  { key: 'unknown', word: 'UNKNOWN', dot: 'bg-slate-500 text-slate-500',     num: 'text-slate-400' },
];

export function LinkChips({ counts }: { counts: LinkCounts }) {
  const label =
    `${counts.up} UP · ${counts.idle} IDLE · ${counts.down} DOWN` +
    (counts.unknown > 0 ? ` · ${counts.unknown} UNKNOWN` : '');
  return (
    <div className="flex gap-1.5" role="group" aria-label={label}>
      {CHIPS.filter((c) => c.key !== 'unknown' || counts.unknown > 0).map((c) => {
        const n = counts[c.key];
        return (
          <div
            key={c.key}
            data-testid={`link-chip-${c.key}`}
            data-count={n}
            className={`flex-1 flex items-center gap-1.5 px-2 py-1.5 rounded bg-white/[0.03] font-mono text-[11px] text-slate-300${n === 0 ? ' opacity-[0.35]' : ''}`}
          >
            <span
              aria-hidden="true"
              className={`inline-block w-[7px] h-[7px] rounded-full ${c.dot}${n > 0 ? ' shadow-[0_0_6px_currentColor]' : ''}`}
            />
            <span className={`text-base font-bold tabular-nums ${c.num}`}>{n}</span>
            <span className="text-slate-400">{c.word}</span>
          </div>
        );
      })}
    </div>
  );
}
