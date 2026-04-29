import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import * as THREE from 'three';

interface DdilNetworkLinkProps {
  start: THREE.Vector3;
  end: THREE.Vector3;
  status: 'NOMINAL' | 'SEVERED';
}

export default function DdilNetworkLink({ start, end, status }: DdilNetworkLinkProps) {
  const bufferRingRef = useRef<THREE.Mesh>(null);
  
  const points = useMemo(() => [start, end], [start, end]);
  
  const color = status === 'NOMINAL' ? '#10b981' : '#f43f5e';
  const dashed = status === 'SEVERED';
  
  useFrame((state) => {
    const time = state.clock.getElapsedTime();
    
    if (status === 'SEVERED' && bufferRingRef.current) {
      const scale = 1 + (time * 2) % 2;
      bufferRingRef.current.scale.set(scale, scale, scale);
      (bufferRingRef.current.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - scale/3);
    }
  });

  return (
    <group>
      <Line
        points={points}
        color={color}
        lineWidth={status === 'NOMINAL' ? 1 : 3}
        dashed={dashed}
        dashSize={5}
        gapSize={5}
        transparent
        opacity={status === 'NOMINAL' ? 0.2 : 1}
      />
      
      {status === 'SEVERED' && (
        <mesh ref={bufferRingRef} position={end} rotation={[-Math.PI/2, 0, 0]}>
          <ringGeometry args={[2, 3, 32]} />
          <meshBasicMaterial color="#f43f5e" transparent opacity={0.8} side={THREE.DoubleSide} />
        </mesh>
      )}
    </group>
  );
}
