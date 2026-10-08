#!/usr/bin/env python3
"""exercise/control.py — exercise control service.

PLACEMENT: a small stdlib HTTP service, same discipline as
gateway/manual_qa_stub.py — no third-party deps, delivered as source into a
stock python image (see docker-compose.yml's `exercise` profile).

THE RULE THIS FILE EXISTS TO ENFORCE: the UI never learns the simulator's
state from anything the simulator or the adapter says. Two separate facts
are served, never merged into one:

  1. "Last command sent" (GET /exercise/status's `last_command`, also the
     POST /exercise/op/<op> response): what was sent, when, and what this
     service's own call to the adapter returned (an HTTP status, or a
     transport error) — worded as a SEND, never as a state.
  2. Running / paused / unknown (`activity`): derived ONLY from the
     sidecars' `dis_pdus_received_total{pdu_type="1"}` rate, never from the
     adapter's response body. A cut link is "unknown", never "paused" —
     unreachable is not evidence of a pause, it is an absence of evidence.

The adapter's own response body is read only for its HTTP status; it is
never parsed, stored, or returned — see _call_adapter below.
"""
from __future__ import annotations

import json
import logging
import os
import copy
import re
import ssl
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

log = logging.getLogger("exercise.control")

# The only op keys an adapter file may map — anything else refuses startup.
ALLOWED_OPS = frozenset({"pause", "resume", "stop", "restart", "run"})

# The restart gate (see AppState.restart_refusal): how old a measured zero may
# be before it no longer licenses a restart.
DEFAULT_RESTART_MAX_ZERO_AGE_S = 1800.0

PDU_METRIC = "dis_pdus_received_total"
_METRIC_LINE_RE = re.compile(
    r'^dis_pdus_received_total(\{(?P<labels>[^}]*)\})?\s+(?P<value>[-+0-9.eE]+)'
)
_PDU_TYPE_1_RE = re.compile(r'(^|[,{])\s*pdu_type\s*=\s*"1"\s*([,}]|$)')


# --- adapter config -----------------------------------------------------------

class AdapterConfigError(ValueError):
    """The adapter file is malformed. Startup refuses rather than guessing."""


def load_adapter_config(path: str | os.PathLike) -> dict[str, Any]:
    """`{name, endpoint, operations: {op: {method, path, body}}}` ->
    a normalized dict, or raises AdapterConfigError naming the bad entry.

    `name` is read and carried through to GET /exercise/status as a
    display label only — it is never matched against anything in this
    file. Unknown op key, a missing method/path, or a non-object body each
    refuse startup; there is no partial/best-effort adapter.
    """
    try:
        raw = Path(path).read_text(encoding="utf-8")
    except OSError as exc:
        raise AdapterConfigError(f"cannot read adapter file {path}: {exc}") from exc
    try:
        data = json.loads(raw)
    except ValueError as exc:
        raise AdapterConfigError(f"adapter file {path} is not valid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise AdapterConfigError(f"adapter file {path} must be a JSON object")

    name = data.get("name")
    endpoint = data.get("endpoint")
    if not isinstance(endpoint, str) or not endpoint:
        raise AdapterConfigError(f"adapter file {path}: 'endpoint' must be a non-empty string")

    operations = data.get("operations")
    if not isinstance(operations, dict) or not operations:
        raise AdapterConfigError(f"adapter file {path}: 'operations' must be a non-empty object")

    ops_out: dict[str, dict[str, Any]] = {}
    for op, entry in operations.items():
        if op not in ALLOWED_OPS:
            raise AdapterConfigError(
                f"adapter file {path}: operations entry {op!r} is not one of {sorted(ALLOWED_OPS)}"
            )
        if not isinstance(entry, dict):
            raise AdapterConfigError(f"adapter file {path}: operations.{op} must be an object")
        method = entry.get("method")
        op_path = entry.get("path")
        body = entry.get("body", {})
        if not isinstance(method, str) or not method.strip():
            raise AdapterConfigError(f"adapter file {path}: operations.{op} is missing 'method'")
        if not isinstance(op_path, str) or not op_path:
            raise AdapterConfigError(f"adapter file {path}: operations.{op} is missing 'path'")
        if not isinstance(body, dict):
            raise AdapterConfigError(f"adapter file {path}: operations.{op}.body must be an object")
        ops_out[op] = {"method": method.strip().upper(), "path": op_path, "body": body}

    return {"name": name if isinstance(name, str) else "", "endpoint": endpoint.rstrip("/"),
            "operations": ops_out}


# --- Prometheus text scraping --------------------------------------------------

def parse_pdu_total(text: str) -> float | None:
    """Sum `dis_pdus_received_total` samples whose labels carry
    `pdu_type="1"`, over any other labels. None when the metric name never
    appears at all (absent); 0.0 when it appears only with a value of 0 —
    those are different facts and are not collapsed into one."""
    total = 0.0
    found = False
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        m = _METRIC_LINE_RE.match(line)
        if not m:
            continue
        labels = m.group("labels") or ""
        if not _PDU_TYPE_1_RE.search(labels):
            continue
        try:
            total += float(m.group("value"))
        except ValueError:
            continue
        found = True
    return total if found else None


def _scrape_one(url: str, timeout: float = 5.0) -> float | None:
    """One source's current PDU total, or None for unreachable/absent --
    the two cases this module never tells apart at the per-source level
    (per source: reachable with a rate, or unreachable/absent)."""
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            text = resp.read().decode("utf-8", "replace")
    except Exception:  # noqa: BLE001 -- any failure here is "unreachable"
        return None
    return parse_pdu_total(text)


# --- derive_state: the pure function --------------------------------------------

def _source_rate(samples: list[tuple[float, float | None]], now: float,
                  window: float) -> tuple[bool, float | None]:
    """(reachable, rate) for one source's scrape history.

    `samples` is ascending by time, each entry (t, value): value is None
    when that scrape could not produce a number. A counter reset (a drop
    between consecutive present values) restarts the run — the rate is
    computed from the new value only, never spanning the reset."""
    if not samples:
        return False, None
    if samples[-1][1] is None:
        return False, None

    run_start = 0
    for i in range(1, len(samples)):
        prev_v, cur_v = samples[i - 1][1], samples[i][1]
        if prev_v is not None and cur_v is not None and cur_v < prev_v:
            run_start = i
    run = [s for s in samples[run_start:] if s[1] is not None]
    if len(run) < 2:
        return True, None  # reachable, but not enough data since the reset/start

    window_start = now - window
    in_window = [s for s in run if s[0] >= window_start]
    if len(in_window) < 2:
        in_window = run[-2:]

    t0, v0 = in_window[0]
    t1, v1 = in_window[-1]
    elapsed = t1 - t0
    if elapsed <= 0:
        return True, None
    return True, max(0.0, (v1 - v0) / elapsed)


def derive_state(samples_by_source: dict[str, list[tuple[float, float | None]]],
                  now: float, window: float, min_rate: float) -> dict[str, Any]:
    """Pure. `samples_by_source[url]` is that source's ascending (t, value)
    scrape history (value None for an unreachable/absent scrape). Returns
    `{state, label, sources: [{url, reachable, rate}]}`.

    Rules:
      - any reachable source rate >= min -> running
      - every source reachable, present, and the sum < min for a full
        window -> paused ("no entity PDUs")
      - otherwise (some source unreachable or counter absent, and no
        positive evidence) -> unknown
      - fewer than a full window of samples since start -> unknown
        ("measuring")
    """
    if not samples_by_source:
        return {"state": "unknown", "label": "measuring", "sources": []}

    sources: list[dict[str, Any]] = []
    earliest_first_seen: float | None = None
    any_running = False
    all_reachable_present = True
    sum_rate = 0.0

    for url, samples in samples_by_source.items():
        first_t = samples[0][0] if samples else now
        earliest_first_seen = first_t if earliest_first_seen is None else min(earliest_first_seen, first_t)

        reachable, rate = _source_rate(samples, now, window)
        sources.append({"url": url, "reachable": reachable, "rate": rate})

        if not reachable or rate is None:
            all_reachable_present = False
        else:
            sum_rate += rate
            if rate >= min_rate:
                any_running = True

    measuring = earliest_first_seen is None or (now - earliest_first_seen) < window

    # "measuring" takes priority over any single sample's evidence: a rate
    # computed from less than a full window is not yet trustworthy enough
    # to call running OR paused -- see compose_proof.sh's own predictions
    # (run/pause/resume each take up to window+scrape_interval to show).
    if measuring:
        return {"state": "unknown", "label": "measuring", "sources": sources}
    if any_running:
        return {"state": "running", "label": "running", "sources": sources}
    if all_reachable_present and sum_rate < min_rate:
        return {"state": "paused", "label": "no entity PDUs", "sources": sources}
    return {"state": "unknown", "label": "unknown", "sources": sources}


# --- the rate store (background scraping, shared with the HTTP handler) -------

class RateStore:
    """Scrape history per source, bounded to a few windows of memory."""

    def __init__(self, sources: list[str], window: float, min_rate: float):
        self.sources = sources
        self.window = window
        self.min_rate = min_rate
        self._lock = threading.Lock()
        self._samples: dict[str, list[tuple[float, float | None]]] = {u: [] for u in sources}

    def record(self, url: str, t: float, value: float | None) -> None:
        cutoff = t - self.window * 4
        with self._lock:
            history = self._samples.setdefault(url, [])
            history.append((t, value))
            trimmed = [s for s in history if s[0] >= cutoff]
            self._samples[url] = trimmed or [(t, value)]

    def status(self, now: float) -> dict[str, Any]:
        with self._lock:
            snapshot = {u: list(v) for u, v in self._samples.items()}
        return derive_state(snapshot, now, self.window, self.min_rate)

    def scrape_once(self) -> None:
        now = time.time()
        for url in self.sources:
            self.record(url, now, _scrape_one(url))


def scrape_loop(store: RateStore, interval_s: float, stop_event: threading.Event) -> None:
    while not stop_event.is_set():
        try:
            store.scrape_once()
        except Exception:  # noqa: BLE001 -- the scrape loop must never die
            log.exception("exercise rate scrape failed")
        stop_event.wait(interval_s)


# --- in-cluster reset Job ------------------------------------------------------
#
# POST /exercise/op/reset creates a Job from a chart-rendered template. The Job
# runs scripts/restart-exercise.sh in its in-cluster mode: the scenario reset,
# then the restart POST back to this service through the same restart gate
# (restart_refusal) every other client goes through. A halted reset is never
# retried: the chart's template sets backoffLimit 0, so a refusal ends the Job.
# "reset" is not an adapter op and never reaches the adapter.

RESET_COMPONENT_LABEL = "app.kubernetes.io/component"
RESET_INSTANCE_LABEL = "app.kubernetes.io/instance"
RESET_COMPONENT = "exercise-reset"
REQUESTED_BY_ANNOTATION = "openddil.io/requested-by"
RESET_SUBJECT_ENV = "RESTART_SUBJECT"
RESET_SUBJECT_PREFIX = "reset-job:"
SUBJECT_RE = re.compile(r"[A-Za-z0-9._@:-]{1,96}")
DEFAULT_SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount"
KUBE_API_TIMEOUT_S = 5.0


class ResetJobConfigError(AdapterConfigError):
    """The reset Job template is malformed. Startup refuses rather than guessing."""


class KubeApiError(RuntimeError):
    """A transport fault or non-2xx answer from the Kubernetes API."""

    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


class InvalidSubject(ValueError):
    pass


def load_reset_job_template(path: str | os.PathLike) -> dict[str, Any]:
    try:
        tpl = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ResetJobConfigError(f"reset job template unreadable: {exc}") from exc
    if not isinstance(tpl, dict) or tpl.get("kind") != "Job":
        raise ResetJobConfigError("reset job template must be an object with kind Job")
    meta = tpl.get("metadata")
    labels = meta.get("labels") if isinstance(meta, dict) else None
    if not isinstance(labels, dict) or labels.get(RESET_COMPONENT_LABEL) != RESET_COMPONENT:
        raise ResetJobConfigError(
            f"reset job template needs label {RESET_COMPONENT_LABEL}={RESET_COMPONENT}")
    instance = labels.get(RESET_INSTANCE_LABEL)
    if not isinstance(instance, str) or not instance:
        raise ResetJobConfigError(f"reset job template needs label {RESET_INSTANCE_LABEL}")
    try:
        env = tpl["spec"]["template"]["spec"]["containers"][0]["env"]
        has_subject = any(isinstance(e, dict) and e.get("name") == RESET_SUBJECT_ENV for e in env)
    except (KeyError, IndexError, TypeError):
        has_subject = False
    if not has_subject:
        raise ResetJobConfigError(f"reset job template needs a {RESET_SUBJECT_ENV} env entry")
    return tpl


def _job_state(job: dict[str, Any]) -> str:
    status = job.get("status") or {}
    conds = {c.get("type"): c.get("status") for c in status.get("conditions") or []
             if isinstance(c, dict)}
    if conds.get("Failed") == "True":
        return "failed"
    if conds.get("Complete") == "True":
        return "succeeded"
    if (status.get("active") or 0) > 0:
        return "running"
    if not status.get("completionTime"):
        return "running"
    return "succeeded"


def _job_summary(job: dict[str, Any]) -> dict[str, Any]:
    meta = job.get("metadata") or {}
    status = job.get("status") or {}
    done = [c for c in status.get("conditions") or [] if isinstance(c, dict)
            and c.get("type") in ("Complete", "Failed") and c.get("status") == "True"]
    finished = status.get("completionTime") or (done[0].get("lastTransitionTime") if done else None)
    return {
        "name": meta.get("name"),
        "state": _job_state(job),
        "started_at": status.get("startTime") or meta.get("creationTimestamp"),
        "finished_at": finished,
        "requested_by": (meta.get("annotations") or {}).get(REQUESTED_BY_ANNOTATION),
    }


class ResetJobLauncher:
    """Creates the reset Job and reports the newest one. Talks to the API with
    the pod's service account; TLS always verifies against the SA's ca.crt.
    `base_url` is a test-only injection (a loopback fake API over plain HTTP);
    production leaves it None and gets https://KUBERNETES_SERVICE_HOST:PORT."""

    def __init__(self, template_file: str | os.PathLike, sa_dir: str | os.PathLike | None = None,
                 base_url: str | None = None):
        self.template = load_reset_job_template(template_file)
        self.release = self.template["metadata"]["labels"][RESET_INSTANCE_LABEL]
        self.sa_dir = Path(sa_dir or os.getenv("EXERCISE_SA_DIR") or DEFAULT_SA_DIR)
        self.base_url = base_url
        # Serialises latest-check + create, so two clicks cannot both create.
        self._launch_lock = threading.Lock()

    def _namespace(self) -> str:
        return (self.sa_dir / "namespace").read_text(encoding="utf-8").strip()

    def _request(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        try:
            token = (self.sa_dir / "token").read_text(encoding="utf-8").strip()  # rotates
            if self.base_url:
                base, ctx = self.base_url, None
            else:
                host = os.environ["KUBERNETES_SERVICE_HOST"]
                port = os.environ.get("KUBERNETES_SERVICE_PORT", "443")
                if ":" in host:
                    host = f"[{host}]"
                base = f"https://{host}:{port}"
                ctx = ssl.create_default_context(cafile=str(self.sa_dir / "ca.crt"))
            headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
            data = None
            if body is not None:
                data = json.dumps(body).encode("utf-8")
                headers["Content-Type"] = "application/json"
            req = urllib.request.Request(base + path, data=data, method=method, headers=headers)
            with urllib.request.urlopen(req, timeout=KUBE_API_TIMEOUT_S, context=ctx) as resp:
                raw = resp.read()
                status = resp.status
        except urllib.error.HTTPError as exc:
            detail = exc.read()[:300].decode("utf-8", "replace")
            log.warning("kube api %s %s -> %d %s", method, path.split("?")[0], exc.code, detail)
            raise KubeApiError(f"kube api answered {exc.code}", exc.code) from exc
        except Exception as exc:  # noqa: BLE001 -- transport, TLS or file fault
            raise KubeApiError(f"kube api unreachable: {exc}") from exc
        if not 200 <= status < 300:
            raise KubeApiError(f"kube api answered {status}", status)
        try:
            return json.loads(raw)
        except ValueError as exc:
            raise KubeApiError("kube api answered non-JSON", status) from exc

    def _jobs_path(self) -> str:
        return f"/apis/batch/v1/namespaces/{self._namespace()}/jobs"

    def latest(self) -> dict[str, Any] | None:
        selector = (f"{RESET_COMPONENT_LABEL}={RESET_COMPONENT},"
                    f"{RESET_INSTANCE_LABEL}={self.release}")
        listing = self._request(
            "GET", self._jobs_path() + "?labelSelector=" + urllib.parse.quote(selector, safe=""))
        items = [j for j in listing.get("items") or [] if isinstance(j, dict)]
        if not items:
            return None
        newest = max(items, key=lambda j: (j.get("metadata") or {}).get("creationTimestamp") or "")
        return _job_summary(newest)

    def launch(self, subject: str) -> tuple[str, str | None]:
        """("running", existing job name) or ("created", new job name)."""
        if not SUBJECT_RE.fullmatch(subject):
            raise InvalidSubject(subject[:96])
        with self._launch_lock:
            current = self.latest()
            if current is not None and current["state"] == "running":
                return "running", current["name"]
            job = copy.deepcopy(self.template)
            for entry in job["spec"]["template"]["spec"]["containers"][0]["env"]:
                if isinstance(entry, dict) and entry.get("name") == RESET_SUBJECT_ENV:
                    entry["value"] = RESET_SUBJECT_PREFIX + subject
            job["metadata"].setdefault("annotations", {})[REQUESTED_BY_ANNOTATION] = subject
            created = self._request("POST", self._jobs_path(), job)
            return "created", (created.get("metadata") or {}).get("name")


# --- app state: adapter, last command, reset record ----------------------------

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class AppState:
    def __init__(self, adapter: dict[str, Any], store: RateStore, reset_record_file: str | None,
                 restart_max_zero_age_s: float = DEFAULT_RESTART_MAX_ZERO_AGE_S,
                 reset_launcher: ResetJobLauncher | None = None):
        self.adapter = adapter
        self.reset_launcher = reset_launcher
        self.restart_max_zero_age_s = restart_max_zero_age_s
        # measured_zero_at values an earlier successful restart already used.
        # In memory only: a pod restart loses it, and restart_max_zero_age_s
        # bounds how long a zero can then be reused -- the declared limit.
        self.restart_zero_used: str | None = None
        self.store = store
        self.reset_record_file = reset_record_file
        self._lock = threading.Lock()
        # Serialises restart POSTs from the gate check through the adapter
        # call and the "used" mark, so two concurrent restarts cannot both
        # pass the gate on one zero. Never held by GET /exercise/status.
        self.restart_lock = threading.Lock()
        self.last_command: dict[str, Any] | None = None

    def set_last_command(self, record: dict[str, Any]) -> None:
        with self._lock:
            self.last_command = record

    def get_last_command(self) -> dict[str, Any] | None:
        with self._lock:
            return self.last_command

    def read_reset(self) -> dict[str, Any]:
        """{measured_zero_at, verdict} from EXERCISE_RESET_RECORD_FILE, or
        both None when the file is absent, unreadable or malformed --
        "no measured zero on record", never guessed."""
        if not self.reset_record_file:
            return {"measured_zero_at": None, "verdict": None}
        try:
            data = json.loads(Path(self.reset_record_file).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {"measured_zero_at": None, "verdict": None}
        if not isinstance(data, dict):
            return {"measured_zero_at": None, "verdict": None}
        return {"measured_zero_at": data.get("measured_zero_at"), "verdict": data.get("verdict")}

    def restart_refusal(self, now: datetime | None = None) -> tuple[str | None, dict[str, Any]]:
        """(reason | None, reset record). THE restart gate, and the only copy
        of the rule: POST /exercise/op/restart and GET /exercise/status both
        call this. It lives here, in the one place that calls the adapter, so
        no client (popup, script, curl) can get around it.

        A restart is allowed only on a reset record with verdict PASS and a
        parseable UTC measured_zero_at that is no older than
        restart_max_zero_age_s and was not already used by an earlier
        successful restart. Reasons: no_record, verdict_not_pass,
        unparseable, stale, already_used.

        Limit: the "used" mark is in memory; after a pod restart it is lost,
        so the same zero can be used once more until it ages out -- the max
        age bounds that reuse."""
        rec = self.read_reset()
        at, verdict = rec["measured_zero_at"], rec["verdict"]
        if at is None and verdict is None:
            return "no_record", rec
        if verdict != "PASS":
            return "verdict_not_pass", rec
        try:
            if not isinstance(at, str):
                raise ValueError("not a string")
            parsed = datetime.fromisoformat(at.strip().replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                raise ValueError("no UTC offset")
        except ValueError:
            return "unparseable", rec
        age = ((now or datetime.now(timezone.utc)) - parsed).total_seconds()
        if age > self.restart_max_zero_age_s:
            return "stale", rec
        with self._lock:
            if self.restart_zero_used == at:
                return "already_used", rec
        return None, rec

    def mark_restart_zero_used(self, measured_zero_at: str) -> None:
        with self._lock:
            self.restart_zero_used = measured_zero_at

    def call_adapter(self, op: str) -> tuple[int | None, str | None]:
        """(status, error) -- the adapter's response BODY is read (to drain
        the connection) but never interpreted or returned; only the HTTP
        status (or a transport error string) crosses back out of this
        function. That is the whole of what "last command sent" may ever
        carry about the adapter's own answer."""
        entry = self.adapter["operations"][op]
        url = self.adapter["endpoint"] + entry["path"]
        body = entry["body"]
        data = json.dumps(body).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        req = urllib.request.Request(url, data=data, method=entry["method"], headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                resp.read()
                return resp.status, None
        except urllib.error.HTTPError as exc:
            exc.read()
            return exc.code, None
        except Exception as exc:  # noqa: BLE001 -- a transport fault, not a crash
            return None, str(exc)


# --- HTTP ----------------------------------------------------------------------

SUBJECT_HEADER = "X-OpenDDIL-Subject"


def make_handler(app: AppState) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "openddil-exercise-control/1.0"

        def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
            log.info("%s - %s", self.address_string(), fmt % args)

        def _send_json(self, status: int, payload: dict[str, Any]) -> None:
            out = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)

        def _drain(self) -> None:
            try:
                length = int(self.headers.get("Content-Length", 0) or 0)
            except ValueError:
                length = 0
            if length:
                self.rfile.read(length)

        def do_GET(self) -> None:  # noqa: N802
            if self.path == "/healthz":
                self._send_json(200, {"status": "ok"})
                return
            if self.path == "/exercise/status":
                now = time.time()
                activity = app.store.status(now)
                refusal, _rec = app.restart_refusal()
                reset_job: dict[str, Any] = {"available": app.reset_launcher is not None,
                                             "latest": None, "error": None}
                if app.reset_launcher is not None:
                    try:
                        reset_job["latest"] = app.reset_launcher.latest()
                    except KubeApiError as exc:
                        reset_job["error"] = str(exc)
                self._send_json(200, {
                    "adapter": {"name": app.adapter["name"],
                                "ops": sorted(app.adapter["operations"].keys())},
                    "last_command": app.get_last_command(),
                    "activity": {
                        "state": activity["state"],
                        "label": activity["label"],
                        "window_s": app.store.window,
                        "min_rate": app.store.min_rate,
                        "sources": activity["sources"],
                    },
                    "reset": app.read_reset(),
                    "restart_allowed": refusal is None,
                    "restart_refusal": refusal,
                    "reset_job": reset_job,
                })
                return
            self._send_json(404, {"error": "not found"})

        def do_POST(self) -> None:  # noqa: N802
            if not self.path.startswith("/exercise/op/"):
                self._drain()
                self._send_json(404, {"error": "not found"})
                return
            op = self.path[len("/exercise/op/"):]
            if op == "reset" and app.reset_launcher is not None:
                self._drain()
                self._handle_reset()
                return
            if op not in app.adapter["operations"]:
                # Refused BEFORE any outward call -- an unknown op never
                # reaches the adapter.
                self._drain()
                self._send_json(404, {"error": "unknown op", "op": op})
                return

            subject = self.headers.get(SUBJECT_HEADER, "").strip()
            self._drain()  # the client's own body is never used -- the
            # mapped call's body comes from the adapter file, not the caller.
            if not subject:
                self._send_json(400, {"error": "missing subject header"})
                return

            if op == "restart":
                with app.restart_lock:
                    reason, rec = app.restart_refusal()
                    if reason is not None:
                        # Refused BEFORE any outward call; last_command (what
                        # was last SENT) is deliberately left alone.
                        log.info(json.dumps({"exercise_op_refused": op, "reason": reason,
                                              "subject": subject}))
                        self._send_json(409, {"error": "reset required", "reason": reason,
                                              "measured_zero_at": rec["measured_zero_at"],
                                              "verdict": rec["verdict"]})
                        return
                    status, error = app.call_adapter(op)
                    if status is not None and 200 <= status < 300:
                        # Only a 2xx uses the zero up; a transport error or
                        # non-2xx leaves it available.
                        app.mark_restart_zero_used(rec["measured_zero_at"])
            else:
                status, error = app.call_adapter(op)
            record = {"op": op, "at": _now_iso(), "status": status, "error": error,
                      "subject": subject}
            app.set_last_command(record)
            log.info(json.dumps({"exercise_op": op, "status": status, "error": error,
                                  "subject": subject}))
            self._send_json(200, record)

        def _handle_reset(self) -> None:
            subject = self.headers.get(SUBJECT_HEADER, "").strip()
            if not subject:
                self._send_json(400, {"error": "missing subject header"})
                return
            try:
                outcome, job = app.reset_launcher.launch(subject)
            except InvalidSubject:
                self._send_json(400, {"error": "invalid subject"})
                return
            except KubeApiError as exc:
                log.warning(json.dumps({"exercise_reset_job": "not_created", "status": exc.status,
                                         "subject": subject}))
                self._send_json(502, {"error": "reset job not created", "status": exc.status})
                return
            if outcome == "running":
                log.info(json.dumps({"exercise_op_refused": "reset", "reason": "reset_running",
                                      "job": job, "subject": subject}))
                self._send_json(409, {"error": "reset already running",
                                      "reason": "reset_running", "job": job})
                return
            at = _now_iso()
            app.set_last_command({"op": "reset", "at": at, "status": 201, "error": None,
                                  "subject": subject, "job": job})
            log.info(json.dumps({"exercise_reset_job": job, "subject": subject}))
            self._send_json(202, {"op": "reset", "at": at, "job": job, "subject": subject})

    return Handler


def main() -> int:
    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s [exercise-control] %(message)s",
    )

    try:
        max_zero_age = float(os.getenv("EXERCISE_RESTART_MAX_ZERO_AGE_S",
                                       str(DEFAULT_RESTART_MAX_ZERO_AGE_S)))
        if not max_zero_age > 0:
            raise ValueError
    except ValueError:
        print("EXERCISE_RESTART_MAX_ZERO_AGE_S must be a number > 0", file=sys.stderr)
        return 2

    adapter_file = os.getenv("EXERCISE_ADAPTER_FILE", "")
    if not adapter_file:
        print("EXERCISE_ADAPTER_FILE is required", file=sys.stderr)
        return 1
    try:
        adapter = load_adapter_config(adapter_file)
    except AdapterConfigError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    sources = [s.strip() for s in os.getenv("EXERCISE_RATE_SOURCES", "").split(",") if s.strip()]
    window = float(os.getenv("EXERCISE_RATE_WINDOW_S", "30"))
    min_rate = float(os.getenv("EXERCISE_RATE_MIN", "0.1"))
    scrape_interval = float(os.getenv("EXERCISE_SCRAPE_INTERVAL_S", "5"))
    reset_record_file = os.getenv("EXERCISE_RESET_RECORD_FILE", "").strip() or None
    port = int(os.getenv("EXERCISE_PORT", "8095"))

    reset_launcher = None
    reset_job_file = os.getenv("EXERCISE_RESET_JOB_FILE", "").strip()
    if reset_job_file:
        try:
            reset_launcher = ResetJobLauncher(reset_job_file)
        except AdapterConfigError as exc:
            print(str(exc), file=sys.stderr)
            return 1

    store = RateStore(sources=sources, window=window, min_rate=min_rate)
    app = AppState(adapter=adapter, store=store, reset_record_file=reset_record_file,
                   restart_max_zero_age_s=max_zero_age,
                   reset_launcher=reset_launcher)

    stop_event = threading.Event()
    scraper = threading.Thread(target=scrape_loop, args=(store, scrape_interval, stop_event),
                                daemon=True)
    scraper.start()

    server = ThreadingHTTPServer(("0.0.0.0", port), make_handler(app))
    log.info("exercise control listening on :%d, adapter=%s, ops=%s, sources=%s",
              port, adapter["name"], sorted(adapter["operations"].keys()), sources)
    try:
        server.serve_forever()
    finally:
        stop_event.set()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
