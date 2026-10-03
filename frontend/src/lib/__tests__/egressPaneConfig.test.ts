// `parseEgressPane` decides whether the HQ view renders the egress admission
// pane at all, so it is tested directly, like parseReleasedRecordsPanes.
import { describe, expect, it } from 'vitest';
import { parseEgressPane } from '../../deployment';

describe('parseEgressPane', () => {
  it('keeps a destination', () => {
    expect(parseEgressPane({ destination: 'system:c2-stand-in-atl' })).toEqual({
      destination: 'system:c2-stand-in-atl',
    });
  });

  it('trims the destination', () => {
    expect(parseEgressPane({ destination: '  system:x  ' })).toEqual({ destination: 'system:x' });
  });

  it('hides the pane when the entry is absent or malformed', () => {
    expect(parseEgressPane(undefined)).toBeUndefined();
    expect(parseEgressPane(null)).toBeUndefined();
    expect(parseEgressPane(true)).toBeUndefined();
    expect(parseEgressPane([{ destination: 'system:x' }])).toBeUndefined();
    expect(parseEgressPane({})).toBeUndefined();
    expect(parseEgressPane({ destination: '' })).toBeUndefined();
    expect(parseEgressPane({ destination: '   ' })).toBeUndefined();
    expect(parseEgressPane({ destination: 7 })).toBeUndefined();
  });
});
