"""Live long-polls must not compete with snapshot shapes for the same slot.

pep.py bounds resident shape BODIES with `_inflight`, a BoundedSemaphore
sized for the worst snapshot it has measured (see the comment above
MAX_INFLIGHT_SHAPES). A `live=true` request holds that same semaphore for as
long as it idles waiting for Electric's next change -- up to ~20s -- even
though a live delta holds at most one STREAM_CHUNK, not a snapshot body.
Eight quiet live polls can occupy every slot and starve a ninth shape, live
or not: measured on a deployed tier as a row written every 2s arriving in the
browser in batches of 7, 18-30s later.

This drives the REAL PEP handler (not a reimplementation) against a stub
Topaz and a stub Electric, the way test_pep_cm_write.py and
test_pep_egress_route.py do. test_pep_streaming.py reproduces the write-out
block in isolation and never imports pep, so it is NOT the pattern this file
follows, despite the surface resemblance.

Run:  py -3 -m pytest gateway
"""
from __future__ import annotations

import json
import os
import sys
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

ENTITLEMENTS = {"op.atl": ["ATL"]}


class FakeTopaz(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        subject = json.loads(body["input"])["subject"]
        nations = ENTITLEMENTS.get(subject, [])
        x = {"allow": bool(nations), "allowed_nations": nations,
             "subject_known": subject in ENTITLEMENTS,
             "policy_version": "p1", "corpus_version": "c1", "role": "edge-operator"}
        out = json.dumps({"response": {"result": [{"bindings": {"x": x}}]}}).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


class FakeElectric(BaseHTTPRequestHandler):
    """Answers every /v1/shape GET immediately, live or not. The starvation
    this test is about is the PEP holding its OWN semaphore through an idle
    wait -- it has nothing to do with how long Electric itself takes to
    answer, so this fake never sleeps and never actually long-polls."""

    def log_message(self, *a):
        pass

    def do_GET(self):  # noqa: N802
        messages = [{"headers": {"control": "up-to-date"}}]
        out = json.dumps(messages).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(out)))
        self.send_header("electric-handle", "fake-handle")
        self.send_header("electric-offset", "0")
        self.end_headers()
        self.wfile.write(out)


def _serve(handler) -> ThreadingHTTPServer:
    srv = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


@pytest.fixture(scope="module")
def pep_module():
    topaz = _serve(FakeTopaz)
    electric = _serve(FakeElectric)

    os.environ["OPENDDIL_ELECTRIC_URL"] = f"http://127.0.0.1:{electric.server_port}"
    os.environ["OPENDDIL_TOPAZ_URL"] = f"http://127.0.0.1:{topaz.server_port}"
    # Small on purpose: the test saturates every permit by hand, and a small
    # cap keeps that loop -- and the assertion that it actually saturated
    # something -- cheap.
    os.environ["OPENDDIL_MAX_INFLIGHT_SHAPES"] = "2"
    os.environ.pop("OPENDDIL_OIDC_ISSUER", None)
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    sys.modules.pop("pep", None)
    import pep  # noqa: PLC0415 -- must follow the env above

    pep.AUTH_MODE = "header"

    pep_srv = _serve(pep.Pep)
    yield pep, f"http://127.0.0.1:{pep_srv.server_port}"
    for s in (pep_srv, topaz, electric):
        s.shutdown()
    os.environ.pop("OPENDDIL_MAX_INFLIGHT_SHAPES", None)


def _get(url: str, subject: str, timeout: float = 10):
    req = urllib.request.Request(url)
    req.add_header("X-OpenDDIL-Subject", subject)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def test_live_shape_does_not_wait_behind_saturated_snapshot_slots(pep_module):
    """Saturate every MAX_INFLIGHT_SHAPES permit of the SNAPSHOT semaphore by
    hand, then prove a live long-poll still completes (it must have its own
    slot) while a plain shape request under the same saturation does NOT (it
    waits on the slot the test is holding) -- and completes once that slot is
    freed. This is the exact starvation measured on a deployed tier: a quiet
    live=true poll occupying a snapshot slot blocked a row written every 2s
    from reaching the browser for 20-30s."""
    pep_mod, base = pep_module
    cap = pep_mod.MAX_INFLIGHT_SHAPES
    acquired = 0
    results: dict[str, object] = {"live": None, "plain": None}
    plain_thread = None

    def do_live():
        results["live"] = _get(f"{base}/v1/shape?table=t&offset=-1&live=true", "op.atl")

    def do_plain():
        results["plain"] = _get(f"{base}/v1/shape?table=t&offset=-1", "op.atl")

    try:
        for _ in range(cap):
            pep_mod._inflight.acquire()
            acquired += 1

        live_thread = threading.Thread(target=do_live)
        live_thread.start()
        live_thread.join(timeout=3)
        assert not live_thread.is_alive(), (
            "live=true request did not complete within 3s while every "
            "snapshot-bound permit was held -- it is still sharing the "
            "snapshot semaphore instead of having its own bound")
        assert results["live"] is not None and results["live"][0] == 200, results["live"]

        plain_thread = threading.Thread(target=do_plain)
        plain_thread.start()
        plain_thread.join(timeout=1)
        assert plain_thread.is_alive(), (
            "a non-live shape request completed despite every snapshot "
            "permit being held -- the saturation in this test is not "
            "actually bounding anything, so the live assertion above is "
            "not meaningful either")
    finally:
        for _ in range(acquired):
            pep_mod._inflight.release()

    assert plain_thread is not None
    plain_thread.join(timeout=5)
    assert not plain_thread.is_alive()
    assert results["plain"] is not None and results["plain"][0] == 200, results["plain"]


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
