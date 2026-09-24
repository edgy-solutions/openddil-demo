"""Egress gate: predicted counts, measured — ADR-0043 Arc 2 Slice 2.

WHAT THIS PROVES, AND WHAT IT DELIBERATELY DOES NOT
It proves that the running gate, asked by a running PDP, admits toward the C2
stand-in exactly the records the declared fleet says it should, and refuses
the rest with a reason recorded for each one. It does NOT prove the ingest
chain labels anything: these records are produced straight onto
asset-logistics-status from the SAME declaration file the ingress mapping
stamps from (ontology/releasability.yaml). Reading the labels out of the
authored declaration rather than inventing them is what keeps this a
measurement of the gate rather than a measurement of the fixture.

THE PREDICTION IS WRITTEN DOWN BEFORE IT IS MEASURED, in ADR-0043 and again
in egress/test_gate.py. A test that computed its expectation from the same
data it is checking would agree with itself no matter what the gate did, so
the numbers below are literals.

Run: `python tests/hero_scenario_v3/test_50_egress_gate_counts.py`
Needs: redpanda-hq, topaz, egress-gate-c2.
"""
from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(
    0, str(Path(__file__).parents[3] / "openddil-contracts" / "gen" / "python"))

import yaml  # noqa: E402
from _cm_helpers import KAFKA_BOOTSTRAP, docker_compose  # noqa: E402
from _helpers import fail_, pass_, skip_  # noqa: E402

TEST = "test_50_egress_gate_counts"
DECLARATION = Path(__file__).parents[2] / "ontology" / "releasability.yaml"
SOURCE_TOPIC = "asset-logistics-status"
SINK_TOPIC = "egress-c2-status"
GATE_CONTAINER = "openddil-demo-egress-gate-c2"

# THE PREDICTION, as literals.
PREDICTED_ADMITTED = 8
PREDICTED_REFUSED_NO_OVERLAP = 6

# The two red-check records. Keys outside the declared fleet's id space, so a
# compacted topic can never confuse them with a real asset's latest status.
REDCHECK_UNLABELLED = "redcheck:unlabelled"
REDCHECK_CLASSIFIED = "redcheck:classified"


def declared_fleet() -> list[tuple[str, str, list[str]]]:
    """(asset_id, originator_nation, releasable_to) straight from the corpus."""
    doc = yaml.safe_load(DECLARATION.read_text(encoding="utf-8"))
    default = doc.get("default_originator_nation") or ""
    out = []
    for asset_id, entry in (doc.get("assets") or {}).items():
        entry = entry or {}
        out.append((
            asset_id,
            entry.get("originator_nation") or default,
            list(entry.get("releasable_to") or []),
        ))
    return sorted(out)


def build_proto(nation: str, releasable: list[str]) -> bytes:
    from openddil.logistics.v1 import logistics_status_pb2

    msg = logistics_status_pb2.AssetLogisticsStatusUpdate()
    msg.provenance.originator_nation = nation
    msg.provenance.releasable_to.extend(releasable)
    return msg.SerializeToString()


def produce(records: list[tuple[str, bytes]]) -> None:
    from confluent_kafka import Producer

    p = Producer({"bootstrap.servers": KAFKA_BOOTSTRAP})
    for key, value in records:
        p.produce(SOURCE_TOPIC, key=key.encode(), value=value)
    p.flush(20)


def distinct_keys_on_sink(expect_at_least: int, timeout_s: int = 45) -> set[str]:
    """Every key currently present on the egress topic.

    DISTINCT keys, not a record count: the topic is compacted and this test
    may have been run before, so "how many messages are there" is a question
    about compaction timing, while "which assets has the gate admitted" is the
    question actually being asked.
    """
    from confluent_kafka import Consumer

    c = Consumer({
        "bootstrap.servers": KAFKA_BOOTSTRAP,
        "group.id": f"egress-count-{int(time.time())}",
        "auto.offset.reset": "earliest",
        "enable.auto.commit": False,
    })
    c.subscribe([SINK_TOPIC])
    keys: set[str] = set()
    deadline = time.time() + timeout_s
    settled = 0
    try:
        while time.time() < deadline:
            msg = c.poll(1.0)
            if msg is None:
                settled += 1
                if keys and settled >= 4 and len(keys) >= expect_at_least:
                    break
                continue
            if msg.error():
                continue
            settled = 0
            if msg.key():
                keys.add(msg.key().decode("utf-8", "replace"))
    finally:
        c.close()
    return keys


def gate_decisions(since: str) -> list[dict]:
    """The gate's own decision log, parsed.

    Read from the container's stdout rather than inferred from a sink topic,
    because a refusal by definition produces nothing downstream: if refusals
    were only countable by subtraction, "refused" and "never arrived" would be
    the same observation — which is the property the gate exists to deny.
    """
    proc = subprocess.run(
        docker_compose() + ["logs", "--since", since, "--no-log-prefix",
                            "egress-gate-c2"],
        capture_output=True, text=True,
    )
    out = proc.stdout
    if "DECISION {" not in out:
        proc = subprocess.run(
            ["docker", "logs", "--since", since, GATE_CONTAINER],
            capture_output=True, text=True)
        out = proc.stdout + proc.stderr
    decisions = []
    for line in out.splitlines():
        marker = line.find("DECISION {")
        if marker == -1:
            continue
        try:
            decisions.append(json.loads(line[marker + len("DECISION "):]))
        except json.JSONDecodeError:
            continue
    return decisions


def main() -> int:
    if not DECLARATION.exists():
        skip_(TEST, f"no releasability declaration at {DECLARATION}")
        return 0

    alive = subprocess.run(
        ["docker", "inspect", "-f", "{{.State.Running}}", GATE_CONTAINER],
        capture_output=True, text=True)
    if alive.returncode != 0 or alive.stdout.strip() != "true":
        skip_(TEST, f"{GATE_CONTAINER} is not running")
        return 0

    fleet = declared_fleet()
    if len(fleet) != 14:
        skip_(TEST,
              f"declaration has {len(fleet)} assets; the prediction is for 14")
        return 0

    # THE TRAILING Z IS load-BEARING. `docker logs --since` reads a
    # timestamp without a zone as LOCAL time, so a UTC instant handed
    # over bare lands hours in the future and the command returns an
    # empty log — which reads exactly like a gate that decided nothing.
    started = time.strftime("%Y-%m-%dT%H:%M:%SZ",
                            time.gmtime(time.time() - 5))

    records = [(a, build_proto(n, r)) for a, n, r in fleet]
    # RED CHECK 1 — unlabelled. proto3 puts an unset string and an empty
    # repeated field on the wire identically to a producer that declared
    # nothing, which is the whole reason deny-unlabelled has to be the floor.
    records.append((REDCHECK_UNLABELLED, build_proto("", [])))
    # RED CHECK 2 — a record carrying a marking on an axis this gate does not
    # evaluate. Sent as JSON because the Provenance message has no
    # classification field: the fence guards against a producer that starts
    # carrying one, and JSON is the shape such a producer would arrive in
    # before the proto ever changed.
    records.append((REDCHECK_CLASSIFIED, json.dumps({
        "asset_id": REDCHECK_CLASSIFIED,
        "originator_nation": "ATL",       # would pass the releasability axis
        "releasable_to": ["BDR"],         # outright, and is refused anyway
        "classification": "S//NF",
    }).encode()))

    produce(records)
    time.sleep(12)

    keys = distinct_keys_on_sink(PREDICTED_ADMITTED)
    fleet_keys = {a for a, _, _ in fleet}
    redcheck_keys = {REDCHECK_UNLABELLED, REDCHECK_CLASSIFIED}
    admitted_fleet = keys & fleet_keys
    admitted_redcheck = keys & redcheck_keys

    decisions = gate_decisions(started)
    if not decisions:
        fail_(TEST, "the gate logged no decisions; nothing can be said "
                    "about what it did")
        return 1

    # ONE DECISION PER RECORD is what "nothing is dropped silently" reduces
    # to. Checked over the keys this run produced, since the gate may have
    # been running before it.
    ours = [d for d in decisions if d.get("key") in fleet_keys | redcheck_keys]
    missing = (fleet_keys | redcheck_keys) - {d["key"] for d in ours}
    if missing:
        fail_(TEST, f"{len(missing)} records crossed with no decision logged: "
                    f"{sorted(missing)[:5]}")
        return 1

    latest = {d["key"]: d for d in ours}
    refused = {k: d for k, d in latest.items() if d["outcome"] != "admit"}
    by_reason: dict[str, int] = {}
    for d in refused.values():
        by_reason[d["reason"]] = by_reason.get(d["reason"], 0) + 1

    problems = []
    if len(admitted_fleet) != PREDICTED_ADMITTED:
        problems.append(
            f"admitted {len(admitted_fleet)} of the fleet, predicted "
            f"{PREDICTED_ADMITTED}: {sorted(admitted_fleet)}")
    if by_reason.get("no_nation_overlap", 0) != PREDICTED_REFUSED_NO_OVERLAP:
        problems.append(
            f"no_nation_overlap refusals {by_reason.get('no_nation_overlap', 0)}"
            f", predicted {PREDICTED_REFUSED_NO_OVERLAP}")
    if admitted_redcheck:
        problems.append(
            f"RED CHECK FAILED — the gate forwarded {sorted(admitted_redcheck)}")
    if latest[REDCHECK_UNLABELLED]["reason"] != "unlabelled":
        problems.append("unlabelled record refused for the wrong reason: "
                        f"{latest[REDCHECK_UNLABELLED]['reason']}")
    if latest[REDCHECK_CLASSIFIED]["reason"] != "classification_not_evaluated":
        problems.append("marked record refused for the wrong reason: "
                        f"{latest[REDCHECK_CLASSIFIED]['reason']}")

    if problems:
        fail_(TEST, "; ".join(problems))
        return 1

    pass_(TEST, f"admitted {len(admitted_fleet)}/14 as predicted; "
                f"refusals {by_reason}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
