"""
Test 24 — Fusion rules unit tests + coverage.

Runs pytest on openddil-logistics-fusion-service/src/tests/test_rules.py.
Asserts ≥90% coverage on rules.py. This is the "pure-Python algorithm
boundary" check from ADR-0006 — fusion rules must be testable without any
streaming framework.
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _helpers import fail_, pass_, skip_  # noqa: E402

NAME = "test_24_fusion_rules_unit"

REPO_ROOT = Path(__file__).resolve().parents[3]
FUSION = REPO_ROOT / "openddil-logistics-fusion-service"
CONTRACTS_GEN = REPO_ROOT / "openddil-contracts" / "gen" / "python"


def main() -> None:
    if not FUSION.is_dir():
        skip_(NAME, f"fusion service not present at {FUSION}")

    env = {
        **__import__("os").environ,
        "PYTHONPATH": f"{CONTRACTS_GEN};{FUSION / 'src'}",
    }
    # Run via uv so dev deps install in an ephemeral env on the host.
    cmd = [
        "uv", "run", "--no-project",
        "--with", "pytest>=8.0",
        "--with", "pytest-cov>=5.0",
        "--with", "protobuf>=6.30.0,<7.0.0",
        "--with", "pint>=0.23,<1.0",
        "--with", "pyyaml>=6.0",
        "pytest", str(FUSION / "src" / "tests" / "test_rules.py"),
        "--cov=fusion", "--cov-report=term-missing", "-q",
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True,
                              timeout=180, env=env)
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        skip_(NAME, f"could not run pytest under uv: {exc}")

    out = (proc.stdout + proc.stderr)
    if proc.returncode != 0:
        fail_(NAME, f"pytest failed (rc={proc.returncode}); "
                    f"last 400 chars:\n{out[-400:]}")

    # Parse coverage row for rules.py. The exact path separator varies by
    # OS; the column layout is consistent (Name Stmts Miss Cover Missing).
    rules_cover = None
    for line in out.splitlines():
        if "rules.py" not in line:
            continue
        m = re.search(r"(\d+)%", line)
        if m:
            rules_cover = int(m.group(1))
            break
    if rules_cover is None:
        fail_(NAME, "could not parse rules.py coverage from pytest output")
    if rules_cover < 90:
        fail_(NAME, f"rules.py coverage {rules_cover}% < 90% target")

    # Count passing tests
    passed = 0
    for line in out.splitlines():
        m = re.search(r"(\d+) passed", line)
        if m:
            passed = int(m.group(1))
            break

    pass_(NAME, f"{passed} unit tests passed, rules.py coverage {rules_cover}%")


if __name__ == "__main__":
    main()
