"""
Test 56 — DIS forces are admitted by declaration, and refusals are counted.

The gate (dynamic-mappings/dis-force-gate.yaml) sits right after
dis_kind_gate and answers a different question: not "is this entity kind a
fleet member" but "is this entity's force one we track." An edge is a
sensor for its own side; the default admits force=1 (Friendly) only, so an
Opposing or Neutral Entity State PDU reported by the co-located simulator
is refused the same way a munition kind is — counted, not dead-lettered,
and never reaches raw-sensor-stream.

Five assertions. The fourth and fifth are the ones that matter:

  1. a kind=1, force=2 PDU increments dis_ingress_force_dropped{force="2"}
     by exactly 1
  2. that PDU adds NOTHING to raw-sensor-stream and nothing to ingress-dlq
     -- a refused force is a policy decision, not malformed data
  3. a kind=1, force=1 PDU still lands on raw-sensor-stream
  4. a kind=2, force=2 PDU increments dis_ingress_kind_dropped{kind="2"}
     and does NOT move dis_ingress_force_dropped{force="2"} -- the kind
     gate runs first and deletes the message, so the force gate never
     sees it; a munition from an opposing force is counted once, by kind
  5. a Remove Entity for the force-2 id from (1) passes the gate: raw-
     sensor-stream HWM +1, and no telemetry_latest_state row for that id
     -- the gate is stateless and cannot tell a fleet member's removal
     from a refused force's, so it does not try, and a removal for an id
     that was never admitted creates nothing downstream

Without (3) this test passes for a gate that drops the entire feed, which
is a total ingress outage that looks like a clean deploy. Without (4) it
passes for a gate that double-counts a kind=2 PDU from an opposing force
as both a kind drop and a force drop, which would make either counter
meaningless as a signal of how much traffic a given gate refused. Without
(5) a refused force's removal would be dropped as unreachable, or worse,
would create the fleet member the gate kept out.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _helpers import (  # noqa: E402
    TOPIC_DLQ,
    TOPIC_SILVER,
    build_entity_state_pdu,
    build_remove_entity_pdu,
    fail_,
    metric_value_labeled,
    pass_,
    query_postgres,
    scrape_connect_metrics,
    send_udp_bytes,
    skip_,
    topic_high_watermark,
)

NAME = "test_56_dis_force_gate"

ADMITTED_KIND = 1        # PLATFORM
GATED_KIND = 2            # MUNITION (for assertion 4, via dis_kind_gate)
ADMITTED_FORCE = 1        # Friendly
REFUSED_FORCE = 2         # Opposing
METRIC_FORCE = "dis_ingress_force_dropped"
METRIC_KIND = "dis_ingress_kind_dropped"

REFUSED_FORCE_ENTITY = 56001
ADMITTED_ENTITY = 56002
KIND_AND_FORCE_ENTITY = 56003
REFUSED_FORCE_ID = f"dis:1:1:{REFUSED_FORCE_ENTITY}"


def _rows_for(asset_id: str) -> int:
    return int(query_postgres(
        "select count(*) from telemetry_latest_state "
        f"where asset_id = '{asset_id}'")[0][0])


def _hw(topic: str) -> int:
    """Watermark, or fail the test. NOT `or 0`.

    topic_high_watermark returns None when it cannot read the topic, and
    coercing that to 0 is how this suite's leak assertions became `0 > 0`
    and stopped being able to fail (see test_54's note on this). A gate
    test that cannot read the topic must say so, not pass.
    """
    hw = topic_high_watermark(topic)
    if hw is None:
        fail_(NAME, f"could not read high-watermark for {topic} — "
                    f"cannot judge whether anything landed")
    return hw


def _pdu(kind: int, force: int, entity: int, marking: str) -> bytes:
    return build_entity_state_pdu(
        site=1, application=1, entity=entity,
        kind=kind, domain=1, country=225, category=1, subcategory=1,
        specific=2, extra=0, force_id=force, marking=marking,
    )


def main() -> None:
    baseline_text = scrape_connect_metrics()
    if not baseline_text:
        # Distinguished from "series absent" deliberately: an unreachable
        # endpoint would otherwise read as a zero counter and this test
        # would pass by failing to look.
        skip_(NAME, "Connect metrics endpoint unreachable — cannot judge the gate")

    force_dropped_before = metric_value_labeled(
        baseline_text, METRIC_FORCE, {"force": str(REFUSED_FORCE)})
    kind_dropped_before = metric_value_labeled(
        baseline_text, METRIC_KIND, {"kind": str(GATED_KIND)})
    silver_before = _hw(TOPIC_SILVER)
    dlq_before = _hw(TOPIC_DLQ)

    # --- 1 + 2: admitted kind, refused force -----------------------------
    send_udp_bytes(_pdu(ADMITTED_KIND, REFUSED_FORCE, REFUSED_FORCE_ENTITY,
                        "GATE-FORCE"))
    time.sleep(3.0)

    force_dropped_after = metric_value_labeled(
        scrape_connect_metrics(), METRIC_FORCE, {"force": str(REFUSED_FORCE)})
    delta = force_dropped_after - force_dropped_before
    if delta != 1:
        fail_(NAME,
              f'{METRIC_FORCE}{{force="{REFUSED_FORCE}"}} did not increase '
              f"by exactly 1 ({force_dropped_before} -> {force_dropped_after}, "
              f"delta={delta})")

    silver_mid = _hw(TOPIC_SILVER)
    if silver_mid > silver_before:
        fail_(NAME,
              f"force={REFUSED_FORCE} leaked onto {TOPIC_SILVER} "
              f"(watermark {silver_before} -> {silver_mid})")

    dlq_mid = _hw(TOPIC_DLQ)
    if dlq_mid > dlq_before:
        fail_(NAME,
              f"force={REFUSED_FORCE} was dead-lettered to {TOPIC_DLQ} "
              f"(watermark {dlq_before} -> {dlq_mid}) — a refused force is "
              f"a policy decision, not an error")

    # --- 3: the admitted force still flows -------------------------------
    send_udp_bytes(_pdu(ADMITTED_KIND, ADMITTED_FORCE, ADMITTED_ENTITY,
                        "GATE-FRIENDLY"))
    time.sleep(3.0)

    silver_after = _hw(TOPIC_SILVER)
    if silver_after <= silver_mid:
        fail_(NAME,
              f"force={ADMITTED_FORCE} did NOT reach {TOPIC_SILVER} "
              f"(watermark stuck at {silver_mid}) — the gate is refusing "
              f"admitted traffic, which is an ingress outage, not a guard")

    # --- 4: kind gate runs first; no double counting ---------------------
    # A kind=2, force=2 PDU is refused by dis_kind_gate before dis_force_gate
    # ever sees it (the kind gate deletes the message). It must be counted
    # once, by kind, not again as a force drop.
    send_udp_bytes(_pdu(GATED_KIND, REFUSED_FORCE, KIND_AND_FORCE_ENTITY,
                        "GATE-BOTH"))
    time.sleep(3.0)

    kind_dropped_after = metric_value_labeled(
        scrape_connect_metrics(), METRIC_KIND, {"kind": str(GATED_KIND)})
    if kind_dropped_after <= kind_dropped_before:
        fail_(NAME,
              f'{METRIC_KIND}{{kind="{GATED_KIND}"}} did not increase '
              f"({kind_dropped_before} -> {kind_dropped_after}) — a munition "
              f"from a refused force was not counted at all")

    force_dropped_final = metric_value_labeled(
        scrape_connect_metrics(), METRIC_FORCE, {"force": str(REFUSED_FORCE)})
    if force_dropped_final != force_dropped_after:
        fail_(NAME,
              f'{METRIC_FORCE}{{force="{REFUSED_FORCE}"}} moved on a '
              f"kind-gated message ({force_dropped_after} -> "
              f"{force_dropped_final}) — it was counted twice, once by "
              f"each gate")

    # --- 5: a removal for the refused-force id passes the gate -----------
    # The gate passes it: it has no memory of what it refused. What keeps
    # it from creating an asset is downstream, where the ids live.
    if _rows_for(REFUSED_FORCE_ID) != 0:
        fail_(NAME, f"precondition: {REFUSED_FORCE_ID} already has a "
                    f"telemetry_latest_state row; this step cannot judge "
                    f"whether a removal creates one")

    silver_before_removal = _hw(TOPIC_SILVER)
    send_udp_bytes(build_remove_entity_pdu(site=1, application=1,
                                           entity=REFUSED_FORCE_ENTITY))
    time.sleep(3.0)

    silver_removed = _hw(TOPIC_SILVER)
    if silver_removed != silver_before_removal + 1:
        fail_(NAME,
              f"a removal for refused-force id {REFUSED_FORCE_ID} did not "
              f"move {TOPIC_SILVER} by exactly +1 (watermark "
              f"{silver_before_removal} -> {silver_removed}) -- the gate "
              f"drops removals of ids it never admitted")

    if _rows_for(REFUSED_FORCE_ID) != 0:
        fail_(NAME, f"a removal for refused-force id {REFUSED_FORCE_ID} "
                    f"created a telemetry_latest_state row")

    pass_(NAME,
          f"force={REFUSED_FORCE} refused and counted "
          f"({force_dropped_before:.0f} -> {force_dropped_after:.0f}), no "
          f"DLQ entry, force={ADMITTED_FORCE} still admitted; kind={GATED_KIND}"
          f"+force={REFUSED_FORCE} counted once by kind "
          f"({kind_dropped_before:.0f} -> {kind_dropped_after:.0f}), force "
          f"counter unmoved; refused-force removal through the gate, no row")


if __name__ == "__main__":
    main()
