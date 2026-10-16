"""The shipped producers must write exactly the topics produces.yaml lists.

Two kinds of producer ship from this repo to the chart.

1. The egress image (egress/, one image, three chart roles = three manifest keys). Each role's code is the
   entry module (main.py = gate, assembler.py, intake.py) plus every egress module it imports, transitively; a
   module shared by roles counts for each role that runs it. Test files are not shipped code and are skipped;
   egress/tak/ is a separate image (a Dockerfile and a config, no Python) and is not scanned. Producer call
   sites are found by AST: `.send(`, `.send_and_wait(`, `.produce(`, and this image's own wrappers,
   `delivery.send_one(` and the `produce(` callable that assembler.py / intake.py inject. Topics come from config
   lists the chart passes (route `sink_topic`, assembler `output_topic`, intake `onward_topic`), so those sites
   read an attribute and carry `# produces: <manifest entry>` (entries separated by ';'). The second half of this
   file holds each annotation to the real config loader.
2. Three Redpanda Connect pipelines the chart mounts (image redpandadata/connect): openddil-base-connect.yaml,
   cm-intake.yaml, declaration-intake.yaml. They are config, so they are parsed: every output kafka /
   kafka_franz topic, through switch / broker / fallback, must equal the key's topics. The other Connect files in
   this repo (connect/, redpanda-connect*.yaml, benthos-ingest.yaml) are compose-only: the chart never mounts
   them, so they are out of scope here.
"""
from __future__ import annotations

import ast
import json
import re
import sys
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
EGRESS = ROOT / "egress"
sys.path.insert(0, str(ROOT))
import produces_manifest as pm  # noqa: E402

MANIFEST = pm.load(ROOT / "produces.yaml")

# ---- egress -------------------------------------------------------------------------------------------
ROLES = {"egress-gate-c2": "main.py", "egress-assembler": "assembler.py", "egress-intake": "intake.py"}
EGRESS_ATTRS = {"send", "send_and_wait", "produce", "send_one"}
EGRESS_NAMES = {"produce", "send_one", "send"}
# (file, function) that take the topic as a parameter or loop variable and hand it to the producer: the sink
# the caller feeds. Skipped by name; each caller carries the topic.
TRANSPORTS = {("delivery.py", "send"), ("delivery.py", "send_one"),
              ("assembler.py", "produce"), ("intake.py", "produce")}
ANNOTATION = re.compile(r"#\s*produces:\s*(.+?)\s*$")
ENV = {}  # fixture env: every code default applies
CONFIG = {  # fixture config lists, as the chart passes them (KEY = the env var holding the file path)
    "OPENDDIL_EGRESS_ROUTES_PATH": [{"sink_topic": "fixture-route-sink-a"}, {"sink_topic": "fixture-route-sink-b"}],
    "OPENDDIL_ASSEMBLER_CONFIG": [{"output_topic": "fixture-assembled-a"}, {"output_topic": "fixture-assembled-b"}],
    "OPENDDIL_EGRESS_INTAKE_CONFIG": [{"onward_topic": "fixture-onward-a"}, {"onward_topic": "fixture-onward-b"}],
}


def _parents(tree):
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            child.parent = node


def _fn_names(node):
    while node is not None:
        node = getattr(node, "parent", None)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            yield node.name


def _env_template(call):
    """os.environ.get("X", "d") / os.getenv("X", "d") -> '${X:-d}', else None."""
    f = call.func
    ok = isinstance(f, ast.Attribute) and (
        (f.attr == "getenv" and isinstance(f.value, ast.Name) and f.value.id == "os")
        or (f.attr == "get" and isinstance(f.value, ast.Attribute) and f.value.attr == "environ"))
    if not ok or not call.args or not isinstance(call.args[0], ast.Constant):
        return None
    var = call.args[0].value
    if len(call.args) > 1 and isinstance(call.args[1], ast.Constant) and isinstance(call.args[1].value, str):
        return f"${{{var}:-{call.args[1].value}}}"
    return f"${{{var}}}"


def _closure(entry: str) -> list[str]:
    """The entry module and every egress module it imports (anywhere in the file), transitively."""
    local = {p.name for p in EGRESS.glob("*.py") if not p.name.startswith("test_")}
    seen, todo = [], [entry]
    while todo:
        name = todo.pop()
        if name in seen:
            continue
        seen.append(name)
        for n in ast.walk(ast.parse((EGRESS / name).read_text(encoding="utf-8"))):
            mods = [a.name for a in n.names] if isinstance(n, ast.Import) else (
                [n.module] if isinstance(n, ast.ImportFrom) and n.module and not n.level else [])
            todo += [f"{m.split('.')[0]}.py" for m in mods if f"{m.split('.')[0]}.py" in local]
    return sorted(seen)


def _scan(files, attrs=EGRESS_ATTRS, names=EGRESS_NAMES):
    """-> (templates, bad 'file:line', {file: site count}, [(file, line, annotated?, arg source)])."""
    templates, bad, sites, detail = set(), [], {}, []
    for name in files:
        src = (EGRESS / name).read_text(encoding="utf-8")
        lines = src.splitlines()
        tree = ast.parse(src)
        _parents(tree)
        consts = {}
        for n in tree.body:
            if isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name):
                if isinstance(n.value, ast.Constant) and isinstance(n.value.value, str):
                    consts[n.targets[0].id] = n.value.value
                elif isinstance(n.value, ast.Call) and _env_template(n.value):
                    consts[n.targets[0].id] = _env_template(n.value)
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            f = node.func
            called = f.attr if isinstance(f, ast.Attribute) else getattr(f, "id", None)
            if not ((isinstance(f, ast.Attribute) and f.attr in attrs)
                    or (isinstance(f, ast.Name) and f.id in names)):
                continue
            if any((name, fn) in TRANSPORTS for fn in _fn_names(node)):
                continue
            sites[name] = sites.get(name, 0) + 1
            kw = {k.arg: k.value for k in node.keywords}
            pos = 1 if called == "send_one" else 0
            arg = kw.get("topic") or (node.args[pos] if len(node.args) > pos else None)
            span = lines[max(node.lineno - 2, 0):node.end_lineno]
            note = next((m.group(1) for m in map(ANNOTATION.search, span) if m), None)
            if note:
                templates.update(t.strip().strip("\"'") for t in note.split(";"))
                detail.append((name, node.lineno, True, ast.unparse(arg) if arg is not None else ""))
                continue
            got = None
            if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                got = arg.value
            elif isinstance(arg, ast.Name):
                got = consts.get(arg.id)
            elif isinstance(arg, ast.Call):
                got = _env_template(arg)
            if got:
                templates.add(got)
            else:
                bad.append(f"egress/{name}:{node.lineno}")
    return templates, bad, sites, detail


def _expand(templates):
    return {n for t in templates for n in pm.expand_all(t, ENV, CONFIG)}


def _declared(key):
    assert key in MANIFEST, f"produces.yaml has no key {key!r}"
    return _expand(MANIFEST[key]["topics"] or [])


def _diff(got, declared, what):
    msg = [f"{what}: manifest lists a topic the code does not produce: {t}" for t in sorted(declared - got)]
    msg += [f"{what}: code produces a topic the manifest does not list: {t}" for t in sorted(got - declared)]
    return msg


@pytest.mark.parametrize("key,entry", sorted(ROLES.items()))
def test_egress_role_produces_exactly_its_manifest_key(key, entry):
    files = _closure(entry)
    templates, bad, sites, _ = _scan(files)
    assert sites, f"{key}: no producer call sites found in {files}: the scan is not looking at the code"
    assert not bad, ("unresolvable producer call sites (annotate with '# produces: <entry>'): " + ", ".join(bad))
    msg = _diff(_expand(templates), _declared(key), key)
    assert not msg, "\n".join(msg)


def test_no_producer_outside_the_three_roles():
    """Egress modules no role runs (forwarder, pane_api, cot_adapter, stub_sink) must hold no Kafka producer.
    `.send(` is left out here on purpose: cot_adapter's `tak.send` is a TCP socket write, not Kafka."""
    run = {f for entry in ROLES.values() for f in _closure(entry)}
    others = sorted(p.name for p in EGRESS.glob("*.py") if not p.name.startswith("test_") and p.name not in run)
    _, bad, sites, _ = _scan(others, attrs=EGRESS_ATTRS - {"send"}, names=EGRESS_NAMES - {"send"})
    assert not sites, f"producer call sites in egress modules no manifest key covers: {sites}"
    assert not list((EGRESS / "tak").glob("*.py")), "egress/tak now ships Python: scan it"


def test_manifest_has_exactly_the_shipped_keys():
    assert set(MANIFEST) == set(ROLES) | set(CONNECT)
    assert {MANIFEST[k]["image"] for k in ROLES} == {"openddil/egress"}


# ---- each annotated site against the real config loader ------------------------------------------------
# An annotation names a config list; the loader the role runs must produce, from that list, exactly the
# attribute the send site reads. Fixture lists are written to disk and loaded by the real loaders.
def test_annotations_equal_the_real_loaders(tmp_path, monkeypatch):
    monkeypatch.syspath_prepend(str(EGRESS))
    monkeypatch.delenv("OPENDDIL_EGRESS_SINK_TOPIC", raising=False)
    import importlib
    import assembler, intake, kinds, routes  # noqa: E401
    importlib.reload(routes)  # SINK_TOPIC is read at import

    def write(key, entries):
        p = tmp_path / f"{key}.json"
        p.write_text(json.dumps(entries), encoding="utf-8")
        return p

    r = [{"name": f"r{i}", "source_topic": "s", "destination": "d", **e}
         for i, e in enumerate(CONFIG["OPENDDIL_EGRESS_ROUTES_PATH"])]
    a = [{"name": f"a{i}", "kind": "K", "trigger_topic": "t", **e}
         for i, e in enumerate(CONFIG["OPENDDIL_ASSEMBLER_CONFIG"])]
    i_ = [{"name": f"i{i}", "source_destination": "system:x", "kind": "Q",
           "poll": {"url": "http://x", "interval_s": 5, "items_pointer": ""},
           "answers": {"topic": "t", "kind": "R", "ref_pointer": "/a", "id_pointer": "/b"},
           "approvers": {"array_pointer": "/e", "subject_field": "subject"}, **e}
          for i, e in enumerate(CONFIG["OPENDDIL_EGRESS_INTAKE_CONFIG"])]
    decls = {"Q": kinds.Declarations(key="/k", label="/l", owning_tier="/t"), "R": kinds.Declarations(key="/k", label="/l")}
    held = {
        "egress-gate-c2": ({x.sink_topic for x in routes.load_routes(write("r", r))}
                           | {x.sink_topic for x in routes.load_routes(None)}),
        "egress-assembler": {x.output_topic for x in assembler.load_assembler_config(write("a", a), ["K"])},
        "egress-intake": {x.onward_topic for x in intake.load_intake_config(write("i", i_), decls)},
    }
    field = {"egress-gate-c2": "sink_topic", "egress-assembler": "output_topic", "egress-intake": "onward_topic"}
    for key, entry in ROLES.items():
        templates, _, _, detail = _scan(_closure(entry))
        annotated = [d for d in detail if d[2]]
        assert annotated, f"{key}: no annotated site: this test would hold nothing"
        for name, line, _, arg in annotated:
            assert arg.endswith("." + field[key]), f"egress/{name}:{line} reads {arg!r}, not .{field[key]}"
        assert _expand(templates) == held[key], f"{key}: annotation vs loaded config {sorted(held[key])}"


# ---- Redpanda Connect pipelines ------------------------------------------------------------------------
CONNECT = {k: w["config"] for k, w in MANIFEST.items() if "config" in w}
KAFKA_OUTPUTS = {"kafka", "kafka_franz", "redpanda"}
NO_TOPIC = {"reject", "drop", "stdout", "sync_response", "processors", "label"}


def _outputs(node, found, path):
    """Collect topic templates from one `output:` tree, through switch / broker / fallback."""
    if not isinstance(node, dict):
        raise AssertionError(f"{path}: output is not a mapping")
    for k, v in node.items():
        if k in KAFKA_OUTPUTS:
            topic = (v or {}).get("topic")
            assert isinstance(topic, str) and "${!" not in topic, f"{path}: {k} topic is not static: {topic!r}"
            found.add(re.sub(r"\$\{(\w+):([^}]*)\}", r"${\1:-\2}", topic))  # Connect ${V:d} -> manifest ${V:-d}
        elif k == "switch":
            for case in (v.get("cases") if isinstance(v, dict) else v) or []:
                if case.get("output") is not None:
                    _outputs(case["output"], found, f"{path}/switch")
        elif k == "broker":
            for o in v.get("outputs") or []:
                _outputs(o, found, f"{path}/broker")
        elif k == "fallback":
            for o in v or []:
                _outputs(o, found, f"{path}/fallback")
        elif k not in NO_TOPIC:
            raise AssertionError(f"{path}: output type {k!r} is not one this scan understands")


@pytest.mark.parametrize("key,filename", sorted(CONNECT.items()))
def test_connect_pipeline_produces_exactly_its_manifest_key(key, filename):
    assert MANIFEST[key]["image"] == "redpandadata/connect"
    doc = yaml.safe_load((ROOT / filename).read_text(encoding="utf-8"))
    found: set[str] = set()
    _outputs(doc["output"], found, filename)
    assert found, f"{filename}: no kafka output found: the scan is not looking at the pipeline"
    msg = _diff({pm.expand(t, ENV) for t in found}, _declared(key), f"{key} ({filename})")
    assert not msg, "\n".join(msg)


def test_connect_keys_are_the_three_mounted_pipelines():
    assert CONNECT == {"connect-edge": "openddil-base-connect.yaml", "cm-intake": "cm-intake.yaml",
                       "declaration-intake": "declaration-intake.yaml"}
