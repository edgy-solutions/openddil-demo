// Camera-scaled asset symbols: constant size on screen, never smaller than true size.
import { resolveRingRadius } from './assetGeometry';
import { M } from './sceneScale';

/** Symbol radius on screen, CSS px. */
export const PX_R = 16;
/** True half-length of a vehicle, metres. */
export const TRUE_R_M = 6;
/** True half-length of a vehicle, scene units. */
export const R_TRUE = TRUE_R_M * M;

/** World units spanned by one screen pixel at distance `dist`. */
export function worldPerPx(dist: number, heightPx: number, fovDeg: number): number {
  return (2 * dist * Math.tan((fovDeg * Math.PI) / 360)) / heightPx;
}

/** A symbol's base-ring radius in world units: PX_R on screen, never below true size. */
export function symbolRadius(dist: number, heightPx: number, fovDeg: number): number {
  return Math.max(R_TRUE, PX_R * worldPerPx(dist, heightPx, fovDeg));
}

/** Group scale for a model so its base ring has `symbolRadius`. */
export function symbolScale(variant: string | null, dist: number, heightPx: number, fovDeg: number): number {
  return symbolRadius(dist, heightPx, fovDeg) / resolveRingRadius(variant, 1);
}
