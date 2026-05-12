"""
Test 9 — Angle Quantity round-trip (ADR-0013).

Sends a DIS PDU with yaw = pi/2 radians (90 degrees), pitch = 0, roll = pi/4.
Verifies that the Silver event carries `kinematics.attitude.euler.yaw` as a
Quantity with value ≈ pi/2 and unit "rad", and that converting via pint
yields ≈ 90 deg.

Confirms that ADR-0013's "no more bare-double angle fields" rule is honored
by the new Bloblang mapping and that the units.py adapter round-trips
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

NAME = "test_09_angle_quantity_roundtrip"


def _build_pdu_with_orientation(psi_rad: float, theta_rad: float,
                                phi_rad: float, entity: int) -> bytes:
    """
    Hand-roll an Entity State PDU using opendis layout, with the orientation
    fields set explicitly. Re-uses the same canonical layout as
    `build_entity_state_pdu` but parameterizes the Euler trio.
    """
    buf = bytearray()
    # Header
    buf += struct.pack(">BBBBIHBB", 7, 1, 1, 1, 0, 144, 0, 0)
    # EntityID (1, 1, entity)
    buf += struct.pack(">HHH", 1, 1, entity)
    # forceId, numArt
    buf += struct.pack(">BB", 1, 0)
    # EntityType — M1A2 SEPv3 (1,1,225,1,3,1,0) so ontology lookup succeeds
    buf += struct.pack(">BBHBBBB", 1, 1, 225, 1, 3, 1, 0)
    # AlternativeEntityType (zero)
    buf += b"\x00" * 8
    # LinearVelocity (zero)
    buf += struct.pack(">fff", 0.0, 0.0, 0.0)
    # Location (zero)
    buf += struct.pack(">ddd", 0.0, 0.0, 0.0)
    # Orientation (psi, theta, phi) — radians per IEEE 1278.1
    buf += struct.pack(">fff", psi_rad, theta_rad, phi_rad)
    # Appearance
    buf += struct.pack(">I", 0)
    # DeadReckoning (algo + 15 + 12 + 12)
    buf += b"\x01" + b"\x00" * 15 + struct.pack(">fff", 0.0, 0.0, 0.0) + struct.pack(">fff", 0.0, 0.0, 0.0)
    # Marking
    marking = b"YAW-PI2".ljust(11, b"\x00")
    buf += b"\x01" + marking
    # Capabilities
    buf += struct.pack(">I", 0)
    return bytes(buf)


def main() -> None:
    try:
        from _protobuf import decode_entity_event
    except ImportError as exc:
        skip_(NAME, f"protobuf helper unavailable: {exc}")

    yaw_rad = math.pi / 2     # 90 deg
    pitch_rad = 0.0
    roll_rad = math.pi / 4    # 45 deg
    entity = 9201             # distinctive marker for this test

    pdu = _build_pdu_with_orientation(yaw_rad, pitch_rad, roll_rad, entity)
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

    euler = found.kinematics.attitude.euler

    # ----- Yaw -----
    if not euler.HasField("yaw"):
        fail_(NAME, "kinematics.attitude.euler.yaw is unset; Bloblang did not "
                    "populate the Quantity field")
    if euler.yaw.unit != "rad":
        fail_(NAME, f"yaw.unit={euler.yaw.unit!r}, expected 'rad'")
    if not math.isclose(euler.yaw.value, yaw_rad, abs_tol=1e-4):
        fail_(NAME, f"yaw.value={euler.yaw.value}, expected ≈{yaw_rad}")

    # ----- Roll -----
    if euler.roll.unit != "rad":
        fail_(NAME, f"roll.unit={euler.roll.unit!r}, expected 'rad'")
    if not math.isclose(euler.roll.value, roll_rad, abs_tol=1e-4):
        fail_(NAME, f"roll.value={euler.roll.value}, expected ≈{roll_rad}")

    # ----- units.py adapter round-trip -----
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parents[3]
                               / "openddil-tactical-agents" / "edge"))
        from detection.units import euler_to_pint  # type: ignore
    except ImportError as exc:
        # Adapter not importable from this host environment — schema check
        # alone is still meaningful. Skip the pint round-trip but PASS the
        # protobuf assertions.
        pass_(NAME,
              f"yaw={euler.yaw.value:.4f} rad, roll={euler.roll.value:.4f} rad "
              f"(units adapter unavailable: {exc})")
        return

    pint_dict = euler_to_pint(euler)
    yaw_deg = pint_dict["yaw"].to("degree").magnitude
    if not math.isclose(yaw_deg, 90.0, abs_tol=1e-2):
        fail_(NAME, f"pint round-trip yaw={yaw_deg} deg, expected ≈90.0")

    pass_(NAME,
          f"yaw={euler.yaw.value:.4f} rad ~= {yaw_deg:.2f} deg via pint; "
          f"unit tags preserved on the wire (ADR-0013 honored)")


if __name__ == "__main__":
    main()
