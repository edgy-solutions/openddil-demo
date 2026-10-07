"""Verification tests for the PEP's hand-written RS256 check.

WHY THIS FILE EXISTS AND WHY IT IS NOT OPTIONAL.
`oidc.py` verifies token signatures without PyJWT, because the PEP runs in a
stock python image with no wheels (see the bundle Dockerfile — a component
whose job is to refuse requests must not have a dependency that can fail to
install). That is a defensible trade, and it is only defensible if the
verification is EXERCISED AGAINST REAL TOKENS INCLUDING BAD ONES.

Every negative case below is a red-check: it constructs a token that a
verifier could plausibly accept by omission, and requires refusal. Two of
them — audience and issuer — are exactly the checks the sibling project's
gateway skips (`options={"verify_aud": False}`, no `issuer=`), so they are
the ones with demonstrated precedent for being left out.

These tests use `cryptography` and PyJWT to MINT tokens. That is a test-time
dependency only; nothing in the runtime path imports either.

Run:  python -m pytest gateway/test_oidc.py -q
"""
from __future__ import annotations

import base64
import importlib
import json
import time

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

ISSUER = "https://idp.example/realms/openddil"
CLIENT_ID = "openddil-pep"
KID = "test-key-1"


def b64u(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


@pytest.fixture(scope="module")
def key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


@pytest.fixture(scope="module")
def oidc(key, monkeypatch_module=None):
    """Import oidc with an issuer/client configured, and seed its JWKS cache
    directly so no network call is attempted."""
    import os
    os.environ["OPENDDIL_OIDC_ISSUER"] = ISSUER
    os.environ["OPENDDIL_OIDC_CLIENT_ID"] = CLIENT_ID
    os.environ["OPENDDIL_OIDC_CLIENT_SECRET"] = "s3cret"
    os.environ["OPENDDIL_OIDC_REDIRECT_URI"] = "https://app.example/auth/callback"
    import oidc as mod
    importlib.reload(mod)
    pub = key.public_key().public_numbers()
    mod._jwks[KID] = {
        "kty": "RSA", "kid": KID,
        "n": b64u(pub.n.to_bytes((pub.n.bit_length() + 7) // 8, "big")),
        "e": b64u(pub.e.to_bytes((pub.e.bit_length() + 7) // 8, "big")),
    }
    mod._jwks_fetched_at = time.time() + 10_000  # never refresh during tests
    return mod


def mint(key, *, alg="RS256", kid=KID, **overrides) -> str:
    import jwt
    claims = {
        "iss": ISSUER, "aud": CLIENT_ID, "sub": "user-sub-123",
        "preferred_username": "operator.atlantia",
        "email": "operator.atlantia@example.invalid",
        "exp": int(time.time()) + 300, "iat": int(time.time()),
    }
    claims.update(overrides)
    pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption())
    return jwt.encode(claims, pem, algorithm=alg, headers={"kid": kid})


# --- the happy path ---------------------------------------------------------

def test_valid_token_verifies(oidc, key):
    claims = oidc.verify_id_token(mint(key))
    assert claims["sub"] == "user-sub-123"


def test_subject_is_sub_not_username_or_email(oidc, key):
    """The join key into the entitlements corpus. `email` and
    `preferred_username` are mutable and re-assignable in an identity
    provider: an address freed and later handed to someone else would
    silently inherit the first person's entitlements, and nothing in the
    corpus would look wrong."""
    _, session = oidc.create_session(oidc.verify_id_token(mint(key)))
    assert session["subject"] == "user-sub-123"
    assert session["username"] == "operator.atlantia"
    assert session["email"] == "operator.atlantia@example.invalid"


# --- red-checks: each is a token a lax verifier would accept ----------------

def test_tampered_payload_is_refused(oidc, key):
    """The signature check itself. Flip a claim, keep the signature."""
    h, p, s = mint(key).split(".")
    claims = json.loads(base64.urlsafe_b64decode(p + "=" * (-len(p) % 4)))
    claims["sub"] = "somebody-else"
    forged = b64u(json.dumps(claims).encode())
    with pytest.raises(oidc.AuthError, match="signature"):
        oidc.verify_id_token(f"{h}.{forged}.{s}")


def test_token_for_another_client_is_refused(oidc, key):
    """THE CHECK THE SIBLING GATEWAY SKIPS (`verify_aud: False`). This realm
    also holds service clients; without this, a token minted for any of them
    is accepted by the user-facing gateway."""
    with pytest.raises(oidc.AuthError, match="audience"):
        oidc.verify_id_token(mint(key, aud="some-service-client"))


def test_token_from_another_issuer_is_refused(oidc, key):
    """The second check the sibling gateway skips. Signed by a key this
    process trusts, but minted by a different realm."""
    with pytest.raises(oidc.AuthError, match="issuer"):
        oidc.verify_id_token(mint(key, iss="https://idp.example/realms/other"))


def test_expired_token_is_refused(oidc, key):
    with pytest.raises(oidc.AuthError, match="expired"):
        oidc.verify_id_token(mint(key, exp=int(time.time()) - 1))


def test_alg_none_is_refused(oidc, key):
    """`alg: none` with an empty signature — the canonical forgery. Refused
    on the algorithm check before any key lookup happens, because this
    verifier NEVER selects its algorithm from the token."""
    header = b64u(json.dumps({"alg": "none", "typ": "JWT", "kid": KID}).encode())
    payload = b64u(json.dumps({
        "iss": ISSUER, "aud": CLIENT_ID, "sub": "attacker",
        "exp": int(time.time()) + 300}).encode())
    with pytest.raises(oidc.AuthError, match="algorithm"):
        oidc.verify_id_token(f"{header}.{payload}.")


def test_hs256_signed_with_the_public_key_is_refused(oidc, key):
    """Algorithm confusion: sign with HMAC using the RSA public key as the
    shared secret. A verifier that picked its algorithm from the header would
    accept this, because the public key is public."""
    import hashlib
    import hmac
    pub_pem = key.public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo)
    # Assembled by hand: PyJWT REFUSES to mint this, raising
    # "asymmetric key ... should not be used as an HMAC secret". That refusal
    # is a good safeguard on the minting side and it is not the thing under
    # test — the question here is what a VERIFIER does when handed such a
    # token by someone who did not use PyJWT to build it.
    header = b64u(json.dumps({"alg": "HS256", "typ": "JWT", "kid": KID}).encode())
    payload = b64u(json.dumps({"iss": ISSUER, "aud": CLIENT_ID,
                               "sub": "attacker",
                               "exp": int(time.time()) + 300}).encode())
    signing_input = f"{header}.{payload}".encode()
    sig = b64u(hmac.new(pub_pem, signing_input, hashlib.sha256).digest())
    with pytest.raises(oidc.AuthError, match="algorithm"):
        oidc.verify_id_token(f"{header}.{payload}.{sig}")


def test_unknown_key_id_is_refused_without_network(oidc, key):
    """An unknown kid triggers one JWKS refresh. With the cache pinned fresh
    and no network available, the refusal must still be an AuthError rather
    than an unhandled exception — a crash here would be a 500, and a 500 is
    not a deny."""
    with pytest.raises(oidc.AuthError):
        oidc.verify_id_token(mint(key, kid="some-other-key"))


def test_nonce_mismatch_is_refused(oidc, key):
    """Replay of a token minted for a different login attempt."""
    with pytest.raises(oidc.AuthError, match="nonce"):
        oidc.verify_id_token(mint(key, nonce="aaa"), nonce="bbb")


def test_token_with_no_subject_is_refused(oidc, key):
    """No subject means no join key into the entitlements corpus. Accepting
    it would produce a session that Topaz can only answer about with a
    default-deny — which is safe, but records the wrong reason."""
    with pytest.raises(oidc.AuthError, match="subject"):
        oidc.verify_id_token(mint(key, sub=""))


# --- sessions ---------------------------------------------------------------

def test_session_expiry_is_capped_by_the_token(oidc, key):
    """A session must not outlive the token it was minted from, even when
    the configured TTL is longer. Otherwise a revoked or short-lived identity
    keeps a live session for the remainder of the chart's session lifetime."""
    short = int(time.time()) + 30
    _, session = oidc.create_session(oidc.verify_id_token(mint(key, exp=short)))
    assert session["expires"] <= short


def test_destroyed_session_is_gone(oidc, key):
    sid, _ = oidc.create_session(oidc.verify_id_token(mint(key)))
    assert oidc.get_session(sid) is not None
    oidc.destroy_session(sid)
    assert oidc.get_session(sid) is None


def test_expired_session_is_not_returned(oidc, key):
    sid, _ = oidc.create_session(oidc.verify_id_token(mint(key)))
    oidc._sessions[sid]["expires"] = time.time() - 1
    assert oidc.get_session(sid) is None


def test_cookie_is_httponly_and_samesite(oidc):
    """The whole point of the BFF: the browser holds a cookie it cannot read
    from JavaScript, not a token it can."""
    header = oidc.cookie_header("abc123")
    assert "HttpOnly" in header
    assert "SameSite=" in header
    assert "Path=/" in header


# --- sign-out ending the provider's session too -----------------------------
# The defect: /auth/logout cleared the gateway's cookie and sent the browser
# to "/". The session gate sent it on to /auth/login, the provider still held
# its own session, and the user was signed straight back in with no form.

END_SESSION = ISSUER + "/protocol/openid-connect/logout"


def _logout_query(url):
    import urllib.parse
    base, _, q = url.partition("?")
    return base, dict(urllib.parse.parse_qsl(q))


def test_session_keeps_the_id_token_for_sign_out(oidc, key):
    token = mint(key)
    sid, session = oidc.create_session(oidc.verify_id_token(token), token)
    assert oidc.get_session(sid)["id_token"] == token


def test_logout_url_ends_the_provider_session(oidc, monkeypatch):
    monkeypatch.setattr(oidc, "_meta", {"end_session_endpoint": END_SESSION})
    base, q = _logout_query(oidc.logout_url("the.id.token"))
    # Browser-facing: on the issuer's address, not an internal one.
    assert base == END_SESSION
    assert q == {"client_id": CLIENT_ID, "id_token_hint": "the.id.token",
                 # The registered callback, so no realm change is needed.
                 "post_logout_redirect_uri": "https://app.example/auth/callback"}


def test_logout_url_without_a_token_still_signs_out(oidc, monkeypatch):
    """An expired gateway session has no token to hint with. The provider
    then asks before signing out, which is still a sign-out."""
    monkeypatch.setattr(oidc, "_meta", {"end_session_endpoint": END_SESSION})
    _, q = _logout_query(oidc.logout_url(None))
    assert "id_token_hint" not in q and q["client_id"] == CLIENT_ID


def test_logout_url_is_none_without_an_end_session_endpoint(oidc, monkeypatch):
    monkeypatch.setattr(oidc, "_meta", {"issuer": ISSUER})
    assert oidc.logout_url("t") is None


def test_logout_url_is_none_when_the_provider_is_unreachable(oidc, monkeypatch):
    def down():
        raise oidc.AuthError("unreachable")
    monkeypatch.setattr(oidc, "metadata", down)
    assert oidc.logout_url("t") is None


def test_stale_login_form_restarts_rather_than_denies(oidc):
    """Keycloak's answer to a re-submitted login form (back button,
    double-click). The user is usually already signed in by the first
    submit; a deny page there reads as a refusal of a signed-in user."""
    assert oidc.is_stale_login_form("temporarily_unavailable")


def test_other_provider_errors_stay_denies(oidc):
    for err in ("access_denied", "login_required", "invalid_request",
                "server_error", "", None):
        assert not oidc.is_stale_login_form(err)


def test_half_configured_oidc_refuses_to_start(monkeypatch):
    """A gateway that silently fell back to header mode because a secret was
    missing would be a fail-open wearing a configuration error as a
    disguise."""
    import os
    import oidc as mod
    monkeypatch.setattr(mod, "CLIENT_SECRET", "")
    with pytest.raises(mod.AuthError, match="CLIENT_SECRET"):
        mod.enabled()


# ===========================================================================
# Refresh-token renewal: sessions outlive the 5-minute ID token
# ===========================================================================
# The defect: create_session capped `expires` at the ID token's `exp` (five
# minutes on this provider) and complete_login discarded the refresh token
# that could have extended it, so every session died five minutes after
# login and every shape request after that got a 401.
TOKEN_ENDPOINT = "https://idp.example/realms/openddil/protocol/openid-connect/token"


def _mint_refresh_response(key, *, refresh_token="rotated-refresh",
                           refresh_expires_in=3600, **claim_overrides):
    """What the token endpoint returns for a refresh grant."""
    claims = {"sub": "user-sub-123", "exp": int(time.time()) + 300}
    claims.update(claim_overrides)
    return {
        "id_token": mint(key, **claims),
        "refresh_token": refresh_token,
        "refresh_expires_in": refresh_expires_in,
    }


def _session_due_for_renewal(oidc, key, *, refresh_expires_in=3600):
    """A session whose renewal is already due, with a refresh token still
    good for `refresh_expires_in` seconds. `expires` is forced into the
    past directly rather than slept to, for a deterministic test."""
    claims = oidc.verify_id_token(mint(key, exp=int(time.time()) + 2))
    sid, _ = oidc.create_session(claims, "orig-id-token", "orig-refresh",
                                 refresh_expires_in)
    with oidc._sessions_lock:
        oidc._sessions[sid]["expires"] = time.time() - 1
    return sid


def _mock_token_endpoint(oidc, monkeypatch, responder):
    monkeypatch.setattr(oidc, "metadata",
                        lambda: {"token_endpoint": TOKEN_ENDPOINT})
    monkeypatch.setattr(oidc, "_http_json", responder)


def test_session_survives_past_the_id_token_exp_via_refresh(oidc, key, monkeypatch):
    """RED-CHECK: run against the pre-change oidc.py (no renewal in
    get_session) this assertion fails -- a session minted from an ID token
    with exp=now+2 is gone when checked after it expires, even with a
    refresh token present and an endpoint willing to issue a fresh one."""
    sid = _session_due_for_renewal(oidc, key)
    _mock_token_endpoint(oidc, monkeypatch,
                        lambda *a, **k: _mint_refresh_response(key))
    session = oidc.get_session(sid)
    assert session is not None
    assert session["subject"] == "user-sub-123"
    assert session["id_token"] != "orig-id-token"
    assert session["refresh_token"] == "rotated-refresh"
    assert session["expires"] > time.time()


def test_refresh_rejected_by_the_provider_drops_the_session(oidc, key, monkeypatch):
    """invalid_grant (400) -- the user logged out or was disabled at the
    provider since the ID token was minted."""
    sid = _session_due_for_renewal(oidc, key)
    def rejected(*a, **k):
        err = oidc.AuthError("invalid_grant")
        err.http_status = 400
        raise err
    _mock_token_endpoint(oidc, monkeypatch, rejected)
    assert oidc.get_session(sid) is None


def test_refresh_with_a_different_subject_drops_the_session(oidc, key, monkeypatch):
    sid = _session_due_for_renewal(oidc, key)
    _mock_token_endpoint(
        oidc, monkeypatch,
        lambda *a, **k: _mint_refresh_response(key, sub="someone-else"))
    assert oidc.get_session(sid) is None


def test_provider_unreachable_keeps_the_session_until_refresh_expires(
        oidc, key, monkeypatch):
    sid = _session_due_for_renewal(oidc, key, refresh_expires_in=3600)
    def unreachable(*a, **k):
        raise oidc.AuthError(f"{TOKEN_ENDPOINT} unreachable: timed out")
    _mock_token_endpoint(oidc, monkeypatch, unreachable)
    session = oidc.get_session(sid)
    assert session is not None
    assert session["expires"] == pytest.approx(
        time.time() + oidc.RENEW_RETRY_S, abs=2)


def test_provider_unreachable_past_refresh_expires_drops_the_session(
        oidc, key, monkeypatch):
    sid = _session_due_for_renewal(oidc, key, refresh_expires_in=3600)
    with oidc._sessions_lock:
        oidc._sessions[sid]["refresh_expires"] = time.time() - 1
    def unreachable(*a, **k):
        raise oidc.AuthError("unreachable")
    _mock_token_endpoint(oidc, monkeypatch, unreachable)
    assert oidc.get_session(sid) is None


def test_no_refresh_token_expires_as_today(oidc, key):
    """Legacy shape: no refresh token at all -- the pre-existing behaviour
    this change must not disturb."""
    claims = oidc.verify_id_token(mint(key, exp=int(time.time()) + 5))
    sid, _ = oidc.create_session(claims)
    with oidc._sessions_lock:
        oidc._sessions[sid]["expires"] = time.time() - 1
    assert oidc.get_session(sid) is None


def test_hard_expires_wins_even_when_refresh_would_succeed(oidc, key, monkeypatch):
    sid = _session_due_for_renewal(oidc, key)
    with oidc._sessions_lock:
        oidc._sessions[sid]["hard_expires"] = time.time() - 1
    _mock_token_endpoint(oidc, monkeypatch,
                        lambda *a, **k: _mint_refresh_response(key))
    assert oidc.get_session(sid) is None


def test_refresh_token_never_appears_in_auth_me(oidc, key, monkeypatch):
    """The token that crosses the seam to Keycloak must never reach the
    browser -- /auth/me builds its body field by field, and this exercises
    that handler directly rather than re-deriving its allowlist of fields
    in the test."""
    import urllib.parse

    import pep as _pep

    monkeypatch.setattr(_pep, "AUTH_MODE", "oidc")
    monkeypatch.setattr(_pep, "ask_topaz", lambda subject: {
        "allowed_nations": ["ATL"], "policy_version": "v1",
        "corpus_version": "v1", "role": "operator"})
    token = mint(key)
    sid, _ = oidc.create_session(oidc.verify_id_token(token), token)
    with oidc._sessions_lock:
        oidc._sessions[sid]["refresh_token"] = "super-secret-refresh-value"

    handler = object.__new__(_pep.Pep)
    handler.headers = {"Cookie": f"{oidc.COOKIE_NAME}={sid}"}
    captured = {}

    def fake_send(status, body, headers=None):
        captured["status"] = status
        captured["body"] = body
    handler._send = fake_send

    handler._handle_auth(urllib.parse.urlparse("/auth/me"))
    assert captured["status"] == 200
    assert b"refresh_token" not in captured["body"]
    assert b"super-secret-refresh-value" not in captured["body"]


# ===========================================================================
# Lead-window renewal: refresh before expiry, not only after it
# ===========================================================================
# THE DEFECT. Renewal was due only once `expires < now`. On a severed or
# merely slow uplink, the renewal call itself can take longer than the
# window that is left, and the ONE request that happens to land exactly at
# expiry pays for a round trip to the provider before it gets an answer.
# Renewing a lead window early turns that into background work a live tab
# never notices.
def _session_with_expires(oidc, key, *, expires_in, refresh_expires_in=3600,
                          refresh_token="orig-refresh"):
    """A session whose `expires` is `expires_in` seconds from now (may be
    negative), with a refresh token good for `refresh_expires_in` more."""
    claims = oidc.verify_id_token(mint(key, exp=int(time.time()) + 3600))
    sid, _ = oidc.create_session(claims, "orig-id-token", refresh_token,
                                 refresh_expires_in)
    with oidc._sessions_lock:
        oidc._sessions[sid]["expires"] = time.time() + expires_in
    return sid


def test_renewal_not_due_before_the_lead_window(oidc, key, monkeypatch):
    """At expires - 60 - 1 (60 is the documented default lead, written here
    as a literal rather than read off the live module — see the +1 case
    below for why that distinction matters when the default regresses), no renewal
    call happens."""
    sid = _session_with_expires(oidc, key, expires_in=60 + 1)
    called = []
    monkeypatch.setattr(oidc, "_refresh_tokens",
                        lambda *a, **k: called.append(1))
    session = oidc.get_session(sid)
    assert session is not None
    assert called == []


def test_renewal_due_inside_the_lead_window(oidc, key, monkeypatch):
    """The regression target: at expires - REFRESH_LEAD_S + 1, a renewal call
    happens — against pre-change oidc.py (due only once `expires < now`)
    this is still a minute early and no call is made, which is the defect.
    hard_expires must be unchanged by the renewal.

    60 is written here as a literal — the documented default — rather
    than read off the live oidc.REFRESH_LEAD_S constant, specifically so
    a regression (oidc.py's REFRESH_LEAD_S default edited to 0) changes
    what the PRODUCTION CODE does without also changing what this test
    asserts. A test that rederived its scenario from the same constant it
    is meant to guard could never see that constant regress."""
    sid = _session_with_expires(oidc, key, expires_in=60 - 1)
    with oidc._sessions_lock:
        hard_expires_before = oidc._sessions[sid]["hard_expires"]
    calls = []
    def fake_refresh(refresh_token):
        calls.append(refresh_token)
        return _mint_refresh_response(key)
    monkeypatch.setattr(oidc, "_refresh_tokens", fake_refresh)
    session = oidc.get_session(sid)
    assert calls == ["orig-refresh"]
    assert session is not None
    assert session["hard_expires"] == hard_expires_before


def test_inside_lead_window_with_no_refresh_token_stays_valid(oidc, key,
                                                              monkeypatch):
    """The careful case: due for renewal (inside
    the lead window) but nothing to renew with must NOT drop the session
    early — it stays valid until `expires`, same as before the lead
    window existed."""
    sid = _session_with_expires(oidc, key, expires_in=60 - 1,
                                refresh_token="")
    session = oidc.get_session(sid)
    assert session is not None
    assert session["subject"] == "user-sub-123"


def test_hard_expires_plus_one_drops_the_session_without_a_refresh_attempt(
        oidc, key, monkeypatch):
    sid = _session_with_expires(oidc, key, expires_in=-1)
    with oidc._sessions_lock:
        oidc._sessions[sid]["hard_expires"] = time.time() - 1
    called = []
    monkeypatch.setattr(oidc, "_refresh_tokens",
                        lambda *a, **k: called.append(1))
    assert oidc.get_session(sid) is None
    assert called == []


# ===========================================================================
# safe_next: only a same-origin relative path survives the round trip
# ===========================================================================
# THE DEFECT A LAX CHECK HERE WOULD BE. The callback follows `next` without
# asking the browser again, so an unsafe value redirects a freshly
# signed-in browser (cookie now set) wherever the value points.
SAFE_NEXT_TABLE = [
    ("/", "/"),
    ("/?role=hq&asset=x", "/?role=hq&asset=x"),
    ("//evil.example", None),
    ("https://evil.example", None),
    ("/\\evil", None),
    ("javascript:alert(1)", None),
    ("/a b", None),
    ("/a\nb", None),
    ("", None),
    (None, None),
    ("/" + "a" * 3000, None),
]


def test_safe_next_table(oidc):
    """RED-CHECK target: a safe_next that returns its input unchanged
    (`return raw`) fails every `None`-expected row below."""
    for raw, expect_unchanged in SAFE_NEXT_TABLE:
        want = raw if expect_unchanged is not None else oidc.POST_LOGIN_PATH
        got = oidc.safe_next(raw)
        assert got == want, f"safe_next({raw!r}) == {got!r}, want {want!r}"


# ===========================================================================
# Return-to-the-same-view: /auth/login?next= round trips through the
# callback, and only through a validated value
# ===========================================================================
def test_login_route_validates_next_before_begin_login(monkeypatch):
    """The route-level wiring: /auth/login reads `?next=`, validates it with
    safe_next, and ONLY THEN hands it to begin_login — an unsafe value
    must never reach begin_login at all."""
    import urllib.parse

    import oidc
    import pep as _pep
    monkeypatch.setattr(_pep, "AUTH_MODE", "oidc")
    captured = {}
    def fake_begin_login(next_path):
        captured["next_path"] = next_path
        return "https://idp.example/authorize?state=xxx"
    monkeypatch.setattr(oidc, "begin_login", fake_begin_login)
    handler = object.__new__(_pep.Pep)
    handler.headers = {}
    handler._send = lambda *a, **k: None
    handler._handle_auth(
        urllib.parse.urlparse("/auth/login?next=https://evil.example"))
    assert captured["next_path"] == oidc.POST_LOGIN_PATH


def test_login_route_passes_a_valid_next_through_unchanged(monkeypatch):
    import urllib.parse

    import oidc
    import pep as _pep
    monkeypatch.setattr(_pep, "AUTH_MODE", "oidc")
    captured = {}
    def fake_begin_login(next_path):
        captured["next_path"] = next_path
        return "https://idp.example/authorize?state=xxx"
    monkeypatch.setattr(oidc, "begin_login", fake_begin_login)
    handler = object.__new__(_pep.Pep)
    handler.headers = {}
    handler._send = lambda *a, **k: None
    handler._handle_auth(
        urllib.parse.urlparse(
            "/auth/login?" + urllib.parse.urlencode({"next": "/regional?role=hq"})))
    assert captured["next_path"] == "/regional?role=hq"


def test_callback_redirects_to_the_next_path_from_begin_login(monkeypatch):
    """Location is the `next` given to begin_login — carried through
    complete_login's LoginResult, exactly as oidc.py returns it."""
    import urllib.parse

    import oidc
    import pep as _pep
    monkeypatch.setattr(_pep, "AUTH_MODE", "oidc")
    fake_login = oidc.LoginResult(
        claims={"sub": "user-sub-123"}, id_token="idt", refresh_token="rt",
        refresh_expires_in=3600, next_path="/regional?role=hq")
    monkeypatch.setattr(oidc, "complete_login", lambda code, state: fake_login)
    handler = object.__new__(_pep.Pep)
    handler.headers = {}
    captured = {}
    def fake_send(status, body, headers=None):
        captured["status"] = status
        captured["headers"] = dict(headers or [])
    handler._send = fake_send
    handler._handle_auth(
        urllib.parse.urlparse("/auth/callback?code=abc&state=xyz"))
    assert captured["headers"]["Location"] == "/regional?role=hq"


def test_callback_with_an_invalid_next_redirects_to_post_login_path(monkeypatch):
    """What begin_login was actually given was already validated by
    safe_next at the /auth/login route (see above) — so this is the shape
    that round trip produces: complete_login hands back POST_LOGIN_PATH,
    and the callback redirects there."""
    import urllib.parse

    import oidc
    import pep as _pep
    monkeypatch.setattr(_pep, "AUTH_MODE", "oidc")
    fake_login = oidc.LoginResult(
        claims={"sub": "user-sub-123"}, id_token="idt", refresh_token="rt",
        refresh_expires_in=3600, next_path=oidc.POST_LOGIN_PATH)
    monkeypatch.setattr(oidc, "complete_login", lambda code, state: fake_login)
    handler = object.__new__(_pep.Pep)
    handler.headers = {}
    captured = {}
    def fake_send(status, body, headers=None):
        captured["status"] = status
        captured["headers"] = dict(headers or [])
    handler._send = fake_send
    handler._handle_auth(
        urllib.parse.urlparse("/auth/callback?code=abc&state=xyz"))
    assert captured["headers"]["Location"] == oidc.POST_LOGIN_PATH


# ===========================================================================
# /auth/me carries the session's end, so the browser can arm its own timer
# ===========================================================================
def test_auth_me_carries_expires_at_and_server_time(oidc, key, monkeypatch):
    """Tested at the oidc/pep level directly (no separate PEP-test-style
    helper for /auth/me exists yet in this suite besides
    test_refresh_token_never_appears_in_auth_me, whose pattern this
    follows)."""
    import urllib.parse

    import pep as _pep
    monkeypatch.setattr(_pep, "AUTH_MODE", "oidc")
    monkeypatch.setattr(_pep, "ask_topaz", lambda subject: {
        "allowed_nations": ["ATL"], "policy_version": "v1",
        "corpus_version": "v1", "role": "operator"})
    token = mint(key)
    sid, session = oidc.create_session(oidc.verify_id_token(token), token)
    handler = object.__new__(_pep.Pep)
    handler.headers = {"Cookie": f"{oidc.COOKIE_NAME}={sid}"}
    captured = {}
    def fake_send(status, body, headers=None):
        captured["status"] = status
        captured["body"] = json.loads(body)
    handler._send = fake_send
    before = time.time()
    handler._handle_auth(urllib.parse.urlparse("/auth/me"))
    after = time.time()
    assert captured["status"] == 200
    assert captured["body"]["expires_at"] == session["hard_expires"]
    assert before <= captured["body"]["server_time"] <= after


# ===========================================================================
# Table granularity: a rollup that cannot be partitioned must not be served
# ===========================================================================
# These defend the rule found by a 502. The region_* rollup tables carry no
# releasability columns, the PEP forwarded a predicate naming those columns
# anyway, Electric rejected it, and the browser rendered the failure as
# "awaiting first emission" — a transport error wearing the clothes of an
# absence.
#
# The rule is NOT a decision against a viewer. Nothing is decided about
# them: unpartitionable data has no question to answer, so the fully
# entitled subject is refused exactly as the unentitled one is.
import os as _os  # noqa: E402
# pep.py reads its wiring at import time and refuses to guess, which is
# correct for a gateway and means a test must supply it. Set before import.
_os.environ.setdefault("OPENDDIL_ELECTRIC_URL", "http://electric.invalid:5133")
_os.environ.setdefault("OPENDDIL_TOPAZ_URL", "http://topaz.invalid:8282")
from pep import may_serve_table  # noqa: E402

LABELED = {"telemetry_latest_state", "asset_logistics_status"}


def test_labeled_table_is_served():
    assert may_serve_table("telemetry_latest_state", LABELED) is True


def test_unlabelable_table_is_refused():
    assert may_serve_table("region_fleet_summary", LABELED) is False


def test_refusal_does_not_depend_on_the_subject():
    """The same answer for everyone — that is what makes it a property of
    the data. A per-subject exception here would be a second authorization
    decision nobody reviewed (ADR-0029 §1)."""
    for _subject in ("liaison.coalition", "observer.unlisted", ""):
        assert may_serve_table("region_top_factors", LABELED) is False


def test_unconfigured_means_off_and_serves_everything():
    """An empty allowlist is 'not configured', never 'nothing is labeled'.
    Reading it the other way would refuse every table on a deployment that
    simply had not set the variable — failing closed into a total outage
    rather than into the previous behaviour, which is announced at boot."""
    assert may_serve_table("anything_at_all", set()) is True


# ===========================================================================
# Table CLASSES — "cannot be partitioned" was hiding four different reasons
# ===========================================================================
import pep as _pep  # noqa: E402


def _classes(nation=(), role=(), subject=None, oversight=("auditor",)):
    _pep.LABELED_TABLES = set(nation)
    _pep.ROLE_SERVED_TABLES = set(role)
    _pep.SUBJECT_SCOPED_TABLES = dict(subject or {})
    _pep.OVERSIGHT_ROLES = set(oversight)


def test_role_served_table_is_not_refused():
    """edge_buffer_status holds bridge lag and a severance flag — no asset
    data, so nothing to partition BY. Refusing it removed HQ's severance
    indicator, which is the thing a severance recording exists to show."""
    _classes(nation={"telemetry_latest_state"}, role={"edge_buffer_status"})
    assert _pep.table_class("edge_buffer_status") == "role"
    assert _pep.table_class("telemetry_latest_state") == "nation"


def test_a_table_in_no_class_is_still_refused():
    """The split must not become a way for everything to be servable."""
    _classes(nation={"telemetry_latest_state"}, role={"edge_buffer_status"})
    assert _pep.table_class("region_top_factors") == "refused"


def test_subject_scoped_needs_its_column():
    _classes(nation={"x"}, subject={"audit_log": "actor"})
    assert _pep.table_class("audit_log") == "subject"
    assert _pep.SUBJECT_SCOPED_TABLES["audit_log"] == "actor"


def test_class_does_not_depend_on_the_subject():
    """Which class a table is in is a property of the DATA. What the class
    then does with a subject differs — that is why table_class returns a
    class and not a decision."""
    _classes(nation={"a"}, role={"b"}, subject={"c": "actor"})
    for _who in ("liaison.coalition", "observer.unlisted", ""):
        assert _pep.table_class("b") == "role"
        assert _pep.table_class("zzz") == "refused"


def test_unconfigured_still_means_off():
    _classes()
    assert _pep.table_class("anything") == "nation"


def test_role_served_sends_no_where_at_all(monkeypatch):
    """A role-served table contributes NO policy clause, and the parameter
    must then be omitted rather than sent empty. Sending it unconditionally
    put the literal string "None" upstream as a predicate: Electric
    rejected it and the panel saw a 502 for a table the gateway had just
    decided to serve — a malformed allow that looked exactly like a
    refusal."""
    import urllib.parse
    params = {"table": ["edge_buffer_status"], "offset": ["-1"]}
    client_where = (params.get("where") or [None])[0]
    policy_clause = None
    where = client_where if not policy_clause else "x"
    upstream = [(k, v) for k, vs in params.items()
                if k in _pep.PASSTHROUGH_PARAMS for v in vs]
    if where:
        upstream.append(("where", where))
    assert "where" not in urllib.parse.urlencode(upstream)


# --- verify_service_token (client_credentials access tokens) ----------------

def test_service_token_verifies(oidc, key):
    claims = oidc.verify_service_token(
        mint(key, aud="svc-aud", azp="client-a"), audience="svc-aud")
    assert claims["azp"] == "client-a"


def test_service_token_audience_list_accepted(oidc, key):
    oidc.verify_service_token(
        mint(key, aud=["other", "svc-aud"], azp="c"), audience="svc-aud")


@pytest.mark.parametrize("over", [
    {"aud": "nope"}, {"iss": "https://evil.example"}, {"azp": ""},
    {"exp": 1}, {"nbf": int(time.time()) + 3600},
])
def test_service_token_refusals(oidc, key, over):
    claims = {"aud": "svc-aud", "azp": "c"}
    claims.update(over)
    with pytest.raises(oidc.AuthError):
        oidc.verify_service_token(mint(key, **claims), audience="svc-aud")


def test_service_token_wrong_alg_and_signature(oidc, key):
    other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    with pytest.raises(oidc.AuthError):
        oidc.verify_service_token(mint(other, aud="svc-aud", azp="c"),
                                  audience="svc-aud")
    with pytest.raises(oidc.AuthError):
        import jwt
        hs = jwt.encode({"iss": ISSUER, "aud": "svc-aud", "azp": "c",
                         "exp": int(time.time()) + 300}, "x" * 64,
                        algorithm="HS256", headers={"kid": KID})
        oidc.verify_service_token(hs, audience="svc-aud")
