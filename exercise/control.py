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

NAMED SEQUENCES: an optional JSON file (EXERCISE_SEQUENCES_FILE) declares
named, timed lists of HTTP calls and waits against in-cluster exercise
apparatus; POST /exercise/op/<name> starts one in a background thread and
answers 202 with a run record whose per-step state is served by GET
/exercise/status. Halt rule: the first step that is not 2xx, or that hits a
transport error, is marked failed, every later step is skipped and the run is
halted; a halted run undoes nothing, whatever the executed steps changed stays
changed. A URL never carries credentials: a sequence file with one in a URL is
refused at startup. Only one sequence runs at a time, and the run lives in
memory only: a pod restart loses a running sequence.
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

_WAN_PROXY_RE = re.compile(r"^/proxies/(?P<proxy>[^/]+)$")
_WAN_TOXICS_RE = re.compile(r"^/proxies/(?P<proxy>[^/]+)/toxics(/.*)?$")

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
    """`{name, endpoint, operations: {op: {method, path, body} | [{method, path, body}, ...]}}` ->
    a normalized dict, or raises AdapterConfigError naming the bad entry.

    `name` is read and carried through to GET /exercise/status as a
    display label only — it is never matched against anything in this
    file. Unknown op key, a missing method/path, or a non-object body each
    refuse startup; there is no partial/best-effort adapter. An op is one
    call or a non-empty list of calls; every op is normalized to a list of
    steps.
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

    ops_out: dict[str, list[dict[str, Any]]] = {}
    for op, entry in operations.items():
        if op not in ALLOWED_OPS:
            raise AdapterConfigError(
                f"adapter file {path}: operations entry {op!r} is not one of {sorted(ALLOWED_OPS)}"
            )
        if isinstance(entry, list):
            if not entry:
                raise AdapterConfigError(f"adapter file {path}: operations.{op} must not be an empty list")
            raw_steps = [(f"operations.{op}[{i}]", step) for i, step in enumerate(entry)]
        else:
            raw_steps = [(f"operations.{op}", entry)]
        steps_out = []
        for label, step in raw_steps:
            if not isinstance(step, dict):
                raise AdapterConfigError(f"adapter file {path}: {label} must be an object")
            method = step.get("method")
            op_path = step.get("path")
            body = step.get("body", {})
            if not isinstance(method, str) or not method.strip():
                raise AdapterConfigError(f"adapter file {path}: {label} is missing 'method'")
            if not isinstance(op_path, str) or not op_path:
                raise AdapterConfigError(f"adapter file {path}: {label} is missing 'path'")
            if not isinstance(body, dict):
                raise AdapterConfigError(f"adapter file {path}: {label}.body must be an object")
            steps_out.append({"method": method.strip().upper(), "path": op_path, "body": body})
        ops_out[op] = steps_out

    return {"name": name if isinstance(name, str) else "", "endpoint": endpoint.rstrip("/"),
            "operations": ops_out}


SEQUENCE_NAME_RE = re.compile(r"[a-z]{1,32}")
SEQUENCE_MAX_STEPS = 32
SEQUENCE_MAX_WAIT_STEP_S = 900
SEQUENCE_MAX_WAIT_TOTAL_S = 1800


def load_sequences(path: str | os.PathLike | None) -> dict[str, dict[str, Any]]:
    """`{name: {label, description?, steps: [...]}}` -> `{name: {label,
    description, steps}}`, or raises AdapterConfigError naming the sequence
    and step. An unset or empty path, or a file holding `{}`, means no
    sequences. A step is `{"wait_s": n}` (0 < n <= 900) or `{"method", "url",
    "body"?, "name"?}`; the url is plain http with a host and no credentials.
    A sequence has 1..32 steps and at most 1800 s of waiting in total.
    """
    if path is None or str(path).strip() == "":
        return {}
    try:
        raw = Path(path).read_text(encoding="utf-8")
    except OSError as exc:
        raise AdapterConfigError(f"cannot read sequences file {path}: {exc}") from exc
    try:
        data = json.loads(raw)
    except ValueError as exc:
        raise AdapterConfigError(f"sequences file {path} is not valid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise AdapterConfigError(f"sequences file {path} must be a JSON object")

    out: dict[str, dict[str, Any]] = {}
    for name, entry in data.items():
        if not SEQUENCE_NAME_RE.fullmatch(name):
            raise AdapterConfigError(
                f"sequences file {path}: sequence name {name!r} must match [a-z]{{1,32}}")
        if name in ALLOWED_OPS or name == "reset":
            raise AdapterConfigError(
                f"sequences file {path}: sequence name {name!r} collides with a built-in op")
        if not isinstance(entry, dict):
            raise AdapterConfigError(f"sequences file {path}: sequence {name!r} must be an object")
        label = entry.get("label")
        if not isinstance(label, str) or not label.strip():
            raise AdapterConfigError(
                f"sequences file {path}: sequence {name!r}: 'label' must be a non-empty string")
        description = entry.get("description", "")
        if not isinstance(description, str):
            raise AdapterConfigError(
                f"sequences file {path}: sequence {name!r}: 'description' must be a string")
        raw_steps = entry.get("steps")
        if not isinstance(raw_steps, list) or not 1 <= len(raw_steps) <= SEQUENCE_MAX_STEPS:
            raise AdapterConfigError(
                f"sequences file {path}: sequence {name!r}: 'steps' must be a list of "
                f"1..{SEQUENCE_MAX_STEPS} entries")
        steps: list[dict[str, Any]] = []
        total_wait = 0.0
        for i, step in enumerate(raw_steps):
            where = f"sequences file {path}: sequence {name!r} step {i}"
            if not isinstance(step, dict):
                raise AdapterConfigError(f"{where}: must be an object")
            if "wait_s" in step:
                wait = step["wait_s"]
                if (isinstance(wait, bool) or not isinstance(wait, (int, float))
                        or not 0 < wait <= SEQUENCE_MAX_WAIT_STEP_S):
                    raise AdapterConfigError(
                        f"{where}: wait_s must be a number > 0 and <= {SEQUENCE_MAX_WAIT_STEP_S}")
                total_wait += wait
                steps.append({"wait_s": wait})
                continue
            method = step.get("method")
            url = step.get("url")
            body = step.get("body", {})
            step_name = step.get("name")
            if not isinstance(method, str) or not method.strip():
                raise AdapterConfigError(f"{where}: missing 'method'")
            if not isinstance(url, str) or not url.startswith("http://"):
                raise AdapterConfigError(f"{where}: 'url' must be a string starting http://")
            parts = urllib.parse.urlsplit(url)
            if not parts.hostname or "@" in parts.netloc:
                raise AdapterConfigError(
                    f"{where}: 'url' needs a host and must not carry credentials")
            if not isinstance(body, dict):
                raise AdapterConfigError(f"{where}: 'body' must be an object")
            if step_name is not None and not isinstance(step_name, str):
                raise AdapterConfigError(f"{where}: 'name' must be a string")
            steps.append({"method": method.strip().upper(), "url": url, "body": body,
                          "name": step_name})
        if total_wait > SEQUENCE_MAX_WAIT_TOTAL_S:
            raise AdapterConfigError(
                f"sequences file {path}: sequence {name!r}: total wait_s {total_wait} exceeds "
                f"{SEQUENCE_MAX_WAIT_TOTAL_S}")
        out[name] = {"label": label.strip(), "description": description, "steps": steps}
    return out


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
RESET_CONFIRM_ENV = "RESET_CONFIRM_CANCEL_OPEN"
CONFIRMED_OPEN_ANNOTATION = "openddil.io/confirmed-open"
RESET_BODY_MAX_BYTES = 1024
RESET_BODY_KEYS = frozenset({"confirm_cancel_open", "seen_open"})
DEFAULT_RESET_MAX_OPEN = 300
PREFLIGHT_TIMEOUT_S = 10.0
PREFLIGHT_SQL = "select count(*) as n from sys_invocation where status <> 'completed'"
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


def reset_mode() -> str:
    """What the reset button runs: "quick" or "full". Unset or anything else is
    "full", so a chart that predates the setting behaves as it always did."""
    return "quick" if os.getenv("EXERCISE_RESET_MODE", "").strip() == "quick" else "full"


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


class KubeApi:
    """The in-cluster API as the pod's service account. TLS always verifies
    against the SA's ca.crt. `base_url` is a test-only injection (a loopback
    fake API over plain HTTP); production leaves it None and gets
    https://KUBERNETES_SERVICE_HOST:PORT."""

    def __init__(self, sa_dir: str | os.PathLike | None = None, base_url: str | None = None):
        self.sa_dir = Path(sa_dir or os.getenv("EXERCISE_SA_DIR") or DEFAULT_SA_DIR)
        self.base_url = base_url

    def _namespace(self) -> str:
        return (self.sa_dir / "namespace").read_text(encoding="utf-8").strip()

    def _request(self, method: str, path: str, body: dict[str, Any] | None = None,
                 content_type: str = "application/json") -> dict[str, Any]:
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
                headers["Content-Type"] = content_type
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


class ResetJobLauncher(KubeApi):
    """Creates the reset Job and reports the newest one."""

    def __init__(self, template_file: str | os.PathLike, sa_dir: str | os.PathLike | None = None,
                 base_url: str | None = None):
        super().__init__(sa_dir, base_url)
        self.template = load_reset_job_template(template_file)
        self.release = self.template["metadata"]["labels"][RESET_INSTANCE_LABEL]
        # Serialises latest-check + create, so two clicks cannot both create.
        self._launch_lock = threading.Lock()

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

    def launch(self, subject: str,
               confirmed_open: int | None = None) -> tuple[str, str | None]:
        """("running", existing job name) or ("created", new job name).

        confirmed_open is not None -> the operator confirmed cancelling the
        open Restate work they were shown: the reset container gets
        RESET_CONFIRM_CANCEL_OPEN=1 and the Job an annotation with the count."""
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
            if confirmed_open is not None:
                container = job["spec"]["template"]["spec"]["containers"][0]
                container["env"] = [e for e in container["env"]
                                    if not (isinstance(e, dict) and e.get("name") == RESET_CONFIRM_ENV)]
                container["env"].append({"name": RESET_CONFIRM_ENV, "value": "1"})
                job["metadata"]["annotations"][CONFIRMED_OPEN_ANNOTATION] = str(confirmed_open)
            created = self._request("POST", self._jobs_path(), job)
            return "created", (created.get("metadata") or {}).get("name")


# --- reset pre-flight: open Restate invocations --------------------------------

def parse_restate_admin_urls(raw: str) -> list[tuple[str, str]]:
    """"name=url,name=url" -> [(name, url)]; blank entries are skipped."""
    out: list[tuple[str, str]] = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        name, sep, url = part.partition("=")
        if not sep or not name.strip() or not url.strip():
            raise AdapterConfigError(f"EXERCISE_RESTATE_ADMIN_URLS entry {part[:60]!r} is not name=url")
        out.append((name.strip(), url.strip()))
    return out


def _short(text: str) -> str:
    return " ".join(str(text).split())[:120]


def count_open(url: str, timeout: float = PREFLIGHT_TIMEOUT_S) -> int:
    """Open (non-completed) invocations on one Restate runtime; raises on any fault."""
    req = urllib.request.Request(
        url.rstrip("/") + "/query", data=json.dumps({"query": PREFLIGHT_SQL}).encode("utf-8"),
        method="POST", headers={"content-type": "application/json", "accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 -- chart-set URL
        data = json.loads(resp.read(65536))
    n = data["rows"][0]["n"]
    if isinstance(n, bool) or not isinstance(n, int) or n < 0:
        raise ValueError("count is not a non-negative integer")
    return n


def reset_preflight(runtimes: list[tuple[str, str]], limit: int,
                    timeout: float = PREFLIGHT_TIMEOUT_S) -> dict[str, Any]:
    """Queries every runtime in parallel (one thread each, `timeout` per call)."""
    results: list[dict[str, Any]] = [{"name": n, "open": None, "error": None} for n, _ in runtimes]

    def work(i: int, url: str) -> None:
        try:
            results[i]["open"] = count_open(url, timeout)
        except urllib.error.HTTPError as exc:
            results[i]["error"] = _short(f"HTTP {exc.code}")
        except Exception as exc:  # noqa: BLE001 -- any fault is "unreadable"
            results[i]["error"] = _short(f"{type(exc).__name__}: {exc}")

    threads = [threading.Thread(target=work, args=(i, url), daemon=True)
               for i, (_, url) in enumerate(runtimes)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout + 5)
    for r in results:
        if r["open"] is None and r["error"] is None:
            r["error"] = "no answer"
    over = [r["name"] for r in results if r["open"] is not None and r["open"] > limit]
    return {
        "limit": limit,
        "runtimes": results,
        "over": over,
        "open_over": sum(r["open"] for r in results if r["name"] in over),
        "needs_confirmation": bool(over),
        "unreadable": any(r["open"] is None for r in results),
    }


def parse_reset_body(raw: bytes) -> tuple[dict[str, Any] | None, str | None]:
    """(confirmation|None, error). An empty body is a plain reset. The body is a
    JSON object with only confirm_cancel_open (bool) and seen_open (int >= 0)."""
    if not raw.strip():
        return None, None
    try:
        body = json.loads(raw)
    except ValueError:
        return None, "body is not JSON"
    if not isinstance(body, dict):
        return None, "body must be a JSON object"
    if set(body) - RESET_BODY_KEYS:
        return None, "unknown key in body"
    flag = body.get("confirm_cancel_open", False)
    seen = body.get("seen_open", 0)
    if not isinstance(flag, bool):
        return None, "confirm_cancel_open must be a boolean"
    if isinstance(seen, bool) or not isinstance(seen, int) or seen < 0:
        return None, "seen_open must be a non-negative integer"
    return {"confirm_cancel_open": flag, "seen_open": seen}, None


# --- app state: adapter, last command, reset record ----------------------------

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class AppState:
    def __init__(self, adapter: dict[str, Any], store: RateStore, reset_record_file: str | None,
                 restart_max_zero_age_s: float = DEFAULT_RESTART_MAX_ZERO_AGE_S,
                 reset_launcher: ResetJobLauncher | None = None,
                 sequences: dict[str, dict[str, Any]] | None = None,
                 restate_admin: list[tuple[str, str]] | None = None,
                 reset_max_open: int = DEFAULT_RESET_MAX_OPEN):
        self.adapter = adapter
        self.restate_admin = restate_admin or []
        self.reset_max_open = reset_max_open
        self.sequences = sequences or {}
        # Latest sequence run record; mutated by the run thread under _lock.
        self.sequence_run: dict[str, Any] | None = None
        # Serialises the running-check and the record creation of a start.
        self.sequence_lock = threading.Lock()
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
        # Serialises reset presses from the running-check through the pause
        # and the Job create, so concurrent presses send one pause and
        # create one Job.
        self.reset_lock = threading.Lock()
        self.last_command: dict[str, Any] | None = None
        # Replaced by main() (or a test) once the loop is configured.
        self.loop = LoopRunner(self, None)

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

    def _call_step(self, step: dict[str, Any]) -> tuple[int | None, str | None]:
        return self._send_call(self.adapter["endpoint"] + step["path"], step["method"],
                               step["body"])

    @staticmethod
    def _send_call(url: str, method: str, body: dict[str, Any]) -> tuple[int | None, str | None]:
        data = json.dumps(body).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                resp.read()
                return resp.status, None
        except urllib.error.HTTPError as exc:
            exc.read()
            return exc.code, None
        except Exception as exc:  # noqa: BLE001 -- a transport fault, not a crash
            return None, str(exc)

    def call_adapter(self, op: str) -> tuple[int | None, str | None, list[dict[str, Any]]]:
        """(status, error, steps) -- runs the op's steps in order and halts
        at the first one that is not 2xx or hit a transport error; later
        steps are never sent. status/error are the last executed step's.
        Each response BODY is read (to drain the connection) but never
        interpreted or returned; only the HTTP status (or a transport error
        string) per step crosses back out of this function. That is the
        whole of what "last command sent" may ever carry about the
        adapter's own answer."""
        steps: list[dict[str, Any]] = []
        status: int | None = None
        error: str | None = None
        for step in self.adapter["operations"][op]:
            status, error = self._call_step(step)
            steps.append({"method": step["method"], "path": step["path"],
                          "status": status, "error": error})
            if status is None or not 200 <= status < 300:
                break
        return status, error, steps

    # --- reset ------------------------------------------------------------
    def run_reset(self, subject: str, confirm: dict[str, Any] | None = None
                  ) -> tuple[int, dict[str, Any]]:
        """The reset press, without HTTP: (status, body) exactly as the route
        answers. The simulator is quieted through the adapter (pause) before the
        reset Job is created; a failed pause refuses the reset rather than
        resetting under a running simulator. No adapter call is made for a
        refused press (reset already running). 202 means the Job was created;
        the loop then follows it to its end."""
        with self.reset_lock:
            try:
                current = self.reset_launcher.latest()
            except KubeApiError as exc:
                log.warning(json.dumps({"exercise_reset_job": "not_created",
                                         "status": exc.status, "subject": subject}))
                return 502, {"error": "reset job not created", "status": exc.status}
            if current is not None and current["state"] == "running":
                return self._reset_running(subject, current["name"])
            pause: dict[str, Any] | None = None
            if "pause" in self.adapter["operations"]:
                status, error, steps = self.call_adapter("pause")
                pause = {"status": status, "error": error, "steps": steps}
                self.set_last_command({"op": "pause", "at": _now_iso(), "status": status,
                                       "error": error, "subject": subject, "steps": steps,
                                       "via": "reset"})
                log.info(json.dumps({"exercise_op": "pause", "status": status,
                                      "error": error, "subject": subject, "via": "reset"}))
                if status is None or not 200 <= status < 300:
                    log.info(json.dumps({"exercise_op_refused": "reset",
                                          "reason": "pause_failed", "subject": subject}))
                    return 502, {"error": "reset refused: the simulator pause failed",
                                 "reason": "pause_failed", "pause": pause}
            try:
                confirmed = (confirm["seen_open"]
                             if confirm is not None and confirm["confirm_cancel_open"] else None)
                outcome, job = self.reset_launcher.launch(subject, confirmed)
            except InvalidSubject:
                return 400, {"error": "invalid subject"}
            except KubeApiError as exc:
                log.warning(json.dumps({"exercise_reset_job": "not_created",
                                         "status": exc.status, "subject": subject}))
                return 502, {"error": "reset job not created", "status": exc.status,
                             "simulator_paused": pause is not None}
            if outcome == "running":
                return self._reset_running(subject, job)
            at = _now_iso()
            self.set_last_command({"op": "reset", "at": at, "status": 201, "error": None,
                                   "subject": subject, "job": job, "pause": pause})
            log.info(json.dumps({"exercise_reset_job": job, "subject": subject}))
            return 202, {"op": "reset", "at": at, "job": job, "subject": subject, "pause": pause}

    @staticmethod
    def _reset_running(subject: str, job: str | None) -> tuple[int, dict[str, Any]]:
        log.info(json.dumps({"exercise_op_refused": "reset", "reason": "reset_running",
                              "job": job, "subject": subject}))
        return 409, {"error": "reset already running", "reason": "reset_running", "job": job}

    # --- named sequences --------------------------------------------------
    def get_sequence_run(self) -> dict[str, Any] | None:
        with self._lock:
            return copy.deepcopy(self.sequence_run)

    def sequence_summaries(self) -> list[dict[str, Any]]:
        return [{"name": name, "label": seq["label"], "description": seq.get("description", ""),
                 "steps": len(seq["steps"]),
                 "total_wait_s": sum(st["wait_s"] for st in seq["steps"] if "wait_s" in st)}
                for name, seq in sorted(self.sequences.items())]

    def running_sequence(self) -> str | None:
        with self._lock:
            run = self.sequence_run
            return run["op"] if run is not None and run["state"] == "running" else None

    def start_sequence(self, name: str, subject: str) -> dict[str, Any]:
        """Create the run record, set last_command, start the daemon thread
        and return a copy of the record in its initial state. The caller has
        already checked that nothing is running."""
        seq = self.sequences[name]
        steps_rec = []
        for i, st in enumerate(seq["steps"]):
            rec: dict[str, Any] = {"i": i, "kind": "wait" if "wait_s" in st else "call",
                                   "name": st.get("name"), "state": "pending", "status": None,
                                   "error": None, "at": None, "done_at": None}
            if "wait_s" in st:
                rec["wait_s"] = st["wait_s"]
            else:
                rec["method"] = st["method"]
                rec["url"] = st["url"]
            steps_rec.append(rec)
        started = _now_iso()
        run = {"op": name, "label": seq["label"], "subject": subject, "started_at": started,
               "finished_at": None, "state": "running", "steps": steps_rec}
        with self._lock:
            self.sequence_run = run
            self.last_command = {"op": name, "at": started, "status": 202, "error": None,
                                 "subject": subject, "sequence": True}
            initial = copy.deepcopy(run)
        log.info(json.dumps({"exercise_sequence": name, "event": "start", "subject": subject}))
        threading.Thread(target=self._run_sequence, args=(run, seq), daemon=True).start()
        return initial

    @staticmethod
    def _log_wan_line(st: dict[str, Any], subject: str, status: int | None,
                      name: str, i: int) -> None:
        path = urllib.parse.urlsplit(st["url"]).path
        method = str(st["method"]).upper()
        body = st.get("body")
        m = _WAN_PROXY_RE.match(path)
        if m and method == "POST" and isinstance(body, dict) and "enabled" in body:
            log.info("WAN CONTROL subject=%s proxy=%s enabled=%s upstream_status=%s "
                     "sequence=%s step=%s", subject, m.group("proxy"), body["enabled"],
                     status, name, i)
            return
        m = _WAN_TOXICS_RE.match(path)
        if m:
            log.info("WAN TOXICS subject=%s proxy=%s method=%s upstream_status=%s "
                     "sequence=%s step=%s", subject, m.group("proxy"), method,
                     status, name, i)

    def _run_sequence(self, run: dict[str, Any], seq: dict[str, Any]) -> None:
        """Run a named sequence's steps in order, halting on the first failure.

        Call steps go straight to the link proxy's admin API, not through the
        gateway, so the gateway's plain-text "WAN CONTROL" / "WAN TOXICS" lines
        never see them. A search for "who changed a link during this window"
        greps for those lines, and a sequence's cut and heal are real link
        changes by the subject who pressed it, so each such step also logs a
        line in the same vocabulary (see _log_wan_line). Skipped steps change
        nothing and log nothing; a transport error still logs, with
        upstream_status=None, because the write may have landed.
        """
        name, subject = run["op"], run["subject"]
        halted = False
        for i, st in enumerate(seq["steps"]):
            rec = run["steps"][i]
            if halted:
                with self._lock:
                    rec["state"] = "skipped"
                log.info(json.dumps({"exercise_sequence": name, "step": i, "kind": rec["kind"],
                                      "state": "skipped", "status": None, "error": None,
                                      "subject": subject}))
                continue
            with self._lock:
                rec["state"] = "running"
                rec["at"] = _now_iso()
            status: int | None = None
            error: str | None = None
            if "wait_s" in st:
                time.sleep(st["wait_s"])
                ok = True
            else:
                status, error = self._send_call(st["url"], st["method"], st["body"])
                ok = status is not None and 200 <= status < 300
            with self._lock:
                rec["state"] = "ok" if ok else "failed"
                rec["status"] = status
                rec["error"] = error
                rec["done_at"] = _now_iso()
            log.info(json.dumps({"exercise_sequence": name, "step": i, "kind": rec["kind"],
                                  "state": rec["state"], "status": status, "error": error,
                                  "subject": subject}))
            if "wait_s" not in st:
                self._log_wan_line(st, subject, status, name, i)
            if not ok:
                halted = True
        with self._lock:
            run["state"] = "halted" if halted else "completed"
            run["finished_at"] = _now_iso()
        log.info(json.dumps({"exercise_sequence": name, "event": run["state"],
                              "subject": subject}))


# --- the exercise loop ---------------------------------------------------------
#
# A supervisor starts the loop (POST /exercise/op/loop); it repeats a configured
# step list until stopped (loopstop) or a step fails. Nothing is retried: a
# failed step halts the loop. State lives in memory only, so a pod restart means
# no loop (status reports idle); the per-cycle record in the ConfigMap is what
# survives. "Scenario end" is read from counters (fires and in-flight), never
# from anything the adapter says.

LOOP_RESERVED = ("loop", "loopstop")
LOOP_DEFAULT_QUIET_S = 120.0
LOOP_DEFAULT_FALLBACK_S = 720.0
LOOP_DEFAULT_RECORD_MAX = 50
LOOP_STEP_KINDS = ("op", "reset", "wait_s", "await")
LOOP_WAIT_SLICE_S = 0.25
RESET_JOB_GRACE_S = 120.0
RESET_JOB_DEFAULT_DEADLINE_S = 1800.0
LOOP_RECORD_KEY = "cycles.json"
FIRES_METRIC, FIRES_LABEL = "dis_effector_pdus_decoded_total", ("pdu_type", "2")
INFLIGHT_METRIC, INFLIGHT_LABEL = "dis_ingress_kind_tracked", ("kind", "2")


def parse_labeled_total(text: str, metric: str, label: str, value: str) -> float | None:
    """Sum the samples of `metric` whose labels carry `label="value"`, over any
    other labels. None when no such sample appears at all."""
    line_re = re.compile(r'^' + re.escape(metric) + r'(\{(?P<labels>[^}]*)\})?\s+(?P<value>[-+0-9.eE]+)')
    label_re = re.compile(r'(^|[,{])\s*' + re.escape(label) + r'\s*=\s*"' + re.escape(value)
                          + r'"\s*([,}]|$)')
    total = 0.0
    found = False
    for line in text.splitlines():
        m = line_re.match(line.strip())
        if not m or not label_re.search(m.group("labels") or ""):
            continue
        try:
            total += float(m.group("value"))
        except ValueError:
            continue
        found = True
    return total if found else None


def _step_label(step: dict[str, Any]) -> str:
    kind = next(iter(step))
    return f"{kind}:{step[kind]}"


def load_loop_config(path: str | os.PathLike | None, adapter: dict[str, Any],
                     sequences: dict[str, Any], has_reset: bool) -> dict[str, Any] | None:
    """None when no file is configured (the loop is simply not configured);
    AdapterConfigError for anything wrong in one, so startup can refuse the loop
    rather than fail at run time."""
    if not path:
        return None
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise AdapterConfigError(f"loop file {path}: {exc}") from exc
    if not isinstance(raw, dict):
        raise AdapterConfigError(f"loop file {path}: must be a JSON object")
    ops = adapter["operations"]
    for name in LOOP_RESERVED:
        if name in ops or name in sequences:
            raise AdapterConfigError(f"loop file {path}: {name!r} is reserved for the loop but "
                                     "is also an adapter op or sequence name")
    steps = raw.get("steps")
    if not isinstance(steps, list) or not steps:
        raise AdapterConfigError(f"loop file {path}: steps must be a non-empty list")
    for i, st in enumerate(steps):
        where = f"loop file {path}: step {i}"
        if not isinstance(st, dict) or len(st) != 1 or next(iter(st)) not in LOOP_STEP_KINDS:
            raise AdapterConfigError(f"{where}: must be an object with exactly one of "
                                     f"{', '.join(LOOP_STEP_KINDS)}")
        kind, arg = next(iter(st.items()))
        if kind == "op":
            if arg not in ops:
                raise AdapterConfigError(f"{where}: op {arg!r} is not an adapter op")
            if arg == "restart":
                # restart goes through the measured-zero gate on the HTTP path
                raise AdapterConfigError(f"{where}: restart is gated and cannot be a loop step")
        elif kind == "reset":
            if arg != "quick":
                raise AdapterConfigError(f"{where}: reset must be \"quick\"")
            if not has_reset:
                raise AdapterConfigError(f"{where}: reset step but no reset Job is configured")
        elif kind == "wait_s":
            if isinstance(arg, bool) or not isinstance(arg, (int, float)) or not arg >= 0:
                raise AdapterConfigError(f"{where}: wait_s must be a number >= 0")
        elif arg != "scenarioEnd":
            raise AdapterConfigError(f"{where}: await must be \"scenarioEnd\"")
    out: dict[str, Any] = {"steps": steps}
    for key, field, default in (("quietSeconds", "quiet_s", LOOP_DEFAULT_QUIET_S),
                                ("fallbackSeconds", "fallback_s", LOOP_DEFAULT_FALLBACK_S),
                                ("recordMax", "record_max", LOOP_DEFAULT_RECORD_MAX)):
        val = raw.get(key, default)
        if isinstance(val, bool) or not isinstance(val, (int, float)) or not val > 0:
            raise AdapterConfigError(f"loop file {path}: {key} must be a number > 0")
        out[field] = int(val) if field == "record_max" else float(val)
    return out


class LoopSampler:
    """One scrape of every source. A failed fetch is None for that source (never
    zero): the loop treats the tick as unknown. A reachable source without the
    metric series has nothing to report and reads 0."""

    def __init__(self, fire_sources: list[str], inflight_sources: list[str], timeout: float = 5.0):
        self.fire_sources = fire_sources
        self.inflight_sources = inflight_sources
        self.timeout = timeout

    def _fetch(self, url: str, metric: str, label: tuple[str, str]) -> float | None:
        try:
            with urllib.request.urlopen(url, timeout=self.timeout) as resp:
                text = resp.read().decode("utf-8", "replace")
        except Exception:  # noqa: BLE001 -- any failure here is "unknown"
            return None
        return parse_labeled_total(text, metric, *label) or 0.0

    def __call__(self) -> dict[str, dict[str, float | None]]:
        return {"fires": {u: self._fetch(u, FIRES_METRIC, FIRES_LABEL) for u in self.fire_sources},
                "inflight": {u: self._fetch(u, INFLIGHT_METRIC, INFLIGHT_LABEL)
                             for u in self.inflight_sources}}


class LoopRecorder:
    """Keeps the last `record_max` cycle records and patches them into a
    ConfigMap (merge-patch of one data key). Seeds from the stored list on first
    use so a pod restart does not drop earlier records."""

    def __init__(self, kube: KubeApi, name: str, record_max: int):
        self.kube = kube
        self.name = name
        self.record_max = record_max
        self.records: list[dict[str, Any]] | None = None

    def _path(self) -> str:
        return f"/api/v1/namespaces/{self.kube._namespace()}/configmaps/{self.name}"

    def load(self) -> list[dict[str, Any]]:
        if self.records is None:
            try:
                stored = (self.kube._request("GET", self._path()).get("data") or {}).get(LOOP_RECORD_KEY)
                loaded = json.loads(stored) if stored else []
                self.records = [r for r in loaded if isinstance(r, dict)] if isinstance(loaded, list) else []
            except (KubeApiError, ValueError, OSError) as exc:
                log.warning("loop record not loaded: %s", exc)
                self.records = []
        return list(self.records)

    def append(self, rec: dict[str, Any]) -> None:
        self.load()
        self.records = (self.records + [rec])[-self.record_max:]
        self.kube._request("PATCH", self._path(),
                           {"data": {LOOP_RECORD_KEY: json.dumps(self.records)}},
                           content_type="application/merge-patch+json")


class LoopRunner:
    """The loop's state and its worker thread. `clock`/`sleep`/`sampler` are
    injectable so tests run it on a fake clock; production leaves the defaults."""

    def __init__(self, app: "AppState", config: dict[str, Any] | None,
                 sampler: Any = None, recorder: Any = None, scrape_interval: float = 5.0,
                 clock: Any = time.monotonic, sleep: Any = time.sleep, reset_poll_s: float = 5.0):
        self.app = app
        self.config = config
        self.sampler = sampler
        self.recorder = recorder
        self.scrape_interval = scrape_interval
        self.clock = clock
        self.sleep = sleep
        self.reset_poll_s = reset_poll_s
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._s: dict[str, Any] = {"state": "idle", "cycle": 0, "step_index": None, "step": None,
                                   "started_at": None, "step_started_at": None, "started_by": None,
                                   "halt": None, "last_cycle": None, "record_error": None}
        self._await: dict[str, Any] | None = None
        if recorder is not None and config is not None:
            records = recorder.load()
            self._s["last_cycle"] = records[-1] if records else None

    @property
    def configured(self) -> bool:
        return self.config is not None

    def active_cycle(self) -> int | None:
        """The cycle number while the loop is running or stopping, else None."""
        with self._lock:
            return self._s["cycle"] if self._s["state"] in ("running", "stopping") else None

    # --- control -------------------------------------------------------
    def start(self, subject: str, background: bool = True) -> tuple[int, dict[str, Any]]:
        if self.config is None:
            return 409, {"error": "loop not configured"}
        with self._lock:
            if self._s["state"] in ("running", "stopping"):
                return 409, {"error": "loop already running", "cycle": self._s["cycle"]}
            self._stop.clear()
            self._await = None
            self._s.update(state="running", cycle=1, step_index=0,
                           step=_step_label(self.config["steps"][0]), started_at=_now_iso(),
                           step_started_at=None, started_by=subject, halt=None, record_error=None)
        log.info(json.dumps({"exercise_loop": "start", "subject": subject}))
        if background:
            threading.Thread(target=self._run, args=(subject,), daemon=True).start()
        else:
            self._run(subject)
        return 202, {"loop": "started", "cycle": 1}

    def stop(self) -> tuple[int, dict[str, Any]]:
        with self._lock:
            if self._s["state"] not in ("running", "stopping"):
                return 409, {"error": "no loop running"}
            self._s["state"] = "stopping"
            self._stop.set()
        log.info(json.dumps({"exercise_loop": "stop_requested"}))
        return 202, {"loop": "stopping"}

    def _wait(self, seconds: float) -> bool:
        """Sleep up to `seconds`, ending early on stop. True when stopped."""
        end = self.clock() + seconds
        while not self._stop.is_set():
            left = end - self.clock()
            if left <= 0:
                return False
            self.sleep(min(LOOP_WAIT_SLICE_S, left))
        return True

    # --- status --------------------------------------------------------
    def status(self) -> dict[str, Any]:
        with self._lock:
            s = dict(self._s)
            aw = dict(self._await) if self._await else None
        out: dict[str, Any] = {"configured": self.configured, **s,
                               "steps": self.config["steps"] if self.config else [], "await": None,
                               "quiet_s": self.config["quiet_s"] if self.config else None,
                               "fallback_s": self.config["fallback_s"] if self.config else None}
        if aw is not None:
            now = self.clock()
            out["await"] = {
                "armed": aw["armed"], "fires_this_await": aw["fires"], "inflight": aw["inflight"],
                "quiet_s": round(now - aw["quiet_since"], 1) if aw["armed"] else 0,
                "quiet_needed_s": self.config["quiet_s"], "fallback_s": self.config["fallback_s"],
                "fallback_remaining_s": max(0.0, round(aw["started"] + self.config["fallback_s"] - now, 1)),
                "unknown_sources": aw["unknown"]}
        return {"loop": out}

    # --- worker --------------------------------------------------------
    def _set(self, **kw: Any) -> None:
        with self._lock:
            self._s.update(kw)

    def _run(self, subject: str) -> None:
        cycle = 1
        try:
            while True:
                outcome = self._run_cycle(cycle, subject)
                if outcome != "ok" or self._stop.is_set():
                    break
                cycle += 1
                self._set(cycle=cycle)
        except Exception as exc:  # noqa: BLE001 -- a loop bug must end it visibly, not hang it
            log.exception("exercise loop crashed")
            self._set(state="halted", halt={"cycle": cycle, "step_index": self._s["step_index"],
                                            "step": self._s["step"], "detail": f"internal error: {exc}"})
        finally:
            with self._lock:
                self._await = None
                if self._s["state"] != "halted":
                    self._s["state"] = "stopped"
            log.info(json.dumps({"exercise_loop": self._s["state"], "cycle": cycle}))

    def _run_cycle(self, cycle: int, subject: str) -> str:
        steps = self.config["steps"]
        cyc: dict[str, Any] = {"fires": 0, "end_reason": None, "armed": None, "reset_job": None}
        started_at = _now_iso()
        steps_rec: list[dict[str, Any]] = []
        outcome = "ok"
        for i, st in enumerate(steps):
            if self._stop.is_set():
                outcome = "stopped"
                break
            label = _step_label(st)
            t0 = self.clock()
            step_at = _now_iso()
            self._set(step_index=i, step=label, step_started_at=step_at)
            ok, detail = self._exec(st, subject, cyc)
            steps_rec.append({"step": label, "ok": ok, "started_at": step_at,
                              "s": round(self.clock() - t0, 1), "detail": detail})
            if not ok:
                outcome = "halted"
                self._set(state="halted", halt={"cycle": cycle, "step_index": i, "step": label,
                                                "detail": detail})
                break
            if self._stop.is_set() and (i < len(steps) - 1 or detail == "stopped"):
                outcome = "stopped"
                break
        rec = {"event": "exercise_loop_cycle", "cycle": cycle, "started_at": started_at,
               "ended_at": _now_iso(), "end_reason": cyc["end_reason"], "armed": cyc["armed"],
               "fires": cyc["fires"], "outcome": outcome, "steps": steps_rec,
               "reset_job": cyc["reset_job"], "started_by": self._s["started_by"]}
        self._emit(rec)
        return outcome

    def _emit(self, rec: dict[str, Any]) -> None:
        log.info(json.dumps(rec))
        error = None
        if self.recorder is not None:
            try:
                self.recorder.append(rec)
            except Exception as exc:  # noqa: BLE001 -- a failed record never halts the loop
                error = str(exc)
                log.warning("loop record not saved: %s", exc)
        with self._lock:
            self._s["last_cycle"] = rec
            if error is not None:
                self._s["record_error"] = error

    def _exec(self, st: dict[str, Any], subject: str, cyc: dict[str, Any]) -> tuple[bool, str | None]:
        kind, arg = next(iter(st.items()))
        if kind == "wait_s":
            return True, "stopped" if self._wait(float(arg)) else None
        if kind == "await":
            return True, self._await_end(cyc)
        if kind == "op":
            status, error, steps = self.app.call_adapter(arg)
            self.app.set_last_command({"op": arg, "at": _now_iso(), "status": status, "error": error,
                                       "subject": subject, "steps": steps, "via": "loop"})
            log.info(json.dumps({"exercise_op": arg, "status": status, "error": error,
                                  "subject": subject, "via": "loop"}))
            if status is None or not 200 <= status < 300:
                return False, error or f"adapter answered {status}"
            return True, None
        return self._reset(subject, cyc)

    def _reset(self, subject: str, cyc: dict[str, Any]) -> tuple[bool, str | None]:
        code, body = self.app.run_reset(subject, None)
        if code != 202:
            reason = body.get("reason")
            return False, str(reason).replace("_", " ") if reason else str(body.get("error"))
        job = body.get("job")
        cyc["reset_job"] = job
        launcher = self.app.reset_launcher
        deadline_s = (launcher.template.get("spec") or {}).get("activeDeadlineSeconds",
                                                               RESET_JOB_DEFAULT_DEADLINE_S)
        deadline = self.clock() + float(deadline_s) + RESET_JOB_GRACE_S
        # Never cancelled and never interrupted by a stop: only the Job's own
        # end (or the deadline) finishes this step.
        while True:
            try:
                cur = launcher.latest()
            except KubeApiError as exc:
                log.warning("loop reset poll: %s", exc)
                cur = None
            if cur is not None and (job is None or cur["name"] == job):
                if cur["state"] == "succeeded":
                    return True, None
                if cur["state"] == "failed":
                    return False, "reset job failed"
            if self.clock() >= deadline:
                return False, "reset job timeout"
            self.sleep(self.reset_poll_s)

    def _await_end(self, cyc: dict[str, Any]) -> str | None:
        """Block until the scenario has ended (quiet or fallback) or a stop.
        The first sample only sets the baselines, so fires from before the await
        began are never counted."""
        cfg = self.config
        started = self.clock()
        aw = {"armed": False, "fires": 0, "inflight": None, "unknown": [], "started": started,
              "quiet_since": started}
        with self._lock:
            self._await = aw
        prev: dict[str, float] = {}
        reason: str | None = None
        stopped = False
        while True:
            sample = self.sampler() if self.sampler else {"fires": {}, "inflight": {}}
            now = self.clock()
            delta = 0.0
            unknown: list[str] = []
            for url, v in sample["fires"].items():
                if v is None:
                    unknown.append(url)
                    continue
                p = prev.get(url)
                if p is not None and v > p:
                    delta += v - p
                prev[url] = v  # a decrease re-baselines: not a fire
            inflight: float | None = 0.0 if sample["inflight"] else None
            for url, v in sample["inflight"].items():
                if v is None:
                    unknown.append(url)
                    inflight = None
                elif inflight is not None:
                    inflight += v
            busy = delta > 0 or bool(inflight) or bool(unknown)
            with self._lock:
                aw["unknown"], aw["inflight"] = unknown, inflight
                if delta > 0:
                    aw["fires"] += int(delta)
                    aw["armed"] = True
                if aw["armed"] and busy:
                    aw["quiet_since"] = now
                if aw["armed"] and not busy and now - aw["quiet_since"] >= cfg["quiet_s"]:
                    reason = "quiet"
                elif now - started >= cfg["fallback_s"]:
                    reason = "fallback"
            if reason is not None:
                break
            if self._wait(self.scrape_interval):
                stopped = True
                break
        cyc["fires"] += aw["fires"]
        cyc["armed"] = aw["armed"]
        cyc["end_reason"] = None if stopped else reason
        return "stopped" if stopped else reason


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
                                             "latest": None, "error": None,
                                             "mode": reset_mode()}
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
                    "sequences": app.sequence_summaries(),
                    "sequence": app.get_sequence_run(),
                    **app.loop.status(),
                })
                return
            if self.path == "/exercise/reset/preflight" and app.reset_launcher is not None:
                self._send_json(200, reset_preflight(app.restate_admin, app.reset_max_open))
                return
            self._send_json(404, {"error": "not found"})

        def do_POST(self) -> None:  # noqa: N802
            if not self.path.startswith("/exercise/op/"):
                self._drain()
                self._send_json(404, {"error": "not found"})
                return
            op = self.path[len("/exercise/op/"):]
            # The loop's own ops come first: neither is an adapter op or a
            # sequence (startup refuses both names), and while a loop runs
            # nothing else may act on the exercise.
            if op == "loop":
                self._drain()
                self._handle_loop_start()
                return
            if op == "loopstop":
                self._drain()
                code, body = app.loop.stop()
                self._send_json(code, body)
                return
            cycle = app.loop.active_cycle()
            if cycle is not None:
                self._drain()
                log.info(json.dumps({"exercise_op_refused": op, "reason": "loop_running"}))
                self._send_json(409, {"refused": "loop running", "cycle": cycle})
                return
            if op == "reset" and app.reset_launcher is not None:
                try:
                    length = int(self.headers.get("Content-Length", 0) or 0)
                except ValueError:
                    length = RESET_BODY_MAX_BYTES + 1
                if length < 0 or length > RESET_BODY_MAX_BYTES:
                    self.close_connection = True
                    self._send_json(400, {"error": "invalid body"})
                    return
                raw = self.rfile.read(length) if length else b""
                confirm, err = parse_reset_body(raw)
                if err is not None:
                    self._send_json(400, {"error": "invalid body", "detail": err})
                    return
                self._handle_reset(confirm)
                return
            if op in app.sequences:
                self._drain()
                self._handle_sequence(op)
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
                    status, error, steps = app.call_adapter(op)
                    if len(steps) == len(app.adapter["operations"][op]) and all(
                            st["status"] is not None and 200 <= st["status"] < 300
                            for st in steps):
                        # Only a fully 2xx sequence uses the zero up; a
                        # transport error or any non-2xx step leaves it
                        # available.
                        app.mark_restart_zero_used(rec["measured_zero_at"])
            else:
                status, error, steps = app.call_adapter(op)
            record = {"op": op, "at": _now_iso(), "status": status, "error": error,
                      "subject": subject, "steps": steps}
            app.set_last_command(record)
            log.info(json.dumps({"exercise_op": op, "status": status, "error": error,
                                  "subject": subject}))
            self._send_json(200, record)

        def _handle_loop_start(self) -> None:
            subject = self.headers.get(SUBJECT_HEADER, "").strip()
            if not subject:
                self._send_json(400, {"error": "missing subject header"})
                return
            if not SUBJECT_RE.fullmatch(subject):
                self._send_json(400, {"error": "invalid subject"})
                return
            if not app.loop.configured:
                self._send_json(409, {"error": "loop not configured"})
                return
            with app.sequence_lock:
                if app.running_sequence() is not None:
                    self._send_json(409, {"error": "sequence already running",
                                          "reason": "sequence_running"})
                    return
                if app.reset_launcher is not None:
                    try:
                        current = app.reset_launcher.latest()
                    except KubeApiError as exc:
                        self._send_json(502, {"error": "reset job state unavailable",
                                              "status": exc.status})
                        return
                    if app.reset_lock.locked() or (current is not None
                                                    and current["state"] == "running"):
                        self._send_json(409, {"error": "reset already running",
                                              "reason": "reset_running"})
                        return
                code, body = app.loop.start(subject)
            self._send_json(code, body)

        def _handle_sequence(self, name: str) -> None:
            subject = self.headers.get(SUBJECT_HEADER, "").strip()
            if not subject:
                self._send_json(400, {"error": "missing subject header"})
                return
            if not SUBJECT_RE.fullmatch(subject):
                self._send_json(400, {"error": "invalid subject"})
                return
            with app.sequence_lock:
                running = app.running_sequence()
                if running is not None:
                    log.info(json.dumps({"exercise_op_refused": name,
                                          "reason": "sequence_running", "subject": subject}))
                    self._send_json(409, {"error": "sequence already running",
                                          "reason": "sequence_running", "op": running})
                    return
                if app.reset_launcher is not None:
                    try:
                        current = app.reset_launcher.latest()
                    except KubeApiError as exc:
                        log.warning(json.dumps({"exercise_sequence": name, "event": "refused",
                                                 "status": exc.status, "subject": subject}))
                        self._send_json(502, {"error": "reset job state unavailable",
                                              "status": exc.status})
                        return
                    if current is not None and current["state"] == "running":
                        log.info(json.dumps({"exercise_op_refused": name,
                                              "reason": "reset_running", "subject": subject}))
                        self._send_json(409, {"error": "reset already running",
                                              "reason": "reset_running", "job": current["name"]})
                        return
                record = app.start_sequence(name, subject)
            self._send_json(202, record)

        def _handle_reset(self, confirm: dict[str, Any] | None = None) -> None:
            # The simulator is quieted through the adapter (pause) before the
            # reset Job is created; a failed pause refuses the reset rather
            # than resetting under a running simulator. No adapter call is
            # made for a refused press (bad subject, reset already running).
            subject = self.headers.get(SUBJECT_HEADER, "").strip()
            if not subject:
                self._send_json(400, {"error": "missing subject header"})
                return
            if not SUBJECT_RE.fullmatch(subject):
                self._send_json(400, {"error": "invalid subject"})
                return
            code, body = app.run_reset(subject, confirm)
            self._send_json(code, body)

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

    try:
        sequences = load_sequences(os.getenv("EXERCISE_SEQUENCES_FILE", "").strip())
    except AdapterConfigError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    try:
        restate_admin = parse_restate_admin_urls(os.getenv("EXERCISE_RESTATE_ADMIN_URLS", ""))
        reset_max_open = int(os.getenv("EXERCISE_RESET_MAX_OPEN", str(DEFAULT_RESET_MAX_OPEN)))
        if reset_max_open < 0:
            raise ValueError("EXERCISE_RESET_MAX_OPEN must be >= 0")
    except (AdapterConfigError, ValueError) as exc:
        print(f"EXERCISE_RESTATE_ADMIN_URLS / EXERCISE_RESET_MAX_OPEN invalid: {exc}",
              file=sys.stderr)
        return 2

    loop_config = None
    try:
        loop_config = load_loop_config(os.getenv("EXERCISE_LOOP_FILE", "").strip(), adapter,
                                       sequences, has_reset=reset_launcher is not None)
    except AdapterConfigError as exc:
        # The loop is a convenience on top of the controls: refuse it, keep serving.
        log.error("loop unavailable: %s", exc)

    store = RateStore(sources=sources, window=window, min_rate=min_rate)
    app = AppState(adapter=adapter, store=store, reset_record_file=reset_record_file,
                   restart_max_zero_age_s=max_zero_age,
                   reset_launcher=reset_launcher, sequences=sequences,
                   restate_admin=restate_admin, reset_max_open=reset_max_open)

    if loop_config is not None:
        inflight = [s.strip() for s in os.getenv("EXERCISE_INFLIGHT_SOURCES", "").split(",")
                    if s.strip()]
        record_cm = os.getenv("EXERCISE_LOOP_RECORD_CM", "").strip()
        recorder = (LoopRecorder(reset_launcher or KubeApi(), record_cm, loop_config["record_max"])
                    if record_cm else None)
        app.loop = LoopRunner(app, loop_config, sampler=LoopSampler(sources, inflight),
                              recorder=recorder, scrape_interval=scrape_interval)

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
