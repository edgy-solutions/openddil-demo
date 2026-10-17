// =============================================================================
// ArrivalsPanel -- undeclared and expected arrivals at the selected edge
// =============================================================================
// ADR-0050 s3. Polls GET /arrivals (lib/arrivals.ts) and renders nothing when
// the route is not offered to this viewer (401/403/404) or no edge is selected.
// One inline form (a section, not a modal) declares an undeclared asset or
// confirms it against an expected arrival. The PEP stamps who declared.
import { useState } from 'react';
import {
  buildDeclareBody,
  formatPosition,
  submitDeclaration,
  type ArrivalsData,
  type ExpectedArrival,
  type LoadArrivalsResult,
  type UndeclaredArrival,
} from '../lib/arrivals';
import { useArrivals } from '../hooks/useArrivals';


const FIELD =
  'w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-sm py-1 px-2 text-xs focus:outline-none focus:ring-2 focus:ring-cyan-500/50 disabled:opacity-60';
const LABEL = 'text-[10px] text-slate-500 uppercase tracking-wider';

interface FormTarget {
  row: UndeclaredArrival;
  /** Set for a confirm: the expected serial being confirmed. */
  confirmSerial: string | null;
}

function ArrivalForm({
  edgeId,
  data,
  target,
  onClose,
  onDone,
}: {
  edgeId: string;
  data: ArrivalsData;
  target: FormTarget;
  onClose: () => void;
  onDone: (warning: string | null) => void;
}) {
  const { row, confirmSerial } = target;
  const expected = confirmSerial
    ? data.expected.find((x) => x.serial === confirmSerial)
    : undefined;
  const isConfirm = confirmSerial !== null;

  const [serial, setSerial] = useState('');
  const [unit, setUnit] = useState(expected?.unit ?? '');
  const [nation, setNation] = useState(expected?.owning_nation ?? '');
  const [releasable, setReleasable] = useState<string[]>(expected?.releasable_to ?? []);
  const [baseline, setBaseline] = useState('none');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const baselines = data.baselines[row.platform_variant] ?? [];
  const notEntitled = isConfirm && !!nation && !data.declarable_nations.includes(nation);
  const unitName = data.units.find((u) => u.id === unit)?.name ?? unit;
  const canSubmit =
    !submitting && !!unit && !!nation && !notEntitled && (!isConfirm || !!expected);

  const toggle = (n: string) =>
    setReleasable((cur) => (cur.includes(n) ? cur.filter((x) => x !== n) : [...cur, n]));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    const result = await submitDeclaration(
      buildDeclareBody({
        assetId: row.asset_id,
        edgeId,
        serial: isConfirm ? confirmSerial : serial,
        unit,
        originatorNation: nation,
        releasableTo: releasable.filter((n) => n !== nation),
        baselineId: baseline,
        source: isConfirm ? 'expect-confirm' : 'declare',
        confirmSerial: confirmSerial ?? undefined,
      }),
    );
    setSubmitting(false);
    if (result.kind === 'ok') {
      onDone(
        result.warning
          ? `${row.asset_id} declared; baseline ${baseline} NOT assigned: ${result.warning}`
          : null,
      );
    } else {
      setError(result.kind === 'refused' ? result.reason : result.message);
    }
  };

  return (
    <form
      data-testid="arrivals-form"
      onSubmit={submit}
      className="mt-2 mb-1 p-2 space-y-2 border border-slate-700 rounded-sm bg-slate-900/60"
    >
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <label className={LABEL}>Asset id</label>
          <input className={FIELD} value={row.asset_id} readOnly />
        </div>
        <div className="space-y-1">
          <label className={LABEL}>Serial</label>
          <input
            className={FIELD}
            value={isConfirm ? confirmSerial : serial}
            readOnly={isConfirm}
            onChange={(e) => setSerial(e.target.value)}
            placeholder="optional"
          />
        </div>
        <div className="space-y-1">
          <label className={LABEL}>Unit</label>
          {isConfirm ? (
            <input className={FIELD} value={unitName} readOnly />
          ) : (
            <select className={FIELD} value={unit} onChange={(e) => setUnit(e.target.value)}>
              <option value="">Select unit…</option>
              {data.units.map((u) => (
                <option key={u.id} value={u.id}>{u.name}</option>
              ))}
            </select>
          )}
        </div>
        <div className="space-y-1">
          <label className={LABEL}>Nation</label>
          {isConfirm ? (
            <input data-testid="arrivals-nation" className={FIELD} value={nation} readOnly />
          ) : (
            <select
              data-testid="arrivals-nation"
              className={FIELD}
              value={nation}
              onChange={(e) => setNation(e.target.value)}
            >
              <option value="">Select nation…</option>
              {data.declarable_nations.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          )}
        </div>
      </div>

      <div className="space-y-1">
        <label className={LABEL}>Releasable to</label>
        <div className="flex flex-wrap gap-3 text-xs text-slate-300">
          {data.nations
            .filter((n) => n !== nation)
            .map((n) => (
              <label key={n} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={releasable.includes(n)}
                  disabled={isConfirm}
                  onChange={() => toggle(n)}
                />
                {n}
              </label>
            ))}
        </div>
      </div>

      <div className="space-y-1">
        <label className={LABEL}>Baseline</label>
        <select className={FIELD} value={baseline} onChange={(e) => setBaseline(e.target.value)}>
          <option value="none">none</option>
          {baselines.map((b) => (
            <option key={b} value={b}>{b}</option>
          ))}
        </select>
      </div>

      {notEntitled && (
        <div className="text-[11px] text-amber-400">
          your login is not entitled to declare {nation}
        </div>
      )}

      <div className="flex gap-2">
        <button
          type="submit"
          data-testid="arrivals-submit"
          disabled={!canSubmit}
          className="flex-1 text-xs font-bold uppercase tracking-wider py-1.5 rounded-sm border border-cyan-700 bg-cyan-900/40 text-cyan-300 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-cyan-900/60 transition-colors"
        >
          {submitting ? 'Submitting…' : isConfirm ? 'Confirm' : 'Declare'}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="text-xs uppercase tracking-wider py-1.5 px-3 rounded-sm border border-slate-700 text-slate-400 hover:bg-slate-800 transition-colors"
        >
          Cancel
        </button>
      </div>

      {error && (
        <div data-testid="arrivals-error" className="text-[11px] text-red-400">
          {error}
        </div>
      )}
    </form>
  );
}

function OverdueChip({ x }: { x: ExpectedArrival }) {
  if (!isOverdue(x)) return null;
  return (
    <span
      data-testid={`arrivals-overdue-${x.serial}`}
      className="text-[9px] font-bold tracking-wider px-1 rounded-sm border border-red-700 bg-red-900/40 text-red-400"
    >
      OVERDUE
    </span>
  );
}

// compact (the switcher's Arrivals tab, ~380px): two lines instead of the grid.
function ExpectedRow({ x, compact }: { x: ExpectedArrival; compact?: boolean }) {
  if (compact) {
    return (
      <div data-testid={`arrivals-expected-${x.serial}`} className="text-[11px] text-slate-300 py-0.5">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-mono whitespace-nowrap">{x.serial}</span>
          <span className="truncate">{x.platform_variant ?? '—'}</span>
          <span className="whitespace-nowrap text-slate-400">{x.unit ?? '—'}</span>
          <span className="ml-auto shrink-0"><OverdueChip x={x} /></span>
        </div>
        <div className="text-[10px] text-slate-500 break-all">due {x.due_by ?? '—'}</div>
      </div>
    );
  }
  return (
    <div
      data-testid={`arrivals-expected-${x.serial}`}
      className="grid grid-cols-[1fr_1fr_1fr_1.4fr] gap-2 items-center text-[11px] text-slate-300 py-0.5"
    >
      <span className="font-mono">{x.serial}</span>
      <span>{x.platform_variant ?? '—'}</span>
      <span>{x.unit ?? '—'}</span>
      <span className="flex items-center gap-1">
        {x.due_by ?? '—'}
        <OverdueChip x={x} />
      </span>
    </div>
  );
}

/** The overdue predicate ExpectedRow marks with the OVERDUE chip. */
function isOverdue(x: ExpectedArrival): boolean {
  return !!x.overdue;
}

// Mount with key={edgeId}: a different edge is a fresh panel (no stale rows or form).
export function ArrivalsView({
  edgeId,
  state,
  refetch,
  compact,
}: {
  edgeId: string | null;
  state: LoadArrivalsResult | undefined;
  refetch: () => Promise<void>;
  compact?: boolean;
}) {
  const [target, setTarget] = useState<FormTarget | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  if (!edgeId || !state || state.kind === 'absent') return null;
  if (state.kind === 'error') {
    return (
      <div data-testid="arrivals-panel" className="text-[11px] text-slate-500 px-1">
        Arrivals unavailable
      </div>
    );
  }
  const data = state.data;

  return (
    <div
      data-testid="arrivals-panel"
      className={compact ? 'max-h-[60vh] overflow-y-auto pr-1' : 'panel shrink-0 p-3'}
    >
      {!compact && (
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm text-slate-400 tracking-wider uppercase">Arrivals</h2>
          <span data-testid="arrivals-count" className="text-[11px] text-slate-400 font-mono">
            undeclared {data.undeclared.length} · expected {data.expected.length}
          </span>
        </div>
      )}

      {warning && (
        <div
          data-testid="arrivals-warning"
          className="flex items-start justify-between gap-2 mb-2 text-[11px] text-amber-400"
        >
          <span>{warning}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setWarning(null)}>
            ×
          </button>
        </div>
      )}
      {data.undeclared.length === 0 ? (
        <div className="text-[11px] text-slate-500 mb-2">No undeclared arrivals</div>
      ) : (
        <div className="space-y-2 mb-3">
          {data.undeclared.map((u) => (
            <div key={u.asset_id} data-testid={`arrivals-undeclared-${u.asset_id}`}>
              {(() => {
                const actions = (
                  <>
                    <button
                      type="button"
                      data-testid={`arrivals-declare-${u.asset_id}`}
                      onClick={() => setTarget({ row: u, confirmSerial: null })}
                      className="text-[10px] uppercase tracking-wider py-0.5 px-2 rounded-sm border border-cyan-700 bg-cyan-900/40 text-cyan-300 hover:bg-cyan-900/60"
                    >
                      Declare
                    </button>
                    {u.candidates.map((s) => (
                      <button
                        key={s}
                        type="button"
                        data-testid={`arrivals-confirm-${u.asset_id}-${s}`}
                        onClick={() => setTarget({ row: u, confirmSerial: s })}
                        className="text-[10px] uppercase tracking-wider py-0.5 px-2 rounded-sm border border-emerald-700 bg-emerald-900/30 text-emerald-300 hover:bg-emerald-900/50"
                      >
                        Confirm as {s}
                      </button>
                    ))}
                  </>
                );
                return compact ? (
                  <div className="text-[11px] text-slate-300">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-mono whitespace-nowrap">{u.asset_id}</span>
                      <span className={`truncate ${u.platform_variant === 'UNKNOWN' ? 'text-amber-400' : ''}`}>
                        {u.platform_variant}
                      </span>
                      <span className="ml-auto flex shrink-0 flex-wrap justify-end gap-1">{actions}</span>
                    </div>
                    <div className="text-[10px] text-slate-500 break-all">
                      {u.first_seen ?? '—'} → {u.last_seen ?? '—'} · {formatPosition(u.position)}
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-[1.4fr_1fr_1fr_1fr_1.4fr] gap-2 text-[11px] text-slate-300">
                      <span className="font-mono">{u.asset_id}</span>
                      <span>{u.first_seen ?? '—'}</span>
                      <span>{u.last_seen ?? '—'}</span>
                      <span className={u.platform_variant === 'UNKNOWN' ? 'text-amber-400' : ''}>
                        {u.platform_variant}
                      </span>
                      <span className="font-mono">{formatPosition(u.position)}</span>
                    </div>
                    <div className="flex flex-wrap gap-2 mt-1">{actions}</div>
                  </>
                );
              })()}
              {target?.row.asset_id === u.asset_id && (
                <ArrivalForm
                  key={`${u.asset_id}|${target.confirmSerial ?? ''}`}
                  edgeId={edgeId}
                  data={data}
                  target={target}
                  onClose={() => setTarget(null)}
                  onDone={(w) => {
                    setTarget(null);
                    setWarning(w);
                    void refetch();
                  }}
                />
              )}
            </div>
          ))}
        </div>
      )}

      <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Expected</div>
      {data.expected.length === 0 ? (
        <div className="text-[11px] text-slate-500">Nothing expected</div>
      ) : (
        data.expected.map((x) => <ExpectedRow key={x.serial} x={x} compact={compact} />)
      )}
    </div>
  );
}

export default function ArrivalsPanel({ edgeId }: { edgeId: string | null }) {
  const { state, refetch } = useArrivals(edgeId);
  return <ArrivalsView edgeId={edgeId} state={state} refetch={refetch} />;
}
