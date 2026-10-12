// =============================================================================
// SchematicMaterial — the one material every schematic part uses
// =============================================================================
// Renders as MESH CHILDREN, per render mode:
//   matte       the original material, props untouched (visual no-op)
//   metallic    solid -> meshPhysicalMaterial via metallicParams;
//               indicator stays unlit basic so state colours are unchanged
//   holographic solid -> shared holo shader + cyan Edges;
//               indicator -> bright additive basic (blooms) in its OWN colour
// kind: 'solid' (default; lit) | 'indicator' (unlit basic: status pads,
// accents, wire overlays) | 'glass' (translucent lit surface).
// `shading="phong"` keeps a part that is Phong today Phong in matte.
// `holoColor` overrides a solid with a bright semantic colour in holographic.
import type { ThreeElements } from '@react-three/fiber';
import { Edges } from '@react-three/drei';
import * as THREE from 'three';
import { useRenderMode } from './renderMode';
import { metallicParams } from './metallic';
import { holoMaterial, HOLO_EDGE } from './holoMaterial';

export type SchematicKind = 'solid' | 'indicator' | 'glass';

type BaseProps = ThreeElements['meshStandardMaterial'];

export type SchematicMaterialProps = Omit<BaseProps, 'ref'> & {
  kind?: SchematicKind;
  shading?: 'standard' | 'phong';
  holoColor?: THREE.ColorRepresentation;
};

export function SchematicMaterial({ kind = 'solid', shading = 'standard', holoColor, ...props }: SchematicMaterialProps) {
  const mode = useRenderMode();

  if (kind === 'indicator') {
    if (mode === 'holographic') {
      return (
        <meshBasicMaterial
          {...(props as object)}
          transparent
          depthWrite={false}
          toneMapped={false}
          blending={THREE.AdditiveBlending}
        />
      );
    }
    return <meshBasicMaterial {...(props as object)} />;
  }

  if (mode === 'holographic') {
    if (holoColor !== undefined) {
      return (
        <meshBasicMaterial
          color={holoColor}
          transparent
          opacity={0.7}
          depthWrite={false}
          toneMapped={false}
          blending={THREE.AdditiveBlending}
        />
      );
    }
    return (
      <>
        <primitive object={holoMaterial} attach="material" />
        <Edges
          threshold={22}
          color={HOLO_EDGE}
          transparent
          opacity={0.85}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </>
    );
  }

  if (mode === 'metallic') {
    const p = metallicParams(props as never);
    return <meshPhysicalMaterial {...(p as object)} {...(kind === 'glass' ? { roughness: 0.15 } : {})} />;
  }

  return shading === 'phong'
    ? <meshPhongMaterial {...(props as object)} />
    : <meshStandardMaterial {...props} />;
}
