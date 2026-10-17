// useMunitionTrails -- client-side trail history for in-flight munitions.
//
// STOPGAP. The munition_track table is one row per munition and carries no
// history, so each view accumulates the last few projected positions itself.
// A browser that opens mid-flight starts with a one-point trail, and a reload
// loses it. The durable fix is server-side history (a short array column or a
// sample table); until then this is what feeds MunitionTrackHolo.
//
// There is no termination event on the wire: a munition that leaves the
// in-flight list is a lost track, never a hit. It is kept for SILENCE_MS with
// a 'silence' ending and then dropped. No detonation is ever synthesised.
import { useEffect, useRef, useState } from 'react';
import { SILENCE_MS, type TrackEnding, type Vec3 } from '../components/MunitionTrackHolo';
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

type TrackInput = Pick<MunitionTrack, 'munitionAssetId'>;

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
): MunitionTrailEntry[] {
  const prevById = new Map(prev.map((e) => [e.id, e]));
  const live = new Set(tracks.map((x) => x.munitionAssetId));
  const seen = new Set<string>();
  const out: MunitionTrailEntry[] = [];

  for (const e of prev) {
    if (live.has(e.id)) continue; // handled below
    // Vanished: start the silence clock once, then drop at SILENCE_MS.
    if (!e.ending) out.push({ ...e, ending: { kind: 'silence', atMs: nowMs } });
    else if (nowMs - e.ending.atMs < SILENCE_MS) out.push(e);
  }

  const present: MunitionTrailEntry[] = [];
  for (const t of tracks) {
    const id = t.munitionAssetId;
    if (seen.has(id)) continue;
    seen.add(id);
    let old = prevById.get(id);
    // An ending that ran out between steps is a new flight, not a resume.
    if (old?.ending && nowMs - old.ending.atMs >= SILENCE_MS) old = undefined;
    const p = project(t);
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
  useEffect(() => {
    latest.current = { tracks, project, launcherOf };
    const step = () => {
      const l = latest.current;
      setEntries((prev) => nextTrails(prev, l.tracks, l.project, performance.now(), l.launcherOf));
    };
    step();
  }, [tracks, project, launcherOf]);

  // Expire silence endings: a timer for the earliest one still running.
  useEffect(() => {
    const ending = entries.filter((e) => e.ending).map((e) => e.ending!.atMs);
    if (!ending.length) return undefined;
    const wait = Math.max(0, Math.min(...ending) + SILENCE_MS - performance.now()) + 20;
    const id = setTimeout(() => {
      const l = latest.current;
      setEntries((prev) => nextTrails(prev, l.tracks, l.project, performance.now(), l.launcherOf));
    }, wait);
    return () => clearTimeout(id);
  }, [entries]);

  return entries;
}
