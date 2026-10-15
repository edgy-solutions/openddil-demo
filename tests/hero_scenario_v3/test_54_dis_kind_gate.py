"""
Test 54 — DIS entity kinds are admitted by declaration, and refusals are counted.

The gate (dynamic-mappings/dis-kind-gate.yaml) exists because a kind=2
MUNITION Entity State PDU was measured entering the fleet as an asset with
platform_variant=UNKNOWN, and two properties made that permanent: `kind` is
absent from the asset_id, so no fleet query can exclude munitions by key
pattern; and there is no eviction path, so a round admitted once stays a
member. See openddil-helm/scripts/FINDING-2026-09-26-kind2-munition-resolution.md.

Since ADR-0049 the gate has two exits. Kind 2 (DIS_TRACK_ENTITY_KINDS) is
routed ahead of it to the munition-tracks topic as a child track and counted
in dis_ingress_kind_tracked; any other unadmitted kind (3 here) is still
refused and counted in dis_ingress_kind_dropped. Neither becomes an asset.

Six assertions. The third and fifth are the ones that matter:

  1. a kind=2 PDU increments dis_ingress_kind_tracked{kind="2"}, leaves
     dis_ingress_kind_dropped{kind="2"} unchanged, and advances the
     munition-tracks watermark
  2. a kind=2 PDU adds NOTHING to raw-sensor-stream, and nothing to
     ingress-dlq; it never reaches the fleet (no telemetry_latest_state
     row) and it lands as a munition_track row
  3. a kind=1 PDU still lands on raw-sensor-stream
  4. a Remove Entity for the id admitted in (3) lands on raw-sensor-stream
  5. a Remove Entity for an id that was never admitted also passes the gate
     (it is stateless), and creates nothing: no telemetry_latest_state row,
     and the projector, AssetCM and AssetLogistics each count it as a
     removal for an unknown key
  6. a kind=3 PDU is still dropped: dis_ingress_kind_dropped{kind="3"}
     increases, and neither raw-sensor-stream nor munition-tracks moves

Without (3) this test passes for a gate that drops the entire feed, which is a
total ingress outage that looks like a clean deploy. Without (4) it passes for
a gate that drops every removal, which it did: a removal carries no entity
type, and read as kind 0 it was refused. Without (5) a munition's removal
would create the fleet member the gate kept out.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _helpers import (  # noqa: E402
    TOPIC_DLQ,
    TOPIC_SILVER,
    build_entity_state_pdu,
    build_remove_entity_pdu,
    fail_,
    metric_sum,
    metric_value_labeled,
    pass_,
    query_postgres,
    scrape_connect_metrics,
    scrape_service_metrics,
    send_udp_bytes,
    skip_,
    topic_high_watermark,
)

NAME = "test_54_dis_kind_gate"

TRACK_KIND = 2        # MUNITION: a child track, not an asset (ADR-0049)
GATED_KIND = 3        # not admitted, not tracked: still dropped
ADMITTED_KIND = 1     # PLATFORM
METRIC = "dis_ingress_kind_dropped"
METRIC_TRACKED = "dis_ingress_kind_tracked"
TOPIC_TRACKS = "munition-tracks"
TRACK_ENTITY = 54002
TRACK_ID = f"dis:1:1:{TRACK_ENTITY}"
GATED_ENTITY = 54004  # 54003 is the never-admitted removal id below
UNSEEN_ENTITY = 54003
UNSEEN_ID = f"dis:1:1:{UNSEEN_ENTITY}"

# Where a removal for an unknown key is resolved, and the counter each one
# keeps: (compose service, metrics port, series). The projector's port is
# the compose METRICS_PORT; the Restate services use their default.
UNKNOWN_REMOVAL_COUNTERS = {
    "projector": (
        ["openddil-projector-01", "openddil-projector-02",
         "openddil-projector-03", "openddil-projector-hq"],
        8084, "projector_removal_unknown_asset_dropped_total"),
    "AssetCM": (["cm-service"], 9464,
                "cm_removal_unknown_asset_dropped_total"),
    "AssetLogistics": (["logistics-fusion-service"], 9464,
                       "logistics_removal_unknown_asset_dropped_total"),
}


def _unknown_removal_counts() -> dict[str, float]:
    """One total per resolver. Fails, never zeroes, when a resolver cannot
    be read or does not carry the series: an image without the drop would
    otherwise read as "nothing counted yet" and step 5 could only fail late,
    for the wrong reason."""
    out = {}
    for who, (services, port, series) in UNKNOWN_REMOVAL_COUNTERS.items():
        total = None
        for svc in services:
            v = metric_sum(scrape_service_metrics(svc, port), series)
            if v is not None:
                total = (total or 0.0) + v
        if total is None:
            fail_(NAME, f"{who}: no {series} series on "
                        f"{', '.join(services)}:{port} -- cannot judge the "
                        f"unknown-key removal drop")
        out[who] = total
    return out


def _rows_for(asset_id: str) -> int:
    return int(query_postgres(
        "select count(*) from telemetry_latest_state "
        f"where asset_id = '{asset_id}'")[0][0])


def _hw(topic: str) -> int:
    """Watermark, or fail the test. NOT `or 0`.

    topic_high_watermark returns None when it cannot read the topic, and
    coercing that to 0 is how this suite's leak assertions became `0 > 0` and
    stopped being able to fail (see the note on that function). A gate test
    that cannot read the topic must say so, not pass.
    """
    hw = topic_high_watermark(topic)
    if hw is None:
        fail_(NAME, f"could not read high-watermark for {topic} — "
                    f"cannot judge whether anything landed")
    return hw


def _pdu(kind: int, entity: int, marking: str) -> bytes:
    return build_entity_state_pdu(
        site=1, application=1, entity=entity,
        kind=kind, domain=1, country=225, category=1, subcategory=1,
        specific=2, extra=0, marking=marking,
    )


def main() -> None:
    baseline_text = scrape_connect_metrics()
    if not baseline_text:
        # Distinguished from "series absent" deliberately: an unreachable
        # endpoint would otherwise read as a zero counter and this test would
        # pass by failing to look.
        skip_(NAME, "Connect metrics endpoint unreachable — cannot judge the gate")

    dropped_before = metric_value_labeled(baseline_text, METRIC,
                                          {"kind": str(TRACK_KIND)})
    tracked_before = metric_value_labeled(baseline_text, METRIC_TRACKED,
                                          {"kind": str(TRACK_KIND)})
    silver_before = _hw(TOPIC_SILVER)
    dlq_before = _hw(TOPIC_DLQ)
    tracks_before = _hw(TOPIC_TRACKS)

    # --- 1 + 2: the track kind ------------------------------------------
    send_udp_bytes(_pdu(TRACK_KIND, TRACK_ENTITY, "GATE-MUNITION"))
    time.sleep(3.0)

    after_text = scrape_connect_metrics()
    tracked_after = metric_value_labeled(after_text, METRIC_TRACKED,
                                         {"kind": str(TRACK_KIND)})
    if tracked_after <= tracked_before:
        fail_(NAME,
              f'{METRIC_TRACKED}{{kind="{TRACK_KIND}"}} did not increase '
              f"({tracked_before} -> {tracked_after}) — the route is silent")
    dropped_after = metric_value_labeled(after_text, METRIC,
                                         {"kind": str(TRACK_KIND)})
    if dropped_after != dropped_before:
        fail_(NAME,
              f'{METRIC}{{kind="{TRACK_KIND}"}} moved '
              f"({dropped_before} -> {dropped_after}) — a track kind is "
              f"being counted as refused too")

    tracks_after = _hw(TOPIC_TRACKS)
    if tracks_after < tracks_before + 1:
        fail_(NAME,
              f"kind={TRACK_KIND} did NOT reach {TOPIC_TRACKS} "
              f"(watermark {tracks_before} -> {tracks_after})")

    silver_mid = _hw(TOPIC_SILVER)
    if silver_mid > silver_before:
        fail_(NAME,
              f"kind={TRACK_KIND} leaked onto {TOPIC_SILVER} "
              f"(watermark {silver_before} -> {silver_mid})")

    dlq_mid = _hw(TOPIC_DLQ)
    if dlq_mid > dlq_before:
        fail_(NAME,
              f"kind={TRACK_KIND} was dead-lettered to {TOPIC_DLQ} "
              f"(watermark {dlq_before} -> {dlq_mid}) — a track kind is "
              f"routed, not an error")

    # Never in the fleet, and in the in-flight table. The projector needs a
    # moment to consume munition-tracks.
    time.sleep(5.0)
    if _rows_for(TRACK_ID) != 0:
        fail_(NAME, f"{TRACK_ID} (kind={TRACK_KIND}) has a "
                    f"telemetry_latest_state row — a munition became a "
                    f"fleet member")
    n_tracks = int(query_postgres(
        "select count(*) from munition_track "
        f"where munition_asset_id = '{TRACK_ID}'")[0][0])
    if n_tracks < 1:
        fail_(NAME, f"no munition_track row for {TRACK_ID} after the "
                    f"projector had time to consume {TOPIC_TRACKS}")

    # --- 6: a kind that is neither admitted nor tracked is still dropped --
    gated_before = metric_value_labeled(scrape_connect_metrics(), METRIC,
                                        {"kind": str(GATED_KIND)})
    send_udp_bytes(_pdu(GATED_KIND, GATED_ENTITY, "GATE-OTHER"))
    time.sleep(3.0)
    gated_after = metric_value_labeled(scrape_connect_metrics(), METRIC,
                                       {"kind": str(GATED_KIND)})
    if gated_after <= gated_before:
        fail_(NAME,
              f'{METRIC}{{kind="{GATED_KIND}"}} did not increase '
              f"({gated_before} -> {gated_after}) — the drop is silent")
    if _hw(TOPIC_SILVER) > silver_mid or _hw(TOPIC_TRACKS) > tracks_after:
        fail_(NAME, f"kind={GATED_KIND} reached {TOPIC_SILVER} or "
                    f"{TOPIC_TRACKS}")

    # --- 3: the admitted kind still flows -------------------------------
    send_udp_bytes(_pdu(ADMITTED_KIND, 54001, "GATE-PLATFORM"))
    time.sleep(3.0)

    silver_after = _hw(TOPIC_SILVER)
    if silver_after <= silver_mid:
        fail_(NAME,
              f"kind={ADMITTED_KIND} did NOT reach {TOPIC_SILVER} "
              f"(watermark stuck at {silver_mid}) — the gate is refusing "
              f"admitted traffic, which is an ingress outage, not a guard")

    # --- 4: a removal for the id admitted in 3 goes through ---------------
    # A Remove Entity PDU carries no entity type, so kind cannot decide it:
    # read as kind 0, every removal was dropped, and a fleet member could
    # never be removed.
    send_udp_bytes(build_remove_entity_pdu(site=1, application=1,
                                           entity=54001))
    time.sleep(3.0)

    silver_removed = _hw(TOPIC_SILVER)
    if silver_removed <= silver_after:
        fail_(NAME,
              f"a removal for admitted id 54001 did NOT reach {TOPIC_SILVER} "
              f"(watermark stuck at {silver_after}) -- the gate drops "
              f"removals of fleet members")

    # --- 5: a removal for an id that was never admitted -------------------
    # The gate passes it: it has no memory of what it admitted. What keeps it
    # from creating an asset is downstream, where the ids live.
    if _rows_for(UNSEEN_ID) != 0:
        fail_(NAME, f"precondition: {UNSEEN_ID} already has a "
                    f"telemetry_latest_state row; this step cannot judge "
                    f"whether a removal creates one")
    counts_before = _unknown_removal_counts()
    send_udp_bytes(build_remove_entity_pdu(site=1, application=1,
                                           entity=UNSEEN_ENTITY))

    deadline = time.monotonic() + 30.0
    while True:
        time.sleep(3.0)
        counts_after = _unknown_removal_counts()
        if all(counts_after[k] > counts_before[k] for k in counts_before):
            break
        if time.monotonic() > deadline:
            stuck = [f"{k} {counts_before[k]:.0f} -> {counts_after[k]:.0f}"
                     for k in counts_before
                     if counts_after[k] <= counts_before[k]]
            fail_(NAME, f"a removal for never-admitted {UNSEEN_ID} was not "
                        f"counted as an unknown-key drop by: "
                        f"{'; '.join(stuck)}")

    silver_unseen = _hw(TOPIC_SILVER)
    if silver_unseen <= silver_removed:
        fail_(NAME,
              f"a removal for never-admitted {UNSEEN_ID} did NOT reach "
              f"{TOPIC_SILVER} (watermark stuck at {silver_removed}) -- the "
              f"gate is meant to pass every removal")
    if _rows_for(UNSEEN_ID) != 0:
        fail_(NAME, f"a removal for never-admitted {UNSEEN_ID} created a "
                    f"telemetry_latest_state row")

    pass_(NAME,
          f"kind={TRACK_KIND} tracked "
          f"({tracked_before:.0f} -> {tracked_after:.0f}), not dropped, "
          f"not in the fleet, in munition_track; kind={GATED_KIND} still "
          f"refused ({gated_before:.0f} -> {gated_after:.0f}), no DLQ entry, "
          f"kind={ADMITTED_KIND} still admitted; admitted id's removal "
          f"through; unseen removal through the gate, no row, counted by "
          + ", ".join(f"{k} {counts_before[k]:.0f} -> {counts_after[k]:.0f}"
                      for k in counts_before))


if __name__ == "__main__":
    main()
