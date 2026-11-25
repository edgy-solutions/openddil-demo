// "Ask the manual" -- an action on the selected asset that opens cortex's
// existing ask link (the one the manual panel uses) with the asset as
// context. Drawn only when cortex is configured with `askManual: true`.
//
// The link carries only the callsign and the asset id. It forwards no token
// and stores nothing: no fetch, no storage, no store. Cortex fills its
// composer from the link and sends nothing. Where a sent question goes is
// iagent's to define.
import { BookOpen } from 'lucide-react';
import { cortexAskManual, cortexBaseUrl, cortexDisplayName, cortexIdp } from '../deployment';
import { cortexAskUrl } from '../lib/manualQa';

function tooltip(baseUrl: string): string | undefined {
  const name = cortexDisplayName();
  if (name) return `Opens in ${name}`;
  try {
    return `Opens in ${new URL(baseUrl).host}`;
  } catch {
    return undefined;
  }
}

export default function AskTheManualLink({
  assetId,
  callsign,
}: {
  assetId: string;
  callsign?: string | null;
}) {
  const baseUrl = cortexBaseUrl();
  if (!baseUrl || !cortexAskManual()) return null;
  const id = assetId.trim();
  if (!id) return null;
  const sign = callsign?.trim();
  const text = sign ? `Asset ${sign} (${id}): ` : `Asset ${id}: `;
  const href = cortexAskUrl(baseUrl, text, cortexIdp());
  if (!href) return null;
  return (
    <a
      href={href}
      title={tooltip(baseUrl)}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-xs font-bold uppercase tracking-wider py-1 px-3 rounded-sm border border-cyan-700 bg-cyan-900/40 text-cyan-300 hover:bg-cyan-900/60 transition-colors"
    >
      <BookOpen className="w-3 h-3" /> Ask the manual
    </a>
  );
}
