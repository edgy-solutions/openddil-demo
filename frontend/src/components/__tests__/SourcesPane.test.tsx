// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SourcesPaneView } from '../SourcesPane';
import type { Band, SourcesBody } from '../../lib/sources';

const body = (
  o: Band | null, d: Band | null, v: Band | null,
  over: { silent?: boolean; noCm?: boolean; noLogi?: boolean; disc?: boolean } = {},
): SourcesBody => ({
  asset_id: 'dis:1:1:1010',
  platform_variant: 'MRAD_Sensor',
  served_at: '2026-10-29T12:00:00Z',
  sources: {
    observed: {
      record: { operational_status: 'operational', health_state: 'HEALTHY',
                reporting_status: over.silent ? 'not_reporting' : 'reporting',
                last_sample_at: '2026-10-29T11:00:00Z' },
      band: o, tier: 'edge-01', source: 'sim-dis', time: '2026-10-29T11:00:00Z',
      silent: !!over.silent,
    },
    declared: over.noCm
      ? { record: null, band: null, tier: null, source: 'cm-service', time: null }
      : {
          record: { overall_status: 'CONFIG_STATUS_NOT_MISSION_CAPABLE', lifecycle: 'L',
                    baseline_id: 'BL-1', as_of: '2026-10-29T11:30:00Z',
                    manual_discrepancies: over.disc
                      ? [{ fault_code: 'FC-100', component: 'ENG-1', description: 'd', severity: 'MAJOR' }]
                      : [],
                    declaration: null },
          band: d, tier: 'edge-01', source: 'cm-service', time: '2026-10-29T11:30:00Z',
        },
    derived: over.noLogi
      ? { record: null, band: null, tier: null, source: 'fusion', time: null }
      : {
          record: { overall_severity: 'LOGISTICS_SEVERITY_OK', constraining_factors: [] },
          band: v, tier: 'edge-01', source: 'fusion', time: '2026-10-29T11:45:00Z',
        },
  },
});

const state = (id: string) => screen.getByTestId(id).getAttribute('data-state');

describe('SourcesPane', () => {
  afterEach(cleanup);

  it('agree: all three marks read agree', () => {
    render(<SourcesPaneView data={body('ready', 'ready', 'ready')} />);
    expect(state('mark-observed-declared')).toBe('agree');
    expect(state('mark-observed-derived')).toBe('agree');
    expect(state('mark-declared-derived')).toBe('agree');
  });

  it('1010-like: observed vs declared is marked and names both bands', () => {
    render(<SourcesPaneView data={body('ready', 'not-ready', 'ready', { disc: true })} />);
    expect(state('mark-observed-declared')).toBe('marked');
    expect(screen.getByTestId('mark-observed-declared').textContent).toContain('ready vs not-ready');
    expect(state('mark-observed-derived')).toBe('agree');
    expect(screen.getByTestId('discrepancies').textContent).toContain('FC-100');
    expect(screen.getByTestId('discrepancies').textContent).toContain('ENG-1');
  });

  it('silent: observed vs derived is marked and silent since is shown', () => {
    render(<SourcesPaneView data={body('ready', 'ready', 'limited', { silent: true })} />);
    expect(state('mark-observed-derived')).toBe('marked');
    expect(screen.getByTestId('silent').textContent).toContain('silent since');
  });

  it('missing rows: no-band', () => {
    render(<SourcesPaneView data={body('ready', null, null, { noCm: true, noLogi: true })} />);
    expect(state('mark-observed-declared')).toBe('no-band');
    expect(state('mark-observed-derived')).toBe('no-band');
    expect(state('mark-declared-derived')).toBe('no-band');
    expect(screen.getByTestId('col-declared').textContent).toContain('no record visible here');
  });

  it('columns are in order Observed, Declared, Derived', () => {
    render(<SourcesPaneView data={body('ready', 'ready', 'ready')} />);
    const ids = Array.from(document.querySelectorAll('[data-testid^="col-"]')).map(
      (e) => e.getAttribute('data-testid'));
    expect(ids).toEqual(['col-observed', 'col-declared', 'col-derived']);
  });

  it('no rollup: three bands, no combined wording, no reduction in source', () => {
    const { container } = render(
      <SourcesPaneView data={body('ready', 'not-ready', 'limited', { disc: true })} />);
    expect(container.querySelectorAll('[data-testid^="band-"]').length).toBe(3);
    const bad = /readiness|overall|rollup|summary|score/i;
    for (const el of Array.from(container.querySelectorAll('*'))) {
      if (el.closest('[data-testid^="col-"]')) continue;
      const own = Array.from(el.childNodes)
        .filter((n) => n.nodeType === 3).map((n) => n.textContent).join('');
      expect(own).not.toMatch(bad);
    }
    const forbidden = /\b(worst|rollup|readiness|overallBand|combinedBand)\b/;
    for (const f of ['../SourcesPane.tsx', '../../lib/sources.ts']) {
      const src = readFileSync(resolve(__dirname, f), 'utf-8');
      expect(src).not.toMatch(forbidden);
    }
  });
});
