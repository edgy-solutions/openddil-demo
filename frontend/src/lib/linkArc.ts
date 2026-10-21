// The HQ link's arc over the ground.
export type Vec3 = [number, number, number];

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * `n + 1` points from `start` to `end`, bowed up by 6% of the horizontal length. The ends are
 * exactly `start` and `end`; between them the arc stays `clear` above the ground, the
 * clearance easing in over the first and last 15% so a link meets its endpoints.
 */
export function linkArc(start: Vec3, end: Vec3, groundY: (x: number, z: number) => number, n = 48, clear = 3): Vec3[] {
  const h = 0.06 * Math.hypot(end[0] - start[0], end[2] - start[2]);
  const out: Vec3[] = [];
  for (let i = 0; i <= n; i++) {
    if (i === 0) { out.push([start[0], start[1], start[2]]); continue; }
    if (i === n) { out.push([end[0], end[1], end[2]]); continue; }
    const t = i / n;
    const x = start[0] + (end[0] - start[0]) * t;
    const z = start[2] + (end[2] - start[2]) * t;
    const y = start[1] + (end[1] - start[1]) * t + h * Math.sin(Math.PI * t);
    out.push([x, Math.max(y, groundY(x, z) + clear * smoothstep(0, 0.15, Math.min(t, 1 - t))), z]);
  }
  return out;
}

/**
 * Per-point alpha for a line that fades out at its far end: 1 up to `1 - fadeEnd` of the point list
 * (by index), then linear down to 0 at the last point. `fadeEnd` is clamped to 0..1.
 */
export function fadeAlphas(n: number, fadeEnd: number): number[] {
  const f = Math.min(1, Math.max(0, fadeEnd));
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) : 0;
    out.push(f > 0 && t > 1 - f ? Math.max(0, (1 - t) / f) : 1);
  }
  return out;
}
