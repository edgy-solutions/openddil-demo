// =============================================================================
// useLinkIndicator — re-evaluates linkIndicator's classification at 1Hz
// =============================================================================
// Staleness is a function of wall-clock time, not just of the last row
// received — a row that stops updating must be caught even though nothing
// re-renders this component on its own. Same 1Hz-tick shape as
// hooks/useFleetTiers.ts's silent-asset re-evaluation.
import { useEffect, useState } from 'react';
import {
  classifyLinkIndicator,
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

  return classifyLinkIndicator(status, isError, now);
}
