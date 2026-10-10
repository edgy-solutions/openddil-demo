// Exercised with renderToStaticMarkup for the same reason as
// EdgePulldown.test.tsx: no @testing-library/react / jsdom in this
// project's dev deps.
//
// Importing RegionalHeader pulls in '../../../hooks' (useEdgeBuffer) and
// useLinkStatus, which through electric.ts touch `window` at module scope --
// not available under this project's Node (non-jsdom) vitest environment.
// Both are mocked here for that reason alone, same as HqHeader.test.tsx.
//
// Two separate links, two separate claims: the left segment lists each child
// edge's own link (toggle = commanded, word = observed link_status row); the
// right segment is this hub's own uplink (observed via edge_buffer_status).
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { EdgeBufferStatus } from '../../../hooks';
import type { UseLinkControlResult } from '../../../hooks/useLinkControl';
import type { LinkStatusRow } from '../../../lib/linkStatus';

const mockUseEdgeBuffer = vi.fn();
vi.mock('../../../hooks', () => ({
  useEdgeBuffer: () => mockUseEdgeBuffer(),
}));
const mockUseLinkStatus = vi.fn();
vi.mock('../../../hooks/useLinkStatus', () => ({
  useLinkStatus: () => mockUseLinkStatus(),
}));

import RegionalHeader from '../RegionalHeader';

const SEVERED_STATUS: EdgeBufferStatus = {
  bridge_group_lag: 0,
  hq_link_severed: true,
  probe_healthy: true,
  updated_at: new Date().toISOString(),
};

function row(id: string, state: string): LinkStatusRow {
  return {
    id, link_state: state, traffic: 'none', declared_idle: false,
    heartbeat_age_s: 1, last_heartbeat_at: null, bridge_lag: 0,
    updated_at: new Date().toISOString(),
  };
}

function setup(rows: LinkStatusRow[]): void {
  mockUseEdgeBuffer.mockReturnValue({ status: SEVERED_STATUS, isError: false });
  mockUseLinkStatus.mockReturnValue({
    links: new Map(rows.map((r) => [r.id, r])), isLoading: false, isError: false,
  });
}

function control(over: Partial<UseLinkControlResult>): UseLinkControlResult {
  return {
    status: 'ready',
    uplink: { parent: 'hq', enabled: true },
    children: [{ id: 'edge-01', enabled: true }, { id: 'edge-02', enabled: false }],
    set: () => {},
    ...over,
  };
}

function render(linkControl: UseLinkControlResult): string {
  return renderToStaticMarkup(
    <RegionalHeader linkControl={linkControl} setIsRuleEditorOpen={() => {}} />,
  );
}

describe('RegionalHeader', () => {
  it('one row per child with its own checkbox and observed state word', () => {
    setup([row('edge-01', 'down')]);
    const html = render(control({}));
    expect(html).toContain('edge-01');
    expect(html).toContain('edge-02');
    expect(html).toContain('id="link-toggle-edge-01"');
    expect(html).toContain('id="link-toggle-edge-02"');
    expect(html).toContain('>DOWN<');
    expect(html).toContain('>UNKNOWN<');
  });

  it('uplink segment names the parent and keeps the REGIONAL-HQ label', () => {
    setup([]);
    const html = render(control({}));
    expect(html).toContain('UPLINK TO HQ');
    expect(html).toContain('id="rtoggle1"');
    expect(html).toContain('REGIONAL↔HQ: SEVERED');
  });

  it('off: rows render from link_status ids, no checkboxes', () => {
    setup([row('edge-07', 'up'), row('edge-03', 'idle')]);
    const html = render(control({ status: 'off', uplink: null, children: [] }));
    expect(html).not.toContain('type="checkbox"');
    expect(html).toContain('edge-03');
    expect(html).toContain('edge-07');
    expect(html.indexOf('edge-03')).toBeLessThan(html.indexOf('edge-07'));
    expect(html).toContain('>UP<');
    // The parent is named only by the listing; off means it is not known here.
    expect(html).toContain('>UPLINK<');
    expect(html).not.toContain('UPLINK TO');
  });

  it('forbidden: disabled checkboxes and the caption; observed words stay', () => {
    setup([row('edge-01', 'up')]);
    const html = render(control({
      status: 'forbidden',
      uplink: { parent: 'hq', enabled: null },
      children: [{ id: 'edge-01', enabled: null }],
    }));
    expect(html).toMatch(/<input[^>]*disabled=""/);
    expect(html).toContain('Link control: not authorised');
    expect(html).toContain('>UP<');
    expect(html).toContain('REGIONAL↔HQ: SEVERED');
  });
});
