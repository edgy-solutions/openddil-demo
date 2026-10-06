"""
Test 57 — Fire/Detonation PDUs divert to effector-events, not the fleet feed.

dis_effector (dynamic-mappings/dis-effector.yaml) sits ahead of both
dis_kind_gate and dis_force_gate: a Fire or Detonation PDU is not an Entity
State, so neither gate has an opinion about it, and it is routed straight
to its own topic instead of being forced through a pipeline built for
platform tracks. The fixture is one engagement between two launchers and
one target:

  launcher A = dis:1:1:57001, launcher B = dis:1:1:57002, target T = dis:1:1:57010

  Fire:        E1 A->T, E2 A->T, E3 A (no target), E4 B->T, E5 B (no target)
  Detonation:  E1 result=1, E2 result=3, E4 result=6

Six assertions. The second, third and fourth are the ones that matter —
they are what distinguishes "diverted" from "silently dropped" or "sent to
the wrong place":

  1. effector-events gains exactly 8 records (5 fire + 3 detonation),
     checked two ways: the topic's total high-watermark moves by exactly
     +8, AND the exact per-partition offset range [before, after) written
     by this run — not "the last N records", which cannot tell this run's
     output apart from an earlier, byte-identical run's — holds exactly 8
     records whose event_urns are exactly dis-event:1:1:{1..5} (fire) and
     dis-event:1:1:{1,2,4} (detonation), each appearing once; each record
     is keyed by its launcher_urn — 3 fire + 2 detonation keyed to
     launcher A, 2 fire + 1 detonation keyed to launcher B; and every
     record's provenance.edge_id is the sensor-ingest that actually
     received it (edge-01, stamped by dis_ingestor.py at ingest — the
     Connect-layer mapping only forwards this field, never originates it)
  2. raw-sensor-stream's high-watermark does not move at all while the 8
     PDUs are sent — Fire/Detonation never reaches the platform-tracking
     feed, so there is nothing to mistake for a platform update
  3. dis_ingress_kind_dropped and dis_ingress_force_dropped (summed across
     all label series) are unchanged — the divert happens before both
     gates, so neither gate ever sees these PDUs, and neither counter is
     the right place to look for them
  4. ingress-dlq's high-watermark is unchanged — a Fire/Detonation PDU is
     not malformed data, so it must not land in the dead-letter queue
  5. dis_effector_routed{pdu_type="fire"} increases by exactly 5 and
     dis_effector_routed{pdu_type="detonation"} by exactly 3
  6. a control kind=1 force=1 Entity State PDU sent in the same window
     still reaches raw-sensor-stream (HWM +1) — guards against a divert
     that swallows the whole feed and would otherwise pass (2) vacuously

Without (2) this test would pass for a divert that forwards Fire/
Detonation onto raw-sensor-stream as well as effector-events, which is the
kind of double-delivery that makes every downstream consumer of that topic
wrong. Without (6), a divert that has started eating ALL traffic —
including ordinary Entity State PDUs — would still show "0 fire/detonation
on raw-sensor-stream" and pass assertion (2) for the worst possible reason.
Without (3) a kind/force gate accidentally reordered ahead of the divert
would count these PDUs as kind or force drops instead of routing them, and
nothing here would catch it.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _helpers import (  # noqa: E402
    TOPIC_DLQ,
    TOPIC_EFFECTOR,
    TOPIC_SILVER,
    build_detonation_pdu,
    build_entity_state_pdu,
    build_fire_pdu,
    consume_topic_records_range,
    fail_,
    metric_sum,
    metric_value_labeled,
    partition_high_watermarks,
    pass_,
    query_postgres,
    scrape_connect_metrics,
    send_udp_bytes,
    skip_,
    topic_high_watermark,
)

NAME = "test_57_effector_ingest"

SITE = 1
APPLICATION = 1
LAUNCHER_A = 57001
LAUNCHER_B = 57002
TARGET_T = 57010
CONTROL_ENTITY = 57099

LAUNCHER_A_URN = f"dis:{SITE}:{APPLICATION}:{LAUNCHER_A}"
LAUNCHER_B_URN = f"dis:{SITE}:{APPLICATION}:{LAUNCHER_B}"

# send_udp_bytes with no edge_id routes to edge-01 (sensor-ingest-01) by
# default -- see its docstring. That is the process that stamps
# provenance.edge_id on these records, so this is what every record in
# this fixture's slice must carry.
EXPECTED_EDGE_ID = "edge-01"

METRIC_ROUTED = "dis_effector_routed"
METRIC_KIND = "dis_ingress_kind_dropped"
METRIC_FORCE = "dis_ingress_force_dropped"

# (event_number, firing_entity, target_entity_or_None)
FIRES = [
    (1, LAUNCHER_A, TARGET_T),
    (2, LAUNCHER_A, TARGET_T),
    (3, LAUNCHER_A, None),
    (4, LAUNCHER_B, TARGET_T),
    (5, LAUNCHER_B, None),
]
# (event_number, firing_entity, target_entity_or_None, detonation_result)
DETONATIONS = [
    (1, LAUNCHER_A, TARGET_T, 1),
    (2, LAUNCHER_A, TARGET_T, 3),
    (4, LAUNCHER_B, TARGET_T, 6),
]

EXPECTED_FIRE_URNS = {f"dis-event:{SITE}:{APPLICATION}:{n}" for n, _, _ in FIRES}
EXPECTED_DET_URNS = {f"dis-event:{SITE}:{APPLICATION}:{n}"
                     for n, _, _, _ in DETONATIONS}


def _hw(topic: str) -> int:
    """Watermark, or fail the test. NOT `or 0` — see test_56's note: a
    topic this cannot read must fail the check, not read as empty."""
    hw = topic_high_watermark(topic)
    if hw is None:
        fail_(NAME, f"could not read high-watermark for {topic} — "
                    f"cannot judge whether anything landed")
    return hw


def _rows_for(asset_id: str) -> int:
    return int(query_postgres(
        "select count(*) from telemetry_latest_state "
        f"where asset_id = '{asset_id}'")[0][0])


def main() -> None:
    baseline_text = scrape_connect_metrics()
    if not baseline_text:
        skip_(NAME, "Connect metrics endpoint unreachable — cannot judge the divert")

    routed_fire_before = metric_value_labeled(
        baseline_text, METRIC_ROUTED, {"pdu_type": "fire"})
    routed_det_before = metric_value_labeled(
        baseline_text, METRIC_ROUTED, {"pdu_type": "detonation"})
    kind_dropped_before = metric_sum(baseline_text, METRIC_KIND)
    force_dropped_before = metric_sum(baseline_text, METRIC_FORCE)

    silver_before = _hw(TOPIC_SILVER)
    dlq_before = _hw(TOPIC_DLQ)
    effector_before = _hw(TOPIC_EFFECTOR)

    # Per-partition watermarks, taken immediately around the send, bound
    # EXACTLY this run's contribution to effector-events -- see
    # `partition_high_watermarks`'s docstring. The topic is never reset
    # between runs and the fixture is byte-for-byte identical every run, so
    # a window wide enough to be "comfortable" is also wide enough to
    # include a prior run's matching records; only an exact [before, after)
    # slice proves THIS run's own output is correct.
    before_wm = partition_high_watermarks(TOPIC_EFFECTOR)

    # --- send the fixture: 5 fire + 3 detonation --------------------------
    for event_number, firing, target in FIRES:
        send_udp_bytes(build_fire_pdu(
            site=SITE, application=APPLICATION, event_number=event_number,
            firing_entity=firing, target_entity=target))
    for event_number, firing, target, result in DETONATIONS:
        send_udp_bytes(build_detonation_pdu(
            site=SITE, application=APPLICATION, event_number=event_number,
            firing_entity=firing, target_entity=target,
            detonation_result=result))
    time.sleep(3.0)

    # --- 1: effector-events gains exactly 8 records, right urns, right keys
    effector_after = _hw(TOPIC_EFFECTOR)
    if effector_after != effector_before + 8:
        fail_(NAME,
              f"{TOPIC_EFFECTOR} did not move by exactly +8 (watermark "
              f"{effector_before} -> {effector_after})")

    after_wm = partition_high_watermarks(TOPIC_EFFECTOR)

    # Exact [before, after) slice per partition -- THIS run's records only,
    # never a prior run's, even though the fixture is byte-for-byte
    # identical every time and the topic is never reset.
    records = consume_topic_records_range(TOPIC_EFFECTOR, before_wm, after_wm,
                                          timeout_s=15)
    parsed = []
    for rec in records:
        v = rec.get("value")
        if isinstance(v, str):
            try:
                v = json.loads(v)
            except (ValueError, TypeError):
                continue
        if isinstance(v, dict):
            parsed.append((rec.get("key"), v))

    if len(parsed) != 8:
        fail_(NAME, f"{TOPIC_EFFECTOR} exact slice held {len(parsed)} "
                    f"records, expected exactly 8: {parsed}")

    fire_recs = [(k, v) for k, v in parsed if v.get("pdu_type") == "fire"]
    det_recs = [(k, v) for k, v in parsed if v.get("pdu_type") == "detonation"]

    fire_urn_list = [v["event_urn"] for _, v in fire_recs]
    det_urn_list = [v["event_urn"] for _, v in det_recs]
    if sorted(fire_urn_list) != sorted(EXPECTED_FIRE_URNS):
        fail_(NAME, f"fire event_urns in {TOPIC_EFFECTOR}'s exact slice were "
                    f"{sorted(fire_urn_list)}, expected each of "
                    f"{sorted(EXPECTED_FIRE_URNS)} exactly once")
    if sorted(det_urn_list) != sorted(EXPECTED_DET_URNS):
        fail_(NAME, f"detonation event_urns in {TOPIC_EFFECTOR}'s exact "
                    f"slice were {sorted(det_urn_list)}, expected each of "
                    f"{sorted(EXPECTED_DET_URNS)} exactly once")

    # Expected key per event_urn, derived from the fixture itself.
    expected_key_by_urn = {
        f"dis-event:{SITE}:{APPLICATION}:{n}":
            LAUNCHER_A_URN if firing == LAUNCHER_A else LAUNCHER_B_URN
        for n, firing, _ in FIRES
    }
    expected_key_by_urn.update({
        f"dis-event:{SITE}:{APPLICATION}:{n}":
            LAUNCHER_A_URN if firing == LAUNCHER_A else LAUNCHER_B_URN
        for n, firing, _, _ in DETONATIONS
    })

    bad_keys = {}
    for k, v in fire_recs + det_recs:
        urn = v["event_urn"]
        if k != expected_key_by_urn[urn]:
            bad_keys.setdefault(urn, set()).add(k)
    if bad_keys:
        fail_(NAME, f"{TOPIC_EFFECTOR} records keyed wrong: {bad_keys} — "
                    f"expected {expected_key_by_urn}")

    # Exact per-launcher tallies -- valid now that the slice is exact.
    fire_a = sum(1 for k, _ in fire_recs if k == LAUNCHER_A_URN)
    fire_b = sum(1 for k, _ in fire_recs if k == LAUNCHER_B_URN)
    det_a = sum(1 for k, _ in det_recs if k == LAUNCHER_A_URN)
    det_b = sum(1 for k, _ in det_recs if k == LAUNCHER_B_URN)
    if (fire_a, det_a, fire_b, det_b) != (3, 2, 2, 1):
        fail_(NAME, f"{TOPIC_EFFECTOR} keying was fire_a={fire_a} det_a="
                    f"{det_a} fire_b={fire_b} det_b={det_b}, expected "
                    f"fire_a=3 det_a=2 fire_b=2 det_b=1")

    # Every record's provenance.edge_id must be the sensor-ingest that
    # actually received it -- stamped by dis_ingestor.py at ingest, the
    # same way remove_entity/entity_state carry it; dis-effector.yaml only
    # forwards the field, it does not originate it.
    bad_provenance = {
        v.get("event_urn"): v.get("provenance")
        for _, v in parsed
        if (v.get("provenance") or {}).get("edge_id") != EXPECTED_EDGE_ID
    }
    if bad_provenance:
        fail_(NAME, f"{TOPIC_EFFECTOR} records with wrong/missing "
                    f"provenance.edge_id (expected {EXPECTED_EDGE_ID!r}): "
                    f"{bad_provenance}")

    # --- 2: raw-sensor-stream does not move for the fixture ---------------
    silver_mid = _hw(TOPIC_SILVER)
    if silver_mid != silver_before:
        fail_(NAME,
              f"{TOPIC_SILVER} moved while sending Fire/Detonation PDUs "
              f"({silver_before} -> {silver_mid}) — they must divert to "
              f"{TOPIC_EFFECTOR} only, never also reach the platform feed")

    # --- 3: kind/force drop counters unmoved -------------------------------
    after_text = scrape_connect_metrics()
    kind_dropped_after = metric_sum(after_text, METRIC_KIND)
    force_dropped_after = metric_sum(after_text, METRIC_FORCE)
    if kind_dropped_after != kind_dropped_before:
        fail_(NAME,
              f"{METRIC_KIND} (summed) moved on Fire/Detonation traffic "
              f"({kind_dropped_before} -> {kind_dropped_after}) — the "
              f"divert must happen before dis_kind_gate ever runs")
    if force_dropped_after != force_dropped_before:
        fail_(NAME,
              f"{METRIC_FORCE} (summed) moved on Fire/Detonation traffic "
              f"({force_dropped_before} -> {force_dropped_after}) — the "
              f"divert must happen before dis_force_gate ever runs")

    # --- 4: ingress-dlq unmoved ---------------------------------------------
    dlq_after = _hw(TOPIC_DLQ)
    if dlq_after != dlq_before:
        fail_(NAME,
              f"{TOPIC_DLQ} moved on well-formed Fire/Detonation traffic "
              f"({dlq_before} -> {dlq_after}) — these are not malformed")

    # --- 5: dis_effector_routed by pdu_type ---------------------------------
    routed_fire_after = metric_value_labeled(
        after_text, METRIC_ROUTED, {"pdu_type": "fire"})
    routed_det_after = metric_value_labeled(
        after_text, METRIC_ROUTED, {"pdu_type": "detonation"})
    if routed_fire_after - routed_fire_before != 5:
        fail_(NAME,
              f'{METRIC_ROUTED}{{pdu_type="fire"}} did not increase by '
              f"exactly 5 ({routed_fire_before} -> {routed_fire_after})")
    if routed_det_after - routed_det_before != 3:
        fail_(NAME,
              f'{METRIC_ROUTED}{{pdu_type="detonation"}} did not increase '
              f"by exactly 3 ({routed_det_before} -> {routed_det_after})")

    # --- 6: control ESPDU still reaches raw-sensor-stream -------------------
    send_udp_bytes(build_entity_state_pdu(
        site=SITE, application=APPLICATION, entity=CONTROL_ENTITY,
        kind=1, domain=1, country=225, category=1, subcategory=1,
        specific=2, extra=0, force_id=1, marking="GATE-CTRL"))
    time.sleep(3.0)

    silver_after = _hw(TOPIC_SILVER)
    if silver_after != silver_mid + 1:
        fail_(NAME,
              f"control Entity State PDU did not move {TOPIC_SILVER} by "
              f"exactly +1 (watermark {silver_mid} -> {silver_after}) — "
              f"either the divert is eating ordinary platform traffic too, "
              f"or it under/over-delivered")

    # --- extra: no stray read-model rows for the 5700x fixture ids ---------
    # Fire/Detonation never reach raw-sensor-stream, so none of these ids
    # should ever be seen by the projector. Checked, not assumed.
    stray = [a for a in (LAUNCHER_A_URN, LAUNCHER_B_URN,
                         f"dis:{SITE}:{APPLICATION}:{TARGET_T}")
            if _rows_for(a) != 0]
    if stray:
        fail_(NAME,
              f"telemetry_latest_state has rows for fixture ids that never "
              f"should have reached the projector: {stray}")

    pass_(NAME,
          f"{TOPIC_EFFECTOR} exact slice = 8 (5 fire, 3 detonation), right "
          f"event_urns, right keys (fire_a=3 det_a=2 fire_b=2 det_b=1), "
          f"provenance.edge_id={EXPECTED_EDGE_ID!r} on all 8; "
          f"{TOPIC_SILVER} unmoved for the fixture then +1 for the control; "
          f"{TOPIC_DLQ} unmoved; kind/force drop counters unmoved; "
          f"{METRIC_ROUTED} fire +5 ({routed_fire_before:.0f} -> "
          f"{routed_fire_after:.0f}) detonation +3 ({routed_det_before:.0f} "
          f"-> {routed_det_after:.0f}); no stray read-model rows")


if __name__ == "__main__":
    main()
