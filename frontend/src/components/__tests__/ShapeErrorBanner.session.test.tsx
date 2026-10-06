// Expiry is not link loss, and this banner is where that split now shows:
// a session-kind error (a 401) goes to the whole-screen gate in Root.tsx,
// which unmounts the panels — it must render NOTHING here, not "SESSION
// EXPIRED … last copy" over data that is about to be removed from the DOM
// anyway. Uses renderToStaticMarkup (see EdgePulldown.test.tsx) — the
// banner reads the shared registry synchronously during render via
// useSyncExternalStore, so no effect needs to fire for this to work under
// SSR.
import { describe, expect, it, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ShapeErrorBanner from '../ShapeErrorBanner';
import { reportShapeError, clearShapeError } from '../../lib/shapeErrors';
import { __resetSessionExpiryForTest } from '../../lib/sessionExpiry';

const TABLE = 'tactical_events';

afterEach(() => {
  clearShapeError(TABLE);
  __resetSessionExpiryForTest();
});

describe('ShapeErrorBanner — session kind', () => {
  it('a session-kind table renders nothing — neither SESSION EXPIRED nor FEED UNAVAILABLE', () => {
    reportShapeError(TABLE, 'session');
    const html = renderToStaticMarkup(<ShapeErrorBanner />);
    expect(html).not.toContain('SESSION EXPIRED');
    expect(html).not.toContain('FEED UNAVAILABLE');
  });

  it('a transport-kind table still renders FEED UNAVAILABLE, as today', () => {
    reportShapeError(TABLE, 'transport');
    const html = renderToStaticMarkup(<ShapeErrorBanner />);
    expect(html).toContain('FEED UNAVAILABLE');
  });
});
