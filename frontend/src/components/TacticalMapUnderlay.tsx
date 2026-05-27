// =============================================================================
// TacticalMapUnderlay — 3D terrain texture plane
// =============================================================================
// DEMO_MOCK: a decorative static map texture under the 3D scenes. No data
// input, ever — it is pure scenery. This is a react-three-fiber primitive
// (<mesh>) with no DOM wrapper, so it carries the DEMO_MOCK marker as this
// comment + const only; a DOM <DemoMockBanner> cannot live inside a Canvas.
// See ADR-0017.
import { useTexture } from '@react-three/drei';

const DEMO_MOCK = true;
void DEMO_MOCK; // marker only — pure-3D primitive, no DOM banner possible

export default function TacticalMapUnderlay() {
  const texture = useTexture('/map_base.png');

  // Opacity dropped from 0.15 -> 0.03 because the texture's center is the
  // Gulf of Guinea (lat 0, lon 0) but scene origin is now whatever the
  // deployment's FOB centroid resolves to (regional for current demo).
  // At 0.15 the geography misalignment reads as "assets are over Africa";
  // at 0.03 the texture functions as ambient terrain noise without making
  // a geographic claim. A future improvement is to either ship a per-
  // deployment recentred texture or projection-transform this plane to
  // match the scene's geo-frame.
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -2.1, 0]}>
      <planeGeometry args={[2000, 2000]} />
      <meshBasicMaterial map={texture} transparent opacity={0.03} color="#10b981" depthWrite={false} />
    </mesh>
  );
}