// =============================================================================
// useLinkIndicator — re-evaluates linkIndicator's classification at 1Hz
// =============================================================================
// Staleness is a function of wall-clock time, not just of the last row
// received — a row that stops updating must be caught even though nothing
// re-renders this component on its own. Same 1Hz-tick shape as
// hooks/useFleetTiers.ts's silent-asset re-evaluation.
//
// classifyLinkIndicator's stale/exit hysteresis needs the previously
// rendered kind fed back in. A ref would be the obvious place to keep
// that, but reading/writing a ref during render is exactly what
// react-hooks/refs forbids (rightly: a ref isn't a rendering input), and
// computing it from an unconditional setState-in-effect trips
// react-hooks's "avoid derived state via effect" rule instead. So this
// uses the React-docs-sanctioned "adjust state during render" pattern:
// compare this render's inputs to the last-seen ones kept in state, and
// if they differ, synchronously recompute and store both -- same
// data-flow as the ref would have given, without reading/writing outside
// what render itself owns.
import { useEffect, useState } from 'react';
import {
  classifyLinkIndicator,
  linkIndicatorInputs,
  sameLinkIndicatorInputs,
  type LinkIndicatorKind,
  type LinkIndicatorStatus,
} from '../lib/linkIndicator';

export function useLinkIndicator(
  status: LinkIndicatorStatus | null,
  isError: boolean,
): LinkIndicatorKind {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const [kind, setKind] = useState<LinkIndicatorKind>(() =>
    classifyLinkIndicator(status, isError, now),
  );
  // Compared by value: the status row is a new object on every render, and
  // an identity compare re-adjusted state on every render until React
  // aborted (#301) and the screen went blank.
  const inputs = linkIndicatorInputs(status, isError, now);
  const [lastSeen, setLastSeen] = useState(inputs);

  if (!sameLinkIndicatorInputs(lastSeen, inputs)) {
    setKind(classifyLinkIndicator(status, isError, now, kind));
    setLastSeen(inputs);
  }

  return kind;
}
