// =============================================================================
// EngagementInset -- a corner view of the same scene, framed on the flights
// =============================================================================
// The maps draw assets as symbols (a launcher is ~3 units, ~4 km on the
// regional map) but munitions at true scale (a 20 s flight is ~3.6 units), so
// in the main view a flight never leaves its launcher's silhouette. Rather
// than exaggerating either, a second camera renders the SAME scene into a
// corner viewport, framed on whatever is in flight (every trail sample, the
// launchers and the targets), looking from the main camera's bearing so
// directions match. In that view the asset models are hidden and drawn as
// pixel dots, so the flight is the biggest thing in it.
//
// Usage, inside the <Canvas>:
//   - tag each asset model's group with userData.insetHidden = true;
//   - render <EngagementInset focus={...} markers={...} renderMain />;
//   - put <EngagementInsetFrame> next to the canvas for the border and label.
//
// Rendering: a useFrame at a positive priority turns R3F's own render off,
// so with renderMain the inset renders the main view first. A view that has
// an EffectComposer (HQ, priority 1) leaves renderMain off and the inset
// draws after it at priority 2, without bloom.
import { useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { Vec3 } from './MunitionTrackHolo';
import {
  frameOf, gridStepKm, MIN_RADIUS, INSET_RECT as DEFAULT_INSET_RECT, type InsetRect,
} from '../lib/engagementFrame';


/** Downward look of the inset camera, clamped so altitude always reads. */
const MIN_PITCH = (14 * Math.PI) / 180;
const MAX_PITCH = (40 * Math.PI) / 180;
/** Seconds for the framing to settle on a new extent. */
const EASE_S = 0.6;
const INSET_BG = new THREE.Color(0x030b1a);

export interface InsetMarker { at: Vec3; color: string }

export interface EngagementInsetProps {
  /** Points to keep in frame. Empty hides the inset. */
  focus: Vec3[];
  /** Assets as dots, drawn in the inset only (their models are hidden there). */
  markers?: InsetMarker[];
  groundY?: number;
  rect?: InsetRect;
  /** Render the main view too: set when no EffectComposer renders it. */
  renderMain?: boolean;
  /** Scene units per km: sizes the inset's ground grid in whole km steps. */
  unitsPerKm: number;
}

const dotVert = `attribute vec3 color;varying vec3 vC;uniform float px;uniform float dpr;
void main(){vC=color;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);gl_PointSize=px*dpr;}`;
const dotFrag = `varying vec3 vC;void main(){vec2 p=gl_PointCoord*2.-1.;float r=length(p);if(r>1.)discard;
 float k=1.-smoothstep(.55,.75,r)+(1.-smoothstep(0.,.12,abs(r-.88)))*.7;gl_FragColor=vec4(vC*k,k);}`;

function makeDotMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { px: { value: 9 }, dpr: { value: 1 } },
    vertexShader: dotVert, fragmentShader: dotFrag,
    transparent: true, depthWrite: false, depthTest: false,
  });
}

/** Objects tagged insetHidden, without walking into them (models can be large). */
function collectHidden(o: THREE.Object3D, out: THREE.Object3D[]) {
  for (const c of o.children) {
    if (c.userData.insetHidden) out.push(c);
    else collectHidden(c, out);
  }
}

interface Rig {
  cam: THREE.PerspectiveCamera;
  c: THREE.Vector3;
  r: number;
  ready: boolean;
  dots: THREE.Points;
  hidden: THREE.Object3D[];
  v: THREE.Vector3;
  grid: THREE.GridHelper | null;
  gridStep: number;
}

function makeRig(): Rig {
  const dots = new THREE.Points(new THREE.BufferGeometry(), makeDotMaterial());
  dots.frustumCulled = false;
  dots.visible = false;
  dots.renderOrder = 9;
  return {
    cam: new THREE.PerspectiveCamera(32, 1, 0.01, 1000), c: new THREE.Vector3(), r: MIN_RADIUS,
    ready: false, dots, hidden: [], v: new THREE.Vector3(), grid: null, gridStep: 0,
  };
}

function setDots(rig: Rig, markers: InsetMarker[]) {
  const pos: number[] = [], col: number[] = [];
  const tmp = new THREE.Color();
  for (const m of markers) { pos.push(...m.at); tmp.set(m.color); col.push(tmp.r, tmp.g, tmp.b); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  rig.dots.geometry.dispose();
  rig.dots.geometry = g;
}

/** Ease the rig onto the frame and aim it from the main camera's bearing. */
function aim(rig: Rig, main: THREE.Camera, frame: { c: THREE.Vector3; r: number }, aspect: number, dt: number) {
  const k = rig.ready ? 1 - Math.exp(-dt / (EASE_S / 3)) : 1;
  rig.c.lerp(frame.c, k);
  rig.r += (frame.r - rig.r) * k;
  rig.ready = true;

  const fwd = main.getWorldDirection(rig.v);
  const az = Math.atan2(fwd.x, fwd.z);
  const pitch = Math.min(MAX_PITCH, Math.max(MIN_PITCH, Math.asin(Math.min(1, Math.max(-1, -fwd.y)))));
  const cam = rig.cam;
  const half = THREE.MathUtils.degToRad(cam.fov / 2);
  // Fit the sphere in the narrower of the two half-angles.
  const halfMin = aspect < 1 ? Math.atan(Math.tan(half) * aspect) : half;
  const dist = (rig.r / Math.sin(halfMin)) * 1.05;
  const back = new THREE.Vector3(Math.sin(az) * Math.cos(pitch), -Math.sin(pitch), Math.cos(az) * Math.cos(pitch));
  cam.position.copy(rig.c).addScaledVector(back, -dist);
  cam.aspect = aspect;
  cam.near = dist / 100;
  cam.far = dist * 20;
  cam.lookAt(rig.c);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld();
}

const GRID_CELLS = 24;
/** The inset's own ground grid: whole-km cells, snapped to the cell so it doesn't swim. */
function placeGrid(rig: Rig, scene: THREE.Scene, groundY: number, unitsPerKm: number) {
  const step = gridStepKm(rig.r, unitsPerKm);
  if (step !== rig.gridStep || !rig.grid) {
    rig.grid?.removeFromParent();
    rig.grid?.geometry.dispose();
    const cell = step * unitsPerKm;
    rig.grid = new THREE.GridHelper(cell * GRID_CELLS, GRID_CELLS, 0x334155, 0x1e293b);
    rig.grid.frustumCulled = false;
    rig.gridStep = step;
  }
  if (!rig.grid.parent) scene.add(rig.grid);
  const cell = step * unitsPerKm;
  rig.grid.position.set(Math.round(rig.c.x / cell) * cell, groundY - 0.01, Math.round(rig.c.z / cell) * cell);
  rig.grid.visible = true;
}

interface FrameArgs {
  gl: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.Camera; size: { width: number; height: number };
}

/** One frame: optionally the main view, then the inset viewport with models swapped for dots. */
function renderFrame(
  { gl, scene, camera, size }: FrameArgs, rig: Rig, frame: ReturnType<typeof frameOf>,
  rect: InsetRect, renderMain: boolean, dt: number, groundY: number, unitsPerKm: number,
) {
  if (renderMain) gl.render(scene, camera);
  if (!frame) { rig.ready = false; return; }
  aim(rig, camera, frame, rect.w / rect.h, dt);

  rig.hidden.length = 0;
  collectHidden(scene, rig.hidden);
  const was = rig.hidden.map((o) => o.visible);
  for (const o of rig.hidden) o.visible = false;
  if (!rig.dots.parent) scene.add(rig.dots);
  rig.dots.visible = true;
  placeGrid(rig, scene, groundY, unitsPerKm);
  (rig.dots.material as THREE.ShaderMaterial).uniforms.dpr.value = gl.getPixelRatio();
  const fog = scene.fog;
  const bg = scene.background;
  scene.fog = null;
  scene.background = INSET_BG;

  const autoClear = gl.autoClear;
  gl.autoClear = true;
  gl.setViewport(rect.x, rect.y, rect.w, rect.h);
  gl.setScissor(rect.x, rect.y, rect.w, rect.h);
  gl.setScissorTest(true);
  gl.render(scene, rig.cam);
  gl.setScissorTest(false);
  gl.setViewport(0, 0, size.width, size.height);
  gl.autoClear = autoClear;

  scene.background = bg;
  scene.fog = fog;
  rig.dots.visible = false;
  if (rig.grid) rig.grid.visible = false;
  rig.hidden.forEach((o, i) => { o.visible = was[i]; });
}

export default function EngagementInset({
  focus, markers = [], groundY = 0, rect = DEFAULT_INSET_RECT, renderMain = false, unitsPerKm,
}: EngagementInsetProps) {
  const rig = useMemo(() => makeRig(), []);
  const frame = useMemo(() => frameOf(focus, groundY), [focus, groundY]);
  // Dots follow the markers; the rig owns the geometry, so the swap is a module call.
  useMemo(() => setDots(rig, markers), [rig, markers]);
  useEffect(() => () => {
    rig.dots.removeFromParent(); rig.dots.geometry.dispose();
    rig.grid?.removeFromParent(); rig.grid?.geometry.dispose();
  }, [rig]);
  useFrame((state, dt) => renderFrame(state, rig, frame, rect, renderMain, dt, groundY, unitsPerKm), renderMain ? 1 : 2);
  return null;
}

/** The inset's border and label, absolutely placed over the canvas's container. */
export function EngagementInsetFrame({
  visible, label, rect = DEFAULT_INSET_RECT,
}: { visible: boolean; label: string; rect?: InsetRect }) {
  if (!visible) return null;
  return (
    <div
      data-testid="engagement-inset"
      className="pointer-events-none absolute rounded-sm border border-amber-500/40 shadow-[0_0_18px_rgba(245,158,11,0.15)]"
      style={{ left: rect.x, bottom: rect.y, width: rect.w, height: rect.h }}
    >
      <div className="absolute left-2 top-1.5 font-mono text-[9px] tracking-[0.2em] text-amber-300/90">{label}</div>
      <div className="absolute inset-0 rounded-sm bg-[repeating-linear-gradient(0deg,transparent_0,transparent_2px,rgba(148,163,184,0.04)_3px)]" />
    </div>
  );
}
