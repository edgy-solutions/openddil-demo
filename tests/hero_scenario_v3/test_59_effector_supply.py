"""
Test 59 — effector_supply: the fusion factor for effector supply (admission,
dedup-by-event_urn, Detonation no-op, worst-wins against whatever else is
constraining the asset).

Two launchers with a declared munition load (compose mounts config/
effector-declared-load.yaml, variant-keyed; AH-64E-V6=4) plus one launcher
with no declared-load entry at all (CH-47F-BlockII), and one launcher that
is never admitted at all:

  Launcher B = dis:1:591:(n+1), entity type 1_2_225_20_1_7_0 (AH-64E-V6, declared 4)
  Launcher C = dis:1:592:(n+1), entity type 1_2_225_23_1_9_0 (CH-47F-BlockII, no declared load)
  Launcher X = dis:1:593:(n+1), never sent as an Entity State PDU

Engagement (munition 2.9.225.2.1.1.0, quantity 1, eventID site 1
application 3000+(n%60000)):

  E1 B (fire)       -- expended 1/4, remaining 75%, no factor
  E2 B, E3 B (fire)  -- expended 3/4, remaining 25% -> DEGRADED
  E3 resent (same event_urn) -- replay, no change
  E4 B (fire)        -- expended 4/4, remaining 0% -> CRITICAL
  E5 C, E6 C (fire)  -- C has no declared load, so no factor regardless of
                        expended and no change to C's overall severity
  E7 X (fire)        -- unknown_launcher refusal, no state, no status row
  E1 B (detonation)  -- no supply effect, counted, B unchanged

`logistics-fusion-service` runs as a single compose instance (unlike the
projector's four), and its three per-edge Kafka-cluster subscriptions for
effector-events (edge-01/02/03) cover every edge send_udp_bytes can target
but there is no hq subscription for this topic -- every PDU here goes to
edge-01 (send_udp_bytes's default), so each one is processed by fusion
EXACTLY ONCE. All metric deltas below are therefore plain +1 counts against
a single instance's /metrics, not a cross-instance sum (contrast test_58,
whose docstring explains why the projector's four instances need summing).

Expended is read back directly from AssetLogistics' durable Restate state
(`effector_expended_dict`, via `restate state get AssetLogistics <id> -p` --
the same CLI path _cm_helpers.clear_asset_logistics_state already uses to
clear that state) rather than inferred solely from the published factor,
since a quiet update (no severity transition) does not by itself prove a
Fire was counted. asset_logistics_status is read directly from postgres-hq,
the same table test_47/test_51 query, with constraining_factors cast to
text and decoded as JSON the way test_46 decodes region_top_factors.factors.

Fail-on-purpose (run by hand, not part of this script's own PASS path):
bump AH-64E-V6's entry in config/effector-declared-load.yaml from 4 to 5,
`docker compose restart logistics-fusion-service` (not `up -d` -- that
no-ops when compose sees no config-level diff even though the mounted
file's content changed), wait for the service to be ready, rerun -- step 2
must FAIL (2/5 = 40% remaining, above the 25% degraded threshold, so no
effector.* factor appears at all). Restore to 4, restart, wait for ready,
rerun for a clean PASS.
"""
from __future__ import annotations

import json
import subprocess
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
from _cm_helpers import COMPOSE_DIR, docker_compose  # noqa: E402

NAME = "test_59_effector_supply"

FUSION_SVC = "logistics-fusion-service"
FUSION_METRICS_PORT = 9464

SITE = 1
MUNITION = (2, 9, 225, 2, 1, 1, 0)
MUNITION_KEY = "2.9.225.2.1.1.0"
FACTOR_ID = f"effector.{MUNITION_KEY}"

NON_OK_SEVERITIES = ("LOGISTICS_SEVERITY_DEGRADED", "LOGISTICS_SEVERITY_CRITICAL")

n = int(time.time()) % 30000

LAUNCHER_B_APP = 591  # AH-64E-V6, declared load 4
LAUNCHER_C_APP = 592  # CH-47F-BlockII, no declared load
LAUNCHER_X_APP = 593  # never sent as an Entity State PDU

LAUNCHER_B = n + 1
LAUNCHER_C = n + 1
LAUNCHER_X = n + 1

LAUNCHER_B_URN = f"dis:{SITE}:{LAUNCHER_B_APP}:{LAUNCHER_B}"
LAUNCHER_C_URN = f"dis:{SITE}:{LAUNCHER_C_APP}:{LAUNCHER_C}"
LAUNCHER_X_URN = f"dis:{SITE}:{LAUNCHER_X_APP}:{LAUNCHER_X}"

EVENT_APP = 3000 + (n % 60000)


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


def _restate_state(asset_id: str) -> dict:
    """AssetLogistics' durable Restate state for one asset_id, via the same
    `restate state ... AssetLogistics <id>` CLI path
    _cm_helpers.clear_asset_logistics_state uses to clear it. `{}` for an
    asset with no state at all -- including one that was never admitted."""
    cmd = docker_compose() + [
        "exec", "-T", "restate-server",
        "restate", "state", "get", "AssetLogistics", asset_id, "-p",
    ]
    try:
        proc = subprocess.run(cmd, cwd=str(COMPOSE_DIR), capture_output=True,
                              timeout=15, text=True)
    except subprocess.TimeoutExpired:
        return {}
    if proc.returncode != 0:
        return {}
    try:
        return json.loads(proc.stdout.strip() or "{}")
    except json.JSONDecodeError:
        return {}


def _expended(asset_id: str) -> dict:
    return _restate_state(asset_id).get("effector_expended_dict", {}) or {}


def _status_row(asset_id: str) -> dict | None:
    rows = query_postgres(
        "SELECT overall_severity, constraining_factors::text, status_revision "
        f"FROM asset_logistics_status WHERE asset_id = '{asset_id}'")
    if not rows:
        return None
    severity, factors_text, revision = rows[0]
    factors = json.loads(factors_text) if factors_text else []
    return {"overall_severity": severity, "factors": factors,
            "status_revision": int(revision)}


def _factor(status: dict | None, factor_id: str) -> dict | None:
    if status is None:
        return None
    for f in status["factors"]:
        if f.get("factor_id") == factor_id:
            return f
    return None


def _wait_status_row(asset_id: str, timeout_s: float = 30.0) -> dict | None:
    deadline = time.monotonic() + timeout_s
    status = _status_row(asset_id)
    while status is None and time.monotonic() < deadline:
        time.sleep(1.5)
        status = _status_row(asset_id)
    return status


def _poll(predicate, timeout_s: float = 20.0, interval: float = 1.5) -> bool:
    deadline = time.monotonic() + timeout_s
    result = predicate()
    while not result and time.monotonic() < deadline:
        time.sleep(interval)
        result = predicate()
    return bool(result)


def _metrics() -> str:
    text = scrape_service_metrics(FUSION_SVC, FUSION_METRICS_PORT)
    if not text:
        skip_(NAME, f"{FUSION_SVC}'s metrics endpoint was not reachable")
    return text


def _refused_unknown(text: str) -> float:
    return metric_value_labeled(
        text, "fusion_effector_refused_total", {"reason": "unknown_launcher"})


def _replayed(text: str) -> float:
    return metric_sum(text, "fusion_effector_replayed_total") or 0.0


def _detonation_seen(text: str) -> float:
    return metric_sum(text, "fusion_effector_detonation_seen_total") or 0.0


def main() -> None:
    text_before = _metrics()
    unknown_before = _refused_unknown(text_before)

    # --- admit B (AH-64E-V6) and C (CH-47F-BlockII); X is never sent --------
    send_udp_bytes(build_entity_state_pdu(
        site=SITE, application=LAUNCHER_B_APP, entity=LAUNCHER_B,
        kind=1, domain=2, country=225, category=20, subcategory=1,
        specific=7, extra=0, force_id=1, marking="EFF59-B"))
    send_udp_bytes(build_entity_state_pdu(
        site=SITE, application=LAUNCHER_C_APP, entity=LAUNCHER_C,
        kind=1, domain=2, country=225, category=23, subcategory=1,
        specific=9, extra=0, force_id=1, marking="EFF59-C"))

    status_b = _wait_status_row(LAUNCHER_B_URN, timeout_s=30.0)
    status_c = _wait_status_row(LAUNCHER_C_URN, timeout_s=30.0)
    if status_b is None or status_c is None:
        skip_(NAME, "B and/or C did not get an asset_logistics_status row "
                    "within 30s of their Entity State PDU -- cannot judge "
                    "effector-supply admission without it "
                    f"(B={status_b is not None} C={status_c is not None})")

    # --- step 1: B fires E1 (q1) -- remaining 3/4 = 75%, no factor ----------
    _fire(1, LAUNCHER_B, LAUNCHER_B_APP)

    if not _poll(lambda: _expended(LAUNCHER_B_URN).get(MUNITION_KEY) == 1,
                timeout_s=20.0):
        fail_(NAME, f"B's effector_expended_dict did not reach "
                    f"{{{MUNITION_KEY!r}: 1}} within 20s after E1 "
                    f"(last seen {_expended(LAUNCHER_B_URN)})")
    status_b = _status_row(LAUNCHER_B_URN)
    if _factor(status_b, FACTOR_ID) is not None:
        fail_(NAME, f"B has a {FACTOR_ID} factor after E1 (1/4 expended, "
                    f"75% remaining); expected none: {status_b['factors']}")

    # --- step 2: B fires E2, E3 -- remaining 1/4 = 25% -> DEGRADED ----------
    _fire(2, LAUNCHER_B, LAUNCHER_B_APP)
    _fire(3, LAUNCHER_B, LAUNCHER_B_APP)

    if not _poll(lambda: _expended(LAUNCHER_B_URN).get(MUNITION_KEY) == 3,
                timeout_s=20.0):
        fail_(NAME, f"B's effector_expended_dict did not reach "
                    f"{{{MUNITION_KEY!r}: 3}} within 20s after E2/E3 "
                    f"(last seen {_expended(LAUNCHER_B_URN)})")

    def _b_degraded() -> bool:
        nonlocal status_b
        status_b = _status_row(LAUNCHER_B_URN)
        f = _factor(status_b, FACTOR_ID)
        return f is not None and f.get("severity") == "LOGISTICS_SEVERITY_DEGRADED"

    if not _poll(_b_degraded, timeout_s=20.0):
        fail_(NAME, f"B's {FACTOR_ID} factor did not read DEGRADED within "
                    f"20s of E2/E3 (last status: {status_b})")
    if status_b["overall_severity"] not in NON_OK_SEVERITIES:
        fail_(NAME, f"B's overall_severity ({status_b['overall_severity']}) "
                    f"is not at least DEGRADED after E2/E3")

    # --- step 3: resend E3 (same event_urn) -- replay, no change -----------
    expended_before_replay = dict(_expended(LAUNCHER_B_URN))
    revision_before_replay = status_b["status_revision"]
    replayed_before_resend = _replayed(_metrics())

    _fire(3, LAUNCHER_B, LAUNCHER_B_APP)

    def _replay_seen() -> bool:
        return _replayed(_metrics()) >= replayed_before_resend + 1

    if not _poll(_replay_seen, timeout_s=20.0):
        fail_(NAME, f"fusion_effector_replayed_total did not read +1 within "
                    f"20s of resending E3's event_urn (before="
                    f"{replayed_before_resend:.0f})")
    replayed_after_resend = _replayed(_metrics())

    if _expended(LAUNCHER_B_URN) != expended_before_replay:
        fail_(NAME, f"B's effector_expended_dict changed after a replayed "
                    f"event_urn: {expended_before_replay} -> "
                    f"{_expended(LAUNCHER_B_URN)}")
    status_b_after_replay = _status_row(LAUNCHER_B_URN)
    if status_b_after_replay["status_revision"] != revision_before_replay:
        fail_(NAME, f"B's status_revision moved on a replayed event_urn "
                    f"({revision_before_replay} -> "
                    f"{status_b_after_replay['status_revision']})")

    # --- step 4: B fires E4 -- remaining 0/4 = 0% -> CRITICAL ---------------
    _fire(4, LAUNCHER_B, LAUNCHER_B_APP)

    if not _poll(lambda: _expended(LAUNCHER_B_URN).get(MUNITION_KEY) == 4,
                timeout_s=20.0):
        fail_(NAME, f"B's effector_expended_dict did not reach "
                    f"{{{MUNITION_KEY!r}: 4}} within 20s after E4 "
                    f"(last seen {_expended(LAUNCHER_B_URN)})")

    def _b_critical() -> bool:
        nonlocal status_b
        status_b = _status_row(LAUNCHER_B_URN)
        f = _factor(status_b, FACTOR_ID)
        return f is not None and f.get("severity") == "LOGISTICS_SEVERITY_CRITICAL"

    if not _poll(_b_critical, timeout_s=20.0):
        fail_(NAME, f"B's {FACTOR_ID} factor did not read CRITICAL within "
                    f"20s of E4 (last status: {status_b})")
    if status_b["overall_severity"] != "LOGISTICS_SEVERITY_CRITICAL":
        fail_(NAME, f"B's overall_severity is {status_b['overall_severity']} "
                    f"after E4, expected LOGISTICS_SEVERITY_CRITICAL")

    # --- step 5: C fires E5, E6 -- no declared load -> no factor, unchanged
    status_c_before_fires = _status_row(LAUNCHER_C_URN)
    _fire(5, LAUNCHER_C, LAUNCHER_C_APP)
    _fire(6, LAUNCHER_C, LAUNCHER_C_APP)

    if not _poll(lambda: _expended(LAUNCHER_C_URN).get(MUNITION_KEY) == 2,
                timeout_s=20.0):
        fail_(NAME, f"C's effector_expended_dict did not reach "
                    f"{{{MUNITION_KEY!r}: 2}} within 20s after E5/E6 "
                    f"(last seen {_expended(LAUNCHER_C_URN)})")

    status_c_after_fires = _status_row(LAUNCHER_C_URN)
    if _factor(status_c_after_fires, FACTOR_ID) is not None:
        fail_(NAME, f"C has a {FACTOR_ID} factor after E5/E6 despite no "
                    f"declared load: {status_c_after_fires['factors']}")
    if (status_c_after_fires["overall_severity"]
            != status_c_before_fires["overall_severity"]):
        fail_(NAME, f"C's overall_severity changed after E5/E6 with no "
                    f"declared load: {status_c_before_fires['overall_severity']} "
                    f"-> {status_c_after_fires['overall_severity']}")

    # --- step 6: X fires E7 -- unknown launcher, refused, no row -----------
    _fire(7, LAUNCHER_X, LAUNCHER_X_APP)

    def _unknown_seen() -> bool:
        return _refused_unknown(_metrics()) >= unknown_before + 1

    if not _poll(_unknown_seen, timeout_s=20.0):
        fail_(NAME, f'fusion_effector_refused_total{{reason='
                    f'"unknown_launcher"}} did not read +1 within 20s of E7 '
                    f"(before={unknown_before:.0f})")
    unknown_after = _refused_unknown(_metrics())
    if unknown_after - unknown_before != 1:
        fail_(NAME, f'fusion_effector_refused_total{{reason='
                    f'"unknown_launcher"}} (single instance) moved by '
                    f"{unknown_after - unknown_before:.0f}, expected exactly "
                    f"+1 ({unknown_before:.0f} -> {unknown_after:.0f})")

    if _status_row(LAUNCHER_X_URN) is not None:
        fail_(NAME, "X has an asset_logistics_status row despite never "
                    "being admitted via an Entity State PDU")
    if _restate_state(LAUNCHER_X_URN):
        fail_(NAME, f"X has AssetLogistics state despite being refused: "
                    f"{_restate_state(LAUNCHER_X_URN)}")

    # --- step 7: B detonation for E1 -- no supply effect, counted ----------
    detonation_before = _detonation_seen(_metrics())
    expended_before_det = dict(_expended(LAUNCHER_B_URN))
    status_b_before_det = _status_row(LAUNCHER_B_URN)

    _detonation(1, LAUNCHER_B, LAUNCHER_B_APP, result=1)

    def _detonation_counted() -> bool:
        return _detonation_seen(_metrics()) >= detonation_before + 1

    if not _poll(_detonation_counted, timeout_s=20.0):
        fail_(NAME, f"fusion_effector_detonation_seen_total did not read +1 "
                    f"within 20s of B's E1 Detonation (before="
                    f"{detonation_before:.0f})")
    detonation_after = _detonation_seen(_metrics())

    if _expended(LAUNCHER_B_URN) != expended_before_det:
        fail_(NAME, f"B's effector_expended_dict changed after a "
                    f"Detonation: {expended_before_det} -> "
                    f"{_expended(LAUNCHER_B_URN)}")
    status_b_after_det = _status_row(LAUNCHER_B_URN)
    if (status_b_after_det["overall_severity"]
            != status_b_before_det["overall_severity"]
            or _factor(status_b_after_det, FACTOR_ID)
            != _factor(status_b_before_det, FACTOR_ID)):
        fail_(NAME, f"B's status changed after a Detonation: "
                    f"{status_b_before_det} -> {status_b_after_det}")

    pass_(NAME,
          f"B admitted (AH-64E-V6, declared 4), C admitted (CH-47F-BlockII, "
          f"no declared load); step1 E1 expended=1 no {FACTOR_ID} factor "
          f"(75% remaining); step2 E2/E3 expended=3 {FACTOR_ID} DEGRADED "
          f"(25% remaining), overall>=DEGRADED; step3 replay of E3 left "
          f"expended={expended_before_replay} and status_revision unchanged, "
          f"fusion_effector_replayed_total (single instance) +"
          f"{replayed_after_resend - replayed_before_resend:.0f}; step4 E4 "
          f"expended=4 {FACTOR_ID} CRITICAL (0% remaining), overall "
          f"CRITICAL; step5 C E5/E6 expended=2 no {FACTOR_ID} factor, "
          f"overall unchanged ({status_c_before_fires['overall_severity']}); "
          f'step6 X E7 fusion_effector_refused_total{{reason='
          f'"unknown_launcher"}} (single instance) +'
          f"{unknown_after - unknown_before:.0f}, no status row, no Restate "
          f"state; step7 B Detonation for E1 left expended/status unchanged, "
          f"fusion_effector_detonation_seen_total +"
          f"{detonation_after - detonation_before:.0f}")


if __name__ == "__main__":
    main()
