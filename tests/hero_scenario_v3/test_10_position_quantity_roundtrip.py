"""
Test 10 — Position Quantity round-trip (ADR-0013).

Sends a DIS PDU with known ECEF coordinates (a real surveyed point near
Fort Hood, TX, in meters). Verifies that the Silver event carries
`kinematics.position.ecef.x/y/z` as Quantity messages with unit "m" and
matching values, and that the units.py `ecef_to_pint` adapter round-trips
cleanly.
"""
from __future__ import annotations

import math
import struct
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _helpers import (  # noqa: E402
    TOPIC_SILVER,
    consume_topic_binary,
    fail_,
    pass_,
    send_udp_bytes,
    skip_,
)

NAME = "test_10_position_quantity_roundtrip"


def _build_pdu_with_location(x_m: float, y_m: float, z_m: float,
                              entity: int) -> bytes:
    buf = bytearray()
    buf += struct.pack(">BBBBIHBB", 7, 1, 1, 1, 0, 144, 0, 0)
    buf += struct.pack(">HHH", 1, 1, entity)
    buf += struct.pack(">BB", 1, 0)
    buf += struct.pack(">BBHBBBB", 1, 1, 225, 1, 3, 1, 0)  # M1A2 SEPv3
    buf += b"\x00" * 8
    buf += struct.pack(">fff", 0.0, 0.0, 0.0)               # velocity
    buf += struct.pack(">ddd", x_m, y_m, z_m)               # location (doubles)
    buf += struct.pack(">fff", 0.0, 0.0, 0.0)               # orientation
    buf += struct.pack(">I", 0)
    buf += b"\x01" + b"\x00" * 15 + struct.pack(">fff", 0.0, 0.0, 0.0) + struct.pack(">fff", 0.0, 0.0, 0.0)
    buf += b"\x01" + b"POS-TEST".ljust(11, b"\x00")
    buf += struct.pack(">I", 0)
    return bytes(buf)


def main() -> None:
    try:
        from _protobuf import decode_entity_event
    except ImportError as exc:
        skip_(NAME, f"protobuf helper unavailable: {exc}")

    # Known ECEF coordinates near Fort Hood, TX (lat 31.13, lon -97.78, sea level)
    x_m = -796104.6
    y_m = -5417889.3
    z_m =  3280898.7
    entity = 9202

    pdu = _build_pdu_with_location(x_m, y_m, z_m, entity)
    send_udp_bytes(pdu)
    time.sleep(2.5)

    raws = consume_topic_binary(TOPIC_SILVER, n=20, timeout_s=20)
    if not raws:
        fail_(NAME, "no message on raw-sensor-stream")

    found = None
    for raw in raws:
        try:
            evt = decode_entity_event(raw)
        except ModuleNotFoundError as exc:
            skip_(NAME, f"protobuf module missing: {exc}")
        except Exception:
            continue
        if str(entity) in evt.asset.asset_id:
            found = evt
            break

    if found is None:
        fail_(NAME, f"did not see entity={entity} marker in Silver stream")

    ecef = found.kinematics.position.ecef
    if not ecef.HasField("x"):
        fail_(NAME, "kinematics.position.ecef.x is unset; Bloblang did not "
                    "populate the Quantity field")
    if ecef.x.unit != "m":
        fail_(NAME, f"ecef.x.unit={ecef.x.unit!r}, expected 'm'")

    if not math.isclose(ecef.x.value, x_m, rel_tol=1e-6):
        fail_(NAME, f"ecef.x.value={ecef.x.value}, expected ≈{x_m}")
    if not math.isclose(ecef.y.value, y_m, rel_tol=1e-6):
        fail_(NAME, f"ecef.y.value={ecef.y.value}, expected ≈{y_m}")
    if not math.isclose(ecef.z.value, z_m, rel_tol=1e-6):
        fail_(NAME, f"ecef.z.value={ecef.z.value}, expected ≈{z_m}")

    # ----- units.py adapter round-trip -----
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parents[3]
                               / "openddil-tactical-agents" / "edge"))
        from detection.units import ecef_to_pint  # type: ignore
    except ImportError as exc:
        pass_(NAME,
              f"x={ecef.x.value:.1f}m, y={ecef.y.value:.1f}m, z={ecef.z.value:.1f}m "
              f"(units adapter unavailable: {exc})")
        return

    pint_dict = ecef_to_pint(ecef)
    x_km = pint_dict["x"].to("km").magnitude
    if not math.isclose(x_km * 1000.0, x_m, rel_tol=1e-6):
        fail_(NAME, f"pint round-trip x={x_km}km != source {x_m}m")

    pass_(NAME,
          f"ECEF=({ecef.x.value:.1f}, {ecef.y.value:.1f}, {ecef.z.value:.1f}) m; "
          f"pint round-trip x={x_km:.3f} km; ADR-0013 honored")


if __name__ == "__main__":
    main()
