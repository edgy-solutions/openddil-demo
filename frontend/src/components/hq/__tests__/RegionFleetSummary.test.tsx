// @vitest-environment jsdom
// RegionFleetSummary — element band columns from window rollups, and the
// pure per-region summing they rest on.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import type { TelemetryWindows } from '../../../hooks/useTelemetryWindows';

let WINDOWS: TelemetryWindows[] = [];
let FLEET: { region_id: string | null; posture_status: string }[] = [];
const region = (id: string) => ({
  region_id: id, nominal: 1, degraded: 0, critical: 0, non_operational: 0,
  destroyed: 0, deactivated: 0, removed: 0, asset_count: 1,
  observed_at: new Date().toISOString(),
});

vi.mock('../../../hooks', () => ({
  useRegionFleetSummary: () => ({
    data: [region('region-east'), region('region-west')],
    isLoading: false,
  }),
  useAllTelemetryWindows: () => ({ data: WINDOWS, isLoading: false }),
  useFleetAssets: () => ({ data: FLEET, isLoading: false }),
}));

import RegionFleetSummary from '../RegionFleetSummary';
import { elementCountsByRegion } from '../../../hooks/useTelemetryWindows';

const win = (
  region_id: string | null,
  element_rollup: Record<string, unknown> | null,
): TelemetryWindows =>
  ({ asset_id: 'a', edge_id: 'e', region_id, element_rollup }) as unknown as TelemetryWindows;

describe('elementCountsByRegion', () => {
  it('sums per region, zeroes absent keys, parses strings, buckets null region, skips no-rollup rows', () => {
    const m = elementCountsByRegion([
      win('region-east', { element_count: 4, critical_count: 1, degraded_count: 2 }),
      win('region-east', { element_count: '3', critical_count: '2' }),
      win('region-west', {}),
      win(null, { element_count: 5, critical_count: 5, degraded_count: 1 }),
      win('region-west', null),
    ]);
    expect(m.get('region-east')).toEqual({ critical: 3, degraded: 2, elements: 7, rollups: 2 });
    expect(m.get('region-west')).toEqual({ critical: 0, degraded: 0, elements: 0, rollups: 1 });
    expect(m.get('')).toEqual({ critical: 5, degraded: 1, elements: 5, rollups: 1 });
    expect(m.size).toBe(3);
  });
});

describe('RegionFleetSummary element columns', () => {
  const cell = (html: string, id: string) =>
    new RegExp(`data-testid="${id}"[^>]*>([^<]*)<`).exec(html)?.[1];

  it('shows summed counts for a region with rollups and an em dash without', () => {
    WINDOWS = [
      win('region-east', { critical_count: 2, degraded_count: 1 }),
      win('region-east', { critical_count: 1 }),
    ];
    const html = renderToStaticMarkup(<RegionFleetSummary />);
    expect(cell(html, 'region-elements-critical-region-east')).toBe('3');
    expect(cell(html, 'region-elements-degraded-region-east')).toBe('1');
    expect(cell(html, 'region-elements-critical-region-west')).toBe('—');
    expect(cell(html, 'region-elements-degraded-region-west')).toBe('—');
    expect(html).not.toContain('region-elements-unattributed');
  });

  it('shows the unattributed footer only when a rollup has no region', () => {
    WINDOWS = [win(null, { critical_count: 1 }), win(null, { critical_count: 1 })];
    const html = renderToStaticMarkup(<RegionFleetSummary />);
    expect(html).toContain('region-elements-unattributed');
    expect(html).toContain('2 element rollup(s) without a region');
  });

  it('counts posture per region from the asset rows and shows a dash for a region with none', () => {
    FLEET = [
      { region_id: 'region-east', posture_status: 'emplaced' },
      { region_id: 'region-east', posture_status: 'emplaced' },
      { region_id: 'region-east', posture_status: 'moving' },
    ];
    const html = renderToStaticMarkup(<RegionFleetSummary />);
    expect(cell(html, 'region-posture-emplaced-region-east')).toBe('2');
    expect(cell(html, 'region-posture-moving-region-east')).toBe('1');
    expect(cell(html, 'region-posture-emplacing-region-east')).toBe('0');
    expect(cell(html, 'region-posture-emplaced-region-west')).toBe('—');
    expect(cell(html, 'region-posture-march_ordered-region-west')).toBe('—');
  });
});
