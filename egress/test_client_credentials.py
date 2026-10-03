"""Unit tests for egress/client_credentials.py.

Run: `python -m pytest egress/test_client_credentials.py -q` from
openddil-demo/.

No network: `ClientCredentials.token()` is exercised with an injected
`post` and an injected `clock`, the same seam `forwarder.py`'s `_deliver`
gives its own HTTP call and sleep. No secret or token value used in these
tests is ever asserted as ABSENT from caplog by accident -- the fixture
strings (`s3cr3t-value`, `tok3n-value`, rotated variants) are deliberately
distinctive so a leak would be unmistakable.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from client_credentials import ClientCredentials, parse_auth  # noqa: E402

TOKEN_URL = "http://example.invalid/oauth/token"
CLIENT_ID = "client-a"

SECRET_STRINGS = ("s3cr3t-value", "rotated-s3cr3t-value")
TOKEN_STRINGS = ("tok3n-value", "tok3n-value-2")


def _secret_file(tmp_path, value: str, name: str = "client-secret") -> str:
    path = tmp_path / name
    path.write_text(value)
    return str(path)


def _fake_post(responses):
    """Returns a `post` that pops one (status, body_dict) off `responses`
    per call, and records every call it was given."""
    calls: list[tuple[str, bytes, dict]] = []

    def post(url, data, headers):
        calls.append((url, data, dict(headers)))
        status, body = responses.pop(0)
        return status, json.dumps(body).encode("utf-8")

    post.calls = calls  # type: ignore[attr-defined]
    return post


def _assert_no_secret_or_token_leak(caplog, *secrets_and_tokens):
    text = "\n".join(rec.message for rec in caplog.records)
    for value in secrets_and_tokens:
        assert value not in text


# --- parse_auth ---------------------------------------------------------

def test_parse_auth_both_valid():
    creds = parse_auth(
        {"token_url": TOKEN_URL, "client_id": CLIENT_ID, "client_secret_file": "/x"},
        "entry",
    )
    assert isinstance(creds, ClientCredentials)
    assert creds.token_url == TOKEN_URL
    assert creds.client_id == CLIENT_ID
    assert creds.client_secret_file == "/x"


def test_parse_auth_neither_is_none():
    assert parse_auth(None, "entry") is None


def test_parse_auth_missing_field_raises():
    with pytest.raises(ValueError, match="entry"):
        parse_auth({"token_url": TOKEN_URL, "client_id": CLIENT_ID}, "entry")


def test_parse_auth_empty_field_raises():
    with pytest.raises(ValueError):
        parse_auth(
            {"token_url": "", "client_id": CLIENT_ID, "client_secret_file": "/x"}, "entry")


def test_parse_auth_unknown_key_raises():
    with pytest.raises(ValueError, match="entry"):
        parse_auth(
            {"token_url": TOKEN_URL, "client_id": CLIENT_ID,
             "client_secret_file": "/x", "extra": "nope"},
            "entry",
        )


def test_parse_auth_not_an_object_raises():
    with pytest.raises(ValueError):
        parse_auth("not-an-object", "entry")


# --- token(): caching, refresh, rotation --------------------------------

def test_token_caches_while_more_than_30s_remain(tmp_path):
    secret_path = _secret_file(tmp_path, SECRET_STRINGS[0])
    post = _fake_post([(200, {"access_token": TOKEN_STRINGS[0], "expires_in": 60})])
    clock = {"t": 0.0}
    creds = ClientCredentials(
        TOKEN_URL, CLIENT_ID, secret_path, post=post, clock=lambda: clock["t"])

    assert creds.token() == TOKEN_STRINGS[0]
    clock["t"] = 20.0  # 40s remain of the 60s expiry -- still cached
    assert creds.token() == TOKEN_STRINGS[0]
    assert len(post.calls) == 1


def test_token_refreshes_once_fewer_than_30s_remain(tmp_path):
    secret_path = _secret_file(tmp_path, SECRET_STRINGS[0])
    post = _fake_post([
        (200, {"access_token": TOKEN_STRINGS[0], "expires_in": 60}),
        (200, {"access_token": TOKEN_STRINGS[1], "expires_in": 60}),
    ])
    clock = {"t": 0.0}
    creds = ClientCredentials(
        TOKEN_URL, CLIENT_ID, secret_path, post=post, clock=lambda: clock["t"])

    assert creds.token() == TOKEN_STRINGS[0]
    clock["t"] = 31.0  # 29s remain -- must refresh
    assert creds.token() == TOKEN_STRINGS[1]
    assert len(post.calls) == 2


def test_default_expires_in_is_60s_when_absent(tmp_path):
    secret_path = _secret_file(tmp_path, SECRET_STRINGS[0])
    post = _fake_post([
        (200, {"access_token": TOKEN_STRINGS[0]}),
        (200, {"access_token": TOKEN_STRINGS[1], "expires_in": 60}),
    ])
    clock = {"t": 0.0}
    creds = ClientCredentials(
        TOKEN_URL, CLIENT_ID, secret_path, post=post, clock=lambda: clock["t"])

    assert creds.token() == TOKEN_STRINGS[0]
    clock["t"] = 29.0  # 31s remain of the default 60s -- still cached
    assert creds.token() == TOKEN_STRINGS[0]
    clock["t"] = 31.0  # 29s remain -- must refresh
    assert creds.token() == TOKEN_STRINGS[1]
    assert len(post.calls) == 2


def test_secret_file_is_re_read_on_refresh_rotation(tmp_path):
    secret_path = tmp_path / "client-secret"
    secret_path.write_text(SECRET_STRINGS[0])
    post = _fake_post([
        (200, {"access_token": TOKEN_STRINGS[0], "expires_in": 60}),
        (200, {"access_token": TOKEN_STRINGS[1], "expires_in": 60}),
    ])
    clock = {"t": 0.0}
    creds = ClientCredentials(
        TOKEN_URL, CLIENT_ID, str(secret_path), post=post, clock=lambda: clock["t"])

    assert creds.token() == TOKEN_STRINGS[0]

    secret_path.write_text(SECRET_STRINGS[1])  # the Secret rotates
    clock["t"] = 31.0  # force a refresh
    assert creds.token() == TOKEN_STRINGS[1]

    import urllib.parse
    body0 = dict(urllib.parse.parse_qsl(post.calls[0][1].decode("ascii")))
    body1 = dict(urllib.parse.parse_qsl(post.calls[1][1].decode("ascii")))
    assert body0["client_secret"] == SECRET_STRINGS[0]
    assert body1["client_secret"] == SECRET_STRINGS[1]


def test_token_posts_form_encoded_grant(tmp_path):
    secret_path = _secret_file(tmp_path, SECRET_STRINGS[0])
    post = _fake_post([(200, {"access_token": TOKEN_STRINGS[0], "expires_in": 60})])
    creds = ClientCredentials(TOKEN_URL, CLIENT_ID, secret_path, post=post, clock=lambda: 0.0)

    creds.token()
    url, data, headers = post.calls[0]
    assert url == TOKEN_URL
    assert headers["Content-Type"] == "application/x-www-form-urlencoded"

    import urllib.parse
    body = dict(urllib.parse.parse_qsl(data.decode("ascii")))
    assert body == {
        "grant_type": "client_credentials",
        "client_id": CLIENT_ID,
        "client_secret": SECRET_STRINGS[0],
    }


# --- token(): failure paths all return None, never raise ----------------

def test_missing_secret_file_returns_none(tmp_path, caplog):
    missing_path = str(tmp_path / "does-not-exist")
    creds = ClientCredentials(TOKEN_URL, CLIENT_ID, missing_path, clock=lambda: 0.0)

    with caplog.at_level("WARNING"):
        assert creds.token() is None
    assert any(TOKEN_URL in rec.message for rec in caplog.records)
    _assert_no_secret_or_token_leak(caplog, *SECRET_STRINGS, *TOKEN_STRINGS)


def test_empty_secret_file_returns_none(tmp_path, caplog):
    secret_path = _secret_file(tmp_path, "   \n")
    creds = ClientCredentials(TOKEN_URL, CLIENT_ID, secret_path, clock=lambda: 0.0)

    with caplog.at_level("WARNING"):
        assert creds.token() is None
    _assert_no_secret_or_token_leak(caplog, *SECRET_STRINGS, *TOKEN_STRINGS)


def test_http_error_returns_none(tmp_path, caplog):
    secret_path = _secret_file(tmp_path, SECRET_STRINGS[0])
    post = _fake_post([(503, {"error": "unavailable"})])
    creds = ClientCredentials(TOKEN_URL, CLIENT_ID, secret_path, post=post, clock=lambda: 0.0)

    with caplog.at_level("WARNING"):
        assert creds.token() is None
    assert any(TOKEN_URL in rec.message for rec in caplog.records)
    _assert_no_secret_or_token_leak(caplog, *SECRET_STRINGS, *TOKEN_STRINGS)


def test_connection_error_returns_none(tmp_path, caplog):
    secret_path = _secret_file(tmp_path, SECRET_STRINGS[0])

    def failing_post(url, data, headers):
        raise OSError("connection refused")

    creds = ClientCredentials(
        TOKEN_URL, CLIENT_ID, secret_path, post=failing_post, clock=lambda: 0.0)

    with caplog.at_level("WARNING"):
        assert creds.token() is None
    _assert_no_secret_or_token_leak(caplog, *SECRET_STRINGS, *TOKEN_STRINGS)


def test_response_without_access_token_returns_none(tmp_path, caplog):
    secret_path = _secret_file(tmp_path, SECRET_STRINGS[0])
    post = _fake_post([(200, {"expires_in": 60})])
    creds = ClientCredentials(TOKEN_URL, CLIENT_ID, secret_path, post=post, clock=lambda: 0.0)

    with caplog.at_level("WARNING"):
        assert creds.token() is None
    _assert_no_secret_or_token_leak(caplog, *SECRET_STRINGS, *TOKEN_STRINGS)


def test_repr_omits_secret_and_token(tmp_path):
    secret_path = _secret_file(tmp_path, SECRET_STRINGS[0])
    post = _fake_post([(200, {"access_token": TOKEN_STRINGS[0], "expires_in": 60})])
    creds = ClientCredentials(TOKEN_URL, CLIENT_ID, secret_path, post=post, clock=lambda: 0.0)
    creds.token()

    text = repr(creds)
    assert SECRET_STRINGS[0] not in text
    assert TOKEN_STRINGS[0] not in text
    assert TOKEN_URL in text
