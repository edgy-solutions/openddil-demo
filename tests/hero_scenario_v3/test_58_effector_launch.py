"""
Test 58 — effector_launch: the launch record end to end (admission, update-
only Detonation, timeout sweep, late termination, declared-load view).

Three launchers, two of them with a declared munition load (compose mounts
config/effector-declared-load.yaml, variant-keyed, M1A1=8 AH-64E-V6=4), one
without (CH-47F-BlockII has no declared-load entry at all):

  Launcher A = dis:1:58:(2n+1), entity type 1_1_225_1_1_2_0  (M1A1)
  Launcher B = dis:1:58:(2n+2), entity type 1_2_225_20_1_7_0 (AH-64E-V6)
  Launcher C = dis:1:59:(n+1),  entity type 1_2_225_23_1_9_0 (CH-47F-BlockII)

effector_launcher_counts resolves its `declared` column through
telemetry_latest_state.platform_variant for a variant-keyed row, which is
only populated by the DIS ontology-enrichment path off an Entity State PDU
-- never off Fire/Detonation. So each launcher's own kind=1/force=1 ESPDU
goes out FIRST and this test polls until all three have a
telemetry_latest_state row before sending a single Fire.

Engagement (all munition 2.9.225.2.1.1.0, quantity 1, eventID site 1
application 2000+(n%60000) -- a different DIS identifier space from the
launchers' own entity ids, since eventID and EntityID are independent DIS
fields):

  Fire:       E1 A, E2 A, E3 A, E4 B, E5 B, E6 C
  Detonation: E1 result=1 (-> entity_impact), E2 result=3 (-> ground_impact),
              E4 result=6 (-> dud)
  Red:        E7 Fire from dis:1:58:(2n+3), never sent as an ESPDU
                 -> unknown_launcher, no row
              E8 Detonation, launcher A, never fired
                 -> no_fire, no row, A's counts unchanged

Every PDU in this fixture is sent to edge-01, so only two of the four
compose projector instances ever see it: projector-01 (consumes
redpanda-edge-01 directly) and projector-hq (consumes redpanda-hq, which
gets effector-events bridged in from every edge, including edge-01, and
writes the SAME shared postgres-hq effector_launch table projector-01
writes). That means every Fire/Detonation lands in this one table TWICE --
once from each instance -- and every effector_* counter this test checks
must be summed across all four services, not read off projector-01 alone,
or half the real activity is invisible. The second instance to apply a
real Detonation's result is a replay (effector_replayed_total), not a
refusal: that is the whole point of the replayed/conflicting split in
apply_effector_detonation (see its docstring) -- a benign duplicate
carries no signal, so it must not share a counter with a real anomaly.

Counting this out for the main engagement: E1/E2/E4 (real detonations) each
get applied once (the first instance to see them) and replayed once (the
second) -> effector_replayed_total +3. E7 (unknown launcher) and E8
(no matching Fire) are refused independently by BOTH instances, since
"is this launcher admitted" and "does this event_urn have a Fire row" are
facts about the shared store, not instance-local state -> unknown_launcher
+2, no_fire +2. The timeout sweep runs on every instance independently too,
but it UPDATEs the SAME row, so whichever instance's sweep wins a given
row's race is the only one that counts it -- summed across instances,
effector_unresolved_total is still exactly +3 for E3/E5/E6, not +3 per
instance. The late Detonation for E5 repeats this pattern at a smaller
scale: the first instance to see it gets "late" (+1 late_terminal), the
second sees the row already resolved to the same result and gets
"replayed" (+1 more, so +4 total replayed by the end).

Then: wait out the timeout sweep (compose sets EFFECTOR_TERMINAL_TIMEOUT_S=
60, sweep interval 15s) so E3/E5/E6 go 'unresolved'; then a LATE Detonation
for E5 (result=1) proves a real result still wins over the sweep's
inference (late_terminal=true), and that `expended` never moves for any of
this -- it is SUM(quantity) over the table, independent of terminal_state.

Three fail-on-purpose cycles are meant to be run by hand around this
script, not automated into its PASS path:

  1. Declared-load: bump M1A1's entry in config/effector-declared-load.yaml
     from 8 to 9, `docker compose restart openddil-projector-01` (not
     `up -d` -- that no-ops when compose sees no config-level diff even
     though the mounted file's content changed), rerun -- expect FAIL on
     assertion 3 (A's `remaining`). Restore to 8, restart, rerun for a
     clean PASS.
  2. Conflicting detonation: set EFFECTOR_TEST_INJECT_CONFLICT=1 before
     running this script. It sends a second Detonation for E1 with
     result=3 (the original was result=1) after the main engagement --
     both projector-01 and projector-hq see a terminal row with a
     different result and refuse it, so effector_refused_total{reason=
     "conflicting_detonation"} reads +2 instead of the +0 this run
     otherwise holds throughout, and the test FAILs on that assertion
     with the values reported. Unset the env var and rerun for a clean
     PASS.
  3. Cross-test contamination: run test_59_effector_supply.py (it leaves
     several of its own effector_launch rows pending a terminal_state --
     see SKIP_DRAIN's comment), then set EFFECTOR_TEST_SKIP_DRAIN=1 and
     run this script immediately -- the sweep lands on test_59's foreign
     rows during this run and effector_unresolved_total reads +8 instead
     of +3. Unset the env var and rerun (the drain precondition now waits
     them out first) for a clean PASS.

Cleanup deletes only this run's effector_launch rows (scoped by this run's
own launcher urns, unique per n) -- declared load is config, not run data,
and is deliberately left alone (reset-scenario.sh's TABLES comment explains
why).
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _helpers import (  # noqa: E402
    build_detonation_pdu,
    build_entity_state_pdu,
    build_fire_pdu,
    fail_,
    metric_sum,
    metric_value_labeled,
    pass_,
    query_postgres,
    scrape_service_metrics,
    send_udp_bytes,
    skip_,
)

NAME = "test_58_effector_launch"

PROJECTOR_METRICS_PORT = 8084

# Every PDU in this fixture goes to edge-01, so only these two instances
# ever process it directly -- but the timeout sweep runs on all four
# independently against the same shared postgres-hq table, so every
# effector_* counter below is summed across all four regardless (see the
# module docstring for why a single instance undercounts both kinds of
# activity).
ALL_PROJECTOR_SVCS = ("openddil-projector-01", "openddil-projector-02",
                     "openddil-projector-03", "openddil-projector-hq")

SITE = 1
MUNITION = (2, 9, 225, 2, 1, 1, 0)
MUNITION_KEY = "2.9.225.2.1.1.0"

n = int(time.time()) % 30000

LAUNCHER_A = 2 * n + 1
LAUNCHER_B = 2 * n + 2
LAUNCHER_C = n + 1
LAUNCHER_A_APP = 58
LAUNCHER_B_APP = 58
LAUNCHER_C_APP = 59
UNKNOWN_LAUNCHER = 2 * n + 3  # E7's firing entity -- never sent as an ESPDU

LAUNCHER_A_URN = f"dis:{SITE}:{LAUNCHER_A_APP}:{LAUNCHER_A}"
LAUNCHER_B_URN = f"dis:{SITE}:{LAUNCHER_B_APP}:{LAUNCHER_B}"
LAUNCHER_C_URN = f"dis:{SITE}:{LAUNCHER_C_APP}:{LAUNCHER_C}"

EVENT_APP = 2000 + (n % 60000)

METRIC_REFUSED = "effector_refused_total"
METRIC_LATE = "effector_late_terminal_total"
METRIC_UNRESOLVED = "effector_unresolved_total"
METRIC_REPLAYED = "effector_replayed_total"

# Manual fail-on-purpose #2 (see module docstring) -- set to "1" to send a
# second, conflicting Detonation for E1 and watch the conflicting_detonation
# assertion near the end of main() fail with the reported +2.
INJECT_CONFLICT = os.environ.get("EFFECTOR_TEST_INJECT_CONFLICT") == "1"

# Drain precondition (fail-on-purpose #3, see module docstring): other
# effector tests (e.g. test_59) can leave their own in-flight effector_launch
# rows (terminal_state IS NULL) behind when they exit. The timeout sweep
# resolves those to 'unresolved' asynchronously, up to EFFECTOR_TERMINAL_
# TIMEOUT_S + one sweep interval later -- if that sweep lands while THIS
# test is mid-run, its foreign rows get counted into the SAME summed
# effector_unresolved_total this test baselines and asserts +3 against,
# inflating the delta. Set to "1" to skip the drain and reproduce that
# contamination on purpose.
SKIP_DRAIN = os.environ.get("EFFECTOR_TEST_SKIP_DRAIN") == "1"
# compose sets EFFECTOR_TERMINAL_TIMEOUT_S=60, sweep interval 15s -- give any
# pre-existing pending rows a full timeout window plus margin to resolve.
DRAIN_TIMEOUT_S = 105.0
# One more sweep interval (15s) plus margin (5s), so a sweep already in
# flight when the drain check passes has landed before the baseline is read.
POST_DRAIN_WAIT_S = 20.0


def _event_urn(event_number: int) -> str:
    return f"dis-event:{SITE}:{EVENT_APP}:{event_number}"


def _fire(event_number: int, firing_entity: int, firing_app: int) -> None:
    send_udp_bytes(build_fire_pdu(
        site=SITE, application=firing_app, event_number=event_number,
        firing_entity=firing_entity, target_entity=None, munition_entity=0,
        munition_type=MUNITION, quantity=1,
        event_site=SITE, event_application=EVENT_APP))


def _detonation(event_number: int, firing_entity: int, firing_app: int,
                result: int) -> None:
    send_udp_bytes(build_detonation_pdu(
        site=SITE, application=firing_app, event_number=event_number,
        firing_entity=firing_entity, target_entity=None, munition_entity=0,
        munition_type=MUNITION, quantity=1, detonation_result=result,
        event_site=SITE, event_application=EVENT_APP))


def _asset_exists(urn: str) -> bool:
    rows = query_postgres(
        f"select 1 from telemetry_latest_state where asset_id = '{urn}'")
    return bool(rows)


def _wait_assets_registered(urns: list[str], timeout_s: float = 30.0) -> bool:
    deadline = time.monotonic() + timeout_s
    pending = set(urns)
    while True:
        pending = {u for u in pending if not _asset_exists(u)}
        if not pending:
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(1.5)


def _terminal_states(event_urns: list[str]) -> dict[str, str | None]:
    in_list = ",".join(f"'{u}'" for u in event_urns)
    rows = query_postgres(
        f"select event_urn, terminal_state from effector_launch "
        f"where event_urn in ({in_list})")
    return {r[0]: (r[1] if r[1] != "" else None) for r in rows}


def _launch_row_count(event_urns: list[str]) -> int:
    in_list = ",".join(f"'{u}'" for u in event_urns)
    rows = query_postgres(
        f"select count(*) from effector_launch where event_urn in ({in_list})")
    return int(rows[0][0])


def _pending_count() -> int:
    """Rows across ALL runs/tests still awaiting a terminal_state -- the
    population the timeout sweep can still resolve into effector_unresolved_total
    at any moment."""
    rows = query_postgres(
        "select count(*) from effector_launch where terminal_state is null")
    return int(rows[0][0])


def _wait_drained() -> None:
    """Block until no effector_launch row anywhere is pending a terminal
    sweep, then wait one more sweep interval so a sweep already in flight
    lands before the counter baseline is read. See SKIP_DRAIN's comment for
    why: a foreign pending row swept mid-run inflates this test's own +3
    assertion on effector_unresolved_total."""
    if SKIP_DRAIN:
        return
    deadline = time.monotonic() + DRAIN_TIMEOUT_S
    count = _pending_count()
    while count != 0 and time.monotonic() < deadline:
        time.sleep(3.0)
        count = _pending_count()
    if count != 0:
        skip_(NAME, f"{count} effector_launch row(s) still pending a "
                    f"terminal_state after {DRAIN_TIMEOUT_S:.0f}s -- cannot "
                    f"take a clean effector_unresolved_total baseline while "
                    f"a sweep could still land mid-run")
    time.sleep(POST_DRAIN_WAIT_S)


def _counts(launcher_urn: str) -> dict[str, int | None] | None:
    rows = query_postgres(
        "select expended, in_flight, unresolved, declared, remaining "
        "from effector_launcher_counts where launcher_asset_id = "
        f"'{launcher_urn}' and munition_type = '{MUNITION_KEY}'")
    if not rows:
        return None

    def _i(s: str) -> int | None:
        return None if s == "" else int(s)

    r = rows[0]
    return {"expended": _i(r[0]), "in_flight": _i(r[1]), "unresolved": _i(r[2]),
            "declared": _i(r[3]), "remaining": _i(r[4])}


def _late_terminal(event_urn: str) -> bool:
    rows = query_postgres(
        f"select late_terminal from effector_launch where event_urn = '{event_urn}'")
    return bool(rows) and rows[0][0] == "t"


def _scrape_all() -> dict[str, str]:
    """Every reachable projector instance's /metrics text, keyed by service
    name. skip_s if none of the four answer -- the counters below cannot be
    judged at all without at least one."""
    texts: dict[str, str] = {}
    for svc in ALL_PROJECTOR_SVCS:
        text = scrape_service_metrics(svc, PROJECTOR_METRICS_PORT)
        if text:
            texts[svc] = text
    if not texts:
        skip_(NAME, "no projector instance's metrics endpoint was reachable")
    return texts


def _sum_metric(texts: dict[str, str], name: str,
                labels: dict[str, str] | None = None) -> float:
    total = 0.0
    for text in texts.values():
        if labels:
            total += metric_value_labeled(text, name, labels)
        else:
            total += metric_sum(text, name) or 0.0
    return total


def _poll_metric_sum(name: str, labels: dict[str, str] | None, target: float,
                     timeout_s: float = 20.0) -> float:
    """Poll the metric's cross-instance sum until it reaches at least
    `target` or timeout_s elapses, then return whatever it last read. The
    20s ceiling (rather than the few seconds a single-instance read would
    need) is for projector-hq's copy of each record, which arrives via the
    redpanda bridge and so lags the edge projector's own copy."""
    deadline = time.monotonic() + timeout_s
    value = _sum_metric(_scrape_all(), name, labels)
    while value < target and time.monotonic() < deadline:
        time.sleep(2.0)
        value = _sum_metric(_scrape_all(), name, labels)
    return value


def _cleanup() -> None:
    urns = ",".join(f"'{u}'" for u in
                    (LAUNCHER_A_URN, LAUNCHER_B_URN, LAUNCHER_C_URN))
    try:
        query_postgres(
            f"delete from effector_launch where launcher_asset_id in ({urns})")
    except Exception as exc:  # noqa: BLE001 - cleanup must never mask a result
        print(f"    (cleanup warning: {exc})")


def main() -> None:
    # Drain precondition: see SKIP_DRAIN's comment -- a foreign pending row
    # from another test, swept mid-run, would inflate the +3 assertion on
    # effector_unresolved_total below.
    _wait_drained()

    texts_before = _scrape_all()
    unknown_before = _sum_metric(
        texts_before, METRIC_REFUSED, {"reason": "unknown_launcher"})
    no_fire_before = _sum_metric(
        texts_before, METRIC_REFUSED, {"reason": "no_fire"})
    conflicting_before = _sum_metric(
        texts_before, METRIC_REFUSED, {"reason": "conflicting_detonation"})
    replayed_before = _sum_metric(texts_before, METRIC_REPLAYED)
    late_before = _sum_metric(texts_before, METRIC_LATE)
    unresolved_before = _sum_metric(texts_before, METRIC_UNRESOLVED)

    # --- register the three launchers via Entity State PDUs ---------------
    send_udp_bytes(build_entity_state_pdu(
        site=SITE, application=LAUNCHER_A_APP, entity=LAUNCHER_A,
        kind=1, domain=1, country=225, category=1, subcategory=1,
        specific=2, extra=0, force_id=1, marking="EFFECTOR-A"))
    send_udp_bytes(build_entity_state_pdu(
        site=SITE, application=LAUNCHER_B_APP, entity=LAUNCHER_B,
        kind=1, domain=2, country=225, category=20, subcategory=1,
        specific=7, extra=0, force_id=1, marking="EFFECTOR-B"))
    send_udp_bytes(build_entity_state_pdu(
        site=SITE, application=LAUNCHER_C_APP, entity=LAUNCHER_C,
        kind=1, domain=2, country=225, category=23, subcategory=1,
        specific=9, extra=0, force_id=1, marking="EFFECTOR-C"))

    if not _wait_assets_registered(
            [LAUNCHER_A_URN, LAUNCHER_B_URN, LAUNCHER_C_URN], timeout_s=30.0):
        skip_(NAME, "launcher ESPDUs did not reach telemetry_latest_state "
                    "within 30s -- cannot judge admission/declared-load "
                    "resolution without it")

    # --- the engagement: fires, then detonations ---------------------------
    _fire(1, LAUNCHER_A, LAUNCHER_A_APP)
    _fire(2, LAUNCHER_A, LAUNCHER_A_APP)
    _fire(3, LAUNCHER_A, LAUNCHER_A_APP)
    _fire(4, LAUNCHER_B, LAUNCHER_B_APP)
    _fire(5, LAUNCHER_B, LAUNCHER_B_APP)
    _fire(6, LAUNCHER_C, LAUNCHER_C_APP)

    _detonation(1, LAUNCHER_A, LAUNCHER_A_APP, 1)
    _detonation(2, LAUNCHER_A, LAUNCHER_A_APP, 3)
    _detonation(4, LAUNCHER_B, LAUNCHER_B_APP, 6)

    all_urns = [_event_urn(i) for i in range(1, 7)]

    # --- 1: exactly 6 effector_launch rows for this run ---------------------
    deadline = time.monotonic() + 15.0
    count = _launch_row_count(all_urns)
    while count != 6 and time.monotonic() < deadline:
        time.sleep(1.0)
        count = _launch_row_count(all_urns)
    if count != 6:
        fail_(NAME, f"effector_launch held {count} rows for this run's 6 "
                    f"fires, expected exactly 6")

    # --- 2: terminal states ------------------------------------------------
    states = _terminal_states(all_urns)
    expected_terminal = {
        _event_urn(1): "entity_impact",
        _event_urn(2): "ground_impact",
        _event_urn(4): "dud",
    }
    bad = {u: states.get(u) for u in all_urns
          if states.get(u) != expected_terminal.get(u)}
    if bad:
        fail_(NAME, f"terminal_state mismatch: {bad}, expected "
                    f"{expected_terminal} and NULL for E3/E5/E6")

    # --- 3: effector_launcher_counts per launcher ---------------------------
    counts_a = _counts(LAUNCHER_A_URN)
    counts_b = _counts(LAUNCHER_B_URN)
    counts_c = _counts(LAUNCHER_C_URN)
    expected_a = {"expended": 3, "in_flight": 1, "declared": 8, "remaining": 5}
    expected_b = {"expended": 2, "in_flight": 1, "declared": 4, "remaining": 2}
    expected_c = {"expended": 1, "in_flight": 1, "declared": None, "remaining": None}

    def _mismatch(actual: dict | None, expected: dict) -> dict:
        if actual is None:
            return {"missing": True}
        return {k: (actual.get(k), v) for k, v in expected.items()
                if actual.get(k) != v}

    mism_a, mism_b, mism_c = (_mismatch(counts_a, expected_a),
                              _mismatch(counts_b, expected_b),
                              _mismatch(counts_c, expected_c))
    if mism_a or mism_b or mism_c:
        fail_(NAME, f"effector_launcher_counts mismatch -- A:{mism_a} "
                    f"(got {counts_a}) B:{mism_b} (got {counts_b}) "
                    f"C:{mism_c} (got {counts_c})")

    # --- 3b: replayed +3 -- the second projector instance (01 or hq) to
    # see each of E1/E2/E4's real Detonation ---------------------------------
    replayed_after_engagement = _poll_metric_sum(
        METRIC_REPLAYED, None, replayed_before + 3, timeout_s=20.0)
    if replayed_after_engagement - replayed_before != 3:
        fail_(NAME, f"{METRIC_REPLAYED} (summed across {ALL_PROJECTOR_SVCS}) "
                    f"moved by {replayed_after_engagement - replayed_before:.0f}, "
                    f"expected exactly +3 (E1/E2/E4, the second instance to "
                    f"see each) ({replayed_before:.0f} -> "
                    f"{replayed_after_engagement:.0f})")

    # --- 4: red -- E7 Fire from an unregistered launcher --------------------
    _fire(7, UNKNOWN_LAUNCHER, LAUNCHER_A_APP)
    # --- 5: red -- E8 Detonation with no matching Fire ----------------------
    _detonation(8, LAUNCHER_A, LAUNCHER_A_APP, 1)

    e7_urn, e8_urn = _event_urn(7), _event_urn(8)
    deadline = time.monotonic() + 15.0
    while (time.monotonic() < deadline
          and (_launch_row_count([e7_urn]) != 0 or _launch_row_count([e8_urn]) != 0)):
        time.sleep(1.0)
    if _launch_row_count([e7_urn]) != 0:
        fail_(NAME, f"{e7_urn} (unknown-launcher Fire) wrote a row; expected none")
    if _launch_row_count([e8_urn]) != 0:
        fail_(NAME, f"{e8_urn} (no-matching-Fire Detonation) wrote a row; "
                    f"expected none")

    # unknown_launcher/no_fire are refused independently by projector-01 and
    # projector-hq (both check the same shared-store facts), so +2 each, not
    # +1 -- see module docstring.
    unknown_after = _poll_metric_sum(
        METRIC_REFUSED, {"reason": "unknown_launcher"}, unknown_before + 2,
        timeout_s=20.0)
    no_fire_after = _poll_metric_sum(
        METRIC_REFUSED, {"reason": "no_fire"}, no_fire_before + 2, timeout_s=20.0)
    if unknown_after - unknown_before != 2:
        fail_(NAME, f'{METRIC_REFUSED}{{reason="unknown_launcher"}} (summed '
                    f"across {ALL_PROJECTOR_SVCS}) did not increase by exactly "
                    f"2 ({unknown_before:.0f} -> {unknown_after:.0f})")
    if no_fire_after - no_fire_before != 2:
        fail_(NAME, f'{METRIC_REFUSED}{{reason="no_fire"}} (summed across '
                    f"{ALL_PROJECTOR_SVCS}) did not increase by exactly 2 "
                    f"({no_fire_before:.0f} -> {no_fire_after:.0f})")

    counts_a_after_red = _counts(LAUNCHER_A_URN)
    if _mismatch(counts_a_after_red, expected_a):
        fail_(NAME, f"A's counts changed after the red Detonation E8: "
                    f"{counts_a_after_red}, expected unchanged {expected_a}")

    # --- 6: wait out the timeout sweep --------------------------------------
    # compose sets EFFECTOR_TERMINAL_TIMEOUT_S=60, sweep interval 15s.
    unresolved_targets = [_event_urn(3), _event_urn(5), _event_urn(6)]
    deadline = time.monotonic() + 100.0
    swept = _terminal_states(unresolved_targets)
    while (any(swept.get(u) != "unresolved" for u in unresolved_targets)
          and time.monotonic() < deadline):
        time.sleep(3.0)
        swept = _terminal_states(unresolved_targets)
    still_not_unresolved = {u: swept.get(u) for u in unresolved_targets
                            if swept.get(u) != "unresolved"}
    if still_not_unresolved:
        fail_(NAME, f"timeout sweep did not mark {still_not_unresolved} "
                    f"'unresolved' within 100s")

    for urn, label in ((LAUNCHER_A_URN, "A"), (LAUNCHER_B_URN, "B"),
                      (LAUNCHER_C_URN, "C")):
        c = _counts(urn)
        if c is None or c["in_flight"] != 0:
            fail_(NAME, f"launcher {label} in_flight was not 0 after the "
                        f"timeout sweep: {c}")

    # Every instance's sweep races the SAME row via an UPDATE, so only the
    # one that wins a given row counts it -- summed across instances this
    # is exactly +3 for E3/E5/E6, not +3 per instance.
    unresolved_after_sweep = _poll_metric_sum(
        METRIC_UNRESOLVED, None, unresolved_before + 3, timeout_s=20.0)
    if unresolved_after_sweep - unresolved_before != 3:
        fail_(NAME, f"{METRIC_UNRESOLVED} (summed across {ALL_PROJECTOR_SVCS}) "
                    f"moved by {unresolved_after_sweep - unresolved_before:.0f}, "
                    f"expected exactly +3 ({unresolved_before:.0f} -> "
                    f"{unresolved_after_sweep:.0f})")

    # --- 7: late Detonation for E5 -------------------------------------------
    e5_urn = _event_urn(5)
    _detonation(5, LAUNCHER_B, LAUNCHER_B_APP, 1)

    deadline = time.monotonic() + 15.0
    state5 = _terminal_states([e5_urn]).get(e5_urn)
    while state5 != "entity_impact" and time.monotonic() < deadline:
        time.sleep(1.0)
        state5 = _terminal_states([e5_urn]).get(e5_urn)
    if state5 != "entity_impact":
        fail_(NAME, f"late Detonation for {e5_urn} did not resolve to "
                    f"entity_impact within 15s (last seen: {state5!r})")
    if not _late_terminal(e5_urn):
        fail_(NAME, f"{e5_urn} resolved by a late Detonation but "
                    f"late_terminal is not true")

    # The first instance to see the late Detonation gets "late" (+1
    # late_terminal); the second sees the row already resolved to the same
    # result and gets "replayed" (+1 more -- +4 total replayed by now).
    late_after = _poll_metric_sum(METRIC_LATE, None, late_before + 1, timeout_s=20.0)
    if late_after - late_before != 1:
        fail_(NAME, f"{METRIC_LATE} (summed across {ALL_PROJECTOR_SVCS}) did "
                    f"not increase by exactly 1 ({late_before:.0f} -> "
                    f"{late_after:.0f})")

    replayed_final = _poll_metric_sum(
        METRIC_REPLAYED, None, replayed_before + 4, timeout_s=20.0)
    if replayed_final - replayed_before != 4:
        fail_(NAME, f"{METRIC_REPLAYED} (summed across {ALL_PROJECTOR_SVCS}) "
                    f"is +{replayed_final - replayed_before:.0f} since the start "
                    f"of this run, expected exactly +4 by now (3 from E1/E2/E4 "
                    f"+ 1 more from the late E5's second instance)")

    counts_b_after_late = _counts(LAUNCHER_B_URN)
    if (counts_b_after_late is None or counts_b_after_late["unresolved"] != 0
            or counts_b_after_late["in_flight"] != 0):
        fail_(NAME, f"B's counts after the late Detonation were "
                    f"{counts_b_after_late}, expected unresolved=0 in_flight=0")

    # --- fail-on-purpose #2 (manual; see module docstring) ------------------
    if INJECT_CONFLICT:
        _detonation(1, LAUNCHER_A, LAUNCHER_A_APP, 3)  # E1's real result was 1

    # conflicting_detonation must read +0 for the whole run -- unless the
    # injection above just ran, in which case it must read +2 (both
    # instances independently refuse the conflicting result) and this
    # assertion is meant to fail.
    conflicting_target = conflicting_before + (2 if INJECT_CONFLICT else 0)
    conflicting_final = _poll_metric_sum(
        METRIC_REFUSED, {"reason": "conflicting_detonation"}, conflicting_target,
        timeout_s=20.0)
    if conflicting_final - conflicting_before != 0:
        fail_(NAME, f'{METRIC_REFUSED}{{reason="conflicting_detonation"}} '
                    f"(summed across {ALL_PROJECTOR_SVCS}) moved by "
                    f"{conflicting_final - conflicting_before:.0f} during this "
                    f"run, expected +0 throughout ({conflicting_before:.0f} -> "
                    f"{conflicting_final:.0f})")

    # --- 8: expended unchanged by the sweep and the late Detonation --------
    counts_a_final = _counts(LAUNCHER_A_URN)
    counts_b_final = _counts(LAUNCHER_B_URN)
    counts_c_final = _counts(LAUNCHER_C_URN)
    final_expended = {
        "A": counts_a_final["expended"] if counts_a_final else None,
        "B": counts_b_final["expended"] if counts_b_final else None,
        "C": counts_c_final["expended"] if counts_c_final else None,
    }
    if final_expended != {"A": 3, "B": 2, "C": 1}:
        fail_(NAME, f"expended moved after the sweep/late-Detonation: "
                    f"{final_expended}, expected A=3 B=2 C=1 unchanged")

    _cleanup()
    pass_(NAME,
          f"6 rows written (A3 B2 C1); terminal E1=entity_impact "
          f"E2=ground_impact E4=dud, E3/E5/E6 NULL pre-sweep; counts A="
          f"{expected_a} B={expected_b} C={expected_c}; {METRIC_REPLAYED} "
          f"+{replayed_after_engagement - replayed_before:.0f} for E1/E2/E4; "
          f"red E7 unknown_launcher +{unknown_after - unknown_before:.0f} "
          f"({unknown_before:.0f}->{unknown_after:.0f}) no row, E8 no_fire "
          f"+{no_fire_after - no_fire_before:.0f} "
          f"({no_fire_before:.0f}->{no_fire_after:.0f}) no row, A unchanged; "
          f"sweep marked E3/E5/E6 unresolved, in_flight=0 all three, "
          f"{METRIC_UNRESOLVED} +{unresolved_after_sweep - unresolved_before:.0f}; "
          f"late Detonation E5->entity_impact late_terminal=true "
          f"{METRIC_LATE} +{late_after - late_before:.0f}, {METRIC_REPLAYED} "
          f"total +{replayed_final - replayed_before:.0f}, B unresolved=0 "
          f"in_flight=0; conflicting_detonation +"
          f"{conflicting_final - conflicting_before:.0f}; expended unchanged "
          f"A=3 B=2 C=1")


if __name__ == "__main__":
    main()
