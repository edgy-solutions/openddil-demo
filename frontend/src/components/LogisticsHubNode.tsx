import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

export default function LogisticsHubNode({ position }: { position: [number, number, number] }) {
  const beaconRef = useRef<THREE.Mesh>(null);

  useFrame((state) => {
    if (beaconRef.current) {
      const time = state.clock.getElapsedTime();
      // Pulsing slowly (aviation beacon)
      const intensity = 0.5 + Math.sin(time * 3) * 0.5;
      (beaconRef.current.material as THREE.MeshBasicMaterial).opacity = 0.5 + intensity * 0.5;
    }
  });

  return (
    <group position={position}>
      {/* Core hexagonal bunker */}
      <mesh position={[0, 1, 0]}>
        <cylinderGeometry args={[4, 4.5, 2, 6]} />
        <meshStandardMaterial color={0x0f172a} metalness={0.9} roughness={0.1} />
      </mesh>
      
      {/* Holographic data-shield (wireframe) */}
      <mesh position={[0, 1, 0]}>
        <cylinderGeometry args={[4.2, 4.7, 2.2, 6]} />
        <meshBasicMaterial color={0x22d3ee} wireframe transparent opacity={0.15} />
      </mesh>

      {/* Aviation beacon */}
      <mesh ref={beaconRef} position={[0, 2.2, 0]}>
        <sphereGeometry args={[0.3, 16, 16]} />
        <meshBasicMaterial color={0x22d3ee} transparent opacity={1} />
      </mesh>
      <pointLight position={[0, 2.2, 0]} color={0x22d3ee} intensity={2} distance={20} />
    </group>
  );
}