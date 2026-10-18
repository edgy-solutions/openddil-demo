// =============================================================================
// FaultReportOverlay — discreet bottom-right fault reporting over the 3D view
// =============================================================================
// A small round glass button whose label slides out on hover/focus; clicking
// opens FaultReportForm in a glass sheet above it. The BIT-discrepancy card is
// live state and stays visible above the button whenever it is present; its
// "record" action opens the sheet prefilled. The container is
// pointer-events-none so the 3D view stays orbitable.
import { useEffect, useState } from 'react';
import { Wrench } from 'lucide-react';
import BitDiscrepancyCard from './BitDiscrepancyCard';
import FaultReportForm from './FaultReportForm';
import CortexApprovalLink from './CortexApprovalLink';
import { useCortexCases } from '../hooks/useCortexCases';

export interface BitDiscrepancy {
  /** component|fault_code, identifies the discrepancy across renders. */
  key: string;
  component: string;
  faultCode: string;
  text: string;
}

interface FaultReportOverlayProps {
  assetId: string | null | undefined;
  components: string[];
  bit: BitDiscrepancy | null;
  /** Faults on this asset's fault card (manual discrepancies); each may get
   *  an "Approve in cortex" link once cortex holds a case for it. */
  faults?: { component: string; faultCode: string }[];
}

// Inner cards (.panel) are opaque with a large radius; inside the glass sheet
// they become transparent and square so the sheet is the only frame.
const GLASS_INNER = '[&_.panel]:bg-transparent! [&_.panel]:border-0! [&_.panel]:shadow-none! [&_.panel]:rounded-none! [&_.panel]:p-0!';

export default function FaultReportOverlay({ assetId, components, bit, faults = [] }: FaultReportOverlayProps) {
  const cortexCases = useCortexCases(assetId);
  const [open, setOpen] = useState(false);
  const [prefill, setPrefill] = useState<{ component: string; code: string } | null>(null);
  // Key of the last BIT discrepancy this viewer filed, so the card can say
  // "Recorded, awaiting confirmation" before the CM state catches up.
  const [recordedKey, setRecordedKey] = useState<string | null>(null);

  const close = () => {
    setOpen(false);
    setPrefill(null);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className="absolute bottom-3 right-3 z-20 w-[300px] flex flex-col items-end gap-2 pointer-events-none">
      {faults.map((f) => (
        <div key={`${f.component}|${f.faultCode}`} className="pointer-events-auto" data-testid="fault-card-cortex">
          <CortexApprovalLink cases={cortexCases} faultCode={f.faultCode} component={f.component} />
        </div>
      ))}
      {bit && (
        <div className="pointer-events-auto w-full rounded-sm border border-amber-700/60 bg-slate-950/60 backdrop-blur p-2 [&_.panel]:bg-transparent! [&_.panel]:border-0! [&_.panel]:shadow-none! [&_.panel]:rounded-none! [&_.panel]:p-0!">
          <BitDiscrepancyCard
            text={bit.text}
            recorded={recordedKey === bit.key}
            onRecord={() => {
              setPrefill({ component: bit.component, code: bit.faultCode });
              setOpen(true);
            }}
          />
        </div>
      )}
      {open && (
        <div
          role="dialog"
          aria-label="Report a fault"
          className={`pointer-events-auto w-full max-h-[60vh] overflow-auto rounded-sm border border-cyan-500/20 bg-slate-950/60 backdrop-blur p-3 ${GLASS_INNER}`}
        >
          <FaultReportForm
            assetId={assetId}
            components={components}
            prefillComponent={prefill?.component}
            prefillCode={prefill?.code}
            onSuccess={() => {
              if (bit) setRecordedKey(bit.key);
            }}
            onClose={close}
          />
        </div>
      )}
      {!open && (
        <button
          type="button"
          aria-label="Report a fault"
          onClick={() => {
            setPrefill(null);
            setOpen(true);
          }}
          className="group pointer-events-auto flex h-9 items-center overflow-hidden rounded-full border border-cyan-500/25 bg-slate-950/55 px-[9px] text-cyan-300 backdrop-blur hover:border-cyan-400 focus:outline-none focus-visible:border-cyan-400 focus-visible:ring-2 focus-visible:ring-cyan-500"
        >
          <Wrench className="h-4 w-4 shrink-0" />
          <span className="max-w-0 whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.14em] opacity-0 motion-safe:transition-all motion-safe:duration-200 group-hover:ml-2 group-hover:max-w-[120px] group-hover:opacity-100 group-focus-visible:ml-2 group-focus-visible:max-w-[120px] group-focus-visible:opacity-100">
            Report a fault
          </span>
        </button>
      )}
    </div>
  );
}
