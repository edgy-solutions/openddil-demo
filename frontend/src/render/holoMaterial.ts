// Shared holographic ShaderMaterial (module singleton). One program and one
// uniform set serve every solid part; the scene component advances `t` once
// per frame. Sweep range uniforms let the scene fit the band to the model.
import * as THREE from 'three';

const vertexShader = `varying vec3 vN;varying vec3 vV;varying vec3 vW;
void main(){vec4 w=modelMatrix*vec4(position,1.);vW=w.xyz;vN=normalize(mat3(modelMatrix)*normal);vV=normalize(cameraPosition-w.xyz);gl_Position=projectionMatrix*viewMatrix*w;}`;

const fragmentShader = `uniform float t;uniform vec3 col;uniform float y0;uniform float span;varying vec3 vN;varying vec3 vV;varying vec3 vW;
void main(){float f=pow(1.-abs(dot(normalize(vN),vV)),2.2);
 float scan=.55+.45*sin(vW.y*38.-t*5.);
 float sweep=smoothstep(.25,0.,abs(vW.y-(mod(t*.9,span)+y0)));
 float flick=.92+.08*sin(t*47.)*sin(t*13.);
 float a=(.05+f*.85)*scan*flick+sweep*.5;
 gl_FragColor=vec4(col*(.6+f*1.4+sweep*1.5),a);}`;

export const HOLO_CYAN = 0x22d3ee;
export const HOLO_EDGE = '#67e8f9';

export const holoMaterial = new THREE.ShaderMaterial({
  uniforms: {
    t: { value: 0 },
    col: { value: new THREE.Color(HOLO_CYAN) },
    y0: { value: -1.2 },
    span: { value: 4.4 },
  },
  vertexShader,
  fragmentShader,
  transparent: true,
  depthWrite: false,
  side: THREE.DoubleSide,
  blending: THREE.AdditiveBlending,
});

export function setHoloTime(t: number): void {
  holoMaterial.uniforms.t.value = t;
}

export function setHoloSweep(base: number, span: number): void {
  holoMaterial.uniforms.y0.value = base;
  holoMaterial.uniforms.span.value = span;
}
