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

interface HudFrameProps {
    title: string;
    subtitle?: string;
    bannerNote?: string;
    bottomHint?: string;
    /** Optional content rendered under the header (e.g. SensorArrayView's
     *  depth-breadcrumb and status pills). Lives in the same top-left
     *  overlay block so the visual grouping stays coherent. */
    headerExtras?: ReactNode;
    /** Children render inside the frame (typically: the <Canvas> plus any
     *  HUD overlays the caller owns — interrogation panes, depth indicators). */
    children: ReactNode;
}

export default function HudFrame({
    title,
    subtitle,
    bannerNote,
    bottomHint,
    headerExtras,
    children,
}: HudFrameProps) {
    return (
        <div className="absolute inset-0 bg-[#020617] text-[#22d3ee] font-mono select-none overflow-hidden">
            {bannerNote && <DemoMockBanner note={bannerNote} />}
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

            {children}

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
