// engagementFrame -- what the engagement inset keeps in view.
import * as THREE from 'three';
import type { Vec3 } from '../components/MunitionTrackHolo';

export interface InsetRect { x: number; y: number; w: number; h: number }
/** CSS pixels from the canvas's bottom-left: above the one-line controls hint both maps put there. */
export const INSET_RECT: InsetRect = { x: 16, y: 40, w: 320, h: 210 };

/** The frame never gets tighter than this radius (scene units). */
export const MIN_RADIUS = 0.8;

/** Centre and radius of the points, with each point's ground footprint included. */
export function frameOf(focus: Vec3[], groundY: number): { c: THREE.Vector3; r: number } | null {
  if (!focus.length) return null;
  const box = new THREE.Box3();
  for (const p of focus) {
    if (!p.every(Number.isFinite)) continue;
    box.expandByPoint(new THREE.Vector3(p[0], p[1], p[2]));
    box.expandByPoint(new THREE.Vector3(p[0], groundY, p[2]));
  }
  if (box.isEmpty()) return null;
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  return { c: sphere.center, r: Math.max(MIN_RADIUS, sphere.radius) };
}


const STEPS_KM = [0.5, 1, 2, 5, 10, 20, 50, 100];
/** Grid cell (km) for a frame of radius r: about eight cells across the frame. */
export function gridStepKm(r: number, unitsPerKm: number): number {
  const acrossKm = (2 * r) / unitsPerKm;
  return STEPS_KM.find((s) => acrossKm / s <= 8) ?? STEPS_KM[STEPS_KM.length - 1];
}

/** What the inset keeps in frame: every trail sample, each launcher and each known target. */
export function engagementFocus(
  entries: { trail: Vec3[]; launcher?: Vec3; target?: Vec3 }[],
): Vec3[] {
  const out: Vec3[] = [];
  for (const e of entries) {
    out.push(...e.trail);
    if (e.launcher) out.push(e.launcher);
    if (e.target) out.push(e.target);
  }
  return out;
}

/**
 * Track height in scene units above the map's ground, from the munition's
 * ellipsoidal height and its launcher's. The maps draw every asset on one
 * ground plane, so a site's own elevation (the sim puts entities at 1600-1800 m)
 * is not flight; with no launcher altitude the ellipsoidal height is used as is.
 */
export function heightAboveLaunch(hM: number, launcherAltM: number | null | undefined, unitsPerKm: number): number {
  const agl = launcherAltM == null || !Number.isFinite(launcherAltM) ? hM : hM - launcherAltM;
  return (Math.max(0, agl) / 1000) * unitsPerKm;
}

/** Lift a flight point at least 50 m above the ground under it. Flight height is
 *  true-scale but relief may be exaggerated, so a low track could otherwise
 *  sit inside a hill. */
export function clearOfGround(y: number, groundY: number, unitsPerKm: number): number {
  return Math.max(y, groundY + 0.05 * unitsPerKm);
}
