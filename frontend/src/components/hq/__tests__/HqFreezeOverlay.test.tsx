import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import HqFreezeOverlay from '../HqFreezeOverlay';

describe('HqFreezeOverlay', () => {
  it('says all links are down, not that an uplink is severed', () => {
    const html = renderToStaticMarkup(<HqFreezeOverlay />);
    expect(html).toContain('ALL LINKS DOWN');
    expect(html).toContain('SYSTEM FREEZE');
    expect(html).not.toContain('UPLINK');
  });
});
