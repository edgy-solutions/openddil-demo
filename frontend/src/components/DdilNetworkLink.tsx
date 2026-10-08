import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import * as THREE from 'three';

// NOMINAL up, IDLE up with no traffic (amber, solid), SEVERED down, UNKNOWN not
// measured (slate, dashed).
const LINK_COLOR = { NOMINAL: '#10b981', IDLE: '#f59e0b', SEVERED: '#f43f5e', UNKNOWN: '#64748b' } as const;

interface DdilNetworkLinkProps {
  start: THREE.Vector3;
  end: THREE.Vector3;
  status: 'NOMINAL' | 'SEVERED' | 'IDLE' | 'UNKNOWN';
}

export default function DdilNetworkLink({ start, end, status }: DdilNetworkLinkProps) {
  const bufferRingRef = useRef<THREE.Mesh>(null);
  
  const points = useMemo(() => [start, end], [start, end]);
  
  const color = LINK_COLOR[status];
  const dashed = status === 'SEVERED' || status === 'UNKNOWN';
  
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
        lineWidth={status === 'SEVERED' ? 3 : 1.5}
        dashed={dashed}
        dashSize={5}
        gapSize={5}
        transparent
        opacity={status === 'SEVERED' ? 1 : 0.6}
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
