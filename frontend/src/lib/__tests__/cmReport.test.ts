// =============================================================================
// cmReport — fault-report submission + fault-code loading
// =============================================================================
// Pure-logic tests, node environment (no jsdom): a fetchFn is always
// injected so these never touch the real network. See src/lib/cmReport.ts
// for the contract this exercises (GET /cm/fault-codes, POST
// /cm/discrepancy).
import { describe, expect, it, vi } from 'vitest';
import {
  bitOnlyDiscrepancy,
  buildReportBody,
  codeOptionsFor,
  componentOptions,
  describeBitDiscrepancy,
  loadFaultCatalog,
  noFaultIsolationMessage,
  submitReport,
  type CatalogCode,
  type ManualDiscrepancy,
  type ReportInput,
} from '../cmReport';
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

describe('loadFaultCatalog', () => {
  const MRAD_CATALOG = {
    asset_id: 'asset-1',
    platform_variant: 'MRAD_Sensor',
    manual: 'ODMRAD',
    codes: [{ code: 'MRAD-ARR-0417', text: 'Array module fault, section 3.', component: 'tr_module', severity: 'MAJOR' }],
  };

  it('requests the asset-scoped URL, not a global list', async () => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse(200, MRAD_CATALOG));
    await loadFaultCatalog('asset-1', fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('/cm/fault-codes?asset_id=asset-1');
    expect(init).toMatchObject({ credentials: 'same-origin' });
  });

  it('404 -> null (feature not configured, or asset not visible)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse(404, {}));
    expect(await loadFaultCatalog('asset-1', fetchFn)).toBeNull();
  });

  it('401 -> null (no session)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse(401, {}));
    expect(await loadFaultCatalog('asset-1', fetchFn)).toBeNull();
  });

  it('a rejected fetch -> null', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('network down'));
    expect(await loadFaultCatalog('asset-1', fetchFn)).toBeNull();
  });

  it('200 with the catalog shape -> the catalog, codes included', async () => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse(200, MRAD_CATALOG));
    expect(await loadFaultCatalog('asset-1', fetchFn)).toEqual(MRAD_CATALOG);
  });

  it('200 with zero codes (variant has no fault-isolation module) -> the catalog, codes: []', async () => {
    const empty = { asset_id: 'asset-2', platform_variant: 'M1A2_Tank', manual: null, codes: [] };
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse(200, empty));
    expect(await loadFaultCatalog('asset-2', fetchFn)).toEqual(empty);
  });

  it('200 with a malformed body (no codes array) -> null', async () => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse(200, { not: 'a catalog' }));
    expect(await loadFaultCatalog('asset-1', fetchFn)).toBeNull();
  });

  // --- Regression: no code from another variant ----------------------------
  // Before this module existed, FaultReportForm fetched ONE global,
  // unfiltered code list (lib/cmReport.ts's old loadFaultCodes) and dumped
  // it straight into the <select> -- a code belonging to a different
  // asset/variant (GV-XMSN-0201, from a GROUND_Vehicle transmission) could
  // ride straight through into an MRAD sensor's form. Against that code, a fetch mock
  // returning a flat list containing both MRAD-ARR-0417 and GV-XMSN-0201
  // produced a codes array containing GV-XMSN-0201.
  //
  // Now the server itself resolves the asset's platform_variant and returns
  // ONLY that variant's codes -- there is no "whole list" response any
  // more for a leftover GV-XMSN-0201 to hide in. This fixture is exactly
  // the MRAD asset's response the gateway returns from GET /cm/fault-codes;
  // asserting it structurally CANNOT carry GV-XMSN-0201 (a GROUND_Vehicle
  // code) guards against that mechanism ever coming back.
  it('an MRAD asset\'s catalog never carries another variant\'s code (e.g. GV-XMSN-0201)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse(200, MRAD_CATALOG));
    const catalog = await loadFaultCatalog('asset-1', fetchFn);
    const codes = codeOptionsFor(catalog?.codes ?? [], '');
    expect(codes.map((c) => c.code)).not.toContain('GV-XMSN-0201');
    expect(codes.map((c) => c.code)).toEqual(['MRAD-ARR-0417']);
  });
});

describe('codeOptionsFor', () => {
  const CODES: CatalogCode[] = [
    { code: 'FC-1', text: 'fluid leak', component: 'ENG-1', severity: 'MAJOR' },
    { code: 'FC-2', text: 'overheat', component: 'ENG-1', severity: 'MINOR' },
    { code: 'FC-3', text: 'transmission fault', component: 'cooling_fan', severity: 'MAJOR' },
  ];

  it('no component chosen yet -> every code (so picking a code can set the component)', () => {
    expect(codeOptionsFor(CODES, '')).toEqual(CODES);
  });

  it('a component chosen -> only that component\'s codes', () => {
    expect(codeOptionsFor(CODES, 'ENG-1')).toEqual([CODES[0], CODES[1]]);
    expect(codeOptionsFor(CODES, 'cooling_fan')).toEqual([CODES[2]]);
  });

  it('a component with no codes -> []', () => {
    expect(codeOptionsFor(CODES, 'nonexistent-slot')).toEqual([]);
  });
});

describe('noFaultIsolationMessage', () => {
  it('names the variant', () => {
    expect(noFaultIsolationMessage('M1A2_Tank')).toBe(
      'No fault-isolation module for M1A2_Tank; describe the fault',
    );
  });

  it('falls back to generic copy when the variant is unknown', () => {
    expect(noFaultIsolationMessage(null)).toBe(
      'No fault-isolation module for this asset; describe the fault',
    );
  });
});

describe('bitOnlyDiscrepancy', () => {
  function disc(overrides: Partial<ManualDiscrepancy> & { sources: ManualDiscrepancy['sources'] }): ManualDiscrepancy {
    return {
      component: 'tr_module',
      fault_code: 'MRAD-ARR-0417',
      detected_at_ns: 1_700_000_000_000_000_000,
      ...overrides,
    };
  }

  it('a telemetry_bit-only entry is returned', () => {
    const entry = disc({ sources: [{ source: 'telemetry_bit' }] });
    expect(bitOnlyDiscrepancy([entry])).toEqual(entry);
  });

  it('an entry that also has an operator_report source is not returned', () => {
    const entry = disc({ sources: [{ source: 'telemetry_bit' }, { source: 'operator_report' }] });
    expect(bitOnlyDiscrepancy([entry])).toBeNull();
  });

  it('no discrepancies -> null', () => {
    expect(bitOnlyDiscrepancy([])).toBeNull();
    expect(bitOnlyDiscrepancy(undefined)).toBeNull();
  });

  it('an entry with no telemetry_bit source at all is not returned', () => {
    const entry = disc({ sources: [{ source: 'operator_report' }] });
    expect(bitOnlyDiscrepancy([entry])).toBeNull();
  });

  it('multiple BIT-only entries -> the most recently detected one', () => {
    const older = disc({ component: 'ENG-1', fault_code: 'FC-1', detected_at_ns: 100, sources: [{ source: 'telemetry_bit' }] });
    const newer = disc({ component: 'ENG-2', fault_code: 'FC-2', detected_at_ns: 200, sources: [{ source: 'telemetry_bit' }] });
    expect(bitOnlyDiscrepancy([older, newer])).toEqual(newer);
  });
});

describe('describeBitDiscrepancy', () => {
  const entry: ManualDiscrepancy = {
    component: 'tr_module',
    fault_code: 'MRAD-ARR-0417',
    detected_at_ns: Date.UTC(2026, 9, 3, 14, 32) * 1e6,
    sources: [{ source: 'telemetry_bit' }],
  };

  it('uses the catalog text when the code is in the catalog', () => {
    const catalog: CatalogCode[] = [
      { code: 'MRAD-ARR-0417', text: 'Array module fault, section 3.', component: 'tr_module', severity: 'MAJOR' },
    ];
    expect(describeBitDiscrepancy(entry, catalog)).toBe(
      'Fault detected on tr_module: Array module fault, section 3. (MRAD-ARR-0417), 14:32Z. Record it?',
    );
  });

  it('falls back to the bare code when the catalog has no match', () => {
    expect(describeBitDiscrepancy(entry, [])).toBe(
      'Fault detected on tr_module: MRAD-ARR-0417 (MRAD-ARR-0417), 14:32Z. Record it?',
    );
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
