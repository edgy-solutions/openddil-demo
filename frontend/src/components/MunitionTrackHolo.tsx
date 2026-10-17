// =============================================================================
// MunitionTrackHolo -- an in-flight munition drawn as a holographic track
// =============================================================================
// Every size here is in screen pixels, not scene units: the HQ map runs at 400
// units per degree with the camera 200-1200 units out, the regional map at 80
// with the camera as close as 10, and a sphere sized in scene units read as a
// dot on one and a ball on the other.
//
// Parts, all additive and unlit so they read as light rather than objects:
//   - head: a hot core, a soft halo and a thin ring (one point sprite);
//   - trail: a tapered streak through the recent samples, brightest at the
//     head, with pulses running toward it, so direction reads at a glance;
//   - curtain: a faint sheet from the trail down to the ground, scanlined in
//     screen space like the maintainer holograms, so altitude is visible as
//     a flight profile rather than a number;
//   - ground trace and drop line with a footprint ring under the head;
//   - launch ring at the launcher and a reticle at the target when known;
//   - endings that differ: a burst and ground shock on detonation, a hollow
//     ring and grey fade on silence (the track was lost, not the target hit).
import { useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';

export type Vec3 = [number, number, number];
export type TrackEnding = { kind: 'detonation' | 'silence'; atMs: number } | null;

const AMBER = new THREE.Color('#f59e0b');
const HOT = new THREE.Color('#fff3c4');
const ROSE = new THREE.Color('#fb7185');
const LOST = new THREE.Color('#94a3b8');

/** How long each ending plays before the component draws nothing. */
export const BURST_MS = 1400;
export const SILENCE_MS = 3500;

// Pixel sizes (CSS px). Exported so a test can see that nothing is in scene units.
export const HEAD_PX = 22;
export const FOOT_PX = 14;
export const LAUNCH_PX = 12;
export const LAUNCH_PULSE_PX = 6;
export const RETICLE_PX = 30;
export const LOST_PX = 20;
export const LOST_GROW_PX = 10;
export const BURST_PX = 14;
export const BURST_RING_PX = 110;
export const SHOCK_PX = 10;
export const SHOCK_RING_PX = 150;
export const TRAIL_MIN_PX = 0.5;
export const TRAIL_MAX_PX = 7;
export const CORE_MAX_PX = 2;

// --- point sprites (head, rings, reticle, burst) ---------------------------
// One shader, a `shape` uniform picks the drawing. gl_PointSize is in device
// pixels, so `px` is CSS pixels times the pixel ratio.
const spriteVert = `uniform float px;uniform float dpr;void main(){gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);gl_PointSize=px*dpr;}`;
const spriteFrag = `uniform vec3 col;uniform float a;uniform float t;uniform int shape;uniform float ringW;
float ring(float r,float c,float w){return 1.-smoothstep(0.,w,abs(r-c));}
void main(){vec2 p=gl_PointCoord*2.-1.;float r=length(p);if(r>1.)discard;float ang=atan(p.y,p.x+1e-5);float v=0.;
 if(shape==0){v=exp(-r*r*28.)*1.6+exp(-r*r*5.)*.35+ring(r,.62,.05)*(.55+.45*sin(t*6.));}
 else if(shape==1){v=ring(r,.8,ringW);}
 else if(shape==2){float br=step(.55,abs(sin(ang*2.+t*.8)));v=ring(r,.82,.06)*br+ring(r,.18,.08)*.8;
   v+=(1.-smoothstep(0.,.04,abs(p.x)))*step(.35,r)*step(r,.6)*.6+(1.-smoothstep(0.,.04,abs(p.y)))*step(.35,r)*step(r,.6)*.6;}
 else if(shape==3){v=ring(r,.8,.07)*step(0.,sin(ang*8.+t*2.));}
 else{v=ring(r,.86,ringW)+exp(-r*r*6.)*.6;}
 gl_FragColor=vec4(col*v*a,1.);}`;

function spriteMaterial(shape: number) {
  return new THREE.ShaderMaterial({
    uniforms: {
      px: { value: 16 }, dpr: { value: 1 }, col: { value: AMBER.clone() }, a: { value: 1 },
      t: { value: 0 }, shape: { value: shape }, ringW: { value: 0.08 },
    },
    vertexShader: spriteVert, fragmentShader: spriteFrag,
    transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
  });
}

function Sprite({ at, mat }: { at: Vec3; mat: THREE.ShaderMaterial }) {
  const geo = useMemo(() => new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(at, 3)), [at]);
  return <points geometry={geo} material={mat} frustumCulled={false} renderOrder={10} />;
}

// --- screen-space ribbon (trail, ground trace, drop line) -------------------
// Each path point is emitted twice (side -1/+1); the vertex shader offsets the
// pair perpendicular to the path as seen on screen, so width is in pixels.
const ribbonVert = `attribute vec3 prev;attribute vec3 next;attribute float side;attribute float u;
uniform vec2 res;uniform float w0;uniform float w1;varying float vU;varying float vS;
vec2 scr(vec4 c){return c.xy/c.w*res*.5;}
void main(){vec4 c=projectionMatrix*modelViewMatrix*vec4(position,1.);
 vec2 a=scr(projectionMatrix*modelViewMatrix*vec4(prev,1.));vec2 b=scr(projectionMatrix*modelViewMatrix*vec4(next,1.));
 vec2 d=b-a;d=length(d)<1e-4?vec2(1.,0.):normalize(d);vec2 n=vec2(-d.y,d.x);
 float w=mix(w0,w1,u);c.xy+=n*side*w*.5/(res*.5)*c.w;gl_Position=c;vU=u;vS=side;}`;
const ribbonFrag = `uniform vec3 col;uniform float a;uniform float t;uniform float pulse;uniform float dash;varying float vU;varying float vS;
void main(){float edge=max(0.,1.-vS*vS);float k=pow(clamp(vU,0.,1.),1.4)*(.35+.65*edge);
 k*=1.+pulse*.9*smoothstep(.75,1.,sin(vU*40.-t*9.));
 if(dash>0.&&sin(gl_FragCoord.y*dash)<0.)k*=.15;
 gl_FragColor=vec4(col*k*a,1.);}`;

function ribbonMaterial(w0: number, w1: number, color: THREE.Color, pulse = 0, dash = 0) {
  return new THREE.ShaderMaterial({
    uniforms: {
      res: { value: new THREE.Vector2(1, 1) }, w0: { value: w0 }, w1: { value: w1 },
      col: { value: color.clone() }, a: { value: 1 }, t: { value: 0 }, pulse: { value: pulse }, dash: { value: dash },
    },
    vertexShader: ribbonVert, fragmentShader: ribbonFrag,
    // DoubleSide: the strip's winding flips with the path's screen direction.
    transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
  });
}

// The ribbon converts pixels to clip space with `res`. The same mesh can be
// drawn into more than one viewport (the map, then the engagement inset), so
// each draw reads the viewport it is going into.
const vp = new THREE.Vector4();
function fitRes(r: THREE.WebGLRenderer, _s: THREE.Scene, _c: THREE.Camera, _g: THREE.BufferGeometry, mat: THREE.Material) {
  const u = (mat as THREE.ShaderMaterial).uniforms;
  if (!u?.res) return;
  r.getCurrentViewport(vp);
  const dpr = r.getPixelRatio();
  u.res.value.set(vp.z / dpr, vp.w / dpr);
  (mat as THREE.ShaderMaterial).uniformsNeedUpdate = true;
}

function ribbonGeometry(pts: THREE.Vector3[], uFrom = 0): THREE.BufferGeometry {
  const n = pts.length;
  const pos: number[] = [], prev: number[] = [], next: number[] = [], side: number[] = [], u: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i], a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    const ui = uFrom + (1 - uFrom) * (n > 1 ? i / (n - 1) : 1);
    for (const s of [-1, 1]) {
      pos.push(p.x, p.y, p.z); prev.push(a.x, a.y, a.z); next.push(b.x, b.y, b.z); side.push(s); u.push(ui);
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < n - 1; i++) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('prev', new THREE.Float32BufferAttribute(prev, 3));
  g.setAttribute('next', new THREE.Float32BufferAttribute(next, 3));
  g.setAttribute('side', new THREE.Float32BufferAttribute(side, 1));
  g.setAttribute('u', new THREE.Float32BufferAttribute(u, 1));
  g.setIndex(idx);
  return g;
}

// --- altitude curtain --------------------------------------------------------
// A vertical sheet between the trail and the ground. Bright at the trail edge,
// gone at the ground, older samples fainter; scanlines use gl_FragCoord so
// they are the same pixel pitch on both maps.
const curtainVert = `attribute float u;attribute float h;varying float vU;varying float vH;
void main(){vU=u;vH=h;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`;
const curtainFrag = `uniform vec3 col;uniform float a;uniform float t;varying float vU;varying float vH;
void main(){float scan=.55+.45*sin(gl_FragCoord.y*1.6-t*4.);
 float k=pow(clamp(vH,0.,1.),1.6)*.55*scan*pow(clamp(vU,0.,1.),1.2)+smoothstep(.96,1.,vH)*.35*vU;
 gl_FragColor=vec4(col*k*a,1.);}`;

function curtainGeometry(pts: THREE.Vector3[], groundY: number): THREE.BufferGeometry {
  const pos: number[] = [], u: number[] = [], h: number[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p = pts[i], ui = n > 1 ? i / (n - 1) : 1;
    pos.push(p.x, p.y, p.z, p.x, groundY, p.z); u.push(ui, ui); h.push(1, 0);
  }
  const idx: number[] = [];
  for (let i = 0; i < n - 1; i++) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('u', new THREE.Float32BufferAttribute(u, 1));
  g.setAttribute('h', new THREE.Float32BufferAttribute(h, 1));
  g.setIndex(idx);
  return g;
}

// Repeated samples (a munition reporting the same fix twice) are dropped: a
// zero-length span gives the centripetal curve NaNs, and bloom smears a NaN
// pixel across the whole frame.
function smoothPath(samples: Vec3[]): THREE.Vector3[] {
  const v: THREE.Vector3[] = [];
  for (const s of samples) {
    const p = new THREE.Vector3(...s);
    if (s.every(Number.isFinite) && (!v.length || v[v.length - 1].distanceToSquared(p) > 1e-8)) v.push(p);
  }
  if (v.length < 3) return v;
  return new THREE.CatmullRomCurve3(v, false, 'centripetal').getPoints(Math.min(96, v.length * 8));
}

type Materials = ReturnType<typeof makeMaterials>;

function makeMaterials() {
  return {
    trail: ribbonMaterial(TRAIL_MIN_PX, TRAIL_MAX_PX, AMBER, 1),
    core: ribbonMaterial(0, CORE_MAX_PX, HOT),
    ground: ribbonMaterial(1, 1.5, AMBER),
    drop: ribbonMaterial(1, 1, AMBER, 0, 0.9),
    aim: ribbonMaterial(1, 1, ROSE, 0, 0.7),
    curtain: new THREE.ShaderMaterial({
      uniforms: { col: { value: AMBER.clone() }, a: { value: 1 }, t: { value: 0 } },
      vertexShader: curtainVert, fragmentShader: curtainFrag,
      transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    }),
    head: spriteMaterial(0),
    foot: spriteMaterial(1),
    launch: spriteMaterial(1),
    reticle: spriteMaterial(2),
    lost: spriteMaterial(3),
    burst: spriteMaterial(4),
    shock: spriteMaterial(1),
  };
}

/** Per-frame uniforms: time, pixel ratio and the ending's progress. Width and height are CSS pixels. */
function tick(m: Materials, t: number, dpr: number, width: number, height: number, ending: TrackEnding | undefined) {
  const since = ending ? Math.max(0, performance.now() - ending.atMs) : 0;
  const det = ending?.kind === 'detonation', sil = ending?.kind === 'silence';
  const p = det ? Math.min(1, since / BURST_MS) : sil ? Math.min(1, since / SILENCE_MS) : 0;
  const fade = ending ? 1 - p : 1;
  const lineCol = sil ? AMBER.clone().lerp(LOST, Math.min(1, p * 3)) : AMBER;

  for (const k of ['trail', 'core', 'ground', 'drop', 'aim'] as const) {
    const u = m[k].uniforms;
    u.res.value.set(width, height);
    u.t.value = t;
    u.a.value = det ? (1 - p) * (1 + 2 * Math.max(0, 1 - p * 6)) : fade;
    if (k !== 'aim' && k !== 'core') u.col.value.copy(lineCol);
  }
  m.curtain.uniforms.t.value = t;
  m.curtain.uniforms.a.value = fade;
  m.curtain.uniforms.col.value.copy(lineCol);

  for (const s of [m.head, m.foot, m.launch, m.reticle, m.lost, m.burst, m.shock]) {
    s.uniforms.dpr.value = dpr;
    s.uniforms.t.value = t;
  }
  m.head.uniforms.px.value = HEAD_PX;
  m.head.uniforms.a.value = ending ? 0 : 1;
  m.foot.uniforms.px.value = FOOT_PX;
  m.foot.uniforms.a.value = 0.5 * fade;
  m.foot.uniforms.col.value.copy(lineCol);
  m.launch.uniforms.px.value = LAUNCH_PX + LAUNCH_PULSE_PX * ((t * 0.6) % 1);
  m.launch.uniforms.a.value = 0.7 * (1 - ((t * 0.6) % 1)) * fade;
  m.reticle.uniforms.px.value = RETICLE_PX;
  m.reticle.uniforms.col.value.copy(ROSE);
  m.reticle.uniforms.a.value = det ? 1 - p : fade;
  m.lost.uniforms.px.value = LOST_PX + LOST_GROW_PX * p;
  m.lost.uniforms.col.value.copy(LOST);
  m.lost.uniforms.a.value = sil ? 1 - p : 0;
  // Burst: a white-hot flash that cools to amber while its ring opens out.
  m.burst.uniforms.px.value = BURST_PX + BURST_RING_PX * Math.pow(p, 0.45);
  m.burst.uniforms.ringW.value = 0.18 * (1 - p) + 0.02;
  m.burst.uniforms.col.value.copy(HOT).lerp(AMBER, p);
  m.burst.uniforms.a.value = det ? Math.pow(1 - p, 1.5) * 0.9 : 0;
  m.shock.uniforms.px.value = SHOCK_PX + SHOCK_RING_PX * p;
  m.shock.uniforms.ringW.value = 0.04;
  m.shock.uniforms.a.value = det ? (1 - p) * 0.8 : 0;
}

export interface MunitionTrackHoloProps {
  /** Ids for the test anchor. */
  track: { munitionAssetId: string; launcherAssetId: string | null };
  /** Recent samples, oldest first; the last one is the head. Scene units, y = altitude. */
  trail: Vec3[];
  groundY: number;
  launcher?: Vec3;
  target?: Vec3;
  ending?: TrackEnding;
}

export default function MunitionTrackHolo({
  track, trail, groundY, launcher, target, ending,
}: MunitionTrackHoloProps) {
  const { size, gl } = useThree();
  const head = trail[trail.length - 1];
  const headGround: Vec3 = [head[0], groundY, head[2]];

  const path = useMemo(() => smoothPath(trail), [trail]);
  const groundPath = useMemo(() => path.map((p) => new THREE.Vector3(p.x, groundY, p.z)), [path, groundY]);
  const trailGeo = useMemo(() => ribbonGeometry(path), [path]);
  const groundGeo = useMemo(() => ribbonGeometry(groundPath, 0.2), [groundPath]);
  const curtainGeo = useMemo(() => curtainGeometry(path, groundY), [path, groundY]);
  const dropGeo = useMemo(() => ribbonGeometry([new THREE.Vector3(...headGround), new THREE.Vector3(...head)], 0.5), [head, groundY]); // eslint-disable-line react-hooks/exhaustive-deps
  const aimGeo = useMemo(
    () => (target ? ribbonGeometry([new THREE.Vector3(...head), new THREE.Vector3(...target)], 0) : null),
    [head, target],
  );

  const m = useMemo(() => makeMaterials(), []);
  useFrame(({ clock }) => tick(m, clock.getElapsedTime(), gl.getPixelRatio(), size.width, size.height, ending));

  return (
    <group>
      <mesh geometry={curtainGeo} material={m.curtain} frustumCulled={false} renderOrder={5} />
      <mesh geometry={groundGeo} material={m.ground} onBeforeRender={fitRes} frustumCulled={false} renderOrder={6} />
      <mesh geometry={trailGeo} material={m.trail} onBeforeRender={fitRes} frustumCulled={false} renderOrder={7} />
      <mesh geometry={trailGeo} material={m.core} onBeforeRender={fitRes} frustumCulled={false} renderOrder={8} />
      <mesh geometry={dropGeo} material={m.drop} onBeforeRender={fitRes} frustumCulled={false} renderOrder={6} />
      {aimGeo && <mesh geometry={aimGeo} material={m.aim} onBeforeRender={fitRes} frustumCulled={false} renderOrder={6} />}
      <Sprite at={headGround} mat={m.foot} />
      {launcher && <Sprite at={launcher} mat={m.launch} />}
      {target && <Sprite at={target} mat={m.reticle} />}
      <Sprite at={head} mat={m.head} />
      <Sprite at={head} mat={m.lost} />
      <Sprite at={head} mat={m.burst} />
      <Sprite at={headGround} mat={m.shock} />
      {!ending && (
        <Html position={head} center style={{ pointerEvents: 'none' }}>
          <div
            data-testid="munition-track-marker"
            data-munition={track.munitionAssetId}
            data-launcher={track.launcherAssetId ?? ''}
            style={{ width: 1, height: 1 }}
          />
        </Html>
      )}
    </group>
  );
}
