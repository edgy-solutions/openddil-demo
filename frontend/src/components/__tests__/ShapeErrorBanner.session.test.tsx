// A session-kind error must render SESSION EXPIRED and must NOT double up
// under FEED UNAVAILABLE. Uses renderToStaticMarkup (see
// EdgePulldown.test.tsx) — the banner reads the shared registry
// synchronously during render via useSyncExternalStore, so no effect needs
// to fire for this to work under SSR.
import { describe, expect, it, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ShapeErrorBanner from '../ShapeErrorBanner';
import { reportShapeError, clearShapeError } from '../../lib/shapeErrors';

const TABLE = 'tactical_events';

afterEach(() => {
  clearShapeError(TABLE);
});

describe('ShapeErrorBanner — session kind', () => {
  it('a session-kind table renders SESSION EXPIRED, not FEED UNAVAILABLE', () => {
    reportShapeError(TABLE, 'session');
    const html = renderToStaticMarkup(<ShapeErrorBanner />);
    expect(html).toContain('SESSION EXPIRED');
    expect(html).not.toContain('FEED UNAVAILABLE');
  });

  it('a transport-kind table still renders FEED UNAVAILABLE, as today', () => {
    reportShapeError(TABLE, 'transport');
    const html = renderToStaticMarkup(<ShapeErrorBanner />);
    expect(html).toContain('FEED UNAVAILABLE');
  });
});
