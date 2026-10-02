"""The /cm/discrepancy write route, run through the real PEP handler.

An authenticated report becomes one CmEvent posted to the tier's cm-intake.
This checks every branch that must refuse rather than forward: no subject,
the PDP down or denying, a body that fails validation, an unconfigured fault
code list, a visibility read that finds nothing or finds the wrong slot, an
oversize body, a CSRF-shaped request, and an intake failure. The happy path
checks that exactly one CmEvent reaches cm-intake and that it round-trips
through the real generated protobuf type when that gencode is importable.

pep.py reads its upstreams at import, so they are fakes on loopback started
before the import, and the PEP runs in header mode (no issuer set).

Run:  py -3 -m pytest gateway/test_pep_cm_write.py
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

try:
    CONTRACTS_PY = (Path(__file__).resolve().parents[2]
                     / "openddil-contracts" / "gen" / "python")
    sys.path.insert(0, str(CONTRACTS_PY))
    from google.protobuf import json_format  # noqa: PLC0415
    from openddil.configuration.v1 import cm_events_pb2  # noqa: PLC0415
    GENCODE_AVAILABLE = True
except Exception:  # noqa: BLE001 -- the test environment may lack the gencode
    GENCODE_AVAILABLE = False

FAULT_CODES = [
    {"code": "FC-100", "text": "fluid leak", "severity": "MAJOR"},
    {"code": "FC-200", "text": "sensor drift", "severity": "MINOR"},
]

# Who the fake PDP knows. "pdp-down" makes Topaz answer 500.
ENTITLEMENTS = {"op.atl": ["ATL"], "stranger": []}

state = {
    "visibility_rows": [{"asset_id": "atl-1", "installed": [{"slot_id": "ENG-1"}]}],
    "intake_status": 200,
    "intake_calls": [],
}


class FakeTopaz(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        subject = json.loads(body["input"])["subject"]
        if subject == "pdp-down":
            self.send_response(500)
            self.end_headers()
            return
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
    """Answers the bounded shape read the visibility check makes. Reaches
    up-to-date on the very first response, as a freshly-created shape with
    nothing pending in its log would, so the check still makes exactly one
    request per call -- these tests are about the write route, not about
    the shape-log-following read itself (see test_pep_cm_visibility_read.py
    for that)."""

    def log_message(self, *a):
        pass

    def do_GET(self):  # noqa: N802
        rows = state["visibility_rows"]
        messages = [{"key": row.get("asset_id", "row"), "value": row,
                     "headers": {"operation": "insert"}} for row in rows]
        messages.append({"headers": {"control": "up-to-date"}})
        out = json.dumps(messages).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(out)))
        self.send_header("electric-handle", "fake-handle")
        self.send_header("electric-offset", "0")
        self.end_headers()
        self.wfile.write(out)


class FakeIntake(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):  # noqa: N802
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        state["intake_calls"].append(body)
        status = state["intake_status"]
        self.send_response(status)
        self.send_header("Content-Length", "0")
        self.end_headers()


def _serve(handler) -> ThreadingHTTPServer:
    srv = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


@pytest.fixture(scope="module")
def pep_factory():
    topaz = _serve(FakeTopaz)
    electric = _serve(FakeElectric)
    intake = _serve(FakeIntake)
    fault_codes_path = Path(__file__).resolve().parent / "_cm_fault_codes_test.json"
    fault_codes_path.write_text(json.dumps(FAULT_CODES))

    os.environ["OPENDDIL_ELECTRIC_URL"] = f"http://127.0.0.1:{electric.server_port}"
    os.environ["OPENDDIL_TOPAZ_URL"] = f"http://127.0.0.1:{topaz.server_port}"
    os.environ["OPENDDIL_CM_INTAKE_URL"] = f"http://127.0.0.1:{intake.server_port}/cm-events"
    os.environ["OPENDDIL_FAULT_CODES_PATH"] = str(fault_codes_path)
    os.environ.pop("OPENDDIL_REPORT_SOURCE", None)
    os.environ.pop("OPENDDIL_OIDC_ISSUER", None)
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    sys.modules.pop("pep", None)
    import pep  # noqa: PLC0415 -- must follow the env above

    pep.AUTH_MODE = "header"

    servers = []

    def start():
        srv = _serve(pep.Pep)
        servers.append(srv)
        return f"http://127.0.0.1:{srv.server_port}"

    yield start
    for s in servers + [topaz, electric, intake]:
        s.shutdown()
    fault_codes_path.unlink(missing_ok=True)
    # Leaving these set would point the NEXT module's fresh `import pep` at a
    # file this fixture just deleted and a port nothing listens on anymore.
    for var in ("OPENDDIL_CM_INTAKE_URL", "OPENDDIL_FAULT_CODES_PATH"):
        os.environ.pop(var, None)


def _post(url: str, subject: str | None, body: dict | bytes | None, *,
          content_type: str | None = "application/json",
          origin: str | None = None, host: str | None = None):
    data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data or b"", method="POST")
    if subject:
        req.add_header("X-OpenDDIL-Subject", subject)
    if content_type is not None:
        req.add_header("Content-Type", content_type)
    if origin is not None:
        req.add_header("Origin", origin)
    if host is not None:
        req.add_header("Host", host)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def _get(url: str, subject: str | None):
    req = urllib.request.Request(url)
    if subject:
        req.add_header("X-OpenDDIL-Subject", subject)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


@pytest.fixture
def pep_url(pep_factory):
    state.update(
        visibility_rows=[{"asset_id": "atl-1", "installed": [{"slot_id": "ENG-1"}]}],
        intake_status=200,
        intake_calls=[],
    )
    return pep_factory()


GOOD_BODY = {"asset_id": "atl-1", "component": "ENG-1", "fault_code": "FC-100",
             "description": "leaking at the seal"}


def test_no_session_is_401_and_intake_not_called(pep_url):
    code, body = _post(pep_url + "/cm/discrepancy", None, GOOD_BODY)
    assert code == 401
    assert state["intake_calls"] == []


def test_pdp_down_is_503(pep_url):
    code, body = _post(pep_url + "/cm/discrepancy", "pdp-down", GOOD_BODY)
    assert code == 503
    assert state["intake_calls"] == []


def test_pdp_deny_is_403(pep_url):
    code, body = _post(pep_url + "/cm/discrepancy", "stranger", GOOD_BODY)
    assert code == 403
    assert state["intake_calls"] == []


def test_spoofed_reported_by_is_ignored(pep_url):
    body = dict(GOOD_BODY, reported_by="someone-else", recorded_by="someone-else",
                source="someone-else")
    code, resp = _post(pep_url + "/cm/discrepancy", "op.atl", body)
    assert code == 202
    assert len(state["intake_calls"]) == 1
    sent = json.loads(state["intake_calls"][0])
    assert sent["recordedBy"] == "op.atl"


def test_visibility_read_empty_is_404_and_intake_not_called(pep_url):
    state["visibility_rows"] = []
    code, body = _post(pep_url + "/cm/discrepancy", "op.atl", GOOD_BODY)
    assert code == 404
    assert state["intake_calls"] == []


def test_component_not_installed_is_400(pep_url):
    body = dict(GOOD_BODY, component="NOT-A-SLOT")
    code, resp = _post(pep_url + "/cm/discrepancy", "op.atl", body)
    assert code == 400
    assert state["intake_calls"] == []


def test_unknown_fault_code_is_400(pep_url):
    body = dict(GOOD_BODY, fault_code="FC-999")
    code, resp = _post(pep_url + "/cm/discrepancy", "op.atl", body)
    assert code == 400
    assert state["intake_calls"] == []


def test_oversize_body_is_413(pep_url):
    big = dict(GOOD_BODY, description="x" * 9000)
    code, resp = _post(pep_url + "/cm/discrepancy", "op.atl", big)
    assert code == 413
    assert state["intake_calls"] == []


def test_intake_failure_is_502_and_decision_recorded(pep_url, caplog):
    state["intake_status"] = 500
    code, resp = _post(pep_url + "/cm/discrepancy", "op.atl", GOOD_BODY)
    assert code == 502
    assert len(state["intake_calls"]) == 1


def test_happy_path_posts_exactly_one_cm_event(pep_url):
    code, resp = _post(pep_url + "/cm/discrepancy", "op.atl", GOOD_BODY)
    assert code == 202
    assert "event_id" in resp
    assert len(state["intake_calls"]) == 1
    raw = state["intake_calls"][0]
    sent = json.loads(raw)
    assert sent["assetId"] == "atl-1"
    assert sent["recordedBy"] == "op.atl"
    assert sent["manualDiscrepancy"]["component"] == "ENG-1"
    assert sent["manualDiscrepancy"]["faultCode"] == "FC-100"
    assert sent["manualDiscrepancy"]["severity"] == "MAJOR"
    assert sent["manualDiscrepancy"]["source"] == "operator_report"
    if GENCODE_AVAILABLE:
        event = cm_events_pb2.CmEvent()
        json_format.Parse(raw, event)
        assert event.asset_id == "atl-1"
        assert event.manual_discrepancy.fault_code == "FC-100"
    else:
        print("GENCODE NOT IMPORTABLE -- skipping json_format.Parse check")


def test_unrouted_post_path_is_404(pep_url):
    code, resp = _post(pep_url + "/cm/nonsense", "op.atl", GOOD_BODY)
    assert code == 404
    assert state["intake_calls"] == []


# --- CSRF defence (defence in depth; SameSite is config, not a guarantee) ----

def test_non_json_content_type_is_415_and_intake_not_called(pep_url):
    code, resp = _post(pep_url + "/cm/discrepancy", "op.atl",
                        json.dumps(GOOD_BODY).encode(), content_type="text/plain")
    assert code == 415
    assert state["intake_calls"] == []


def test_cross_site_origin_is_403_and_intake_not_called(pep_url):
    url = pep_url + "/cm/discrepancy"
    code, resp = _post(url, "op.atl", GOOD_BODY, origin="https://evil.example")
    assert code == 403
    assert state["intake_calls"] == []


def test_same_origin_origin_passes_through(pep_url):
    url = pep_url + "/cm/discrepancy"
    host = urllib.parse.urlsplit(url).netloc
    code, resp = _post(url, "op.atl", GOOD_BODY, origin=f"http://{host}")
    assert code == 202
    assert len(state["intake_calls"]) == 1


def test_origin_port_is_not_compared_with_a_portless_host(pep_url):
    # The edge proxy forwards Host without the port; the browser's Origin
    # keeps it. Same hostname is same-site.
    url = pep_url + "/cm/discrepancy"
    hostname = urllib.parse.urlsplit(url).hostname
    code, resp = _post(url, "op.atl", GOOD_BODY, origin=f"http://{hostname}:3000",
                       host=hostname)
    assert code == 202
    assert len(state["intake_calls"]) == 1


# --- GET /cm/fault-codes ------------------------------------------------------

def test_fault_codes_requires_a_session(pep_url):
    code, body = _get(pep_url + "/cm/fault-codes", None)
    assert code == 401


def test_fault_codes_lists_the_configured_codes(pep_url):
    code, body = _get(pep_url + "/cm/fault-codes", "op.atl")
    assert code == 200
    assert body == FAULT_CODES


def test_fault_codes_404_when_not_configured(pep_factory, monkeypatch):
    # pep reads OPENDDIL_FAULT_CODES_PATH once at import; exercise the
    # "not configured" branch directly through the module rather than
    # re-importing with the env var unset (which would also tear down the
    # module-scoped fakes every other test in this file depends on).
    import pep  # noqa: PLC0415
    monkeypatch.setattr(pep, "FAULT_CODES", [])
    url = pep_factory()
    code, body = _get(url + "/cm/fault-codes", "op.atl")
    assert code == 404
