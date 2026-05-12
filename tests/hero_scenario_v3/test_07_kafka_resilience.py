"""
Test 7 — Kafka resilience.

  1. Stop redpanda-edge.
  2. Send a PDU (the sidecar's producer queue will buffer or error).
  3. Restart redpanda-edge.
  4. Verify the sidecar process is still alive.
  5. Send another PDU and confirm it lands on ingress-dis-raw.

The pass criterion is "sidecar didn't crash and resumes producing", not
"buffered PDU was preserved" — the sidecar does NOT persistently buffer
across Kafka outages, per its design.
"""
from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _helpers import (  # noqa: E402
    COMPOSE_DIR,
    REDPANDA_SVC,
    TOPIC_BRONZE,
    _docker_compose_cmd,
    consume_topic,
    fail_,
    pass_,
    send_fixture,
    sensor_alive,
)

NAME = "test_07_kafka_resilience"


def _compose(*args: str, timeout: int = 60) -> subprocess.CompletedProcess:
    return subprocess.run(
        _docker_compose_cmd() + list(args),
        cwd=str(COMPOSE_DIR), capture_output=True, text=True, timeout=timeout,
    )


def main() -> None:
    # 1. Stop redpanda-edge
    r = _compose("stop", REDPANDA_SVC)
    if r.returncode != 0:
        fail_(NAME, f"failed to stop {REDPANDA_SVC}: {r.stderr}")
    time.sleep(2)

    # 2. Send a PDU while Kafka is down. The sidecar should NOT crash.
    try:
        send_fixture("sample_entity_state.bin")
    except FileNotFoundError as exc:
        # Restart redpanda before failing so we leave the env usable.
        _compose("start", REDPANDA_SVC)
        fail_(NAME, f"fixture missing: {exc}")
    time.sleep(2)

    if not sensor_alive():
        _compose("start", REDPANDA_SVC)
        fail_(NAME, "sidecar exited while Kafka was down")

    # 3. Restart redpanda-edge
    r = _compose("start", REDPANDA_SVC)
    if r.returncode != 0:
        fail_(NAME, f"failed to start {REDPANDA_SVC}: {r.stderr}")

    # Wait for the broker to become healthy. Give it up to 45 s.
    deadline = time.monotonic() + 45
    healthy = False
    while time.monotonic() < deadline:
        r = _compose("ps", "--status=running", "--services")
        if REDPANDA_SVC in r.stdout.split():
            # Probe rpk
            probe = subprocess.run(
                _docker_compose_cmd() + ["exec", "-T", REDPANDA_SVC,
                                          "rpk", "cluster", "info"],
                cwd=str(COMPOSE_DIR), capture_output=True, text=True,
                timeout=10,
            )
            if probe.returncode == 0:
                healthy = True
                break
        time.sleep(2)

    if not healthy:
        fail_(NAME, "redpanda-edge did not return to healthy within 45 s")

    if not sensor_alive():
        fail_(NAME, "sidecar exited during Kafka recovery")

    # 4. Send a new PDU and verify it lands.
    try:
        send_fixture("sample_entity_state.bin")
    except FileNotFoundError as exc:
        fail_(NAME, f"fixture missing: {exc}")
    time.sleep(3)

    msgs = consume_topic(TOPIC_BRONZE, n=5, timeout_s=15, offset="-5")
    if not msgs:
        fail_(NAME, "no message on ingress-dis-raw after Kafka recovery")

    pass_(NAME, "sidecar survived broker outage and resumed producing")


if __name__ == "__main__":
    main()
