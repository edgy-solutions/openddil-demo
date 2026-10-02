// =============================================================================
// cmReport — fault-report submission + fault-code loading
// =============================================================================
// Pure-logic tests, node environment (no jsdom): a fetchFn is always
// injected so these never touch the real network. See src/lib/cmReport.ts
// for the contract this exercises (GET /cm/fault-codes, POST
// /cm/discrepancy).
import { describe, expect, it, vi } from 'vitest';
import { buildReportBody, componentOptions, loadFaultCodes, submitReport, type ReportInput } from '../cmReport';
import type { CmState } from '../../hooks';

function fakeResponse(status: number, json: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    json: async () => json,
  } as unknown as Response;
}

const BASE_INPUT: ReportInput = {
  assetId: 'asset-1',
  component: 'slot-a',
  faultCode: 'FC-1',
  description: 'engine light on',
};

describe('submitReport', () => {
  it('calls fetchFn exactly once with the right URL, method, credentials, header, and exactly the four body keys', async () => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse(202, { event_id: 'evt-123' }));
    await submitReport(BASE_INPUT, fetchFn);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('/cm/discrepancy');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });

    const parsed = JSON.parse(init.body as string);
    expect(Object.keys(parsed).sort()).toEqual(['asset_id', 'component', 'description', 'fault_code']);
  });

  it('sends exactly those four keys even when the input (cast) carries extra reported_by/source properties', async () => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse(202, { event_id: 'evt-123' }));
    const tainted = {
      ...BASE_INPUT,
      reported_by: 'someone',
      source: 'console',
    } as ReportInput & { reported_by: string; source: string };

    await submitReport(tainted, fetchFn);

    const [, init] = fetchFn.mock.calls[0];
    const parsed = JSON.parse(init.body as string);
    expect(Object.keys(parsed).sort()).toEqual(['asset_id', 'component', 'description', 'fault_code']);
  });

  it('an empty or whitespace description throws, and fetch is not called', async () => {
    const fetchFn = vi.fn();

    expect(() => buildReportBody({ ...BASE_INPUT, description: '' })).toThrow();
    expect(() => buildReportBody({ ...BASE_INPUT, description: '   ' })).toThrow();

    await expect(submitReport({ ...BASE_INPUT, description: '' }, fetchFn)).rejects.toThrow();
    await expect(submitReport({ ...BASE_INPUT, description: '   ' }, fetchFn)).rejects.toThrow();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('an over-length description (>500 chars) throws, and fetch is not called', async () => {
    const fetchFn = vi.fn();
    const tooLong = 'x'.repeat(501);
    expect(() => buildReportBody({ ...BASE_INPUT, description: tooLong })).toThrow();
    await expect(submitReport({ ...BASE_INPUT, description: tooLong }, fetchFn)).rejects.toThrow();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('202 {event_id} resolves ok:true with eventId', async () => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse(202, { event_id: 'evt-999' }));
    const result = await submitReport(BASE_INPUT, fetchFn);
    expect(result).toEqual({ ok: true, eventId: 'evt-999' });
  });

  it('403 resolves ok:false with status 403', async () => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse(403, { error: 'forbidden' }));
    const result = await submitReport(BASE_INPUT, fetchFn);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
    }
  });
});

describe('loadFaultCodes', () => {
  const codes = [{ code: 'FC-1', text: 'Engine light on', severity: 'MINOR' }];

  it('404 -> null (feature not configured on this tier)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse(404, {}));
    expect(await loadFaultCodes(fetchFn)).toBeNull();
  });

  it('401 -> null (no session)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse(401, {}));
    expect(await loadFaultCodes(fetchFn)).toBeNull();
  });

  it('a rejected fetch -> null', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('network down'));
    expect(await loadFaultCodes(fetchFn)).toBeNull();
  });

  it('200 with an array -> the array', async () => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse(200, codes));
    expect(await loadFaultCodes(fetchFn)).toEqual(codes);
  });

  it('200 with an object (non-array body) -> null', async () => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse(200, { not: 'an array' }));
    expect(await loadFaultCodes(fetchFn)).toBeNull();
  });
});

describe('componentOptions', () => {
  function cmWithInstalled(installed: Array<{ slot_id: string }>): CmState {
    return {
      asset_id: 'a',
      baseline_id: null,
      lifecycle: 'LIFECYCLE_ACTIVE',
      overall_status: 'CONFIG_STATUS_IN_COMPLIANCE',
      last_alerted_status: null,
      as_of: null,
      last_observed_at: null,
      installed,
      mod_status: [],
      discrepancies: [],
      manual_discrepancies: [],
    };
  }

  it('duplicate and unsorted slots -> sorted unique', () => {
    const result = componentOptions(cmWithInstalled([
      { slot_id: 'slot-c' },
      { slot_id: 'slot-a' },
      { slot_id: 'slot-c' },
      { slot_id: 'slot-b' },
    ]));
    expect(result).toEqual(['slot-a', 'slot-b', 'slot-c']);
  });

  it('undefined -> []', () => {
    expect(componentOptions(undefined)).toEqual([]);
  });
});
