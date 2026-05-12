"""
Test 4 — Ontology enrichment for a known platform.

Sends a PDU with entityType=(1,1,225,1,3,1,0) (M1A2 SEPv3 per
dis_entity_types.yaml). Consumes the resulting Silver event from
raw-sensor-stream and verifies asset.platform_variant == "M1A2-SEPv3".

Requires the generated openddil.telemetry.v1.EntityTelemetryEvent protobuf
module under openddil-contracts/gen/python. If missing, the test SKIPs.
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

NAME = "test_04_ontology_enrichment"


def main() -> None:
    try:
        from _protobuf import decode_entity_event, proto_to_dict
    except ImportError as exc:
        skip_(NAME, f"protobuf helper unavailable: {exc}")

    pdu = build_entity_state_pdu(
        site=1, application=1, entity=4773,
        kind=1, domain=1, country=225,
        category=1, subcategory=3, specific=1, extra=0,
        marking="M1A2-SEPv3",
    )
    send_udp_bytes(pdu)

    # Allow the sidecar → Bronze → Connect (Bloblang) → Silver hop to complete.
    time.sleep(2.5)

    raws = consume_topic_binary(TOPIC_SILVER, n=10, timeout_s=15, offset="-10")
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
        if getattr(evt.asset, "platform_variant", "") == "M1A2-SEPv3":
            found = evt
            break

    if found is None:
        last = None
        try:
            last = proto_to_dict(decode_entity_event(raws[-1])) if raws else None
        except Exception:
            pass
        fail_(NAME,
              f"no Silver event with platform_variant=M1A2-SEPv3 "
              f"(checked {len(raws)} message(s); last={last})")

    # Per Phase 2 spec, asserting `platform_variant` is sufficient.
    # `platform_family` lives in the ontology row but is not surfaced on the
    # AssetIdentity proto today (no field slot). Asserting it here would
    # require adding a proto field — out of scope for Phase 2.
    pass_(NAME,
          f"variant={found.asset.platform_variant} "
          f"baseline={found.asset.configuration_baseline} "
          f"cbm_schema={found.asset.cbm_schema}")


if __name__ == "__main__":
    main()
