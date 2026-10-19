// The terrain meshes: a heightfield with the basemap draped on it, and sharp patches over it.
// The loaders, hooks and helpers live in terrainData.ts.
import { useEffect, useMemo } from 'react';
import '@react-three/fiber'; // JSX intrinsics for mesh
import * as THREE from 'three';
import { REGIONAL_SAT_FRAG, REGIONAL_SAT_VERT } from './theaterShaders';
import { drape, type Patch, type TerrainData } from './terrainData';

/** The unlit satellite material (HQ shading, brightness control, fog). Memoised per texture and mask. */
function useSatMaterial(map: THREE.Texture, maskCanvas: HTMLCanvasElement | null, brightness: number, patch: boolean) {
  const maskTex = useMemo(() => (maskCanvas ? new THREE.CanvasTexture(maskCanvas) : null), [maskCanvas]);
  useEffect(() => () => { maskTex?.dispose(); }, [maskTex]);
  const material = useMemo(() => {
    // Fog uniforms are cloned by merge; the textures are assigned after so they are not.
    const uniforms: Record<string, THREE.IUniform> = {
      ...THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
      uMap: { value: map }, uMask: { value: maskTex },
      uHasMask: { value: maskTex ? 1 : 0 }, uBright: { value: 1 },
    };
    return new THREE.ShaderMaterial({
      uniforms,
      vertexShader: REGIONAL_SAT_VERT,
      fragmentShader: REGIONAL_SAT_FRAG,
      fog: true,
      transparent: patch,
      depthWrite: !patch,
      polygonOffset: patch,
      polygonOffsetFactor: patch ? -2 : 0,
      polygonOffsetUnits: patch ? -2 : 0,
    });
  }, [map, maskTex, patch]);
  useEffect(() => () => material.dispose(), [material]);
  // eslint-disable-next-line react-hooks/immutability -- three.js uniforms are GPU state set imperatively (R3F)
  useEffect(() => { material.uniforms.uBright.value = brightness; }, [material, brightness]);
  return material;
}

export function TerrainMesh({ data, exag = 1, segments = 400, brightness = 1 }: { data: TerrainData; exag?: number; segments?: number; brightness?: number }) {
  const geometry = useMemo(() => drape(data.heightM, data.bounds, data.proj, segments, exag), [data, exag, segments]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  const material = useSatMaterial(data.texture, data.mask, brightness, false);

  return (
    // Drawn only in the main view, not in the engagement inset.
    <mesh geometry={geometry} userData={{ insetHidden: true }}>
      <primitive object={material} attach="material" />
    </mesh>
  );
}

/** A patch draped on the same heightfield, drawn over the base imagery; sharper patches draw on top. */
export function PatchMesh({ data, patch, exag = 1, brightness = 1 }: { data: TerrainData; patch: Patch; exag?: number; brightness?: number }) {
  // Vehicle patches are ~200 m: 16 segments still follow the ~45 m DEM.
  const segs = patch.zoom >= 19 ? 16 : 96;
  const geometry = useMemo(() => drape(data.heightM, patch.bounds, data.proj, segs, exag), [data, patch, exag, segs]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => patch.texture.dispose(), [patch]);
  const material = useSatMaterial(patch.texture, null, brightness, true);
  return (
    <mesh geometry={geometry} renderOrder={patch.zoom} userData={{ insetHidden: true }}>
      <primitive object={material} attach="material" />
    </mesh>
  );
}
