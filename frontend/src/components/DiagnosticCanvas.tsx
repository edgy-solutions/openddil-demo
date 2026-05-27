// =============================================================================
// DiagnosticCanvas — 3D asset diagnostic schematics (maintainer-tier view)
// =============================================================================
// Routes by assetType to the matching 3D schematic. Visual chrome (cyan
// bezel, scanning-line drift, glitch-text headers) comes from HudFrame so
// every maintainer-tier 3D surface reads as the same family.
//
// DEMO_MOCK: synthetic 3D schematics. None are wired to per-platform
// telemetry yet — the RADAR branch delegates to SensorArrayView (which
// carries its own banner via the LTAMDS config); the other branches
// render synthetic schematics with no data input. Full rewiring to the
// pipeline's per-platform telemetry is future work once schemas for
// those platforms are flowing. See ADR-0017.
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import SensorArrayView, { LTAMDS_CONFIG } from './SensorArrayView';
import HudFrame from './HudFrame';
import { useTransitPhase, transitClass } from './EdgeTransit';
// Schematics extracted to platform-schematics/. Imported by legacy names
// here; the new module exports them under both legacy and canonical names.
// AssetVisual (regional/HQ 3D maps) consumes the same module via its
// SCHEMATIC_REGISTRY dispatcher.
import {
    LaserShorad,
    Artillery,
    Quadruped,
    VehicleClassSchematic,
} from './platform-schematics';

const DEMO_MOCK = true;


const KNOWN_SCHEMATICS = ['LASER_SHORAD', 'ARTILLERY', 'QUADRUPED'];

// Headers track the maintainer-tier framing: "Ground Diagnostics" for the
// ground-vehicle class (the VehicleClassSchematic fallback), and the
// existing `{assetType} DIAGNOSTICS` pattern for the dedicated schematics.
// LTAMDS keeps its own title from LTAMDS_CONFIG (renders via SensorArrayView).
function headerForAsset(assetType: string, hasDedicatedSchematic: boolean): { title: string, subtitle: string } {
    if (hasDedicatedSchematic) {
        return {
            title: `${assetType} DIAGNOSTICS`,
            subtitle: 'ENGINEERING SCHEMATIC // SYNTHETIC',
        };
    }
    return {
        title: 'GROUND DIAGNOSTICS',
        subtitle: `${assetType} // SYNTHETIC PLACEHOLDER`,
    };
}

export default function DiagnosticCanvas({
    assetType,
    degraded,
    coreTemp,
    transitTriggerKey,
}: {
    assetType: string,
    degraded: boolean,
    coreTemp: number,
    // Phase 6c.3 — when this key changes (the selectedEdge from
    // MaintainerApp), the schematic Canvas runs a transit animation.
    // First-mount and same-key re-renders do NOT trigger. Asset
    // changes within an edge don't trigger because the parent passes
    // the edge id, not the asset id.
    transitTriggerKey?: string | null,
}) {
    // Hook runs on every render; gating is internal (first-mount + same-
    // key checks). Safe to call before the RADAR-branch early-return.
    const transitPhase = useTransitPhase(transitTriggerKey ?? null);

    if (assetType === 'RADAR') {
        // Sensor-array class. LTAMDS is the only config shipped today; the
        // claim that this could carry other arrays becomes provable when a
        // second config arrives.
        // §C.3 TODO: SensorArrayView bypasses HudFrame so cycle-1
        // animation does NOT apply to RADAR-class schematics. Acceptable
        // for now — the demo's M1A2-SEPv3 fleet renders via the
        // VehicleClassSchematic path below (HudFrame-wrapped). If a
        // RADAR-class asset becomes demo-relevant later, lift the
        // contentClassName seam into SensorArrayView too.
        return <SensorArrayView degraded={degraded} coreTemp={coreTemp} config={LTAMDS_CONFIG} />;
    }
    const hasDedicatedSchematic = KNOWN_SCHEMATICS.includes(assetType);
    const { title, subtitle } = headerForAsset(assetType, hasDedicatedSchematic);

    return (
        <HudFrame
            title={title}
            subtitle={subtitle}
            bannerNote={DEMO_MOCK ? 'synthetic 3D schematic' : undefined}
            contentClassName={transitClass(transitPhase)}
        >
            <Canvas camera={{ position: [10, 10, 10], fov: 50 }}>
                <color attach="background" args={[0x020617]} />
                <fogExp2 attach="fog" args={[0x020617, 0.05]} />
                <ambientLight intensity={0.4} />
                <spotLight position={[20, 40, 20]} intensity={1.5} color={0x22d3ee} />

                <OrbitControls enableDamping dampingFactor={0.05} />

                {assetType === 'LASER_SHORAD' && <LaserShorad degraded={degraded} />}
                {assetType === 'ARTILLERY' && <Artillery degraded={degraded} />}
                {assetType === 'QUADRUPED' && <Quadruped degraded={degraded} />}
                {!hasDedicatedSchematic && <VehicleClassSchematic degraded={degraded} />}
            </Canvas>
        </HudFrame>
    );
}
