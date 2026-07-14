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
import SensorArrayView, { LTAMDS_CONFIG, MRAD_CONFIG, type LiveElementTelemetry } from './SensorArrayView';
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

// platform_variant patterns that route to SensorArrayView with
// MRAD_CONFIG -- the detailed-array maintainer view. AFTER the
// 2026-06-24 per-site sensor identity fix in proprietary-mapping.yaml,
// each radar SITE now produces TWO OpenDDIL assets:
//
//   1. The Unit-sourced chassis (asset_id `prop:..._radar`,
//      platform_type=MRAD_Radar aliased → platform_variant=MRAD_Sensor).
//      This is the physical platform -- not the sensor subsystem
//      inside it. Should render as a regular radar visual
//      (SensorRadarSchematic via SCHEMATIC_REGISTRY).
//
//   2. The Sensor-sourced subsystem (asset_id `prop:..._radar_MRAD_Sensor`,
//      platform_type=MRAD_Sensor → platform_variant=MRAD_Sensor).
//      THIS is the per-site sensor whose operational_state the customer
//      publishes. Should render as the multi-array MRAD detailed view.
//
// Both end up with platform_variant=MRAD_Sensor after the alias map.
// Differentiating them requires looking at the asset_id pattern --
// per the customer's naming convention (parentUnitId + "_" + sensorId),
// the per-site sensor asset_id always ENDS in `_Sensor` (one of
// MRAD_Sensor, SHORAD_Sensor, VSHORAD_Sensor, CUAS_Sensor).
//
// Without this filter, the chassis asset for every radar (and the
// launcher asset, which carries variant=MRAD_Interceptor and was
// previously in this set) renders the multi-array view with
// UNSPECIFIED operational_state -- which the user reads as "the
// launcher is wrong" because the array tiles light up in colors
// driven by sim defaults rather than the customer's actual state.
//
// MRAD_Interceptor + MRAD_Radar are NO LONGER in this set -- they
// fall through to SCHEMATIC_REGISTRY, where MRAD_Interceptor renders
// as ArtillerySchematic (launcher visual) and MRAD_Sensor on a non-
// `_Sensor` asset_id renders as SensorRadarSchematic (radar visual).
const MRAD_VARIANTS: ReadonlySet<string> = new Set([
    'MRAD_Sensor',
    'MRAD2_radar',     // matches the asset-id token used by customer-overlay's NLD
                       // proprietary feed (demo:*_MRAD2_radar)
]);

/** True when the asset_id is a per-site SENSOR asset (sensor-subsystem-
 *  sourced, has operational_state from the customer wire). False for
 *  Unit-sourced chassis / launcher assets. Identifies the customer's
 *  parentUnitId_sensorId naming convention. */
function isPerSiteSensorAsset(assetId: string | null | undefined): boolean {
    if (!assetId) return false;
    return assetId.endsWith('_Sensor');
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
    /** Currently-selected asset id. Threaded into SensorArrayView so the
     *  seeded-RNG (and, once wired, the live mrad-sim telemetry hook)
     *  produces per-asset-stable, per-asset-independent element values. */
    assetId?: string | null;
    degraded: boolean;
    coreTemp: number;
    /** Asset uptime in hours. Threaded from MaintainerApp which
     *  resolves sustainment.uptime_hours > logistics-sim asset rollup
     *  (operational.uptime_hours) > null. SensorArrayView falls back
     *  to a hardcoded literal when null. */
    uptimeHours?: number | null;
    /** Per-asset element telemetry from openddil-logistics-sim, lifted
     *  to MaintainerApp so the asset rollups (core_temp_c, uptime_hours
     *  in operational) flow to header readouts without a second hook
     *  subscription. Same shape useAssetElementTelemetry returns. */
    liveTelemetry?: LiveElementTelemetry;
    /** Phase 6c.3 — when this key changes (the selectedEdge from
     *  MaintainerApp), the schematic Canvas runs a transit animation.
     *  First-mount and same-key re-renders do NOT trigger. */
    transitTriggerKey?: string | null;
    /** Phase 5 (ADR-0026): per-axis operational posture for the selected
     *  asset. Threaded into the schematic so close-up visualization can
     *  react to POWER_STATE_OFF / MAINTENANCE / HEALTH_STATE_FAULT etc.
     *  beyond the rolled-up `degraded` boolean. */
    operationalState?: SchematicProps['operationalState'];
    /** 2026-07-14: asset-level POWER_STATE_OFF signal. Threaded down to
     *  SensorArrayView so the per-element tiles render as OFF rather
     *  than as their synthesized (nominal green) health colors. Sim
     *  correctly synthesizes POWER_OFF as "no lifted-band tiles + all
     *  tx/rx off", but the element-health values alone can't tell
     *  the UI apart from "everything nominal, idle" -- the asset-
     *  level flag is the disambiguator. */
    isPoweredOff?: boolean;
}

export default function DiagnosticCanvas({
    platformVariant,
    assetType,
    assetId,
    degraded,
    coreTemp,
    uptimeHours,
    liveTelemetry,
    transitTriggerKey,
    operationalState,
    isPoweredOff = false,
}: DiagnosticCanvasProps) {
    // The transit hook gates internally on first-mount + same-key.
    // The MRAD telemetry hook USED to live here but was lifted to
    // MaintainerApp so the asset-level rollups (core_temp_c,
    // uptime_hours from the operational JSONB) can flow to header
    // readouts without a duplicate hook subscription. liveTelemetry
    // and uptimeHours are now props.
    const transitPhase = useTransitPhase(transitTriggerKey ?? null);

    // MRAD-class variants get the dedicated multi-array detailed view --
    // BUT only when the asset is the per-site SENSOR subsystem
    // (asset_id ending in `_Sensor`). The chassis Unit assets (`*_radar`,
    // `*_Launcher*`) also carry platform_variant=MRAD_Sensor/Interceptor
    // after the alias map, but they're the platform holding the sensor,
    // not the sensor itself -- they should render as a regular radar or
    // launcher visual via SCHEMATIC_REGISTRY below. See the MRAD_VARIANTS
    // comment block for the full rationale + the 2026-06-24 per-site
    // sensor identity fix that surfaced this distinction.
    if (platformVariant && MRAD_VARIANTS.has(platformVariant) && isPerSiteSensorAsset(assetId)) {
        return <SensorArrayView degraded={degraded} coreTemp={coreTemp} uptimeHours={uptimeHours ?? null} config={MRAD_CONFIG} assetId={assetId ?? platformVariant} liveTelemetry={liveTelemetry} isPoweredOff={isPoweredOff} />;
    }

    if (assetType === 'RADAR') {
        // LTAMDS detailed-array view. Special-case maintainer rendering
        // for sensor arrays — richer than the cascade's per-tier
        // SensorRadarSchematic. Retained as a maintainer-only debug aid;
        // ORBAT-named radar tiers (CUAS/VSHORAD/SHORAD/MRAD_Sensor) go
        // through the registry path below.
        return <SensorArrayView degraded={degraded} coreTemp={coreTemp} uptimeHours={uptimeHours ?? null} config={LTAMDS_CONFIG} assetId={assetId ?? 'ltamds-dev'} isPoweredOff={isPoweredOff} />;
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
            <Canvas
                camera={{ position: [10, 10, 10], fov: 50 }}
                // GPU memory budget knobs — same conservative config as
                // SensorArrayView. Integrated GPUs (work laptops) run out
                // of buffer slots fast when an operator picks through a
                // fleet of 60+ assets, each switch mounting/unmounting
                // this Canvas; the driver eventually kills a context.
                //   * dpr cap 1.5× saves ~2.25× GPU memory vs 2.0+ DPR
                //   * antialias off — MSAA buffers are the next biggest
                //     cost; dark theme hides aliasing
                //   * alpha/stencil off — saves swap-chain channels
                //   * powerPreference high-performance — wakes dGPU
                //   * frameloop demand — only renders when scene state
                //     changes (not 60fps), HUGE win for an idle picker
                dpr={[1, 1.5]}
                frameloop="demand"
                gl={{
                    antialias: false,
                    powerPreference: 'high-performance',
                    alpha: false,
                    stencil: false,
                    depth: true,
                }}
            >
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
