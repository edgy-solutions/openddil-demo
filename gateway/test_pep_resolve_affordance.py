"""/auth/me declares `may_resolve_discrepancy` from the decision that gates it.

An affordance only: POST /cm/discrepancy/resolve re-checks everything. The
field is true only when the role is in CM_RESOLVE_ROLES AND the CM route is
configured at this tier (fault catalog loaded, intake URL set).

Run:  python -m pytest gateway/test_pep_resolve_affordance.py -q
"""
from __future__ import annotations

import json
import sys
import urllib.parse

import pytest

from test_oidc import key, mint, oidc  # noqa: F401  (fixtures)


def _me(pep, oidc, key, monkeypatch, role):
    monkeypatch.setattr(pep, "AUTH_MODE", "oidc")
    monkeypatch.setattr(pep, "ask_topaz", lambda subject: {
        "allowed_nations": ["ATL"], "policy_version": "v1",
        "corpus_version": "v1", "role": role})
    token = mint(key)
    sid, _ = oidc.create_session(oidc.verify_id_token(token), token)
    handler = object.__new__(pep.Pep)
    handler.headers = {"Cookie": f"{oidc.COOKIE_NAME}={sid}"}
    captured = {}
    handler._send = lambda status, body, headers=None: captured.update(
        status=status, body=json.loads(body))
    handler._handle_auth(urllib.parse.urlparse("/auth/me"))
    assert captured["status"] == 200
    return captured["body"]


@pytest.fixture
def configured(monkeypatch):
    import pep
    monkeypatch.setattr(pep, "FAULT_CATALOG", {"variants": []})
    monkeypatch.setattr(pep, "CM_INTAKE_URL", "http://intake.invalid/cm-events")
    monkeypatch.setattr(pep, "CM_RESOLVE_ROLES",
                        pep._parse_roles_csv("edge-operator,regional-operator,supervisor"))
    return pep


def test_true_for_supervisor_false_for_observer(oidc, key, monkeypatch, configured):
    assert _me(configured, oidc, key, monkeypatch, "supervisor")["may_resolve_discrepancy"] is True
    assert _me(configured, oidc, key, monkeypatch, "observer")["may_resolve_discrepancy"] is False


def test_false_when_cm_route_unconfigured(oidc, key, monkeypatch, configured):
    monkeypatch.setattr(configured, "CM_INTAKE_URL", "")
    assert _me(configured, oidc, key, monkeypatch, "supervisor")["may_resolve_discrepancy"] is False
    monkeypatch.setattr(configured, "CM_INTAKE_URL", "http://intake.invalid/cm-events")
    monkeypatch.setattr(configured, "FAULT_CATALOG", None)
    assert _me(configured, oidc, key, monkeypatch, "supervisor")["may_resolve_discrepancy"] is False


def test_follows_roles_env(oidc, key, monkeypatch, configured):
    original = sys.modules["pep"]
    monkeypatch.setenv("OPENDDIL_CM_RESOLVE_ROLES", "observer")
    sys.modules.pop("pep", None)
    try:
        import pep as fresh  # noqa: PLC0415
        monkeypatch.setattr(fresh, "FAULT_CATALOG", {"variants": []})
        monkeypatch.setattr(fresh, "CM_INTAKE_URL", "http://intake.invalid/cm-events")
        assert _me(fresh, oidc, key, monkeypatch, "observer")["may_resolve_discrepancy"] is True
        assert _me(fresh, oidc, key, monkeypatch, "supervisor")["may_resolve_discrepancy"] is False
    finally:
        sys.modules["pep"] = original
