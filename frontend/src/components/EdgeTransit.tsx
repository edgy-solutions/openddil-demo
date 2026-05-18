// =============================================================================
// EdgeTransit — Phase 6c.3 transit hook (corrected scope)
// =============================================================================
// CORRECTED SCOPE (post-cycle-bd6b4e9 redirect): the animation target is
// the 3D schematic inside the GROUND DIAGNOSTICS panel ONLY — not the
// entire main grid, not the cards column, not LocalFleetRadar, not the
// identity strip. Per the recipe revision, everything else snaps to new
// asset data without animation.
//
// ESCALATION ORDER (recipe-locked):
//   Cycle 1  — Option A: CSS dissolve on the schematic only — opacity
//              down + blur up during dematerialize, held at low opacity
//              + max blur during suspended, opacity up + blur down
//              during materialize. NO cyan wash. NO scanlines. NO
//              particles. NO scale change.
//   Cycle 2+ — Option A + one B-accent (user picks: contained cyan tint
//              inside the panel during suspended, soft inset glow on
//              panel border, or subtle rotation suggesting "lifting off
//              the pad"). The B-accent keyframes are held in reserve
//              in index.css (transit-overlay-anim, transit-glow-anim)
//              but NOT rendered in cycle 1.
//   Bail     — if cycle 6 against the corrected target still feels
//              wrong, drop to slide as the floor (recipe bail
//              condition; specified before iteration, not derived
//              under pressure).
//
// THE BAR IS "GOOD ENOUGH," NOT "SPECTACULAR." If cycle 1 lands at
// good-enough, ship it — don't iterate toward fancier just because
// B-accents exist.
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
