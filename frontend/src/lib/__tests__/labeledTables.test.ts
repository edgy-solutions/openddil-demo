// =============================================================================
// labeledTables / shapeErrors — a failed feed must never read as an empty one
// =============================================================================
// Found by measurement: nine of fourteen served tables were answering 502
// through the gateway and every affected panel rendered its ordinary empty
// copy. These defend the two decisions that fix it, and both are about
// UNDERSTATING rather than inventing.
import { describe, it, expect, beforeEach } from 'vitest';
import { setLabeledTables, isUnlabelable } from '../labeledTables';
import {
  reportShapeError, clearShapeError, getShapeErrors, subscribeShapeErrors,
} from '../shapeErrors';

describe('isUnlabelable', () => {
  beforeEach(() => setLabeledTables(undefined));

  it('is true for a table the gateway does not list', () => {
    setLabeledTables(['telemetry_latest_state']);
    expect(isUnlabelable('region_fleet_summary')).toBe(true);
  });

  it('is false for a listed table', () => {
    setLabeledTables(['telemetry_latest_state']);
    expect(isUnlabelable('telemetry_latest_state')).toBe(false);
  });

  it('is FALSE for everything before the gateway has answered', () => {
    // An unknown reason must be reported as a plain transport error. Naming
    // a cause we have not been told would be the browser forming a second
    // opinion about an authorization decision (ADR-0029 §1).
    expect(isUnlabelable('anything')).toBe(false);
  });

  it('treats an EMPTY list as "not configured", not "nothing is labeled"', () => {
    // The gateway sends [] when table-granularity checking is off. Reading
    // that as "no table is labeled" would mark every feed unlabelable and
    // put a confident, wrong explanation on the screen.
    setLabeledTables([]);
    expect(isUnlabelable('telemetry_latest_state')).toBe(false);
    expect(isUnlabelable('region_fleet_summary')).toBe(false);
  });
});

describe('shapeErrors registry', () => {
  beforeEach(() => {
    for (const e of getShapeErrors()) clearShapeError(e.table);
  });

  it('records and clears by table', () => {
    reportShapeError('region_top_factors', 'unlabelable');
    expect(getShapeErrors()).toEqual([
      { table: 'region_top_factors', kind: 'unlabelable' },
    ]);
    clearShapeError('region_top_factors');
    expect(getShapeErrors()).toEqual([]);
  });

  it('returns a STABLE snapshot between changes', () => {
    // useSyncExternalStore compares by reference: a fresh array each call
    // is an infinite render loop, and it would present as the whole app
    // hanging rather than as anything to do with error reporting.
    reportShapeError('a', 'transport');
    expect(getShapeErrors()).toBe(getShapeErrors());
  });

  it('notifies subscribers on change and not on a repeat', () => {
    let n = 0;
    const un = subscribeShapeErrors(() => { n += 1; });
    reportShapeError('b', 'transport');
    const after = n;
    reportShapeError('b', 'transport');   // same kind — no new information
    expect(n).toBe(after);
    un();
  });
});
