"""
Test 2 — Malformed PDU does not crash the sidecar.

Sends 32 bytes of random noise, verifies:
  - dis_decode_errors_total increments
  - nothing new appears on ingress-dis-raw
  - the sidecar container is still alive
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
    sensor_alive,
    topic_high_watermark,
    wait_for_metric_increase,
)

NAME = "test_02_malformed_pdu_resilience"


def main() -> None:
    try:
        text = scrape_metrics()
    except Exception as exc:
        fail_(NAME, f"failed to scrape baseline metrics: {exc}")

    baseline = metric_value(text, "dis_decode_errors_total")
    hw_before = topic_high_watermark(TOPIC_BRONZE) or 0

    try:
        send_fixture("sample_malformed.bin")
    except FileNotFoundError as exc:
        fail_(NAME, f"fixture missing: {exc}")

    after = wait_for_metric_increase("dis_decode_errors_total", baseline,
                                      timeout_s=10)

    if after <= baseline:
        fail_(NAME, f"dis_decode_errors_total did not increment "
                    f"(baseline={baseline}, after={after})")

    # Nothing on ingress-dis-raw — high watermark must not advance.
    time.sleep(2)  # give any (incorrect) publish time to land
    hw_after = topic_high_watermark(TOPIC_BRONZE) or 0
    if hw_after > hw_before:
        fail_(NAME,
              f"malformed PDU leaked onto {TOPIC_BRONZE} "
              f"(watermark {hw_before} -> {hw_after})")

    if not sensor_alive():
        fail_(NAME, "sidecar container is no longer running")

    pass_(NAME,
          f"decode_errors {baseline} -> {after}, no Kafka leak, sidecar up")


if __name__ == "__main__":
    main()
