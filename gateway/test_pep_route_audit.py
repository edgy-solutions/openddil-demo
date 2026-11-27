"""Route audit for the PEP (gateway/pep.py): every route is listed, and every
route that can return labelled data is probed with canary strings.

Part 1 is static. It parses pep.py with `ast`, collects the route literals the
dispatch functions compare the request path to, and checks them against the
`ROUTES` registry below. A new route that is not classified here fails
`test_every_route_is_registered`.

Part 2 is behavioural. Each label-filtered route is probed with three canary
kinds: CANARY_BDR (labelled for BDR only), CANARY_UNLABELLED (no label) and
CANARY_ATL (labelled for ATL, the positive control). Assertions read the raw
response bytes. A failing probe is a finding, not a test bug.

Run:  python -m pytest gateway/test_pep_route_audit.py -rA
"""
from __future__ import annotations

import ast
import json
import os
import re
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

GATEWAY = Path(__file__).resolve().parent
PEP_SRC = GATEWAY / "pep.py"

# ---------------------------------------------------------------------------
# Part 1: the static route inventory
# ---------------------------------------------------------------------------

# (class name, function name, default method; None = decided by `method`)
_DISPATCH = [
    ("Pep", "do_GET", "GET"),
    ("Pep", "do_POST", "POST"),
    ("Pep", "do_DELETE", "DELETE"),
    ("Pep", "_handle_auth", "GET"),
    ("Pep", "_handle_egress", "GET"),
    ("Pep", "_handle_reports", "GET"),
    ("Pep", "_handle_exercise", None),
    ("Pep", "_handle_wan_control", None),
    ("MetricsHandler", "do_GET", "GET"),
]
_PATH_EXPRS = {"parsed.path", "path", "self.path.split('?', 1)[0]"}


def _str_consts(body) -> dict:
    out = {}
    for n in body:
        if isinstance(n, ast.Assign) and isinstance(n.value, ast.Constant) \
                and isinstance(n.value.value, str):
            for t in n.targets:
                if isinstance(t, ast.Name):
                    out[t.id] = n.value.value
    return out


def _method_literal(test) -> str | None:
    """`method == "GET"` / `"POST"` anywhere in an if-test, else None."""
    for n in ast.walk(test):
        if (isinstance(n, ast.Compare) and isinstance(n.left, ast.Name)
                and n.left.id == "method" and len(n.ops) == 1
                and isinstance(n.ops[0], ast.Eq)
                and isinstance(n.comparators[0], ast.Constant)):
            return n.comparators[0].value
    return None


def extract_routes() -> dict:
    """{(method, path): {"match": "exact"|"prefix", "server": ...}}."""
    tree = ast.parse(PEP_SRC.read_text(encoding="utf-8"))
    module_consts = _str_consts(tree.body)
    classes = {n.name: n for n in tree.body if isinstance(n, ast.ClassDef)}
    found: dict = {}

    for cls_name, fn_name, default in _DISPATCH:
        fn = next(n for n in classes[cls_name].body
                  if isinstance(n, ast.FunctionDef) and n.name == fn_name)
        consts = dict(module_consts)
        consts.update(_str_consts(list(ast.walk(fn))))  # local `prefix = "..."`
        server = "metrics" if cls_name == "MetricsHandler" else "pep"
        local: list = []  # (method, path, match)

        def lit(node):
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                return node.value
            if isinstance(node, ast.Name):
                return consts.get(node.id)
            return None

        def scan_expr(expr, ctx):
            for n in ast.walk(expr):
                if isinstance(n, ast.Compare):
                    if ast.unparse(n.left) not in _PATH_EXPRS:
                        continue
                    for op, comp in zip(n.ops, n.comparators):
                        if isinstance(op, (ast.Eq, ast.NotEq)):
                            vals = [lit(comp)]
                        elif isinstance(op, (ast.In, ast.NotIn)) \
                                and isinstance(comp, (ast.Tuple, ast.List)):
                            vals = [lit(e) for e in comp.elts]
                        else:
                            continue
                        for v in vals:
                            if v:
                                local.append((ctx, v, "exact"))
                elif (isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
                      and n.func.attr == "startswith"
                      and ast.unparse(n.func.value) in _PATH_EXPRS and n.args):
                    v = lit(n.args[0])
                    if v:
                        local.append((ctx, v, "prefix"))

        def visit(stmts, ctx):
            for s in stmts:
                if isinstance(s, ast.If):
                    m = _method_literal(s.test)
                    scan_expr(s.test, m or ctx)
                    if m == "GET":
                        visit(s.body, "GET")
                        visit(s.orelse, "POST")
                    elif m == "POST":
                        visit(s.body, "POST")
                        visit(s.orelse, "GET")
                    else:
                        visit(s.body, ctx)
                        visit(s.orelse, ctx)
                elif isinstance(s, (ast.For, ast.While, ast.With, ast.Try)):
                    for field in ("body", "orelse", "finalbody"):
                        visit(getattr(s, field, []), ctx)
                    for h in getattr(s, "handlers", []):
                        visit(h.body, ctx)
                else:
                    scan_expr(s, ctx)

        visit(fn.body, default)
        exact = {p for _, p, mt in local if mt == "exact"}
        for m, p, mt in local:
            # A guard such as `not path.startswith("/auth/")` is a proper
            # prefix of the exact routes in the same function: not a route.
            if mt == "prefix" and any(e != p and e.startswith(p) for e in exact):
                continue
            found.setdefault((m or "ANY", p), {"match": mt, "server": server})
    return found


def _r(cls, why, probes=()):
    return {"cls": cls, "why": why, "probes": tuple(probes)}


NRD, LF, DX = "no-record-data", "label-filtered", "declared-exception"

ROUTES = {
    ("GET", "/healthz"): _r(NRD, "fixed body b'ok' (pep.py:5068)"),
    ("GET", "/v1/health"): _r(NRD, "relays Electric's own health document, no store rows (pep.py:5038 _handle_electric_health)"),
    ("GET", "/picture"): _r(
        DX, "machine-to-machine: service-token client picks a destination, upstream body relayed verbatim, no viewer "
            "nations exist on this path (pep.py:5077-5079 dispatch comment; _handle_picture docstring pep.py:4983)",
        ["test_probe_09_picture_relays_body_verbatim"]),
    ("POST", "/picture"): _r(NRD, "405 method-not-allowed answer, fixed body (pep.py:4395)"),
    ("GET", "/auth/login"): _r(NRD, "redirect to the IdP, no store rows (pep.py:4437)"),
    ("GET", "/auth/callback"): _r(NRD, "IdP code exchange, sets the session cookie (pep.py:4465)"),
    ("GET", "/auth/logout"): _r(NRD, "clears the session (pep.py:4549)"),
    ("GET", "/auth/me"): _r(NRD, "the caller's own subject and expiry, not a record (pep.py:4565)"),
    ("GET", "/reports/mine"): _r(
        LF, "ledger rows filtered by egress_view.is_visible in _reports_rows consumers; episodes the viewer filed "
            "are split by reports_view.episode_hidden, a hidden one is listed only as a 'report withheld' entry "
            "(_handle_reports)",
        ["test_probe_03_reports_mine"]),
    ("GET", "/reports/tier"): _r(
        LF, "egress_view.filter_decisions over episodes (pep.py:4690)",
        ["test_probe_03_reports_tier"]),
    ("GET", "/egress/"): _r(
        LF, "dispatch prefix for the two egress routes below (pep.py:5087)",
        ["test_probe_01_egress_decisions", "test_probe_02_egress_cases"]),
    ("GET", "/egress/cases"): _r(
        LF, "asset is_visible then per-action labels; each case is rebuilt from the CASE_KEYS whitelist, with "
            "nested whitelists for disposition and decision (_case_view)",
        ["test_probe_02_egress_cases", "test_probe_02_egress_cases_per_case_whitelist"]),
    ("GET", "/egress/decisions"): _r(
        LF, "egress_view.filter_decisions (pep.py:4843)",
        ["test_probe_01_egress_decisions"]),
    ("GET", "/cm/fault-codes"): _r(
        LF, "read_visible_row(telemetry_latest_state), 404 when invisible (pep.py:2985)",
        ["test_probe_04_cm_fault_codes"]),
    ("GET", "/cm/sources"): _r(
        LF, "four read_visible_row reads (pep.py:3046-3054)",
        ["test_probe_04_cm_sources"]),
    ("GET", "/arrivals"): _r(
        LF, "fielding read composes policy_predicate (pep.py:3518-3520); the undeclared list keeps a labelled "
            "telemetry row only when the viewer's nations may see it. Declared exception: unlabelled undeclared "
            "rows, to declare roles at the owned edge (ADR-0050 s3)",
        ["test_probe_05_arrivals_fielding", "test_probe_05_arrivals_undeclared_list_follows_the_label_rule"]),
    ("GET", "/arrivals/summary"): _r(
        LF, "counts only; fielding uses policy_predicate (pep.py:3593), telemetry is edge-scoped (pep.py:3589)",
        ["test_probe_05_arrivals_summary_counts"]),
    ("GET", "/proxies/"): _r(NRD, "WAN-control relay (proxy state), not a labelled store (pep.py:5102, _handle_wan_control)"),
    ("POST", "/proxies/"): _r(NRD, "WAN-control relay (toxic toggles), not a labelled store (pep.py:4389)"),
    ("GET", "/exercise/"): _r(NRD, "dispatch prefix for the exercise-control relay (pep.py:5105)"),
    ("POST", "/exercise/"): _r(NRD, "dispatch prefix for the exercise-control relay (pep.py:4392)"),
    ("GET", "/exercise/status"): _r(NRD, "exercise-control status relay, no store rows (pep.py:4168)"),
    ("GET", "/exercise/reset/preflight"): _r(NRD, "exercise-control preflight relay (pep.py:4168, EXERCISE_PREFLIGHT_PATH)"),
    ("POST", "/exercise/op/"): _r(NRD, "exercise-control operation relay (pep.py:4173)"),
    ("POST", "/cm/discrepancy"): _r(
        LF, "read_cm_visibility_row before the intake post, 404 when invisible (pep.py:3218)",
        ["test_probe_07_cm_discrepancy"]),
    ("POST", "/cm/discrepancy/resolve"): _r(
        LF, "visibility row read (pep.py:3388) before the intake post",
        ["test_probe_07_cm_discrepancy_resolve"]),
    ("POST", "/manual/ask"): _r(
        LF, "visibility read before the upstream ask (pep.py:3918); the answer text is relayed without a label "
            "filter (pep.py:3954)",
        ["test_probe_08_manual_ask_invisible_asset", "test_probe_08_manual_ask_answer_text"]),
    ("POST", "/arrivals/declare"): _r(
        LF, "expect-confirm fielding read composes policy_predicate (pep.py:3738-3740); refusals are static text",
        ["test_probe_06_arrivals_declare"]),
    ("GET", "/v1/shape"): _r(
        LF, "table_class picks the clause: nation = policy_predicate (pep.py:5178), subject = subject column unless "
            "an oversight role (pep.py:5171-5176), refused = 403 pre-PDP (pep.py:5122); the role class is served "
            "with NO nation predicate by design (policy_clause = None, pep.py:5163-5170)",
        ["test_probe_10_shape_nation_class", "test_probe_10_shape_subject_class",
         "test_probe_10_shape_refused_class"]),
    ("DELETE", "/v1/shape"): _r(
        LF, "only the element table is served (405, pep.py:4337) and only when nation-class (403, pep.py:4341)",
        ["test_probe_10_shape_delete"]),
    ("GET", "/metrics"): _r(NRD, "Prometheus counters from element_metrics_text (pep.py:1065); metrics server, not the PEP port"),
}


def _fmt(routes):
    return ", ".join(f"{m} {p}" for m, p in sorted(routes))


def test_every_route_is_registered():
    """Every route literal the dispatch code compares the path to is classified in ROUTES."""
    missing = sorted(set(extract_routes()) - set(ROUTES))
    assert not missing, (
        f"unregistered routes: {_fmt(missing)}; classify it in ROUTES and give "
        "label-filtered routes a probe")


def test_no_stale_registry_entry():
    """Every ROUTES key is still extracted from pep.py."""
    stale = sorted(set(ROUTES) - set(extract_routes()))
    assert not stale, f"ROUTES entries pep.py no longer has: {_fmt(stale)}"


def test_every_filtered_route_names_existing_probes():
    """Label-filtered and declared-exception routes name probes that exist in this module."""
    here = sys.modules[__name__]
    bad = []
    for key, entry in ROUTES.items():
        assert entry["cls"] in (NRD, LF, DX), key
        assert entry["why"], key
        if entry["cls"] == NRD:
            continue
        if not entry["probes"]:
            bad.append(f"{_fmt([key])}: no probes")
        for name in entry["probes"]:
            if not callable(getattr(here, name, None)):
                bad.append(f"{_fmt([key])}: no test function {name}")
    assert not bad, "; ".join(bad)


# ---------------------------------------------------------------------------
# Part 2: the canary probes
# ---------------------------------------------------------------------------

CANARY_BDR = "CANARY-BDR-7F3A"
CANARY_UNLABELLED = "CANARY-UNL-7F3A"
CANARY_ATL = "CANARY-ATL-7F3A"
CANARIES = {"BDR": CANARY_BDR, "UNL": CANARY_UNLABELLED, "ATL": CANARY_ATL}

VIEWERS = {
    "atl": {"subject": "viewer-atl", "nations": ["ATL"]},
    "all": {"subject": "viewer-all", "nations": ["ATL", "BDR", "CHA"]},
}
SUBJECT_NATIONS = {v["subject"]: v["nations"] for v in VIEWERS.values()}

# Rows are stored the way Electric hands them back: releasable_to as pg text.
LABELS = {
    "BDR": {"originator_nation": "BDR", "releasable_to": "{BDR}"},
    "UNL": {"originator_nation": None, "releasable_to": None},
    "ATL": {"originator_nation": "ATL", "releasable_to": "{ATL}"},
}
# The same labels as an egress record carries them (a real list).
LIST_LABELS = {
    "BDR": {"originator_nation": "BDR", "releasable_to": ["BDR"]},
    "UNL": {"originator_nation": None, "releasable_to": []},
    "ATL": {"originator_nation": "ATL", "releasable_to": ["ATL"]},
}
EDGE = "edge-1"
DMC = "DMC-ODMRAD-A-34-10-01-00A-421A-A"


def forbidden(viewer):
    """Canary kinds this viewer must never receive: the unlabelled one for
    everybody, and BDR's too for the ATL-only viewer."""
    return ["UNL"] if viewer == "all" else ["BDR", "UNL"]


def assert_no_leak(raw: bytes, viewer: str, where: str) -> None:
    for kind in forbidden(viewer):
        assert CANARIES[kind].encode() not in raw, (
            f"{where}: viewer {viewer} received the {kind} canary: {raw[:400]!r}")


def assert_positive(raw: bytes, where: str) -> None:
    assert CANARY_ATL.encode() in raw, (
        f"{where}: the ATL positive control is missing, so this probe may not "
        f"have reached its fake: {raw[:400]!r}")


class State:
    def __init__(self):
        self.reset()

    def reset(self):
        self.nations = ["ATL"]
        self.rows = {}            # table -> [row dict]
        self.pane_decisions = None
        self.pane_cases = {}      # asset_id -> [case dict]
        self.pane_faults = []
        self.qa_reply = None
        self.picture_body = b"{}"
        self.calls = []           # (name, detail)

    def called(self, name):
        return [d for n, d in self.calls if n == name]


S = State()
REAL = None  # captured before any per-test patch: the oracle the leaky store uses


class _Upstream(BaseHTTPRequestHandler):
    """One loopback server standing in for Topaz, the egress pane, the intake
    services, the question service, the picture assembler and Electric."""

    def log_message(self, fmt, *args):
        pass

    def _reply(self, status, obj=None, raw=None, headers=()):
        body = raw if raw is not None else json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        for k, v in headers:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        body = self._body()
        if path == "/topaz/api/v2/authz/query":
            S.calls.append(("topaz", None))
            subject = json.loads(json.loads(body)["input"])["subject"]
            nations = SUBJECT_NATIONS.get(subject, [])
            role = "auditor" if subject == "auditor-1" else "supervisor"
            return self._reply(200, {"response": {"result": [{"bindings": {"x": {
                "allow": bool(nations), "allowed_nations": nations,
                "subject_known": True, "policy_version": "p1",
                "corpus_version": "c1", "role": role}}}]}})
        if path == "/arrivals-intake":
            S.calls.append(("arrivals-intake", json.loads(body)))
            return self._reply(200, {})
        if path == "/cm-intake":
            S.calls.append(("cm-intake", json.loads(body)))
            return self._reply(200, {})
        if path == "/qa":
            S.calls.append(("qa", json.loads(body)))
            return self._reply(200, S.qa_reply)
        self._reply(404, {})

    def do_DELETE(self):
        S.calls.append(("electric-delete", self.path))
        self._reply(200, {})

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
        if parsed.path == "/pane/decisions":
            S.calls.append(("pane-decisions", q))
            return self._reply(200, S.pane_decisions)
        if parsed.path == "/pane/cases":
            S.calls.append(("pane-cases", q))
            return self._reply(200, {"cases": S.pane_cases.get(q["asset_id"][0], [])})
        if parsed.path == "/pane/reports/states":
            S.calls.append(("pane-states", q))
            return self._reply(200, {"faults": S.pane_faults, "unkeyed_ledger": 0})
        if parsed.path == "/pic/picture":
            S.calls.append(("picture", q))
            return self._reply(200, raw=S.picture_body)
        if parsed.path == "/electric/v1/shape":
            S.calls.append(("electric-get", q))
            return self._reply(200, [{"headers": {"control": "up-to-date"}}],
                               headers=[("electric-handle", "h1"),
                                        ("electric-offset", "0_0")])
        self._reply(404, {})


def _leaky_follow_shape(table, where, columns, default_key):
    """THE SEAM. Every Electric read in pep.py (read_visible_row, _reports_rows,
    the arrivals handlers) goes through `_follow_shape(table, where, columns,
    default_key)`, and this replaces it. It is a deliberately leaky store:
    it returns EVERY seeded row of the table that matches the plain
    `col = 'value'` terms of `where`, unless `where` contains the real
    `policy_predicate(viewer nations)` text, in which case it also drops the
    rows `egress_view.is_visible` hides from those nations. A route that
    forgets the predicate therefore gets other nations' and unlabelled rows
    back, and its canary reaches the response. The oracle (REAL) is captured
    before any per-test patch, so patching pep.policy_predicate or
    egress_view.is_visible does not blunt the store."""
    S.calls.append(("read", (table, where)))
    rows = list(S.rows.get(table, []))
    for col, val in re.findall(r"(\w+) = '((?:[^']|'')*)'", where):
        want = val.replace("''", "'")
        rows = [r for r in rows if str(r.get(col)) == want]
    if REAL.policy_predicate(S.nations) in where:
        rows = [r for r in rows if REAL.is_visible(
            {"originator_nation": r.get("originator_nation"),
             "releasable_to": REAL.pg_array(r.get("releasable_to"))}, S.nations)]
    if columns:
        rows = [{c: r.get(c) for c in columns} for r in rows]
    return [dict(r) for r in rows]


@pytest.fixture(scope="module")
def pep_mod():
    mp = pytest.MonkeyPatch()
    mp.setenv("OPENDDIL_ELECTRIC_URL", "http://electric.invalid:9")
    mp.setenv("OPENDDIL_TOPAZ_URL", "http://topaz.invalid:9")
    mp.delenv("OPENDDIL_OIDC_ISSUER", raising=False)
    mp.syspath_prepend(str(GATEWAY))
    previous = sys.modules.pop("pep", None)
    import pep  # noqa: PLC0415 -- must follow the env above
    global REAL
    REAL = type("Real", (), {})()
    REAL.policy_predicate = pep.policy_predicate
    REAL.is_visible = pep.egress_view.is_visible
    REAL.pg_array = pep._pg_array
    REAL.compose = pep.compose
    up = ThreadingHTTPServer(("127.0.0.1", 0), _Upstream)
    pp = ThreadingHTTPServer(("127.0.0.1", 0), pep.Pep)
    for srv in (up, pp):
        threading.Thread(target=srv.serve_forever, daemon=True).start()
    pep.UP_URL = f"http://127.0.0.1:{up.server_port}"
    pep.PEP_URL = f"http://127.0.0.1:{pp.server_port}"
    try:
        yield pep
    finally:
        pp.shutdown()
        up.shutdown()
        pp.server_close()
        up.server_close()
        mp.undo()
        if previous is not None:
            sys.modules["pep"] = previous
        else:
            sys.modules.pop("pep", None)


@pytest.fixture
def rig(pep_mod, monkeypatch, tmp_path):
    pep = pep_mod
    S.reset()
    up = pep.UP_URL
    rel = tmp_path / "releasability.yaml"
    rel.write_text(
        "nations:\n"
        "  ATL: {name: Atlantis, color: \"#112233\"}\n"
        "  BDR: {name: Borderia, color: \"#223344\"}\n"
        "  CHA: {name: Chalcis, color: \"#334455\"}\n"
        "default_originator_nation: null\n"
        "assets: {}\n", encoding="utf-8")
    baselines = tmp_path / "baselines"
    baselines.mkdir()
    for name, value in {
        "AUTH_MODE": "header", "PEP_TIER": "hub", "TOPAZ": up + "/topaz",
        "ELECTRIC": up + "/electric", "EGRESS_PANE": up + "/pane",
        "CM_INTAKE_URL": up + "/cm-intake", "MANUAL_QA_URL": up + "/qa",
        "ARRIVALS_INTAKE_URL": up + "/arrivals-intake",
        "ARRIVALS_EDGES": frozenset({EDGE}),
        "ARRIVALS_UNITS": [{"id": "u1", "name": "Unit One"}],
        "ARRIVALS_OWNING_TIER": "root",
        "RELEASABILITY_FILE": str(rel), "BASELINES_DIRS": str(baselines),
        "FAULT_CATALOG": {"variants": {}},
        "SOURCE_BANDS": {"window_seconds": 300, "variants": {}},
        "LABELED_TABLES": set(), "ROLE_SERVED_TABLES": set(),
        "SUBJECT_SCOPED_TABLES": {}, "PICTURE_URL": up + "/pic",
        "PICTURE_CLIENTS": {"client-a": "dest-a"},
        "_follow_shape": _leaky_follow_shape,
    }.items():
        monkeypatch.setattr(pep, name, value)
    monkeypatch.setattr(pep.oidc, "ISSUER", "https://idp.invalid/realm")
    monkeypatch.setattr(pep.oidc, "enabled", lambda: False)
    monkeypatch.setattr(pep.oidc, "verify_service_token",
                        lambda token, audience=None: {"azp": "client-a"})
    pep._reports_cache.clear()
    yield pep
    pep._reports_cache.clear()


def call(viewer, method, path, body=None, headers=None, rig_pep=None):
    """One request to the PEP as `viewer`. Returns (status, raw response bytes)."""
    import pep as _p  # the module the fixture loaded
    S.nations = list(VIEWERS[viewer]["nations"])
    hdrs = {"X-OpenDDIL-Subject": VIEWERS[viewer]["subject"]}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        hdrs["Content-Type"] = "application/json"
    hdrs.update(headers or {})
    req = urllib.request.Request(_p.PEP_URL + path, data=data, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def trio(table, make):
    """Seed `table` with one row per canary kind, unlabelled first, BDR
    second and ATL last: a store that leaks hands back the first one."""
    for kind in ("UNL", "BDR", "ATL"):
        row = dict(LABELS[kind])
        row.update(make(kind, CANARIES[kind]))
        S.rows.setdefault(table, []).append(row)


viewer_param = pytest.mark.parametrize("viewer", ["atl", "all"])


# --- 1. /egress/decisions ---------------------------------------------------

@viewer_param
def test_probe_01_egress_decisions(rig, viewer):
    """Pane decision records labelled BDR, unlabelled and ATL, each with its canary in `reason`; proves egress_view.filter_decisions."""
    S.pane_decisions = {
        "destination": "dest-1", "policy_version": "p", "corpus_version": "c",
        "records": [dict(LIST_LABELS[k], kind="ActionRecord", key=f"k-{k}",
                         allowed=False, reason=CANARIES[k]) for k in ("UNL", "BDR", "ATL")],
        "admitted": 0, "refused": 3}
    status, raw = call(viewer, "GET", "/egress/decisions?destination=dest-1")
    assert status == 200, raw
    assert_no_leak(raw, viewer, "/egress/decisions")
    assert_positive(raw, "/egress/decisions")


# --- 2. /egress/cases -------------------------------------------------------

def _seed_case_assets():
    for kind in ("UNL", "BDR", "ATL"):
        S.rows.setdefault("asset_cm_state", []).append(dict(
            LABELS[kind], asset_id=f"ast-{kind.lower()}", edge_id=EDGE, region_id=None,
            manual_discrepancies=None))


def _case(kind, **extra):
    return dict({"case_id": f"case-{kind.lower()}", "asset_id": "ast-atl",
                 "disposition": f"disp {CANARIES[kind]}", "decided_at": "2026-01-01T00:00:00Z",
                 "decision": {"allowed": False, "reason": CANARIES[kind]},
                 "disposition_state": "decided",
                 "action_labels": dict(LIST_LABELS[kind])}, **extra)


@viewer_param
def test_probe_02_egress_cases(rig, viewer):
    """Assets labelled BDR/unlabelled/ATL and ATL-asset actions labelled BDR/unlabelled/ATL, canaries in decision.reason; proves the asset is_visible check and the per-action label check."""
    _seed_case_assets()
    for asset in ("ast-unl", "ast-bdr"):
        S.pane_cases[asset] = [_case(k) for k in ("UNL", "BDR", "ATL")]
    S.pane_cases["ast-atl"] = [_case(k) for k in ("UNL", "BDR", "ATL")]
    raws = []
    for asset in ("ast-unl", "ast-bdr", "ast-atl"):
        status, raw = call(viewer, "GET", f"/egress/cases?asset_id={asset}")
        assert status == 200, raw
        assert_no_leak(raw, viewer, f"/egress/cases {asset}")
        raws.append((asset, raw))
    assert_positive(dict(raws)["ast-atl"], "/egress/cases ast-atl")
    if viewer == "atl":
        # A hidden asset reads as no cases and the pane is not asked for it.
        asked = [q["asset_id"][0] for q in S.called("pane-cases")]
        assert asked == ["ast-atl"], asked


@viewer_param
def test_probe_02_egress_cases_per_case_whitelist(rig, viewer):
    """An ATL-visible case with extra keys carrying the BDR and unlabelled canaries; proves only whitelisted keys leave the route."""
    _seed_case_assets()
    S.pane_cases["ast-atl"] = [
        _case("ATL", internal_note=CANARY_BDR, internal_ref=CANARY_UNLABELLED)]
    status, raw = call(viewer, "GET", "/egress/cases?asset_id=ast-atl")
    assert status == 200, raw
    assert_positive(raw, "/egress/cases whitelist")
    assert_no_leak(raw, viewer, "/egress/cases per-case whitelist")
    # Extra keys nested inside disposition and decision are dropped too.
    S.pane_cases["ast-atl"] = [_case(
        "ATL", disposition={"option": "o", "stage": "s", "kind": "k", "key": "x",
                            "note": CANARY_BDR},
        decision={"allowed": True, "reason": "r", "trace": CANARY_UNLABELLED})]
    status, raw = call(viewer, "GET", "/egress/cases?asset_id=ast-atl")
    assert status == 200, raw
    assert CANARY_BDR.encode() not in raw and CANARY_UNLABELLED.encode() not in raw, raw
    got = json.loads(raw)["cases"][0]
    assert got["disposition"] == {"option": "o", "stage": "s", "kind": "k", "key": "x"}
    assert got["decision"] == {"allowed": True, "reason": "r"}


# --- 3. /reports/tier and /reports/mine -------------------------------------

def _seed_reports():
    for kind in ("UNL", "BDR", "ATL"):
        k = kind.lower()
        S.rows.setdefault("failure_episodes", []).append(dict(
            LABELS[kind], episode_id=f"ep-{k}", detected_at="2026-01-01 10:00:00+00",
            asset_id=f"ast-{k}", component=f"comp-{k}", fault_code=CANARIES[kind],
            cleared_at="2026-01-01 11:00:00+00", cleared_by="someone",
            resolution=CANARIES[kind], edge_id=EDGE, region_id=None,
            sources=json.dumps([
                {"source": "report", "reported_by": v["subject"],
                 "reported_at_ns": 1767261600000000000} for v in VIEWERS.values()])))
    ledger = {"route": "cortex", "event_id": str(uuid.uuid4()), "outcome": "delivered",
              "http_status": 200, "case_id": "case-1", "episode_id": "egress-ep",
              "recorded_at": "2026-01-01T10:30:00+00:00",
              "first_recorded_at": "2026-01-01T10:30:00+00:00",
              "case_id_mismatch": False}

    def rec(kind, **extra):
        return dict({"kind": "ActionRecord", "key": f"k-{kind}", "case_id": "case-1",
                     "decided_at": "2026-01-01T10:40:00Z", "allowed": False,
                     "reason": CANARIES[kind], "labels": dict(LIST_LABELS[kind])}, **extra)

    S.pane_faults = [{
        "asset_id": "ast-atl", "component": "comp-atl", "fault_code": CANARY_ATL,
        "ledger": [ledger],
        "released": [rec(k) for k in ("UNL", "BDR", "ATL")],
        "completion": {"declared": True,
                       "records": [rec(k, completes="x", outcome="done")
                                   for k in ("UNL", "BDR", "ATL")]},
        "unmatched_completions": []}]


@viewer_param
def test_probe_03_reports_tier(rig, viewer):
    """Closed episodes labelled BDR/unlabelled/ATL with canaries in fault_code and resolution, plus released and completion records of each label on the ATL episode; proves filter_decisions on episodes and _hidden on records."""
    _seed_reports()
    status, raw = call(viewer, "GET", "/reports/tier")
    assert status == 200, raw
    assert_positive(raw, "/reports/tier")
    assert_no_leak(raw, viewer, "/reports/tier")


@viewer_param
def test_probe_03_reports_mine(rig, viewer):
    """The viewer filed a report on episodes labelled BDR/unlabelled/ATL (canaries in fault_code and resolution); proves the episode header is label-filtered for a filer, not only reported_by."""
    _seed_reports()
    status, raw = call(viewer, "GET", "/reports/mine")
    assert status == 200, raw
    assert_positive(raw, "/reports/mine")
    assert_no_leak(raw, viewer, "/reports/mine episode headers")
    reports = json.loads(raw)["reports"]
    listed = [r for r in reports if r["asset_id"] is not None]
    withheld = [r for r in reports if r["asset_id"] is None]
    expect_listed = ["ep-atl"] if viewer == "atl" else ["ep-atl", "ep-bdr"]
    assert sorted(r["episode_id"] for r in listed) == expect_listed
    assert all(r["fault_code"] and r["component"] for r in listed)
    # Everything else is a withheld entry: one state, no episode field.
    assert len(withheld) == 3 - len(expect_listed)
    for r in withheld:
        assert r["episode_id"].startswith("withheld-")
        assert [s["state"] for s in r["states"]] == ["report withheld"]
        for f in ("detected_at", "asset_id", "owning_tier", "component", "fault_code",
                  "open", "cleared_at", "cleared_by", "resolution"):
            assert r[f] is None, (f, r)
        assert r["unmatched"] == []


# --- 4. /cm/fault-codes and /cm/sources -------------------------------------

@viewer_param
def test_probe_04_cm_fault_codes(rig, viewer):
    """telemetry_latest_state rows labelled BDR/unlabelled/ATL with canaries in platform_variant; proves read_visible_row scopes the asset and its row."""
    trio("telemetry_latest_state", lambda k, c: {"asset_id": "ast-mix", "platform_variant": c})
    S.rows["telemetry_latest_state"] += [
        dict(LABELS["BDR"], asset_id="ast-bdronly", platform_variant=CANARY_BDR),
        dict(LABELS["UNL"], asset_id="ast-unlonly", platform_variant=CANARY_UNLABELLED),
        dict(LABELS["ATL"], asset_id="ast-atlonly", platform_variant=CANARY_ATL)]
    out = {}
    for asset in ("ast-mix", "ast-bdronly", "ast-unlonly", "ast-atlonly"):
        status, raw = call(viewer, "GET", f"/cm/fault-codes?asset_id={asset}")
        out[asset] = (status, raw)
        assert_no_leak(raw, viewer, f"/cm/fault-codes {asset}")
    assert out["ast-mix"][0] == 200
    assert_positive(out["ast-atlonly"][1], "/cm/fault-codes")
    assert out["ast-unlonly"][0] == 404
    if viewer == "atl":
        assert out["ast-bdronly"][0] == 404


@viewer_param
def test_probe_04_cm_sources(rig, viewer):
    """Rows labelled BDR/unlabelled/ATL in telemetry, asset_cm_state, asset_logistics_status and asset_declaration, canaries in their free-text fields; proves every read goes through read_visible_row."""
    trio("telemetry_latest_state", lambda k, c: {
        "asset_id": "ast-mix", "edge_id": EDGE, "platform_variant": c,
        "provenance": {"edge_id": EDGE, "producer_id": c}})
    trio("asset_cm_state", lambda k, c: {
        "asset_id": "ast-mix", "edge_id": EDGE, "baseline_id": c,
        "manual_discrepancies": [{"fault_code": "F-1", "component": "C-1",
                                  "description": c, "severity": "minor"}]})
    trio("asset_logistics_status", lambda k, c: {
        "asset_id": "ast-mix", "edge_id": EDGE, "constraining_factors": [c]})
    trio("asset_declaration", lambda k, c: {"asset_id": "ast-mix", "declared_by": c})
    S.rows["telemetry_latest_state"] += [
        dict(LABELS["BDR"], asset_id="ast-bdronly", platform_variant=CANARY_BDR),
        dict(LABELS["UNL"], asset_id="ast-unlonly", platform_variant=CANARY_UNLABELLED),
        dict(LABELS["ATL"], asset_id="ast-atlonly", platform_variant=CANARY_ATL)]
    out = {}
    for asset in ("ast-mix", "ast-bdronly", "ast-unlonly", "ast-atlonly"):
        status, raw = call(viewer, "GET", f"/cm/sources?asset_id={asset}")
        out[asset] = (status, raw)
        assert_no_leak(raw, viewer, f"/cm/sources {asset}")
    assert out["ast-mix"][0] == 200, out["ast-mix"]
    assert_positive(out["ast-atlonly"][1], "/cm/sources")
    assert out["ast-unlonly"][0] == 404


# --- 5. /arrivals and /arrivals/summary -------------------------------------

def _seed_fielding():
    trio("asset_fielding", lambda k, c: {
        "serial": "SN-" + c, "platform_variant": "VAR-1", "unit": "u1",
        "fielded_to": EDGE, "due_by": "2999-01-01T00:00:00Z"})


@viewer_param
def test_probe_05_arrivals_fielding(rig, viewer):
    """asset_fielding rows labelled BDR/unlabelled/ATL with canaries in the serial; proves the expected list composes policy_predicate."""
    _seed_fielding()
    status, raw = call(viewer, "GET", f"/arrivals?edge_id={EDGE}")
    assert status == 200, raw
    assert_positive(raw, "/arrivals expected")
    assert_no_leak(raw, viewer, "/arrivals expected (pep.py:3518-3520)")


def test_probe_05_arrivals_undeclared_list_follows_the_label_rule(rig):
    """DECLARED EXCEPTION, narrowed: undeclared assets seen on telemetry (labelled BDR/unlabelled/ATL, canaries in asset_id). A labelled row is listed only to a viewer whose nations may see it; an unlabelled one is listed to every declarer, so a declare role at the owned edge can declare it (ADR-0050 s3, ADR-0050 amendment of 2026-11-06)."""
    trio("telemetry_latest_state", lambda k, c: {
        "asset_id": "ast-" + c, "edge_id": EDGE, "platform_variant": "VAR-1",
        "last_sample_at": "2026-01-01T00:00:00Z", "kinematics": None})
    status, raw = call("atl", "GET", f"/arrivals?edge_id={EDGE}")
    assert status == 200, raw
    assert_positive(raw, "/arrivals undeclared")
    assert CANARY_UNLABELLED.encode() in raw, raw[:400]
    assert CANARY_BDR.encode() not in raw, raw[:400]
    status, raw = call("all", "GET", f"/arrivals?edge_id={EDGE}")
    assert status == 200, raw
    for kind in ("ATL", "UNL", "BDR"):
        assert CANARIES[kind].encode() in raw, (kind, raw[:400])
def _summary_counts(viewer):
    status, raw = call(viewer, "GET", "/arrivals/summary")
    assert status == 200, raw
    assert_no_leak(raw, viewer, "/arrivals/summary")
    edges = {e["edge_id"]: e for e in json.loads(raw)["edges"]}
    return edges.get(EDGE, {"undeclared": 0, "expected": 0, "overdue": 0})


def test_probe_05_arrivals_summary_counts(rig):
    """Counts with and without a BDR-only fielding row and undeclared assets; proves fielding counts are label-scoped, a BDR-labelled undeclared asset moves only the all-nations count, and an unlabelled one moves both."""
    S.rows["asset_fielding"] = [
        dict(LABELS["ATL"], serial="SN-" + CANARY_ATL, fielded_to=EDGE,
             due_by="2000-01-01T00:00:00Z")]
    S.rows["telemetry_latest_state"] = [
        dict(LABELS["ATL"], asset_id="ast-atl", edge_id=EDGE)]
    before = _summary_counts("atl")
    before_all = _summary_counts("all")
    assert before["expected"] >= 1 and before["overdue"] >= 1, before  # positive control
    S.rows["asset_fielding"].append(
        dict(LABELS["BDR"], serial="SN-" + CANARY_BDR, fielded_to=EDGE,
             due_by="2000-01-01T00:00:00Z"))
    S.rows["telemetry_latest_state"].append(
        dict(LABELS["BDR"], asset_id="ast-" + CANARY_BDR, edge_id=EDGE))
    after = _summary_counts("atl")
    after_all = _summary_counts("all")
    assert after["expected"] == before["expected"], (before, after)
    assert after["overdue"] == before["overdue"], (before, after)
    assert after["undeclared"] == before["undeclared"], (before, after)
    assert after_all["undeclared"] == before_all["undeclared"] + 1, (before_all, after_all)
    S.rows["telemetry_latest_state"].append(
        dict(LABELS["UNL"], asset_id="ast-" + CANARY_UNLABELLED, edge_id=EDGE))
    unl = _summary_counts("atl")
    unl_all = _summary_counts("all")
    assert unl["undeclared"] == after["undeclared"] + 1, (after, unl)
    assert unl_all["undeclared"] == after_all["undeclared"] + 1, (after_all, unl_all)


# --- 6. POST /arrivals/declare ----------------------------------------------

def _declare_body(serial):
    return {"asset_id": "ast-new", "edge_id": EDGE, "serial": None, "unit": "u1",
            "originator_nation": "ATL", "releasable_to": [], "baseline_id": None,
            "source": "expect-confirm", "confirm_serial": serial}


@viewer_param
def test_probe_06_arrivals_declare(rig, viewer):
    """An ATL operator confirms serials whose asset_fielding rows are BDR-only / unlabelled (canaries in the serial); proves the expect-confirm read composes policy_predicate, answers 404 and posts nothing."""
    S.rows["telemetry_latest_state"] = [
        {"asset_id": "ast-new", "edge_id": EDGE, "platform_variant": "VAR-1", "region_id": None}]
    S.rows["asset_fielding"] = []
    for kind in ("UNL", "BDR", "ATL"):
        row = dict(LABELS[kind], serial="SN-" + CANARIES[kind], platform_variant="VAR-1",
                   unit="u1", fielded_to=EDGE)
        if kind == "ATL":
            row["releasable_to"] = "{}"
        S.rows["asset_fielding"].append(row)
    for kind in forbidden(viewer):
        status, raw = call(viewer, "POST", "/arrivals/declare",
                           _declare_body("SN-" + CANARIES[kind]))
        assert status == 404, (kind, status, raw)
        assert_no_leak(raw, viewer, "/arrivals/declare refusal")
        assert b"BDR" not in raw or viewer == "all", raw
        assert not S.called("arrivals-intake"), S.called("arrivals-intake")
    status, raw = call(viewer, "POST", "/arrivals/declare", _declare_body("SN-" + CANARY_ATL))
    assert status == 201, (status, raw)
    assert_positive(raw, "/arrivals/declare")
    assert_no_leak(raw, viewer, "/arrivals/declare")
    assert len(S.called("arrivals-intake")) == 1
    # A BDR-labelled undeclared asset: the ATL viewer gets the one 404 answer
    # an unknown id gets; the all-nations viewer may declare it.
    S.rows["telemetry_latest_state"].append(
        dict(LABELS["BDR"], asset_id="ast-bdr-row", edge_id=EDGE,
             platform_variant="VAR-1", region_id=None))
    body = dict(_declare_body(None), asset_id="ast-bdr-row", source="declare")
    status, raw = call(viewer, "POST", "/arrivals/declare", body)
    if viewer == "atl":
        unknown = call(viewer, "POST", "/arrivals/declare",
                       dict(body, asset_id="ast-unknown"))
        assert status == unknown[0] == 404, (status, raw, unknown)
        assert json.loads(raw)["cause"] == json.loads(unknown[1])["cause"]
        assert len(S.called("arrivals-intake")) == 1
    else:
        assert status == 201, (status, raw)
        assert len(S.called("arrivals-intake")) == 2


# --- 7. POST /cm/discrepancy and /cm/discrepancy/resolve ---------------------

def _seed_cm_assets():
    pep = sys.modules["pep"]
    pep.FAULT_CATALOG = {"variants": {
        f"VAR-{k}": {"manual": "m", "codes": [
            {"code": "F-1", "component": CANARIES[k], "severity": "minor"}]}
        for k in ("UNL", "BDR", "ATL")}}
    for kind in ("UNL", "BDR", "ATL"):
        asset = f"ast-cm-{kind.lower()}"
        S.rows.setdefault("asset_cm_state", []).append(dict(
            LABELS[kind], asset_id=asset, edge_id=EDGE,
            installed=[{"slot_id": CANARIES[kind]}]))
        S.rows.setdefault("telemetry_latest_state", []).append(dict(
            LABELS[kind], asset_id=asset, platform_variant=f"VAR-{kind}"))


@viewer_param
def test_probe_07_cm_discrepancy(rig, viewer):
    """asset_cm_state rows labelled BDR/unlabelled/ATL whose installed slot id is the canary; proves a report on an invisible asset is a 404 and never reaches the CM intake."""
    _seed_cm_assets()
    for kind in forbidden(viewer):
        status, raw = call(viewer, "POST", "/cm/discrepancy", {
            "asset_id": f"ast-cm-{kind.lower()}", "component": CANARIES[kind],
            "fault_code": "", "description": "probe"})
        assert status == 404, (kind, status, raw)
        assert_no_leak(raw, viewer, "/cm/discrepancy")
        assert not S.called("cm-intake"), S.called("cm-intake")
    status, raw = call(viewer, "POST", "/cm/discrepancy", {
        "asset_id": "ast-cm-atl", "component": CANARY_ATL, "fault_code": "",
        "description": "probe"})
    assert status == 202, (status, raw)
    assert CANARY_ATL in json.dumps(S.called("cm-intake"))


@viewer_param
def test_probe_07_cm_discrepancy_resolve(rig, viewer):
    """The same BDR/unlabelled/ATL assets with a catalog fault code bound to the canary slot; proves a resolve on an invisible asset is a 404 and never reaches the CM intake."""
    _seed_cm_assets()
    for kind in forbidden(viewer):
        status, raw = call(viewer, "POST", "/cm/discrepancy/resolve", {
            "asset_id": f"ast-cm-{kind.lower()}", "component": CANARIES[kind],
            "fault_code": "F-1", "resolution": "probe"})
        assert status == 404, (kind, status, raw)
        assert_no_leak(raw, viewer, "/cm/discrepancy/resolve")
        assert not S.called("cm-intake"), S.called("cm-intake")
    status, raw = call(viewer, "POST", "/cm/discrepancy/resolve", {
        "asset_id": "ast-cm-atl", "component": CANARY_ATL, "fault_code": "F-1",
        "resolution": "probe"})
    assert status == 202, (status, raw)
    assert CANARY_ATL in json.dumps(S.called("cm-intake"))


# --- 8. POST /manual/ask ----------------------------------------------------

def _seed_qa_assets():
    for kind in ("UNL", "BDR", "ATL"):
        S.rows.setdefault("asset_cm_state", []).append(dict(
            LABELS[kind], asset_id=f"ast-qa-{kind.lower()}", edge_id=EDGE))


def _ask(viewer, kind):
    return call(viewer, "POST", "/manual/ask", {
        "asset_id": f"ast-qa-{kind.lower()}", "question": "how?", "dmcs": [DMC]})


@viewer_param
def test_probe_08_manual_ask_invisible_asset(rig, viewer):
    """asset_cm_state rows labelled BDR/unlabelled/ATL, the question service's answer carrying the canary; proves an invisible asset is a 404 and the service is not called."""
    _seed_qa_assets()
    for kind in forbidden(viewer):
        S.qa_reply = {"answer": f"seen {CANARIES[kind]}", "citations": [{"dmc": DMC}]}
        status, raw = _ask(viewer, kind)
        assert status == 404, (kind, status, raw)
        assert_no_leak(raw, viewer, "/manual/ask")
        assert not S.called("qa"), S.called("qa")
    S.qa_reply = {"answer": f"seen {CANARY_ATL}", "citations": [{"dmc": DMC}]}
    status, raw = _ask(viewer, "ATL")
    assert status == 200, (status, raw)
    assert_positive(raw, "/manual/ask")


def test_probe_08_manual_ask_answer_text(rig):
    """INFORMATION ONLY: an ATL-visible asset whose upstream answer contains the BDR canary; prints whether the route relays the answer text (nothing asserted about it)."""
    _seed_qa_assets()
    S.qa_reply = {"answer": f"seen {CANARY_BDR}", "citations": [{"dmc": DMC}]}
    status, raw = _ask("atl", "ATL")
    assert len(S.called("qa")) == 1
    print(f"manual/ask, answer text with the BDR canary: HTTP {status}, "
          f"relayed={CANARY_BDR.encode() in raw}")


# --- 9. GET /picture --------------------------------------------------------

def test_probe_09_picture_relays_body_verbatim(rig):
    """DECLARED EXCEPTION, pinned as it is today: the assembler's picture (events labelled BDR/unlabelled/ATL, canaries in their notes) is relayed byte for byte to a service-token client. The route authenticates a machine client (Bearer JWT, audience PICTURE_AUDIENCE, mapped by azp to a destination) and never asks Topaz, so it has no viewer nations; see pep.py:5077-5079 and the _handle_picture docstring (pep.py:4983)."""
    events = [dict(LIST_LABELS[k], event_id=str(uuid.uuid4()), note=CANARIES[k])
              for k in ("BDR", "UNL", "ATL")]
    S.picture_body = json.dumps({"events": events}).encode()
    event_id = str(uuid.uuid4())
    import pep as _p
    req = urllib.request.Request(
        f"{_p.PEP_URL}/picture?event_id={event_id}&destination=caller-chosen",
        headers={"Authorization": "Bearer token"})
    with urllib.request.urlopen(req, timeout=20) as r:
        status, raw = r.status, r.read()
    assert status == 200
    assert raw == S.picture_body
    for c in CANARIES.values():
        assert c.encode() in raw
    sent = S.called("picture")[0]
    assert sent["destination"] == ["dest-a"], sent   # from the mapping, not the caller
    assert not S.called("topaz"), "no viewer nations are consulted on /picture"


# --- 10. /v1/shape ----------------------------------------------------------

def _shape_get(viewer, table, extra=""):
    return call(viewer, "GET", f"/v1/shape?table={table}&offset=-1{extra}")


@viewer_param
def test_probe_10_shape_nation_class(rig, viewer):
    """A nation-class table read with and without a client where; proves the upstream where is (client) AND (policy_predicate(nations)) so the client can only narrow."""
    pep = rig
    pep.LABELED_TABLES = {"asset_cm_state"}
    pep.ROLE_SERVED_TABLES = {"role_t"}
    pep.SUBJECT_SCOPED_TABLES = {"subj_t": "owner"}
    pred = REAL.policy_predicate(VIEWERS[viewer]["nations"])
    status, raw = _shape_get(viewer, "asset_cm_state")
    assert status == 200, raw
    status, raw = _shape_get(viewer, "asset_cm_state",
                             "&where=" + urllib.parse.quote("1=1 OR asset_id = 'x'"))
    assert status == 200, raw
    wheres = [q["where"][0] for q in S.called("electric-get")]
    assert wheres == [pred, f"(1=1 OR asset_id = 'x') AND ({pred})"], wheres


def test_probe_10_shape_subject_class(rig):
    """A subject-class table read by a non-oversight role; proves the subject column clause is in the upstream where."""
    pep = rig
    pep.LABELED_TABLES = {"asset_cm_state"}
    pep.SUBJECT_SCOPED_TABLES = {"subj_t": "owner"}
    status, raw = _shape_get("atl", "subj_t")
    assert status == 200, raw
    assert [q["where"][0] for q in S.called("electric-get")] == ["owner = 'viewer-atl'"]


def test_probe_10_shape_refused_class(rig):
    """An unclassified table while classes are configured; proves a 403 before the PDP and no Electric call."""
    pep = rig
    pep.LABELED_TABLES = {"asset_cm_state"}
    status, raw = _shape_get("atl", "not_classified")
    assert status == 403, raw
    assert not S.called("topaz") and not S.called("electric-get")


def test_probe_10_shape_delete(rig):
    """DELETE /v1/shape on a non-element table and on a role-class element table; proves both are refused and nothing is sent to Electric."""
    pep = rig
    status, raw = call("atl", "DELETE", "/v1/shape?table=asset_cm_state&handle=h1")
    assert status == 405, raw
    pep.LABELED_TABLES = {"asset_cm_state"}
    pep.ROLE_SERVED_TABLES = {pep.ELEMENT_TABLE}
    status, raw = call("atl", "DELETE", f"/v1/shape?table={pep.ELEMENT_TABLE}&handle=h1")
    assert status == 403, raw
    assert not S.called("electric-delete") and not S.called("electric-get")
