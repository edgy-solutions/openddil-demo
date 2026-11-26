// =============================================================================
// CaseDisposition -- what became of the case's latest action, on the fault card
// =============================================================================
// ADR-0058 slice 3a, design section 4. A judgment drawn with its producer (the
// case id) and its time. A refusal reads as a refusal with its reason; an
// absence is named, never left blank. A case from an older server (no
// `disposition_state`) draws nothing here.
import { matchCase, type CortexCase } from '../hooks/useCortexCases';

function fmt(iso: string | null | undefined): string {
  if (!iso) return 'no time';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('en-US', { hour12: false });
}

function dispositionLine(c: CortexCase): string | null {
  switch (c.disposition_state) {
    case 'admitted': {
      const d = c.disposition ?? {};
      const what = [d.option, d.stage].filter(Boolean).join(', ');
      return `disposition: ${what || 'recorded'} - by case ${c.case_id} - decided ${fmt(c.decided_at)}`;
    }
    case 'refused':
      return `refused: ${c.decision?.reason ?? 'no reason given'} - case ${c.case_id} - decided ${fmt(c.decided_at)}`;
    case 'none':
      return 'no disposition recorded';
    case 'unjoinable':
      return 'action kind declares no case reference';
    case 'held at the hub':
      return 'disposition held at the hub';
    default:
      return null;
  }
}

export default function CaseDisposition({
  cases,
  faultCode,
  component,
}: {
  cases: CortexCase[];
  faultCode: string;
  component?: string | null;
}) {
  const match = matchCase(cases, { faultCode, component });
  if (!match) return null;
  const line = dispositionLine(match);
  if (!line) return null;
  return (
    <div className="font-mono text-[10px] text-slate-300 text-right" data-testid="case-disposition">
      {line}
    </div>
  );
}
