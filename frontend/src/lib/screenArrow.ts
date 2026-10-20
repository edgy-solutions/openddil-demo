/**
 * CSS rotation (degrees, clockwise) that turns a right-pointing arrow to run from screen point
 * `from` to screen point `to`. Both are NDC, where y grows upward; CSS y grows downward.
 */
export function screenArrowDeg(from: { x: number; y: number }, to: { x: number; y: number }): number {
  // + 0 turns -0 (a target dead right) into 0.
  return (Math.atan2(-(to.y - from.y), to.x - from.x) * 180) / Math.PI + 0;
}
