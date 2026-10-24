"""Tests for exercise/control.py: derive_state's rules in isolation, the
Prometheus-text parser, adapter-file validation, and one round trip through
the real HTTP handler against fake metrics servers and a fake adapter
endpoint (all on loopback -- offline, like gateway/test_pep_wan_control.py).

Run:  py -3 -m pytest exercise/test_control.py -q
"""
from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

import control


# =============================================================================
# derive_state -- the pure function
# =============================================================================

WINDOW = 30.0
MIN_RATE = 0.1


def test_measuring_when_fewer_than_a_full_window_since_start():
    now = 1000.0
    samples = {"s1": [(now - 5, 100.0), (now - 2, 110.0)]}  # only 5s of history
    out = control.derive_state(samples, now, WINDOW, MIN_RATE)
    assert out["state"] == "unknown"
    assert out["label"] == "measuring"
    assert out["sources"][0]["url"] == "s1"
    assert out["sources"][0]["reachable"] is True
    assert out["sources"][0]["rate"] == pytest.approx(10.0 / 3.0)


def test_single_reachable_source_above_min_is_running():
    now = 1000.0
    samples = {"s1": [(now - WINDOW - 1, 0.0), (now, 100.0)]}  # ~3.2/s
    out = control.derive_state(samples, now, WINDOW, MIN_RATE)
    assert out["state"] == "running"
    assert out["sources"][0]["reachable"] is True
    assert out["sources"][0]["rate"] > MIN_RATE


def test_all_reachable_present_below_min_for_full_window_is_paused():
    now = 1000.0
    samples = {
        "s1": [(now - WINDOW - 1, 50.0), (now, 50.0)],  # flat: rate 0
        "s2": [(now - WINDOW - 1, 10.0), (now, 10.0)],
    }
    out = control.derive_state(samples, now, WINDOW, MIN_RATE)
    assert out["state"] == "paused"
    assert out["label"] == "no entity PDUs"


def test_one_source_unreachable_with_no_positive_evidence_is_unknown():
    now = 1000.0
    samples = {
        "s1": [(now - WINDOW - 1, 50.0), (now, 50.0)],  # reachable, flat
        "s2": [(now - WINDOW - 1, None), (now, None)],  # unreachable
    }
    out = control.derive_state(samples, now, WINDOW, MIN_RATE)
    assert out["state"] == "unknown"
    assert out["sources"][1] == {"url": "s2", "reachable": False, "rate": None}


def test_one_source_unreachable_other_running_is_still_running():
    now = 1000.0
    samples = {
        "s1": [(now - WINDOW - 1, 0.0), (now, 100.0)],
        "s2": [(now - WINDOW - 1, None), (now, None)],
    }
    out = control.derive_state(samples, now, WINDOW, MIN_RATE)
    assert out["state"] == "running"  # a cut link never masks a running one


def test_cut_link_is_unknown_never_paused():
    now = 1000.0
    samples = {"s1": [(now - WINDOW - 1, None), (now, None)]}
    out = control.derive_state(samples, now, WINDOW, MIN_RATE)
    assert out["state"] == "unknown"
    assert out["state"] != "paused"


def test_no_samples_at_all_is_unknown_measuring():
    out = control.derive_state({}, 1000.0, WINDOW, MIN_RATE)
    assert out == {"state": "unknown", "label": "measuring", "sources": []}


def test_counter_reset_treated_as_restart_rate_from_new_value_only():
    now = 1000.0
    # Counts up to 1000, resets to 0 (a restart), then climbs again.
    samples = {"s1": [
        (now - WINDOW - 10, 900.0),
        (now - WINDOW - 5, 1000.0),
        (now - WINDOW + 5, 0.0),     # reset
        (now - 5, 50.0),
        (now, 100.0),
    ]}
    out = control.derive_state(samples, now, WINDOW, MIN_RATE)
    # Rate must be computed only from the post-reset run -- a naive
    # (latest - oldest) / elapsed would go deeply negative.
    assert out["sources"][0]["rate"] is not None
    assert out["sources"][0]["rate"] > 0


# =============================================================================
# parse_pdu_total
# =============================================================================

def test_parses_total_summed_over_other_labels():
    text = (
        '# HELP dis_pdus_received_total x\n'
        '# TYPE dis_pdus_received_total counter\n'
        'dis_pdus_received_total{pdu_type="1",source="a"} 12\n'
        'dis_pdus_received_total{pdu_type="1",source="b"} 8\n'
        'dis_pdus_received_total{pdu_type="7"} 500\n'
    )
    assert control.parse_pdu_total(text) == 20.0


def test_metric_absent_returns_none():
    assert control.parse_pdu_total("# nothing here\nother_metric 1\n") is None


def test_metric_present_with_zero_value_is_zero_not_none():
    text = 'dis_pdus_received_total{pdu_type="1"} 0\n'
    assert control.parse_pdu_total(text) == 0.0


# =============================================================================
# load_adapter_config -- refuses startup, naming the entry
# =============================================================================

def _write(tmp_path, obj):
    p = tmp_path / "adapter.json"
    p.write_text(json.dumps(obj), encoding="utf-8")
    return str(p)


def test_valid_adapter_loads(tmp_path):
    cfg = {
        "name": "stand-in",
        "endpoint": "http://example.invalid",
        "operations": {"pause": {"method": "post", "path": "/pause", "body": {}}},
    }
    out = control.load_adapter_config(_write(tmp_path, cfg))
    assert out["operations"]["pause"] == [{"method": "POST", "path": "/pause", "body": {}}]


def test_unknown_op_key_refuses(tmp_path):
    cfg = {"name": "x", "endpoint": "http://e", "operations": {"launch": {"method": "POST", "path": "/x"}}}
    with pytest.raises(control.AdapterConfigError, match="launch"):
        control.load_adapter_config(_write(tmp_path, cfg))


def test_missing_method_refuses(tmp_path):
    cfg = {"name": "x", "endpoint": "http://e", "operations": {"pause": {"path": "/x"}}}
    with pytest.raises(control.AdapterConfigError, match="pause"):
        control.load_adapter_config(_write(tmp_path, cfg))


def test_missing_path_refuses(tmp_path):
    cfg = {"name": "x", "endpoint": "http://e", "operations": {"pause": {"method": "POST"}}}
    with pytest.raises(control.AdapterConfigError, match="pause"):
        control.load_adapter_config(_write(tmp_path, cfg))


def test_non_object_body_refuses(tmp_path):
    cfg = {"name": "x", "endpoint": "http://e",
           "operations": {"pause": {"method": "POST", "path": "/x", "body": "nope"}}}
    with pytest.raises(control.AdapterConfigError, match="pause"):
        control.load_adapter_config(_write(tmp_path, cfg))


def test_malformed_json_refuses(tmp_path):
    p = tmp_path / "adapter.json"
    p.write_text("{not json", encoding="utf-8")
    with pytest.raises(control.AdapterConfigError):
        control.load_adapter_config(str(p))


# =============================================================================
# Integration: the real HTTP handler against fake sources + a fake adapter
# =============================================================================

state = {"adapter_calls": [], "adapter_status": 200, "status_by_path": {}, "adapter_delay": 0.0, "metrics_text": ""}


class FakeAdapter(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        body = self.rfile.read(length) if length else b""
        state["adapter_calls"].append({"path": self.path, "body": body})
        if state["adapter_delay"]:
            time.sleep(state["adapter_delay"])
        out = json.dumps({"state": "running"}).encode()  # the stub's own
        # lie about state -- control.py must never read this field.
        self.send_response(state["status_by_path"].get(self.path, state["adapter_status"]))
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


class FakeMetrics(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        out = state["metrics_text"].encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


def _serve(handler):
    srv = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


@pytest.fixture
def app(tmp_path):
    adapter_srv = _serve(FakeAdapter)
    metrics_srv = _serve(FakeMetrics)
    state.update(adapter_calls=[], adapter_status=200, adapter_delay=0.0, status_by_path={},
                 metrics_text='dis_pdus_received_total{pdu_type="1"} 1\n')

    cfg = {
        "name": "stand-in",
        "endpoint": f"http://127.0.0.1:{adapter_srv.server_port}",
        "operations": {"pause": {"method": "POST", "path": "/pause", "body": {}}},
    }
    adapter = control.load_adapter_config(_write(tmp_path, cfg))
    store = control.RateStore(sources=[f"http://127.0.0.1:{metrics_srv.server_port}/metrics"],
                               window=30.0, min_rate=0.1)
    app_state = control.AppState(adapter=adapter, store=store, reset_record_file=None)

    handler_srv = _serve(control.make_handler(app_state))
    yield f"http://127.0.0.1:{handler_srv.server_port}", app_state, store
    for s in (adapter_srv, metrics_srv, handler_srv):
        s.shutdown()


def _get(url):
    try:
        with urllib.request.urlopen(url, timeout=5) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def _post(url, subject=None, timeout=5):
    req = urllib.request.Request(url, data=b"", method="POST")
    if subject is not None:
        req.add_header(control.SUBJECT_HEADER, subject)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def test_status_reports_adapter_ops_and_reset_absent(app):
    url, _app_state, _store = app
    code, body = _get(url + "/exercise/status")
    assert code == 200
    assert body["adapter"] == {"name": "stand-in", "ops": ["pause"]}
    assert body["last_command"] is None
    assert body["reset"] == {"measured_zero_at": None, "verdict": None}


def test_unknown_op_is_404_before_any_outward_call(app):
    url, _app_state, _store = app
    code, body = _post(url + "/exercise/op/launch", subject="s1")
    assert code == 404
    assert state["adapter_calls"] == []


def test_missing_subject_header_is_400_no_call(app):
    url, _app_state, _store = app
    code, _body = _post(url + "/exercise/op/pause", subject=None)
    assert code == 400
    assert state["adapter_calls"] == []


def test_valid_op_forwards_and_records_last_command_status_only(app):
    url, _app_state, _store = app
    state["adapter_status"] = 200
    code, body = _post(url + "/exercise/op/pause", subject="subj.1")
    assert code == 200
    assert body["op"] == "pause"
    assert body["status"] == 200
    assert body["error"] is None
    assert body["subject"] == "subj.1"
    # The adapter's lie ({"state": "running"}) must never surface here.
    assert "state" not in body
    assert len(state["adapter_calls"]) == 1

    status_code, status_body = _get(url + "/exercise/status")
    assert status_code == 200
    assert status_body["last_command"]["op"] == "pause"


def test_adapter_unreachable_records_transport_error(app, monkeypatch):
    url, app_state, _store = app
    # Point the adapter at a dead loopback port.
    dead = _serve(FakeAdapter)
    port = dead.server_port
    dead.shutdown()
    app_state.adapter["endpoint"] = f"http://127.0.0.1:{port}"

    code, body = _post(url + "/exercise/op/pause", subject="subj.1", timeout=15)
    assert code == 200  # this service's own route still answers
    assert body["status"] is None
    assert body["error"]  # some transport error string, recorded not guessed


# =============================================================================
# The restart gate: never without a fresh measured zero
# =============================================================================

@pytest.fixture
def gate(tmp_path):
    adapter_srv = _serve(FakeAdapter)
    metrics_srv = _serve(FakeMetrics)
    state.update(adapter_calls=[], adapter_status=200, adapter_delay=0.0, status_by_path={},
                 metrics_text='dis_pdus_received_total{pdu_type="1"} 1\n')
    ops = {op: {"method": "POST", "path": "/" + op, "body": {}}
           for op in ("pause", "resume", "stop", "restart", "run")}
    cfg = {"name": "stand-in",
           "endpoint": f"http://127.0.0.1:{adapter_srv.server_port}",
           "operations": ops}
    adapter = control.load_adapter_config(_write(tmp_path, cfg))
    store = control.RateStore(sources=[f"http://127.0.0.1:{metrics_srv.server_port}/metrics"],
                               window=30.0, min_rate=0.1)
    record = tmp_path / "record.json"
    app_state = control.AppState(adapter=adapter, store=store,
                                 reset_record_file=str(record))
    handler_srv = _serve(control.make_handler(app_state))
    yield f"http://127.0.0.1:{handler_srv.server_port}", record
    for s in (adapter_srv, metrics_srv, handler_srv):
        s.shutdown()


def _zero(record, verdict="PASS", age_s=10, stamp=None):
    from datetime import datetime, timedelta, timezone
    at = stamp or (datetime.now(timezone.utc) - timedelta(seconds=age_s)).isoformat(
        timespec="seconds")
    record.write_text(json.dumps({"measured_zero_at": at, "verdict": verdict}))
    return at


def test_g1_no_record_is_409_no_record_and_no_call(gate):
    url, _record = gate
    code, body = _post(url + "/exercise/op/restart", subject="s")
    assert code == 409
    assert body == {"error": "reset required", "reason": "no_record",
                    "measured_zero_at": None, "verdict": None}
    assert state["adapter_calls"] == []
    assert _get(url + "/exercise/status")[1]["last_command"] is None


def test_g2_verdict_fail_is_409_verdict_not_pass(gate):
    url, record = gate
    _zero(record, verdict="FAIL")
    code, body = _post(url + "/exercise/op/restart", subject="s")
    assert code == 409
    assert body["reason"] == "verdict_not_pass"
    assert body["verdict"] == "FAIL"
    assert state["adapter_calls"] == []


def test_g2b_unparseable_timestamp_is_409_unparseable(gate):
    url, record = gate
    _zero(record, stamp="yesterday-ish")
    code, body = _post(url + "/exercise/op/restart", subject="s")
    assert code == 409
    assert body["reason"] == "unparseable"
    assert state["adapter_calls"] == []


def test_g3_fresh_pass_sends_once_then_already_used(gate):
    url, record = gate
    at = _zero(record)
    code, body = _post(url + "/exercise/op/restart", subject="s")
    assert code == 200
    assert body["op"] == "restart" and body["status"] == 200
    assert [c["path"] for c in state["adapter_calls"]] == ["/restart"]
    code, body = _post(url + "/exercise/op/restart", subject="s")
    assert code == 409
    assert body["reason"] == "already_used"
    assert body["measured_zero_at"] == at
    assert body["verdict"] == "PASS"
    assert len(state["adapter_calls"]) == 1
    # a new measured zero re-arms the gate
    _zero(record, age_s=1)
    assert _post(url + "/exercise/op/restart", subject="s")[0] == 200
    assert len(state["adapter_calls"]) == 2


def test_g4_stale_zero_is_409_stale(gate):
    url, record = gate
    _zero(record, age_s=control.DEFAULT_RESTART_MAX_ZERO_AGE_S + 60)
    code, body = _post(url + "/exercise/op/restart", subject="s")
    assert code == 409
    assert body["reason"] == "stale"
    assert state["adapter_calls"] == []


def test_g5_adapter_503_does_not_use_up_the_zero(gate):
    url, record = gate
    _zero(record)
    state["adapter_status"] = 503
    code, body = _post(url + "/exercise/op/restart", subject="s")
    assert code == 200 and body["status"] == 503
    state["adapter_status"] = 200
    code, body = _post(url + "/exercise/op/restart", subject="s")
    assert code == 200 and body["status"] == 200
    assert len(state["adapter_calls"]) == 2


def test_g6_other_ops_are_not_gated(gate):
    url, _record = gate  # no record file at all
    for op in ("pause", "stop", "run", "resume"):
        assert _post(url + f"/exercise/op/{op}", subject="s")[0] == 200
    assert [c["path"] for c in state["adapter_calls"]] == [
        "/pause", "/stop", "/run", "/resume"]


def test_g7_status_shows_restart_allowed(gate):
    url, record = gate
    body = _get(url + "/exercise/status")[1]
    assert body["restart_allowed"] is False
    assert body["restart_refusal"] == "no_record"
    _zero(record)
    body = _get(url + "/exercise/status")[1]
    assert body["restart_allowed"] is True
    assert body["restart_refusal"] is None
    _post(url + "/exercise/op/restart", subject="s")
    body = _get(url + "/exercise/status")[1]
    assert body["restart_allowed"] is False
    assert body["restart_refusal"] == "already_used"


@pytest.mark.parametrize("bad", ["0", "-5", "abc"])
def test_g8_non_positive_max_age_refuses_startup(monkeypatch, bad):
    monkeypatch.setenv("EXERCISE_RESTART_MAX_ZERO_AGE_S", bad)
    assert control.main() == 2


def _two_concurrent_restarts(url):
    out = []
    ts = [threading.Thread(target=lambda: out.append(
        _post(url + "/exercise/op/restart", subject="s", timeout=10))) for _ in range(2)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    return out


def test_g9_concurrent_restarts_send_exactly_one(gate):
    url, record = gate
    _zero(record)
    state["adapter_delay"] = 0.5
    out = _two_concurrent_restarts(url)
    assert len(state["adapter_calls"]) == 1
    assert sorted(c for c, _ in out) == [200, 409]
    refused = [b for c, b in out if c == 409][0]
    assert refused["reason"] == "already_used"


def test_g9_control_failed_restart_does_not_use_the_zero(gate):
    url, record = gate
    _zero(record)
    state["adapter_delay"] = 0.5
    state["adapter_status"] = 503
    out = _two_concurrent_restarts(url)
    assert len(state["adapter_calls"]) == 2
    assert [c for c, _ in out] == [200, 200]


# =============================================================================
# in-cluster reset Job -- POST /exercise/op/reset against a fake Kubernetes API
# =============================================================================

kube = {"jobs": [], "posts": [], "gets": [], "list_status": 200, "post_status": 201, "post_delay": 0.0}

TEMPLATE = {
    "apiVersion": "batch/v1",
    "kind": "Job",
    "metadata": {"generateName": "rel-exercise-reset-",
                 "labels": {"app.kubernetes.io/component": "exercise-reset",
                            "app.kubernetes.io/instance": "rel"}},
    "spec": {"backoffLimit": 0, "template": {"spec": {"containers": [
        {"name": "reset", "env": [{"name": "RESTART_SUBJECT", "value": ""}]}]}}},
}


def _job(name, created, active=0, conds=None, completion=None, by=None):
    status = {"active": active, "conditions": conds or []}
    if completion:
        status["completionTime"] = completion
    meta = {"name": name, "creationTimestamp": created}
    if by:
        meta["annotations"] = {"openddil.io/requested-by": by}
    return {"metadata": meta, "status": status}


class FakeKube(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _reply(self, code, obj):
        out = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def do_GET(self):
        kube["gets"].append({"path": self.path, "auth": self.headers.get("Authorization")})
        if kube["list_status"] != 200:
            self._reply(kube["list_status"], {"message": "denied"})
            return
        self._reply(200, {"items": list(kube["jobs"])})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        body = json.loads(self.rfile.read(length))
        if kube["post_delay"]:
            time.sleep(kube["post_delay"])
        if kube["post_status"] != 201:
            self._reply(kube["post_status"], {"message": "failed"})
            return
        kube["posts"].append({"path": self.path, "body": body,
                              "adapter_calls_before": len(state["adapter_calls"])})
        name = f"rel-exercise-reset-{len(kube['posts'])}"
        kube["jobs"].append(_job(name, f"2026-01-01T00:00:{len(kube['posts']):02d}Z", active=1))
        self._reply(201, {"metadata": {"name": name}})


@pytest.fixture
def kapp(tmp_path):
    kube.update(jobs=[], posts=[], gets=[], list_status=200, post_status=201, post_delay=0.0)
    state.update(adapter_calls=[], adapter_status=200, status_by_path={})
    kube_srv = _serve(FakeKube)
    sa = tmp_path / "sa"
    sa.mkdir()
    (sa / "token").write_text("tok-1\n")
    (sa / "namespace").write_text("ns1\n")
    tpl = tmp_path / "job.json"
    tpl.write_text(json.dumps(TEMPLATE))
    launcher = control.ResetJobLauncher(tpl, sa_dir=sa, base_url=f"http://127.0.0.1:{kube_srv.server_port}")
    adapter_srv = _serve(FakeAdapter)
    cfg = {"name": "stand-in", "endpoint": f"http://127.0.0.1:{adapter_srv.server_port}",
           "operations": {"pause": {"method": "POST", "path": "/pause", "body": {}}}}
    adapter = control.load_adapter_config(_write(tmp_path, cfg))
    store = control.RateStore(sources=[], window=30.0, min_rate=0.1)
    app_state = control.AppState(adapter=adapter, store=store, reset_record_file=None,
                                 reset_launcher=launcher)
    handler_srv = _serve(control.make_handler(app_state))
    yield f"http://127.0.0.1:{handler_srv.server_port}", app_state
    for s in (kube_srv, adapter_srv, handler_srv):
        s.shutdown()


def test_r1_reset_creates_job_with_subject_env_and_annotation(kapp):
    url, app_state = kapp
    code, body = _post(url + "/exercise/op/reset", subject="sup@x")
    assert code == 202
    assert body["op"] == "reset" and body["subject"] == "sup@x"
    assert body["job"] == "rel-exercise-reset-1"
    assert len(kube["posts"]) == 1
    posted = kube["posts"][0]
    assert posted["adapter_calls_before"] == 1  # the pause landed before the Job POST
    assert posted["path"] == "/apis/batch/v1/namespaces/ns1/jobs"
    env = posted["body"]["spec"]["template"]["spec"]["containers"][0]["env"]
    assert {"name": "RESTART_SUBJECT", "value": "reset-job:sup@x"} in env
    assert posted["body"]["metadata"]["annotations"]["openddil.io/requested-by"] == "sup@x"
    last = app_state.get_last_command()
    assert last["op"] == "reset" and last["status"] == 201 and last["error"] is None
    assert last["job"] == body["job"] and last["subject"] == "sup@x"
    # kapp configures pause: exactly one pause call, sent before the Job POST.
    assert [c["path"] for c in state["adapter_calls"]] == ["/pause"]
    assert body["pause"]["status"] == 200 and body["pause"]["error"] is None
    assert [st["path"] for st in body["pause"]["steps"]] == ["/pause"]
    assert last["pause"] == body["pause"]
    # the template itself is not mutated by a launch
    tpl_env = app_state.reset_launcher.template["spec"]["template"]["spec"]["containers"][0]["env"]
    assert tpl_env[0]["value"] == ""


def test_r2_selector_is_encoded_and_token_sent(kapp):
    url, _ = kapp
    _post(url + "/exercise/op/reset", subject="s")
    g = kube["gets"][0]
    assert ("labelSelector=app.kubernetes.io%2Fcomponent%3Dexercise-reset%2C"
            "app.kubernetes.io%2Finstance%3Drel") in g["path"]
    assert g["auth"] == "Bearer tok-1"


def test_r3_running_job_is_409_and_creates_nothing(kapp):
    url, app_state = kapp
    kube["jobs"].append(_job("rel-exercise-reset-old", "2026-01-01T00:00:00Z", active=1))
    code, body = _post(url + "/exercise/op/reset", subject="s")
    assert code == 409
    assert body == {"error": "reset already running", "reason": "reset_running",
                    "job": "rel-exercise-reset-old"}
    assert kube["posts"] == []
    assert app_state.get_last_command() is None


@pytest.mark.parametrize("api_status", [403, 500])
def test_r4_api_error_is_502_and_last_command_is_the_pause_or_untouched(kapp, api_status):
    url, app_state = kapp
    kube["post_status"] = api_status
    code, body = _post(url + "/exercise/op/reset", subject="s")
    assert code == 502
    assert body == {"error": "reset job not created", "status": api_status,
                    "simulator_paused": True}
    last = app_state.get_last_command()
    assert last["op"] == "pause" and last["via"] == "reset"
    # a list failure never gets as far as the adapter
    app_state.set_last_command(None)
    state["adapter_calls"].clear()
    kube.update(post_status=201, list_status=api_status)
    code, body = _post(url + "/exercise/op/reset", subject="s")
    assert (code, body["status"]) == (502, api_status)
    assert "simulator_paused" not in body
    assert state["adapter_calls"] == []
    assert app_state.get_last_command() is None


def test_r5_reset_is_404_when_feature_off(app):
    url, _app_state, _store = app
    code, body = _post(url + "/exercise/op/reset", subject="s")
    assert code == 404 and body["error"] == "unknown op"


def test_r6_missing_subject_and_bad_subject_are_400(kapp):
    url, _ = kapp
    assert _post(url + "/exercise/op/reset")[0] == 400
    for bad in ["has space", "semi;colon", "x" * 97]:
        assert _post(url + "/exercise/op/reset", subject=bad)[0] == 400
    assert kube["posts"] == [] and kube["gets"] == []


def test_r7_status_without_launcher(app):
    url, _app_state, _store = app
    _, body = _get(url + "/exercise/status")
    assert body["reset_job"] == {"available": False, "latest": None, "error": None, "mode": "full"}


def test_r8_status_with_launcher_and_states(kapp):
    url, _ = kapp
    _, body = _get(url + "/exercise/status")
    assert body["reset_job"] == {"available": True, "latest": None, "error": None, "mode": "full"}
    kube["jobs"] = [
        _job("old", "2026-01-01T00:00:00Z", conds=[{"type": "Failed", "status": "True"}]),
        _job("new", "2026-01-02T00:00:00Z", by="sup",
             conds=[{"type": "Complete", "status": "True"}], completion="2026-01-02T00:05:00Z"),
    ]
    _, body = _get(url + "/exercise/status")
    latest = body["reset_job"]["latest"]
    assert latest["name"] == "new" and latest["state"] == "succeeded"
    assert latest["requested_by"] == "sup" and latest["finished_at"] == "2026-01-02T00:05:00Z"
    kube["jobs"] = [_job("f", "2026-01-03T00:00:00Z", conds=[{"type": "Failed", "status": "True"}])]
    assert _get(url + "/exercise/status")[1]["reset_job"]["latest"]["state"] == "failed"
    kube["jobs"] = [_job("r", "2026-01-04T00:00:00Z")]  # no active, no completion, no condition
    assert _get(url + "/exercise/status")[1]["reset_job"]["latest"]["state"] == "running"


def test_r9_status_still_answers_when_api_is_down(kapp):
    url, _ = kapp
    kube["list_status"] = 500
    code, body = _get(url + "/exercise/status")
    assert code == 200
    assert body["reset_job"]["available"] is True
    assert body["reset_job"]["latest"] is None and body["reset_job"]["error"]
    assert "adapter" in body and "restart_allowed" in body

def test_r10_status_reports_reset_mode(kapp, monkeypatch):
    url, _ = kapp
    monkeypatch.delenv("EXERCISE_RESET_MODE", raising=False)
    assert _get(url + "/exercise/status")[1]["reset_job"]["mode"] == "full"
    monkeypatch.setenv("EXERCISE_RESET_MODE", "quick")
    assert _get(url + "/exercise/status")[1]["reset_job"]["mode"] == "quick"
    monkeypatch.setenv("EXERCISE_RESET_MODE", "bogus")
    assert _get(url + "/exercise/status")[1]["reset_job"]["mode"] == "full"


def test_r10_concurrent_resets_create_exactly_one_job(kapp):
    url, _ = kapp
    kube["post_delay"] = 0.5
    out = []
    ts = [threading.Thread(target=lambda: out.append(
        _post(url + "/exercise/op/reset", subject="s", timeout=10))) for _ in range(2)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    assert len(kube["posts"]) == 1
    assert sorted(c for c, _ in out) == [202, 409]
    assert [c["path"] for c in state["adapter_calls"]] == ["/pause"]


def test_r11_reset_is_never_an_adapter_op(tmp_path):
    cfg = {"name": "x", "endpoint": "http://e", "operations": {"reset": {"method": "POST", "path": "/r"}}}
    with pytest.raises(control.AdapterConfigError, match="reset"):
        control.load_adapter_config(_write(tmp_path, cfg))


@pytest.mark.parametrize("mutate", [
    lambda t: t.update(kind="Pod"),
    lambda t: t["metadata"]["labels"].pop("app.kubernetes.io/component"),
    lambda t: t["metadata"]["labels"].update({"app.kubernetes.io/component": "other"}),
    lambda t: t["metadata"]["labels"].pop("app.kubernetes.io/instance"),
    lambda t: t["spec"]["template"]["spec"]["containers"][0].update(env=[{"name": "OTHER", "value": "x"}]),
    lambda t: t["spec"]["template"]["spec"]["containers"][0].pop("env"),
])
def test_r12_template_validation_refuses(tmp_path, mutate):
    import copy
    tpl = copy.deepcopy(TEMPLATE)
    mutate(tpl)
    f = tmp_path / "job.json"
    f.write_text(json.dumps(tpl))
    with pytest.raises(control.AdapterConfigError):
        control.ResetJobLauncher(f, sa_dir=tmp_path)


def test_r12_template_missing_or_not_json_or_not_object_refuses(tmp_path):
    with pytest.raises(control.AdapterConfigError):
        control.ResetJobLauncher(tmp_path / "absent.json", sa_dir=tmp_path)
    for text in ["{nope", "[]"]:
        f = tmp_path / "bad.json"
        f.write_text(text)
        with pytest.raises(control.AdapterConfigError):
            control.ResetJobLauncher(f, sa_dir=tmp_path)


def test_r13_main_refuses_on_bad_template(monkeypatch, tmp_path):
    f = tmp_path / "job.json"
    f.write_text("{}")
    a = tmp_path / "adapter.json"
    a.write_text(json.dumps({"name": "x", "endpoint": "http://e", "operations": {"pause": {"method": "POST", "path": "/p"}}}))
    monkeypatch.setenv("EXERCISE_ADAPTER_FILE", str(a))
    monkeypatch.setenv("EXERCISE_RESET_JOB_FILE", str(f))
    assert control.main() == 1


# =============================================================================
# Op step lists
# =============================================================================

def _cfg(ops):
    return {"name": "x", "endpoint": "http://e", "operations": ops}


def test_list_op_loads_as_ordered_steps(tmp_path):
    ops = {"restart": [{"method": "post", "path": "/a"},
                       {"method": "put", "path": "/b", "body": {"k": 1}}]}
    out = control.load_adapter_config(_write(tmp_path, _cfg(ops)))
    assert out["operations"]["restart"] == [
        {"method": "POST", "path": "/a", "body": {}},
        {"method": "PUT", "path": "/b", "body": {"k": 1}},
    ]


def test_empty_list_op_refuses(tmp_path):
    with pytest.raises(control.AdapterConfigError, match="restart"):
        control.load_adapter_config(_write(tmp_path, _cfg({"restart": []})))


def test_non_object_list_element_refuses(tmp_path):
    ops = {"restart": [{"method": "POST", "path": "/a"}, "nope"]}
    with pytest.raises(control.AdapterConfigError, match=r"restart\[1\]"):
        control.load_adapter_config(_write(tmp_path, _cfg(ops)))


def test_list_element_missing_path_names_the_step(tmp_path):
    ops = {"restart": [{"method": "POST", "path": "/a"}, {"method": "POST"}]}
    with pytest.raises(control.AdapterConfigError, match=r"operations\.restart\[1\] is missing 'path'"):
        control.load_adapter_config(_write(tmp_path, _cfg(ops)))


def _list_app(tmp_path, ops):
    adapter_srv = _serve(FakeAdapter)
    metrics_srv = _serve(FakeMetrics)
    state.update(adapter_calls=[], adapter_status=200, adapter_delay=0.0, status_by_path={},
                 metrics_text='dis_pdus_received_total{pdu_type="1"} 1\n')
    cfg = {"name": "stand-in", "endpoint": f"http://127.0.0.1:{adapter_srv.server_port}",
           "operations": ops}
    adapter = control.load_adapter_config(_write(tmp_path, cfg))
    store = control.RateStore(sources=[f"http://127.0.0.1:{metrics_srv.server_port}/metrics"],
                               window=30.0, min_rate=0.1)
    record = tmp_path / "record.json"
    app_state = control.AppState(adapter=adapter, store=store, reset_record_file=str(record))
    handler_srv = _serve(control.make_handler(app_state))
    return f"http://127.0.0.1:{handler_srv.server_port}", record, app_state, \
        (adapter_srv, metrics_srv, handler_srv)


def test_list_op_runs_in_order(tmp_path):
    url, _record, _app, srvs = _list_app(tmp_path, {"pause": [
        {"method": "POST", "path": "/a"}, {"method": "POST", "path": "/b"},
        {"method": "POST", "path": "/c"}]})
    try:
        code, body = _post(url + "/exercise/op/pause", subject="s")
    finally:
        for sv in srvs:
            sv.shutdown()
    assert code == 200 and body["status"] == 200 and body["error"] is None
    assert [c["path"] for c in state["adapter_calls"]] == ["/a", "/b", "/c"]
    assert [(st["path"], st["status"]) for st in body["steps"]] == [
        ("/a", 200), ("/b", 200), ("/c", 200)]


def test_list_op_halts_at_first_failing_step(tmp_path):
    url, _record, app_state, srvs = _list_app(tmp_path, {"pause": [
        {"method": "POST", "path": "/a"}, {"method": "POST", "path": "/b"}]})
    try:
        state["status_by_path"] = {"/a": 404}
        code, body = _post(url + "/exercise/op/pause", subject="s")
    finally:
        for sv in srvs:
            sv.shutdown()
    assert code == 200 and body["status"] == 404
    assert [c["path"] for c in state["adapter_calls"]] == ["/a"]
    assert len(body["steps"]) == 1 and body["steps"][0]["status"] == 404
    assert app_state.get_last_command()["status"] == 404


def test_restart_list_uses_the_zero_only_when_every_step_succeeds(tmp_path):
    url, record, app_state, srvs = _list_app(tmp_path, {"restart": [
        {"method": "POST", "path": "/r1"}, {"method": "POST", "path": "/r2"}]})
    try:
        _zero(record)
        state["status_by_path"] = {"/r2": 503}
        code, body = _post(url + "/exercise/op/restart", subject="s")
        assert code == 200 and body["status"] == 503 and len(body["steps"]) == 2
        assert app_state.restart_refusal()[0] is None  # zero still unused
        state["status_by_path"] = {}
        code, body = _post(url + "/exercise/op/restart", subject="s")
        assert code == 200 and body["status"] == 200
        assert app_state.restart_refusal()[0] is not None  # now used
    finally:
        for sv in srvs:
            sv.shutdown()


# =============================================================================
# Pause-first reset
# =============================================================================

def test_reset_pause_503_refuses_and_creates_no_job(kapp):
    url, app_state = kapp
    state["status_by_path"] = {"/pause": 503}
    code, body = _post(url + "/exercise/op/reset", subject="s")
    assert code == 502 and body["reason"] == "pause_failed"
    assert body["pause"]["status"] == 503
    assert kube["posts"] == []
    last = app_state.get_last_command()
    assert last["op"] == "pause" and last["via"] == "reset" and last["status"] == 503


def test_reset_pause_unreachable_refuses_and_creates_no_job(kapp):
    url, app_state = kapp
    dead = _serve(FakeAdapter)
    port = dead.server_port
    dead.shutdown()
    app_state.adapter["endpoint"] = f"http://127.0.0.1:{port}"
    code, body = _post(url + "/exercise/op/reset", subject="s", timeout=15)
    assert code == 502 and body["reason"] == "pause_failed"
    assert body["pause"]["status"] is None and body["pause"]["error"]
    assert kube["posts"] == []


def test_reset_while_running_sends_no_adapter_call(kapp):
    url, _ = kapp
    kube["jobs"].append(_job("rel-exercise-reset-old", "2026-01-01T00:00:00Z", active=1))
    code, body = _post(url + "/exercise/op/reset", subject="s")
    assert code == 409 and body["reason"] == "reset_running"
    assert state["adapter_calls"] == []
    assert kube["posts"] == []


def test_reset_invalid_subject_sends_no_adapter_call(kapp):
    url, _ = kapp
    code, body = _post(url + "/exercise/op/reset", subject="has space")
    assert code == 400 and body == {"error": "invalid subject"}
    assert state["adapter_calls"] == []
    assert kube["gets"] == [] and kube["posts"] == []


def test_reset_without_a_pause_op_still_runs(kapp):
    url, app_state = kapp
    app_state.adapter["operations"] = {
        "resume": [{"method": "POST", "path": "/resume", "body": {}}]}
    code, body = _post(url + "/exercise/op/reset", subject="s")
    assert code == 202 and body["pause"] is None
    assert state["adapter_calls"] == []
    assert len(kube["posts"]) == 1
    assert app_state.get_last_command()["pause"] is None


# =============================================================================
# named exercise sequences
# =============================================================================

def _seq_file(tmp_path, obj):
    p = tmp_path / "sequences.json"
    p.write_text(json.dumps(obj), encoding="utf-8")
    return p


GOOD_SEQ = {"label": "Cut and heal", "description": "cut, wait, heal",
            "steps": [{"method": "post", "url": "http://127.0.0.1:9/a", "body": {"x": 1}},
                      {"wait_s": 5}]}


def test_s1_valid_sequences_load(tmp_path):
    out = control.load_sequences(_seq_file(tmp_path, {"cutheal": GOOD_SEQ}))
    seq = out["cutheal"]
    assert seq["label"] == "Cut and heal" and seq["description"] == "cut, wait, heal"
    assert seq["steps"][0]["method"] == "POST" and seq["steps"][0]["body"] == {"x": 1}
    assert seq["steps"][1] == {"wait_s": 5}


def test_s1_empty_object_unset_and_empty_path_mean_no_sequences(tmp_path):
    assert control.load_sequences(_seq_file(tmp_path, {})) == {}
    (tmp_path / "e.json").write_text("{}")
    assert control.load_sequences(str(tmp_path / "e.json")) == {}
    assert control.load_sequences(None) == {}
    assert control.load_sequences("") == {}


def _bad(seq):
    return {"cutheal": {"label": "L", "steps": seq}}


def _step(**kw):
    s = {"method": "POST", "url": "http://host/x"}
    s.update(kw)
    return s


@pytest.mark.parametrize("doc,needle", [
    ({"Bad": GOOD_SEQ}, "Bad"),
    ({"has1": GOOD_SEQ}, "has1"),
    ({"a" * 33: GOOD_SEQ}, "name"),
    ({"pause": GOOD_SEQ}, "pause"),
    ({"reset": GOOD_SEQ}, "reset"),
    ({"cutheal": {"label": "", "steps": [_step()]}}, "label"),
    ({"cutheal": {"label": "L", "description": 3, "steps": [_step()]}}, "description"),
    (_bad([]), "steps"),
    (_bad([_step()] * 33), "steps"),
    (_bad([{"wait_s": 0}]), "step 0"),
    (_bad([{"wait_s": 901}]), "step 0"),
    (_bad([{"wait_s": "3"}]), "step 0"),
    (_bad([{"wait_s": True}]), "step 0"),
    (_bad([_step(), {"wait_s": 900}, {"wait_s": 900}, {"wait_s": 10}]), "wait"),
    (_bad([_step(url="https://host/x")]), "step 0"),
    (_bad([_step(), _step(url="ftp://host/x")]), "step 1"),
    (_bad([_step(url="http://user:pw@host/x")]), "step 0"),
    (_bad([_step(url="http://user@host/x")]), "step 0"),
    (_bad([_step(url="http:///x")]), "step 0"),
    (_bad([_step(body=[1])]), "step 0"),
    (_bad([_step(method="")]), "step 0"),
    (_bad([_step(name=5)]), "step 0"),
    (_bad(["x"]), "step 0"),
    ([], "object"),
])
def test_s2_load_sequences_rejections(tmp_path, doc, needle):
    with pytest.raises(control.AdapterConfigError) as ei:
        control.load_sequences(_seq_file(tmp_path, doc))
    assert needle in str(ei.value)
    if needle.startswith("step"):
        assert "cutheal" in str(ei.value)


def test_s2_unreadable_and_malformed_refuse(tmp_path):
    with pytest.raises(control.AdapterConfigError):
        control.load_sequences(tmp_path / "missing.json")
    (tmp_path / "bad.json").write_text("{nope")
    with pytest.raises(control.AdapterConfigError):
        control.load_sequences(tmp_path / "bad.json")


seq_state = {"calls": [], "status_by_path": {}}


class SeqStub(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        body = self.rfile.read(length) if length else b""
        seq_state["calls"].append((self.command, self.path, json.loads(body or b"null")))
        out = b'{"secret": "never stored"}'
        self.send_response(seq_state["status_by_path"].get(self.path, 200))
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    do_PUT = do_POST


def _wait_run(url, want=("completed", "halted"), timeout=10):
    end = time.time() + timeout
    while time.time() < end:
        _, st = _get(url + "/exercise/status")
        if st["sequence"] and st["sequence"]["state"] in want:
            return st["sequence"]
        time.sleep(0.02)
    raise AssertionError("sequence did not finish")


@pytest.fixture
def sapp(tmp_path):
    stub = _serve(SeqStub)
    seq_state.update(calls=[], status_by_path={})
    base = f"http://127.0.0.1:{stub.server_port}"
    seqs = {
        "three": {"label": "Three", "description": "d", "steps": [
            {"method": "POST", "url": base + "/one", "body": {"n": 1}, "name": "first"},
            {"wait_s": 0.05},
            {"method": "PUT", "url": base + "/two", "body": {"n": 2}},
            {"method": "POST", "url": base + "/three", "body": {}},
        ]},
        "slow": {"label": "Slow", "steps": [{"wait_s": 0.6},
                                            {"method": "POST", "url": base + "/after", "body": {}}]},
        "dead": {"label": "Dead", "steps": [{"method": "POST", "url": "http://127.0.0.1:1/x", "body": {}},
                                             {"method": "POST", "url": base + "/never", "body": {}}]},
    }
    cfg = {"name": "stand-in", "endpoint": base,
           "operations": {"pause": {"method": "POST", "path": "/pause", "body": {}}}}
    adapter = control.load_adapter_config(_write(tmp_path, cfg))
    store = control.RateStore(sources=[], window=30.0, min_rate=0.1)
    app_state = control.AppState(adapter=adapter, store=store, reset_record_file=None,
                                 sequences=seqs)
    handler_srv = _serve(control.make_handler(app_state))
    yield f"http://127.0.0.1:{handler_srv.server_port}", app_state, base
    for s in (stub, handler_srv):
        s.shutdown()


def test_s3_sequence_completes_in_order_with_configured_bodies(sapp):
    url, app_state, base = sapp
    code, rec = _post(url + "/exercise/op/three", subject="sup@x")
    assert code == 202
    assert rec["state"] == "running" and rec["finished_at"] is None
    assert rec["op"] == "three" and rec["label"] == "Three" and rec["subject"] == "sup@x"
    assert [s["state"] for s in rec["steps"]] == ["pending"] * 4
    assert [s["kind"] for s in rec["steps"]] == ["call", "wait", "call", "call"]
    final = _wait_run(url)
    assert final["state"] == "completed" and final["finished_at"]
    assert [s["state"] for s in final["steps"]] == ["ok"] * 4
    assert [s["status"] for s in final["steps"] if s["kind"] == "call"] == [200, 200, 200]
    assert final["steps"][0]["name"] == "first"
    assert seq_state["calls"] == [("POST", "/one", {"n": 1}), ("PUT", "/two", {"n": 2}),
                                  ("POST", "/three", {})]
    assert "never stored" not in json.dumps(final)


def test_s3_last_command_is_set_at_start(sapp):
    url, app_state, _ = sapp
    _post(url + "/exercise/op/slow", subject="sup@x")
    _, st = _get(url + "/exercise/status")
    lc = st["last_command"]
    assert lc["op"] == "slow" and lc["status"] == 202 and lc["error"] is None
    assert lc["subject"] == "sup@x" and lc["sequence"] is True and lc["at"]
    _wait_run(url)


def _wan_run(sapp, seqs, op, path_status=None, subject="alice"):
    import unittest
    url, app_state, base = sapp
    app_state.sequences.update(seqs(base))
    seq_state["status_by_path"].update(path_status or {})
    with unittest.TestCase().assertLogs("exercise.control", level="INFO") as cm:
        _post(url + "/exercise/op/" + op, subject=subject)
        _wait_run(url)
    return [m.split(":", 2)[2] for m in cm.output if m.split(":", 2)[2].startswith("WAN ")]


def test_f_cut_and_heal_log_wan_control_as_the_subject(sapp):
    out = _wan_run(sapp, lambda b: {"cutheal": {"label": "c", "steps": [
        {"method": "POST", "url": b + "/proxies/uplink-x", "body": {"enabled": False}},
        {"wait_s": 0},
        {"method": "POST", "url": b + "/proxies/uplink-x", "body": {"enabled": True}}]}},
        "cutheal")
    assert len(out) == 2 and all(m.startswith("WAN CONTROL") for m in out)
    assert out[0].startswith("WAN CONTROL subject=alice proxy=uplink-x enabled=False upstream_status=200 ")
    assert out[1].startswith("WAN CONTROL subject=alice proxy=uplink-x enabled=True upstream_status=200 ")


def test_f_toxics_call_logs_wan_toxics(sapp):
    out = _wan_run(sapp, lambda b: {"tox": {"label": "t", "steps": [
        {"method": "POST", "url": b + "/proxies/uplink-x/toxics", "body": {"type": "latency"}}]}},
        "tox")
    assert len(out) == 1
    assert out[0].startswith("WAN TOXICS subject=alice proxy=uplink-x method=POST upstream_status=200 ")


def test_f_other_calls_log_no_wan_line(sapp):
    out = _wan_run(sapp, lambda b: {"arm": {"label": "a", "steps": [
        {"method": "POST", "url": b + "/posture/arm", "body": {"enabled": True}}]}}, "arm")
    assert out == []


def test_f_halted_run_logs_failed_step_and_not_skipped_one(sapp):
    out = _wan_run(sapp, lambda b: {"h": {"label": "h", "steps": [
        {"method": "POST", "url": b + "/proxies/uplink-x", "body": {"enabled": False}},
        {"method": "POST", "url": b + "/proxies/uplink-x", "body": {"enabled": True}}]}},
        "h", path_status={"/proxies/uplink-x": 500})
    assert len(out) == 1 and "enabled=False upstream_status=500 " in out[0]


def test_f_transport_error_logs_status_none(sapp):
    out = _wan_run(sapp, lambda b: {"d": {"label": "d", "steps": [
        {"method": "POST", "url": "http://127.0.0.1:1/proxies/uplink-x",
         "body": {"enabled": False}}]}}, "d")
    assert len(out) == 1 and "upstream_status=None " in out[0]


def test_s4_a_500_halts_and_later_steps_are_skipped(sapp):
    url, app_state, _ = sapp
    seq_state["status_by_path"]["/two"] = 500
    _post(url + "/exercise/op/three", subject="sup@x")
    final = _wait_run(url)
    assert final["state"] == "halted" and final["finished_at"]
    assert [s["state"] for s in final["steps"]] == ["ok", "ok", "failed", "skipped"]
    assert final["steps"][2]["status"] == 500
    assert [c[1] for c in seq_state["calls"]] == ["/one", "/two"]


def test_s4_transport_error_halts(sapp):
    url, app_state, _ = sapp
    _post(url + "/exercise/op/dead", subject="sup@x")
    final = _wait_run(url)
    assert final["state"] == "halted"
    assert final["steps"][0]["state"] == "failed"
    assert final["steps"][0]["status"] is None and final["steps"][0]["error"]
    assert final["steps"][1]["state"] == "skipped"
    assert seq_state["calls"] == []


def test_s5_second_sequence_while_running_is_409(sapp):
    url, app_state, _ = sapp
    code, _ = _post(url + "/exercise/op/slow", subject="sup@x")
    assert code == 202
    code, body = _post(url + "/exercise/op/three", subject="sup@x")
    assert code == 409
    assert body == {"error": "sequence already running", "reason": "sequence_running",
                    "op": "slow"}
    _wait_run(url)
    assert [c[1] for c in seq_state["calls"]] == ["/after"]  # nothing from 'three'
    code, _ = _post(url + "/exercise/op/three", subject="sup@x")
    assert code == 202
    _wait_run(url)


class _RunningLauncher:
    def latest(self):
        return {"name": "job-1", "state": "running"}


def test_s5_reset_job_running_is_409_before_any_call(sapp):
    url, app_state, _ = sapp
    app_state.reset_launcher = _RunningLauncher()
    code, body = _post(url + "/exercise/op/three", subject="sup@x")
    assert code == 409 and body["reason"] == "reset_running"
    time.sleep(0.2)
    assert seq_state["calls"] == []
    app_state.reset_launcher = None
    _, st = _get(url + "/exercise/status")
    assert st["sequence"] is None and st["last_command"] is None


def test_s6_status_carries_sequences_and_the_run_record(sapp):
    url, app_state, _ = sapp
    _, st = _get(url + "/exercise/status")
    assert st["sequence"] is None
    assert [s["name"] for s in st["sequences"]] == ["dead", "slow", "three"]
    three = st["sequences"][2]
    assert three == {"name": "three", "label": "Three", "description": "d", "steps": 4,
                     "total_wait_s": 0.05}
    assert st["sequences"][1]["description"] == ""
    _post(url + "/exercise/op/three", subject="sup@x")
    final = _wait_run(url)
    _, st = _get(url + "/exercise/status")
    assert st["sequence"] == final


def test_s6_status_without_sequences_has_empty_list(app):
    url, _app, _store = app
    _, st = _get(url + "/exercise/status")
    assert st["sequences"] == [] and st["sequence"] is None


def test_s7_subject_400s_and_no_call(sapp):
    url, app_state, _ = sapp
    code, body = _post(url + "/exercise/op/three")
    assert code == 400 and body["error"] == "missing subject header"
    code, body = _post(url + "/exercise/op/three", subject="bad subject!")
    assert code == 400 and body["error"] == "invalid subject"
    time.sleep(0.2)
    assert seq_state["calls"] == []
    _, st = _get(url + "/exercise/status")
    assert st["sequence"] is None


def test_s8_main_refuses_a_bad_sequences_file(monkeypatch, tmp_path):
    cfg = {"name": "n", "endpoint": "http://127.0.0.1:1",
           "operations": {"pause": {"method": "POST", "path": "/p", "body": {}}}}
    monkeypatch.setenv("EXERCISE_ADAPTER_FILE", str(_write(tmp_path, cfg)))
    monkeypatch.setenv("EXERCISE_SEQUENCES_FILE", str(_seq_file(tmp_path, {"Bad": GOOD_SEQ})))
    monkeypatch.delenv("EXERCISE_RESET_JOB_FILE", raising=False)
    assert control.main() == 1


# =============================================================================
# Reset pre-flight and the confirmed cancel
# =============================================================================

restate = {"counts": {}, "queries": []}


class FakeRestate(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        restate["queries"].append({"path": self.path, "body": json.loads(self.rfile.read(length)),
                                   "accept": self.headers.get("accept"),
                                   "ctype": self.headers.get("content-type")})
        name = self.path.split("/")[1]
        val = restate["counts"].get(name)
        if val == "boom":
            out, code = b"x" * 500, 500
        elif val == "junk":
            out, code = b"not json", 200
        else:
            out, code = json.dumps({"rows": [{"n": val}]}).encode(), 200
        self.send_response(code)
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


@pytest.fixture
def papp(kapp):
    url, app_state = kapp
    srv = _serve(FakeRestate)
    restate.update(counts={}, queries=[])
    base = f"http://127.0.0.1:{srv.server_port}"
    # path prefix carries the synthetic runtime name; the stub routes on it.
    app_state.restate_admin = [("rt-a", base + "/rt-a"), ("rt-b", base + "/rt-b")]
    app_state.reset_max_open = 300
    yield url, app_state
    srv.shutdown()


def _post_body(url, body, subject="sup@x", raw=None):
    data = raw if raw is not None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header(control.SUBJECT_HEADER, subject)
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def _job_env(posted):
    return posted["body"]["spec"]["template"]["spec"]["containers"][0]["env"]


def test_preflight_under_limit(papp):
    url, _ = papp
    restate["counts"] = {"rt-a": 3, "rt-b": 300}
    code, body = _get(url + "/exercise/reset/preflight")
    assert code == 200
    assert body == {"limit": 300, "runtimes": [{"name": "rt-a", "open": 3, "error": None},
                                               {"name": "rt-b", "open": 300, "error": None}],
                    "over": [], "open_over": 0, "needs_confirmation": False, "unreadable": False}
    q = restate["queries"][0]
    assert q["body"] == {"query": "select count(*) as n from sys_invocation where status <> 'completed'"}
    assert q["path"].endswith("/query") and q["accept"] == "application/json"


def test_preflight_over_limit_sums_only_runtimes_over(papp):
    url, _ = papp
    restate["counts"] = {"rt-a": 301, "rt-b": 40}
    _, body = _get(url + "/exercise/reset/preflight")
    assert body["over"] == ["rt-a"] and body["open_over"] == 301
    assert body["needs_confirmation"] is True and body["unreadable"] is False


def test_preflight_one_unreadable_and_error_is_short(papp):
    url, _ = papp
    restate["counts"] = {"rt-a": "boom", "rt-b": 500}
    _, body = _get(url + "/exercise/reset/preflight")
    a, b = body["runtimes"]
    assert a["open"] is None and a["error"] and len(a["error"]) <= 120 and "xxxx" not in a["error"]
    assert b["open"] == 500
    assert body["unreadable"] is True and body["over"] == ["rt-b"]
    assert body["needs_confirmation"] is True and body["open_over"] == 500
    restate["counts"] = {"rt-a": "junk", "rt-b": 1}
    _, body = _get(url + "/exercise/reset/preflight")
    assert body["runtimes"][0]["open"] is None and body["unreadable"] is True


def test_reset_with_confirm_sets_env_and_annotation(papp):
    url, _ = papp
    code, body = _post_body(url + "/exercise/op/reset",
                            {"confirm_cancel_open": True, "seen_open": 412})
    assert code == 202
    posted = kube["posts"][0]
    assert {"name": "RESET_CONFIRM_CANCEL_OPEN", "value": "1"} in _job_env(posted)
    assert posted["body"]["metadata"]["annotations"]["openddil.io/confirmed-open"] == "412"


@pytest.mark.parametrize("body", [None, {}, {"confirm_cancel_open": False, "seen_open": 9}])
def test_reset_without_confirm_is_the_plain_job(papp, body):
    url, _ = papp
    code, _b = _post_body(url + "/exercise/op/reset", body, raw=b"" if body is None else None)
    assert code == 202
    posted = kube["posts"][0]
    assert all(e["name"] != "RESET_CONFIRM_CANCEL_OPEN" for e in _job_env(posted))
    assert "openddil.io/confirmed-open" not in posted["body"]["metadata"]["annotations"]


@pytest.mark.parametrize("raw", [
    b"[1]", b"7", b"not json",
    b'{"confirm_cancel_open": "yes", "seen_open": 1}',
    b'{"confirm_cancel_open": true, "seen_open": -1}',
    b'{"confirm_cancel_open": true, "seen_open": 1.5}',
    b'{"confirm_cancel_open": true, "seen_open": true}',
    b'{"confirm_cancel_open": true, "seen_open": 1, "extra": 1}',
    b'{"confirm_cancel_open": true, "seen_open": 1, "pad": "' + b"a" * 1100 + b'"}',
])
def test_reset_invalid_body_is_400_no_pause_no_job(papp, raw):
    url, app_state = papp
    code, _b = _post_body(url + "/exercise/op/reset", None, raw=raw)
    assert code == 400
    assert kube["posts"] == [] and state["adapter_calls"] == []
    assert app_state.get_last_command() is None


# =============================================================================
# exercise loop -- the step list, end detection, halt rule, record
# =============================================================================

import logging


class FakeClock:
    """Injected clock + sleep: sleeping advances time and runs a script hook, so
    a loop runs to completion in microseconds and signals change on a schedule."""

    def __init__(self):
        self.t = 0.0
        self.hook = lambda t: None

    def now(self):
        return self.t

    def sleep(self, s):
        self.t += s
        self.hook(self.t)


class ListRecorder:
    """Stands in for LoopRecorder; stops the loop after `stop_after` records."""

    def __init__(self, runner_ref, stop_after=1):
        self.records = []
        self.runner_ref = runner_ref
        self.stop_after = stop_after

    def append(self, rec):
        self.records.append(rec)
        if len(self.records) >= self.stop_after:
            self.runner_ref[0].stop()

    def load(self):
        return []


def _loop_cfg(steps, quiet=5.0, fallback=20.0, record_max=50):
    return {"steps": steps, "quiet_s": quiet, "fallback_s": fallback, "record_max": record_max}


@pytest.fixture
def lapp(tmp_path):
    """An app with a fake adapter, a fake kube API and a scripted loop clock."""
    kube.update(jobs=[], posts=[], gets=[], list_status=200, post_status=201, post_delay=0.0)
    state.update(adapter_calls=[], adapter_status=200, status_by_path={}, adapter_delay=0.0)
    kube_srv = _serve(FakeKube)
    sa = tmp_path / "sa"
    sa.mkdir()
    (sa / "token").write_text("tok-1\n")
    (sa / "namespace").write_text("ns1\n")
    tpl = dict(TEMPLATE)
    tpl["spec"] = {**TEMPLATE["spec"], "activeDeadlineSeconds": 10}
    tplf = tmp_path / "job.json"
    tplf.write_text(json.dumps(tpl))
    launcher = control.ResetJobLauncher(tplf, sa_dir=sa,
                                        base_url=f"http://127.0.0.1:{kube_srv.server_port}")
    adapter_srv = _serve(FakeAdapter)
    ops = {n: {"method": "POST", "path": "/" + n, "body": {}} for n in ("pause", "stop", "run")}
    cfg = {"name": "stand-in", "endpoint": f"http://127.0.0.1:{adapter_srv.server_port}",
           "operations": ops}
    adapter = control.load_adapter_config(_write(tmp_path, cfg))
    store = control.RateStore(sources=[], window=30.0, min_rate=0.1)
    app_state = control.AppState(adapter=adapter, store=store, reset_record_file=None,
                                 reset_launcher=launcher)
    clock = FakeClock()
    sig = {"fires": {"f1": 0.0}, "inflight": {"i1": 0.0}}

    def make(steps, recorder=None, **kw):
        runner_ref = [None]
        rec = recorder or ListRecorder(runner_ref)
        runner = control.LoopRunner(app_state, _loop_cfg(steps, **kw),
                                    sampler=lambda: {"fires": dict(sig["fires"]),
                                                     "inflight": dict(sig["inflight"])},
                                    recorder=rec, scrape_interval=1.0, clock=clock.now,
                                    sleep=clock.sleep, reset_poll_s=1.0)
        runner_ref[0] = runner
        app_state.loop = runner
        return runner, rec

    handler_srv = _serve(control.make_handler(app_state))
    yield {"url": f"http://127.0.0.1:{handler_srv.server_port}", "app": app_state,
           "clock": clock, "sig": sig, "make": make}
    for s in (kube_srv, adapter_srv, handler_srv):
        s.shutdown()


AWAIT = [{"await": "scenarioEnd"}]


def _run_sync(runner, subject="sup@x"):
    code, body = runner.start(subject, background=False)
    assert code == 202, body
    return runner.status()


def test_parse_labeled_total_filters_on_label_and_sums():
    text = ('dis_effector_pdus_decoded_total{pdu_type="fire",site="1"} 3\n'
            'dis_effector_pdus_decoded_total{site="2",pdu_type="fire"} 4\n'
            'dis_effector_pdus_decoded_total{pdu_type="detonation"} 99\n'
            'dis_pdus_received_total{pdu_type="2"} 7\n')
    assert control.parse_labeled_total(text, "dis_effector_pdus_decoded_total", "pdu_type", "fire") == 7.0
    assert control.parse_labeled_total(text, "dis_ingress_kind_tracked", "kind", "2") is None
    # the existing rate parse is untouched
    assert control.parse_pdu_total(text) is None


def test_loop_sampler_counts_fires_in_the_sidecar_label_vocabulary():
    # sensor-ingest labels this counter by PDU name (dis_ingestor.py
    # DIS_EFFECTOR_PDUS_DECODED: "fire", "detonation", "resupply_received"),
    # never by the DIS type number; only fires count.
    srv = _serve(FakeMetrics)
    state["metrics_text"] = (
        '# TYPE dis_effector_pdus_decoded_total counter\n'
        'dis_effector_pdus_decoded_total{pdu_type="fire"} 3.0\n'
        'dis_effector_pdus_decoded_created{pdu_type="fire"} 1.7e+09\n'
        'dis_effector_pdus_decoded_total{pdu_type="detonation"} 2.0\n'
        'dis_effector_pdus_decoded_total{pdu_type="resupply_received"} 5.0\n')
    try:
        url = f"http://127.0.0.1:{srv.server_port}/metrics"
        assert control.LoopSampler([url], [])()["fires"] == {url: 3.0}
    finally:
        srv.shutdown()


def test_loop_a_quiet_end_after_fire_with_nothing_in_flight(lapp):
    sig, clock = lapp["sig"], lapp["clock"]

    def script(t):
        if t >= 3:
            sig["fires"]["f1"] = 5.0  # one burst at t=3, then flat
    clock.hook = script
    runner, rec = lapp["make"](AWAIT, quiet=5.0, fallback=60.0)
    _run_sync(runner)
    r = rec.records[0]
    assert (r["end_reason"], r["armed"], r["fires"]) == ("quiet", True, 5)
    assert 8 <= r["steps"][0]["s"] <= 10  # armed at 3 + quiet 5


def test_loop_b_inflight_holds_the_end(lapp):
    sig, clock = lapp["sig"], lapp["clock"]

    def script(t):
        if t >= 2:
            sig["fires"]["f1"] = 1.0
        if 3 <= t < 12:
            sig["inflight"]["i1"] += 1.0  # a counter: rises by one each tick, flat otherwise
    clock.hook = script
    runner, rec = lapp["make"](AWAIT, quiet=5.0, fallback=60.0)
    _run_sync(runner)
    r = rec.records[0]
    assert r["end_reason"] == "quiet"
    assert 16 <= r["steps"][0]["s"] <= 18  # rising until 11, then 5 s quiet


def test_loop_b2_flat_nonzero_inflight_counter_does_not_hold_the_end(lapp):
    sig, clock = lapp["sig"], lapp["clock"]
    sig["inflight"]["i1"] = 500.0  # counter already large from the first tick, never rises

    def script(t):
        if t >= 1:
            sig["fires"]["f1"] = 1.0
    clock.hook = script
    runner, rec = lapp["make"](AWAIT, quiet=5.0, fallback=60.0)
    _run_sync(runner)
    r = rec.records[0]
    assert r["end_reason"] == "quiet"
    assert r["steps"][0]["s"] < 20


def test_loop_b3_inflight_counter_decrease_rebaselines(lapp):
    sig, clock = lapp["sig"], lapp["clock"]
    sig["inflight"]["i1"] = 500.0

    def script(t):
        if t >= 1:
            sig["fires"]["f1"] = 1.0
        if t >= 3:
            sig["inflight"]["i1"] = 3.0  # counter reset (pod restart): not a rise
    clock.hook = script
    runner, rec = lapp["make"](AWAIT, quiet=5.0, fallback=60.0)
    _run_sync(runner)
    r = rec.records[0]
    assert r["end_reason"] == "quiet"
    assert r["steps"][0]["s"] < 20


def test_loop_b4_status_inflight_is_the_per_tick_rise(lapp):
    sig, clock = lapp["sig"], lapp["clock"]
    sig["inflight"]["i1"] = 10.0
    runner, rec = lapp["make"](AWAIT, quiet=5.0, fallback=60.0)
    seen = {}

    def script(t):
        if t == 5:
            sig["inflight"]["i1"] = 12.0
        if t == 7:
            sig["inflight"]["i1"] = None
        if t in (4, 6, 8):
            seen[t] = runner.status()["loop"]["await"]["inflight"]
        if t == 9:
            runner.stop()
    clock.hook = script
    _run_sync(runner)
    assert seen[4] == 0.0
    assert seen[6] == 2.0
    assert seen[8] is None


def test_loop_c_unknown_tick_restarts_quiet(lapp):
    sig, clock = lapp["sig"], lapp["clock"]

    def script(t):
        if t >= 2:
            sig["fires"]["f1"] = 1.0
        sig["inflight"]["i1"] = None if t == 6 else 0.0  # one failed scrape
    clock.hook = script
    runner, rec = lapp["make"](AWAIT, quiet=5.0, fallback=60.0)
    _run_sync(runner)
    r = rec.records[0]
    assert r["end_reason"] == "quiet"
    assert r["steps"][0]["s"] >= 11  # without the unknown tick it would end at 7


def test_loop_d_fallback_while_armed_and_while_never_armed(lapp):
    sig, clock = lapp["sig"], lapp["clock"]

    def busy(t):
        sig["fires"]["f1"] = t  # a fire on every tick, forever
    clock.hook = busy
    runner, rec = lapp["make"](AWAIT, quiet=5.0, fallback=20.0)
    _run_sync(runner)
    r = rec.records[0]
    assert (r["end_reason"], r["armed"]) == ("fallback", True)
    assert 20 <= r["steps"][0]["s"] <= 21

    clock.hook = lambda t: None
    clock.t = 0.0
    sig["fires"]["f1"] = 0.0
    runner, rec = lapp["make"](AWAIT, quiet=5.0, fallback=20.0)
    _run_sync(runner)
    r = rec.records[0]
    assert (r["end_reason"], r["armed"], r["fires"]) == ("fallback", False, 0)


def test_loop_e_counter_decrease_rebaselines_without_a_fire(lapp):
    sig, clock = lapp["sig"], lapp["clock"]
    sig["fires"]["f1"] = 100.0

    def script(t):
        if t >= 2:
            sig["fires"]["f1"] = 5.0  # the source restarted
    clock.hook = script
    runner, rec = lapp["make"](AWAIT, quiet=5.0, fallback=20.0)
    _run_sync(runner)
    r = rec.records[0]
    assert (r["end_reason"], r["armed"], r["fires"]) == ("fallback", False, 0)

    # the new baseline is live: a rise after the decrease does count
    clock.t = 0.0
    sig["fires"]["f1"] = 100.0

    def script2(t):
        sig["fires"]["f1"] = 5.0 if t < 6 else 9.0
    clock.hook = script2
    runner, rec = lapp["make"](AWAIT, quiet=5.0, fallback=40.0)
    _run_sync(runner)
    r = rec.records[0]
    assert (r["end_reason"], r["armed"], r["fires"]) == ("quiet", True, 4)


def test_loop_f_reset_pause_failure_halts_naming_cycle_and_step(lapp):
    state["status_by_path"]["/pause"] = 503
    runner, rec = lapp["make"]([{"op": "stop"}, {"reset": "quick"}, {"op": "run"}])
    st = _run_sync(runner)["loop"]
    assert st["state"] == "halted"
    assert st["halt"] == {"cycle": 1, "step_index": 1, "step": "reset:quick",
                          "detail": "pause failed"}
    assert kube["posts"] == []  # no Job created
    assert "/run" not in [c["path"] for c in state["adapter_calls"]]  # later steps never run
    assert rec.records[0]["outcome"] == "halted"


def test_loop_g_failed_reset_job_halts_and_names_the_job(lapp):
    clock = lapp["clock"]

    def script(t):
        if kube["jobs"] and t >= 3:
            kube["jobs"][-1]["status"]["conditions"] = [{"type": "Failed", "status": "True"}]
    clock.hook = script
    runner, rec = lapp["make"]([{"reset": "quick"}, {"op": "run"}])
    st = _run_sync(runner)["loop"]
    assert st["state"] == "halted"
    assert st["halt"]["detail"] == "reset job failed"
    assert rec.records[0]["reset_job"] == "rel-exercise-reset-1"
    assert "/run" not in [c["path"] for c in state["adapter_calls"]]


def test_loop_g_reset_job_that_never_finishes_times_out(lapp):
    runner, rec = lapp["make"]([{"reset": "quick"}])
    st = _run_sync(runner)["loop"]  # job stays active; deadline 10 s + 120 s
    assert st["state"] == "halted"
    assert st["halt"]["detail"] == "reset job timeout"
    assert 130 <= lapp["clock"].t <= 140


def test_loop_h_stop_during_await_ends_at_once(lapp):
    clock = lapp["clock"]
    runner, rec = lapp["make"](AWAIT + [{"op": "stop"}], quiet=5.0, fallback=600.0)
    clock.hook = lambda t: runner.stop() if t >= 3 else None
    st = _run_sync(runner)["loop"]
    assert st["state"] == "stopped"
    assert clock.t < 5
    assert rec.records[0]["outcome"] == "stopped"
    assert state["adapter_calls"] == []


def test_loop_h_stop_during_reset_waits_for_the_job_and_cancels_nothing(lapp):
    clock = lapp["clock"]
    seen = {}

    def script(t):
        if t == 2:
            lapp["app"].loop.stop()
            seen["state"] = lapp["app"].loop.status()["loop"]["state"]
        if t >= 5 and kube["jobs"]:
            kube["jobs"][-1]["status"]["conditions"] = [{"type": "Complete", "status": "True"}]
    clock.hook = script
    runner, rec = lapp["make"]([{"reset": "quick"}, {"op": "run"}])
    st = _run_sync(runner)["loop"]
    assert seen["state"] == "stopping"
    assert st["state"] == "stopped"
    assert clock.t >= 5  # it waited for the Job
    assert len(kube["posts"]) == 1
    assert "/run" not in [c["path"] for c in state["adapter_calls"]]  # ends after the step
    assert rec.records[0]["outcome"] == "stopped"


def test_loop_i_other_work_is_refused_while_running_and_loop_while_other_work(lapp):
    url, app_state = lapp["url"], lapp["app"]
    runner = control.LoopRunner(app_state, _loop_cfg(AWAIT, quiet=5.0, fallback=600.0),
                                sampler=lambda: {"fires": {}, "inflight": {}},
                                recorder=ListRecorder([None], stop_after=10 ** 9),
                                scrape_interval=0.05)
    app_state.loop = runner
    app_state.sequences = {"cut": {"label": "c", "steps": [{"wait_s": 1}]}}
    # loop refused while a reset is running
    kube["jobs"] = [_job("rel-exercise-reset-0", "2026-01-01T00:00:00Z", active=1)]
    code, body = _post(url + "/exercise/op/loop", subject="sup@x")
    assert code == 409
    kube["jobs"] = []
    # ... and while a sequence is running
    app_state.sequence_run = {"op": "cut", "state": "running"}
    code, body = _post(url + "/exercise/op/loop", subject="sup@x")
    assert code == 409
    app_state.sequence_run = None

    code, body = _post(url + "/exercise/op/loop", subject="sup@x")
    assert (code, body) == (202, {"loop": "started", "cycle": 1})
    try:
        for op in ("pause", "reset", "cut"):
            code, body = _post(url + "/exercise/op/" + op, subject="sup@x")
            assert (code, body) == (409, {"refused": "loop running", "cycle": 1}), op
        code, body = _post(url + "/exercise/op/loop", subject="sup@x")
        assert code == 409
        assert state["adapter_calls"] == [] and kube["posts"] == []
        code, body = _post(url + "/exercise/op/loopstop", subject="sup@x")
        assert (code, body) == (202, {"loop": "stopping"})
    finally:
        runner.stop()
    deadline = time.time() + 2
    while runner.status()["loop"]["state"] != "stopped" and time.time() < deadline:
        time.sleep(0.02)
    assert runner.status()["loop"]["state"] == "stopped"
    code, body = _post(url + "/exercise/op/loopstop", subject="sup@x")
    assert code == 409  # nothing running now


def test_loop_i_start_when_not_configured_is_409(app):
    url, _app_state, _store = app
    code, body = _post(url + "/exercise/op/loop", subject="sup@x")
    assert code == 409
    assert body["error"] == "loop not configured"
    code, body = _post(url + "/exercise/op/loopstop", subject="sup@x")
    assert code == 409


def _loop_file(tmp_path, steps, **extra):
    p = tmp_path / "loop.json"
    p.write_text(json.dumps({"steps": steps, **extra}))
    return p


def _plain_adapter(tmp_path, ops=("pause", "stop", "run")):
    cfg = {"name": "x", "endpoint": "http://127.0.0.1:1",
           "operations": {n: {"method": "POST", "path": "/" + n, "body": {}} for n in ops}}
    return control.load_adapter_config(_write(tmp_path, cfg))


def test_loop_j_reserved_names_and_bad_steps_are_refused_at_startup(tmp_path):
    adapter = _plain_adapter(tmp_path)
    good = [{"await": "scenarioEnd"}, {"op": "stop"}, {"reset": "quick"}, {"op": "run"}]
    cfg = control.load_loop_config(_loop_file(tmp_path, good), adapter, {}, has_reset=True)
    assert cfg["steps"] == good
    assert (cfg["quiet_s"], cfg["fallback_s"], cfg["record_max"]) == (120.0, 720.0, 50)

    seq = {"label": "l", "steps": [{"wait_s": 1}]}
    for name in ("loop", "loopstop"):
        with pytest.raises(control.AdapterConfigError):
            control.load_loop_config(_loop_file(tmp_path, good), adapter, {name: seq}, True)
        bad_adapter = dict(adapter, operations={**adapter["operations"], name: []})
        with pytest.raises(control.AdapterConfigError):
            control.load_loop_config(_loop_file(tmp_path, good), bad_adapter, {}, True)

    for steps in ([{"sleep": 3}], [{"op": "nope"}], [{"reset": "slow"}], [{"await": "x"}],
                  [{"op": "stop", "wait_s": 1}], [], [{"op": "restart"}]):
        with pytest.raises(control.AdapterConfigError):
            control.load_loop_config(_loop_file(tmp_path, steps), adapter, {}, True)
    with pytest.raises(control.AdapterConfigError):  # reset step with no reset Job configured
        control.load_loop_config(_loop_file(tmp_path, good), adapter, {}, has_reset=False)
    # absent file: not configured, not an error
    assert control.load_loop_config(None, adapter, {}, True) is None
    assert control.load_loop_config("", adapter, {}, True) is None


def test_loop_k_status_shape(lapp):
    url = lapp["url"]
    code, body = _get(url + "/exercise/status")
    lp = body["loop"]
    assert lp["configured"] is False and lp["state"] == "idle" and lp["await"] is None
    assert lp["last_cycle"] is None and lp["halt"] is None

    steps = [{"await": "scenarioEnd"}, {"op": "stop"}]
    runner, rec = lapp["make"](steps, quiet=5.0, fallback=20.0)
    seen = {}

    def script(t):
        if t == 4:
            seen["loop"] = _get(url + "/exercise/status")[1]["loop"]
            runner.stop()
    lapp["clock"].hook = script
    _run_sync(runner)
    lp = seen["loop"]
    assert set(lp) >= {"configured", "state", "cycle", "step_index", "step", "steps", "started_at",
                       "step_started_at", "started_by", "await", "last_cycle", "halt",
                       "record_error", "quiet_s", "fallback_s"}
    assert (lp["quiet_s"], lp["fallback_s"]) == (5.0, 20.0)
    assert (lp["configured"], lp["cycle"], lp["step_index"], lp["step"]) == \
        (True, 1, 0, "await:scenarioEnd")
    assert lp["state"] in ("running", "stopping")
    assert lp["steps"] == steps and lp["started_by"] == "sup@x"
    aw = lp["await"]
    assert set(aw) == {"armed", "fires_this_await", "inflight", "quiet_s", "quiet_needed_s",
                       "fallback_s", "fallback_remaining_s", "unknown_sources"}
    assert aw["quiet_needed_s"] == 5 and aw["fallback_s"] == 20
    assert 15 <= aw["fallback_remaining_s"] <= 17 and aw["armed"] is False
    assert runner.status()["loop"]["last_cycle"]["outcome"] == "stopped"


def test_loop_k_status_names_failing_source(lapp):
    lapp["sig"]["fires"]["f1"] = None
    runner, rec = lapp["make"](AWAIT, quiet=5.0, fallback=20.0)
    seen = {}

    def script(t):
        if t == 3:
            seen["aw"] = runner.status()["loop"]["await"]
            runner.stop()
    lapp["clock"].hook = script
    _run_sync(runner)
    assert seen["aw"]["unknown_sources"] == ["f1"]


class KubeCM(BaseHTTPRequestHandler):
    """A fake ConfigMap endpoint: GET returns the stored object, PATCH merges data."""

    def log_message(self, *a):
        pass

    def _reply(self, code, obj):
        out = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def do_GET(self):
        self._reply(200, {"metadata": {"name": "rel-exercise-loop-record"},
                          "data": dict(cm["data"])})

    def do_PATCH(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        body = json.loads(self.rfile.read(length))
        cm["patches"].append({"path": self.path, "ctype": self.headers.get("Content-Type"),
                              "body": body})
        if cm["fail"]:
            self._reply(500, {"message": "boom"})
            return
        cm["data"].update(body["data"])
        self._reply(200, {})


cm = {"data": {}, "patches": [], "fail": False}


@pytest.fixture
def cmkube(tmp_path):
    cm.update(data={}, patches=[], fail=False)
    srv = _serve(KubeCM)
    sa = tmp_path / "sa2"
    sa.mkdir()
    (sa / "token").write_text("tok\n")
    (sa / "namespace").write_text("ns1\n")
    yield lambda: control.KubeApi(sa_dir=sa, base_url=f"http://127.0.0.1:{srv.server_port}")
    srv.shutdown()


def _stop_after_recorder(kubeapi, record_max, runner_ref, stop_after):
    class StopAfterRecorder(control.LoopRecorder):
        n = 0

        def append(self, rec):
            try:
                super().append(rec)
            finally:
                self.n += 1
                if self.n >= stop_after:
                    runner_ref[0].stop()
    return StopAfterRecorder(kubeapi, "rel-exercise-loop-record", record_max)


def test_loop_l_one_log_line_and_one_patch_per_cycle_bounded(lapp, cmkube, caplog):
    ref = [None]
    recorder = _stop_after_recorder(cmkube(), 2, ref, 3)
    runner, _ = lapp["make"]([{"wait_s": 1}], recorder=recorder)
    ref[0] = runner
    with caplog.at_level(logging.INFO, logger="exercise.control"):
        _run_sync(runner)
    lines = [json.loads(r.getMessage()) for r in caplog.records
             if '"exercise_loop_cycle"' in r.getMessage()]
    assert [l["cycle"] for l in lines] == [1, 2, 3]
    assert set(lines[0]) >= {"event", "cycle", "started_at", "ended_at", "end_reason", "armed",
                             "fires", "outcome", "steps", "reset_job", "started_by"}
    assert set(lines[0]["steps"][0]) == {"step", "ok", "started_at", "s", "detail"}
    assert len(cm["patches"]) == 3
    assert cm["patches"][0]["path"] == "/api/v1/namespaces/ns1/configmaps/rel-exercise-loop-record"
    assert cm["patches"][0]["ctype"] == "application/merge-patch+json"
    stored = json.loads(cm["data"]["cycles.json"])
    assert [c["cycle"] for c in stored] == [2, 3]  # bounded to recordMax, newest last


def test_loop_l_patch_failure_does_not_halt_the_loop(lapp, cmkube):
    cm["fail"] = True
    ref = [None]
    recorder = _stop_after_recorder(cmkube(), 5, ref, 2)
    runner, _ = lapp["make"]([{"wait_s": 1}], recorder=recorder)
    ref[0] = runner
    st = _run_sync(runner)["loop"]
    assert st["state"] == "stopped" and st["halt"] is None
    assert st["last_cycle"]["cycle"] == 2
    assert "kube api" in st["record_error"]
