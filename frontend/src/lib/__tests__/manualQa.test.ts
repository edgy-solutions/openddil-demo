import { describe, expect, it, vi } from 'vitest';
import {
  askManualQuestion,
  citationsInScope,
  manualQaScope,
  shouldRenderAnswer,
  type AskResult,
} from '../manualQa';
import type { CatalogCode } from '../cmReport';

function fakeResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: `status ${status}`,
    json: async () => body,
  } as unknown as Response;
}

const CODES: CatalogCode[] = [
  { code: 'MRAD-ARR-0417', text: 'Array module fault, section 3.', component: 'tr_module', severity: 'MAJOR', dmc: 'DMC-ODMRAD-A-34-10-01-00A-421A-A' },
  { code: 'MRAD-ARR-0500', text: 'Cooling fault.', component: 'cooling_fan', severity: 'MINOR', dmc: 'DMC-ODMRAD-A-34-10-02-00A-421A-A' },
];

describe('manualQaScope', () => {
  it('collects the distinct dmc values carried by the catalog response', () => {
    expect(manualQaScope(CODES)).toEqual([
      'DMC-ODMRAD-A-34-10-01-00A-421A-A',
      'DMC-ODMRAD-A-34-10-02-00A-421A-A',
    ]);
  });

  it('folds in an open BIT-discrepancy card\'s own dmc even if the catalog does not carry it', () => {
    const scope = manualQaScope([CODES[0]], 'DMC-ODMRAD-A-34-10-09-00A-941A-A');
    expect(scope).toContain('DMC-ODMRAD-A-34-10-01-00A-421A-A');
    expect(scope).toContain('DMC-ODMRAD-A-34-10-09-00A-941A-A');
  });

  it('a card dmc already in the catalog does not duplicate', () => {
    const scope = manualQaScope(CODES, CODES[0].dmc);
    expect(scope.filter((d) => d === CODES[0].dmc)).toHaveLength(1);
  });

  it('no codes and no card -> empty scope', () => {
    expect(manualQaScope([])).toEqual([]);
  });
});

describe('citationsInScope / shouldRenderAnswer — the render gate', () => {
  const scope = ['DMC-A', 'DMC-B'];

  it('a well-formed reply citing a dmc inside scope is renderable', () => {
    const reply: AskResult = { kind: 'answered', answer: 'x', citations: [{ dmc: 'DMC-A' }] };
    expect(shouldRenderAnswer(reply, scope)).toBe(true);
  });

  it('an answered reply with no citations at all is never renderable', () => {
    const reply: AskResult = { kind: 'answered', answer: 'x', citations: [] };
    expect(citationsInScope(reply.citations, scope)).toBe(false);
    expect(shouldRenderAnswer(reply, scope)).toBe(false);
  });

  it('a citation naming a dmc outside the scope sent is never renderable, even if others are in scope', () => {
    const reply: AskResult = {
      kind: 'answered',
      answer: 'x',
      citations: [{ dmc: 'DMC-A' }, { dmc: 'DMC-OUTSIDE' }],
    };
    expect(shouldRenderAnswer(reply, scope)).toBe(false);
  });

  it('a non-answered reply is never renderable regardless of scope', () => {
    const reply: AskResult = { kind: 'no_cited_answer', reason: 'no_citations' };
    expect(shouldRenderAnswer(reply, scope)).toBe(false);
  });
});

describe('askManualQuestion', () => {
  it('an empty scope sends nothing -- fetchFn is never called', async () => {
    const fetchFn = vi.fn();
    const result = await askManualQuestion({ assetId: 'a1', question: 'what', dmcs: [] }, fetchFn);
    expect(result).toEqual({ kind: 'no_scope' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('posts asset_id, question, and the scoped dmcs, nothing else', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      fakeResponse(200, { status: 'answered', answer: 'ok', citations: [{ dmc: 'DMC-A' }] }),
    );
    await askManualQuestion({ assetId: 'a1', question: 'what', dmcs: ['DMC-A'] }, fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('/manual/ask');
    expect(JSON.parse(init.body)).toEqual({ asset_id: 'a1', question: 'what', dmcs: ['DMC-A'] });
  });

  it('a well-formed answered reply parses through', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      fakeResponse(200, { status: 'answered', answer: 'the array module', citations: [{ dmc: 'DMC-A', step: 'Reseat connector' }] }),
    );
    const result = await askManualQuestion({ assetId: 'a1', question: 'q', dmcs: ['DMC-A'] }, fetchFn);
    expect(result).toEqual({
      kind: 'answered',
      answer: 'the array module',
      citations: [{ dmc: 'DMC-A', step: 'Reseat connector' }],
    });
  });

  it('a no_cited_answer reply carries its reason through', async () => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse(200, { status: 'no_cited_answer', reason: 'no_citations' }));
    const result = await askManualQuestion({ assetId: 'a1', question: 'q', dmcs: ['DMC-A'] }, fetchFn);
    expect(result).toEqual({ kind: 'no_cited_answer', reason: 'no_citations' });
  });

  it('404 -> hidden', async () => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse(404, {}));
    const result = await askManualQuestion({ assetId: 'a1', question: 'q', dmcs: ['DMC-A'] }, fetchFn);
    expect(result).toEqual({ kind: 'hidden' });
  });

  it('401 -> no_session', async () => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse(401, {}));
    const result = await askManualQuestion({ assetId: 'a1', question: 'q', dmcs: ['DMC-A'] }, fetchFn);
    expect(result).toEqual({ kind: 'no_session' });
  });

  it('403 -> no_session', async () => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse(403, {}));
    const result = await askManualQuestion({ assetId: 'a1', question: 'q', dmcs: ['DMC-A'] }, fetchFn);
    expect(result).toEqual({ kind: 'no_session' });
  });

  it('502 -> unavailable', async () => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse(502, { status: 'unavailable' }));
    const result = await askManualQuestion({ assetId: 'a1', question: 'q', dmcs: ['DMC-A'] }, fetchFn);
    expect(result).toEqual({ kind: 'unavailable' });
  });

  it('a network failure -> unavailable', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('network down'));
    const result = await askManualQuestion({ assetId: 'a1', question: 'q', dmcs: ['DMC-A'] }, fetchFn);
    expect(result).toEqual({ kind: 'unavailable' });
  });

  it('an unexpected status falls back to a generic error', async () => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse(400, { error: 'bad dmcs' }));
    const result = await askManualQuestion({ assetId: 'a1', question: 'q', dmcs: ['DMC-A'] }, fetchFn);
    expect(result).toEqual({ kind: 'error', status: 400, message: 'bad dmcs' });
  });
});
