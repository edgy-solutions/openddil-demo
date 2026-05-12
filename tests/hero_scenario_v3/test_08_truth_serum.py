"""
Test 8 — Truth Serum (carryover from v2.1).

The original v2.1 intent was to verify that the thermal_runaway algorithm
honors units: 200 K is cold (no anomaly), 200 °F is hot (anomaly fires).
The v3 architectural rule, however, is that mock thermal data MUST NOT
flow through the DIS path or its diagnostic HTTP alias. The current
sim-dis-mapping.yaml deliberately does NOT pass through any sustainment
fields — so even when we POST {"thermal":...} to the diagnostic HTTP
endpoint on :9999, no sustainment can reach algorithms.

This test verifies the architectural seal: mock thermal data injected via
the diagnostic HTTP path produces a Silver event with NO sustainment block,
which means the thermal_runaway algorithm cannot fire regardless of unit.

The genuine 200 K vs 200 °F unit-handling assertion is exercised by the
algorithm-level unit tests in openddil-tactical-agents/edge/detection,
not by this end-to-end test. Re-introducing a sustainment-bearing input
path is a future-phase concern (proprietary sensor protocol).
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _helpers import (  # noqa: E402
    TOPIC_SILVER,
    consume_topic_binary,
    fail_,
    pass_,
    send_http,
    skip_,
)

NAME = "test_08_truth_serum"


# Crafted to match what the DIS-shaped mapping expects, plus an EXTRA
# sustainment-like field we want to confirm DOES NOT propagate.
def _payload(temperature_kelvin: float) -> dict:
    return {
        "dis_entity_id": {"site": 9, "application": 9, "entity": 808},
        "entity_id_urn": "dis:9:9:808",
        "dis_entity_type": {
            "kind": 1, "domain": 1, "country": 225,
            "category": 1, "subcategory": 3, "specific": 1, "extra": 0,
        },
        "marking":      "TRUTH-808",
        "force_id":     1,
        "location_ecef":         {"x": 0.0, "y": 0.0, "z": 0.0},
        "linear_velocity_ecef":  {"x": 0.0, "y": 0.0, "z": 0.0},
        "orientation_euler":     {"psi": 0.0, "theta": 0.0, "phi": 0.0},
        "appearance_bits":          0,
        "dead_reckoning_algorithm": 1,
        "pdu_sequence":             1,
        "ingest_timestamp":         "2026-05-12T00:00:00Z",
        # Out-of-band mock thermal — MUST NOT propagate to Silver.
        "thermal": {
            "component_temperature_k": temperature_kelvin,
            "ambient_temperature_k":   285.0,
        },
    }


def _send_and_check(temperature_k: float, label: str) -> dict:
    try:
        from _protobuf import decode_entity_event
    except ImportError as exc:
        skip_(NAME, f"protobuf helper unavailable: {exc}")

    status = send_http(_payload(temperature_k))
    if status not in (200, 202, 204):
        fail_(NAME, f"HTTP diagnostic returned {status}")

    time.sleep(2.5)
    raws = consume_topic_binary(TOPIC_SILVER, n=80, timeout_s=20, offset="-10")
    if not raws:
        fail_(NAME, f"[{label}] no message on {TOPIC_SILVER}")

    for raw in raws:
        try:
            evt = decode_entity_event(raw)
        except ModuleNotFoundError as exc:
            skip_(NAME, f"protobuf module missing: {exc}")
        except Exception:
            continue
        if "808" in evt.asset.asset_id:
            return evt

    fail_(NAME, f"[{label}] never observed entity=808 in Silver stream")


def main() -> None:
    # Round 1 — "200 K" (would be COLD, so no anomaly even if it propagated).
    evt_cold = _send_and_check(200.0, "200 K")
    if evt_cold.HasField("sustainment"):
        fail_(NAME, "mock thermal LEAKED through HTTP path (200 K case)")

    # Round 2 — "200 °F" (≈ 366.5 K — would be HOT IF it propagated).
    evt_hot = _send_and_check(366.5, "200 °F")
    if evt_hot.HasField("sustainment"):
        fail_(NAME, "mock thermal LEAKED through HTTP path (200 °F case)")

    pass_(NAME,
          "architectural seal holds — mock thermal blocked at the mapping "
          "boundary for both 200 K and 200 °F; algorithm-level unit "
          "handling is verified separately in openddil-tactical-agents")


if __name__ == "__main__":
    main()
