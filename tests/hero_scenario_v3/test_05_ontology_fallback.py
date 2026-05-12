"""
Test 5 — Ontology fallback for unknown triplet.

Sends a PDU with an entity type that is intentionally NOT present in
dis_entity_types.yaml. Verifies the Silver event lands with
asset.platform_variant == "UNKNOWN" (the _default fallback).
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

NAME = "test_05_ontology_fallback"


def main() -> None:
    try:
        from _protobuf import decode_entity_event
    except ImportError as exc:
        skip_(NAME, f"protobuf helper unavailable: {exc}")

    # Make the triplet self-evidently unknown:
    # kind=9 (unused in our ontology), country=999 (not a real DIS country code)
    pdu = build_entity_state_pdu(
        site=2, application=2, entity=9999,
        kind=9, domain=9, country=999,
        category=99, subcategory=99, specific=99, extra=99,
        marking="UNKNOWN-X",
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
        # Match by URN (we set entity=9999) AND verify the variant resolved
        # to the _default fallback.
        if "9999" in evt.asset.asset_id:
            found = evt
            break

    if found is None:
        fail_(NAME, "did not see our marker (entity=9999) in Silver stream")

    if found.asset.platform_variant != "UNKNOWN":
        fail_(NAME,
              f"unknown triplet did not fall back to 'UNKNOWN' — "
              f"got {found.asset.platform_variant!r}")

    pass_(NAME, "unknown triplet fell back to platform_variant=UNKNOWN")


if __name__ == "__main__":
    main()
