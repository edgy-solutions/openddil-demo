"""
Test 54 — DIS entity kinds are admitted by declaration, and refusals are counted.

The gate (dynamic-mappings/dis-kind-gate.yaml) exists because a kind=2
MUNITION Entity State PDU was measured entering the fleet as an asset with
platform_variant=UNKNOWN, and two properties made that permanent: `kind` is
absent from the asset_id, so no fleet query can exclude munitions by key
pattern; and there is no eviction path, so a round admitted once stays a
member. See openddil-helm/scripts/FINDING-2026-09-26-kind2-munition-resolution.md.

Five assertions. The third and fifth are the ones that matter:

  1. a kind=2 PDU increments dis_ingress_kind_dropped{kind="2"}
  2. a kind=2 PDU adds NOTHING to raw-sensor-stream, and nothing to
     ingress-dlq — a gated kind is a policy decision, not malformed data
  3. a kind=1 PDU still lands on raw-sensor-stream
  4. a Remove Entity for the id admitted in (3) lands on raw-sensor-stream
  5. a Remove Entity for an id that was never admitted also passes the gate
     (it is stateless), and creates nothing: no telemetry_latest_state row,
     and the projector, AssetCM and AssetLogistics each count it as a
     removal for an unknown key

Without (3) this test passes for a gate that drops the entire feed, which is a
total ingress outage that looks like a clean deploy. Without (4) it passes for
a gate that drops every removal, which it did: a removal carries no entity
type, and read as kind 0 it was refused. Without (5) a munition's removal
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
    metric_sum,
    metric_value_labeled,
    pass_,
    query_postgres,
    scrape_connect_metrics,
    scrape_service_metrics,
    send_udp_bytes,
    skip_,
    topic_high_watermark,
)

NAME = "test_54_dis_kind_gate"

GATED_KIND = 2        # MUNITION
ADMITTED_KIND = 1     # PLATFORM
METRIC = "dis_ingress_kind_dropped"
UNSEEN_ENTITY = 54003
UNSEEN_ID = f"dis:1:1:{UNSEEN_ENTITY}"

# Where a removal for an unknown key is resolved, and the counter each one
# keeps: (compose service, metrics port, series). The projector's port is
# the compose METRICS_PORT; the Restate services use their default.
UNKNOWN_REMOVAL_COUNTERS = {
    "projector": (
        ["openddil-projector-01", "openddil-projector-02",
         "openddil-projector-03", "openddil-projector-hq"],
        8084, "projector_removal_unknown_asset_dropped_total"),
    "AssetCM": (["cm-service"], 9464,
                "cm_removal_unknown_asset_dropped_total"),
    "AssetLogistics": (["logistics-fusion-service"], 9464,
                       "logistics_removal_unknown_asset_dropped_total"),
}


def _unknown_removal_counts() -> dict[str, float]:
    """One total per resolver. Fails, never zeroes, when a resolver cannot
    be read or does not carry the series: an image without the drop would
    otherwise read as "nothing counted yet" and step 5 could only fail late,
    for the wrong reason."""
    out = {}
    for who, (services, port, series) in UNKNOWN_REMOVAL_COUNTERS.items():
        total = None
        for svc in services:
            v = metric_sum(scrape_service_metrics(svc, port), series)
            if v is not None:
                total = (total or 0.0) + v
        if total is None:
            fail_(NAME, f"{who}: no {series} series on "
                        f"{', '.join(services)}:{port} -- cannot judge the "
                        f"unknown-key removal drop")
        out[who] = total
    return out


def _rows_for(asset_id: str) -> int:
    return int(query_postgres(
        "select count(*) from telemetry_latest_state "
        f"where asset_id = '{asset_id}'")[0][0])


def _hw(topic: str) -> int:
    """Watermark, or fail the test. NOT `or 0`.

    topic_high_watermark returns None when it cannot read the topic, and
    coercing that to 0 is how this suite's leak assertions became `0 > 0` and
    stopped being able to fail (see the note on that function). A gate test
    that cannot read the topic must say so, not pass.
    """
    hw = topic_high_watermark(topic)
    if hw is None:
        fail_(NAME, f"could not read high-watermark for {topic} — "
                    f"cannot judge whether anything landed")
    return hw


def _pdu(kind: int, entity: int, marking: str) -> bytes:
    return build_entity_state_pdu(
        site=1, application=1, entity=entity,
        kind=kind, domain=1, country=225, category=1, subcategory=1,
        specific=2, extra=0, marking=marking,
    )


def main() -> None:
    baseline_text = scrape_connect_metrics()
    if not baseline_text:
        # Distinguished from "series absent" deliberately: an unreachable
        # endpoint would otherwise read as a zero counter and this test would
        # pass by failing to look.
        skip_(NAME, "Connect metrics endpoint unreachable — cannot judge the gate")

    dropped_before = metric_value_labeled(baseline_text, METRIC,
                                          {"kind": str(GATED_KIND)})
    silver_before = _hw(TOPIC_SILVER)
    dlq_before = _hw(TOPIC_DLQ)

    # --- 1 + 2: the gated kind ------------------------------------------
    send_udp_bytes(_pdu(GATED_KIND, 54002, "GATE-MUNITION"))
    time.sleep(3.0)

    dropped_after = metric_value_labeled(scrape_connect_metrics(), METRIC,
                                         {"kind": str(GATED_KIND)})
    if dropped_after <= dropped_before:
        fail_(NAME,
              f'{METRIC}{{kind="{GATED_KIND}"}} did not increase '
              f"({dropped_before} -> {dropped_after}) — the drop is silent")

    silver_mid = _hw(TOPIC_SILVER)
    if silver_mid > silver_before:
        fail_(NAME,
              f"kind={GATED_KIND} leaked onto {TOPIC_SILVER} "
              f"(watermark {silver_before} -> {silver_mid})")

    dlq_mid = _hw(TOPIC_DLQ)
    if dlq_mid > dlq_before:
        fail_(NAME,
              f"kind={GATED_KIND} was dead-lettered to {TOPIC_DLQ} "
              f"(watermark {dlq_before} -> {dlq_mid}) — a gated kind is a "
              f"policy decision, not an error")

    # --- 3: the admitted kind still flows -------------------------------
    send_udp_bytes(_pdu(ADMITTED_KIND, 54001, "GATE-PLATFORM"))
    time.sleep(3.0)

    silver_after = _hw(TOPIC_SILVER)
    if silver_after <= silver_mid:
        fail_(NAME,
              f"kind={ADMITTED_KIND} did NOT reach {TOPIC_SILVER} "
              f"(watermark stuck at {silver_mid}) — the gate is refusing "
              f"admitted traffic, which is an ingress outage, not a guard")

    # --- 4: a removal for the id admitted in 3 goes through ---------------
    # A Remove Entity PDU carries no entity type, so kind cannot decide it:
    # read as kind 0, every removal was dropped, and a fleet member could
    # never be removed.
    send_udp_bytes(build_remove_entity_pdu(site=1, application=1,
                                           entity=54001))
    time.sleep(3.0)

    silver_removed = _hw(TOPIC_SILVER)
    if silver_removed <= silver_after:
        fail_(NAME,
              f"a removal for admitted id 54001 did NOT reach {TOPIC_SILVER} "
              f"(watermark stuck at {silver_after}) -- the gate drops "
              f"removals of fleet members")

    # --- 5: a removal for an id that was never admitted -------------------
    # The gate passes it: it has no memory of what it admitted. What keeps it
    # from creating an asset is downstream, where the ids live.
    if _rows_for(UNSEEN_ID) != 0:
        fail_(NAME, f"precondition: {UNSEEN_ID} already has a "
                    f"telemetry_latest_state row; this step cannot judge "
                    f"whether a removal creates one")
    counts_before = _unknown_removal_counts()
    send_udp_bytes(build_remove_entity_pdu(site=1, application=1,
                                           entity=UNSEEN_ENTITY))

    deadline = time.monotonic() + 30.0
    while True:
        time.sleep(3.0)
        counts_after = _unknown_removal_counts()
        if all(counts_after[k] > counts_before[k] for k in counts_before):
            break
        if time.monotonic() > deadline:
            stuck = [f"{k} {counts_before[k]:.0f} -> {counts_after[k]:.0f}"
                     for k in counts_before
                     if counts_after[k] <= counts_before[k]]
            fail_(NAME, f"a removal for never-admitted {UNSEEN_ID} was not "
                        f"counted as an unknown-key drop by: "
                        f"{'; '.join(stuck)}")

    silver_unseen = _hw(TOPIC_SILVER)
    if silver_unseen <= silver_removed:
        fail_(NAME,
              f"a removal for never-admitted {UNSEEN_ID} did NOT reach "
              f"{TOPIC_SILVER} (watermark stuck at {silver_removed}) -- the "
              f"gate is meant to pass every removal")
    if _rows_for(UNSEEN_ID) != 0:
        fail_(NAME, f"a removal for never-admitted {UNSEEN_ID} created a "
                    f"telemetry_latest_state row")

    pass_(NAME,
          f"kind={GATED_KIND} refused and counted "
          f"({dropped_before:.0f} -> {dropped_after:.0f}), no DLQ entry, "
          f"kind={ADMITTED_KIND} still admitted; admitted id's removal "
          f"through; unseen removal through the gate, no row, counted by "
          + ", ".join(f"{k} {counts_before[k]:.0f} -> {counts_after[k]:.0f}"
                      for k in counts_before))


if __name__ == "__main__":
    main()
