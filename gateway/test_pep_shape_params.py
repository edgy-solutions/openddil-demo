"""Electric's `log` and `subset__*` parameters pass through the PEP as a
validated allowlist: they narrow a shape and never widen it, provided each is
checked by name and type and anything else is refused.

Drives the REAL handler against a stub Topaz and a stub Electric that RECORDS
the upstream query string, the way test_pep_handle_binding.py does. A refusal
is asserted by the stub having seen no request at all.

Run:  py -3 -m pytest gateway -q
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

SEEN: list[dict[str, list[str]]] = []


class FakeTopaz(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        json.loads(body["input"])
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

    def do_GET(self):  # noqa: N802
        q = urllib.parse.urlparse(self.path).query
        SEEN.append(urllib.parse.parse_qs(q, keep_blank_values=True))
        out = json.dumps([{"headers": {"control": "up-to-date"}}]).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(out)))
        self.send_header("electric-handle", "h-fixed")
        self.send_header("electric-offset", "0")
        self.end_headers()
        self.wfile.write(out)


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
    pep_srv = _serve(pep.Pep)
    yield pep, f"http://127.0.0.1:{pep_srv.server_port}"
    for s in (pep_srv, topaz, electric):
        s.shutdown()


@pytest.fixture(autouse=True)
def _clear_seen():
    SEEN.clear()
    yield


def _get(base: str, query: str):
    req = urllib.request.Request(f"{base}/v1/shape?{query}")
    req.add_header("X-OpenDDIL-Subject", "op.a")
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def _q(**kv) -> str:
    return urllib.parse.urlencode(kv)


def _policy(pep) -> str:
    return pep.policy_predicate(["ATL"])


MARK = "ZZMARKERZZ"


def _refused(base: str, query: str, name: str):
    status, body = _get(base, query)
    assert status == 400, (query, status)
    assert SEEN == [], "a refused request reached Electric"
    assert name in json.loads(body)["cause"]
    assert MARK not in body.decode()


def test_log_changes_only_and_offset_now_reach_upstream_with_policy_where(pep_module):
    pep, base = pep_module
    assert _get(base, "table=t&log=changes_only&offset=now")[0] == 200
    (up,) = SEEN
    assert up["log"] == ["changes_only"] and up["offset"] == ["now"]
    assert up["where"] == [_policy(pep)]


def test_log_full_passes_and_bad_or_repeated_log_is_refused(pep_module):
    _pep, base = pep_module
    assert _get(base, "table=t&log=full")[0] == 200
    assert SEEN[0]["log"] == ["full"]
    SEEN.clear()
    for q in ("table=t&log=bogus", "table=t&log=", "table=t&log=full&log=full"):
        _refused(base, q, "log")


def test_subset_where_is_composed_with_policy_and_limit_order_by_pass(pep_module):
    pep, base = pep_module
    q = _q(table="t", subset__where="true", subset__limit="1",
           subset__order_by="updated_at DESC")
    assert _get(base, q)[0] == 200
    (up,) = SEEN
    assert up["subset__where"] == [f"(true) AND ({_policy(pep)})"]
    assert up["subset__limit"] == ["1"]
    assert up["subset__order_by"] == ["updated_at DESC"]


def test_subset_where_or_cannot_escape_the_parentheses(pep_module):
    pep, base = pep_module
    assert _get(base, _q(table="t", subset__where="'x' OR 1=1"))[0] == 200
    assert SEEN[0]["subset__where"] == [f"('x' OR 1=1) AND ({_policy(pep)})"]


def test_subset_without_where_gets_the_policy_clause(pep_module):
    pep, base = pep_module
    assert _get(base, "table=t&subset__limit=1")[0] == 200
    assert SEEN[0]["subset__where"] == [_policy(pep)]


def test_role_class_table_passes_subset_where_raw_and_adds_none(pep_module, monkeypatch):
    pep, base = pep_module
    monkeypatch.setattr(pep, "LABELED_TABLES", {"t"})
    monkeypatch.setattr(pep, "ROLE_SERVED_TABLES", {"rt"})
    assert _get(base, _q(table="rt", subset__where="true"))[0] == 200
    assert SEEN[0]["subset__where"] == ["true"] and "where" not in SEEN[0]
    SEEN.clear()
    assert _get(base, "table=rt&subset__limit=2")[0] == 200
    assert "subset__where" not in SEEN[0]


REFUSALS = [
    ("subset__where_expr", _q(table="t", subset__where_expr=MARK)),
    ("subset__order_by_expr", _q(table="t", subset__order_by_expr=MARK)),
    ("subset__bogus", _q(table="t", subset__bogus=MARK)),
    ("subset__limit", "table=t&subset__limit=0"),
    ("subset__limit", "table=t&subset__limit=10001"),
    ("subset__limit", "table=t&subset__limit=-1"),
    ("subset__limit", "table=t&subset__limit=1e3"),
    ("subset__offset", "table=t&subset__offset=-1"),
    ("subset__order_by", _q(table="t", subset__order_by="updated_at; DROP TABLE x")),
    ("subset__order_by", _q(table="t", subset__order_by="(select 1)")),
    ("subset__params", _q(table="t", subset__params="not-json")),
    ("subset__params", _q(table="t", subset__params='{"a":1}')),
    ("subset__params", _q(table="t", subset__params='{"1":{"x":1}}')),
    ("subset__where", _q(table="t", subset__where="x" * 4097)),
    ("subset__limit", "table=t&subset__limit=1&subset__limit=2"),
]


@pytest.mark.parametrize("name,query", REFUSALS)
def test_refusals_are_400_and_never_reach_electric(pep_module, name, query):
    _pep, base = pep_module
    _refused(base, query, name)


def test_valid_subset_params_pass(pep_module):
    _pep, base = pep_module
    q = _q(table="t", subset__offset="5", subset__params='{"1":"a","2":3}')
    assert _get(base, q)[0] == 200
    assert SEEN[0]["subset__params"] == ['{"1":"a","2":3}']
    assert SEEN[0]["subset__offset"] == ["5"]


def test_refusal_names_the_parameter_not_its_value(pep_module):
    _pep, base = pep_module
    status, body = _get(base, _q(table="t", subset__limit=MARK))
    assert status == 400
    assert "subset__limit" in body.decode() and MARK not in body.decode()


def test_unknown_non_subset_param_is_dropped_silently(pep_module):
    _pep, base = pep_module
    assert _get(base, "table=t&expired_handle=abc&cachebuster=1")[0] == 200
    assert "expired_handle" not in SEEN[0] and "cachebuster" not in SEEN[0]


def test_order_by_grammar(pep_module):
    pep, _base = pep_module

    def ok(v):
        return not isinstance(pep.narrowing_params({"subset__order_by": [v]}), str)

    assert ok("a") and ok('"a" asc') and ok("a DESC NULLS LAST, b")
    assert ok("a nulls first")
    assert not ok(",".join("abcdefghi"))          # 9 terms
    assert ok(",".join("abcdefgh"))               # 8 terms
    # Chosen: uppercase identifiers are refused, quoted or not.
    assert not ok("A") and not ok('"A"')
    assert not ok("a desc desc") and not ok("a,") and not ok("")


def test_validator_returns_the_name_of_the_first_refused(pep_module):
    pep, _base = pep_module
    assert pep.narrowing_params({"subset__limit": ["0"]}) == "subset__limit"
    assert pep.narrowing_params({"other": ["x"]}) == []


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))


def test_upstream_shape_carries_compaction_exactly_once(pep_module):
    pep, base = pep_module
    assert _get(base, "table=t&offset=-1")[0] == 200
    (up,) = SEEN
    assert up["experimental_compaction"] == ["true"]


def test_client_compaction_param_is_dropped_and_peps_true_is_sent(pep_module):
    pep, base = pep_module
    assert _get(base, "table=t&offset=-1&experimental_compaction=false")[0] == 200
    (up,) = SEEN
    assert up["experimental_compaction"] == ["true"]


def test_compaction_off_omits_the_param(pep_module, monkeypatch):
    pep, base = pep_module
    monkeypatch.setattr(pep, "ELECTRIC_COMPACTION", False)
    assert _get(base, "table=t&offset=-1")[0] == 200
    (up,) = SEEN
    assert "experimental_compaction" not in up


def test_follow_shape_upstream_carries_compaction(pep_module, monkeypatch):
    pep, _base = pep_module
    pep._follow_shape("t", "true", None, "id")
    assert SEEN and all(u["experimental_compaction"] == ["true"] for u in SEEN)
    SEEN.clear()
    monkeypatch.setattr(pep, "ELECTRIC_COMPACTION", False)
    pep._follow_shape("t", "true", None, "id")
    assert SEEN and all("experimental_compaction" not in u for u in SEEN)
