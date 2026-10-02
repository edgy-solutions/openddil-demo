#!/usr/bin/env python3
"""Egress pane viewer-nation filter. Reached directly, the hub /egress/ pane
gave every signed-in profile the same records -- an ATL-only edge operator
saw BDR's -- because the pane decides once, for every nation on the wire,
and nothing in front of it narrowed that answer to the nations the VIEWER
may see.

THIS FILTERS BY VIEWER; IT DOES NOT RE-DECIDE ADMISSION. The input payload
is `egress/pane_api.py`'s own answer -- each record's `allowed`/`reason`
already came from the real `EgressGate.decide` path, over the DESTINATION.
Visibility here is a second, orthogonal question: which of those already-
decided records may THIS viewer be shown at all. A record a viewer cannot
see is withheld regardless of whether the gate admitted or refused it.

THE VISIBILITY RULE IS pep.py's `policy_predicate` RULE, RESTATED. (ADR-0029
Phase 4): a record is visible to a viewer holding `nations` iff its
`originator_nation` is one of them, or its `releasable_to` overlaps them.
Deny-unlabelled falls out of the same two clauses rather than needing a
third: a record with no originator and no releasable_to satisfies neither,
for any viewer, including one holding every nation on the corpus. Restated
here rather than imported because this module filters JSON records and
policy_predicate composes a SQL WHERE clause for a different transport --
but it is the SAME rule, and a change to one without the other is exactly
the drift this comment exists to catch at review time.

WHY THE OUTPUT IS BUILT FROM A WHITELIST, NEVER FROM A COPY OF THE INPUT.
`dict(payload)` with `records` swapped out would carry forward any summary
field the pane adds later -- a future `fleet_summary` or `nation_counts`
computed over the pane's UNFILTERED record set would leak exactly what this
function exists to hide, and nothing in this file would catch it because
this file never looks at that key. Building the result field by field is
the only shape of this filter that cannot regress that way.
"""
from __future__ import annotations


def filter_decisions(payload: dict, nations: list[str]) -> dict:
    """Return the subset of `payload["records"]` visible to a viewer holding
    `nations`, with `admitted`/`refused`/`withheld` recomputed over what is
    actually shown -- the upstream pane's own counts are for every nation
    and must not leak through unchanged.

    Raises ValueError on malformed input: `payload` not a dict, `records`
    not a list, or any record not a dict. No partial result -- either every
    record can be classified or none are returned.
    """
    if not isinstance(payload, dict):
        raise ValueError("payload must be a dict")
    records = payload.get("records")
    if not isinstance(records, list):
        raise ValueError("payload['records'] must be a list")
    for record in records:
        if not isinstance(record, dict):
            raise ValueError("every record must be a dict")

    allowed = set(nations)
    visible = []
    admitted = 0
    for record in records:
        originator = record.get("originator_nation")
        releasable_to = record.get("releasable_to")
        # SAME TWO CLAUSES AS policy_predicate (pep.py). An unlabelled
        # record -- originator None, releasable_to empty or missing --
        # satisfies neither and is never visible, to any viewer: there is
        # no third clause here for visibility to fall through to.
        is_visible = (
            (isinstance(originator, str) and originator != "" and originator in allowed)
            or (isinstance(releasable_to, list)
                and any(isinstance(n, str) and n in allowed for n in releasable_to))
        )
        if not is_visible:
            continue
        visible.append(record)
        if record.get("allowed") is True:
            admitted += 1

    total = len(records)
    shown = len(visible)
    return {
        "destination": payload.get("destination"),
        "policy_version": payload.get("policy_version"),
        "corpus_version": payload.get("corpus_version"),
        "records": visible,
        # RECOMPUTED, never forwarded -- see the module docstring. The
        # pane's own admitted/refused cover every record it decided, for
        # every nation; a viewer who can see only some of them needs the
        # tally for what they can see, not for the whole corpus.
        "admitted": admitted,
        "refused": shown - admitted,
        "withheld": total - shown,
        "viewer_nations": sorted(allowed),
    }
