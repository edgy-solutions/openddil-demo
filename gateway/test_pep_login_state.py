"""Login state lives in a signed cookie, so it survives a PEP restart; a login
that cannot be continued is a sign-in-again page, not a refusal.

Run:  py -3 -m pytest gateway
"""
from __future__ import annotations

import importlib
import os
import re
import sys
import urllib.parse
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

CALLBACK = "https://app.example/auth/callback"


def _fresh_oidc(monkeypatch):
    """A new-process oidc: module reloaded, nothing held in memory."""
    monkeypatch.setenv("OPENDDIL_OIDC_ISSUER", "https://idp.example/realms/x")
    monkeypatch.setenv("OPENDDIL_OIDC_CLIENT_SECRET", "test-only-secret")
    monkeypatch.setenv("OPENDDIL_OIDC_REDIRECT_URI", CALLBACK)
    monkeypatch.setenv("OPENDDIL_COOKIE_SAMESITE", "Strict")
    monkeypatch.setenv("OPENDDIL_COOKIE_SECURE", "true")
    import oidc as mod
    importlib.reload(mod)
    monkeypatch.setattr(mod, "metadata", lambda: {
        "authorization_endpoint": "https://idp.example/authorize",
        "token_endpoint": "https://idp.example/token"})
    monkeypatch.setattr(mod, "_internalize", lambda u: u)
    monkeypatch.setattr(mod, "_http_json", lambda *a, **k: {
        "id_token": "idt", "refresh_token": "rt", "refresh_expires_in": 60})
    seen = {}
    def fake_verify(tok, nonce=None):
        seen["nonce"] = nonce
        return {"sub": "s"}
    monkeypatch.setattr(mod, "verify_id_token", fake_verify)
    mod._seen = seen
    return mod


@pytest.fixture
def oidc(monkeypatch):
    return _fresh_oidc(monkeypatch)


def _begin(oidc, nxt="/regional"):
    url, set_cookie = oidc.begin_login(nxt)
    state = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)["state"][0]
    name_value = set_cookie.split(";", 1)[0]
    return url, state, set_cookie, name_value


def test_cookie_attributes(oidc):
    _, state, set_cookie, nv = _begin(oidc)
    assert nv.startswith("openddil_login_" + state[:16] + "=")
    attrs = set_cookie.split("; ")[1:]
    assert attrs == ["Path=/auth/callback", "HttpOnly", "SameSite=Lax",
                     "Max-Age=600", "Secure"]


def test_round_trip(oidc):
    _, state, _, nv = _begin(oidc, "/regional?role=hq")
    res = oidc.complete_login("code", state, nv)
    assert res.next_path == "/regional?role=hq"
    assert oidc._seen["nonce"]


def test_survives_restart(monkeypatch, oidc):
    _, state, _, nv = _begin(oidc)
    fresh = _fresh_oidc(monkeypatch)           # new process: nothing in memory
    assert not fresh._consumed
    assert fresh.complete_login("code", state, nv).next_path == "/regional"


def test_two_tabs_either_order(oidc):
    _, s1, _, c1 = _begin(oidc, "/a")
    _, s2, _, c2 = _begin(oidc, "/b")
    both = c1 + "; " + c2
    assert oidc.complete_login("c", s2, both).next_path == "/b"
    assert oidc.complete_login("c", s1, both).next_path == "/a"


def _cause(oidc, state, cookie):
    with pytest.raises(oidc.LoginStateError) as e:
        oidc.complete_login("c", state, cookie)
    return e.value.cause


def test_expired(monkeypatch, oidc):
    _, state, _, nv = _begin(oidc)
    t0 = oidc._clock()
    monkeypatch.setattr(oidc, "_clock", lambda: t0 + 601)
    assert _cause(oidc, state, nv) == "expired"


def test_tampered(oidc):
    _, state, _, nv = _begin(oidc)
    name, _, val = nv.partition("=")
    body, _, mac = val.partition(".")
    flipped = ("A" if body[0] != "A" else "B") + body[1:]
    assert _cause(oidc, state, f"{name}={flipped}.{mac}") == "bad_signature"
    assert _cause(oidc, state, f"{name}={body}.") == "bad_signature"
    assert _cause(oidc, state, f"{name}=garbage") == "bad_signature"


def test_wrong_state(oidc):
    _, s1, _, c1 = _begin(oidc)
    other = s1[:16] + "x" * 10          # same cookie name, different state
    assert _cause(oidc, other, c1) == "state_mismatch"


def test_missing_cookie(oidc):
    _, state, _, _ = _begin(oidc)
    assert _cause(oidc, state, None) == "missing"
    assert _cause(oidc, state, "other=1") == "missing"


def test_replay(oidc):
    _, state, _, nv = _begin(oidc)
    oidc.complete_login("c", state, nv)
    assert _cause(oidc, state, nv) == "replayed"


def test_key_depends_on_client_secret(monkeypatch, oidc):
    _, state, _, nv = _begin(oidc)
    monkeypatch.setattr(oidc, "CLIENT_SECRET", "another-test-secret")
    assert _cause(oidc, state, nv) == "bad_signature"


# --- the callback route ------------------------------------------------------
def _callback(monkeypatch, oidc, state, cookie):
    import pep as _pep
    monkeypatch.setattr(_pep, "AUTH_MODE", "oidc")
    monkeypatch.setattr(_pep, "record_decision", lambda **k: None)
    h = object.__new__(_pep.Pep)
    h.headers = {"Cookie": cookie} if cookie else {}
    out = {"denied": None}
    def send(status, body, headers=None):
        out.update(status=status, body=body, headers=list(headers or []))
    h._send = send
    h._deny = lambda cause, **k: out.update(denied=cause)
    h._handle_auth(urllib.parse.urlparse(
        "/auth/callback?" + urllib.parse.urlencode(
            {"code": "c", "state": state})))
    return out


def test_callback_success_sets_session_and_clears_login_cookie(
        monkeypatch, oidc):
    _, state, _, nv = _begin(oidc)
    out = _callback(monkeypatch, oidc, state, nv)
    assert out["status"] == 302
    cookies = [v for k, v in out["headers"] if k == "Set-Cookie"]
    assert any(c.startswith(oidc.COOKIE_NAME + "=") for c in cookies)
    assert any(c.startswith("openddil_login_" + state[:16] + "=;")
               and "Max-Age=0" in c for c in cookies)


@pytest.mark.parametrize("mode", ["missing", "expired", "replayed",
                                  "bad_signature"])
def test_callback_login_state_failure_is_not_a_denial(
        monkeypatch, oidc, mode):
    _, state, _, nv = _begin(oidc, "/regional?role=hq")
    cookie = nv
    if mode == "missing":
        cookie = None
    elif mode == "expired":
        t0 = oidc._clock()
        monkeypatch.setattr(oidc, "_clock", lambda: t0 + 601)
    elif mode == "replayed":
        oidc.complete_login("c", state, nv)
    else:
        cookie = nv[:-3] + "AAA"
    out = _callback(monkeypatch, oidc, state, cookie)
    body = out["body"].decode()
    assert out["denied"] is None
    assert out["status"] == 400
    assert "Login timed out" in body and "Sign in again." in body
    for bad in ("AUTHZ DENIED", "reference", "TOPAZ", "Topaz"):
        assert bad not in body
    hdrs = dict(out["headers"])
    assert hdrs["Cache-Control"] == "no-store"
    assert "Max-Age=0" in hdrs["Set-Cookie"]
    if mode == "missing":
        assert 'href="/"' in body
    elif mode != "bad_signature":
        assert "/auth/login?next=%2Fregional%3Frole%3Dhq" in body


@pytest.mark.parametrize("state", [
    "abc\r\nSet-Cookie: x=1", "a;b=c" * 4, "short", "ü" * 20])
def test_callback_hostile_state_never_reaches_a_header(
        monkeypatch, oidc, state):
    _, _, _, nv = _begin(oidc)
    out = _callback(monkeypatch, oidc, state, nv)
    assert out["status"] == 400 and out["denied"] is None
    for _k, v in out["headers"]:
        assert "\r" not in v and "\n" not in v
    name = dict(out["headers"])["Set-Cookie"].split("=", 1)[0]
    assert re.fullmatch(r"openddil_login_[A-Za-z0-9_-]{0,16}", name)


def test_callback_token_exchange_failure_keeps_deny_path(monkeypatch, oidc):
    _, state, _, nv = _begin(oidc)
    def boom(*a, **k):
        raise oidc.AuthError("token endpoint said no")
    monkeypatch.setattr(oidc, "_http_json", boom)
    out = _callback(monkeypatch, oidc, state, nv)
    assert out["denied"] and "login failed" in out["denied"]
    assert "status" not in out
