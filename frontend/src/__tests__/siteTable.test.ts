// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseSiteTable, parseSiteTableText, selectForTier, type SiteTable } from '../siteTable';
import { IMPLICIT_ROOT, deployment, loadDeployment, parseTiers, type TierConfig } from '../deployment';

// Fictional stub: the same file as the example bundle.
const STUB = `
fobs:
  - {edge_id: edge-01, region_id: region-east, lat: 39.08, lon: -104.92, label: FOB Granite}
  - {edge_id: edge-02, region_id: region-east, lat: 38.96, lon: -104.80, label: FOB Juniper}
  - {edge_id: edge-03, region_id: region-west, lat: 38.92, lon: -105.18, label: FOB Mesa}
tier_sites:
  - {tier_id: region-east, lat: 39.02, lon: -104.86, label: Cedar Ridge}
  - {tier_id: region-west, lat: 38.95, lon: -105.12, label: Pinyon Flat}
  - {tier_id: hq, lat: 39.12, lon: -105.05, label: HQ Summit}
strategy: chain
chain: []
fallback: {edge_id: edge-unspecified, region_id: region-unspecified}
`;

const FOB_ROWS = `
    - {edge_id: edge-01, region_id: region-east, lat: 39.08, lon: -104.92, label: FOB Granite}
    - {edge_id: edge-02, region_id: region-east, lat: 38.96, lon: -104.80, label: FOB Juniper}
    - {edge_id: edge-03, region_id: region-west, lat: 38.92, lon: -105.18, label: FOB Mesa}
`;
const SITES = `
tier_sites:
  - {tier_id: region-east, lat: 39.02, lon: -104.86, label: Cedar Ridge}
  - {tier_id: region-west, lat: 38.95, lon: -105.12, label: Pinyon Flat}
  - {tier_id: hq, lat: 39.12, lon: -105.05, label: HQ Summit}
`;

function table(text: string): SiteTable {
  const r = parseSiteTableText(text);
  if (!r.ok) throw new Error(r.error);
  return r.table;
}
function rejected(text: string, sub: string): void {
  const r = parseSiteTableText(text);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain(sub);
}
const row = (over: string) => `fobs:\n  - {edge_id: edge-01, region_id: r1, lat: 1, lon: 2${over}}\n`;

describe('parseSiteTable - accepts', () => {
  it('the stub: 3 FOBs, 3 sites, labels kept', () => {
    const t = table(STUB);
    expect(t.fobs.map((f) => f.edge_id)).toEqual(['edge-01', 'edge-02', 'edge-03']);
    expect(t.fobs[0].label).toBe('FOB Granite');
    expect(t.tierSites).toHaveLength(3);
    expect(t.tierSites[2]).toEqual({ tier_id: 'hq', lat: 39.12, lon: -105.05, label: 'HQ Summit' });
  });
  it('rows inside a chain nearest_fob step parse identically', () => {
    const t = table(`chain:\n  - strategy: nearest_fob\n    fobs:${FOB_ROWS}strategy: chain\n${SITES}`);
    expect(t).toEqual(table(STUB));
  });
  it('root-level nearest_fob with fobs', () => {
    const t = table(`strategy: nearest_fob\nfobs:${FOB_ROWS}${SITES}`);
    expect(t).toEqual(table(STUB));
  });
  it('the edge_assignment wrapper', () => {
    const indented = STUB.split('\n').map((l) => (l ? '  ' + l : l)).join('\n');
    expect(table(`edge_assignment:${indented}`)).toEqual(table(STUB));
  });
  it('no fobs and no step is ok with fobs []', () => {
    const t = table('strategy: chain\nchain: []\n');
    expect(t).toEqual({ fobs: [], tierSites: [] });
  });
  it('drops extra keys and an empty label', () => {
    const t = table(row(', label: "", extra: 1'));
    expect(t.fobs[0]).toEqual({ edge_id: 'edge-01', region_id: 'r1', lat: 1, lon: 2 });
  });
});

describe('parseSiteTable - rejects', () => {
  it('not YAML', () => rejected('a: [unclosed', 'not valid YAML'));
  it('not a mapping', () => {
    rejected('- a\n- b\n', 'the file is not a mapping');
    expect(parseSiteTable(null).ok).toBe(false);
  });
  it('fobs not a list', () => rejected('fobs: nope\n', 'fobs must be a list'));
  it('both sources', () => rejected(
    `fobs:${FOB_ROWS}chain:\n  - strategy: nearest_fob\n    fobs:${FOB_ROWS}strategy: chain\n`,
    'both top-level fobs and a nearest_fob step',
  ));
  it('two steps', () => rejected(
    'strategy: chain\nchain:\n  - {strategy: nearest_fob, fobs: []}\n  - {strategy: nearest_fob, fobs: []}\n',
    'found 2 nearest_fob steps; at most one',
  ));
  it('step with no fobs', () => rejected(
    'strategy: chain\nchain:\n  - {strategy: nearest_fob}\n', 'the nearest_fob step has no fobs',
  ));
  it('row not a mapping', () => rejected('fobs:\n  - nope\n', 'fobs[0] is not a mapping'));
  it('empty edge_id', () => rejected(
    'fobs:\n  - {edge_id: "", region_id: r, lat: 1, lon: 2}\n', 'fobs[0]: edge_id must be a non-empty string',
  ));
  it('missing region_id', () => rejected(
    'fobs:\n  - {edge_id: edge-01, lat: 1, lon: 2}\n', 'fobs[0] (edge-01): region_id must be a non-empty string',
  ));
  it('string lat', () => rejected(
    'fobs:\n  - {edge_id: edge-01, region_id: r, lat: "1", lon: 2}\n', 'fobs[0] (edge-01): lat must be a number',
  ));
  it('boolean lon', () => rejected(
    'fobs:\n  - {edge_id: edge-01, region_id: r, lat: 1, lon: true}\n', 'lon must be a number',
  ));
  it('lat 91', () => rejected(
    'fobs:\n  - {edge_id: edge-01, region_id: r, lat: 91, lon: 2}\n', 'lat 91 is outside [-90,90]',
  ));
  it('lon -181', () => rejected(
    'fobs:\n  - {edge_id: edge-01, region_id: r, lat: 1, lon: -181}\n', 'lon -181 is outside [-180,180]',
  ));
  it('duplicate edge_id', () => rejected(
    'fobs:\n  - {edge_id: edge-01, region_id: r, lat: 1, lon: 2}\n  - {edge_id: edge-01, region_id: r, lat: 1, lon: 2}\n',
    'fobs[1]: duplicate edge_id edge-01',
  ));
  it('label a number', () => rejected(row(', label: 5'), 'label must be a string'));
  it('tier_sites not a list', () => rejected('tier_sites: nope\n', 'tier_sites must be a list'));
  it('duplicate tier_id', () => rejected(
    'tier_sites:\n  - {tier_id: hq, lat: 1, lon: 2}\n  - {tier_id: hq, lat: 1, lon: 2}\n',
    'tier_sites[1]: duplicate tier_id hq',
  ));
  it('tier_id equal to a FOB edge_id', () => rejected(
    `${row('')}tier_sites:\n  - {tier_id: edge-01, lat: 1, lon: 2}\n`,
    "tier_sites[0] (edge-01): tier_id is a FOB's edge_id",
  ));
  it('site lat out of range', () => rejected(
    'tier_sites:\n  - {tier_id: hq, lat: -200, lon: 2}\n', 'tier_sites[0] (hq): lat -200 is outside [-90,90]',
  ));
  it('site lon out of range', () => rejected(
    'tier_sites:\n  - {tier_id: hq, lat: 1, lon: -200}\n', 'tier_sites[0] (hq): lon -200 is outside [-180,180]',
  ));
  it('one bad row among good ones rejects the whole table', () => {
    rejected(
      `fobs:${FOB_ROWS}    - {edge_id: edge-04, region_id: region-west, lat: 99, lon: 0}\n`,
      'fobs[3] (edge-04): lat 99',
    );
  });
});

describe('selectForTier', () => {
  const t = table(STUB);
  const tier = (id: string, parent: string | null): TierConfig => ({
    id, label: id, scope: null, has_children: false, parent,
  });
  const ids = (s: ReturnType<typeof selectForTier>) => s.fobs.map((f) => f.edge_id);
  it.each([
    ['implicit root', IMPLICIT_ROOT, ['edge-01', 'edge-02', 'edge-03'], null],
    ['region-east', tier('region-east', 'root'), ['edge-01', 'edge-02'], null],
    ['region-west', tier('region-west', 'root'), ['edge-03'], null],
    ['edge-01', tier('edge-01', 'region-east'), ['edge-01', 'edge-02'], 'edge-01'],
    ['edge-03', tier('edge-03', 'region-west'), ['edge-03'], 'edge-03'],
    ['undefined', undefined, [], null],
  ])('%s', (_n, tc, fobIds, own) => {
    const s = selectForTier(t, tc);
    expect(ids(s)).toEqual(fobIds);
    expect(s.ownFob).toBe(own);
    expect(s.tierSites).toHaveLength(3);
    expect(s.hq).toEqual({ lat: 39.12, lon: -105.05, label: 'HQ Summit' });
  });
  it('hq undefined when the table has no hq row', () => {
    const s = selectForTier({ fobs: t.fobs, tierSites: t.tierSites.slice(0, 2) }, IMPLICIT_ROOT);
    expect(s.hq).toBeUndefined();
    expect(s.tierSites).toHaveLength(2);
  });
});

describe('loadDeployment - site table', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const stub = (routes: Record<string, { body: string; type?: string; status?: number }>) =>
    vi.stubGlobal('fetch', async (url: string) => {
      const r = routes[url];
      if (!r) return new Response('nope', { status: 404 });
      return new Response(r.body, {
        status: r.status ?? 200,
        headers: { 'content-type': r.type ?? 'application/json' },
      });
    });
  const YAML = { body: STUB, type: 'application/x-yaml' };
  const SITE = '/edge-assignment/edge-assignment.yaml';

  it('(a) deployment.json fobs/hq are ignored with a warning; the table wins', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stub({
      '/deployment/deployment.json': {
        body: JSON.stringify({
          fobs: [{ edge_id: 'x', region_id: 'y', lat: 1, lon: 1 }],
          hq: { lat: 5, lon: 5 },
        }),
      },
      [SITE]: YAML,
    });
    await loadDeployment();
    const d = deployment();
    expect(d.fobs.map((f) => f.edge_id)).toEqual(['edge-01', 'edge-02', 'edge-03']);
    expect(d.hq).toEqual({ lat: 39.12, lon: -105.05, label: 'HQ Summit' });
    const msgs = warn.mock.calls.map((c) => String(c[0]));
    expect(msgs.some((m) => m.includes('"fobs"'))).toBe(true);
    expect(msgs.some((m) => m.includes('"hq"'))).toBe(true);
  });

  it('(b) a 404 site table is no sites, no error', async () => {
    stub({});
    await loadDeployment();
    const d = deployment();
    expect(d.fobs).toEqual([]);
    expect(d.tierSites).toEqual([]);
    expect(d.siteTableError).toBeNull();
    expect(d.hq).toBeUndefined();
  });

  it('(c) an invalid site table draws nothing and records the error', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    stub({ [SITE]: { body: 'fobs: nope\n', type: 'application/x-yaml' } });
    await loadDeployment();
    const d = deployment();
    expect(d.fobs).toEqual([]);
    expect(d.siteTableError).toContain('fobs must be a list');
    expect(err).toHaveBeenCalled();
  });

  it('(d) a text/html answer is treated as absent', async () => {
    stub({ [SITE]: { body: '<html></html>', type: 'text/html; charset=utf-8' } });
    await loadDeployment();
    const d = deployment();
    expect(d.siteTableError).toBeNull();
    expect(d.fobs).toEqual([]);
  });
});

describe('positions never come from deployment.json tiers', () => {
  it('parseTiers drops lat/lon/label on an entry', () => {
    expect(parseTiers([{ id: 'r1', parent: null, hasChildren: true, lat: 10, lon: 20, label: 'Node One' }]))
      .toEqual([{ id: 'r1', parent: null, hasChildren: true }]);
  });
});
