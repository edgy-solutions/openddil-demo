// =============================================================================
// RenderModeScene — lights / background / fog / environment / floor / bloom
// =============================================================================
// Mount INSIDE a <Canvas>. Wraps children in the RenderModeProvider so every
// SchematicMaterial below sees the mode. MATTE reproduces the previous inline
// scene exactly (background 0x020617, fogExp2 0.05, ambient 0.4, cyan spot).
// METALLIC: procedural Lightformer environment (no network assets), neutral
// key + cyan rim. HOLOGRAPHIC: dark-blue field, holo floor, bloom.
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Environment, Lightformer } from '@react-three/drei';
import { Bloom, EffectComposer } from '@react-three/postprocessing';
import * as THREE from 'three';
import { RenderModeProvider, type RenderMode } from './renderMode';
import { setHoloSweep, setHoloTime } from './holoMaterial';

const MATTE_BG = 0x020617;
const HOLO_BG = 0x02060d;

export interface RenderModeSceneProps {
  mode: RenderMode;
  children?: ReactNode;
  /** Holographic: Y of the floor under the model. */
  floorY?: number;
  /** Holographic: floor radius multiplier (default fits a ~7-unit model). */
  floorScale?: number;
  /** Holographic: scan-sweep band as [baseY, span]. */
  sweep?: readonly [number, number];
}

export function RenderModeScene({ mode, children, floorY = -1, floorScale = 1, sweep = [-1.2, 4.4] }: RenderModeSceneProps) {
  return (
    <RenderModeProvider value={mode}>
      {mode === 'matte' && <MatteLights />}
      {mode === 'metallic' && <MetallicLights />}
      {mode === 'holographic' && <HoloStage floorY={floorY} floorScale={floorScale} sweep={sweep} />}
      <RedrawOnModeChange mode={mode} />
      {children}
    </RenderModeProvider>
  );
}

// The canvas runs frameloop="demand" outside holographic, so nothing redraws
// after a mode switch settles. METALLIC's environment bakes on the first frame
// and the scene stayed blank until the operator dragged the view; ask for a
// few frames whenever the mode changes so the baked result is shown.
function RedrawOnModeChange({ mode }: { mode: RenderMode }) {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    invalidate(3);
    const id = requestAnimationFrame(() => invalidate(3));
    return () => cancelAnimationFrame(id);
  }, [mode, invalidate]);
  return null;
}

function MatteLights() {
  return (
    <>
      <color attach="background" args={[MATTE_BG]} />
      <fogExp2 attach="fog" args={[MATTE_BG, 0.05]} />
      <ambientLight intensity={0.4} />
      <spotLight position={[20, 40, 20]} intensity={1.5} color={0x22d3ee} />
    </>
  );
}

function MetallicLights() {
  return (
    <>
      <color attach="background" args={[MATTE_BG]} />
      <fogExp2 attach="fog" args={[MATTE_BG, 0.05]} />
      <ambientLight intensity={0.15} />
      <directionalLight position={[10, 16, 12]} intensity={2} color={0xffffff} />
      <directionalLight position={[-12, 6, -14]} intensity={1.6} color={0x22d3ee} />
      {/* Procedural studio environment: nothing downloaded, so it works in
          disconnected deployments. frames=1 bakes the cube map once. */}
      <Environment resolution={256} frames={1}>
        <Lightformer form="rect" intensity={2.2} color="#dbeafe" position={[0, 8, 0]} rotation-x={Math.PI / 2} scale={[16, 16, 1]} />
        <Lightformer form="rect" intensity={1.6} color="#ffffff" position={[-10, 3, 4]} rotation-y={Math.PI / 2} scale={[12, 5, 1]} />
        <Lightformer form="rect" intensity={1.2} color="#e2e8f0" position={[10, 2, -4]} rotation-y={-Math.PI / 2} scale={[12, 4, 1]} />
        <Lightformer form="ring" intensity={1.8} color="#22d3ee" position={[0, 3, -12]} scale={8} />
        <Lightformer form="rect" intensity={0.6} color="#64748b" position={[0, -6, 0]} rotation-x={-Math.PI / 2} scale={[20, 20, 1]} />
      </Environment>
    </>
  );
}

const PARTICLES = 260;

/** Deterministic [0,1) hash so the particle seed is pure. */
function hash(n: number): number {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function HoloStage({ floorY, floorScale, sweep }: { floorY: number; floorScale: number; sweep: readonly [number, number] }) {
  const ringRef = useRef<THREE.Mesh>(null);
  const ticksRef = useRef<THREE.Group>(null);
  const partGeoRef = useRef<THREE.BufferGeometry>(null);

  const grid = useMemo(() => {
    const g = new THREE.GridHelper(40, 40, 0x0e7490, 0x0b3a4a);
    const m = g.material as THREE.LineBasicMaterial;
    m.transparent = true;
    m.opacity = 0.35;
    return g;
  }, []);

  const positions = useMemo(() => {
    const a = new Float32Array(PARTICLES * 3);
    for (let i = 0; i < PARTICLES; i++) {
      const ang = hash(i * 3 + 1) * Math.PI * 2;
      const r = hash(i * 3 + 2) * 4.5;
      a[i * 3] = Math.cos(ang) * r;
      a[i * 3 + 1] = hash(i * 3 + 3) * 5;
      a[i * 3 + 2] = Math.sin(ang) * r;
    }
    return a;
  }, []);

  const tickGeoLong = useMemo(() => new THREE.PlaneGeometry(0.04, 0.4), []);
  const tickGeoShort = useMemo(() => new THREE.PlaneGeometry(0.04, 0.18), []);
  const ticks = useMemo(
    () => Array.from({ length: 72 }, (_, i) => ({ i, a: (i / 72) * Math.PI * 2 })),
    [],
  );
  const beamMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        vertexShader: 'varying float y;void main(){y=position.y;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
        fragmentShader: 'varying float y;void main(){float a=pow(1.-(y+3.)/6.,3.)*.07;gl_FragColor=vec4(.13,.83,.93,a);}',
      }),
    [],
  );

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    setHoloTime(t);
    setHoloSweep(sweep[0], sweep[1]);
    if (ringRef.current) ringRef.current.rotation.z = t * 0.15;
    if (ticksRef.current) ticksRef.current.rotation.y = -t * 0.08;
    const geo = partGeoRef.current;
    if (geo) {
      const arr = geo.attributes.position.array as Float32Array;
      for (let i = 0; i < PARTICLES; i++) {
        arr[i * 3 + 1] += 0.012;
        if (arr[i * 3 + 1] > 5) arr[i * 3 + 1] = 0;
      }
      geo.attributes.position.needsUpdate = true;
    }
  });

  return (
    <>
      <color attach="background" args={[HOLO_BG]} />
      <fogExp2 attach="fog" args={[HOLO_BG, 0.02]} />

      <group position={[0, floorY, 0]} scale={floorScale}>
        <primitive object={grid} />
        <mesh ref={ringRef} rotation-x={-Math.PI / 2}>
          <ringGeometry args={[4.6, 4.65, 128]} />
          <meshBasicMaterial color={0x22d3ee} transparent opacity={0.3} side={THREE.DoubleSide} blending={THREE.AdditiveBlending} depthWrite={false} />
        </mesh>
        <mesh rotation-x={-Math.PI / 2}>
          <ringGeometry args={[5.2, 5.22, 128]} />
          <meshBasicMaterial color={0x22d3ee} transparent opacity={0.6} side={THREE.DoubleSide} blending={THREE.AdditiveBlending} depthWrite={false} />
        </mesh>
        <mesh rotation-x={-Math.PI / 2}>
          <ringGeometry args={[7.5, 7.55, 128]} />
          <meshBasicMaterial color={0x22d3ee} transparent opacity={0.3} side={THREE.DoubleSide} blending={THREE.AdditiveBlending} depthWrite={false} />
        </mesh>
        <group ref={ticksRef}>
          {ticks.map(({ i, a }) => (
            <mesh
              key={i}
              geometry={i % 6 ? tickGeoShort : tickGeoLong}
              position={[Math.cos(a) * 5.6, 0.01, Math.sin(a) * 5.6]}
              rotation={[-Math.PI / 2, 0, -a + Math.PI / 2]}
            >
              <meshBasicMaterial color={0x67e8f9} transparent opacity={0.5} side={THREE.DoubleSide} blending={THREE.AdditiveBlending} depthWrite={false} />
            </mesh>
          ))}
        </group>
        <mesh position={[0, 2, 0]} material={beamMat}>
          <cylinderGeometry args={[4.6, 4.6, 6, 64, 1, true]} />
        </mesh>
        <points>
          <bufferGeometry ref={partGeoRef}>
            <bufferAttribute attach="attributes-position" args={[positions, 3]} />
          </bufferGeometry>
          <pointsMaterial color={0x67e8f9} size={0.05} transparent opacity={0.7} blending={THREE.AdditiveBlending} depthWrite={false} />
        </points>
      </group>

      <EffectComposer multisampling={0}>
        <Bloom mipmapBlur luminanceThreshold={0.2} intensity={0.9} />
      </EffectComposer>
    </>
  );
}
