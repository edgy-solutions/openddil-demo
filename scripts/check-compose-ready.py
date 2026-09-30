#!/usr/bin/env python3
"""Is the compose stack up? Exit 0 only if every service is.

A test run against a stack with a dead service measures the dead service,
not the change under test, and the results read like a code failure. This
check is meant to run before any compose prediction is written.

Two kinds of service, told apart by what the compose file declares:

  * one-shot: `restart: "no"` set explicitly (redpanda-init, atlas-init, the
    Restate bootstraps, ...). Ready means exited with code 0.
  * everything else: long-running. Ready means running, and healthy if it
    defines a healthcheck. Exited, restarting, created-but-not-started,
    unhealthy, still starting, or no container at all: not ready.

An unset restart policy is also "no" to Docker, so the explicit value is the
only declaration there is. A long-running service with no restart policy that
dies stays dead, and that is exactly what this reports.

  python scripts/check-compose-ready.py              # one look
  python scripts/check-compose-ready.py --wait 120   # poll until ready or timeout

Exit 0 ready, 1 not ready, 3 could not read compose.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


def _compose(*args: str) -> str:
    return subprocess.run(["docker", "compose", *args], cwd=REPO,
                          capture_output=True, text=True, check=True).stdout


def _containers() -> dict[str, dict]:
    out = _compose("ps", "-a", "--format", "json").strip()
    if not out:
        return {}
    # Compose v2 prints one object per line; older releases print one array.
    rows = json.loads(out) if out.startswith("[") else [
        json.loads(line) for line in out.splitlines() if line.strip()]
    return {r["Service"]: r for r in rows}


def not_ready(services: dict[str, dict]) -> list[str]:
    ps = _containers()
    bad = []
    for name in sorted(services):
        c = ps.get(name)
        if c is None:
            bad.append(f"{name}: no container")
            continue
        state, health = c.get("State", ""), c.get("Health", "")
        code = c.get("ExitCode")
        if services[name].get("restart") == "no":
            if state != "exited" or code != 0:
                bad.append(f"{name}: one-shot, {state} exit={code} "
                           f"(want exited 0)")
        elif state != "running":
            bad.append(f"{name}: {state} exit={code} ({c.get('Status', '')})")
        elif health and health != "healthy":
            bad.append(f"{name}: running but {health}")
    return bad


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--wait", type=int, default=0, metavar="SECONDS",
                    help="poll until ready, fail after this long")
    a = ap.parse_args()
    try:
        services = json.loads(_compose("config", "--format", "json"))["services"]
    except (subprocess.CalledProcessError, OSError, KeyError, ValueError) as e:
        print(f"NOT RUN: cannot read compose config: {e}", file=sys.stderr)
        return 3

    deadline = time.monotonic() + a.wait
    while True:
        try:
            bad = not_ready(services)
        except (subprocess.CalledProcessError, OSError, ValueError) as e:
            print(f"NOT RUN: cannot read compose state: {e}", file=sys.stderr)
            return 3
        if not bad or time.monotonic() >= deadline:
            break
        time.sleep(5)

    for line in bad:
        print(f"NOT READY {line}")
    print(f"{len(services) - len(bad)}/{len(services)} services ready"
          + ("" if bad else " -- READY"))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
