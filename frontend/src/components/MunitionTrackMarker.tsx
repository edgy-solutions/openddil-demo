// =============================================================================
// MunitionTrackMarker -- one in-flight munition on a 3D map (ADR-0049)
// =============================================================================
// A track layer, not an asset layer: no click-through, no callout card, and
// the row is in no fleet list. The marker is a small amber dot plus a thin
// line to the launcher when the launcher is on the same map.
//
// The testid element goes through drei's <Html> so it exists in the DOM
// (R3F meshes are not DOM); it is a 1px hidden-from-pointer anchor, the dot
// itself is the mesh.
import { Html, Line } from '@react-three/drei';
import type { MunitionTrack } from '../hooks/useMunitionTracks';

const AMBER = '#f59e0b';

export default function MunitionTrackMarker({
  track,
  position,
  launcherPosition,
}: {
  track: Pick<MunitionTrack, 'munitionAssetId' | 'launcherAssetId'>;
  position: [number, number, number];
  /** Launcher's scene position; undefined when it is not on this map. */
  launcherPosition?: [number, number, number];
}) {
  return (
    <group>
      <mesh position={position}>
        <sphereGeometry args={[1.2, 12, 12]} />
        <meshBasicMaterial color={AMBER} />
      </mesh>
      {launcherPosition && (
        <Line points={[launcherPosition, position]} color={AMBER} lineWidth={1} transparent opacity={0.6} />
      )}
      <Html position={position} center style={{ pointerEvents: 'none' }}>
        <div
          data-testid="munition-track-marker"
          data-munition={track.munitionAssetId}
          data-launcher={track.launcherAssetId ?? ''}
          style={{ width: 1, height: 1 }}
        />
      </Html>
    </group>
  );
}
