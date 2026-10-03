"""client_credentials.py — a destination's OAuth2 client secret comes only
from an existing Kubernetes Secret, mounted as a file out of band.

Neither this module nor anything that configures it ever holds the secret
anywhere but a local read: `ClientCredentials` re-reads `client_secret_file`
from disk on every token refresh rather than caching it in memory, so a
rotated Secret (the file's content changing underneath a running pod) takes
effect on the next refresh without a restart.

NEVER LOG OR REPR THE SECRET OR THE ACCESS TOKEN. `__repr__` below prints
only the non-secret fields; every failure path logs the token URL and a
short reason class, never the body of the request or the response.

`parse_auth` is the one shared config-parsing entry point `forwarder.py`
and `intake.py` both call for their own `auth` config object -- a second
hand-rolled copy in each would be a second place the three field names and
the "unknown key" check could drift from the first.
"""
from __future__ import annotations

import json
import logging
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable, Mapping

log = logging.getLogger("egress.client_credentials")

HTTP_TIMEOUT_S = 10.0
EXPIRY_MARGIN_S = 30.0
DEFAULT_EXPIRES_IN_S = 60.0

_AUTH_FIELDS = ("token_url", "client_id", "client_secret_file")


def _default_post(url: str, data: bytes, headers: Mapping[str, str]) -> tuple[int, bytes]:
    req = urllib.request.Request(url, data=data, headers=dict(headers), method="POST")
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()
    except urllib.error.URLError as exc:
        # A connection error -- DNS failure, refused connection, timeout.
        raise OSError(str(exc.reason)) from exc


class ClientCredentials:
    """An OAuth2 client_credentials grant against one destination's token
    endpoint. `token()` returns a cached access token while more than
    `EXPIRY_MARGIN_S` remain of its `expires_in`, and otherwise refreshes:
    re-reads `client_secret_file` from disk and POSTs form-encoded
    `grant_type=client_credentials&client_id=...&client_secret=...`.

    Any failure -- a missing or empty secret file, a connection error, a
    non-2xx response, or a response without `access_token` -- returns
    `None` rather than raising, so a caller's existing "no credential yet"
    path (the same one a missing `token_file` already takes) handles this
    destination's outage too."""

    def __init__(
        self,
        token_url: str,
        client_id: str,
        client_secret_file: str,
        *,
        post: Callable[[str, bytes, Mapping[str, str]], tuple[int, bytes]] = _default_post,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.token_url = token_url
        self.client_id = client_id
        self.client_secret_file = client_secret_file
        self._post = post
        self._clock = clock
        self._token: str | None = None
        self._expires_at: float | None = None

    def __repr__(self) -> str:
        # Omits both the secret file's content and the cached token --
        # only the configuration shape, never a credential.
        return (
            f"ClientCredentials(token_url={self.token_url!r}, "
            f"client_id={self.client_id!r}, "
            f"client_secret_file={self.client_secret_file!r})"
        )

    def _read_secret(self) -> str | None:
        try:
            return Path(self.client_secret_file).read_text().strip()
        except OSError:
            return None

    def _warn(self, reason: str) -> None:
        log.warning(
            "client credentials unavailable for token_url=%s: %s", self.token_url, reason)

    def token(self) -> str | None:
        now = self._clock()
        if (self._token is not None and self._expires_at is not None
                and self._expires_at - now > EXPIRY_MARGIN_S):
            return self._token

        self._token = None
        self._expires_at = None

        secret = self._read_secret()
        if not secret:
            self._warn("missing_or_empty_secret_file")
            return None

        body = urllib.parse.urlencode({
            "grant_type": "client_credentials",
            "client_id": self.client_id,
            "client_secret": secret,
        }).encode("ascii")
        headers = {"Content-Type": "application/x-www-form-urlencoded"}

        try:
            status, resp_body = self._post(self.token_url, body, headers)
        except OSError:
            self._warn("connection_error")
            return None

        if not (200 <= status < 300):
            self._warn(f"http_error_{status}")
            return None

        try:
            parsed = json.loads(resp_body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._warn("invalid_response")
            return None

        access_token = parsed.get("access_token") if isinstance(parsed, Mapping) else None
        if not isinstance(access_token, str) or not access_token:
            self._warn("no_access_token")
            return None

        expires_in = parsed.get("expires_in", DEFAULT_EXPIRES_IN_S) if isinstance(parsed, Mapping) else None
        if not isinstance(expires_in, (int, float)) or isinstance(expires_in, bool) or expires_in <= 0:
            expires_in = DEFAULT_EXPIRES_IN_S

        self._token = access_token
        self._expires_at = now + float(expires_in)
        return self._token


def parse_auth(raw: Any, label: str) -> "ClientCredentials | None":
    """Parse an optional `auth` config object: `{"token_url", "client_id",
    "client_secret_file"}`, each required to be a non-empty string, with
    any other key an error. `raw is None` (the field was absent) returns
    `None` -- not an error, since `auth` is always optional.

    Raises a plain `ValueError` naming `label`; the caller (forwarder's
    `ForwardConfigError`, intake's `IntakeConfigError`) catches this and
    re-raises as its own config-error class, so the entry's error still
    surfaces in that module's own convention."""
    if raw is None:
        return None
    if not isinstance(raw, Mapping):
        raise ValueError(f"{label}: 'auth' must be an object")

    unknown = sorted(set(raw) - set(_AUTH_FIELDS))
    if unknown:
        raise ValueError(f"{label}: 'auth' has unknown key(s) {unknown}")

    values: dict[str, str] = {}
    for field_name in _AUTH_FIELDS:
        value = raw.get(field_name)
        if not isinstance(value, str) or not value:
            raise ValueError(f"{label}: 'auth.{field_name}' must be a non-empty string")
        values[field_name] = value

    return ClientCredentials(**values)
