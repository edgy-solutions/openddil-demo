// =============================================================================
// AdvisoryBadge — provenance marker for a recommended action (ADR-0038 C4(b))
// =============================================================================
// Shared by all three surfaces that render `recommended_action`: the maintainer
// drill-in (CmStateCard), the regional roll-up (regional/WorkOrders) and the
// HQ roll-up (hq/HqWorkOrders). One component so the three cannot drift —
// the audit that found this thread reported two surfaces and there were three,
// and a per-surface badge would make the fourth just as easy to miss.
//
// Renders NOTHING when the advisory carries no stamp. That is the honest
// treatment: rows written before C4(a) tell us nothing about what produced
// them, and an absent badge must read as "no claim" rather than "trusted".
import { advisoryBadge, describeAdvisory, type AdvisoryProvenance } from '../lib/valueBasis';

/** Amber for machine-generated, slate for human-authored.
 *
 *  The colour split is the point of the badge, not decoration: before C4(a) a
 *  machine advisory and a human one were the same bare string, distinguishable
 *  only by which JSONB list the row sat in — which the operator cannot see.
 *  Amber matches the SYNTHESIZED / DERIVED vocabulary used elsewhere in the
 *  COP for "this was computed, not observed". */
const CLS: Record<string, string> = {
  RULE:  'border-amber-700/50 bg-amber-900/30 text-amber-400',
  MODEL: 'border-amber-700/50 bg-amber-900/30 text-amber-400',
  HUMAN: 'border-slate-600 bg-slate-800/50 text-slate-400',
};

export function AdvisoryBadge({ provenance }: { provenance?: AdvisoryProvenance | null }) {
  const label = advisoryBadge(provenance);
  if (!label) return null;
  const title = describeAdvisory(provenance) ?? undefined;
  return (
    <span
      className={`ml-2 text-[9px] tracking-widest px-1.5 py-0.5 border uppercase rounded-sm cursor-help ${CLS[label] ?? CLS.RULE}`}
      title={title}
    >
      {label}
    </span>
  );
}

export default AdvisoryBadge;
