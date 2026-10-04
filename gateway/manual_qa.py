"""manual_qa — POST /manual/ask support: request-shape validation, delegation
to the manual question service, and server-side citation enforcement.

Kept separate from pep.py (as egress_view.py and oidc.py already are) so the
one decision this corpus cares most about proving — that an answer never
renders without a citation inside the requested scope — is a short, pure
function with no HTTP server around it to get in the way of testing it
directly.

THIS FILE CONTAINS NO AUTHORIZATION LOGIC, same constraint pep.py's own
header carries. Topaz decides who may ask; this module decides only whether
an upstream reply is well-formed and in scope. Stdlib only, like pep.py.
"""
from __future__ import annotations

import json
import re
import urllib.error
import urllib.request

# S1000D DMC shape: DMC-<model ident code>(-<more segments>)+. Loose on
# purpose — this gateway is not the authority on what a valid DMC looks
# like, only on whether a string plausibly carries one before it is sent
# upstream or compared against a citation.
DMC_RE = re.compile(r"^DMC-[A-Z0-9]+(-[A-Z0-9]+)+$")

MAX_QUESTION_LEN = 1000
MIN_DMCS = 1
MAX_DMCS = 20


class ManualQaError(Exception):
    """A validation failure in the request body. str(exc) is the 400 cause."""


def validate_question(question) -> None:
    if not isinstance(question, str) or not (1 <= len(question) <= MAX_QUESTION_LEN):
        raise ManualQaError("invalid question")


def validate_dmcs(dmcs) -> None:
    if not isinstance(dmcs, list) or not (MIN_DMCS <= len(dmcs) <= MAX_DMCS):
        raise ManualQaError("invalid dmcs")
    for d in dmcs:
        if not isinstance(d, str) or not DMC_RE.match(d):
            raise ManualQaError("invalid dmc shape")


class UpstreamError(Exception):
    """The manual question service could not be reached, or did not answer
    usably within the timeout. Always a 502, never a deny — authorization
    was already decided before this call; see pep.py's _handle_manual_ask."""


def ask_upstream(url: str, *, question: str, dmcs: list, on_behalf_of: str,
                  token: str | None, timeout: float) -> dict:
    """POST {question, scope: {dmcs}, on_behalf_of} to the manual question
    service and return its parsed JSON reply.

    on_behalf_of is always the caller's own `on_behalf_of` argument, never
    read from anywhere else. The caller (pep.py) passes the session subject;
    nothing a request body carries can reach this parameter, because this
    function never looks at a request body in the first place.

    RFC 8693 token exchange (ADR-0046, noted for later) replaces the
    bearer-token forward below once the manual question service's own OIDC
    client is issued. Until then: a configured token file's contents,
    verbatim, or no Authorization header at all — the stub's own posture.
    """
    body = json.dumps({
        "question": question,
        "scope": {"dmcs": dmcs},
        "on_behalf_of": on_behalf_of,
    }).encode()
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if resp.status != 200:
                raise UpstreamError(f"manual question service returned HTTP {resp.status}")
            payload = json.loads(resp.read())
    except UpstreamError:
        raise
    except urllib.error.HTTPError as exc:
        raise UpstreamError(f"manual question service HTTP {exc.code}: {exc.reason}") from exc
    except (ValueError, TypeError) as exc:
        raise UpstreamError(f"manual question service reply was not valid JSON: {exc}") from exc
    except Exception as exc:  # noqa: BLE001 — every other failure here is "unavailable"
        raise UpstreamError(f"manual question service unreachable: {exc}") from exc
    return payload


def enforce_citations(reply, requested_dmcs: list) -> dict:
    """The one decision this module exists for: an answer renders only when
    it carries at least one citation and every citation names a DMC inside
    the scope the gateway itself forwarded — never a DMC the upstream
    introduces on its own.

    `reply` is the manual question service's own answer, expected to be
    {answer: str, citations: [{dmc, title?, step?}]}. Returns exactly one
    of:
      {"status": "answered", "answer": ..., "citations": [...]}
      {"status": "no_cited_answer", "reason": <one of the three reasons below>}

    Order matters. A reply that is not even shaped right (answer missing,
    citations not a list, a citation missing its own dmc) is
    "malformed_reply" before its citations are judged empty or
    out-of-scope: there is no citation list to judge when the field
    claiming to be one is not one.
    """
    citations = reply.get("citations") if isinstance(reply, dict) else None
    well_formed = (
        isinstance(reply, dict)
        and isinstance(reply.get("answer"), str)
        and isinstance(citations, list)
        and all(isinstance(c, dict) and isinstance(c.get("dmc"), str) for c in citations)
    )
    if not well_formed:
        return {"status": "no_cited_answer", "reason": "malformed_reply"}
    if not citations:
        return {"status": "no_cited_answer", "reason": "no_citations"}
    scope = set(requested_dmcs)
    if any(c["dmc"] not in scope for c in citations):
        return {"status": "no_cited_answer", "reason": "citation_outside_scope"}
    return {"status": "answered", "answer": reply["answer"], "citations": citations}
