// Pin the asset classifier. A launcher is a launcher unless a launch row
// says it fired; absence of a capability row alone is only evidence of a
// munition while the capability feed is demonstrably alive.
import { describe, expect, it } from 'vitest';
import { classifyAsset, makeAssetClassifier } from '../assetClass';

const NONE = { hasCapability: false, capabilityFeedAlive: false, isLaunchedMunition: false };

describe('classifyAsset', () => {
  it.each(['MISSILE_LAUNCHER', 'MRAD_Interceptor', 'SHORAD_Interceptor'])(
    'no capability feed, no launch row: %s is a LAUNCHER',
    (variant) => {
      expect(classifyAsset(variant, NONE)).toBe('LAUNCHER');
    },
  );

  it('live capability feed without this asset keeps the legacy MUNITION rule', () => {
    expect(classifyAsset('MRAD_Interceptor', { ...NONE, capabilityFeedAlive: true })).toBe('MUNITION');
  });

  it.each([true, false])('launch row makes it a MUNITION (feed alive=%s)', (alive) => {
    expect(
      classifyAsset('MRAD_Interceptor', { ...NONE, capabilityFeedAlive: alive, isLaunchedMunition: true }),
    ).toBe('MUNITION');
  });

  it('capability row wins over everything below facility', () => {
    expect(classifyAsset('MRAD_Interceptor', { ...NONE, hasCapability: true, capabilityFeedAlive: true })).toBe('LAUNCHER');
  });

  it('sensor precedence stays above the launch flag', () => {
    expect(classifyAsset('MRAD_Sensor', { ...NONE, isLaunchedMunition: true })).toBe('SENSOR');
  });

  it('facility, unknown, platform', () => {
    expect(classifyAsset('AIR_DEFENSE_SITE', NONE)).toBe('FACILITY');
    expect(classifyAsset(null, NONE)).toBe('UNKNOWN');
    expect(classifyAsset('M1A2', NONE)).toBe('PLATFORM');
  });
});

describe('makeAssetClassifier', () => {
  it('uses the launch row as evidence with an empty capability feed', () => {
    const classify = makeAssetClassifier([], [{ munition_asset_id: 'm-1' }, { munition_asset_id: null }]);
    expect(classify({ asset_id: 'm-1', platform_variant: 'MRAD_Interceptor' })).toBe('MUNITION');
    expect(classify({ asset_id: 'l-1', platform_variant: 'MRAD_Interceptor' })).toBe('LAUNCHER');
  });

  it('a live feed classes an unlisted interceptor as MUNITION', () => {
    const classify = makeAssetClassifier([{ asset_id: 'l-9' }], []);
    expect(classify({ asset_id: 'l-9', platform_variant: 'MRAD_Interceptor' })).toBe('LAUNCHER');
    expect(classify({ asset_id: 'x-1', platform_variant: 'MRAD_Interceptor' })).toBe('MUNITION');
  });
});
