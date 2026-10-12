// @vitest-environment jsdom
// =============================================================================
// assetRoundTrip.dom — ?asset= survives a reload and a selection change
// =============================================================================
// Same contract as ?role= (Root.tsx:44, 68-72): an initial URL carrying
// ?asset=X selects X, and changing the selection updates the URL in place
// — keeping ?role= — rather than replacing it. The production code
// (MaintainerApp.tsx's pendingDeepLinkAsset resolution + its ?asset= sync
// effect) already does this; this test is new, the code is not.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import Root from '../Root';
import { installAuthMeFetch } from '../test-support/fetchAuthMe';
import {
  goToDemoLeafPath,
  primeSentinelFleet,
  resetSessionDomState,
  secondFleetRow,
  sentinelFleetRow,
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
});

afterEach(() => {
  cleanup();
  resetSessionDomState();
});

const ASSET_A = 'dis:1:1:7731';
const ASSET_B = 'dis:1:1:7732';

describe('?asset= round-trip', () => {
  it('an initial ?asset=X selects X, and switching assets updates the URL while keeping ?role=', async () => {
    goToDemoLeafPath(`?role=maintainer&asset=${ASSET_B}`);
    installAuthMeFetch({ mode: 'ok', deltaSeconds: 3600 });
    primeSentinelFleet(sentinelFleetRow(), secondFleetRow());

    const { container } = render(<Root />);

    const switchBtn = await waitFor(() => {
      const el = container.querySelector('button[aria-label="Switch asset"]');
      const ident = container.querySelector('[data-testid="asset-identity"]');
      if (!el || !ident?.textContent?.includes(ASSET_B)) throw new Error('asset switcher not yet resolved to the deep-linked asset');
      return el;
    });

    fireEvent.click(switchBtn);
    const option = await waitFor(() => {
      const el = container.querySelector(`[role="option"][aria-label^="${ASSET_A}"]`);
      if (!el) throw new Error('option for ASSET_A not listed');
      return el;
    });
    fireEvent.click(option);

    await waitFor(() => {
      const url = new URL(window.location.href);
      expect(url.searchParams.get('asset')).toBe(ASSET_A);
    });
    const url = new URL(window.location.href);
    expect(url.searchParams.get('role')).toBe('maintainer');
  });
});
