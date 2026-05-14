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
// =============================================================================

export function DemoMockBanner({ note }: { note?: string }) {
  return (
    <div
      className="absolute top-1 right-1 z-20 px-1.5 py-0.5 text-[9px] font-bold
                 tracking-wider uppercase bg-amber-500/15 text-amber-400
                 border border-amber-500/40 rounded-sm pointer-events-none
                 select-none"
      title={note ? `Demo mock — ${note}` : 'Demo mock — live data wiring pending'}
    >
      Demo Mock{note ? ` — ${note}` : ''}
    </div>
  );
}

export default DemoMockBanner;
