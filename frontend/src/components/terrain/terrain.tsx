// The terrain meshes: a heightfield with the basemap draped on it, and sharp patches over it.
// The loaders, hooks and helpers live in terrainData.ts.
import { useEffect, useMemo } from 'react';
import '@react-three/fiber'; // JSX intrinsics for mesh
import { drape, type Patch, type TerrainData } from './terrainData';

export function TerrainMesh({ data, exag = 1, segments = 400 }: { data: TerrainData; exag?: number; segments?: number }) {
  const geometry = useMemo(() => drape(data.heightM, data.bounds, data.proj, segments, exag), [data, exag, segments]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    // Drawn only in the main view, not in the engagement inset.
    <mesh geometry={geometry} userData={{ insetHidden: true }}>
      <meshStandardMaterial map={data.texture} roughness={1} metalness={0} color="#a8b4c4" />
    </mesh>
  );
}

/** A patch draped on the same heightfield, drawn over the base imagery; sharper patches draw on top. */
export function PatchMesh({ data, patch, exag = 1 }: { data: TerrainData; patch: Patch; exag?: number }) {
  // Vehicle patches are ~200 m: 16 segments still follow the ~45 m DEM.
  const segs = patch.zoom >= 19 ? 16 : 96;
  const geometry = useMemo(() => drape(data.heightM, patch.bounds, data.proj, segs, exag), [data, patch, exag, segs]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => patch.texture.dispose(), [patch]);
  return (
    <mesh geometry={geometry} renderOrder={patch.zoom} userData={{ insetHidden: true }}>
      <meshStandardMaterial map={patch.texture} roughness={1} metalness={0} color="#a8b4c4"
        transparent depthWrite={false} polygonOffset polygonOffsetFactor={-2} polygonOffsetUnits={-2} />
    </mesh>
  );
}
