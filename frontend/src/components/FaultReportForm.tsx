// =============================================================================
// FaultReportForm — "Report a fault"
// =============================================================================
// Lets a user file a fault report against the selected asset. Fault
// codes and their text come entirely from the server (GET /cm/fault-codes)
// — none are hard-coded here, so this form has no opinion on what a fault
// code means and renders nothing when the feature isn't configured on this
// tier (null from loadFaultCodes: 404, 401, a network error, or a
// non-array body all collapse to the same "stay hidden" outcome).
//
// Submission goes through lib/cmReport.ts's submitReport, which builds the
// POST /cm/discrepancy body with exactly four keys (asset_id, component,
// fault_code, description) — this component never adds a reporter field;
// the PEP stamps that from the session.
import { useEffect, useState } from 'react';
import { ChevronDown, Wrench } from 'lucide-react';
import { loadFaultCodes, submitReport, type FaultCode } from '../lib/cmReport';

interface FaultReportFormProps {
  assetId: string | null | undefined;
  /** Component (slot_id) choices for this asset — componentOptions(cmState). */
  components: string[];
}

type SubmitOutcome =
  | { kind: 'success'; eventId: string }
  | { kind: 'error'; status: number; message: string };

export default function FaultReportForm({ assetId, components }: FaultReportFormProps) {
  const [faultCodes, setFaultCodes] = useState<FaultCode[] | null>(null);
  const [component, setComponent] = useState('');
  const [faultCode, setFaultCode] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<SubmitOutcome | null>(null);

  // Load once on mount. Not re-fetched on assetId change — the fault code
  // catalog is server-wide, not per-asset.
  useEffect(() => {
    let cancelled = false;
    loadFaultCodes().then((codes) => {
      if (!cancelled) setFaultCodes(codes);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // The feature is off for this tier/session — render nothing rather than
  // an empty or broken form.
  if (faultCodes === null) {
    return null;
  }

  const canSubmit = !submitting && !!assetId && !!component && !!faultCode && description.trim().length > 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!assetId || !canSubmit) return;
    setSubmitting(true);
    setOutcome(null);
    try {
      const result = await submitReport({ assetId, component, faultCode, description });
      if (result.ok) {
        setOutcome({ kind: 'success', eventId: result.eventId });
        setDescription('');
      } else {
        setOutcome({ kind: 'error', status: result.status, message: result.message });
      }
    } catch (err) {
      setOutcome({ kind: 'error', status: 0, message: err instanceof Error ? err.message : 'request failed' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="panel shrink-0 p-3">
      <h2 className="text-sm text-slate-400 tracking-wider uppercase mb-3 flex items-center">
        <Wrench className="w-4 h-4 mr-2" /> Report a fault
      </h2>

      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="space-y-1">
          <label className="text-[10px] text-slate-500 uppercase tracking-wider">Component</label>
          <div className="relative">
            <select
              value={component}
              onChange={(e) => setComponent(e.target.value)}
              className="w-full appearance-none bg-slate-800 text-slate-200 border border-slate-700 rounded-sm py-1.5 pl-2 pr-8 text-xs focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
            >
              <option value="">Select component…</option>
              {components.map((slot) => (
                <option key={slot} value={slot}>{slot}</option>
              ))}
            </select>
            <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-slate-500">
              <ChevronDown className="w-3 h-3" />
            </div>
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-[10px] text-slate-500 uppercase tracking-wider">Fault code</label>
          <div className="relative">
            <select
              value={faultCode}
              onChange={(e) => setFaultCode(e.target.value)}
              className="w-full appearance-none bg-slate-800 text-slate-200 border border-slate-700 rounded-sm py-1.5 pl-2 pr-8 text-xs focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
            >
              <option value="">Select fault code…</option>
              {faultCodes.map((fc) => (
                <option key={fc.code} value={fc.code}>{fc.code} — {fc.text}</option>
              ))}
            </select>
            <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-slate-500">
              <ChevronDown className="w-3 h-3" />
            </div>
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-[10px] text-slate-500 uppercase tracking-wider">Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={500}
            rows={3}
            className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-sm py-1.5 px-2 text-xs focus:outline-none focus:ring-2 focus:ring-cyan-500/50 resize-none"
            placeholder="What's wrong, and what you observed…"
          />
        </div>

        <button
          type="submit"
          disabled={!canSubmit}
          className="w-full text-xs font-bold uppercase tracking-wider py-1.5 rounded-sm border border-cyan-700 bg-cyan-900/40 text-cyan-300 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-cyan-900/60 transition-colors"
        >
          {submitting ? 'Submitting…' : 'Submit report'}
        </button>

        {outcome?.kind === 'success' && (
          <div className="text-[11px] text-emerald-400">
            Reported (event {outcome.eventId.slice(0, 8)})
          </div>
        )}
        {outcome?.kind === 'error' && (
          <div className="text-[11px] text-rose-400">
            {outcome.status}: {outcome.message}
          </div>
        )}
      </form>
    </div>
  );
}
