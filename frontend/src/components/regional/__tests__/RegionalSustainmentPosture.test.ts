// Pins RegionalSustainmentPosture's assetShortName contract (ADR-0047:
// asset_id is opaque -- it must never be split/sliced to derive the
// callout's short-name label).
//
// assetShortName is module-private and the component is a react-three-
// fiber scene with no WebGL/jsdom test harness in this project's dev
// deps (see EdgePulldown.test.tsx for the project's no-@testing-library
// convention), so this reimplements the same shape as a contract test
// rather than importing the component. If
// RegionalSustainmentPosture.tsx's assetShortName changes, this test
// moves with it.
import { describe, expect, it } from 'vitest';
import { assetCallsign } from '../../../lib/assetLabel';

function assetShortName(assetId: string, callsign: string | null): string {
  const cs = assetCallsign({ asset_id: assetId, callsign });
  return cs ?? assetId;
}

describe('assetShortName', () => {
  it('uses the declared callsign when present and distinct from asset_id', () => {
    expect(assetShortName('prop:unit-123', 'Launcher1')).toBe('Launcher1');
  });

  it('falls back to the full asset_id when callsign is absent (null)', () => {
    expect(assetShortName('prop:unit-123', null)).toBe('prop:unit-123');
  });

  it('falls back to the full asset_id when callsign equals asset_id', () => {
    expect(assetShortName('prop:unit-123', 'prop:unit-123')).toBe('prop:unit-123');
  });

  it('never slices or splits the asset_id to derive a name', () => {
    const longId = 'prop:some-very-long-native-unit-identifier_with_underscores';
    expect(assetShortName(longId, null)).toBe(longId);
  });
});
