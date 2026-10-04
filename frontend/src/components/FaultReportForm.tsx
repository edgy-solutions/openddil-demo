// =============================================================================
// FaultReportForm — "Report a fault"
// =============================================================================
// Lets a user file a fault report against the selected asset. The fault
// catalog (codes + their text) comes entirely from the server, scoped to
// THIS asset's platform_variant (GET /cm/fault-codes?asset_id=<id> — see
// lib/cmReport.ts's loadFaultCatalog) — none are hard-coded here, and a
// code belonging to a different variant can never appear in this asset's
// options, because the server never sends one.
//
// Split into a stateful container (this default export: owns the fetch,
// the form fields, submission) and a pure view (FaultReportFormView,
// exported separately) so the rendering logic — which options show for
// which component, what the empty-catalog message says — is testable
// without mounting a component that has hooks (this project's vitest runs
// with no DOM; see vitest.config.ts).
//
// Submission goes through lib/cmReport.ts's submitReport, which builds the
// POST /cm/discrepancy body with exactly four keys (asset_id, component,
// fault_code, description) — this component never adds a reporter field;
// the PEP stamps that from the session. fault_code may be empty ("Not
// listed" — the fault isn't in the manual, or the variant has none at all).
import { useEffect, useState } from 'react';
import { ChevronDown, Wrench, X } from 'lucide-react';
import {
  codeOptionsFor,
  loadFaultCatalog,
  noFaultIsolationMessage,
  submitReport,
  type CatalogCode,
  type FaultCatalog,
} from '../lib/cmReport';

export interface FaultReportFormProps {
  assetId: string | null | undefined;
  /** Component (slot_id) choices for this asset — componentOptions(cmState). */
  components: string[];
  /** Pre-fills the form (from the BIT-discrepancy card's "Record it").
   *  Omitted/undefined for the plain "Report a fault" button path, which
   *  opens with both fields empty. */
  prefillComponent?: string;
  prefillCode?: string;
  /** Called on cancel AND on a successful submit — the caller (DiagnosticCanvas)
   *  closes the panel/modal either way. */
  onClose?: () => void;
  /** Called on a successful submit only, before onClose — lets the caller
   *  (the BIT-discrepancy card) distinguish "filed" from "cancelled". */
  onSuccess?: () => void;
}

type SubmitOutcome =
  | { kind: 'success'; eventId: string }
  | { kind: 'error'; status: number; message: string };

export default function FaultReportForm({
  assetId,
  components,
  prefillComponent,
  prefillCode,
  onClose,
  onSuccess,
}: FaultReportFormProps) {
  // undefined = still loading; null = loaded but off (404/401/not visible).
  const [catalog, setCatalog] = useState<FaultCatalog | null | undefined>(undefined);
  const [component, setComponent] = useState(prefillComponent ?? '');
  const [faultCode, setFaultCode] = useState(prefillCode ?? '');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<SubmitOutcome | null>(null);

  // Re-fetched whenever the selected asset changes — the catalog is scoped
  // to this asset's platform_variant, not server-wide.
  useEffect(() => {
    let cancelled = false;
    setCatalog(undefined);
    if (!assetId) {
      setCatalog(null);
      return;
    }
    loadFaultCatalog(assetId).then((loaded) => {
      if (!cancelled) setCatalog(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [assetId]);

  const handleCodeChange = (code: string) => {
    setFaultCode(code);
    // "Choosing a code sets component": look the code up in whichever
    // codes are currently on offer and adopt its component, so the two
    // fields never disagree about which part is at fault.
    if (code && catalog) {
      const entry = catalog.codes.find((c) => c.code === code);
      if (entry) setComponent(entry.component);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!assetId || submitting || !component || description.trim().length === 0) return;
    setSubmitting(true);
    setOutcome(null);
    try {
      const result = await submitReport({ assetId, component, faultCode, description });
      if (result.ok) {
        setOutcome({ kind: 'success', eventId: result.eventId });
        onSuccess?.();
        onClose?.();
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
    <FaultReportFormView
      assetId={assetId}
      components={components}
      catalog={catalog}
      component={component}
      faultCode={faultCode}
      description={description}
      submitting={submitting}
      outcome={outcome}
      onComponentChange={setComponent}
      onCodeChange={handleCodeChange}
      onDescriptionChange={setDescription}
      onSubmit={handleSubmit}
      onCancel={() => onClose?.()}
    />
  );
}

// =============================================================================
// FaultReportFormView — pure rendering, no hooks
// =============================================================================
export interface FaultReportFormViewProps {
  assetId: string | null | undefined;
  components: string[];
  /** undefined = still loading; null = loaded but off for this asset
   *  (404/401/not visible) — rendered as a notice, not a broken form. */
  catalog: FaultCatalog | null | undefined;
  component: string;
  faultCode: string;
  description: string;
  submitting: boolean;
  outcome: SubmitOutcome | null;
  onComponentChange: (component: string) => void;
  onCodeChange: (code: string) => void;
  onDescriptionChange: (description: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  onCancel: () => void;
}

export function FaultReportFormView({
  assetId,
  components,
  catalog,
  component,
  faultCode,
  description,
  submitting,
  outcome,
  onComponentChange,
  onCodeChange,
  onDescriptionChange,
  onSubmit,
  onCancel,
}: FaultReportFormViewProps) {
  const canSubmit = !submitting && !!assetId && !!component && description.trim().length > 0;
  const codes: CatalogCode[] = catalog ? codeOptionsFor(catalog.codes, component) : [];
  const catalogIsEmpty = !!catalog && catalog.codes.length === 0;

  return (
    <div className="panel shrink-0 p-3">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm text-slate-400 tracking-wider uppercase flex items-center">
          <Wrench className="w-4 h-4 mr-2" /> Report a fault
        </h2>
        <button type="button" onClick={onCancel} aria-label="Close" className="text-slate-500 hover:text-slate-300">
          <X className="w-4 h-4" />
        </button>
      </div>

      {catalog === null && (
        <div className="text-[11px] text-slate-500 mb-2">
          Fault reporting is not available for this asset.
        </div>
      )}
      {catalogIsEmpty && (
        <div className="text-[11px] text-slate-500 mb-2">
          {noFaultIsolationMessage(catalog?.platform_variant ?? null)}
        </div>
      )}

      <form onSubmit={onSubmit} className="space-y-3">
        <div className="space-y-1">
          <label className="text-[10px] text-slate-500 uppercase tracking-wider">Component</label>
          <div className="relative">
            <select
              value={component}
              onChange={(e) => onComponentChange(e.target.value)}
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
              onChange={(e) => onCodeChange(e.target.value)}
              className="w-full appearance-none bg-slate-800 text-slate-200 border border-slate-700 rounded-sm py-1.5 pl-2 pr-8 text-xs focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
            >
              <option value="">Not listed</option>
              {codes.map((fc) => (
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
            onChange={(e) => onDescriptionChange(e.target.value)}
            maxLength={500}
            rows={3}
            className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-sm py-1.5 px-2 text-xs focus:outline-none focus:ring-2 focus:ring-cyan-500/50 resize-none"
            placeholder="What's wrong, and what you observed…"
          />
        </div>

        <div className="flex gap-2">
          <button
            type="submit"
            disabled={!canSubmit}
            className="flex-1 text-xs font-bold uppercase tracking-wider py-1.5 rounded-sm border border-cyan-700 bg-cyan-900/40 text-cyan-300 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-cyan-900/60 transition-colors"
          >
            {submitting ? 'Submitting…' : 'Submit report'}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="text-xs uppercase tracking-wider py-1.5 px-3 rounded-sm border border-slate-700 text-slate-400 hover:bg-slate-800 transition-colors"
          >
            Cancel
          </button>
        </div>

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
