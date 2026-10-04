// =============================================================================
// BitDiscrepancyCard — "BIT found this; record it?"
// =============================================================================
// Pure presentational card: DiagnosticCanvas wires it to useCmState()'s
// manual_discrepancies via lib/cmReport.ts's bitOnlyDiscrepancy /
// describeBitDiscrepancy (see that module for the telemetry_bit vs
// operator_report source semantics this is built on). No hooks here, so
// it's testable with react-dom/server's renderToStaticMarkup the same way
// ScopeControl/DecisionsView are (this project's vitest runs with no DOM).
import { AlertTriangle } from 'lucide-react';

export interface BitDiscrepancyCardProps {
  /** describeBitDiscrepancy(entry, catalogCodes) — the full card sentence. */
  text: string;
  /** true once this discrepancy's report has been submitted (202) but the
   *  CM state hasn't yet shown an operator_report source for it — the
   *  card stays up with "Recorded, awaiting confirmation" instead of the
   *  button, rather than disappearing and reappearing as the same card. */
  recorded: boolean;
  onRecord: () => void;
}

export default function BitDiscrepancyCard({ text, recorded, onRecord }: BitDiscrepancyCardProps) {
  return (
    <div className="panel shrink-0 p-3 border border-amber-700/60 bg-amber-900/10">
      <div className="flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
        <p className="text-xs text-amber-200 flex-1">{text}</p>
      </div>
      {recorded ? (
        <div className="text-[11px] text-slate-500 mt-2">Recorded, awaiting confirmation</div>
      ) : (
        <button
          type="button"
          onClick={onRecord}
          className="mt-2 text-xs font-bold uppercase tracking-wider py-1 px-3 rounded-sm border border-amber-700 bg-amber-900/30 text-amber-300 hover:bg-amber-900/50 transition-colors"
        >
          Record it
        </button>
      )}
    </div>
  );
}
