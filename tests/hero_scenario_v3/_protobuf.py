"""
Protobuf decode helper for Hero Scenario v3 tests.

The Silver topic raw-sensor-stream carries binary protobuf
openddil.telemetry.v1.EntityTelemetryEvent. This helper imports the
generated Python module from openddil-contracts/gen/python and exposes a
single decode_entity_event(bytes) function. If the generated module is
unavailable, decode_entity_event raises ModuleNotFoundError so the
calling test can SKIP cleanly.
"""
from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT  = Path(__file__).resolve().parents[3]
GEN_PYTHON = REPO_ROOT / "openddil-contracts" / "gen" / "python"


def _ensure_proto_path() -> None:
    if str(GEN_PYTHON) not in sys.path:
        sys.path.insert(0, str(GEN_PYTHON))


def decode_entity_event(raw: bytes):
    """
    Decode a protobuf-binary EntityTelemetryEvent. Returns the proto object.
    Caller may then access msg.asset.platform_variant etc.

    Raises ModuleNotFoundError if the generated proto module is not present;
    raises google.protobuf.message.DecodeError on bad input.
    """
    _ensure_proto_path()
    from openddil.telemetry.v1 import telemetry_pb2  # type: ignore
    msg = telemetry_pb2.EntityTelemetryEvent()
    msg.ParseFromString(raw)
    return msg


def proto_to_dict(msg) -> dict:
    """Lightweight proto → dict conversion (good enough for assertions)."""
    from google.protobuf.json_format import MessageToDict  # type: ignore
    return MessageToDict(msg, preserving_proto_field_name=True)
