import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { Line, Html } from '@react-three/drei';
import * as THREE from 'three';
import { fadeAlphas, linkArc } from '../lib/linkArc';
import type { DdilLinkStatus } from '../lib/linkStatus';

// NOMINAL up, IDLE up with no traffic (amber, solid), SEVERED down, UNKNOWN not
// measured (slate, dashed), UNREACHABLE an ancestor link is down so this one cannot
// be measured (grey, dashed, labelled with the ancestor).
const LINK_COLOR = { NOMINAL: '#10b981', IDLE: '#f59e0b', SEVERED: '#f43f5e', UNKNOWN: '#64748b', UNREACHABLE: '#94a3b8' } as const;

interface DdilNetworkLinkProps {
  start: THREE.Vector3;
  end: THREE.Vector3;
  status: DdilLinkStatus;
  /** For UNREACHABLE: the nearest down ancestor, named in the label. */
  via?: string;
  /** Ground height at (x, z). When given, the link arcs over the ground instead of running straight. */
  groundY?: (x: number, z: number) => number;
  /** Draw the line at 0.35 of its usual opacity (another link has the focus). */
  dim?: boolean;
  /** Height the arc keeps above the ground away from its ends (default 3, the HQ map's scale). */
  clearance?: number;
  /** Fade the last fraction (0..1) of the line out to nothing; the SEVERED ring at `end` is then not drawn. */
  fadeEnd?: number;
}

export default function DdilNetworkLink({ start, end, status, via, groundY, dim, clearance, fadeEnd }: DdilNetworkLinkProps) {
  const bufferRingRef = useRef<THREE.Mesh>(null);
  
  const points = useMemo(
    () => groundY
      ? linkArc(start.toArray(), end.toArray(), groundY, undefined, clearance).map(([x, y, z]) => new THREE.Vector3(x, y, z))
      : [start, end],
    [start, end, groundY, clearance],
  );
  const mid = useMemo(
    () => (groundY ? points[points.length >> 1] : start.clone().lerp(end, 0.5)),
    [groundY, points, start, end],
  );
  
  const color = LINK_COLOR[status];
  // RGBA per point: the status colour with the alpha ramp. The material colour stays white so it does not tint them.
  const vertexColors = useMemo(() => {
    if (fadeEnd === undefined) return undefined;
    const c = new THREE.Color(color);
    return fadeAlphas(points.length, fadeEnd).map((a) => [c.r, c.g, c.b, a] as [number, number, number, number]);
  }, [fadeEnd, points, color]);
  const dashed = status === 'SEVERED' || status === 'UNKNOWN' || status === 'UNREACHABLE';
  
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
        color={vertexColors ? 'white' : color}
        vertexColors={vertexColors}
        lineWidth={status === 'SEVERED' ? 3 : 1.5}
        dashed={dashed}
        dashSize={5}
        gapSize={5}
        transparent
        opacity={(status === 'SEVERED' ? 1 : 0.6) * (dim ? 0.35 : 1)}
      />
      
      {status === 'UNREACHABLE' && (
        <Html position={mid} center style={{ pointerEvents: 'none', whiteSpace: 'nowrap' }}>
          <span className="font-mono text-[9px] tracking-widest text-slate-400 bg-slate-900/80 px-1">
            unreachable via {via ?? 'ancestor'}
          </span>
        </Html>
      )}

      {status === 'SEVERED' && fadeEnd === undefined && (
        <mesh ref={bufferRingRef} position={end} rotation={[-Math.PI/2, 0, 0]}>
          <ringGeometry args={[2, 3, 32]} />
          <meshBasicMaterial color="#f43f5e" transparent opacity={0.8} side={THREE.DoubleSide} />
        </mesh>
      )}
    </group>
  );
}
