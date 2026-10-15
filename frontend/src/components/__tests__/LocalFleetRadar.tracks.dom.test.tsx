// @vitest-environment jsdom
// In-flight munition tracks on the edge radar (ADR-0049): one marker element
// per track row passed in, a line to the launcher only when the launcher is a
// radar asset. A terminal track is never passed (the shape filters it), so the
// radar draws exactly what it is given.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import LocalFleetRadar from '../LocalFleetRadar';
import { mapMunitionTrack } from '../../hooks/useMunitionTracks';

// A point roughly 0.1 deg of arc from the radar centre, as ECEF metres.
function ecefNear(lat: number, lon: number) {
  const r = 6371000;
  const la = (lat * Math.PI) / 180;
  const lo = (lon * Math.PI) / 180;
  return { ecef_x: r * Math.cos(la) * Math.cos(lo), ecef_y: r * Math.cos(la) * Math.sin(lo), ecef_z: r * Math.sin(la) };
}

const CENTER = { lat: 10, lon: 20 };
const ASSETS = [{ id: 'dis:1:1:42', type: 'V', node_id: '', lat: 10.02, lon: 20.02 }];

function track(id: string, launcher: string | null, lat: number, lon: number) {
  return mapMunitionTrack({
    munition_asset_id: id,
    launcher_asset_id: launcher,
    munition_type: '2.1.225.1.0.0.0',
    ...ecefNear(lat, lon),
  });
}

describe('LocalFleetRadar munition tracks', () => {
  afterEach(cleanup);

  it('renders one marker per in-flight track with its launcher', () => {
    const { container } = render(
      <LocalFleetRadar
        localAssets={ASSETS}
        centerLat={CENTER.lat}
        centerLon={CENTER.lon}
        munitionTracks={[
          track('dis:1:1:5001', 'dis:1:1:42', 10.05, 20.05),
          track('dis:1:1:5002', null, 9.95, 19.95),
        ]}
      />,
    );
    const markers = screen.getAllByTestId('munition-track-marker');
    expect(markers).toHaveLength(2);
    expect(markers.map((m) => m.getAttribute('data-munition'))).toEqual(['dis:1:1:5001', 'dis:1:1:5002']);
    expect(markers.map((m) => m.getAttribute('data-launcher'))).toEqual(['dis:1:1:42', '']);
    // Line only for the track whose launcher is on the radar.
    expect(markers[0].querySelector('line')).not.toBeNull();
    expect(markers[1].querySelector('line')).toBeNull();
    // Tracks are not assets: no extra asset labels were added.
    expect(container.querySelectorAll('text')).toHaveLength(1);
  });

  it('renders no marker when no track is passed', () => {
    render(<LocalFleetRadar localAssets={ASSETS} centerLat={CENTER.lat} centerLon={CENTER.lon} munitionTracks={[]} />);
    expect(screen.queryAllByTestId('munition-track-marker')).toHaveLength(0);
  });
});
