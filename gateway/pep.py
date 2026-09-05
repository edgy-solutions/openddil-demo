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
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# --- configuration ----------------------------------------------------------
ELECTRIC = os.environ["OPENDDIL_ELECTRIC_URL"].rstrip("/")
TOPAZ = os.environ["OPENDDIL_TOPAZ_URL"].rstrip("/")
LISTEN_PORT = int(os.getenv("OPENDDIL_PEP_PORT", "8080"))
SUBJECT_HEADER = os.getenv("OPENDDIL_SUBJECT_HEADER", "X-OpenDDIL-Subject")
TOPAZ_TIMEOUT = float(os.getenv("OPENDDIL_TOPAZ_TIMEOUT", "2.0"))

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


def record_decision(**fields) -> None:
    """One JSON line per decision: user, attributes, policy version, outcome,
    timestamp. Structured because the demo reads it back and an operator
    greps it, and those want the same record rather than two."""
    fields.setdefault("ts", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
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


def bind_handle(handle: str, subject: str) -> None:
    if not handle:
        return
    with _handles_lock:
        _handles[handle] = subject


def handle_belongs_to(handle: str, subject: str) -> bool:
    with _handles_lock:
        owner = _handles.get(handle)
    return owner is not None and owner == subject


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
        "input": json.dumps({"subject": subject}),
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

    def _deny(self, cause: str, *, subject: str, resource: str, status: int = 403,
              upstream: str = "") -> None:
        """Every non-200 and every exception lands here. There is no other
        exit from an authorization failure, and no branch that converts one
        into an allow."""
        log.warning("%s cause=%s user=%s resource=%s upstream=%s",
                    DENY_MARKER, cause, subject or "<none>", resource, upstream or "-")
        record_decision(outcome="deny", cause=cause, subject=subject or None,
                        resource=resource, upstream_status=upstream or None)
        body = json.dumps({"error": DENY_MARKER, "cause": cause}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/healthz":
            self.send_response(200)
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"ok")
            return
        if not parsed.path.startswith("/v1/shape"):
            self._deny("unknown path", subject="", resource=parsed.path, status=404)
            return

        params = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
        table = (params.get("table") or [""])[0]
        subject = self.headers.get(SUBJECT_HEADER, "").strip()

        if not subject:
            self._deny("no authenticated subject", subject="", resource=table)
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
        if handle and not handle_belongs_to(handle, subject):
            self._deny("shape handle was not minted for this subject",
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
            record_decision(outcome="allow", subject=subject, resource=table,
                            policy_version=decision["policy_version"],
                            allowed_nations=decision["allowed_nations"],
                            upstream_error=str(exc))
            self.send_response(502)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        bind_handle(new_handle, subject)
        record_decision(outcome="allow", subject=subject, resource=table,
                        policy_version=decision["policy_version"],
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
    log.info("  electric: %s", ELECTRIC)
    log.info("  topaz:    %s", TOPAZ)
    ThreadingHTTPServer(("0.0.0.0", LISTEN_PORT), Pep).serve_forever()


if __name__ == "__main__":
    main()
