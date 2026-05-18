"""
Test 49 — Maintainer view edge-pulldown scoping (ADR-0023 Phase 6c.2).

Verifies the DATA LAYER's correctness for the maintainer view's per-edge
pulldown: the Shape API returns disjoint asset sets when queried with
`where edge_id = 'edge-NN'` per the three demo edges, and the asset_id
sets across edges are disjoint (no asset belongs to two edges).

NECESSARY, NOT SUFFICIENT - read this before treating a PASS as final:

  test_49 verifies the DATA LAYER's scoping correctness - the Shape API
  returns the right rows for each `where edge_id = '...'` query. test_49
  does NOT certify that the rendered React picker re-renders on URL
  change. The Shape API returns disjoint sets when queried independently
  REGARDLESS of whether the React frontend actually calls those filtered
  endpoints. The URL->render coupling is verified by the manual browser
  eyeball step (load ?role=maintainer&edge=edge-01 and ?role=maintainer&
  edge=edge-02 side by side; confirm the picker contents differ in the
  browser). test_49 + manual eyeball + ADR-0025's rebuild-and-grep
  deployment proof are jointly the §C.2 observable checkpoint - none of
  them is sufficient alone.

  This honesty is here in the docstring AND in the §C.2 commit narrative
  so the next time a similar verification gap surfaces, nobody assumes
  test_49 should have caught it.

Pattern (Shape-API-direct, no Playwright dependency; symmetric with
test_48):
  - For each demo edge (edge-01, edge-02, edge-03), GET the
    telemetry_latest_state shape with where=edge_id='edge-NN'. Assert
    all returned rows have edge_id == 'edge-NN' (positive).
  - Across all three edges, assert the asset_id sets are pairwise
    disjoint (negative — no asset belongs to two edges).
  - Assert each edge's set is non-empty (a deployment with an edge that
    has zero assets isn't necessarily wrong, but for the demo's 3-edge
    topology with hero-scenario traffic having driven all three, an
    empty edge is a regression signal).
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).parent))
from _helpers import fail_, pass_  # noqa: E402

NAME = "test_49_maintainer_edge_pulldown_scope"

ELECTRIC_URL = "http://localhost:5133/v1/shape"
DEMO_EDGES = ("edge-01", "edge-02", "edge-03")


def _fetch_shape(table: str, where: str | None = None) -> list[dict]:
    q = f"table={table}&offset=-1"
    if where:
        q += f"&where={quote(where)}"
    url = f"{ELECTRIC_URL}?{q}"
    proc = subprocess.run(
        ["curl", "-sS", url],
        capture_output=True, text=True, timeout=15,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"curl failed: {proc.stderr.strip()}")
    body = proc.stdout.strip()
    if not body:
        return []
    payload = json.loads(body)
    rows: list[dict] = []
    for entry in payload:
        if "value" not in entry:
            continue
        rows.append(entry["value"])
    return rows


def main() -> None:
    by_edge: dict[str, set[str]] = {}
    for edge in DEMO_EDGES:
        rows = _fetch_shape("telemetry_latest_state", where=f"edge_id = '{edge}'")
        # POSITIVE: every returned row carries the queried edge_id.
        for r in rows:
            actual = r.get("edge_id")
            if actual != edge:
                fail_(NAME, f"edge {edge} scope returned a row with "
                            f"edge_id={actual!r} — Shape API filter not "
                            f"applied (or projector wrote the wrong "
                            f"edge_id; cross-check with test_40 if so).")
        asset_ids = {r.get("asset_id") for r in rows if r.get("asset_id")}
        if not asset_ids:
            fail_(NAME, f"edge {edge} returned zero assets — demo's 3-edge "
                        f"topology with hero-scenario traffic should have "
                        f"populated every edge. Either traffic wasn't driven "
                        f"or the projector stopped writing edge_id correctly.")
        by_edge[edge] = asset_ids

    # NEGATIVE (differentiation): pairwise asset_id sets are disjoint.
    edges = list(by_edge.keys())
    for i, e1 in enumerate(edges):
        for e2 in edges[i + 1:]:
            overlap = by_edge[e1] & by_edge[e2]
            if overlap:
                fail_(NAME, f"edge {e1} and edge {e2} share asset_ids "
                            f"{sorted(overlap)} — an asset can't belong "
                            f"to two edges. Pipeline bug or test fixture "
                            f"contamination.")

    counts = {e: len(s) for e, s in by_edge.items()}
    pass_(NAME, f"data-layer scoping OK: {counts}; asset_id sets are "
                f"pairwise disjoint across all 3 edges. NOTE: this test "
                f"verifies the Shape API; the URL->render coupling is "
                f"verified by manual browser eyeball (see docstring).")


if __name__ == "__main__":
    main()
