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
    if table == "label_registry":
        if state.get("registry_error"):
            raise sys.modules["pep"].ElectricUnavailable("registry down")
        return [dict(r) for r in state["registry"]]
    rows = (state.get("report_rows") or REPORT_ROWS).get(table)
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
    state.update(shape_reads=[], electric_seen=[], released=[], registry=[],
                 registry_error=False, report_rows=None, base=base)
    monkeypatch.setattr(pep, "_label_registry_cache", None)
    monkeypatch.setattr(pep, "LABEL_REGISTRY_CACHE_S", 0.0)
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


# ---- the switch ON ---------------------------------------------------------
VECTORS_FILE = HERE / "testdata" / "lk1.json"


def _vectors() -> list[dict]:
    return json.loads(VECTORS_FILE.read_text())


def _registry_rows(as_string=True) -> list[dict]:
    rows, seen = [], set()
    for v in _vectors():
        if v["label_key"] is None or v["label_key"] in seen:
            continue
        seen.add(v["label_key"])
        rows.append({"label_key": v["label_key"],
                     "label": json.dumps(v["label"]) if as_string else v["label"]})
    return rows


@pytest.fixture
def on(pep_url, rig, monkeypatch):
    pep, _ = rig
    monkeypatch.setattr(pep, "LABEL_KEY_FILTER", True)
    state["registry"] = _registry_rows()
    return pep


def _predicate_admits(originator, releasable, nations) -> bool:
    """policy_predicate's rule, evaluated in Python."""
    return ((originator is not None and originator in nations)
            or (releasable is not None and bool(set(releasable) & set(nations))))


def test_vectors_file_is_the_one_the_design_names():
    import hashlib  # noqa: PLC0415

    assert hashlib.sha256(VECTORS_FILE.read_bytes()).hexdigest().startswith("f7d8075fb8fd674b")


# ---- check 4 ---------------------------------------------------------------
def test_check4_zero_registry_rows_is_false(on):
    state["registry"] = []
    assert on.row_filter(["ATL"]) == "false"


def test_check4_registry_never_read_is_false(on):
    state["registry_error"] = True
    assert on.row_filter(["ATL"]) == "false"
    state["registry_error"] = False
    assert on.row_filter(["ATL"]).startswith("label_key IN (")   # a later read heals it


def test_check4_failing_refresh_keeps_the_earlier_keys(on, caplog):
    first = on.row_filter(["ATL"])
    assert first.startswith("label_key IN (")
    state["registry_error"] = True
    with caplog.at_level("WARNING", logger="pep"):
        assert on.row_filter(["ATL"]) == first
    assert any("keeping the last copy" in r.getMessage() for r in caplog.records)


def test_check4_ttl_serves_the_cache(on, monkeypatch):
    monkeypatch.setattr(on, "LABEL_REGISTRY_CACHE_S", 600.0)
    on.row_filter(["ATL"])
    on.row_filter(["ATL", "BDR"])
    assert [r["table"] for r in state["shape_reads"]].count("label_registry") == 1
    read = next(r for r in state["shape_reads"] if r["table"] == "label_registry")
    assert read["where"] == "true" and read["columns"] == ["label_key", "label"]


def test_check4_nation_order_does_not_change_the_text(on):
    a, b = on.row_filter(["ATL", "BDR"]), on.row_filter(["BDR", "ATL"])
    assert a == b
    keys = [k.strip("'") for k in a[len("label_key IN ("):-1].split(", ")]
    assert keys == sorted(set(keys)) and len(keys) >= 3


def test_check4_empty_nations_and_no_admitted_keys_are_false(on):
    assert on.row_filter([]) == "false"
    assert on.row_filter(["CYR"]) == "false"
    assert on.admitted_key_count(["CYR"]) == 0


def test_check4_body_may_arrive_as_a_string_or_a_dict(on):
    state["registry"] = _registry_rows(as_string=False)
    as_dict = on.row_filter(["ATL"])
    on._label_registry_cache = None
    state["registry"] = _registry_rows(as_string=True)
    assert on.row_filter(["ATL"]) == as_dict


def _body(author, release):
    return json.dumps({"dims": {"nation": {"author": author, "release": release}}})


def test_check4_a_body_of_the_wrong_shape_is_not_admitted(on):
    state["registry"] = [
        {"label_key": "k-1", "label": "not json"},
        {"label_key": "k-2", "label": json.dumps({"dims": {}})},
        {"label_key": "k-3", "label": _body(7, None)},
        {"label_key": "k-4", "label": _body("ATL", "ATL")},
        {"label_key": "k-5", "label": _body("ATL", [1])},
        {"label_key": "k-6", "label": json.dumps([1])},
        {"label_key": None, "label": _body("ATL", None)}]
    assert on.row_filter(["ATL"]) == "false"


def test_check4_empty_author_admits_nothing_by_itself(on):
    state["registry"] = [{"label_key": "k-e", "label": _body("", None)}]
    assert on.row_filter([""]) == "false"
    assert on.row_filter(["ATL"]) == "false"


NATION_SETS = [[], ["ATL"], ["BDR"], ["ATL", "BDR"], ["CYR"]]

# Vectors that carry no key, on which the NULL-safe predicate nevertheless
# admits the row through releasable_to while the key rule admits nothing. The
# first is Finding 5's class (no usable originator). The others are not: see
# the reason against each.
NO_KEY_ADMITTED_BY_PREDICATE = {
    "empty_originator_bdr": "finding 5: empty originator, admitted through releasable_to",
    "no_policy": "no policy id: no key, yet the predicate admits ATL and BDR",
    # Not Finding 5's class either: a release list with a malformed member
    # (null, lower case, empty string) gets no key, while the row's ATL
    # originator still passes the predicate for an ATL viewer.
    "release_has_none": "malformed release member: no key, admitted by originator",
    "release_lowercase": "malformed release member: no key, admitted by originator",
    "release_empty_string": "malformed release member: no key, admitted by originator",
}


def test_check4_truth_table_against_the_vectors(on):
    differ = set()
    for v in _vectors():
        for nations in NATION_SETS:
            by_predicate = _predicate_admits(v["originator_nation"], v["releasable_to"],
                                             nations)
            if v["label_key"] is None:
                if by_predicate:   # no key, so the key rule admits nothing here
                    differ.add(v["name"])
                continue
            by_key = v["label_key"] in on._admitted_keys(nations)
            assert by_key == by_predicate, (v["name"], nations)
    assert differ == set(NO_KEY_ADMITTED_BY_PREDICATE), differ


# ---- check 5 ---------------------------------------------------------------
def test_check5_policy_predicate_has_one_caller_row_filter():
    src = (HERE / "pep.py").read_text()
    lines = [ln for ln in src.splitlines() if "policy_predicate(" in ln]
    assert len(lines) == 2, lines
    assert lines[0].startswith("def policy_predicate(")
    body = src[src.index("def row_filter("):]
    body = body[:body.index("\n\n\n")]
    assert lines[1] in body


# ---- the decision line -----------------------------------------------------
def _proxy_decision_lines(caplog, subject="s-atl_bdr"):
    with caplog.at_level("INFO", logger="pep.decision"):
        url = f"{state['base']}/v1/shape?table=telemetry_latest_state&offset=-1"
        assert _call(url, subject) == 200
    raw = [r.getMessage() for r in caplog.records]
    out = [json.loads(m.split("DECISION ", 1)[1]) for m in raw if "DECISION " in m]
    return [d for d in out if d.get("resource") == "telemetry_latest_state"
            and d.get("outcome") == "allow"], raw


def test_decision_line_switch_off(pep_url, caplog):
    lines, _raw = _proxy_decision_lines(caplog)
    assert lines and all(d["filter"] == "predicate" and "admitted_keys" not in d
                         for d in lines)


def test_decision_line_switch_on(on, caplog):
    lines, raw = _proxy_decision_lines(caplog)
    assert lines
    d = lines[-1]
    assert d["filter"] == "key" and isinstance(d["admitted_keys"], int)
    assert d["admitted_keys"] == on.admitted_key_count(["ATL", "BDR"]) > 0
    assert not any("lk1:" in m for m in raw)
    assert "label_key IN (<admitted keys>)" in d["predicate"]
    # and the upstream request did carry the real filter
    sent = state["electric_seen"][-1]["where"][0]
    assert sent.startswith("label_key IN ('lk1:")


# ---- the reports routes, switch on -----------------------------------------
def _key(name):
    return next(v["label_key"] for v in _vectors() if v["name"] == name)


def _report_rows_with_keys():
    rows = json.loads(json.dumps(REPORT_ROWS))
    rows["asset_cm_state"][0]["label_key"] = _key("atl_absent")
    keys = {"E-ATL": _key("atl_absent"), "E-BDR": _key("bdr_atl"), "E-NULL": None}
    for r in rows["failure_episodes"]:
        r["label_key"] = keys[r["episode_id"]]
    rows["failure_episodes"].append(dict(
        rows["failure_episodes"][0], episode_id="E-UNKNOWN-KEY", label_key="lk1:" + "0" * 64))
    return rows


def test_reports_tier_lists_only_admitted_keys(on, monkeypatch):
    state["report_rows"] = _report_rows_with_keys()
    monkeypatch.setattr(on, "PEP_TIER", "hub")
    status, raw = _call(f"{state['base']}/reports/tier", "s-atl", want_body=True)
    assert status == 200
    listed = sorted(r["episode_id"] for r in json.loads(raw)["reports"])
    # Admitted: atl_absent, and bdr_atl (released to ATL). Not listed: a NULL
    # key, and a key the registry does not hold.
    assert listed == ["E-ATL", "E-BDR", "E-OPEN"]
    cols = {r["table"]: r["columns"] for r in state["shape_reads"]
            if r["table"] != "label_registry"}
    assert cols and all(c[-1] == "label_key" for c in cols.values())
    assert on._REPORT_COLUMNS["failure_episodes"][-1] != "label_key"   # base lists unmoved


def test_reports_tier_with_no_registry_lists_nothing(on, monkeypatch):
    state["report_rows"] = _report_rows_with_keys()
    state["registry_error"] = True
    monkeypatch.setattr(on, "PEP_TIER", "hub")
    status, raw = _call(f"{state['base']}/reports/tier", "s-atl", want_body=True)
    assert status == 200 and json.loads(raw)["reports"] == []
