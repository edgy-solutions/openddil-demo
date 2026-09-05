// =============================================================================
// tierShape — which instance a tier's SHAPE calls for
// =============================================================================
// ADR-0033 §Tier-parameterized presentation. This is THE decision of the
// tier-parameterized presentation arc, and it lives here — in `lib/`, with no
// React import — for a reason the arc itself demonstrates: a decision that
// can only be exercised by mounting three component trees is a decision
// nobody will re-check.
//
// SELECTION IS BY SHAPE, NEVER BY NAME. Nothing below reads `id`. The two
// questions are:
//
//   has_children   does this tier roll anything up?  → aggregate panels
//   parent         can this tier's uplink be cut?    → severance panel
//
// That is what turns "which of the three views does a fourth tier get?" from
// an unanswerable question into an obvious one. It was never unanswerable —
// it was MALFORMED, because it asked which of three instantiations a new
// instantiation should be. A fourth tier has a shape, and the shape decides.
//
// The trap this replaces is worth naming: reading "hq" or "region-" out of
// an identifier and choosing a view from it. That is inference from a naming
// habit — the same family as parsing a nation out of an asset id, which
// ADR-0029 §5 refuses for the same reason.

/** The three shapes a tier can have in a tree. Not three kinds of view. */
export type TierInstance = 'leaf' | 'intermediate' | 'root';

/** The minimum a shape decision needs. Deliberately NOT `TierConfig` — this
 *  function must not be able to read an id even by accident. */
export interface TierShape {
  has_children: boolean;
  parent?: string | null;
}

export function instanceForShape(tier: TierShape): TierInstance {
  // A leaf presents its own assets in depth: it has nothing to roll up, so
  // every panel it shows is about things it holds directly.
  if (!tier.has_children) return 'leaf';
  // Has children AND a parent: it rolls up, and its own uplink can be cut.
  if (tier.parent) return 'intermediate';
  // Has children, no parent: the root of this deployment.
  return 'root';
}
