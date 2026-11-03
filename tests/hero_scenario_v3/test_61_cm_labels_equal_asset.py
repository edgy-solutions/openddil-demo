#!/usr/bin/env python3
"""INVARIANT: CM and registry rows carry the same label as their asset, at every tier.

WHAT THIS ASSERTS
At every tier that has a store, for each `asset_cm_state` row with a
non-null `originator_nation`: the asset's label is its `asset_declaration`
row if it has one in that store, otherwise its `telemetry_latest_state` row.
The CM row's `originator_nation` and `releasable_to` (compared as sets) must
equal the asset's label. `asset_registry` rows are held to the same rule: the
registry relabels on a positive statement (ADR-0050 s2), so a declared asset
must not keep the rule stamp it was first seen under.

WHY
A CM row labelled differently from its asset is the undeclared relabel of
ADR-0053: CM has made a positive statement about the asset's releasability
that nobody declared, and the two rows now disagree about who may see it. It
means no operator sees the whole asset -- the telemetry shows to one nation
and the configuration state to another. CM copies the label it is handed, so
this is where a wrong label upstream (see ADR-0050 s2.6, a failed declaration
lookup) becomes visible.

CM's consumer can lag, so a mismatch read during a catch-up names the lag as
well as a defect. The test prints the CM consumer group's lag when it can
read it.

WHAT IS NOT A FAILURE
A CM row with no comparison row in that store (no declaration and no
telemetry): CM may hold an asset the tier has no telemetry for. These are
counted and printed.

WHAT IS A FAILURE
A mismatch (tier, asset, both labels); and no tier being readable at all,
which would otherwise read as a pass about nothing. A tier with zero CM rows
is reported, never silently passed.

DISCOVERY
Tiers are the running Postgres containers (`docker ps`, names containing
`postgres-`), not a list written down here.

Usage:  python test_61_cm_labels_equal_asset.py
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from _helpers import fail_, pass_, skip_  # noqa: E402

TEST = "CM and registry labels equal the asset label"
TABLES = (("asset_cm_state", "CM"), ("asset_registry", "registry"))
DOCKER_TIMEOUT_S = 60
CM_GROUP = "cm-service-silver"

SQL = """
SELECT json_build_object(
  'asset_id', c.asset_id,
  'cm', json_build_object('n', c.originator_nation,
                          'r', to_json(c.releasable_to)),
  'decl', CASE WHEN d.asset_id IS NULL THEN NULL ELSE
          json_build_object('n', d.originator_nation,
                            'r', to_json(d.releasable_to)) END,
  'tel', CASE WHEN t.asset_id IS NULL THEN NULL ELSE
         json_build_object('n', t.originator_nation,
                           'r', to_json(t.releasable_to)) END)::text
FROM {table} c
LEFT JOIN asset_declaration d ON d.asset_id = c.asset_id
LEFT JOIN telemetry_latest_state t ON t.asset_id = c.asset_id
WHERE c.originator_nation IS NOT NULL
ORDER BY c.asset_id;
"""


# ---------------------------------------------------------------------------
# The comparison, pure so it can be tested without a cluster
# ---------------------------------------------------------------------------
def _label(row: dict | None):
    if row is None:
        return None
    return (row.get("n"), frozenset(row.get("r") or ()))


def compare(cm: dict, decl: dict | None, tel: dict | None, who: str = "CM"):
    """('ok'|'no_comparison'|'mismatch', detail) for one CM row.

    The asset's label is the declaration row if there is one, else the
    telemetry row. Releasable sets compare as sets: order is not meaning."""
    asset = _label(decl) if decl is not None else _label(tel)
    if asset is None:
        return "no_comparison", ""
    mine = _label(cm)
    if mine == asset:
        return "ok", ""
    src = "declaration" if decl is not None else "telemetry"
    return "mismatch", (f"{who} {mine[0]!r} {sorted(mine[1])} != {src} "
                        f"{asset[0]!r} {sorted(asset[1])}")


# ---------------------------------------------------------------------------
# Live reads
# ---------------------------------------------------------------------------
def discover_tiers() -> list[str]:
    r = subprocess.run(["docker", "ps", "--format", "{{.Names}}"],
                       capture_output=True, text=True, timeout=DOCKER_TIMEOUT_S)
    if r.returncode != 0:
        raise RuntimeError(f"docker ps failed: {r.stderr.strip()[:200]}")
    return sorted(n for n in r.stdout.split() if "postgres-" in n)


def read_tier(container: str, table: str) -> list[dict]:
    r = subprocess.run(
        ["docker", "exec", container, "psql", "-U", "postgres", "-d", "openddil",
         "-At", "-c", SQL.format(table=table)],
        capture_output=True, text=True, timeout=DOCKER_TIMEOUT_S)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip()[:200])
    return [json.loads(ln) for ln in r.stdout.splitlines() if ln.strip()]


def cm_consumer_lag() -> str:
    """Best effort: total lag of the CM consumer group, as `rpk` reports it
    on the edge-01 broker the neighbouring helpers use."""
    try:
        from _helpers import REDPANDA_SVC, COMPOSE_DIR, _docker_compose_cmd
        r = subprocess.run(
            _docker_compose_cmd() + ["exec", "-T", REDPANDA_SVC,
                                      "rpk", "group", "describe", CM_GROUP],
            cwd=str(COMPOSE_DIR), capture_output=True, text=True, timeout=15)
        if r.returncode != 0:
            return "unavailable"
        m = re.search(r"TOTAL-LAG\s+(\d+)", r.stdout)
        return m.group(1) if m else "unavailable"
    except Exception:  # noqa: BLE001
        return "unavailable"


def main() -> None:
    try:
        tiers = discover_tiers()
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as exc:
        skip_(TEST, f"cannot list running containers: {exc}")
        return
    if not tiers:
        skip_(TEST, "no running postgres container to read")
        return

    print(f"CM consumer lag ({CM_GROUP}): {cm_consumer_lag()}")
    readable = 0
    failures: list[str] = []
    for tier in tiers:
        tier_read = False
        for table, who in TABLES:
            try:
                rows = read_tier(tier, table)
            except Exception as exc:  # noqa: BLE001
                print(f"  {tier} {table}: could not be read: {exc}")
                continue
            tier_read = True
            if not rows:
                print(f"  {tier}: 0 labelled {who} rows (nothing compared)")
                continue
            ok = no_cmp = 0
            for row in rows:
                verdict, detail = compare(row["cm"], row.get("decl"), row.get("tel"), who)
                if verdict == "ok":
                    ok += 1
                elif verdict == "no_comparison":
                    no_cmp += 1
                else:
                    failures.append(f"{tier} {row['asset_id']}: {detail}")
            print(f"  {tier}: {len(rows)} labelled {who} rows, {ok} equal, "
                  f"{no_cmp} with no comparison row, "
                  f"{len(rows) - ok - no_cmp} mismatched")
        readable += tier_read

    if readable == 0:
        fail_(TEST, f"none of {len(tiers)} tier store(s) could be read; "
                    "nothing was compared")
        return
    if failures:
        fail_(TEST, f"{len(failures)} row(s) labelled differently from "
                    "their asset (read during a catch-up this may be lag): "
                    + "; ".join(failures[:10]))
        return
    pass_(TEST, f"{readable} tier(s) read, every compared row equals its asset")


if __name__ == "__main__":
    main()
