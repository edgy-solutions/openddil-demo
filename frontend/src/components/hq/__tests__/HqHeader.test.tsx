// Exercised with renderToStaticMarkup for the same reason as
// EdgePulldown.test.tsx: no @testing-library/react / jsdom in this
// project's dev deps.
//
// Importing HqHeader at all pulls in '../../hooks' (useEdgeBuffer), which
// through electric.ts touches `window` at module scope -- not available
// under this project's Node (non-jsdom) vitest environment. Mocked here
// for that reason alone, same as TheaterReadinessPosture.test.tsx,
// independent of anything under test.
//
// forbidden means the PEP answered 401/403 to the WAN-control GET/POST:
// this subject does not hold the WAN-control role. The toggle must render
// disabled and explained ("WAN control: supervisor only"), and must NOT
// borrow the severed/error styling — being refused a capability is not
// the link being down. The status label itself is a separate claim (it
// comes from edge_buffer_status via useEdgeBuffer, not from the proxy),
// so forbidden must never replace it -- only add a caption alongside it.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { EdgeBufferStatus } from '../../../hooks';

const mockUseEdgeBuffer = vi.fn();
vi.mock('../../../hooks', () => ({
  useEdgeBuffer: () => mockUseEdgeBuffer(),
}));

import HqHeader from '../HqHeader';

function setStatus(status: EdgeBufferStatus | null): void {
  mockUseEdgeBuffer.mockReturnValue({ status, isError: false });
}

const ACTIVE_STATUS: EdgeBufferStatus = {
  bridge_group_lag: 0,
  hq_link_severed: false,
  probe_healthy: true,
  updated_at: new Date().toISOString(),
};

const SEVERED_STATUS: EdgeBufferStatus = {
  ...ACTIVE_STATUS,
  hq_link_severed: true,
};

describe('HqHeader', () => {
  it('forbidden renders the WAN toggle disabled with "WAN control: supervisor only"', () => {
    setStatus(null);
    const html = renderToStaticMarkup(
      <HqHeader wanActive={null} setWanActive={() => {}} forbidden={true} />,
    );
    expect(html).toContain('WAN control: supervisor only');
    expect(html).toMatch(/<input[^>]*disabled=""[^>]*>/);
  });

  it('not forbidden, link active -> no forbidden text, toggle not disabled', () => {
    setStatus(ACTIVE_STATUS);
    const html = renderToStaticMarkup(
      <HqHeader wanActive={true} setWanActive={() => {}} forbidden={false} />,
    );
    expect(html).not.toContain('WAN control: supervisor only');
    expect(html).not.toMatch(/<input[^>]*disabled=""[^>]*>/);
  });

  it('forbidden + not-severed status: the status label AND the caption both render', () => {
    setStatus(ACTIVE_STATUS);
    const html = renderToStaticMarkup(
      <HqHeader wanActive={null} setWanActive={() => {}} forbidden={true} />,
    );
    expect(html).toContain('HQ UPLINK: ACTIVE');
    expect(html).toContain('WAN control: supervisor only');
  });

  it('forbidden + severed status: "HQ UPLINK: SEVERED" AND the caption both render', () => {
    setStatus(SEVERED_STATUS);
    const html = renderToStaticMarkup(
      <HqHeader wanActive={null} setWanActive={() => {}} forbidden={true} />,
    );
    expect(html).toContain('HQ UPLINK: SEVERED');
    expect(html).toContain('WAN control: supervisor only');
  });
});
