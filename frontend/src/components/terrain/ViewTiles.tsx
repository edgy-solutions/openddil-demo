// Tracks where the camera looks and how close it is, and reports the tile boxes of
// sharp imagery that view wants. Mount inside the <Canvas>.
import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { Projection } from '../../lib/geoProjection';
import { M } from '../../lib/sceneScale';
import { worldPerPx } from '../../lib/symbolScale';
import { boxKey, viewRings, viewZoom, type TileBox } from '../../lib/viewTiles';

const CHECK_S = 0.25;
/** The view counts as moving while the target or distance changes by more than this fraction of the distance. */
const STILL_FRAC = 0.01;

export function ViewTiles({ proj, minZ, maxZ, onChange }: {
  proj: Projection; minZ: number; maxZ: number; onChange: (boxes: TileBox[]) => void;
}) {
  const { camera, controls, size } = useThree() as unknown as {
    camera: THREE.PerspectiveCamera; controls: { target: THREE.Vector3 } | null; size: { height: number };
  };
  const cb = useRef(onChange);
  useEffect(() => { cb.current = onChange; });
  const last = useRef<{ target: THREE.Vector3; dist: number } | null>(null);
  const lastKey = useRef<string | null>(null);
  const acc = useRef(0);
  // A new zoom range or projection must re-emit even if the view is still.
  useEffect(() => { lastKey.current = null; }, [proj, minZ, maxZ]);

  useFrame((_, dt) => {
    acc.current += dt;
    if (acc.current < CHECK_S || !controls) return;
    acc.current = 0;
    const target = controls.target;
    const dist = camera.position.distanceTo(target);
    const prev = last.current;
    last.current = { target: target.clone(), dist };
    if (!prev || target.distanceTo(prev.target) > STILL_FRAC * dist || Math.abs(dist - prev.dist) > STILL_FRAC * dist) return;

    const metresPerPx = worldPerPx(dist, size.height, camera.fov) / M;
    const [lat, lon] = proj.unproject(target.x, target.z);
    const zFine = viewZoom(metresPerPx, lat, 0, maxZ);
    const boxes = zFine < minZ ? [] : viewRings(lat, lon, zFine, minZ);
    const key = boxes.map(boxKey).join('|');
    if (key === lastKey.current) return;
    lastKey.current = key;
    cb.current(boxes);
  });
  return null;
}
