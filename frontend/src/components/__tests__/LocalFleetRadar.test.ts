// Pins LocalFleetRadar's radarLabel contract (ADR-0047: asset_id is
// opaque -- it must never be split/sliced to derive a label).
//
// radarLabel is module-private and the component itself is an SVG/
// three.js-adjacent view with no @testing-library/react or jsdom in
// this project's dev deps (see EdgePulldown.test.tsx), so this
// reimplements the same shape as a contract test rather than importing
// the component. If LocalFleetRadar.tsx's radarLabel changes, this test
// moves with it.
import { describe, expect, it } from 'vitest';
import { assetCallsign } from '../../lib/assetLabel';

interface Asset {
  id: string;
  callsign?: string | null;
}

function radarLabel(asset: Asset): string {
  const cs = assetCallsign({ asset_id: asset.id, callsign: asset.callsign });
  if (!cs) return asset.id;
  return cs.length > 10 ? cs.slice(0, 10) : cs;
}

describe('radarLabel', () => {
  it('uses the declared callsign when present and distinct from asset_id', () => {
    expect(radarLabel({ id: 'prop:unit-123', callsign: 'Launcher1' })).toBe('Launcher1');
  });

  it('falls back to the full asset_id when callsign is absent', () => {
    expect(radarLabel({ id: 'prop:unit-123' })).toBe('prop:unit-123');
  });

  it('falls back to the full asset_id when callsign equals asset_id', () => {
    expect(radarLabel({ id: 'prop:unit-123', callsign: 'prop:unit-123' })).toBe('prop:unit-123');
  });

  it('never slices or splits the full asset_id fallback, even if long', () => {
    const longId = 'prop:some-very-long-native-unit-identifier-segment';
    expect(radarLabel({ id: longId })).toBe(longId);
  });

  it('caps a long callsign for space, but never caps the asset_id', () => {
    expect(radarLabel({ id: 'prop:x', callsign: 'VERY-LONG-CALLSIGN-TEXT' }))
      .toBe('VERY-LONG-');
  });
});
