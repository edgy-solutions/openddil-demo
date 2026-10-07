#!/usr/bin/env python3
"""Read-path policy enforcement point — ADR-0029 Phase 4.

PLACEMENT: a per-tier reverse proxy in front of Electric's shape endpoint,
co-located with the tier's Electric and its Topaz. The PEP goes at the one
read surface users actually touch, on the tier that serves them, and nothing
else may reach that surface.

Why not the alternatives, recorded so they are not re-litigated:

  * Frontend filtering — bypassed by anyone with a dev-tools tab. Not
    enforcement.
  * Postgres row-level security — strongest in principle, but Electric reads
    via replication as its OWN database role, not as the end user, so RLS
    never sees who is asking. Dead on arrival for this read path.
  * Per-nation stores — ADR-0029 already rejected it. One store, filtered
    reads, or the coalition liaison case breaks.
  * Inside Electric — no policy hook exists, and modifying it forks a
    dependency.

LOCALITY. The decision is taken from the tier's own Topaz against the tier's
own bundle. Under severance the tier keeps deciding with no reachback, which
is ADR-0029 §6's capstone property and the sentence no cloud-side system can
say.

THIS COMPONENT CONTAINS NO AUTHORIZATION LOGIC (ADR-0029 §1). It gathers
attributes, asks Topaz, and applies the answer verbatim. The WHERE clause it
composes is a TRANSPORT for the decision, not a second decision — which is
why the PDP returns a set of nations rather than a predicate. A transport
cannot disagree with what it carries; a second rule engine can.

STDLIB ONLY, ON PURPOSE. No new image, no wheels to resolve at start-up, no
network at boot. The source is delivered from the runtime bundle into a
stock python image. A component that will refuse requests should not have a
dependency that can fail to install.

THE WAN CONTROL ROUTE (GET/POST /proxies/hq-link) is not a read-path
decision -- it is an operator action with a blast radius (severing or
restoring the uplink for everyone), gated on ROLE rather than on nations.
No session is a 401; an authenticated subject whose role is not a
WAN-control role (default `supervisor`) is a 403; a WAN-control role is
forwarded to the DDIL sever mechanism. Both GET and POST are gated -- a
read of the link's current state is no less a capability than flipping it.

THE EXERCISE CONTROL ROUTE (GET /exercise/status, POST /exercise/op/<op>)
is the same shape of affordance -- role-gated, not nation-gated. This
gateway forwards ONLY to exercise/control.py's own HTTP surface; no route
here ever reaches the adapter endpoint or the simulator -- control.py is
the only thing that calls the adapter, and this file never learns its
address. The subject header sent upstream is always this session's own
subject, never a client-supplied one.
"""
from __future__ import annotations

import json
import logging
import os
import re
import secrets
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import egress_view
import manual_qa
import oidc

# --- configuration ----------------------------------------------------------
ELECTRIC = os.environ["OPENDDIL_ELECTRIC_URL"].rstrip("/")
TOPAZ = os.environ["OPENDDIL_TOPAZ_URL"].rstrip("/")
LISTEN_PORT = int(os.getenv("OPENDDIL_PEP_PORT", "8080"))
SUBJECT_HEADER = os.getenv("OPENDDIL_SUBJECT_HEADER", "X-OpenDDIL-Subject")
TOPAZ_TIMEOUT = float(os.getenv("OPENDDIL_TOPAZ_TIMEOUT", "2.0"))

# THE EGRESS PANE, REACHED THROUGH THIS PEP RATHER THAN DIRECTLY. The
# pane (egress/pane_api.py) answers once, for every nation on the wire; this
# PEP is the only place a viewer's own nations are known, so it is the only
# place that answer can be narrowed before it reaches a browser. Empty means
# "no pane at this tier", same meaning as ELECTRIC/TOPAZ being required: a
# deployment that has not wired a pane gets a clean 404, not a guess.
EGRESS_PANE = os.getenv("OPENDDIL_EGRESS_PANE_URL", "").rstrip("/")

# --- the service-client picture route ------------------------------------------
# GET /picture?event_id=<id>, authenticated by an OAuth2 Bearer access token
# (client_credentials) from this realm. The PEP maps the token's client to a
# release destination itself; the consumer never names one. Empty URL means
# "not wired at this tier": a clean 404, same convention as EGRESS_PANE.
PICTURE_URL = os.getenv("OPENDDIL_PICTURE_URL", "").rstrip("/")
PICTURE_AUDIENCE = os.getenv("OPENDDIL_PICTURE_AUDIENCE", "openddil-picture")


def _parse_picture_clients(raw: str) -> dict:
    """JSON object of client id -> destination. Anything malformed yields an
    EMPTY map (so every client is refused), never a partial one."""
    if not raw.strip():
        return {}
    try:
        parsed = json.loads(raw)
    except ValueError:
        logging.getLogger("pep").error("OPENDDIL_PICTURE_CLIENTS is not valid "
                                       "JSON; no clients are entitled")
        return {}
    if (not isinstance(parsed, dict)
            or not all(isinstance(k, str) and isinstance(v, str) and v
                       for k, v in parsed.items())):
        logging.getLogger("pep").error("OPENDDIL_PICTURE_CLIENTS must map "
                                       "strings to non-empty strings; no "
                                       "clients are entitled")
        return {}
    return parsed


PICTURE_CLIENTS = _parse_picture_clients(os.getenv("OPENDDIL_PICTURE_CLIENTS", ""))

# --- the CM write path --------------------------------------------------------
# ONE route, one write, one topic. Empty means "not wired at this tier", the
# same meaning ELECTRIC/TOPAZ/EGRESS_PANE being unset already carries: a
# deployment that has not configured a write path gets a clean 404, not a
# half-working route.
CM_INTAKE_URL = os.getenv("OPENDDIL_CM_INTAKE_URL", "").rstrip("/")
REPORT_SOURCE = os.getenv("OPENDDIL_REPORT_SOURCE", "operator_report")
MAX_CM_BODY_BYTES = int(os.getenv("OPENDDIL_MAX_CM_BODY_BYTES", str(8 * 1024)))

# --- the manual question service ---------------------------------------------
# A maintainer's question about the asset in view, delegated through this
# gateway to the manual question service and scoped to the data modules
# (DMCs) the maintainer is actually looking at. Empty means "not wired at
# this tier", the same meaning CM_INTAKE_URL/EGRESS_PANE being unset already
# carry: a deployment with no answering service gets a clean 404, not a
# half-working route.
MANUAL_QA_URL = os.getenv("OPENDDIL_MANUAL_QA_URL", "").rstrip("/")
MANUAL_QA_TOKEN_FILE = os.getenv("OPENDDIL_MANUAL_QA_TOKEN_FILE", "")
MANUAL_QA_TIMEOUT = float(os.getenv("OPENDDIL_MANUAL_QA_TIMEOUT", "10.0"))
MAX_MANUAL_ASK_BODY_BYTES = int(os.getenv("OPENDDIL_MAX_MANUAL_ASK_BODY_BYTES", str(16 * 1024)))


def _manual_qa_token() -> str | None:
    """RFC 8693 token exchange (ADR-0046, noted for later) replaces this
    bearer-token forward once the manual question service's own OIDC client
    is issued. Until then: a configured token file's contents, verbatim, or
    no Authorization header at all -- the stub's own posture."""
    if not MANUAL_QA_TOKEN_FILE:
        return None
    try:
        with open(MANUAL_QA_TOKEN_FILE, "r", encoding="utf-8") as f:
            return f.read().strip() or None
    except Exception as exc:  # noqa: BLE001 -- a config read, not a request
        log.error("could not read OPENDDIL_MANUAL_QA_TOKEN_FILE=%s: %s",
                  MANUAL_QA_TOKEN_FILE, exc)
        return None

# --- how much of a shape this process is willing to hold at once -------------
#
# THE OUTAGE THIS EXISTS FOR (2026-09-18). Every tier PEP was OOMKilled (exit
# 137) in a loop and the browser showed FEED UNAVAILABLE on every panel. Not a
# leak -- idle they sat flat at 17-19 MiB for minutes. Two things multiplied:
#
#   * the proxy did `payload = resp.read()` -- the WHOLE shape body resident
#     before a byte was forwarded; and
#   * ThreadingHTTPServer spawns one unbounded thread per connection, so the
#     resident total was (bytes per shape) x (however many requests arrived).
#
# One client load was measured at 10.05 MiB, of which `tactical_events` alone
# was 10.00 MiB. Nine shapes, a reconnecting browser, a 256 MiB cap.
#
# RAISING THE LIMIT WOULD NOT HAVE FIXED IT. It would have changed how many
# concurrent shapes the process survives before dying -- the same mistake as
# sizing a Restate by its memory limit while its RocksDB budget was a fraction
# OF that limit. A cap is only a sizing if something bounds what runs beneath
# it. Streaming removes the per-request body; the semaphore bounds the
# multiplier. Both, or neither is a bound.
MAX_INFLIGHT_SHAPES = int(os.getenv("OPENDDIL_MAX_INFLIGHT_SHAPES", "8"))
STREAM_CHUNK = int(os.getenv("OPENDDIL_STREAM_CHUNK", "65536"))

# A live=true request does not hold a body -- it holds at most one
# STREAM_CHUNK, the same as any other delta -- it holds a THREAD, idle,
# waiting up to ~20s for Electric's next change. Sharing _inflight between
# the two meant eight quiet long-polls on tables nothing was writing to
# occupied every slot the body bound exists for, and a ninth shape -- even a
# live poll on a table changing every 2s -- queued behind them. Measured: a
# row written every 2s arrived at the browser in batches of 7, 18-30s after
# it was written, while polling Electric directly delivered each write in
# 0.1s. The fix is a second, separately-sized bound for the idle wait, not a
# bigger MAX_INFLIGHT_SHAPES -- that number is still what one snapshot body
# measured, and raising it to cover idle long-polls would be sizing the body
# bound by a cost that has nothing to do with bodies.
MAX_INFLIGHT_LIVE = int(os.getenv("OPENDDIL_MAX_INFLIGHT_LIVE", "64"))

# A SHAPE THIS LARGE IS A FINDING, NOT A REQUEST. Logged per response so the
# read path has the dimension it lacked: nothing measured shape bytes, so a
# table that had quietly grown to 10 MiB looked exactly like one that had not
# until the process died. Warned, never refused -- a PEP that drops a shape
# because it is big turns a capacity problem into an availability one, and the
# operator needs the number, not a blank panel.
SHAPE_WARN_BYTES = int(os.getenv("OPENDDIL_SHAPE_WARN_BYTES", str(2 * 1024 * 1024)))

# Bounds CONCURRENCY, not queueing: a request that cannot get a slot waits. The
# alternative -- refusing -- makes a busy gateway indistinguishable from a
# broken one at the panel, which is the confusion this whole corpus exists to
# remove.
_inflight = threading.BoundedSemaphore(MAX_INFLIGHT_SHAPES)

# The live long-poll's own bound. Separate from _inflight on purpose -- see
# the comment above MAX_INFLIGHT_LIVE. Both bounds exist; this does not raise
# the body bound, it stops idle waits from borrowing its slots.
_inflight_live = threading.BoundedSemaphore(MAX_INFLIGHT_LIVE)

# --- how the subject is established ------------------------------------------
# TWO MODES, CHOSEN AT BOOT, MUTUALLY EXCLUSIVE. This is deliberately NOT a
# fallback inside one path, and the distinction is the whole point:
#
#   oidc    the browser completes an authorization-code flow against Keycloak
#           and holds an httpOnly session cookie. Tokens never reach
#           JavaScript. This is the mode a deployment runs.
#   header  the subject arrives in a trusted header. For the scripted suite
#           and for a PEP that is reachable only in-cluster.
#
# WHY THIS IS NOT `ALLOW_MOCK_AUTH` WEARING A HAT. That defect — inherited as
# a design constraint from dag-tools, where it was found and retired — was a
# branch INSIDE the real path that converted an authorizer exception into
# allow-by-default. A request could take the bypass at runtime without anyone
# choosing it.
#
# Here the mode is fixed before the first request. In `oidc` mode the header
# is NEVER READ: there is no input a caller can supply that selects the other
# mode, and no failure that falls back to it. A misconfigured OIDC refuses to
# start rather than degrading (see oidc.enabled()). Every decision record
# carries the mode that produced its subject, so the audit trail can never be
# ambiguous about which one was live.
try:
    AUTH_MODE = "oidc" if oidc.enabled() else "header"
except oidc.AuthError as _exc:
    print(f"FATAL: {_exc}", file=sys.stderr)
    raise SystemExit(2)

# The single searchable marker. An operator facing a sudden 403 storm gets ONE
# string to grep, and "authz is broken" cannot be confused with "authz denied
# you" — which is precisely the distinction a fail-open erases. Inherited
# verbatim in shape from dag-tools/central_gateway, whose ALLOW_MOCK_AUTH
# fail-open was found, fixed and retired with its interim; the constraint is
# stronger for coming from a demonstrated pattern with a demonstrated remedy.
DENY_MARKER = "TOPAZ AUTHZ DENIED"

# The egress pane's `kind` query param, forwarded verbatim when present and
# nowhere else validated before it reaches the pane. Short, opaque, no
# spaces or path-breaking characters -- the same shape as the kind registry
# itself uses (kinds.py), not a schema this gateway has any business
# knowing.
KIND_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_.-]{0,63}$")

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s [pep] %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("pep")

def _load_fault_catalog(path: str) -> dict | None:
    """The per-platform-variant catalog built by
    tools/fault_catalog/build_fault_catalog.py, or None when the route is
    simply not configured at this tier (path unset) or the file could not
    be read/parsed (fail closed, logged, same as an unset path -- a broken
    config must not silently look like "zero variants").

    `{"variants": {}}` is a valid, successfully-parsed catalog (zero
    variants) and is NOT None: the write route stays served even then,
    because reports without a fault code are always allowed."""
    if not path:
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            catalog = json.load(f)
    except Exception as exc:  # noqa: BLE001 -- a config read, not a request
        log.error("could not read OPENDDIL_FAULT_CATALOG_PATH=%s: %s", path, exc)
        return None
    if not isinstance(catalog, dict) or not isinstance(catalog.get("variants"), dict):
        log.error("OPENDDIL_FAULT_CATALOG_PATH=%s is not a fault-catalog object", path)
        return None
    return catalog


# OPENDDIL_FAULT_CODES_PATH served one global flat code list and let an
# MRAD be offered (and the gateway accept) another variant's codes, such as
# a transmission fault that does not exist on it. Retired in favour of
# OPENDDIL_FAULT_CATALOG_PATH, below. If the old env is still set, say so
# once at import and do not read it -- a silent ignore here would leave an
# operator who set the old var believing it still worked.
_legacy_fault_codes_path = os.getenv("OPENDDIL_FAULT_CODES_PATH", "")
if _legacy_fault_codes_path:
    log.error(
        "OPENDDIL_FAULT_CODES_PATH=%s is set but no longer read; it served one "
        "global fault-code list. Set OPENDDIL_FAULT_CATALOG_PATH instead, to a "
        "catalog generated per platform variant by "
        "openddil-demo/tools/fault_catalog/build_fault_catalog.py.",
        _legacy_fault_codes_path,
    )

# Read once at import, like every other upstream config in this file. Tests
# reach past this by setting the module attribute directly (see
# test_pep_cm_write.py) rather than by re-importing, because this module's
# fakes are started once per test module.
FAULT_CATALOG = _load_fault_catalog(os.getenv("OPENDDIL_FAULT_CATALOG_PATH", ""))

# The decision log — ADR-0029 Phase 5's mechanism.
#
# Topaz's own decision_logger is NOT configurable on this build (both
# `plugins` and `decision_logger` are rejected with "'config.Config' has
# invalid keys", and the co-located reasoning plane running the same
# generation carries no such block either). So there is no second, independent
# record and this one is the audit trail rather than defence in depth.
#
# It records EVERY decision, allow and deny alike. Loud on failure and silent
# on success is exactly the shape that leaves an authorization system with no
# positive audit trail — the asymmetry ADR-0029 explicitly says not to repeat.
decisions = logging.getLogger("pep.decision")


def new_decision_id() -> str:
    """A short, unique id minted per request and used in two places at once.

    IT IS THE SAME STRING THE USER SEES AND THE OPERATOR GREPS. A refusal
    screen that says "not authorized" and nothing else forces the person who
    was refused and the person who can explain it to correlate by timestamp,
    which fails the moment two people are refused in the same second. A
    reference id makes "why was I denied?" answerable in one query, and it is
    safe to show because it identifies a decision RECORD, not the data."""
    return secrets.token_hex(4).upper()


def record_decision(**fields) -> None:
    """One JSON line per decision: user, attributes, policy version, outcome,
    timestamp. Structured because the demo reads it back and an operator
    greps it, and those want the same record rather than two."""
    fields.setdefault("ts", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    fields.setdefault("auth_mode", AUTH_MODE)
    decisions.info("DECISION %s", json.dumps(fields, sort_keys=True))


# --- shape-handle binding ---------------------------------------------------
# THE BYPASS THAT LOOKS LIKE A CACHING DETAIL, AND IS AN AUTHORIZATION HOLE.
#
# A handle is Electric's id for a shape DEFINITION — table + where + columns
# — not a grant issued to one session. Electric mints the SAME handle for
# two requests that happen to carry the same table/where/columns, because
# from Electric's side those ARE the same shape; it has no idea a policy was
# ever involved. So a handle cannot be owned by a single session, and two
# sessions legitimately sharing one view (the same
# person open in two tabs, or two people with identical entitlements) are
# both entitled to resume it. Each session instead holds its OWN binding per
# view it was itself served.
#
# A binding is only ever created from that session's own ALLOWED request,
# stored under this session's principal paired with the view — (table,
# where, columns) — that request's forwarded predicate actually was: the
# composed client+policy predicate, not just the client's half of it. So
# presenting a handle back is accepted only where this exact session was
# itself served it for this exact view. A different session never matches.
# Neither does this same session asking about a different view: a different
# table, or the same table once its entitlements (and so its composed
# `where`) have changed.
#
# In-memory and per-process, which is honest about its limits: a gateway
# restart forgets every binding, and clients then re-request from offset -1.
# That fails CLOSED (an unknown handle is refused, not trusted), which is the
# correct direction for the failure. A multi-replica deployment needs shared
# storage here; Slice 1 runs one replica and says so rather than pretending.
_FeedKey = tuple[str, tuple[str, str, str]]
_feeds: dict[_FeedKey, list[str]] = {}
_feeds_lock = threading.Lock()

# Newest last; oldest dropped past this. Electric rotates the handle on a
# must-refetch, so a session that has been resuming the same view for a
# while accumulates more than one live handle for it, and all of them must
# keep working until the client itself moves off them.
MAX_HANDLES_PER_FEED = 8


# The binding key is PRINCIPAL (the session id in oidc mode, the subject in
# header mode), paired with the view, not the subject alone. Stricter, and
# for a reason worth stating: two concurrent sessions for one person are two
# separate grants, and a handle bound under one is not resumable under the
# other just because the person is the same. A session that has been logged
# out or has expired holds no bindings at all and so cannot resume a shape
# it opened, which is the behaviour a revoked session ought to have. An
# entitlement change does not need its own check here — it changes the
# composed `where`, which changes the view, which means the old bindings
# are simply for a view that no longer exists for this principal.
def bind_handle(principal: str, view: tuple[str, str, str], handle: str) -> None:
    if not handle:
        return
    key = (principal, view)
    with _feeds_lock:
        handles = _feeds.setdefault(key, [])
        if handle in handles:
            handles.remove(handle)
        handles.append(handle)
        del handles[:-MAX_HANDLES_PER_FEED]


def handle_belongs_to(principal: str, view: tuple[str, str, str], handle: str) -> bool:
    with _feeds_lock:
        handles = _feeds.get((principal, view), [])
    return handle in handles


# --- the PDP call -----------------------------------------------------------
class AuthzUnavailable(Exception):
    """Topaz could not be reached or did not answer usably.

    A SEPARATE TYPE FROM A DENY, on purpose. Both produce a 403 — the PEP
    fails closed — but they are different events and the decision log must
    keep them apart. Conflating them is how an outage gets read as a policy
    change, and how a policy change gets dismissed as an outage."""


def ask_topaz(subject: str) -> dict:
    """Ask the local Topaz what nations this subject may see.

    ONE call, ONE answer, ONE logged decision. A gateway that assembled a
    decision from several queries could log a combination that no single PDP
    evaluation ever produced."""
    body = json.dumps({
        "query": "x = data.openddil.releasability.decision",
        # `input` is a JSON *string*, not an object — Topaz's query API takes
        # it that way. Established by calling the running authorizer, not by
        # reading docs.
        "input": json.dumps({"subject": subject}),
        # REQUIRED, even though this policy authenticates nobody. Omitting it
        # returns `E30008 invalid argument: identity type UNKNOWN` — a 400,
        # which this gateway would correctly treat as PDP-unavailable and
        # refuse every request. IDENTITY_TYPE_NONE says "the caller has
        # already established who this is", which is exactly true here: the
        # gateway authenticates, the PDP decides.
        "identity_context": {"type": "IDENTITY_TYPE_NONE"},
    }).encode()
    req = urllib.request.Request(
        f"{TOPAZ}/api/v2/authz/query",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=TOPAZ_TIMEOUT) as resp:
            if resp.status != 200:
                raise AuthzUnavailable(f"topaz returned HTTP {resp.status}")
            payload = json.load(resp)
    except AuthzUnavailable:
        raise
    except urllib.error.HTTPError as exc:
        raise AuthzUnavailable(f"topaz HTTP {exc.code}: {exc.reason}") from exc
    except Exception as exc:  # noqa: BLE001 — EVERY exception is a deny
        raise AuthzUnavailable(f"topaz unreachable: {exc}") from exc

    # Topaz wraps an OPA query result. Anything unexpected in the shape is
    # UNAVAILABLE rather than an empty decision: a malformed answer read as
    # "no nations" would silently become a deny-all outage that looks exactly
    # like correct enforcement of a revoked account.
    try:
        bindings = payload["response"]["result"][0]["bindings"]["x"]
        nations = sorted(set(bindings["allowed_nations"]))
        return {
            "allow": bool(bindings["allow"]),
            "allowed_nations": nations,
            "policy_version": bindings["policy_version"],
            # WHICH ENTITLEMENTS CORPUS DECIDED. `policy_version` versions the
            # RULES; this versions the DATA, and they move independently — a
            # promotion changes one list in one file and touches no rule. A
            # record carrying only the rule version cannot answer "which
            # entitlements were in force when this person was allowed?", which
            # is the question an accreditor asks.
            #
            # `.get` with a default rather than a required key: an older
            # policy bundle that predates this field must not turn every
            # decision into an unparseable answer, which the PEP would
            # correctly report as a PDP outage — a policy upgrade should not
            # be able to look like an outage.
            "corpus_version": bindings.get("corpus_version", "unknown"),
            # THE SECOND AXIS — affordances within a tier, never rows. It is
            # carried here so the UI and the decision log agree about it, and
            # it is NOT consulted anywhere in this file: `allowed_nations` is
            # the whole of the filter. If that ever stops being true, it must
            # stop being true in the POLICY, not here.
            #
            # Defaulted like the rest, so an older bundle cannot turn every
            # decision into an unparseable answer the PEP reports as an
            # outage.
            "role": bindings.get("role", "observer"),
            "subject_known": bool(bindings["subject_known"]),
        }
    except Exception as exc:  # noqa: BLE001
        raise AuthzUnavailable(f"unparseable topaz answer: {exc}") from exc


# --- predicate composition --------------------------------------------------
def _sql_str(value: str) -> str:
    """Single-quoted SQL literal. Nations come from the PDP's answer, which
    comes from a PR-reviewed corpus, so this is defence in depth rather than
    the primary control — but a predicate builder that cannot quote is a
    predicate builder waiting for the day its input source changes."""
    return "'" + value.replace("'", "''") + "'"


# ---------------------------------------------------------------------------
# WHICH TABLES CAN BE PARTITIONED AT ALL (ADR-0029, table granularity)
# ---------------------------------------------------------------------------
# `policy_predicate` names `originator_nation` and `releasable_to`. A table
# without those columns cannot be filtered by it — and until 2026-09-06 the
# PEP forwarded the predicate anyway, Electric rejected the query, and the
# browser got a 502 that its panels rendered as "awaiting first emission".
#
# The behaviour was right by accident and wrong in how it said so: a rollup
# carrying no releasability labels CANNOT BE PARTITIONED, so it must not be
# served to anyone — the fully-entitled liaison included. That is
# deny-unlabeled operating at table granularity, and it deserves to be a
# stated decision with a cause rather than a SQL error three components
# away.
#
# The cause is `unlabelable`, and it is deliberately NOT phrased as a
# decision against the viewer. Nothing was decided about them: the data
# cannot be scoped, so there is no question to decide.
#
# EMPTY MEANS THE CHECK IS OFF, and that is announced at boot rather than
# assumed. A deployment that sets nothing keeps the pre-2026-09-06
# behaviour; the completeness gate is what verifies this list against the
# database, because a list in a chart and columns in a schema are two
# copies of one fact.
LABELED_TABLES = {
    t.strip() for t in os.getenv("OPENDDIL_LABELED_TABLES", "").split(",")
    if t.strip()
}

# ---------------------------------------------------------------------------
# THREE CLASSES, NOT TWO — because "unlabelable" was conflating four things
# ---------------------------------------------------------------------------
# The first cut of this refused every table without nation labels, which was
# correct for rollups and WRONG for infrastructure state: `edge_buffer_status`
# holds bridge lag and a severance flag, no asset data at all, and refusing it
# removed HQ's severance indicator — the very thing a severance recording
# exists to show. A single bucket called "cannot be partitioned" was hiding
# the fact that the tables in it could not be partitioned FOR DIFFERENT
# REASONS, and only one of those reasons implies "serve to nobody".
#
#   nation-filtered  carries originator_nation / releasable_to. The ADR-0029
#                    predicate applies. (LABELED_TABLES above.)
#
#   role-served      carries no asset data, so there is nothing to partition
#                    BY. Served to an authenticated subject with no nation
#                    filter. This is a DECLARED POSITION, not an oversight:
#                    infrastructure topology is visible to authenticated
#                    operators. Widening it to anything asset-bearing would
#                    be a bypass wearing this class's name.
#
#   subject-scoped   partitioned by WHO, not by nation. A subject sees their
#                    own rows; a subject whose role grants oversight sees all.
#                    `audit_log` is the case: your decisions are yours, an
#                    auditor's remit is everyone's.
#
# Anything in none of the three is refused, and that refusal is now a
# statement about one specific class of data rather than about everything the
# read path had not got to yet.
ROLE_SERVED_TABLES = {
    t.strip() for t in os.getenv("OPENDDIL_ROLE_SERVED_TABLES", "").split(",")
    if t.strip()
}

# "table:column" pairs — the column holding the subject a row belongs to.
SUBJECT_SCOPED_TABLES = {
    t.split(":", 1)[0].strip(): t.split(":", 1)[1].strip()
    for t in os.getenv("OPENDDIL_SUBJECT_SCOPED_TABLES", "").split(",")
    if t.strip() and ":" in t
}

# Roles that see every row of a subject-scoped table rather than their own.
OVERSIGHT_ROLES = {
    r.strip() for r in os.getenv("OPENDDIL_OVERSIGHT_ROLES", "auditor").split(",")
    if r.strip()
}

# --- the WAN control route ---------------------------------------------------
# The frontend's WAN-link toggle used to reach the DDIL sever mechanism's
# HTTP API directly (frontend/nginx.conf's old /proxies/ location) with no
# session and no role check -- anyone who could reach the frontend could cut
# or restore the uplink. This route puts that control behind the same
# subject-then-Topaz sequence every other write in this file goes through.
# Empty URL means "not wired at this tier", the same meaning
# CM_INTAKE_URL/EGRESS_PANE/MANUAL_QA_URL being unset already carry.
WAN_CONTROL_URL = os.getenv("OPENDDIL_WAN_CONTROL_URL", "").strip().rstrip("/")


def _parse_roles_csv(value: str) -> frozenset[str]:
    """Comma-separated roles -> a frozenset, stripped, empties dropped.

    A standalone function (rather than an inline comprehension like
    OVERSIGHT_ROLES above) so the parsing rule can be exercised directly,
    without re-importing this module under a different environment."""
    return frozenset(r.strip() for r in value.split(",") if r.strip())


# A role, not a nation entitlement -- severing the uplink is an affordance
# within a tier, not a question of which rows a subject may see, so this is
# checked against `role` directly rather than folded into ask_topaz's
# allow/deny.
WAN_CONTROL_ROLES = _parse_roles_csv(os.getenv("OPENDDIL_WAN_CONTROL_ROLES", "supervisor"))

# OPENDDIL_WAN_UPLINK: this PEP's own uplink, in toxiproxy proxy-name terms.
# `/proxies/uplink` resolves to it, so the frontend never needs to learn
# which tier it's served from -- the origin decides. Root PEP: "hq-link".
# Tier PEP: "uplink-<tier id>" for a tier that has one. Unset means
# "hq-link", which is today's (pre-P5) single link.
WAN_UPLINK = os.getenv("OPENDDIL_WAN_UPLINK", "hq-link").strip() or "hq-link"

# OPENDDIL_WAN_LINKS: proxy names this PEP may address by their EXACT name
# (comma-separated), in addition to "uplink" itself. Root: every uplink plus
# "hq-link". Tier: its own uplink only. Unset means {"hq-link"} alone, so a
# frontend that still calls /proxies/hq-link directly keeps working.
WAN_LINKS = _parse_roles_csv(os.getenv("OPENDDIL_WAN_LINKS", "hq-link"))


def _resolve_wan_proxy_name(path: str) -> str | None:
    """`/proxies/<name>` -> the toxiproxy proxy name to forward to, or None
    if this exact path isn't a permitted WAN-control route.

    `/proxies/uplink` resolves through WAN_UPLINK -- this tier's own link.
    Any other name is forwarded only when it's an EXACT match (no
    sub-paths: `/proxies/uplink/toxics` is not this route, same as
    `/proxies/hq-link/toxics` never was) for a name in WAN_LINKS.
    """
    prefix = "/proxies/"
    if not path.startswith(prefix):
        return None
    remainder = path[len(prefix):]
    if not remainder or "/" in remainder:
        return None
    if remainder == "uplink":
        return WAN_UPLINK
    if remainder in WAN_LINKS:
        return remainder
    return None


# --- the exercise control route ----------------------------------------------
# GET /exercise/status and POST /exercise/op/<op>, forwarded to
# exercise/control.py -- never to the adapter or the simulator directly (see
# _handle_exercise_control). Empty URL means "not wired at this tier", same
# meaning WAN_CONTROL_URL/CM_INTAKE_URL/EGRESS_PANE being unset already
# carry: the routes do not exist, 404, exactly like today.
EXERCISE_CONTROL_URL = os.getenv("OPENDDIL_EXERCISE_CONTROL_URL", "").strip().rstrip("/")

# Same role-gating discipline as WAN_CONTROL_ROLES: an affordance, checked
# against `role` directly, not folded into ask_topaz's allow/deny.
EXERCISE_CONTROL_ROLES = _parse_roles_csv(os.getenv("OPENDDIL_EXERCISE_CONTROL_ROLES", "supervisor"))


def table_class(table: str) -> str:
    """'nation' | 'role' | 'subject' | 'refused'.

    Checked before any subject is resolved: which class a table belongs to is
    a property of the DATA and is the same for everyone. What the class then
    DOES with a subject differs, which is why this returns a class rather
    than a decision.
    """
    if not LABELED_TABLES and not ROLE_SERVED_TABLES and not SUBJECT_SCOPED_TABLES:
        return "nation"          # not configured — pre-2026-09-06 behaviour
    if table in LABELED_TABLES:
        return "nation"
    if table in ROLE_SERVED_TABLES:
        return "role"
    if table in SUBJECT_SCOPED_TABLES:
        return "subject"
    return "refused"


def may_serve_table(table: str, labeled: set[str] | None = None) -> bool:
    """False when the table cannot be partitioned, and so must not be served.

    A function rather than an inline test so the rule can be exercised
    directly — this is the only place the PEP refuses data on a property of
    the DATA rather than of the subject, and that asymmetry is worth being
    able to assert.
    """
    if labeled is not None:
        # Explicit set — used by the tests to pin the rule without touching
        # module state.
        return (not labeled) or table in labeled
    return table_class(table) != "refused"


def policy_predicate(nations: list[str]) -> str:
    """The Topaz decision, rendered as a shape filter. Nothing else.

    Two clauses, matching ADR-0029 Phase 4:
        originator_nation = ANY(user_nations)
        OR user_nation    = ANY(releasable_to)

    DENY-UNLABELED IS ASSERTED, NOT INHERITED. A NULL originator_nation does
    not equal anything and a NULL array overlaps nothing, so SQL would drop
    unlabelled rows on its own — but relying on that leaves the property
    undeclared, resting on array-overlap semantics someone could later change
    without realising what they were changing. The IS NOT NULL terms make the
    intent explicit and testable, and they cost nothing.
    """
    if not nations:
        # An entitled-to-nothing subject gets a predicate that matches
        # nothing — deliberately, rather than an omitted filter. "No
        # entitlements" and "no filter" are one keystroke apart and opposite
        # in meaning.
        return "false"
    lst = ", ".join(_sql_str(n) for n in nations)
    arr = "ARRAY[" + ", ".join(_sql_str(n) for n in nations) + "]::text[]"
    return (
        "(originator_nation IS NOT NULL AND originator_nation IN (" + lst + "))"
        " OR "
        "(releasable_to IS NOT NULL AND releasable_to && " + arr + ")"
    )


def compose(client_where: str | None, policy_where: str) -> str:
    """(client) AND (policy) — never the client's alone, never replaced.

    A client-supplied `where` may only NARROW the set. Both sides are
    parenthesised because a client clause containing a top-level OR would
    otherwise bind loosely and widen past the policy — the single most
    likely way this composition goes wrong, and invisible in a URL."""
    if not client_where or not client_where.strip():
        return policy_where
    return "(" + client_where + ") AND (" + policy_where + ")"


# --- the CM write path's own visibility check --------------------------------
class ElectricUnavailable(Exception):
    """The one bounded Electric shape read behind the CM visibility check
    failed. A separate type from "zero rows", for the same reason
    AuthzUnavailable is separate from a deny: one is an outage, the other is
    a correctly scoped answer that this asset is not visible here."""


def read_visible_row(table: str, asset_id: str, nations: list[str]) -> dict | None:
    """One bounded, non-streaming read of `table`, filtered through the SAME
    machinery the read path uses -- `compose`, `policy_predicate`,
    `_sql_str` -- not a second decision about who may see what. Zero rows
    means "not visible here", and the caller must read it that way rather
    than as "does not exist": this write path never confirms or denies that
    an asset id is real to someone it has not been shown to.

    Kept behind one small function on purpose, so another write path
    can stub this one read in its own tests without re-deriving it.

    Electric answers an `offset=-1` GET with the snapshot taken when the
    shape was FIRST CREATED, not with the table's live state -- a shape is
    cached, so a later request for the same table+where gets that same
    original snapshot back. Anything written since then lives only in the
    shape's log, reached by following `electric-handle`/`electric-offset`.
    This function keeps following that log, with no `live=true`, until a
    message carries `headers.control == "up-to-date"`, applying each insert,
    update (a merge -- an update may carry only the changed columns) and
    delete in order, so the row returned reflects what Electric has actually
    replicated rather than a point-in-time snapshot that may be hours stale.
    """
    where = compose(f"asset_id = {_sql_str(asset_id)}", policy_predicate(nations))
    base_params = {"table": table, "where": where}
    deadline = time.monotonic() + 10
    handle: str | None = None
    offset: str | None = None
    restarted = False
    rows: dict[str, dict] = {}

    for _attempt in range(20):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ElectricUnavailable("electric visibility read exceeded its time budget")
        params = dict(base_params)
        if handle is None:
            params["offset"] = "-1"
        else:
            params["handle"] = handle
            params["offset"] = offset
        url = f"{ELECTRIC}/v1/shape?" + urllib.parse.urlencode(params)
        try:
            with urllib.request.urlopen(url, timeout=min(10, remaining)) as resp:
                status = resp.status
                resp_headers = resp.headers
                body = resp.read()
        except urllib.error.HTTPError as exc:
            if exc.code == 409:
                status, resp_headers, body = 409, exc.headers, b""
            else:
                raise ElectricUnavailable(f"electric returned HTTP {exc.code}") from exc
        except Exception as exc:  # noqa: BLE001 -- a transport fault, not a deny
            raise ElectricUnavailable(f"electric unreachable: {exc}") from exc

        if status == 409:
            if restarted:
                raise ElectricUnavailable("electric returned HTTP 409 twice")
            restarted = True
            handle, offset, rows = None, None, {}
            continue
        if status != 200:
            raise ElectricUnavailable(f"electric returned HTTP {status}")

        try:
            messages = json.loads(body)
        except Exception as exc:  # noqa: BLE001
            raise ElectricUnavailable("unexpected shape response shape") from exc
        if not isinstance(messages, list):
            raise ElectricUnavailable("unexpected shape response shape")

        up_to_date = False
        must_refetch = False
        for msg in messages:
            if not isinstance(msg, dict):
                continue
            msg_headers = msg.get("headers")
            control = msg_headers.get("control") if isinstance(msg_headers, dict) else None
            if control == "up-to-date":
                up_to_date = True
                continue
            if control == "must-refetch":
                must_refetch = True
                break
            key = msg.get("key") or asset_id
            operation = msg_headers.get("operation") if isinstance(msg_headers, dict) else None
            # A delete is honoured whether or not it carries a value: skipping
            # it would leave a row visible that the shape has dropped.
            if operation == "delete":
                rows.pop(key, None)
                continue
            value = msg.get("value")
            if not isinstance(value, dict):
                continue
            if operation == "update" and key in rows:
                rows[key] = {**rows[key], **value}
            else:
                rows[key] = dict(value)

        if must_refetch:
            if restarted:
                raise ElectricUnavailable("electric sent must-refetch twice")
            restarted = True
            handle, offset, rows = None, None, {}
            continue

        if up_to_date:
            return next(iter(rows.values()), None)

        new_handle = resp_headers.get("electric-handle") or resp_headers.get("electric-shape-id")
        new_offset = resp_headers.get("electric-offset")
        if not new_handle or new_offset is None:
            raise ElectricUnavailable("electric response missing handle/offset header")
        handle, offset = new_handle, new_offset

    raise ElectricUnavailable("electric shape did not reach up-to-date within 20 requests")


def read_cm_visibility_row(asset_id: str, nations: list[str]) -> dict | None:
    """Thin wrapper kept for existing tests/stubs: the asset_cm_state read,
    exactly as before `read_visible_row` grew a `table` argument so the
    fault-code route could read `platform_variant` from telemetry_latest_state through the same
    machinery."""
    return read_visible_row("asset_cm_state", asset_id, nations)


def _component_installed(row: dict, component: str) -> bool:
    """True when `component` names a slot_id in the row's `installed` list.
    Electric may hand back a jsonb column already decoded or still as a JSON
    string, depending on how the shape serialised it; both are accepted."""
    installed = row.get("installed") if isinstance(row, dict) else None
    if isinstance(installed, str):
        try:
            installed = json.loads(installed)
        except ValueError:
            installed = []
    if not isinstance(installed, list):
        return False
    return any(isinstance(item, dict) and item.get("slot_id") == component
               for item in installed)


# asset_id has no existing pattern elsewhere in this file; component and
# fault_code share one, since both are short opaque identifiers rather than
# free text.
_ASSET_ID_RE = re.compile(r"^[A-Za-z0-9:._-]{1,64}$")
_COMPONENT_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")


def _parse_discrepancy_body(payload) -> dict:
    """The four validated fields, or raise ValueError(reason).

    Unknown keys are ignored. `reported_by`, `recorded_by` and `source` are
    never read here -- not validated, not ignored-with-a-warning, simply
    never looked up -- because the only source this route trusts for who
    reported something is the authenticated subject, and the only source for
    where a report came from is OPENDDIL_REPORT_SOURCE.
    """
    if not isinstance(payload, dict):
        raise ValueError("body must be a JSON object")
    asset_id = payload.get("asset_id")
    component = payload.get("component")
    # Optional: absent or "" means "not listed" -- the reporter could not
    # find a matching code in the fault-isolation manual (or there is none
    # for this variant). Only a non-empty value is validated against the
    # shared identifier pattern; a present-but-wrong-shaped value is still
    # a 400, not silently treated as "not listed".
    fault_code = payload.get("fault_code", "")
    description = payload.get("description")
    if not isinstance(asset_id, str) or not _ASSET_ID_RE.match(asset_id):
        raise ValueError("invalid asset_id")
    if not isinstance(component, str) or not _COMPONENT_RE.match(component):
        raise ValueError("invalid component")
    if not isinstance(fault_code, str):
        raise ValueError("invalid fault_code")
    if fault_code and not _COMPONENT_RE.match(fault_code):
        raise ValueError("invalid fault_code")
    if not isinstance(description, str) or not (1 <= len(description) <= 500):
        raise ValueError("invalid description")
    return {"asset_id": asset_id, "component": component,
            "fault_code": fault_code, "description": description}


def _parse_manual_ask_body(payload) -> dict:
    """asset_id, question, dmcs -- or raise ValueError(reason).

    asset_id is validated against THIS FILE's own _ASSET_ID_RE, the one
    asset-id pattern it has (asset_id is opaque and never parsed beyond
    matching that one pattern). The question's length and the DMCs' shape
    are manual_qa's own concern. Citation enforcement is a separate step
    entirely, applied to the upstream's reply, not to this request -- see
    manual_qa.enforce_citations.
    """
    if not isinstance(payload, dict):
        raise ValueError("body must be a JSON object")
    asset_id = payload.get("asset_id")
    question = payload.get("question")
    dmcs = payload.get("dmcs")
    if not isinstance(asset_id, str) or not _ASSET_ID_RE.match(asset_id):
        raise ValueError("invalid asset_id")
    try:
        manual_qa.validate_question(question)
        manual_qa.validate_dmcs(dmcs)
    except manual_qa.ManualQaError as exc:
        raise ValueError(str(exc)) from exc
    return {"asset_id": asset_id, "question": question, "dmcs": dmcs}


def _cm_record(*, allowed: bool, subject: str, asset_id: str | None,
               fault_code: str | None, event_id: str | None, reason: str) -> str:
    """The one decision line for every /cm/discrepancy outcome from the PDP
    call on, in the field names this write path's audit trail commits to."""
    decision_id = new_decision_id()
    record_decision(decision_id=decision_id, allowed=allowed,
                    subject=subject or None, asset_id=asset_id,
                    fault_code=fault_code, event_id=event_id, reason=reason,
                    resource="cm:discrepancy")
    return decision_id


# 1024 bytes, fixed rather than configurable -- the body is one key and one
# bool, and a route that only ever sends {"enabled": true|false} does not
# need a sizing knob.
MAX_WAN_CONTROL_BODY_BYTES = 1024


def _parse_wan_control_body(payload) -> bool:
    """The validated `enabled` flag, or raise ValueError(reason).

    EXACTLY one key, `enabled`, a bool -- not "truthy", not coercible from a
    string. A stray extra key or a string "false" is refused rather than
    guessed at, the same discipline _parse_discrepancy_body applies to the
    CM write path."""
    if not isinstance(payload, dict) or set(payload) != {"enabled"}:
        raise ValueError("body must be a JSON object with exactly one key: enabled")
    enabled = payload["enabled"]
    if not isinstance(enabled, bool):
        raise ValueError("enabled must be a bool")
    return enabled


# --- the proxy --------------------------------------------------------------
PASSTHROUGH_PARAMS = {"table", "offset", "handle", "live", "cursor", "columns", "replica"}


def _shape_slot(params: dict[str, list[str]]) -> threading.BoundedSemaphore:
    """Which bound a transfer counts against -- see MAX_INFLIGHT_LIVE. A
    request is a live long-poll only when it says so explicitly; anything
    else (absent, blank, misspelled) is a snapshot as far as this is
    concerned, which is the side to be wrong on since that bound is sized
    for a resident body."""
    live = (params.get("live") or [""])[0]
    return _inflight_live if live.strip().lower() == "true" else _inflight


class Pep(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quieter access log; decisions are logged
        log.debug(fmt, *args)

    def _send(self, status: int, body: bytes, headers: list | None = None) -> None:
        self.send_response(status)
        for k, v in (headers or []):
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _deny(self, cause: str, *, subject: str, resource: str, status: int = 403,
              upstream: str = "", headers: list | None = None,
              marker: str = DENY_MARKER) -> None:
        """Every non-200 and every exception lands here. There is no other
        exit from an authorization failure, and no branch that converts one
        into an allow.

        `marker` exists because the default one NAMES TOPAZ, and not every
        refusal came from Topaz. An `unlabelable` table is refused before the
        PDP is consulted at all — logging that as "TOPAZ AUTHZ DENIED" would
        attribute a decision to an authority that never saw the request, and
        an operator grepping the decision log would go and read Topaz's
        policy looking for a rule that does not exist.
        """
        ref = new_decision_id()
        log.warning("%s ref=%s cause=%s user=%s resource=%s upstream=%s",
                    marker, ref, cause, subject or "<none>", resource,
                    upstream or "-")
        record_decision(decision_id=ref, outcome="deny", cause=cause,
                        subject=subject or None, resource=resource,
                        upstream_status=upstream or None)
        # `reference` is the string the refusal screen shows, and it is the
        # SAME string the operator greps. A refusal that says only "not
        # authorized" forces the person refused and the person who can
        # explain it to correlate by timestamp, which fails the moment two
        # people are refused in the same second. Safe to show, because it
        # identifies a decision RECORD and carries nothing about the data.
        body = json.dumps({"error": DENY_MARKER, "cause": cause,
                           "reference": ref}).encode()
        self._send(status, body,
                   [("Content-Type", "application/json")] + (headers or []))

    # --- CM write path ----------------------------------------------------------
    def _content_length(self) -> int:
        try:
            return int(self.headers.get("Content-Length", 0) or 0)
        except ValueError:
            return 0

    def _drain_body(self) -> None:
        length = self._content_length()
        if length:
            try:
                self.rfile.read(length)
            except Exception:  # noqa: BLE001 -- best-effort; a deny follows regardless
                pass

    def _content_type_is_json(self) -> bool:
        # Parameters such as charset are allowed; only the media type is
        # checked, exactly as a browser's own `fetch` would set it for a
        # same-origin JSON POST.
        ctype = self.headers.get("Content-Type", "")
        return ctype.split(";", 1)[0].strip().lower() == "application/json"

    def _origin_is_cross_site(self) -> bool:
        # A MISSING Origin is allowed: a same-origin `fetch` may omit it, and
        # a server-side caller has no browser origin to send. Defence in
        # depth, not the only control -- the session cookie's own SameSite
        # (OPENDDIL_COOKIE_SAMESITE) is the first line.
        origin = self.headers.get("Origin")
        if not origin:
            return False
        # Hostnames only: the edge proxy forwards `Host: $host`, which drops
        # the port, while a browser's Origin keeps a non-default one.
        host = urllib.parse.urlsplit("//" + self.headers.get("Host", "")).hostname or ""
        origin_host = urllib.parse.urlsplit(origin).hostname or ""
        return origin_host != host

    def _cm_deny(self, status: int, reason: str, *, subject: str,
                 asset_id: str | None = None, fault_code: str | None = None,
                 event_id: str | None = None, headers: list | None = None) -> None:
        decision_id = _cm_record(allowed=False, subject=subject, asset_id=asset_id,
                                 fault_code=fault_code, event_id=event_id, reason=reason)
        log.warning("CM WRITE REFUSED ref=%s reason=%s subject=%s asset_id=%s",
                    decision_id, reason, subject or "<none>", asset_id or "-")
        body = json.dumps({"error": "cm discrepancy refused", "cause": reason,
                           "reference": decision_id}).encode()
        self._send(status, body, [("Content-Type", "application/json")] + (headers or []))

    def _cm_allow(self, *, subject: str, asset_id: str, fault_code: str,
                  event_id: str) -> None:
        _cm_record(allowed=True, subject=subject, asset_id=asset_id,
                  fault_code=fault_code, event_id=event_id, reason="recorded")
        self._send(202, json.dumps({"event_id": event_id}).encode(),
                   [("Content-Type", "application/json")])

    def _handle_cm_fault_codes(self, parsed) -> None:
        # Not configured at this tier -> the route is absent. Checked before
        # anything else, same as the write path: whether the route exists is
        # a fact about the deployment, not the request.
        if FAULT_CATALOG is None:
            self._deny("fault catalog not configured at this tier", subject="",
                       resource=parsed.path, status=404,
                       marker="GATEWAY REFUSED (PRE-PDP)")
            return
        try:
            subject, _principal, _session = self._resolve_principal()
        except oidc.AuthError:
            self._send(401, json.dumps({"error": "no authenticated subject"}).encode(),
                       [("Content-Type", "application/json")])
            return

        params = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
        asset_id = (params.get("asset_id") or [""])[0]
        if not asset_id:
            self._send(400, json.dumps({"error": "asset_id is required"}).encode(),
                       [("Content-Type", "application/json")])
            return

        try:
            decision = ask_topaz(subject)
        except AuthzUnavailable as exc:
            self._deny(f"PDP unavailable: {exc}", subject=subject,
                       resource=parsed.path, status=503)
            return
        if not decision["allow"]:
            cause = ("subject not in the entitlements corpus"
                     if not decision["subject_known"]
                     else "subject holds no nation entitlements")
            self._deny(cause, subject=subject, resource=parsed.path, status=403)
            return

        try:
            row = read_visible_row("telemetry_latest_state", asset_id,
                                   decision["allowed_nations"])
        except ElectricUnavailable as exc:
            self._deny(f"electric unavailable: {exc}", subject=subject,
                       resource=parsed.path, status=502)
            return
        if row is None:
            self._deny("asset not visible at this tier", subject=subject,
                       resource=parsed.path, status=404,
                       marker="GATEWAY REFUSED (PRE-PDP)")
            return

        platform_variant = row.get("platform_variant")
        variant_entry = FAULT_CATALOG.get("variants", {}).get(platform_variant) if platform_variant else None
        manual = variant_entry.get("manual") if variant_entry else None
        codes = variant_entry.get("codes", []) if variant_entry else []

        # No global list is ever returned -- an unmapped/unknown variant
        # gets zero codes here, not the codes of some OTHER variant.
        body = {
            "asset_id": asset_id,
            "platform_variant": platform_variant,
            "manual": manual,
            "codes": codes,
        }
        self._send(200, json.dumps(body).encode(),
                   [("Content-Type", "application/json"), ("Cache-Control", "no-store")])

    def _handle_cm_discrepancy(self, parsed) -> None:
        path = parsed.path

        # Not configured at this tier -> the route is absent, exactly as an
        # unset EGRESS_PANE gives 404. Checked before anything else: whether
        # the route exists is a fact about the deployment, not the request.
        if FAULT_CATALOG is None or not CM_INTAKE_URL:
            self._drain_body()
            self._deny("cm write route not configured at this tier", subject="",
                       resource=path, status=404, marker="GATEWAY REFUSED (PRE-PDP)")
            return

        # --- CSRF defence in depth, checked before the body and before Topaz.
        if not self._content_type_is_json():
            self._drain_body()
            self._deny("Content-Type must be application/json", subject="",
                       resource=path, status=415, marker="GATEWAY REFUSED (PRE-PDP)")
            return
        if self._origin_is_cross_site():
            self._drain_body()
            self._deny("cross-site origin", subject="", resource=path, status=403,
                       marker="GATEWAY REFUSED (PRE-PDP)")
            return

        length = self._content_length()
        if length > MAX_CM_BODY_BYTES:
            # NOT drained -- a body this size is refused, not absorbed. The
            # connection closes rather than desyncing a kept-alive socket on
            # whatever bytes were never read.
            self._deny("body too large", subject="", resource=path, status=413,
                       headers=[("Connection", "close")],
                       marker="GATEWAY REFUSED (PRE-PDP)")
            return
        raw = self.rfile.read(length) if length else b""

        try:
            payload = json.loads(raw or b"{}")
        except ValueError:
            self._send(400, json.dumps({"error": "malformed JSON body"}).encode(),
                       [("Content-Type", "application/json")])
            return

        # Step 1: the principal. No session -> 401, nothing sent upstream --
        # and, deliberately, no decision recorded: there is no subject yet
        # for a decision to be about. See step 2 onward for where recording
        # starts.
        try:
            subject, _principal, _session = self._resolve_principal()
        except oidc.AuthError:
            self._send(401, json.dumps({"error": "no authenticated subject"}).encode(),
                       [("Content-Type", "application/json")])
            return

        asset_id_hint = payload.get("asset_id") if isinstance(payload, dict) else None
        fault_code_hint = payload.get("fault_code") if isinstance(payload, dict) else None

        # Step 2: Topaz, applied verbatim -- this file contains no
        # authorization logic.
        try:
            decision = ask_topaz(subject)
        except AuthzUnavailable as exc:
            self._cm_deny(503, f"PDP unavailable: {exc}", subject=subject,
                          asset_id=asset_id_hint, fault_code=fault_code_hint)
            return
        if not decision["allow"]:
            cause = ("subject not in the entitlements corpus"
                     if not decision["subject_known"]
                     else "subject holds no nation entitlements")
            self._cm_deny(403, cause, subject=subject, asset_id=asset_id_hint,
                          fault_code=fault_code_hint)
            return

        # Step 3: validate the body.
        try:
            fields = _parse_discrepancy_body(payload)
        except ValueError as exc:
            self._cm_deny(400, str(exc), subject=subject, asset_id=asset_id_hint,
                          fault_code=fault_code_hint)
            return
        asset_id = fields["asset_id"]
        component = fields["component"]
        fault_code = fields["fault_code"]
        description = fields["description"]

        # Step 4: visibility and slot check, through the read path's own
        # predicate -- never a second decision about who may see the asset.
        try:
            row = read_cm_visibility_row(asset_id, decision["allowed_nations"])
        except ElectricUnavailable as exc:
            self._cm_deny(502, f"electric unavailable: {exc}", subject=subject,
                          asset_id=asset_id, fault_code=fault_code)
            return
        if row is None:
            self._cm_deny(404, "asset not visible at this tier", subject=subject,
                          asset_id=asset_id, fault_code=fault_code)
            return
        if not _component_installed(row, component):
            self._cm_deny(400, "component is not an installed slot on this asset",
                          subject=subject, asset_id=asset_id, fault_code=fault_code)
            return

        # Step 5: a fault code is optional -- "" or absent means "not
        # listed" (the reporter could not find a matching code, or there is
        # none for this variant). When one IS given, it must belong to this
        # asset's own variant's manual, and to the submitted component.
        # Severity then comes from that catalog entry; with no code, the
        # existing default for a report (empty -- cm-service applies its
        # own default when severity is not supplied).
        severity = ""
        if fault_code:
            try:
                variant_row = read_visible_row("telemetry_latest_state", asset_id,
                                               decision["allowed_nations"])
            except ElectricUnavailable as exc:
                self._cm_deny(502, f"electric unavailable: {exc}", subject=subject,
                              asset_id=asset_id, fault_code=fault_code)
                return
            platform_variant = variant_row.get("platform_variant") if variant_row else None
            variant_entry = (FAULT_CATALOG.get("variants", {}).get(platform_variant)
                             if platform_variant else None)
            codes = variant_entry.get("codes", []) if variant_entry else []
            entry = next((c for c in codes if c.get("code") == fault_code), None)
            if entry is None:
                self._cm_deny(
                    400,
                    f"fault code not in the fault-isolation manual for variant {platform_variant}",
                    subject=subject, asset_id=asset_id, fault_code=fault_code,
                )
                return
            if entry.get("component") != component:
                self._cm_deny(
                    400, f"fault code belongs to component {entry.get('component')}",
                    subject=subject, asset_id=asset_id, fault_code=fault_code,
                )
                return
            severity = entry.get("severity", "")

        # Step 6: build the CmEvent -- proto3 JSON field names, exactly as
        # json_format.Parse expects them on the other end.
        event_id = str(uuid.uuid4())
        event = {
            "eventId": event_id,
            "assetId": asset_id,
            "recordedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "recordedBy": subject,
            "manualDiscrepancy": {
                "description": description,
                "severity": severity,
                "source": REPORT_SOURCE,
                "component": component,
                "faultCode": fault_code,
            },
        }
        event_body = json.dumps(event).encode()

        # Step 7: hand it to cm-intake. A non-2xx or an exception is an
        # upstream fault, never a deny -- authorization was never in
        # question here, only whether the write landed.
        req = urllib.request.Request(
            CM_INTAKE_URL, data=event_body,
            headers={"Content-Type": "application/json"}, method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=15):
                pass  # 2xx -- urlopen raises HTTPError for anything else
        except urllib.error.HTTPError as exc:
            self._cm_deny(502, f"cm-intake returned HTTP {exc.code}", subject=subject,
                          asset_id=asset_id, fault_code=fault_code, event_id=event_id)
            return
        except Exception as exc:  # noqa: BLE001 -- a transport fault, not a deny
            self._cm_deny(502, f"cm-intake unreachable: {exc}", subject=subject,
                          asset_id=asset_id, fault_code=fault_code, event_id=event_id)
            return

        # Step 9: recorded.
        self._cm_allow(subject=subject, asset_id=asset_id, fault_code=fault_code,
                       event_id=event_id)

    def _handle_manual_ask(self, parsed) -> None:
        """Serve POST /manual/ask: a maintainer's question, scoped to the
        DMCs in view, delegated to the manual question service and answered
        only when the reply's citations stay inside that scope (see
        manual_qa.enforce_citations).

        Topaz is asked the SAME single question every other route asks --
        which nations this subject may see -- through ask_topaz, with no
        second rule for this resource. `resource="manual-ask"` below is a
        label for the decision log, exactly as `resource=table` and
        `resource=f"egress:{dest}"` already are for the read path and the
        egress route; it is never an input Topaz is asked about, because
        this policy makes one decision and does not vary it by resource
        (see policy/releasability.rego's own header on why role does not
        gate rows -- a resource-specific rule here would be the same kind
        of second, unreviewed authorization decision that file rules out).
        """
        path = parsed.path

        # Not configured at this tier -> the route is absent, exactly as an
        # unset CM_INTAKE_URL/EGRESS_PANE gives 404. Checked before anything
        # else: whether the upstream exists is a fact about the deployment,
        # not the request.
        if not MANUAL_QA_URL:
            self._drain_body()
            self._deny("manual question service not configured at this tier",
                       subject="", resource="manual-ask", status=404,
                       marker="GATEWAY REFUSED (PRE-PDP)")
            return

        length = self._content_length()
        if length > MAX_MANUAL_ASK_BODY_BYTES:
            self._deny("body too large", subject="", resource="manual-ask",
                       status=413, headers=[("Connection", "close")],
                       marker="GATEWAY REFUSED (PRE-PDP)")
            return
        raw = self.rfile.read(length) if length else b""

        try:
            payload = json.loads(raw or b"{}")
        except ValueError:
            self._send(400, json.dumps({"error": "malformed JSON body"}).encode(),
                       [("Content-Type", "application/json")])
            return

        # Step 1: the principal. No session -> 401, nothing sent upstream,
        # and no decision recorded -- there is no subject yet for a
        # decision to be about, same as the CM write path.
        try:
            subject, _principal, _session = self._resolve_principal()
        except oidc.AuthError:
            self._send(401, json.dumps({"error": "no authenticated subject"}).encode(),
                       [("Content-Type", "application/json")])
            return

        # Step 2: Topaz, applied verbatim -- this file contains no
        # authorization logic.
        try:
            decision = ask_topaz(subject)
        except AuthzUnavailable as exc:
            self._deny(f"PDP unavailable: {exc}", subject=subject,
                       resource="manual-ask", status=503)
            return
        if not decision["allow"]:
            cause = ("subject not in the entitlements corpus"
                     if not decision["subject_known"]
                     else "subject holds no nation entitlements")
            self._deny(cause, subject=subject, resource="manual-ask", status=403)
            return

        # Step 3: validate the body shape -- asset_id against this file's
        # own _ASSET_ID_RE, question length and DMC shape against
        # manual_qa's.
        try:
            fields = _parse_manual_ask_body(payload)
        except ValueError as exc:
            self._deny(str(exc), subject=subject, resource="manual-ask", status=400)
            return
        asset_id = fields["asset_id"]
        question = fields["question"]
        dmcs = fields["dmcs"]

        # Step 4: the asset must be visible to this subject -- the CM write
        # path's own visibility read, never a second decision about who may
        # see it.
        try:
            row = read_cm_visibility_row(asset_id, decision["allowed_nations"])
        except ElectricUnavailable as exc:
            self._deny(f"electric unavailable: {exc}", subject=subject,
                       resource="manual-ask", status=502)
            return
        if row is None:
            self._deny("asset not visible at this tier", subject=subject,
                       resource="manual-ask", status=404)
            return

        # Step 5: delegate. on_behalf_of is ALWAYS the session subject --
        # this gateway reads no field named on_behalf_of (or anything like
        # it) from the request body, so there is nothing for a
        # client-supplied value to override.
        try:
            reply = manual_qa.ask_upstream(
                MANUAL_QA_URL, question=question, dmcs=dmcs, on_behalf_of=subject,
                token=_manual_qa_token(), timeout=MANUAL_QA_TIMEOUT,
            )
        except manual_qa.UpstreamError as exc:
            log.error("manual question service upstream error user=%s asset_id=%s: %s",
                      subject, asset_id, exc)
            # AN UPSTREAM FAULT, NOT A POLICY DENY -- mirrors how the egress
            # route and the read path record an upstream failure:
            # outcome="allow", never a deny, because authorization was
            # never in question past this point. The question text is
            # still never logged.
            record_decision(decision_id=new_decision_id(), outcome="allow",
                            subject=subject, resource="manual-ask",
                            asset_id=asset_id, dmcs=dmcs, upstream_error=str(exc))
            self._send(502, json.dumps({"status": "unavailable"}).encode(),
                       [("Content-Type", "application/json")])
            return

        # Step 6: citation enforcement, always applied, server side -- the
        # one check this route exists for.
        result = manual_qa.enforce_citations(reply, dmcs)
        record_decision(decision_id=new_decision_id(), outcome="allow",
                        subject=subject, resource="manual-ask", asset_id=asset_id,
                        dmcs=dmcs, reply_status=result["status"],
                        reason=result.get("reason"))
        self._send(200, json.dumps(result).encode(),
                   [("Content-Type", "application/json"), ("Cache-Control", "no-store")])

    # --- the WAN control route ------------------------------------------------
    def _handle_wan_control(self, parsed, method: str) -> None:
        """Serve GET/POST /proxies/uplink (this tier's own link) or
        /proxies/<name> (any name in WAN_LINKS): the WAN slider's commanded
        and observed state, reached through this gateway instead of the
        DDIL sever mechanism directly. Both methods run the same gate --
        reading the link's current state is a capability too, not just
        flipping it.

        Order mirrors _handle_cm_discrepancy: route existence, then (POST
        only) the request-shape checks, THEN the subject, THEN Topaz, THEN
        the role check. Nothing is forwarded until a WAN-control role is
        confirmed.
        """
        path = parsed.path
        proxy_name = _resolve_wan_proxy_name(path)
        if proxy_name is None:
            if method == "POST":
                self._drain_body()
            self._deny("unknown path", subject="", resource=path, status=404,
                       marker="GATEWAY REFUSED (PRE-PDP)")
            return

        if not WAN_CONTROL_URL:
            if method == "POST":
                self._drain_body()
            self._deny("wan control not configured at this tier", subject="",
                       resource=path, status=404, marker="GATEWAY REFUSED (PRE-PDP)")
            return

        enabled: bool | None = None
        if method == "POST":
            # --- request-shape checks, pre-PDP, same discipline as the CM
            # write path's own CSRF defence in depth.
            if not self._content_type_is_json():
                self._drain_body()
                self._deny("Content-Type must be application/json", subject="",
                           resource=path, status=415, marker="GATEWAY REFUSED (PRE-PDP)")
                return
            if self._origin_is_cross_site():
                self._drain_body()
                self._deny("cross-site origin", subject="", resource=path, status=403,
                           marker="GATEWAY REFUSED (PRE-PDP)")
                return

            length = self._content_length()
            if length > MAX_WAN_CONTROL_BODY_BYTES:
                # NOT drained -- a body this size is refused, not absorbed.
                self._deny("body too large", subject="", resource=path, status=413,
                           headers=[("Connection", "close")],
                           marker="GATEWAY REFUSED (PRE-PDP)")
                return
            raw = self.rfile.read(length) if length else b""

            try:
                payload = json.loads(raw or b"{}")
            except ValueError:
                self._send(400, json.dumps({"error": "malformed JSON body"}).encode(),
                           [("Content-Type", "application/json")])
                return
            try:
                enabled = _parse_wan_control_body(payload)
            except ValueError as exc:
                self._send(400, json.dumps({"error": str(exc)}).encode(),
                           [("Content-Type", "application/json")])
                return

        # Step: the principal. No session -> 401, nothing forwarded.
        try:
            subject, _principal, _session = self._resolve_principal()
        except oidc.AuthError:
            self._send(401, json.dumps({"error": "no authenticated subject"}).encode(),
                       [("Content-Type", "application/json")])
            return

        # Step: Topaz, applied verbatim -- this file contains no
        # authorization logic. Role, not allowed_nations, is what this
        # route's decision turns on.
        try:
            decision = ask_topaz(subject)
        except AuthzUnavailable as exc:
            self._deny(f"PDP unavailable: {exc}", subject=subject, resource=path,
                       status=503)
            return

        if not decision.get("subject_known") or decision.get("role") not in WAN_CONTROL_ROLES:
            reason = "wan control requires role: " + ",".join(sorted(WAN_CONTROL_ROLES))
            self._deny(reason, subject=subject, resource=path, status=403)
            return

        # Step: forward. `User-Agent: openddil-pep` because the sever
        # mechanism refuses browser user agents -- nginx used to set
        # "Toxiproxy-UI" for exactly that reason; this gateway carries the
        # same defence under its own name.
        data = None
        req_headers = {"User-Agent": "openddil-pep"}
        if method == "POST":
            data = json.dumps({"enabled": enabled}).encode()
            req_headers["Content-Type"] = "application/json"
        req = urllib.request.Request(
            WAN_CONTROL_URL + "/proxies/" + proxy_name, data=data,
            headers=req_headers, method=method,
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                upstream_status = resp.status
                upstream_body = resp.read()
        except urllib.error.HTTPError as exc:
            # A real answer from the sever mechanism, just not a 2xx --
            # relayed verbatim, same as a 2xx. Only a connection-level
            # failure below is an upstream-unavailable 502.
            upstream_status = exc.code
            upstream_body = exc.read()
        except Exception as exc:  # noqa: BLE001 -- a transport fault, not a deny
            log.error("wan control upstream error subject=%s: %s", subject, exc)
            self._send(502, json.dumps({"error": "wan control upstream unavailable"}).encode(),
                       [("Content-Type", "application/json")])
            return

        if method == "POST":
            log.info("WAN CONTROL subject=%s role=%s enabled=%s upstream_status=%s",
                     subject, decision.get("role"), enabled, upstream_status)
        self._send(upstream_status, upstream_body, [("Content-Type", "application/json")])

    def _handle_exercise(self, parsed, method: str) -> None:
        """Serve GET /exercise/status and POST /exercise/op/<op>, forwarded
        to exercise/control.py ONLY -- this route never reaches the
        adapter endpoint or the simulator; exercise/control.py is itself
        the only thing that calls the adapter. Any other path under
        /exercise/ (either method) is 404.

        Order mirrors _handle_wan_control: route existence, then the
        subject (401), then Topaz, then the role check (403, and nothing
        is forwarded until an exercise-control role is confirmed).
        """
        path = parsed.path
        op: str | None = None
        if method == "GET":
            if path != "/exercise/status":
                self._deny("unknown path", subject="", resource=path, status=404,
                           marker="GATEWAY REFUSED (PRE-PDP)")
                return
        else:
            prefix = "/exercise/op/"
            remainder = path[len(prefix):] if path.startswith(prefix) else ""
            # A plain lower-case word or nothing: control.py checks the op
            # against its adapter map, but nothing else is ever sent upstream.
            if not re.fullmatch(r"[a-z]{1,32}", remainder):
                self._drain_body()
                self._deny("unknown path", subject="", resource=path, status=404,
                           marker="GATEWAY REFUSED (PRE-PDP)")
                return
            op = remainder

        if not EXERCISE_CONTROL_URL:
            if method == "POST":
                self._drain_body()
            self._deny("exercise control not configured at this tier", subject="",
                       resource=path, status=404, marker="GATEWAY REFUSED (PRE-PDP)")
            return

        if method == "POST":
            # The client's own body is never forwarded -- exercise/control.py
            # takes the op from the path and the body from the adapter
            # file, not from the caller. Drained so a kept-alive socket
            # isn't desynced by an unread body.
            self._drain_body()

        # Step: the principal. No session -> 401, nothing forwarded.
        try:
            subject, _principal, _session = self._resolve_principal()
        except oidc.AuthError:
            self._send(401, json.dumps({"error": "no authenticated subject"}).encode(),
                       [("Content-Type", "application/json")])
            return

        # Step: Topaz, applied verbatim -- this file contains no
        # authorization logic. Role, not allowed_nations, is what this
        # route's decision turns on.
        try:
            decision = ask_topaz(subject)
        except AuthzUnavailable as exc:
            self._deny(f"PDP unavailable: {exc}", subject=subject, resource=path,
                       status=503)
            return

        if not decision.get("subject_known") or decision.get("role") not in EXERCISE_CONTROL_ROLES:
            reason = "exercise control requires role: " + ",".join(sorted(EXERCISE_CONTROL_ROLES))
            self._deny(reason, subject=subject, resource=path, status=403)
            return

        # Step: forward, to exercise/control.py's own HTTP surface alone.
        # `X-OpenDDIL-Subject` is set from THIS session, always -- any
        # client-sent value on the incoming request was never read above
        # and is overwritten here, never trusted.
        url = (EXERCISE_CONTROL_URL + "/exercise/status" if method == "GET"
               else EXERCISE_CONTROL_URL + "/exercise/op/" + op)
        req = urllib.request.Request(
            url, data=(b"" if method == "POST" else None),
            headers={SUBJECT_HEADER: subject}, method=method,
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                upstream_status = resp.status
                upstream_body = resp.read()
        except urllib.error.HTTPError as exc:
            # A real answer from exercise/control.py, just not a 2xx --
            # relayed verbatim. Only a connection-level failure below is an
            # upstream-unavailable 502.
            upstream_status = exc.code
            upstream_body = exc.read()
        except Exception as exc:  # noqa: BLE001 -- a transport fault, not a deny
            log.error("exercise control upstream error subject=%s: %s", subject, exc)
            self._send(502, json.dumps({"error": "exercise control upstream unavailable"}).encode(),
                       [("Content-Type", "application/json")])
            return

        if method == "POST":
            log.info("EXERCISE CONTROL subject=%s role=%s op=%s upstream_status=%s",
                     subject, decision.get("role"), op, upstream_status)
        self._send(upstream_status, upstream_body, [("Content-Type", "application/json")])

    def do_POST(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/cm/discrepancy":
            self._handle_cm_discrepancy(parsed)
            return
        if parsed.path == "/manual/ask":
            self._handle_manual_ask(parsed)
            return
        if parsed.path.startswith("/proxies/"):
            self._handle_wan_control(parsed, "POST")
            return
        if parsed.path.startswith("/exercise/"):
            self._handle_exercise(parsed, "POST")
            return
        if parsed.path == "/picture":
            self._drain_body()
            self._send(405, json.dumps({"detail": "method not allowed"}).encode(),
                       [("Content-Type", "application/json"), ("Allow", "GET")])
            return
        # Every other POST path is refused. The body is drained first so a
        # kept-alive HTTP/1.1 socket is not left desynced by an unread
        # request body ahead of whatever the client sends next.
        self._drain_body()
        self._deny("unknown path", subject="", resource=parsed.path, status=404)

    # --- authentication routes ------------------------------------------------
    def _sid(self):
        return oidc.session_id_from_cookies(self.headers.get("Cookie"))

    def _resolve_principal(self):
        """(subject, principal_key, session) or raise.

        NEVER returns a partially-authenticated caller: either a subject is
        established or this raises and the caller denies. There is no third
        outcome, because a third outcome is where a fail-open lives."""
        if AUTH_MODE == "oidc":
            sid = self._sid()
            session = oidc.get_session(sid)
            if session is None:
                raise oidc.AuthError("no valid session")
            return session["subject"], sid or "", session
        subject = self.headers.get(SUBJECT_HEADER, "").strip()
        if not subject:
            raise oidc.AuthError("no authenticated subject")
        return subject, subject, None

    def _handle_auth(self, parsed):
        """Serve /auth/*. Returns True when the path was handled."""
        path = parsed.path
        if not path.startswith("/auth/"):
            return False
        if AUTH_MODE != "oidc":
            self._deny("auth routes are not served in header mode",
                       subject="", resource=path, status=404)
            return True

        if path == "/auth/login":
            # `?next=` is the page the browser was gated off of. Validated
            # here (oidc.safe_next) before it ever reaches begin_login,
            # which stores whatever it is handed without re-checking it —
            # see oidc.safe_next for what "safe" means and why.
            next_raw = (urllib.parse.parse_qs(parsed.query).get("next")
                       or [""])[0]
            next_path = oidc.safe_next(next_raw)
            try:
                url = oidc.begin_login(next_path)
            except oidc.AuthError as exc:
                # The IdP is unreachable. That is a failure to AUTHENTICATE,
                # not a denial of anything — but it still ends in a refusal,
                # and the record must not call it a policy decision.
                self._deny("identity provider unavailable: " + str(exc),
                           subject="", resource="login", status=503)
                return True
            self._send(302, b"", [("Location", url),
                                  ("Cache-Control", "no-store")])
            return True

        if path == "/auth/callback":
            q = urllib.parse.parse_qs(parsed.query)
            if oidc.is_stale_login_form((q.get("error") or [""])[0]):
                # A used or expired login form, not a refusal; see
                # oidc.is_stale_login_form. "/" either shows the session the
                # first submit already made or starts a fresh sign-in.
                record_decision(decision_id=new_decision_id(),
                                outcome="login_restart",
                                cause=q["error"][0], resource="callback")
                self._send(302, b"", [("Location", "/"),
                                      ("Cache-Control", "no-store")])
                return True
            if "error" in q:
                self._deny("identity provider returned " + q["error"][0],
                           subject="", resource="callback")
                return True
            code = (q.get("code") or [""])[0]
            state = (q.get("state") or [""])[0]
            if not code and not state:
                # The provider coming back from a sign-out (the callback is
                # the post-logout address; see oidc.POST_LOGOUT_REDIRECT_URI).
                # Nothing to exchange; "/" shows the sign-in.
                self._send(302, b"", [("Location", "/"),
                                      ("Cache-Control", "no-store")])
                return True
            try:
                login = oidc.complete_login(code, state)
            except oidc.AuthError as exc:
                self._deny("login failed: " + str(exc), subject="",
                           resource="callback")
                return True
            sid, session = oidc.create_session(
                login.claims, login.id_token, login.refresh_token,
                login.refresh_expires_in)
            record_decision(decision_id=new_decision_id(), outcome="login",
                            subject=session["subject"],
                            username=session["username"] or None,
                            resource="session")
            self._send(302, b"", [("Location", login.next_path),
                                  ("Set-Cookie", oidc.cookie_header(sid)),
                                  ("Cache-Control", "no-store")])
            return True

        if path == "/auth/logout":
            sid = self._sid()
            session = oidc.get_session(sid)
            oidc.destroy_session(sid)
            if session:
                record_decision(decision_id=new_decision_id(),
                                outcome="logout", subject=session["subject"],
                                resource="session")
            # To the provider's sign-out when it has one, so its session ends
            # with ours; see oidc.logout_url for why ours alone is not enough.
            to = oidc.logout_url(session.get("id_token") if session else None)
            self._send(302, b"", [("Location", to or "/"),
                                  ("Set-Cookie", oidc.clear_cookie_header()),
                                  ("Cache-Control", "no-store")])
            return True

        if path == "/auth/me":
            # THE HEADER BADGE-S SOURCE, and it returns the nations TOPAZ
            # grants rather than any claim from the token. What the badge
            # shows and what the filter enforces are then the same answer
            # from the same authority. A badge fed from token claims could
            # disagree with the data on screen, and the screen would be the
            # one telling the truth.
            try:
                subject, _, session = self._resolve_principal()
            except oidc.AuthError:
                self._send(401, json.dumps({"authenticated": False}).encode(),
                           [("Content-Type", "application/json"),
                            ("Cache-Control", "no-store")])
                return True
            try:
                decision = ask_topaz(subject)
            except AuthzUnavailable as exc:
                self._deny("PDP unavailable: " + str(exc), subject=subject,
                           resource="me", status=503)
                return True
            body = json.dumps({
                "authenticated": True,
                "subject": subject,
                "username": (session or {}).get("username", ""),
                "name": (session or {}).get("name", ""),
                # WHEN THIS SESSION ENDS, as a pair the browser diffs rather
                # than a bare deadline it would otherwise compare against
                # its own clock. A phone five minutes fast must not see its
                # session as already over, and a server five minutes fast
                # must not grant five extra minutes to everyone else's —
                # sending both lets the client measure the gap instead of
                # trusting either clock alone.
                "expires_at": (session or {}).get("hard_expires"),
                "server_time": time.time(),
                "nations": decision["allowed_nations"],
                "policy_version": decision["policy_version"],
                "corpus_version": decision["corpus_version"],
                "role": decision["role"],
                # WHICH TABLES CAN BE PARTITIONED AT ALL. Surfaced here so
                # the browser learns it from the same authority that
                # enforces it, rather than inferring "no rows" from a failed
                # request. Empty list means the check is not configured, and
                # the UI must not then claim anything about labelability.
                "labeled_tables": sorted(
                    LABELED_TABLES | ROLE_SERVED_TABLES | set(SUBJECT_SCOPED_TABLES)
                ),
            }).encode()
            self._send(200, body, [("Content-Type", "application/json"),
                                   ("Cache-Control", "no-store")])
            return True

        self._deny("unknown auth route", subject="", resource=path, status=404)
        return True

    # --- egress pane route ---------------------------------------------------
    def _handle_egress(self, parsed) -> None:
        """Serve /egress/decisions: the pane's answer, narrowed to what this
        viewer may see. Reached directly, the pane gave every signed-in
        profile the same records, whichever nations they held.

        THE PANE HAS NO PER-VIEWER CONCEPT -- it answers once, for every
        nation on the wire (see egress/pane_api.py). This is therefore the
        only place a viewer's own nations can be applied, and it applies
        them with `egress_view.filter_decisions`, the SAME visibility rule
        as `policy_predicate` above, restated over JSON records instead of a
        SQL predicate. There is no branch below that returns the pane's
        answer unfiltered.
        """
        path = parsed.path
        if not EGRESS_PANE:
            self._deny("no egress pane at this tier", subject="", resource=path,
                       status=404, marker="GATEWAY REFUSED (PRE-PDP)")
            return
        if path != "/egress/decisions":
            self._deny("unknown path", subject="", resource=path, status=404)
            return

        params = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
        dest = (params.get("destination") or [""])[0]
        if not dest:
            self._deny("missing destination", subject="", resource=path,
                       status=400, marker="GATEWAY REFUSED (PRE-PDP)")
            return

        kind = (params.get("kind") or [""])[0]
        if kind and not KIND_RE.match(kind):
            self._deny("invalid kind", subject="", resource=path,
                       status=400, marker="GATEWAY REFUSED (PRE-PDP)")
            return

        try:
            subject, _principal, _session = self._resolve_principal()
        except oidc.AuthError as exc:
            self._deny(str(exc), subject="", resource=f"egress:{dest}", status=401)
            return

        try:
            decision = ask_topaz(subject)
        except AuthzUnavailable as exc:
            self._deny(f"PDP unavailable: {exc}", subject=subject,
                       resource=f"egress:{dest}", status=503)
            return

        if not decision["allow"]:
            # Same causes as the read path -- copied verbatim, not
            # paraphrased, so the two surfaces never drift apart in wording.
            cause = ("subject not in the entitlements corpus"
                     if not decision["subject_known"]
                     else "subject holds no nation entitlements")
            self._deny(cause, subject=subject, resource=f"egress:{dest}")
            return

        # ONLY destination and (when present and validated) kind are
        # forwarded -- nothing else from the client query reaches the pane.
        # See /v1/shape's PASSTHROUGH_PARAMS for the equivalent discipline on
        # the read path.
        forward = {"destination": dest}
        if kind:
            forward["kind"] = kind
        url = f"{EGRESS_PANE}/decisions?" + urllib.parse.urlencode(forward)

        def _upstream_unavailable(detail: str) -> None:
            # AN UPSTREAM FAULT, NOT A POLICY DENY -- mirrors how the read
            # path records an Electric upstream failure: outcome="allow",
            # never a deny, because authorization was never in question here.
            log.error("egress pane upstream error user=%s resource=%s: %s",
                      subject, dest, detail)
            record_decision(decision_id=new_decision_id(), outcome="allow",
                            subject=subject, resource=f"egress:{dest}",
                            policy_version=decision["policy_version"],
                            corpus_version=decision["corpus_version"],
                            allowed_nations=decision["allowed_nations"],
                            upstream_error=detail)
            self._send(502, json.dumps({"error": "egress pane unavailable"}).encode(),
                       [("Content-Type", "application/json")])

        try:
            with urllib.request.urlopen(url, timeout=15) as resp:
                status = resp.status
                raw = resp.read()
        except urllib.error.HTTPError as exc:
            if exc.code == 503:
                # THE PANE'S OWN "PDP unavailable" ANSWER -- relayed
                # verbatim, body and all, because the UI renders this
                # specific shape (see useEgressAdmission.ts's 503 branch).
                self._send(503, exc.read(), [("Content-Type", "application/json")])
                return
            _upstream_unavailable(f"HTTP {exc.code}")
            return
        except Exception as exc:  # noqa: BLE001 -- a transport fault, not a deny
            _upstream_unavailable(str(exc))
            return

        if status != 200:
            _upstream_unavailable(f"HTTP {status}")
            return

        try:
            payload = json.loads(raw)
            view = egress_view.filter_decisions(payload, decision["allowed_nations"])
        except (ValueError, TypeError) as exc:
            _upstream_unavailable(str(exc))
            return

        record_decision(decision_id=new_decision_id(), outcome="allow",
                        subject=subject, resource=f"egress:{dest}",
                        policy_version=decision["policy_version"],
                        corpus_version=decision["corpus_version"],
                        allowed_nations=decision["allowed_nations"],
                        shown=len(view["records"]), withheld=view["withheld"])
        self._send(200, json.dumps(view).encode(),
                   [("Content-Type", "application/json"), ("Cache-Control", "no-store")])

    def _picture_reply(self, status: int, detail: str,
                       headers: list | None = None) -> None:
        self._send(status, json.dumps({"detail": detail}).encode(),
                   [("Content-Type", "application/json")] + (headers or []))

    def _handle_picture(self, parsed) -> None:
        """GET /picture -- a service client's Bearer token in, the assembler's
        picture answer out, for the destination THIS PEP maps the client to.
        A `destination` the caller supplies is ignored."""
        if not PICTURE_URL or not oidc.ISSUER:
            self._deny("no picture route at this tier", subject="",
                       resource="/picture", status=404)
            return
        auth = self.headers.get("Authorization", "")
        challenge = 'Bearer realm="openddil"'
        invalid = [("WWW-Authenticate", challenge + ', error="invalid_token"')]
        if not auth.startswith("Bearer ") or not auth[7:].strip():
            log.warning("PICTURE refused cause=no bearer token")
            self._picture_reply(401, "bearer token required",
                                [("WWW-Authenticate", challenge)])
            return
        try:
            claims = oidc.verify_service_token(auth[7:].strip(),
                                               audience=PICTURE_AUDIENCE)
        except oidc.AuthError as exc:
            log.warning("PICTURE refused cause=invalid token (%s)", exc)
            self._picture_reply(401, "invalid token", invalid)
            return
        azp = claims["azp"]
        dest = PICTURE_CLIENTS.get(azp)
        if not dest:
            log.warning("PICTURE refused azp=%s cause=client not entitled", azp)
            self._picture_reply(403, "client not entitled to pictures")
            return
        raw_id = (urllib.parse.parse_qs(parsed.query).get("event_id") or [""])[0]
        try:
            event_id = str(uuid.UUID(raw_id)) if raw_id else ""
        except ValueError:
            event_id = ""
        if not event_id:
            log.warning("PICTURE refused azp=%s cause=bad event_id", azp)
            self._picture_reply(400, "event_id must be a UUID")
            return
        url = f"{PICTURE_URL}/picture?" + urllib.parse.urlencode(
            {"event_id": event_id, "destination": dest})
        try:
            with urllib.request.urlopen(url, timeout=15) as resp:
                status, body = resp.status, resp.read()
        except urllib.error.HTTPError as exc:
            status, body = exc.code, exc.read()
        except Exception as exc:  # noqa: BLE001 -- transport fault
            log.error("PICTURE upstream unreachable azp=%s event_id=%s: %s",
                      azp, event_id, exc)
            self._picture_reply(502, "picture service unreachable")
            return
        log.info("PICTURE azp=%s event_id=%s destination=%s status=%s",
                 azp, event_id, dest, status)
        self._send(status, body, [("Content-Type", "application/json"),
                                  ("Cache-Control", "no-store")])

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/healthz":
            self.send_response(200)
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"ok")
            return
        # Machine-to-machine: never consults the session cookie or the
        # header-mode subject, so it is dispatched before either is read.
        if parsed.path == "/picture":
            self._handle_picture(parsed)
            return
        if self._handle_auth(parsed):
            return
        if parsed.path.startswith("/egress/"):
            self._handle_egress(parsed)
            return
        if parsed.path == "/cm/fault-codes":
            self._handle_cm_fault_codes(parsed)
            return
        if parsed.path.startswith("/proxies/"):
            self._handle_wan_control(parsed, "GET")
            return
        if parsed.path.startswith("/exercise/"):
            self._handle_exercise(parsed, "GET")
            return
        if not parsed.path.startswith("/v1/shape"):
            self._deny("unknown path", subject="", resource=parsed.path, status=404)
            return

        params = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
        table = (params.get("table") or [""])[0]

        # BEFORE the session and before the PDP: whether this table can be
        # partitioned is a fact about the data, not about who is asking, so
        # asking Topaz first would record a decision about a subject when
        # the answer is the same for every subject.
        if table and table_class(table) == "refused":
            # NOT a Topaz decision — the PDP is never consulted for this, so
            # the log must not say it was. See _deny's `marker`.
            self._deny("unlabelable: table carries no releasability labels",
                       subject="", resource=table, status=403,
                       marker="GATEWAY REFUSED (PRE-PDP)")
            return

        try:
            subject, principal, _session = self._resolve_principal()
        except oidc.AuthError as exc:
            # An unauthenticated read is refused BEFORE the PDP is consulted.
            # Asking Topaz about an empty subject would produce a deny too,
            # but it would be recorded as a policy decision about nobody
            # rather than as a missing session, and those are different
            # events with different remedies.
            self._deny(str(exc), subject="", resource=table, status=401)
            return

        try:
            decision = ask_topaz(subject)
        except AuthzUnavailable as exc:
            # THE FAIL-CLOSED PATH. The request is never forwarded unfiltered.
            self._deny(f"PDP unavailable: {exc}", subject=subject, resource=table,
                       status=503)
            return

        if not decision["allow"]:
            cause = ("subject not in the entitlements corpus"
                     if not decision["subject_known"]
                     else "subject holds no nation entitlements")
            self._deny(cause, subject=subject, resource=table)
            return

        # THE FILTER THIS TABLE'S CLASS CALLS FOR. One place, so a class
        # cannot acquire a second meaning somewhere else in the handler.
        cls = table_class(table)
        if cls == "role":
            # Nothing to partition by. The client's own `where` still
            # applies; the POLICY contributes no clause, which is a
            # declared position and not an omission — see the class
            # comment. Recorded in the decision log as such, so a reader
            # of that log can tell "no filter was applied" from "a filter
            # was applied and matched everything".
            policy_clause = None
        elif cls == "subject":
            col = SUBJECT_SCOPED_TABLES[table]
            if decision["role"] in OVERSIGHT_ROLES:
                policy_clause = None
            else:
                policy_clause = f"{col} = {_sql_str(subject)}"
        else:
            policy_clause = policy_predicate(decision["allowed_nations"])

        client_where = (params.get("where") or [None])[0]
        where = compose(client_where, policy_clause) if policy_clause else client_where

        # Handle binding, checked BEFORE the request is forwarded, and only
        # now that `where` -- and so the view -- is known.
        columns = (params.get("columns") or [""])[0]
        view = (table, where or "", columns)
        handle = (params.get("handle") or [""])[0]
        if handle and not handle_belongs_to(principal, view, handle):
            self._deny("shape handle was not minted for this session and view",
                       subject=subject, resource=table)
            return

        upstream_params = [(k, v) for k, vs in params.items()
                           if k in PASSTHROUGH_PARAMS for v in vs]
        # ONLY WHEN THERE IS ONE. Appending the parameter unconditionally
        # sent `where=None` upstream for a role-served table — urlencode
        # stringifies None, Electric got the literal word as a predicate,
        # and the browser saw a 502 for a table the gateway had just decided
        # to serve. A refusal and a malformed allow are opposite outcomes
        # that looked identical from the panel.
        if where:
            upstream_params.append(("where", where))
        url = f"{ELECTRIC}{parsed.path}?" + urllib.parse.urlencode(upstream_params)

        # The body is STREAMED, not buffered: `resp` stays open across the
        # write below and bytes leave as they arrive. The semaphore is held
        # for the whole transfer, because what must be bounded is the number
        # of transfers in flight, not the number that have started.
        #
        # WHICH semaphore depends on `live` -- bound once, to a local, so the
        # acquire and every release below (there is more than one) agree on
        # the same object for this request. See MAX_INFLIGHT_LIVE.
        slot = _shape_slot(params)
        try:
            slot.acquire()
            try:
                resp = urllib.request.urlopen(url, timeout=30)
            except Exception:
                slot.release()
                raise
            new_handle = resp.headers.get("electric-handle") or \
                resp.headers.get("electric-shape-id") or ""
            headers = [(k, v) for k, v in resp.headers.items()
                       if k.lower().startswith("electric-")]
            upstream_len = resp.headers.get("Content-Length")
            status = resp.status
        except Exception as exc:  # noqa: BLE001
            # An upstream failure is NOT an authorization failure and must not
            # be recorded as a deny — that would poison the audit trail with
            # events authorization never caused.
            log.error("electric upstream error user=%s resource=%s: %s",
                      subject, table, exc)
            record_decision(decision_id=new_decision_id(), outcome="allow",
                            subject=subject, resource=table,
                            policy_version=decision["policy_version"],
                            corpus_version=decision["corpus_version"],
                            allowed_nations=decision["allowed_nations"],
                            upstream_error=str(exc))
            self.send_response(502)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        bind_handle(principal, view, new_handle)
        record_decision(decision_id=new_decision_id(), outcome="allow",
                        subject=subject, resource=table,
                        policy_version=decision["policy_version"],
                        corpus_version=decision["corpus_version"],
                        role=decision["role"],
                        allowed_nations=decision["allowed_nations"],
                        predicate=where, shape_handle=new_handle or None)

        self.send_response(status)
        for k, v in headers:
            self.send_header(k, v)
        self.send_header("Content-Type", "application/json")
        # Content-Length is FORWARDED from upstream when Electric gave one, and
        # the response is chunked when it did not. The previous version could
        # always answer `len(payload)` because it had the whole body; the price
        # of not holding it is that this length is upstream's claim, not a
        # measurement. Never compute it by reading the body first -- that is
        # the buffer this change removed, wearing a header.
        #
        # protocol_version is HTTP/1.1, so the connection is kept alive and a
        # response WITHOUT Content-Length must be chunk-framed or the next
        # response on that socket is parsed as part of this one. The framing
        # is written here, by hand: BaseHTTPRequestHandler does NOT encode it
        # for you, and sending the header without doing the work would be a
        # declaration the code does not honour -- the same shape as a comment
        # that documents a fix it prevents.
        chunked = upstream_len is None
        if chunked:
            self.send_header("Transfer-Encoding", "chunked")
        else:
            self.send_header("Content-Length", upstream_len)
        self.end_headers()

        # `sent` counts PAYLOAD bytes, not framing, because it is compared
        # against a ceiling expressed in shape bytes.
        sent = 0
        try:
            while True:
                chunk = resp.read(STREAM_CHUNK)
                if not chunk:
                    break
                if chunked:
                    self.wfile.write(b"%x\r\n" % len(chunk))
                    self.wfile.write(chunk)
                    self.wfile.write(b"\r\n")
                else:
                    self.wfile.write(chunk)
                sent += len(chunk)
            if chunked:
                self.wfile.write(b"0\r\n\r\n")
        except (BrokenPipeError, ConnectionResetError):
            # The browser navigated away mid-shape. Not an error worth a stack
            # trace, and NOT an authorization event -- the decision above
            # already stands and must not be re-recorded as a failure.
            log.info("client disconnected mid-shape resource=%s sent=%d", table, sent)
        finally:
            try:
                resp.close()
            finally:
                slot.release()

        # PER-SHAPE BYTES, every time. This is the read-path dimension that did
        # not exist: on 2026-09-18 `tactical_events` had grown to 10 MiB of
        # residue and nothing anywhere reported a number until the process was
        # killed for it.
        if sent >= SHAPE_WARN_BYTES:
            log.warning("SHAPE OVER CEILING resource=%s bytes=%d ceiling=%d "
                        "subject=%s -- a shape this size is a retention or "
                        "predicate finding, not a client problem",
                        table, sent, SHAPE_WARN_BYTES, subject)
        else:
            log.info("shape served resource=%s bytes=%d", table, sent)


def main() -> None:
    log.info("read-path PEP listening on :%s", LISTEN_PORT)
    log.info("  electric:  %s", ELECTRIC)
    log.info("  egress pane: %s", EGRESS_PANE or "(none)")
    log.info("  picture: %s (%d mapped clients)", PICTURE_URL or "(none)",
             len(PICTURE_CLIENTS))
    log.info("  topaz:     %s", TOPAZ)
    # THE AUTH MODE IS ANNOUNCED AT BOOT, ONCE, LOUDLY. An operator asking
    # "is this thing actually authenticating?" should not have to infer the
    # answer from a request that happened to fail.
    log.info("  auth mode: %s", AUTH_MODE)
    log.info("  shapes:    max %d in flight, max %d live, %d B chunks, warn over %d B",
             MAX_INFLIGHT_SHAPES, MAX_INFLIGHT_LIVE, STREAM_CHUNK, SHAPE_WARN_BYTES)
    if LABELED_TABLES or ROLE_SERVED_TABLES or SUBJECT_SCOPED_TABLES:
        log.info("  nation-filtered: %s", ", ".join(sorted(LABELED_TABLES)) or "(none)")
        log.info("  role-served:     %s — NO nation filter, authenticated subjects",
                 ", ".join(sorted(ROLE_SERVED_TABLES)) or "(none)")
        log.info("  subject-scoped:  %s — oversight roles: %s",
                 ", ".join(f"{t}:{c}" for t, c in sorted(SUBJECT_SCOPED_TABLES.items())) or "(none)",
                 ", ".join(sorted(OVERSIGHT_ROLES)) or "(none)")
    else:
        log.warning("  labelable: NOT CONFIGURED — every table is forwarded "
                    "with a releasability predicate, so a table without the "
                    "label columns fails at Electric and reaches the browser "
                    "as a transport error. Set OPENDDIL_LABELED_TABLES.")
    if AUTH_MODE == "oidc":
        log.info("  issuer:    %s", oidc.ISSUER)
        log.info("  client:    %s", oidc.CLIENT_ID)
        log.info("  session:   %ss, cookie=%s SameSite=%s Secure=%s",
                 oidc.SESSION_TTL, oidc.COOKIE_NAME, oidc.COOKIE_SAMESITE,
                 oidc.COOKIE_SECURE)
    else:
        log.warning("  header mode: the subject is taken from %r and is "
                    "NOT authenticated. This is correct only where the PEP "
                    "is unreachable except from inside the cluster.",
                    SUBJECT_HEADER)
    ThreadingHTTPServer(("0.0.0.0", LISTEN_PORT), Pep).serve_forever()


if __name__ == "__main__":
    main()
