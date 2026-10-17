// useMunitionTrails -- client-side trail history for in-flight munitions.
//
// STOPGAP. The munition_track table is one row per munition and carries no
// history, so each view accumulates the last few projected positions itself.
// A browser that opens mid-flight starts with a one-point trail, and a reload
// loses it. The durable fix is server-side history (a short array column or a
// sample table); until then this is what feeds MunitionTrackHolo.
//
// Endings come from the ledger's terminal state: a Detonation PDU
// (entity_impact, ground_impact, detonated, other) bursts for BURST_MS; a
// 'silent' sweep or a dud fades grey for SILENCE_MS and never bursts. An id
// that vanishes from the feed with no terminal state (a reset delete, say)
// gets the silence ending at disappearance.
import { useEffect, useRef, useState } from 'react';
import { BURST_MS, SILENCE_MS, type TrackEnding, type Vec3 } from '../components/MunitionTrackHolo';
import type { MunitionTrack } from './useMunitionTracks';

/** Samples kept per munition, oldest first. */
export const TRAIL_LEN = 10;
/** A sample closer than this on every axis to the last kept one is a duplicate. */
const DUP_EPS = 1e-6;

export interface MunitionTrailEntry {
  id: string;
  trail: Vec3[];
  ending: TrackEnding;
  launcher?: Vec3;
}

type TrackInput = Pick<MunitionTrack, 'munitionAssetId'> & Partial<Pick<MunitionTrack, 'terminalState' | 'terminatedAt'>>;

type EndingKind = 'detonation' | 'silence';

/** munition_track.terminal_state (the six CHECK values) -> how the track ends. */
export const ENDING_KIND_BY_TERMINAL_STATE: Readonly<Record<string, EndingKind>> = {
  entity_impact: 'detonation',
  ground_impact: 'detonation',
  detonated: 'detonation',
  other: 'detonation',
  silent: 'silence',
  dud: 'silence',
};

function endingMs(kind: EndingKind): number {
  return kind === 'detonation' ? BURST_MS : SILENCE_MS;
}

function sameVec(a: Vec3 | undefined, b: Vec3 | undefined): boolean {
  if (!a || !b) return a === b;
  return a.every((v, i) => Math.abs(v - b[i]) <= DUP_EPS);
}

/**
 * Pure step: fold the current in-flight list into the previous trails.
 * Entries that did not change keep their object identity, and the previous
 * array is returned when nothing changed at all.
 */
export function nextTrails<T extends TrackInput>(
  prev: MunitionTrailEntry[],
  tracks: T[],
  project: (track: T) => Vec3 | null,
  nowMs: number,
  launcherOf?: (track: T) => Vec3 | undefined,
  nowWallMs: number = Date.now(),
  spent: Set<string> = new Set(),
): MunitionTrailEntry[] {
  const prevById = new Map(prev.map((e) => [e.id, e]));
  const live = new Set(tracks.map((x) => x.munitionAssetId));
  for (const id of spent) if (!live.has(id)) spent.delete(id);
  const seen = new Set<string>();
  const out: MunitionTrailEntry[] = [];

  for (const e of prev) {
    if (live.has(e.id)) continue; // handled below
    // Vanished: start the silence clock once, then drop at SILENCE_MS.
    if (!e.ending) out.push({ ...e, ending: { kind: 'silence', atMs: nowMs } });
    else if (nowMs - e.ending.atMs < endingMs(e.ending.kind)) out.push(e);
  }

  const present: MunitionTrailEntry[] = [];
  for (const t of tracks) {
    const id = t.munitionAssetId;
    if (seen.has(id)) continue;
    seen.add(id);
    let old = prevById.get(id);
    // An ending that ran out between steps is a new flight, not a resume.
    if (old?.ending && nowMs - old.ending.atMs >= endingMs(old.ending.kind)) old = undefined;
    const p = project(t);
    if (t.terminalState) {
      if (spent.has(id)) continue; // its ending ran out; the row may linger in the feed
      const kind = ENDING_KIND_BY_TERMINAL_STATE[t.terminalState] ?? 'silence';
      const prior = prevById.get(id);
      let atMs: number;
      if (prior?.ending) atMs = prior.ending.atMs; // clock already running
      else if (prior) atMs = nowMs; // seen in flight, now terminal: immune to clock skew
      else {
        const ageMs = Math.max(0, nowWallMs - Date.parse(t.terminatedAt ?? ''));
        atMs = nowMs - (Number.isFinite(ageMs) ? ageMs : 0);
      }
      const ending: TrackEnding = prior?.ending ?? { kind, atMs };
      if (nowMs - atMs >= endingMs(ending.kind)) { spent.add(id); continue; } // over: never (re)appears
      old = prior;
      const ok = !!p && p.every(Number.isFinite);
      if (!old && !ok) continue;
      const launcher = launcherOf?.(t);
      const last = old?.trail[old.trail.length - 1];
      const grew = ok && (!last || !sameVec(last, p!));
      if (old?.ending && !grew && sameVec(old.launcher, launcher)) {
        present.push(old);
      } else {
        const trail = !old ? [p!] : grew ? [...old.trail, p!].slice(-TRAIL_LEN) : old.trail;
        present.push({ id, trail, ending, ...(launcher ? { launcher } : {}) });
      }
      continue;
    }
    if (!p || !p.every(Number.isFinite)) {
      if (old) present.push(old.ending ? { ...old, ending: null } : old);
      continue;
    }
    const launcher = launcherOf?.(t);
    const last = old?.trail[old.trail.length - 1];
    const grew = !last || !sameVec(last, p);
    const trail = !old ? [p] : grew ? [...old.trail, p].slice(-TRAIL_LEN) : old.trail;
    if (old && !grew && !old.ending && sameVec(old.launcher, launcher)) {
      present.push(old);
    } else {
      present.push({ id, trail, ending: null, ...(launcher ? { launcher } : {}) });
    }
  }

  // Keep first-seen order: prev order for known ids, new ids after.
  const merged: MunitionTrailEntry[] = [];
  const byId = new Map([...out, ...present].map((e) => [e.id, e]));
  for (const e of prev) {
    const n = byId.get(e.id);
    if (n) { merged.push(n); byId.delete(e.id); }
  }
  merged.push(...byId.values());

  const unchanged = merged.length === prev.length && merged.every((e, i) => e === prev[i]);
  return unchanged ? prev : merged;
}

/**
 * Per-view hook around nextTrails. `project` must be memoised by the caller
 * (it is an effect dependency). `launcherOf` is optional, same rule.
 */
export function useMunitionTrails<T extends TrackInput>(
  tracks: T[],
  project: (track: T) => Vec3 | null,
  launcherOf?: (track: T) => Vec3 | undefined,
): MunitionTrailEntry[] {
  const [entries, setEntries] = useState<MunitionTrailEntry[]>([]);
  const latest = useRef({ tracks, project, launcherOf });
  const spent = useRef(new Set<string>());
  useEffect(() => {
    latest.current = { tracks, project, launcherOf };
    const step = () => {
      const l = latest.current;
      setEntries((prev) => nextTrails(prev, l.tracks, l.project, performance.now(), l.launcherOf, Date.now(), spent.current));
    };
    step();
  }, [tracks, project, launcherOf]);

  // Expire silence endings: a timer for the earliest one still running.
  useEffect(() => {
    const ends = entries.filter((e) => e.ending).map((e) => e.ending!.atMs + endingMs(e.ending!.kind));
    if (!ends.length) return undefined;
    const wait = Math.max(0, Math.min(...ends) - performance.now()) + 20;
    const id = setTimeout(() => {
      const l = latest.current;
      setEntries((prev) => nextTrails(prev, l.tracks, l.project, performance.now(), l.launcherOf, Date.now(), spent.current));
    }, wait);
    return () => clearTimeout(id);
  }, [entries]);

  return entries;
}
