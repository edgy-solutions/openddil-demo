// Link-count chips for the HQ HUD card: one chip per state, count in the
// state colour, zero-count chips dimmed. The accessible summary is the same
// text summaryText() produces, carried on the row's aria-label.
import type { LinkCounts } from '../../lib/linkStatus';

type ChipKey = 'up' | 'idle' | 'down' | 'unknown' | 'unreachable';

/** The four measured states, plus an optional count of links that cannot be
 *  measured because an ancestor link is down (the HQ theater tier tree). */
type ChipCounts = LinkCounts & { unreachable?: number };

const CHIPS: Array<{ key: ChipKey; word: string; dot: string; num: string }> = [
  { key: 'up',      word: 'UP',      dot: 'bg-emerald-500 text-emerald-500', num: 'text-emerald-400' },
  { key: 'idle',    word: 'IDLE',    dot: 'bg-amber-500 text-amber-500',     num: 'text-amber-400' },
  { key: 'down',    word: 'DOWN',    dot: 'bg-rose-500 text-rose-500',       num: 'text-rose-400' },
  { key: 'unknown', word: 'UNKNOWN', dot: 'bg-slate-500 text-slate-500',     num: 'text-slate-400' },
  { key: 'unreachable', word: 'UNREACH.', dot: 'bg-slate-400 text-slate-400',  num: 'text-slate-300' },
];

export function LinkChips({ counts }: { counts: ChipCounts }) {
  const label =
    `${counts.up} UP · ${counts.idle} IDLE · ${counts.down} DOWN` +
    (counts.unknown > 0 ? ` · ${counts.unknown} UNKNOWN` : '') +
    ((counts.unreachable ?? 0) > 0 ? ` · ${counts.unreachable} UNREACHABLE` : '');
  const count = (k: ChipKey) => counts[k] ?? 0;
  const shown = CHIPS.filter((c) => (c.key !== 'unknown' && c.key !== 'unreachable') || count(c.key) > 0);
  return (
    // Equal columns, count stacked over the word: four chips (UNKNOWN only
    // shows when > 0) must fit the card at its narrowest, which a single
    // line of dot + count + word did not.
    <div className={`grid ${shown.length === 5 ? 'grid-cols-5' : shown.length === 4 ? 'grid-cols-4' : 'grid-cols-3'} gap-1.5`} role="group" aria-label={label}>
      {shown.map((c) => {
        const n = count(c.key);
        return (
          <div
            key={c.key}
            data-testid={`link-chip-${c.key}`}
            data-count={n}
            className={`min-w-0 flex flex-col items-center px-1 py-1.5 rounded bg-white/[0.03] font-mono text-slate-300${n === 0 ? ' opacity-[0.35]' : ''}`}
          >
            <span className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className={`inline-block w-[7px] h-[7px] rounded-full ${c.dot}${n > 0 ? ' shadow-[0_0_6px_currentColor]' : ''}`}
              />
              <span className={`text-base font-bold tabular-nums leading-tight ${c.num}`}>{n}</span>
            </span>
            <span className="text-[9px] tracking-wider text-slate-400">{c.word}</span>
          </div>
        );
      })}
    </div>
  );
}
