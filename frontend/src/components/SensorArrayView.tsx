// =============================================================================
// SensorArrayView — generic 3D sensor-array maintainer view
// =============================================================================
// Generalized from the original LtamdsView. The 3D scene machinery (depth
// drilling, element interrogation, scaling tweens, click-to-focus) is
// preserved exactly — the array-specific bits are now config-driven:
//
//   * Face count + layout at depth 0 (LTAMDS = 3 faces, MRAD = 1 face, etc.)
//   * Drill depth (how many internal layers you can drill into)
//   * Per-layer grid (cols × rows) at every internal depth
//   * Per-layer naming (breadcrumb label, element id prefix)
//   * Per-layer element sizing + spacing
//
// Health values are seeded per (assetId, depth, element_index) so each
// discovered asset gets its OWN consistent set of telemetry values across
// re-renders — no flicker between every frame, and each asset looks
// independent (matches the "independent telemetry values for each asset
// discovered" requirement for the MRAD sim). Pass `liveTelemetry` to
// override the seeded values with real per-element data from the sim
// service once that path is wired (see openddil-mrad-sim).
//
// ADR-0017: DEMO_MOCK marker carried on each config's bannerNote.
import { useState, useMemo, useRef, useEffect } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import * as TWEEN from '@tweenjs/tween.js';
import HudFrame from './HudFrame';

const COLORS = { nominal: 0x22d3ee, warning: 0xfacc15, critical: 0xef4444, bg: 0x020617, housing: 0x0f172a, card: 0x1e293b };

// ---------------------------------------------------------------------------
// Public config — fully data-driven so a new sensor array (MRAD, future
// AESAs, sonar, IR, whatever) is a config change, not a code change.
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

export interface LayerSpec {
    /** Breadcrumb label for this depth (top header trail). */
    name: string;
    /** Grid columns at this depth. Depth 0 ignores this — faces drive layout. */
    cols: number;
    /** Grid rows at this depth. Depth 0 ignores this — faces drive layout. */
    rows: number;
    /** Element id prefix at this depth (e.g. "TR", "BOARD", "MODULE"). */
    prefix: string;
    /** Element box size [w, h, d] at this depth. */
    elementSize: [number, number, number];
    /** Grid spacing (center-to-center) at this depth. */
    spacing: number;
    /** Whether elements at this depth render as wireframe overlays (depth>0). */
    wireframe?: boolean;
}

export interface SensorArrayConfig {
    /** Top-left header — platform-specific identity. */
    title: string;
    /** Subtitle under the title. */
    subtitle: string;
    /** Face specs for depth 0 (the outer housing). One entry = single-face
     *  array like MRAD. Multiple entries = multi-face array like LTAMDS. */
    faces: FaceSpec[];
    /** Layers from depth 0 (outermost housing) to N (innermost). Length
     *  determines maximum drill depth. layers[0] only uses `name` +
     *  elementSize/spacing/wireframe (faces[] drives layout). layers[1..]
     *  fully drive a centered grid. */
    layers: LayerSpec[];
    /** Banner text passed to HudFrame (e.g. "DEMO_MOCK -- synthetic data"). */
    bannerNote: string;
    /** Outer housing bounding box [w, h, d] at depth 0. */
    housingSize: [number, number, number];
}

// ---------------------------------------------------------------------------
// LTAMDS_CONFIG — three-face AESA radar. Values lifted verbatim from the
// original LtamdsView so visual output is identical.
// ---------------------------------------------------------------------------
export const LTAMDS_CONFIG: SensorArrayConfig = {
    title: 'LTAMDS Gen-4',
    subtitle: 'ARRAY DIAGNOSTIC INTERFACE @[//] SECTOR 7G',
    faces: [
        { cols: 8, rows: 14, pos: [0, 0, 2.51], rot: [0, 0, 0], name: 'PRIMARY NORTH' },
        { cols: 5, rows: 8,  pos: [-3.51, 0, -1], rot: [0, -Math.PI / 2, 0], name: 'SECTOR ALPHA' },
        { cols: 5, rows: 8,  pos: [3.51, 0, -1],  rot: [0,  Math.PI / 2, 0], name: 'SECTOR BETA'  },
    ],
    layers: [
        { name: 'RADAR UNIT',       cols: 0, rows: 0, prefix: 'TR',     elementSize: [0.5, 0.5, 0.15], spacing: 0.65 },
        { name: 'PROCESSOR BANK',   cols: 2, rows: 2, prefix: 'BOARD',  elementSize: [6, 6, 0.5],     spacing: 8, wireframe: true },
        { name: 'SIGNAL CONVERTER', cols: 2, rows: 2, prefix: 'MODULE', elementSize: [4, 4, 0.5],     spacing: 6, wireframe: true },
        { name: 'GAN MMIC CHIP',    cols: 2, rows: 2, prefix: 'CHIP',   elementSize: [2, 2, 0.5],     spacing: 3, wireframe: true },
    ],
    bannerNote: 'live data wiring pending RTI/Cyber DDS integration',
    housingSize: [7, 12, 5],
};

// ---------------------------------------------------------------------------
// MRAD_CONFIG — single-face Multi-Mission Radar variant. Same LTAMDS visual
// family (grey/slate housing, cyan element highlights, glitch text), but
// one face. Per-layer cols/rows/naming tuned for the MRAD's narrower drill
// tree (backplane → processor → MMIC). The mrad-sim Python service
// publishes per-element telemetry into mrad_element_telemetry; this
// component falls back to seeded-RNG synthesis when no live data yet.
// ---------------------------------------------------------------------------
export const MRAD_CONFIG: SensorArrayConfig = {
    title: 'MRAD Multi-Mission Radar',
    subtitle: 'ARRAY DIAGNOSTIC INTERFACE @[//] FORWARD-DEPLOYED',
    faces: [
        { cols: 8, rows: 12, pos: [0, 0, 2.51], rot: [0, 0, 0], name: 'PRIMARY APERTURE' },
    ],
    layers: [
        { name: 'RADAR UNIT',     cols: 0, rows: 0, prefix: 'TR',     elementSize: [0.5, 0.5, 0.15], spacing: 0.65 },
        { name: 'BACKPLANE',      cols: 2, rows: 3, prefix: 'BOARD',  elementSize: [4, 4, 0.5],     spacing: 6, wireframe: true },
        { name: 'PROCESSOR BANK', cols: 2, rows: 2, prefix: 'MODULE', elementSize: [3, 3, 0.5],     spacing: 5, wireframe: true },
        { name: 'GAN MMIC CHIP',  cols: 3, rows: 3, prefix: 'CHIP',   elementSize: [1.5, 1.5, 0.4], spacing: 2.5, wireframe: true },
    ],
    bannerNote: 'DEMO_MOCK -- per-element telemetry from openddil-mrad-sim (synthesized when sim absent)',
    housingSize: [6, 9, 5],
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

/** Per-element telemetry from a live source (logistics-sim). Keyed
 *  by the same element id this view generates
 *  (`<prefix>-<face>-<i>-<j>` for face elements, `<prefix>-<i>-<j>`
 *  for internal layers). When provided, health/temp/load override the
 *  seeded synthesis; txActive/rxActive reflect the customer-sim-
 *  reported actively_transmitting / actively_receiving bits so the
 *  interrogation panel can show "TX off" / "RX off" badges that match
 *  the customer feed exactly. */
export interface LiveElementTelemetry {
    [elementId: string]: {
        health: number;
        temp?: number;
        load?: number;
        txActive?: boolean;
        rxActive?: boolean;
    };
}

// Status pill rendered when no liveTelemetry entry exists for this
// element_id. Distinct color (medium slate) so the operator can tell
// "telemetry hasn't arrived yet" from "telemetry says nominal".
const NO_DATA_STATUS = {
    color: 0x475569,
    label: 'NO DATA',
    class: 'bg-slate-700/30 text-slate-400',
};

// Build the per-element render data list for a single layer at a given
// depth.
//
// LAYOUT is config-driven (from MRAD_CONFIG / LTAMDS_CONFIG): cell
// positions, sizes, wireframe styling — all known statically.
//
// ELEMENT IDs are PATH-ENCODED at depth > 0 to match the sim's tree
// topology. Depth 0 ids look like `TR-PRIMARYAPERTURE-3-5` (the face
// element's own id). Depth N ids look like `<parentId>/<prefix>-<i>-<j>`
// where parentId is the FULL path-encoded id of the element the user
// drilled into at depth N-1. The sim publishes the entire tree using
// this exact id format (see logistics-sim element_gen.py) so the live-
// telemetry lookup hits per-drill-path, not globally.
//
// HEALTH / TEMP / LOAD / TX / RX values come ONLY from liveTelemetry.
// When liveTelemetry has no entry for an element_id, that element
// renders with NO_DATA_STATUS — a neutral slate placeholder, NOT a
// fabricated nominal/degraded color.
//
// This is the "frontend is a puppet" contract: there is no second
// synthesizer. openddil-logistics-sim is the sole source of truth for
// per-element values; the frontend just lays them out and colors them.
function generateElements(
    depth: number,
    faces: FaceSpec[],
    layers: LayerSpec[],
    parentId: string | null,
    liveTelemetry?: LiveElementTelemetry,
): ElementData[] {
    const elements: ElementData[] = [];
    const layer = layers[depth];
    if (!layer) return elements;
    // Depth > 0 requires a parent path to construct child ids. If none
    // is set (shouldn't happen in normal nav flow), bail out — better
    // than emitting unscoped ids that would miss the live lookup.
    if (depth > 0 && !parentId) return elements;

    const fromLive = (elementId: string): {
        healthValue: number;
        status: typeof NO_DATA_STATUS;
        temp: string;
        load: string;
    } => {
        const live = liveTelemetry?.[elementId];
        if (live?.health == null) {
            return { healthValue: 0, status: NO_DATA_STATUS, temp: '—', load: '—' };
        }
        return {
            healthValue: live.health,
            status: getStatusFromHealth(live.health),
            temp: live.temp != null ? live.temp.toFixed(1) : '—',
            load: live.load != null ? live.load.toFixed(0) : '—',
        };
    };

    if (depth === 0) {
        // Depth 0 = outer housing surface. faces[] drives the layout; each
        // face's cols/rows lay out a planar grid that's then transformed
        // into the housing's frame. Ids are face-scoped (e.g. TR-PRIMARY
        // APERTURE-3-5); they ARE the root of every subsequent drill path.
        for (const spec of faces) {
            const { cols, rows, pos, rot, name } = spec;
            const spacing = layer.spacing;
            for (let i = 0; i < cols; i++) {
                for (let j = 0; j < rows; j++) {
                    const elementId = `${layer.prefix}-${name.replace(/\s+/g, '')}-${i}-${j}`;
                    const v = fromLive(elementId);

                    const localPos = new THREE.Vector3((i - (cols - 1) / 2) * spacing, (j - (rows - 1) / 2) * spacing, 0);
                    localPos.applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)));
                    localPos.add(new THREE.Vector3(...pos));

                    elements.push({
                        id: elementId,
                        face: name,
                        temp: v.temp,
                        load: v.load,
                        healthValue: v.healthValue,
                        status: v.status,
                        pos: [localPos.x, localPos.y, localPos.z],
                        rot,
                        size: layer.elementSize,
                        color: v.status.color,
                    });
                }
            }
        }
    } else {
        // Internal layer — children of parentId. Ids are path-scoped
        // (`<parentId>/<prefix>-<i>-<j>`) so different parents have
        // different children. Sim publishes all 23k tree nodes; this
        // lookup hits the entry for THIS specific drill path.
        const { cols, rows, prefix, spacing, elementSize, wireframe } = layer;
        for (let i = 0; i < cols; i++) {
            for (let j = 0; j < rows; j++) {
                const elementId = `${parentId}/${prefix}-${i}-${j}`;
                const v = fromLive(elementId);

                elements.push({
                    id: elementId,
                    face: 'INTERNAL',
                    temp: v.temp,
                    load: v.load,
                    healthValue: v.healthValue,
                    status: v.status,
                    pos: [(i - (cols - 1) / 2) * spacing, (j - (rows - 1) / 2) * spacing, 0],
                    rot: [0, 0, 0],
                    size: elementSize,
                    color: COLORS.card,
                    wireframe: wireframe ?? true,
                });
            }
        }
    }
    return elements;
}

// SceneController — rewritten for stability.
//
// Previous design mixed (a) TWEEN-driven camera.position mutations with
// per-frame camera.lookAt() calls, and (b) OrbitControls owning the camera
// after each tween completed. The two sources of truth raced: lookAt() at
// near-zero distance corrupted camera.up and camera.quaternion; OrbitControls
// retained residual damping velocity across enable/disable cycles. The
// failure was intermittent and depended on exact tween timing — classic
// signature of accumulated state corruption.
//
// Current design:
//   * OrbitControls is the SOLE owner of camera position/orientation after
//     mount. No TWEEN ever touches camera.position or camera.up.
//   * Depth change = hard snap. camera.position, camera.up, camera.lookAt,
//     and controls.target all reset to canonical values atomically.
//   * Single click = scale-up the clicked mesh + show HUD. No camera move.
//     User can orbit/zoom freely using OrbitControls to inspect.
//   * Double click = brief mesh scale-pop (visual feedback), then commit
//     depth change. No camera tween, so no lookAt(self), no up corruption,
//     no leaked state into the next layer.
//   * tweenGroup only animates mesh scale + group scale-in. Both reset
//     deterministically on depth change so re-entering a layer is clean.
function SceneController({ currentDepth, parentId, onDrillDown, onInterrogate, isTransitioning, setIsTransitioning, faces, layers, liveTelemetry, housingSize }: any) {
    const { camera } = useThree();
    const controlsRef = useRef<any>(null);
    const groupsRef = useRef<THREE.Group[]>([]);
    // Tracks the in-flight depth-0 camera fly-in tween so handleDrillDown
    // and the depth-change useEffect can cancel it cleanly without nuking
    // the layer scale-in or element-pop tweens.
    const cameraFlyRef = useRef<TWEEN.Tween<any> | null>(null);
    // Deferred camera-fly timer. The fly is delayed ~250ms after a single
    // click so a follow-up dblclick can intercept and drill instead. Without
    // this delay, the camera moves on the first click, the mesh shifts on
    // screen, the second click misses, and onDoubleClick never fires.
    const clickTimerRef = useRef<number | null>(null);
    // Currently-popped mesh, tracked via REF (not useState) so back-to-back
    // clicks see the LATEST selection synchronously. With useState, the
    // closure in handleSelect captures the prior render's value of
    // selectedMesh — if the user clicks B before React re-renders after
    // clicking A, the closure still sees selectedMesh=null and skips the
    // "cancel A's tween + reset A.scale" cleanup. A keeps popping toward
    // its 1.4x target while B pops too; the user sees "A is the big one"
    // when they expected B to be selected, reading as "B didn't bounce."
    // Refs update synchronously, so this race goes away.
    const selectedMeshRef = useRef<THREE.Mesh | null>(null);

    // Layout for the currently-visible depth. Generated from config (faces
    // + layers + drill parent); coloring/values come from liveTelemetry.
    // No synthesis. parentId is the FULL path-encoded id of the element
    // the user drilled INTO at the previous depth (null at depth 0).
    const currentElements = useMemo(
        () => generateElements(currentDepth, faces, layers, parentId, liveTelemetry),
        [currentDepth, faces, layers, parentId, liveTelemetry],
    );

    useFrame(() => {
        tweenGroup.update();
    });

    // Tween the camera position and lookAt-target in lockstep over `duration` ms.
    //
    // Stable for the select fly-in because the camera-to-target distance
    // stays >= ~5 units throughout (start is the overview ~28 units out;
    // end is the face-normal offset of 5 units). lookAt(target) where
    // camera != target is well-defined, so calling it every frame is safe
    // here — unlike the drill tween (removed), which approached zero
    // distance and corrupted camera.up.
    //
    // Lerping the lookAt target (not just the camera position) is what
    // keeps the array in frame throughout the tween. Without it, the
    // camera moves in 3D toward the element but keeps pointing at the
    // origin until the end — the array swings off-screen mid-flight and
    // snaps back at completion. With it, the camera always points at a
    // sensible interpolated point on or near the array center.
    const flyCameraTo = (endPos: THREE.Vector3, endTarget: THREE.Vector3, duration: number) => {
        if (cameraFlyRef.current) {
            tweenGroup.remove(cameraFlyRef.current);
            cameraFlyRef.current = null;
        }
        if (controlsRef.current) controlsRef.current.enabled = false;

        const startPos = camera.position.clone();
        const startTarget = controlsRef.current?.target?.clone() ?? new THREE.Vector3(0, 0, 0);
        const tmpTarget = new THREE.Vector3();

        const progress = { t: 0 };
        const tween = new TWEEN.Tween(progress, tweenGroup)
            .to({ t: 1 }, duration)
            .easing(TWEEN.Easing.Quadratic.InOut)
            .onUpdate(() => {
                camera.position.lerpVectors(startPos, endPos, progress.t);
                tmpTarget.lerpVectors(startTarget, endTarget, progress.t);
                camera.up.set(0, 1, 0);
                camera.lookAt(tmpTarget);
            })
            .onComplete(() => {
                camera.position.copy(endPos);
                camera.up.set(0, 1, 0);
                camera.lookAt(endTarget);
                if (controlsRef.current) {
                    controlsRef.current.target.copy(endTarget);
                    controlsRef.current.update();
                    controlsRef.current.enabled = true;
                }
                cameraFlyRef.current = null;
            })
            .start();
        cameraFlyRef.current = tween;
    };

    useEffect(() => {
        // Hard snap to canonical view for this depth. No tweens, no
        // accumulated state from prior layers.
        tweenGroup.removeAll();
        cameraFlyRef.current = null;
        selectedMeshRef.current = null;
        if (clickTimerRef.current !== null) {
            window.clearTimeout(clickTimerRef.current);
            clickTimerRef.current = null;
        }

        const targetCamPos = currentDepth === 0 ? new THREE.Vector3(15, 12, 20) : new THREE.Vector3(0, 0, 15);
        const targetLookAt = new THREE.Vector3(0, 0, 0);

        camera.up.set(0, 1, 0);
        camera.position.copy(targetCamPos);
        camera.lookAt(targetLookAt);

        if (controlsRef.current) {
            controlsRef.current.target.copy(targetLookAt);
            controlsRef.current.update();
        }

        // Reset scales for ALL layers so groups left scaled-up by prior
        // visual feedback (or stale from an earlier mount) come back to 1.
        // Then animate the active layer in from 0.1 for the "pop" effect.
        groupsRef.current.forEach((g, d) => {
            if (!g) return;
            if (d === currentDepth) {
                g.scale.set(0.1, 0.1, 0.1);
            } else {
                g.scale.set(1, 1, 1);
            }
        });

        const activeGroup = groupsRef.current[currentDepth];
        if (activeGroup) {
            new TWEEN.Tween(activeGroup.scale, tweenGroup)
                .to({ x: 1, y: 1, z: 1 }, 500)
                .easing(TWEEN.Easing.Back.Out)
                .onComplete(() => setIsTransitioning(false))
                .start();
        } else {
            setIsTransitioning(false);
        }
    }, [currentDepth, camera, setIsTransitioning]);

    const handleSelect = (data: ElementData, mesh: THREE.Mesh) => {
        if (isTransitioning) return;

        // Cancel the PRIOR selection's pop tween BEFORE setting its
        // scale back to 1. Uses the REF (selectedMeshRef.current), not
        // state — across rapid clicks, the closure's state value is
        // stale and this cleanup gets skipped, leaving the prior mesh
        // popped while the new one also pops.
        const prior = selectedMeshRef.current;
        if (prior && prior !== mesh) {
            tweenGroup.getAll()
                .filter(t => (t as any)._object === prior.scale)
                .forEach(t => tweenGroup.remove(t));
            prior.scale.set(1, 1, 1);
        }

        selectedMeshRef.current = mesh;
        onInterrogate(data);

        // Cancel any in-flight pop tween on THIS mesh (re-clicking the
        // same element or a rapid mesh-to-mesh swap), then start fresh
        // from scale=1. The prior bug — "click registers in the HUD but
        // the element doesn't bounce" — was the prior tween's onUpdate
        // overwriting our scale.set(1,1,1) on the next frame, leaving
        // the new tween effectively starting and ending at the same
        // value.
        tweenGroup.getAll()
            .filter(t => (t as any)._object === mesh.scale)
            .forEach(t => tweenGroup.remove(t));
        mesh.scale.set(1, 1, 1);
        // Uniform 1.4x — more visible than the prior {1.2, 1.2, 2}
        // which appears as only ~20% xy growth from head-on (the 2x z
        // is invisible when looking straight down z).
        new TWEEN.Tween(mesh.scale, tweenGroup)
            .to({ x: 1.4, y: 1.4, z: 1.4 }, 300)
            .easing(TWEEN.Easing.Back.Out)
            .start();

        // Camera fly applies at all depths. Distance scales with
        // element size so the focused element fills a similar fraction
        // of view regardless of depth.
        //
        // The fly is DEFERRED 250ms so a follow-up dblclick can
        // intercept and drill. Without the delay, the camera starts
        // moving on the first click → the mesh shifts on screen → the
        // second click misses → onDoubleClick never fires. This was
        // the depth-0 dblclick bug; the same trap applies at every
        // depth that has a fly-in.
        if (clickTimerRef.current !== null) {
            window.clearTimeout(clickTimerRef.current);
        }
        clickTimerRef.current = window.setTimeout(() => {
            clickTimerRef.current = null;
            const targetPos = new THREE.Vector3();
            mesh.getWorldPosition(targetPos);

            let endPos: THREE.Vector3;
            if (currentDepth === 0) {
                // Depth 0: ZOOM IN along the face normal so the small
                // element on a big face becomes the centered, head-on
                // focus. Face normal = face local +Z transformed by
                // the mesh's quaternion (varies per face on multi-face
                // arrays like LTAMDS; always world +Z for MRAD).
                const faceNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(mesh.quaternion);
                endPos = targetPos.clone().add(faceNormal.multiplyScalar(5));
            } else {
                // Depth > 0: pan AND re-flatten the view. Preserve the
                // user's current zoom DISTANCE so scroll-zoom isn't
                // lost, but reset the camera direction to canonical
                // top-down (camera above the element at +z, looking
                // down -z) — so an orbited/rotated view snaps back to
                // the flat layer plane on click. The "click should
                // put the layer back into the view plane" behavior.
                const currentTarget = controlsRef.current?.target?.clone() ?? new THREE.Vector3(0, 0, 0);
                const currentDist = camera.position.distanceTo(currentTarget);
                endPos = new THREE.Vector3(targetPos.x, targetPos.y, targetPos.z + currentDist);
            }
            flyCameraTo(endPos, targetPos, 700);
        }, 250);
    };

    const handleDrillDown = (data: ElementData, mesh: THREE.Mesh) => {
        if (isTransitioning) return;

        // Cancel any deferred camera-fly from the preceding single-click
        // so it never runs (the user is drilling, not selecting).
        if (clickTimerRef.current !== null) {
            window.clearTimeout(clickTimerRef.current);
            clickTimerRef.current = null;
        }
        // Interrupt any in-flight depth-0 fly-in so the drill commits
        // immediately. The depth-change useEffect will hard-snap the
        // camera to the new layer's canonical view.
        if (cameraFlyRef.current) {
            tweenGroup.remove(cameraFlyRef.current);
            cameraFlyRef.current = null;
        }

        setIsTransitioning(true);
        onInterrogate(null);

        const prior = selectedMeshRef.current;
        if (prior) {
            tweenGroup.getAll()
                .filter(t => (t as any)._object === prior.scale)
                .forEach(t => tweenGroup.remove(t));
            prior.scale.set(1, 1, 1);
            selectedMeshRef.current = null;
        }

        // Visual feedback: pop the clicked element briefly, then commit
        // the depth change. No camera tween — depth-change useEffect
        // handles the camera hard-snap atomically.
        tweenGroup.getAll()
            .filter(t => (t as any)._object === mesh.scale)
            .forEach(t => tweenGroup.remove(t));
        mesh.scale.set(1, 1, 1);
        new TWEEN.Tween(mesh.scale, tweenGroup)
            .to({ x: 1.5, y: 1.5, z: 1.5 }, 200)
            .easing(TWEEN.Easing.Quadratic.Out)
            .onComplete(() => {
                mesh.scale.set(1, 1, 1);
                // Pass the clicked element up so the parent component
                // can extend the drill path — the next layer's element
                // ids are scoped under THIS element's full path-id.
                onDrillDown(data);
            })
            .start();
    };

    const handlePointerMissed = () => {
        // Cancel any pending camera fly that was queued from a prior
        // click — the user clicked away, so don't fire it.
        if (clickTimerRef.current !== null) {
            window.clearTimeout(clickTimerRef.current);
            clickTimerRef.current = null;
        }
        const prior = selectedMeshRef.current;
        if (prior) {
            tweenGroup.getAll()
                .filter(t => (t as any)._object === prior.scale)
                .forEach(t => tweenGroup.remove(t));
            prior.scale.set(1, 1, 1);
            selectedMeshRef.current = null;
            onInterrogate(null);
        }
        // INTENTIONAL: do NOT auto-fly the camera back to overview on
        // a missed click. With gaps between elements (e.g. depth-1
        // BACKPLANE = 4-wide elements at 6-unit spacing → 2-unit
        // gaps), users routinely click in the gap when aiming for an
        // element. A missed-click flyback then yanks the camera away
        // mid-select, producing the "moves toward element but doesn't
        // center" symptom. Just deselect; the user can click another
        // element or orbit out manually.
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
                {/* Only the active depth's group is mounted. Three.js's
                    Raycaster does NOT filter by Object3D.visible — invisible
                    children are still tested for ray hits — so a <group
                    visible={false}> still intercepts clicks. With MRAD's
                    depth-0 face (96 elements at z=2.51) sitting in front
                    of depth-1 elements (z=0) in screen space, clicks on
                    centered depth-1 elements were hitting the invisible
                    depth-0 face elements behind the camera ray instead,
                    routing the click to a mesh the user couldn't see
                    (pop tween fires on an invisible mesh, no visible
                    effect; HUD shows the depth-0 element's data even
                    though the breadcrumb says BACKPLANE). Unmounting
                    non-active layers eliminates the raycast collision
                    entirely. */}
                {currentElements && (
                    <group
                        key={currentDepth}
                        ref={el => { if (el) groupsRef.current[currentDepth] = el; }}
                    >
                        {currentDepth === 0 && <HousingMesh size={housingSize} />}
                        {currentElements.map((data: ElementData) => (
                            <ElementMesh
                                key={data.id}
                                data={data}
                                onSelect={handleSelect}
                                onDrillDown={handleDrillDown}
                            />
                        ))}
                    </group>
                )}
            </group>
        </>
    );
}

// Outer housing box rendered at depth 0. Extracted into its own
// component so the EdgesGeometry can be memoized — inline new
// THREE.BoxGeometry calls in the SceneController body would have
// rebuilt the GPU buffer on every render, leaking memory until the
// WebGL context died.
function HousingMesh({ size }: { size: [number, number, number] }) {
    const edges = useMemo(() => {
        const box = new THREE.BoxGeometry(...size);
        const eg = new THREE.EdgesGeometry(box);
        box.dispose();
        return eg;
    }, [size]);
    return (
        <mesh>
            <boxGeometry args={size} />
            <meshPhongMaterial color={COLORS.housing} transparent opacity={0.9} />
            <lineSegments geometry={edges}>
                <lineBasicMaterial color={0x334155} transparent opacity={0.5} />
            </lineSegments>
        </mesh>
    );
}

function ElementMesh({ data, onSelect, onDrillDown }: { data: ElementData, onSelect: any, onDrillDown: any }) {
    const meshRef = useRef<THREE.Mesh>(null);

    // Memoize the wireframe EdgesGeometry. Without this, every React
    // re-render of this component (96 instances × every sim tick) would
    // execute `new THREE.BoxGeometry(...)` and `new THREE.EdgesGeometry(...)`
    // — R3F treats the resulting object as a new constructor arg and
    // builds a fresh GPU buffer. The old buffers don't get disposed,
    // so over ~15 minutes the WebGL driver runs out of GPU memory and
    // kills the context (`THREE.WebGLRenderer: Context Lost`). The
    // useMemo locks the geometry to a single instance keyed on the
    // box dimensions (data.size); disposed on unmount via R3F.
    const edgesGeom = useMemo(() => {
        const box = new THREE.BoxGeometry(...data.size);
        const edges = new THREE.EdgesGeometry(box);
        box.dispose();  // BoxGeometry is no longer referenced after EdgesGeometry is built
        return edges;
    }, [data.size]);

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
                <lineSegments geometry={edgesGeom}>
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
     *  LTAMDS_CONFIG. Pass MRAD_CONFIG for MRAD variants. */
    config?: SensorArrayConfig;
    /** Asset id used as the seed for per-element synthesis. Different
     *  assets get different (consistent) telemetry sets. Default 'unknown'. */
    assetId?: string;
    /** Live per-element telemetry from openddil-mrad-sim. Optional — when
     *  absent, the view falls back to seeded-RNG synthesis. */
    liveTelemetry?: LiveElementTelemetry;
}

export default function SensorArrayView({ coreTemp, config = LTAMDS_CONFIG, liveTelemetry }: SensorArrayViewProps) {
    const [currentDepth, setCurrentDepth] = useState(0);
    const [selectedElement, setSelectedElement] = useState<ElementData | null>(null);
    const [isTransitioning, setIsTransitioning] = useState(false);
    // Full path-encoded id of the element the user drilled INTO at the
    // previous depth. Null at depth 0 (face elements have no parent).
    // The sim publishes one row per (asset, drill-path) so this is the
    // key for child-element lookup. Wrap-around (depth N-1 → 0) resets.
    const [parentId, setParentId] = useState<string | null>(null);

    const maxDepth = config.layers.length;

    const handleDrillDown = (parentData: ElementData) => {
        const next = (currentDepth + 1) % maxDepth;
        setCurrentDepth(next);
        // The clicked element's id IS the new parent path. Its id is
        // already fully path-encoded (e.g. "TR-X-Y/BOARD-0-1") so the
        // next layer's children inherit the whole chain by suffix.
        setParentId(next === 0 ? null : parentData.id);
    };

    const handleInterrogate = (data: ElementData | null) => {
        setSelectedElement(data);
    };

    // Refresh selectedElement when liveTelemetry ticks so the HUD card
    // doesn't lag behind the tile color. Without this, click→pick a
    // yellow tile, sim ticks, tile re-renders cyan (new health value)
    // but the right-side card still says DEGRADED — frozen at click
    // time. Re-deriving from the latest liveTelemetry entry keeps the
    // two in sync on every tick.
    useEffect(() => {
        if (!selectedElement) return;
        const live = liveTelemetry?.[selectedElement.id];
        if (live?.health == null) return;
        if (live.health === selectedElement.healthValue) return;
        const status = getStatusFromHealth(live.health);
        setSelectedElement({
            ...selectedElement,
            healthValue: live.health,
            status,
            temp: live.temp != null ? live.temp.toFixed(1) : selectedElement.temp,
            load: live.load != null ? live.load.toFixed(0) : selectedElement.load,
            color: selectedElement.face === 'INTERNAL' ? selectedElement.color : status.color,
        });
    }, [liveTelemetry, selectedElement]);

    const headerExtras = (
        <>
            <div className="mt-4 flex gap-2 text-[0.6rem] font-bold uppercase tracking-widest text-cyan-500/50">
                {config.layers.slice(0, currentDepth + 1).map((layer, i) => (
                    <span key={i} className="flex items-center gap-2">
                        <span className={i === currentDepth ? 'text-cyan-400' : ''}>{layer.name}</span>
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
                    parentId={parentId}
                    onDrillDown={handleDrillDown}
                    onInterrogate={handleInterrogate}
                    isTransitioning={isTransitioning}
                    setIsTransitioning={setIsTransitioning}
                    faces={config.faces}
                    layers={config.layers}
                    liveTelemetry={liveTelemetry}
                    housingSize={config.housingSize}
                />
            </Canvas>

            {/* Depth indicator — one tick per configured layer. */}
            <div className="absolute bottom-6 right-6 z-10 flex gap-2 pointer-events-none">
                {config.layers.map((_, i) => (
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
