import { useTexture } from '@react-three/drei';

export default function TacticalMapUnderlay() {
  const texture = useTexture('/map_base.png');

  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -2.1, 0]}>
      <planeGeometry args={[2000, 2000]} />
      <meshBasicMaterial map={texture} transparent opacity={0.15} color="#10b981" depthWrite={false} />
    </mesh>
  );
}