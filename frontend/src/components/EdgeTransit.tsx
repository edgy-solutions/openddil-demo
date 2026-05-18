// =============================================================================
// EdgeTransit — Phase 6c.3 transit hook (CLOSED at cycle 3, Option Z)
// =============================================================================
// Animation target: the 3D schematic inside the GROUND DIAGNOSTICS panel
// ONLY — not the entire main grid, not the cards column, not
// LocalFleetRadar, not the identity strip. Everything else snaps to new
// asset data without animation.
//
// What this hook returns: a transit phase. The schematic's render path
// (DiagnosticCanvas -> HudFrame.contentClassName) maps the phase to a
// CSS class; the class drives a single 800ms keyframe animation
// (transit-content-anim in index.css) that dissolves the schematic via
// opacity ramp + blur ramp + brightness bump — no overlay, no color
// wash. See index.css for the full iteration history (cycles 1-3),
// the cyan-wash failure-family learning (cycle 2), and the
// CSS-minifier-identity-strip note (cycle 3).
//
// First-mount gating: prev-ref starts undefined; first effect run
// sets it without animating. Asset-within-edge changes do NOT trigger
// transit because the parent passes only the edge id as the key.
import { useEffect, useRef, useState } from 'react';

export type TransitPhase = 'idle' | 'transit';

/**
 * Hook form — returns the current transit phase based on triggerKey
 * changes. First mount and same-key re-renders do NOT trigger transit.
 * Edge change triggers a 800ms transit window (300ms dematerialize +
 * 200ms suspended + 300ms materialize).
 */
export function useTransitPhase(triggerKey: string | null): TransitPhase {
  const [phase, setPhase] = useState<TransitPhase>('idle');
  const prev = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (prev.current === undefined) {
      // First mount — record the initial trigger, do NOT animate.
      prev.current = triggerKey;
      return;
    }
    if (prev.current === triggerKey) {
      // Not an actual change (parent re-rendered without changing
      // the trigger) — do NOT animate.
      return;
    }
    prev.current = triggerKey;
    setPhase('transit');
    const t = setTimeout(() => setPhase('idle'), 800);
    return () => clearTimeout(t);
  }, [triggerKey]);

  return phase;
}

/**
 * Helper — returns the CSS class to apply to the schematic's children-
 * wrapping div during transit. Empty string when idle (no class applied,
 * no animation runs).
 *
 * Cycle 1 (Option A) applies ONLY `transit-content` (opacity + blur).
 * Cycle 2+ may add `transit-overlay` / `transit-glow` for B-accents IF
 * cycle 1 doesn't land — user picks which B-accent at cycle 2.
 */
export function transitClass(phase: TransitPhase): string {
  return phase === 'transit' ? 'transit-content' : '';
}
