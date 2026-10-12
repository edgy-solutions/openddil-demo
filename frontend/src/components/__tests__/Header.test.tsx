// @vitest-environment jsdom
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
import { renderOpen as renderToStaticMarkup } from '../network/__tests__/openPopover';
import { cleanup, render as rtlRender } from '@testing-library/react';
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

function render(linkControl: UseLinkControlResult, expandRows = false): string {
  return renderToStaticMarkup(
    <Header linkControl={linkControl} />,
    { expandRows },
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
    // The shaping group lives in the expanded uplink row.
    const html = render(control({}), true);
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

describe('Header — network pill and popover', () => {
  const HEALTHY: EdgeBufferStatus = { ...SEVERED_STATUS, hq_link_severed: false };
  const dotTone = (html: string) => /data-testid="network-pill-dot" data-tone="(\w+)"/.exec(html)?.[1];

  it('the pill dot follows the observed indicator', () => {
    setStatus(SEVERED_STATUS);
    expect(dotTone(render(control({})))).toBe('bad');
    setStatus(HEALTHY);
    expect(dotTone(render(control({})))).toBe('ok');
    setStatus({ ...HEALTHY, probe_healthy: false });
    expect(dotTone(render(control({})))).toBe('warn');
    setStatus(null);
    expect(dotTone(render(control({})))).toBe('neutral');
  });

  it('the pill carries the count, the buffer label and the dialog semantics', () => {
    setStatus({ ...HEALTHY, bridge_group_lag: 1500 });
    __setDeploymentForTest({ id: 'edge-a', scope: null, has_children: false, parent: 'region-east' });
    try {
      const html = render(control({}));
      expect(html).toContain('aria-haspopup="dialog"');
      expect(html).toContain('1.5K');
      expect(html).toContain('UPLINK BUFFER → region-east');
    } finally {
      __setDeploymentForTest(undefined);
    }
  });

  it('an edge under a region shows only itself and the parent: one link row, no HQ node', () => {
    setStatus(SEVERED_STATUS);
    __setDeploymentForTest({ id: 'edge-a', scope: null, has_children: false, parent: 'region-east' });
    try {
      const html = render(control({}));
      expect(html).not.toContain('CENTRAL HQ');
      expect(html).toContain('UPLINK');
      expect(html.match(/type="checkbox"/g)).toHaveLength(1);
      expect(html.match(/aria-label="[^"]* to [^"]*"/g)).toHaveLength(1);
    } finally {
      __setDeploymentForTest(undefined);
    }
  });
});

describe('Header — top-bar summary (popover closed)', () => {
  function closed(): string {
    cleanup();
    return rtlRender(<Header linkControl={control({})} />).container.innerHTML;
  }

  it('shows the link word, buffer value, MSGS and the parent-named label without opening', () => {
    setStatus(SEVERED_STATUS);
    __setDeploymentForTest({ id: 'edge-a', scope: null, has_children: false, parent: 'region-east' });
    try {
      const html = closed();
      expect(html).toContain('DDIL: LINK SEVERED');
      expect(html).toContain('buffer-value');
      expect(html).toContain('MSGS');
      expect(html).toContain('UPLINK BUFFER → region-east');
    } finally {
      __setDeploymentForTest(undefined);
    }
  });

  it('a healthy link says UPLINK: LINK UP', () => {
    setStatus({ ...SEVERED_STATUS, hq_link_severed: false });
    expect(closed()).toContain('UPLINK: LINK UP');
  });

  it('renders no banner of its own', () => {
    setStatus(SEVERED_STATUS);
    const html = closed();
    expect(html).not.toContain('<header');
    expect(html).not.toContain('class="panel');
  });

  it('the word and the buffer value each appear once with the popover open', () => {
    setStatus(SEVERED_STATUS);
    const html = render(control({}));
    expect(html.match(/data-testid="buffer-value"/g)).toHaveLength(1);
    expect(html.match(/data-testid="link-indicator"/g)).toHaveLength(1);
  });
});
