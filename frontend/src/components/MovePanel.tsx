// MovePanel -- what a move does to an asset or a declared unit, by phase.
//
// Nothing here is drafted to read as shown: every value line ends with its
// source and time, and every missing input is shown as its absence, named,
// using the reason strings lib/movePanel.ts returns. The presentational
// component takes already-fetched rows; the two containers below call the
// hooks and the declared inputs.
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import {
  deferredMaintenance,
  emplaceTime,
  fuelForMove,
  isAbsent,
  latestEpisode,
  marchOrderTime,
  operationalStatusConcept,
  readinessAfterEmplacement,
  replayLedger,
  resupplySince,
  vsStandard,
  type Episode,
  type LedgerDeclared,
  type LedgerFire,
  type Maybe,
} from '../lib/movePanel';
import {
  normalizePosture,
  postureClass,
  postureLabel,
  usePostureClock,
} from '../lib/posture';
import type { LinkStatusRow } from '../lib/linkStatus';
import { moveInputs, unitForAsset, type MoveStandard } from '../deployment';
import {
  useAllCmState,
  useAllLogisticsStatus,
  useCmState,
  useEdgeBuffer,
  useEffectorLaunchesFor,
  useEffectorResupply,
  useFleetAssets,
  useLinkStatus,
  useLogisticsStatus,
  usePartsAvailability,
  usePostureTransitions,
  type EdgeBufferStatus,
  type PartsAvailability,
} from '../hooks';

export type TierKind = 'edge' | 'region' | 'hq';

export interface MemberResupply {
  receivedAt: string;
  munitionType: string;
  quantity: number;
  supplierAssetId: string | null;
}

export interface MemberFleet {
  reportingStatus: string | null;
  reportingStatusAt: string | null;
  lastSampleAt: string | null;
  position: { lat: number; lon: number } | null;
  edgeId: string | null;
}

export interface MemberInput {
  assetId: string;
  variant: string | null;
  declared: LedgerDeclared;
  fires: LedgerFire[];
  resupplies: MemberResupply[];
  discrepancies: Array<Record<string, any>>;
  episode: Episode | null;
  logistics: { overall_severity: string; computed_at: string | null } | null;
  fleet: MemberFleet | null;
}

export interface MovePanelProps {
  kind: 'asset' | 'unit';
  tierKind: TierKind;
  scopeId: string;
  scopeLabel: string;
  members: MemberInput[];
  standards: Record<string, MoveStandard>;
  plannedMoveKm?: number;
  nowMs: number;
  buffer?: EdgeBufferStatus | null;
  links?: Map<string, LinkStatusRow>;
  parts?: PartsAvailability[];
  /** Start with the sources, notes and timing detail expanded. */
  defaultDetail?: boolean;
}

// ---------------------------------------------------------------------------
// Small renderers
// ---------------------------------------------------------------------------

function fmtT(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toISOString().slice(0, 19).replace('T', ' ') + 'Z';
}

function fmtS(s: number): string {
  const a = Math.abs(Math.round(s));
  const sign = s < 0 ? '-' : '';
  if (a < 120) return `${sign}${a}s`;
  if (a < 7200) return `${sign}${Math.floor(a / 60)}m ${a % 60}s`;
  return `${sign}${Math.floor(a / 3600)}h ${Math.floor((a % 3600) / 60)}m`;
}

/** Muted `source . time` tail of a value line. */
// Provenance tails, concept lines and notes render only when the panel's detail expander is open.
const DetailContext = createContext(false);

function Prov({ source, at, tag }: { source: string; at?: string | null; tag?: string }) {
  const detail = useContext(DetailContext);
  if (!detail) return null;
  const parts = [source, at ? fmtT(at) : '', tag ?? ''].filter(Boolean);
  return <span className="text-[10px] text-slate-500 ml-1 break-words">{parts.join(' · ')}</span>;
}

function Absence({ reason, testId }: { reason: string; testId?: string }) {
  return (
    <span className="text-slate-400 italic break-words" data-absent={reason} data-testid={testId}>
      {reason}
    </span>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="text-[11px] text-slate-300 break-words min-w-0">
      <span className="text-slate-500">{label} </span>
      {children}
    </div>
  );
}

function Heading({ children }: { children: ReactNode }) {
  return <div className="text-[10px] text-slate-500 tracking-wider uppercase mt-2 mb-0.5">{children}</div>;
}

function maybeText<T>(m: Maybe<T>, fmt: (v: T) => string): ReactNode {
  return isAbsent(m)
    ? <Absence reason={m.absent} />
    : <>{fmt(m.value)}<Prov source={m.source} at={m.at} /></>;
}

// ---------------------------------------------------------------------------
// Phase helpers
// ---------------------------------------------------------------------------

const PHASE_RANK: Record<string, number> = { march_ordered: 0, moving: 1, emplacing: 2, emplaced: 3 };

/** The unit's phase is its least advanced member phase. */
export function unitPhase(members: MemberInput[]): string | null {
  let best: string | null = null;
  for (const m of members) {
    if (!m.episode) continue;
    const p = m.episode.phase;
    if (best === null || (PHASE_RANK[p] ?? 0) < (PHASE_RANK[best] ?? 0)) best = p;
  }
  return best;
}

function Timing({
  testId, label, measured, standardS, variant, running, member,
}: {
  testId: string;
  label: string;
  measured: Maybe<number>;
  standardS: number | undefined;
  variant: string;
  running?: boolean;
  member: string;
}) {
  if (isAbsent(measured)) {
    return (
      <Row label={label}>
        <span data-testid={testId} data-asset={member} data-absent={measured.absent} className="text-slate-400 italic">
          {measured.absent}
        </span>
      </Row>
    );
  }
  const v = vsStandard(measured.value, standardS, variant);
  return (
    <Row label={label}>
      <span
        data-testid={testId}
        data-asset={member}
        data-value={measured.value}
        {...(isAbsent(v) ? { 'data-absent': v.absent } : { 'data-verdict': v.value.verdict })}
      >
        {fmtS(measured.value)}
        {running ? ' (browser clock)' : ''}
        {isAbsent(v)
          ? <> · <Absence reason={v.absent} /></>
          : <> · {v.value.verdict} standard by {fmtS(Math.abs(v.value.delta))} (standard {fmtS(standardS as number)}, <span className="text-slate-500">overlay-declared</span>)</>}
      </span>
      <Prov source={measured.source} at={measured.at} />
    </Row>
  );
}

function Rounds({ member, asOfMs, label, kind }: { member: MemberInput; asOfMs: number; label: string; kind: 'asset' | 'unit' }) {
  const rows = replayLedger(member.declared, member.fires, member.resupplies, asOfMs);
  return (
    <div>
      <Heading>{label}</Heading>
      {rows.length === 0 ? (
        <Row label="Rounds"><Absence reason={`no declared load or launches for ${member.assetId}`} /></Row>
      ) : rows.map((r) => (
        <div
          key={r.munitionKey}
          className="text-[11px] text-slate-300 break-words"
          data-testid="move-rounds"
          data-launcher={member.assetId}
          data-munition={r.munitionKey}
          data-remaining={isAbsent(r.remaining) ? 'absent' : r.remaining.value}
          {...(isAbsent(r.remaining) ? { 'data-absent': r.remaining.absent } : {})}
        >
          <span className="text-slate-500">{kind === 'asset' ? r.munitionKey : `${member.assetId} ${r.munitionKey}`}</span>{' '}
          declared/fired {r.fired.value}/received {r.received.value}/remaining{' '}
          {isAbsent(r.remaining) ? <Absence reason={r.remaining.absent} /> : r.remaining.value}
          <Prov source={isAbsent(r.remaining) ? r.fired.source : r.remaining.source} at={r.fired.at} />
        </div>
      ))}
    </div>
  );
}

function Deferred({ member, asOfMs, heading }: { member: MemberInput; asOfMs: number; heading: string }) {
  const detail = useContext(DetailContext);
  const d = deferredMaintenance(member.discrepancies, asOfMs);
  return (
    <div>
      <Heading>{heading}</Heading>
      {d.items.length === 0 ? (
        <div className="text-[11px] text-slate-400">No open discrepancy in this window</div>
      ) : d.items.map((t) => (
        <div
          key={t.discrepancyId}
          className="text-[11px] text-slate-300 break-words"
          data-testid="move-deferred"
          data-discrepancy={t.discrepancyId}
        >
          {t.faultCode} {t.component} ({t.severity}) · <Absence reason={t.workOrder.absent} />
          <Prov source={t.concept} at={t.detectedAt} />
        </div>
      ))}
      {detail && <div className="text-[10px] text-slate-500">{d.note}</div>}
    </div>
  );
}

function Spares({ members, tierKind, parts }: { members: MemberInput[]; tierKind: TierKind; parts: PartsAvailability[] }) {
  if (tierKind !== 'hq') {
    return (
      <Row label="">
        <span data-testid="move-spares">Spares: the stand-in is held at HQ, not carried to this tier</span>
      </Row>
    );
  }
  const unk = (v: number | null) => (v === null ? 'unknown' : String(v));
  return (
    <div data-testid="move-spares">
      <Heading>Spares</Heading>
      {members.map((m) => {
        const edge = m.fleet?.edgeId ?? null;
        const rows = edge ? parts.filter((p) => p.site === edge) : [];
        if (rows.length === 0) {
          return (
            <Row key={m.assetId} label={m.assetId}>
              <Absence reason={`no parts_availability rows for ${edge ?? 'an unattributed edge'}`} />
            </Row>
          );
        }
        return rows.map((p) => (
          <div key={`${m.assetId}:${p.site}:${p.partRef}`} className="text-[11px] text-slate-300 break-words" data-part={p.partRef}>
            <span className="text-slate-500">{p.site} {p.partRef}</span>{' '}
            on hand {unk(p.onHand)}; nearest stock {p.nearestSiteWithStock ?? 'unknown'} ({unk(p.nearestOnHand)});
            lead time {p.leadTimeDays === null ? 'unknown' : `${p.leadTimeDays} d`}
            <Prov source={p.source ?? 'source unknown'} at={p.observedAt} />
          </div>
        ));
      })}
    </div>
  );
}

function TierView({ tierKind, buffer, member, reporting, edge, link, pos }: {
  tierKind: TierKind;
  buffer: EdgeBufferStatus | null | undefined;
  member: MemberInput;
  reporting: string | null;
  edge: string | null;
  link: LinkStatusRow | undefined;
  pos: { lat: number; lon: number } | null;
}) {
  return (
    <>
      {tierKind === 'edge' ? (
        <>
          {buffer ? (
            <>
              <Row label="">
                <span data-testid="move-uplink" data-severed={buffer.hq_link_severed ? 'true' : 'false'}>
                  {buffer.hq_link_severed ? 'uplink severed' : 'uplink up'}
                </span>
                <Prov source="edge_buffer_status.hq_link_severed" at={buffer.updated_at} />
              </Row>
              <Row label="buffer depth">
                <span data-testid="move-buffer" data-value={buffer.bridge_group_lag}>{buffer.bridge_group_lag}</span>
                <Prov source="bridge_group_lag" at={buffer.updated_at} />
              </Row>
            </>
          ) : (
            <Row label="uplink"><Absence reason="no edge_buffer_status row" testId="move-uplink" /></Row>
          )}
        </>
      ) : (
        <>
          <Row label="reporting">
            {reporting ?? 'unknown'}
            <Prov source="reporting_status" at={member.fleet?.reportingStatusAt} />
          </Row>
          <Row label="last sample">
            {member.fleet?.lastSampleAt
              ? <>{fmtT(member.fleet.lastSampleAt)}<Prov source="last_sample_at" /></>
              : <Absence reason="no sample on record" />}
          </Row>
          <Row label={reporting && reporting !== 'reporting' ? 'last position held' : 'position'}>
            {pos
              ? <>{pos.lat.toFixed(5)}, {pos.lon.toFixed(5)}<Prov source="fleet position" at={member.fleet?.lastSampleAt} /></>
              : <Absence reason="no position on record" />}
          </Row>
          {link ? (
            <div
              className="text-[11px] text-slate-300 break-words"
              data-testid="move-link"
              data-edge={link.id}
              data-state={link.link_state}
            >
              <span className="text-slate-500">link {link.id} </span>
              {link.link_state}; heartbeat age {link.heartbeat_age_s === null ? 'unknown' : `${link.heartbeat_age_s}s`}; bridge lag {link.bridge_lag}
              <Prov source="link_status" at={link.updated_at} />
            </div>
          ) : (
            <Row label="">
              <span data-testid="move-link" data-edge={edge ?? ''} data-state="absent" data-absent={`no link row for ${edge ?? 'unknown edge'}`} className="text-slate-400 italic">
                no link row for {edge ?? 'unknown edge'}
              </span>
            </Row>
          )}
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// One member's section
// ---------------------------------------------------------------------------

function MemberSection(props: MovePanelProps & { member: MemberInput }) {
  const { member, tierKind, nowMs, standards, plannedMoveKm, buffer, links, parts, kind } = props;
  const detail = useContext(DetailContext);
  const ep = member.episode;
  if (!ep) return <Row label={member.assetId}><Absence reason="No move on record" /></Row>;
  const phase = ep.phase;
  const variant = member.variant ?? 'unknown variant';
  const standard = member.variant ? standards[member.variant] : undefined;
  const marchMs = Date.parse(ep.marchOrderedAt);
  const frozen = phase === 'moving';
  const settled = phase === 'emplacing' || phase === 'emplaced';
  const fuel = fuelForMove(standard, plannedMoveKm);
  const reporting = member.fleet?.reportingStatus ?? null;
  const edge = member.fleet?.edgeId ?? null;
  const link = edge ? links?.get(edge) : undefined;
  const pos = member.fleet?.position ?? null;
  const readiness = readinessAfterEmplacement(member.logistics, ep.emplacedAt);
  const resupplied = resupplySince(member.resupplies, marchMs);
  const silent = tierKind !== 'edge' && ((reporting !== null && reporting !== 'reporting') || (link !== undefined && link.link_state !== 'up' && link.link_state !== 'idle'));

  return (
    <div className="border-t border-slate-700/50 pt-1 mt-1 min-w-0">
      <div
        className="text-[11px] text-slate-200 font-semibold break-words"
        data-testid="move-member"
        data-asset={member.assetId}
        data-reporting={reporting ?? 'absent'}
        data-phase={phase}
      >
        {member.assetId} · {postureLabel(normalizePosture(phase))}
      </div>

      {(phase === 'march_ordered') && (
        <>
          <Rounds kind={kind} member={member} asOfMs={nowMs} label="Rounds (now)" />
          <Heading>Fuel for the move</Heading>
          <div
            className="text-[11px] text-slate-300 break-words"
            data-testid="move-fuel"
            {...(isAbsent(fuel.result) ? { 'data-absent': fuel.result.absent } : { 'data-value': fuel.result.value })}
          >
            {isAbsent(fuel.result)
              ? <Absence reason={fuel.result.absent} />
              : <>{fuel.result.value} left<Prov source={fuel.result.source} tag="overlay-declared" /></>}
          </div>
          {detail && <div className="text-[10px] text-slate-500">{fuel.assumption}</div>}
          <Spares members={[member]} tierKind={tierKind} parts={parts ?? []} />
          <Deferred member={member} asOfMs={marchMs} heading="Deferred maintenance (as of march order)" />
          <Heading>Time to march order</Heading>
          <Timing
            testId="move-mo-time"
            label={`since march order ${fmtT(ep.marchOrderedAt)}`}
            measured={silent
              ? { absent: `${edge ?? 'the edge'} not reporting since ${fmtT(member.fleet?.lastSampleAt)}: whether the unit has moved is unknown here; the march-order time comes from the edge's transitions once they arrive` }
              : Number.isFinite(marchMs)
              ? { value: (nowMs - marchMs) / 1000, source: 'browser clock minus march order time', at: ep.marchOrderedAt }
              : { absent: 'march order time unparseable' }}
            standardS={standard?.marchOrderS}
            variant={variant}
            running
            member={member.assetId}
          />
          <TierView tierKind={tierKind} buffer={buffer} member={member} reporting={reporting} edge={edge} link={link} pos={pos} />
        </>
      )}

      {frozen && (
        <>
          <Rounds kind={kind} member={member} asOfMs={marchMs} label={`Rounds as of march order ${fmtT(ep.marchOrderedAt)}`} />
          <Deferred member={member} asOfMs={marchMs} heading={`Deferred maintenance as of march order ${fmtT(ep.marchOrderedAt)}`} />
          <Row label="moving since">
            {ep.movingMotionSince
              ? <>{fmtS((nowMs - Date.parse(ep.movingMotionSince)) / 1000)} (browser clock)<Prov source="motion_since of the moving transition" at={ep.movingMotionSince} /></>
              : <Absence reason="moving transition carries no motion_since" />}
          </Row>
          <Timing
            testId="move-mo-time"
            label="march order time"
            measured={marchOrderTime(ep)}
            standardS={standard?.marchOrderS}
            variant={variant}
            member={member.assetId}
          />
          <TierView tierKind={tierKind} buffer={buffer} member={member} reporting={reporting} edge={edge} link={link} pos={pos} />
        </>
      )}

      {settled && (
        <>
          {detail && (
            <>
            <Timing
              testId="move-emplace-time"
              label="emplace time"
              measured={emplaceTime(ep)}
              standardS={standard?.emplaceS}
              variant={variant}
              member={member.assetId}
            />
            <Row label="readiness">
              <span
                data-testid="move-readiness"
                {...(isAbsent(readiness.readiness)
                  ? { 'data-absent': readiness.readiness.absent }
                  : { 'data-value': readiness.readiness.value })}
              >
                {maybeText(readiness.readiness, (v) => v)}
              </span>
            </Row>
            <div className="text-[10px] text-slate-500">{readiness.note}</div>
            </>
          )}
          <Deferred member={member} asOfMs={marchMs} heading="Due on emplacement" />
          {detail && (
            <div>
            <Heading>Resupply received since march order</Heading>
            {resupplied.length === 0 ? (
              <div className="text-[11px] text-slate-400">None received since march order</div>
            ) : resupplied.map((r, i) => (
              <div key={`${r.receivedAt}:${i}`} className="text-[11px] text-slate-300 break-words" data-testid="move-resupply" data-munition={r.munitionType}>
                {r.munitionType} x{r.quantity} from {r.supplierAssetId ?? 'unknown supplier'} · applied to the ledger
                <Prov source="effector_resupply" at={r.receivedAt} />
              </div>
            ))}
            </div>
          )}
          <Rounds kind={kind} member={member} asOfMs={nowMs} label="Rounds (now)" />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

/** Seconds-in-state anchor: the current-phase timestamp of the least advanced member episode. */
function stateSince(members: MemberInput[]): string | null {
  let best: Episode | null = null;
  for (const m of members) {
    const e = m.episode;
    if (!e) continue;
    if (best === null || (PHASE_RANK[e.phase] ?? 0) < (PHASE_RANK[best.phase] ?? 0)) best = e;
  }
  if (!best) return null;
  switch (best.phase) {
    case 'emplaced': return best.emplacedAt;
    case 'emplacing': return best.emplacingAt;
    case 'moving': return best.movingAt;
    case 'march_ordered': return best.marchOrderedAt;
    default: return null;
  }
}

export default function MovePanel(props: MovePanelProps) {
  const { kind, scopeId, scopeLabel, members } = props;
  const [detail, setDetail] = useState(props.defaultDetail ?? false);
  const phase = unitPhase(members);
  const since = stateSince(members);
  const sinceMs = since ? Date.parse(since) : NaN;
  const idAttr = kind === 'asset' ? { 'data-asset': scopeId } : { 'data-unit': scopeId };
  const concept = phase ? operationalStatusConcept(phase) : null;
  return (
    <DetailContext.Provider value={detail}>
    <div
      className="panel shrink-0 p-3 min-w-0 max-h-80 overflow-y-auto overflow-x-hidden"
      data-testid="move-panel"
      {...idAttr}
      data-phase={phase ?? 'none'}
    >
      <div className="flex items-center gap-2 mb-1 flex-wrap">
        <h2 className="text-sm text-slate-400 tracking-wider uppercase">Move · {scopeLabel}</h2>
        {phase && (
          <span className={`text-[11px] font-bold px-2 py-0.5 rounded-sm border ${postureClass(normalizePosture(phase))}`}>
            {postureLabel(normalizePosture(phase))}
          </span>
        )}
        {phase && Number.isFinite(sinceMs) && (
          <span data-testid="move-in-state" className="text-[11px] text-slate-300 tabular-nums">
            {fmtS((props.nowMs - sinceMs) / 1000)}
          </span>
        )}
        <button
          type="button"
          data-testid="move-detail-toggle"
          aria-expanded={detail}
          title="Show sources, notes and timing detail"
          onClick={() => setDetail((d) => !d)}
          className="ml-auto flex items-center gap-0.5 text-[10px] text-slate-500 hover:text-slate-300"
        >
          detail
          {detail ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        </button>
      </div>
      {!phase || !concept ? (
        <div className="text-[11px] text-slate-500" data-absent="No move on record">No move on record</div>
      ) : (
        <>
          {detail && (
            <div
              className="text-[11px] text-slate-300 break-words"
              data-testid="move-c1"
              {...(isAbsent(concept) ? { 'data-absent': concept.absent } : {})}
            >
              {maybeText(concept, (v) => v)}
            </div>
          )}
          {members.map((m) => <MemberSection key={m.assetId} {...props} member={m} />)}
        </>
      )}
    </div>
    </DetailContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

function ledgerDeclared(assetId: string, variant: string | null): LedgerDeclared {
  const load = moveInputs()?.declaredLoad;
  return {
    label: variant ? `${assetId} (${variant})` : assetId,
    asset: load?.asset[assetId],
    variant: variant ? load?.variant[variant] : undefined,
  };
}

/** Edge (maintainer) view: the selected asset's own move. */
export function AssetMovePanel({ assetId, variant, tierKind }: { assetId: string; variant: string | null; tierKind: 'edge' }) {
  const nowMs = usePostureClock();
  const transitions = usePostureTransitions([assetId]);
  const launches = useEffectorLaunchesFor([assetId]);
  const resupply = useEffectorResupply([assetId]);
  const cm = useCmState(assetId);
  const logistics = useLogisticsStatus(assetId);
  const edgeBuffer = useEdgeBuffer();
  const inputs = moveInputs();
  const unit = unitForAsset(assetId);

  const member = useMemo<MemberInput>(() => {
    const c = cm.data[0];
    const l = logistics.data[0];
    return {
      assetId,
      variant,
      declared: ledgerDeclared(assetId, variant),
      fires: launches.data.filter((x) => x.launcherAssetId === assetId),
      resupplies: resupply.data.filter((x) => x.launcherAssetId === assetId),
      discrepancies: [...(c?.discrepancies ?? []), ...(c?.manual_discrepancies ?? [])],
      episode: latestEpisode(transitions.data, assetId),
      logistics: l ? { overall_severity: l.overall_severity, computed_at: l.computed_at ?? null } : null,
      fleet: null,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetId, variant, launches.data, resupply.data, cm.data, logistics.data, transitions.data, inputs]);

  return (
    <MovePanel
      kind="asset"
      tierKind={tierKind}
      scopeId={assetId}
      scopeLabel={assetId}
      members={[member]}
      standards={inputs?.standards ?? {}}
      plannedMoveKm={unit?.plannedMoveKm}
      nowMs={nowMs}
      buffer={edgeBuffer.status}
    />
  );
}

/** Region and HQ views: one panel per declared movement unit. */
export function UnitMovePanels({ tierKind }: { tierKind: 'region' | 'hq' }) {
  const inputs = moveInputs();
  const units = inputs?.units ?? [];
  const nowMs = usePostureClock();
  const memberIds = useMemo(() => [...new Set(units.flatMap((u) => u.members))], [units]);
  const transitions = usePostureTransitions(memberIds);
  const launches = useEffectorLaunchesFor(memberIds);
  const resupply = useEffectorResupply(memberIds);
  const cm = useAllCmState();
  const logistics = useAllLogisticsStatus();
  const fleet = useFleetAssets();
  const linkStatus = useLinkStatus();
  const edgeIds = useMemo(
    () => memberIds.map((id) => fleet.data.find((f) => f.asset_id === id)?.edge_id).filter((e): e is string => !!e),
    [memberIds, fleet.data],
  );
  const parts = usePartsAvailability(tierKind === 'hq' ? edgeIds : []);

  if (!inputs) {
    return (
      <div className="panel shrink-0 p-3 text-[11px] text-slate-400" data-absent="Move inputs not delivered by this deployment">
        Move inputs not delivered by this deployment
      </div>
    );
  }
  if (units.length === 0) {
    return (
      <div className="panel shrink-0 p-3 text-[11px] text-slate-400" data-absent="No units declared for move tracking (movement.units)">
        No units declared for move tracking (movement.units)
      </div>
    );
  }
  return (
    <>
      {units.map((u) => {
        const members: MemberInput[] = u.members.map((id) => {
          const f = fleet.data.find((x) => x.asset_id === id);
          const variant = f?.platform_variant ?? null;
          const c = cm.data.find((x) => x.asset_id === id);
          const l = logistics.data.find((x) => x.asset_id === id);
          return {
            assetId: id,
            variant,
            declared: ledgerDeclared(id, variant),
            fires: launches.data.filter((x) => x.launcherAssetId === id),
            resupplies: resupply.data.filter((x) => x.launcherAssetId === id),
            discrepancies: [...(c?.discrepancies ?? []), ...(c?.manual_discrepancies ?? [])],
            episode: latestEpisode(transitions.data, id),
            logistics: l ? { overall_severity: l.overall_severity, computed_at: l.computed_at ?? null } : null,
            fleet: f
              ? {
                  reportingStatus: f.reporting_status,
                  reportingStatusAt: f.reporting_status_at,
                  lastSampleAt: f.last_sample_at,
                  position: f.position,
                  edgeId: f.edge_id,
                }
              : null,
          };
        });
        return (
          <MovePanel
            key={u.id}
            kind="unit"
            tierKind={tierKind}
            scopeId={u.id}
            scopeLabel={u.label}
            members={members}
            standards={inputs.standards}
            plannedMoveKm={u.plannedMoveKm}
            nowMs={nowMs}
            links={linkStatus.links}
            parts={parts.data}
          />
        );
      })}
    </>
  );
}
