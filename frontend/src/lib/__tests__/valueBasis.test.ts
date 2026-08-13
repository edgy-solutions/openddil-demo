import { describe, it, expect } from 'vitest';
import { basisKind, describeBasis } from '../valueBasis';

describe('basisKind', () => {
  it('maps the Origin enum names', () => {
    expect(basisKind({ origin: 'ORIGIN_DERIVED' })).toBe('DERIVED');
    expect(basisKind({ origin: 'ORIGIN_MEASURED' })).toBe('MEASURED');
  });

  it('treats an absent or unspecified stamp as UNKNOWN, never as measured', () => {
    // The whole point of IH-5: ORIGIN_UNSPECIFIED is the proto3 zero and
    // means "no claim". Reading it as MEASURED would be the fail-open that
    // the truthiness check in the fusion guard also avoids.
    expect(basisKind({ origin: 'ORIGIN_UNSPECIFIED' })).toBe('UNKNOWN');
    expect(basisKind({})).toBe('UNKNOWN');
    expect(basisKind(null)).toBe('UNKNOWN');
    expect(basisKind(undefined)).toBe('UNKNOWN');
  });
});

describe('describeBasis', () => {
  it('returns null when there is no stamp, so no badge is rendered', () => {
    // An absent badge must mean "no claim" — never "measured". The caller
    // renders nothing rather than inventing a basis.
    expect(describeBasis({})).toBeNull();
    expect(describeBasis({ origin: 'ORIGIN_UNSPECIFIED' })).toBeNull();
    expect(describeBasis(null)).toBeNull();
  });

  it('says a derived value was computed here, not measured', () => {
    const s = describeBasis({ origin: 'ORIGIN_DERIVED' })!;
    expect(s).toContain('Derived value');
    expect(s).toContain('not measured');
  });

  it('qualifies confidence as asserted rather than computed', () => {
    // ADR-0020 §Confidence staircase: an unqualified "confidence 0.20"
    // reads as a measurement of trust, and today it is an assertion.
    const s = describeBasis({ origin: 'ORIGIN_DERIVED', confidence: 0.2 })!;
    expect(s).toContain('0.20');
    expect(s).toContain('asserted, not computed');
  });

  it('omits confidence entirely when unstamped', () => {
    const s = describeBasis({ origin: 'ORIGIN_DERIVED' })!;
    expect(s).not.toContain('Confidence');
  });

  // ---------------------------------------------------------------------
  // The forward-compatibility claim, pinned rather than asserted in prose.
  // IH-6 states that future stamp fields reach the tooltip WITHOUT a
  // frontend change. That is only true if unknown keys are surfaced
  // generically — so it is tested with a key this module has never heard of.
  // ---------------------------------------------------------------------
  it('surfaces known analytics stamp fields in order', () => {
    const s = describeBasis({
      origin: 'ORIGIN_DERIVED',
      detector: 'rul-linear',
      version: '2',
      model_artifact_hash: 'sha256:abc',
    })!;
    expect(s).toContain('detector: rul-linear');
    expect(s).toContain('model artifact hash: sha256:abc');
    expect(s.indexOf('detector')).toBeLessThan(s.indexOf('model artifact hash'));
  });

  it('surfaces a stamp field this module has never heard of', () => {
    const s = describeBasis({
      origin: 'ORIGIN_DERIVED',
      some_future_field: 'weibull-shape-1.8',
    })!;
    expect(s).toContain('some future field: weibull-shape-1.8');
  });

  it('does not leak the factor payload into the basis sentence', () => {
    // severity/description/current_value belong to the factor row's own
    // rendering. Repeating them in the tooltip would make the badge a
    // second, drifting copy of the row.
    const s = describeBasis({
      origin: 'ORIGIN_DERIVED',
      factor_id: 'mtbf.engine',
      severity: 'LOGISTICS_SEVERITY_DEGRADED',
      description: 'Projected engine time-to-failure 6.0h',
      current_value: { value: 6, unit: 'h' },
    })!;
    expect(s).not.toContain('LOGISTICS_SEVERITY_DEGRADED');
    expect(s).not.toContain('time-to-failure');
    expect(s).not.toContain('[object Object]');
  });
});
