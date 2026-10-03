"""Named startup refusals for missing topics and tables — R6b.

Every egress process that needs a topic or a table checks for it HERE,
before its main loop, rather than discovering it is missing from a consumer
poll timeout or a postgres "relation does not exist" error buried inside the
first record it tries to decide. A refusal here is a named, one-line fact an
operator can read without having first guessed that the real cause of a
cryptic runtime error was a provisioning step that never ran.

ONE HELPER, USED BY EVERY PROCESS. The check is never reimplemented per
process — that would be a second (and inevitably, eventually, slightly
different) copy of "missing" to keep consistent across `main.py`,
`intake.py`, `pane_api.py` and anything after them.

Missing -> exactly one `STARTUP_REFUSED missing_topic <name>` or
`STARTUP_REFUSED missing_table <name>` line per missing item, then
`sys.exit(3)`. Broker or postgres unreachable -> one
`STARTUP_REFUSED unreachable <what>` line, then `sys.exit(3)`. `sys.exit`
raises `SystemExit`, which a top-level `raise SystemExit(main())` (every
process's own convention already) propagates with no traceback — this is a
refusal, not a bug.
"""
from __future__ import annotations

import logging
import sys
from typing import Any, Awaitable, Callable, Iterable, Protocol

log = logging.getLogger("egress.startup")


class _ClusterMetadata(Protocol):
    topics: dict  # topic name -> metadata; confluent_kafka's own shape


class _AdminClient(Protocol):
    def list_topics(self, timeout: float = ...) -> _ClusterMetadata: ...


def require_topics(
    admin: _AdminClient,
    topics: Iterable[str],
    *,
    timeout: float = 10.0,
) -> None:
    """Refuse to start if any of `topics` is missing from the cluster.

    `admin` is anything with a `list_topics(timeout=...)` method returning
    an object with a `.topics` mapping — confluent_kafka's
    `AdminClient(conf)` already has exactly this shape, so production code
    passes one straight through; tests pass a fake with the same two
    members and no broker at all.
    """
    wanted = list(topics)
    if not wanted:
        return
    try:
        metadata = admin.list_topics(timeout=timeout)
    except Exception as exc:  # noqa: BLE001 — any client/broker failure here
        log.error("STARTUP_REFUSED unreachable broker: %s", exc)
        sys.exit(3)
    known = set(metadata.topics)
    missing = sorted(name for name in wanted if name not in known)
    if missing:
        for name in missing:
            log.error("STARTUP_REFUSED missing_topic %s", name)
        sys.exit(3)


async def require_tables(
    dsn: str,
    tables: Iterable[str],
    *,
    connect: Callable[[str], Awaitable[Any]] | None = None,
) -> None:
    """Refuse to start if any of `tables` does not exist, checked with
    `to_regclass` — NULL means "no such relation", same as a missing topic.

    A fresh connection per call, the same convention `IntakeStore` and
    `pane_api.py` already use for the same reason: this runs once at
    startup, not on a hot path, so there is no pool whose liveness needs
    tracking. `connect` is injected for tests (an async fake returning a
    fake connection with `fetchval`/`close`); production code leaves it
    unset and gets `asyncpg.connect`.
    """
    wanted = list(tables)
    if not wanted:
        return
    if connect is None:
        import asyncpg  # noqa: PLC0415
        connect = asyncpg.connect
    try:
        conn = await connect(dsn)
    except Exception as exc:  # noqa: BLE001 — any connect failure here
        log.error("STARTUP_REFUSED unreachable postgres: %s", exc)
        sys.exit(3)
    try:
        missing = []
        for table in wanted:
            result = await conn.fetchval("SELECT to_regclass($1)", table)
            if result is None:
                missing.append(table)
    finally:
        await conn.close()
    if missing:
        for name in sorted(missing):
            log.error("STARTUP_REFUSED missing_table %s", name)
        sys.exit(3)
