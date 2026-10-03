"""Unit tests for egress/startup.py — R6b named startup refusals.

No real broker, no real postgres: `require_topics` takes anything shaped
like confluent_kafka's `AdminClient` (a `.list_topics(timeout=...)`
returning an object with `.topics`); `require_tables` takes an injected
async `connect` returning a fake connection with `fetchval`/`close`.
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from startup import require_tables, require_topics  # noqa: E402


# --- require_topics -----------------------------------------------------


class _FakeMetadata:
    def __init__(self, topic_names: list[str]) -> None:
        self.topics = {name: object() for name in topic_names}


class _FakeAdmin:
    def __init__(self, topic_names: list[str]) -> None:
        self._metadata = _FakeMetadata(topic_names)

    def list_topics(self, timeout: float = 10.0):
        return self._metadata


class _UnreachableAdmin:
    def list_topics(self, timeout: float = 10.0):
        raise RuntimeError("broker unreachable")


def test_require_topics_all_present_proceeds():
    admin = _FakeAdmin(["topic-a", "topic-b"])
    require_topics(admin, ["topic-a", "topic-b"])  # must not raise/exit


def test_require_topics_missing_topic_exits_3_with_one_line(caplog):
    admin = _FakeAdmin(["topic-a"])
    with pytest.raises(SystemExit) as exc_info:
        require_topics(admin, ["topic-a", "topic-missing"])
    assert exc_info.value.code == 3
    lines = [r.message for r in caplog.records if "STARTUP_REFUSED" in r.message]
    assert lines == ["STARTUP_REFUSED missing_topic topic-missing"]


def test_require_topics_several_missing_logs_one_line_each(caplog):
    admin = _FakeAdmin([])
    with pytest.raises(SystemExit) as exc_info:
        require_topics(admin, ["topic-b", "topic-a"])
    assert exc_info.value.code == 3
    lines = [r.message for r in caplog.records if "STARTUP_REFUSED" in r.message]
    assert lines == [
        "STARTUP_REFUSED missing_topic topic-a",
        "STARTUP_REFUSED missing_topic topic-b",
    ]


def test_require_topics_unreachable_broker_exits_3(caplog):
    with pytest.raises(SystemExit) as exc_info:
        require_topics(_UnreachableAdmin(), ["topic-a"])
    assert exc_info.value.code == 3
    assert any(
        r.message.startswith("STARTUP_REFUSED unreachable broker")
        for r in caplog.records
    )


def test_require_topics_empty_list_proceeds():
    require_topics(_UnreachableAdmin(), [])  # nothing wanted, nothing checked


# --- require_tables -------------------------------------------------------


class _FakeConn:
    def __init__(self, existing: set[str]) -> None:
        self._existing = existing
        self.closed = False

    async def fetchval(self, query: str, table: str) -> Any:
        return table if table in self._existing else None

    async def close(self) -> None:
        self.closed = True


def _fake_connect(existing: set[str]):
    async def connect(dsn: str) -> _FakeConn:
        return _FakeConn(existing)
    return connect


def _unreachable_connect():
    async def connect(dsn: str):
        raise OSError("postgres unreachable")
    return connect


@pytest.mark.asyncio
async def test_require_tables_all_present_proceeds():
    await require_tables(
        "postgres://stand-in", ["intake_records"],
        connect=_fake_connect({"intake_records"}),
    )  # must not raise/exit


@pytest.mark.asyncio
async def test_require_tables_missing_table_exits_3_with_one_line(caplog):
    with pytest.raises(SystemExit) as exc_info:
        await require_tables(
            "postgres://stand-in", ["intake_records", "ghost_table"],
            connect=_fake_connect({"intake_records"}),
        )
    assert exc_info.value.code == 3
    lines = [r.message for r in caplog.records if "STARTUP_REFUSED" in r.message]
    assert lines == ["STARTUP_REFUSED missing_table ghost_table"]


@pytest.mark.asyncio
async def test_require_tables_unreachable_postgres_exits_3(caplog):
    with pytest.raises(SystemExit) as exc_info:
        await require_tables(
            "postgres://stand-in", ["intake_records"],
            connect=_unreachable_connect(),
        )
    assert exc_info.value.code == 3
    assert any(
        r.message.startswith("STARTUP_REFUSED unreachable postgres")
        for r in caplog.records
    )


@pytest.mark.asyncio
async def test_require_tables_closes_the_connection_even_when_missing():
    conn_holder: list[_FakeConn] = []

    async def connect(dsn: str) -> _FakeConn:
        conn = _FakeConn(set())
        conn_holder.append(conn)
        return conn

    with pytest.raises(SystemExit):
        await require_tables("postgres://stand-in", ["ghost_table"], connect=connect)
    assert conn_holder[0].closed is True


@pytest.mark.asyncio
async def test_require_tables_empty_list_proceeds():
    await require_tables(
        "postgres://stand-in", [], connect=_unreachable_connect(),
    )  # nothing wanted, nothing checked
