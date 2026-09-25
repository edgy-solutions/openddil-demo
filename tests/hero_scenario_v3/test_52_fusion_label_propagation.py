"""Do the labels survive the chain to the guarded topic? — ADR-0043, Contract B.

WHAT THIS PROVES THAT test_50 DOES NOT
test_50 produces records straight onto `asset-logistics-status` from the
authored declaration and measures what the gate does with them. That is a
measurement of the GATE. It says nothing about whether anything upstream ever
puts a label on a record, and the compose stack spent its whole existence
labelling nothing while every releasability test passed, because an unlabelled
record is refused and a refusal is the expected answer for an undeclared asset.

So this test does not author a single label. It sends DIS PDUs at the sidecar
and reads what comes out the far end. Every label it finds was put there by
the ingress mapping reading the same `/ontology/releasability.yaml` the
assembler checked, carried by whatever hops lie between, and stamped onto the
guarded topic by fusion's own propagation. If any hop drops it, this fails.

THE NO-NATION CASE IS THE ONE THAT MATTERS
`dis:1:1:1099` is not in the declaration. It is site 1, which in this fiction
correlates perfectly with ATL — every naming habit in the fleet says it is an
Atlantian asset, and nothing is allowed to read that. It must arrive at the
gate unlabelled and be refused as `unlabelled`, which is a different fact from
`no_nation_overlap`: the latter means "we know the author and you are not on
the list", and saying it here would mean some hop had invented an author.

That refusal is the record the gate refuses on the C2's behalf, and it is what
Contract A has to say out loud: a consumer that cannot carry these labels gets
this decision made for it, finally, here.

THE PREDICTION, WRITTEN BEFORE THE RUN, as literals below. A test that read
its expectation out of the row it is checking would agree with itself no
matter what the chain did.

  P1  declared     dis:1:1:1000 -> originator_nation ATL, releasable_to [BDR]
  P2  no-nation    dis:1:1:1099 -> originator_nation absent, releasable_to []
  P3  gate         P1 admitted toward the ATL stand-in; P2 refused
                   `unlabelled`, NOT `no_nation_overlap`
  P4  windowing    asset-telemetry-windows carries NO nation for either asset.
                   faust-edge builds a fresh provenance and copies edge_id,
                   region_id, producer_id and sample_time but not the labels,
                   so the windowed path is lossy. P1 survives anyway because
                   raw-sensor-stream is a direct fusion input and fusion's
                   stored label is sticky — one labelled inbound is enough.
                   An asset reaching fusion ONLY through windows would be
                   indistinguishable at the gate from an undeclared one.

Run: `python tests/hero_scenario_v3/test_52_fusion_label_propagation.py`
Needs: sensor-ingest-01, redpanda-connect-01, restate-server,
logistics-fusion-service (+ its bootstrap), redpanda-edge-01, redpanda-hq,
topaz, egress-gate-c2. Skips cleanly when any of them is down.
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

from _cm_helpers import KAFKA_BOOTSTRAP, docker_compose  # noqa: E402
from _helpers import (  # noqa: E402
    build_entity_state_pdu,
    fail_,
    pass_,
    send_udp_bytes,
    skip_,
)

TEST = "test_52_fusion_label_propagation"

DECLARED_URN = "dis:1:1:1000"
DECLARED_ENTITY = 1000
UNDECLARED_URN = "dis:1:1:1099"
UNDECLARED_ENTITY = 1099

# P1 / P2 — the labels, as literals.
PREDICTED_DECLARED_NATION = "ATL"
PREDICTED_DECLARED_RELEASABLE = ["BDR"]
PREDICTED_UNDECLARED_NATION = ""
PREDICTED_UNDECLARED_RELEASABLE: list[str] = []

# P3 — the gate's verdicts, as literals.
PREDICTED_DECLARED_OUTCOME = "admit"
PREDICTED_UNDECLARED_REASON = "unlabelled"

STATUS_TOPIC = "asset-logistics-status"
WINDOWS_TOPIC = "asset-telemetry-windows"
GATE_CONTAINER = "openddil-demo-egress-gate-c2"

REQUIRED = [
    "openddil-demo-sensor-ingest-01",
    "openddil-demo-redpanda-connect-01",
    "openddil-demo-restate-server",
    "openddil-demo-logistics-fusion-service",
    GATE_CONTAINER,
]

# Fusion emits on a timer; EMIT_INTERVAL_SECONDS is 30 in compose. Two
# intervals plus the chain's own latency, and the PDUs keep arriving
# throughout so a tick can never land on an empty window.
PDU_BURSTS = 8
PDU_INTERVAL_S = 6.0
SETTLE_S = 45.0


def running(container: str) -> bool:
    p = subprocess.run(["docker", "inspect", "-f", "{{.State.Running}}",
                        container], capture_output=True, text=True)
    return p.returncode == 0 and p.stdout.strip() == "true"


def send_pdus() -> None:
    """Both assets, same shape, same burst. The ONLY difference between them
    is whether the declaration names them."""
    for i in range(PDU_BURSTS):
        for entity, marking in ((DECLARED_ENTITY, "DECLARED"),
                                (UNDECLARED_ENTITY, "UNDECLD")):
            send_udp_bytes(build_entity_state_pdu(
                site=1, application=1, entity=entity, marking=marking,
                location_ecef=(1.1e6 + i * 500.0, 4.5e6, 4.2e6),
            ))
        if i < PDU_BURSTS - 1:
            time.sleep(PDU_INTERVAL_S)


def read_status_labels(timeout_s: float = 60.0) -> dict[str, tuple[str, list]]:
    """{asset_id: (originator_nation, releasable_to)} from the guarded topic.

    The LATEST row per asset wins: fusion's stored label is sticky, so an
    early emission that predates the first labelled inbound is a real and
    expected state of the world, not a counterexample.
    """
    from confluent_kafka import Consumer
    from openddil.logistics.v1 import logistics_status_pb2 as ls

    c = Consumer({
        "bootstrap.servers": KAFKA_BOOTSTRAP,
        "group.id": f"fusion-label-{int(time.time())}",
        "auto.offset.reset": "earliest",
        "enable.auto.commit": False,
    })
    c.subscribe([STATUS_TOPIC])
    seen: dict[str, tuple[str, list]] = {}
    deadline = time.time() + timeout_s
    idle = 0
    try:
        while time.time() < deadline:
            msg = c.poll(1.0)
            if msg is None:
                idle += 1
                if idle >= 5 and seen:
                    break
                continue
            if msg.error():
                continue
            idle = 0
            upd = ls.AssetLogisticsStatusUpdate()
            try:
                upd.ParseFromString(msg.value())
            except Exception:  # noqa: BLE001 - a foreign byte string is not a row
                continue
            aid = upd.status.asset_id
            if not aid:
                continue
            seen[aid] = (upd.provenance.originator_nation,
                         list(upd.provenance.releasable_to))
    finally:
        c.close()
    return seen


EDGE_CONTAINER = "openddil-demo-redpanda-edge-01-1"


def window_high_watermark() -> int | None:
    """Total records on asset-telemetry-windows, or None if unreadable.

    Read with rpk INSIDE the broker container. The host cannot reach this
    cluster's group coordinator: :19092 advertises `toxiproxy:8474`, which
    resolves only on the compose network. A reader that quietly returned
    nothing here would report "no windows produced" for a network fact,
    which is the same shape of mistake as the one this whole test exists
    to catch.
    """
    proc = subprocess.run(
        ["docker", "exec", EDGE_CONTAINER, "rpk", "topic", "describe",
         WINDOWS_TOPIC, "-p"],
        capture_output=True, text=True, timeout=30)
    if proc.returncode != 0:
        return None
    total = 0
    for line in proc.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 6 and parts[0].isdigit() and parts[-1].isdigit():
            total += int(parts[-1])
    return total


def read_window_labels(n: int = 20) -> list[str]:
    """originator_nation per windowed record, read through the broker."""
    from openddil.logistics.v1 import windowed_telemetry_pb2 as winpb

    proc = subprocess.run(
        ["docker", "exec", EDGE_CONTAINER, "rpk", "topic", "consume",
         WINDOWS_TOPIC, "--offset", f"-{n}", "-n", str(n),
         "-f", "%v{base64}\n"],
        capture_output=True, text=True, timeout=60)
    if proc.returncode != 0:
        return []
    import base64
    out = []
    for line in proc.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            w = winpb.WindowedTelemetry()
            w.ParseFromString(base64.b64decode(line))
        except Exception:  # noqa: BLE001
            continue
        if w.asset_id:
            out.append(w.provenance.originator_nation)
    return out


def gate_decisions(since: str) -> list[dict]:
    """The gate's own decision log. A refusal produces nothing downstream, so
    counting refusals by subtraction would make `refused` and `never arrived`
    the same observation — the property the gate exists to deny."""
    proc = subprocess.run(
        docker_compose() + ["logs", "--since", since, "--no-log-prefix",
                            "egress-gate-c2"],
        capture_output=True, text=True)
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
    down = [c for c in REQUIRED if not running(c)]
    if down:
        skip_(TEST, f"chain incomplete, not running: {', '.join(down)}")
        return 0

    # The trailing Z is load-bearing: `docker logs --since` reads a zone-less
    # timestamp as LOCAL time, which lands hours in the future.
    since = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z"

    send_pdus()
    time.sleep(SETTLE_S)

    status = read_status_labels()
    if DECLARED_URN not in status:
        fail_(TEST, f"no {STATUS_TOPIC} row for the DECLARED asset "
                    f"{DECLARED_URN}; saw {sorted(status)[:6]}. The chain did "
                    f"not produce, so nothing about labels is measured here.")
        return 1
    if UNDECLARED_URN not in status:
        fail_(TEST, f"no {STATUS_TOPIC} row for the undeclared asset "
                    f"{UNDECLARED_URN}; saw {sorted(status)[:6]}")
        return 1

    dec_nation, dec_rel = status[DECLARED_URN]
    und_nation, und_rel = status[UNDECLARED_URN]

    if dec_nation != PREDICTED_DECLARED_NATION:
        fail_(TEST, f"P1: {DECLARED_URN} reached {STATUS_TOPIC} with "
                    f"originator_nation {dec_nation!r}, predicted "
                    f"{PREDICTED_DECLARED_NATION!r}. Some hop dropped or "
                    f"rewrote the label the ingress mapping stamped.")
        return 1
    if sorted(dec_rel) != sorted(PREDICTED_DECLARED_RELEASABLE):
        fail_(TEST, f"P1: {DECLARED_URN} releasable_to {dec_rel}, predicted "
                    f"{PREDICTED_DECLARED_RELEASABLE}")
        return 1

    if und_nation != PREDICTED_UNDECLARED_NATION:
        fail_(TEST, f"P2: {UNDECLARED_URN} is NOT in the declaration and "
                    f"reached {STATUS_TOPIC} carrying originator_nation "
                    f"{und_nation!r}. Something defaulted. The declaration is "
                    f"the only thing allowed to answer this question.")
        return 1
    if und_rel != PREDICTED_UNDECLARED_RELEASABLE:
        fail_(TEST, f"P2: {UNDECLARED_URN} releasable_to {und_rel}, predicted "
                    f"{PREDICTED_UNDECLARED_RELEASABLE}")
        return 1

    # P3 -- what the gate did with each.
    decisions = gate_decisions(since)
    by_key: dict[str, dict] = {}
    for d in decisions:
        k = d.get("key") or ""
        if k in (DECLARED_URN, UNDECLARED_URN):
            by_key[k] = d
    if DECLARED_URN not in by_key or UNDECLARED_URN not in by_key:
        fail_(TEST, f"P3: the gate logged {len(decisions)} decisions since "
                    f"{since} but not one for each of the two assets; saw "
                    f"{sorted(by_key)}")
        return 1

    dec_d, und_d = by_key[DECLARED_URN], by_key[UNDECLARED_URN]
    if dec_d.get("outcome") != PREDICTED_DECLARED_OUTCOME:
        fail_(TEST, f"P3: the gate outcome for {DECLARED_URN} was "
                    f"{dec_d.get('outcome')!r} "
                    f"(reason {dec_d.get('reason')!r}); predicted "
                    f"{PREDICTED_DECLARED_OUTCOME!r}")
        return 1
    if und_d.get("reason") != PREDICTED_UNDECLARED_REASON:
        fail_(TEST, f"P3: the gate refused {UNDECLARED_URN} with reason "
                    f"{und_d.get('reason')!r}, predicted "
                    f"{PREDICTED_UNDECLARED_REASON!r}. "
                    f"`no_nation_overlap` here would mean a hop invented an "
                    f"author for an asset nobody declared.")
        return 1

    # P4 -- the windowed path is lossy. This records what was actually
    # observable rather than asserting the prediction away: an empty topic
    # is not evidence either way, and saying so is the point.
    hw = window_high_watermark()
    if hw is None:
        win_note = f"{WINDOWS_TOPIC}: unreadable, P4 not exercised"
    elif hw == 0:
        win_note = (f"{WINDOWS_TOPIC}: 0 records, so P4 is NOT exercised by "
                    f"this run -- faust-edge emits only once a window holds "
                    f"enough samples for a trend, and these PDUs carry no "
                    f"fluid or thermal metrics to trend")
    else:
        nations = read_window_labels()
        labelled = [n for n in nations if n]
        if labelled:
            win_note = (f"{WINDOWS_TOPIC}: {len(nations)} records, "
                        f"{len(labelled)} LABELLED -- P4 was wrong, faust-edge "
                        f"propagates after all")
        else:
            win_note = (f"{WINDOWS_TOPIC}: {len(nations)} records, none "
                        f"labelled, as predicted (lossy hop)")

    pass_(TEST,
          f"{DECLARED_URN} reached {STATUS_TOPIC} as "
          f"{dec_nation}/{dec_rel} and was {dec_d.get('outcome')}ted; "
          f"{UNDECLARED_URN} reached it unlabelled and was refused "
          f"{und_d.get('reason')!r}; {win_note}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
