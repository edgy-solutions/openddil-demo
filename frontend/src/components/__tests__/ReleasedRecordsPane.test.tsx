// @vitest-environment jsdom
// Same rendering strategy as EgressAdmissionPane.test.tsx: renderToStaticMarkup
// rather than @testing-library/react (not a dev dep here — see
// vitest.config.ts's comment on environment: 'node'). The fixture below is
// shaped exactly like egress/pane_api.py's `/decisions?kind=` response
// (key/body/owning_tier/decided_at beside the same allowed/reason/
// decision_id every record carries), not a hand-built list — this test
// exercises the same JSON shape the endpoint returns, and the same
// JSON-pointer column configuration a deployment supplies at runtime.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReleasedRecordsView, type ReleasedRecordsColumn } from '../releasability/ReleasedRecordsPane';
import { FigureViewBody, type FigureState } from '../releasability/FigureView';
import type { DecisionRecord, DecisionsResponse } from '../../hooks/useEgressAdmission';

function record(
  key: string,
  originator_nation: string | null,
  releasable_to: string[] = [],
  allowed = true,
  body: Record<string, unknown> = {},
): DecisionRecord {
  return {
    asset_id: null,
    originator_nation,
    releasable_to,
    allowed,
    reason: allowed ? null : originator_nation === null ? 'unlabelled' : 'no_nation_overlap',
    decision_id: `dec-${key}`,
    key,
    owning_tier: 'edge-01',
    decided_at: '2026-10-02T00:10:00Z',
    body,
  };
}

const COLUMNS: ReleasedRecordsColumn[] = [
  { header: 'task', pointer: '/task' },
  { header: 'parts', pointer: '/parts' },
  { header: 'first part', pointer: '/parts/0/ref' },
  { header: 'origin', pointer: '/source/site' },
];

const FIXTURE: DecisionsResponse = {
  destination: 'system:records-dest-test',
  policy_version: 'policy-test',
  corpus_version: 'corpus-test',
  admitted: 2,
  refused: 1,
  records: [
    record('rec-1', 'ATL', [], true, {
      task: 'replace component at position 2',
      parts: [{ ref: 'PN-1234', quantity: 1 }],
      source: { site: 'edge-01' },
    }),
    record('rec-3', 'ATL', ['BDR'], true, { task: 'inspect assembly' }),
    record('rec-4', null, [], false, {}),
  ],
};

describe('ReleasedRecordsPane ReleasedRecordsView', () => {
  it('renders the headline as 2 of 3 admitted', () => {
    const html = renderToStaticMarkup(<ReleasedRecordsView data={FIXTURE} columns={COLUMNS} />);
    expect(html).toMatch(/2<\/span>[\s\S]*?of[\s\S]*?3/);
  });

  it('renders one row per record, keyed, with configured columns resolved by pointer', () => {
    const html = renderToStaticMarkup(<ReleasedRecordsView data={FIXTURE} columns={COLUMNS} />);
    expect(html).toContain('rec-1');
    expect(html).toContain('rec-3');
    expect(html).toContain('rec-4');
    expect(html).toContain('replace component at position 2');
    expect(html).toContain('edge-01');
  });

  it('renders an array found at a pointer as compact JSON text', () => {
    const html = renderToStaticMarkup(<ReleasedRecordsView data={FIXTURE} columns={COLUMNS} />);
    // renderToStaticMarkup HTML-escapes quotes in text content -- assert on
    // the escaped form rather than the raw JSON string.
    expect(html).toContain('[{&quot;ref&quot;:&quot;PN-1234&quot;,&quot;quantity&quot;:1}]');
  });

  it('resolves a nested pointer past an array index', () => {
    const html = renderToStaticMarkup(<ReleasedRecordsView data={FIXTURE} columns={COLUMNS} />);
    expect(html).toContain('PN-1234');
  });

  it('renders an em dash for a pointer with no match', () => {
    const onlyMissing: DecisionsResponse = {
      ...FIXTURE,
      records: [record('rec-missing', 'ATL', [], true, {})],
    };
    const html = renderToStaticMarkup(<ReleasedRecordsView data={onlyMissing} columns={COLUMNS} />);
    expect(html).toContain('—');
  });

  it('renders ADMIT for allowed rows and the refusal reason for refused rows', () => {
    const html = renderToStaticMarkup(<ReleasedRecordsView data={FIXTURE} columns={COLUMNS} />);
    const admitCount = html.split('ADMIT').length - 1;
    expect(admitCount).toBe(2);
    expect(html).toContain('unlabelled');
  });

  it('shows the withheld line with the same semantics as EgressAdmissionPane', () => {
    const withWithheld: DecisionsResponse = {
      ...FIXTURE,
      withheld: 4,
      viewer_nations: ['ATL'],
    };
    const html = renderToStaticMarkup(<ReleasedRecordsView data={withWithheld} columns={COLUMNS} />);
    expect(html).toContain('4');
    expect(html).toContain('withheld — unlabelled, so shown to no one, including fully entitled viewers');
    expect(html).toContain('viewing as ATL');
  });

  it('shows "no records visible" when records is empty', () => {
    const empty: DecisionsResponse = {
      destination: 'system:records-dest-test',
      policy_version: 'policy-test',
      corpus_version: 'corpus-test',
      admitted: 0,
      refused: 0,
      withheld: 4,
      viewer_nations: ['BDR'],
      records: [],
    };
    const html = renderToStaticMarkup(<ReleasedRecordsView data={empty} columns={COLUMNS} />);
    expect(html).toContain('No records for this destination are visible to you.');
    expect(html).toContain('4');
  });
});

describe('ReleasedRecordsPane figure control', () => {
  const FIGURE = { icnPointer: '/work_order/parts/0/icn', applicationStructureIdentPointer: '/work_order/parts/0/hotspot_id' };
  const withIcn = (icn: unknown): DecisionsResponse => ({
    ...FIXTURE,
    records: [record('rec-f', 'ATL', [], true, {
      work_order: { parts: [{ icn, hotspot_id: 'sec-03' }] },
    })],
  });

  it('adds a Figure toggle for a record citing a safe icn', () => {
    const html = renderToStaticMarkup(
      <ReleasedRecordsView data={withIcn('ICN-ODMRAD-00001')} columns={COLUMNS} figure={FIGURE} />,
    );
    expect(html).toContain('>Figure</button>');
  });

  it('renders no control without the figure config', () => {
    const html = renderToStaticMarkup(
      <ReleasedRecordsView data={withIcn('ICN-ODMRAD-00001')} columns={COLUMNS} />,
    );
    expect(html).not.toContain('Figure');
  });

  it('renders no control for an unsafe or missing icn', () => {
    for (const icn of ['../x', 'a/b', '', 7, undefined]) {
      const html = renderToStaticMarkup(
        <ReleasedRecordsView data={withIcn(icn)} columns={COLUMNS} figure={FIGURE} />,
      );
      expect(html).not.toContain('>Figure</button>');
    }
  });
});

describe('FigureViewBody', () => {
  const render = (state: FigureState, applicationStructureIdent: string | null = 'sec-03') =>
    renderToStaticMarkup(<FigureViewBody icn="ICN-ODMRAD-00001" applicationStructureIdent={applicationStructureIdent} state={state} />);

  it('renders loading, missing, error and unreadable captions', () => {
    expect(render({ status: 'loading' })).toContain('Loading figure');
    expect(render({ status: 'missing' })).toContain('Figure ICN-ODMRAD-00001 is not deployed on this hub.');
    expect(render({ status: 'error' })).toContain('Could not load figure ICN-ODMRAD-00001.');
    expect(render({ status: 'unreadable' })).toContain('Figure ICN-ODMRAD-00001 could not be read.');
  });

  it('renders the svg with a highlighted caption, a not-in-figure caption, or a bare caption', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><g id="a"/></svg>';
    const ok = render({ status: 'ready', svg, found: true });
    expect(ok).toContain('<svg');
    expect(ok).toContain('ICN-ODMRAD-00001 — applicationStructureIdent sec-03 highlighted');
    expect(render({ status: 'ready', svg, found: false })).toContain('applicationStructureIdent sec-03 is not in this figure');
    const bare = render({ status: 'ready', svg, found: false }, null);
    expect(bare).not.toContain('applicationStructureIdent');
    expect(bare).toContain('ICN-ODMRAD-00001');
  });
});

describe('ReleasedRecordsPane figure click', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('opens the cited figure and highlights the applicationStructureIdent from the record', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><g id="sec-03" class="hotspot"/><g id="hot-sec-03"/></svg>';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => svg });
    vi.stubGlobal('fetch', fetchMock);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const data: DecisionsResponse = {
      ...FIXTURE,
      records: [record('rec-ipd', 'ATL', [], true, {
        citations: { ipd: { icn: 'ICN-ODMRAD-00001', hotspot_ids: { faulted_section: 'sec-03', detail: 'item-0001' } } },
      })],
    };
    const figure = {
      icnPointer: '/citations/ipd/icn',
      applicationStructureIdentPointer: '/citations/ipd/hotspot_ids/faulted_section',
    };
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => {
      root.render(<ReleasedRecordsView data={data} columns={COLUMNS} figure={figure} />);
    });
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Figure');
    expect(button).toBeDefined();
    await act(async () => { button!.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(String(fetchMock.mock.calls[0][0])).toContain('ICN-ODMRAD-00001');
    expect(host.textContent).toContain('ICN-ODMRAD-00001 — applicationStructureIdent sec-03 highlighted');
    expect(host.querySelectorAll('svg .active')).toHaveLength(1);
    await act(async () => { root.unmount(); });
  });
});
