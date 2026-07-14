// Pin the asset-label rendering rules. Two rules currently:
//
//   1. asset_id is always shown (it's the guaranteed-unique key).
//   2. callsign is appended ONLY when it's both non-empty AND
//      distinct from asset_id. Some customer feeds emit asset_id as
//      the callsign when the upstream callsign field is unset; without
//      the de-dupe rule that rendered "X — X" in every picker.
//
// Header.pickerLabel further appends `(${platform_variant})`; the
// dedup at this layer ensures the picker never renders
// "X — X (variant)". One source of truth for the rule.
import { describe, expect, it } from 'vitest';
import { assetLabel, assetCallsign } from '../assetLabel';

describe('assetLabel', () => {
  it('returns just asset_id when callsign is missing', () => {
    expect(assetLabel({ asset_id: 'dis:1:1:42' })).toBe('dis:1:1:42');
  });

  it('returns just asset_id when callsign is null', () => {
    expect(assetLabel({ asset_id: 'dis:1:1:42', callsign: null })).toBe('dis:1:1:42');
  });

  it('returns just asset_id when callsign is empty string', () => {
    expect(assetLabel({ asset_id: 'dis:1:1:42', callsign: '' })).toBe('dis:1:1:42');
  });

  it('returns just asset_id when callsign is whitespace-only', () => {
    expect(assetLabel({ asset_id: 'dis:1:1:42', callsign: '   ' })).toBe('dis:1:1:42');
  });

  it('appends callsign when it is distinct from asset_id', () => {
    expect(assetLabel({ asset_id: 'dis:1:1:42', callsign: 'IRON-LEAD' }))
      .toBe('dis:1:1:42 — IRON-LEAD');
  });

  it('trims whitespace before comparing + appending', () => {
    expect(assetLabel({ asset_id: 'X', callsign: '  X  ' })).toBe('X');
    expect(assetLabel({ asset_id: 'X', callsign: '  Y  ' })).toBe('X — Y');
  });

  // The bug this rule was added for. Customer overlay's
  // weapons-capability feed emits asset_id == callsign, which
  // without the dedup rendered:
  //   "MRAD_Interceptor_40-... — MRAD_Interceptor_40-... (CUAS_Interceptor)"
  // in the asset picker.
  it('de-dupes when callsign equals asset_id (customer-feed bug)', () => {
    const a = { asset_id: 'MRAD_Interceptor_40-001', callsign: 'MRAD_Interceptor_40-001' };
    expect(assetLabel(a)).toBe('MRAD_Interceptor_40-001');
    // Confirm we did NOT render the duplicated form.
    expect(assetLabel(a)).not.toContain('—');
  });
});

describe('assetCallsign', () => {
  it('returns null when callsign is missing', () => {
    expect(assetCallsign({ asset_id: 'X' })).toBeNull();
  });

  it('returns null when callsign is null', () => {
    expect(assetCallsign({ asset_id: 'X', callsign: null })).toBeNull();
  });

  it('returns null when callsign is empty', () => {
    expect(assetCallsign({ asset_id: 'X', callsign: '' })).toBeNull();
  });

  it('returns null when callsign is whitespace-only', () => {
    expect(assetCallsign({ asset_id: 'X', callsign: '   ' })).toBeNull();
  });

  it('returns the trimmed callsign when distinct from asset_id', () => {
    expect(assetCallsign({ asset_id: 'X', callsign: 'IRON-LEAD' })).toBe('IRON-LEAD');
    expect(assetCallsign({ asset_id: 'X', callsign: '  IRON-LEAD  ' })).toBe('IRON-LEAD');
  });

  // Mirrors the assetLabel de-dupe so a secondary-line caller never
  // renders the asset_id twice in the UI either.
  it('returns null when callsign equals asset_id (after trim)', () => {
    expect(assetCallsign({ asset_id: 'X', callsign: 'X' })).toBeNull();
    expect(assetCallsign({ asset_id: 'X', callsign: '  X  ' })).toBeNull();
  });
});
