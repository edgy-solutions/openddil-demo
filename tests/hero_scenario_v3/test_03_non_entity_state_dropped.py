"""
Test 3 — Non-EntityState PDU is dropped but counted.

Sends a Fire PDU (type 2), verifies:
  - dis_pdus_received_total{pdu_type="2"} increments
  - nothing new appears on ingress-dis-raw
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _helpers import (  # noqa: E402
    TOPIC_BRONZE,
    fail_,
    metric_value,
    pass_,
    scrape_metrics,
    send_fixture,
    topic_high_watermark,
    wait_for_metric_increase,
)

NAME = "test_03_non_entity_state_dropped"


def main() -> None:
    try:
        text = scrape_metrics()
    except Exception as exc:
        fail_(NAME, f"failed to scrape baseline metrics: {exc}")

    baseline = metric_value(text, "dis_pdus_received_total",
                            labels={"pdu_type": "2"})
    hw_before = topic_high_watermark(TOPIC_BRONZE) or 0

    try:
        send_fixture("sample_fire_pdu.bin")
    except FileNotFoundError as exc:
        fail_(NAME, f"fixture missing: {exc}")

    after = wait_for_metric_increase(
        "dis_pdus_received_total", baseline,
        labels={"pdu_type": "2"}, timeout_s=10,
    )

    time.sleep(2)
    hw_after = topic_high_watermark(TOPIC_BRONZE) or 0
    if hw_after > hw_before:
        fail_(NAME,
              f"Fire PDU leaked onto {TOPIC_BRONZE} "
              f"(watermark {hw_before} -> {hw_after})")

    if after <= baseline:
        # Acceptable degraded path: if the synthetic Fire PDU was so short
        # opendis returned None, it would land in decode_errors instead.
        # Either way the topic-watermark check above confirmed no leak.
        fail_(NAME,
              f"pdu_type=2 counter did not increment "
              f"(baseline={baseline}, after={after}); "
              f"sidecar may have classified the fixture as decode_error")

    pass_(NAME, f"pdu_type=2 counter {baseline} -> {after}, no Kafka leak")


if __name__ == "__main__":
    main()
