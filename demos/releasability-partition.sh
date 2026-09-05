#!/usr/bin/env bash
# =============================================================================
# ADR-0029 Arc 2 Slice 1 — the two-user partition, demonstrated
# =============================================================================
# THE CLAIM: two users of different nations, on ONE cluster, reading ONE store
# through ONE screen, see different fleets — and the difference is fully
# explained by a decision log.
#
# Everything here is fiction. Atlantia (ATL) and Borduria (BDR) are invented
# nations; the subjects are demo accounts; the fleet is synthetic DIS.
#
# WHAT MAKES THIS MORE THAN A FILTER DEMO
# The two operators hold the SAME ROLE, on the same tier, hitting the same
# endpoint. RBAC cannot express the difference between them — that is the
# whole reason ADR-0029 exists. The deciding inputs are attributes of the
# SUBJECT (which nations they are cleared into) and of the DATA (which nation
# originated the row, who it is releasable to).
#
# THE DECISION IS TAKEN LOCALLY. The PEP asks the tier's own Topaz against the
# tier's own bundle. Nothing in this path reaches out of the tier, which is
# why the same demo survives a severed link — see the severed variant at the
# end, which is ADR-0029's capstone and the sentence no cloud-side system can
# say.
#
# Usage:  ./demos/releasability-partition.sh
# Env:    NS (default openddil)
set -uo pipefail

NS="${NS:-openddil}"
PEP_SVC="openddil-pep"
PG_POD="openddil-postgres-hq-0"
TABLE="telemetry_latest_state"
CURL_IMAGE="curlimages/curl:8.10.1"

pass=0
fail=0
ok()   { echo "  PASS  $*"; pass=$((pass + 1)); }
bad()  { echo "  FAIL  $*"; fail=$((fail + 1)); }
head1() { echo; echo "=== $* ==="; }

# ---------------------------------------------------------------------------
# PREFLIGHT — refuse to run against stale or wrong artifacts, and NAME them
# ---------------------------------------------------------------------------
# A demo that runs against the wrong cluster, or against a build that predates
# the thing it claims to show, produces output that looks exactly like a pass.
# Every check below has been the actual cause of a misleading run at least
# once in this project.
head1 "preflight"

CTX="$(kubectl config current-context 2>/dev/null)"
if [ -z "$CTX" ]; then
  echo "REFUSING: no kubectl context. This demo makes a claim about ONE" >&2
  echo "cluster and must be able to name it." >&2
  exit 1
fi
echo "  context: $CTX"
# The default kubeconfig on at least one machine points at a long-lived
# production cluster, and the only tell is node age. A demo is not the place
# to discover that.
case "$CTX" in
  *lab*|*local*|*dev*|*kind*|*minikube*|*docker-desktop*) ;;
  *)
    echo "REFUSING: context '$CTX' is not recognisably a lab or local" >&2
    echo "cluster. Set KUBECONFIG deliberately and re-run." >&2
    exit 1 ;;
esac

if ! kubectl get svc -n "$NS" "$PEP_SVC" >/dev/null 2>&1; then
  echo "REFUSING: no '$PEP_SVC' service in namespace '$NS'." >&2
  echo "The read-path PEP is not deployed here. Install the chart with" >&2
  echo "  --set releasability.enabled=true" >&2
  exit 1
fi
echo "  PEP service present"

# The §7 completeness gate is a PRECONDITION, not a step. Demonstrating a
# partition over partially-labelled data would show a smaller fleet for
# reasons that have nothing to do with policy, and the screen looks identical
# either way.
unlabelled="$(kubectl exec -n "$NS" "$PG_POD" -- psql -U postgres -d openddil -At \
  -c "SELECT count(*) FROM $TABLE WHERE originator_nation IS NULL OR releasable_to IS NULL;" 2>/dev/null)"
if [ "${unlabelled:-x}" != "0" ]; then
  echo "REFUSING: $TABLE has ${unlabelled:-?} unlabelled row(s)." >&2
  echo "Run scripts/check-releasability-completeness.sh. A partition shown" >&2
  echo "over partially-labelled data is a smaller fleet for the wrong reason," >&2
  echo "and an operator cannot tell the two apart." >&2
  exit 1
fi
echo "  completeness gate: 0 unlabelled rows in $TABLE"

run() {  # run(subject, extra_query) -> body on stdout
  local subject="$1" extra="${2:-}"
  kubectl run -n "$NS" "peptest-$RANDOM" --rm -i --restart=Never --quiet \
    --image="$CURL_IMAGE" -- \
    sh -c "curl -s -w '\nHTTP:%{http_code}' -H 'X-OpenDDIL-Subject: $subject' \
      'http://$PEP_SVC:8080/v1/shape?table=$TABLE&offset=-1$extra'" 2>/dev/null
}
assets() { grep -oE 'dis:[0-9]+:[0-9]+:[0-9]+' | sort -u; }
httpcode() { grep -oE 'HTTP:[0-9]+' | tail -1 | cut -d: -f2; }

# ---------------------------------------------------------------------------
head1 "0. baseline — the whole fleet, straight from the store"
ALL="$(kubectl exec -n "$NS" "$PG_POD" -- psql -U postgres -d openddil -At \
  -c "SELECT originator_nation || ' ' || count(*) FROM $TABLE GROUP BY 1 ORDER BY 1;" 2>/dev/null)"
echo "$ALL" | sed 's/^/  /'
N_ATL="$(echo "$ALL" | awk '$1=="ATL"{print $2}')"
N_BDR="$(echo "$ALL" | awk '$1=="BDR"{print $2}')"
echo "  (this is what an UNFILTERED read returns — the thing the PEP prevents)"

# NON-VACUITY FLOOR. Every check below compares a filtered view against these
# two numbers, and EVERY ONE OF THEM PASSES TRIVIALLY IF BOTH ARE ZERO:
# "the views are disjoint" and "the liaison sees all 0" are true statements
# about nothing.
#
# Not hypothetical — the FIRST RUN of this script did exactly that. The PEP
# was refusing every request (a stale bundle), and three checks reported PASS
# over an empty result set while two others correctly failed. A reader
# skimming for green would have taken the wrong lesson from a run that was in
# fact completely broken.
if [ -z "${N_ATL:-}" ] || [ -z "${N_BDR:-}" ] || [ "${N_ATL:-0}" -eq 0 ] || [ "${N_BDR:-0}" -eq 0 ]; then
  echo "REFUSING: baseline is ATL='"'"'${N_ATL:-}'"'"' BDR='"'"'${N_BDR:-}'"'"'." >&2
  echo "A partition demo needs a non-empty fleet on BOTH sides; every check" >&2
  echo "below would pass trivially against nothing." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
head1 "1. user-a (Atlantia) sees the ATL fleet only"
OUT="$(run user-a)"; A="$(printf '%s' "$OUT" | assets)"; NA="$(echo "$A" | grep -c .)"
echo "  assets: $NA"
[ "$NA" = "$N_ATL" ] && ok "user-a sees $NA of $((N_ATL + N_BDR))" \
  || bad "user-a saw $NA, expected $N_ATL"
printf '%s' "$A" | grep -q 'dis:2:' && bad "user-a saw a BDR asset" \
  || ok "no BDR asset in user-a's view"

# ---------------------------------------------------------------------------
head1 "2. user-b (Borduria) sees the BDR fleet only"
OUT="$(run user-b)"; B="$(printf '%s' "$OUT" | assets)"; NB="$(echo "$B" | grep -c .)"
echo "  assets: $NB"
[ "$NB" = "$N_BDR" ] && ok "user-b sees $NB of $((N_ATL + N_BDR))" \
  || bad "user-b saw $NB, expected $N_BDR"
printf '%s' "$B" | grep -q 'dis:1:' && bad "user-b saw an ATL asset" \
  || ok "no ATL asset in user-b's view"

# THE DISJOINTNESS IS THE POINT, and it is asserted rather than eyeballed:
# two counts that happen to add up would also be produced by two identical
# half-fleets.
# Disjointness over two EMPTY sets is trivially true, so emptiness is part of
# the assertion rather than an assumption sitting behind it.
if [ "$NA" -eq 0 ] || [ "$NB" -eq 0 ]; then
  bad "cannot assert disjointness — one view is empty (A=$NA B=$NB)"
elif [ -z "$(comm -12 <(echo "$A") <(echo "$B"))" ]; then
  ok "the two views are DISJOINT — no asset appears in both"
else
  bad "an asset appears in both views"
fi

# ---------------------------------------------------------------------------
head1 "3. the coalition liaison sees both"
# The case that ruled out partitioning at write time. With per-nation stores
# this subject would have to query two and merge client-side — a second
# implementation of the join, and a second place for it to be wrong.
OUT="$(run liaison)"; L="$(printf '%s' "$OUT" | assets)"; NL="$(echo "$L" | grep -c .)"
echo "  assets: $NL"
if [ "$NL" = "$((N_ATL + N_BDR))" ] && [ "$NL" -gt 0 ]; then
  ok "liaison sees all $NL"
else
  bad "liaison saw $NL, expected $((N_ATL + N_BDR))"
fi

# ---------------------------------------------------------------------------
head1 "4. an unlisted subject is denied by DEFAULT, not by a rule"
# `nobody` appears nowhere in users.yaml. Its absence is the test: an explicit
# deny entry would prove that explicit denies work while leaving the default
# unexercised — and the default is the branch that runs for every account
# nobody has thought about yet.
OUT="$(run nobody)"; CODE="$(printf '%s' "$OUT" | httpcode)"
echo "  HTTP $CODE"
[ "$CODE" = "403" ] && ok "unlisted subject refused (403)" \
  || bad "unlisted subject got HTTP $CODE, expected 403"
printf '%s' "$OUT" | grep -q "TOPAZ AUTHZ DENIED" \
  && ok "refusal carries the searchable marker" \
  || bad "refusal did not carry TOPAZ AUTHZ DENIED"

head1 "4b. no subject at all is also denied"
OUT="$(kubectl run -n "$NS" "peptest-$RANDOM" --rm -i --restart=Never --quiet \
  --image="$CURL_IMAGE" -- sh -c \
  "curl -s -w '\nHTTP:%{http_code}' 'http://$PEP_SVC:8080/v1/shape?table=$TABLE&offset=-1'" 2>/dev/null)"
CODE="$(printf '%s' "$OUT" | httpcode)"
[ "$CODE" = "403" ] && ok "anonymous request refused (403)" \
  || bad "anonymous request got HTTP $CODE, expected 403"

# ---------------------------------------------------------------------------
head1 "5. a client-supplied where-clause cannot WIDEN the set"
# Shapes accept a `where`. The gateway composes (client) AND (policy) and
# never lets the client's replace it. Here user-b asks for ATL rows
# explicitly; the policy clause still narrows the result to nothing.
OUT="$(run user-b "&where=originator_nation%20%3D%20%27ATL%27")"
W="$(printf '%s' "$OUT" | assets)"; NW="$(echo "$W" | grep -c .)"
# ZERO IS ONLY MEANINGFUL IF user-b CAN SEE ANYTHING AT ALL. A PEP refusing
# every request also returns zero here and would score this a pass; step 2 is
# the control.
if [ "$NB" -eq 0 ]; then
  bad "cannot assert composition — user-b sees nothing even unfiltered"
elif [ "$NW" = "0" ]; then
  ok "user-b sees $NB rows unfiltered, and 0 when asking for ATL explicitly"
else
  bad "client where-clause widened the set to $NW rows"
fi

# ---------------------------------------------------------------------------
head1 "6. the decision log explains every one of the above"
# ADR-0029 Phase 5. Topaz's own decision logger is not configurable on this
# build, so this record is the audit trail rather than defence in depth.
# It carries allows AND denies: loud on failure and silent on success is
# exactly the shape that leaves an authorization system with no positive
# audit trail.
kubectl logs -n "$NS" "deploy/$PEP_SVC" --tail=400 2>/dev/null \
  | grep "DECISION" | tail -12 | sed 's/^/  /'

LOGN="$(kubectl logs -n "$NS" "deploy/$PEP_SVC" --tail=400 2>/dev/null | grep -c "DECISION")"
[ "${LOGN:-0}" -gt 0 ] && ok "$LOGN decision record(s) present" \
  || bad "no decision records — the audit trail is empty"
kubectl logs -n "$NS" "deploy/$PEP_SVC" --tail=400 2>/dev/null \
  | grep "DECISION" | grep -q '"policy_version"' \
  && ok "records carry the policy version that produced them" \
  || bad "records carry no policy version"
kubectl logs -n "$NS" "deploy/$PEP_SVC" --tail=400 2>/dev/null \
  | grep "DECISION" | grep -q '"outcome": "deny"' \
  && ok "denials are recorded, not only allows" \
  || bad "no denial in the record — only allows are being logged"

# ---------------------------------------------------------------------------
head1 "what this run did NOT demonstrate"
# ADR-0037 clause 6. Stated in the demo itself, because a demo's silences are
# read as coverage by everyone who was not in the room.
cat <<'NOTE'
  * EGRESS IS NOT ENFORCED BY ANY OF THIS. Everything above is the user read
    path. Connectors publishing outward and tier bridges forwarding upward or
    laterally are Slice 2, and nothing here gates them. "PEP live" must not be
    read as "all data paths enforced".
  * INTERNAL SERVICE READS are deliberately out of scope (ADR-0029 §4) — the
    data has already been admitted to that tier.
  * The releasable_to CLAUSE is exercised structurally (step 5 proves
    composition) but the demo fleet declares releasable_to: [] for every
    asset, so no asset is actually shared across nations here. Array
    containment itself was verified separately against live Electric by
    seeding one row; that is a different check from this demo passing.
  * Bypass prevention depends on releasability.lockDownElectric. If the
    NetworkPolicy is not installed, everything above is true AND anything in
    the namespace can still read the store directly.
NOTE

# ---------------------------------------------------------------------------
head1 "result"
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
