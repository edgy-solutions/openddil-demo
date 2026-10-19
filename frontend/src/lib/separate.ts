/**
 * Screen-pixel overlap removal with minimal displacement: points closer than `minDist`
 * are pushed apart equally along the line between them. Coincident points are first
 * seeded along +x in index order, centred on their common point.
 */
export function separate(points: [number, number][], minDist: number, iters = 40): [number, number][] {
  const p = points.map(([x, y]) => [x, y] as [number, number]);
  const n = p.length;
  const EPS = 1e-6;
  // Seed coincident groups along +x.
  const done = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    if (done[i]) continue;
    const grp = [i];
    for (let j = i + 1; j < n; j++) {
      if (!done[j] && Math.hypot(p[j][0] - p[i][0], p[j][1] - p[i][1]) < EPS) grp.push(j);
    }
    if (grp.length < 2) continue;
    const [cx, cy] = p[i];
    grp.forEach((idx, k) => {
      done[idx] = true;
      p[idx] = [cx + (k - (grp.length - 1) / 2) * minDist, cy];
    });
  }
  // Jacobi relaxation: all pair pushes of an iteration are summed, then applied together,
  // so the result does not depend on pair order.
  for (let it = 0; it < iters; it++) {
    const dx = new Array<number>(n).fill(0);
    const dy = new Array<number>(n).fill(0);
    let moved = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const ex = p[j][0] - p[i][0];
        const ey = p[j][1] - p[i][1];
        const d = Math.hypot(ex, ey);
        if (d >= minDist - EPS) continue;
        const push = (minDist - d) / 2;
        const ux = d > EPS ? ex / d : 1;
        const uy = d > EPS ? ey / d : 0;
        dx[i] -= ux * push; dy[i] -= uy * push;
        dx[j] += ux * push; dy[j] += uy * push;
        moved = true;
      }
    }
    if (!moved) break;
    for (let i = 0; i < n; i++) p[i] = [p[i][0] + dx[i], p[i][1] + dy[i]];
  }
  return p;
}
