"""
Test 5 — Ontology fallback for unknown triplet.

Sends a PDU with an entity type that is intentionally NOT present in
dis_entity_types.yaml. Verifies the Silver event lands with
asset.platform_variant == "UNKNOWN" (the _default fallback).

ONE VARIABLE ONLY, AND THAT IS WHY THE TUPLE CHANGED (2026-09-27). This test
used kind=9 to express "unknown". Since the ingress kind gate landed
(dynamic-mappings/dis-kind-gate.yaml) kind=9 is not ADMITTED, so the message
never reaches Silver and this test would fail at "did not see our marker" —
reporting an ontology-fallback regression that had not happened. Admission and
resolution are separate questions, so the tuple is now ADMITTED (kind=1) and
UNRESOLVABLE (country/category/etc. garbage), which tests the fallback and
nothing else. The gate itself is tested by test_54_dis_kind_gate.py.
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

    # Make the triplet self-evidently unknown while keeping it ADMITTED.
    # kind=1 (PLATFORM) so the ingress kind gate passes it through; every
    # other element garbage (country=999 is not a real DIS country code) so
    # the ontology cannot resolve it and _default must be reached.
    pdu = build_entity_state_pdu(
        site=2, application=2, entity=9999,
        kind=1, domain=9, country=999,
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
        # Match by the declared DIS entity field (we set entity=9999) AND
        # verify the variant resolved to the _default fallback. asset_id is
        # opaque (ADR-0047) -- match on dis_entity_id.entity, not a substring
        # of asset_id.
        if evt.asset.dis_entity_id.entity == 9999:
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
