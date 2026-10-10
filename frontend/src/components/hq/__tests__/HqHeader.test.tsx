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
// uplink toggle or label. Its direct-link rows (one per direct child) live in
// the header strip.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { EdgeBufferStatus } from '../../../hooks';
import type { UseLinkControlResult } from '../../../hooks/useLinkControl';

const mockUseEdgeBuffer = vi.fn();
vi.mock('../../../hooks', () => ({
  useEdgeBuffer: () => mockUseEdgeBuffer(),
  useLinkStatus: () => ({ links: new Map(), isLoading: false, isError: false }),
}));

const NO_TOXICS = { latency_ms: 0, jitter_ms: 0, bandwidth_kb_s: 0 };
function control(over: Partial<UseLinkControlResult> = {}): UseLinkControlResult {
  return {
    status: 'ready',
    uplink: null,
    children: [
      { id: 'edge-03', enabled: true, toxics: NO_TOXICS },
      { id: 'region-east', enabled: false, toxics: null },
    ],
    set: () => {},
    setToxics: () => {},
    ...over,
  };
}

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
  it('renders no uplink toggle and no HQ UPLINK label', () => {
    setStatus(SEVERED_STATUS);
    const html = renderToStaticMarkup(<HqHeader linkControl={control({ status: 'off', children: [] })} />);
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain('HQ UPLINK');
  });

  it('keeps the global buffer backlog', () => {
    setStatus(SEVERED_STATUS);
    const html = renderToStaticMarkup(<HqHeader linkControl={control()} />);
    expect(html).toContain('GLOBAL BUFFER BACKLOG');
  });

  it('renders one row per direct child with its toggle and toxics when control is on', () => {
    setStatus(SEVERED_STATUS);
    const html = renderToStaticMarkup(<HqHeader linkControl={control()} />);
    expect(html).toContain('id="link-toggle-edge-03"');
    expect(html).toContain('id="link-toggle-region-east"');
    expect(html).toContain('id="link-toxics-edge-03-latency"');
    expect(html.match(/id="link-toggle-/g)).toHaveLength(2);
  });

  it('renders no decorative dots', () => {
    setStatus(SEVERED_STATUS);
    const html = renderToStaticMarkup(<HqHeader linkControl={control({ status: 'off', children: [] })} />);
    expect(html).not.toContain('w-3 h-3 rounded-full bg-emerald-500');
    expect(html).not.toContain('link-toggle-');
  });
});
