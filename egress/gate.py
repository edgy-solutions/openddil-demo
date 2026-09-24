"""The egress gate — ADR-0043 / Arc 2 Slice 2.

THE SECOND GATE, AGAINST THE SECOND ADVERSARY.

ADR-0029 names two. The read gate (Slice 1, `gateway/pep.py`) protects
against the wrong PERSON: its subject is a seat, its failure is a screen
someone should not have seen, and a human is standing in front of it. This
one protects against the wrong DESTINATION: its subject is a link, its
failure is another system DURABLY HOLDING data it should not, and there is
nobody in the loop to notice. A read denial is recoverable; an egress leak
has already happened by the time it could be found.

Everything in this module exists to keep one rule true:

    THERE IS ONE RELEASE PREDICATE, AND THIS IS NOT A SECOND COPY OF IT.

Egress is the read predicate evaluated with the DESTINATION as the subject.
An ATL C2 sees what an ATL person sees, including ATL-authored readings with
no onward release, because anything else would say a nation cannot hand its
own data to its own C2. A stricter egress rule would be a second
implementation of the release rule, and a second implementation is a second
thing to keep true.

What keeps that honest is not this docstring. It is
`tests/hero_scenario_v3/test_44_egress_read_agreement.py`, which runs the
read path's SQL predicate against Postgres and this module's compiled
predicate against the same rows, and fails if they ever disagree.

WHY COMPILED, NOT ASKED PER RECORD
ADR-0029's third Slice 2 forward note: per-message PDP calls "will not scale,
and the fix is a compile step, not a cache". So the PDP is asked ONCE per
destination and its answer is compiled into a record predicate. A cache would
still be one call per record on the miss path and would need an invalidation
story; a compile step has neither, and it makes the decision's inputs
(`policy_version`, `corpus_version`, `allowed_nations`) a fixed, loggable
fact for the whole of the link's life rather than a moving one.

WHAT THIS GATE DOES NOT EVALUATE
The releasability axis, and that axis only. `classification` is fenced, as it
was in Slice 1 — and the fence FAILS CLOSED: a record carrying a
classification this gate has not been taught to read is refused, not passed.
A fence that silently forwards marked data is not a fence.
"""
from __future__ import annotations

import json
import logging
import os
import secrets
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Mapping

TOPAZ = os.getenv("OPENDDIL_TOPAZ_URL", "http://topaz:8383").rstrip("/")
TOPAZ_TIMEOUT = float(os.getenv("OPENDDIL_TOPAZ_TIMEOUT", "2.0"))

log = logging.getLogger("egress.gate")

# The single searchable marker, in the shape the read PEP already uses. An
# operator facing a sudden refusal storm gets ONE string to grep, and "the
# gate is broken" cannot be confused with "the gate refused this record".
REFUSE_MARKER = "EGRESS REFUSED"

# Every decision, admit and refuse alike, as one JSON line. Loud on failure
# and silent on success is exactly the asymmetry ADR-0029 says not to repeat:
# it leaves an authorization boundary with no positive audit trail, so
# "nothing crossed" and "the gate was not running" look identical.
decisions = logging.getLogger("egress.decision")


# --- reasons ----------------------------------------------------------------
# A refusal without a reason is a drop with better manners. Each of these is
# a DISTINCT operational event with a distinct remedy, which is why they are
# not collapsed into one "denied".

#: The record's effective audience does not include any of the destination's
#: nations. THE ORDINARY POLICY OUTCOME — the gate working as designed.
REASON_NO_OVERLAP = "no_nation_overlap"

#: The record carries no releasability label at all. Deny-unlabeled, ASSERTED
#: HERE rather than inherited: an unlabelled record reaching this point is a
#: labelling failure upstream, and forwarding it would convert a known gap
#: into an unknown one. Remedy is at the producer, not here.
REASON_UNLABELLED = "unlabelled"

#: The record carries a `classification` marking. Out of this gate's declared
#: axis, so refused rather than passed. Remedy is a decision about the
#: classification axis, not a change here.
REASON_CLASSIFICATION = "classification_not_evaluated"

#: The policy corpus does not know this destination. DISTINCT from a
#: destination known to the corpus that holds no nations — the first is a
#: configuration omission, the second is a deliberate entitlement of nothing,
#: and telling them apart is the difference between "add the row" and "this
#: link is meant to carry nothing".
REASON_DESTINATION_UNKNOWN = "destination_unknown"

#: The PDP could not be reached or did not answer usably. NOT A DENY. Both
#: refuse the record — the gate fails closed — but conflating them is how an
#: outage gets read as a policy change and a policy change gets dismissed as
#: an outage.
REASON_AUTHZ_UNAVAILABLE = "authz_unavailable"

#: The record could not be read at all. Also not a deny: an undecodable
#: record was never evaluated, and saying "denied" would claim an evaluation
#: that did not happen.
REASON_UNDECODABLE = "undecodable"

ADMIT = "admit"


# --- releasability classes --------------------------------------------------
# The class is the record's SHAPE, not its verdict. Two records of the same
# class always get the same verdict from the same destination, which is what
# makes "admitted N of class X" a claim worth predicting in advance rather
# than a count read off afterwards.

CLASS_UNLABELLED = "unlabelled"
CLASS_AUTHORED_NO_RELEASE = "authored_no_release"
CLASS_AUTHORED_WITH_RELEASE = "authored_with_release"
CLASS_AGGREGATE_EMPTY = "aggregate_empty_audience"
CLASS_AGGREGATE_RELEASED = "aggregate_released"
CLASS_CLASSIFIED = "carries_classification"


class AuthzUnavailable(Exception):
    """The PDP could not be reached or did not answer usably.

    A SEPARATE TYPE FROM A REFUSAL, for the same reason the read PEP keeps
    one: they are different events, they have different remedies, and the
    decision log must not merge them."""


@dataclass(frozen=True)
class Label:
    """What a record claims about its own releasability.

    `originator_nation` is an AUTHORSHIP CLAIM (ADR-0029 addendum
    2026-09-08), and authorship alone grants access — the nation that
    produced a reading can always see it. An aggregate claims none, because
    a row derived from several authors has no single author to claim; its
    audience lives entirely in `releasable_to`.

    `releasable_to = ()` is LABELLED AND RELEASABLE TO NOBODY BEYOND THE
    AUTHOR. It is not the same fact as "unlabelled", even though proto3 puts
    both on the wire as an empty repeated field — which is exactly why the
    producer's declaration, not the payload, is what says which one it is.
    """

    originator_nation: str | None
    releasable_to: tuple[str, ...]

    @property
    def effective_audience(self) -> frozenset[str]:
        """`{originator_nation} ∪ releasable_to` — ADR-0029's composition
        rule, and the set the destination's nations are intersected with."""
        nations = set(self.releasable_to)
        if self.originator_nation:
            nations.add(self.originator_nation)
        return frozenset(nations)

    @property
    def is_labelled(self) -> bool:
        """An aggregate with a non-empty audience IS labelled despite having
        no author. Requiring `originator_nation` here would refuse every
        rollup as unlabelled, which is the opposite of what the addendum's
        aggregate rule says."""
        return bool(self.originator_nation) or bool(self.releasable_to)


@dataclass(frozen=True)
class Decision:
    """One decision about one record. Logged whatever the outcome."""

    decision_id: str
    allowed: bool
    reason: str
    record_class: str
    destination: str
    destination_nations: tuple[str, ...]
    label: Label | None
    key: str | None = None
    policy_version: str = "unknown"
    corpus_version: str = "unknown"
    detail: str = ""
    ts: str = field(default_factory=lambda: time.strftime(
        "%Y-%m-%dT%H:%M:%SZ", time.gmtime()))

    def as_json(self) -> dict[str, Any]:
        return {
            "decision_id": self.decision_id,
            "gate": "egress",
            "outcome": "admit" if self.allowed else "refuse",
            "reason": self.reason,
            "class": self.record_class,
            "destination": self.destination,
            "destination_nations": list(self.destination_nations),
            "key": self.key,
            "originator_nation": self.label.originator_nation if self.label else None,
            "releasable_to": list(self.label.releasable_to) if self.label else None,
            "policy_version": self.policy_version,
            "corpus_version": self.corpus_version,
            "detail": self.detail,
            "ts": self.ts,
        }


def new_decision_id() -> str:
    """The id an operator greps and a downstream report cites. It identifies
    a decision RECORD, not the data, so it is safe to carry anywhere."""
    return secrets.token_hex(4).upper()


# --- label extraction -------------------------------------------------------

def _clean_nation(value: Any) -> str | None:
    """A nation code, or None. Empty and whitespace are None, not codes.

    Proto3 materialises an absent string as `""`, so on the wire "" is the
    only representation "no author" can have. Treating "" as a nation would
    produce a labelled-looking record no policy could ever release and no
    completeness gate would ever flag — the exact failure the ingress mapping
    refuses by writing `deleted()` rather than a placeholder."""
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    return cleaned or None


def _clean_nations(value: Any) -> tuple[str, ...]:
    if not isinstance(value, (list, tuple)):
        return ()
    out = []
    for item in value:
        nation = _clean_nation(item)
        if nation and nation not in out:
            out.append(nation)
    return tuple(out)


def extract_label(record: Mapping[str, Any]) -> Label:
    """Read the labels from a record, accepting BOTH shapes on purpose.

    A decoded proto nests them under `provenance` and camel-cases the field
    names; a JSON producer carries them at the top level in snake_case. Both
    are real on this wire today, and a gate that accepted only one would
    refuse an entire producer's output as unlabelled — a refusal that looks
    exactly like correct enforcement and is not."""
    prov = record.get("provenance")
    prov = prov if isinstance(prov, Mapping) else {}

    nation = (
        _clean_nation(record.get("originator_nation"))
        or _clean_nation(prov.get("originator_nation"))
        or _clean_nation(prov.get("originatorNation"))
    )
    releasable = (
        _clean_nations(record.get("releasable_to"))
        or _clean_nations(prov.get("releasable_to"))
        or _clean_nations(prov.get("releasableTo"))
    )
    return Label(originator_nation=nation, releasable_to=releasable)


def carries_classification(record: Mapping[str, Any]) -> str | None:
    """The classification marking this gate does not evaluate, if present.

    Empty is absent: proto3 gives an unset string field the value `""`, so
    requiring non-empty is what separates "no marking" from "a marking".
    Anything non-empty — in ANY vocabulary, including one this deployment has
    never seen — refuses the record. Recognising only known markings would
    mean an unknown marking passes, which inverts the fence."""
    prov = record.get("provenance")
    prov = prov if isinstance(prov, Mapping) else {}
    for candidate in (
        record.get("classification"),
        prov.get("classification"),
    ):
        marking = _clean_nation(candidate)
        if marking:
            return marking
    return None


def classify(record: Mapping[str, Any]) -> str:
    """The record's releasability class — its shape, independent of any
    destination. Predicting counts per class is only meaningful because this
    function never looks at who is asking."""
    if carries_classification(record):
        return CLASS_CLASSIFIED
    label = extract_label(record)
    if not label.is_labelled:
        return CLASS_UNLABELLED
    if label.originator_nation:
        return (CLASS_AUTHORED_WITH_RELEASE if label.releasable_to
                else CLASS_AUTHORED_NO_RELEASE)
    return (CLASS_AGGREGATE_RELEASED if label.releasable_to
            else CLASS_AGGREGATE_EMPTY)


# --- the compile step -------------------------------------------------------

def compile_predicate(nations: Iterable[str]) -> Callable[[Label], bool]:
    """Compile the destination's entitlement into a record predicate.

    CLAUSE FOR CLAUSE THE READ PATH'S SQL, and deliberately written to be
    read side by side with it:

        (originator_nation IS NOT NULL AND originator_nation IN (:nations))
          OR
        (releasable_to IS NOT NULL AND releasable_to && ARRAY[:nations])

    The empty-nations case returns `false` in the SQL and False here. That is
    a REAL entitlement of nothing, not an error — a destination the corpus
    knows and grants no nations to is a link that carries nothing, and it must
    be distinguishable from a destination the corpus has never heard of.
    """
    allowed = frozenset(n for n in (
        _clean_nation(n) for n in nations) if n)

    if not allowed:
        return lambda label: False

    def predicate(label: Label) -> bool:
        # First clause: authorship. `originator_nation IS NOT NULL AND ... IN`.
        if label.originator_nation and label.originator_nation in allowed:
            return True
        # Second clause: containment. `releasable_to && ARRAY[...]` is
        # array OVERLAP, so any one shared nation is enough.
        return bool(allowed.intersection(label.releasable_to))

    return predicate


# --- the PDP ----------------------------------------------------------------

def ask_topaz(subject: str) -> dict[str, Any]:
    """Ask the PDP what nations this subject may see.

    THE SAME QUERY THE READ PATH ASKS, with the destination in the subject
    slot. `releasability.rego` answers exactly "which nations may this subject
    see" and its header forbids row logic, so a destination is a subject to it
    and nothing in the policy needed to change for this gate to exist. That is
    the evidence for "one predicate" being true at the policy layer as well as
    at this one.

    ONE call, ONE answer, ONE logged decision."""
    body = json.dumps({
        "query": "x = data.openddil.releasability.decision",
        # `input` is a JSON *string*, not an object — Topaz's query API takes
        # it that way.
        "input": json.dumps({"subject": subject}),
        # REQUIRED even though this policy authenticates nobody; omitting it
        # returns a 400 that a fail-closed caller reads as PDP-unavailable and
        # then refuses everything.
        "identity_context": {"type": "IDENTITY_TYPE_NONE"},
    }).encode()
    req = urllib.request.Request(
        f"{TOPAZ}/api/v2/authz/query",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=TOPAZ_TIMEOUT) as resp:
            if resp.status != 200:
                raise AuthzUnavailable(f"topaz returned HTTP {resp.status}")
            payload = json.load(resp)
    except AuthzUnavailable:
        raise
    except urllib.error.HTTPError as exc:
        raise AuthzUnavailable(f"topaz HTTP {exc.code}: {exc.reason}") from exc
    except Exception as exc:  # noqa: BLE001 — every exception fails closed
        raise AuthzUnavailable(f"topaz unreachable: {exc}") from exc

    # An unexpected shape is UNAVAILABLE, never an empty decision. A malformed
    # answer read as "no nations" is a deny-all outage wearing the costume of
    # correct enforcement.
    try:
        bindings = payload["response"]["result"][0]["bindings"]["x"]
        return {
            "allow": bool(bindings["allow"]),
            "allowed_nations": sorted(set(bindings["allowed_nations"])),
            "policy_version": bindings["policy_version"],
            "corpus_version": bindings.get("corpus_version", "unknown"),
            "role": bindings.get("role", "observer"),
            "subject_known": bool(bindings["subject_known"]),
        }
    except Exception as exc:  # noqa: BLE001
        raise AuthzUnavailable(f"unparseable topaz answer: {exc}") from exc


# --- the gate ---------------------------------------------------------------

class EgressGate:
    """The single boundary through which status leaves a tier toward a C2.

    Constructed with a PDP answer already in hand — `for_destination` does the
    asking — so that the object's whole life shares one policy version, one
    corpus version and one nation set. A gate that re-asked mid-stream could
    emit a batch whose records were decided under two different corpora with
    nothing in the log saying which was which.
    """

    def __init__(
        self,
        destination: str,
        nations: Iterable[str],
        *,
        policy_version: str = "unknown",
        corpus_version: str = "unknown",
        destination_known: bool = True,
    ) -> None:
        self.destination = destination
        self.nations = tuple(sorted(
            n for n in (_clean_nation(x) for x in nations) if n))
        self.policy_version = policy_version
        self.corpus_version = corpus_version
        self.destination_known = destination_known
        self._predicate = compile_predicate(self.nations)
        self.counts: dict[str, int] = {}

    @classmethod
    def for_destination(cls, destination: str) -> "EgressGate":
        """Ask the PDP once, then compile. Raises `AuthzUnavailable` — which
        the caller must NOT treat as a refusal of any particular record; it is
        a statement that no record can be decided at all."""
        answer = ask_topaz(destination)
        return cls(
            destination,
            answer["allowed_nations"],
            policy_version=answer["policy_version"],
            corpus_version=answer["corpus_version"],
            destination_known=answer["subject_known"],
        )

    def _tally(self, key: str) -> None:
        self.counts[key] = self.counts.get(key, 0) + 1

    def decide(self, record: Mapping[str, Any], *, key: str | None = None) -> Decision:
        """Decide one record. NOTHING IS DROPPED SILENTLY — every call
        returns a Decision, and every Decision is loggable. The number of
        decisions equals the number of records the gate saw; if it does not,
        the gate has a bug rather than a policy."""
        record_class = classify(record)
        label = extract_label(record)

        def refuse(reason: str, detail: str = "", lbl: Label | None = label) -> Decision:
            return Decision(
                decision_id=new_decision_id(), allowed=False, reason=reason,
                record_class=record_class, destination=self.destination,
                destination_nations=self.nations, label=lbl, key=key,
                policy_version=self.policy_version,
                corpus_version=self.corpus_version, detail=detail,
            )

        # Order matters, and it is the order of CERTAINTY, not of likelihood.
        # An unknown destination and an unevaluated marking are both refusals
        # this gate can make without consulting the record's audience at all;
        # deciding audience first would log a nation-overlap verdict for a
        # record that was never eligible to be evaluated on that axis.
        if not self.destination_known:
            decision = refuse(
                REASON_DESTINATION_UNKNOWN,
                f"destination {self.destination!r} is not in the entitlements corpus",
            )
        elif (marking := carries_classification(record)) is not None:
            decision = refuse(
                REASON_CLASSIFICATION,
                f"record carries classification {marking!r}; this gate "
                f"evaluates the releasability axis only",
            )
        elif not label.is_labelled:
            decision = refuse(REASON_UNLABELLED, "no releasability label on the record")
        elif self._predicate(label):
            decision = Decision(
                decision_id=new_decision_id(), allowed=True, reason=ADMIT,
                record_class=record_class, destination=self.destination,
                destination_nations=self.nations, label=label, key=key,
                policy_version=self.policy_version,
                corpus_version=self.corpus_version,
            )
        else:
            decision = refuse(
                REASON_NO_OVERLAP,
                "effective audience "
                f"{sorted(label.effective_audience)} does not meet "
                f"{list(self.nations)}",
            )

        self._tally(decision.reason)
        self._tally(f"class:{decision.record_class}")
        return decision

    @staticmethod
    def log(decision: Decision) -> None:
        """One JSON line per decision, admit and refuse alike."""
        decisions.info("DECISION %s", json.dumps(decision.as_json(), sort_keys=True))
        if not decision.allowed and decision.reason not in (REASON_NO_OVERLAP,):
            # The ordinary policy outcome stays at INFO; everything else is a
            # condition an operator should be able to find without knowing the
            # decision log's format.
            log.warning(
                "%s %s: %s (%s)", REFUSE_MARKER, decision.decision_id,
                decision.reason, decision.detail or decision.record_class,
            )
