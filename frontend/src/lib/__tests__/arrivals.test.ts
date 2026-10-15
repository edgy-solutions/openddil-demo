import { describe, expect, it } from 'vitest';
import {
  buildDeclareBody,
  formatArrivalsSummary,
  formatPosition,
  loadArrivals,
  loadArrivalsSummary,
  submitDeclaration,
  type DeclareInput,
} from '../arrivals';

const respond = (status: number, body: unknown = {}) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

const input: DeclareInput = {
  assetId: 'dis:1:1:9001',
  edgeId: 'edge-01',
  serial: '  ',
  unit: 'unit-a',
  originatorNation: 'ATL',
  releasableTo: ['BDR'],
  baselineId: 'none',
  source: 'declare',
};

describe('loadArrivals', () => {
  it('maps 200 to ok', async () => {
    const data = { edge_id: 'edge-01', undeclared: [], expected: [] };
    expect(await loadArrivals('edge-01', respond(200, data))).toEqual({ kind: 'ok', data });
  });

  it.each([401, 403, 404])('maps %i to absent', async (s) => {
    expect(await loadArrivals('edge-01', respond(s))).toEqual({ kind: 'absent' });
  });

  it('maps 5xx and network errors to error', async () => {
    expect((await loadArrivals('edge-01', respond(503))).kind).toBe('error');
    const boom = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await loadArrivals('edge-01', boom)).toEqual({ kind: 'error', message: 'offline' });
  });
});

describe('buildDeclareBody', () => {
  it('emits exactly the declare keys, never declared_by or declared_at', () => {
    const body = buildDeclareBody({
      ...input,
      declared_by: 'someone',
      declared_at: 'now',
    } as DeclareInput);
    expect(Object.keys(body).sort()).toEqual(
      ['asset_id', 'baseline_id', 'edge_id', 'originator_nation', 'releasable_to', 'serial',
        'source', 'unit'].sort(),
    );
  });

  it('maps blank serial and "none" baseline to null', () => {
    const body = buildDeclareBody(input);
    expect(body.serial).toBeNull();
    expect(body.baseline_id).toBeNull();
    expect(buildDeclareBody({ ...input, baselineId: '' }).baseline_id).toBeNull();
    expect(buildDeclareBody({ ...input, baselineId: 'bl-1', serial: 'S1' })).toMatchObject({
      baseline_id: 'bl-1',
      serial: 'S1',
    });
  });

  it('adds confirm_serial only for expect-confirm', () => {
    expect('confirm_serial' in buildDeclareBody(input)).toBe(false);
    const c = buildDeclareBody({ ...input, source: 'expect-confirm', confirmSerial: 'S1' });
    expect(c.confirm_serial).toBe('S1');
  });
});

describe('submitDeclaration', () => {
  const body = buildDeclareBody(input);

  it('maps 201 to ok with baselineAssigned', async () => {
    const r = await submitDeclaration(
      body,
      respond(201, { declared: { asset_id: 'dis:1:1:9001' }, baseline_assigned: true }),
    );
    expect(r).toEqual({
      kind: 'ok',
      record: { asset_id: 'dis:1:1:9001' },
      baselineAssigned: true,
    });
  });

  it('shows the PEP cause verbatim on refusal', async () => {
    const r = await submitDeclaration(body, respond(403, { error: 'refused', cause: 'nope' }));
    expect(r).toEqual({ kind: 'refused', status: 403, reason: 'nope' });
  });

  it('maps a network failure to error', async () => {
    const boom = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await submitDeclaration(body, boom)).toEqual({ kind: 'error', message: 'offline' });
  });
});

describe('formatPosition', () => {
  it('formats to 4 dp and falls back to a dash', () => {
    expect(formatPosition({ lat: 1.5, lon: 2.25 })).toBe('1.5000, 2.2500');
    expect(formatPosition(null)).toBe('—');
    expect(formatPosition({ x: 1 })).toBe('—');
  });
});

describe('loadArrivalsSummary', () => {
  it('maps 200 to ok', async () => {
    const edges = [{ edge_id: 'edge-01', undeclared: 0, expected: 2, overdue: 1 }];
    expect(await loadArrivalsSummary(respond(200, { edges }))).toEqual({ kind: 'ok', data: edges });
  });

  it.each([401, 403, 404])('maps %i to absent', async (s) => {
    expect(await loadArrivalsSummary(respond(s))).toEqual({ kind: 'absent' });
  });

  it('maps 500 to error', async () => {
    expect((await loadArrivalsSummary(respond(500))).kind).toBe('error');
  });

  it('maps a body without edges to malformed', async () => {
    expect(await loadArrivalsSummary(respond(200, {}))).toEqual({
      kind: 'error', message: 'malformed arrivals summary',
    });
  });

  it('maps a string count to malformed', async () => {
    const edges = [{ edge_id: 'edge-01', undeclared: '1', expected: 2, overdue: 0 }];
    expect(await loadArrivalsSummary(respond(200, { edges }))).toEqual({
      kind: 'error', message: 'malformed arrivals summary',
    });
  });
});

describe('formatArrivalsSummary', () => {
  it('has no suffix when nothing is overdue, and uses a middle dot', () => {
    const out = formatArrivalsSummary({ edge_id: 'e', undeclared: 1, expected: 0, overdue: 0 });
    expect(out).toBe('undeclared 1 · expected 0');
    expect(out.charCodeAt(out.indexOf('·'))).toBe(0xb7);
  });

  it('appends the overdue suffix', () => {
    const out = formatArrivalsSummary({ edge_id: 'e', undeclared: 0, expected: 3, overdue: 2 });
    expect(out).toBe('undeclared 0 · expected 3 (2 overdue)');
  });
});
