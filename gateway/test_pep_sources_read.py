"""GET /cm/sources (ADR-0053 first slice): three sources for one asset, side
by side, never combined.

Runs the real PEP handler with the PDP, the principal and `read_visible_row`
stubbed (the same seams test_pep_cm_visibility_read.py and
test_pep_cm_write.py use). The band file below is a copy of the shape the
lab ships; nothing here reads a deployment's path.

Run:  py -3 -m pytest gateway/test_pep_sources_read.py
"""
from __future__ import annotations

import datetime
import json
import os
import re
import sys
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

ASSET = "dis:1:1:1010"
NATIONS = ["ATL"]

BANDS = {
    "window_seconds": 300,
    "variants": {
        "MRAD_Sensor": {
            "observed": {"operational_status": {
                "operational": "ready", "destroyed": "not-ready",
                "deactivated": "not-ready", "removed": "not-ready"}},
            "declared": {"overall_status": {
                "CONFIG_STATUS_IN_COMPLIANCE": "ready",
                "CONFIG_STATUS_MINOR_DISCREPANCY": "limited",
                "CONFIG_STATUS_MAJOR_DISCREPANCY": "limited",
                "CONFIG_STATUS_NOT_MISSION_CAPABLE": "not-ready"}},
            "derived": {"overall_severity": {
                "LOGISTICS_SEVERITY_OK": "ready",
                "LOGISTICS_SEVERITY_DEGRADED": "limited",
                "LOGISTICS_SEVERITY_CRITICAL": "not-ready",
                "LOGISTICS_SEVERITY_NON_OPERATIONAL": "not-ready"}},
        },
    },
}

TOP_KEYS = {"asset_id", "platform_variant", "served_at", "sources"}
SOURCE_KEYS = {"record", "band", "tier", "source", "time"}
FORBIDDEN_KEY = re.compile(r"overall_?readiness|rollup|worst|summary|score|readiness", re.I)


def _now(minus: int = 0) -> str:
    t = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=minus)
    return t.isoformat()


@pytest.fixture(scope="module")
def pep_module():
    os.environ.setdefault("OPENDDIL_ELECTRIC_URL", "http://electric.invalid:9")
    os.environ.setdefault("OPENDDIL_TOPAZ_URL", "http://topaz.invalid:9")
    os.environ.pop("OPENDDIL_OIDC_ISSUER", None)
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    sys.modules.pop("pep", None)
    import pep  # noqa: PLC0415 -- must follow the env above
    pep.AUTH_MODE = "header"
    return pep


@pytest.fixture
def rig(pep_module, monkeypatch):
    """Stubs: rows by table, a PDP decision, a call log."""
    pep = pep_module
    ctl = {"rows": {}, "calls": [], "decision": None, "pdp_down": False,
           "electric_down": False, "subject": "op.atl"}
    ctl["decision"] = {"allow": True, "allowed_nations": NATIONS, "subject_known": True}

    def fake_read(table, asset_id, nations):
        ctl["calls"].append((table, asset_id, list(nations)))
        if ctl["electric_down"]:
            raise pep.ElectricUnavailable("down")
        return ctl["rows"].get(table)

    def fake_topaz(subject):
        if ctl["pdp_down"]:
            raise pep.AuthzUnavailable("down")
        return ctl["decision"]

    def fake_principal(self):
        if ctl["subject"] is None:
            raise pep.oidc.AuthError("no session")
        return ctl["subject"], {}, None

    monkeypatch.setattr(pep, "read_visible_row", fake_read)
    monkeypatch.setattr(pep, "ask_topaz", fake_topaz)
    monkeypatch.setattr(pep.Pep, "_resolve_principal", fake_principal)
    monkeypatch.setattr(pep, "SOURCE_BANDS", BANDS)

    srv = ThreadingHTTPServer(("127.0.0.1", 0), pep.Pep)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    ctl["url"] = f"http://127.0.0.1:{srv.server_port}"
    yield ctl
    srv.shutdown()


def _get(ctl, query=f"?asset_id={ASSET}"):
    try:
        with urllib.request.urlopen(ctl["url"] + "/cm/sources" + query, timeout=10) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def _tel(**kw):
    row = {"asset_id": ASSET, "platform_variant": "MRAD_Sensor", "edge_id": "edge-01",
           "operational_status": "operational", "health_state": "HEALTHY",
           "reporting_status": "reporting", "last_sample_at": _now(5),
           "provenance": {"edge_id": "edge-01", "producer_id": "sim-dis"}}
    row.update(kw)
    return row


def _cm(**kw):
    row = {"asset_id": ASSET, "edge_id": "edge-01", "baseline_id": "BL-1",
           "lifecycle": "LIFECYCLE_OPERATIONAL",
           "overall_status": "CONFIG_STATUS_IN_COMPLIANCE", "as_of": _now(60),
           "manual_discrepancies": []}
    row.update(kw)
    return row


def _logi(**kw):
    row = {"asset_id": ASSET, "edge_id": "edge-01",
           "overall_severity": "LOGISTICS_SEVERITY_OK",
           "constraining_factors": [], "computed_at": _now(30)}
    row.update(kw)
    return row


def _decl(**kw):
    row = {"asset_id": ASSET, "declared_by": "op.atl", "declared_at": _now(3600)}
    row.update(kw)
    return row


def _bands(body):
    s = body["sources"]
    return s["observed"]["band"], s["declared"]["band"], s["derived"]["band"]


# 1. refusals ---------------------------------------------------------------

def test_401_without_a_session(rig):
    rig["subject"] = None
    assert _get(rig)[0] == 401


def test_400_without_asset_id(rig):
    assert _get(rig, "")[0] == 400


def test_403_when_the_pdp_denies(rig):
    rig["decision"] = {"allow": False, "allowed_nations": [], "subject_known": False}
    assert _get(rig)[0] == 403


def test_503_when_the_pdp_is_down(rig):
    rig["pdp_down"] = True
    assert _get(rig)[0] == 503


def test_502_when_electric_is_down(rig):
    rig["electric_down"] = True
    assert _get(rig)[0] == 502


def test_404_when_telemetry_is_not_visible(rig):
    rig["rows"] = {"asset_cm_state": _cm()}
    code, body = _get(rig)
    assert code == 404
    assert "sources" not in body


# 2. all three agree --------------------------------------------------------

def test_all_present_and_agreeing(rig):
    rig["rows"] = {"telemetry_latest_state": _tel(), "asset_cm_state": _cm(),
                   "asset_logistics_status": _logi(), "asset_declaration": _decl()}
    code, body = _get(rig)
    assert code == 200
    assert _bands(body) == ("ready", "ready", "ready")
    assert body["sources"]["observed"]["silent"] is False
    assert body["sources"]["observed"]["tier"] == "edge-01"
    assert body["sources"]["observed"]["source"] == "sim-dis"
    assert body["sources"]["declared"]["source"] == "cm-service; declared by op.atl"
    assert body["sources"]["derived"]["source"] == "fusion"


# 3. declared NMC, observed operational -------------------------------------

def test_declared_nmc_with_one_open_discrepancy(rig):
    disc = [{"fault_code": "FC-100", "component": "ENG-1",
             "description": "leaking at the seal", "severity": "MAJOR", "extra": "x"}]
    # the jsonb column may arrive as a JSON string
    rig["rows"] = {"telemetry_latest_state": _tel(),
                   "asset_cm_state": _cm(overall_status="CONFIG_STATUS_NOT_MISSION_CAPABLE",
                                         manual_discrepancies=json.dumps(disc)),
                   "asset_logistics_status": _logi()}
    code, body = _get(rig)
    assert code == 200
    assert _bands(body) == ("ready", "not-ready", "ready")
    rec = body["sources"]["declared"]["record"]
    assert rec["manual_discrepancies"] == [
        {"fault_code": "FC-100", "component": "ENG-1",
         "description": "leaking at the seal", "severity": "MAJOR"}]
    assert rec["declaration"] is None
    assert body["sources"]["declared"]["source"] == "cm-service"


# 4. silent observed, stale-input derived -----------------------------------

def test_silent_observed_keeps_its_band_and_derived_is_limited(rig):
    rig["rows"] = {"telemetry_latest_state": _tel(reporting_status="not_reporting",
                                                 last_sample_at=_now(900),
                                                 provenance=json.dumps({"edge_id": "edge-02",
                                                                        "producer_id": "p"})),
                   "asset_cm_state": _cm(),
                   "asset_logistics_status": _logi(overall_severity="LOGISTICS_SEVERITY_DEGRADED")}
    code, body = _get(rig)
    obs = body["sources"]["observed"]
    assert obs["silent"] is True
    assert obs["tier"] == "edge-02"
    assert _bands(body) == ("ready", "ready", "limited")


def test_stale_sample_alone_is_silent_but_band_unchanged(rig):
    rig["rows"] = {"telemetry_latest_state": _tel(last_sample_at=_now(1000))}
    _, body = _get(rig)
    assert body["sources"]["observed"]["silent"] is True
    assert body["sources"]["observed"]["band"] == "ready"


# 5. missing rows -----------------------------------------------------------

def test_postgres_text_sample_time_is_served_as_iso(rig):
    # Electric serves timestamptz as postgres text; the pane prints what it is given.
    rig["rows"] = {"telemetry_latest_state": _tel(reporting_status="not_reporting",
                                                 last_sample_at="2026-10-26 04:34:15.187917+00")}
    _, body = _get(rig)
    obs = body["sources"]["observed"]
    assert obs["record"]["last_sample_at"] == "2026-10-26T04:34:15.187917+00:00"
    assert obs["time"] == "2026-10-26T04:34:15.187917+00:00"
    assert obs["silent"] is True


def test_unparseable_sample_time_passes_through_and_is_silent(rig):
    rig["rows"] = {"telemetry_latest_state": _tel(last_sample_at="not a time")}
    _, body = _get(rig)
    obs = body["sources"]["observed"]
    assert obs["time"] == "not a time"
    assert obs["silent"] is True


def test_missing_rows_are_null_records_and_null_bands(rig):
    rig["rows"] = {"telemetry_latest_state": _tel()}
    code, body = _get(rig)
    assert code == 200
    for name in ("declared", "derived"):
        assert body["sources"][name]["record"] is None
        assert body["sources"][name]["band"] is None


def test_unknown_variant_and_missing_band_file_give_null_bands(rig, pep_module, monkeypatch):
    rig["rows"] = {"telemetry_latest_state": _tel(platform_variant="Mystery"),
                   "asset_cm_state": _cm(), "asset_logistics_status": _logi()}
    assert _bands(_get(rig)[1]) == (None, None, None)
    rig["rows"]["telemetry_latest_state"] = _tel()
    monkeypatch.setattr(pep_module, "SOURCE_BANDS", None)
    assert _bands(_get(rig)[1]) == (None, None, None)


def test_unparseable_band_file_is_absent_not_a_crash(pep_module, tmp_path):
    bad = tmp_path / "bands.json"
    bad.write_text("{not json")
    assert pep_module._load_source_bands(str(bad)) is None
    assert pep_module._load_source_bands(str(tmp_path / "nope.json")) is None
    assert pep_module._load_source_bands("") is None


# 6. the no-rollup test ------------------------------------------------------

def _walk_keys(node, path=""):
    if isinstance(node, dict):
        for k, v in node.items():
            yield f"{path}/{k}"
            yield from _walk_keys(v, f"{path}/{k}")
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from _walk_keys(v, f"{path}[{i}]")


def test_no_rollup_anywhere(rig):
    rig["rows"] = {"telemetry_latest_state": _tel(), "asset_cm_state": _cm(
        manual_discrepancies=[{"fault_code": "FC-1", "component": "C", "description": "d",
                               "severity": "MINOR"}]),
        "asset_logistics_status": _logi(), "asset_declaration": _decl()}
    code, body = _get(rig)
    assert code == 200
    assert set(body) == TOP_KEYS
    assert set(body["sources"]) == {"observed", "declared", "derived"}
    for name, src in body["sources"].items():
        expected = SOURCE_KEYS | ({"silent"} if name == "observed" else set())
        assert set(src) == expected, name
    bad = [p for p in _walk_keys(body) if FORBIDDEN_KEY.search(p.rsplit("/", 1)[-1])]
    assert bad == []
    # overall_status / overall_severity are allowed, and only inside `record`.
    for p in _walk_keys(body):
        leaf = p.rsplit("/", 1)[-1]
        if leaf in ("overall_status", "overall_severity"):
            assert "/record/" in p, p


# 7. only read_visible_row ---------------------------------------------------

def test_reads_go_through_read_visible_row_with_the_subjects_nations(rig):
    rig["decision"] = {"allow": True, "allowed_nations": ["ATL", "BDR"], "subject_known": True}
    rig["rows"] = {"telemetry_latest_state": _tel()}
    _get(rig)
    assert sorted(c[0] for c in rig["calls"]) == sorted(
        ["telemetry_latest_state", "asset_cm_state", "asset_logistics_status",
         "asset_declaration"])
    assert all(c[1] == ASSET and c[2] == ["ATL", "BDR"] for c in rig["calls"])
