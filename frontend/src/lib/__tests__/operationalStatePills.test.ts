// Pin the proto enum-name → pill mapping. The bug we caught in
// commit a96a226 was exactly this: GroundDiagnosticsCard had cases for
// 'POWER_STATE_OPERATE' and 'HEALTH_STATE_OK' which don't exist in the
// proto (proto says POWER_STATE_ON and HEALTH_STATE_NOMINAL). Every
// healthy sensor rendered the '—' fallback pill instead of green.
// These tests fail loud if someone reintroduces the wrong enum name OR
// drops a valid one.
import { describe, expect, it } from 'vitest';
import {
  powerPill, modePill, healthPill,
  PILL_OK, PILL_AMBER, PILL_RED, PILL_CYAN, PILL_SLATE,
} from '../operationalStatePills';

describe('powerPill — POWER_STATE_* enum mapping', () => {
  // Each test asserts both label AND class, so a regression that only
  // shifts the color (e.g. POWER_STATE_OFF accidentally goes to amber
  // instead of red) is caught.
  it('POWER_STATE_OFF -> red OFF', () => {
    expect(powerPill('POWER_STATE_OFF')).toEqual({ label: 'OFF', cls: PILL_RED });
  });
  it('POWER_STATE_SHUTTING_DOWN -> red SHUTTING DOWN', () => {
    expect(powerPill('POWER_STATE_SHUTTING_DOWN')).toEqual({ label: 'SHUTTING DOWN', cls: PILL_RED });
  });
  it('POWER_STATE_MAINTENANCE -> amber MAINTENANCE', () => {
    expect(powerPill('POWER_STATE_MAINTENANCE')).toEqual({ label: 'MAINTENANCE', cls: PILL_AMBER });
  });
  it('POWER_STATE_STANDBY -> slate STANDBY', () => {
    expect(powerPill('POWER_STATE_STANDBY')).toEqual({ label: 'STANDBY', cls: PILL_SLATE });
  });
  it('POWER_STATE_ON -> green ON (NOT POWER_STATE_OPERATE — that proto name does not exist)', () => {
    expect(powerPill('POWER_STATE_ON')).toEqual({ label: 'ON', cls: PILL_OK });
  });
  it('the wrong enum name POWER_STATE_OPERATE falls through to slate em-dash', () => {
    // This is the regression test for the actual bug from commit 83d72c1.
    // If the case is reintroduced under POWER_STATE_OPERATE, this assertion
    // fails: it expects the wrong name to NOT match.
    expect(powerPill('POWER_STATE_OPERATE')).toEqual({ label: '—', cls: PILL_SLATE });
  });
  it('null -> slate em-dash', () => {
    expect(powerPill(null)).toEqual({ label: '—', cls: PILL_SLATE });
  });
  it('UNSPECIFIED -> slate em-dash (proto-default)', () => {
    expect(powerPill('POWER_STATE_UNSPECIFIED')).toEqual({ label: '—', cls: PILL_SLATE });
  });
});

describe('modePill — FUNCTIONAL_MODE_* enum mapping', () => {
  it('FUNCTIONAL_MODE_IDLE -> slate IDLE', () => {
    expect(modePill('FUNCTIONAL_MODE_IDLE')).toEqual({ label: 'IDLE', cls: PILL_SLATE });
  });
  it('FUNCTIONAL_MODE_ACTIVE -> green ACTIVE', () => {
    expect(modePill('FUNCTIONAL_MODE_ACTIVE')).toEqual({ label: 'ACTIVE', cls: PILL_OK });
  });
  it('FUNCTIONAL_MODE_RECEIVE_ONLY -> cyan', () => {
    expect(modePill('FUNCTIONAL_MODE_RECEIVE_ONLY')).toEqual({ label: 'RECEIVE ONLY', cls: PILL_CYAN });
  });
  it('FUNCTIONAL_MODE_TRANSMIT_ONLY -> cyan', () => {
    expect(modePill('FUNCTIONAL_MODE_TRANSMIT_ONLY')).toEqual({ label: 'TRANSMIT ONLY', cls: PILL_CYAN });
  });
  it('FUNCTIONAL_MODE_SCAN -> green', () => {
    expect(modePill('FUNCTIONAL_MODE_SCAN')).toEqual({ label: 'SCAN', cls: PILL_OK });
  });
  it('FUNCTIONAL_MODE_TRACK -> green', () => {
    expect(modePill('FUNCTIONAL_MODE_TRACK')).toEqual({ label: 'TRACK', cls: PILL_OK });
  });
  it('null -> slate em-dash', () => {
    expect(modePill(null)).toEqual({ label: '—', cls: PILL_SLATE });
  });
});

describe('healthPill — HEALTH_STATE_* enum mapping', () => {
  it('HEALTH_STATE_NOMINAL -> green NOMINAL (NOT HEALTH_STATE_OK)', () => {
    expect(healthPill('HEALTH_STATE_NOMINAL')).toEqual({ label: 'NOMINAL', cls: PILL_OK });
  });
  it('HEALTH_STATE_DEGRADED -> amber', () => {
    expect(healthPill('HEALTH_STATE_DEGRADED')).toEqual({ label: 'DEGRADED', cls: PILL_AMBER });
  });
  it('HEALTH_STATE_FAULT -> red', () => {
    expect(healthPill('HEALTH_STATE_FAULT')).toEqual({ label: 'FAULT', cls: PILL_RED });
  });
  it('HEALTH_STATE_FAILED -> red', () => {
    expect(healthPill('HEALTH_STATE_FAILED')).toEqual({ label: 'FAILED', cls: PILL_RED });
  });
  it('the wrong enum name HEALTH_STATE_OK falls through to slate em-dash', () => {
    // Companion regression test to powerPill's POWER_STATE_OPERATE case.
    expect(healthPill('HEALTH_STATE_OK')).toEqual({ label: '—', cls: PILL_SLATE });
  });
  it('null -> slate em-dash', () => {
    expect(healthPill(null)).toEqual({ label: '—', cls: PILL_SLATE });
  });
});

// Sanity: severity-aligned color constants haven't been silently swapped.
// If someone renames PILL_OK to point at the amber class, every other
// downstream check fails — but this catches it directly with a one-line
// readable assertion.
describe('PILL_* color constants are stable severity anchors', () => {
  it('PILL_OK uses the emerald palette', () => {
    expect(PILL_OK).toContain('emerald');
  });
  it('PILL_AMBER uses the amber palette', () => {
    expect(PILL_AMBER).toContain('amber');
  });
  it('PILL_RED uses the rose palette', () => {
    expect(PILL_RED).toContain('rose');
  });
  it('PILL_CYAN uses the cyan palette', () => {
    expect(PILL_CYAN).toContain('cyan');
  });
  it('PILL_SLATE uses the slate palette', () => {
    expect(PILL_SLATE).toContain('slate');
  });
});
