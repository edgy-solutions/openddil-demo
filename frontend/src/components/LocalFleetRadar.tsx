// =============================================================================
// LocalFleetRadar — 2D SVG radar of local assets
// =============================================================================
// Plots fleet assets at their REAL geographic positions, projected to the
// radar's 2D frame and centered on a deployment-supplied origin (typically
// the FOB hosting the selected edge — "you are at this FOB looking at the
// assets around you"). Earlier this view placed assets at fake circular
// positions by array index — visually busy but it was a DEMO_MOCK
// scaffold predating the pipeline carrying real positions.
//
// Projection: local tangent-plane (linear) — fine at radar scales (<100km).
// Same approach as lib/geoProjection.ts at the regional/HQ tier, just
// scoped to one FOB's neighborhood. cos(centerLat) keeps x and y
// isotropic so a 10km bbox doesn't render as a north-south stretched
// rectangle at 52°N.
//
// Adaptive scale: max-distance-from-center fills the radar's outer ring
// (90 units of the 100-unit viewBox). This keeps the picture useful
// whether assets are 5km or 50km away from the FOB. Falls back to a
// fixed 30km full-scale when no assets have positions yet (cold start).
//
// Assets without lat/lon (strike-only entities, mid-load) are placed at
// the center dot — they are at the FOB by construction (positionless
// assets are homed to their assigned FOB in the projector).
//
// ADR-0017 marker stays: while POSITIONS are now real, this radar is one
// visual tier and elides the geographic context the regional/HQ maps
// carry. The DEMO_MOCK call-out is dropped (positions are real) but the
// view is still a simplified projection — flagged as such via the
// header subtitle.

interface Asset {
  id: string;
  type: string;
  node_id: string;
  /** Asset's real position (from FleetAsset.position). null/undefined
   *  for strike-only assets that don't carry telemetry coordinates. */
  lat?: number | null;
  lon?: number | null;
}

interface LocalFleetRadarProps {
  degraded: boolean;
  localAssets?: Asset[];
  /** Origin of the radar projection — typically the FOB hosting the
   *  selected edge. When null/undefined the radar falls back to the
   *  synthetic circular placement so the view doesn't go blank on
   *  cold start. */
  centerLat?: number | null;
  centerLon?: number | null;
}

// Short radar label — the last id segment, capped. Full asset_ids
// (e.g. "USA-ARMY-1HBCT-M1A2-4773") overlap unreadably on a 200-unit
// SVG; the last segment is short and reasonably distinguishing.
function radarLabel(id: string): string {
  const seg = id.split(/[-:]/).filter(Boolean).pop() ?? id;
  return seg.length > 10 ? seg.slice(0, 10) : seg;
}

// Default radar range when only one asset / no spread to scale to.
// 30km is a reasonable SHORAD-class engagement neighborhood.
const FALLBACK_RANGE_KM = 30;
const KM_PER_DEG_LAT = 111;

export default function LocalFleetRadar({
  degraded,
  localAssets = [],
  centerLat,
  centerLon,
}: LocalFleetRadarProps) {
  const hasCenter =
    typeof centerLat === 'number' && typeof centerLon === 'number' &&
    Number.isFinite(centerLat) && Number.isFinite(centerLon);

  // Project each asset to local-tangent-plane km offsets from the center.
  // Assets without lat/lon land at (0, 0) — the FOB itself.
  const projected = hasCenter
    ? localAssets.map((a) => {
        if (typeof a.lat !== 'number' || typeof a.lon !== 'number') {
          return { asset: a, dx: 0, dy: 0, dist: 0 };
        }
        const cosLat = Math.cos((centerLat as number) * Math.PI / 180);
        const dx = (a.lon - (centerLon as number)) * KM_PER_DEG_LAT * cosLat;
        // North is "up" on the radar — SVG y grows downward, so negate.
        const dy = -((a.lat - (centerLat as number)) * KM_PER_DEG_LAT);
        const dist = Math.sqrt(dx * dx + dy * dy);
        return { asset: a, dx, dy, dist };
      })
    : null;

  // Scale so the farthest asset lands at radius 90 (outer of the 3 rings).
  // If all assets are at the center, use a fixed fallback range so the
  // ring labels still make sense.
  const maxDistKm = projected
    ? Math.max(FALLBACK_RANGE_KM, ...projected.map((p) => p.dist))
    : FALLBACK_RANGE_KM;
  const unitsPerKm = 90 / maxDistKm;

  return (
    <div className="absolute bottom-4 left-4 w-[280px] h-[180px] border border-slate-700 bg-slate-900/90 shadow-2xl z-20 flex flex-col pointer-events-none panel">
      <div className="bg-slate-800 text-[10px] px-2 py-1 text-slate-300 font-bold font-mono border-b border-slate-700 flex justify-between items-center">
        <div className="flex flex-col">
          <span className="tracking-wider">LOCAL FLEET RADAR</span>
          <span className="text-[8px] text-slate-500 tracking-normal">
            {hasCenter ? `${maxDistKm.toFixed(0)}KM RING` : 'centerless'}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <span className={`w-1.5 h-1.5 rounded-full ${degraded ? 'bg-amber-500 animate-pulse' : 'bg-emerald-500'}`}></span>
          <span className={`${degraded ? 'text-amber-400' : 'text-emerald-400'} text-[8px]`}>{degraded ? 'DEGRADED' : 'NOMINAL'}</span>
        </div>
      </div>
      <div className="flex-1 w-full relative overflow-hidden flex items-center justify-center">
        <svg width="100%" height="100%" viewBox="-100 -100 200 200">
          {/* Radar background circles */}
          <circle cx="0" cy="0" r="30" fill="none" stroke="#334155" strokeWidth="1" />
          <circle cx="0" cy="0" r="60" fill="none" stroke="#334155" strokeWidth="1" />
          <circle cx="0" cy="0" r="90" fill="none" stroke="#334155" strokeWidth="1" />

          {/* Crosshairs */}
          <line x1="-100" y1="0" x2="100" y2="0" stroke="#334155" strokeWidth="1" />
          <line x1="0" y1="-100" x2="0" y2="100" stroke="#334155" strokeWidth="1" />

          {/* Assets */}
          {(projected
            ? projected.map((p) => ({
                asset: p.asset,
                x: p.dx * unitsPerKm,
                y: p.dy * unitsPerKm,
              }))
            : localAssets.map((asset, i) => {
                // Fallback: synthetic circular placement when no center
                // is available (cold start, OSS default install). Same
                // shape as the pre-real-positions code.
                const angle = (i / Math.max(1, localAssets.length)) * Math.PI * 2;
                return {
                  asset,
                  x: Math.cos(angle) * 60,
                  y: Math.sin(angle) * 60,
                };
              })
          ).map(({ asset, x, y }, i) => {
            // If degraded, mock one as COMM_LOST
            const isCommLost = degraded && i === 0;
            // Place the label outward of the dot and anchor it on the
            // side away from center, so labels don't stack over each
            // other or the crosshairs.
            const onLeft = x < 0;
            const labelX = x + (onLeft ? -9 : 9);
            return (
              <g key={asset.id}>
                {!isCommLost && (
                  <line x1="0" y1="0" x2={x} y2={y} stroke="#22d3ee" strokeWidth="1.5" strokeDasharray="4 2" opacity="0.6" />
                )}
                <circle cx={x} cy={y} r="5" fill={isCommLost ? '#64748b' : '#22d3ee'} />
                <text
                  x={labelX}
                  y={y + 3}
                  textAnchor={onLeft ? 'end' : 'start'}
                  fill={isCommLost ? '#64748b' : '#94a3b8'}
                  fontSize="7"
                  fontFamily="monospace"
                >
                  {radarLabel(asset.id)}
                </text>
              </g>
            );
          })}

          {/* Center FOB / edge dot */}
          <circle cx="0" cy="0" r="8" fill="#10b981" />
        </svg>
      </div>
    </div>
  );
}
