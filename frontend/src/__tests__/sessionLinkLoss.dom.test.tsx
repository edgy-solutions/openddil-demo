// @vitest-environment jsdom
// =============================================================================
// sessionLinkLoss.dom — link loss is not expiry
// =============================================================================
// A network error on the /auth/me re-check, plus a transport (non-401)
// shape error, together: the viewer is still entitled, so the fleet data
// stays on screen with its stale/feed-unavailable marker, and the gate
// must NOT fire.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { FetchError } from '@electric-sql/client';
import Root from '../Root';
import { __setMockShape } from '../test-support/mockElectric';
import { installAuthMeFetch } from '../test-support/fetchAuthMe';
import {
  SENTINEL,
  goToDemoLeafPath,
  primeSentinelFleet,
  resetSessionDomState,
} from '../test-support/sessionDom';

vi.mock('@electric-sql/react', () => import('../test-support/mockElectric'));
vi.mock('../hooks/useLinkControl', () => ({
  useLinkControl: () => ({ status: 'off', uplink: null, children: [], set: () => {} }),
}));
// The 3D fleet-array view needs a real WebGL/ResizeObserver environment
// jsdom doesn't provide; it has no bearing on the session-expiry gate, so
// it's stubbed to a plain div rather than teaching jsdom to run WebGL.
vi.mock('../components/DiagnosticCanvas', () => ({ default: () => null }));

beforeEach(() => {
  resetSessionDomState();
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetSessionDomState();
});

describe('session gate — link loss is not expiry', () => {
  it('keeps the fleet data and the feed-unavailable marker, shows no sign-in screen', async () => {
    goToDemoLeafPath();
    const authMe = installAuthMeFetch({ mode: 'ok', deltaSeconds: 3600 });
    primeSentinelFleet();

    render(<Root />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(document.body.textContent).toContain(SENTINEL);

    // A transport failure — a non-401 error — on an unrelated table.
    await act(async () => {
      __setMockShape('tactical_events', {
        isError: true,
        error: new FetchError(502, undefined, undefined, {}, '/electric/v1/shape'),
      });
    });

    // The re-check 60s later fails as a network error, not a 401.
    authMe.setMode('network-error');
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

    expect(document.body.textContent).toContain(SENTINEL);
    expect(document.body.textContent).toContain('FEED UNAVAILABLE');
    expect(document.body.textContent).not.toContain('SESSION EXPIRED');
    expect(screen.queryByRole('link', { name: /sign in/i })).toBeNull();
  });

  it('a 503 on the re-check (policy service down) keeps the app, not a sign-in screen', async () => {
    goToDemoLeafPath();
    const authMe = installAuthMeFetch({ mode: 'ok', deltaSeconds: 3600 });
    primeSentinelFleet();

    render(<Root />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(document.body.textContent).toContain(SENTINEL);

    authMe.setMode('pdp-unavailable');
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

    expect(document.body.textContent).toContain(SENTINEL);
    expect(document.body.textContent).not.toContain('SESSION EXPIRED');
    expect(screen.queryByRole('link', { name: /sign in/i })).toBeNull();
  });
});
