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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { __setChildLinksForTest } from '../../../deployment';
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

describe('HqHeader row placement (by declared shape)', () => {
  const MARKERS = ['link-seg-edge-hub', 'link-seg-hub-hq', 'link-direct-edge-hq'];
  // Markup of one segment: from its testid to the next marker (or the end).
  function section(html: string, id: string): string {
    const start = html.indexOf(`data-testid="${id}"`);
    if (start < 0) return '';
    const ends = MARKERS.map((m) => html.indexOf(`data-testid="${m}"`, start + 1)).filter((i) => i > 0);
    return html.slice(start, ends.length ? Math.min(...ends) : undefined);
  }
  const TOGGLE_E = 'id="link-toggle-edge-03"';
  const TOGGLE_R = 'id="link-toggle-region-east"';
  const TITLE = 'link shape not declared in deployment.json';

  afterEach(() => __setChildLinksForTest(undefined));

  it('puts a rollup row on the hub->HQ segment and a leaf row on the direct line', () => {
    __setChildLinksForTest([
      { id: 'region-east', hasChildren: true },
      { id: 'edge-03', hasChildren: false },
    ]);
    setStatus(SEVERED_STATUS);
    const html = renderToStaticMarkup(<HqHeader linkControl={control()} />);
    expect(section(html, 'link-seg-hub-hq')).toContain(TOGGLE_R);
    expect(section(html, 'link-seg-hub-hq')).not.toContain(TOGGLE_E);
    expect(section(html, 'link-direct-edge-hq')).toContain(TOGGLE_E);
    expect(section(html, 'link-direct-edge-hq')).not.toContain(TOGGLE_R);
    // Structural guard: the wrapper shares row 1's tracks and the leaf rows
    // sit in the hub column (layout itself is proven in a browser).
    expect(section(html, 'link-direct-edge-hq')).toContain('grid-cols-subgrid');
    expect(section(html, 'link-direct-edge-hq')).toContain('col-start-3');
    expect(section(html, 'link-seg-edge-hub')).not.toContain('link-toggle-');
    expect(html).not.toContain(TITLE);
  });

  it('puts undeclared rows on the edge->hub segment with the title, and draws no direct line', () => {
    __setChildLinksForTest(undefined);
    setStatus(SEVERED_STATUS);
    const html = renderToStaticMarkup(<HqHeader linkControl={control()} />);
    const seg = section(html, 'link-seg-edge-hub');
    expect(seg).toContain(TOGGLE_E);
    expect(seg).toContain(TOGGLE_R);
    expect(seg.match(new RegExp(TITLE, 'g'))).toHaveLength(2);
    expect(html).not.toContain('link-direct-edge-hq');
  });

  it('draws no direct line when only a rollup child is declared', () => {
    __setChildLinksForTest([{ id: 'region-east', hasChildren: true }]);
    setStatus(SEVERED_STATUS);
    const html = renderToStaticMarkup(
      <HqHeader linkControl={control({ children: [{ id: 'region-east', enabled: false, toxics: null }] })} />,
    );
    expect(html).not.toContain('link-direct-edge-hq');
    expect(section(html, 'link-seg-hub-hq')).toContain(TOGGLE_R);
  });
});
