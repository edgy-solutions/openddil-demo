// The HQ link's arc over the ground.
export type Vec3 = [number, number, number];

/** `n + 1` points from `start` to `end`, bowed up by 6% of the horizontal length and never under 3 above the ground. */
export function linkArc(start: Vec3, end: Vec3, groundY: (x: number, z: number) => number, n = 48): Vec3[] {
  const h = 0.06 * Math.hypot(end[0] - start[0], end[2] - start[2]);
  const out: Vec3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = i === n ? end[0] : start[0] + (end[0] - start[0]) * t;
    const z = i === n ? end[2] : start[2] + (end[2] - start[2]) * t;
    const y = i === n ? end[1] : start[1] + (end[1] - start[1]) * t + h * Math.sin(Math.PI * t);
    out.push([x, Math.max(y, groundY(x, z) + 3), z]);
  }
  return out;
}
