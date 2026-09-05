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
package openddil.releasability

# The policy version stamped into every gateway decision record. ADR-0029 §6
# requires a decision to be auditable against the policy that produced it, and
# a bundle digest is not legible in a log line. Bump this when the RULES
# change; it is not a version of the entitlements data, which changes on its
# own cadence and is auditable through git.
policy_version := "arc2-slice1-v1"

# The subject's entitlement record, or undefined when the subject is unknown.
# `input.subject` is whatever the gateway authenticated — this policy does not
# authenticate, and must not be given a way to.
# Read from data.openddil.users, NOT data.users. The bundle's .manifest
# declares `roots: ["openddil"]`, and OPA refuses a bundle whose data falls
# outside its declared roots — so the entitlements are loaded at
# /policy/openddil/data.yaml and land under data.openddil. The reviewed file
# is still `users.yaml`; the path and the name are both changed by transport,
# which is why both are called out here and at the copy site.
subject_record := data.openddil.users[input.subject]

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
default corpus_version := "unversioned"

corpus_version := data.openddil.version

default subject_known := false

subject_known if data.openddil.users[input.subject]

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
	"subject_known": subject_known,
}
