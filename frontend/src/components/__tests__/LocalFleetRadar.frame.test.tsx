// The radar is a bare square: no title bar, no frame of its own (the
// overlay slot draws the one outline), and labels stay inside the square.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import LocalFleetRadar from '../LocalFleetRadar';

type Props = Parameters<typeof LocalFleetRadar>[0];
const render = (props: Props) => renderToStaticMarkup(<LocalFleetRadar {...props} />);

describe('LocalFleetRadar frame', () => {
  it('has no title and no frame of its own', () => {
    const html = render({ localAssets: [], centerLat: 0, centerLon: 0 });
    expect(html).not.toMatch(/FLEET RADAR|KM RING|CENTERLESS/);
    const classes = html.match(/^<div class="([^"]*)"/)![1].split(/\s+/);
    expect(classes).toContain('w-[176px]');
    expect(classes).toContain('h-[176px]');
    expect(classes).not.toContain('border');
    expect(classes).not.toContain('panel');
  });

  it('puts a label that would cross the edge on the inner side', () => {
    // Lone asset due east lands on the outer ring (x = 90); its 12-char
    // label outward would run to ~149, past the 125 edge.
    const asset = { id: 'unit-east-01', type: 'LAUNCHER', node_id: 'edge-01', lat: 0, lon: 0.5 };
    const html = render({ localAssets: [asset], centerLat: 0, centerLon: 0 } as unknown as Props);
    expect(html).toMatch(/<text x="81"[^>]*text-anchor="end"[^>]*>unit-east-01</);
  });

  it('keeps a short label outward', () => {
    const asset = { id: 'u1', type: 'LAUNCHER', node_id: 'edge-01', lat: 0, lon: 0.5 };
    const html = render({ localAssets: [asset], centerLat: 0, centerLon: 0 } as unknown as Props);
    expect(html).toMatch(/<text x="99"[^>]*text-anchor="start"[^>]*>u1</);
  });
});
