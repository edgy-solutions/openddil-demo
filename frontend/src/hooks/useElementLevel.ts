// useElementLevel -- one open level of the maintainer drilldown.
//
// Table asset_element_state holds one row per (asset_id, element_path). A
// level is one Electric shape: the nodes under one prefix, to a bounded depth.
// The gateway accepts exactly two `where` forms and refuses anything else:
//   asset_id = '<A>' AND depth <= <N>                                  (root, N <= 1)
//   asset_id = '<A>' AND element_path LIKE '<P>/%' AND depth <= <N>    (N <= depth(P) + 2)
// where depth(P) is the number of '/' in P. This module builds only those
// forms and refuses to build anything the gateway would refuse.
//
// Electric keeps a shape stream alive after unmount unless its signal is
// aborted, so each level owns an AbortController and, on release, also sends
// DELETE for the same definition so the server can drop it.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useShape } from '@electric-sql/react';
import { COMPACTION_PARAMS, ELECTRIC_URL, num, sqlLiteral } from './electric';

export const ELEMENT_TABLE = 'asset_element_state';

export const ELEMENT_COLUMNS = [
  'asset_id', 'element_path', 'parent_path', 'depth', 'layer_name', 'health', 'health_band',
  'temp_c', 'load_pct', 'tx_active', 'rx_active', 'moved_by', 'value_changes',
  'subtree_changes', 'subtree_changes_window', 'observed_at',
] as const;

const ASSET_RE = /^[A-Za-z0-9:._-]+$/;
const PATH_RE = /^[A-Za-z0-9-]+(\/[A-Za-z0-9-]+)*$/;

export type ElementLevelParams = {
  table: string;
  experimental_compaction: string;
  where: string;
  columns: string;
};

export interface ElementLevelRequest {
  /** Stable identity of the definition: asset plus prefix ('' for the root). */
  key: string;
  params: ElementLevelParams;
}

export interface ElementRow {
  element_path: string;
  depth: number;
  health: number | null;
  health_band: string | null;
  temp_c: number | null;
  load_pct: number | null;
  tx_active: boolean | null;
  rx_active: boolean | null;
  moved_by: string | null;
  subtree_changes_window: number;
}

const warned = new Set<string>();
function warnOnce(msg: string) {
  if (warned.has(msg)) return;
  warned.add(msg);
  console.warn(msg);
}

/** The shape definition for one level, or null when the asset or prefix is outside the
 *  gateway grammar (the client then sends nothing). `prefix` null = the root level.
 *  `leafDepth` is the deepest depth the tree has. */
export function elementLevelRequest(
  assetId: string | null | undefined,
  prefix: string | null,
  leafDepth: number,
): ElementLevelRequest | null {
  if (!assetId) return null;
  if (!ASSET_RE.test(assetId)) {
    warnOnce('[element-level] asset id outside the element grammar; not subscribing');
    return null;
  }
  let where: string;
  if (prefix == null) {
    where = `asset_id = ${sqlLiteral(assetId)} AND depth <= ${Math.min(1, leafDepth)}`;
  } else {
    if (!PATH_RE.test(prefix)) {
      warnOnce('[element-level] element path outside the element grammar; not subscribing');
      return null;
    }
    const d = prefix.split('/').length - 1;
    const n = Math.min(d + 2, leafDepth);
    where =
      `asset_id = ${sqlLiteral(assetId)} AND element_path LIKE ${sqlLiteral(prefix + '/%')}` +
      ` AND depth <= ${n}`;
  }
  return {
    key: `${assetId}|${prefix ?? ''}`,
    params: {
      table: ELEMENT_TABLE,
      ...COMPACTION_PARAMS,
      where,
      columns: ELEMENT_COLUMNS.join(','),
    },
  };
}

function deleteUrl(params: ElementLevelParams): string {
  const u = new URL(ELECTRIC_URL);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v as string);
  return u.toString();
}

function sendDelete(params: ElementLevelParams, keepalive: boolean) {
  try {
    const p = fetch(deleteUrl(params), {
      method: 'DELETE',
      credentials: 'include',
      ...(keepalive ? { keepalive: true } : {}),
    });
    Promise.resolve(p).catch(() => warnOnce('[element-level] shape DELETE failed; the gateway drops idle holders'));
  } catch {
    warnOnce('[element-level] shape DELETE failed; the gateway drops idle holders');
  }
}

function mapRow(r: Record<string, any>): ElementRow {
  const n = (v: unknown) => (v == null || v === '' ? null : num(v));
  return {
    element_path: String(r.element_path),
    depth: num(r.depth),
    health: n(r.health),
    health_band: r.health_band ?? null,
    temp_c: n(r.temp_c),
    load_pct: n(r.load_pct),
    tx_active: r.tx_active ?? null,
    rx_active: r.rx_active ?? null,
    moved_by: r.moved_by ?? null,
    subtree_changes_window: num(r.subtree_changes_window),
  };
}

/** Subscribe to one level. Aborts and DELETEs the shape on unmount or when the definition
 *  changes, and with keepalive on pagehide. */
export function useElementLevel(req: ElementLevelRequest): ElementRow[] {
  const [gen, setGen] = useState(0);
  // A fresh controller per mount and per definition. The shape cache hashes the options but
  // ignores the signal, so a new controller after an abort yields a new stream.
  const ctl = useMemo(() => new AbortController(), [req.key, gen]); // eslint-disable-line react-hooks/exhaustive-deps

  const paramsRef = useRef(req.params);
  paramsRef.current = req.params;

  const { data } = useShape({
    url: ELECTRIC_URL,
    // columns goes on the wire as the plain comma-joined string; the client types it as string[]
    // and would quote each name, which is not the form the gateway reads.
    params: req.params as never,
    signal: ctl.signal,
  });

  useEffect(() => {
    // A remount that reuses an already-aborted controller (StrictMode) needs a new one.
    if (ctl.signal.aborted) {
      setGen((g) => g + 1);
      return;
    }
    let released = false;
    const release = (keepalive: boolean) => {
      if (released) return;
      released = true;
      ctl.abort();
      sendDelete(paramsRef.current, keepalive);
    };
    const onHide = () => release(true);
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      release(false);
    };
  }, [ctl]);

  return useMemo(() => ((data ?? []) as Record<string, any>[]).map(mapRow), [data]);
}

/** The open non-root levels after drilling into `path`. Levels on the path (the path, its
 *  ancestors, or levels already open beneath it) stay open, so going back up keeps them. A
 *  level on another branch diverges from the new path and is dropped; its unmount releases it. */
export function levelsAfterDrill(levels: string[], path: string): string[] {
  const kept = levels.filter((l) => l === path || path.startsWith(l + '/') || l.startsWith(path + '/'));
  return kept.includes(path) ? kept : [...kept, path];
}

/** Fold the rows of the open levels into the lookup SensorArrayView reads. */
export function mergeLevelRows(
  rowsByKey: Record<string, ElementRow[]>,
  openKeys: string[],
): Record<string, ElementLiveEntry> {
  const out: Record<string, ElementLiveEntry> = {};
  for (const k of openKeys) {
    for (const r of rowsByKey[k] ?? []) {
      out[r.element_path] = {
        health: r.health as number,
        temp: r.temp_c ?? undefined,
        load: r.load_pct ?? undefined,
        txActive: r.tx_active ?? undefined,
        rxActive: r.rx_active ?? undefined,
        movedBy: r.moved_by ?? undefined,
        subtreeChanges: r.subtree_changes_window > 0 ? r.subtree_changes_window : undefined,
      };
    }
  }
  return out;
}

export interface ElementLiveEntry {
  health: number;
  temp?: number;
  load?: number;
  txActive?: boolean;
  rxActive?: boolean;
  movedBy?: string;
  subtreeChanges?: number;
}
