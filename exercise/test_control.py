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
    assert out["operations"]["pause"] == {"method": "POST", "path": "/pause", "body": {}}


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

state = {"adapter_calls": [], "adapter_status": 200, "adapter_delay": 0.0, "metrics_text": ""}


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
        self.send_response(state["adapter_status"])
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
    state.update(adapter_calls=[], adapter_status=200, adapter_delay=0.0,
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
    state.update(adapter_calls=[], adapter_status=200, adapter_delay=0.0,
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
        kube["posts"].append({"path": self.path, "body": body})
        name = f"rel-exercise-reset-{len(kube['posts'])}"
        kube["jobs"].append(_job(name, f"2026-01-01T00:00:{len(kube['posts']):02d}Z", active=1))
        self._reply(201, {"metadata": {"name": name}})


@pytest.fixture
def kapp(tmp_path):
    kube.update(jobs=[], posts=[], gets=[], list_status=200, post_status=201, post_delay=0.0)
    state.update(adapter_calls=[])
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
    assert posted["path"] == "/apis/batch/v1/namespaces/ns1/jobs"
    env = posted["body"]["spec"]["template"]["spec"]["containers"][0]["env"]
    assert {"name": "RESTART_SUBJECT", "value": "reset-job:sup@x"} in env
    assert posted["body"]["metadata"]["annotations"]["openddil.io/requested-by"] == "sup@x"
    last = app_state.get_last_command()
    assert last["op"] == "reset" and last["status"] == 201 and last["error"] is None
    assert last["job"] == body["job"] and last["subject"] == "sup@x"
    assert state["adapter_calls"] == []  # reset never reaches the adapter
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
def test_r4_api_error_is_502_and_last_command_untouched(kapp, api_status):
    url, app_state = kapp
    kube["post_status"] = api_status
    code, body = _post(url + "/exercise/op/reset", subject="s")
    assert code == 502
    assert body == {"error": "reset job not created", "status": api_status}
    assert app_state.get_last_command() is None
    kube.update(post_status=201, list_status=api_status)
    code, body = _post(url + "/exercise/op/reset", subject="s")
    assert (code, body["status"]) == (502, api_status)
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
    assert body["reset_job"] == {"available": False, "latest": None, "error": None}


def test_r8_status_with_launcher_and_states(kapp):
    url, _ = kapp
    _, body = _get(url + "/exercise/status")
    assert body["reset_job"] == {"available": True, "latest": None, "error": None}
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
