// "Approve in cortex" -- drawn on a fault only when cortex is configured and
// the door has delivered a case for that fault. The href is built from the
// door's case_id, never from an event id.
import { ExternalLink } from 'lucide-react';
import { cortexBaseUrl, cortexIdp } from '../deployment';
import { matchCase, type CortexCase } from '../hooks/useCortexCases';

/** Longest raw case id cortex accepts; longer is "not a link" there. */
const CASE_ID_MAX_CHARS = 512;
const warnedLongIds = new Set<string>();

function cortexCaseHref(baseUrl: string, caseId: string, idp?: string): string | null {
  if (caseId.length > CASE_ID_MAX_CHARS) {
    if (!warnedLongIds.has(caseId)) {
      warnedLongIds.add(caseId);
      console.warn(`[cortex] case id over ${CASE_ID_MAX_CHARS} characters; no link drawn`);
    }
    return null;
  }
  const href = `${baseUrl}/case/${encodeURIComponent(caseId)}`;
  return idp ? `${href}?idp=${encodeURIComponent(idp)}` : href;
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
  const href = cortexCaseHref(baseUrl, match.case_id, cortexIdp());
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-xs font-bold uppercase tracking-wider py-1 px-3 rounded-sm border border-cyan-700 bg-cyan-900/40 text-cyan-300 hover:bg-cyan-900/60 transition-colors"
    >
      <ExternalLink className="w-3 h-3" /> Approve in cortex
    </a>
  );
}
