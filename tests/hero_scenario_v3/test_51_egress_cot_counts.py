"""CoT bridge: predicted counts, measured at the TAK server — ADR-0043 Arc 2
Slice 2 / the Contract A -> CoT bridge.

WHAT THIS PROVES, AND WHAT IT DELIBERATELY DOES NOT
It proves that a CoT event reaches the TAK stand-in for exactly the records
the gate admitted toward c2-stand-in-atl in THIS run, carrying the same
release label the declaration says that asset has — and that it does NOT
reach the TAK stand-in for a record the gate refused. It does not re-decide
releasability; it checks that the adapter said, in CoT, what the gate already
decided. See egress/cot_adapter.py's module docstring for the fence that
keeps the adapter from becoming a second decision point.

THE NONCE is what makes this a measurement of THIS run rather than of every
run this compose project has ever produced: the sink topic is compacted but
the adapter's consumer group is new exactly once, so a stale answer here
would be indistinguishable from a correct one without something per-run to
filter on. `status_revision` carries it because it is the one Contract A
field this test can set that the adapter also carries onto the wire
unchanged (`detail/openddil_status/@status_revision`).

THE PREDICTION IS WRITTEN DOWN BEFORE IT IS MEASURED (see
c:\\tmp\\overnight-1001\\C4\\PREDICT.md, P1-P6). The literals below are repeated
here as the actual pass condition, not computed from what is observed.

Run: `py -3 tests/hero_scenario_v3/test_51_egress_cot_counts.py`
Needs: redpanda-hq, topaz, egress-gate-c2, tak-server, egress-cot-adapter-c2.
"""
from __future__ import annotations

import re
import socket
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(
    0, str(Path(__file__).parents[3] / "openddil-contracts" / "gen" / "python"))

from _cm_helpers import KAFKA_BOOTSTRAP  # noqa: E402
from _helpers import fail_, pass_, skip_  # noqa: E402
import test_50_egress_gate_counts as t50  # noqa: E402

TEST = "test_51_egress_cot_counts"
TAK_HOST = "localhost"
TAK_PORT = 8087
ADAPTER_CONTAINER = "openddil-demo-egress-cot-adapter-c2"
PROBE_UID = "openddil-c2-probe"

# THE PREDICTION, as literals (PREDICT.md P1-P5).
PREDICTED_COT_EVENTS = 8          # distinct admitted uids carrying this nonce
PREDICTED_COT_FOR_REFUSED = 0     # of the 6 no_nation_overlap refusals
PREDICTED_COT_FOR_REDCHECK = 0    # of the 2 red-check records

EVENT_RE = re.compile(rb"<event\b.*?</event>", re.DOTALL)


def build_proto(nation: str, releasable: list, asset_id: str, nonce: int) -> bytes:
    """Same provenance shape as test_50's build_proto, plus a `status` block
    so the adapter has something to carry onto `openddil_status` and a
    status_revision this run can filter on. `status.asset_id` is also set to
    the nonce per the build spec; it never reaches the wire's `uid` or
    `openddil_status/@asset_id`, because build_event() in cot_adapter.py
    prefers the Kafka key (the real asset id, forwarded byte-for-byte by the
    gate) over `status.asset_id` for both."""
    from openddil.logistics.v1 import logistics_status_pb2

    msg = logistics_status_pb2.AssetLogisticsStatusUpdate()
    msg.provenance.originator_nation = nation
    msg.provenance.releasable_to.extend(releasable)
    msg.status.asset_id = str(nonce)
    msg.status.status_revision = nonce
    return msg.SerializeToString()


def identify_probe(sock: socket.socket) -> None:
    """Send one minimal SA event so the probe looks like a TAK client to any
    reader that cares, even though it does not have to here.

    taky's COTRouter.broadcast() (taky/cot/router.py) sends every event to
    every entry in self.clients regardless of whether client.user has been
    set — identification is not a precondition for receiving a broadcast on
    this server. client.user is only populated when handle_atom() (taky/cot/
    client.py) sees a <detail> containing all of TAKUSER_TAGS = {"takv",
    "contact", "__group"} (taky/cot/models/takuser.py). This event is sent
    anyway, defensively, because a real TAK client always identifies first
    and a probe that silently depended on taky's specific leniency would stop
    being a useful stand-in for one that doesn't.
    """
    now = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
    event = ET.Element("event", {
        "version": "2.0", "uid": PROBE_UID, "type": "a-f-G-U-C", "how": "m-g",
        "time": now, "start": now, "stale": now,
    })
    ET.SubElement(event, "point", {
        "lat": "0.0", "lon": "0.0", "hae": "0.0", "ce": "9999999.0", "le": "9999999.0",
    })
    detail = ET.SubElement(event, "detail")
    ET.SubElement(detail, "takv", {"os": "", "device": "", "version": "", "platform": "openddil-test"})
    ET.SubElement(detail, "contact", {"callsign": PROBE_UID})
    ET.SubElement(detail, "__group", {"name": "Cyan", "role": "Team Member"})
    sock.sendall(ET.tostring(event, encoding="utf-8"))


def collect_events(sock: socket.socket, quiet_s: float = 6.0, timeout_s: float = 60.0) -> list[ET.Element]:
    """Read raw CoT off the wire until it goes quiet, or until timeout_s.

    "Settle when quiet" rather than "read exactly N": the adapter also
    replays everything already on the compacted sink topic from prior runs,
    so the stream does not stop after this run's events — it just stops
    producing NEW ones. The nonce filter (done by the caller) is what tells
    this run's events apart from that replay; this function's only job is to
    not cut the read off mid-burst.
    """
    sock.settimeout(1.0)
    buf = b""
    events: list[ET.Element] = []
    deadline = time.time() + timeout_s
    last_data = time.time()
    while time.time() < deadline:
        try:
            chunk = sock.recv(65536)
        except socket.timeout:
            chunk = b""
        if chunk:
            buf += chunk
            last_data = time.time()
            for match in EVENT_RE.finditer(buf):
                try:
                    events.append(ET.fromstring(match.group(0)))
                except ET.ParseError:
                    continue
            buf = EVENT_RE.sub(b"", buf)
        elif time.time() - last_data >= quiet_s and events:
            break
    return events


def main() -> int:
    if not t50.DECLARATION.exists():
        skip_(TEST, f"no releasability declaration at {t50.DECLARATION}")
        return 0

    for container in (t50.GATE_CONTAINER, ADAPTER_CONTAINER):
        alive = subprocess.run(
            ["docker", "inspect", "-f", "{{.State.Running}}", container],
            capture_output=True, text=True)
        if alive.returncode != 0 or alive.stdout.strip() != "true":
            skip_(TEST, f"{container} is not running")
            return 0

    fleet = t50.declared_fleet()
    if len(fleet) != 14:
        skip_(TEST,
              f"declaration has {len(fleet)} assets; the prediction is for 14")
        return 0

    nonce = int(time.time() * 1000)

    sock = socket.create_connection((TAK_HOST, TAK_PORT), timeout=10)
    try:
        identify_probe(sock)

        started = time.strftime("%Y-%m-%dT%H:%M:%SZ",
                                time.gmtime(time.time() - 5))

        records = [(a, build_proto(n, r, a, nonce)) for a, n, r in fleet]
        records.append((t50.REDCHECK_UNLABELLED, build_proto("", [], t50.REDCHECK_UNLABELLED, nonce)))
        records.append((t50.REDCHECK_CLASSIFIED, __import__("json").dumps({
            "asset_id": t50.REDCHECK_CLASSIFIED,
            "originator_nation": "ATL",
            "releasable_to": ["BDR"],
            "classification": "S//NF",
            "status": {"asset_id": t50.REDCHECK_CLASSIFIED, "status_revision": nonce},
        }).encode()))

        t50.produce(records)

        events = collect_events(sock)
    finally:
        sock.close()

    by_uid: dict[str, ET.Element] = {}
    for event in events:
        status = event.find("detail/openddil_status")
        if status is None:
            continue
        if status.get("status_revision") != str(nonce):
            continue
        by_uid[event.get("uid")] = event  # last one wins; keys are distinct per uid already

    cot_uids = set(by_uid)

    decisions = t50.gate_decisions(started)
    if not decisions:
        fail_(TEST, "the gate logged no decisions for this run")
        return 1
    fleet_keys = {a for a, _, _ in fleet}
    redcheck_keys = {t50.REDCHECK_UNLABELLED, t50.REDCHECK_CLASSIFIED}
    ours = [d for d in decisions if d.get("key") in fleet_keys | redcheck_keys]
    latest = {d["key"]: d for d in ours}
    admit_set = {k for k, d in latest.items() if d.get("outcome") == "admit"}
    refused_no_overlap = {k for k, d in latest.items()
                           if d.get("reason") == "no_nation_overlap"}

    declared = {a: (n, tuple(r)) for a, n, r in fleet}

    problems = []
    if len(cot_uids) != PREDICTED_COT_EVENTS:
        problems.append(
            f"got {len(cot_uids)} distinct CoT uids for this run, predicted "
            f"{PREDICTED_COT_EVENTS}: {sorted(cot_uids)}")

    cot_for_refused = cot_uids & refused_no_overlap
    if len(cot_for_refused) != PREDICTED_COT_FOR_REFUSED:
        problems.append(
            f"{len(cot_for_refused)} CoT events for no_nation_overlap "
            f"refusals, predicted {PREDICTED_COT_FOR_REFUSED}: "
            f"{sorted(cot_for_refused)}")

    cot_for_redcheck = cot_uids & redcheck_keys
    if len(cot_for_redcheck) != PREDICTED_COT_FOR_REDCHECK:
        problems.append(
            f"{len(cot_for_redcheck)} CoT events for red-check records, "
            f"predicted {PREDICTED_COT_FOR_REDCHECK}: {sorted(cot_for_redcheck)}")

    if cot_uids != admit_set:
        problems.append(
            f"CoT uid set != gate admit set. CoT-only: "
            f"{sorted(cot_uids - admit_set)}; admit-only: "
            f"{sorted(admit_set - cot_uids)}")

    mismatched_release = []
    for uid in sorted(cot_uids & declared.keys()):
        nation, releasable = declared[uid]
        release = by_uid[uid].find("detail/openddil_release")
        got_nation = release.get("originator_nation") if release is not None else None
        got_releasable = tuple(
            c.get("nation") for c in release.findall("releasable_to")
        ) if release is not None else ()
        if (got_nation or None) != (nation or None) or got_releasable != releasable:
            mismatched_release.append(
                f"{uid}: declared ({nation!r},{releasable}) got "
                f"({got_nation!r},{got_releasable})")
    if mismatched_release:
        problems.append("release mismatch: " + "; ".join(mismatched_release))

    print(f"{'uid':<16}{'nation':<8}{'releasable_to':<20}{'admit':<7}{'cot'}")
    for uid in sorted(fleet_keys | redcheck_keys):
        nation, releasable = declared.get(uid, (None, ()))
        print(f"{uid:<16}{str(nation):<8}{str(list(releasable)):<20}"
              f"{'y' if uid in admit_set else 'n':<7}"
              f"{'y' if uid in cot_uids else 'n'}")

    if problems:
        fail_(TEST, "; ".join(problems))
        return 1

    pass_(TEST, f"{len(cot_uids)}/{PREDICTED_COT_EVENTS} CoT events as "
                f"predicted; uid set matches the gate's admit set; all "
                f"releases match the declaration")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
