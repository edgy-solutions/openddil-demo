"""GET /proxies/, GET/POST /proxies/uplink and /proxies/<child id>, run
through the real PEP handler.

A link is a child tier's uplink to its parent. A PEP addresses its own
uplink and its direct children's, any PDP-known subject may read and flip
them (no role gate), and everything else is a 404. This checks the route
table for a root and a tier configuration, the gate order (401, 503, 403
for an unknown subject), the listing's shape, and that an admitted request
is forwarded verbatim (method, body, User-Agent) with the upstream's own
status and body relayed back.

pep.py reads its upstreams at import, so Topaz and the "toxiproxy" stand-in
are fakes on loopback started before the import, and the PEP runs in header
mode (no issuer set) -- same harness as test_pep_cm_write.py.

Run:  py -3 -m pytest gateway/test_pep_wan_control.py -q
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

# Who the fake PDP knows, keyed by subject -> role. A subject absent from
# this dict is "not in the entitlements corpus" (subject_known=False),
# exactly like policy/users.yaml's own default-deny.
SUBJECT_ROLES = {
    "supervisor.1": "supervisor",
    "operator.1": "edge-operator",
}

state = {
    "wan_calls": [],
    "wan_status": 200,
    "wan_body": b'{"enabled": false}',
    # What the fake toxiproxy answers to GET /proxies (name -> proxy).
    "proxy_map": {},
    # Per-call overrides: (method, path) -> (status, body bytes).
    "force": {},
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
        role = SUBJECT_ROLES.get(subject)
        x = {
            "allow": True,
            "allowed_nations": [],
            "subject_known": role is not None,
            "policy_version": "p1",
            "corpus_version": "c1",
            "role": role or "observer",
        }
        out = json.dumps({"response": {"result": [{"bindings": {"x": x}}]}}).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


class FakeWanControl(BaseHTTPRequestHandler):
    """Stands in for the DDIL sever mechanism's HTTP API under /proxies."""

    def log_message(self, *a):
        pass

    def _handle(self, method: str) -> None:
        length = int(self.headers.get("Content-Length", 0) or 0)
        body = self.rfile.read(length) if length else b""
        try:
            parsed = json.loads(body) if body else None
        except ValueError:
            parsed = None
        state["wan_calls"].append({
            "method": method,
            "path": self.path,
            "body": body,
            "json": parsed,
            "user_agent": self.headers.get("User-Agent", ""),
        })
        status = state["wan_status"]
        out = state["wan_body"]
        parts = self.path.strip("/").split("/")
        if method == "GET" and self.path == "/proxies":
            out = json.dumps(state["proxy_map"]).encode()
        elif method == "GET" and len(parts) == 2 and parts[1] in state["proxy_map"]:
            out = json.dumps(state["proxy_map"][parts[1]]).encode()
        # A per-call override: (method, path) -> (status, body).
        status, out = state["force"].get((method, self.path), (status, out))
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def do_GET(self):  # noqa: N802
        self._handle("GET")

    def do_POST(self):  # noqa: N802
        self._handle("POST")

    def do_DELETE(self):  # noqa: N802
        self._handle("DELETE")


def _serve(handler) -> ThreadingHTTPServer:
    srv = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


@pytest.fixture(scope="module")
def pep_factory():
    topaz = _serve(FakeTopaz)
    wan = _serve(FakeWanControl)

    # ELECTRIC is required at import but never reached by this route --
    # a placeholder that is never dialed.
    os.environ["OPENDDIL_ELECTRIC_URL"] = "http://127.0.0.1:1"
    os.environ["OPENDDIL_TOPAZ_URL"] = f"http://127.0.0.1:{topaz.server_port}"
    os.environ["OPENDDIL_WAN_CONTROL_URL"] = f"http://127.0.0.1:{wan.server_port}"
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
    for s in servers + [topaz, wan]:
        s.shutdown()
    os.environ.pop("OPENDDIL_WAN_CONTROL_URL", None)


def _get(url: str, subject: str | None):
    req = urllib.request.Request(url)
    if subject:
        req.add_header("X-OpenDDIL-Subject", subject)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def _post(url: str, subject: str | None, body: dict | bytes | None,
          content_type: str | None = "application/json", origin: str | None = None):
    data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data or b"", method="POST")
    if subject:
        req.add_header("X-OpenDDIL-Subject", subject)
    if content_type:
        req.add_header("Content-Type", content_type)
    if origin:
        req.add_header("Origin", origin)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def _reset():
    state.update(wan_calls=[], wan_status=200, wan_body=b'{"enabled": false}',
                 proxy_map={}, force={})


@pytest.fixture
def root_url(pep_factory, monkeypatch):
    """Root configuration: no uplink, direct children edge-03 and region-east."""
    import pep  # noqa: PLC0415
    monkeypatch.setattr(pep, "WAN_UPLINK", "")
    monkeypatch.setattr(pep, "WAN_UPLINK_PARENT", "")
    monkeypatch.setattr(pep, "WAN_CHILDREN", ("edge-03", "region-east"))
    _reset()
    return pep_factory()


@pytest.fixture
def tier_url(pep_factory, monkeypatch):
    """Tier configuration: own uplink to hq, direct children edge-01/02."""
    import pep  # noqa: PLC0415
    monkeypatch.setattr(pep, "WAN_UPLINK", "uplink-region-east")
    monkeypatch.setattr(pep, "WAN_UPLINK_PARENT", "hq")
    monkeypatch.setattr(pep, "WAN_CHILDREN", ("edge-01", "edge-02"))
    _reset()
    return pep_factory()


GOOD_BODY = {"enabled": False}
NO_TOXICS = {"latency_ms": 0, "jitter_ms": 0, "bandwidth_kb_s": 0}


# --- root configuration -----------------------------------------------------

def test_root_has_no_uplink(root_url):
    code, _ = _get(root_url + "/proxies/uplink", "supervisor.1")
    assert code == 404
    assert state["wan_calls"] == []


def test_root_child_post_forwards_to_uplink_proxy(root_url):
    code, _ = _post(root_url + "/proxies/region-east", "supervisor.1", GOOD_BODY)
    assert code == 200
    assert len(state["wan_calls"]) == 1
    call = state["wan_calls"][0]
    assert call["method"] == "POST"
    assert call["path"] == "/proxies/uplink-region-east"
    assert json.loads(call["body"]) == {"enabled": False}
    assert call["user_agent"] == "openddil-pep"


def test_root_grandchild_is_404(root_url):
    code, _ = _get(root_url + "/proxies/edge-01", "supervisor.1")
    assert code == 404
    assert state["wan_calls"] == []


def test_root_listing(root_url):
    # edge-03 is deliberately absent from the upstream map.
    state["proxy_map"] = {
        "uplink-region-east": {"name": "uplink-region-east", "enabled": False},
        "uplink-edge-01": {"name": "uplink-edge-01", "enabled": True},
    }
    code, body = _get(root_url + "/proxies/", "supervisor.1")
    assert code == 200
    assert json.loads(body) == {
        "uplink": None,
        "children": [
            {"id": "edge-03", "proxy": "uplink-edge-03", "enabled": None, "toxics": None},
            {"id": "region-east", "proxy": "uplink-region-east", "enabled": False,
             "toxics": NO_TOXICS},
        ],
    }
    assert [c["path"] for c in state["wan_calls"]] == ["/proxies"]


# --- tier configuration -----------------------------------------------------

def test_tier_uplink_forwards_to_own_proxy(tier_url):
    state["wan_body"] = b'{"enabled": true}'
    code, body = _get(tier_url + "/proxies/uplink", "supervisor.1")
    assert code == 200
    assert json.loads(body) == {"enabled": True}
    assert len(state["wan_calls"]) == 1
    assert state["wan_calls"][0]["method"] == "GET"
    assert state["wan_calls"][0]["path"] == "/proxies/uplink-region-east"


def test_tier_non_child_is_404(tier_url):
    code, _ = _get(tier_url + "/proxies/edge-03", "supervisor.1")
    assert code == 404
    assert state["wan_calls"] == []


def test_tier_itself_is_404(tier_url):
    code, _ = _get(tier_url + "/proxies/region-east", "supervisor.1")
    assert code == 404
    assert state["wan_calls"] == []


def test_tier_old_proxy_name_form_is_404(tier_url):
    code, _ = _get(tier_url + "/proxies/uplink-edge-01", "supervisor.1")
    assert code == 404
    assert state["wan_calls"] == []


def test_tier_listing_has_uplink_parent_and_children(tier_url):
    state["proxy_map"] = {
        "uplink-region-east": {"enabled": True},
        "uplink-edge-01": {"enabled": False},
        "uplink-edge-02": {"enabled": True},
    }
    code, body = _get(tier_url + "/proxies/", "operator.1")
    assert code == 200
    assert json.loads(body) == {
        "uplink": {"proxy": "uplink-region-east", "parent": "hq", "enabled": True,
                   "toxics": NO_TOXICS},
        "children": [
            {"id": "edge-01", "proxy": "uplink-edge-01", "enabled": False,
             "toxics": NO_TOXICS},
            {"id": "edge-02", "proxy": "uplink-edge-02", "enabled": True,
             "toxics": NO_TOXICS},
        ],
    }


def test_post_listing_is_404(tier_url):
    code, _ = _post(tier_url + "/proxies/", "supervisor.1", GOOD_BODY)
    assert code == 404
    assert state["wan_calls"] == []


# --- the gate ---------------------------------------------------------------

def test_operator_role_is_forwarded(tier_url, caplog):
    state["wan_status"] = 207  # distinguishable from a hardcoded 200
    with caplog.at_level("INFO"):
        code, _ = _post(tier_url + "/proxies/uplink", "operator.1", GOOD_BODY)
    assert code == 207  # the upstream's own status, relayed verbatim
    assert len(state["wan_calls"]) == 1
    msgs = [r.getMessage() for r in caplog.records if "WAN CONTROL" in r.getMessage()]
    assert msgs and "operator.1" in msgs[0] and "uplink-region-east" in msgs[0]
    assert "enabled=False" in msgs[0]


def test_unknown_subject_is_403(tier_url, caplog):
    with caplog.at_level("WARNING"):
        code, _ = _post(tier_url + "/proxies/uplink", "stranger", GOOD_BODY)
    assert code == 403
    assert state["wan_calls"] == []
    assert any("TOPAZ AUTHZ DENIED" in r.getMessage() for r in caplog.records)


def test_unknown_subject_listing_is_403(tier_url):
    code, _ = _get(tier_url + "/proxies/", "stranger")
    assert code == 403
    assert state["wan_calls"] == []


def test_no_session_is_401(tier_url):
    assert _get(tier_url + "/proxies/uplink", None)[0] == 401
    assert _post(tier_url + "/proxies/uplink", None, GOOD_BODY)[0] == 401
    assert _get(tier_url + "/proxies/", None)[0] == 401
    assert state["wan_calls"] == []


def test_topaz_down_is_503(tier_url):
    code, _ = _post(tier_url + "/proxies/uplink", "pdp-down", GOOD_BODY)
    assert code == 503
    assert state["wan_calls"] == []


def test_wrong_content_type_is_415(tier_url):
    code, _ = _post(tier_url + "/proxies/uplink", "supervisor.1", GOOD_BODY,
                    content_type="text/plain")
    assert code == 415
    assert state["wan_calls"] == []


def test_cross_site_origin_is_403(tier_url):
    code, _ = _post(tier_url + "/proxies/uplink", "supervisor.1", GOOD_BODY,
                    origin="http://evil.example")
    assert code == 403
    assert state["wan_calls"] == []


def test_oversized_body_is_413(tier_url):
    import pep  # noqa: PLC0415
    big = b'{"enabled": false, "pad": "' + b"x" * (pep.MAX_WAN_CONTROL_BODY_BYTES + 1) + b'"}'
    code, _ = _post(tier_url + "/proxies/uplink", "supervisor.1", big)
    assert code == 413
    assert state["wan_calls"] == []


def test_malformed_json_is_400(tier_url):
    code, _ = _post(tier_url + "/proxies/uplink", "supervisor.1", b"{not json")
    assert code == 400
    assert state["wan_calls"] == []


def test_non_bool_enabled_is_400(tier_url):
    code, _ = _post(tier_url + "/proxies/uplink", "supervisor.1", {"enabled": "false"})
    assert code == 400
    assert state["wan_calls"] == []


def test_extra_key_is_400(tier_url):
    code, _ = _post(tier_url + "/proxies/uplink", "supervisor.1",
                    {"enabled": False, "x": 1})
    assert code == 400
    assert state["wan_calls"] == []


def test_child_sub_path_is_404(tier_url):
    code, _ = _get(tier_url + "/proxies/edge-01/toxics", "supervisor.1")
    assert code == 404
    assert state["wan_calls"] == []


def test_uplink_sub_path_is_404(tier_url):
    code, _ = _get(tier_url + "/proxies/uplink/toxics", "supervisor.1")
    assert code == 404
    assert state["wan_calls"] == []


def test_wan_control_url_unset_is_404(tier_url, monkeypatch):
    import pep  # noqa: PLC0415
    monkeypatch.setattr(pep, "WAN_CONTROL_URL", "")
    assert _get(tier_url + "/proxies/uplink", "supervisor.1")[0] == 404
    assert _get(tier_url + "/proxies/", "supervisor.1")[0] == 404


# --- a transport failure, not a policy deny ---------------------------------

def test_upstream_connection_failure_is_502(tier_url, monkeypatch):
    import pep  # noqa: PLC0415
    # A loopback port nothing listens on -- urlopen raises URLError
    # (connection refused), not HTTPError.
    dead = _serve(FakeWanControl)
    port = dead.server_port
    dead.shutdown()
    monkeypatch.setattr(pep, "WAN_CONTROL_URL", f"http://127.0.0.1:{port}")
    code, _ = _post(tier_url + "/proxies/uplink", "supervisor.1", GOOD_BODY)
    assert code == 502
    code, body = _get(tier_url + "/proxies/", "supervisor.1")
    assert code == 502
    assert "error" in json.loads(body)


def test_upstream_non_2xx_listing_is_502(tier_url):
    state["wan_status"] = 500
    code, body = _get(tier_url + "/proxies/", "supervisor.1")
    assert code == 502
    assert "error" in json.loads(body)


# --- per-link toxics --------------------------------------------------------

EDGE_PROXY = "uplink-edge-01"
LAT = {"name": "link_latency", "type": "latency", "stream": "upstream",
       "toxicity": 1.0, "attributes": {"latency": 900, "jitter": 50}}
BW = {"name": "link_bandwidth", "type": "bandwidth", "stream": "upstream",
      "toxicity": 1.0, "attributes": {"rate": 64}}


def _proxy(name: str, *toxics):
    return {"name": name, "enabled": True, "toxics": list(toxics)}


def _toxics_post(url: str, toxics, subject: str = "supervisor.1", path: str = "/proxies/edge-01"):
    return _post(url + path, subject, {"toxics": toxics})


def _calls():
    return [(c["method"], c["path"]) for c in state["wan_calls"]]


def test_toxics_create_latency_only(tier_url):
    state["proxy_map"] = {EDGE_PROXY: _proxy(EDGE_PROXY)}
    code, body = _toxics_post(tier_url, {"latency_ms": 2000})
    assert code == 200
    assert _calls() == [("GET", "/proxies/" + EDGE_PROXY),
                        ("POST", "/proxies/" + EDGE_PROXY + "/toxics")]
    create = state["wan_calls"][1]
    assert create["json"] == {"name": "link_latency", "type": "latency",
                              "stream": "upstream", "toxicity": 1.0,
                              "attributes": {"latency": 2000, "jitter": 0}}
    assert create["user_agent"] == "openddil-pep"
    assert json.loads(body) == {"toxics": {"latency_ms": 2000, "jitter_ms": 0,
                                           "bandwidth_kb_s": 0}}


def test_toxics_update_existing_latency(tier_url):
    state["proxy_map"] = {EDGE_PROXY: _proxy(EDGE_PROXY, LAT)}
    code, _ = _toxics_post(tier_url, {"latency_ms": 500, "jitter_ms": 100})
    assert code == 200
    assert _calls() == [("GET", "/proxies/" + EDGE_PROXY),
                        ("POST", "/proxies/" + EDGE_PROXY + "/toxics/link_latency")]
    assert state["wan_calls"][1]["json"] == {"attributes": {"latency": 500, "jitter": 100}}


def test_empty_toxics_clears_both(tier_url):
    state["proxy_map"] = {EDGE_PROXY: _proxy(EDGE_PROXY, LAT, BW)}
    code, body = _toxics_post(tier_url, {})
    assert code == 200
    assert _calls() == [("GET", "/proxies/" + EDGE_PROXY),
                        ("DELETE", "/proxies/" + EDGE_PROXY + "/toxics/link_latency"),
                        ("DELETE", "/proxies/" + EDGE_PROXY + "/toxics/link_bandwidth")]
    assert json.loads(body) == {"toxics": NO_TOXICS}


def test_toxics_body_is_complete_state(tier_url):
    # Bandwidth only: the bandwidth toxic is created and the existing
    # latency toxic goes, because a missing key means 0.
    state["proxy_map"] = {EDGE_PROXY: _proxy(EDGE_PROXY, LAT)}
    code, _ = _toxics_post(tier_url, {"bandwidth_kb_s": 32})
    assert code == 200
    assert _calls() == [("GET", "/proxies/" + EDGE_PROXY),
                        ("DELETE", "/proxies/" + EDGE_PROXY + "/toxics/link_latency"),
                        ("POST", "/proxies/" + EDGE_PROXY + "/toxics")]
    assert state["wan_calls"][2]["json"] == {
        "name": "link_bandwidth", "type": "bandwidth", "stream": "upstream",
        "toxicity": 1.0, "attributes": {"rate": 32}}


def test_null_toxic_means_zero(tier_url):
    state["proxy_map"] = {EDGE_PROXY: _proxy(EDGE_PROXY, LAT)}
    code, body = _toxics_post(tier_url, {"latency_ms": None, "jitter_ms": None})
    assert code == 200
    assert _calls()[-1] == ("DELETE", "/proxies/" + EDGE_PROXY + "/toxics/link_latency")
    assert json.loads(body) == {"toxics": NO_TOXICS}


@pytest.mark.parametrize("payload", [
    {"toxics": {"loss_pct": 5}},
    {"toxics": {"latency_ms": True}},
    {"toxics": {"latency_ms": 1.5}},
    {"toxics": {"latency_ms": "2000"}},
    {"toxics": {"latency_ms": 60001}},
    {"toxics": {"jitter_ms": 60001}},
    {"toxics": {"bandwidth_kb_s": 1000001}},
    {"toxics": {"latency_ms": -1}},
    {"toxics": {"bandwidth_kb_s": -5}},
    {"enabled": True, "toxics": {"latency_ms": 5}},
    {"toxics": [1, 2]},
    {"toxics": None},
    {},
], ids=["unknown-key", "bool", "float", "string", "latency-high", "jitter-high",
        "bandwidth-high", "negative", "negative-bw", "both-keys", "not-object",
        "null-toxics", "empty-body"])
def test_toxics_bad_body_is_400(tier_url, payload):
    state["proxy_map"] = {EDGE_PROXY: _proxy(EDGE_PROXY)}
    code, body = _post(tier_url + "/proxies/edge-01", "supervisor.1", payload)
    assert code == 400
    assert "error" in json.loads(body)
    assert state["wan_calls"] == []


def test_toxics_bool_is_400_specifically(tier_url):
    code, body = _toxics_post(tier_url, {"bandwidth_kb_s": True})
    assert code == 400
    assert "bandwidth_kb_s" in json.loads(body)["error"]
    assert state["wan_calls"] == []


def test_toxics_bounds_are_inclusive(tier_url):
    state["proxy_map"] = {EDGE_PROXY: _proxy(EDGE_PROXY)}
    code, _ = _toxics_post(tier_url, {"latency_ms": 60000, "jitter_ms": 60000,
                                      "bandwidth_kb_s": 1000000})
    assert code == 200


def test_toxics_unknown_proxy_relays_404(tier_url):
    state["force"] = {("GET", "/proxies/" + EDGE_PROXY): (404, b'{"error":"proxy not found"}')}
    code, body = _toxics_post(tier_url, {"latency_ms": 100})
    assert code == 404
    assert json.loads(body) == {"error": "proxy not found"}
    assert _calls() == [("GET", "/proxies/" + EDGE_PROXY)]


def test_toxics_unknown_subject_is_403(tier_url):
    code, _ = _toxics_post(tier_url, {"latency_ms": 100}, subject="stranger")
    assert code == 403
    assert state["wan_calls"] == []


def test_toxics_no_session_is_401(tier_url):
    code, _ = _post(tier_url + "/proxies/edge-01", None, {"toxics": {"latency_ms": 100}})
    assert code == 401
    assert state["wan_calls"] == []


def test_toxics_non_child_is_404(tier_url):
    code, _ = _toxics_post(tier_url, {"latency_ms": 100}, path="/proxies/edge-03")
    assert code == 404
    assert state["wan_calls"] == []


def test_toxic_post_failure_stops_the_sequence(tier_url):
    state["proxy_map"] = {EDGE_PROXY: _proxy(EDGE_PROXY)}
    state["force"] = {("POST", "/proxies/" + EDGE_PROXY + "/toxics"):
                      (500, b'{"error":"boom"}')}
    code, body = _toxics_post(tier_url, {"latency_ms": 100, "bandwidth_kb_s": 10})
    assert code == 500
    assert json.loads(body) == {"error": "boom"}
    # The latency create failed, so the bandwidth create was never sent.
    assert _calls() == [("GET", "/proxies/" + EDGE_PROXY),
                        ("POST", "/proxies/" + EDGE_PROXY + "/toxics")]


def test_toxics_transport_failure_is_502(tier_url, monkeypatch):
    import pep  # noqa: PLC0415
    dead = _serve(FakeWanControl)
    port = dead.server_port
    dead.shutdown()
    monkeypatch.setattr(pep, "WAN_CONTROL_URL", f"http://127.0.0.1:{port}")
    code, body = _toxics_post(tier_url, {"latency_ms": 100})
    assert code == 502
    assert json.loads(body) == {"error": "wan control upstream unavailable"}


def test_listing_carries_toxics(tier_url):
    state["proxy_map"] = {
        "uplink-region-east": _proxy("uplink-region-east", BW),
        EDGE_PROXY: _proxy(EDGE_PROXY, LAT, {"name": "other", "type": "timeout",
                                             "attributes": {"latency": 7}}),
        # edge-02 is deliberately absent.
    }
    code, body = _get(tier_url + "/proxies/", "supervisor.1")
    assert code == 200
    listing = json.loads(body)
    assert listing["uplink"]["toxics"] == {"latency_ms": 0, "jitter_ms": 0,
                                           "bandwidth_kb_s": 64}
    assert listing["children"][0]["toxics"] == {"latency_ms": 900, "jitter_ms": 50,
                                                "bandwidth_kb_s": 0}
    assert listing["children"][1]["toxics"] is None
    assert [c["path"] for c in state["wan_calls"]] == ["/proxies"]


def test_toxics_log_line(tier_url, caplog):
    state["proxy_map"] = {EDGE_PROXY: _proxy(EDGE_PROXY)}
    with caplog.at_level("INFO"):
        code, _ = _toxics_post(tier_url, {"latency_ms": 2000}, subject="operator.1")
    assert code == 200
    msgs = [r.getMessage() for r in caplog.records if "WAN TOXICS" in r.getMessage()]
    assert len(msgs) == 1
    assert "operator.1" in msgs[0] and EDGE_PROXY in msgs[0]
    assert "latency_ms=2000" in msgs[0] and "upstream_status=200" in msgs[0]


def test_tier_uplink_toxics_target_own_proxy(tier_url):
    state["proxy_map"] = {"uplink-region-east": _proxy("uplink-region-east")}
    code, _ = _toxics_post(tier_url, {"latency_ms": 300}, path="/proxies/uplink")
    assert code == 200
    assert _calls() == [("GET", "/proxies/uplink-region-east"),
                        ("POST", "/proxies/uplink-region-east/toxics")]
