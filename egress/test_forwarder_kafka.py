"""Integration tests for egress/forwarder.py against a real broker and a real
Postgres, both started here in containers and removed afterwards.

Run: `python -m pytest egress/test_forwarder_kafka.py -q` from openddil-demo/.
Skipped cleanly when docker (or the client libraries) is absent.

The forwarder runs as a SUBPROCESS (so it can be killed, and so its exit code
and log are what the tests assert on), pointed at the containers by env. The
destination is an in-test HTTP server that counts POSTs per event_id and
answers from a script the test controls.

  I1  eviction: a retry wait longer than max.poll.interval.ms must not get the
      member evicted -- the process stays up, one 2xx POST, one delivered row,
      offset committed.
  I2  kill mid-retry, restart with the same group: one 2xx POST in total.
  I3  replay after a crash is a no-op (`duplicate`, zero POSTs) -- and the
      same run on a route with no dedupe_field POSTs once, so the check is
      shown able to fail.
  I4  retries exhausted and the `held` write forced to fail (a trigger in the
      test database): a `failed` row is written, the offset committed, the
      forwarder still running. Control A: without the trigger the row is
      `held`. Control B: with only the original migration (no 'failed' in the
      CHECK) and the trigger, there is no row and the forwarder logs
      `declared-undelivered`.
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

confluent_kafka = pytest.importorskip("confluent_kafka")
asyncpg = pytest.importorskip("asyncpg")

from confluent_kafka import Consumer, Producer, TopicPartition  # noqa: E402
from confluent_kafka.admin import AdminClient, NewTopic  # noqa: E402

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent  # the directory holding openddil-demo, openddil-helm, openddil-stack
MIGRATIONS_DIR = REPO / "openddil-stack" / "schema" / "migrations"
MIGRATION = MIGRATIONS_DIR / "20261006020000_egress_delivered_events.sql"  # the original, without 'failed'


def _migrations() -> list[Path]:
    """Every migration that touches egress_delivered_events, in filename order."""
    return sorted(MIGRATIONS_DIR.glob("*egress_delivered_events*.sql"), key=lambda p: p.name)

VALUES = REPO / "openddil-helm" / "openddil-demo" / "values.yaml"

# Fallbacks only if the chart values cannot be read; the chart is the source.
_REDPANDA_FALLBACK = "docker.redpanda.com/redpandadata/redpanda:v26.1.7"
_POSTGRES_FALLBACK = "postgres:15"

# Optional alternative launcher (path to a python script), used to drive code
# that predates OPENDDIL_FORWARD_MAX_POLL_INTERVAL_MS.
LAUNCHER = os.environ.get("FWD_TEST_LAUNCHER")


def _docker_ok() -> bool:
    if shutil.which("docker") is None:
        return False
    try:
        return subprocess.run(["docker", "info"], capture_output=True, timeout=30).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def _chart_image(block: str, fallback: str) -> str:
    """`repository:tag` of a top-level block in the chart's values.yaml."""
    try:
        lines = VALUES.read_text(encoding="utf-8").splitlines()
        start = lines.index(f"{block}:")
        repo = tag = None
        for line in lines[start + 1:start + 8]:
            if line.strip().startswith("repository:"):
                repo = line.split(":", 1)[1].strip()
            if line.strip().startswith("tag:"):
                tag = line.split(":", 1)[1].strip().strip('"')
            if repo and tag:
                return f"{repo}:{tag}"
    except (OSError, ValueError):
        pass
    return fallback


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_for(pred, timeout: float, what: str, interval: float = 0.5):
    deadline = time.monotonic() + timeout
    while True:
        value = pred()
        if value:
            return value
        if time.monotonic() > deadline:
            raise AssertionError(f"timed out after {timeout:.0f}s waiting for {what}")
        time.sleep(interval)


@pytest.fixture(scope="module")
def stack():
    if not _docker_ok():
        pytest.skip("docker is not available")
    if not MIGRATION.exists() or not _migrations():
        pytest.skip(f"migration not found: {MIGRATION}")

    started: list[str] = []

    def run(args: list[str]) -> None:
        name = args[args.index("--name") + 1]
        out = subprocess.run(["docker", "run", "-d", *args], capture_output=True, text=True, timeout=900)
        if out.returncode != 0:
            pytest.skip(f"docker run failed: {out.stderr.strip()[-300:]}")
        started.append(name)

    tag = uuid.uuid4().hex[:8]
    rp_name, pg_name = f"fwdtest-{tag}-rp", f"fwdtest-{tag}-pg"
    rp_port, pg_port = _free_port(), _free_port()
    try:
        run([
            "--name", rp_name, "-p", f"127.0.0.1:{rp_port}:{rp_port}",
            _chart_image("redpandaEdge", _REDPANDA_FALLBACK),
            "redpanda", "start", "--mode", "dev-container", "--smp", "1", "--memory", "1G",
            "--reserve-memory", "0M", "--check=false",
            "--kafka-addr", f"0.0.0.0:{rp_port}", "--advertise-kafka-addr", f"127.0.0.1:{rp_port}",
        ])
        run([
            "--name", pg_name, "-p", f"127.0.0.1:{pg_port}:5432",
            "-e", "POSTGRES_PASSWORD=pw", "-e", "POSTGRES_DB=openddil",
            _chart_image("postgresHq", _POSTGRES_FALLBACK),
        ])
        brokers = f"127.0.0.1:{rp_port}"
        dsn = f"postgres://postgres:pw@127.0.0.1:{pg_port}/openddil"

        admin = AdminClient({"bootstrap.servers": brokers})

        def broker_up():
            try:
                admin.list_topics(timeout=3)
                return True
            except Exception:  # noqa: BLE001
                return False

        _wait_for(broker_up, 120, "redpanda to accept connections", interval=1.0)

        async def _prep():
            deadline = time.monotonic() + 90
            while True:
                try:
                    conn = await asyncpg.connect(dsn)
                    break
                except Exception:  # noqa: BLE001
                    if time.monotonic() > deadline:
                        raise
                    await asyncio.sleep(1.0)
            try:
                for migration in _migrations():
                    await conn.execute(migration.read_text(encoding="utf-8"))
            finally:
                await conn.close()

        asyncio.run(_prep())
        yield {"brokers": brokers, "dsn": dsn, "admin": admin,
               "server_dsn": f"postgres://postgres:pw@127.0.0.1:{pg_port}/postgres"}
    finally:
        for name in started:  # only containers this fixture started
            subprocess.run(["docker", "rm", "-f", name], capture_output=True, timeout=120)


class Destination:
    """An HTTP server counting POSTs per event_id; `script(event_id, n, age)`
    returns the status for the n-th POST (1-based) of that event, `age` being
    seconds since that event's first POST."""

    def __init__(self) -> None:
        self.posts: dict[str, list[tuple[float, int]]] = {}
        self.script = lambda event_id, n, age: 200
        self._lock = threading.Lock()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                length = int(self.headers.get("Content-Length", "0"))
                body = json.loads(self.rfile.read(length) or b"{}")
                event_id = body.get("payload", {}).get("event_id", "?")
                now = time.monotonic()
                with outer._lock:
                    seen = outer.posts.setdefault(event_id, [])
                    age = now - seen[0][0] if seen else 0.0
                    status = outer.script(event_id, len(seen) + 1, age)
                    seen.append((now, status))
                payload = json.dumps({"workflow": {"case_id": event_id}}).encode() if status == 200 else b"{}"
                self.send_response(status)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *_a):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/ingest"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def count(self, event_id: str, status: int | None = None) -> int:
        with self._lock:
            return sum(1 for _, s in self.posts.get(event_id, []) if status is None or s == status)

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def dest():
    d = Destination()
    yield d
    d.close()


class Case:
    """One topic, group and route, with helpers to run the forwarder."""

    def __init__(self, stack, dest, tmp_path, *, dedupe: bool = True, max_poll_ms: int | None = None,
                 extra_env: dict[str, str] | None = None):
        self.stack, self.dest, self.tmp_path = stack, dest, tmp_path
        self.extra_env = extra_env or {}
        tag = uuid.uuid4().hex[:8]
        self.topic, self.group, self.route = f"sink-{tag}", f"grp-{tag}", f"route-{tag}"
        self.max_poll_ms = max_poll_ms
        self.procs: list[subprocess.Popen] = []
        entry = {"name": self.route, "sink_topic": self.topic, "url": dest.url, "kind": "KindA"}
        if dedupe:
            entry["dedupe_field"] = "event_id"
        self.config = tmp_path / "forward.json"
        self.config.write_text(json.dumps([entry]))
        fs = stack["admin"].create_topics([NewTopic(self.topic, num_partitions=1, replication_factor=1)])
        fs[self.topic].result(30)

    def produce(self, event_id: str) -> None:
        p = Producer({"bootstrap.servers": self.stack["brokers"]})
        p.produce(self.topic, key=event_id.encode(), value=json.dumps({"event_id": event_id}).encode())
        assert p.flush(30) == 0

    def start(self) -> subprocess.Popen:
        env = dict(os.environ)
        env.update({
            "OPENDDIL_FORWARD_CONFIG": str(self.config),
            "OPENDDIL_EGRESS_BROKERS": self.stack["brokers"],
            "OPENDDIL_FORWARD_GROUP": self.group,
            "POSTGRES_DSN": self.stack["dsn"],
            "PYTHONUNBUFFERED": "1",
        })
        env.update(self.extra_env)
        if self.max_poll_ms is not None:
            env["OPENDDIL_FORWARD_MAX_POLL_INTERVAL_MS"] = str(self.max_poll_ms)
            env["OPENDDIL_FORWARD_SESSION_TIMEOUT_MS"] = "6000"  # must be <= max.poll.interval.ms
        cmd = [sys.executable, LAUNCHER] if LAUNCHER else [sys.executable, "-m", "forwarder"]
        log_path = self.tmp_path / f"forwarder-{len(self.procs)}.log"
        log_file = open(log_path, "wb")
        proc = subprocess.Popen(cmd, cwd=HERE, env=env, stdout=log_file, stderr=subprocess.STDOUT)
        proc.log_path = log_path  # type: ignore[attr-defined]
        self.procs.append(proc)
        return proc

    @staticmethod
    def log(proc) -> str:
        try:
            return proc.log_path.read_text(errors="replace")
        except OSError:
            return ""

    def stop_all(self) -> None:
        for proc in self.procs:
            if proc.poll() is None:
                proc.kill()
            proc.wait(timeout=30)

    def rows(self, event_id: str) -> list[dict]:
        async def _q():
            conn = await asyncpg.connect(self.stack["dsn"])
            try:
                got = await conn.fetch(
                    'SELECT "outcome", "http_status", "case_id" FROM "egress_delivered_events"'
                    ' WHERE "route" = $1 AND "event_id" = $2', self.route, event_id)
                return [dict(r) for r in got]
            finally:
                await conn.close()
        return asyncio.run(_q())

    def insert_delivered(self, event_id: str) -> None:
        async def _x():
            conn = await asyncpg.connect(self.stack["dsn"])
            try:
                await conn.execute(
                    'INSERT INTO "egress_delivered_events" ("route","event_id","outcome","http_status","case_id",'
                    '"topic","partition","kafka_offset","first_recorded_at","recorded_at")'
                    " VALUES ($1,$2,'delivered',200,$2,$3,0,0,now(),now())",
                    self.route, event_id, self.topic)
            finally:
                await conn.close()
        asyncio.run(_x())

    def committed_offset(self) -> int:
        c = Consumer({"bootstrap.servers": self.stack["brokers"], "group.id": self.group,
                      "enable.auto.commit": False})
        try:
            got = c.committed([TopicPartition(self.topic, 0)], timeout=10)
            return got[0].offset  # negative when nothing is committed
        finally:
            c.close()


@pytest.fixture
def make_case(stack, dest, tmp_path):
    cases: list[Case] = []

    def _make(**kw) -> Case:
        case = Case(kw.pop("stack", stack), dest, tmp_path, **kw)
        cases.append(case)
        return case

    yield _make
    for case in cases:
        case.stop_all()


def test_i1_long_retry_wait_does_not_evict_the_consumer(make_case, dest):
    case = make_case(max_poll_ms=10000)
    event = "E-i1"
    dest.script = lambda eid, n, age: 503 if age < 25.0 else 200
    case.produce(event)
    proc = case.start()

    def settled():
        return case.rows(event) or proc.poll() is not None
    _wait_for(settled, 150, "the 200 to be recorded (or the forwarder to exit)")
    # Give the commit time to happen (or the process time to die of it).
    _wait_for(lambda: proc.poll() is not None or case.committed_offset() >= 1, 30,
              "the offset to be committed (or the forwarder to exit)")

    tail = "\n".join(case.log(proc).splitlines()[-6:])
    assert proc.poll() is None, f"forwarder exited {proc.returncode} after the 200; log tail:\n{tail}"
    assert dest.count(event, 200) == 1
    rows = case.rows(event)
    assert len(rows) == 1 and rows[0]["outcome"] == "delivered" and rows[0]["case_id"] == event
    assert case.committed_offset() == 1


def test_i2_kill_mid_retry_then_restart_delivers_exactly_once(make_case, dest):
    case = make_case()
    event = "E-i2"
    dest.script = lambda eid, n, age: 503
    case.produce(event)
    first = case.start()
    _wait_for(lambda: dest.count(event) >= 2, 90, "two retried POSTs")
    first.kill()
    first.wait(timeout=30)
    dest.script = lambda eid, n, age: 200
    second = case.start()
    # the killed member holds the partition until its session expires
    _wait_for(lambda: case.rows(event), 180, "the restarted forwarder to record the delivery")
    _wait_for(lambda: case.committed_offset() >= 1, 30, "the offset to be committed")

    assert second.poll() is None, f"restarted forwarder exited {second.returncode}"
    assert dest.count(event, 200) == 1
    rows = case.rows(event)
    assert len(rows) == 1 and rows[0]["outcome"] == "delivered"


def test_i3_replay_of_a_delivered_event_is_a_duplicate_with_zero_posts(make_case, dest):
    case = make_case(dedupe=True)
    event = "E-i3"
    case.insert_delivered(event)
    case.produce(event)
    proc = case.start()
    _wait_for(lambda: '"outcome": "duplicate"' in case.log(proc), 90, "the duplicate outcome")
    _wait_for(lambda: case.committed_offset() >= 1, 30, "the offset to be committed")
    assert dest.count(event) == 0


def test_i3_can_fail_same_run_without_dedupe_posts_once(make_case, dest):
    case = make_case(dedupe=False)
    event = "E-i3-control"
    case.insert_delivered(event)  # present in the table, but this route does not consult it
    case.produce(event)
    proc = case.start()
    _wait_for(lambda: dest.count(event, 200) >= 1, 90, "the control POST")
    _wait_for(lambda: case.committed_offset() >= 1, 30, "the offset to be committed")
    assert dest.count(event) == 1
    assert '"outcome": "duplicate"' not in case.log(proc)


# --- I4: exhausted + held write fails -> failed row (or declared-undelivered) --

_REFUSE_HELD = """
CREATE FUNCTION refuse_held() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.outcome = 'held' THEN
    RAISE EXCEPTION 'held write refused by test';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER refuse_held BEFORE INSERT OR UPDATE ON "egress_delivered_events"
  FOR EACH ROW EXECUTE FUNCTION refuse_held();
"""


def _fresh_db(stack, migrations: list[Path], *, refuse_held: bool) -> dict:
    """A private database on the fixture's postgres, with just `migrations`
    applied and optionally the trigger that refuses any `held` write."""
    name = f"db_{uuid.uuid4().hex[:8]}"
    dsn = stack["dsn"].rsplit("/", 1)[0] + "/" + name

    async def _x():
        conn = await asyncpg.connect(stack["server_dsn"])
        try:
            await conn.execute(f'CREATE DATABASE "{name}"')
        finally:
            await conn.close()
        conn = await asyncpg.connect(dsn)
        try:
            for migration in migrations:
                await conn.execute(migration.read_text(encoding="utf-8"))
            if refuse_held:
                await conn.execute(_REFUSE_HELD)
        finally:
            await conn.close()
    asyncio.run(_x())
    return {**stack, "dsn": dsn}


def _run_exhausted_case(make_case, dest, stack, event, *, migrations, refuse_held):
    dest.script = lambda eid, n, age: 503
    case = make_case(stack=_fresh_db(stack, migrations, refuse_held=refuse_held), dedupe=True,
                     extra_env={"OPENDDIL_FORWARD_RETRY_MAX_S": "5"})
    case.produce(event)
    proc = case.start()
    _wait_for(lambda: case.committed_offset() >= 1, 120, "the exhausted record's offset to be committed")
    return case, proc


def test_i4_exhausted_and_held_write_fails_records_failed(make_case, dest, stack):
    event = "E-i4"
    case, proc = _run_exhausted_case(make_case, dest, stack, event, migrations=_migrations(), refuse_held=True)
    rows = case.rows(event)
    assert len(rows) == 1 and rows[0]["outcome"] == "failed", rows
    assert case.committed_offset() == 1
    assert proc.poll() is None, f"forwarder exited {proc.returncode}"
    assert "declared-undelivered" not in case.log(proc)


def test_i4_control_a_without_the_trigger_the_row_is_held(make_case, dest, stack):
    event = "E-i4-a"
    case, proc = _run_exhausted_case(make_case, dest, stack, event, migrations=_migrations(), refuse_held=False)
    rows = case.rows(event)
    assert len(rows) == 1 and rows[0]["outcome"] == "held", rows
    assert proc.poll() is None


def test_i4_control_b_original_migration_only_declares_undelivered(make_case, dest, stack):
    event = "E-i4-b"
    case, proc = _run_exhausted_case(make_case, dest, stack, event, migrations=[MIGRATION], refuse_held=True)
    assert case.rows(event) == []
    assert case.committed_offset() == 1
    assert proc.poll() is None, f"forwarder exited {proc.returncode}"
    assert "declared-undelivered" in case.log(proc)
