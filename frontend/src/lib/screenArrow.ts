/**
 * CSS rotation (degrees, clockwise) that turns a right-pointing arrow to run from screen point
 * `from` to screen point `to`. Both are NDC, where y grows upward; CSS y grows downward.
 */
export function screenArrowDeg(from: { x: number; y: number }, to: { x: number; y: number }): number {
  // + 0 turns -0 (a target dead right) into 0.
  return (Math.atan2(-(to.y - from.y), to.x - from.x) * 180) / Math.PI + 0;
}

/**
 * Where a chip sits when pinned to a pane's edge along a screen direction. All CSS pixels, y down.
 * Returns the chip CENTRE: `origin` clamped into the pane inset by `margin` and half the chip, then
 * marched along `dir` to the first boundary of that inner box. A zero or non-finite `dir` means right.
 */
export function paneEdgePoint(
  origin: { x: number; y: number },
  dir: { x: number; y: number },
  pane: { w: number; h: number },
  margin: number,
  chip: { w: number; h: number },
): { x: number; y: number } {
  const span = (size: number, c: number): [number, number] => {
    const lo = margin + c / 2;
    const hi = size - margin - c / 2;
    return lo > hi ? [(lo + hi) / 2, (lo + hi) / 2] : [lo, hi];
  };
  const [x0, x1] = span(pane.w, chip.w);
  const [y0, y1] = span(pane.h, chip.h);
  const ox = Math.min(Math.max(Number.isFinite(origin.x) ? origin.x : 0, x0), x1);
  const oy = Math.min(Math.max(Number.isFinite(origin.y) ? origin.y : 0, y0), y1);
  let dx = dir.x;
  let dy = dir.y;
  const len = Math.hypot(dx, dy);
  if (!Number.isFinite(len) || len === 0) { dx = 1; dy = 0; } else { dx /= len; dy /= len; }
  let t = Infinity;
  if (dx > 0) t = Math.min(t, (x1 - ox) / dx);
  else if (dx < 0) t = Math.min(t, (x0 - ox) / dx);
  if (dy > 0) t = Math.min(t, (y1 - oy) / dy);
  else if (dy < 0) t = Math.min(t, (y0 - oy) / dy);
  if (!Number.isFinite(t)) t = 0;
  return { x: ox + dx * t, y: oy + dy * t };
}
