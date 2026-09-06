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
"""
from __future__ import annotations

import json
import logging
import os
import secrets
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import oidc

# --- configuration ----------------------------------------------------------
ELECTRIC = os.environ["OPENDDIL_ELECTRIC_URL"].rstrip("/")
TOPAZ = os.environ["OPENDDIL_TOPAZ_URL"].rstrip("/")
LISTEN_PORT = int(os.getenv("OPENDDIL_PEP_PORT", "8080"))
SUBJECT_HEADER = os.getenv("OPENDDIL_SUBJECT_HEADER", "X-OpenDDIL-Subject")
TOPAZ_TIMEOUT = float(os.getenv("OPENDDIL_TOPAZ_TIMEOUT", "2.0"))

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

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s [pep] %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("pep")

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
# Electric clients resume a shape by handle + offset. A handle minted for
# user-A's FILTERED shape, presented by user-B, would be served by Electric
# as-is: Electric has no idea a policy was ever involved, and the handle
# already encodes A's predicate. So the gateway binds each handle to the
# subject it was minted for and refuses a mismatch.
#
# In-memory and per-process, which is honest about its limits: a gateway
# restart forgets every binding, and clients then re-request from offset -1.
# That fails CLOSED (an unknown handle is refused, not trusted), which is the
# correct direction for the failure. A multi-replica deployment needs shared
# storage here; Slice 1 runs one replica and says so rather than pretending.
_handles: dict[str, str] = {}
_handles_lock = threading.Lock()


# The binding key is the SESSION in oidc mode, not the subject. Stricter, and
# for a reason worth stating: two concurrent sessions for one person are two
# separate grants, and a handle minted under one should not be resumable
# under the other. A session that has been logged out or has expired then
# cannot resume a shape it opened, which is the behaviour a revoked session
# ought to have.
def bind_handle(handle: str, principal: str) -> None:
    if not handle:
        return
    with _handles_lock:
        _handles[handle] = principal


def handle_belongs_to(handle: str, principal: str) -> bool:
    with _handles_lock:
        owner = _handles.get(handle)
    return owner is not None and owner == principal


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


def may_serve_table(table: str, labeled: set[str] | None = None) -> bool:
    """False when the table cannot be partitioned, and so must not be served.

    A function rather than an inline test so the rule can be exercised
    directly — this is the only place the PEP refuses data on a property of
    the DATA rather than of the subject, and that asymmetry is worth being
    able to assert.
    """
    allowed = LABELED_TABLES if labeled is None else labeled
    if not allowed:
        # Not configured. Pre-2026-09-06 behaviour, announced at boot.
        return True
    return table in allowed


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


# --- the proxy --------------------------------------------------------------
PASSTHROUGH_PARAMS = {"table", "offset", "handle", "live", "cursor", "columns", "replica"}


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
              upstream: str = "", headers: list | None = None) -> None:
        """Every non-200 and every exception lands here. There is no other
        exit from an authorization failure, and no branch that converts one
        into an allow."""
        ref = new_decision_id()
        log.warning("%s ref=%s cause=%s user=%s resource=%s upstream=%s",
                    DENY_MARKER, ref, cause, subject or "<none>", resource,
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
            try:
                url = oidc.begin_login()
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
            if "error" in q:
                self._deny("identity provider returned " + q["error"][0],
                           subject="", resource="callback")
                return True
            code = (q.get("code") or [""])[0]
            state = (q.get("state") or [""])[0]
            try:
                claims = oidc.complete_login(code, state)
            except oidc.AuthError as exc:
                self._deny("login failed: " + str(exc), subject="",
                           resource="callback")
                return True
            sid, session = oidc.create_session(claims)
            record_decision(decision_id=new_decision_id(), outcome="login",
                            subject=session["subject"],
                            username=session["username"] or None,
                            resource="session")
            self._send(302, b"", [("Location", oidc.POST_LOGIN_PATH),
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
            self._send(302, b"", [("Location", "/"),
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
                "nations": decision["allowed_nations"],
                "policy_version": decision["policy_version"],
                "corpus_version": decision["corpus_version"],
                "role": decision["role"],
                # WHICH TABLES CAN BE PARTITIONED AT ALL. Surfaced here so
                # the browser learns it from the same authority that
                # enforces it, rather than inferring "no rows" from a failed
                # request. Empty list means the check is not configured, and
                # the UI must not then claim anything about labelability.
                "labeled_tables": sorted(LABELED_TABLES),
            }).encode()
            self._send(200, body, [("Content-Type", "application/json"),
                                   ("Cache-Control", "no-store")])
            return True

        self._deny("unknown auth route", subject="", resource=path, status=404)
        return True

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/healthz":
            self.send_response(200)
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"ok")
            return
        if self._handle_auth(parsed):
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
        if table and not may_serve_table(table):
            self._deny("unlabelable: table carries no releasability labels",
                       subject="", resource=table, status=403)
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

        # Handle binding, checked BEFORE the request is forwarded.
        handle = (params.get("handle") or [""])[0]
        if handle and not handle_belongs_to(handle, principal):
            self._deny("shape handle was not minted for this session",
                       subject=subject, resource=table)
            return

        where = compose((params.get("where") or [None])[0],
                        policy_predicate(decision["allowed_nations"]))

        upstream_params = [(k, v) for k, vs in params.items()
                           if k in PASSTHROUGH_PARAMS for v in vs]
        upstream_params.append(("where", where))
        url = f"{ELECTRIC}{parsed.path}?" + urllib.parse.urlencode(upstream_params)

        try:
            with urllib.request.urlopen(url, timeout=30) as resp:
                payload = resp.read()
                new_handle = resp.headers.get("electric-handle") or \
                    resp.headers.get("electric-shape-id") or ""
                headers = [(k, v) for k, v in resp.headers.items()
                           if k.lower().startswith("electric-")]
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

        bind_handle(new_handle, principal)
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
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def main() -> None:
    log.info("read-path PEP listening on :%s", LISTEN_PORT)
    log.info("  electric:  %s", ELECTRIC)
    log.info("  topaz:     %s", TOPAZ)
    # THE AUTH MODE IS ANNOUNCED AT BOOT, ONCE, LOUDLY. An operator asking
    # "is this thing actually authenticating?" should not have to infer the
    # answer from a request that happened to fail.
    log.info("  auth mode: %s", AUTH_MODE)
    if LABELED_TABLES:
        log.info("  labelable: %d table(s) may be served — %s",
                 len(LABELED_TABLES), ", ".join(sorted(LABELED_TABLES)))
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
