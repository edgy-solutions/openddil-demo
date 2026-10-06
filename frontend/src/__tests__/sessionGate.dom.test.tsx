// @vitest-environment jsdom
// =============================================================================
// sessionGate.dom — expiry by 401, end to end through the real gate
// =============================================================================
// Mounts the REAL Root (not a copy of its gate), with only the data hooks
// mocked: @electric-sql/react's useShape (every ElectricSQL-backed hook in
// the tree funnels through it — see test-support/mockElectric.ts) and
// useWanLink (the one hook that fetches on its own via a real network
// call). /auth/me is answered by test-support/fetchAuthMe.ts.
//
// vi.mock(...) calls are written directly in this file, not imported from a
// helper, so Vitest's per-file hoisting transform has no cross-module
// ordering to get wrong.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
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
vi.mock('../hooks/useWanLink', () => ({
  useWanLink: () => ({ enabled: true, set: () => {}, forbidden: false, error: false }),
}));
// The 3D fleet-array view needs a real WebGL/ResizeObserver environment
// jsdom doesn't provide; it has no bearing on the session-expiry gate, so
// it's stubbed to a plain div rather than teaching jsdom to run WebGL.
vi.mock('../components/DiagnosticCanvas', () => ({ default: () => null }));

beforeEach(() => {
  resetSessionDomState();
});

afterEach(() => {
  cleanup();
  resetSessionDomState();
});

describe('session gate — expiry by 401', () => {
  it('unmounts the fleet data and shows sign-in, with next= carrying the current path', async () => {
    goToDemoLeafPath('?role=maintainer');
    installAuthMeFetch({ mode: 'ok', deltaSeconds: 3600 });
    primeSentinelFleet();

    render(<Root />);

    await screen.findByText(SENTINEL);

    // The 401: a shape request (any table) classifies as 'session' and
    // marks the gate. tactical_events is not an unlabelable table and
    // isn't the one carrying the sentinel, so this isolates the signal
    // from the fleet data itself.
    await act(async () => {
      __setMockShape('tactical_events', {
        isError: true,
        error: new FetchError(401, undefined, undefined, {}, '/electric/v1/shape'),
      });
    });

    await waitFor(() => {
      expect(document.body.textContent).not.toContain(SENTINEL);
    });

    const signIn = await screen.findByRole('link', { name: /sign in/i });
    const href = signIn.getAttribute('href') ?? '';
    expect(href).toContain('next=');
    expect(decodeURIComponent(href)).toContain('/demo?role=maintainer');
  });
});
