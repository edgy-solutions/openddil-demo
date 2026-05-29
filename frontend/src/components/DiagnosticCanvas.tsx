// =============================================================================
// DiagnosticCanvas — 3D asset diagnostic schematic (maintainer-tier view)
// =============================================================================
// Routes by platform_variant to the matching 3D schematic, using the same
// SCHEMATIC_REGISTRY as Regional/HQ. Single source of truth for which
// silhouette a platform gets — new ORBAT entries (radar tiers, interceptor
// tiers, launchers, facilities) just register there and this view picks
// them up automatically.
//
// Visual chrome (cyan bezel, scanning-line drift, glitch-text headers)
// comes from HudFrame so every maintainer-tier 3D surface reads as the
// same family.
//
// Earlier this component dispatched on a coarse `assetType` ('RADAR' |
// 'GROUND' | 'AIR' | 'UGV' | 'UNKNOWN' from platformClass()) and had a
// hardcoded KNOWN_SCHEMATICS list using stale legacy class names
// (LASER_SHORAD / ARTILLERY / QUADRUPED). Those legacy strings never
// matched what platformClass() actually returns, so EVERY non-RADAR asset
// fell through to VehicleClassSchematic (the M1A2 tank). The customer's
// SHORAD/MRAD sensors + interceptors + launchers all rendered as tanks.
// Now we dispatch by platform_variant via the registry — variants and
// schematics stay in lockstep across all three views.
//
// The RADAR override path (?force=radar URL param in dev) routes to
// SensorArrayView for LTAMDS-style detailed view; that's a richer view
// than the cascade's SensorRadarSchematic and stays as a maintainer-only
// special case.
//
// ADR-0017: schematics carry DEMO_MOCK markers in their own modules
// (pure-3D primitives can't host a DOM banner). HudFrame provides the
// view-level banner.
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import SensorArrayView, { LTAMDS_CONFIG } from './SensorArrayView';
import HudFrame from './HudFrame';
import { useTransitPhase, transitClass } from './EdgeTransit';
import {
    SCHEMATIC_REGISTRY,
    UnknownPlatformBadge,
    type SchematicProps,
} from './platform-schematics';

const DEMO_MOCK = true;

// Header strings derive from the platform_variant when known. Underscores
// become spaces for readability ("SHORAD Sensor DIAGNOSTICS" vs
// "SHORAD_Sensor DIAGNOSTICS"). Falls back to generic when no variant.
function titleForVariant(platformVariant: string | null | undefined): { title: string, subtitle: string } {
    if (!platformVariant) {
        return { title: 'DIAGNOSTICS', subtitle: 'no platform variant selected' };
    }
    const pretty = platformVariant.replace(/_/g, ' ');
    return {
        title: `${pretty} DIAGNOSTICS`,
        subtitle: 'ENGINEERING SCHEMATIC // SYNTHETIC',
    };
}

interface DiagnosticCanvasProps {
    /** Canonical platform_variant from the fleet asset. Drives the schematic
     *  dispatch via SCHEMATIC_REGISTRY. Null/undefined => no asset selected
     *  yet, render an empty placeholder. */
    platformVariant: string | null | undefined;
    /** Legacy/dev-override class. When 'RADAR' (set via ?force=radar URL
     *  param in dev, or by a future RADAR-class asset routing), routes to
     *  the LTAMDS SensorArrayView instead of the registry. */
    assetType?: string;
    degraded: boolean;
    coreTemp: number;
    /** Phase 6c.3 — when this key changes (the selectedEdge from
     *  MaintainerApp), the schematic Canvas runs a transit animation.
     *  First-mount and same-key re-renders do NOT trigger. */
    transitTriggerKey?: string | null;
    /** Phase 5 (ADR-0026): per-axis operational posture for the selected
     *  asset. Threaded into the schematic so close-up visualization can
     *  react to POWER_STATE_OFF / MAINTENANCE / HEALTH_STATE_FAULT etc.
     *  beyond the rolled-up `degraded` boolean. */
    operationalState?: SchematicProps['operationalState'];
}

export default function DiagnosticCanvas({
    platformVariant,
    assetType,
    degraded,
    coreTemp,
    transitTriggerKey,
    operationalState,
}: DiagnosticCanvasProps) {
    // Hook runs on every render; gating is internal (first-mount + same-
    // key checks). Safe to call before the RADAR-branch early-return.
    const transitPhase = useTransitPhase(transitTriggerKey ?? null);

    if (assetType === 'RADAR') {
        // LTAMDS detailed-array view. Special-case maintainer rendering
        // for sensor arrays — richer than the cascade's per-tier
        // SensorRadarSchematic. Retained as a maintainer-only debug aid;
        // ORBAT-named radar tiers (CUAS/VSHORAD/SHORAD/MRAD_Sensor) go
        // through the registry path below.
        return <SensorArrayView degraded={degraded} coreTemp={coreTemp} config={LTAMDS_CONFIG} />;
    }

    const { title, subtitle } = titleForVariant(platformVariant);
    const SchematicComp = platformVariant
        ? SCHEMATIC_REGISTRY[platformVariant]
        : undefined;

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

                {SchematicComp
                    ? <SchematicComp degraded={degraded} operationalState={operationalState} />
                    : <UnknownPlatformBadge degraded={degraded} variant={platformVariant ?? 'UNKNOWN'} />}
            </Canvas>
        </HudFrame>
    );
}
