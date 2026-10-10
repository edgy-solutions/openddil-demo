// @vitest-environment jsdom
// =============================================================================
// sessionDeadline.dom — expiry by local deadline, no 401 involved
// =============================================================================
// Source (c) of lib/sessionExpiry.ts: the browser's own clock reaching
// expires_at - server_time seconds after the /auth/me answer, with no
// shape error and no re-check 401 in the picture at all.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import Root from '../Root';
import { installAuthMeFetch } from '../test-support/fetchAuthMe';
import {
  SENTINEL,
  goToDemoLeafPath,
  primeSentinelFleet,
  resetSessionDomState,
} from '../test-support/sessionDom';

vi.mock('@electric-sql/react', () => import('../test-support/mockElectric'));
vi.mock('../hooks/useLinkControl', () => ({
  useLinkControl: () => ({ status: 'off', uplink: null, children: [], set: () => {}, setToxics: () => {} }),
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

describe('session gate — expiry by deadline', () => {
  it('sentinel present at 119s, gone 2s after the 120s deadline', async () => {
    goToDemoLeafPath();
    installAuthMeFetch({ mode: 'ok', deltaSeconds: 120 });
    primeSentinelFleet();

    render(<Root />);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(document.body.textContent).toContain(SENTINEL);

    await act(async () => { await vi.advanceTimersByTimeAsync(119_000); });
    expect(document.body.textContent).toContain(SENTINEL);

    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(document.body.textContent).not.toContain(SENTINEL);
  });
});
