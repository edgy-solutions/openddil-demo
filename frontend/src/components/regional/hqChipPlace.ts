import * as THREE from 'three';
import { paneEdgePoint, screenArrowDeg } from '../../lib/screenArrow';

export const HQ_CHIP_MARGIN_PX = 12;

export interface HqChipState { x: number; y: number; deg: number }

/**
 * One frame of the off-map HQ chip: project, place, write the DOM. Plain function, so refs stay out of render rules.
 * `end` is the far end of the faded link line: while it projects in front of the camera and inside the pane (less
 * the margin and half the chip) the chip sits on it, so the line fades into the chip. Otherwise the chip is
 * clamped to the pane edge along the on-screen direction node -> `at`, which is where the line leaves the view.
 * The arrow always follows that direction. The DOM is written only when the chip or arrow moved.
 */
export function placeHqChip(
  st: HqChipState, el: HTMLElement | null, arrow: HTMLElement | null,
  from: THREE.Vector3, at: THREE.Vector3, end: THREE.Vector3, camera: THREE.Camera,
  size: { width: number; height: number }, pf: THREE.Vector3, pt: THREE.Vector3,
) {
  if (!el) return;
  // A point one world unit from the node toward HQ keeps both points in front of the camera.
  let dx = at.x - from.x;
  let dz = at.z - from.z;
  const len = Math.hypot(dx, dz);
  if (len > 0) { dx /= len; dz /= len; } else { dx = 1; dz = 0; }
  pf.copy(from).project(camera);
  pt.set(from.x + dx, from.y, from.z + dz).project(camera);
  const sx = ((pt.x - pf.x) * size.width) / 2;
  const sy = (-(pt.y - pf.y) * size.height) / 2;
  const origin = { x: ((pf.x + 1) / 2) * size.width, y: ((1 - pf.y) / 2) * size.height };
  const chip = { w: el.offsetWidth, h: el.offsetHeight };
  // Reuse `pt` for the far end; the direction above is already computed.
  pt.copy(end).project(camera);
  const ex = ((pt.x + 1) / 2) * size.width;
  const ey = ((1 - pt.y) / 2) * size.height;
  const m = HQ_CHIP_MARGIN_PX;
  const onScreen = pt.z >= -1 && pt.z <= 1
    && ex >= m + chip.w / 2 && ex <= size.width - m - chip.w / 2
    && ey >= m + chip.h / 2 && ey <= size.height - m - chip.h / 2;
  const p = onScreen
    ? { x: ex, y: ey }
    : paneEdgePoint(origin, { x: sx, y: sy }, { w: size.width, h: size.height }, m, chip);
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
  if (!(Math.abs(p.x - st.x) < 0.5 && Math.abs(p.y - st.y) < 0.5)) {
    st.x = p.x; st.y = p.y;
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y}px`;
    el.style.visibility = 'visible';
  }
  if (arrow) {
    const deg = screenArrowDeg({ x: 0, y: 0 }, { x: sx, y: -sy });
    if (!Number.isFinite(st.deg) || Math.abs(deg - st.deg) >= 1) {
      st.deg = deg;
      arrow.style.transform = `rotate(${deg}deg)`;
    }
  }
}
