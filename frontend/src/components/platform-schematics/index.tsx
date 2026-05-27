// =============================================================================
// platform-schematics — module entry point
// =============================================================================
// Two flavors of export:
//
// 1. NAMED — individual schematic components (LaserShoradSchematic,
//    ArtillerySchematic, etc.) for maintainer-view direct imports. These
//    were extracted verbatim from DiagnosticCanvas.tsx and continue to
//    serve that view.
//
// 2. SCHEMATIC_REGISTRY — string -> component map keyed by platform_variant.
//    The AssetVisual cascade (regional/HQ 3D maps) dispatches off this
//    registry. New platforms = new entry here, no cascade code change.
//
// Coverage today is the full ORBAT enum from the customer sim
// (CoalitionHierarchy + CoalitionSensorArray schemas) plus the legacy DIS
// fleet (M1A2-SEPv3, AH-64E). New variants land in the registry; the
// AssetVisual handles missing entries via UnknownPlatformBadge fallback.
//
// See types.ts for the shared SchematicProps contract and the SensorTier /
// FacilityVariant discriminators baked into the registry closures.

import type { ComponentType } from 'react';
import type { SchematicProps } from './types';

import { LaserShoradSchematic } from './LaserShoradSchematic';
import { ArtillerySchematic } from './ArtillerySchematic';
import { QuadrupedSchematic } from './QuadrupedSchematic';
import { M1A2Schematic } from './M1A2Schematic';
import { SensorRadarSchematic } from './SensorRadarSchematic';
import { MilitaryFacilitySchematic } from './MilitaryFacilitySchematic';
import { CivilianFacilitySchematic } from './CivilianFacilitySchematic';
import { UnknownPlatformBadge } from './UnknownPlatformBadge';

// Re-export everything for direct consumers (maintainer view, tests).
export { LaserShoradSchematic } from './LaserShoradSchematic';
export { ArtillerySchematic } from './ArtillerySchematic';
export { QuadrupedSchematic } from './QuadrupedSchematic';
export { M1A2Schematic } from './M1A2Schematic';
export { SensorRadarSchematic } from './SensorRadarSchematic';
export { MilitaryFacilitySchematic } from './MilitaryFacilitySchematic';
export { CivilianFacilitySchematic } from './CivilianFacilitySchematic';
export { UnknownPlatformBadge } from './UnknownPlatformBadge';

// Legacy-name re-exports for maintainer-view imports that haven't been
// migrated yet. Each schematic file also defines these locally for direct
// import; re-exporting from the barrel keeps both import styles working.
export { LaserShorad } from './LaserShoradSchematic';
export { Artillery } from './ArtillerySchematic';
export { Quadruped } from './QuadrupedSchematic';
export { VehicleClassSchematic } from './M1A2Schematic';

export type { SchematicProps, SensorTier, FacilityVariant } from './types';

// ---------------------------------------------------------------------------
// SCHEMATIC_REGISTRY — platform_variant -> renderable
// ---------------------------------------------------------------------------
// Each entry produces a component that accepts only `SchematicProps`
// (`{ degraded: boolean }`); per-tier and per-variant specialization is
// baked in here via closure so cascade consumers stay platform-agnostic.
//
// Keys are the CANONICAL platform_variant strings — they match the proto's
// future SubsystemState namespace AND the customer ORBAT enum AND the
// customer-overlay bundle's platform_variant_aliases.yaml `canonical:` values.
// Keep this set in lockstep with that yaml. If a sim entity emits a
// platform_variant not in this map, AssetVisual renders UnknownPlatformBadge.

export const SCHEMATIC_REGISTRY: Record<string, ComponentType<SchematicProps>> = {
    // ---- ORBAT: Sensors (4 range tiers, one schematic with tier prop) ----
    'CUAS_Sensor':
        (p) => <SensorRadarSchematic {...p} tier="CUAS" />,
    'VSHORAD_Sensor':
        (p) => <SensorRadarSchematic {...p} tier="VSHORAD" />,
    'SHORAD_Sensor':
        (p) => <SensorRadarSchematic {...p} tier="SHORAD" />,
    'MRAD_Sensor':
        (p) => <SensorRadarSchematic {...p} tier="MRAD" />,

    // ---- ORBAT: Interceptors (4 range tiers) + generic launcher ----
    // All 5 share ArtillerySchematic for now. Future per-tier launcher
    // visuals are an additive change here.
    'CUAS_Interceptor':    ArtillerySchematic,
    'VSHORAD_Interceptor': ArtillerySchematic,
    'SHORAD_Interceptor':  ArtillerySchematic,
    'MRAD_Interceptor':    ArtillerySchematic,
    'MISSILE_LAUNCHER':    ArtillerySchematic,

    // ---- ORBAT: Facilities ----
    'AIR_DEFENSE_SITE':    MilitaryFacilitySchematic,
    'HEADQUARTER_COMPLEX':
        (p) => <MilitaryFacilitySchematic {...p} variant="HQ" />,
    'INSTALLATION_FACILITY_CIVILIAN': CivilianFacilitySchematic,

    // ---- Legacy DIS / sim-a fleet ----
    // The current customer-overlay demo has 2 M1A2 tanks (4773, 4774) and 1 AH-64E
    // (DAGGER-08, not yet in the live data). AH-64E shares the Quadruped
    // schematic as a placeholder until a real helicopter schematic exists
    // — known visual mismatch, tracked in Phase 5 follow-up.
    'M1A2-SEPv3': M1A2Schematic,
    'M1A2-SEPv2': M1A2Schematic,
    'AH-64E':     QuadrupedSchematic,
};

/** Convenience lookup. Returns the registry entry if present, otherwise the
 *  UnknownPlatformBadge. Cascade consumers can call this instead of
 *  checking the registry themselves. */
export function resolveSchematic(platformVariant: string | null | undefined): ComponentType<SchematicProps> {
    if (!platformVariant) return UnknownPlatformBadge;
    return SCHEMATIC_REGISTRY[platformVariant] ?? UnknownPlatformBadge;
}
