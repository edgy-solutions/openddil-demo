// EdgeAttribution renders one row per edge_id (telemetry_latest_state
// grouped by edge_id). An HQ-attached edge's rows are not edge data that
// survives a WAN cut — they write straight to HQ postgres — so the row
// must say so. A tier edge or an edge that declared nothing renders exactly
// as before: no new tag. See deployment.ts's `edgeAttachment` and
// openddil-helm's openddil.validateEdgeAttachment for how `hq`/`tier` are
// declared and checked.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ClassifiedFleetAsset } from '../../../hooks';

vi.mock('../../../hooks', () => ({
  useClassifiedFleet: () => ({ data: MOCK_FLEET, isLoading: false }),
}));
vi.mock('../../../deployment', () => ({
  edgeAttachment: vi.fn(),
}));

import EdgeAttribution from '../EdgeAttribution';
import { edgeAttachment } from '../../../deployment';

const asset = (edge_id: string): ClassifiedFleetAsset => ({
  asset_id: `dis:1:1:${edge_id}`,
  edge_id,
  region_id: 'region-east',
  asset_class: 'SENSOR',
  platform_variant: 'TEST',
  last_sample_at: new Date().toISOString(),
  parent_launcher_id: null,
  firing_event_urn: null,
} as unknown as ClassifiedFleetAsset);

let MOCK_FLEET: ClassifiedFleetAsset[] = [];

describe('EdgeAttribution — HQ-ATTACHED tag', () => {
  beforeEach(() => {
    vi.mocked(edgeAttachment).mockReset();
  });

  it('shows the tag and the tooltip text for an hq-attached edge', () => {
    MOCK_FLEET = [asset('edge-03')];
    vi.mocked(edgeAttachment).mockImplementation((id: string) => (id === 'edge-03' ? 'hq' : undefined));
    const html = renderToStaticMarkup(<EdgeAttribution />);
    expect(html).toContain('HQ-ATTACHED');
    expect(html).toContain('Writes straight to HQ. No edge store: this is not edge data that survives a WAN cut.');
  });

  it('does not show the tag for a tier edge', () => {
    MOCK_FLEET = [asset('edge-01')];
    vi.mocked(edgeAttachment).mockImplementation((id: string) => (id === 'edge-01' ? 'tier' : undefined));
    const html = renderToStaticMarkup(<EdgeAttribution />);
    expect(html).not.toContain('HQ-ATTACHED');
  });

  it('does not show the tag for an undeclared edge', () => {
    MOCK_FLEET = [asset('edge-02')];
    vi.mocked(edgeAttachment).mockImplementation(() => undefined);
    const html = renderToStaticMarkup(<EdgeAttribution />);
    expect(html).not.toContain('HQ-ATTACHED');
  });
});
