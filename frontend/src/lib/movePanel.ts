// Move panel derivations. Pure, no React.
//
// Every figure is derived from append-only rows and declared config, the
// same way at every tier from that tier's own store. A returned value is
// either `Known` (the value plus where it came from) or `Absent` (the reason
// it cannot be stated, naming the missing input) -- never a bare number, so a
// panel cannot render an unknown as a zero.
import type { MoveStandard, UnitQuantity } from '../deployment';

export interface Known<T> {
  value: T;
  source: string;
  at?: string;
}
export interface Absent {
  absent: string;
}
export type Maybe<T> = Known<T> | Absent;

export function isAbsent<T>(m: Maybe<T>): m is Absent {
  return 'absent' in m;
}

/** One posture transition CloudEvent, mapped. Times are edge sample times. */
export interface PostureTransition {
  subject: string;
  from: string;
  to: string;
  at: string;
  motionSince: string | null;
  motion: string | null;
  deploySignal: boolean | null;
  speedMps: number | null;
  edgeId: string | null;
  regionId: string | null;
  originatorNation?: string;
  releasableTo?: string[];
}

function ms(iso: string | null | undefined): number {
  return iso ? Date.parse(iso) : NaN;
}

// ---------------------------------------------------------------------------
// Episodes and timings
// ---------------------------------------------------------------------------

export interface Episode {
  marchOrderedAt: string;
  movingAt: string | null;
  movingMotionSince: string | null;
  /** When the asset stopped moving, with the field it came from. */
  haltAt: Known<string> | null;
  emplacingAt: string | null;
  emplacedAt: string | null;
  /** `to` of the last transition in the episode. */
  phase: string;
}

/** The asset's latest move: from its latest `to=march_ordered` transition
 *  through the transitions after it. Null when no march order is on record. */
export function latestEpisode(transitions: PostureTransition[], assetId: string): Episode | null {
  const mine = transitions
    .filter((t) => t.subject === assetId && !Number.isNaN(ms(t.at)))
    .sort((a, b) => ms(a.at) - ms(b.at));
  let start = -1;
  for (let i = mine.length - 1; i >= 0; i--) {
    if (mine[i].to === 'march_ordered') { start = i; break; }
  }
  if (start < 0) return null;
  let end = mine.length;
  for (let i = start + 1; i < mine.length; i++) {
    if (mine[i].to === 'march_ordered') { end = i; break; }
  }
  const ep = mine.slice(start, end);
  const first = (pred: (t: PostureTransition) => boolean) => ep.slice(1).find(pred);
  const moving = first((t) => t.to === 'moving');
  const out = first((t) => t.from === 'moving');
  const emplacing = first((t) => t.to === 'emplacing');
  const emplaced = first((t) => t.to === 'emplaced');
  let haltAt: Known<string> | null = null;
  if (out) {
    haltAt = out.motionSince
      ? { value: out.motionSince, source: 'motion_since of the transition out of moving', at: out.at }
      : { value: out.at, source: 'transition time of the transition out of moving (motion_since not carried)', at: out.at };
  }
  return {
    marchOrderedAt: ep[0].at,
    movingAt: moving?.at ?? null,
    movingMotionSince: moving?.motionSince ?? null,
    haltAt,
    emplacingAt: emplacing?.at ?? null,
    emplacedAt: emplaced?.at ?? null,
    phase: ep[ep.length - 1].to,
  };
}

/** Seconds from march order to the start of motion (edge time). */
export function marchOrderTime(ep: Episode): Maybe<number> {
  if (!ep.movingAt) return { absent: 'not yet moving' };
  if (!ep.movingMotionSince) return { absent: 'moving transition carries no motion_since' };
  const s = (ms(ep.movingMotionSince) - ms(ep.marchOrderedAt)) / 1000;
  if (!Number.isFinite(s)) return { absent: 'march order or motion_since time unparseable' };
  return { value: s, source: 'edge time: moving motion_since minus march order', at: ep.movingAt };
}

/** Seconds from halt to emplaced (edge time). */
export function emplaceTime(ep: Episode): Maybe<number> {
  if (!ep.emplacedAt) return { absent: 'not yet emplaced' };
  if (!ep.haltAt) return { absent: 'no transition out of moving on record' };
  const s = (ms(ep.emplacedAt) - ms(ep.haltAt.value)) / 1000;
  if (!Number.isFinite(s)) return { absent: 'halt or emplaced time unparseable' };
  return { value: s, source: `edge time: emplaced minus halt (${ep.haltAt.source})`, at: ep.emplacedAt };
}

export interface StandardVerdict {
  delta: number;
  verdict: 'within' | 'over';
}

export function vsStandard(
  measuredS: number,
  standardS: number | undefined,
  variant: string,
): Maybe<StandardVerdict> {
  if (standardS === undefined) return { absent: `no standard declared for ${variant}` };
  const delta = measuredS - standardS;
  return {
    value: { delta, verdict: delta <= 0 ? 'within' : 'over' },
    source: 'declared movement standard',
  };
}

// ---------------------------------------------------------------------------
// Munition ledger
// ---------------------------------------------------------------------------

export interface LedgerFire {
  launchedAt: string;
  munitionType: string;
  quantity: number;
}
export interface LedgerResupply {
  receivedAt: string;
  munitionType: string;
  quantity: number;
}
/** Declared load for one launcher: its own asset entry, and the entry for its
 *  platform variant. `label` names the asset/variant in absence messages. */
export interface LedgerDeclared {
  label: string;
  asset?: Record<string, number>;
  variant?: Record<string, number>;
}
export interface LedgerRow {
  munitionKey: string;
  fired: Known<number>;
  received: Known<number>;
  expended: Known<number>;
  remaining: Maybe<number>;
}

/** Replays fires and resupplies up to `asOfMs` in time order (a fire sorts
 *  before a resupply at the same instant). Expended never goes below zero.
 *  Remaining is declared minus expended; the asset entry wins over the
 *  variant entry; with no declared load it is absent while expended and
 *  received still show. */
export function replayLedger(
  declared: LedgerDeclared,
  fires: LedgerFire[],
  resupplies: LedgerResupply[],
  asOfMs: number,
): LedgerRow[] {
  type Ev = { t: number; kind: 0 | 1; key: string; q: number };
  const events: Ev[] = [];
  for (const f of fires) {
    const t = ms(f.launchedAt);
    if (t <= asOfMs) events.push({ t, kind: 0, key: f.munitionType, q: f.quantity });
  }
  for (const r of resupplies) {
    const t = ms(r.receivedAt);
    if (t <= asOfMs) events.push({ t, kind: 1, key: r.munitionType, q: r.quantity });
  }
  events.sort((a, b) => a.t - b.t || a.kind - b.kind);

  const keys = new Set<string>([
    ...Object.keys(declared.asset ?? {}),
    ...Object.keys(declared.variant ?? {}),
    ...fires.map((f) => f.munitionType),
    ...resupplies.map((r) => r.munitionType),
  ]);
  const asOfIso = Number.isFinite(asOfMs) ? new Date(asOfMs).toISOString() : undefined;
  const rows: LedgerRow[] = [];
  for (const key of [...keys].sort()) {
    let expended = 0;
    let fired = 0;
    let received = 0;
    for (const e of events) {
      if (e.key !== key) continue;
      if (e.kind === 0) { expended += e.q; fired += e.q; }
      else { expended = Math.max(0, expended - e.q); received += e.q; }
    }
    const d = declared.asset?.[key] ?? declared.variant?.[key];
    const src = 'replay of effector_launch and effector_resupply';
    rows.push({
      munitionKey: key,
      fired: { value: fired, source: src, at: asOfIso },
      received: { value: received, source: src, at: asOfIso },
      expended: { value: expended, source: src, at: asOfIso },
      remaining: d === undefined
        ? { absent: `no declared load for ${declared.label}` }
        : {
            value: d - expended,
            source: `declared ${declared.asset?.[key] !== undefined ? 'asset' : 'variant'} load minus expended`,
            at: asOfIso,
          },
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Fuel
// ---------------------------------------------------------------------------

export interface FuelResult {
  result: Maybe<number>;
  assumption: string;
}

const FUEL_ASSUMPTION = 'assumes a full tank at march order; no fuel level is reported';

export function fuelForMove(
  standard: Pick<MoveStandard, 'fuelTank' | 'fuelBurnPerKm'> | undefined,
  plannedMoveKm: number | undefined,
): FuelResult {
  const tank: UnitQuantity | undefined = standard?.fuelTank;
  const burn: UnitQuantity | undefined = standard?.fuelBurnPerKm;
  const missing: string[] = [];
  if (!tank) missing.push('fuelTank');
  if (!burn) missing.push('fuelBurnPerKm');
  if (plannedMoveKm === undefined) missing.push('plannedMoveKm');
  if (missing.length || !tank || !burn || plannedMoveKm === undefined) {
    return { result: { absent: `missing input: ${missing.join(', ')}` }, assumption: FUEL_ASSUMPTION };
  }
  if (burn.unit !== `${tank.unit}/km`) {
    return { result: { absent: 'fuel units differ' }, assumption: FUEL_ASSUMPTION };
  }
  return {
    result: {
      value: tank.value - burn.value * plannedMoveKm,
      source: `declared tank minus declared burn x planned move (${tank.unit})`,
    },
    assumption: FUEL_ASSUMPTION,
  };
}

// ---------------------------------------------------------------------------
// Maintenance, readiness, status concept, resupply window
// ---------------------------------------------------------------------------

export interface DeferredTask {
  discrepancyId: string;
  faultCode: string;
  component: string;
  severity: string;
  detectedAt: string;
  workOrder: Absent;
  concept: string;
}

export function deferredMaintenance(
  discrepancies: Array<Record<string, any>>,
  asOfMs: number,
): { items: DeferredTask[]; note: string } {
  const items: DeferredTask[] = [];
  for (const d of discrepancies) {
    const detectedMs = Number(d.detected_at_ns) / 1e6;
    if (!Number.isFinite(detectedMs) || detectedMs > asOfMs) continue;
    items.push({
      discrepancyId: String(d.discrepancy_id ?? ''),
      faultCode: String(d.fault_code ?? ''),
      component: String(d.component ?? ''),
      severity: String(d.severity ?? ''),
      detectedAt: new Date(detectedMs).toISOString(),
      workOrder: { absent: 'no work order on record' },
      concept: 'S5000F deferred maintenance task',
    });
  }
  return { items, note: 'closure is absence: a cleared discrepancy leaves this list' };
}

export function readinessAfterEmplacement(
  logistics: { overall_severity: string; computed_at: string | null } | null | undefined,
  emplacedAt: string | null,
): { readiness: Maybe<string>; note: string } {
  const note = 'readiness has no location input';
  if (!emplacedAt) return { readiness: { absent: 'not yet emplaced' }, note };
  if (!logistics || !logistics.computed_at) {
    return { readiness: { absent: 'not recomputed since emplacement' }, note };
  }
  if (!(ms(logistics.computed_at) >= ms(emplacedAt))) {
    return { readiness: { absent: 'not recomputed since emplacement' }, note };
  }
  return {
    readiness: {
      value: logistics.overall_severity,
      source: 'asset_logistics_status computed after emplacement',
      at: logistics.computed_at,
    },
    note,
  };
}

export function operationalStatusConcept(phase: string): Maybe<string> {
  if (phase === 'march_ordered' || phase === 'moving' || phase === 'emplacing') {
    return {
      value: 'JC3IEDM operational status: temporarily not operational (weapon function)',
      source: `posture phase ${phase}`,
    };
  }
  return { absent: 'not inferred from posture' };
}

/** Resupply rows received at or after `sinceMs`, newest first. */
export function resupplySince<T extends { receivedAt: string }>(rows: T[], sinceMs: number): T[] {
  return rows
    .filter((r) => ms(r.receivedAt) >= sinceMs)
    .sort((a, b) => ms(b.receivedAt) - ms(a.receivedAt));
}
