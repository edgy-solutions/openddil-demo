"""Put the generated contracts protos on sys.path for a local egress run.

The egress Dockerfile test stage does `COPY openddil-contracts/gen/python /proto`
with `ENV PYTHONPATH=/proto:/app`; a local `pytest egress` has no such path, so
`openddil.*_pb2` imports fail. This mirrors it. Inside the image none of the
candidates exist and `/proto` is already on the path, so this is a no-op there.
A missing directory changes nothing and tests are not skipped: they must fail.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

_TAIL = Path("openddil-contracts") / "gen" / "python"


def _candidates():
    env = os.environ.get("OPENDDIL_CONTRACTS_GEN_PYTHON")
    if env:
        yield Path(env)
    root = Path(__file__).resolve().parents[1]
    yield root.parent / _TAIL
    dotgit = root / ".git"
    if dotgit.is_file():
        for line in dotgit.read_text(encoding="utf-8").splitlines():
            if line.startswith("gitdir:"):
                gitdir = Path(line.split(":", 1)[1].strip())
                yield gitdir.parents[2].parent / _TAIL
                break


for _dir in _candidates():
    if (_dir / "openddil").is_dir():
        if str(_dir) not in sys.path:
            sys.path.insert(0, str(_dir))
        break
