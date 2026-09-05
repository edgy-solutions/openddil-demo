// =============================================================================
// thisNode — the components. The rule and its reasoning live in
// thisNodeContext.ts, which this file is the rendering half of.
// =============================================================================
import type { ReactNode } from 'react';
import type { TierConfig } from '../deployment';
import { ThisNodeContext, isThisNode, useIsThisNode } from './thisNodeContext';

export function ThisNodeProvider(
  { tier, children }: { tier: TierConfig | null; children: ReactNode },
) {
  return (
    <ThisNodeContext.Provider value={isThisNode(tier)}>
      {children}
    </ThisNodeContext.Provider>
  );
}

/** The badge itself, so the three headers cannot drift in how they say it.
 *  Renders nothing when the claim is not true — the absence IS the fix. */
export function ThisNodeBadge() {
  if (!useIsThisNode()) return null;
  return (
    <span className="bg-emerald-500/20 px-1 py-0.5 rounded text-[8px] ml-1">
      THIS NODE
    </span>
  );
}
