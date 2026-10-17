import { describe, expect, it } from 'vitest';
import MunitionTrackHolo, * as holo from '../MunitionTrackHolo';

describe('MunitionTrackHolo sizes', () => {
  it('exports every pixel constant as a finite number > 0', () => {
    const px = Object.entries(holo).filter(([k]) => k.endsWith('_PX'));
    expect(px.length).toBeGreaterThanOrEqual(10);
    for (const [k, v] of px) {
      expect(typeof v, k).toBe('number');
      expect(Number.isFinite(v as number), k).toBe(true);
      expect(v as number, k).toBeGreaterThan(0);
    }
  });

  it('takes no scene-unit size prop', () => {
    type Keys = keyof holo.MunitionTrackHoloProps;
    const banned: Array<'scale' | 'size' | 'radius'> = ['scale', 'size', 'radius'];
    // Compile-time: no banned key may be assignable to Keys.
    const none: Extract<Keys, 'scale' | 'size' | 'radius'> extends never ? true : false = true;
    expect(none).toBe(true);
    expect(banned).toHaveLength(3);
    // @ts-expect-error radius is not a prop
    const props: holo.MunitionTrackHoloProps = { track: { munitionAssetId: 'dis:9:9:1', launcherAssetId: null }, trail: [], groundY: 0, radius: 1 };
    expect(props).toBeDefined();
    expect(typeof MunitionTrackHolo).toBe('function');
  });
});
