// =============================================================================
// TierApp — this node's instance of the one presentation
// =============================================================================
// ADR-0033 §Tier-parameterized presentation:
//
//   > The framework artifact is ONE UI, parameterized by tier, showing that
//   > tier's local truth plus its subtree rolled up, served by each tier node
//   > at that tier's own endpoint.
//   >
//   > "The HQ view" is the root node's instance. "The maintainer view" is a
//   > leaf node's instance. NONE OF THEM IS A KIND OF VIEW.
//
// -----------------------------------------------------------------------------
// SELECTION IS BY SHAPE, NEVER BY NAME
// -----------------------------------------------------------------------------
// Nothing below reads `tier.id`. The two questions are:
//
//   has_children   does this tier roll anything up?  → aggregate panels
//   parent         can this tier's uplink be cut?    → severance panel
//
// That is what makes "which of the three views does a fourth tier get?" a
// well-formed question instead of an unanswerable one. A fourth tier has a
// shape; the shape selects the panels. The question was never unanswerable —
// it was malformed, because it asked which of three INSTANTIATIONS a new
// instantiation should be.
//
// -----------------------------------------------------------------------------
// ⚠ WHAT THIS IS NOT, STATED PLAINLY
// -----------------------------------------------------------------------------
// This selects between THREE EXISTING COMPONENTS by shape. The amendment
// asks for ONE component composing panels by shape, and that convergence is
// NOT done here.
//
// What is delivered is the property the arc needed first: the tab switcher
// is gone, the instance is chosen by deployment config rather than by a
// human clicking, and the same bundle renders different instances from
// different config files. What remains is that the three still have separate
// implementations — and per the opening package §1 they already share their
// panel sets, so the convergence is smaller than it looks. It is tracked,
// not claimed.
//
// Calling this "done" would be the failure this corpus keeps recording: an
// artifact whose self-description is a claim rather than a fact.
import type { TierConfig } from './deployment';
import { instanceForShape } from './lib/tierShape';
import MaintainerApp from './MaintainerApp';
import RegionalApp from './RegionalApp';
import HqApp from './HqApp';

interface Props {
  tier: TierConfig;
}

export default function TierApp({ tier }: Props) {
  switch (instanceForShape(tier)) {
    case 'leaf':
      return <MaintainerApp tierScopeValue={tier.scope?.value ?? null} />;
    case 'intermediate':
      return <RegionalApp tierScopeValue={tier.scope?.value ?? null} />;
    case 'root':
      return <HqApp />;
  }
}
