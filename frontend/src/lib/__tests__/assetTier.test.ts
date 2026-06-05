// Pin the 5-tier classifier. The visible behavior the 3D scene + the
// pulldown + the tier-count badge all depend on derives from this
// single pure function; silently changing precedence shifts what the
// operator sees in every view at once.
import { describe, expect, it } from 'vitest';
import {
  applyRecoveryHysteresis,
  classifyAssetTier,
  isDegradedHealth,
  isTierVisibleIn3D,
  TIER_ORDER,
  tierLabel,
  tierOpacity,
  tierOutline,
  tierShortCode,
} from '../assetTier';
import { DEFAULT_LIVENESS } from '../../deployment';

const T = DEFAULT_LIVENESS;
const NOW = Date.parse('2026-06-05T12:00:00.000Z');

function isoAgo(seconds: number): string {
  return new Date(NOW - seconds * 1000).toISOString();
}

describe('classifyAssetTier — time thresholds', () => {
  it('fresh sample + healthy -> ACTIVE', () => {
    const t = classifyAssetTier({
      lastSampleAt: isoAgo(2),
      healthState: null,
      edgeLinkSevered: false,
      nowMs: NOW,
    }, T);
    expect(t).toBe('ACTIVE');
  });

  it('within stale window -> ACTIVE (boundary just-inside)', () => {
    const t = classifyAssetTier({
      lastSampleAt: isoAgo(T.stale_after_s - 0.5),
      healthState: null,
      edgeLinkSevered: false,
      nowMs: NOW,
    }, T);
    expect(t).toBe('ACTIVE');
  });

  it('just past stale threshold + link up -> STALE', () => {
    const t = classifyAssetTier({
      lastSampleAt: isoAgo(T.stale_after_s + 1),
      healthState: null,
      edgeLinkSevered: false,
      nowMs: NOW,
    }, T);
    expect(t).toBe('STALE');
  });

  it('just past stale threshold + link DOWN -> COMM_LOST', () => {
    const t = classifyAssetTier({
      lastSampleAt: isoAgo(T.stale_after_s + 1),
      healthState: null,
      edgeLinkSevered: true,
      nowMs: NOW,
    }, T);
    expect(t).toBe('COMM_LOST');
  });

  it('past lost threshold -> LOST regardless of link state', () => {
    const linkUp = classifyAssetTier({
      lastSampleAt: isoAgo(T.lost_after_s + 1),
      healthState: null,
      edgeLinkSevered: false,
      nowMs: NOW,
    }, T);
    const linkDown = classifyAssetTier({
      lastSampleAt: isoAgo(T.lost_after_s + 1),
      healthState: null,
      edgeLinkSevered: true,
      nowMs: NOW,
    }, T);
    expect(linkUp).toBe('LOST');
    expect(linkDown).toBe('LOST');
  });
});

describe('classifyAssetTier — health state', () => {
  it('recent sample + HEALTH_STATE_FAULT -> DEGRADED', () => {
    const t = classifyAssetTier({
      lastSampleAt: isoAgo(2),
      healthState: 'HEALTH_STATE_FAULT',
      edgeLinkSevered: false,
      nowMs: NOW,
    }, T);
    expect(t).toBe('DEGRADED');
  });

  it('recent sample + HEALTH_STATE_FAILED -> DEGRADED', () => {
    const t = classifyAssetTier({
      lastSampleAt: isoAgo(2),
      healthState: 'HEALTH_STATE_FAILED',
      edgeLinkSevered: false,
      nowMs: NOW,
    }, T);
    expect(t).toBe('DEGRADED');
  });

  it('recent sample + HEALTH_STATE_OK -> ACTIVE', () => {
    const t = classifyAssetTier({
      lastSampleAt: isoAgo(2),
      healthState: 'HEALTH_STATE_OK',
      edgeLinkSevered: false,
      nowMs: NOW,
    }, T);
    expect(t).toBe('ACTIVE');
  });

  it('POWER_STATE_OFF is NOT degraded health (off-by-intent != broken)', () => {
    // isDegradedHealth only fires for FAULT/FAILED; POWER_STATE_OFF
    // lives on a different OperationalState axis and is honored by
    // the schematic-degraded animation but doesn't bump the tier.
    expect(isDegradedHealth('POWER_STATE_OFF')).toBe(false);
    expect(isDegradedHealth(null)).toBe(false);
    expect(isDegradedHealth(undefined)).toBe(false);
  });
});

describe('classifyAssetTier — precedence (time beats DEGRADED)', () => {
  // Original bug shape: a launcher reporting FAULT that ALSO goes
  // silent should read as STALE/COMM_LOST/LOST -- the operator's
  // first question is "where is it?", not "is it broken?". Pin the
  // worst-of-time-or-health ordering.

  it('past stale + DEGRADED + link up -> STALE (not DEGRADED)', () => {
    const t = classifyAssetTier({
      lastSampleAt: isoAgo(T.stale_after_s + 5),
      healthState: 'HEALTH_STATE_FAULT',
      edgeLinkSevered: false,
      nowMs: NOW,
    }, T);
    expect(t).toBe('STALE');
  });

  it('past stale + DEGRADED + link down -> COMM_LOST (not DEGRADED)', () => {
    const t = classifyAssetTier({
      lastSampleAt: isoAgo(T.stale_after_s + 5),
      healthState: 'HEALTH_STATE_FAULT',
      edgeLinkSevered: true,
      nowMs: NOW,
    }, T);
    expect(t).toBe('COMM_LOST');
  });

  it('past lost + DEGRADED -> LOST (not DEGRADED)', () => {
    const t = classifyAssetTier({
      lastSampleAt: isoAgo(T.lost_after_s + 5),
      healthState: 'HEALTH_STATE_FAULT',
      edgeLinkSevered: false,
      nowMs: NOW,
    }, T);
    expect(t).toBe('LOST');
  });
});

describe('classifyAssetTier — defensive inputs', () => {
  it('null lastSampleAt -> LOST', () => {
    const t = classifyAssetTier({
      lastSampleAt: null,
      healthState: 'HEALTH_STATE_OK',
      edgeLinkSevered: false,
      nowMs: NOW,
    }, T);
    expect(t).toBe('LOST');
  });

  it('undefined lastSampleAt -> LOST', () => {
    const t = classifyAssetTier({
      lastSampleAt: undefined,
      healthState: null,
      edgeLinkSevered: false,
      nowMs: NOW,
    }, T);
    expect(t).toBe('LOST');
  });

  it('malformed lastSampleAt -> LOST', () => {
    const t = classifyAssetTier({
      lastSampleAt: 'not-a-date',
      healthState: null,
      edgeLinkSevered: false,
      nowMs: NOW,
    }, T);
    expect(t).toBe('LOST');
  });

  it('future-dated lastSampleAt (clock skew) -> ACTIVE (negative age)', () => {
    // A producer slightly ahead of the SPA's clock yields a negative
    // age; should NOT trigger STALE/LOST. Treat as fresh.
    const t = classifyAssetTier({
      lastSampleAt: new Date(NOW + 5_000).toISOString(),
      healthState: null,
      edgeLinkSevered: false,
      nowMs: NOW,
    }, T);
    expect(t).toBe('ACTIVE');
  });
});

describe('classifyAssetTier — custom thresholds', () => {
  it('tighter stale_after_s downgrades sooner', () => {
    const tight = { ...T, stale_after_s: 5 };
    const at10sAgo = classifyAssetTier({
      lastSampleAt: isoAgo(10),
      healthState: null,
      edgeLinkSevered: false,
      nowMs: NOW,
    }, tight);
    expect(at10sAgo).toBe('STALE');
  });

  it('looser lost_after_s defers LOST', () => {
    const loose = { ...T, lost_after_s: 3600 };
    const at400sAgo = classifyAssetTier({
      lastSampleAt: isoAgo(400),
      healthState: null,
      edgeLinkSevered: false,
      nowMs: NOW,
    }, loose);
    expect(at400sAgo).toBe('STALE');
  });
});

// ---------------------------------------------------------------------------
// Visual mapping helpers
// ---------------------------------------------------------------------------

describe('TIER_ORDER worst-to-best', () => {
  it('LOST appears first, ACTIVE last', () => {
    expect(TIER_ORDER[0]).toBe('LOST');
    expect(TIER_ORDER[TIER_ORDER.length - 1]).toBe('ACTIVE');
  });
  it('covers all 5 tiers exactly once', () => {
    expect(new Set(TIER_ORDER).size).toBe(5);
  });
});

describe('isTierVisibleIn3D', () => {
  it('only LOST is hidden', () => {
    expect(isTierVisibleIn3D('ACTIVE')).toBe(true);
    expect(isTierVisibleIn3D('DEGRADED')).toBe(true);
    expect(isTierVisibleIn3D('STALE')).toBe(true);
    expect(isTierVisibleIn3D('COMM_LOST')).toBe(true);
    expect(isTierVisibleIn3D('LOST')).toBe(false);
  });
});

describe('tierOpacity', () => {
  it('ACTIVE and DEGRADED render full opacity', () => {
    expect(tierOpacity('ACTIVE')).toBe(1.0);
    expect(tierOpacity('DEGRADED')).toBe(1.0);
  });
  it('STALE and COMM_LOST render at the same dim level', () => {
    // Same dim so the only visual difference is the outline color --
    // we lean on outline for the comm-vs-stale distinction.
    expect(tierOpacity('STALE')).toBe(tierOpacity('COMM_LOST'));
    expect(tierOpacity('STALE')).toBeGreaterThan(0);
    expect(tierOpacity('STALE')).toBeLessThan(0.7);
  });
  it('LOST opacity is 0 (defense -- it should be filtered before render)', () => {
    expect(tierOpacity('LOST')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Recovery hysteresis — the load-bearing "don't yank back to ACTIVE on
// a single late sample" rule
// ---------------------------------------------------------------------------

describe('applyRecoveryHysteresis', () => {
  it('first sighting (lastTier=null) always accepts candidate', () => {
    // Even if we have no samples in window, a freshly-arrived asset
    // shouldn't be held at the silent tier just because we lack history.
    expect(applyRecoveryHysteresis(null, 'ACTIVE', 0, 3)).toBe('ACTIVE');
    expect(applyRecoveryHysteresis(null, 'LOST', 0, 3)).toBe('LOST');
    expect(applyRecoveryHysteresis(null, 'DEGRADED', 0, 3)).toBe('DEGRADED');
  });

  it('downgrade is always immediate (no hysteresis on the way down)', () => {
    expect(applyRecoveryHysteresis('ACTIVE', 'STALE', 99, 3)).toBe('STALE');
    expect(applyRecoveryHysteresis('ACTIVE', 'COMM_LOST', 99, 3)).toBe('COMM_LOST');
    expect(applyRecoveryHysteresis('ACTIVE', 'LOST', 99, 3)).toBe('LOST');
    expect(applyRecoveryHysteresis('DEGRADED', 'STALE', 99, 3)).toBe('STALE');
  });

  it('live <-> live transitions are free (ACTIVE <-> DEGRADED)', () => {
    // Health-driven, not comms-driven. A FAULT report doesn't need
    // hysteresis -- the asset is talking, just unhappy.
    expect(applyRecoveryHysteresis('ACTIVE', 'DEGRADED', 0, 3)).toBe('DEGRADED');
    expect(applyRecoveryHysteresis('DEGRADED', 'ACTIVE', 0, 3)).toBe('ACTIVE');
  });

  it('silent -> live with INSUFFICIENT samples holds previous silent tier', () => {
    // The bug shape: one new sample after a long silence shouldn't
    // pull a LOST asset back to ACTIVE. With recovery_samples_n=3 and
    // only 1 sample observed, we hold LOST.
    expect(applyRecoveryHysteresis('LOST', 'ACTIVE', 1, 3)).toBe('LOST');
    expect(applyRecoveryHysteresis('COMM_LOST', 'ACTIVE', 2, 3)).toBe('COMM_LOST');
    expect(applyRecoveryHysteresis('STALE', 'ACTIVE', 0, 3)).toBe('STALE');
    expect(applyRecoveryHysteresis('STALE', 'DEGRADED', 0, 3)).toBe('STALE');
  });

  it('silent -> live with SUFFICIENT samples accepts candidate', () => {
    expect(applyRecoveryHysteresis('LOST', 'ACTIVE', 3, 3)).toBe('ACTIVE');
    expect(applyRecoveryHysteresis('COMM_LOST', 'ACTIVE', 5, 3)).toBe('ACTIVE');
    expect(applyRecoveryHysteresis('STALE', 'DEGRADED', 3, 3)).toBe('DEGRADED');
  });

  it('threshold of 1 = no hysteresis (immediate recovery)', () => {
    // Deployments that want a snappy recovery (or no hysteresis at
    // all) can set recovery_samples_n: 1.
    expect(applyRecoveryHysteresis('LOST', 'ACTIVE', 1, 1)).toBe('ACTIVE');
    expect(applyRecoveryHysteresis('STALE', 'DEGRADED', 1, 1)).toBe('DEGRADED');
  });

  it('boundary: samples == n-1 holds, samples == n recovers', () => {
    // Pin the >= comparator -- a future "off by one" refactor would
    // surface here.
    expect(applyRecoveryHysteresis('LOST', 'ACTIVE', 2, 3)).toBe('LOST');
    expect(applyRecoveryHysteresis('LOST', 'ACTIVE', 3, 3)).toBe('ACTIVE');
  });
});

describe('tierOutline + tierShortCode + tierLabel', () => {
  it('outline role per tier', () => {
    expect(tierOutline('ACTIVE')).toBe('severity');
    expect(tierOutline('DEGRADED')).toBe('severity');
    expect(tierOutline('STALE')).toBe('slate');
    expect(tierOutline('COMM_LOST')).toBe('amber');
    expect(tierOutline('LOST')).toBe('none');
  });
  it('short codes are 2 chars and unique', () => {
    const codes = TIER_ORDER.map(tierShortCode);
    codes.forEach(c => expect(c).toHaveLength(2));
    expect(new Set(codes).size).toBe(5);
  });
  it('human labels are non-empty and unique', () => {
    const labels = TIER_ORDER.map(tierLabel);
    labels.forEach(l => expect(l.length).toBeGreaterThan(0));
    expect(new Set(labels).size).toBe(5);
  });
});
