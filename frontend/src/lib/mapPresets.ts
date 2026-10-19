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
  /** Extra points that widen the overview framing only (never the clusters). */
  framePoints?: Vec3[];
  /** Pane width / height (default 1.6). A narrow pane backs the camera off to hold the region's width. */
  aspect?: number;
  clusters: { key: string; label: string; points: Vec3[] }[];
  /** One per in-flight track whose launcher is on the map. `dir` is the horizontal (x, z) direction of the climb. */
  launches: { key: string; callsign: string; launcher: Vec3; dir: [number, number] }[];
}

const MAX_DIST = 280; // under the controls' maxDistance of 300
const MAX_OVERVIEW_DIST = 900; // a region can span far more than a cluster
const DEFAULT_ASPECT = 1.6;

function bbox(points: Vec3[]) {
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]), zs = points.map((p) => p[2]);
  const lo = [Math.min(...xs), Math.min(...ys), Math.min(...zs)];
  const hi = [Math.max(...xs), Math.max(...ys), Math.max(...zs)];
  const c: Vec3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  return { c, r: Math.hypot(hi[0] - lo[0], hi[2] - lo[2]) / 2 };
}

/** Look at the centre of `points` from above and south, far enough to hold them all. */
function framing(
  points: Vec3[], minDist: number, k: number, aspect: number, maxDist = MAX_DIST,
): { target: Vec3; pos: Vec3 } {
  const { c, r } = bbox(points);
  const d = Math.min(maxDist, Math.max(minDist, r * k * Math.max(1, 1 / aspect)));
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
  const aspect = i.aspect && i.aspect > 0 ? i.aspect : DEFAULT_ASPECT;
  const overview = [...i.points, ...(i.framePoints ?? [])];
  if (overview.length > 0) out.push({ key: 'overview', label: 'OVERVIEW', ...framing(overview, 8, 3.6, aspect, MAX_OVERVIEW_DIST) });
  for (const c of i.clusters) {
    if (c.points.length === 0) continue;
    out.push({ key: `cluster:${c.key}`, label: c.label, ...framing(c.points, 1.6, 3.2, aspect) });
  }
  for (const l of i.launches) {
    out.push({ key: `launch:${l.key}`, label: `LAUNCH ${l.callsign}`, ...launchView(l.launcher, l.dir) });
  }
  return out;
}

/** OrbitControls maxDistance: room to pull back past the overview, never under 300. */
export function controlsMaxDistance(presets: CameraPreset[]): number {
  const o = presets.find((p) => p.key === 'overview');
  if (!o) return 300;
  const d = Math.hypot(o.pos[0] - o.target[0], o.pos[1] - o.target[1], o.pos[2] - o.target[2]);
  return Math.max(300, 1.15 * d);
}
