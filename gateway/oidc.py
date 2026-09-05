#!/usr/bin/env python3
"""OIDC authentication for the read-path PEP — the BFF half.

AUTHENTICATION ONLY. This module answers *who is this*. It must never answer
*what may they see* — that is Topaz's job, decided against the git-asserted
entitlements corpus, and the two must not both hold entitlements or the
deployment has two truths to keep in sync. Keycloak may well carry group or
role claims; this module deliberately does not read them.

The one value that crosses the seam is a stable subject id, used as the join
key into `policy/users.yaml`.

-----------------------------------------------------------------------------
WHY BACKEND-FOR-FRONTEND, AND NOT THE SPA PATTERN THE SIBLING PROJECT USES
-----------------------------------------------------------------------------
The co-located reasoning plane runs a PUBLIC Keycloak client: the browser
performs the OIDC flow and holds the tokens, and every backend validates
bearer tokens independently. Read from its realm ConfigMap and gateway
(`src/iagent/auth.py`) on 2026-09-05 rather than assumed. What that reading
found, stated precisely because "how hardened is it" deserves specifics
rather than an impression:

  GOOD, and inherited here verbatim in shape:
    * `PyJWKClient` with a cached JWKS — the right primitive, and the one
      that makes severance-tolerant validation possible at all.
    * `algorithms=["RS256"]` PINNED, which closes algorithm confusion and
      the `alg: none` family. Their own security test says so explicitly.
    * Authorization identity separated from `email`, with email treated as
      display/audit only and allowed to be absent.
    * Topaz as the SOLE source of entitlements, with no JWT-claim reads
      left. That is the same seam this file keeps.

  WEAKER, and deliberately NOT inherited:
    * `options={"verify_aud": False}` — the audience is not checked, with a
      comment that it is relaxed "for compatibility across client types". In
      a realm that also holds service clients, a token minted for any of
      them is accepted by the user-facing gateway. Audience is verified here.
    * No issuer check on decode. Verified here.
    * The UI client is `publicClient: true` with `redirectUris: ["*"]` and
      `webOrigins: ["*"]`. A wildcard redirect on a public client is the
      classic path to handing an authorization code to somewhere else.
    * `directAccessGrantsEnabled: true` on that same UI client — the
      resource-owner password grant, which OAuth 2.1 removes, sitting
      alongside the browser flow as a second way in.
    * No PKCE enforcement attribute, so a public client's intercepted code
      can be redeemed without a verifier.

  The browser flow itself is authorization CODE, not implicit — that part of
  the concern turns out to be unfounded, and it is worth saying so plainly
  rather than leaving a vague worry attached to it.

This deployment therefore uses a CONFIDENTIAL client driven server-side. The
browser receives an httpOnly cookie and never sees a token, so an XSS in the
frontend cannot exfiltrate credentials — it can only ride the session while
the page is open, which is a strictly smaller blast radius. PKCE is used even
though a confidential client does not require it: it costs nothing and it
removes the code-interception window entirely.

None of the above is a criticism of the sibling project's shipped state; its
gateway is a bearer-token API where the SPA pattern is conventional. It is a
record of which parts were copied and which were not, so that neither answer
has to be re-derived — and if this BFF proves out, the pattern is available
to flow back the other way.

-----------------------------------------------------------------------------
DDIL: WHAT SURVIVES A SEVERED LINK, AND WHAT DOES NOT
-----------------------------------------------------------------------------
Authentication has the same locality problem authorization does, and Slice 1
answers it the same way: not yet, honestly.

  * EXISTING SESSIONS SURVIVE. Sessions are validated against a locally
    cached JWKS and a local session table; neither needs Keycloak.
  * NEW LOGINS DO NOT. The authorization-code exchange is a live call to the
    token endpoint. A severed tier cannot mint a session.
  * SESSION LIFETIME IS THEREFORE A DDIL PARAMETER, not a security constant:
    long enough to outlast a plausible severance window, short enough to
    bound a stolen cookie. It is a chart value for exactly that reason.

Per-tier identity — a Keycloak replica or a local IdP — rides the same seam
as per-tier Topaz and lands with the tier-bridge slice. They are one
passenger, not two, and should be designed together.
"""
from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

log = logging.getLogger("pep.oidc")


class AuthError(Exception):
    """Authentication failed, refused, or could not be completed.

    ONE type for every failure, because every one of them is a deny. The
    caller distinguishes them by `cause`, which reaches the decision record;
    it must never distinguish them by CONTROL FLOW, because that is how a
    branch that returns something other than a deny gets added later."""


# --- configuration ----------------------------------------------------------
ISSUER = os.getenv("OPENDDIL_OIDC_ISSUER", "").rstrip("/")
CLIENT_ID = os.getenv("OPENDDIL_OIDC_CLIENT_ID", "openddil-pep")
CLIENT_SECRET = os.getenv("OPENDDIL_OIDC_CLIENT_SECRET", "")
# Where Keycloak sends the browser back. Must match the client's registered
# redirect URI EXACTLY — no wildcards. See the note above about what a
# wildcard redirect costs.
REDIRECT_URI = os.getenv("OPENDDIL_OIDC_REDIRECT_URI", "")
POST_LOGIN_PATH = os.getenv("OPENDDIL_OIDC_POST_LOGIN_PATH", "/")
SESSION_TTL = int(os.getenv("OPENDDIL_SESSION_TTL_SECONDS", "43200"))  # 12h
COOKIE_NAME = os.getenv("OPENDDIL_SESSION_COOKIE", "openddil_session")
COOKIE_SECURE = os.getenv("OPENDDIL_COOKIE_SECURE", "false").lower() == "true"
# SameSite: Lax by DEFAULT, and this is a considered choice rather than a
# weaker one taken by habit.
#
# `Strict` is the instinctive answer and it breaks the login round trip when
# the identity provider is on a different site: Keycloak redirects the
# browser to /auth/callback, the callback sets the cookie and redirects to
# the app, and that second navigation is attributed to the cross-site
# initiator — so a Strict cookie is withheld and the user lands logged out.
# A reload fixes it, which is the worst kind of bug: intermittent, and
# indistinguishable from a flaky login.
#
# `Lax` sends cookies on top-level GET navigations (exactly this case) and
# still withholds them from cross-site POSTs and subresources, which is the
# CSRF surface that matters. Where the IdP is a subdomain of the app —
# same-site under the eTLD+1 rule — `Strict` works and is available here.
COOKIE_SAMESITE = os.getenv("OPENDDIL_COOKIE_SAMESITE", "Lax")
HTTP_TIMEOUT = float(os.getenv("OPENDDIL_OIDC_TIMEOUT", "5.0"))

# --- the two-address problem, and why it needs naming ------------------------
# The identity provider has TWO addresses that must not be conflated:
#
#   ISSUER          the address the BROWSER uses, and the exact string that
#                   appears in the `iss` claim. Validation compares against
#                   this and nothing else.
#   INTERNAL_BASE   the address THIS PROCESS uses for server-side calls
#                   (discovery, JWKS, token exchange). Optional; defaults to
#                   ISSUER.
#
# They differ whenever the IdP is reached through an ingress from outside and
# a Service from inside — which is the normal case in Kubernetes, and the
# normal way this goes wrong. Two failure shapes, both of which look like
# something else:
#
#   * Point everything at the internal Service and tokens carry an internal
#     issuer the browser can never reach; login appears to work until the
#     redirect, then fails somewhere that looks like a networking problem.
#   * Point everything at the external host and the pod must resolve and
#     hairpin back through its own ingress — which sometimes works, and
#     therefore sometimes stops working, in a way that reads as flakiness.
#
# Splitting them makes the `iss` check strict AND the server-side calls
# direct. Endpoints from discovery are rewritten onto INTERNAL_BASE for calls
# this process makes; the authorization endpoint the browser is sent to is
# left on ISSUER, because that one is for the browser.
INTERNAL_BASE = os.getenv("OPENDDIL_OIDC_INTERNAL_ISSUER", "").rstrip("/")


def _internalize(url: str) -> str:
    """Rewrite a discovery endpoint onto the internal base, when one is set."""
    if not INTERNAL_BASE or not url.startswith(ISSUER):
        return url
    return INTERNAL_BASE + url[len(ISSUER):]

# JWKS refresh floor. The cache is what keeps a severed tier validating, so
# it is deliberately long-lived and refreshed only when a key id is unknown —
# never on a timer that would turn an unreachable IdP into a session outage.
_JWKS_MIN_REFRESH_SECONDS = float(os.getenv("OPENDDIL_JWKS_MIN_REFRESH", "300"))


def enabled() -> bool:
    """OIDC is configured. Absence is a MODE, not a failure — see pep.py's
    auth-mode note. A half-configured OIDC is a failure though, and says so."""
    if not ISSUER:
        return False
    missing = [n for n, v in (("CLIENT_SECRET", CLIENT_SECRET),
                              ("REDIRECT_URI", REDIRECT_URI)) if not v]
    if missing:
        raise AuthError(
            "OPENDDIL_OIDC_ISSUER is set but " + ", ".join(missing) +
            " is not. Refusing to start half-configured: a gateway that "
            "silently fell back to another auth mode would be a fail-open "
            "wearing a configuration error as a disguise.")
    return True


# --- provider metadata + keys ------------------------------------------------
_meta_lock = threading.Lock()
_meta: dict | None = None
_jwks: dict[str, dict] = {}
_jwks_fetched_at = 0.0


def _http_json(url: str, data: bytes | None = None,
               headers: dict | None = None) -> dict:
    req = urllib.request.Request(url, data=data, headers=headers or {},
                                 method="POST" if data else "GET")
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as exc:
        body = exc.read()[:400].decode("utf-8", "replace")
        raise AuthError(f"{url} returned HTTP {exc.code}: {body}") from exc
    except Exception as exc:  # noqa: BLE001 — every failure is an AuthError
        raise AuthError(f"{url} unreachable: {exc}") from exc


def metadata() -> dict:
    """OIDC discovery document, fetched once and cached for the process.

    Cached rather than re-fetched because a severed tier must keep serving
    existing sessions, and the endpoints do not move."""
    global _meta
    with _meta_lock:
        if _meta is None:
            base = INTERNAL_BASE or ISSUER
            doc = _http_json(f"{base}/.well-known/openid-configuration")
            # A discovery document fetched internally may still advertise the
            # external issuer (Keycloak does when KC_HOSTNAME is set). Trust
            # our OWN configuration for the issuer string rather than the
            # document: the `iss` check must compare against what the
            # deployer declared, not against what the IdP says about itself.
            if doc.get("issuer") not in (ISSUER, None):
                log.info("discovery advertises issuer %r; validating against "
                         "the configured %r", doc.get("issuer"), ISSUER)
            _meta = doc
        return _meta


def _b64url_decode(seg: str) -> bytes:
    return base64.urlsafe_b64decode(seg + "=" * (-len(seg) % 4))


def _refresh_jwks(force: bool = False) -> None:
    global _jwks_fetched_at
    now = time.time()
    if not force and (now - _jwks_fetched_at) < _JWKS_MIN_REFRESH_SECONDS:
        return
    doc = _http_json(_internalize(metadata()["jwks_uri"]))
    _jwks.update({k["kid"]: k for k in doc.get("keys", []) if k.get("kid")})
    _jwks_fetched_at = now


def _signing_key(kid: str) -> dict:
    """Key lookup with a single refresh on a miss.

    Refresh ONLY on an unknown kid, never on a schedule. A timer would turn
    an unreachable IdP into an outage for sessions that were already
    validated, which is precisely the severance behaviour this design is
    trying to avoid."""
    if kid in _jwks:
        return _jwks[kid]
    _refresh_jwks(force=True)
    if kid not in _jwks:
        raise AuthError(f"token signed by unknown key id {kid!r}")
    return _jwks[kid]


# --- RS256 verification, stdlib only -----------------------------------------
# The sibling project uses PyJWT. This process has no wheels available by
# design (see the bundle Dockerfile), so the verification is written out. It
# is a small amount of code and every line of it is a check that iagent's
# `jwt.decode` call either performs or was told to skip.
def _rsa_verify(message: bytes, signature: bytes, n_b64: str, e_b64: str) -> bool:
    """RSASSA-PKCS1-v1_5 over SHA-256, verified by re-encoding.

    ALGORITHM IS FIXED AT RS256 BY CONSTRUCTION — there is no path here that
    reads `alg` from the token and selects a verifier from it, which is the
    shape that produces algorithm-confusion and `alg: none` acceptance. A
    token claiming anything else is refused by the caller before arriving."""
    n = int.from_bytes(_b64url_decode(n_b64), "big")
    e = int.from_bytes(_b64url_decode(e_b64), "big")
    s = int.from_bytes(signature, "big")
    if s >= n:
        return False
    em = pow(s, e, n).to_bytes((n.bit_length() + 7) // 8, "big")
    # PKCS#1 v1.5: 0x00 0x01 FF..FF 0x00 DigestInfo(SHA-256)
    prefix = bytes.fromhex("3031300d060960864801650304020105000420")
    expected = b"\x00\x01" + b"\xff" * (len(em) - len(prefix) - 35) + b"\x00" \
        + prefix + hashlib.sha256(message).digest()
    return secrets.compare_digest(em, expected)


def verify_id_token(token: str, *, nonce: str | None = None) -> dict:
    """Verify signature, issuer, audience and expiry. Return the claims.

    EVERY CHECK BELOW IS ONE THE SIBLING PROJECT EITHER PERFORMS OR WAS
    EXPLICITLY TOLD TO SKIP, and the two it skips (`aud`, `iss`) are the two
    that decide whether a token minted for a DIFFERENT client in the same
    realm is accepted here. In a realm that also holds service clients — as
    this one does — that is the difference between a user gateway and an
    anything-in-the-realm gateway."""
    try:
        h_b64, p_b64, s_b64 = token.split(".")
        header = json.loads(_b64url_decode(h_b64))
        claims = json.loads(_b64url_decode(p_b64))
        signature = _b64url_decode(s_b64)
    except Exception as exc:  # noqa: BLE001
        raise AuthError(f"malformed token: {exc}") from exc

    if header.get("alg") != "RS256":
        raise AuthError(f"unexpected token algorithm {header.get('alg')!r}; "
                        "only RS256 is accepted")
    key = _signing_key(header.get("kid", ""))
    if key.get("kty") != "RSA":
        raise AuthError(f"unsupported key type {key.get('kty')!r}")
    if not _rsa_verify(f"{h_b64}.{p_b64}".encode(), signature,
                       key["n"], key["e"]):
        raise AuthError("token signature does not verify")

    if claims.get("iss") != ISSUER:
        raise AuthError(f"issuer mismatch: token says {claims.get('iss')!r}")

    aud = claims.get("aud")
    aud = [aud] if isinstance(aud, str) else list(aud or [])
    if CLIENT_ID not in aud:
        raise AuthError(f"audience {aud!r} does not include {CLIENT_ID!r}")

    now = time.time()
    if float(claims.get("exp", 0)) <= now:
        raise AuthError("token has expired")
    # `nbf` is optional; honour it when present rather than ignoring it.
    if "nbf" in claims and float(claims["nbf"]) > now + 60:
        raise AuthError("token is not yet valid")
    if nonce is not None and claims.get("nonce") != nonce:
        raise AuthError("nonce mismatch — possible replay of another login")
    if not claims.get("sub"):
        raise AuthError("token carries no subject")
    return claims


# --- login flow --------------------------------------------------------------
_pending: dict[str, dict] = {}
_pending_lock = threading.Lock()
_PENDING_TTL = 600


def _sweep(store: dict, lock: threading.Lock, key: str = "expires") -> None:
    now = time.time()
    with lock:
        for k in [k for k, v in store.items() if v.get(key, 0) < now]:
            store.pop(k, None)


def begin_login() -> str:
    """Return the URL to send the browser to, and remember the state.

    PKCE IS USED EVEN THOUGH THIS IS A CONFIDENTIAL CLIENT. It is not
    required for one, and it costs a hash — but it closes the
    code-interception window completely rather than relying on the secret
    alone, and it means the same flow is correct if this client were ever
    made public."""
    _sweep(_pending, _pending_lock)
    state = secrets.token_urlsafe(32)
    nonce = secrets.token_urlsafe(16)
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    with _pending_lock:
        _pending[state] = {"verifier": verifier, "nonce": nonce,
                           "expires": time.time() + _PENDING_TTL}
    q = urllib.parse.urlencode({
        "response_type": "code",
        "client_id": CLIENT_ID,
        "redirect_uri": REDIRECT_URI,
        "scope": "openid profile email",
        "state": state,
        "nonce": nonce,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    })
    # NOT internalized: this URL is handed to the BROWSER, which can only
    # reach the external address. Internalizing it here would produce a
    # redirect to a hostname that resolves only inside the cluster.
    return f"{metadata()['authorization_endpoint']}?{q}"


def complete_login(code: str, state: str) -> dict:
    """Exchange the code for tokens and return the verified claims.

    The state entry is consumed WHETHER OR NOT the exchange succeeds, so a
    replayed callback cannot retry against the same verifier."""
    with _pending_lock:
        entry = _pending.pop(state, None)
    if entry is None:
        raise AuthError("unknown or expired login state — possible CSRF, "
                        "a replayed callback, or a login that took too long")
    if entry["expires"] < time.time():
        raise AuthError("login state expired before the callback arrived")

    basic = base64.b64encode(
        f"{CLIENT_ID}:{CLIENT_SECRET}".encode()).decode()
    body = urllib.parse.urlencode({
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": REDIRECT_URI,
        "code_verifier": entry["verifier"],
    }).encode()
    tokens = _http_json(
        _internalize(metadata()["token_endpoint"]), data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded",
                 "Authorization": f"Basic {basic}"})
    id_token = tokens.get("id_token")
    if not id_token:
        raise AuthError("token endpoint returned no id_token")
    return verify_id_token(id_token, nonce=entry["nonce"])


# --- sessions ----------------------------------------------------------------
# In-memory, per-process, exactly like the shape-handle table this sits
# beside — and with the same honest limit: one replica. A restart forgets
# every session and users log in again, which fails CLOSED. Sharing sessions
# across replicas needs shared storage and is the same piece of work as
# sharing handle bindings; they should be done together or not at all.
_sessions: dict[str, dict] = {}
_sessions_lock = threading.Lock()


def create_session(claims: dict) -> tuple[str, dict]:
    """Mint a session from verified claims.

    THE SUBJECT IS `sub`, NEVER `email` OR `preferred_username`. Both of the
    others are mutable and re-assignable in an identity provider: an address
    freed and later handed to a different person would silently inherit that
    person's entitlements, and nothing in the corpus would look wrong. `sub`
    is opaque and stable, which is exactly why the entitlements corpus keys
    on it and carries the username only as a comment for human reviewers."""
    _sweep(_sessions, _sessions_lock)
    sid = secrets.token_urlsafe(32)
    session = {
        "subject": claims["sub"],
        # DISPLAY AND AUDIT ONLY. Never a join key, never a policy input.
        "username": claims.get("preferred_username") or "",
        "email": claims.get("email") or "",
        "name": claims.get("name") or "",
        "expires": min(time.time() + SESSION_TTL, float(claims.get("exp", 0))
                       or time.time() + SESSION_TTL),
    }
    with _sessions_lock:
        _sessions[sid] = session
    return sid, session


def get_session(sid: str | None) -> dict | None:
    if not sid:
        return None
    with _sessions_lock:
        s = _sessions.get(sid)
        if s is None:
            return None
        if s["expires"] < time.time():
            _sessions.pop(sid, None)
            return None
        return dict(s)


def destroy_session(sid: str | None) -> None:
    if sid:
        with _sessions_lock:
            _sessions.pop(sid, None)


def cookie_header(sid: str) -> str:
    parts = [f"{COOKIE_NAME}={sid}", "Path=/", "HttpOnly",
             f"SameSite={COOKIE_SAMESITE}", f"Max-Age={SESSION_TTL}"]
    if COOKIE_SECURE:
        parts.append("Secure")
    return "; ".join(parts)


def clear_cookie_header() -> str:
    parts = [f"{COOKIE_NAME}=", "Path=/", "HttpOnly",
             f"SameSite={COOKIE_SAMESITE}", "Max-Age=0"]
    if COOKIE_SECURE:
        parts.append("Secure")
    return "; ".join(parts)


def session_id_from_cookies(cookie_header_value: str | None) -> str | None:
    if not cookie_header_value:
        return None
    for part in cookie_header_value.split(";"):
        k, _, v = part.strip().partition("=")
        if k == COOKIE_NAME:
            return v or None
    return None
