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
