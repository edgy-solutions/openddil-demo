// =============================================================================
// EdgeTransit — Phase 6c.3 transporter animation wrapper
// =============================================================================
// Wraps the maintainer view's content area; on `triggerKey` change (the
// selected edge id), runs an 800ms three-phase transporter animation:
// dematerialize → suspended → materialize. Per ADR-0023's "FOB transport"
// narrative + the §C.3 recipe's "architectural honesty" framing — the
// system's actual behavior on edge change is Shape unsubscribe + new
// Table + fresh consumer group; dematerialize-and-rematerialize is what
// the user sees because that's what is happening.
//
// First-mount gating: the prev-ref starts undefined; first effect run
// sets it without animating. Only subsequent triggerKey changes cause
// transit. Initial page load isn't a "transport from somewhere" — it's
// "arriving for the first time" (recipe decision).
//
// Asset-within-edge changes do NOT trigger transit because the parent
// passes only the edge id as the trigger key. Selecting a different
// asset at the same FOB isn't transport — it's looking at a different
// asset at the FOB you're already at (recipe decision).
//
// CSS primitives live in index.css (.transit-content / .transit-overlay /
// .transit-glow / .transit-scanline-band keyframe classes). The five-
// primitive vocabulary is intentionally bounded — no canvas, no WebGL,
// no particle systems (recipe explicit out-of-scope per the asymmetric-
// risk framing from the §C.3 assessment).
import { useEffect, useRef, useState } from 'react';

interface EdgeTransitProps {
  /** The scope key that triggers transit when it changes. Maintainer
   *  passes selectedEdge; first-mount is gated by an undefined prev-ref. */
  triggerKey: string | null;
  className?: string;
  children: React.ReactNode;
}

export default function EdgeTransit({ triggerKey, className, children }: EdgeTransitProps) {
  const [phase, setPhase] = useState<'idle' | 'transit'>('idle');
  // `prev.current === undefined` flags the first mount — don't animate.
  // Subsequent renders compare prev.current to the incoming triggerKey
  // to detect actual edge changes (vs. parent re-renders that don't
  // change the trigger).
  const prev = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (prev.current === undefined) {
      // First mount — record the initial scope, do NOT animate.
      prev.current = triggerKey;
      return;
    }
    if (prev.current === triggerKey) {
      // Not an edge change (e.g., parent re-render with same edge) —
      // do NOT animate.
      return;
    }
    // Edge changed — kick off the 800ms transit.
    prev.current = triggerKey;
    setPhase('transit');
    const t = setTimeout(() => setPhase('idle'), 800);
    return () => clearTimeout(t);
  }, [triggerKey]);

  return (
    <div className={`relative ${className ?? ''}`}>
      <div className={phase === 'transit' ? 'transit-content' : ''}>
        {children}
      </div>
      {phase === 'transit' && (
        <>
          {/* Inset cyan glow on the entire content area — "absorbed by
              energy" read. Positioned absolutely so it doesn't shift
              layout. */}
          <div className="transit-glow absolute inset-0 pointer-events-none rounded-md" />
          {/* Cyan-tinted overlay — peaks at the suspended phase. The
              "energy" color. */}
          <div className="transit-overlay absolute inset-0 bg-cyan-400 pointer-events-none mix-blend-screen" />
          {/* Vertical scanline sweep — single horizontal band sweeping
              top→bottom across 800ms. The most distinctive transporter-
              evocative element; reuses the project's scanline visual
              vocabulary (HqApp freeze-overlay). */}
          <div className="absolute inset-0 pointer-events-none overflow-hidden">
            <div
              className="transit-scanline-band absolute inset-x-0 h-24"
              style={{
                background:
                  'linear-gradient(to bottom, transparent 0%, rgba(34,211,238,0.0) 10%, rgba(165,243,252,0.7) 50%, rgba(34,211,238,0.0) 90%, transparent 100%)',
                filter: 'blur(2px)',
                boxShadow: '0 0 24px rgba(34, 211, 238, 0.6)',
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}
