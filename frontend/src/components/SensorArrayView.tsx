// =============================================================================
// SensorArrayView — generic 3D sensor-array maintainer view
// =============================================================================
// Generalized from the original LtamdsView. The 3D scene machinery (depth
// drilling, element interrogation, scaling tweens, click-to-focus) is
// preserved exactly — only the array-specific bits (face counts, depth
// names, header text) are now config-driven. LTAMDS ships as the only
// `SensorArrayConfig` today; the abstraction holds for any future radar /
// sonar / IR / phased-array maintainer view that needs the same visual
// drill-down treatment.
//
// PRESERVED per Phase 4 Decision 4 — data shape will change again when an
// RTI / Cyber DDS feed lands. Visual lift only this pass; no refactor of
// the 3D logic.
//
// DEMO_MOCK: renders against synthetic element data. There is no
// RADAR/sensor-array platform_variant in the current pipeline (the OSS DIS
// feed is M1A2-SEPv3 ground assets), so there is nothing real to wire to
// yet. When a sensor-array asset appears in telemetry_latest_state, wire
// the element grid to its sustainment.* fields; until then this stays
// mock behind an explicit banner. See ADR-0017.
import { useState, useMemo, useRef, useEffect } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import * as TWEEN from '@tweenjs/tween.js';
import HudFrame from './HudFrame';

const COLORS = { nominal: 0x22d3ee, warning: 0xfacc15, critical: 0xef4444, bg: 0x020617, housing: 0x0f172a, card: 0x1e293b };

// ---------------------------------------------------------------------------
// Public config — the LTAMDS-specific values that used to be hardcoded.
// Ship one config (LTAMDS_CONFIG, below) today; the type contract is what
// makes future "a different array" work a config change, not a rewrite.
// ---------------------------------------------------------------------------
export interface FaceSpec {
    cols: number;
    rows: number;
    /** Local position of the face center, in the housing's frame. */
    pos: [number, number, number];
    /** Local rotation Euler, in the housing's frame. */
    rot: [number, number, number];
    /** Display name shown in the interrogation panel. */
    name: string;
}

export interface SensorArrayConfig {
    /** Top-left header — platform-specific identity. */
    title: string;
    /** Subtitle under the title. */
    subtitle: string;
    /** Names for each drill-down depth, from outer housing inward. */
    depthNames: [string, string, string, string];
    /** Face specs for depth 0 (the outer housing). */
    faces: FaceSpec[];
    /** Banner text passed to HudFrame (DEMO_MOCK status, per ADR-0017). */
    bannerNote: string;
}

// ---------------------------------------------------------------------------
// LTAMDS_CONFIG — the only config shipped today. Values lifted verbatim
// from the original LtamdsView so the visual output is identical.
// ---------------------------------------------------------------------------
export const LTAMDS_CONFIG: SensorArrayConfig = {
    title: 'LTAMDS Gen-4',
    subtitle: 'ARRAY DIAGNOSTIC INTERFACE @[//] SECTOR 7G',
    depthNames: ['RADAR UNIT', 'PROCESSOR BANK', 'SIGNAL CONVERTER', 'GAN MMIC CHIP'],
    faces: [
        { cols: 8, rows: 14, pos: [0, 0, 2.51], rot: [0, 0, 0], name: 'PRIMARY NORTH' },
        { cols: 5, rows: 8,  pos: [-3.51, 0, -1], rot: [0, -Math.PI / 2, 0], name: 'SECTOR ALPHA' },
        { cols: 5, rows: 8,  pos: [3.51, 0, -1],  rot: [0,  Math.PI / 2, 0], name: 'SECTOR BETA'  },
    ],
    bannerNote: 'live data wiring pending RTI/Cyber DDS integration',
};

const tweenGroup = new TWEEN.Group();

function getStatusFromHealth(health: number) {
    if (health > 0.97) return { color: COLORS.critical, label: "CRITICAL", class: "bg-red-500/20 text-red-400" };
    if (health > 0.90) return { color: COLORS.warning, label: "DEGRADED", class: "bg-yellow-500/20 text-yellow-400" };
    return { color: COLORS.nominal, label: "NOMINAL", class: "bg-green-500/20 text-green-400" };
}

interface ElementData {
    id: string;
    face: string;
    temp: string;
    load: string;
    healthValue: number;
    status: any;
    pos: [number, number, number];
    rot?: [number, number, number];
    size: [number, number, number];
    color: number;
    wireframe?: boolean;
}

function generateElements(depth: number, degraded: boolean, faces: FaceSpec[]): ElementData[] {
    const elements: ElementData[] = [];

    if (depth === 0) {
        const addFace = (spec: FaceSpec) => {
            const { cols, rows, pos, rot, name } = spec;
            const spacing = 0.65;
            for (let i = 0; i < cols; i++) {
                for (let j = 0; j < rows; j++) {
                    let health = Math.random();
                    if (degraded && Math.random() > 0.85) health = 0.98;
                    const status = getStatusFromHealth(health);

                    const localPos = new THREE.Vector3((i - (cols - 1) / 2) * spacing, (j - (rows - 1) / 2) * spacing, 0);
                    localPos.applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)));
                    localPos.add(new THREE.Vector3(...pos));

                    elements.push({
                        id: `TR-${Math.floor(Math.random() * 8999) + 1000}`,
                        face: name,
                        temp: (30 + health * 40).toFixed(1),
                        load: (Math.random() * 100).toFixed(0),
                        healthValue: health,
                        status,
                        pos: [localPos.x, localPos.y, localPos.z],
                        rot,
                        size: [0.5, 0.5, 0.15],
                        color: status.color,
                    });
                }
            }
        };

        for (const face of faces) addFace(face);
    } else {
        let size: [number, number, number] = [6, 6, 0.5];
        let spacing = 8;
        let prefix = "BOARD";
        if (depth === 2) { size = [4, 4, 0.5]; spacing = 6; prefix = "MODULE"; }
        if (depth === 3) { size = [2, 2, 0.5]; spacing = 3; prefix = "CHIP"; }

        for (let i = 0; i < 2; i++) {
            for (let j = 0; j < 2; j++) {
                let health = Math.random();
                if (degraded && Math.random() > 0.85) health = 0.98;
                const status = getStatusFromHealth(health);

                elements.push({
                    id: `${prefix}-${i}${j}`,
                    face: "INTERNAL",
                    temp: (35 + health * 50).toFixed(1),
                    load: (20 + Math.random() * 70).toFixed(0),
                    healthValue: health,
                    status,
                    pos: [(i - 0.5) * spacing, (j - 0.5) * spacing, 0],
                    rot: [0, 0, 0],
                    size,
                    color: COLORS.card,
                    wireframe: true,
                });
            }
        }
    }
    return elements;
}

function SceneController({ currentDepth, onDrillDown, onInterrogate, isTransitioning, setIsTransitioning, degraded, faces }: any) {
    const { camera } = useThree();
    const controlsRef = useRef<any>(null);
    const groupsRef = useRef<THREE.Group[]>([]);

    const [selectedMesh, setSelectedMesh] = useState<THREE.Mesh | null>(null);

    const elements0 = useMemo(() => generateElements(0, degraded, faces), [degraded, faces]);
    const elements1 = useMemo(() => generateElements(1, degraded, faces), [degraded, faces]);
    const elements2 = useMemo(() => generateElements(2, degraded, faces), [degraded, faces]);
    const elements3 = useMemo(() => generateElements(3, degraded, faces), [degraded, faces]);

    const allElements = [elements0, elements1, elements2, elements3];

    useFrame(() => {
        tweenGroup.update();
    });

    useEffect(() => {
        // Instantly reset camera on depth change
        const targetCamPos = currentDepth === 0 ? new THREE.Vector3(15, 12, 20) : new THREE.Vector3(0, 0, 15);
        const targetLookAt = new THREE.Vector3(0, 0, 0);

        camera.position.copy(targetCamPos);
        camera.lookAt(targetLookAt);

        if (controlsRef.current) {
            controlsRef.current.target.copy(targetLookAt);
            controlsRef.current.update();
        }

        // Scale in new group
        const activeGroup = groupsRef.current[currentDepth];
        if (activeGroup) {
            activeGroup.scale.set(0.1, 0.1, 0.1);
            new TWEEN.Tween(activeGroup.scale, tweenGroup)
                .to({ x: 1, y: 1, z: 1 }, 600)
                .easing(TWEEN.Easing.Back.Out)
                .onComplete(() => {
                    if (controlsRef.current) {
                        controlsRef.current.enabled = true;
                        controlsRef.current.enableDamping = true;
                    }
                    setIsTransitioning(false);
                })
                .start();
        } else {
            if (controlsRef.current) {
                controlsRef.current.enabled = true;
                controlsRef.current.enableDamping = true;
            }
            setIsTransitioning(false);
        }
    }, [currentDepth, camera, setIsTransitioning]);

    const handleSelect = (data: ElementData, mesh: THREE.Mesh) => {
        if (isTransitioning) return;

        // Cancel any ongoing tweens
        tweenGroup.removeAll();

        setIsTransitioning(true);
        if (controlsRef.current) {
            controlsRef.current.enabled = false;
        }

        if (selectedMesh && selectedMesh !== mesh) {
            selectedMesh.scale.set(1, 1, 1);
        }

        setSelectedMesh(mesh);
        onInterrogate(data);

        new TWEEN.Tween(mesh.scale, tweenGroup)
            .to({ x: 1.2, y: 1.2, z: 2 }, 300)
            .easing(TWEEN.Easing.Back.Out)
            .start();

        const targetPos = new THREE.Vector3();
        mesh.getWorldPosition(targetPos);

        const offset = new THREE.Vector3(0, 0, currentDepth === 0 ? 5 : 8);
        offset.applyQuaternion(mesh.quaternion);
        if (currentDepth > 0) offset.z = 10;

        const newCamPos = targetPos.clone().add(offset);

        new TWEEN.Tween(camera.position, tweenGroup)
            .to({ x: newCamPos.x, y: newCamPos.y, z: newCamPos.z }, 1000)
            .easing(TWEEN.Easing.Quadratic.Out)
            .onUpdate(() => {
                camera.lookAt(targetPos);
            })
            .onComplete(() => {
                if (controlsRef.current) {
                    controlsRef.current.target.copy(targetPos);
                    controlsRef.current.enabled = true;
                    controlsRef.current.update();
                }
                setIsTransitioning(false);
            })
            .start();
    };

    const handleDrillDown = (_data: ElementData, _mesh: THREE.Mesh) => {
        // Cancel any ongoing tweens (like the single-click zoom)
        tweenGroup.removeAll();

        setIsTransitioning(true);
        if (controlsRef.current) {
            controlsRef.current.enabled = false;
        }
        onInterrogate(null); // hide HUD

        if (selectedMesh) {
            // Instantly reset scale instead of tweening since we removed all tweens
            selectedMesh.scale.set(1, 1, 1);
            setSelectedMesh(null);
        }

        const targetPos = new THREE.Vector3();
        _mesh.getWorldPosition(targetPos);

        new TWEEN.Tween(camera.position, tweenGroup)
            .to({ x: targetPos.x, y: targetPos.y, z: targetPos.z }, 800)
            .easing(TWEEN.Easing.Exponential.In)
            .onUpdate(() => {
                camera.lookAt(targetPos);
            })
            .onComplete(() => {
                onDrillDown();
            })
            .start();

        const activeGroup = groupsRef.current[currentDepth];
        if (activeGroup) {
            new TWEEN.Tween(activeGroup.scale, tweenGroup)
                .to({ x: 5, y: 5, z: 5 }, 800)
                .easing(TWEEN.Easing.Exponential.In)
                .start();
        }
    };
    const handlePointerMissed = () => {
        if (selectedMesh) {
            new TWEEN.Tween(selectedMesh.scale, tweenGroup).to({ x: 1, y: 1, z: 1 }, 300).start();
            setSelectedMesh(null);
            onInterrogate(null);
        }
    };

    return (
        <>
            <OrbitControls
                ref={controlsRef}
                enableDamping
                dampingFactor={0.05}
                enableRotate={!isTransitioning}
                enableZoom={!isTransitioning}
                enablePan={!isTransitioning}
            />
            <group onPointerMissed={handlePointerMissed}>
                {allElements.map((elements, depth) => (
                    <group
                        key={depth}
                        ref={el => { if (el) groupsRef.current[depth] = el; }}
                        visible={currentDepth === depth}
                    >
                        {depth === 0 && (
                            <mesh>
                                <boxGeometry args={[7, 12, 5]} />
                                <meshPhongMaterial color={COLORS.housing} transparent opacity={0.9} />
                                <lineSegments>
                                    <edgesGeometry args={[new THREE.BoxGeometry(7, 12, 5)]} />
                                    <lineBasicMaterial color={0x334155} transparent opacity={0.5} />
                                </lineSegments>
                            </mesh>
                        )}
                        {elements.map((data) => (
                            <ElementMesh
                                key={data.id}
                                data={data}
                                onSelect={handleSelect}
                                onDrillDown={handleDrillDown}
                            />
                        ))}
                    </group>
                ))}
            </group>
        </>
    );
}

function ElementMesh({ data, onSelect, onDrillDown }: { data: ElementData, onSelect: any, onDrillDown: any }) {
    const meshRef = useRef<THREE.Mesh>(null);

    useFrame((state) => {
        if (meshRef.current && data.healthValue > 0.9) {
            const time = state.clock.getElapsedTime();
            const pulse = 0.5 + Math.sin(time * 5) * 0.5;
            (meshRef.current.material as THREE.MeshPhongMaterial).emissiveIntensity = 0.4 + pulse * 1.5;
        }
    });

    return (
        <mesh
            ref={meshRef}
            position={data.pos}
            rotation={data.rot || [0, 0, 0]}
            onClick={(e) => { e.stopPropagation(); onSelect(data, meshRef.current); }}
            onDoubleClick={(e) => { e.stopPropagation(); onDrillDown(data, meshRef.current); }}
        >
            <boxGeometry args={data.size} />
            <meshPhongMaterial
                color={data.color}
                emissive={data.status.color}
                emissiveIntensity={data.healthValue > 0.9 ? 0.6 : 0.1}
            />
            {data.wireframe && (
                <lineSegments>
                    <edgesGeometry args={[new THREE.BoxGeometry(...data.size)]} />
                    <lineBasicMaterial color={data.status.color} transparent opacity={0.3} />
                </lineSegments>
            )}
        </mesh>
    );
}

interface SensorArrayViewProps {
    degraded: boolean;
    coreTemp: number;
    /** Config for the specific sensor array being rendered. Defaults to
     *  LTAMDS_CONFIG — the only config shipped today. */
    config?: SensorArrayConfig;
}

export default function SensorArrayView({ degraded, coreTemp, config = LTAMDS_CONFIG }: SensorArrayViewProps) {
    const [currentDepth, setCurrentDepth] = useState(0);
    const [selectedElement, setSelectedElement] = useState<ElementData | null>(null);
    const [isTransitioning, setIsTransitioning] = useState(false);

    const handleDrillDown = () => {
        setCurrentDepth(prev => (prev + 1) % 4);
    };

    const handleInterrogate = (data: ElementData | null) => {
        setSelectedElement(data);
    };

    const headerExtras = (
        <>
            <div className="mt-4 flex gap-2 text-[0.6rem] font-bold uppercase tracking-widest text-cyan-500/50">
                {config.depthNames.slice(0, currentDepth + 1).map((name, i) => (
                    <span key={i} className="flex items-center gap-2">
                        <span className={i === currentDepth ? 'text-cyan-400' : ''}>{name}</span>
                        {i < currentDepth && <span className="opacity-30">/</span>}
                    </span>
                ))}
            </div>
            <div className="mt-4 flex gap-4 text-[10px] font-mono">
                <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                    CORE TEMP: <span>{coreTemp.toFixed(1)}</span>°C
                </div>
                <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-cyan-500"></span>
                    UPTIME: 1,422H
                </div>
            </div>
        </>
    );

    return (
        <HudFrame
            title={config.title}
            subtitle={config.subtitle}
            bannerNote={config.bannerNote}
            bottomHint="[CLICK] FOCUS & INTERROGATE • [DBL-CLICK] DRILL DOWN • [SCROLL] ZOOM"
            headerExtras={headerExtras}
        >
            <Canvas camera={{ position: [15, 12, 20], fov: 50 }}>
                <color attach="background" args={[COLORS.bg]} />
                <fogExp2 attach="fog" args={[COLORS.bg, 0.05]} />
                <ambientLight intensity={0.4} />
                <spotLight position={[20, 40, 20]} intensity={1.5} color={0x22d3ee} />

                <SceneController
                    currentDepth={currentDepth}
                    onDrillDown={handleDrillDown}
                    onInterrogate={handleInterrogate}
                    isTransitioning={isTransitioning}
                    setIsTransitioning={setIsTransitioning}
                    degraded={degraded}
                    faces={config.faces}
                />
            </Canvas>

            {/* Depth Indicator */}
            <div className="absolute bottom-6 right-6 z-10 flex gap-2 pointer-events-none">
                {[0, 1, 2, 3].map(i => (
                    <div key={i} className={`w-8 h-1 ${i <= currentDepth ? 'bg-cyan-400' : 'bg-slate-800'}`}></div>
                ))}
            </div>

            {/* Right Diagnostic HUD */}
            <div className={`absolute right-6 top-6 w-80 hud-border p-6 z-20 transition-transform duration-500 transform ${selectedElement ? 'translate-x-0' : 'translate-x-[120%]'} pointer-events-auto`}>
                <div className="scanning-line"></div>
                <div className="flex justify-between items-start mb-4">
                    <div>
                        <h2 className="text-lg font-bold glitch-text text-cyan-400">{selectedElement?.id || '--'}</h2>
                        <p className="text-[0.6rem] opacity-60 uppercase">{selectedElement?.face || 'SYSTEM COMPONENT'}</p>
                    </div>
                    <button onClick={() => {
                        setSelectedElement(null);
                    }} className="text-cyan-400 hover:text-white transition-colors text-xl font-bold p-1 cursor-pointer">✕</button>
                </div>

                <div className="space-y-4">
                    <div className="grid grid-cols-2 gap-2">
                        <div className="p-2 border border-cyan-900 bg-cyan-950/30">
                            <p className="text-[0.6rem] opacity-50">THERMAL</p>
                            <p className="text-lg text-cyan-300"><span>{selectedElement?.temp || '--'}</span>°C</p>
                        </div>
                        <div className="p-2 border border-cyan-900 bg-cyan-950/30">
                            <p className="text-[0.6rem] opacity-50">LOAD</p>
                            <p className="text-lg text-cyan-300"><span>{selectedElement?.load || '--'}</span>%</p>
                        </div>
                    </div>

                    <div>
                        <p className="text-[0.6rem] opacity-50 mb-1">SIGNAL INTEGRITY</p>
                        <div className="w-full h-1 bg-slate-800 rounded-full overflow-hidden">
                            <div
                                className="h-full transition-all duration-700"
                                style={{
                                    width: selectedElement ? `${Math.max(5, Math.floor((1 - (selectedElement.healthValue > 0.9 ? 0.4 : 0.02)) * 100))}%` : '98%',
                                    backgroundColor: selectedElement ? `#${selectedElement.status.color.toString(16).padStart(6, '0')}` : '#22d3ee',
                                }}
                            ></div>
                        </div>
                    </div>

                    <div className="pt-4 border-t border-cyan-900/50">
                        <div className="flex justify-between items-center">
                            <span className="text-xs">STATUS</span>
                            <span className={`px-2 py-0.5 rounded text-[0.7rem] font-bold ${selectedElement?.status.class || 'bg-green-500/20 text-green-400'}`}>
                                {selectedElement?.status.label || 'NOMINAL'}
                            </span>
                        </div>
                    </div>
                </div>
            </div>
        </HudFrame>
    );
}
