"""Element-state shapes through the PEP: grammar, edge-only serving, the
per-viewer bound, refcounted release with a grace, and the metrics endpoint.

Drives the REAL PEP handler against a stub Topaz and a stub Electric, the way
test_pep_handle_binding.py does. The stub Electric also accepts DELETE and
records it. Metric assertions HTTP-GET the PEP's own /metrics listener and
parse the text; nothing stands in for the exporter.

Run:  py -3 -m pytest gateway
"""
from __future__ import annotations

import hashlib
import json
import logging
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
ENTITLEMENTS = {"op.a": ["ATL"], "op.b": ["ATL"]}
COLS = "asset_id,element_path,depth"
ASSET_PLAIN = "asset_id = 'a1' AND depth <= 1"

TOPAZ_ASKS: list[str] = []
ELECTRIC_GETS: list[str] = []
ELECTRIC_DELETES: list[dict] = []


class FakeTopaz(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        subject = json.loads(body["input"])["subject"]
        TOPAZ_ASKS.append(subject)
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
    def log_message(self, *a):
        pass

    def do_GET(self):  # noqa: N802
        params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query,
                                       keep_blank_values=True)
        key = "|".join((params.get(k) or [""])[0] for k in ("table", "where", "columns"))
        ELECTRIC_GETS.append(key)
        handle = "electric-" + hashlib.sha256(key.encode()).hexdigest()[:16]
        out = json.dumps([{"headers": {"control": "up-to-date"}}]).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(out)))
        self.send_header("electric-handle", handle)
        self.send_header("electric-offset", "0")
        self.end_headers()
        self.wfile.write(out)

    def do_DELETE(self):  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        ELECTRIC_DELETES.append({
            "path": parsed.path,
            "params": urllib.parse.parse_qs(parsed.query, keep_blank_values=True)})
        self.send_response(202)
        self.send_header("Content-Length", "0")
        self.end_headers()


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
    saved = (pep.LABELED_TABLES, pep.GRACE_S, pep.HOLDER_IDLE_S,
             pep.VIEWER_SHAPE_MAX, pep.ELEMENT_DELETE_UPSTREAM)
    pep.LABELED_TABLES = {TABLE, "other_t"}
    pep.GRACE_S = 0.3
    pep.HOLDER_IDLE_S = 120.0
    pep.VIEWER_SHAPE_MAX = 8
    pep.ELEMENT_DELETE_UPSTREAM = False

    def wipe():
        with pep._el_lock:
            for st in pep._el_views.values():
                if st["grace"] is not None:
                    st["grace"].cancel()
            pep._el_views.clear()
            for k in pep._el_counts:
                pep._el_counts[k] = 0
        TOPAZ_ASKS.clear()
        ELECTRIC_GETS.clear()
        ELECTRIC_DELETES.clear()

    wipe()
    yield
    wipe()
    (pep.LABELED_TABLES, pep.GRACE_S, pep.HOLDER_IDLE_S,
     pep.VIEWER_SHAPE_MAX, pep.ELEMENT_DELETE_UPSTREAM) = saved


def _call(method: str, url: str, subject: str | None = "op.a"):
    req = urllib.request.Request(url, method=method)
    if subject:
        req.add_header("X-OpenDDIL-Subject", subject)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def _url(base: str, where: str | None, columns: str | None = COLS,
         table: str = TABLE, extra: dict | None = None) -> str:
    q = [("table", table), ("offset", "-1")]
    if where is not None:
        q.append(("where", where))
    if columns is not None:
        q.append(("columns", columns))
    q += list((extra or {}).items())
    return f"{base}/v1/shape?" + urllib.parse.urlencode(q)


def _get(base, where, subject="op.a", **kw):
    return _call("GET", _url(base, where, **kw), subject)


def _delete(base, where, subject="op.a", **kw):
    return _call("DELETE", _url(base, where, **kw), subject)


def _view_where(i: int) -> str:
    return f"asset_id = 'asset-{i}' AND depth <= 1"


def _metrics(murl: str) -> dict:
    with urllib.request.urlopen(f"{murl}/metrics", timeout=10) as r:
        text = r.read().decode()
    out = {}
    for line in text.splitlines():
        if line and not line.startswith("#"):
            name, value = line.rsplit(" ", 1)
            out[name] = float(value)
    return out


def _m(murl: str, name: str, outcome: str | None = None, tier: str = "edge-test") -> float:
    key = f'{name}{{tier="{tier}"'
    key += f',outcome="{outcome}"}}' if outcome else "}"
    return _metrics(murl)[key]


def _wait_for(pred, timeout=5.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if pred():
            return True
        time.sleep(0.05)
    return False


# --- grammar ---------------------------------------------------------------

ACCEPTED = [
    "asset_id = 'a1' AND depth <= 0",
    "asset_id = 'a1' AND depth <= 1",
    "asset_id = 'dis:1:1:1099' AND depth <= 1",
    "asset_id = 'a1' AND element_path LIKE 'MMIC-Front-3-4/%' AND depth <= 2",
    "asset_id = 'a1' AND element_path LIKE 'MMIC-Front-3-4/BP-0-1/%' AND depth <= 3",
    "asset_id = 'a1' AND element_path LIKE 'M/B/P/C/%' AND depth <= 5",
    # keywords case-insensitive, whitespace flexible
    "ASSET_ID='a1' and DEPTH<=1",
    "  asset_id   =   'a1'   AND\tdepth   <=   1  ",
    "asset_id = 'a1' and element_path like 'M-1/%' and depth <= 2",
]

REFUSED = [
    "asset_id = 'a1' AND depth <= 1 OR depth <= 0",                       # OR clause
    "asset_id = 'a1' OR asset_id = 'a2'",                                 # OR clause
    "asset_id = 'a1'",                                                    # missing depth
    "asset_id = 'a1' AND depth <= 2",                                     # over bound, no prefix
    "asset_id = 'a1' AND element_path LIKE 'M-1/%' AND depth <= 3",       # over bound, d=0
    "asset_id = 'a1' AND element_path LIKE 'M-1/B-2/%' AND depth <= 4",   # over bound, d=1
    "asset_id = 'a1' AND element_path LIKE 'M''1/%' AND depth <= 2",      # quote in prefix
    "asset_id = 'a1' AND element_path LIKE 'M 1/%' AND depth <= 2",       # space in prefix
    "asset_id = 'a1' AND element_path LIKE 'M%1/%' AND depth <= 2",       # % in prefix
    "asset_id = 'a1' AND depth <= 1 AND originator_nation = 'ATL'",       # extra predicate
    "asset_id = 'a1' AND element_path LIKE '/%' AND depth <= 2",          # empty prefix
    "asset_id = 'a1' AND element_path LIKE 'M-1//B/%' AND depth <= 3",    # empty segment
    "asset_id = 'a1' AND element_path LIKE 'M-1/' AND depth <= 2",        # no wildcard
    "asset_id = 'a1; DROP' AND depth <= 1",                               # bad asset id
    "asset_id = 'a1' AND depth <= -1",                                    # negative
    "asset_id = 'a1' AND depth < 1",                                      # wrong operator
    "depth <= 1 AND asset_id = 'a1'",                                     # reordered
    "",
]


@pytest.mark.parametrize("where", ACCEPTED)
def test_grammar_accepts(pep_module, where):
    pep, _b, _m_ = pep_module
    assert pep.element_where_refusal({"where": [where], "columns": [COLS]}) is None


@pytest.mark.parametrize("where", REFUSED)
def test_grammar_refuses(pep_module, where):
    pep, _b, _m_ = pep_module
    cause = pep.element_where_refusal({"where": [where], "columns": [COLS]})
    assert cause and cause.startswith("element shape:")


def test_grammar_refuses_missing_and_repeated_where(pep_module):
    pep, _b, _m_ = pep_module
    assert pep.element_where_refusal({"columns": [COLS]})
    assert pep.element_where_refusal(
        {"where": [ASSET_PLAIN, ASSET_PLAIN], "columns": [COLS]})


@pytest.mark.parametrize("columns", [None, "", "  "])
def test_missing_columns_refused_over_http(pep_module, columns):
    _pep, base, _m_ = pep_module
    status, body = _get(base, ASSET_PLAIN, columns=columns)
    assert status == 400 and b"columns are required" in body
    assert ELECTRIC_GETS == []


@pytest.mark.parametrize("extra", [
    {"log": "changes_only"},
    {"subset__limit": "5"},
    {"params[1]": "x"},
    {"params": '{"1":"x"}'},
])
def test_narrowing_params_refused_over_http(pep_module, extra):
    _pep, base, _m_ = pep_module
    status, _body = _get(base, ASSET_PLAIN, extra=extra)
    assert status == 400
    assert ELECTRIC_GETS == []


def test_http_accepts_and_refuses_with_a_cause(pep_module, caplog):
    _pep, base, _m_ = pep_module
    status, _ = _get(base, "asset_id = 'a1' and DEPTH<=1")
    assert status == 200
    ELECTRIC_GETS.clear()
    with caplog.at_level(logging.WARNING, logger="pep"):
        status, body = _get(base, "asset_id = 'a1' AND depth <= 1 OR true")
    assert status == 400
    assert b"where outside the prefix-and-depth grammar" in body
    assert sum("prefix-and-depth grammar" in r.getMessage() for r in caplog.records) == 1
    assert ELECTRIC_GETS == []


def test_other_tables_keep_their_behaviour(pep_module):
    _pep, base, _m_ = pep_module
    status, _ = _call("GET", f"{base}/v1/shape?table=other_t&offset=-1&where=x%3D1")
    assert status == 200


# --- P17: edge-only serving ---------------------------------------------------

def test_p17_table_not_labelled_is_refused_before_the_pdp(pep_module, caplog):
    pep, base, _m_ = pep_module
    pep.LABELED_TABLES = {"other_t"}
    with caplog.at_level(logging.WARNING, logger="pep"):
        status, _ = _get(base, ASSET_PLAIN)
    assert status == 403
    assert sum("GATEWAY REFUSED (PRE-PDP)" in r.getMessage() for r in caplog.records) == 1
    assert TOPAZ_ASKS == []
    assert ELECTRIC_GETS == []


# --- P18: per-viewer bound ----------------------------------------------------

def test_p18_ninth_distinct_view_is_refused(pep_module):
    _pep, base, murl = pep_module
    for i in range(1, 9):
        assert _get(base, _view_where(i))[0] == 200
    assert len(ELECTRIC_GETS) == 8
    before = _m(murl, "openddil_pep_viewer_shape_refusals_total")
    status, body = _get(base, _view_where(9))
    assert status == 403 and b"per-viewer bound 8 reached" in body
    assert len(ELECTRIC_GETS) == 8                     # Electric was not contacted
    assert _m(murl, "openddil_pep_viewer_shape_refusals_total") == before + 1
    assert _m(murl, "openddil_pep_viewer_shapes_max") == 8
    # re-reading a held view never counts
    assert _get(base, _view_where(1))[0] == 200
    assert _m(murl, "openddil_pep_viewer_shape_refusals_total") == before + 1
    # another principal has its own allowance
    assert _get(base, _view_where(9), subject="op.b")[0] == 200


def test_the_bound_is_per_principal_and_released_by_delete(pep_module):
    pep, base, _m_ = pep_module
    pep.VIEWER_SHAPE_MAX = 2
    assert _get(base, _view_where(1))[0] == 200
    assert _get(base, _view_where(2))[0] == 200
    assert _get(base, _view_where(3))[0] == 403
    assert _delete(base, _view_where(1))[0] == 204
    assert _get(base, _view_where(3))[0] == 200


# --- P19 / P20: release and upstream delete --------------------------------------

def test_p19_delete_after_grace_flag_on_deletes_by_handle(pep_module):
    pep, base, murl = pep_module
    pep.ELEMENT_DELETE_UPSTREAM = True
    assert _get(base, ASSET_PLAIN)[0] == 200
    assert _delete(base, ASSET_PLAIN)[0] == 204
    assert _wait_for(lambda: _m(murl, "openddil_pep_element_view_deletes_total", "deleted") == 1)
    assert len(ELECTRIC_DELETES) == 1
    d = ELECTRIC_DELETES[0]
    assert d["path"] == "/v1/shape"
    assert d["params"]["table"] == [TABLE]
    assert d["params"]["handle"][0].startswith("electric-")
    assert _m(murl, "openddil_pep_element_views") == 0


def test_p19_flag_off_skips_the_upstream_delete(pep_module):
    _pep, base, murl = pep_module
    assert _get(base, ASSET_PLAIN)[0] == 200
    assert _delete(base, ASSET_PLAIN)[0] == 204
    assert _wait_for(lambda: _m(murl, "openddil_pep_element_view_deletes_total",
                                "skipped_flag_off") == 1)
    assert ELECTRIC_DELETES == []
    assert _m(murl, "openddil_pep_element_view_deletes_total", "deleted") == 0
    assert _m(murl, "openddil_pep_element_views") == 0


def test_p20_two_principals_share_the_view(pep_module):
    pep, base, murl = pep_module
    pep.ELEMENT_DELETE_UPSTREAM = True
    assert _get(base, ASSET_PLAIN, subject="op.a")[0] == 200
    assert _get(base, ASSET_PLAIN, subject="op.b")[0] == 200
    assert _delete(base, ASSET_PLAIN, subject="op.a")[0] == 204
    time.sleep(pep.GRACE_S * 3)
    assert ELECTRIC_DELETES == []
    assert _m(murl, "openddil_pep_element_views") == 1
    assert _delete(base, ASSET_PLAIN, subject="op.b")[0] == 204
    assert _wait_for(lambda: len(ELECTRIC_DELETES) == 1)
    time.sleep(pep.GRACE_S * 2)
    assert len(ELECTRIC_DELETES) == 1
    assert _m(murl, "openddil_pep_element_views") == 0


def test_reacquire_within_grace_cancels_the_delete(pep_module):
    pep, base, murl = pep_module
    pep.ELEMENT_DELETE_UPSTREAM = True
    pep.GRACE_S = 1.0
    assert _get(base, ASSET_PLAIN)[0] == 200
    assert _delete(base, ASSET_PLAIN)[0] == 204
    assert _get(base, ASSET_PLAIN)[0] == 200
    time.sleep(1.6)
    assert ELECTRIC_DELETES == []
    assert _m(murl, "openddil_pep_element_view_deletes_total", "reacquired") == 1
    assert _m(murl, "openddil_pep_element_views") == 1


def test_delete_of_a_view_not_held_is_idempotent(pep_module):
    _pep, base, murl = pep_module
    assert _delete(base, ASSET_PLAIN)[0] == 204
    assert _delete(base, ASSET_PLAIN)[0] == 204
    assert _m(murl, "openddil_pep_element_views") == 0
    assert ELECTRIC_DELETES == []


def test_delete_on_other_tables_is_405_and_grammar_applies(pep_module):
    _pep, base, _m_ = pep_module
    assert _call("DELETE", f"{base}/v1/shape?table=other_t&where=x%3D1", "op.a")[0] == 405
    assert _delete(base, "asset_id = 'a1'")[0] == 400


def test_holder_idle_expiry_frees_the_bound(pep_module):
    pep, base, _m_ = pep_module
    pep.VIEWER_SHAPE_MAX = 2
    pep.HOLDER_IDLE_S = 0.4
    assert _get(base, _view_where(1))[0] == 200
    assert _get(base, _view_where(2))[0] == 200
    assert _get(base, _view_where(3))[0] == 403
    time.sleep(0.7)
    assert _get(base, _view_where(3))[0] == 200


def test_metrics_endpoint_is_not_on_the_main_port(pep_module):
    _pep, base, murl = pep_module
    assert _call("GET", f"{base}/metrics")[0] == 404
    assert _m(murl, "openddil_pep_element_views") == 0
