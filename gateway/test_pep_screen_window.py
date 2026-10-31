"""The screen window on live element reads through the PEP.

Drives the REAL PEP handler against a stub Topaz and a stub Electric whose
live-mode answers are scripted by time. Metric assertions HTTP-GET the PEP's
own /metrics listener and parse the text.

The rule under test: value updates are folded and released once per window,
and a state transition (or a control other than up-to-date) is never delayed.

Run:  py -3 -m pytest gateway
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

TABLE = "asset_element_state"
COLS = "asset_id,element_path,depth"
WHERE = "asset_id = 'a1' AND depth <= 1"
OTHER_RAW = b'[ {"key":"k1",  "value":{"a":1}} ,\n{"headers":{"control":"up-to-date"}}]'
LIVE_WAIT_S = 5.0

SCRIPT: list[dict] = []
T0 = [0.0]
LOG: list[dict] = []


class FakeTopaz(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):  # noqa: N802
        self.rfile.read(int(self.headers["Content-Length"]))
        x = {"allow": True, "allowed_nations": ["ATL"], "subject_known": True,
             "policy_version": "p1", "corpus_version": "c1", "role": "edge-operator"}
        out = json.dumps({"response": {"result": [{"bindings": {"x": x}}]}}).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


class FakeElectric(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _reply(self, status, body, offset):
        self.send_response(status)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("electric-handle", "h-fixed")
        self.send_header("electric-offset", offset)
        self.send_header("electric-cursor", "c1")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        params = {k: v[0] for k, v in urllib.parse.parse_qs(
            urllib.parse.urlparse(self.path).query, keep_blank_values=True).items()}
        LOG.append({"t": time.monotonic(), "params": params})
        if params.get("table") != TABLE:
            self._reply(200, OTHER_RAW, "7_0")
            return
        off = params.get("offset", "-1")
        have = 0 if off == "-1" else int(off.split("_")[0])
        live = params.get("live") == "true"
        end = time.monotonic() + LIVE_WAIT_S
        while True:
            now = time.monotonic() - T0[0]
            ready = [e for e in SCRIPT if e["n"] > have and e["t"] <= now]
            if ready or not live or time.monotonic() >= end:
                break
            time.sleep(0.005)
        msgs, last = [], have
        for e in ready:
            if e["kind"] == "refetch":
                if not msgs:
                    body = b'[{"headers":{"control":"must-refetch"}}]'
                    self._reply(409, body, "0_0")
                    return
                break
            msgs.append(e["msg"])
            last = e["n"]
        body = json.dumps(msgs + [{"headers": {"control": "up-to-date"}}]).encode()
        self._reply(200, body, f"{last}_0")


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
    os.environ.pop("OPENDDIL_OIDC_ISSUER", None)
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    sys.modules.pop("pep", None)
    import pep  # noqa: PLC0415 -- must follow the env above

    pep.AUTH_MODE = "header"
    pep.PEP_TIER = "edge-test"
    pep_srv = _serve(pep.Pep)
    metrics = pep.start_metrics_server(0)
    yield (pep, f"http://127.0.0.1:{pep_srv.server_port}",
           f"http://127.0.0.1:{metrics.server_port}")
    for s in (pep_srv, metrics, topaz, electric):
        s.shutdown()


@pytest.fixture(autouse=True)
def _clean(pep_module):
    pep, _base, _m = pep_module
    saved = (pep.LABELED_TABLES, pep.GRACE_S, pep.SCREEN_WINDOW_S)
    pep.LABELED_TABLES = {TABLE, "other_t"}
    pep.GRACE_S = 30.0

    def wipe():
        with pep._el_lock:
            for st in pep._el_views.values():
                if st["grace"] is not None:
                    st["grace"].cancel()
            pep._el_views.clear()
            pep._screen_last.clear()
            for k in pep._screen_counts:
                pep._screen_counts[k] = 0
        SCRIPT.clear()
        LOG.clear()

    wipe()
    yield
    wipe()
    pep.LABELED_TABLES, pep.GRACE_S, pep.SCREEN_WINDOW_S = saved


def script(entries: list) -> None:
    """Entries are (seconds after now, message | "refetch"). Offsets are 1..N."""
    SCRIPT.clear()
    T0[0] = time.monotonic()
    for n, (t, what) in enumerate(entries, 1):
        if what == "refetch":
            SCRIPT.append({"n": n, "t": t, "kind": "refetch"})
        else:
            SCRIPT.append({"n": n, "t": t, "kind": "msg", "msg": what})


def upd(key: str, **value) -> dict:
    return {"key": key, "value": {"asset_id": "a1", "element_path": key, **value},
            "headers": {"operation": "update"}}


def get(base, *, offset="-1", handle=None, table=TABLE, extra=None, where=WHERE):
    q = [("table", table), ("offset", offset), ("live", "true"), ("where", where),
         ("columns", COLS)] + list((extra or {}).items())
    if handle:
        q.append(("handle", handle))
    req = urllib.request.Request(f"{base}/v1/shape?" + urllib.parse.urlencode(q))
    req.add_header("X-OpenDDIL-Subject", "op.a")
    t = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            status, hdrs, body = r.status, dict(r.headers.items()), r.read()
    except urllib.error.HTTPError as e:
        status, hdrs, body = e.code, dict(e.headers.items()), e.read()
    return status, hdrs, body, time.monotonic() - t


def metrics(murl: str) -> dict:
    with urllib.request.urlopen(f"{murl}/metrics", timeout=10) as r:
        text = r.read().decode()
    out = {}
    for line in text.splitlines():
        if line and not line.startswith("#"):
            name, value = line.rsplit(" ", 1)
            out[name] = float(value)
    return out


def delivered(murl: str, cls: str) -> float:
    return metrics(murl)[
        'openddil_delivery_messages_total{tier="edge-test",destination_kind="screen",'
        f'destination="pep",class="{cls}"}}']


def merged(murl: str) -> float:
    return metrics(murl)['openddil_delivery_merged_total{tier="edge-test"}']


def msgs_of(body: bytes) -> list:
    return [m for m in json.loads(body) if "control" not in m.get("headers", {})]


# --- transition latency ------------------------------------------------------
def test_transition_is_not_held_by_the_window(pep_module):
    _pep, base, murl = pep_module
    script([(0.0, upd("e1", temp=1)), (0.05, upd("e1", tx_active=True))])
    status, _h, body, took = get(base)
    assert status == 200
    ms = msgs_of(body)
    assert took < 0.2, took
    # both updates, in order: a transition is never folded into an earlier message
    assert [("temp" in m["value"], "tx_active" in m["value"]) for m in ms] == [
        (True, False), (False, True)]
    assert delivered(murl, "transition") == 1 and delivered(murl, "value") == 1


def test_value_then_transition_on_other_keys_keeps_order(pep_module):
    _pep, base, _m = pep_module
    script([(0.0, upd("e1", temp=1)), (0.05, upd("e2", health_band="red"))])
    _s, _h, body, took = get(base)
    assert took < 0.2, took
    assert [m["key"] for m in msgs_of(body)] == ["e1", "e2"]


# --- merge -------------------------------------------------------------------
def test_value_updates_fold_to_one_message(pep_module):
    _pep, base, murl = pep_module
    script([(0.03 * i, upd("e1", temp=i, value_changes=i)) for i in range(20)])
    status, _h, body, took = get(base)
    ms = msgs_of(body)
    assert status == 200 and len(ms) == 1
    assert ms[0]["value"]["temp"] == 19 and ms[0]["value"]["value_changes"] == 19
    assert 0.9 < took < 1.3, took
    assert merged(murl) == 19
    assert delivered(murl, "value") == 1
    assert delivered(murl, "transition") == 0


# --- window bound ------------------------------------------------------------
def test_one_response_per_window_per_view(pep_module):
    _pep, base, _m = pep_module
    script([(0.1 * i, upd("e1", temp=i)) for i in range(1, 31)])
    stamps, offset, handle = [], "-1", None
    start = time.monotonic()
    while time.monotonic() - start < 3.3:
        status, hdrs, body, _t = get(base, offset=offset, handle=handle)
        assert status == 200
        if msgs_of(body):
            stamps.append(time.monotonic() - start)
        offset, handle = hdrs["electric-offset"], hdrs["electric-handle"]
    gaps = [b - a for a, b in zip(stamps, stamps[1:])]
    assert len(stamps) >= 3
    assert all(0.9 <= g <= 1.1 for g in gaps), (stamps, gaps)


# --- must-refetch ------------------------------------------------------------
def test_must_refetch_status_passes_at_once(pep_module):
    _pep, base, _m = pep_module
    script([(0.0, upd("e1", temp=1)), (0.3, "refetch")])
    status, hdrs, body, took = get(base)
    assert status == 409 and 0.2 < took < 0.6, took
    assert hdrs.get("electric-handle") == "h-fixed"
    assert b"must-refetch" in body


def test_must_refetch_control_in_body_flushes_at_once(pep_module):
    _pep, base, _m = pep_module
    ctl = {"headers": {"control": "must-refetch"}}
    script([(0.0, upd("e1", temp=1)), (0.2, ctl)])
    status, _h, body, took = get(base)
    assert status == 200 and took < 0.5, took
    assert any(m.get("headers", {}).get("control") == "must-refetch" for m in json.loads(body))


# --- replica -----------------------------------------------------------------
def test_replica_forced_on_element_live_reads_only(pep_module):
    _pep, base, _m = pep_module
    script([(0.0, upd("e1", tx_active=True))])
    get(base, extra={"replica": "full"})
    assert [e["params"].get("replica") for e in LOG] == ["default"]
    LOG.clear()
    get(base, table="other_t", where="nation = 'ATL'", extra={"replica": "full"})
    assert [e["params"].get("replica") for e in LOG] == ["full"]


# --- passthrough -------------------------------------------------------------
def test_non_element_live_read_is_byte_identical(pep_module):
    _pep, base, _m = pep_module
    status, _h, body, _t = get(base, table="other_t", where="nation = 'ATL'")
    assert status == 200 and body == OTHER_RAW


# --- offset honesty ----------------------------------------------------------
def test_offset_is_the_last_upstream_offset_in_the_body(pep_module):
    _pep, base, _m = pep_module
    script([(0.0, upd("e1", temp=1)), (0.1, upd("e2", temp=2)), (5.0, upd("e3", temp=3))])
    status, hdrs, body, took = get(base)
    assert status == 200 and 0.9 < took < 1.3, took
    assert [m["key"] for m in msgs_of(body)] == ["e1", "e2"]
    assert hdrs["electric-offset"] == "2_0"
