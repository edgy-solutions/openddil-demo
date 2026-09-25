#!/usr/bin/env python3
"""INVARIANT: every fusion input topic carries the releasability labels.

WHAT THIS ASSERTS
For every topic the logistics fusion service actually subscribes to, every
record on that topic obeys the ADR-0029 §3 labelling rule:

  * an asset NAMED in `releasability.yaml` carries exactly the declared
    `originator_nation` and exactly the declared `releasable_to` set;
  * an asset NOT named carries NO nation at all.

Both halves matter. The first is propagation: a hop that drops the label
turns a declared asset into an undeclared-looking one. The second is the
prohibition on derivation: a hop that *invents* a nation for an asset nobody
declared is worse than one that drops it, because a guess is indistinguish-
able from a declaration once it is in the column.

WHY DISCOVERED AND NOT ENUMERATED
A hand-written list of fusion's inputs is a list that goes stale silently.
The failure mode this whole arc keeps finding is the same one every time: a
check that is correct about the things it was told about, and blind to the
thing that was added afterwards. So the topics come from the running
system's own answer -- Restate's `/subscriptions` admin endpoint, which is
what actually wires Kafka to fusion handlers. A new input appears here the
moment it is registered, whether or not anyone remembered this file.

The decoder registry is keyed on the fusion HANDLER, not the topic, because
the handler is what determines the payload shape; a new topic bound to an
existing handler is covered automatically. A discovered handler with no
decoder here is a HARD FAILURE, never a skip: an unchecked fusion input is
precisely the hole this test exists to close, and reporting "nothing wrong
found" about a topic nobody read would be the same lie in a new place.

WHY IT INJECTS
`asset-telemetry-windows` is a fusion input that COMPOSE CANNOT FILL BY
ITSELF. The only producer of `raw-sensor-stream` under compose is the DIS
mapper, and DIS Entity State PDUs carry no sustainment data (the mapping
says so in its own comments). `faust_edge._buffer_event` buffers only
fluids, consumables and wear, so a DIS-only fleet never fills a window
buffer and the windowing hop never emits. That is why the dropped label on
that hop survived: the path was unexercised, not merely untested.

So the test plays the part compose has no producer for. It injects
sustainment-bearing `EntityTelemetryEvent`s onto edge-01's
`raw-sensor-stream` -- one asset that IS declared, carrying the labels the
declaration gives it, and one that is NOT, carrying none. THESE TWO
RECORDS' LABELS ON raw-sensor-stream ARE THE TEST'S OWN, and the test says
so rather than claiming that topic's labels were all earned. What is under
test is the hop: whether `faust-edge` carries those labels onto
`asset-telemetry-windows`, and whether it refrains from inventing one for
the asset that arrived without.

RED CHECK
Remove the two-line label copy from `_emit_window_for_asset` in
`openddil-tactical-agents/edge/faust_edge.py`, restart `faust-edge-01`, and
run this again: the declared asset's window arrives with no nation, which
is a violation of the first half, and the test fails naming the topic, the
asset, and the declared value it should have carried.

HISTORY IS REPORTED, NOT JUDGED
A Kafka topic keeps what was written to it, including records written by
code that has since been fixed -- and including the deliberately broken
record the red check above produces. So the test takes a per-partition
offset baseline before it injects anything, and a violation is only a
FAILURE if it sits at or beyond that baseline. Everything older is reported
under its own heading as history.

This is not leniency. Judging history would make the test go green only by
deleting data, which teaches exactly the wrong habit about a log whose whole
value is that it is append-only; and it would leave a fix looking broken
forever. The history lines are still worth reading: they say what fusion
has already consumed, and a fix does not un-consume it.

RESULT VOCABULARY, AND WHY AN EMPTY TOPIC IS NOT A PASS
  FAIL  a violation was found, or a discovered handler has no decoder
  SKIP  no violation found, but at least one discovered topic held zero
        records and therefore proved nothing
  PASS  every discovered topic held records and every record obeyed the rule

An invariant test that goes green over empty topics is the failure this
whole slice is about -- deny-unlabeled means an unlabelled record is a legal
answer, so silence and correctness look identical. PASS here is a claim
about coverage as well as about content.

Usage:  python test_53_fusion_inputs_carry_labels.py
"""
from __future__ import annotations

import base64
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(
    0, str(Path(__file__).parents[3] / "openddil-contracts" / "gen" / "python"))

from _helpers import fail_, pass_, skip_  # noqa: E402

TEST = "fusion inputs carry releasability labels"

# Restate's admin API. The live answer to "what does fusion consume?".
SUBSCRIPTIONS_URL = "http://localhost:9070/subscriptions"

# The container that mounts the ASSEMBLED overlay. Read the declaration from
# there, not from the repo working tree: the assembled copy is the one the
# ingress mapper reads, and the gap between the two is the defect that
# started this arc.
DECLARATION_CONTAINER = "openddil-demo-redpanda-connect-01"
DECLARATION_PATH = "/ontology/releasability.yaml"

# Injection targets. The declared one must appear in the declaration; the
# undeclared one must not. Both are asserted below rather than assumed.
INJECT_CLUSTER = "openddil-edge-01"
INJECT_TOPIC = "raw-sensor-stream"
DECLARED_ASSET = "dis:1:1:1000"
UNDECLARED_ASSET = "dis:1:1:1099"
# faust_edge emits a window every WINDOW_EMIT_EVERY_N samples (default 5).
# Send more than that so an emission is not a boundary accident.
INJECT_SAMPLES = 7
SETTLE_S = 20.0

# Per (cluster, topic) read cap. Large enough to cover a demo run, small
# enough that a long-lived topic does not stall the suite.
READ_CAP = 500

DOCKER_TIMEOUT_S = 60


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------
def discover_fusion_inputs() -> list[tuple[str, str, str]]:
    """(cluster, topic, handler) for every Kafka subscription Restate holds.

    Raises rather than returning empty: zero subscriptions means Restate is
    not holding the wiring this test is about, and an empty list would
    otherwise sail through every check below and report success."""
    with urllib.request.urlopen(SUBSCRIPTIONS_URL, timeout=15) as resp:
        doc = json.loads(resp.read().decode("utf-8"))
    rows = doc.get("subscriptions") or []
    out: list[tuple[str, str, str]] = []
    for row in rows:
        source = row.get("source") or ""
        sink = row.get("sink") or ""
        if not source.startswith("kafka://"):
            continue
        rest = source[len("kafka://"):]
        cluster, _, topic = rest.partition("/")
        handler = sink.rsplit("/", 1)[-1] if sink else ""
        if cluster and topic:
            out.append((cluster, topic, handler))
    if not out:
        raise RuntimeError(
            f"{SUBSCRIPTIONS_URL} returned {len(rows)} rows and no Kafka "
            "subscriptions. Fusion's inputs cannot be discovered, so nothing "
            "below would be checked.")
    return sorted(set(out))


def broker_container(cluster: str) -> str:
    """The running broker container for a Restate cluster name.

    The host cannot reach the edge brokers directly -- they advertise the
    toxiproxy address, which does not resolve outside the compose network --
    so every read and write below goes through `rpk` inside the broker. The
    cluster->container step is derived from running containers rather than
    written down, and refuses anything other than exactly one match."""
    suffix = cluster[len("openddil-"):] if cluster.startswith("openddil-") else cluster
    want = f"redpanda-{suffix}"
    names = subprocess.run(
        ["docker", "ps", "--format", "{{.Names}}"],
        capture_output=True, text=True, timeout=DOCKER_TIMEOUT_S,
    ).stdout.split()
    matches = [n for n in names if want in n]
    if len(matches) != 1:
        raise RuntimeError(
            f"cluster {cluster!r} -> {len(matches)} running containers "
            f"matching {want!r} ({matches or 'none'}); expected exactly one")
    return matches[0]


# ---------------------------------------------------------------------------
# The declaration, read from the assembled overlay
# ---------------------------------------------------------------------------
def read_declaration() -> tuple[dict[str, tuple[str, list[str]]], str | None]:
    """(declared assets, document default) from the assembled overlay."""
    import yaml
    raw = subprocess.run(
        ["docker", "exec", DECLARATION_CONTAINER, "cat", DECLARATION_PATH],
        capture_output=True, text=True, timeout=DOCKER_TIMEOUT_S,
    )
    if raw.returncode != 0:
        raise RuntimeError(
            f"cannot read {DECLARATION_PATH} from {DECLARATION_CONTAINER}: "
            f"{raw.stderr.strip()}")
    doc = yaml.safe_load(raw.stdout) or {}
    assets = doc.get("assets") or {}
    declared = {
        aid: (str((row or {}).get("originator_nation") or ""),
              list((row or {}).get("releasable_to") or []))
        for aid, row in assets.items()
    }
    return declared, doc.get("default_originator_nation")


# ---------------------------------------------------------------------------
# Decoders, keyed on the fusion handler
# ---------------------------------------------------------------------------
def _labels_from_dict(d: dict) -> tuple[str, str, list[str]]:
    """(asset_id, nation, releasable_to) from a decoded record.

    Deliberately mirrors fusion's own `_extract_releasability`, including
    the cm-state top-level case and the camelCase/snake_case ambiguity that
    two live MessageToDict settings produce. A reader that was stricter than
    fusion would fail on records fusion accepts, and a reader that was
    looser would pass records fusion reads as unlabelled."""
    asset = (d.get("asset") or {})
    asset_id = (asset.get("assetId") or asset.get("asset_id")
                or d.get("assetId") or d.get("asset_id") or "")
    top = d.get("originator_nation") or d.get("originatorNation")
    if top:
        return asset_id, str(top), list(
            d.get("releasable_to") or d.get("releasableTo") or [])
    prov = d.get("provenance") or {}
    nation = prov.get("originatorNation") or prov.get("originator_nation") or ""
    rel = prov.get("releasableTo") or prov.get("releasable_to") or []
    return asset_id, str(nation), list(rel)


def _dec_proto(module: str, name: str):
    def decode(raw: bytes) -> tuple[str, str, list[str]]:
        from google.protobuf.json_format import MessageToDict
        mod = __import__(module, fromlist=[name])
        msg = getattr(mod, name)()
        msg.ParseFromString(raw)
        return _labels_from_dict(MessageToDict(msg))
    return decode


def _dec_json(raw: bytes) -> tuple[str, str, list[str]]:
    d = json.loads(raw.decode("utf-8"))
    return _labels_from_dict(d if isinstance(d, dict) else {})


def _dec_cm_state(raw: bytes) -> tuple[str, str, list[str]]:
    """JSON first, proto fallback -- the same tolerance fusion has."""
    try:
        return _dec_json(raw)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return _dec_proto("openddil.cm.v1.as_maintained_pb2",
                          "AsMaintainedConfiguration")(raw)


DECODERS = {
    "on_proprietary_update": _dec_proto(
        "openddil.telemetry.v1.telemetry_pb2", "EntityTelemetryEvent"),
    "on_derived_sustainment": _dec_proto(
        "openddil.telemetry.v1.telemetry_pb2", "EntityTelemetryEvent"),
    "on_telemetry_window": _dec_proto(
        "openddil.logistics.v1.windowed_telemetry_pb2", "WindowedTelemetry"),
    "on_cm_state_change": _dec_cm_state,
    "on_capability_snapshot": _dec_json,
}


# ---------------------------------------------------------------------------
# Broker I/O via rpk
# ---------------------------------------------------------------------------
def watermarks(container: str, topic: str) -> dict[int, tuple[int, int]] | None:
    """{partition: (log_start, high_watermark)}, or None if not describable.

    Per partition rather than summed, because the offset baseline that
    separates this run's records from history is a per-partition fact."""
    r = subprocess.run(
        ["docker", "exec", container, "rpk", "topic", "describe", "-p", topic],
        capture_output=True, text=True, timeout=DOCKER_TIMEOUT_S,
    )
    if r.returncode != 0:
        return None
    out: dict[int, tuple[int, int]] = {}
    for line in r.stdout.splitlines()[1:]:
        parts = line.split()
        if len(parts) >= 6 and parts[0].isdigit():
            out[int(parts[0])] = (int(parts[4]), int(parts[5]))
    return out or None


def consume(container: str, topic: str, n: int) -> list[tuple[int, int, bytes]]:
    """Exactly `n` records from the start as (partition, offset, value).

    `-n` is load-bearing: `rpk topic consume` without a record count tails
    forever and would hang the suite. The count comes from the watermarks,
    so it is never larger than what is there to read."""
    r = subprocess.run(
        ["docker", "exec", container, "rpk", "topic", "consume", topic,
         "-o", "start", "-n", str(n), "-f", "%p %o %v{base64}\n"],
        capture_output=True, text=True, timeout=DOCKER_TIMEOUT_S,
    )
    if r.returncode != 0:
        raise RuntimeError(f"rpk consume {topic}: {r.stderr.strip()[:200]}")
    out: list[tuple[int, int, bytes]] = []
    for line in r.stdout.splitlines():
        parts = line.strip().split(" ", 2)
        if len(parts) == 3 and parts[0].isdigit() and parts[1].isdigit():
            out.append((int(parts[0]), int(parts[1]),
                        base64.b64decode(parts[2])))
    return out


def produce(container: str, topic: str, records: list[tuple[str, bytes]]) -> None:
    payload = "".join(
        f"{base64.b64encode(k.encode()).decode()} "
        f"{base64.b64encode(v).decode()}\n"
        for k, v in records)
    r = subprocess.run(
        ["docker", "exec", "-i", container, "rpk", "topic", "produce", topic,
         "-f", "%k{base64} %v{base64}\n"],
        input=payload, capture_output=True, text=True, timeout=DOCKER_TIMEOUT_S,
    )
    if r.returncode != 0:
        raise RuntimeError(f"rpk produce {topic}: {r.stderr.strip()[:200]}")


# ---------------------------------------------------------------------------
# The injection that makes the windowing hop observable
# ---------------------------------------------------------------------------
def build_sustainment_event(asset_id: str, nation: str,
                            releasable: list[str], fuel_litres: float) -> bytes:
    from openddil.telemetry.v1 import telemetry_pb2 as tel
    evt = tel.EntityTelemetryEvent()
    evt.asset.asset_id = asset_id
    evt.asset.platform_variant = "TEST_WINDOW_PROBE"
    evt.provenance.producer_id = "test_53"
    evt.provenance.edge_id = "edge-01"
    evt.provenance.classification = "U"
    evt.provenance.sample_time.FromNanoseconds(int(time.time() * 1e9))
    # PROPAGATE, do not derive -- including here. The declared asset gets
    # exactly what the declaration says; the undeclared one gets nothing,
    # and nothing is not an empty string standing in for a value.
    if nation:
        evt.provenance.originator_nation = nation
        evt.provenance.releasable_to.extend(releasable)
    # The one field that makes faust_edge buffer anything at all.
    evt.sustainment.fluids.fuel_remaining.value = fuel_litres
    evt.sustainment.fluids.fuel_remaining.unit = "liter"
    return evt.SerializeToString()


def inject_window_traffic(container: str,
                          declared_labels: tuple[str, list[str]]) -> None:
    nation, releasable = declared_labels
    records: list[tuple[str, bytes]] = []
    for i in range(INJECT_SAMPLES):
        # A falling fuel level, so the samples are a trend and not a flat
        # line -- closer to what a real feed looks like going into a window.
        records.append((DECLARED_ASSET, build_sustainment_event(
            DECLARED_ASSET, nation, releasable, 400.0 - i * 5.0)))
        records.append((UNDECLARED_ASSET, build_sustainment_event(
            UNDECLARED_ASSET, "", [], 380.0 - i * 5.0)))
    produce(container, INJECT_TOPIC, records)


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
def main() -> None:
    try:
        inputs = discover_fusion_inputs()
    except (urllib.error.URLError, OSError, RuntimeError) as exc:
        skip_(TEST, f"cannot discover fusion inputs from Restate: {exc}")
        return

    handlers = sorted({h for _, _, h in inputs})
    print(f"discovered {len(inputs)} fusion input subscriptions across "
          f"{len({c for c, _, _ in inputs})} clusters, "
          f"{len({t for _, t, _ in inputs})} topics, "
          f"{len(handlers)} handlers")
    for c, t, h in inputs:
        print(f"    {c}/{t} -> {h}")
    print()

    unknown = [h for h in handlers if h not in DECODERS]
    if unknown:
        fail_(TEST,
              f"fusion consumes {unknown} and this test has no decoder for "
              "them. A fusion input nobody reads is exactly the gap this "
              "test exists to close, so an unknown handler is a failure, "
              "not a skip. Add a decoder to DECODERS.")
        return

    try:
        declared, default_nation = read_declaration()
    except Exception as exc:  # noqa: BLE001
        skip_(TEST, f"cannot read the assembled declaration: {exc}")
        return
    print(f"declaration: {len(declared)} assets, "
          f"default_originator_nation={default_nation!r}")
    if default_nation:
        skip_(TEST,
              "the declaration sets a document-wide default, so every asset "
              "is labelled and the undeclared half of the invariant cannot "
              "be observed. This test is written for a deployment that "
              "declines the default; see releasability.yaml's header.")
        return
    if DECLARED_ASSET not in declared or UNDECLARED_ASSET in declared:
        skip_(TEST,
              f"the injection assumes {DECLARED_ASSET} is declared and "
              f"{UNDECLARED_ASSET} is not; the assembled declaration "
              "disagrees, so the windowing hop cannot be exercised as "
              "written")
        return

    # --- the offset baseline, taken BEFORE anything is injected ----------
    # Everything at or beyond this is what THIS RUN observed and is judged.
    # Everything below it was written by whatever code was running at the
    # time and is reported as history. Taken here, before the injection,
    # so the injected records fall on the judged side.
    containers: dict[str, str] = {}
    baseline: dict[tuple[str, str], dict[int, int]] = {}
    for cluster, topic, _ in inputs:
        if cluster not in containers:
            try:
                containers[cluster] = broker_container(cluster)
            except RuntimeError:
                continue
        wm = watermarks(containers[cluster], topic)
        if wm:
            baseline[(cluster, topic)] = {p: hi for p, (_, hi) in wm.items()}

    # --- exercise the hop compose has no producer for --------------------
    try:
        inject_container = broker_container(INJECT_CLUSTER)
        print(f"injecting {INJECT_SAMPLES} sustainment samples for "
              f"{DECLARED_ASSET} (declared {declared[DECLARED_ASSET][0]}) and "
              f"{UNDECLARED_ASSET} (undeclared) onto "
              f"{INJECT_CLUSTER}/{INJECT_TOPIC}")
        print("    these two assets' labels on raw-sensor-stream are the "
              "TEST'S OWN; what is under test is whether faust-edge carries "
              "them onto asset-telemetry-windows")
        inject_window_traffic(inject_container, declared[DECLARED_ASSET])
        print(f"    settling {SETTLE_S:.0f}s")
        time.sleep(SETTLE_S)
    except Exception as exc:  # noqa: BLE001
        print(f"    injection failed: {exc}")
        print("    continuing -- the invariant still runs over whatever the "
              "system produced on its own")
    print()

    # --- the invariant ----------------------------------------------------
    violations: list[str] = []
    historic: list[str] = []
    unexercised: list[str] = []
    unreadable: list[str] = []
    checked = 0
    checked_historic = 0
    no_asset_id = 0

    def judge(asset_id: str, nation: str, rel: list[str]) -> str | None:
        """The invariant itself. Returns a complaint, or None."""
        if asset_id in declared:
            want_nation, want_rel = declared[asset_id]
            if nation != want_nation:
                return (f"{asset_id} is declared {want_nation!r} but the "
                        f"record carries {nation!r}")
            if set(rel) != set(want_rel):
                return (f"{asset_id} is declared releasable_to "
                        f"{sorted(want_rel)} but the record carries "
                        f"{sorted(rel)}")
            return None
        if nation:
            return (f"{asset_id} is not declared anywhere, yet the record "
                    f"carries nation {nation!r} -- a label was DERIVED, not "
                    "propagated")
        return None

    for cluster, topic, handler in inputs:
        container = containers.get(cluster)
        if container is None:
            unreadable.append(f"{cluster}/{topic}: no running broker container")
            continue
        wm = watermarks(container, topic)
        if wm is None:
            unreadable.append(f"{cluster}/{topic}: topic not describable")
            continue
        available = sum(hi - lo for lo, hi in wm.values())
        if available <= 0:
            unexercised.append(f"{cluster}/{topic}")
            continue
        base = baseline.get((cluster, topic), {})
        try:
            records = consume(container, topic, min(available, READ_CAP))
        except Exception as exc:  # noqa: BLE001
            unreadable.append(f"{cluster}/{topic}: {exc}")
            continue

        bad = old = fresh = 0
        for partition, offset, raw in records:
            is_history = offset < base.get(partition, 0)
            try:
                asset_id, nation, rel = DECODERS[handler](raw)
            except Exception as exc:  # noqa: BLE001
                complaint = (f"a record did not decode as the shape "
                             f"{handler} expects ({exc}); fusion would read "
                             "it as unlabelled")
                asset_id = ""
            else:
                complaint = judge(asset_id, nation, rel) if asset_id else None
            if is_history:
                checked_historic += 1
            else:
                checked += 1
                fresh += 1
            if not asset_id and complaint is None:
                # Cannot attribute, so cannot judge. Counted and reported
                # rather than quietly treated as compliant.
                no_asset_id += 1
                continue
            if complaint is None:
                continue
            where = f"{cluster}/{topic} p{partition}@{offset}"
            if is_history:
                old += 1
                if old <= 3:
                    historic.append(f"{where}: {complaint}")
            else:
                bad += 1
                if bad <= 3:
                    violations.append(f"{where}: {complaint}")

        note = f"{fresh} from this run"
        if old:
            note += f", {old} older violation(s) reported as history"
        status = "ok" if bad == 0 else f"{bad} violation(s)"
        print(f"    {cluster}/{topic}: {len(records)} of {available} records "
              f"read ({note}) -- {status}")

    print()
    print(f"judged {checked} records written at or after this run's baseline "
          f"({checked_historic} older records read and reported as history); "
          f"{no_asset_id} carried no asset_id and could not be attributed")
    if historic:
        print(f"{len(historic)} historic violation(s) -- written before this "
              "run, already consumed by fusion, NOT counted against the "
              "verdict:")
        for h in historic:
            print(f"    {h}")
    if unreadable:
        print(f"{len(unreadable)} topic(s) could not be read:")
        for u in unreadable:
            print(f"    {u}")
    if unexercised:
        print(f"{len(unexercised)} discovered fusion input(s) held zero "
              "records and therefore proved nothing:")
        for u in unexercised:
            print(f"    {u}")
    print()

    if violations:
        head = "; ".join(violations[:6])
        more = f" (+{len(violations) - 6} more)" if len(violations) > 6 else ""
        fail_(TEST, f"{len(violations)} violation(s): {head}{more}")
        return
    if unreadable or unexercised:
        skip_(TEST,
              f"no violation in {checked} records, but "
              f"{len(unexercised)} input(s) held nothing and "
              f"{len(unreadable)} could not be read, so this is not yet a "
              "claim about every fusion input")
        return
    pass_(TEST,
          f"{checked} records across {len(inputs)} discovered fusion inputs, "
          "every one labelled exactly as the declaration says or not at all")


if __name__ == "__main__":
    main()
