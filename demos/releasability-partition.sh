#!/usr/bin/env bash
# =============================================================================
# ADR-0029 Arc 2 Slice 1 — the two-user partition, demonstrated
# =============================================================================
# THE CLAIM: two users of different nations, on ONE cluster, reading ONE store
# through ONE screen, see different fleets — and the difference is fully
# explained by a decision log.
#
# Everything here is fiction. Atlantia (ATL) and Borduria (BDR) are invented
# nations; the accounts are demo accounts with published passwords; the fleet
# is synthetic DIS.
#
# WHAT MAKES THIS MORE THAN A FILTER DEMO
# The two operators hold the SAME ROLE, on the same tier, hitting the same
# endpoint. RBAC cannot express the difference between them — that is the
# whole reason ADR-0029 exists. The deciding inputs are attributes of the
# SUBJECT (which nations they are cleared into) and of the DATA (which nation
# originated the row, who it is releasable to).
#
# THIS SCRIPT LOGS IN THE WAY THE BROWSER DOES.
# It runs a real authorization-code flow against Keycloak — login form and
# all — then talks to the gateway with the session cookie it was given. It
# holds no token, because there is no token to hold: they stay on the server,
# which is the point of the backend-for-frontend. A script that asserted the
# identity instead would prove the filter and leave the thing a customer
# actually asks about — "whose login is that?" — untested.
#
# Usage:   ./demos/releasability-partition.sh
# Env:     NS (default openddil), ORIGIN (default: read from the ingress)
#
# The counts printed here are the engineering evidence. A recording made from
# the same beats is what you show; the two should agree, and if they ever do
# not, this file is the one that is checkable.
set -uo pipefail

# ---------------------------------------------------------------------------
# WHY THIS FILE USES `grep -q PATTERN <<<"$var"` AND NEVER `printf | grep -q`
# ---------------------------------------------------------------------------
# `set -o pipefail` and `grep -q` are a false-negative generator, and the
# failure is SIZE-DEPENDENT, which is the worst property it could have.
#
# `grep -q` exits on the FIRST match and closes its input. The upstream
# `printf` then takes SIGPIPE and exits 141. With `pipefail` the pipeline
# reports 141 — so a pipeline that MATCHED reports FAILURE.
#
# It only happens when the data exceeds the pipe buffer (~64KB). Below that,
# printf finishes writing before grep exits, there is no SIGPIPE, and the
# check is correct. So every one of these worked on small inputs and would
# have started lying as the fleet grew.
#
# The direction of the lie is what makes it worth this comment. In the
# `match && bad || ok` shape a SIGPIPE reads as "no match" and takes the
# `ok` branch — REPORTING A PASS ON A REAL LEAK. A check that gets quieter
# as the data gets bigger is the exact opposite of what these files are for.
#
# A here-string is not a pipeline, so `pipefail` has nothing to report.

NS="${NS:-openddil}"
PG_POD="${PG_POD:-openddil-postgres-hq-0}"
TABLE="telemetry_latest_state"
# A LABEL SELECTOR, NOT A DEPLOYMENT NAME. `kubectl logs deploy/...` picks
# ONE pod, and during a rollout that can be the terminating one — which
# serves nothing and whose log predates the requests this script just made.
# The result is assertions that fail against a window in which the events
# never happened, and the failure reads as a missing feature rather than as
# a stale read. Cost one confusing run to find.
PEP_SELECTOR="-l app.kubernetes.io/component=pep"
JAR_DIR="$(mktemp -d)"
trap 'rm -rf "$JAR_DIR"' EXIT

pass=0
fail=0
ok()   { echo "  PASS  $*"; pass=$((pass + 1)); }
bad()  { echo "  FAIL  $*"; fail=$((fail + 1)); }
beat() { echo; echo "=== $* ==="; }

# ---------------------------------------------------------------------------
# PREFLIGHT — refuse stale or wrong artifacts, and NAME them
# ---------------------------------------------------------------------------
# A demo that runs against the wrong cluster, or against a build that predates
# what it claims to show, produces output that looks exactly like a pass.
# Every check below has been the actual cause of a misleading run at least
# once in this project.
beat "preflight"

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

if ! kubectl get svc -n "$NS" openddil-pep >/dev/null 2>&1; then
  echo "REFUSING: no PEP in namespace '$NS'. Install with" >&2
  echo "  --set releasability.enabled=true" >&2
  exit 1
fi

ORIGIN="${ORIGIN:-}"
if [ -z "$ORIGIN" ]; then
  host="$(kubectl get ingress -n "$NS" -o jsonpath='{.items[0].spec.rules[0].host}' 2>/dev/null)"
  [ -n "$host" ] && ORIGIN="http://$host"
fi
if [ -z "$ORIGIN" ]; then
  echo "REFUSING: could not determine the public origin. Set ORIGIN." >&2
  exit 1
fi
echo "  origin:  $ORIGIN"

# THE §7 COMPLETENESS GATE IS A PRECONDITION, NOT A STEP. A partition shown
# over partially-labelled data is a smaller fleet for reasons that have
# nothing to do with policy, and the screen looks identical either way.
unlabelled="$(kubectl exec -n "$NS" "$PG_POD" -- psql -U postgres -d openddil -At \
  -c "SELECT count(*) FROM $TABLE WHERE originator_nation IS NULL OR releasable_to IS NULL;" 2>/dev/null)"
if [ "${unlabelled:-x}" != "0" ]; then
  echo "REFUSING: $TABLE has ${unlabelled:-?} unlabelled row(s)." >&2
  echo "Run openddil-helm/scripts/check-releasability-completeness.sh first." >&2
  exit 1
fi
echo "  completeness gate: 0 unlabelled rows in $TABLE"

# Which authentication mode is live? REPORTED, never inferred silently — a
# run that quietly used header mode would be demonstrating the filter while
# claiming to demonstrate the login.
AUTH_MODE="header"
me_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$ORIGIN/auth/me" 2>/dev/null)"
case "$me_code" in 200|401) AUTH_MODE="oidc" ;; esac
echo "  auth mode: $AUTH_MODE"
if [ "$AUTH_MODE" = "header" ]; then
  echo "  NOTE: the gateway is in header mode, so the logins below are"
  echo "        ASSERTED rather than performed. The partition is still real;"
  echo "        the identity is not. Do not record this variant."
fi

# ---------------------------------------------------------------------------
# login — a real authorization-code flow, driven the way a browser drives it
# ---------------------------------------------------------------------------
login() {  # login <username> <password> -> echoes the cookie jar path
  local user="$1" pw="$2" jar="$JAR_DIR/$1.jar"
  rm -f "$jar"
  if [ "$AUTH_MODE" != "oidc" ]; then
    echo "$jar"; return 0
  fi
  # 1. the gateway starts the flow and redirects to the identity provider;
  # 2. the IdP serves a login form whose action carries per-attempt session
  #    and execution ids — PARSED OUT rather than guessed, because Keycloak
  #    regenerates them every time;
  # 3. the form is posted; the IdP redirects back with an authorization code;
  # 4. the gateway exchanges the code SERVER-SIDE and sets a session cookie.
  #
  # One cookie jar spans both, because the IdP is served under the app's own
  # origin — same site, no CORS anywhere in this round trip.
  local page action
  page="$(curl -s -L -c "$jar" -b "$jar" --max-time 25 "$ORIGIN/auth/login")"
  action="$(printf '%s' "$page" \
    | grep -o 'action="[^"]*"' | head -1 | sed 's/^action="//; s/"$//' \
    | sed 's/&amp;/\&/g')"
  if [ -z "$action" ]; then
    echo "  (login: no form action found for $user)" >&2
    echo "$jar"; return 1
  fi
  curl -s -L -c "$jar" -b "$jar" --max-time 25 \
       --data-urlencode "username=$user" \
       --data-urlencode "password=$pw" \
       --data-urlencode "credentialId=" \
       "$action" >/dev/null
  echo "$jar"
}

# shape <jar> <subject> [extra-query] -> body then a trailing HTTP:<code>
shape() {
  local jar="$1" subject="$2" extra="${3:-}"
  if [ "$AUTH_MODE" = "oidc" ]; then
    curl -s -b "$jar" -w '\nHTTP:%{http_code}' --max-time 30 \
      "$ORIGIN/electric/v1/shape?table=$TABLE&offset=-1$extra"
  else
    curl -s -H "X-OpenDDIL-Subject: $subject" -w '\nHTTP:%{http_code}' --max-time 30 \
      "$ORIGIN/electric/v1/shape?table=$TABLE&offset=-1$extra"
  fi
}

assets()   { grep -oE 'dis:[0-9]+:[0-9]+:[0-9]+' | sort -u; }
httpcode() { grep -oE 'HTTP:[0-9]+' | tail -1 | cut -d: -f2; }
count()    { grep -c . ; }

SUB_A="11111111-1111-4111-8111-111111111111"
SUB_B="22222222-2222-4222-8222-222222222222"
SUB_L="33333333-3333-4333-8333-333333333333"
SUB_N="44444444-4444-4444-8444-444444444444"

# ---------------------------------------------------------------------------
beat "0. baseline — the whole fleet, straight from the store"
ALL="$(kubectl exec -n "$NS" "$PG_POD" -- psql -U postgres -d openddil -At \
  -c "SELECT originator_nation || ' ' || count(*) FROM $TABLE GROUP BY originator_nation ORDER BY originator_nation;" 2>/dev/null)"
echo "$ALL" | sed 's/^/  /'
N_ATL="$(echo "$ALL" | awk '$1=="ATL"{print $2}')"
N_BDR="$(echo "$ALL" | awk '$1=="BDR"{print $2}')"
SHARED="$(kubectl exec -n "$NS" "$PG_POD" -- psql -U postgres -d openddil -At \
  -c "SELECT asset_id FROM $TABLE WHERE releasable_to <> '{}' ORDER BY asset_id;" 2>/dev/null)"
N_SHARED="$(echo "$SHARED" | count)"
echo "  shared across nations: ${SHARED:-<none>}"
echo "  (this is what an UNFILTERED read returns — the thing the PEP prevents)"

# NON-VACUITY FLOOR. Every check below compares a filtered view against these
# numbers, and EVERY ONE OF THEM PASSES TRIVIALLY IF THEY ARE ZERO: "the
# views are disjoint" and "the liaison sees all 0" are true statements about
# nothing.
#
# Not hypothetical — an early run of this script did exactly that. The PEP
# was refusing every request, and three checks reported PASS over an empty
# result set beside two honest failures. A reader skimming for green would
# have taken the wrong lesson from a run that was completely broken.
if [ -z "${N_ATL:-}" ] || [ -z "${N_BDR:-}" ] || [ "${N_ATL:-0}" -eq 0 ] || [ "${N_BDR:-0}" -eq 0 ]; then
  echo "REFUSING: baseline is ATL=[${N_ATL:-}] BDR=[${N_BDR:-}]." >&2
  echo "A partition demo needs a non-empty fleet on BOTH sides; every check" >&2
  echo "below would pass trivially against nothing." >&2
  exit 1
fi
if [ "$N_SHARED" -lt 1 ]; then
  echo "REFUSING: no asset is releasable across nations, so the one-store" >&2
  echo "beat would prove nothing and the SECOND clause of the filter would" >&2
  echo "never fire — carried, untested, indistinguishable from broken." >&2
  exit 1
fi
TOTAL=$((N_ATL + N_BDR))
EXPECT_B=$((N_BDR + N_SHARED))

# ---------------------------------------------------------------------------
beat "1. the coalition liaison — what the whole picture looks like"
# Opening on the liaison, because a partition is only legible against the
# thing being partitioned. This is also the case that ruled out per-nation
# stores: with two databases this subject queries both and merges
# client-side, which is a second implementation of the join and a second
# place for it to be wrong.
JAR_L="$(login liaison.coalition demo)"
OUT="$(shape "$JAR_L" "$SUB_L")"; L="$(printf '%s' "$OUT" | assets)"; NL="$(echo "$L" | count)"
echo "  assets: $NL"
if [ "$NL" = "$TOTAL" ] && [ "$NL" -gt 0 ]; then
  ok "liaison sees the whole coalition: $NL"
else
  bad "liaison saw $NL, expected $TOTAL"
fi

# ---------------------------------------------------------------------------
beat "2. operator.atlantia — the ATL fleet"
JAR_A="$(login operator.atlantia demo)"
OUT="$(shape "$JAR_A" "$SUB_A")"; A="$(printf '%s' "$OUT" | assets)"; NA="$(echo "$A" | count)"
echo "  assets: $NA of $TOTAL"
[ "$NA" = "$N_ATL" ] && ok "user-a sees $NA" || bad "user-a saw $NA, expected $N_ATL"
# The other nation's assets are ABSENT, not greyed and not counted. A
# "6 hidden" indicator would itself be a leak: a count of what you cannot see
# is information about it.
grep -q 'dis:2:' <<<"$A" && bad "user-a saw a BDR asset" \
  || ok "no BDR asset in user-a's view — absent, not hidden"

# ---------------------------------------------------------------------------
beat "3. operator.borduria — the BDR fleet, plus what is released to it"
JAR_B="$(login operator.borduria demo)"
OUT="$(shape "$JAR_B" "$SUB_B")"; B="$(printf '%s' "$OUT" | assets)"; NB="$(echo "$B" | count)"
echo "  assets: $NB of $TOTAL  ($N_BDR Bordurian + $N_SHARED released)"
[ "$NB" = "$EXPECT_B" ] && ok "user-b sees $NB" || bad "user-b saw $NB, expected $EXPECT_B"

# ---------------------------------------------------------------------------
beat "4. the shared asset — one store, two entitlements"
# THE BEAT THAT DEFEATS "it is just two databases". The overlap must be
# EXACTLY the declared set: not empty, which would prove nothing about
# sharing, and not larger, which would mean the filter leaks.
OVERLAP="$(comm -12 <(echo "$A") <(echo "$B"))"
N_OVERLAP="$(echo "$OVERLAP" | count)"
echo "  in both views: ${OVERLAP:-<none>}"
if [ "$NA" -eq 0 ] || [ "$NB" -eq 0 ]; then
  bad "cannot assert overlap — a view is empty (A=$NA B=$NB)"
elif [ "$OVERLAP" = "$SHARED" ]; then
  ok "the overlap is EXACTLY the declared shared asset ($N_OVERLAP)"
else
  bad "overlap [$OVERLAP] is not the declared shared set [$SHARED]"
fi
# Same row, not two copies. Per-nation stores would have to replicate it,
# and replication shows the moment the copies disagree by a tick.
Q="&where=asset_id%20%3D%20%27${SHARED}%27"
TS_A="$(printf '%s' "$(shape "$JAR_A" "$SUB_A" "$Q")" | grep -oE '"last_sample_at":"[^"]*"' | head -1)"
TS_B="$(printf '%s' "$(shape "$JAR_B" "$SUB_B" "$Q")" | grep -oE '"last_sample_at":"[^"]*"' | head -1)"
echo "  A: ${TS_A:-<none>}"
echo "  B: ${TS_B:-<none>}"
if [ -n "$TS_A" ] && [ "$TS_A" = "$TS_B" ]; then
  ok "both operators read the SAME ROW, to the timestamp"
else
  bad "the shared asset differs between views (A=$TS_A B=$TS_B)"
fi

# ---------------------------------------------------------------------------
beat "5. an unlisted subject — denied by DEFAULT, not by a rule"
# observer.unlisted is a REAL, ENABLED account. It authenticates successfully
# and is entitled to nothing, and it appears nowhere in the entitlements
# corpus: its absence IS the test. An explicit deny entry would prove that
# explicit denies work while leaving the default unexercised — and the
# default is the branch that runs for every account nobody has thought about
# yet.
JAR_N="$(login observer.unlisted demo)"
OUT="$(shape "$JAR_N" "$SUB_N")"; CODE="$(printf '%s' "$OUT" | httpcode)"
REF="$(printf '%s' "$OUT" | grep -oE '"reference":[ ]*"[A-F0-9]+"' | grep -oE '[A-F0-9]{8}' | head -1)"
echo "  HTTP $CODE   reference ${REF:-<none>}"
[ "$CODE" = "403" ] && ok "unlisted subject refused (403)" \
  || bad "unlisted subject got HTTP $CODE, expected 403"
grep -q "TOPAZ AUTHZ DENIED" <<<"$OUT" \
  && ok "refusal carries the searchable marker" \
  || bad "refusal did not carry TOPAZ AUTHZ DENIED"

beat "5b. no session at all is also denied"
OUT="$(curl -s -w '\nHTTP:%{http_code}' --max-time 25 \
        "$ORIGIN/electric/v1/shape?table=$TABLE&offset=-1")"
CODE="$(printf '%s' "$OUT" | httpcode)"
case "$CODE" in
  401|403) ok "anonymous request refused ($CODE)" ;;
  *)       bad "anonymous request got HTTP $CODE, expected 401 or 403" ;;
esac

# ---------------------------------------------------------------------------
beat "6. a client-supplied where-clause cannot WIDEN the set"
# Shapes accept a `where`. The gateway composes (client) AND (policy) and
# never lets the client's replace it. Here user-b asks for Atlantian rows
# explicitly, and the policy clause narrows the result to the one asset
# actually released to them.
OUT="$(shape "$JAR_B" "$SUB_B" "&where=originator_nation%20%3D%20%27ATL%27")"
W="$(printf '%s' "$OUT" | assets)"; NW="$(echo "$W" | count)"
echo "  assets: $NW  (${W:-<none>})"
# NW BEING SMALL IS ONLY MEANINGFUL IF user-b CAN SEE ANYTHING AT ALL — a PEP
# refusing every request also returns nothing here. Beat 3 is the control.
if [ "$NB" -eq 0 ]; then
  bad "cannot assert composition — user-b sees nothing even unfiltered"
elif [ "$W" = "$SHARED" ]; then
  ok "user-b asking for ATL rows gets only what is released to them"
else
  bad "client where-clause returned [$W], expected [$SHARED]"
fi

# ---------------------------------------------------------------------------
beat "7. the decision log explains every one of the above"
# ADR-0029 Phase 5. Topaz's own decision logger is not configurable on this
# build, so this record is the audit trail rather than defence in depth. It
# carries allows AND denies: loud on failure and silent on success is exactly
# the shape that leaves an authorization system with no positive audit trail.
kubectl logs -n "$NS" $PEP_SELECTOR --tail=400 2>/dev/null \
  | grep "DECISION" | tail -10 | sed 's/^/  /'

LOG="$(kubectl logs -n "$NS" $PEP_SELECTOR --tail=400 2>/dev/null | grep 'DECISION')"
[ -n "$LOG" ] && ok "$(echo "$LOG" | count) decision record(s) present" \
  || bad "no decision records — the audit trail is empty"
grep -q '"policy_version"' <<<"$LOG" \
  && ok "records carry the policy version that produced them" \
  || bad "records carry no policy version"
# TWO VERSIONS, NOT ONE. The rule version and the entitlements version move
# independently — a promotion changes one list in one file and touches no
# rule — so a record carrying only the first cannot say which entitlements
# were in force. That is the question an accreditor asks.
grep -q '"corpus_version"' <<<"$LOG" \
  && ok "records carry the entitlements corpus version too" \
  || bad "records carry no corpus version"
grep -q '"outcome": "deny"' <<<"$LOG" \
  && ok "denials are recorded, not only allows" \
  || bad "no denial in the record — only allows are being logged"
# THE REFERENCE THE USER WAS SHOWN IS THE REFERENCE THE OPERATOR GREPS. That
# is the whole reason a refusal carries one.
if [ -n "${REF:-}" ]; then
  grep -q "\"decision_id\": \"$REF\"" <<<"$LOG" \
    && ok "the refusal's reference $REF is findable in the log" \
    || bad "reference $REF does not appear in the decision log"
fi
if [ "$AUTH_MODE" = "oidc" ]; then
  grep -q '"auth_mode": "oidc"' <<<"$LOG" \
    && ok "records name the authentication mode that produced the subject" \
    || bad "records do not name the auth mode"
fi

# ---------------------------------------------------------------------------
beat "what this run did NOT demonstrate"
# ADR-0037 clause 6. Stated in the demo itself, because a demo's silences are
# read as coverage by everyone who was not in the room.
cat <<'NOTE'
  * EGRESS IS NOT ENFORCED BY ANY OF THIS. Everything above is the user read
    path. Connectors publishing outward and tier bridges forwarding upward or
    laterally are Slice 2, and nothing here gates them. "PEP live" must not
    be read as "all data paths enforced".
  * INTERNAL SERVICE READS are deliberately out of scope (ADR-0029 4) — the
    data has already been admitted to that tier.
  * NO EDGE DECIDED ANYTHING. Slice 1 runs ONE Topaz, at HQ. The decision
    path has no dependency on the inter-tier link, which is worth something —
    but per-tier local authorizers land with the tier-bridge slice, so
    "partitioning that survives disconnection at the edge" is NOT yet a
    claim. Promise the partition; do not promise the capstone.
  * Bypass prevention depends on releasability.lockDownElectric. Without the
    NetworkPolicy everything above is true AND anything in the namespace can
    still read the store directly.
  * The identity provider here is a DEMO one: start-dev, in-memory,
    published passwords, no TLS. The mechanism is what transfers; this
    instance does not.
NOTE

# ---------------------------------------------------------------------------
beat "result"
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
