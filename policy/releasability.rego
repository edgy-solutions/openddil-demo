# =============================================================================
# ADR-0029 — coalition releasability policy
# =============================================================================
# THE ONLY DECISION THIS POLICY MAKES: which nations may a given subject see?
#
# It deliberately does NOT decide anything about rows. The gateway turns the
# answer into a WHERE clause, and ADR-0029 §1 is explicit that such a filter
# is a TRANSPORT for this decision, not a second decision. Keeping the PDP's
# output a set of nations rather than a predicate is what makes that true: a
# transport cannot disagree with a decision it merely carries, but a second
# rule engine can.
#
# It also makes the decision cheap enough to take PER SHAPE rather than per
# row — one call per subscription, not one per asset.
#
# DEFAULT DENY IS THE FIRST LINE FOR A REASON.
# Every rule below can only ADD to an empty set. A subject absent from
# data.users falls through to `allowed_nations = set()`, the gateway composes
# a predicate that matches nothing, and the subject sees an empty fleet. There
# is no branch that can turn an unknown subject into a permitted one.
#
# WHAT IS NOT HERE, AND MUST NOT BE ADDED
#   * No row-level logic. See above.
#   * No inference from subject id, email domain, or nation-looking prefixes.
#     Entitlements are asserted (§5); a policy that could derive one would
#     make the assertion optional, and an inferred entitlement has no
#     accountable author.
#   * No classification axis yet. `clearance` is carried on the subject and
#     unused in Slice 1 — adding the axis later is a rule here plus a column,
#     not an architecture change (§2).
#
# -----------------------------------------------------------------------------
# THE DESTINATION REGISTRY, AND ITS PRECEDENCE OVER THE SUBJECT CORPUS
# -----------------------------------------------------------------------------
# A destination (ADR-0046 §7) is a registry entry, resolved by the same
# `subject_record` lookup as a human or system subject — see below. Three
# sources feed it, LOW TO HIGH:
#   1. data.openddil.users                  — policy/users.yaml
#   2. data.openddil.destinations           — policy/destinations.yaml,
#                                              shipped, always `entries: {}`
#   3. data.openddil.destinations_deployment — a deployment's own overlay,
#                                              rendered only when the chart
#                                              was given one
# A higher source WINS for any key it names; a key it does not name falls
# through to the next source down. All three subtrees are OPTIONAL — an
# absent file (an older bundle with no destinations.yaml, a deployment with
# no overlay) means that subtree is simply undefined, and every rule below
# stays total regardless of which subtrees exist.
package openddil.releasability

# The policy version stamped into every gateway decision record. ADR-0029 §6
# requires a decision to be auditable against the policy that produced it, and
# a bundle digest is not legible in a log line. Bump this when the RULES
# change; it is not a version of the entitlements data, which changes on its
# own cadence and is auditable through git.
policy_version := "arc2-slice1-v1"

# The subject's entitlement record, or undefined when the subject is unknown
# to ALL THREE sources. `input.subject` is whatever the gateway authenticated
# — this policy does not authenticate, and must not be given a way to.
# Read from data.openddil.*, NOT data.users or data.destinations*. The
# bundle's .manifest declares `roots: ["openddil"]`, and OPA refuses a bundle
# whose data falls outside its declared roots — so every source below is
# loaded under its own data.yaml and lands under data.openddil. The reviewed
# files are still `users.yaml` / `destinations.yaml` / the deployment's own
# overlay; the path and the name are changed by transport in every case,
# which is why it is called out here and at each copy site.
#
# PRECEDENCE: deployment overlay, else the shipped registry, else the subject
# corpus — see the header note above. `else` on a bare ref means "try the
# next source when this one is undefined", so a subject present in an
# earlier-checked source never falls through to a later one: each branch
# either resolves whole or is skipped whole, never partially.
subject_record := v if {
	v := data.openddil.destinations_deployment.entries[input.subject]
}

else := v if {
	v := data.openddil.destinations.entries[input.subject]
}

else := v if {
	v := data.openddil.users[input.subject]
}

# ---------------------------------------------------------------------------
# allowed_nations — THE decision
# ---------------------------------------------------------------------------
# Default first, so the deny path is the one that survives every future edit
# to the rules below.
default allowed_nations := set()

allowed_nations := {n | some n in subject_record.nations}

# ---------------------------------------------------------------------------
# allow — a coarse "may this subject read at all?"
# ---------------------------------------------------------------------------
# NOT the filter, and not sufficient on its own. It exists so the gateway can
# distinguish "subject is unknown" (deny outright, log it, 403) from "subject
# is known and entitled to nothing" — which is a legitimate if unusual state
# and should render an empty fleet rather than an authorization error.
#
# Conflating the two would make an operator whose entitlements were revoked
# indistinguishable from an operator whose account does not exist, and those
# call for different responses.
default allow := false

allow if {
	subject_record
	count(allowed_nations) > 0
}

# ---------------------------------------------------------------------------
# subject_known — total by construction
# ---------------------------------------------------------------------------
# WHY THIS IS A RULE WITH A DEFAULT AND NOT AN EXPRESSION ON subject_record.
#
# `subject_record` is UNDEFINED for a subject absent from the corpus — that is
# how Rego expresses absence, and it is correct. But an expression referencing
# an undefined value is itself undefined, and any rule referencing THAT is
# undefined in turn. `decision` was written as an object literal containing
# `subject_record != null`, which made the WHOLE DECISION OBJECT undefined for
# exactly the case it exists to deny.
#
# Topaz then answered `{"response": {"result": []}}` — no bindings at all —
# and the gateway, unable to read a decision, reported the PDP as UNAVAILABLE.
# Fail-closed either way, so the user was still refused; but the audit trail
# recorded an OUTAGE where the truth was an unlisted subject. Those call for
# different responses, and conflating them is how an outage gets read as a
# policy change and a policy change gets dismissed as an outage.
#
# Found by asking the running PDP about `nobody`, not by reading the policy.
# ---------------------------------------------------------------------------
# role — THE SECOND AXIS, and it is not an authorization input
# ---------------------------------------------------------------------------
# WHICH TIER a subject sees is a fact about WHERE THEY LOGGED IN: the tier
# node serves its own instance to whoever it authenticates. WHICH ROLE they
# hold is a fact about the SUBJECT, and it comes from here.
#
# Those are two axes and this policy keeps them apart. The tab switcher
# conflated them into one four-item enum — "maintainer / regional / hq /
# controller" mixes a role with two tier depths and a tool — which is exactly
# why "which of the three views does a fourth tier get?" had no answer.
#
# ⚠ ROLE DOES NOT FILTER DATA, AND MUST NOT START TO. `allowed_nations` is
# the whole of the read-path decision (ADR-0029 §4). Role selects AFFORDANCES
# within a tier — which panels and controls a subject is offered — and if a
# role ever needs to gate rows it does so by changing the subject's nations,
# through this policy, not by a second filter somewhere downstream. A second
# thing that can narrow a result set is a second authorization decision
# nobody reviewed (§1).
#
# Defaulted to `observer`, the least-privileged value, for the same reason
# every other rule here has a default: a subject whose corpus row omits a
# role must not make the decision object undefined, which the gateway would
# correctly report as a PDP outage. An entitled subject with no stated role
# gets the read-only affordances and nothing else.
default role := "observer"

role := subject_record.role

default corpus_version := "unversioned"

corpus_version := data.openddil.version

default subject_known := false

# True if ANY of the three sources has the subject — not just the one that
# ultimately wins `subject_record`. A subject shadowed by a higher source is
# still a known subject; `subject_record` picks which ENTRY decides, this
# asks whether any entry exists at all.
subject_known if data.openddil.destinations_deployment.entries[input.subject]

subject_known if data.openddil.destinations.entries[input.subject]

subject_known if data.openddil.users[input.subject]

# ---------------------------------------------------------------------------
# accepts — which record kinds a destination is entitled to receive
# ---------------------------------------------------------------------------
# Total, like every other decision field. A human subject's record carries no
# `accepts`, and the empty default is exactly as meaningful there as it is
# for a destination with nothing declared: "accepts nothing" is a safe,
# auditable default, not a missing feature.
default accepts := []

accepts := sort(subject_record.accepts)

# ---------------------------------------------------------------------------
# registry_version — WHICH registry snapshot (shipped + deployment) produced
# this subject_record, distinct from corpus_version (users.yaml's version)
# and from policy_version (the rules). Three different things move on three
# different cadences; conflating any two of them is how a decision record
# stops being able to answer "what was in force when this was decided?".
# ---------------------------------------------------------------------------
default shipped_registry_version := "none"

shipped_registry_version := data.openddil.destinations.version

default deployment_registry_version := "none"

deployment_registry_version := data.openddil.destinations_deployment.version

registry_version := sprintf("%s+%s", [shipped_registry_version, deployment_registry_version])

# ---------------------------------------------------------------------------
# decision — what the gateway actually asks for
# ---------------------------------------------------------------------------
# One object so the gateway makes ONE call and logs ONE answer. A gateway that
# assembled a decision from several queries could log a combination that no
# single PDP evaluation ever produced.
#
# EVERY FIELD BELOW IS TOTAL. `allow`, `allowed_nations` and `subject_known`
# each have an explicit default; `policy_version` is a constant. So this
# object is defined for every possible input, INCLUDING the inputs it denies —
# which is the property that lets the gateway tell a deny from a broken PDP.
decision := {
	"allow": allow,
	"allowed_nations": allowed_nations,
	"policy_version": policy_version,
	# WHICH ENTITLEMENTS CORPUS PRODUCED THIS. `policy_version` above versions
	# the RULES; this versions the DATA, and they move independently — a
	# promotion changes one list in one file and touches no rule at all. A
	# decision record carrying only the rule version cannot say which
	# entitlements were in force, which is the question an accreditor asks.
	#
	# Defaulted rather than read bare: a corpus with no version must not make
	# the whole decision object undefined, which is the exact defect that made
	# an unlisted subject read as a PDP outage.
	"corpus_version": corpus_version,
	# The second axis. Affordances, not rows — see the note above.
	"role": role,
	"subject_known": subject_known,
	# ADR-0046 §7. Which record kinds this subject (ordinarily a destination)
	# may receive. Total via its own default; see the note above `accepts`.
	"accepts": accepts,
	# WHICH REGISTRY SNAPSHOT — shipped + deployment, independently of
	# corpus_version (users.yaml) and policy_version (the rules). See the
	# note above `registry_version`.
	"registry_version": registry_version,
}
