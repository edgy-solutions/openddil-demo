// "Approve in cortex" -- drawn on a fault only when cortex is configured and
// the door has delivered a case for that fault. The href is built from the
// door's case_id, never from an event id.
import { ExternalLink } from 'lucide-react';
import { cortexBaseUrl } from '../deployment';
import { matchCase, type CortexCase } from '../hooks/useCortexCases';

function cortexCaseHref(baseUrl: string, caseId: string): string {
  return `${baseUrl}/case/${encodeURIComponent(caseId)}`;
}

export default function CortexApprovalLink({
  cases,
  faultCode,
  component,
}: {
  cases: CortexCase[];
  faultCode: string;
  component?: string | null;
}) {
  const baseUrl = cortexBaseUrl();
  if (!baseUrl) return null;
  const match = matchCase(cases, { faultCode, component });
  if (!match) return null;
  return (
    <a
      href={cortexCaseHref(baseUrl, match.case_id)}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-xs font-bold uppercase tracking-wider py-1 px-3 rounded-sm border border-cyan-700 bg-cyan-900/40 text-cyan-300 hover:bg-cyan-900/60 transition-colors"
    >
      <ExternalLink className="w-3 h-3" /> Approve in cortex
    </a>
  );
}
