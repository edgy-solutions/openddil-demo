// =============================================================================
// LostContactBanner — Maintainer-view banner for selected non-live assets
// =============================================================================
// Renders ONLY when the currently-selected asset is in a non-live tier
// (STALE / COMM_LOST / LOST). Returns null otherwise so the layout
// snaps tight for live assets.
//
// Purpose: forensics path discoverability. The asset stays in the
// pulldown (tier-suffixed) so the operator can navigate to a lost
// asset — once selected, this banner makes it obvious WHY the
// CmStateCard / TelemetryCharts / LogisticsStatusCard show stale-
// looking data: the asset hasn't been heard from. Last-contact
// timestamp is the load-bearing data point.

import { AlertTriangle, Clock, RadioTower } from 'lucide-react';
import { tierLabel, type AssetTier } from '../lib/assetTier';

interface LostContactBannerProps {
  tier: AssetTier | undefined;
  lastSampleAt: string | null | undefined;
}

// Per-tier visual treatment. Border + icon color match the 3D scene's
// ring-outline color for that tier so the operator's eye carries the
// same scheme across the Maintainer view and the Regional 3D scene.
const TIER_STYLE: Record<'STALE' | 'COMM_LOST' | 'LOST',
                        { border: string; bar: string; icon: string;
                          headerColor: string; Icon: typeof AlertTriangle }> = {
  STALE:     { border: 'border-slate-500',  bar: 'bg-slate-500/15',
               icon: 'text-slate-300',   headerColor: 'text-slate-300',
               Icon: Clock },
  COMM_LOST: { border: 'border-amber-500',  bar: 'bg-amber-500/10',
               icon: 'text-amber-400',   headerColor: 'text-amber-300',
               Icon: RadioTower },
  LOST:      { border: 'border-rose-500',   bar: 'bg-rose-500/10',
               icon: 'text-rose-400',    headerColor: 'text-rose-300',
               Icon: AlertTriangle },
};

const NARRATIVE: Record<'STALE' | 'COMM_LOST' | 'LOST', string> = {
  STALE:
    'Telemetry feed silent past the stale threshold. Link to the edge is ' +
    'up, so the asset itself is what stopped reporting. Could be local ' +
    'power, sensor fault, or simply between sim cycles.',
  COMM_LOST:
    'Telemetry feed silent AND the edge link is severed. Comms loss is ' +
    'the explanation -- the asset may still be up locally and rejoin ' +
    'when the link restores.',
  LOST:
    'Telemetry feed silent past the lost threshold. Last-known state ' +
    'shown below is preserved for forensics; the asset is hidden from ' +
    'the 3D scene. If the asset reappears it returns to the live fleet ' +
    'after the configured recovery samples.',
};

function relativeAgo(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const sec = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min - hr * 60}m ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ${hr - day * 24}h ago`;
}

export default function LostContactBanner({
  tier,
  lastSampleAt,
}: LostContactBannerProps) {
  if (tier !== 'STALE' && tier !== 'COMM_LOST' && tier !== 'LOST') {
    return null;
  }
  const style = TIER_STYLE[tier];
  const { Icon } = style;
  const ago = relativeAgo(lastSampleAt, Date.now());
  const absolute = lastSampleAt
    ? new Date(lastSampleAt).toLocaleString('en-US', { hour12: false })
    : 'never';

  return (
    <div
      className={`panel border-l-4 ${style.border} ${style.bar} p-3 shrink-0 flex items-start gap-3`}
      role="status"
    >
      <Icon className={`w-5 h-5 ${style.icon} mt-0.5 shrink-0`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-3">
          <span className={`text-sm font-bold tracking-wider ${style.headerColor}`}>
            {tierLabel(tier).toUpperCase()}
          </span>
          <span className="text-[11px] text-slate-400 font-mono">
            last contact {absolute}
          </span>
          <span className="text-[11px] text-slate-500 font-mono">({ago})</span>
        </div>
        <p className="text-[11px] text-slate-400 mt-1 leading-snug">
          {NARRATIVE[tier]}
        </p>
      </div>
    </div>
  );
}
