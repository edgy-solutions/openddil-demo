// An edge asset's status (here, the radar dots and header pill) must never
// depend on the uplink. LocalFleetRadar has no @testing-library/react or
// jsdom in this project's dev deps (see EdgePulldown.test.tsx for the
// project's no-DOM convention), so this uses renderToStaticMarkup, same as
// that file.
//
// Before the fix, LocalFleetRadar took a `degraded` prop (fed from
// MaintainerApp's link-derived state) that (a) drove a NOMINAL/DEGRADED
// header pill and (b) mocked the first asset as COMM_LOST. Neither must
// survive the fix — the prop is deliberately cast away with `as any` here
// so this test still compiles against the fixed signature.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import LocalFleetRadar from '../LocalFleetRadar';

const assets = [
  { id: 'prop:unit-a', type: 'LAUNCHER', node_id: 'edge-01', lat: 1, lon: 1 },
  { id: 'prop:unit-b', type: 'LAUNCHER', node_id: 'edge-01', lat: 2, lon: 2 },
];

function renderWithLinkFlag(linkCut: boolean): string {
  const props = {
    degraded: linkCut,
    localAssets: assets,
    centerLat: 0,
    centerLon: 0,
  } as unknown as Parameters<typeof LocalFleetRadar>[0];
  return renderToStaticMarkup(<LocalFleetRadar {...props} />);
}

describe('LocalFleetRadar — link independence', () => {
  it('renders identically whether the uplink is up or cut', () => {
    const linkUp = renderWithLinkFlag(false);
    const linkCut = renderWithLinkFlag(true);
    expect(linkCut).toBe(linkUp);
  });

  it('never renders the mocked COMM_LOST grey fill (#64748b) from the link flag alone', () => {
    expect(renderWithLinkFlag(true)).not.toContain('#64748b');
  });
});
