"""GET /arrivals and POST /arrivals/declare (ADR-0050 s2).

Topaz and both intakes are real local servers; the Electric shape reads are
stubbed at `pep._follow_shape` (the loop itself is covered in
test_pep_cm_visibility_read.py), dispatched by table and the where text.
Everything here is synthetic: invented nations ATL and BDR, invented ids.
"""
from __future__ import annotations

import json
import os
import re
import sys
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

ENT = {
    "op-atl": (["ATL"], "edge-operator"),
    "op-bdr": (["BDR"], "edge-operator"),
    "obs-atl": (["ATL"], "observer"),
    "sup": (["ATL", "BDR"], "supervisor"),
}
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


class FakeIntake(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):  # noqa: N802
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        state["calls"].append((self.path, json.loads(body)))
        status = state["status"].get(self.path, 200)
        self.send_response(status)
        self.send_header("Content-Length", "0")
        self.end_headers()


def _serve(handler):
    srv = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


@pytest.fixture(scope="module")
def env():
    topaz, intake = _serve(FakeTopaz), _serve(FakeIntake)
    os.environ["OPENDDIL_ELECTRIC_URL"] = "http://127.0.0.1:1"
    os.environ["OPENDDIL_TOPAZ_URL"] = f"http://127.0.0.1:{topaz.server_port}"
    os.environ.pop("OPENDDIL_OIDC_ISSUER", None)
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    sys.modules.pop("pep", None)
    import pep  # noqa: PLC0415

    pep.AUTH_MODE = "header"
    pep_srv = _serve(pep.Pep)
    yield pep, f"http://127.0.0.1:{pep_srv.server_port}", f"http://127.0.0.1:{intake.server_port}"
    for s in (topaz, intake, pep_srv):
        s.shutdown()


OBSERVED = {"asset_id": "dis:1:1:7", "edge_id": "edge-a", "platform_variant": "SENTRY",
            "region_id": "reg-1", "kinematics": '{"position": {"lat": 1.5, "lon": 2.5}}',
            "last_sample_at": "2026-10-15T12:00:00Z"}
FIELDING = [
    {"serial": "SN-1", "platform_variant": "SENTRY", "unit": "u1", "originator_nation": "ATL",
     "releasable_to": "{BDR}", "due_by": "2020-01-01 00:00:00+00", "fielded_to": "edge-a"},
    {"serial": "SN-2", "platform_variant": "SENTRY", "unit": "u1", "originator_nation": "ATL",
     "releasable_to": "{}", "due_by": "2999-01-01 00:00:00+00", "fielded_to": "edge-a"},
    {"serial": "SN-3", "platform_variant": "OTHER", "unit": "u1", "originator_nation": "ATL",
     "releasable_to": "{}", "due_by": "2999-01-01 00:00:00+00", "fielded_to": "edge-a"},
]


def _fake_shape(table, where, columns, default_key):
    state["shape_reads"].append((table, where, columns))
    if state.get("electric_down"):
        raise state["electric_down"]
    if table == "telemetry_latest_state":
        rows = state["telemetry"]
        if "originator_nation IS NULL" in where:
            rows = [r for r in rows if r.get("originator_nation") is None]
        if "asset_id = " in where:
            rows = [r for r in rows if f"asset_id = '{r['asset_id']}'" in where]
        return [{k: r[k] for k in r if columns is None or k in columns} for r in rows]
    if table == "asset_registry":
        return [{"asset_id": r["asset_id"], "assigned_at": "2026-10-15T11:00:00Z"}
                for r in state["telemetry"]]
    if table == "asset_declaration":
        return [r for r in state["declared"]
                if where == "true" or f"'{r['asset_id']}'" in where or "edge_id" in where]
    if table == "asset_fielding":
        if "serial = " in where:
            return [r for r in FIELDING if f"serial = '{r['serial']}'" in where]
        m = re.search(r"originator_nation IN \(([^)]*)\)", where)
        if m:
            nations = re.findall(r"'([^']*)'", m.group(1))
            return [r for r in FIELDING if r["originator_nation"] in nations]
        if where == "false":
            return []
        return list(FIELDING)
    if table == "asset_correlation":
        if "serial = " in where:
            return [r for r in state["correlated"] if f"'{r['serial']}'" in where]
        return list(state["correlated"])
    raise AssertionError(table)


@pytest.fixture
def pep_url(env, monkeypatch, tmp_path):
    pep, base, intake = env
    state.update(calls=[], status={}, shape_reads=[], telemetry=[dict(OBSERVED)],
                 declared=[], correlated=[], electric_down=None)
    rel = tmp_path / "releasability.yaml"
    rel.write_text("# c\nnations:\n  ATL:\n    name: Atlantia\n  BDR:\n    name: Borduria\n"
                   "default_originator_nation: null\n")
    bdir = tmp_path / "baselines"
    bdir.mkdir()
    (bdir / "s.yaml").write_text('baseline_id: "SENTRY-B1"\nplatform_variant: "SENTRY"\n')
    monkeypatch.setattr(pep, "_follow_shape", _fake_shape)
    monkeypatch.setattr(pep, "ARRIVALS_INTAKE_URL", intake + "/asset-declarations")
    monkeypatch.setattr(pep, "CM_INTAKE_URL", intake + "/cm-events")
    monkeypatch.setattr(pep, "ARRIVALS_EDGES", frozenset({"edge-a"}))
    monkeypatch.setattr(pep, "ARRIVALS_UNITS", [{"id": "u1", "name": "Unit One"}])
    monkeypatch.setattr(pep, "ARRIVALS_OWNING_TIER", "tier-x")
    monkeypatch.setattr(pep, "RELEASABILITY_FILE", str(rel))
    state["rel"] = rel
    monkeypatch.setattr(pep, "BASELINES_DIRS", str(bdir))
    return base


def _req(url, subject, body=None, method=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method or ("POST" if data else "GET"))
    if subject:
        req.add_header("X-OpenDDIL-Subject", subject)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def _set_rows(*ids):
    """Give the releasability file a per-asset row for each id."""
    rel = state["rel"]
    head = rel.read_text().split("assets:")[0]
    rows = "".join(f'  "{i}": {{ originator_nation: ATL, releasable_to: [] }}\n' for i in ids)
    rel.write_text(head + ("assets:\n" + rows if ids else "assets: {}\n"))


GOOD = {"asset_id": "dis:1:1:7", "edge_id": "edge-a", "serial": None, "unit": "u1",
        "originator_nation": "ATL", "releasable_to": ["BDR"], "baseline_id": None,
        "source": "declare"}


def _declare(base, subject="op-atl", **over):
    body = {**GOOD, **over}
    return _req(base + "/arrivals/declare", subject, body)


def _intake_calls(path):
    return [b for p, b in state["calls"] if p == path]


# --- GET /arrivals ------------------------------------------------------------
def test_get_gates(pep_url):
    assert _req(pep_url + "/arrivals?edge_id=edge-a", None)[0] == 401
    assert _req(pep_url + "/arrivals?edge_id=edge-a", "nobody")[0] == 403
    assert _req(pep_url + "/arrivals?edge_id=edge-a", "obs-atl")[0] == 403
    assert _req(pep_url + "/arrivals?edge_id=elsewhere", "op-atl")[0] == 404


def test_get_404_when_env_unset(pep_url, monkeypatch, env):
    pep = env[0]
    monkeypatch.setattr(pep, "ARRIVALS_EDGES", frozenset())
    assert _req(pep_url + "/arrivals?edge_id=edge-a", "op-atl")[0] == 404
    assert _declare(pep_url)[0] == 404


def test_get_shape(pep_url):
    status, body = _req(pep_url + "/arrivals?edge_id=edge-a", "op-atl")
    assert status == 200
    assert set(body) == {"edge_id", "undeclared", "expected", "units", "nations",
                         "declarable_nations", "baselines"}
    (u,) = body["undeclared"]
    assert u["asset_id"] == "dis:1:1:7" and u["platform_variant"] == "SENTRY"
    assert u["candidates"] == ["SN-1", "SN-2"]
    assert u["position"] == {"lat": 1.5, "lon": 2.5}
    assert u["first_seen"] and u["last_seen"]
    by = {x["serial"]: x for x in body["expected"]}
    assert by["SN-1"]["overdue"] is True and by["SN-2"]["overdue"] is False
    assert by["SN-1"]["releasable_to"] == ["BDR"]
    assert body["nations"] == ["ATL", "BDR"] and body["declarable_nations"] == ["ATL"]
    assert body["baselines"] == {"SENTRY": ["SENTRY-B1"]}
    # the fielding read carries the policy predicate; the telemetry read does not
    # filter on the projected label (a default-labelled asset stays undeclared)
    reads = {t: w for t, w, _c in state["shape_reads"]}
    assert "originator_nation" not in reads["telemetry_latest_state"]
    assert "ANY" not in reads["asset_fielding"] and "'ATL'" in reads["asset_fielding"]


def test_get_removes_correlated_serial_and_declared_id(pep_url):
    state["correlated"] = [{"serial": "SN-1"}]
    state["declared"] = [{"asset_id": "dis:1:1:7"}]
    _s, body = _req(pep_url + "/arrivals?edge_id=edge-a", "op-atl")
    assert [x["serial"] for x in body["expected"]] == ["SN-2", "SN-3"]
    assert body["undeclared"] == []


def test_default_labelled_asset_is_listed_and_declarable(pep_url):
    state["telemetry"] = [dict(OBSERVED, originator_nation="ATL")]  # default-stamped
    _s, body = _req(pep_url + "/arrivals?edge_id=edge-a", "op-atl")
    assert [u["asset_id"] for u in body["undeclared"]] == ["dis:1:1:7"]
    assert _declare(pep_url)[0] == 201


def test_row_labelled_asset_is_refused_and_not_listed(pep_url):
    state["telemetry"] = [dict(OBSERVED, originator_nation="ATL")]
    _set_rows("dis:1:1:7")
    _s, body = _req(pep_url + "/arrivals?edge_id=edge-a", "op-atl")
    assert body["undeclared"] == []
    assert _declare(pep_url)[0] == 404
    assert state["calls"] == []


def test_declared_default_labelled_asset_is_refused_and_not_listed(pep_url):
    state["telemetry"] = [dict(OBSERVED, originator_nation="ATL")]
    state["declared"] = [{"asset_id": "dis:1:1:7"}]
    _s, body = _req(pep_url + "/arrivals?edge_id=edge-a", "op-atl")
    assert body["undeclared"] == []
    assert _declare(pep_url)[0] == 404


def test_file_asset_ids_reader(pep_url, tmp_path, env):
    pep = env[0]
    f = tmp_path / "r.yaml"
    f.write_text('nations:\n  ATL: {name: A}\nassets:\n'
                 '  # c\n'
                 '  "dis:1:1:1": { originator_nation: ATL, releasable_to: [] }  # t\n'
                 "  'dis:1:1:2': { originator_nation: ATL }\n"
                 '  dis:1:1:3: { originator_nation: BDR }\n'
                 '  plain:\n    originator_nation: ATL\n'
                 'default_originator_nation: BDR\n')
    pep.RELEASABILITY_FILE = str(f)
    assert pep._file_asset_ids() == {"dis:1:1:1", "dis:1:1:2", "dis:1:1:3", "plain"}
    f.write_text("assets: {}\ndefault_originator_nation: ATL\n")
    assert pep._file_asset_ids() == set()
    f.write_text("nations: {}\n")
    assert pep._file_asset_ids() == set()
    pep.RELEASABILITY_FILE = str(tmp_path / "missing.yaml")
    assert pep._file_asset_ids() == set()


# --- POST /arrivals/declare ---------------------------------------------------
def test_allow_uses_session_subject_and_posts_once(pep_url):
    status, body = _declare(pep_url, declared_by="mallory")
    assert status == 400  # a body-supplied declared_by is refused outright
    status, body = _declare(pep_url)
    assert status == 201 and body["baseline_assigned"] is False
    (rec,) = _intake_calls("/asset-declarations")
    assert rec["declared_by"] == "op-atl" and rec["owning_tier"] == "tier-x"
    assert rec["region_id"] == "reg-1" and rec["declared_at"].endswith("Z")
    assert _intake_calls("/cm-events") == []


def test_baseline_assigned_event(pep_url):
    status, body = _declare(pep_url, baseline_id="SENTRY-B1")
    assert status == 201 and body["baseline_assigned"] is True
    (ev,) = _intake_calls("/cm-events")
    assert ev["recordedBy"] == "op-atl" and ev["assetId"] == "dis:1:1:7"
    assert ev["baselineAssigned"]["baselineId"] == "SENTRY-B1"


def test_baseline_failure_keeps_declaration(pep_url):
    state["status"]["/cm-events"] = 500
    status, body = _declare(pep_url, baseline_id="SENTRY-B1")
    assert status == 502 and body["declared"] is True and body["baseline_assigned"] is False
    assert len(_intake_calls("/asset-declarations")) == 1


def test_intake_failure_is_502_and_nothing_else(pep_url):
    state["status"]["/asset-declarations"] = 500
    assert _declare(pep_url, baseline_id="SENTRY-B1")[0] == 502
    assert _intake_calls("/cm-events") == []


@pytest.mark.parametrize("subject,over,code", [
    ("obs-atl", {}, 403),                                   # observer role
    ("op-bdr", {"originator_nation": "ATL"}, 403),          # the red check
    ("op-atl", {"releasable_to": ["ZZZ"]}, 400),
    ("op-atl", {"releasable_to": ["ATL"]}, 400),            # includes originator
    ("op-atl", {"unit": "nope"}, 400),
    ("op-atl", {"baseline_id": "WRONG"}, 400),
    ("op-atl", {"edge_id": "elsewhere"}, 404),
    ("op-atl", {"source": "bogus"}, 400),
    ("op-atl", {"source": "expect-confirm"}, 400),          # confirm_serial missing
])
def test_refusals(pep_url, subject, over, code):
    status, _b = _declare(pep_url, subject, **over)
    assert status == code
    assert state["calls"] == []


def test_unknown_labelled_and_declared_ids_answer_alike(pep_url):
    unknown = _declare(pep_url, asset_id="dis:9:9:9")
    _set_rows("dis:1:1:7")  # a file row labels it
    labelled = _declare(pep_url)
    _set_rows()
    state["declared"] = [{"asset_id": "dis:1:1:7"}]
    declared = _declare(pep_url)
    assert {unknown[0], labelled[0], declared[0]} == {404}
    assert unknown[1]["cause"] == labelled[1]["cause"] == declared[1]["cause"]


def test_serial_already_correlated(pep_url):
    state["correlated"] = [{"serial": "SN-9"}]
    assert _declare(pep_url, serial="SN-9")[0] == 409
    assert state["calls"] == []


def test_expect_confirm_happy_and_mismatches(pep_url):
    ok = dict(source="expect-confirm", confirm_serial="SN-1")
    status, _b = _declare(pep_url, **ok)
    assert status == 201
    assert _intake_calls("/asset-declarations")[0]["serial"] == "SN-1"
    state["calls"].clear()
    assert _declare(pep_url, **{**ok, "releasable_to": []})[0] == 400   # differs from record
    assert _declare(pep_url, **{**ok, "confirm_serial": "SN-3"})[0] == 400  # other variant
    assert _declare(pep_url, **{**ok, "confirm_serial": "SN-404"})[0] == 404
    assert state["calls"] == []


def test_decision_line_per_outcome(pep_url, caplog):
    import logging  # noqa: PLC0415
    caplog.set_level(logging.INFO, logger="pep.decision")
    _declare(pep_url)
    _declare(pep_url, "obs-atl")
    lines = [r.getMessage() for r in caplog.records if "arrival:declare" in r.getMessage()]
    assert len(lines) == 2
    assert '"allowed": true' in lines[0] and '"subject": "op-atl"' in lines[0]
    assert '"allowed": false' in lines[1]


# --- GET /arrivals/summary ----------------------------------------------------
def _tel(asset_id, edge, nation=None):
    return {"asset_id": asset_id, "edge_id": edge, "originator_nation": nation}


def _summary_state():
    state["telemetry"] = [
        _tel("dis:9:9:1", "edge-a"), _tel("dis:9:9:2", "edge-a"),
        _tel("dis:9:9:3", "edge-a", "ATL"), _tel("dis:9:9:4", "edge-b", "ATL"),
    ]
    _set_rows("dis:9:9:3", "dis:9:9:4")
    state["declared"] = [{"asset_id": "dis:9:9:2", "edge_id": "edge-a"}]
    state["correlated"] = [{"serial": "SN-2"}]


def test_summary_shape(pep_url):
    _summary_state()
    status, body = _req(pep_url + "/arrivals/summary", "op-atl")
    assert status == 200
    assert body["edges"] == [
        {"edge_id": "edge-a", "undeclared": 1, "expected": 2, "overdue": 1},
        {"edge_id": "edge-b", "undeclared": 0, "expected": 0, "overdue": 0},
    ]


def test_summary_counts_default_labelled_as_undeclared(pep_url):
    _summary_state()
    _set_rows("dis:9:9:4")  # dis:9:9:3 is now labelled only by a default
    _s, body = _req(pep_url + "/arrivals/summary", "op-atl")
    assert body["edges"][0]["undeclared"] == 2


def test_summary_carries_no_ids(pep_url):
    _summary_state()
    req = urllib.request.Request(pep_url + "/arrivals/summary",
                                 headers={"X-OpenDDIL-Subject": "op-atl"})
    with urllib.request.urlopen(req, timeout=10) as r:
        raw = r.read().decode()
    for needle in ("dis:9:9", "SN-1", "SN-2", "SN-3"):
        assert needle not in raw


def test_summary_fielding_read_is_policy_only(pep_url, env):
    pep = env[0]
    _summary_state()
    status, body = _req(pep_url + "/arrivals/summary", "op-bdr")
    assert status == 200
    by = {e["edge_id"]: e for e in body["edges"]}
    assert by["edge-a"]["expected"] == 0
    (where,) = [w for t, w, _c in state["shape_reads"] if t == "asset_fielding"]
    assert where == pep.compose(None, pep.policy_predicate(["BDR"]))


def test_summary_edge_from_fielding_alone(pep_url):
    _summary_state()
    FIELDING.append({"serial": "SN-Z", "platform_variant": "X", "unit": "u1",
                     "originator_nation": "ATL", "releasable_to": "{}",
                     "due_by": "2999-01-01 00:00:00+00", "fielded_to": "edge-z"})
    try:
        status, body = _req(pep_url + "/arrivals/summary", "op-atl")
    finally:
        FIELDING.pop()
    assert status == 200
    assert {"edge_id": "edge-z", "undeclared": 0, "expected": 1, "overdue": 0} in body["edges"]


def test_summary_gates(pep_url, env, monkeypatch):
    pep = env[0]
    url = pep_url + "/arrivals/summary"
    assert _req(url, None)[0] == 401
    assert _req(url, "nobody")[0] == 403

    state["electric_down"] = pep.ElectricUnavailable("down")
    assert _req(url, "op-atl")[0] == 502
    state["electric_down"] = None

    def boom(_subject):
        raise pep.AuthzUnavailable("down")

    monkeypatch.setattr(pep, "ask_topaz", boom)
    assert _req(url, "op-atl")[0] == 503


def test_summary_not_gated_on_ownership_or_role(pep_url, monkeypatch, env):
    pep = env[0]
    monkeypatch.setattr(pep, "ARRIVALS_EDGES", frozenset())
    assert _req(pep_url + "/arrivals?edge_id=edge-a", "op-atl")[0] == 404
    assert _req(pep_url + "/arrivals/summary", "op-atl")[0] == 200
    monkeypatch.setattr(pep, "ARRIVALS_EDGES", frozenset({"edge-a"}))
    assert "observer" not in pep.ARRIVALS_DECLARE_ROLES
    assert _req(pep_url + "/arrivals/summary", "obs-atl")[0] == 200


@pytest.mark.parametrize("spec,want", [
    ("/baselines", ["/baselines"]),
    ("/baselines:/baselines-overlay", ["/baselines", "/baselines-overlay"]),
    ("/a:/b:/c", ["/a", "/b", "/c"]),
    ("/a::/b", ["/a", "/b"]),
    ("/a:", ["/a"]),
    ("C:/a:C:/b", ["C:/a", "C:/b"]),
    ("C:\\a:/b", ["C:\\a", "/b"]),
    ("ab:/c", ["ab", "/c"]),
])
def test_split_dirs(env, spec, want):
    assert env[0]._split_dirs(spec) == want


def test_load_baselines_reads_every_directory(env, monkeypatch, tmp_path):
    pep = env[0]
    d1, d2 = tmp_path / "one", tmp_path / "two"
    d1.mkdir()
    d2.mkdir()
    (d1 / "a.yaml").write_text('baseline_id: "ALPHA-B1"\nplatform_variant: "ALPHA"\n')
    (d2 / "b.yaml").write_text('baseline_id: "BRAVO-B1"\nplatform_variant: "BRAVO"\n')
    (d2 / "c.yaml").write_text('baseline_id: "ALPHA-B1"\nplatform_variant: "ALPHA"\n')
    # the second entry is drive-less and rooted ("/..."), so the separator colon is
    # followed by "/" exactly as in a POSIX list; chdir keeps it on d1's drive
    monkeypatch.chdir(tmp_path)
    rooted = os.path.splitdrive(d2.as_posix())[1]
    monkeypatch.setattr(pep, "BASELINES_DIRS", f"{d1.as_posix()}:{rooted}")
    assert pep._load_baselines() == {"ALPHA": ["ALPHA-B1"], "BRAVO": ["BRAVO-B1"]}
