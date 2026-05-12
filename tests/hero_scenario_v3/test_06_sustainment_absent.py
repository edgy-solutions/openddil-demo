"""
Test 6 — DIS-sourced Silver events carry no sustainment data.

Phase 0/2 honesty rule: DIS Entity State PDUs do not carry sustainment
(thermal/fuel/power) — those are LEGITIMATELY absent. The Silver event must
not contain a sustainment block. This test verifies that the architectural
rule survived the mapping rewrite.

It also confirms that no thermal_runaway anomaly is produced for a DIS-only
input. Since the Silver record has no thermal data at all, the algorithm
should return None and the anomaly topic (if any) should stay quiet — we
assert via the absence of the sustainment field, which is the upstream cause.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _helpers import (  # noqa: E402
    TOPIC_SILVER,
    build_entity_state_pdu,
    consume_topic_binary,
    fail_,
    pass_,
    send_udp_bytes,
    skip_,
)

NAME = "test_06_sustainment_absent"


def main() -> None:
    try:
        from _protobuf import decode_entity_event, proto_to_dict
    except ImportError as exc:
        skip_(NAME, f"protobuf helper unavailable: {exc}")

    pdu = build_entity_state_pdu(
        site=3, application=3, entity=7777,
        kind=1, domain=1, country=225,
        category=1, subcategory=3, specific=1, extra=0,
        marking="STX-7777",
    )
    send_udp_bytes(pdu)
    time.sleep(2.5)

    raws = consume_topic_binary(TOPIC_SILVER, n=80, timeout_s=20, offset="-10")
    if not raws:
        fail_(NAME, f"no message on {TOPIC_SILVER}")

    found = None
    for raw in raws:
        try:
            evt = decode_entity_event(raw)
        except ModuleNotFoundError as exc:
            skip_(NAME, f"protobuf module missing: {exc}")
        except Exception:
            continue
        if "7777" in evt.asset.asset_id:
            found = evt
            break

    if found is None:
        fail_(NAME, "did not see entity=7777 marker in Silver stream")

    # The protobuf field `sustainment` is a singular message. In proto3,
    # absence-of-message is represented as `HasField("sustainment") == False`.
    if found.HasField("sustainment"):
        as_dict = proto_to_dict(found).get("sustainment")
        fail_(NAME,
              f"DIS-sourced Silver event carries a sustainment block "
              f"(should be absent): {as_dict}")

    pass_(NAME, "sustainment legitimately absent from DIS-sourced event")


if __name__ == "__main__":
    main()
