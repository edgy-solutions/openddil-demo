// =============================================================================
// ShapeErrorBanner — the screen says what the panels cannot
// =============================================================================
// Rendered once, in the shared chrome, from a registry every shape request
// reports into. That placement is the point: threading an error state into
// each panel leaves the defect one panel away, and this project has already
// watched a feature sit in one sibling for a whole arc.
//
// Three causes, and they are genuinely different claims:
//
//   unlabelable  The table carries no releasability labels, so it CANNOT BE
//                PARTITIONED and is not served to anyone — the fully
//                entitled subject included. Nothing was decided about the
//                viewer; there was no question to decide. Saying "not
//                releasable" here would be wrong in a way that matters: it
//                implies a decision went against them.
//
//   transport    The request failed and we do not know why. Reported as
//                exactly that, rather than guessed at.
//
//   session      The request failed with a 401 — the viewer's session has
//                expired. This used to render "SESSION EXPIRED … the data
//                below is the last copy" IN THIS BANNER, with every fleet
//                value still sitting in the DOM beneath it. Expiry is not
//                link loss: the viewer is no longer entitled, so this now
//                goes to the whole-screen gate in Root.tsx (which unmounts
//                the panels), not to a banner stapled above them. The
//                'session' kind is still recorded in the registry — the
//                gate's signal comes from lib/sessionExpiry, set alongside
//                it in lib/shapeErrors.reportShapeError — but this banner
//                deliberately renders nothing for it.
import { useSyncExternalStore } from 'react';
import { subscribeShapeErrors, getShapeErrors } from '../lib/shapeErrors';

export default function ShapeErrorBanner() {
  // Third argument is `getServerSnapshot`: without it, renderToStaticMarkup
  // (react-dom/server's legacy sync renderer, used by this project's test
  // suite in lieu of jsdom) throws "Missing getServerSnapshot" and silently
  // falls back to an empty-snapshot client render, so the banner never
  // showed anything under that render path. The store has no server/client
  // split here (it's an in-memory module-level registry, not window state),
  // so the same getter is correct for both.
  const errors = useSyncExternalStore(subscribeShapeErrors, getShapeErrors, getShapeErrors);

  const unlabelable = errors.filter((e) => e.kind === 'unlabelable');
  const transport = errors.filter((e) => e.kind === 'transport');
  // 'session' errors are deliberately not read here — see the module
  // comment above. They still reach the registry (so getShapeErrors()
  // reflects them) but the gate in Root.tsx is where they are shown.
  //
  // The emptiness check is on these two kinds, not on `errors` as a
  // whole: an in-flight render with ONLY a session error recorded (the
  // gate hasn't unmounted this banner yet) must render nothing rather
  // than an empty amber bar.
  if (unlabelable.length === 0 && transport.length === 0) return null;

  return (
    <div className="shrink-0 border-b border-amber-800/60 bg-amber-950/40 px-4 py-1.5
                    text-[11px] leading-relaxed text-amber-200/90 font-mono">
      {unlabelable.length > 0 && (
        <div>
          <span className="font-bold tracking-wider">NOT SERVED</span>{' '}
          — {unlabelable.length} feed{unlabelable.length === 1 ? '' : 's'} carr
          {unlabelable.length === 1 ? 'ies' : 'y'} no releasability labels, so
          {' '}{unlabelable.length === 1 ? 'it' : 'they'} cannot be filtered and
          {' '}{unlabelable.length === 1 ? 'is' : 'are'} withheld from everyone,
          including fully entitled subjects:{' '}
          <span className="text-amber-100">
            {unlabelable.map((e) => e.table).join(', ')}
          </span>
          . <span className="text-amber-300/70">
            These panels are empty because the data is refused, not because
            there is none.
          </span>
        </div>
      )}
      {transport.length > 0 && (
        <div>
          <span className="font-bold tracking-wider">FEED UNAVAILABLE</span>{' '}
          — {transport.map((e) => e.table).join(', ')}.{' '}
          <span className="text-amber-300/70">
            The request failed; the panels below are not reporting an absence
            of data.
          </span>
        </div>
      )}
    </div>
  );
}
