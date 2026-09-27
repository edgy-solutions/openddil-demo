"""
Test 54 — DIS entity kinds are admitted by declaration, and refusals are counted.

The gate (dynamic-mappings/dis-kind-gate.yaml) exists because a kind=2
MUNITION Entity State PDU was measured entering the fleet as an asset with
platform_variant=UNKNOWN, and two properties made that permanent: `kind` is
absent from the asset_id, so no fleet query can exclude munitions by key
pattern; and there is no eviction path, so a round admitted once stays a
member. See openddil-helm/scripts/FINDING-2026-09-26-kind2-munition-resolution.md.

Three assertions, and the third is the one that matters:

  1. a kind=2 PDU increments dis_ingress_kind_dropped{kind="2"}
  2. a kind=2 PDU adds NOTHING to raw-sensor-stream, and nothing to
     ingress-dlq — a gated kind is a policy decision, not malformed data
  3. a kind=1 PDU still lands on raw-sensor-stream

Without (3) this test passes for a gate that drops the entire feed, which is a
total ingress outage that looks like a clean deploy.
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
    fail_,
    metric_value_labeled,
    pass_,
    scrape_connect_metrics,
    send_udp_bytes,
    skip_,
    topic_high_watermark,
)

NAME = "test_54_dis_kind_gate"

GATED_KIND = 2        # MUNITION
ADMITTED_KIND = 1     # PLATFORM
METRIC = "dis_ingress_kind_dropped"


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

    pass_(NAME,
          f"kind={GATED_KIND} refused and counted "
          f"({dropped_before:.0f} -> {dropped_after:.0f}), no DLQ entry, "
          f"kind={ADMITTED_KIND} still admitted")


if __name__ == "__main__":
    main()
