"""Stand-in "adapter" for compose: runs the entity simulator as a child
process and exposes pause/resume/stop/run/restart over HTTP, so
exercise/control.py has something real to call under `docker compose
--profile exercise up`.

THIS FILE OWNS NOTHING ABOUT WHAT THE UI SHOWS. The UI's running/paused/
unknown state comes only from the simulator's own sidecar PDU-rate metric
(see control.py) — never from anything this file's HTTP responses say.
`STUB_LIE_STATE=running` exists only to prove that: it makes every
response body here claim `{"state": "running"}` no matter what the child
process is actually doing, and the rate-derived state must stay correct
anyway (see exercise/COMPOSE-PROOF.md's fail-on-purpose case).

Control model:
  - pause:   SIGSTOP the child (keeps the process, freezes it -- it sends
             no further PDUs while stopped).
  - resume:  SIGCONT the child.
  - stop:    SIGTERM the child and wait for it to exit.
  - run:     start a new child if none is alive; a no-op if one already is
             (paused counts as alive -- pause/resume toggle sending, not
             existence). Answers 502 if the script is missing or the child
             has exited within STUB_RUN_SETTLE_S of starting.
  - restart: stop then run.

Each request is logged as one JSON line and appended to an in-memory list
served at GET /requests, so a test can assert on call counts without
scraping logs.

Env:
  STUB_PORT            (8096)
  STUB_SIM_PATH        (/dis-sim/dis_sim.py) -- where the simulator script
                        is mounted (the chart sets /src/dis_sim.py).
  STUB_RUN_SETTLE_S    (1.0) seconds `run` waits for a fresh child; one that
                        has exited by then makes `run` answer 502.
  STUB_SIM_ARGS         extra args appended to the simulator's own argv,
                        shell-split (e.g. "--entities 4 --interval 2").
                        --host/--port are left to the simulator's own
                        DIS_TARGET_HOST/DIS_TARGET_PORT env defaults,
                        inherited from this process's environment.
  STUB_SIM_ARGS_CYCLE   JSON list of argument strings (each shell-split). When
                        set, the k-th child start (1-based, counted across
                        this process's life) uses element (k-1) % len in
                        place of STUB_SIM_ARGS, so successive runs can differ.
                        GET /requests reports the chosen `args_index`.
  STUB_LIE_STATE        "running" -> every response body's "state" field
                        is always "running" regardless of the child's
                        actual state (see the module docstring).
"""
from __future__ import annotations

import json
import logging
import os
import shlex
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger("stub_adapter")

STUB_PORT = int(os.getenv("STUB_PORT", "8096"))
STUB_SIM_PATH = os.getenv("STUB_SIM_PATH", "/dis-sim/dis_sim.py")
STUB_RUN_SETTLE_S = float(os.getenv("STUB_RUN_SETTLE_S", "1.0"))
STUB_SIM_ARGS = shlex.split(os.getenv("STUB_SIM_ARGS", ""))
STUB_SIM_ARGS_CYCLE = json.loads(os.getenv("STUB_SIM_ARGS_CYCLE", "") or "null")
STUB_LIE_STATE = os.getenv("STUB_LIE_STATE", "").strip().lower()

_OPS = ("pause", "resume", "stop", "run", "restart")

# SIGSTOP/SIGCONT are POSIX-only; this process always runs in a Linux
# container in compose, where they exist. They are looked up with getattr
# rather than a bare attribute reference so that running this module's
# tests directly on a non-POSIX host degrades to "pause/resume track state
# but do not actually freeze the child" instead of an AttributeError --
# compose's own real deployment target always has both signals.
_SIGSTOP = getattr(signal, "SIGSTOP", None)
_SIGCONT = getattr(signal, "SIGCONT", None)


class Sim:
    """Owns the one child simulator process. Not thread-safe by itself --
    callers take `self.lock`."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.proc: subprocess.Popen | None = None
        self.paused = False
        self.starts = 0  # child starts so far; picks the STUB_SIM_ARGS_CYCLE element
        self.args_index: int | None = None  # the cycle element the current/last child took

    def _alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def actual_state(self) -> str:
        if not self._alive():
            return "stopped"
        return "paused" if self.paused else "running"

    def run(self) -> dict:
        """Returns {"ok": True} or {"ok": False, "error": ..., ...}."""
        with self.lock:
            if self._alive():
                return {"ok": True}  # already running (or paused) -- not an error
            if not os.path.exists(STUB_SIM_PATH):
                return {"ok": False, "error": "sim script not found", "path": STUB_SIM_PATH}
            args = STUB_SIM_ARGS
            self.args_index = None
            if STUB_SIM_ARGS_CYCLE:
                self.args_index = self.starts % len(STUB_SIM_ARGS_CYCLE)
                args = shlex.split(STUB_SIM_ARGS_CYCLE[self.args_index])
            # A failed start below still counts: it was a start attempt, so
            # the next run takes the next STUB_SIM_ARGS_CYCLE element.
            self.starts += 1
            argv = [sys.executable, STUB_SIM_PATH, *args]
            self.proc = subprocess.Popen(argv)
            self.paused = False
            try:
                rc = self.proc.wait(timeout=STUB_RUN_SETTLE_S)
            except subprocess.TimeoutExpired:
                return {"ok": True}
            return {"ok": False, "error": "sim exited at start", "rc": rc}

    def pause(self) -> None:
        with self.lock:
            if self._alive() and not self.paused:
                if _SIGSTOP is not None:
                    self.proc.send_signal(_SIGSTOP)
                self.paused = True

    def resume(self) -> None:
        with self.lock:
            if self._alive() and self.paused:
                if _SIGCONT is not None:
                    self.proc.send_signal(_SIGCONT)
                self.paused = False

    def stop(self) -> None:
        with self.lock:
            if self._alive():
                if self.paused and _SIGCONT is not None:
                    # SIGTERM on a SIGSTOPped process is not delivered
                    # until it is continued -- resume first so it can
                    # actually act on the term signal.
                    self.proc.send_signal(_SIGCONT)
                self.proc.terminate()
                try:
                    self.proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
                    self.proc.wait(timeout=10)
            self.paused = False

    def restart(self) -> dict:
        self.stop()
        return self.run()


SIM = Sim()
REQUESTS: list[dict] = []
_REQUESTS_LOCK = threading.Lock()


def _record(op: str, result: dict | None = None) -> dict:
    entry = {"ts": time.time(), "op": op, "pid": SIM.proc.pid if SIM.proc else None}
    if op in ("run", "restart") and result is not None:
        entry.update({k: v for k, v in result.items() if k != "path"})
    if op == "run":
        entry["args_index"] = SIM.args_index
    with _REQUESTS_LOCK:
        REQUESTS.append(entry)
    log.info(json.dumps({"stub_adapter_op": op, "pid": entry["pid"]}))
    return entry


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a) -> None:  # quiet; _record()/log.info() cover it
        pass

    def _reply(self, status: int, body: dict) -> None:
        out = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def _state_field(self) -> str:
        if STUB_LIE_STATE == "running":
            return "running"
        return SIM.actual_state()

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/requests":
            with _REQUESTS_LOCK:
                body = list(REQUESTS)
            self._reply(200, {"requests": body})
            return
        if self.path == "/healthz":
            self._reply(200, {"ok": True})
            return
        self._reply(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length:
            self.rfile.read(length)  # drained, never interpreted

        op = self.path.lstrip("/")
        if op not in _OPS:
            self._reply(404, {"error": "unknown op"})
            return

        result = getattr(SIM, op)()
        entry = _record(op, result)
        if result is not None and not result["ok"]:
            self._reply(502, {"op": op, **{k: v for k, v in result.items() if k != "ok"}})
            return
        self._reply(200, {"op": op, "pid": entry["pid"], "state": self._state_field()})


def main() -> int:
    srv = ThreadingHTTPServer(("0.0.0.0", STUB_PORT), Handler)
    log.info(json.dumps({"stub_adapter_listening": STUB_PORT, "sim_path": STUB_SIM_PATH}))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        SIM.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
