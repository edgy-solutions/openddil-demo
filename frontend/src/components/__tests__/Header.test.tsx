// Exercised with renderToStaticMarkup for the same reason as
// EdgePulldown.test.tsx: no @testing-library/react / jsdom in this
// project's dev deps.
//
// Importing Header at all pulls in '../hooks' (useEdgeBuffer), which
// through electric.ts touches `window` at module scope -- not available
// under this project's Node (non-jsdom) vitest environment. Mocked here
// for that reason alone, same as HqHeader.test.tsx.
//
// The reachability label is a claim about the observed edge_buffer_status
// row (via useLinkIndicator), never about link control. A refused or
// unavailable control must add a caption beside the label, never replace it
// -- otherwise a viewer who may not cut the link loses the honest SEVERED
// signal.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { EdgeBufferStatus } from '../../hooks';
import type { UseLinkControlResult } from '../../hooks/useLinkControl';

const mockUseEdgeBuffer = vi.fn();
vi.mock('../../hooks', () => ({
  useEdgeBuffer: () => mockUseEdgeBuffer(),
}));

import Header from '../Header';
import { __setDeploymentForTest } from '../../deployment';

function setStatus(status: EdgeBufferStatus | null): void {
  mockUseEdgeBuffer.mockReturnValue({ status, isError: false });
}

const SEVERED_STATUS: EdgeBufferStatus = {
  bridge_group_lag: 0,
  hq_link_severed: true,
  probe_healthy: true,
  updated_at: new Date().toISOString(),
};

function control(over: Partial<UseLinkControlResult>): UseLinkControlResult {
  return {
    status: 'ready',
    uplink: { parent: 'region-east', enabled: true, toxics: { latency_ms: 0, jitter_ms: 0, bandwidth_kb_s: 0 } },
    children: [],
    set: () => {},
    setToxics: () => {},
    ...over,
  };
}

function render(linkControl: UseLinkControlResult): string {
  return renderToStaticMarkup(
    <Header
      linkControl={linkControl}
      fleet={[]}
      selectedAsset=""
      setSelectedAsset={() => {}}
      availableEdges={[]}
      selectedEdge={null}
      onSelectEdge={() => {}}
    />,
  );
}

describe('Header', () => {
  it('ready: names the parent and renders an enabled checkbox', () => {
    setStatus(SEVERED_STATUS);
    const html = render(control({}));
    expect(html).toContain('UPLINK TO REGION-EAST');
    expect(html).toContain('type="checkbox"');
    expect(html).not.toMatch(/<input[^>]*id="toggle1"[^>]*disabled=""/);
    expect(html).toContain('Cut or restore the uplink from this tier to region-east');
  });

  it('off: no checkbox, reachability label still present', () => {
    setStatus(SEVERED_STATUS);
    const html = render(control({ status: 'off', uplink: null }));
    expect(html).not.toContain('type="checkbox"');
    expect(html).toContain('DDIL: LINK SEVERED');
  });

  it('forbidden: disabled checkbox, caption, and the severed label both render', () => {
    setStatus(SEVERED_STATUS);
    const html = render(control({ status: 'forbidden', uplink: { parent: 'region-east', enabled: null, toxics: null } }));
    expect(html).toMatch(/<input[^>]*id="toggle1"[^>]*disabled=""/);
    expect(html).toContain('Link control: not authorised');
    expect(html).toContain('DDIL: LINK SEVERED');
  });

  it('ready but state unknown: disabled with the unknown title', () => {
    setStatus(SEVERED_STATUS);
    const html = render(control({ uplink: { parent: null, enabled: null, toxics: null } }));
    expect(html).toMatch(/<input[^>]*id="toggle1"[^>]*disabled=""/);
    expect(html).toContain('Link state unknown');
    expect(html).toContain('>UPLINK<');
  });
});

describe('Header — parent from tier configuration', () => {
  it('config parent region-east: named with link control off, no toggle', () => {
    setStatus(SEVERED_STATUS);
    __setDeploymentForTest({ id: 'edge-a', scope: null, has_children: false, parent: 'region-east' });
    try {
      const html = render(control({ status: 'off', uplink: null }));
      expect(html).toContain('UPLINK TO REGION-EAST');
      expect(html).toContain('UPLINK BUFFER → region-east');
      expect(html).not.toContain('type="checkbox"');
      expect(html).not.toContain('CENTRAL HQ');
    } finally {
      __setDeploymentForTest(undefined);
    }
  });

  it('config parent is the root: CENTRAL HQ, UPLINK TO HQ, UPLINK BUFFER → HQ', () => {
    setStatus(SEVERED_STATUS);
    __setDeploymentForTest({ id: 'edge-a', scope: null, has_children: false, parent: 'root' });
    try {
      const html = render(control({ status: 'off', uplink: null }));
      expect(html).toContain('CENTRAL HQ');
      expect(html).toContain('UPLINK TO HQ');
      expect(html).toContain('UPLINK BUFFER → HQ');
    } finally {
      __setDeploymentForTest(undefined);
    }
  });
});

describe('Header — uplink toxics', () => {
  it('ready: the uplink toxics group renders beside the toggle', () => {
    setStatus(SEVERED_STATUS);
    const html = render(control({}));
    expect(html).toContain('id="uplink-toxics-latency"');
    expect(html).toContain('id="uplink-toxics-jitter"');
    expect(html).toContain('id="uplink-toxics-bandwidth"');
  });

  it('off: absent', () => {
    setStatus(SEVERED_STATUS);
    const html = render(control({ status: 'off', uplink: null }));
    expect(html).not.toContain('uplink-toxics');
  });
});
