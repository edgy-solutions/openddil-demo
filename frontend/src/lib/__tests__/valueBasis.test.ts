import { describe, it, expect } from 'vitest';
import {
  advisoryBadge, basisKind, describeAdvisory, describeBasis,
} from '../valueBasis';

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

// ---------------------------------------------------------------------------
// Advisory provenance — ADR-0038 C4(b)
// ---------------------------------------------------------------------------
// These decode INTEGER enums, not string names, because asset-cm-state is JSON
// from dataclasses.asdict and the projector stores nested lists as JSONB
// verbatim (ADR-0018). Getting that wrong is silent: `basis: 1` compared
// against 'ADVISORY_BASIS_RULE' is simply falsy, and the badge vanishes.

describe('advisoryBadge', () => {
  it('decodes integer basis values, not string names', () => {
    expect(advisoryBadge({ basis: 1 })).toBe('RULE');
    expect(advisoryBadge({ basis: 2 })).toBe('MODEL');
    expect(advisoryBadge({ basis: 3 })).toBe('HUMAN');
  });

  it('renders no badge when unstamped — absence is "no claim"', () => {
    // Every discrepancy written before C4(a) lands here. An absent badge must
    // never read as "trusted" or "human-authored".
    expect(advisoryBadge({ basis: 0 })).toBeNull();
    expect(advisoryBadge({})).toBeNull();
    expect(advisoryBadge(null)).toBeNull();
    expect(advisoryBadge(undefined)).toBeNull();
  });

  it('does not treat a string enum name as a basis', () => {
    // Guards the asymmetry: ConstrainingFactor carries string origins,
    // discrepancies carry integer bases. Confusing them fails silently.
    expect(advisoryBadge({ basis: 'ADVISORY_BASIS_RULE' as any })).toBeNull();
  });
});

describe('describeAdvisory', () => {
  it('names the producer, rule and baseline it was bound to', () => {
    const s = describeAdvisory({
      basis: 1,
      producer: 'cm-service/discrepancy-analyzer',
      producer_version: '1.0.0',
      rule_id: 'required-mod.overdue',
      config_hash: 'M1A2-Baseline-2026.1@2026.1',
      inputs: ['baseline:M1A2-Baseline-2026.1', 'mod:MWO-2026-001'],
    })!;
    expect(s).toContain('deterministic rule');
    expect(s).toContain('cm-service/discrepancy-analyzer 1.0.0');
    expect(s).toContain('required-mod.overdue');
    expect(s).toContain('M1A2-Baseline-2026.1@2026.1');
    expect(s).toContain('mod:MWO-2026-001');
  });

  it('renders limitations as what the advisory does NOT claim', () => {
    const s = describeAdvisory({ basis: 1, limitations: [4, 1, 2] })!;
    expect(s).toContain('Does NOT claim');
    expect(s).toContain('not a work order');
    expect(s).toContain('not a safety-of-use judgment');
  });

  it('stays silent on confidence when no kind is declared', () => {
    // The rule-based producer sets neither. Rendering "Confidence 0.00" would
    // read as no-confidence when the truth is no-claim (ADR-0020 staircase).
    const s = describeAdvisory({ basis: 1, confidence: 0.0, confidence_kind: 0 })!;
    expect(s).not.toContain('Confidence');
  });

  it('renders confidence once a kind IS declared', () => {
    const s = describeAdvisory({ basis: 2, confidence: 0.83, confidence_kind: 3 })!;
    expect(s).toContain('Confidence 0.83');
  });

  it('distinguishes human-authored advice from machine-generated', () => {
    // AE-2's actual danger: one bare string, two origins, distinguishable
    // only by which JSONB list the row sat in — which no operator can see.
    const human = describeAdvisory({ basis: 3 })!;
    expect(human).toContain('Authored by a person');
    expect(human).not.toContain('deterministic rule');
  });

  it('returns null when unstamped, so the caller renders nothing', () => {
    expect(describeAdvisory({ basis: 0, producer: 'x' })).toBeNull();
  });
});
