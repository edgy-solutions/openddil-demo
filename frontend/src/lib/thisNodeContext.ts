// =============================================================================
// thisNode — may the screen claim to BE the node it is showing?
// =============================================================================
// THE HAZARD, WHICH WAS LIVE AND VISIBLE. The demo shell composes every tier
// into one pane. Its maintainer tab rendered a header reading
// `TACTICAL EDGE [THIS NODE]` — on the HQ host. The screen was labelling a
// composed edge view as the node you were connected to, which it was not.
//
// It is the same mode confusion the tier arc was opened for: a UI wearing a
// tier's identity while reading somewhere else. The tier work removed it
// from tier nodes by giving each its own endpoint and store. It survived
// INSIDE the shell, because the badge was written when "which tab you are
// on" and "which node you are at" were the same fact.
//
// THE RULE, and it is narrow on purpose:
//
//   A view may claim node identity only when the tier it is rendering IS
//   the tier this deployment serves.
//
// Two consequences, both intended:
//   * In the shell, `deployment().tier` is absent, so NOTHING is this node
//     and no tab claims to be. The shell is a viewer, not a node.
//   * At a tier node, the one instance it serves claims it, and any other
//     tier it might ever render would not.
//
// Note this is deliberately NOT "is the shape the same". Two leaves have
// the same shape and are different nodes; identity is the id, and only the
// id.
import { createContext, useContext } from 'react';
import { deployment } from '../deployment';
import type { TierConfig } from '../deployment';

/** Split from the components deliberately: the lint rule that forbids a
 *  module exporting both components and plain functions is protecting fast
 *  refresh, and the honest fix is two modules rather than a suppression. */
export const ThisNodeContext = createContext(false);

/** True when `tier` is the tier this deployment itself serves. */
export function isThisNode(tier: TierConfig | null | undefined): boolean {
  const own = deployment().tier;
  if (!own || !tier) return false;
  return own.id === tier.id;
}

/** For headers: may I say THIS NODE?
 *
 *  Defaults to `false` outside a provider, which is the safe direction — a
 *  component that forgot to be wrapped understates its claim rather than
 *  asserting an identity nobody granted it. */
export function useIsThisNode(): boolean {
  return useContext(ThisNodeContext);
}
