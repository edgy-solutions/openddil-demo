// Where HQ sits on the HQ theater, and what its marker says.
import type { HqLocation } from '../deployment';
import { HQ_NODE } from './theaterTopology';

type ScenePoint = [number, number];
type Projector = { project: (lat: number, lon: number) => ScenePoint };

/** HQ's scene [x, z]: the configured location projected, else the origin
 *  (the FOB centroid). The projection itself never includes HQ. */
export function hqScenePos(hq: HqLocation | undefined, proj: Projector): ScenePoint {
  return hq ? proj.project(hq.lat, hq.lon) : [0, 0];
}

/** The HQ marker's label text: `HQ`, or `HQ · <label>` when one is configured. */
export function hqLabelText(hq: HqLocation | undefined): string {
  return hq?.label ? `HQ · ${hq.label}` : 'HQ';
}

/** Scene [x, z] per drawn node, plus HQ at `hqPos`. */
export function buildNodePos(
  nodes: { id: string; lat: number; lon: number }[],
  proj: Projector,
  hqPos: ScenePoint,
): Map<string, ScenePoint> {
  const m = new Map<string, ScenePoint>([[HQ_NODE, hqPos]]);
  for (const n of nodes) m.set(n.id, proj.project(n.lat, n.lon));
  return m;
}
