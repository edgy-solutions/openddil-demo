"""
Test 60 — Effector tracks read path (effector_launch via Electric).

Confirms effector_launch is actually reachable the same way the compose
frontend reaches it: VITE_ELECTRIC_URL points straight at electric-sync
(see docker-compose.override.yml) — there is no gateway/PEP hop in this
compose path, so this test reads the Shape API directly, the same table
+ where-clause shape useEffectorLaunches builds client-side.

Setup: one launcher A (M1A1 entity type, per-run id) registered via an
Entity State PDU and waited into telemetry_latest_state. Three Fire
events (E1/E2/E3, qty 1 each); only E1 gets a Detonation (result=1 ->
entity_impact). E2/E3 stay in flight (terminal_state NULL) — this test
does not wait out the timeout sweep, so it does not exercise
'unresolved' (test_58 already covers that).

Assertions on the Shape read:
  - exactly 3 rows for A
  - E1 terminal_state == entity_impact, E2/E3 terminal_state is None
  - each row's releasable_to/originator_nation equal A's own labels in
    telemetry_latest_state (whatever those are — this run's compose
    config may leave them null; the claim under test is propagation,
    not a specific value)

What this does NOT gate: in compose, Electric serves effector_launch
whether or not electrify.sql listed it (dropping it from
electric_publication and restarting electric-sync still served the rows),
and there is no PEP on this path. The gate that decides whether a browser
may read this table is the PEP's labelled-table list, which only exists
where the PEP does; it is checked there, not here.

When Electric serves no rows in time, postgres is asked directly: rows in
postgres but not served is a FAIL of the read path; no rows in postgres
is VOID (the projector has not written them).

Fail-on-purpose (run by hand): EFFECTOR_TEST_INJECT_E2_RESULT=3 also sends
a Detonation for E2 with result 3 before the read, so E2 is ground_impact
instead of in flight and the in-flight assertion must FAIL naming E2.

Cleanup: rows are left in place (test_58's own drain covers in-flight
effector_launch rows generally; this run's 2 in-flight E2/E3 rows will
resolve to 'unresolved' on the next timeout sweep like any other run's).
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).parent))
from _helpers import (  # noqa: E402
    build_detonation_pdu,
    build_entity_state_pdu,
    build_fire_pdu,
    fail_,
    pass_,
    query_postgres,
    send_udp_bytes,
)

NAME = "test_60_effector_tracks"

# Fail-on-purpose switch; see the module docstring.
INJECT_E2_RESULT = os.environ.get("EFFECTOR_TEST_INJECT_E2_RESULT")

ELECTRIC_URL = "http://localhost:5133/v1/shape"

SITE = 1
# M1A1 entity type, same triplet test_58's module docstring uses for its
# own launcher A: kind=1 domain=1 country=225(USA) category=1 subcat=1
# specific=2 extra=0.
LAUNCHER_ENTITY_TYPE = dict(kind=1, domain=1, country=225, category=1,
                           subcategory=1, specific=2, extra=0)
MUNITION = (2, 9, 225, 2, 1, 1, 0)

n = int(time.time()) % 30000
LAUNCHER_A = 2 * n + 1
LAUNCHER_A_APP = 60  # distinct application id from test_58/59's launchers
LAUNCHER_A_URN = f"dis:{SITE}:{LAUNCHER_A_APP}:{LAUNCHER_A}"
EVENT_APP = 4000 + (n % 50000)


def void_(detail: str) -> None:
    """Environment/apparatus problem, not a product-behavior failure. No
    helper in this family distinguishes VOID from FAIL (grep turned up
    none); this one is local to this test, same shape as pass_/fail_/
    skip_ in _helpers.py, with its own exit code so a runner can tell
    the two apart."""
    print(f"VOID: {NAME} — {detail}")
    sys.exit(2)


def _event_urn(event_number: int) -> str:
    return f"dis-event:{SITE}:{EVENT_APP}:{event_number}"


def _fire(event_number: int) -> None:
    send_udp_bytes(build_fire_pdu(
        site=SITE, application=LAUNCHER_A_APP, event_number=event_number,
        firing_entity=LAUNCHER_A, target_entity=None, munition_entity=0,
        munition_type=MUNITION, quantity=1,
        event_site=SITE, event_application=EVENT_APP))


def _detonation(event_number: int, result: int) -> None:
    send_udp_bytes(build_detonation_pdu(
        site=SITE, application=LAUNCHER_A_APP, event_number=event_number,
        firing_entity=LAUNCHER_A, target_entity=None, munition_entity=0,
        munition_type=MUNITION, quantity=1, detonation_result=result,
        event_site=SITE, event_application=EVENT_APP))


def _asset_exists(urn: str) -> bool:
    rows = query_postgres(
        f"select 1 from telemetry_latest_state where asset_id = '{urn}'")
    return bool(rows)


def _asset_labels(urn: str) -> tuple[str | None, list[str]]:
    """(originator_nation, releasable_to) for `urn` from telemetry_latest_state."""
    rows = query_postgres(
        f"select originator_nation, releasable_to from telemetry_latest_state "
        f"where asset_id = '{urn}'")
    if not rows:
        return None, []
    nation_raw, rel_raw = rows[0][0], rows[0][1]
    nation = nation_raw if nation_raw else None
    rel = []
    if rel_raw and rel_raw not in ("{}",):
        rel = [x for x in rel_raw.strip("{}").split(",") if x]
    return nation, rel


def _fetch_shape(table: str, where: str) -> list[dict] | None:
    """Fetch one ElectricSQL Shape page; return parsed row values, or None
    on any transport/HTTP-level failure (non-zero curl, non-JSON body) --
    same contract test_48 relies on, except here a failure is a value the
    caller inspects rather than an uncaught exception, because the
    fail-on-purpose step in this test *expects* failure and must not crash
    the script when it gets it."""
    q = f"table={table}&offset=-1&where={quote(where)}"
    url = f"{ELECTRIC_URL}?{q}"
    try:
        proc = subprocess.run(["curl", "-sS", "-f", url],
                              capture_output=True, text=True, timeout=15)
    except subprocess.TimeoutExpired:
        return None
    if proc.returncode != 0:
        return None
    body = proc.stdout.strip()
    if not body:
        return []
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, list):
        return None
    rows: list[dict] = []
    for entry in payload:
        if "value" not in entry:
            continue
        rows.append(entry["value"])
    return rows


def main() -> None:
    # --- setup: register launcher A, fire E1/E2/E3, detonate only E1 -------
    send_udp_bytes(build_entity_state_pdu(
        site=SITE, application=LAUNCHER_A_APP, entity=LAUNCHER_A,
        marking=f"EFX-{LAUNCHER_A}", **LAUNCHER_ENTITY_TYPE))

    deadline = time.monotonic() + 30.0
    while not _asset_exists(LAUNCHER_A_URN) and time.monotonic() < deadline:
        time.sleep(1.5)
    if not _asset_exists(LAUNCHER_A_URN):
        void_(f"launcher {LAUNCHER_A_URN} never reached telemetry_latest_state "
              f"within 30s; sensor-ingest/connect-dis-mapper path may be cold")

    nation, releasable = _asset_labels(LAUNCHER_A_URN)

    _fire(1)
    _fire(2)
    _fire(3)
    _detonation(1, 1)  # -> entity_impact
    if INJECT_E2_RESULT:
        _detonation(2, int(INJECT_E2_RESULT))

    e1, e2, e3 = _event_urn(1), _event_urn(2), _event_urn(3)
    where_initial = f"launcher_asset_id = '{LAUNCHER_A_URN}'"

    rows = None
    deadline = time.monotonic() + 30.0
    while time.monotonic() < deadline:
        fetched = _fetch_shape("effector_launch", where_initial)
        if fetched is not None and len(fetched) >= 3:
            rows = fetched
            break
        time.sleep(2.0)
    if rows is None:
        in_pg = query_postgres(
            "select count(*) from effector_launch where launcher_asset_id = "
            f"'{LAUNCHER_A_URN}'")
        n_pg = int(in_pg[0][0]) if in_pg else 0
        if n_pg >= 3:
            fail_(NAME, f"postgres holds {n_pg} effector_launch rows for "
                        f"{LAUNCHER_A_URN} but Electric did not serve 3 within "
                        f"30s -- the read path is broken")
        void_(f"projector wrote {n_pg} effector_launch rows for "
              f"{LAUNCHER_A_URN} within 30s (expected 3); the read path was "
              f"not exercised")

    by_urn = {r.get("event_urn"): r for r in rows}
    if set(by_urn) != {e1, e2, e3}:
        fail_(NAME, f"expected exactly {{{e1}, {e2}, {e3}}}, got {sorted(by_urn)}")

    if by_urn[e1].get("terminal_state") != "entity_impact":
        fail_(NAME, f"{e1} terminal_state = {by_urn[e1].get('terminal_state')!r}, "
                    f"expected 'entity_impact'")
    for urn in (e2, e3):
        ts = by_urn[urn].get("terminal_state")
        if ts is not None:
            fail_(NAME, f"{urn} terminal_state = {ts!r}, expected null (in flight)")

    for urn, row in by_urn.items():
        row_nation = row.get("originator_nation")
        row_rel = row.get("releasable_to") or []
        if row_nation != nation:
            fail_(NAME, f"{urn} originator_nation = {row_nation!r}, "
                        f"launcher A's own telemetry_latest_state label is "
                        f"{nation!r} -- propagation mismatch")
        if sorted(row_rel) != sorted(releasable):
            fail_(NAME, f"{urn} releasable_to = {row_rel!r}, launcher A's own "
                        f"telemetry_latest_state label is {releasable!r} -- "
                        f"propagation mismatch")

    pass_(NAME, f"3/3 rows served for {LAUNCHER_A_URN}, {e1}=entity_impact, "
                f"{e2}/{e3} in flight, labels match the launcher's "
                f"(nation={nation!r} releasable={releasable!r})")


if __name__ == "__main__":
    main()
