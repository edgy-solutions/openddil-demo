// =============================================================================
// The tier→instance mapping, and the tier-config validator
// =============================================================================
// These two are THE decisions of the tier-parameterized presentation arc.
// Everything else is plumbing that TypeScript checks. A decision that can
// only be exercised by mounting three React trees is a decision nobody will
// re-check, so both are pure functions and both are pinned here.
//
// The forcing question ADR-0033 names — "which of the three views does a
// FOURTH tier get?" — is answered by `instanceForShape`, and the fourth-tier
// case is tested explicitly below.
//
// The suite default is `node`. The SHAPE half needs nothing, and that is the
// point of it living in lib/ — but the VALIDATOR half goes through
// loadDeployment, which sets document.title, so the file as a whole needs a
// DOM. Splitting the file to keep the shape tests DOM-free was considered
// and rejected: the two halves are one decision seen from two sides, and
// separating them would let one be edited without the other being re-read.
import { describe, expect, it, vi } from 'vitest';
import { instanceForShape } from '../tierShape';
import { parseTier, type TierConfig } from '../../deployment';

const tier = (o: Partial<TierConfig>): TierConfig => ({
  id: 'x',
  scope: null,
  has_children: false,
  parent: null,
  ...o,
});

describe('instanceForShape — selection is by SHAPE, never by name', () => {
  it('a leaf is a leaf', () => {
    expect(instanceForShape(tier({ has_children: false, parent: 'r' })))
      .toBe('leaf');
  });

  it('children plus a parent is an intermediate', () => {
    expect(instanceForShape(tier({ has_children: true, parent: 'hq' })))
      .toBe('intermediate');
  });

  it('children and no parent is the root', () => {
    expect(instanceForShape(tier({ has_children: true, parent: null })))
      .toBe('root');
  });

  it('THE FOURTH TIER. A depth this deployment has never had resolves by ' +
     'shape with no code change — which is the question ADR-0033 says is ' +
     'unanswerable for three hardcoded views.', () => {
    // A second intermediate level: rolls up, and reports to another
    // intermediate rather than to the root.
    const fourth = tier({ id: 'sector-7', has_children: true, parent: 'region-east' });
    expect(instanceForShape(fourth)).toBe('intermediate');
    // ...and a leaf hanging off it.
    const leafOfFourth = tier({ id: 'fob-9', has_children: false, parent: 'sector-7' });
    expect(instanceForShape(leafOfFourth)).toBe('leaf');
  });

  it('the id is NEVER read — two tiers with the same shape and wildly ' +
     'different names resolve identically', () => {
    const a = tier({ id: 'hq', has_children: true, parent: null });
    const b = tier({ id: 'zzz-unheard-of', has_children: true, parent: null });
    expect(instanceForShape(a)).toBe(instanceForShape(b));
  });

  it('a name that LOOKS like another tier does not change the answer', () => {
    // The trap the tab switcher institutionalised: reading "hq" or
    // "region-" out of an identifier and deciding a view from it.
    const misleading = tier({ id: 'region-east', has_children: false, parent: 'hq' });
    expect(instanceForShape(misleading)).toBe('leaf');
  });
});

// -----------------------------------------------------------------------------
// The validator. A PARTIAL tier identity is rejected, not merged.
// -----------------------------------------------------------------------------
// Asymmetric with `liveness`, which merges field by field, and the asymmetry
// is the point: a half-applied threshold gives slightly wrong timing, a
// half-applied IDENTITY gives a UI that confidently believes it is a tier it
// is not — UD-9's failure mode arriving through the door built to stop it.
describe('tier config validation — absence beats a confident wrong answer', () => {
  // `parseTier` is called directly. Reaching it through `loadDeployment`
  // would have tested a fetch stub, a JSON parse and a DOM write alongside
  // the one thing under examination — and it needed jsdom for a function
  // that touches no DOM. The indirection was the problem, not the missing
  // dependency.
  const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});

  it('accepts a complete unscoped tier', () => {
    expect(parseTier({ id: 'hq', has_children: true, scope: null, parent: null }))
      .toMatchObject({ id: 'hq', has_children: true, scope: null });
  });

  it('accepts a complete scoped tier', () => {
    expect(parseTier({
      id: 'edge-northpoint', has_children: false, parent: 'region-east',
      scope: { column: 'edge_id', value: 'edge-northpoint' },
    })).toMatchObject({ scope: { column: 'edge_id', value: 'edge-northpoint' } });
  });

  it('REJECTS a missing has_children rather than guessing it', () => {
    quiet();
    // Guessing false would silently make every misconfigured tier a leaf,
    // and a leaf shows no rollups — an intermediate would lose its subtree
    // with no error anywhere.
    expect(parseTier({ id: 'x', scope: null })).toBeUndefined();
  });

  it('REJECTS an omitted scope, which is not the same as an explicit null', () => {
    quiet();
    // Explicit null says "read unscoped, I mean it". Omission reads as an
    // oversight, and an oversight that produces an unscoped read at a tier
    // WITH children would show the whole subtree under a leaf's label.
    expect(parseTier({ id: 'x', has_children: true })).toBeUndefined();
  });

  it('REJECTS a scope naming a column the schema does not have', () => {
    quiet();
    // The GD-01 edge. A fourth tier will want `tier_path` and there is no
    // such column; accepting the name would produce a WHERE clause Postgres
    // rejects, surfacing as an empty fleet rather than as a config error.
    expect(parseTier({
      id: 'sector-7', has_children: true, parent: 'region-east',
      scope: { column: 'tier_path', value: 'hq/region-east/sector-7' },
    })).toBeUndefined();
  });

  it('REJECTS an empty scope value', () => {
    quiet();
    expect(parseTier({
      id: 'x', has_children: false, scope: { column: 'edge_id', value: '' },
    })).toBeUndefined();
  });

  it('absent tier is undefined, and that is a supported state', () => {
    // No tier configured = demo shell. Not an error, and it must not become
    // one: the OSS default install has no tier block.
    expect(parseTier(undefined)).toBeUndefined();
    expect(parseTier(null)).toBeUndefined();
  });

  it('REJECTION IS LOUD. A silently-discarded tier config renders the demo ' +
     'shell and looks merely misconfigured rather than broken.', () => {
    const spy = quiet();
    parseTier({ id: 'x' });
    expect(spy).toHaveBeenCalled();
  });
});
