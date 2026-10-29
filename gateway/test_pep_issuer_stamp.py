"""Issuer is refused before the key lookup, and stamped on every decision.

ADR-0045 next increment, item 6. Two things are pinned here:

  1. THE VERIFIER ORDER. A token from a foreign issuer is refused for what it
     is, and costs no JWKS refresh. `_signing_key` refreshes on an unknown
     kid, so checking the issuer after it let a stream of foreign tokens
     hammer the IdP and report "unknown key id" for an issuer fault.
  2. THE STAMP. `record_decision` carries `issuer` and `realm_version`, and
     /auth/me and the session carry the issuer, so an accreditor can ask
     which realm a decision's subject was authenticated against.

Reuses the key/JWKS fixtures of test_oidc.py.

Run:  python -m pytest gateway/test_pep_issuer_stamp.py -q
"""
from __future__ import annotations

import json
import logging
import urllib.parse

import pytest

from test_oidc import ISSUER, key, mint, oidc  # noqa: F401  (fixtures)

FOREIGN = "https://other-idp.example/realms/elsewhere"


@pytest.fixture
def jwks_calls(oidc, monkeypatch):
    """Count every attempt to reach the IdP for keys."""
    calls = []
    monkeypatch.setattr(oidc, "_refresh_jwks",
                        lambda force=False: calls.append(force))
    return calls


def _verify(oidc, kind, token):
    if kind == "id":
        return oidc.verify_id_token(token)
    return oidc.verify_service_token(token, audience="openddil-pep")


KINDS = ["id", "service"]


@pytest.mark.parametrize("kind", KINDS)
def test_foreign_issuer_unknown_key_is_refused_for_issuer_without_refresh(
        oidc, key, jwks_calls, kind):
    token = mint(key, kid="never-seen", iss=FOREIGN)
    with pytest.raises(oidc.AuthError, match="issuer mismatch"):
        _verify(oidc, kind, token)
    assert jwks_calls == []


@pytest.mark.parametrize("kind", KINDS)
def test_right_issuer_unknown_key_is_still_refused_for_the_key(
        oidc, key, jwks_calls, kind):
    token = mint(key, kid="never-seen")
    with pytest.raises(oidc.AuthError, match="unknown key id"):
        _verify(oidc, kind, token)
    assert jwks_calls == [True]  # the miss still costs its one refresh


@pytest.mark.parametrize("kind", KINDS)
def test_right_issuer_valid_signature_is_accepted(oidc, key, kind):
    claims = _verify(oidc, kind, mint(key, azp="openddil-pep"))
    assert claims["iss"] == ISSUER


@pytest.mark.parametrize("kind", KINDS)
def test_right_issuer_bad_signature_is_refused_for_the_signature(
        oidc, key, kind):
    h, p, s = mint(key).split(".")
    bad = ".".join([h, p, s[:-4] + ("AAAA" if s[-4:] != "AAAA" else "BBBB")])
    with pytest.raises(oidc.AuthError, match="signature"):
        _verify(oidc, kind, bad)


# --- the stamp --------------------------------------------------------------

def _decision_lines(caplog, fn):
    with caplog.at_level(logging.INFO, logger="pep.decision"):
        fn()
    out = []
    for r in caplog.records:
        msg = r.getMessage()
        if msg.startswith("DECISION "):
            out.append(json.loads(msg[len("DECISION "):]))
    return out


def test_record_decision_stamps_issuer_and_realm_version(oidc, caplog):
    import pep
    (rec,) = _decision_lines(
        caplog, lambda: pep.record_decision(decision_id="A1", outcome="allow"))
    assert rec["issuer"] == ISSUER
    assert rec["realm_version"] == pep.REALM_VERSION


def test_record_decision_does_not_overwrite_a_callers_issuer(oidc, caplog):
    import pep
    (rec,) = _decision_lines(
        caplog, lambda: pep.record_decision(decision_id="A2", issuer="x"))
    assert rec["issuer"] == "x"


def test_record_decision_issuer_is_empty_when_oidc_is_off(
        oidc, caplog, monkeypatch):
    import pep
    monkeypatch.setattr(oidc, "ISSUER", "")
    (rec,) = _decision_lines(
        caplog, lambda: pep.record_decision(decision_id="A3"))
    assert rec["issuer"] == ""


def test_session_and_auth_me_carry_issuer_and_realm_version(
        oidc, key, monkeypatch):
    import pep
    monkeypatch.setattr(pep, "AUTH_MODE", "oidc")
    monkeypatch.setattr(pep, "ask_topaz", lambda subject: {
        "allowed_nations": ["ATL"], "policy_version": "v1",
        "corpus_version": "v1", "role": "operator"})
    token = mint(key)
    sid, session = oidc.create_session(oidc.verify_id_token(token), token)
    assert session["issuer"] == ISSUER
    handler = object.__new__(pep.Pep)
    handler.headers = {"Cookie": f"{oidc.COOKIE_NAME}={sid}"}
    captured = {}
    handler._send = lambda status, body, headers=None: captured.update(
        status=status, body=json.loads(body))
    handler._handle_auth(urllib.parse.urlparse("/auth/me"))
    assert captured["status"] == 200
    assert captured["body"]["issuer"] == ISSUER
    assert captured["body"]["realm_version"] == pep.REALM_VERSION
    assert captured["body"]["subject"] == "user-sub-123"  # existing keys kept
