// =============================================================================
// SourcesPane -- three sources, one asset, no collapse (ADR-0053 first slice)
// =============================================================================
// Observed, Declared and Derived side by side, each with its own band. Three
// pair marks compare exactly two bands each. Nothing reduces the three marks
// or the three bands to one value; there is no combined state on this pane.
import { useEffect, useState } from 'react';
import { loadSources } from '../lib/sources';
import type { Band, SourceName, SourcesBody } from '../lib/sources';

type Pair = [SourceName, SourceName];
const PAIRS: Pair[] = [
  ['observed', 'declared'],
  ['observed', 'derived'],
  ['declared', 'derived'],
];

function markFor(a: Band | null, b: Band | null): { state: 'marked' | 'agree' | 'no-band'; text: string } {
  if (a === null || b === null) return { state: 'no-band', text: 'no band' };
  if (a === b) return { state: 'agree', text: 'agree' };
  return { state: 'marked', text: `bands differ: ${a} vs ${b}` };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const show = (v: unknown) => (v === null || v === undefined || v === '' ? '-' : String(v));

function Row({ k, v }: { k: string; v: unknown }) {
  return (
    <div className="flex gap-2">
      <span className="text-slate-500">{k}</span>
      <span className="text-slate-200 break-all">{show(v)}</span>
    </div>
  );
}

export function SourcesPaneView({ data }: { data: SourcesBody }) {
  const { observed, declared, derived } = data.sources;
  const cells = { observed, declared, derived };
  const cols: SourceName[] = ['observed', 'declared', 'derived'];
  return (
    <div className="panel p-3 text-xs" data-testid="sources-pane">
      <div className="grid grid-cols-3 gap-3">
        {cols.map((name) => {
          const cell = cells[name];
          return (
            <div key={name} data-testid={`col-${name}`} className="border border-slate-700 p-2 rounded-sm">
              <div className="font-semibold text-slate-300">{cap(name)}</div>
              <div>band: <span data-testid={`band-${name}`}>{cell.band ?? 'none'}</span></div>
              <Row k="tier" v={cell.tier} />
              <Row k="source" v={cell.source} />
              <Row k="time" v={cell.time} />
              {name === 'observed' && observed.silent && (
                <div className="text-amber-400" data-testid="silent">silent since {show(observed.time)}</div>
              )}
              {cell.record === null ? (
                <div className="text-slate-500">no record visible here</div>
              ) : (
                Object.entries(cell.record)
                  .filter(([k]) => k !== 'manual_discrepancies' && k !== 'declaration' && k !== 'constraining_factors')
                  .map(([k, v]) => <Row key={k} k={k} v={v} />)
              )}
              {name === 'declared' && declared.record && (
                <div data-testid="discrepancies">
                  {declared.record.manual_discrepancies.map((d, i) => (
                    <div key={i} className="text-rose-300">{d.fault_code} {d.component}</div>
                  ))}
                  {declared.record.declaration && (
                    <Row k="declared by" v={declared.record.declaration.declared_by} />
                  )}
                </div>
              )}
              {name === 'derived' && derived.record && (
                <Row k="factors" v={derived.record.constraining_factors.length} />
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex flex-col gap-1">
        {PAIRS.map(([a, b]) => {
          const m = markFor(cells[a].band, cells[b].band);
          return (
            <div key={`${a}-${b}`} data-testid={`mark-${a}-${b}`} data-state={m.state}
                 className={m.state === 'marked' ? 'text-amber-300' : 'text-slate-400'}>
              {a} / {b}: {m.text}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function SourcesPane({ assetId }: { assetId: string }) {
  const [data, setData] = useState<SourcesBody | null>(null);
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!assetId) return;
    let live = true;
    const pull = () => loadSources(assetId).then((d) => { if (live) { setData(d); setDone(true); } });
    pull();
    const t = setInterval(pull, 10000);
    return () => { live = false; clearInterval(t); };
  }, [assetId]);
  if (!assetId) return null;
  if (!data) {
    return <div className="text-xs text-slate-500" data-testid="sources-empty">{done ? 'No sources visible for this asset.' : 'Loading sources...'}</div>;
  }
  return <SourcesPaneView data={data} />;
}
