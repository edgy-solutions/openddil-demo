// =============================================================================
// linkShaping — pure helpers behind the link-shaping panel
// =============================================================================
// Scales, formatting, severity thresholds, the preset table and the
// draft<->LinkToxics conversions. No React, no DOM: everything here is unit
// tested directly (network/__tests__/linkShaping.test.ts).
//
// None of this reads reachability. A shaped link is still up; the observed
// state words and the pill dot come from observed rows only (see
// lib/linkIndicator.ts and lib/linkStatus.ts), never from these values.
import type { LinkToxics } from '../../lib/linkControl';

// The PEP's bounds; a value outside them is refused there, so refuse it here
// too (same limits LinkToxicsControl enforces). 0 means "no such toxic",
// i.e. unlimited bandwidth / no latency / no jitter.
export const LATENCY_MAX_MS = 60000;
export const JITTER_MAX_MS = 60000;
export const BANDWIDTH_MAX_KB_S = 1000000;

// Slider scales. Latency/jitter run 0..60 s on a log axis; bandwidth runs
// 5 KB/s .. 125000 KB/s on a log axis whose far right (position 1000) is 0,
// i.e. UNLIMITED. Positions are integers 0..1000.
export const LMAX = 60000;
export const BMIN = 5;
export const BMAX = 125000;

export const msToP = (ms: number): number =>
  ms <= 0 ? 0 : Math.round((Math.log10(ms) / Math.log10(LMAX)) * 1000);
export const pToMs = (p: number): number =>
  p <= 0 ? 0 : Math.round(Math.pow(10, (p / 1000) * Math.log10(LMAX)));
export const bwToP = (b: number): number =>
  b <= 0
    ? 1000
    : Math.round(((Math.log10(b) - Math.log10(BMIN)) / (Math.log10(BMAX) - Math.log10(BMIN))) * 999);
export const pToBw = (p: number): number =>
  p >= 1000
    ? 0
    : Math.round(Math.pow(10, Math.log10(BMIN) + (p / 999) * (Math.log10(BMAX) - Math.log10(BMIN))));

// ---- formatting -------------------------------------------------------------
export const fms = (ms: number): string =>
  ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
export const fbw = (b: number): string =>
  b === 0 ? 'UNLIMITED' : b < 1000 ? `${b} KB/s` : `${(b / 1000).toFixed(b < 10000 ? 1 : 0)} MB/s`;
export const fjit = (j: number): string => (j ? `± ${fms(j)}` : 'none');

/** Small tags for a row: only the toxics that are set. */
export function toxicTags(t: LinkToxics | null): string[] {
  if (!t) return [];
  const out: string[] = [];
  if (t.latency_ms) {
    out.push(fms(t.latency_ms).replace(' ', '') + (t.jitter_ms ? ` ±${fms(t.jitter_ms).replace(' ', '')}` : ''));
  } else if (t.jitter_ms) {
    out.push(`±${fms(t.jitter_ms).replace(' ', '')}`);
  }
  if (t.bandwidth_kb_s) out.push(fbw(t.bandwidth_kb_s));
  return out;
}

// ---- severity ---------------------------------------------------------------
export type Severity = 'ok' | 'warn' | 'bad';
export const sLat = (ms: number): Severity => (ms < 150 ? 'ok' : ms < 800 ? 'warn' : 'bad');
export const sJit = (ms: number): Severity => (ms < 50 ? 'ok' : ms < 300 ? 'warn' : 'bad');
export const sBw = (b: number): Severity => (b === 0 || b >= 5000 ? 'ok' : b >= 200 ? 'warn' : 'bad');
export const SEVERITY_COLOR: Record<Severity, string> = {
  ok: '#34d399',
  warn: '#f59e0b',
  bad: '#f43f5e',
};

// ---- presets ----------------------------------------------------------------
export interface ShapeValues { up: boolean; lat: number; jit: number; bw: number }

export interface Preset {
  name: 'NOMINAL' | 'CONTESTED' | 'DEGRADED' | 'SEVERED';
  /** Signal glyph: lit bars out of 4. */
  bars: 0 | 1 | 2 | 3 | 4;
  color: string;
  severed?: boolean;
  values: ShapeValues;
}

export const PRESETS: readonly Preset[] = [
  { name: 'NOMINAL', bars: 4, color: '#34d399', values: { up: true, lat: 0, jit: 0, bw: 0 } },
  { name: 'CONTESTED', bars: 3, color: '#f59e0b', values: { up: true, lat: 300, jit: 80, bw: 256 } },
  { name: 'DEGRADED', bars: 1, color: '#f59e0b', values: { up: true, lat: 1200, jit: 400, bw: 32 } },
  // SEVERED is the link toggle off (and no shaping), not a toxic.
  { name: 'SEVERED', bars: 0, color: '#f43f5e', severed: true, values: { up: false, lat: 0, jit: 0, bw: 0 } },
];

/** Index of the preset the values match, or -1 (CUSTOM). */
export function presetOf(v: ShapeValues): number {
  return PRESETS.findIndex((p) =>
    p.severed
      ? !v.up
      : v.up && v.lat === p.values.lat && v.jit === p.values.jit && v.bw === p.values.bw,
  );
}

/** The rows of a preset tile: [label, value]. */
export function presetRows(p: Preset): Array<[string, string]> {
  if (p.severed) return [['LAT', '—'], ['JIT', '—'], ['BW', '0']];
  const v = p.values;
  return [
    ['LAT', fms(v.lat)],
    ['JIT', v.jit ? `±${fms(v.jit)}` : '—'],
    ['BW', v.bw ? fbw(v.bw) : '∞'],
  ];
}

// ---- toxics <-> draft ---------------------------------------------------------
export const ZERO_TOXICS: LinkToxics = { latency_ms: 0, jitter_ms: 0, bandwidth_kb_s: 0 };

/** True when any toxic is set. */
export function isShaped(t: LinkToxics | null): boolean {
  return !!t && (t.latency_ms > 0 || t.jitter_ms > 0 || t.bandwidth_kb_s > 0);
}

export function toxicsToValues(t: LinkToxics | null, up: boolean): ShapeValues {
  return { up, lat: t?.latency_ms ?? 0, jit: t?.jitter_ms ?? 0, bw: t?.bandwidth_kb_s ?? 0 };
}

/** The complete LinkToxics state for a draft, or null when a value is outside
 *  the PEP's bounds (APPLY refuses rather than sending it). */
export function valuesToToxics(v: ShapeValues): LinkToxics | null {
  const ok = (n: number, max: number) => Number.isInteger(n) && n >= 0 && n <= max;
  if (!ok(v.lat, LATENCY_MAX_MS) || !ok(v.jit, JITTER_MAX_MS) || !ok(v.bw, BANDWIDTH_MAX_KB_S)) return null;
  return { latency_ms: v.lat, jitter_ms: v.jit, bandwidth_kb_s: v.bw };
}

/** Backlog count as the headers have always shown it: a dash while the probe
 *  is down, x.xK above 1000. */
export function formatLag(probeDown: boolean, lag: number): string {
  return probeDown ? '—' : lag > 1000 ? `${(lag / 1000).toFixed(1)}K` : String(lag);
}
