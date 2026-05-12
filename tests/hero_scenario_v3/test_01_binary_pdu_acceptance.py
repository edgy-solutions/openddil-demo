"""
Test 1 — Binary PDU acceptance.

Sends the canonical sample_entity_state.bin fixture to UDP :62040 and verifies
that a JSON record appears on ingress-dis-raw with the structured DIS entity
ID and a populated entity_id_urn.
"""
from __future__ import annotations

import time
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _helpers import (  # noqa: E402
    TOPIC_BRONZE,
    consume_topic,
    fail_,
    pass_,
    send_fixture,
)

NAME = "test_01_binary_pdu_acceptance"


def main() -> None:
    try:
        sent = send_fixture("sample_entity_state.bin")
    except FileNotFoundError as exc:
        fail_(NAME, f"fixture missing: {exc}")

    # Give the sidecar a moment to publish.
    time.sleep(1.5)

    # Read the last few records and filter for our URN.
    # `-o -10` = "last 10 from end" — exits cleanly when topic has < 10 records.
    messages = consume_topic(TOPIC_BRONZE, n=10, timeout_s=15, offset="-10")
    if not messages:
        fail_(NAME, f"no message arrived on {TOPIC_BRONZE} after sending "
                    f"{len(sent)} bytes")

    # Find last message matching the fixture's URN
    matching = [m for m in messages
                if isinstance(m, dict) and m.get("entity_id_urn") == "dis:1:1:4773"]
    if not matching:
        fail_(NAME, f"no message with URN dis:1:1:4773 in {len(messages)} "
                    f"records on {TOPIC_BRONZE}")
    msg = matching[-1]
    if not isinstance(msg, dict):
        fail_(NAME, f"expected JSON record, got bytes: {msg[:80]!r}")

    if "entity_id_urn" not in msg:
        fail_(NAME, f"missing entity_id_urn in {msg!r}")
    if not isinstance(msg.get("dis_entity_id"), dict):
        fail_(NAME, f"missing structured dis_entity_id in {msg!r}")

    eid = msg["dis_entity_id"]
    for key in ("site", "application", "entity"):
        if key not in eid:
            fail_(NAME, f"dis_entity_id missing '{key}'")

    if not isinstance(msg.get("dis_entity_type"), dict):
        fail_(NAME, "missing structured dis_entity_type")

    urn = msg["entity_id_urn"]
    expected_prefix = f"dis:{eid['site']}:{eid['application']}:{eid['entity']}"
    if urn != expected_prefix:
        fail_(NAME, f"URN {urn!r} does not match {expected_prefix!r}")

    pass_(NAME, f"urn={urn} type={msg['dis_entity_type']}")


if __name__ == "__main__":
    main()
