// =============================================================================
// HudFrame — shared visual chrome for the maintainer-tier diagnostic surfaces
// =============================================================================
// Extracted from LtamdsView + DiagnosticCanvas so every 3D maintainer view
// reads as the same family — same cyan bezel, same scanning-line drift,
// same glitch-text header treatment. Children render the 3D Canvas and any
// view-specific HUD overlays (LtamdsView's interrogation panel, depth dots,
// etc. — those live as children, not in the frame).
//
// Pure presentational. No data input, no DEMO_MOCK status of its own — the
// banner the caller passes via `bannerNote` carries the honesty per
// ADR-0017; if it's null, no banner.
import type { ReactNode } from 'react';
import { DemoMockBanner } from './DemoMockBanner';

type BannerPosition = 'top-right' | 'bottom-right' | 'bottom-center';

interface HudFrameProps {
    title: string;
    subtitle?: string;
    bannerNote?: string;
    /** Position for the DemoMockBanner. Defaults to top-right; the
     *  maintainer 3D drill-down passes 'bottom-center' so the badge
     *  doesn't crowd the top header's title + breadcrumbs. */
    bannerPosition?: BannerPosition;
    bottomHint?: string;
    /** Optional content rendered under the header (e.g. SensorArrayView's
     *  depth-breadcrumb and status pills). Lives in the same top-left
     *  overlay block so the visual grouping stays coherent. */
    headerExtras?: ReactNode;
    /** Children render inside the frame (typically: the <Canvas> plus any
     *  HUD overlays the caller owns — interrogation panes, depth indicators). */
    children: ReactNode;
    /** Phase 6c.3: optional className applied to the children-wrapping
     *  div. Used by DiagnosticCanvas to animate the schematic
     *  (Canvas) without animating HudFrame's chrome (header, banner,
     *  scanning-line, glitch-text). Children get the class; the
     *  GROUND DIAGNOSTICS title + DEMO MOCK badge stay put. */
    contentClassName?: string;
}

export default function HudFrame({
    title,
    subtitle,
    bannerNote,
    bannerPosition,
    bottomHint,
    headerExtras,
    children,
    contentClassName,
}: HudFrameProps) {
    return (
        <div className="absolute inset-0 bg-[#020617] text-[#22d3ee] font-mono select-none overflow-hidden">
            {bannerNote && <DemoMockBanner note={bannerNote} position={bannerPosition} />}
            <style>{`
                .hud-border {
                    border: 1px solid rgba(34, 211, 238, 0.3);
                    background: rgba(15, 23, 42, 0.85);
                    backdrop-filter: blur(12px);
                    clip-path: polygon(0% 0%, 90% 0%, 100% 10%, 100% 100%, 10% 100%, 0% 90%);
                    box-shadow: 0 0 30px rgba(34, 211, 238, 0.1);
                }
                .scanning-line {
                    height: 2px;
                    background: linear-gradient(to right, transparent, #22d3ee, transparent);
                    position: absolute;
                    width: 100%;
                    animation: scan 3s linear infinite;
                    opacity: 0.5;
                    pointer-events: none;
                }
                @keyframes scan {
                    0% { top: 0; }
                    100% { top: 100%; }
                }
                .glitch-text {
                    text-transform: uppercase;
                    letter-spacing: 0.2em;
                    text-shadow: 0 0 10px #22d3ee;
                }
            `}</style>

            {/* Phase 6c.3: children-wrapping div carries the optional
                contentClassName so the schematic's Canvas can animate
                in isolation (DiagnosticCanvas threads the transit
                class here). The wrapper is `absolute inset-0` so it
                fills the panel without disturbing HudFrame's child
                layout (the Canvas inside expects to fill its parent). */}
            <div className={`absolute inset-0 ${contentClassName ?? ''}`}>
                {children}
            </div>

            {/* Top Left Header Overlay */}
            <div className="absolute top-6 left-6 z-10 pointer-events-none">
                <h1 className="glitch-text text-2xl font-bold text-cyan-400">{title}</h1>
                {subtitle && (
                    <p className="text-xs tracking-widest opacity-70">{subtitle}</p>
                )}
                {headerExtras}
            </div>

            {/* Bottom Left Context Hint (optional) */}
            {bottomHint && (
                <div className="absolute bottom-6 left-6 z-10 text-[0.7rem] uppercase tracking-tighter opacity-50 pointer-events-none">
                    {bottomHint}
                </div>
            )}
        </div>
    );
}
