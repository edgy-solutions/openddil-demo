// =============================================================================
// DemoMockBanner — the standing "no orphan mocks" marker (ADR-0017)
// =============================================================================
// Every component that renders against synthetic / hardcoded data instead
// of real pipeline data sets `const DEMO_MOCK = true` and renders this
// banner. The badge makes it visually obvious in the running UI which
// surfaces are not yet wired to real data, and to what.
//
// Usage:
//   const DEMO_MOCK = true;
//   ...
//   {DEMO_MOCK && <DemoMockBanner note="live data wiring pending RTI/Cyber DDS" />}
//
// `position` defaults to top-right. Components with a full-width top
// title bar (LocalFleetRadar) pass "bottom-right" so the badge doesn't
// collide with the title.
// =============================================================================

type BannerPosition = 'top-right' | 'bottom-right' | 'bottom-center';

const POSITION_CLASSES: Record<BannerPosition, string> = {
  'top-right':     'top-1 right-1',
  'bottom-right':  'bottom-1 right-1',
  // Bottom-center centers along the horizontal axis; the maintainer
  // 3D drill-down uses this so the badge sits under the asset and out
  // of the way of the top-left header / drill breadcrumbs.
  'bottom-center': 'bottom-1 left-1/2 -translate-x-1/2',
};

export function DemoMockBanner({
  note,
  position = 'top-right',
}: {
  note?: string;
  position?: BannerPosition;
}) {
  return (
    <div
      className={`absolute ${POSITION_CLASSES[position]} z-30 px-1.5 py-0.5
                  text-[9px] font-bold tracking-wider uppercase
                  bg-amber-500/15 text-amber-400 border border-amber-500/40
                  rounded-sm pointer-events-none select-none`}
      title={note ? `Demo mock — ${note}` : 'Demo mock — live data wiring pending'}
    >
      Demo Mock{note ? ` — ${note}` : ''}
    </div>
  );
}

export default DemoMockBanner;
