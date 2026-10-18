// Camera presets for the regional map: where to put the camera, as pure data.
export type Vec3 = [number, number, number];
export interface CameraPreset {
  key: string;
  label: string;
  /** Where OrbitControls looks. */
  target: Vec3;
  /** Where the camera sits. */
  pos: Vec3;
}

export interface PresetInputs {
  /** Every renderable asset's drawn ground position. */
  points: Vec3[];
  clusters: { key: string; label: string; points: Vec3[] }[];
  /** One per in-flight track whose launcher is on the map. `dir` is the horizontal (x, z) direction of the climb. */
  launches: { key: string; callsign: string; launcher: Vec3; dir: [number, number] }[];
}

const MAX_DIST = 280; // under the controls' maxDistance of 300

function bbox(points: Vec3[]) {
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]), zs = points.map((p) => p[2]);
  const lo = [Math.min(...xs), Math.min(...ys), Math.min(...zs)];
  const hi = [Math.max(...xs), Math.max(...ys), Math.max(...zs)];
  const c: Vec3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  return { c, r: Math.hypot(hi[0] - lo[0], hi[2] - lo[2]) / 2 };
}

/** Look at the centre of `points` from above and south, far enough to hold them all. */
function framing(points: Vec3[], minDist: number, k: number): { target: Vec3; pos: Vec3 } {
  const { c, r } = bbox(points);
  const d = Math.min(MAX_DIST, Math.max(minDist, r * k));
  return { target: c, pos: [c[0], c[1] + 0.6 * d, c[2] + 0.8 * d] };
}

/** Beside a launch, looking along the first few km of the climb. */
export function launchView(launcher: Vec3, dir: [number, number]): { target: Vec3; pos: Vec3 } {
  const len = Math.hypot(dir[0], dir[1]);
  const [dx, dz] = len > 1e-9 ? [dir[0] / len, dir[1] / len] : [0, -1];
  const sx = -dz, sz = dx;
  return {
    target: [launcher[0] + dx * 0.2, launcher[1] + 0.35, launcher[2] + dz * 0.2],
    pos: [launcher[0] - dx * 0.2 + sx * 2.0, launcher[1] + 0.5, launcher[2] - dz * 0.2 + sz * 2.0],
  };
}

/** The camera that flies to a selected asset: the asset as target, the camera a little up and to the side. */
export function assetFocus(at: Vec3): { target: Vec3; pos: Vec3 } {
  return { target: at, pos: [at[0] + 0.35, at[1] + 0.25, at[2] + 0.35] };
}

/** OVERVIEW, then one preset per cluster, then one per in-flight track. */
export function buildPresets(i: PresetInputs): CameraPreset[] {
  const out: CameraPreset[] = [];
  if (i.points.length > 0) out.push({ key: 'overview', label: 'OVERVIEW', ...framing(i.points, 8, 3.6) });
  for (const c of i.clusters) {
    if (c.points.length === 0) continue;
    out.push({ key: `cluster:${c.key}`, label: c.label, ...framing(c.points, 1.6, 3.2) });
  }
  for (const l of i.launches) {
    out.push({ key: `launch:${l.key}`, label: `LAUNCH ${l.callsign}`, ...launchView(l.launcher, l.dir) });
  }
  return out;
}
