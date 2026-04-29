import { useRef, useMemo, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { Line, Html } from '@react-three/drei';
import * as THREE from 'three';

interface LogisticsArcProps {
  start: THREE.Vector3;
  end: THREE.Vector3;
  item: string;
}

export default function LogisticsArc({ start, end, item }: LogisticsArcProps) {
  const droneRef = useRef<THREE.Mesh>(null);
  const [startTime] = useState(() => Date.now());
  const [arrived, setArrived] = useState(false);
  
  const curve = useMemo(() => {
    const midPoint = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
    const distance = start.distanceTo(end);
    midPoint.y += Math.max(20, distance * 0.3); // High arcing path
    return new THREE.QuadraticBezierCurve3(start, midPoint, end);
  }, [start, end]);
  
  const points = useMemo(() => curve.getPoints(50), [curve]);
  
  useFrame(() => {
    if (droneRef.current) {
      const elapsed = (Date.now() - startTime) / 1000;
      const t = Math.min(1, elapsed * 0.05); // Takes 20 seconds to cross the map
      
      const position = curve.getPoint(t);
      droneRef.current.position.copy(position);
      
      if (t < 1) {
        // Look at next point
        const nextT = Math.min(1, t + 0.01);
        const nextPosition = curve.getPoint(nextT);
        droneRef.current.lookAt(nextPosition);
      } else if (!arrived) {
        setArrived(true);
      }
    }
  });

  return (
    <group>
      <Line
        points={points}
        color="#22d3ee"
        lineWidth={1}
        transparent
        opacity={0.6}
      />
      
      <mesh ref={droneRef}>
        <boxGeometry args={[3, 1.5, 3]} />
        <meshBasicMaterial color="#f59e0b" />
        
        {!arrived && (
          <Html position={[0, 4, 0]} center>
            <div className="bg-slate-900/90 border border-slate-700 text-amber-400 font-mono text-[10px] px-2 py-1 whitespace-nowrap shadow-lg">
              INBOUND: {item}
            </div>
          </Html>
        )}
      </mesh>
    </group>
  );
}
