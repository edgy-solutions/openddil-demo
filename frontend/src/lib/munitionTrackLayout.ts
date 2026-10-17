// munitionTrackLayout -- where an in-flight munition_track row sits on a map.
// The row carries ECEF metres; every map works in lat/lon first, so this is
// the one conversion (ecefToWgs84 in geoProjection) and each map then runs
// the result through its own projection, the same path a fleet asset takes.
import { ecefToWgs84 } from './geoProjection';
import type { MunitionTrack } from '../hooks/useMunitionTracks';

/** Geodetic position of a track (h = ellipsoidal height, metres), or null when the row has no usable ECEF. */
export function trackLatLon(
  t: Pick<MunitionTrack, 'ecefX' | 'ecefY' | 'ecefZ'>,
): { lat: number; lon: number; h: number } | null {
  if (t.ecefX === null || t.ecefY === null || t.ecefZ === null) return null;
  return ecefToWgs84(t.ecefX, t.ecefY, t.ecefZ);
}
