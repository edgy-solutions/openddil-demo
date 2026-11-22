"""The PEP's row filter, with the label-key switch OFF, is byte-for-byte the
filter it was before the switch existed (DESIGN-2026-11-06 s2, s5 check 3).

`testdata/where_clauses_switch_off.json` was generated once from the code as
it stood before `row_filter` was added, by driving each of the six
`policy_predicate` call sites through its route with a fake Electric / fake
`_follow_shape` that records the `where` it was given. It is never
regenerated. Every route is driven for the nation lists [], [ATL],
[ATL, BDR] and [BDR, ATL]; where the route refuses before it builds a filter
(a subject with no nations), the golden records `null` and the status.

Everything here is synthetic: invented nations ATL, BDR and invented ids.

Run:  python -m pytest -q   (from gateway/)
"""
from __future__ import annotations

import json
import os
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
GOLDEN = HERE / "testdata" / "where_clauses_switch_off.json"

NATION_LISTS = {
    "empty": [],
    "atl": ["ATL"],
    "atl_bdr": ["ATL", "BDR"],
    "bdr_atl": ["BDR", "ATL"],
}
# subject -> (nations, role). Every subject is known to the PDP; an empty
# nation list is "known, entitled to nothing" (allow false).
ENT = {f"s-{k}": (v, "supervisor") for k, v in NATION_LISTS.items()}

state: dict = {}


class FakeTopaz(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        subject = json.loads(body["input"])["subject"]
        nations, role = ENT.get(subject, ([], "observer"))
        x = {"allow": bool(nations), "allowed_nations": nations,
             "subject_known": subject in ENT, "policy_version": "p1",
             "corpus_version": "c1", "role": role}
        out = json.dumps({"response": {"result": [{"bindings": {"x": x}}]}}).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


class FakeElectric(BaseHTTPRequestHandler):
    """Records the query of every GET and answers an empty, up-to-date shape."""

    def log_message(self, *a):
        pass

    def do_GET(self):  # noqa: N802
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query,
                                  keep_blank_values=True)
        state["electric_seen"].append({k: v for k, v in q.items()})
        out = json.dumps([{"headers": {"control": "up-to-date"}}]).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("electric-handle", "h-1")
        self.send_header("electric-offset", "0_0")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


def _serve(handler):
    srv = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


@pytest.fixture(scope="module")
def rig():
    topaz, electric = _serve(FakeTopaz), _serve(FakeElectric)
    os.environ["OPENDDIL_ELECTRIC_URL"] = f"http://127.0.0.1:{electric.server_port}"
    os.environ["OPENDDIL_TOPAZ_URL"] = f"http://127.0.0.1:{topaz.server_port}"
    os.environ.pop("OPENDDIL_OIDC_ISSUER", None)
    sys.path.insert(0, str(HERE))
    sys.modules.pop("pep", None)
    import pep  # noqa: PLC0415 -- must follow the env above

    pep.AUTH_MODE = "header"
    front = _serve(pep.Pep)
    yield pep, f"http://127.0.0.1:{front.server_port}"
    for s in (front, topaz, electric):
        s.shutdown()


# ---- the rows the fake shape read returns ---------------------------------
OBSERVED = {"asset_id": "dis:1:1:7", "edge_id": "edge-a", "platform_variant": "SENTRY",
            "region_id": "reg-1", "kinematics": '{"position": {"lat": 1.5, "lon": 2.5}}',
            "last_sample_at": "2026-10-15T12:00:00Z"}
FIELDING_ROW = {"serial": "SN-1", "platform_variant": "SENTRY", "unit": "u1",
                "originator_nation": "ATL", "releasable_to": "{BDR}",
                "due_by": "2999-01-01 00:00:00+00", "fielded_to": "edge-a"}

REPORT_ROWS = {
    "asset_cm_state": [
        {"asset_id": "asset-a", "edge_id": "edge-t", "region_id": None,
         "originator_nation": "ATL", "releasable_to": "{}",
         "manual_discrepancies": json.dumps([{
             "discrepancy_id": "E-OPEN", "detected_at_ns": 1_800_000_000_000_000_000,
             "component": "c1", "fault_code": "F-1", "sources": []}])},
    ],
    "failure_episodes": [
        {"episode_id": "E-ATL", "detected_at": "2026-11-01 10:00:00+00",
         "asset_id": "asset-a", "component": "c1", "fault_code": "F-1",
         "cleared_at": "2026-11-01 11:00:00+00", "cleared_by": "x", "resolution": "r",
         "sources": "[]", "originator_nation": "ATL", "releasable_to": "{}",
         "edge_id": "edge-t", "region_id": None},
        {"episode_id": "E-BDR", "detected_at": "2026-11-01 10:00:00+00",
         "asset_id": "asset-b", "component": "c1", "fault_code": "F-1",
         "cleared_at": "2026-11-01 11:00:00+00", "cleared_by": "x", "resolution": "r",
         "sources": "[]", "originator_nation": "BDR", "releasable_to": "{ATL}",
         "edge_id": "edge-t", "region_id": None},
        {"episode_id": "E-NULL", "detected_at": "2026-11-01 10:00:00+00",
         "asset_id": "asset-c", "component": "c1", "fault_code": "F-1",
         "cleared_at": "2026-11-01 11:00:00+00", "cleared_by": "x", "resolution": "r",
         "sources": "[]", "originator_nation": None, "releasable_to": "{BDR}",
         "edge_id": "edge-t", "region_id": None},
    ],
}


def _fake_shape(table, where, columns, default_key):
    state["shape_reads"].append({"table": table, "where": where, "columns": columns})
    rows = REPORT_ROWS.get(table)
    if rows is not None:
        return [dict(r) for r in rows]
    if table == "telemetry_latest_state":
        return [dict(OBSERVED)]
    if table == "asset_fielding":
        return [dict(FIELDING_ROW)]
    return []


@pytest.fixture
def pep_url(rig, monkeypatch, tmp_path):
    pep, base = rig
    state.update(shape_reads=[], electric_seen=[], released=[])
    rel = tmp_path / "releasability.yaml"
    rel.write_text("# c\nnations:\n  ATL:\n    name: Atlantia\n  BDR:\n    name: Borduria\n"
                   "default_originator_nation: null\nassets: {}\n")
    bdir = tmp_path / "baselines"
    bdir.mkdir()
    monkeypatch.setattr(pep, "_follow_shape", _fake_shape)
    monkeypatch.setattr(pep, "ARRIVALS_INTAKE_URL", "http://127.0.0.1:1/asset-declarations")
    monkeypatch.setattr(pep, "ARRIVALS_EDGES", frozenset({"edge-a"}))
    monkeypatch.setattr(pep, "ARRIVALS_UNITS", [{"id": "u1", "name": "Unit One"}])
    monkeypatch.setattr(pep, "ARRIVALS_OWNING_TIER", "tier-x")
    monkeypatch.setattr(pep, "RELEASABILITY_FILE", str(rel))
    monkeypatch.setattr(pep, "BASELINES_DIRS", str(bdir))
    monkeypatch.setattr(pep, "FAULT_CATALOG", {"variants": {}})
    monkeypatch.setattr(pep, "element_release",
                        lambda principal, view: state["released"].append(list(view)))
    pep._reports_cache.clear()
    pep.REPORTS_CACHE_S = 0.0
    return base


def _call(url, subject, body=None, method=None, want_body=False):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method or ("POST" if data else "GET"))
    req.add_header("X-OpenDDIL-Subject", subject)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            raw = r.read()
            return (r.status, raw) if want_body else r.status
    except urllib.error.HTTPError as e:
        raw = e.read()
        return (e.code, raw) if want_body else e.code


def _wheres(reads, tables=None):
    return [{"table": r["table"], "where": r["where"], "columns": r["columns"]}
            for r in reads if tables is None or r["table"] in tables]


def collect_switch_off(pep, base) -> dict:
    """Every site, every nation list: the where-clause(s) the route built."""
    out: dict = {}

    def run(site, label, fn):
        state["shape_reads"].clear()
        state["electric_seen"].clear()
        state["released"].clear()
        out.setdefault(site, {})[label] = fn()

    for label, nations in NATION_LISTS.items():
        subj = f"s-{label}"

        # site 1 (read_visible_row): GET /cm/fault-codes, reads telemetry
        for asset in ("dis:1:1:7", "a'b"):
            q = urllib.parse.quote(asset)
            run(f"read_visible_row[asset={asset}]", label, lambda q=q: {
                "status": _call(f"{base}/cm/fault-codes?asset_id={q}", subj),
                "reads": _wheres(state["shape_reads"])})

        # site 2: GET /arrivals
        run("arrivals_get", label, lambda: {
            "status": _call(f"{base}/arrivals?edge_id=edge-a", subj),
            "reads": _wheres(state["shape_reads"], {"asset_fielding"})})

        # site 3: GET /arrivals/summary
        run("arrivals_summary", label, lambda: {
            "status": _call(f"{base}/arrivals/summary", subj),
            "reads": _wheres(state["shape_reads"], {"asset_fielding"})})

        # site 4: POST /arrivals/declare, source expect-confirm. The nation
        # the subject declares is ATL, which an empty-nations subject lacks.
        body = {"asset_id": "dis:1:1:7", "edge_id": "edge-a", "serial": None,
                "unit": "u1", "originator_nation": "ATL", "releasable_to": ["BDR"],
                "baseline_id": None, "source": "expect-confirm",
                "confirm_serial": "SN-1"}
        run("arrivals_declare_expect_confirm", label, lambda: {
            "status": _call(f"{base}/arrivals/declare", subj, body),
            "reads": _wheres(state["shape_reads"], {"asset_fielding"})})

        # site 5: DELETE /v1/shape on the element table; the view it names
        # is (table, where, columns).
        cw = urllib.parse.quote("asset_id = 'dis:1:1:7' AND depth <= 1")
        run("element_delete", label, lambda: {
            "status": _call(f"{base}/v1/shape?table=asset_element_state&where={cw}"
                            f"&columns=asset_id", subj, method="DELETE"),
            "views": [list(v) for v in state["released"]]})

        # site 6: GET /v1/shape on a nation-class table, with no client where
        # and with one (an OR, to show the parenthesising).
        for tag, cwhere in (("no_client_where", None),
                            ("client_where_or", "asset_id = 'x' OR asset_id = 'y'")):
            qs = "table=telemetry_latest_state&offset=-1"
            if cwhere:
                qs += "&where=" + urllib.parse.quote(cwhere)
            run(f"shape_proxy[{tag}]", label, lambda qs=qs: {
                "status": _call(f"{base}/v1/shape?{qs}", subj),
                "upstream": [{k: v for k, v in q.items() if k in ("table", "where", "subset__where")}
                             for q in state["electric_seen"]]})

    # The reports routes: columns and where per table, and who is listed.
    out["_REPORT_COLUMNS"] = pep._REPORT_COLUMNS
    for tier in ("hub", "edge-t"):
        pep.PEP_TIER = tier
        for route in ("/reports/tier", "/reports/mine"):
            for label in NATION_LISTS:
                pep._reports_cache.clear()
                state["shape_reads"].clear()
                status, raw = _call(f"{base}{route}", f"s-{label}", want_body=True)
                try:
                    listed = sorted(r["episode_id"] for r in json.loads(raw)["reports"])
                except (ValueError, KeyError):
                    listed = None
                out.setdefault(f"reports[{tier}][{route}]", {})[label] = {
                    "status": status, "reads": _wheres(state["shape_reads"]),
                    "listed": listed}
    return out


def render(obj) -> str:
    return json.dumps(obj, indent=2, sort_keys=True) + "\n"


# ---- check 3: switch off, every site and the reports columns ---------------
def test_check3_switch_off_where_clauses_match_the_golden(pep_url, rig):
    pep, base = rig
    saved = pep.PEP_TIER
    try:
        got = render(collect_switch_off(pep, pep_url))
    finally:
        pep.PEP_TIER = saved
    assert got.encode() == GOLDEN.read_bytes()
