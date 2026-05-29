// Pin the severity × force-affiliation → ring color policy.
//
// Two classes of regression this catches:
//   1. Enum-name mismatches (same risk as the operationalStatePills
//      bug from commit a96a226 — if someone changes
//      LOGISTICS_SEVERITY_OK to LOGISTICS_SEVERITY_NOMINAL or similar)
//   2. Force-affiliation override drift (e.g. accidentally letting
//      severity override FORCE_OPPOSING — would render enemy assets
//      green if their telemetry says OK; demo-blocking, completely
//      wrong tactically)
import { describe, expect, it } from 'vitest';
import {
  ringColor,
  COLOR_FRIENDLY, COLOR_OPPOSING, COLOR_NEUTRAL,
  COLOR_OK, COLOR_DEGRADED, COLOR_CRITICAL, COLOR_UNKNOWN,
} from '../ringColor';

describe('ringColor — force affiliation overrides severity', () => {
  it('FORCE_OPPOSING is rose even when severity is OK', () => {
    expect(ringColor('LOGISTICS_SEVERITY_OK', 'FORCE_OPPOSING')).toBe(COLOR_OPPOSING);
  });
  it('FORCE_OPPOSING is rose when severity is CRITICAL', () => {
    expect(ringColor('LOGISTICS_SEVERITY_CRITICAL', 'FORCE_OPPOSING')).toBe(COLOR_OPPOSING);
  });
  it('FORCE_OPPOSING is rose when severity is UNSPECIFIED', () => {
    expect(ringColor('LOGISTICS_SEVERITY_UNSPECIFIED', 'FORCE_OPPOSING')).toBe(COLOR_OPPOSING);
  });
  it('FORCE_NEUTRAL is slate even when severity is OK', () => {
    expect(ringColor('LOGISTICS_SEVERITY_OK', 'FORCE_NEUTRAL')).toBe(COLOR_NEUTRAL);
  });
  it('FORCE_NEUTRAL is slate when severity is DEGRADED', () => {
    expect(ringColor('LOGISTICS_SEVERITY_DEGRADED', 'FORCE_NEUTRAL')).toBe(COLOR_NEUTRAL);
  });
});

describe('ringColor — FRIENDLY uses severity', () => {
  it('FRIENDLY + OK = emerald', () => {
    expect(ringColor('LOGISTICS_SEVERITY_OK', 'FORCE_FRIENDLY')).toBe(COLOR_OK);
  });
  it('FRIENDLY + DEGRADED = amber', () => {
    expect(ringColor('LOGISTICS_SEVERITY_DEGRADED', 'FORCE_FRIENDLY')).toBe(COLOR_DEGRADED);
  });
  it('FRIENDLY + CRITICAL = red', () => {
    expect(ringColor('LOGISTICS_SEVERITY_CRITICAL', 'FORCE_FRIENDLY')).toBe(COLOR_CRITICAL);
  });
  it('FRIENDLY + NON_OPERATIONAL = red (folded with CRITICAL)', () => {
    // The dual-case fallthrough on the switch is load-bearing — a
    // refactor that "tidies" it to one case loses the NON_OPERATIONAL
    // mapping. Pin both labels separately.
    expect(ringColor('LOGISTICS_SEVERITY_NON_OPERATIONAL', 'FORCE_FRIENDLY')).toBe(COLOR_CRITICAL);
  });
  it('FRIENDLY + UNSPECIFIED = cyan (the FRIENDLY affiliation default)', () => {
    expect(ringColor('LOGISTICS_SEVERITY_UNSPECIFIED', 'FORCE_FRIENDLY')).toBe(COLOR_FRIENDLY);
  });
  it('FRIENDLY + null severity = cyan', () => {
    expect(ringColor(null, 'FORCE_FRIENDLY')).toBe(COLOR_FRIENDLY);
  });
});

describe('ringColor — unset force_id', () => {
  it('unset force + OK = emerald', () => {
    expect(ringColor('LOGISTICS_SEVERITY_OK', null)).toBe(COLOR_OK);
  });
  it('unset force + CRITICAL = red', () => {
    expect(ringColor('LOGISTICS_SEVERITY_CRITICAL', null)).toBe(COLOR_CRITICAL);
  });
  it('unset force + UNSPECIFIED = slate (no claim, no affiliation -> COLOR_UNKNOWN)', () => {
    // Critical distinction from FRIENDLY: FRIENDLY-but-no-severity is
    // cyan (positive affiliation claim, no logistics claim); unset
    // force + no severity is slate (no claim at all).
    expect(ringColor('LOGISTICS_SEVERITY_UNSPECIFIED', null)).toBe(COLOR_UNKNOWN);
  });
  it('FORCE_UNKNOWN is treated as unset (slate when no severity claim)', () => {
    expect(ringColor('LOGISTICS_SEVERITY_UNSPECIFIED', 'FORCE_UNKNOWN')).toBe(COLOR_UNKNOWN);
  });
});

describe('ringColor — opposing/neutral with junk severity values', () => {
  // The force-affiliation override path executes BEFORE any severity
  // lookup. A junk / unknown severity string passed alongside
  // FORCE_OPPOSING must still produce rose — the override semantics
  // don't depend on severity validity.
  it('OPPOSING + junk severity = rose', () => {
    expect(ringColor('LOGISTICS_SEVERITY_FUTURE_TIER_NOT_YET_DEFINED', 'FORCE_OPPOSING'))
      .toBe(COLOR_OPPOSING);
  });
  it('NEUTRAL + junk severity = slate', () => {
    expect(ringColor('garbage' as any, 'FORCE_NEUTRAL')).toBe(COLOR_NEUTRAL);
  });
});

describe('color constants — semantic anchors', () => {
  // The exact hex values are tuned visual choices; what tests care
  // about is the semantic family. Tailwind palette names appear in
  // the corresponding pill classes, but hex is detached. Pin the
  // hex format to catch accidental swaps (e.g. red and green getting
  // accidentally cross-mapped during a refactor).
  it('COLOR_OPPOSING is a rose hex (#f4...)', () => {
    expect(COLOR_OPPOSING.startsWith('#f4')).toBe(true);
  });
  it('COLOR_OK is an emerald hex (#10b981)', () => {
    expect(COLOR_OK).toBe('#10b981');
  });
  it('COLOR_CRITICAL is a red hex (#ef...)', () => {
    expect(COLOR_CRITICAL.startsWith('#ef')).toBe(true);
  });
  it('COLOR_DEGRADED is an amber hex (#f5...)', () => {
    expect(COLOR_DEGRADED.startsWith('#f5')).toBe(true);
  });
  it('All 7 ring colors are unique', () => {
    const all = [
      COLOR_FRIENDLY, COLOR_OPPOSING, COLOR_NEUTRAL,
      COLOR_OK, COLOR_DEGRADED, COLOR_CRITICAL, COLOR_UNKNOWN,
    ];
    expect(new Set(all).size).toBe(all.length);
  });
});
