// The radar must not claim a slot itself: the canvas owns the bottom-left
// column and stacks the radar under the manual-question panel. Uses
// renderToStaticMarkup, same as the link-independence test.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import LocalFleetRadar from '../LocalFleetRadar';

describe('LocalFleetRadar position', () => {
  it('root does not position itself', () => {
    const html = renderToStaticMarkup(
      <LocalFleetRadar localAssets={[]} centerLat={0} centerLon={0} />,
    );
    const m = html.match(/^<div class="([^"]*)"/);
    expect(m).not.toBeNull();
    const classes = m![1].split(/\s+/);
    for (const c of ['absolute', 'bottom-4', 'left-4']) {
      expect(classes).not.toContain(c);
    }
  });
});
