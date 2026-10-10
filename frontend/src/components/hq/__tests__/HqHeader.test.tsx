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
// HQ is the root of the tree: it has no uplink, so the header carries no
// link toggle and no uplink label. Each link is cut from its child's screen
// (and from the DIRECT LINKS card for HQ's direct children).
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

const SEVERED_STATUS: EdgeBufferStatus = {
  bridge_group_lag: 5,
  hq_link_severed: true,
  probe_healthy: true,
  updated_at: new Date().toISOString(),
};

describe('HqHeader', () => {
  it('renders no link toggle and no HQ UPLINK label', () => {
    setStatus(SEVERED_STATUS);
    const html = renderToStaticMarkup(<HqHeader />);
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain('HQ UPLINK');
  });

  it('keeps the global buffer backlog', () => {
    setStatus(SEVERED_STATUS);
    const html = renderToStaticMarkup(<HqHeader />);
    expect(html).toContain('GLOBAL BUFFER BACKLOG');
  });
});
