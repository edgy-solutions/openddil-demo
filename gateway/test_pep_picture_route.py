"""The machine-to-machine /picture route, run through the real PEP handler.

The route authenticates a service client's OAuth2 Bearer access token,
maps the token's client to a release destination on the PEP's side, and
proxies to the assembler's picture endpoint. The consumer never chooses the
destination. Upstreams are loopback fakes; the JWKS cache is seeded with a
test key so nothing touches a network.

Run:  py -3 -m pytest gateway
"""
from __future__ import annotations

import base64
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

ISSUER = "https://idp.example/realms/openddil"
AUDIENCE = "openddil-picture"
USER_CLIENT = "openddil-pep"
KID = "picture-test-key"
EVENT = str(uuid.uuid4())

state = {"calls": 0, "queries": [], "mode": "ok"}
OK_BODY = {"event_id": EVENT, "kind": "report.v1", "destination": "system:dest-a",
           "decision_id": "d-1", "policy_version": "p1", "corpus_version": "c1",
           "record": {"a": 1, "nested": {"b": [1, 2, 3]}}}
DENY_BODY = {"decision_id": "d-2", "reason": "no_nation_overlap"}
MISSING_BODY = {"error": "unknown event"}


class FakePicture(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):  # noqa: N802
        state["calls"] += 1
        state["queries"].append(self.path)
        status, body = {"ok": (200, OK_BODY), "403": (403, DENY_BODY),
                        "404": (404, MISSING_BODY)}[state["mode"]]
        out = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


def _serve(handler) -> ThreadingHTTPServer:
    srv = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def b64u(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _pem(key) -> bytes:
    return key.private_bytes(serialization.Encoding.PEM,
                             serialization.PrivateFormat.PKCS8,
                             serialization.NoEncryption())


@pytest.fixture(scope="module")
def key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


@pytest.fixture(scope="module")
def other_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


@pytest.fixture(scope="module")
def env(key):
    picture = _serve(FakePicture)
    os.environ["OPENDDIL_ELECTRIC_URL"] = "http://127.0.0.1:9"
    os.environ["OPENDDIL_TOPAZ_URL"] = "http://127.0.0.1:9"
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    sys.modules.pop("pep", None)
    import oidc  # noqa: PLC0415
    import pep  # noqa: PLC0415

    pep.AUTH_MODE = "header"
    saved_issuer = oidc.ISSUER
    oidc.ISSUER = ISSUER
    pub = key.public_key().public_numbers()
    oidc._jwks[KID] = {
        "kty": "RSA", "kid": KID,
        "n": b64u(pub.n.to_bytes((pub.n.bit_length() + 7) // 8, "big")),
        "e": b64u(pub.e.to_bytes((pub.e.bit_length() + 7) // 8, "big")),
    }
    oidc._jwks_fetched_at = time.time() + 10_000
    pep.PICTURE_AUDIENCE = AUDIENCE
    pep.PICTURE_CLIENTS = {"client-a": "system:dest-a"}
    srv = _serve(pep.Pep)
    yield pep, f"http://127.0.0.1:{srv.server_port}", \
        f"http://127.0.0.1:{picture.server_port}"
    srv.shutdown()
    picture.shutdown()
    oidc.ISSUER = saved_issuer


@pytest.fixture
def url(env):
    pep, base, picture = env
    pep.PICTURE_URL = picture
    pep.PICTURE_CLIENTS = {"client-a": "system:dest-a"}
    state.update(calls=0, queries=[], mode="ok")
    return base


def mint(key, *, alg="RS256", kid=KID, **overrides) -> str:
    import jwt
    claims = {"iss": ISSUER, "aud": AUDIENCE, "azp": "client-a",
              "sub": "service-account-client-a",
              "exp": int(time.time()) + 300, "iat": int(time.time())}
    claims.update(overrides)
    if alg == "none":
        h = b64u(json.dumps({"alg": "none", "typ": "JWT", "kid": kid}).encode())
        p = b64u(json.dumps(claims).encode())
        return f"{h}.{p}."
    if alg == "HS256":
        return jwt.encode(claims, "x" * 64, algorithm="HS256", headers={"kid": kid})
    return jwt.encode(claims, _pem(key), algorithm=alg, headers={"kid": kid})


def _get(url: str, token: str | None = None, headers: dict | None = None):
    req = urllib.request.Request(url)
    if token is not None:
        req.add_header("Authorization", f"Bearer {token}")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read()), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}"), dict(e.headers)


def P(base):
    return f"{base}/picture?event_id={EVENT}"


def test_no_authorization_is_401_with_challenge(url):
    code, body, headers = _get(P(url))
    assert code == 401
    assert headers.get("WWW-Authenticate", "").startswith('Bearer realm="openddil"')
    assert "detail" in body
    assert state["calls"] == 0


def test_non_bearer_scheme_is_401(url):
    code, _, _ = _get(P(url), headers={"Authorization": "Basic abc"})
    assert code == 401
    assert state["calls"] == 0


@pytest.mark.parametrize("case", ["badsig", "issuer", "audience", "expired",
                                  "none", "hs256", "no_azp", "garbage"])
def test_invalid_token_is_401_and_upstream_not_called(url, key, other_key, case):
    token = {
        "badsig": lambda: mint(other_key),
        "issuer": lambda: mint(key, iss="https://evil.example/realms/x"),
        "audience": lambda: mint(key, aud="somebody-else"),
        "expired": lambda: mint(key, exp=int(time.time()) - 10),
        "none": lambda: mint(key, alg="none"),
        "hs256": lambda: mint(key, alg="HS256"),
        "no_azp": lambda: mint(key, azp=""),
        "garbage": lambda: "not.a.token",
    }[case]()
    code, body, headers = _get(P(url), token)
    assert code == 401
    assert 'error="invalid_token"' in headers.get("WWW-Authenticate", "")
    assert token not in json.dumps(body)
    assert state["calls"] == 0


def test_unmapped_client_is_403(url, key):
    code, body, _ = _get(P(url), mint(key, azp="client-unknown"))
    assert code == 403
    assert body["detail"] == "client not entitled to pictures"
    assert state["calls"] == 0


def test_destination_comes_from_the_mapping_not_the_caller(url, key):
    code, body, _ = _get(P(url) + "&destination=system:other", mint(key))
    assert code == 200
    assert body == OK_BODY
    assert state["calls"] == 1
    q = urllib.parse.parse_qs(urllib.parse.urlparse(state["queries"][0]).query)
    assert q["destination"] == ["system:dest-a"]
    assert q["event_id"] == [EVENT]
    assert "system:other" not in state["queries"][0]


@pytest.mark.parametrize("mode,status,body", [("403", 403, DENY_BODY),
                                              ("404", 404, MISSING_BODY)])
def test_upstream_refusals_pass_through(url, key, mode, status, body):
    state["mode"] = mode
    code, got, _ = _get(P(url), mint(key))
    assert (code, got) == (status, body)


def test_no_picture_url_is_404(env, key):
    pep, base, _ = env
    pep.PICTURE_URL = ""
    state.update(calls=0, queries=[], mode="ok")
    code, _, _ = _get(P(base), mint(key))
    assert code == 404
    assert state["calls"] == 0


def test_session_cookie_or_subject_header_without_bearer_is_401(url):
    code, _, _ = _get(P(url), headers={"X-OpenDDIL-Subject": "op.atl"})
    assert code == 401
    code, _, _ = _get(P(url), headers={"Cookie": "openddil_session=abc"})
    assert code == 401
    assert state["calls"] == 0


def test_user_id_token_is_401(url, key):
    code, _, _ = _get(P(url), mint(key, aud=USER_CLIENT, azp=USER_CLIENT))
    assert code == 401
    assert state["calls"] == 0


@pytest.mark.parametrize("q", ["", "?event_id=", "?event_id=not-a-uuid"])
def test_bad_event_id_is_400(url, key, q):
    code, _, _ = _get(f"{url}/picture{q}", mint(key))
    assert code == 400
    assert state["calls"] == 0


def test_upstream_down_is_502(env, key):
    pep, base, _ = env
    pep.PICTURE_URL = "http://127.0.0.1:9"
    pep.PICTURE_CLIENTS = {"client-a": "system:dest-a"}
    code, body, _ = _get(P(base), mint(key))
    assert code == 502
    assert body == {"detail": "picture service unreachable"}


def test_post_is_405(url, key):
    req = urllib.request.Request(P(url), data=b"{}", method="POST")
    req.add_header("Authorization", f"Bearer {mint(key)}")
    with pytest.raises(urllib.error.HTTPError) as ei:
        urllib.request.urlopen(req, timeout=10)
    assert ei.value.code == 405
    assert state["calls"] == 0


def test_oidc_not_enabled_is_404(url, env, key):
    pep = env[0]
    token = mint(key)
    saved = pep.oidc.ISSUER
    pep.oidc.ISSUER = ""
    try:
        code, _, _ = _get(P(url), token)
    finally:
        pep.oidc.ISSUER = saved
    assert code == 404
    assert state["calls"] == 0


def test_malformed_clients_env_is_an_empty_map(env):
    pep = env[0]
    assert pep._parse_picture_clients('{"a": 1}') == {}
    assert pep._parse_picture_clients("not json") == {}
    assert pep._parse_picture_clients("[]") == {}
    assert pep._parse_picture_clients('{"a": "system:x"}') == {"a": "system:x"}
    assert pep._parse_picture_clients("") == {}
